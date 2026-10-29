import test from 'node:test';
import assert from 'node:assert/strict';
import { LINES_KEY, LINE_FIELD, MAIN, ownState, planLineAction, readRegistry, recordedEpisodes } from '../src/own-lines.js';
import { aiLinePrompt, lineDirective, lineName, parseAiLines, requestHeads, requestKind, suggestLineMarks } from '../src/inline-episodes.js';
import { lineView } from '../src/line-view.js';

const u = mes => ({ is_user: true, is_system: false, mes });
const c = mes => ({ is_user: false, is_system: false, mes });
let n = 0;
const ids = () => `l${++n}`;
// Applies a plan the way the bridge does (writeLinePlan).
function apply(chat, metadata, action, options) {
    const plan = planLineAction(chat, metadata, action, options, ids);
    if (!plan) return metadata;
    for (const [i, line] of plan.marks) { if (line) chat[i][LINE_FIELD] = line; else delete chat[i][LINE_FIELD]; }
    return { ...metadata, [LINES_KEY]: plan.registry };
}

test('a request starts a line, "回到正文" goes back; "暂停剧情自检" and a bare "回到剧情" do neither', () => {
    assert.deepEqual(lineDirective('写个小剧场：丧尸男友'), { action: 'start', kind: 'skit', title: '丧尸男友', weak: false });
    assert.equal(lineDirective('暂停剧情，生成一个番外，主题是「雨夜」').kind, 'side');
    assert.equal(lineDirective('来个平行世界，现代AU').kind, 'parallel');
    assert.deepEqual(lineDirective('回到正文'), { action: 'back' });
    assert.equal(lineDirective('gemini 暂停剧情 自检是否ooc'), null);
    assert.equal(lineDirective('回到剧情'), null);
    assert.equal(lineDirective('禁止继续正文，接着往下写'), null);
    assert.equal(requestKind('小剧场：两个人吵架'), 'skit');
    assert.equal(requestKind('他推开门'), null);
});

test('sending: the next message starts the new line, and going back puts the 正文 after it', () => {
    const chat = [c('你来了。'), u('他推开门'), c('门开了。')];
    let meta = {};
    meta = apply(chat, meta, 'new-next', { title: '丧尸男友', kind: 'skit' });
    let state = ownState(chat, meta);
    assert.equal(state.pending, 'l1');
    assert.equal(state.multi, true);
    chat.push(u('写个小剧场：丧尸男友'));
    meta = apply(chat, meta, 'apply-pending', { index: 3 });
    chat.push(c('丧尸来了。'));
    state = ownState(chat, meta);
    assert.equal(state.pending, null);
    assert.equal(state.active, 'l1');
    assert.deepEqual(state.segments, [{ id: MAIN, start: 0, end: 2 }, { id: 'l1', start: 3, end: 4 }]);
    assert.equal(state.registry.l1.kind, 'skit');
    meta = apply(chat, meta, 'to-main');
    chat.push(u('回到正文'), c('回来了。'));
    meta = apply(chat, meta, 'apply-pending', { index: 5 });
    state = ownState(chat, meta);
    assert.equal(state.active, MAIN);
    const view = lineView({ storyline: state, total: chat.length });
    assert.deepEqual(view.indices('l1'), [3, 4]);
    assert.equal(view.label('l1'), '小剧场 · 丧尸男友');
    assert.deepEqual(view.indices(MAIN), [0, 1, 2, 5, 6]);
    // Nothing waits: the next message has nothing to apply.
    assert.equal(planLineAction(chat, meta, 'apply-pending', { index: 6 }), null);
});

test('marking by hand: a new line from a message, back to the 正文, undone; kind and name changed', () => {
    const chat = [c('开场'), u('a'), c('b'), u('c'), c('d'), u('e'), c('f')];
    let meta = apply(chat, {}, 'mark', { index: 3, title: '古风无情道', kind: 'side' });
    meta = apply(chat, meta, 'mark', { index: 5, line: MAIN });
    let state = ownState(chat, meta);
    assert.deepEqual(state.segments.map(s => [s.id, s.start, s.end]), [[MAIN, 0, 2], ['l2', 3, 4], [MAIN, 5, 6]]);
    meta = apply(chat, meta, 'unmark', { index: 5 });
    assert.deepEqual(ownState(chat, meta).segments.map(s => [s.id, s.start, s.end]), [[MAIN, 0, 2], ['l2', 3, 6]]);
    meta = apply(chat, meta, 'set-kind', { line: 'l2', kind: 'parallel' });
    meta = apply(chat, meta, 'rename', { line: 'l2', title: '  古风  人设 ' });
    state = ownState(chat, meta);
    assert.equal(state.registry.l2.kind, 'parallel');
    assert.equal(state.registry.l2.title, '古风 人设');
    // A hand-chosen kind wins over the request's.
    assert.equal(lineView({ storyline: state, total: chat.length, kindOf: id => state.kinds[id] || 'skit' }).label('l2'), '平行线 · 古风 人设');
    assert.throws(() => planLineAction(chat, meta, 'mark', { index: 99, line: MAIN }), /没有这条消息/);
    assert.throws(() => planLineAction(chat, meta, 'to-line', { line: 'nope' }), /没有这条线/);
});

test('marks of lines the record does not know, and broken records, are not followed', () => {
    const chat = [c('开场'), { ...u('a'), [LINE_FIELD]: 'ghost' }, c('b')];
    assert.equal(ownState(chat, {}).multi, false);
    const broken = { [LINES_KEY]: { lines: { x: 'no', main: { title: 'm' }, ok: { title: 'ok', kind: 'weird' } }, pending: 'gone', kinds: { ok: 'bad' } } };
    const reg = readRegistry(broken);
    assert.deepEqual(Object.keys(reg.lines), ['ok']);
    assert.equal(reg.lines.ok.kind, null);
    assert.equal(reg.pending, null);
    assert.deepEqual(reg.kinds, {});
});

test('an older story: suggestions from the requests, applied after the author checks them', () => {
    const chat = [c('开场'), u('他推开门'), c('门开了。'), u('暂停剧情，生成番外。主题是「雨夜」'), c('雨下了一夜。'), u('gemini 暂停剧情 自检是否ooc'),
        c('自检。'), u('回到正文'), c('回来了。'), u('写个小剧场：吵架'), c('吵。'), u('来个平行世界，现代AU'), c('现代。')];
    const found = suggestLineMarks(chat);
    assert.deepEqual(found.map(f => [f.index, f.action, f.kind ?? null]), [[3, 'start', 'side'], [7, 'back', null], [9, 'start', 'skit'], [11, 'start', 'parallel']]);
    assert.equal(found[0].title, '雨夜');
    const meta = apply(chat, {}, 'apply-suggestions', { items: found });
    const state = ownState(chat, meta);
    assert.deepEqual(state.segments.map(s => [s.start, s.end]), [[0, 2], [3, 6], [7, 8], [9, 10], [11, 12]]);
    assert.equal(state.segments[2].id, MAIN);
    assert.throws(() => planLineAction(chat, meta, 'apply-suggestions', { items: [{ index: 0, action: 'start' }] }), /没有可用的分段/);
});

test('the AI is sent only the openings of the requests, and only its floors among them are kept', () => {
    const chat = [c('开场'), u('<p>他推开门</p>'), c('门开了。'), u('写个小剧场：' + '长'.repeat(100)), c('……')];
    const heads = requestHeads(chat);
    assert.deepEqual(heads.map(h => h.index), [1, 3]);
    assert.equal(heads[0].text, '他推开门');
    assert.equal(heads[1].text.length, 60);
    const prompt = aiLinePrompt(heads);
    assert.ok(prompt.includes('#3 写个小剧场'));
    assert.ok(!prompt.includes('门开了'));
    const answer = '好的：\n```json\n[{"floor":3,"action":"start","kind":"skit","title":"长"},{"floor":2,"action":"back"},{"floor":3,"action":"back"},{"floor":1,"action":"jump"}]\n```';
    assert.deepEqual(parseAiLines(answer, heads), [{ index: 3, action: 'start', kind: 'skit', title: '长' }]);
    assert.equal(parseAiLines('没有', heads), null);
    assert.deepEqual(parseAiLines('[]', heads), []);
});

test('a kind picked by hand is kept over the request\'s; a message sent outside the shell is read as on sending', () => {
    const chat = [c('开场'), u('写个小剧场：吵架'), c('吵。'), u('回到正文'), c('回来了。')];
    let meta = apply(chat, {}, 'mark', { index: 1, title: '吵架', kind: 'parallel' });
    const id = Object.keys(readRegistry(meta).lines)[0];
    assert.equal(readRegistry(meta).kinds[id], 'parallel');
    // Sent in the full app: no pending, the request itself says it.
    assert.equal(planLineAction(chat, meta, 'detected', { index: 3, directive: lineDirective(chat[3].mes) }).marks[0][1], MAIN);
    const plain = [c('开场'), u('回到正文')];
    assert.equal(planLineAction(plain, {}, 'detected', { index: 1, directive: lineDirective(plain[1].mes) }), null);
    const fresh = [c('开场'), u('写个番外')];
    const plan = planLineAction(fresh, {}, 'detected', { index: 1, directive: lineDirective(fresh[1].mes) }, () => 'x');
    assert.deepEqual(plan.marks, [[1, 'x']]);
    assert.equal(plan.registry.lines.x.auto, true);
    assert.equal(planLineAction(fresh, {}, 'detected', { index: 1, directive: null }), null);
});

test('a line named from a request that said little is named again from its reply; renaming keeps the new name', () => {
    assert.equal(lineDirective('写个番外').weak, true);
    assert.equal(lineDirective('写个小剧场：丧尸男友').weak, false);
    const chat = [c('开场'), u('写个番外'), c('**雨夜**\n雨下了一夜。')];
    const meta = apply(chat, {}, 'mark', { index: 1, title: '写个番外', kind: 'side' });
    const id = Object.keys(readRegistry(meta).lines)[0];
    assert.equal(lineName(readRegistry(meta).lines[id], chat, 1), null); // named by hand
    assert.equal(lineName({ auto: true }, chat, 1), '雨夜');
    assert.equal(lineName({ auto: true }, [c('开场'), u('写个番外')], 1), null);
});

test('suggestions skip messages that already start a line; recorded lines list as 番外 to copy out', () => {
    const chat = [c('开场'), u('暂停剧情，生成番外。主题是「雨夜」'), c('雨。'), u('回到正文'), c('回来了。')];
    let meta = apply(chat, {}, 'apply-suggestions', { items: suggestLineMarks(chat) });
    assert.throws(() => planLineAction(chat, meta, 'apply-suggestions', { items: suggestLineMarks(chat) }), /没有可用的分段/);
    const state = ownState(chat, meta);
    assert.deepEqual(recordedEpisodes(state).map(({ from, to, title, kind, count }) => ({ from, to, title, kind, count })),
        [{ from: 1, to: 2, title: '雨夜', kind: 'side', count: 2 }]);
    assert.deepEqual(recordedEpisodes({ source: 'horae', segments: [] }), []);
});

test('a thinking model\'s notes before its answer are left out', () => {
    const heads = [{ index: 3, text: '写个番外' }];
    assert.deepEqual(parseAiLines('<think>看看 [1, 2] 哪里换线</think>[{"floor":3,"action":"start","kind":"side","title":"雨夜"}]', heads),
        [{ index: 3, action: 'start', kind: 'side', title: '雨夜' }]);
});
