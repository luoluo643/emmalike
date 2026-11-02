import { createRegexEditor } from './bridge-regex-editor.js';
import { createRegexCharacterTarget } from './bridge-regex-character-target.js';

/** ST 1.16+ binding (the regex extension is the same in 1.16–1.19). Queue, account and page checks come from bridge.js. */
// The app's three lists in its regex panel, by script type (engine.js SCRIPT_TYPES).
const LISTS = { 0: '#saved_regex_scripts', 1: '#saved_scoped_scripts', 2: '#saved_preset_scripts' };
const ALLOW_SWITCHES = { 1: '#regex_scoped_toggle', 2: '#regex_preset_toggle' };
const APPLY_WAIT_MS = 20000;

export function createNativeRegexEditor({ account, regexEngine, extensions, st, groupChats, ctx, uuid, enqueue, waitIdle, verifyAccount, assertSession, waitFor,
    window: win = globalThis.window, document: doc = globalThis.document }) {
    const $ = (...args) => win.$(...args);
    const settings = () => extensions.extension_settings;
    const character = () => {
        const chid = st.this_chid, group = !!groupChats.selected_group;
        return { character: chid !== undefined && chid !== null ? st.characters?.[chid] ?? null : null, group };
    };
    const target = createRegexCharacterTarget({ current: character, characters: () => st.characters ?? [], assertSession,
        async readCard(avatar) {
            const response = await win.fetch('/api/characters/get', { method: 'POST', headers: st.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
            if (!response.ok) throw new Error('角色没有加载成功，请重试');
            return response.json();
        },
        async writeScripts(index, scripts) {
            if (typeof extensions.writeExtensionField !== 'function') throw new Error('当前酒馆版本不支持，请在原版界面操作');
            await extensions.writeExtensionField(index, 'regex_scripts', scripts);
        },
    });
    const scopedEngine = { ...regexEngine,
        getScriptsByType: type => type === 1 && target.foreign() ? target.scripts() : regexEngine.getScriptsByType(type),
        saveScriptsByType: (scripts, type) => type === 1 && target.foreign() ? target.save(scripts) : regexEngine.saveScriptsByType(scripts, type),
    };
    const editor = createRegexEditor({
        account, engine: scopedEngine, settings, character: target.character, foreignCharacter: target.foreign, beforeWrite: target.beforeWrite,
        uuid, enqueue, waitIdle, verifyAccount, assertSession,
        saveSettingsDebounced: () => st.saveSettingsDebounced(),
        // The app's saveSettings shows a failure in its own page and returns as usual; it says SETTINGS_UPDATED only
        // once the server took them.
        flushSettings: typeof st.saveSettings === 'function' ? async () => {
            const source = ctx().eventSource, name = ctx().eventTypes.SETTINGS_UPDATED;
            if (!name || typeof source.removeListener !== 'function') return st.saveSettings();
            let done = false; const mark = () => { done = true; };
            source.on(name, mark);
            try { await st.saveSettings(); } finally { source.removeListener(name, mark); }
            if (!done) throw new Error('settings not saved');
        } : null,
        chatOpen: () => !!st.getCurrentChatId?.(),
        reloadChat: () => st.reloadCurrentChat(),
        sampleText() {
            if (target.foreign()) return '';
            const reply = [...(ctx().chat ?? [])].reverse().find(m => m && !m.is_user && !m.is_system && m.mes);
            return String(reply?.mes ?? '');
        },
        native: {
            /**
             * Saves one list through the app's own reordering (the sortable list's stop handler): it keeps the scripts in
             * the order of the rows, saves them, reloads the story and redraws all three lists. The rows are put in the
             * list's present order first; a script without a row yet gets a stand-in the redraw replaces.
             */
            async commit(type, scripts) {
                if (type === 1 && target.foreign()) return false;
                const list = $(LISTS[type]);
                let stop = null;
                try { stop = list.length ? list.sortable('option', 'stop') : null; } catch { stop = null; }
                const ids = scripts.map(s => String(s?.id ?? ''));
                if (typeof stop !== 'function' || ids.some(id => !id) || new Set(ids).size !== ids.length) return false;
                const rows = new Map(list.children().toArray().map(el => [el.id, el]));
                list.children().detach();
                for (const id of ids) list.append(rows.get(id) ?? $('<div></div>').attr('id', id));
                await stop.call(list[0]);
                return true;
            },
            showAllowed(type, allowed) { if (type !== 1 || !target.foreign()) $(ALLOW_SWITCHES[type]).prop('checked', !!allowed); },
            /** The open character's scripts as its card on the server has them (the app's card save does not say when it fails). */
            async savedCharacterScripts() {
                if (target.foreign()) return target.saved();
                const { character: open, group } = character();
                if (!open?.avatar || group) return null;
                const response = await win.fetch('/api/characters/get', { method: 'POST', headers: st.getRequestHeaders(), body: JSON.stringify({ avatar_url: open.avatar }) });
                if (!response.ok) throw new Error(`character not read: ${response.status}`);
                const card = await response.json();
                const scripts = card?.data?.extensions?.regex_scripts;
                return Array.isArray(scripts) ? scripts : [];
            },
            /**
             * The app asks once whether to allow a character's (or preset's) scripts when one that is not allowed is
             * opened, and holds the story's reload until answered. Kept from running here is that answer.
             */
            markAnswered(type) {
                const storage = ctx().accountStorage;
                if (!storage) return;
                if (type === 1) { const avatar = target.character().character?.avatar; if (avatar) storage.setItem(`AlertRegex_${avatar}`, 'true'); }
                if (type === 2) {
                    const apiId = regexEngine.getCurrentPresetAPI?.(), name = regexEngine.getCurrentPresetName?.();
                    if (apiId && name) storage.setItem(`AlertRegex_${apiId}_${name}`, 'true');
                }
            },
            /** The app's set picker, as its /regex-preset command uses it (no "unsaved changes" question). */
            async applyCombo(id) {
                const select = doc.getElementById('regex_presets');
                if (!select) return false;
                if (![...select.options].some(o => o.value === id)) this.showCombos(settings().regex_presets ?? [], id);
                select.value = id;
                select.dispatchEvent(new win.CustomEvent('change', { detail: { fromSlashCommand: true } }));
                const combo = () => (settings().regex_presets ?? []).find(p => String(p.id) === id);
                // Done when the app has marked it chosen and every listed script is on.
                const applied = () => {
                    const c = combo();
                    if (!c?.isSelected) return false;
                    return [[0, 'global'], [1, 'scoped'], [2, 'preset']].every(([type, key]) => {
                        if (type === 1 && (character().group || !character().character)) return true;
                        const listed = (c[key] ?? []).map(item => String(item?.id));
                        return (regexEngine.getScriptsByType(type) ?? []).every(s => !s.disabled === listed.includes(String(s.id)));
                    });
                };
                if (!await waitFor(applied, APPLY_WAIT_MS)) throw Object.assign(new Error('原版一直没切完这个组合，去原版界面看看现在开着哪些'), { code: 'REGEX_COMBO_UNCONFIRMED' });
                return true;
            },
            /** Redraws the app's set picker (its renderPresetList), without applying anything. */
            showCombos(list, selectedId) {
                const select = doc.getElementById('regex_presets');
                if (!select) return;
                select.innerHTML = '';
                for (const p of list) select.append(new win.Option(p.name, p.id, String(p.id) === String(selectedId), String(p.id) === String(selectedId)));
                if (!list.length) select.append(new win.Option('—', '', true, true));
                select.disabled = !list.length;
            },
        },
    });
    // The page asks again when the app changes something on its own: another preset or character, its own panel.
    const types = ctx().eventTypes, source = ctx().eventSource;
    for (const name of ['PRESET_CHANGED', 'CHAT_CHANGED', 'SETTINGS_UPDATED', 'MAIN_API_CHANGED']) if (types[name]) source.on(types[name], editor.regexEditorChanged);
    return Object.assign(editor, {
        regexCharacters: () => target.list(),
        regexSelectCharacter: avatar => enqueue(async () => {
            await waitIdle(); await verifyAccount(); assertSession();
            await target.select(avatar);
            editor.regexEditorChanged();
            return { state: editor.regexEditorState() };
        }),
    });
}
