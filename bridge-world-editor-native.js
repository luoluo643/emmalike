import { createWorldEditorAdapter } from './bridge-world-editor.js';
import { createWorldEditorJournal } from './src/world-editor-journal.js';
import { EPISODE_NAMESPACE, validateEpisodeMeta } from './src/episode-model.js';
import { worldError } from './src/world-editor-model.js';

/** Thin ST 1.19.0 binding. Host queue, account and page lifetime are supplied by bridge.js.
 * This module is also injected into isolated native tests; it does not patch global fetch or native code.
 */
// Settled save records older than this are cleared whenever a book page asks for unfinished ones (one still being
// checked by another page is never settled, and a just-settled one stays a while).
const SETTLED_KEEP_MS = 10 * 60 * 1000;

export function createNativeWorldEditor(h) {
    const { worldInfo: wi, st, powerUser, ctx } = h;
    const base = h.journal ?? createWorldEditorJournal();
    const journal = { ...base, unfinished(account) { base.pruneSettled?.(SETTLED_KEEP_MS).catch(() => { }); return base.unfinished(account); } };
    const assertLease = lease => { h.assertQueueOwner(lease); h.assertLease(lease); };
    async function post(path, body, lease) {
        assertLease(lease); await h.verifyAccount(); assertLease(lease);
        const response = await (h.fetchImpl ?? fetch)(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: st.getRequestHeaders(), body: JSON.stringify(body) });
        assertLease(lease); await h.verifyAccount(); assertLease(lease);
        if (!response.ok) throw worldError('WORLD_READ_UNCONFIRMED', `世界书没加载出来（HTTP ${response.status}）`);
        const value = await response.json(); assertLease(lease); return value;
    }
    return createWorldEditorAdapter({
        account: h.account, journal, uuid: h.uuid,
        enqueue: h.enqueue, makeLease: h.makeLease, assertLease, verifyAccount: h.verifyAccount,
        async listBooks(lease) {
            const rows = await post('/api/worldinfo/list', {}, lease);
            if (!Array.isArray(rows) || rows.some(row => typeof row?.file_id !== 'string')) throw worldError('WORLD_LIST_UNCONFIRMED', '世界书列表没加载全');
            return rows.map(row => row.file_id);
        },
        readServerBook: (name, lease) => post('/api/worldinfo/get', { name }, lease),
        cacheGet: name => wi.worldInfoCache.get(name), cacheSet: (name, data) => wi.worldInfoCache.set(name, data), cacheDelete: name => wi.worldInfoCache.delete(name),
        async saveNativeImmediate(name, data, lease, assertBeforeWrite) {
            let nativeWriteStarted = false;
            try {
                assertLease(lease); await h.waitIdle(); await h.verifyAccount(); assertLease(lease);
                assertBeforeWrite();
                // No await between the final cache/session check and this native invocation.
                nativeWriteStarted = true;
                await wi.saveWorldInfo(name, data, true);
                assertLease(lease); await h.verifyAccount(); assertLease(lease);
            } catch (error) {
                error.nativeWriteStarted = nativeWriteStarted;
                throw error;
            }
        },
        watchUpdates(name, handler) {
            const c = ctx(), listener = changedName => { if (changedName === name) handler(); };
            c.eventSource.on(c.eventTypes.WORLDINFO_UPDATED, listener);
            return () => c.eventSource.removeListener(c.eventTypes.WORLDINFO_UPDATED, listener);
        },
        emitUpdated: (name, data) => ctx().eventSource.emit(ctx().eventTypes.WORLDINFO_UPDATED, name, data),
        reloadEditor: name => wi.reloadEditor(name), refreshBookList: () => wi.updateWorldInfoList(),
        describeSources(name) {
            const c = ctx(), characters = [], add = (book, who) => { if (book === name && who && !characters.includes(who)) characters.push(who); };
            const byFile = new Map();
            for (const character of c.characters ?? []) {
                add(character?.data?.extensions?.world, character.name);
                byFile.set(String(character.avatar ?? '').replace(/\.[^.]+$/, ''), character.name);
            }
            for (const lore of wi.world_info?.charLore ?? []) for (const book of lore.extraBooks ?? []) add(book, byFile.get(lore.name) ?? lore.name);
            const episode = validateEpisodeMeta(c.chatMetadata?.[EPISODE_NAMESPACE], h.account);
            return { global: (wi.selected_world_info ?? []).includes(name), characters,
                currentChat: c.chatMetadata?.[wi.METADATA_KEY] === name, persona: powerUser.power_user?.persona_description_lorebook === name,
                otherReferences: 'unknown', ...(episode.kind !== 'absent' && episode.kind !== 'valid' ? { identityWarning: '这个故事的番外信息有问题；这里只显示实际关联' } : {}) };
        },
        createEntry: (name, data) => wi.createWorldInfoEntry(name, data),
        setOriginal(data, uid, key, value) {
            if (key === 'disable') wi.setWIOriginalDataValue(data, uid, 'enabled', !value);
            else if (wi.originalWIDataKeyMap?.[key]) wi.setWIOriginalDataValue(data, uid, wi.originalWIDataKeyMap[key], value);
        },
        deleteOriginal: (data, uid) => wi.deleteWIOriginalDataValue(data, uid),
    });
}
