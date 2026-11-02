import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegexEditor } from '../bridge-regex-editor.js';
import { scriptFingerprint } from '../src/regex-model.js';

const script = (id, name, extra = {}) => ({ id, scriptName: name, findRegex: `/${name}/g`, replaceString: '', trimStrings: [], placement: [2], disabled: false,
    markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null, ...extra });

/** The app as far as the regex panel uses it: three lists, the allow lists, its own redraw (or none). */
function setup({ commit = true, presetAbsent = false, character = { avatar: 'a.png', name: '甲' }, group = false, preset = { apiId: 'openai', name: 'P' }, applyCombo = null,
    flush = null, card = null } = {}) {
    const lists = { 0: [script('g1', '一'), script('g2', '二', { disabled: true, custom: 'kept' })], 1: [script('s1', '角')], 2: presetAbsent ? null : [script('p1', '预')] };
    const allowed = { preset: [], scoped: [] }, log = [];
    const settings = { regex: lists[0], regex_presets: [], disabledExtensions: [] };
    const engine = {
        getScriptsByType: t => Array.isArray(lists[t]) ? lists[t] : [],
        async saveScriptsByType(list, t) { lists[t] = list; if (t === 0) settings.regex = list; log.push(`save:${t}`); },
        getCurrentPresetAPI: () => preset?.apiId ?? null, getCurrentPresetName: () => preset?.name ?? null,
        isPresetScriptsAllowed: (api, name) => allowed.preset.includes(`${api}/${name}`), allowPresetScripts: (api, name) => { allowed.preset.push(`${api}/${name}`); log.push('allow:preset'); },
        disallowPresetScripts: (api, name) => { allowed.preset = allowed.preset.filter(x => x !== `${api}/${name}`); },
        isScopedScriptsAllowed: c => allowed.scoped.includes(c?.avatar), allowScopedScripts: c => { allowed.scoped.push(c.avatar); log.push('allow:scoped'); },
        disallowScopedScripts: c => { allowed.scoped = allowed.scoped.filter(x => x !== c.avatar); },
        runRegexScript: (s, text) => text.replace(new RegExp(s.findRegex.slice(1, -2), 'g'), s.replaceString),
    };
    let ids = 0, published = 0;
    const editor = createRegexEditor({
        account: 'me', engine, settings: () => settings, character: () => ({ character, group }), uuid: () => `new${++ids}`,
        enqueue: op => op(() => false), waitIdle: async () => {}, verifyAccount: async () => 'me', assertSession: () => {},
        saveSettingsDebounced: () => log.push('settings'), flushSettings: async () => { log.push('flush'); await flush?.(); }, chatOpen: () => true, reloadChat: async () => log.push('reload'),
        sampleText: () => '最近的回复',
        native: {
            async commit(type, scripts) { log.push(`commit:${type}:${scripts.map(s => s.id).join(',')}`); return commit; },
            showAllowed: (type, on) => log.push(`show-allowed:${type}:${on}`),
            markAnswered: type => log.push(`answered:${type}`),
            // The character's card as the server has it: what was saved, unless a test says otherwise.
            savedCharacterScripts: async () => card ? card(lists) : lists[1],
            applyCombo: async id => applyCombo ? applyCombo(id, { lists, settings, log }) : false,
            showCombos: () => log.push('show-combos'),
        },
    });
    editor.onRegexEditorChange(() => published++);
    const state = () => editor.regexEditorState();
    return { editor, lists, allowed, log, settings, state, owner: () => state().owner, published: () => published };
}

test('the three lists in the order the app runs them, with what keeps a script from working', () => {
    const t = setup();
    t.lists[0].push({ scriptName: '没 id', findRegex: '', placement: [] });
    const s = t.state();
    assert.deepEqual(s.groups.map(g => g.type), ['global', 'preset', 'scoped']);
    assert.equal(t.lists[0][2].id, 'new1', 'a script without an id gets one on itself, as the app does');
    assert.equal(s.groups[0].scripts[2].problem, '没写要找的内容，不会生效');
    assert.deepEqual([s.groups[1].owner, s.groups[1].allowed, s.groups[2].owner, s.groups[2].canEdit], ['P', false, '甲', true]);
    assert.deepEqual(s.owner, { preset: 'openai\u0000P', scoped: 'a.png' });
});

test('no character, a group chat, no preset: those lists say why', () => {
    assert.match(setup({ character: null }).state().groups[2].reason, /打开一个角色/);
    const group = setup({ group: true }).state().groups[2];
    assert.deepEqual([group.canEdit, group.scripts.length], [false, 0]);
    assert.match(group.reason, /群聊/);
    assert.equal(setup({ preset: null }).state().groups[1].canEdit, false);
});

test('a switch: changed on the script itself, saved through the app panel; switched on, the preset is allowed (and that written now)', async () => {
    const t = setup(), before = t.lists[2][0];
    const off = await t.editor.regexToggle({ group: 'preset', id: 'p1', disabled: true, owner: t.owner(), base: scriptFingerprint(before) });
    assert.equal(t.lists[2][0], before, 'same object, so the app panel stays in step');
    assert.equal(before.disabled, true);
    assert.equal(off.allowedNow, false, 'switching one off does not set a list kept from running going again');
    assert.deepEqual(t.log, ['commit:2:p1', 'settings']);
    assert.equal(off.state.groups[1].allowed, false);
    const on = await t.editor.regexToggle({ group: 'preset', id: 'p1', disabled: false, owner: t.owner(), base: scriptFingerprint(before) });
    assert.equal(on.allowedNow, true);
    assert.deepEqual(t.log.slice(2), ['allow:preset', 'commit:2:p1', 'settings', 'flush']);
    assert.equal(on.state.groups[1].allowed, true);
    assert.ok(t.published() > 0);
});

test('a switch changed elsewhere since it was shown is not overwritten', async () => {
    const t = setup(), base = scriptFingerprint(t.lists[0][0]);
    t.lists[0][0].findRegex = '/别处改了/g';
    await assert.rejects(t.editor.regexToggle({ group: 'global', id: 'g1', disabled: true, owner: t.owner(), base }), e => e.code === 'REGEX_CHANGED' && e.detail.current.findRegex === '/别处改了/g');
    assert.equal(t.lists[0][0].disabled, false);
    assert.deepEqual(t.log, []);
});

test('another preset or character since the page read: nothing is written', async () => {
    const t = setup();
    await assert.rejects(t.editor.regexToggle({ group: 'preset', id: 'p1', disabled: true, owner: { preset: 'openai\u0000Other', scoped: 'a.png' } }), e => e.code === 'REGEX_OWNER_CHANGED');
    await assert.rejects(t.editor.regexToggle({ group: 'scoped', id: 's1', disabled: true, owner: { scoped: 'b.png' } }), e => e.code === 'REGEX_OWNER_CHANGED');
    assert.deepEqual(t.log, []);
});

test('saving keeps what the editor does not show; a new script goes last with a new id', async () => {
    const t = setup(), target = t.lists[0][1];
    await t.editor.regexSave({ group: 'global', id: 'g2', script: { ...target, scriptName: '改名', replaceString: 'x' }, owner: t.owner(), base: scriptFingerprint(target) });
    assert.equal(t.lists[0][1], target);
    assert.deepEqual([target.scriptName, target.replaceString, target.custom, target.id], ['改名', 'x', 'kept', 'g2']);
    const created = await t.editor.regexSave({ group: 'scoped', id: '', script: { scriptName: '新的', findRegex: '/a/', placement: [2] }, owner: t.owner() });
    assert.equal(created.id, 'new1');
    assert.equal(t.lists[1].at(-1).scriptName, '新的');
    assert.equal(created.allowedNow, true, 'saving into the character list allows it, as the app does');
    const t2 = setup();
    const savedOff = await t2.editor.regexSave({ group: 'preset', id: '', script: { scriptName: '关着的', findRegex: '/a/', placement: [2], disabled: true }, owner: t2.owner() });
    assert.equal(savedOff.allowedNow, false, 'one saved switched off does not allow the list');
    await assert.rejects(t.editor.regexSave({ group: 'global', id: '', script: { scriptName: ' ' }, owner: t.owner() }), e => e.code === 'REGEX_NO_NAME');
});

test('a preset that had no scripts yet is written once, then saved through the panel', async () => {
    const t = setup({ presetAbsent: true });
    await t.editor.regexSave({ group: 'preset', id: '', script: { scriptName: '第一条', findRegex: '/a/', placement: [2] }, owner: t.owner() });
    assert.deepEqual(t.log.filter(x => x.startsWith('save') || x.startsWith('commit')), ['save:2', 'commit:2:new1']);
    assert.equal(t.lists[2].length, 1);
});

test('without the app panel (regex turned off there): saved directly, the story reloaded, and the page told', async () => {
    const t = setup({ commit: false });
    const result = await t.editor.regexToggle({ group: 'global', id: 'g1', disabled: true, owner: t.owner() });
    assert.deepEqual(t.log, ['commit:0:g1,g2', 'save:0', 'settings', 'reload', 'flush']);
    assert.equal(result.state.nativeStale, true);
});

test('move, reorder, delete, import and several switches, the app way', async () => {
    const t = setup();
    const moved = await t.editor.regexMove({ from: 'global', to: 'preset', items: [{ id: 'g1' }], owner: t.owner() });
    assert.deepEqual(t.lists[0].map(s => s.id), ['g2']);
    assert.deepEqual(t.lists[2].map(s => s.id), ['p1', 'g1']);
    assert.equal(moved.allowedNow, true);
    assert.ok(t.log.indexOf('save:2') >= 0 && t.log.indexOf('save:2') < t.log.indexOf('commit:0:g2'), `the list moved to is saved first: ${t.log.join(' ')}`);

    await t.editor.regexReorder({ group: 'preset', id: 'g1', to: 0, owner: t.owner() });
    assert.deepEqual(t.lists[2].map(s => s.id), ['g1', 'p1']);

    const imported = await t.editor.regexImport({ group: 'global', scripts: [{ id: 'old', scriptName: '导入' }, { findRegex: 'x' }], owner: t.owner() });
    assert.equal(imported.imported, 1);
    assert.notEqual(t.lists[0].at(-1).id, 'old', 'imported scripts get new ids');

    const set = await t.editor.regexSetEnabled({ items: [{ group: 'global', id: 'g2' }, { group: 'preset', id: 'p1' }], enabled: true, owner: t.owner() });
    assert.equal(set.changed, 1, 'only the one that was off');
    const t2 = setup();
    t2.lists[1][0].disabled = true;
    const offOnly = await t2.editor.regexSetEnabled({ items: [{ group: 'preset', id: 'p1' }], enabled: false, owner: t2.owner() });
    assert.deepEqual([offOnly.allowedNow, t2.allowed.preset], [false, []], 'switched off in bulk: nothing allowed');
    const onAgain = await t2.editor.regexSetEnabled({ items: [{ group: 'preset', id: 'p1' }, { group: 'scoped', id: 's1' }], enabled: true, owner: t2.owner() });
    assert.deepEqual([onAgain.allowedNow, t2.allowed.preset, t2.allowed.scoped], [true, ['openai/P'], ['a.png']], 'switched on in bulk: allowed, as one switch');
    const t3 = setup();
    t3.lists[0][0].disabled = true;
    const movedOff = await t3.editor.regexMove({ from: 'global', to: 'scoped', items: [{ id: 'g1' }], owner: t3.owner() });
    assert.deepEqual([movedOff.allowedNow, t3.allowed.scoped], [false, []], 'a switched-off script moved in does not allow the list');

    await t.editor.regexDelete({ group: 'preset', items: [{ id: 'p1', base: scriptFingerprint(t.lists[2][1]) }], owner: t.owner() });
    assert.deepEqual(t.lists[2].map(s => s.id), ['g1']);
});

test('allowing a preset or character list', async () => {
    const t = setup();
    await t.editor.regexAllow({ group: 'scoped', allowed: true, owner: t.owner() });
    assert.deepEqual(t.allowed.scoped, ['a.png']);
    assert.ok(t.log.includes('show-allowed:1:true') && t.log.includes('reload'));
    assert.ok(!t.log.includes('answered:1'));
    await t.editor.regexAllow({ group: 'scoped', allowed: false, owner: t.owner() });
    assert.deepEqual(t.allowed.scoped, []);
    assert.ok(t.log.indexOf('answered:1') >= 0 && t.log.indexOf('answered:1') < t.log.lastIndexOf('reload'), 'the app\'s own "allow?" question counts as answered before the story reloads');
});

test('saved sets of switches: save, compare, apply (the app steps when its panel is missing), update, delete', async () => {
    const t = setup();
    const saved = await t.editor.regexComboSave({ name: '只看正文' });
    const combo = t.settings.regex_presets[0];
    assert.deepEqual([combo.name, combo.isSelected, combo.global, combo.preset, combo.scoped], ['只看正文', true, [{ id: 'g1' }], [{ id: 'p1' }], [{ id: 's1' }]]);
    assert.equal(saved.state.combos[0].matches, true);

    t.lists[0][0].disabled = true; t.lists[0][1].disabled = false;
    assert.equal(t.state().combos[0].matches, false);
    await t.editor.regexComboApply({ id: combo.id, owner: t.owner() });
    assert.deepEqual(t.lists[0].map(s => [s.id, s.disabled]), [['g1', false], ['g2', true]], 'listed ones on, the rest off, in the order they were');
    assert.equal(t.state().combos[0].matches, true);

    t.lists[1][0].disabled = true;
    await t.editor.regexComboSave({ id: combo.id });
    assert.deepEqual(t.settings.regex_presets[0].scoped, []);
    await assert.rejects(t.editor.regexComboSave({ id: 'gone' }), e => e.code === 'REGEX_COMBO_MISSING');

    const before = t.lists[0].map(s => s.disabled);
    await t.editor.regexComboDelete({ id: combo.id });
    assert.deepEqual(t.settings.regex_presets, []);
    assert.deepEqual(t.lists[0].map(s => s.disabled), before, 'deleting a set leaves the switches as they are');
});

test('a set applied through the app panel: the order the app changed is put back and saved', async () => {
    // As the app's applyPresetList: switches, then the ones not in the set first, in place.
    const appApply = (id, { lists, settings, log }) => {
        const combo = settings.regex_presets.find(p => p.id === id);
        for (const [type, key] of [[0, 'global'], [1, 'scoped'], [2, 'preset']]) {
            const list = lists[type], listed = combo[key];
            list.forEach(s => { s.disabled = !listed.some(i => i.id === s.id); });
            list.sort((a, b) => listed.findIndex(i => i.id === a.id) - listed.findIndex(i => i.id === b.id) || list.indexOf(a) - list.indexOf(b));
        }
        combo.isSelected = true; log.push('app-apply');
        return true;
    };
    const t = setup({ applyCombo: appApply });
    t.lists[0].push(script('g3', '三'));
    t.settings.regex_presets.push({ id: 'c1', name: '组合', isSelected: false, global: [{ id: 'g3' }, { id: 'g1' }], preset: [{ id: 'p1' }], scoped: [] });
    await t.editor.regexComboApply({ id: 'c1', owner: t.owner() });
    assert.deepEqual(t.lists[0].map(s => [s.id, s.disabled]), [['g1', false], ['g2', true], ['g3', false]]);
    assert.deepEqual(t.lists[1].map(s => s.disabled), [true]);
    assert.deepEqual(t.log, ['app-apply', 'commit:0:g1,g2,g3', 'settings', 'flush'], 'only the list the app reordered is written again, through its panel');
});

test('a save the server did not take is not reported as done; saved again, it is not taken for a change made elsewhere', async () => {
    let down = true;
    const t = setup({ flush: async () => { if (down) throw new Error('offline'); } });
    const target = t.lists[0][0], base = scriptFingerprint(target);
    await assert.rejects(t.editor.regexSave({ group: 'global', id: 'g1', script: { ...target, replaceString: '新' }, owner: t.owner(), base }), e => e.code === 'REGEX_NOT_SAVED');
    assert.equal(target.replaceString, '新', 'the change stays in the app, for the next save to carry');
    assert.ok(t.published() > 0, 'the page is told the lists changed');
    down = false;
    const again = await t.editor.regexSave({ group: 'global', id: 'g1', script: { ...target, replaceString: '新' }, owner: t.owner(), base });
    assert.equal(again.id, 'g1');
    await assert.rejects(t.editor.regexComboSave({ name: '组合' }).then(() => { down = true; return t.editor.regexComboDelete({ id: t.settings.regex_presets[0].id }); }), e => e.code === 'REGEX_NOT_SAVED');
    down = true;
    await assert.rejects(t.editor.regexAllow({ group: 'preset', allowed: true, owner: t.owner() }), e => e.code === 'REGEX_NOT_SAVED');
});

test('a character\'s card that did not take the change is read back and reported', async () => {
    const t = setup({ card: () => [script('s1', '角')] });
    await assert.rejects(t.editor.regexToggle({ group: 'scoped', id: 's1', disabled: true, owner: t.owner() }), e => e.code === 'REGEX_NOT_SAVED');
    const ok = setup();
    const result = await ok.editor.regexToggle({ group: 'scoped', id: 's1', disabled: true, owner: ok.owner() });
    assert.equal(result.state.groups[2].scripts[0].disabled, true);
});

test('a new script tried again after a failed save is saved over, not added twice (also a copy, also an import)', async () => {
    let down = true;
    const t = setup({ flush: async () => { if (down) throw new Error('offline'); } });
    const value = { scriptName: '新的', findRegex: '/a/g', placement: [2] };
    await assert.rejects(t.editor.regexSave({ group: 'global', id: '', newId: 'page-1', script: value, owner: t.owner() }), e => e.code === 'REGEX_NOT_SAVED');
    down = false;
    const again = await t.editor.regexSave({ group: 'global', id: '', newId: 'page-1', script: { ...value, replaceString: '后来改的' }, owner: t.owner() });
    assert.equal(again.id, 'page-1');
    assert.deepEqual(t.lists[0].filter(s => s.scriptName === '新的').map(s => [s.id, s.replaceString]), [['page-1', '后来改的']]);

    down = true;
    const file = [{ scriptName: '导入一', findRegex: '/x/' }, { scriptName: '导入二', findRegex: '/y/' }];
    await assert.rejects(t.editor.regexImport({ group: 'global', scripts: file, ids: ['f1', 'f2'], owner: t.owner() }), e => e.code === 'REGEX_NOT_SAVED');
    down = false;
    const imported = await t.editor.regexImport({ group: 'global', scripts: file, ids: ['f1', 'f2'], owner: t.owner() });
    assert.equal(imported.imported, 2);
    assert.deepEqual(t.lists[0].filter(s => s.scriptName.startsWith('导入')).map(s => s.id), ['f1', 'f2']);
});

test('several at once: everything is checked before anything changes', async () => {
    const t = setup();
    t.lists[0].push(script('g3', '三'));
    const g1 = scriptFingerprint(t.lists[0][0]), g3 = scriptFingerprint(t.lists[0][2]);
    t.lists[0][2].findRegex = '/别处改了/g';
    await assert.rejects(t.editor.regexDelete({ group: 'global', items: [{ id: 'g1', base: g1 }, { id: 'g3', base: g3 }], owner: t.owner() }), e => e.code === 'REGEX_CHANGED');
    assert.deepEqual(t.lists[0].map(s => s.id), ['g1', 'g2', 'g3'], 'the first is not taken out when the second is refused');
    await assert.rejects(t.editor.regexMove({ from: 'global', to: 'preset', items: [{ id: 'g1' }, { id: 'gone' }], owner: t.owner() }), e => e.code === 'REGEX_MISSING');
    assert.deepEqual([t.lists[0].map(s => s.id), t.lists[2].map(s => s.id)], [['g1', 'g2', 'g3'], ['p1']]);
    await assert.rejects(t.editor.regexSetEnabled({ items: [{ group: 'global', id: 'g2' }, { group: 'preset', id: 'gone' }], enabled: true, owner: t.owner() }), e => e.code === 'REGEX_MISSING');
    assert.equal(t.lists[0][1].disabled, true);
    assert.deepEqual([t.log, t.allowed.preset], [[], []]);
});

test('import preserves a blocked group and records that choice before native reload can ask invisibly', async () => {
    for (const [group, type] of [['scoped', 1], ['preset', 2]]) {
        const t = setup();
        const result = await t.editor.regexImport({ group, scripts: [script('file', '导入')], ids: ['imported'], owner: t.owner() });
        assert.equal(result.imported, 1);
        assert.equal(result.state.groups.find(g => g.type === group).allowed, false);
        assert.ok(t.log.indexOf(`answered:${type}`) >= 0);
        assert.ok(t.log.indexOf(`answered:${type}`) < t.log.findIndex(entry => entry.startsWith(`commit:${type}:`)));
        assert.equal(t.log.includes(`allow:${group}`), false);
    }
});

test('a set applied again: nothing to do when it is in use, otherwise waited for until the app marks it chosen', async () => {
    let chosenWhenCalled = null;
    const appApply = (id, { lists, settings, log }) => {
        const combo = settings.regex_presets.find(p => p.id === id);
        chosenWhenCalled = combo.isSelected;
        for (const [type, key] of [[0, 'global'], [1, 'scoped'], [2, 'preset']]) lists[type].forEach(s => { s.disabled = !combo[key].some(i => i.id === s.id); });
        combo.isSelected = true; log.push('app-apply');
        return true;
    };
    const t = setup({ applyCombo: appApply });
    await t.editor.regexComboSave({ name: '组合' });
    const id = t.settings.regex_presets[0].id;
    t.log.length = 0;
    const same = await t.editor.regexComboApply({ id, owner: t.owner() });
    assert.deepEqual([same.unchanged, t.log], [true, []]);
    t.lists[0][0].disabled = true;
    const applied = await t.editor.regexComboApply({ id, owner: t.owner() });
    assert.equal(applied.unchanged, undefined);
    assert.equal(chosenWhenCalled, false, 'unmarked first, so the wait is for the app\'s own mark');
    assert.equal(t.lists[0][0].disabled, false);
    const failing = setup({ applyCombo: async () => { throw Object.assign(new Error('没切完'), { code: 'REGEX_COMBO_UNCONFIRMED' }); } });
    await failing.editor.regexComboSave({ name: '组合' });
    failing.lists[0][0].disabled = true;
    await assert.rejects(failing.editor.regexComboApply({ id: failing.settings.regex_presets[0].id, owner: failing.owner() }), e => e.code === 'REGEX_COMBO_UNCONFIRMED');
    assert.equal(failing.settings.regex_presets[0].isSelected, true, 'the mark it had is put back');
});

test('trying a script runs it through the app, and shows a real reply to try on', () => {
    const t = setup();
    assert.deepEqual(t.editor.regexTest({ script: { findRegex: '/猫/g', replaceString: '狗' }, text: '一只猫' }), { output: '一只狗' });
    assert.equal(t.editor.regexSample(), '最近的回复');
});
