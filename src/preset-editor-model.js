export const clonePreset = value => value === undefined ? undefined : structuredClone(value);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const presetFingerprint = value => JSON.stringify(canonical(value));
export const samePreset = (a, b) => presetFingerprint(a) === presetFingerprint(b);
export const presetError = (code, message, detail) => Object.assign(new Error(message), { code, detail });
export const PRESET_FIELDS = {
    openai_max_tokens: '回复长度上限', openai_max_context: '能看到多少前文', temperature: '随机程度（温度）',
    top_p: '候选范围（Top P）', frequency_penalty: '少重复用过的词', presence_penalty: '多聊新话题', stream_openai: '流式输出',
};
const keyedBy = lists => ['identifier', 'character_id'].find(key => lists.every(list => Array.isArray(list)
    && list.every(item => object(item) && ['string', 'number'].includes(typeof item[key]))
    && new Set(list.map(item => String(item[key]))).size === list.length));
const pathKey = path => JSON.stringify(path);
const childPath = (path, key, value) => [...path, { by: key, value }];
export function presetFieldLabel(path) {
    if (path[0] === 'prompts') return `提示词 ${path[1]?.value ?? ''} · ${{ content: '内容', name: '名称', role: '消息身份' }[path.at(-1)] || path.at(-1)}`;
    if (path[0] === 'prompt_order') return `提示词顺序或开关 · ${path.findLast(item => typeof item === 'object')?.value ?? ''}`;
    return PRESET_FIELDS[path[0]] || path.map(item => typeof item === 'object' ? item.value : item).join(' · ');
}

// Native export has a fixed schema. Carry imported/unknown fields from the actual named file,
// including unknown properties on identifier-keyed prompt entries, without resurrecting removed entries.
export function overlayPresetDocument(original, exported) {
    if (object(original) && object(exported)) {
        const result = clonePreset(original);
        for (const [key, value] of Object.entries(exported)) if (value !== undefined) result[key] = overlayPresetDocument(original[key], value);
        return result;
    }
    if (Array.isArray(original) && Array.isArray(exported)) {
        const key = keyedBy([original, exported]);
        if (key) return exported.map(item => overlayPresetDocument(original.find(old => old[key] === item[key]), item));
    }
    return clonePreset(exported);
}

export function presetChanges(before, after, path = []) {
    if (samePreset(before, after)) return [];
    if (object(before) && object(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .flatMap(key => presetChanges(before[key], after[key], [...path, key]));
    if (Array.isArray(before) && Array.isArray(after)) {
        const by = keyedBy([before, after]);
        if (by) {
            const order = lists => lists.map(item => item[by]);
            const changes = samePreset(order(before), order(after)) ? [] : [{ path: [...path, '$order'], before: order(before), after: order(after) }];
            for (const value of new Set([...before, ...after].map(item => item[by]))) {
                changes.push(...presetChanges(before.find(item => item[by] === value), after.find(item => item[by] === value), childPath(path, by, value)));
            }
            return changes.map(change => ({ ...change, key: pathKey(change.path), label: presetFieldLabel(change.path) }));
        }
    }
    return [{ path, key: pathKey(path), label: presetFieldLabel(path), before: clonePreset(before), after: clonePreset(after) }];
}

/** Three-way field merge. The input objects are never mutated. No cross-device atomicity claim. */
export function mergePresetDocument(base, mine, server, resolutions = {}) {
    const conflicts = [];
    const merge = (old, local, remote, path) => {
        if (samePreset(local, old)) return clonePreset(remote);
        if (samePreset(remote, old) || samePreset(local, remote)) return clonePreset(local);
        const choice = resolutions[pathKey(path)];
        // Decisions include the exact displayed remote value; an intervening change invalidates consent.
        if (choice && samePreset(choice.server, remote)) return clonePreset(choice.take === 'mine' ? local : remote);
        if (object(old) && object(local) && object(remote)) {
            const result = {};
            for (const key of new Set([...Object.keys(old), ...Object.keys(local), ...Object.keys(remote)])) {
                const value = merge(old[key], local[key], remote[key], [...path, key]);
                if (value !== undefined) result[key] = value;
            }
            return result;
        }
        if (Array.isArray(old) && Array.isArray(local) && Array.isArray(remote)) {
            const by = keyedBy([old, local, remote]);
            if (by) {
                const ids = list => list.map(item => item[by]);
                const order = merge(ids(old), ids(local), ids(remote), [...path, '$order']);
                const items = new Map();
                for (const value of new Set([...old, ...local, ...remote].map(item => item[by]))) {
                    const item = merge(old.find(item => item[by] === value), local.find(item => item[by] === value), remote.find(item => item[by] === value), childPath(path, by, value));
                    if (item !== undefined) items.set(value, item);
                }
                return [...new Set([...order, ...items.keys()])].filter(id => items.has(id)).map(id => items.get(id));
            }
        }
        conflicts.push({ key: pathKey(path), path, label: presetFieldLabel(path), before: clonePreset(old), mine: clonePreset(local), server: clonePreset(remote) });
        return clonePreset(remote);
    };
    const snapshot = merge(base, mine, server, []);
    return { kind: conflicts.length ? 'conflict' : 'merged', snapshot, conflicts };
}

// ST 1.19 src/endpoints/presets.js calls sanitize-filename with its default empty
// replacement. Match that package's substitutions and 255-byte UTF-8 truncation.
export function normalizePresetTargetName(name) {
    if (typeof name !== 'string') throw presetError('INVALID_PRESET_NAME', '预设名称必须是文字');
    const clean = name.replace(/[\/\?<>\\:\*\|"]/g, '').replace(/[\x00-\x1f\x80-\x9f]/g, '')
        .replace(/^\.+$/, '').replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, '').replace(/[\. ]+$/, '');
    let result = '', bytes = 0;
    for (const char of clean) { const size = new TextEncoder().encode(char).length; if (bytes + size > 255) break; result += char; bytes += size; }
    return result;
}
export const presetTargetKey = (account, apiId, name, caseSensitive = false) => {
    const normalized = normalizePresetTargetName(name);
    return JSON.stringify([account, apiId || 'openai', caseSensitive ? normalized : normalized.toLowerCase()]);
};
export const PRESET_DECISION_ACK = 'late-write-can-overwrite-v1';
export function normalizePresetOperation(op) {
    if (!op) return op;
    const value = clonePreset(op), confirmed = ['confirmed', 'saved-not-applied'].includes(value.stage);
    value.apiId ||= 'openai'; value.revision ||= 0;
    if (typeof value.name === 'string') { value.requestedName ??= value.name; value.name = normalizePresetTargetName(value.name); }
    // Old armed and rejected/not-saved receipts contain no proof of non-invocation.
    value.writeOutcome = value.version === 2 ? value.writeOutcome || (confirmed ? 'confirmed' : 'unknown') : confirmed ? 'confirmed' : 'unknown';
    if (value.writeOutcome === 'not-submitted' && value.notSubmittedProof?.kind !== 'write-not-invoked') value.writeOutcome = 'unknown';
    if (value.writeOutcome === 'unknown' && ['armed', 'not-saved'].includes(value.stage)) value.stage = 'unconfirmed';
    return value;
}
export const hasPresetUserDecision = op => op?.userDecision?.acknowledgement === PRESET_DECISION_ACK && op.userDecision.operationId === op.id;
export const isBlockingPresetOperation = op => normalizePresetOperation(op)?.writeOutcome === 'unknown' && !hasPresetUserDecision(op);
export const PRESET_RECEIPT_PREFIX = 'tavern-lite:preset-operation:';
/** A receipt nothing shows or reads again: a confirmed save (not a copy still to be used), or a proven non-write. */
export const isSettledPresetOperation = op => {
    const value = normalizePresetOperation(op);
    return !!value && !hasPresetUserDecision(value) && (value.writeOutcome === 'not-submitted' || value.writeOutcome === 'confirmed' && value.stage === 'confirmed');
};
/**
 * Each preset save leaves a receipt holding the whole preset (a long one is a few hundred KB), and the device storage
 * is shared with the app and the shell's drafts. Kept forever they fill it after a few saves: the next save cannot
 * write its receipt and stops, and world book drafts cannot be kept. Removes settled receipts (any account; never an
 * unknown one or one the user decided on) except `keep`. Returns how many were removed; storage errors count as none.
 */
export function pruneSettledPresetReceipts(storage, keep = '') {
    let removed = 0;
    try {
        const keys = [];
        for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key?.startsWith(PRESET_RECEIPT_PREFIX) && key !== keep) keys.push(key); }
        for (const key of keys) {
            let value; try { value = JSON.parse(storage.getItem(key)); } catch { continue; }
            if (isSettledPresetOperation(value)) { storage.removeItem(key); removed++; }
        }
    } catch {}
    return removed;
}
export function validatePresetName(name) {
    if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 120 || normalizePresetTargetName(name) !== name
        || /^[. ]/.test(name)) throw presetError('INVALID_PRESET_NAME', '名字不能包含 \\ / : * ? " < > |，也不能太长');
    return name;
}
export function presetSearch(prompt, query) {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return { matched: true, hits: [] };
    const hits = [];
    for (const [key, label] of [['name', '名称'], ['content', '正文'], ['role', '消息身份'], ['identifier', '标识']]) {
        const text = String(prompt[key] ?? ''), index = text.toLocaleLowerCase().indexOf(needle);
        if (index < 0) continue;
        const start = Math.max(0, index - 22), end = Math.min(text.length, index + needle.length + 50);
        hits.push({ key, label, index, length: needle.length, snippet: `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}` });
    }
    return { matched: !!hits.length, hits };
}
export const presetScope = (account, name, identifier = '') => JSON.stringify([account, name, identifier]);
export const makePromptDraft = (state, prompt) => ({ account: state.account, name: state.name, identifier: prompt.identifier,
    openedEpoch: state.epoch, opened: prompt.content, base: prompt.content, text: prompt.content, revision: 0, conflict: null });
const cleanPromptDraft = draft => typeof draft.text === 'string' && draft.text === draft.base && !draft.conflict;
export function createPromptDraftStore(storage) {
    const resolveStorage = () => storage === undefined ? globalThis.localStorage : storage;
    const key = identity => `tavern-lite:preset-draft:${presetScope(identity.account, identity.name, identity.identifier)}`;
    return {
        read(identity) {
            try { const draft = JSON.parse(resolveStorage().getItem(key(identity)));
                if (draft === null) return null;
                if (draft.account !== identity.account || draft.name !== identity.name || draft.identifier !== identity.identifier
                    || !['opened', 'base', 'text'].every(field => typeof draft[field] === 'string') || !Number.isSafeInteger(draft.revision)) throw new Error('Invalid draft');
                return draft;
            } catch { throw presetError('PRESET_DRAFT_UNAVAILABLE', '读不到本机的草稿，先把现在的文字复制下来'); }
        },
        // Written each time (a failing write is reported while typing), then taken off the device when nothing is
        // left unapplied: a stored draft holds the entry's text three times and was kept for every entry opened.
        // A full storage first gives up settled save receipts.
        write(draft) {
            try {
                const storage = resolveStorage(), encoded = JSON.stringify(draft);
                try { storage.setItem(key(draft), encoded); } catch (error) { if (!pruneSettledPresetReceipts(storage)) throw error; storage.setItem(key(draft), encoded); }
                if (cleanPromptDraft(draft)) storage.removeItem(key(draft));
            } catch { throw presetError('PRESET_DRAFT_UNAVAILABLE', '草稿没存上，写的还在；先复制下来再离开或刷新'); }
        },
        /** Clears drafts earlier versions kept with nothing unapplied. Storage errors leave them. */
        pruneClean() {
            try {
                const storage = resolveStorage(), prefix = 'tavern-lite:preset-draft:', keys = [];
                for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k?.startsWith(prefix)) keys.push(k); }
                for (const k of keys) { let draft; try { draft = JSON.parse(storage.getItem(k)); } catch { continue; } if (draft && cleanPromptDraft(draft)) storage.removeItem(k); }
            } catch {}
        },
        remove(identity) { try { resolveStorage().removeItem(key(identity)); }
            catch { throw presetError('PRESET_DRAFT_UNAVAILABLE', '草稿没清掉，写的还在'); } },
    };
}
export function refreshPromptDraft(draft, remote) {
    if (remote === undefined) return { ...draft, conflict: { missing: true } };
    if (draft.text === draft.base) return { ...draft, base: remote, text: remote, conflict: null };
    if (remote === draft.text) return { ...draft, base: remote, conflict: null };
    return { ...draft, conflict: remote !== draft.base ? { before: draft.base, mine: draft.text, server: remote } : null };
}
export function applySavedPromptDraft(draft, submitted, saved) {
    return { ...draft, base: saved, text: draft.text === submitted.text && draft.revision === submitted.revision ? saved : draft.text, conflict: null };
}
export const canSubmitPresetKey = event => (event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing && event.keyCode !== 229;
