import test from 'node:test';
import assert from 'node:assert/strict';
import { hasShortNames, hideInText, hideNames, readerNames, roundAt, storyRounds, summarize } from '../src/share-model.js';

const msg = (index, user, mes, name = user ? '阿青' : '林小满') => ({ index, user, name, mes });

test('a story is cut into rounds that start at the reader\'s messages, the greeting being round 0', () => {
    const rounds = storyRounds([msg(0, false, '你好呀'), msg(1, true, '去河边'), msg(2, false, '好'), msg(3, false, '（又说）'), msg(5, true, '回家')]);
    assert.deepEqual(rounds.map(r => [r.number, r.from, r.to, r.messages.length]), [[0, 0, 0, 1], [1, 1, 3, 3], [2, 5, 5, 1]]);
    assert.equal(rounds[1].summary, '去河边');
});

test('a story that starts with the reader has no round 0', () => {
    const rounds = storyRounds([msg(0, true, '开头'), msg(1, false, '回复')]);
    assert.deepEqual(rounds.map(r => r.number), [1]);
    assert.deepEqual(storyRounds([]), []);
});

test('a message is found in its round, and "from this message" starts at that round', () => {
    const rounds = storyRounds([msg(0, false, 'a'), msg(1, true, 'b'), msg(2, false, 'c'), msg(4, true, 'd'), msg(5, false, 'e')]);
    assert.equal(roundAt(rounds, 0), 0);
    assert.equal(roundAt(rounds, 2), 1);
    assert.equal(roundAt(rounds, 3), 2, 'a hidden or missing index falls to the next round');
    assert.equal(roundAt(rounds, 99), 2);
});

test('round summaries are one short line of plain text', () => {
    assert.equal(summarize('<p>**你好**，\n\n<i>世界</i></p>'), '你好， 世界');
    assert.equal(summarize('一二三四五六七八九十'.repeat(3)), `${'一二三四五六七八九十'.repeat(3).slice(0, 24)}…`);
    assert.equal(summarize('<style>.a{color:red}</style>只要这句'), '只要这句');
});

test('the reader\'s names come from their messages and the current persona', () => {
    const names = readerNames([msg(0, false, 'x'), msg(1, true, 'y'), { ...msg(2, true, 'z'), name: '青青' }, { ...msg(3, true, 'w'), name: ' ' }], '阿青');
    assert.deepEqual(names, ['阿青', '青青']);
    assert.deepEqual(readerNames([], ''), []);
});

test('hiding names replaces the reader\'s name over their messages and inside every text, longest name first', () => {
    const out = hideNames([
        { name: '阿青', user: true, text: '我是阿青，也叫青青阿青' },
        { name: '林小满', user: false, text: '阿青，青青阿青来了。小满不变' },
    ], ['阿青', '青青阿青']);
    assert.deepEqual(out, [
        { name: '■■', user: true, text: '我是■■，也叫■■' },
        { name: '林小满', user: false, text: '■■，■■来了。小满不变' },
    ]);
});

test('a one-character name is hidden over messages only, and names with symbols are matched literally', () => {
    const out = hideNames([{ name: '青', user: true, text: '青山和青' }, { name: 'A.B', user: false, text: 'A.B 和 AxB' }], ['青', 'A.B']);
    assert.deepEqual(out, [{ name: '■■', user: true, text: '青山和青' }, { name: '■■', user: false, text: '■■ 和 AxB' }]);
    assert.equal(hasShortNames(['青', '阿青']), true);
    assert.equal(hasShortNames(['阿青']), false);
    assert.equal(hideInText('林小满 · 第 1 个故事', []), '林小满 · 第 1 个故事');
});
