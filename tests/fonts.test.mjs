import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FONTS, cleanFont, familyInCss, fontFaceCss, fontLinkIn, fontNameOf, isFontFileLink, sameFont } from '../src/fonts.js';

globalThis.location = { search: '' };
const data = new Map();
globalThis.localStorage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k), key: () => null, length: 0 };
globalThis.dispatchEvent = () => {};
globalThis.document = {
    getElementById: () => null, querySelector: () => null,
    createElement: () => ({ textContent: '', before() {}, remove() {} }),
    head: { append() {} },
};
const theme = await import('../src/theme.js');

const upload = { id: 'abc1', name: '霞鹜文楷', kind: 'upload', url: '/user/files/tavern-lite-font-abc1.ttf' };
const sheet = { id: 'abc2', kind: 'css', url: 'https://fonts.example/lxgw/result.css', family: 'LXGW WenKai' };

test('source identity normalizes URLs but preserves families, queries and content hashes', () => {
    assert(sameFont(cleanFont(sheet), cleanFont({ ...sheet, id: 'other', url: 'https://FONTS.example:443/lxgw/result.css' })));
    assert(!sameFont(cleanFont(sheet), cleanFont({ ...sheet, family: 'Another' })));
    assert(!sameFont(cleanFont(sheet), cleanFont({ ...sheet, url: sheet.url + '?v=2' })));
    const digest = 'a'.repeat(64);
    assert(sameFont(cleanFont({ ...upload, digest }), cleanFont({ ...upload, id: 'other', digest, url: '/user/files/other.ttf' })));
    assert.equal(cleanFont({ ...upload, digest }).digest, digest);
    assert.equal(cleanFont({ ...upload, digest: '<bad>' }).digest, undefined);
});

test('saving duplicates reuses the old choice, even at capacity; capacity is checked again at save', () => {
    theme.setAppearanceAccount('font-dedup');
    const first = theme.saveFont(sheet);
    assert.equal(theme.saveFont({ ...sheet, id: 'duplicate' }).id, first.id);
    assert.equal(theme.cachedFonts().length, 1);
    for (let i = 1; i < MAX_FONTS; i++) theme.saveFont({ ...upload, id: `font${i}`, url: `/user/files/${i}.ttf` });
    assert.equal(theme.cachedFonts().length, MAX_FONTS);
    assert.equal(theme.saveFont({ ...sheet, id: 'again' }).id, first.id);
    assert.throws(() => theme.saveFont({ ...upload, id: 'overflow', url: '/user/files/overflow.ttf' }), /最多 20/);
    assert.equal(theme.cachedFonts().length, MAX_FONTS);
    theme.setAppearanceAccount('font-other');
});

test('a file gets its own family; a stylesheet keeps the one it declares', () => {
    assert.equal(cleanFont(upload).family, 'tl-font-abc1');
    assert.equal(cleanFont({ ...upload, family: 'x"; } body { display: none' }).family, 'tl-font-abc1');
    assert.equal(cleanFont(sheet).family, 'LXGW WenKai');
    assert.equal(cleanFont(sheet).name, 'LXGW WenKai');
});

test('what would break out of the stylesheet is refused', () => {
    for (const bad of [
        { ...upload, url: 'javascript:alert(1)' },
        { ...upload, url: 'https://x.example/a.ttf"); } body { display: none } a { b: url("' },
        { ...upload, url: '/etc/passwd' },
        { ...upload, kind: 'other' },
        { ...upload, id: '../x' },
        { ...sheet, family: 'x"; } body { display: none' },
        { ...sheet, family: '' },
        null,
    ]) assert.equal(cleanFont(bad), null, JSON.stringify(bad));
});

test('the declaration matches the kind', () => {
    assert.equal(fontFaceCss(cleanFont(upload)), '@font-face { font-family: "tl-font-abc1"; src: url("/user/files/tavern-lite-font-abc1.ttf"); font-display: swap; }');
    assert.equal(fontFaceCss(cleanFont(sheet)), '@import url("https://fonts.example/lxgw/result.css");');
});

test('the link is found in what a font site offers to copy', () => {
    assert.equal(fontLinkIn(' https://a.example/f.woff2 '), 'https://a.example/f.woff2');
    assert.equal(fontLinkIn(`@import url('https://a.example/x/result.css');`), 'https://a.example/x/result.css');
    assert.equal(fontLinkIn('<link href="https://a.example/c.css?family=Noto+Serif+SC:wght@400;700" rel="stylesheet">'), 'https://a.example/c.css?family=Noto+Serif+SC:wght@400;700');
    assert.equal(fontLinkIn('ftp://a.example/f.ttf'), '');
    assert.equal(fontLinkIn('字体'), '');
});

test('font file links and names', () => {
    assert.equal(isFontFileLink('https://a.example/F.TTF?v=2'), true);
    assert.equal(isFontFileLink('https://a.example/result.css'), false);
    assert.equal(isFontFileLink('https://a.example/css?family=F.ttf'), false);
    assert.equal(fontNameOf('霞鹜文楷-Regular.woff2'), '霞鹜文楷-Regular');
    assert.equal(fontNameOf('/x/%E5%AD%97%E4%BD%93.ttf?v=1'), '字体');
});

test('the first declared family is read from any quoting', () => {
    assert.equal(familyInCss(`/* x */ @font-face { font-style: normal; font-family: "LXGW WenKai"; src: url(a.woff2); }`), 'LXGW WenKai');
    assert.equal(familyInCss(`@font-face{font-family:'A B';src:url(a)}@font-face{font-family:'C'}`), 'A B');
    assert.equal(familyInCss(`@font-face { font-family: Plain Name; }`), 'Plain Name');
    assert.equal(familyInCss(`body { font-family: "not a face"; }`), '');
    assert.equal(familyInCss(`<html>`), '');
});

test('reading and theme settings use an added font; only that one is declared', () => {
    const [a, b] = [cleanFont(upload), cleanFont(sheet)];
    const fonts = [a, b];
    const css = theme.readingCss({ theme: 'paper', font: 'custom:abc1' }, [], fonts);
    assert.match(css, /--tl-font: "tl-font-abc1", system-ui/);
    assert.equal(theme.fontCss({ theme: 'paper', font: 'custom:abc1' }, [], fonts), fontFaceCss(a));

    const own = theme.cleanTheme({ id: 't1', bg: '#ffffff', text: '#000000', font: 'custom:abc2' });
    assert.equal(own.font, 'custom:abc2');
    assert.match(theme.readingCss({ theme: 'custom:t1' }, [own], fonts), /--tl-font: "LXGW WenKai"/);
    assert.equal(theme.fontCss({ theme: 'custom:t1' }, [own], fonts), fontFaceCss(b));
    // The reading setting wins over the theme's font, for the declaration as well.
    assert.equal(theme.fontCss({ theme: 'custom:t1', font: 'serif' }, [own], fonts), '');
    assert.equal(theme.fontCss({ theme: 'custom:t1', font: 'custom:abc1' }, [own], fonts), fontFaceCss(a));
});

test('a font that is gone falls back instead of breaking', () => {
    assert.doesNotMatch(theme.readingCss({ theme: 'paper', font: 'custom:gone' }, [], []), /--tl-font:/);
    assert.equal(theme.fontCss({ theme: 'paper', font: 'custom:gone' }, [], []), '');
    const shared = theme.cleanTheme({ id: 't2', bg: '#ffffff', text: '#000000', font: 'custom:gone' });
    assert.doesNotMatch(theme.readingCss({ theme: 'custom:t2' }, [shared], []), /--tl-font:/);
    assert.equal(theme.cleanTheme({ id: 't3', bg: '#ffffff', text: '#000000', font: 'custom:"x' }).font, 'default');
});

test('without an added font the look is what it was', () => {
    assert.equal(theme.fontCss({ theme: 'paper', font: 'serif' }, [], []), '');
    assert.match(theme.readingCss({ theme: 'paper', font: 'serif' }, [], []), /--tl-font: "Songti SC"/);
});
