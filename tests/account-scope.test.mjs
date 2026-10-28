// What one account writes on a shared browser stays that account's: character drafts and the appearance.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = { search: '' };
const data = new Map(), styles = new Map();
globalThis.localStorage = {
    getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k),
    get length() { return data.size; }, key: i => [...data.keys()][i] ?? null,
};
globalThis.dispatchEvent = () => {};
globalThis.document = {
    getElementById: id => styles.get(id), querySelector: () => null,
    createElement: () => ({ textContent: '', before() {}, remove() { styles.delete(this.id); } }),
    head: { append: el => styles.set(el.id, el) },
};
const drafts = await import('../src/drafts.js');
const theme = await import('../src/theme.js');
const { hasStory, makeSource, newRecord } = await import('../src/personal-model.js');

test('a character draft is only seen by the account that wrote it; old unowned drafts go to nobody', async () => {
    data.clear();
    data.set('tavern-lite:draft:create:new', JSON.stringify({ name: '旧草稿', at: 1 }));
    await drafts.putDraft('A', 'create:new', { name: '账号A专属草稿', at: 10 });
    assert.equal((await drafts.getDraft('A', 'create:new')).name, '账号A专属草稿');
    assert.equal(await drafts.getDraft('B', 'create:new'), null);
    await assert.rejects(drafts.getDraft(null, 'create:new'), /还没登录/);
    await drafts.deleteDraft('A', 'create:new');
    assert.equal(await drafts.getDraft('A', 'create:new'), null);
    assert.equal(JSON.parse(data.get('tavern-lite:draft:create:new')).name, '旧草稿', 'left where it was, not adopted');
});

test('keystrokes kept while the page closes come back, and an older copy never wins over a newer save', async () => {
    data.clear();
    await drafts.putDraft('A', 'character:x.png', { values: { first_mes: '旧开场白' }, at: 10 });
    assert.ok(drafts.keepDraftNow('A', 'character:x.png', { values: { first_mes: '新开场白' }, at: 20 }));
    assert.equal((await drafts.getDraft('A', 'character:x.png')).values.first_mes, '新开场白');
    await drafts.putDraft('A', 'character:x.png', { values: { first_mes: '再新的' }, at: 30 });
    assert.equal((await drafts.getDraft('A', 'character:x.png')).values.first_mes, '再新的');
    assert.equal(drafts.keepDraftNow(null, 'character:x.png', {}), false);
});

test('a theme made by one account is not shown to, or written into the settings of, the next account', () => {
    data.clear(); styles.clear();
    data.set('tavern-lite:display-owner', 'A');
    theme.setAppearanceAccount('A');
    const settingsA = { tavernLite: {} };
    const made = theme.saveTheme({ name: 'A的主题', bg: '#18202b', text: '#ddd6ca' }, { extensionSettings: () => settingsA, saveSettings() {} });
    assert.equal(theme.cachedReading().theme, `custom:${made.id}`);
    assert.equal(settingsA.tavernLite.themes.length, 1);

    theme.setAppearanceAccount('B');
    assert.equal(theme.cachedReading().theme, 'system');
    assert.deepEqual(theme.cachedThemes(), []);
    assert.doesNotMatch(styles.get('tl-reading-css').textContent, /#18202b/, 'B does not see A\'s colours');
    let saved = 0;
    const settingsB = { tavernLite: {} };
    theme.syncAppearanceWithAccount({ extensionSettings: () => settingsB, saveSettings() { saved++; } });
    assert.equal(settingsB.tavernLite.themes, undefined, 'nothing of A is pushed into B');
    assert.equal(saved, 0);

    theme.setAppearanceAccount('A');
    assert.equal(theme.cachedReading().theme, `custom:${made.id}`, 'A gets its own look back');
});

test('the appearance from before it was per account goes to the account that used the browser last, once', () => {
    data.clear(); styles.clear();
    data.set('tavern-lite:display-owner', 'A');
    data.set('tavern-lite:reading', JSON.stringify({ theme: 'night', fontSize: 20 }));
    data.set('tavern-lite:custom-css', '.x { color: red; }');
    data.set('tavern-lite:theme-updated', '50');
    theme.setAppearanceAccount(null);
    theme.setAppearanceAccount('B');
    assert.equal(theme.cachedReading().theme, 'system', 'B signed in first but the old look was A\'s');
    assert.equal(theme.cachedCss(), '');
    theme.setAppearanceAccount('A');
    assert.equal(theme.cachedReading().theme, 'night');
    assert.equal(theme.cachedReading().fontSize, 20);
    assert.equal(theme.cachedCss(), '.x { color: red; }');
    assert.equal(data.get('tavern-lite:reading'), undefined, 'the unscoped copy is gone');
    theme.setAppearanceAccount('C');
    assert.equal(theme.cachedReading().theme, 'system');
});

test('colours made readable on a dark background keep their hue and reach 4.5:1', () => {
    for (const color of ['#7a4a1e', '#6f6558', '#8b5e34']) {
        assert.ok(theme.contrastRatio(color, '#18202b') < 4.5);
        const fixed = theme.readableOn(color, '#18202b');
        assert.ok(theme.contrastRatio(fixed, '#18202b') >= 4.5, `${color} → ${fixed}`);
    }
    assert.equal(theme.readableOn('#2b2620', '#f5efe3'), '#2b2620', 'already readable: unchanged');
});

test('a record needs a story to go back to', () => {
    assert.equal(hasStory({ avatar: 'a.png', file: 'chat' }), true);
    assert.equal(hasStory({ groupId: '7', file: 'chat' }), true);
    assert.equal(hasStory(null), false);
    assert.equal(hasStory({ avatar: 'a.png' }), false);
    const welcome = makeSource(null, { name: 'Assistant', mes: '欢迎' }, 0);
    assert.throws(() => newRecord('quote', '欢迎', welcome), /不知道这段话在哪个故事里/);
    assert.equal(newRecord('quote', '你好', makeSource({ avatar: 'a.png', file: 'chat' }, { name: 'S', mes: '你好' }, 1)).source.file, 'chat');
});
