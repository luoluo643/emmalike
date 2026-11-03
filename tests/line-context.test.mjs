import test from 'node:test';
import assert from 'node:assert/strict';
import { LINES_KEY, LINE_FIELD, MAIN, ownState, planLineAction, readRegistry, replyLine, sentIndices } from '../src/own-lines.js';
import { lineView } from '../src/line-view.js';
import { holdBack } from '../bridge-line-context.js';

const u = mes => ({ is_user: true, is_system: false, mes, extra: {} });
const c = mes => ({ is_user: false, is_system: false, mes, extra: {} });
let n = 0;
const ids = () => `l${++n}`;
function apply(chat, metadata, action, options) {
    const plan = planLineAction(chat, metadata, action, options, ids);
    if (!plan) return metadata;
    for (const [i, line] of plan.marks) { if (line) chat[i][LINE_FIELD] = line; else delete chat[i][LINE_FIELD]; }
    return { ...metadata, [LINES_KEY]: plan.registry };
}
const sorted = set => set ? [...set].sort((a, b) => a - b) : set;

// 正文 0-2, A 3-4, 正文 5-6, B 7-8, A again 9-10.
function story() {
    n = 0;
    const chat = [c('你来了。'), u('他推开门'), c('门开了。')];
    let meta = apply(chat, {}, 'new-next', { title: '雨夜', kind: 'side' });
    chat.push(u('生成番外：雨夜'), c('雨下着。'));
    meta = apply(chat, meta, 'apply-pending', { index: 3 });
    meta = apply(chat, meta, 'to-main');
    chat.push(u('回到正文'), c('回来了。'));
    meta = apply(chat, meta, 'apply-pending', { index: 5 });
    meta = apply(chat, meta, 'new-next', { title: '吵架', kind: 'skit' });
    chat.push(u('小剧场：吵架'), c('吵起来了。'));
    meta = apply(chat, meta, 'apply-pending', { index: 7 });
    meta = apply(chat, meta, 'to-line', { line: 'l1' });
    chat.push(u('接着雨夜'), c('雨停了。'));
    meta = apply(chat, meta, 'apply-pending', { index: 9 });
    return { chat, meta };
}

test('a story whose lines chose nothing sends as before', () => {
    const { chat, meta } = story();
    assert.equal(sentIndices(chat, meta, 'l1'), null);
    assert.equal(sentIndices(chat, meta, MAIN), null);
    const sent = [...chat];
    assert.equal(holdBack(sent, chat, meta, 'normal'), 0);
    assert.equal(sent.length, chat.length);
});

test('fork sends the 正文 before the line left and the line itself; own sends the line alone; the 正文 leaves both out', () => {
    let { chat, meta } = story();
    meta = apply(chat, meta, 'set-context', { line: 'l1', context: 'fork' });
    meta = apply(chat, meta, 'set-context', { line: 'l2', context: 'own' });
    assert.deepEqual(sorted(sentIndices(chat, meta, 'l1')), [0, 1, 2, 3, 4, 9, 10]);
    assert.deepEqual(sorted(sentIndices(chat, meta, 'l2')), [7, 8]);
    assert.deepEqual(sorted(sentIndices(chat, meta, MAIN)), [0, 1, 2, 5, 6]);
    // A line that sends the whole story still leaves out the lines kept apart.
    meta = apply(chat, meta, 'set-context', { line: 'l1', context: 'all' });
    assert.deepEqual(sorted(sentIndices(chat, meta, 'l1')), [0, 1, 2, 3, 4, 5, 6, 9, 10]);
    assert.deepEqual(sorted(sentIndices(chat, meta, MAIN)), [0, 1, 2, 3, 4, 5, 6, 9, 10]);
});

test('a line left from another line sends what that line sends, up to where it left', () => {
    let { chat, meta } = story();
    meta = apply(chat, meta, 'set-context', { line: 'l1', context: 'fork' });
    meta = apply(chat, meta, 'new-next', { title: '梦里', kind: 'side', parent: 'l1', context: 'fork' });
    chat.push(u('番外里的番外：梦里'), c('做梦了。'));
    meta = apply(chat, meta, 'apply-pending', { index: 11 });
    assert.equal(readRegistry(meta).lines.l3.parent, 'l1');
    assert.deepEqual(sorted(sentIndices(chat, meta, 'l3')), [0, 1, 2, 3, 4, 9, 10, 11, 12]);
    // A line with nothing written yet: everything its parent sends (吵架 chose nothing: it is sent as before).
    meta = apply(chat, meta, 'new-next', { title: '还没写', kind: 'side', parent: MAIN, context: 'fork' });
    assert.deepEqual(sorted(sentIndices(chat, meta, 'l4')), [0, 1, 2, 5, 6, 7, 8]);
});

test('a line that sends the whole story also sends every line it left from, even one kept apart', () => {
    let { chat, meta } = story();
    meta = apply(chat, meta, 'set-context', { line: 'l1', context: 'own' });
    // 梦里 left 雨夜 (own); 梦中梦 left 梦里 (fork); both whole-story lines under them see 雨夜.
    meta = apply(chat, meta, 'new-next', { title: '梦里', kind: 'side', parent: 'l1', context: 'fork' });
    chat.push(u('番外里的番外：梦里'), c('做梦了。'));
    meta = apply(chat, meta, 'apply-pending', { index: 11 });
    meta = apply(chat, meta, 'new-next', { title: '梦中梦', kind: 'side', parent: 'l3', context: 'all' });
    chat.push(u('梦中梦'), c('还在梦里。'));
    meta = apply(chat, meta, 'apply-pending', { index: 13 });
    // 雨夜 (own) whole, 梦里 (fork) whole, the 正文 and 吵架 (both chose nothing), itself.
    assert.deepEqual(sorted(sentIndices(chat, meta, 'l4')), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    // 梦里 (fork) sends what 雨夜 (own) sends up to where it left: 雨夜 alone.
    assert.deepEqual(sorted(sentIndices(chat, meta, 'l3')), [3, 4, 9, 10, 11, 12]);
    // The 正文 still leaves out the lines kept apart (梦中梦 sends the whole story: it is not kept apart).
    assert.deepEqual(sorted(sentIndices(chat, meta, MAIN)), [0, 1, 2, 5, 6, 7, 8, 13, 14]);
    // A parent loop in a damaged record does not hang.
    const loop = { [LINES_KEY]: { ...meta[LINES_KEY], lines: { ...meta[LINES_KEY].lines, l1: { ...meta[LINES_KEY].lines.l1, parent: 'l4' } } } };
    assert.ok(sentIndices(chat, loop, 'l4').has(3));
});

test('the choice is kept by every other action; remembered, it goes to the lines started after', () => {
    let { chat, meta } = story();
    meta = apply(chat, meta, 'set-context', { line: 'l1', context: 'own', remember: true });
    meta = apply(chat, meta, 'rename', { line: 'l1', title: '雨夜二' });
    meta = apply(chat, meta, 'set-kind', { line: 'l2', kind: 'parallel' });
    meta = apply(chat, meta, 'clear-pending');
    let registry = readRegistry(meta);
    assert.equal(registry.contexts.l1, 'own');
    assert.equal(registry.defaultContext, 'own');
    meta = apply(chat, meta, 'new-next', { title: '新的', kind: 'side' });
    meta = apply(chat, meta, 'mark', { index: 6, title: '从这里', kind: 'side' });
    registry = readRegistry(meta);
    assert.equal(registry.contexts.l3, 'own');
    assert.equal(registry.contexts.l4, 'own');
    // Chosen in the form, it wins over the remembered one; not remembered, the remembered one stays.
    meta = apply(chat, meta, 'new-next', { title: '再一个', kind: 'side', context: 'fork' });
    registry = readRegistry(meta);
    assert.equal(registry.contexts.l5, 'fork');
    assert.equal(registry.defaultContext, 'own');
    assert.equal(ownState(chat, meta).registry.l1.context, 'own');
    assert.equal(ownState(chat, meta).defaultContext, 'own');
});

test('set-context checks the line and the choice; a stored choice that is not one is dropped', () => {
    const { chat, meta } = story();
    assert.throws(() => planLineAction(chat, meta, 'set-context', { line: MAIN, context: 'own' }), /没有这条线/);
    assert.throws(() => planLineAction(chat, meta, 'set-context', { line: 'nope', context: 'own' }), /没有这条线/);
    assert.throws(() => planLineAction(chat, meta, 'set-context', { line: 'l1', context: 'some' }), /请选择/);
    const odd = { [LINES_KEY]: { ...meta[LINES_KEY], contexts: { l1: 'some', l2: 'own', main: 'own' }, defaultContext: 'x' } };
    assert.deepEqual(readRegistry(odd).contexts, { l2: 'own' });
    assert.equal(readRegistry(odd).defaultContext, null);
});

test('the reply goes on the line asked for, but a new swipe, a regenerate or going on stays on the last message', () => {
    let { chat, meta } = story();
    assert.equal(replyLine(chat, meta), 'l1');
    meta = apply(chat, meta, 'to-line', { line: 'l2' });
    assert.equal(replyLine(chat, meta), 'l2');
    assert.equal(replyLine(chat, meta, { afterLast: true }), 'l1');
});

test('holdBack takes out of the generation chat what the line does not send, keeps what it does not know and the message answered', () => {
    let { chat, meta } = story();
    meta = apply(chat, meta, 'set-context', { line: 'l2', context: 'own' });
    meta = apply(chat, meta, 'to-line', { line: 'l2' });
    const injected = { is_user: false, mes: '别的扩展加的', extra: {} };
    let sent = [...chat.slice(0, 5), injected, ...chat.slice(5)];
    // The next message goes on 吵架 (own): only its stretch, the injected entry and the message being answered.
    assert.equal(holdBack(sent, chat, meta, 'normal'), 8);
    assert.deepEqual(sent.map(m => m.mes), ['别的扩展加的', '小剧场：吵架', '吵起来了。', '雨停了。']);
    // A new swipe of the last reply stays on 雨夜 (whole story): 吵架 is left out.
    sent = [...chat];
    assert.equal(holdBack(sent, chat, meta, 'swipe'), 2);
    assert.ok(!sent.some(m => m.mes === '吵起来了。'));
    // What the app really hands over: shallow copies with the text prepared, known by their extra.
    sent = chat.map(m => ({ ...m, mes: `${m.mes}（已处理）` }));
    assert.equal(holdBack(sent, chat, meta, 'normal'), 8);
    assert.deepEqual(sent.map(m => m.mes), ['小剧场：吵架（已处理）', '吵起来了。（已处理）', '雨停了。（已处理）']);
    // Saved without extra: known in order by who sent it and when.
    const old = chat.map((m, i) => { const { extra, ...rest } = m; return { ...rest, name: m.is_user ? 'User' : '他', send_date: `t${i % 3}` }; });
    sent = old.map(m => ({ ...m, mes: `${m.mes}（已处理）` }));
    assert.equal(holdBack(sent, old, meta, 'normal'), 8);
    assert.deepEqual(sent.map(m => m.mes), ['小剧场：吵架（已处理）', '吵起来了。（已处理）', '雨停了。（已处理）']);
});

test('lineView carries what each line sends', () => {
    let { chat, meta } = story();
    meta = apply(chat, meta, 'set-context', { line: 'l1', context: 'fork' });
    const view = lineView({ storyline: ownState(chat, meta), total: chat.length });
    assert.equal(view.lines.find(l => l.id === 'l1').context, 'fork');
    assert.equal(view.lines.find(l => l.id === 'l2').context, null);
    assert.equal(view.lines.find(l => l.id === MAIN).context, null);
});
