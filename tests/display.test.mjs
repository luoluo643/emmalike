import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileDisplay } from '../src/display-model.js';

globalThis.location = { search: '' };
const data = new Map(), styles = new Map();
globalThis.localStorage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) };
globalThis.dispatchEvent = () => {};
globalThis.document = {
    getElementById: id => styles.get(id), querySelector: () => null,
    createElement: () => ({ textContent: '', before() {}, remove() { styles.delete(this.id); } }),
    head: { append: el => styles.set(el.id, el) },
};
const theme = await import('../src/theme.js');

test('legacy reading scale migrates once; independent UI preference wins over old-only updates', () => {
    for (const size of [17, 26]) {
        const migrated = reconcileDisplay(null, null, { fontSize: size });
        assert.equal(migrated.fontSize, size);
        assert.deepEqual(reconcileDisplay(migrated, null, { fontSize: 14 }), migrated);
    }
    const local = { schemaVersion: 1, fontSize: 24, updated: 100 };
    assert.equal(reconcileDisplay(local, null, { fontSize: 17 }).fontSize, 24);
    assert.equal(reconcileDisplay(local, { schemaVersion: 1, fontSize: 22, updated: 101 }, {}).fontSize, 22);
    assert.equal(reconcileDisplay({ schemaVersion: 1, fontSize: 26, updated: 999, source: 'migrated' }, local, {}).fontSize, 24);
    assert.equal(reconcileDisplay(local, { schemaVersion: 1, fontSize: 26, updated: 999, source: 'migrated' }, {}).fontSize, 24);
});

test('account migration, reading reset, legacy remote write, import and explicit display remain separate', async () => {
    data.clear(); styles.clear();
    data.set('tavern-lite:reading', JSON.stringify({ fontSize: 26 }));
    data.set('tavern-lite:theme-updated', '10');
    theme.setAppearanceAccount('display-account-A');
    assert.equal(theme.cachedDisplay().fontSize, 26);
    const settings = { tavernLite: { reading: { fontSize: 26 }, themeUpdated: 20 } };
    const bridge = { extensionSettings: () => settings, saveSettings() {} };
    theme.syncAppearanceWithAccount(bridge);
    assert.equal(theme.cachedDisplay().fontSize, 26);
    assert.equal(settings.tavernLite.display, undefined, 'automatic migration never writes a stale inferred choice to the server');
    theme.saveDisplay(23, bridge);
    theme.saveAppearance({ reading: { ...theme.DEFAULT_READING } }, bridge);
    assert.equal(theme.cachedReading().fontSize, 17);
    assert.equal(theme.cachedDisplay().fontSize, 23);
    settings.tavernLite = { reading: { fontSize: 14 }, themeUpdated: Date.now() + 5000 };
    theme.syncAppearanceWithAccount(bridge);
    assert.equal(theme.cachedDisplay().fontSize, 23);
    assert.equal(settings.tavernLite.display.fontSize, 23);
    const old = theme.parseTheme(JSON.stringify({ format: 'tavern-lite-theme', version: 1, reading: { fontSize: 26 } }));
    await theme.importTheme(old, bridge);
    assert.equal(theme.cachedReading().fontSize, 26);
    assert.equal(theme.cachedDisplay().fontSize, 23);
    const exported = JSON.parse(await theme.exportTheme());
    assert.equal(exported.display.fontSize, 23);
    assert.equal(exported.reading.fontSize, 26);
    theme.setAppearanceAccount('display-account-B');
    assert.equal(theme.cachedDisplay().fontSize, 17, 'does not inherit A display');
    const other = { tavernLite: { reading: { fontSize: 24 }, themeUpdated: 1 } };
    theme.syncAppearanceWithAccount({ extensionSettings: () => other, saveSettings() {} });
    assert.equal(theme.cachedDisplay().fontSize, 24);
    theme.setAppearanceAccount('display-account-A');
    assert.equal(theme.cachedDisplay().fontSize, 23);
    assert.match(theme.readingCss({ fontSize: 19, font: 'kai' }), /--tl-font-size: 19px/);
    assert.match(theme.readingCss({ fontSize: 19 }), /--tl-ui-font-size: 23px/);
});

test('built-in accent foreground text has at least 4.5:1 contrast', () => {
    for (const [name, preset] of Object.entries(theme.PRESETS)) {
        if (!preset.bg) continue;
        const vars = theme.themeVars(preset);
        assert.ok(theme.contrastRatio(vars.accent, vars['accent-text']) >= 4.5, name);
        assert.ok(theme.contrastRatio(vars['text-muted'], vars.bg) >= 4.5, `${name} secondary text`);
        assert.ok(theme.contrastRatio(vars.accent, vars.bg) >= 4.5, `${name} accent labels`);
        for (const key of ['text', 'quote', 'em']) assert.ok(theme.contrastRatio(vars[key], vars.bg) >= 4.5, `${name} ${key}`);
    }
});

test('display quota failure is reported rather than claiming a saved preference', () => {
    const old = localStorage.setItem;
    localStorage.setItem = () => { throw new Error('quota'); };
    assert.throws(() => theme.saveDisplay(22), /quota/);
    localStorage.setItem = old;
    assert.equal(theme.cachedDisplay().fontSize, 23);
});
