import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToc, currentEntry, filterToc, tocSnippet } from '../src/toc-model.js';

const horae = (date, location, ...events) => ({ timestamp: { story_date: date }, scene: { location }, events });
const story = [
    { is_user: false, mes: '<think>先想想</think>“你来了。”他抬头。' },
    { is_user: true, mes: '我推门进去' },
    { is_user: false, mes: '正文一', horae_meta: horae('2026/10/12', '公寓·客厅',
        { level: '一般', summary: '阿远倒了杯水' }, { level: '重要', summary: '阿远雨夜去找小林' }, { level: '摘要', isSummary: true, summary: '十月十二日的长夜' }) },
    { is_user: true, mes: '继续' },
    { is_user: false, is_system: true, notice: true, mes: '系统提示' },
    { is_user: false, mes: '正文二', hidden: true, horae_meta: horae('2026/10/12', '公寓·卧室', { level: '摘要', summary: '` and `' }) },
    { is_user: false, mes: '正文三', horae_meta: horae('2026/10/15', '医院', { level: '关键', summary: '小林住院' }) },
];

test('one entry per reply, titled by the most telling Horae event, else by the opening words', () => {
    const { entries } = buildToc(story);
    assert.deepEqual(entries.map(e => e.index), [0, 2, 5, 6]);
    assert.equal(entries[0].title, '“你来了。”他抬头。');
    assert.equal(entries[0].fromHorae, false);
    assert.equal(entries[1].title, '阿远雨夜去找小林');
    assert.equal(entries[1].fromHorae, true);
    // A stray symbol is not a summary: the opening words stand in.
    assert.equal(entries[2].title, '正文二');
    assert.equal(entries[2].hidden, true);
});

test('a stretch summary titles a reply only when Horae recorded nothing else', () => {
    const { entries } = buildToc([{ is_user: false, mes: '正文', horae_meta: horae('', '', { level: '摘要', isSummary: true, summary: '十月十二日的长夜' }) }]);
    assert.equal(entries[0].title, '十月十二日的长夜');
});

test('grouped by story date when Horae keeps one, else in runs of 50 floors', () => {
    const { groups } = buildToc(story);
    assert.deepEqual(groups.map(g => g.label), ['2026/10/12 · #0–5', '2026/10/15 · #6']);
    const plain = Array.from({ length: 120 }, (_, i) => ({ is_user: i % 2 === 1, mes: `第${i}段` }));
    const runs = buildToc(plain);
    assert.equal(runs.entries[0].title, '第0段');
    assert.deepEqual(runs.groups.map(g => g.label), ['第 0–48 楼', '第 50–98 楼', '第 100–118 楼']);
});

test('the entry being read is the last at or before the top message', () => {
    const { entries } = buildToc(story);
    assert.equal(currentEntry(entries, 3).index, 2);
    assert.equal(currentEntry(entries, 6).index, 6);
    assert.equal(currentEntry(entries, undefined), null);
});

test('search looks in titles and dates; a number finds floors', () => {
    const { entries } = buildToc(story);
    assert.deepEqual(filterToc(entries, '去找').map(e => e.index), [2]);
    assert.deepEqual(filterToc(entries, '2026/10/15').map(e => e.index), [6]);
    // What the contents don't show isn't searched.
    assert.deepEqual(filterToc(entries, '长夜'), []);
    assert.deepEqual(filterToc(entries, '医院'), []);
    assert.deepEqual(filterToc(entries, '#5').map(e => e.index), [5]);
    assert.equal(filterToc(entries, '  ').length, entries.length);
});

test('snippets leave out tags, thinking and markdown marks', () => {
    assert.equal(tocSnippet('<details><summary>状态</summary>心情 好</details>**她**笑了'), '她笑了');
    assert.equal(tocSnippet('一'.repeat(100), 10), `${'一'.repeat(10)}…`);
});
