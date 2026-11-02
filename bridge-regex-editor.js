import { normalizeScript, problemOf, scriptFingerprint } from './src/regex-model.js';

// The app's regex scripts, read and changed the way its own regex panel does (extensions/regex/index.js): the same
// lists, the same "allowed to run" lists for presets and characters, the same saved sets of switches
// (extension_settings.regex_presets). Every change ends in the app's own list refresh and chat reload, so its panel
// and the open story show the new state. Bound to the app in bridge-regex-editor-native.js; tests pass fakes.

const TYPE = { global: 0, scoped: 1, preset: 2 };
const regexError = (code, message, detail) => Object.assign(new Error(message), { code, ...(detail ? { detail } : {}) });
// The change is on the page (and in the app) but the server did not take it; the next save of that list carries it.
const notSaved = cause => Object.assign(regexError('REGEX_NOT_SAVED', '没存到服务器上，可能连不上了。改动还在，先别刷新页面，过一会儿再存一次'), { cause });
const sameScripts = (a, b) => Array.isArray(a) && a.length === b.length && a.every((s, i) => String(s?.id) === String(b[i]?.id) && scriptFingerprint(s) === scriptFingerprint(b[i]));

export function createRegexEditor(h) {
    const { engine } = h, listeners = new Set();
    const publish = () => listeners.forEach(listener => { try { listener(); } catch { /* a page that went away */ } });
    // A list the app has not refreshed in its own panel since a change could not go through that panel.
    let nativeStale = false;

    const live = group => {
        const list = engine.getScriptsByType(TYPE[group]);
        return Array.isArray(list) ? list : [];
    };
    // As the app's list does when it shows scripts: one without an id gets one, on the script itself.
    const withIds = list => { for (const script of list) if (script && !script.id) script.id = h.uuid(); return list; };
    const presetOwner = () => { const apiId = engine.getCurrentPresetAPI?.() ?? null, name = engine.getCurrentPresetName?.() ?? null; return apiId && name ? { apiId, name } : null; };
    const presetKey = owner => owner ? `${owner.apiId}\u0000${owner.name}` : '';
    const describeScripts = group => withIds(live(group)).filter(s => s && typeof s === 'object').map((script, index) => {
        const value = normalizeScript(script);
        return { id: String(script.id), index, ...value, problem: problemOf(value) };
    });
    const enabledIds = group => live(group).filter(s => s && !s.disabled).map(s => String(s.id));
    const sameSet = (a = [], b = []) => a.length === b.length && a.every(id => b.includes(id));

    function regexEditorState() {
        h.assertSession();
        const settings = h.settings(), preset = presetOwner(), { character, group } = h.character();
        const groups = [
            { type: 'global', allowed: true, canEdit: true, owner: '', scripts: describeScripts('global') },
            { type: 'preset', allowed: !!preset && !!engine.isPresetScriptsAllowed(preset.apiId, preset.name), canEdit: !!preset, owner: preset?.name ?? '',
                reason: preset ? '' : '现在的连接没有预设', scripts: preset ? describeScripts('preset') : [] },
            { type: 'scoped', allowed: !!character && !!engine.isScopedScriptsAllowed(character), canEdit: !!character && !group, owner: character?.name ?? '',
                reason: group ? '群聊里不能改角色自带的正则' : character ? '' : '打开一个角色的故事后，这里显示它自带的正则', scripts: character && !group ? describeScripts('scoped') : [] },
        ];
        const enabled = Object.fromEntries(groups.map(g => [g.type, g.scripts.filter(s => !s.disabled).map(s => s.id)]));
        const combos = (Array.isArray(settings.regex_presets) ? settings.regex_presets : []).filter(p => p && p.id).map(p => {
            const ids = type => (Array.isArray(p[type]) ? p[type] : []).map(item => String(item?.id));
            const combo = { id: String(p.id), name: String(p.name ?? ''), selected: !!p.isSelected, global: ids('global'), scoped: ids('scoped'), preset: ids('preset') };
            return { ...combo, matches: groups.every(g => sameSet(combo[g.type], enabled[g.type])) };
        });
        return { account: h.account, managingOtherCharacter: !!h.foreignCharacter?.(), extensionOff: !!settings.disabledExtensions?.includes('regex'), nativeStale, groups, combos,
            owner: { preset: presetKey(preset), scoped: character?.avatar ?? '' } };
    }

    function assertOwner(groups, owner = {}) {
        if (groups.includes('preset')) {
            if (!presetOwner()) throw regexError('REGEX_NO_PRESET', '现在的连接没有预设，预设里的正则改不了');
            if (presetKey(presetOwner()) !== owner.preset) throw regexError('REGEX_OWNER_CHANGED', '预设换了，刚才的改动没存，已重新加载');
        }
        if (groups.includes('scoped')) {
            const { character, group } = h.character();
            if (group) throw regexError('REGEX_GROUP_CHAT', '群聊里不能改角色自带的正则');
            if (!character) throw regexError('REGEX_NO_CHARACTER', '先打开一个角色的故事，再改它自带的正则');
            if (character.avatar !== owner.scoped) throw regexError('REGEX_OWNER_CHANGED', '角色换了，刚才的改动没存，已重新加载');
        }
    }
    const find = (group, id) => {
        const list = live(group), index = list.findIndex(s => String(s?.id) === String(id));
        if (index < 0) throw regexError('REGEX_MISSING', '这条正则已经不在了，已重新加载');
        return { list, index, script: list[index] };
    };
    const assertBase = (script, base) => {
        if (base !== undefined && scriptFingerprint(script) !== base) throw regexError('REGEX_CHANGED', '这条正则在别处改过了，你写的还在，看过再存', { current: normalizeScript(script) });
    };
    // As the app's saveRegexScript does after a script is saved into the preset's or the character's list. Unlike the
    // app, only when a script there ends up on: switching one off does not set the rest of a list that was kept from
    // running going again.
    const allowAfterSave = group => {
        if (group === 'preset') { const owner = presetOwner(); const was = engine.isPresetScriptsAllowed(owner.apiId, owner.name); engine.allowPresetScripts(owner.apiId, owner.name); return !was; }
        if (group === 'scoped') { const { character } = h.character(); const was = engine.isScopedScriptsAllowed(character); engine.allowScopedScripts(character); return !was; }
        return false;
    };

    /**
     * Saves the given lists as they now are (each the app's own array, changed in place), the last one through the
     * app's own panel so it redraws and reloads the story. A list the app keeps nowhere yet (a preset or character
     * without scripts) is first written once so the panel finds it. `flush`: the account settings changed too (a list
     * allowed to run) and are written now, not after the usual pause.
     *
     * Done only when the server has them: the app's own saves of the settings and of a character's card show a failure
     * in its (hidden) page and return as usual, so the settings save is waited on for its answer and the card read back.
     */
    async function persist(groups, lists, flush = false) {
        const order = [...new Set(groups)], last = order.at(-1);
        try {
            for (const group of order.slice(0, -1)) await engine.saveScriptsByType(lists[group], TYPE[group]);
            let saved = false;
            if (engine.getScriptsByType(TYPE[last]) !== lists[last]) { await engine.saveScriptsByType(lists[last], TYPE[last]); saved = true; }
            // False when the panel is not there; a failure inside its save is not taken for that.
            const redrawn = await h.native.commit(TYPE[last], live(last));
            if (!redrawn && !saved) await engine.saveScriptsByType(live(last), TYPE[last]);
            h.saveSettingsDebounced();
            if (!redrawn) {
                if (!h.foreignCharacter?.() || order.some(group => group !== 'scoped')) {
                    nativeStale = true; if (h.chatOpen()) await h.reloadChat();
                }
            } else nativeStale = false;
            if (flush || order.includes('global')) await h.flushSettings?.();
            if (order.includes('scoped')) await confirmScoped();
        } catch (error) { throw error?.code === 'REGEX_NOT_SAVED' ? error : notSaved(error); }
        publish();
    }
    async function confirmScoped() {
        const saved = await h.native.savedCharacterScripts?.();
        if (saved !== undefined && saved !== null && !sameScripts(saved, live('scoped'))) throw notSaved();
    }
    const flushNow = async () => { try { await h.flushSettings?.(); } catch (error) { throw notSaved(error); } };

    // Every change runs after whatever the app is doing (a reply being written) and checks the account first. Each
    // checks everything it is about to change before changing any of it, so a refusal leaves the lists as they were;
    // only a save the server did not take leaves a change behind (on the page too, so it is told).
    const write = (groups, owner, work) => h.enqueue(async () => {
        await h.waitIdle(); await h.verifyAccount(); h.assertSession();
        assertOwner(groups, owner);
        try {
            await h.beforeWrite?.(groups);
            const result = await work();
            return { ...(result ?? {}), state: regexEditorState() };
        } catch (error) { if (['REGEX_NOT_SAVED', 'REGEX_CHARACTER_CHANGED'].includes(error?.code)) publish(); throw error; }
    });

    return {
        regexEditorState,
        onRegexEditorChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        regexEditorChanged: publish,

        /** One switch, as the switch on the app's list: saved with the script, and the preset or character allowed when it is on. */
        regexToggle: ({ group, id, disabled, owner, base }) => write([group], owner, async () => {
            const { list, script } = find(group, id);
            assertBase(script, base);
            script.disabled = !!disabled;
            const allowedNow = !disabled && allowAfterSave(group);
            await persist([group], { [group]: list }, allowedNow);
            return { allowedNow };
        }),

        /** Several switches at once; switched on, their preset or character is allowed, as with one switch. */
        regexSetEnabled: ({ items, enabled, owner }) => write([...new Set(items.map(i => i.group))], owner, async () => {
            const groups = [...new Set(items.map(i => i.group))], lists = {}, switched = new Set();
            const found = items.map(item => ({ group: item.group, ...find(item.group, item.id) }));
            let changed = 0;
            for (const { group, list, script } of found) {
                lists[group] = list;
                if (!!script.disabled === enabled) { script.disabled = !enabled; changed++; switched.add(group); }
            }
            let allowedNow = false;
            if (enabled) for (const group of switched) if (allowAfterSave(group)) allowedNow = true;
            if (changed) await persist(groups, lists, allowedNow);
            return { changed, allowedNow };
        }),

        /**
         * A new script (`id` empty; `newId` the id the page gave it) or the changed fields of one; fields the editor does
         * not show stay on the script. Tried again after a save the server did not take, it is saved over, not added twice.
         */
        regexSave: ({ group, id, newId, script, owner, base }) => write([group], owner, async () => {
            const value = normalizeScript(script);
            if (!value.scriptName.trim()) throw regexError('REGEX_NO_NAME', '先起个名字');
            const again = !id && !!newId && live(group).some(s => String(s?.id) === String(newId));
            let target, list;
            if (id || again) {
                ({ list, script: target } = find(group, id || newId));
                // Already as written here (that earlier try) is not a change made elsewhere.
                if (!again && scriptFingerprint(target) !== scriptFingerprint(value)) assertBase(target, base);
                Object.assign(target, value);
            } else {
                list = live(group); target = { id: newId ? String(newId) : h.uuid(), ...value }; list.push(target);
            }
            const allowedNow = !value.disabled && allowAfterSave(group);
            await persist([group], { [group]: list }, allowedNow);
            return { id: String(target.id), allowedNow };
        }),

        regexDelete: ({ group, items, owner }) => write([group], owner, async () => {
            const list = live(group);
            const doomed = new Set(items.map(item => { const { script } = find(group, item.id); assertBase(script, item.base); return script; }));
            for (let index = list.length - 1; index >= 0; index--) if (doomed.has(list[index])) list.splice(index, 1);
            await persist([group], { [group]: list });
            return { deleted: doomed.size };
        }),

        /**
         * To another list (the app's moveRegexScript: out of one, appended to the other, which is then allowed). The list
         * moved to is saved first: a save that does not go through leaves a script in both, not in neither.
         */
        regexMove: ({ from, to, items, owner }) => write([from, to], owner, async () => {
            if (from === to) return { moved: 0 };
            const source = live(from), target = live(to);
            const scripts = [...new Set(items.map(item => { const { script } = find(from, item.id); assertBase(script, item.base); return script; }))];
            for (const script of scripts) { source.splice(source.indexOf(script), 1); target.push(script); }
            const allowedNow = scripts.some(s => !s.disabled) && allowAfterSave(to);
            await persist([to, from], { [from]: source, [to]: target }, allowedNow);
            return { moved: scripts.length, allowedNow };
        }),

        /** Within its list, as dragging in the app's panel. */
        regexReorder: ({ group, id, to, owner }) => write([group], owner, async () => {
            const { list, index } = find(group, id), position = Math.max(0, Math.min(list.length - 1, Number(to)));
            if (position === index) return {};
            list.splice(position, 0, list.splice(index, 1)[0]);
            await persist([group], { [group]: list });
            return {};
        }),

        /** Whether the preset's or the character's own scripts run at all (the app's two "allow" switches). */
        regexAllow: ({ group, allowed, owner }) => write([group], owner, async () => {
            if (group === 'preset') { const p = presetOwner(); (allowed ? engine.allowPresetScripts : engine.disallowPresetScripts)(p.apiId, p.name); }
            else { const { character } = h.character(); (allowed ? engine.allowScopedScripts : engine.disallowScopedScripts)(character); }
            h.native.showAllowed(TYPE[group], allowed);
            // Otherwise the reload below may stop on the app's one-time "allow its scripts?" question.
            if (!allowed) h.native.markAnswered?.(TYPE[group]);
            h.saveSettingsDebounced(); await flushNow();
            if (h.chatOpen() && (group !== 'scoped' || !h.foreignCharacter?.())) await h.reloadChat();
            publish();
            return {};
        }),

        /**
         * Scripts from an exported file, each with a new id (the app's import). `ids`, one per script, are the ids the
         * page gave them: tried again after a save the server did not take, the ones already in are not added twice.
         */
        regexImport: ({ group, scripts, ids = [], owner }) => write([group], owner, async () => {
            const list = live(group), have = new Set(list.map(s => String(s?.id)));
            let imported = 0;
            scripts.forEach((script, index) => {
                if (!script || typeof script !== 'object' || !String(script.scriptName ?? '').trim()) return;
                const id = ids[index] ? String(ids[index]) : h.uuid();
                if (!have.has(id)) list.push({ ...script, id });
                imported++;
            });
            if (imported) {
                // Import keeps the existing group permission. Otherwise the first scoped/preset import can save,
                // then block reloadCurrentChat on an invisible native "allow embedded scripts?" confirmation.
                // The shell already exposes this decision as the group's explicit allow switch.
                if (group === 'scoped' && !engine.isScopedScriptsAllowed(h.character().character)) h.native.markAnswered?.(TYPE[group]);
                if (group === 'preset') {
                    const p = presetOwner();
                    if (!engine.isPresetScriptsAllowed(p.apiId, p.name)) h.native.markAnswered?.(TYPE[group]);
                }
                await persist([group], { [group]: list });
            }
            return { imported };
        }),

        /**
         * Switches every listed script on and the rest off, through the app's own set picker. The app also moves the
         * switched-off scripts to the front of their list; the order they run in is put back afterwards.
         */
        regexComboApply: ({ id, owner }) => write([...(presetOwner() ? ['preset'] : []), ...(h.character().character && !h.character().group ? ['scoped'] : [])], owner, async () => {
            if (h.foreignCharacter?.()) throw regexError('REGEX_OWNER_CHANGED', '请先切回当前故事的角色，再使用开关组合');
            const settings = h.settings(), combo = (settings.regex_presets ?? []).find(p => String(p.id) === String(id));
            if (!combo) throw regexError('REGEX_COMBO_MISSING', '这个组合已经不在了');
            const name = String(combo.name ?? '');
            if (combo.isSelected && regexEditorState().combos.find(c => c.id === String(combo.id))?.matches) return { name, unchanged: true };
            const groups = ['global', ...(presetOwner() ? ['preset'] : []), ...(h.character().character && !h.character().group ? ['scoped'] : [])];
            const orders = Object.fromEntries(groups.map(group => [group, live(group).map(s => String(s?.id))]));
            // The app marks a set chosen only once it has switched, saved, redrawn and reloaded the story; unmarked
            // first, so waiting for that mark waits for all of it, also for the set that was chosen already.
            const chosen = settings.regex_presets.filter(p => p.isSelected);
            settings.regex_presets.forEach(p => { p.isSelected = false; });
            let applied;
            try { applied = await h.native.applyCombo(String(combo.id)); }
            catch (error) { if (!settings.regex_presets.some(p => p.isSelected)) chosen.forEach(p => { p.isSelected = true; }); throw error; }
            if (applied) {
                const moved = groups.filter(group => live(group).map(s => String(s?.id)).join('\n') !== orders[group].join('\n'));
                const rank = (group, script) => { const at = orders[group].indexOf(String(script?.id)); return at < 0 ? orders[group].length : at; };
                for (const group of moved) live(group).sort((a, b) => rank(group, a) - rank(group, b));
                if (moved.length) await persist(moved, Object.fromEntries(moved.map(group => [group, live(group)])), true);
                else await flushNow();
                if (groups.includes('scoped') && !moved.includes('scoped')) await confirmScoped();
            } else {
                // The app's panel is not there (regex turned off in it): the same switches, without its redraw.
                try {
                    for (const group of groups) {
                        const list = live(group), listed = (combo[group] ?? []).map(item => String(item?.id));
                        list.forEach(script => { script.disabled = !listed.includes(String(script.id)); });
                        await engine.saveScriptsByType(list, TYPE[group]);
                    }
                    settings.regex_presets.forEach(p => { p.isSelected = p === combo; });
                    h.saveSettingsDebounced(); await flushNow(); nativeStale = true;
                    if (groups.includes('scoped')) await confirmScoped();
                    if (h.chatOpen()) await h.reloadChat();
                } catch (error) { throw error?.code === 'REGEX_NOT_SAVED' ? error : notSaved(error); }
            }
            publish();
            return { name };
        }),

        /** Keeps which scripts are on now as a new set (the app's "save as"), or into an existing one (its "update"). */
        regexComboSave: ({ id, name }) => write([], {}, async () => {
            if (h.foreignCharacter?.()) throw regexError('REGEX_OWNER_CHANGED', '请先切回当前故事的角色，再保存开关组合');
            const settings = h.settings();
            if (!Array.isArray(settings.regex_presets)) settings.regex_presets = [];
            let combo = id ? settings.regex_presets.find(p => String(p.id) === String(id)) : null;
            if (id && !combo) throw regexError('REGEX_COMBO_MISSING', '这个组合已经不在了');
            if (!combo) {
                if (!String(name ?? '').trim()) throw regexError('REGEX_NO_NAME', '先起个名字');
                combo = { id: h.uuid(), name: String(name).trim(), isSelected: false };
                settings.regex_presets.push(combo);
            }
            const items = group => enabledIds(group).map(itemId => ({ id: itemId }));
            Object.assign(combo, { global: items('global'), scoped: items('scoped'), preset: items('preset') });
            settings.regex_presets.forEach(p => { p.isSelected = p === combo; });
            h.native.showCombos(settings.regex_presets, String(combo.id));
            h.saveSettingsDebounced(); await flushNow();
            publish();
            return { id: String(combo.id), name: combo.name };
        }),

        /** Only the set goes; which scripts are on stays as it is (the app also switches to the first remaining set). */
        regexComboDelete: ({ id }) => write([], {}, async () => {
            const settings = h.settings(), list = Array.isArray(settings.regex_presets) ? settings.regex_presets : [];
            const index = list.findIndex(p => String(p.id) === String(id));
            if (index < 0) throw regexError('REGEX_COMBO_MISSING', '这个组合已经不在了');
            const [removed] = list.splice(index, 1);
            h.native.showCombos(list, list.find(p => p.isSelected)?.id ?? '');
            h.saveSettingsDebounced(); await flushNow();
            publish();
            return { name: String(removed.name ?? '') };
        }),

        /** What a script would make of some text, run by the app (macros resolved for the open character). */
        regexTest({ script, text }) {
            h.assertSession();
            if (h.foreignCharacter?.()) return { output: String(text ?? ''), error: '要试替换，请先打开这个角色的故事' };
            const value = { ...normalizeScript(script), id: 'tavern-lite-test', disabled: false, placement: null };
            try { return { output: String(engine.runRegexScript(value, String(text ?? ''))) }; }
            catch (error) { return { output: String(text ?? ''), error: String(error?.message ?? error) }; }
        },
        /** The open story's latest reply, as stored: something real to try a script on. */
        regexSample: () => h.sampleText(),
    };
}
