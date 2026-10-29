import test from 'node:test';
import assert from 'node:assert/strict';
import { MAIN_LINE, idsFromMarks, lineView } from '../src/line-view.js';

// The shape of a real story: 正文 with three nested 番外 written inside it, back to the 正文, two more lines, one with
// a 番外 of its own at the end.
const registry = {
    reborn: { title: '他重生了', parent: 'main' },
    memo: { title: '把前任的聊天框当备忘录', parent: 'reborn' },
    zombie: { title: '丧尸男友', parent: 'memo' },
    draft: { title: '古风人设草稿', parent: 'main' },
    gufeng: { title: '古风无情道', parent: 'main' },
    extra: { title: '番外', parent: 'gufeng' },
    gone: { title: '删掉的', parent: 'main', deleted: true },
};
const segments = [['main', 0, 354], ['reborn', 355, 386], ['memo', 387, 402], ['zombie', 403, 410], ['main', 411, 416],
    ['draft', 417, 426], ['gufeng', 427, 676], ['extra', 677, 820]].map(([id, start, end]) => ({ id, start, end }));
const storyline = { multi: true, active: 'extra', pending: null, registry, segments };
const total = 821;

test('each line shows only its own messages', () => {
    const view = lineView({ storyline, total });
    assert.equal(view.enabled, true);
    assert.equal(view.writing, 'extra');
    assert.deepEqual(view.indices('zombie'), [403, 404, 405, 406, 407, 408, 409, 410]);
    const main = view.indices(MAIN_LINE);
    assert.equal(main.length, 355 + 6);
    assert.equal(main.at(-1), 416);
    assert.ok(!main.includes(403));
    assert.equal(view.lineOf(405), 'zombie');
});

test('lines are listed under the line they were opened from', () => {
    const view = lineView({ storyline, total });
    assert.deepEqual(view.lines.map(l => [l.id, l.depth, l.count]),
        [['main', 0, 361], ['reborn', 1, 32], ['memo', 2, 16], ['zombie', 3, 8], ['draft', 1, 10], ['gufeng', 1, 250], ['extra', 2, 144]]);
    assert.equal(view.label('zombie'), '番外 · 丧尸男友');
});

test('a line leaves its parent under the parent\'s last message before it', () => {
    const view = lineView({ storyline, total });
    const main = view.marks(MAIN_LINE);
    assert.deepEqual([...main.keys()], [354, 416]);
    assert.deepEqual(main.get(354).map(l => l.id), ['reborn']);
    assert.deepEqual(main.get(416).map(l => l.id), ['draft', 'gufeng']);
    assert.deepEqual([...view.marks('memo').entries()].map(([at, ls]) => [at, ls.map(l => l.id)]), [[402, ['zombie']]]);
    // The 正文 coming back is not a line leaving.
    assert.equal(view.marks('zombie').size, 0);
});

test('the path runs from the 正文 down through the parents', () => {
    const view = lineView({ storyline, total });
    assert.deepEqual(view.path('zombie').map(p => p.label), ['正文', '番外 · 他重生了', '番外 · 把前任的聊天框当备忘录', '番外 · 丧尸男友']);
    assert.deepEqual(view.path(MAIN_LINE).map(p => p.id), ['main']);
});

test('a line copied from the 正文 only splits what it wrote itself', () => {
    const view = lineView({ storyline, total, from: 675 });
    assert.deepEqual(view.lines.map(l => [l.id, l.count]), [['gufeng', 2], ['extra', 144]]);
    assert.deepEqual(view.indices('gufeng'), [675, 676]);
    assert.equal(view.has('zombie'), false);
    // 古风无情道 is the parent of 番外 here; the 正文 itself has nothing of this line's own.
    assert.deepEqual(view.path('extra').map(p => [p.id, p.readable]), [['main', false], ['gufeng', true], ['extra', true]]);
});

test('one line only, or no Horae: nothing to split', () => {
    assert.equal(lineView({ storyline: null, total }).enabled, false);
    assert.equal(lineView({ storyline: { ...storyline, multi: false }, total }).enabled, false);
    assert.equal(lineView({ storyline, total, from: 700 }).enabled, false);
});

test('the next message\'s line is readable before it has anything', () => {
    const view = lineView({ storyline: { ...storyline, pending: 'zombie' }, total });
    assert.equal(view.writing, 'zombie');
    const fresh = lineView({ storyline: { ...storyline, registry: { ...registry, newer: { title: '新的', parent: 'extra' } }, pending: 'newer' }, total });
    assert.equal(fresh.writing, 'newer');
    assert.equal(fresh.count('newer'), 0);
    assert.deepEqual(fresh.indices('newer'), []);
    assert.ok(fresh.lines.some(l => l.id === 'newer'));
});

test('messages Horae has not placed yet follow the line being written', () => {
    const view = lineView({ storyline, total: total + 2 });
    assert.deepEqual(view.indices('extra').slice(-2), [821, 822]);
    const switched = lineView({ storyline: { ...storyline, pending: 'zombie' }, total: total + 1 });
    assert.equal(switched.lineOf(821), 'zombie');
});

test('marks on the messages give the same lines (the preview before the app is ready)', () => {
    const messages = Array.from({ length: total }, () => ({ mes: '' }));
    for (const seg of segments) if (seg.start > 0) messages[seg.start].horae_storyline = seg.id;
    messages[500].horae_storyline = 'gone';
    const ids = idsFromMarks(messages, registry);
    const view = lineView({ ids, registry, total });
    assert.deepEqual(view.indices('zombie'), [403, 404, 405, 406, 407, 408, 409, 410]);
    assert.equal(view.lineOf(500), 'gufeng');
    assert.equal(view.writing, 'extra');
});
