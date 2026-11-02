import test from 'node:test';
import assert from 'node:assert/strict';
import { alreadyIn, blankScript, comboChanges, ruleKey, comboUnknownGroups, depthInput, depthRangeEmpty, depthText, exportName, findNote, kindFlags, kindOf, matchesFilter, normalizeScript, parseFind, problemOf,
    regexSearch, scriptChanges, scriptFingerprint, scriptSummary, scriptsFromFile } from '../src/regex-model.js';

const thinking = { scriptName: '折叠思维链', findRegex: '/<thinking>([\\s\\S]*?)<\\/thinking>/g', replaceString: '', placement: [2], markdownOnly: true, promptOnly: false };

test('the find box is read the way the app reads it', () => {
    assert.equal(parseFind('/a+/gi').global, true);
    assert.equal(parseFind('/a+/gi').ignoreCase, true);
    assert.equal(parseFind('plain text').ok, true, 'without slashes the whole text is the pattern');
    assert.equal(parseFind('/a(/g').ok, false);
    assert.match(parseFind('/a(/g').error, /^写法有误/);
    assert.equal(parseFind('').empty, true);
    assert.equal(findNote(thinking).text, '替换所有找到的，区分大小写');
    assert.equal(findNote({ findRegex: '/x/i' }).text, '只替换找到的第一处，不分大小写');
    assert.match(findNote({ findRegex: '/{{char}}/g', substituteRegex: 2 }).text, /先换成当前的名字/);
});

test('what keeps a script from doing anything is named', () => {
    assert.equal(problemOf(normalizeScript(thinking)), '');
    assert.equal(problemOf(normalizeScript({ ...thinking, findRegex: '' })), '没写要找的内容，不会生效');
    assert.equal(problemOf(normalizeScript({ ...thinking, placement: [] })), '没选用在哪里，不会生效');
    assert.equal(problemOf(normalizeScript({ ...thinking, findRegex: '/(/' })), '查找内容写法有误，不会生效');
    assert.equal(problemOf(normalizeScript({ ...thinking, findRegex: '/{{char}}(/', substituteRegex: 1 })), '', 'a macro pattern is checked only by the app');
    assert.equal(problemOf(normalizeScript({ ...thinking, placement: [5] })), '世界书内容要选「只改发给 AI 的」才会生效');
    assert.equal(problemOf(normalizeScript({ ...thinking, placement: [5], promptOnly: true })), '');
    assert.equal(problemOf(normalizeScript({ ...thinking, minDepth: 3, maxDepth: 1 })), '最小深度比最大深度大，不会改任何消息');
    assert.equal(problemOf(normalizeScript({ ...thinking, minDepth: 1, maxDepth: 1 })), '');
    assert.deepEqual([depthRangeEmpty({ minDepth: 3, maxDepth: null }), depthRangeEmpty({ minDepth: 3, maxDepth: -1 }), depthRangeEmpty({ minDepth: 2, maxDepth: 1 })], [false, false, true]);
});

test('the two "only" flags are one choice', () => {
    for (const kind of ['display', 'prompt', 'both', 'stored']) assert.equal(kindOf(kindFlags(kind)), kind);
    assert.equal(kindOf({ markdownOnly: true }), 'display');
    assert.equal(kindOf({}), 'stored');
    assert.equal(scriptSummary(normalizeScript(thinking)), 'AI 回复 · 只改显示');
    assert.equal(scriptSummary(normalizeScript({ ...thinking, placement: [1, 2], promptOnly: true, markdownOnly: false, minDepth: 4 })), 'AI 回复、你说的话 · 只改发给 AI 的 · 最近 4 条不改');
});

test('depth in words, as the app counts it (0 is the latest message)', () => {
    assert.equal(depthText({ minDepth: null, maxDepth: null }), '');
    assert.equal(depthText({ minDepth: 0, maxDepth: null }), '');
    assert.equal(depthText({ minDepth: 2, maxDepth: null }), '最近 2 条不改');
    assert.equal(depthText({ minDepth: null, maxDepth: 0 }), '只改最近 1 条');
    assert.equal(depthText({ minDepth: 1, maxDepth: 3 }), '只改倒数第 2～4 条');
    assert.deepEqual(depthInput(''), { value: null });
    assert.deepEqual(depthInput(' 3 '), { value: 3 });
    assert.ok(depthInput('1.5').error);
    assert.ok(depthInput('-2').error);
});

test('normalized as the app editor saves, and compared only by what it shows', () => {
    const n = normalizeScript({ scriptName: 1, placement: ['2', 1, 2], minDepth: NaN, trimStrings: ['a', ''], extra: 'kept elsewhere' });
    assert.deepEqual(n.placement, [1, 2]);
    assert.equal(n.minDepth, null);
    assert.deepEqual(n.trimStrings, ['a']);
    assert.equal('extra' in n, false);
    assert.equal(scriptFingerprint({ ...thinking, id: 'a', extra: 1 }), scriptFingerprint({ ...thinking, id: 'b' }));
    assert.deepEqual(scriptChanges(thinking, { ...thinking, markdownOnly: false, promptOnly: true, replaceString: 'x' }), ['替换为', '改哪里']);
    const blank = blankScript();
    assert.deepEqual([blank.placement, blank.markdownOnly, blank.runOnEdit], [[2], true, true]);
});

test('filters and search', () => {
    const on = normalizeScript(thinking), off = normalizeScript({ ...thinking, disabled: true, promptOnly: true, markdownOnly: false });
    assert.deepEqual([matchesFilter(on, 'on'), matchesFilter(off, 'on'), matchesFilter(off, 'off')], [true, false, true]);
    assert.deepEqual([matchesFilter(on, 'display'), matchesFilter(off, 'prompt'), matchesFilter(on, 'stored')], [true, true, false]);
    assert.equal(matchesFilter(normalizeScript({ ...thinking, both: 1, markdownOnly: true, promptOnly: true }), 'prompt'), true);
    assert.equal(regexSearch(on, '').matched, true);
    const found = regexSearch(on, 'THINKING');
    assert.deepEqual(found.hits.map(h => h.label), ['查找']);
    assert.equal(regexSearch(on, '思维').hits[0].label, '名字');
    assert.equal(regexSearch(on, 'nothing here').matched, false);
});

test('a saved set of switches: what applying it changes', () => {
    const state = { groups: [
        { type: 'global', scripts: [{ id: 'a', scriptName: 'A', disabled: false }, { id: 'b', scriptName: 'B', disabled: true }] },
        { type: 'preset', scripts: [{ id: 'c', scriptName: 'C', disabled: false }] },
        { type: 'scoped', scripts: [] },
    ] };
    const changes = comboChanges(state, { global: ['b'], preset: ['c'], scoped: [] });
    assert.deepEqual(changes.turnOn.map(x => x.name), ['B']);
    assert.deepEqual(changes.turnOff.map(x => x.name), ['A']);
    assert.deepEqual(comboChanges(state, { global: ['a'], preset: ['c'] }), { turnOn: [], turnOff: [] });
});

test('a set saved with another preset or character says so before it switches that list off', () => {
    const state = { groups: [
        { type: 'global', owner: '', scripts: [{ id: 'a', disabled: false }] },
        { type: 'preset', owner: 'P', scripts: [{ id: 'c', disabled: false }, { id: 'd', disabled: true }] },
        { type: 'scoped', owner: '甲', scripts: [{ id: 's', disabled: false }] },
    ] };
    assert.deepEqual(comboUnknownGroups(state, { global: [], preset: ['other'], scoped: ['s'] }), [{ type: 'preset', owner: 'P', off: 1 }]);
    assert.deepEqual(comboUnknownGroups(state, { global: [], preset: ['d'], scoped: ['s'] }), [], 'one of its scripts is in the set');
    assert.deepEqual(comboUnknownGroups(state, { global: ['a'] }).map(g => g.type), ['preset', 'scoped']);
});

test('files the app exports are read back', () => {
    assert.equal(scriptsFromFile(JSON.stringify(thinking)).scripts.length, 1);
    const many = scriptsFromFile(JSON.stringify([thinking, { findRegex: 'x' }, null]));
    assert.deepEqual([many.scripts.length, many.skipped], [1, 2]);
    assert.ok(scriptsFromFile('{').error);
    assert.ok(scriptsFromFile('[]').error);
    assert.equal(exportName('折叠 思维/链'), 'regex-折叠_思维_链.json');
});

test('a script alike to one already in a list: the same rule, whatever its name or switch', () => {
    assert.equal(ruleKey({ ...thinking, scriptName: '别的名字', disabled: true }), ruleKey(thinking));
    assert.notEqual(ruleKey({ ...thinking, replaceString: 'x' }), ruleKey(thinking));
    assert.equal(alreadyIn([thinking, { ...thinking, findRegex: '/b/' }], [{ ...thinking, id: 'old', scriptName: '旧的' }]), 1);
});
