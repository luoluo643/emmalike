import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegexCharacterTarget } from '../bridge-regex-character-target.js';
import { regexExport } from '../src/regex-export.js';
import { scriptsFromFile } from '../src/regex-model.js';
import { createNativeRegexEditor } from '../bridge-regex-editor-native.js';

function fixture() {
    const cards = [{ avatar: 'a.png', name: 'A', data: { extensions: { regex_scripts: [{ id: 'a', scriptName: 'A rule' }], other: 'keep' } } },
        { avatar: 'b.png', name: 'B', data: { extensions: { regex_scripts: [{ id: 'b', scriptName: 'B rule' }], other: 'keep' } } }];
    const files = new Map(cards.map(card => [card.avatar, structuredClone(card)]));
    const writes = []; let rejectSave = false;
    const current = { character: cards[0], group: false };
    const target = createRegexCharacterTarget({ current: () => current, characters: () => cards, assertSession() {},
        readCard: async avatar => structuredClone(files.get(avatar)),
        writeScripts: async (index, scripts) => { writes.push(cards[index].avatar); if (!rejectSave) files.get(cards[index].avatar).data.extensions.regex_scripts = scripts; },
    });
    return { target, current, cards, files, writes, fail() { rejectSave = true; }, recover() { rejectSave = false; } };
}

test('managing another card preserves open story and writes only that card', async () => {
    const f = fixture(), before = JSON.stringify(f.files.get('a.png'));
    await f.target.select('b.png');
    assert.equal(f.current.character.avatar, 'a.png');
    assert.equal(f.target.character().character.avatar, 'b.png');
    await f.target.beforeWrite(['scoped']);
    f.target.scripts()[0].scriptName = 'B edited';
    await f.target.save(f.target.scripts());
    assert.deepEqual(f.writes, ['b.png']);
    assert.equal(JSON.stringify(f.files.get('a.png')), before);
    assert.equal(f.files.get('b.png').data.extensions.other, 'keep');
    assert.equal(f.files.get('b.png').data.extensions.regex_scripts[0].scriptName, 'B edited');
    await f.target.select(null);
    assert.equal(f.target.character(), f.current);
});
test('remote changes are loaded and rejected before a stale edit writes', async () => {
    const f = fixture(); await f.target.select('b.png');
    f.files.get('b.png').data.extensions.regex_scripts[0].scriptName = 'remote';
    await assert.rejects(f.target.beforeWrite(['scoped']), { code: 'REGEX_CHARACTER_CHANGED' });
    assert.equal(f.target.scripts()[0].scriptName, 'remote'); assert.equal(f.writes.length, 0);
});
test('failed readback preserves candidate and allows retry against unchanged file', async () => {
    const f = fixture(); await f.target.select('b.png'); f.fail();
    f.target.scripts()[0].scriptName = 'candidate';
    await assert.rejects(f.target.save(f.target.scripts()), { code: 'REGEX_NOT_SAVED' });
    assert.equal(f.target.scripts()[0].scriptName, 'candidate');
    f.recover(); await f.target.beforeWrite(['scoped']); await f.target.save(f.target.scripts());
    assert.equal(f.files.get('b.png').data.extensions.regex_scripts[0].scriptName, 'candidate');
});
test('card identity follows avatar when list order changes and rejects deletion', async () => {
    const f = fixture(); await f.target.select('b.png'); f.cards.reverse();
    await f.target.beforeWrite(['scoped']); await f.target.save(f.target.scripts());
    assert.deepEqual(f.writes, ['b.png']);
    f.cards.splice(0, 1);
    await assert.rejects(f.target.beforeWrite(['scoped']), { code: 'REGEX_MISSING' });
});
test('export creates one importable file in rule order with enabled flags preserved', () => {
    const source = [{ id: 'one', scriptName: 'first', findRegex: '/a/g', replaceString: 'aa', placement: [2], disabled: true },
        { id: 'two', scriptName: 'second', findRegex: '/b/g', placement: [2], disabled: false }];
    const file = regexExport(source, '角色：B');
    assert.equal(file.count, 2); assert.equal(file.name.includes('：'), true);
    const read = scriptsFromFile(file.text);
    assert.equal(read.error, ''); assert.deepEqual(read.scripts.map(s => s.id), ['one','two']);
    assert.deepEqual(read.scripts.map(s => s.disabled), [true,false]);
    assert.equal(Array.isArray(JSON.parse(regexExport([source[0]]).text)), false);
    assert.throws(() => regexExport([]));
});

test('native binding isolates off-role writes, avoids panel commits/reloads and guards combos', async () => {
    const f = fixture(), allowed = new Set(), log = [], callbacks = {};
    const settings = { regex: [], regex_presets: [] };
    const st = { this_chid: 0, characters: f.cards, getRequestHeaders: () => ({}), getCurrentChatId: () => 'A story',
        saveSettingsDebounced() {}, reloadCurrentChat() { log.push('reload'); } };
    const editor = createNativeRegexEditor({ account: 'test', st, groupChats: {},
        regexEngine: { getScriptsByType: type => type === 1 ? f.cards[0].data.extensions.regex_scripts : [],
            saveScriptsByType: () => { throw new Error('current-role saver must not run'); },
            isScopedScriptsAllowed: c => allowed.has(c.avatar), allowScopedScripts: c => allowed.add(c.avatar), disallowScopedScripts: c => allowed.delete(c.avatar) },
        extensions: { extension_settings: settings, async writeExtensionField(index, key, list) { log.push(f.cards[index].avatar); f.files.get(f.cards[index].avatar).data.extensions[key] = structuredClone(list); } },
        ctx: () => ({ eventTypes: { CHAT_CHANGED: 'chat' }, eventSource: { on: (name, fn) => { callbacks[name] = fn; } }, accountStorage: { setItem() {} } }),
        uuid: () => 'generated', enqueue: fn => fn(), waitIdle: async () => {}, verifyAccount: async () => {}, assertSession() {}, waitFor() {},
        window: { $: () => { throw new Error('active native panel must not be touched'); }, fetch: async (_url, options) => ({ ok: true, json: async () => structuredClone(f.files.get(JSON.parse(options.body).avatar_url)) }) }, document: {},
    });
    const selected = await editor.regexSelectCharacter('b.png');
    assert.equal(selected.state.managingOtherCharacter, true);
    const result = await editor.regexToggle({ group: 'scoped', id: 'b', disabled: true, owner: selected.state.owner });
    assert.deepEqual(log, ['b.png']);
    assert.equal(result.state.groups[2].scripts[0].disabled, true);
    assert.equal(st.this_chid, 0);
    await editor.regexAllow({ group: 'scoped', allowed: true, owner: result.state.owner });
    assert.deepEqual([...allowed], ['b.png']); assert.deepEqual(log, ['b.png']);
    await assert.rejects(editor.regexComboSave({ name: 'wrong mix' }), { code: 'REGEX_OWNER_CHANGED' });
    await assert.rejects(editor.regexComboApply({ id: 'any', owner: result.state.owner }), { code: 'REGEX_OWNER_CHANGED' });
    assert.equal((await editor.regexSelectCharacter(null)).state.owner.scoped, 'a.png');
});
