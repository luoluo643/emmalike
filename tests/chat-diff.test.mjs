import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, diffLines, hashLines, hashText } from '../server-chat-save/chat-diff.mjs';

const chat = n => [JSON.stringify({ chat_metadata: { integrity: 'x' } }), ...Array.from({ length: n }, (_, i) => JSON.stringify({ mes: `第${i}条 “引号” \n 换行`, is_user: i % 2 === 0 }))];

test('the hash of lines is the hash of the file text they make', () => {
    const lines = chat(20);
    assert.equal(hashLines(lines), hashText(lines.join('\n')));
    assert.equal(hashLines([]), hashText(''));
    assert.notEqual(hashLines(['a', 'b']), hashLines(['ab']));
    assert.notEqual(hashLines(['a', '']), hashLines(['a']));
    const edited = lines.slice(); edited[7] = edited[7].replace('第', '弟');
    assert.notEqual(hashLines(edited), hashLines(lines));
});

test('a patch carries only the changed lines and rebuilds the new chat', () => {
    const old = chat(30);
    const next = old.slice(); next[0] = JSON.stringify({ chat_metadata: { integrity: 'x', note: 1 } }); next[30] = '{"mes":"改了"}'; next.push('{"mes":"新的"}');
    const patch = diffLines(old, next);
    assert.deepEqual(patch.set.map(([i]) => i), [0, 30, 31]);
    assert.deepEqual(applyPatch(old, patch), next);
    const shorter = old.slice(0, 10);
    assert.deepEqual(applyPatch(old, diffLines(old, shorter)), shorter);
    assert.deepEqual(diffLines(old, old).set, []);
});

test('a malformed patch, or one that leaves a line unknown, is refused', () => {
    const old = chat(3);
    assert.equal(old.length, 4);
    assert.equal(applyPatch(old, { length: 7, set: [[4, '{}'], [5, '{}']] }), null);
    assert.deepEqual(applyPatch(old, { length: 6, set: [[4, '{}'], [5, '{}']] }), [...old, '{}', '{}']);
    assert.equal(applyPatch(old, { length: 2, set: [[2, '{}']] }), null);
    assert.equal(applyPatch(old, { length: 2, set: [[0, 1]] }), null);
    assert.equal(applyPatch(old, { length: -1, set: [] }), null);
    assert.equal(applyPatch(old, { length: 2 }), null);
    assert.equal(applyPatch(old, { length: 1.5, set: [] }), null);
    assert.deepEqual(applyPatch([], { length: 2, set: [[0, 'a'], [1, 'b']] }), ['a', 'b']);
});

test('the bridge copy of the line hash and diff is the plugin one', async () => {
    const lines = await import('../src/chat-lines.js');
    for (const name of ['hashLines', 'diffLines', 'hashText']) assert.equal(String(lines[name]), String({ hashLines, diffLines, hashText }[name]), name);
});
