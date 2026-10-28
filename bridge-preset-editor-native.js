import { createPresetEditorAdapter } from './bridge-preset-editor.js';
import { clonePreset, PRESET_FIELDS, presetError, samePreset, normalizePresetTargetName } from './src/preset-editor-model.js';
import { validateEpisodeMeta } from './src/episode-model.js';

/** ST 1.16+ integration. No imports with startup side effects; the existing bridge supplies loaded modules.
 * Application is confirmed by getPresetApplicationPromise (1.19), or before that by the PRESET_CHANGED event that ends
 * the app's preset change; never by a selected option or a fixed wait.
 */
export function createNativePresetEditor({ account, st, openai, presetManager, ctx, enqueue, verifyAccount,
    assertSession = () => {}, document: doc = globalThis.document, window: win = globalThis.window,
    fetch: request = globalThis.fetch, journal, uuid } = {}) {
    const listeners = new Set(), currentDocument = doc; let epoch = 0;
    const publish = () => listeners.forEach(listener => listener());
    const eventSource = ctx().eventSource, types = ctx().eventTypes;
    const changed = () => { epoch++; publish(); };
    eventSource.on(types.OAI_PRESET_CHANGED_AFTER, changed);
    if (types.SETTINGS_UPDATED) eventSource.on(types.SETTINGS_UPDATED, publish);
    const owner = () => openai.promptManager?.activeCharacter ?? null;
    const APPLY_WAIT_MS = 60000;
    const appliedOnEvent = (name, select) => new Promise((resolve, reject) => {
        const done = data => { if (data?.apiId === 'openai' && data.name === name) { off(); resolve(); } };
        const timer = win.setTimeout(() => { off(); reject(presetError('PRESET_APPLY_UNCONFIRMED', '原版一直没切完这个预设，去原版界面看看现在用的是哪个')); }, APPLY_WAIT_MS);
        const off = () => { win.clearTimeout(timer); eventSource.removeListener(types.PRESET_CHANGED, done); };
        eventSource.on(types.PRESET_CHANGED, done);
        try { select(); } catch (error) { off(); reject(error); }
    });
    const accountCheck = lease => {
        assertSession();
        if (lease.account !== account || lease.document !== currentDocument || win.document !== currentDocument || !doc.documentElement.isConnected) {
            throw presetError('PRESET_ACCOUNT_CHANGED', '账号或页面变了，原稿还在；如果已经保存过，先回原账号检查一下');
        }
    };
    const makeLease = () => ({ account, document: currentDocument, epoch, name: openai.oai_settings?.preset_settings_openai });
    const assertLease = lease => {
        accountCheck(lease);
        if (epoch !== lease.epoch || openai.oai_settings?.preset_settings_openai !== lease.name || st.main_api !== 'openai') throw presetError('PRESET_CHANGED', '预设换了，原稿还在；这次的结果需要检查');
    };
    const sources = () => {
        const c = ctx(), character = c.characters?.[c.characterId], episode = validateEpisodeMeta(c.chatMetadata?.tavern_lite_episode, account);
        return { character: character?.name || '', persona: c.name1 || '',
            chat: c.getCurrentChatId?.() ? episode.kind === 'valid'
                ? `${{ root: '正文', side: '番外', parallel: '平行线', skit: '小剧场' }[episode.value.kind]} · ${episode.value.title}`
                : episode.kind === 'absent' ? '普通故事' : '来源没确认' : '', otherReferences: 'unknown' };
    };
    const current = () => {
        assertSession(); const settings = openai.oai_settings, pm = openai.promptManager;
        if (st.main_api !== 'openai' || !settings || !pm) return null;
        const samplers = {};
        for (const key of Object.keys(PRESET_FIELDS)) {
            const mapping = openai.settingsToUpdate[key]; if (!mapping || key === 'stream_openai') continue;
            const element = doc.querySelector(mapping[0]);
            const bound = value => value == null || value === '' ? null : Number(value);
            samplers[key] = { value: settings[mapping[1]], min: bound(element?.min), max: bound(element?.max), step: bound(element?.step) };
        }
        const prompts = pm.getPromptOrderForCharacter(owner()).map(entry => {
            const prompt = pm.getPromptById(entry.identifier);
            return prompt ? { ...clonePreset(prompt), identifier: entry.identifier, content: String(prompt.content ?? ''), enabled: !!entry.enabled,
                canToggle: !!pm.isPromptToggleAllowed(prompt), canEdit: !!pm.isPromptEditAllowed(prompt) && !prompt.marker } : null;
        }).filter(Boolean);
        return { account, name: String(settings.preset_settings_openai || ''), epoch, full: openai.getChatCompletionPreset(settings),
            samplers, stream: !!settings.stream_openai, prompts, sources: sources(), choices: Object.keys(openai.openai_setting_names) };
    };
    async function serverPresets() {
        const response = await request('/api/settings/get', { method: 'POST', headers: st.getRequestHeaders(), body: '{}' });
        if (!response.ok) throw presetError('PRESET_READ_UNCONFIRMED', '没读到预设文件，改动先留着');
        const data = await response.json();
        if (!Array.isArray(data.openai_setting_names) || !Array.isArray(data.openai_settings) || data.openai_setting_names.length !== data.openai_settings.length) throw presetError('PRESET_READ_UNCONFIRMED', '预设列表格式不对');
        return new Map(data.openai_setting_names.map((name, i) => [name, typeof data.openai_settings[i] === 'string' ? JSON.parse(data.openai_settings[i]) : data.openai_settings[i]]));
    }
    const fieldValue = key => {
        if (key.startsWith('enabled:')) return !!openai.promptManager?.getPromptOrderEntry(owner(), key.slice(8))?.enabled;
        const mapping = openai.settingsToUpdate[key];
        if (!Object.hasOwn(PRESET_FIELDS, key) || !mapping) throw presetError('PRESET_FIELD_UNKNOWN', '这一项请在原版界面里改');
        return openai.oai_settings[mapping[1]];
    };
    // Server filesystem sensitivity is not exposed by ST. Conservatively fold names
    // for locks/collisions; never infer it from the browser's operating system.
    const adapter = createPresetEditorAdapter({ account, apiId: 'openai', caseSensitiveNames: false, journal, uuid, enqueue, current, makeLease, assertLease, assertAccount: accountCheck, verifyAccount,
        async canonicalName(name) {
            const response = await request('/api/files/sanitize-filename', { method: 'POST', headers: st.getRequestHeaders(), body: JSON.stringify({ fileName: name }) });
            if (!response.ok) throw presetError('PRESET_NAME_UNCONFIRMED', '没法确认名字能不能用，这次没存');
            const result = await response.json();
            if (typeof result.fileName !== 'string') throw presetError('PRESET_NAME_UNCONFIRMED', '没法确认名字能不能用，这次没存');
            return result.fileName;
        },
        readNamed: async name => clonePreset((await serverPresets()).get(name) ?? null), listNamed: async () => [...(await serverPresets()).keys()],
        fieldValue,
        async applyField(key, value) {
            if (key.startsWith('enabled:')) {
                const id = key.slice(8), pm = openai.promptManager, entry = pm.getPromptOrderEntry(owner(), id), prompt = pm.getPromptById(id);
                if (!entry || !prompt || !pm.isPromptToggleAllowed(prompt) || typeof value !== 'boolean') throw presetError('PRESET_FIELD_UNKNOWN', '这个开关不能在这里修改');
                entry.enabled = value; pm.render?.(); await pm.saveServiceSettings();
            } else {
                fieldValue(key); const [selector] = openai.settingsToUpdate[key];
                if (key === 'stream_openai') win.$(selector).prop('checked', !!value).trigger('change');
                else {
                    if (!Number.isFinite(value)) throw presetError('PRESET_FIELD_INVALID', '请输入数字');
                    win.$(selector).val(value).trigger('input');
                }
            }
            publish();
        },
        // As the full app's drag and drop does: the order list of the active character (or the global one).
        async movePrompt(identifier, to) {
            const pm = openai.promptManager, order = pm.getPromptOrderForCharacter(owner()), from = order.findIndex(entry => entry.identifier === identifier);
            if (from < 0) throw presetError('PRESET_PROMPT_MISSING', '这个条目不在了');
            order.splice(to, 0, order.splice(from, 1)[0]);
            pm.render?.(); await pm.saveServiceSettings(); publish();
        },
        // A copy is a prompt of the user's own (deletable in the full app), placed right below its source and off, so
        // the same text is not sent twice until it is switched on.
        async copyPrompt(identifier, created, name) {
            const pm = openai.promptManager, order = pm.getPromptOrderForCharacter(owner()), prompt = pm.getPromptById(identifier);
            const from = order.findIndex(entry => entry.identifier === identifier);
            if (!prompt || from < 0) throw presetError('PRESET_PROMPT_MISSING', '这个条目不在了');
            if (prompt.marker) throw presetError('PRESET_PROMPT_MISSING', '位置标记没有正文，不能复制');
            const copy = clonePreset(prompt); delete copy.identifier;
            pm.addPrompt({ ...copy, name: name || `${prompt.name || identifier} 副本`, system_prompt: false, marker: false, enabled: false }, created);
            order.splice(from + 1, 0, { identifier: created, enabled: false });
            pm.render?.(); await pm.saveServiceSettings(); publish();
        },
        async applyPrompt(identifier, content) {
            const pm = openai.promptManager, prompt = pm.getPromptById(identifier);
            if (!prompt || !pm.isPromptEditAllowed(prompt) || prompt.marker) throw presetError('PRESET_PROMPT_MISSING', '这个提示词不能在这里改');
            pm.updatePromptByIdentifier(identifier, { content: String(content) }); pm.render?.(); await pm.saveServiceSettings(); publish();
        },
        async writeNamed(name, snapshot) {
            const response = await request('/api/presets/save', { method: 'POST', headers: st.getRequestHeaders(), body: JSON.stringify({ apiId: 'openai', name, preset: snapshot }) });
            // Even an ST-originated error may occur after the file write. The
            // adapter confirms only via an independent complete readback.
            if (!response.ok) throw presetError('PRESET_SAVE_UNCONFIRMED', `保存预设时返回 HTTP ${response.status}，还不知道存没存上，检查一下`);
            const result = await response.json(); if (result.name !== normalizePresetTargetName(name)) throw presetError('PRESET_SAVE_UNCONFIRMED', '存下的名字对不上，先检查一下');
        },
        registerNamed(name, snapshot) {
            const names = openai.openai_setting_names, list = openai.openai_settings;
            let index = names[name];
            if (index === undefined) { index = list.length; names[name] = index; list.push(clonePreset(snapshot)); }
            else list[index] = clonePreset(snapshot);
            const select = doc.getElementById('settings_preset_openai');
            if (!select) throw presetError('PRESET_SELECT_MISSING', '预设已保存，原版列表还没刷新');
            if (![...select.options].some(option => option.value === String(index))) select.add(new win.Option(name, String(index), false, false));
            publish();
        },
        async useNamed(name, lease) {
            assertLease(lease);
            const manager = presetManager.getPresetManager('openai');
            const index = String(openai.openai_setting_names[name]);
            if (manager && typeof openai.getPresetApplicationPromise === 'function') {
                await manager.selectPreset(index);
                await openai.getPresetApplicationPromise();
            } else if (manager && types.PRESET_CHANGED) await appliedOnEvent(name, () => manager.selectPreset(index));
            else throw presetError('PRESET_APPLY_UNSUPPORTED', '副本已保存，但没法确认用上了，请在原版界面选它');
            accountCheck(lease);
        },
        matchesApplied(expected, actual) {
            return Object.entries(openai.settingsToUpdate).every(([key, [, , , connection]]) => {
                if (connection && !openai.oai_settings.bind_preset_to_connection || expected[key] === undefined) return true;
                return samePreset(actual.full[key], expected[key]);
            });
        },
    });
    return { ...adapter, onPresetEditorChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        disposePresetEditor() { listeners.clear(); eventSource.removeListener(types.OAI_PRESET_CHANGED_AFTER, changed); if (types.SETTINGS_UPDATED) eventSource.removeListener(types.SETTINGS_UPDATED, publish); } };
}
