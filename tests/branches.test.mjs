import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { storyBranches, forksByIndex } from '../src/branches.js';

const account = 'alice', rootId = randomUUID();
const line = (title, extra = {}) => ({ schemaVersion: 1, ownerAccount: account, episodeId: randomUUID(), rootId, parentId: rootId, kind: 'parallel', title,
    contextMode: 'continued', createdAt: extra.createdAt ?? '2026-10-26T09:10:51.917Z', creationOperationId: randomUUID(),
    sourceIdentityKind: 'native-integrity', sourceAnchor: { sourceId: rootId, sourceIntegrity: rootId, sourceFingerprint: 'a'.repeat(64), messageCount: 675,
        messagePrefixFingerprint: 'b'.repeat(64), anchor: { index: 674, fingerprint: 'c'.repeat(64) }, locator: { account, avatar: 'c.png', file: 'root' },
        capturedAt: '2026-10-26T09:10:51.917Z' }, ...extra });
const root = { file_name: 'root.jsonl', chat_items: 676, chat_metadata: { integrity: rootId } };
const meta = line('meta'), rain = line('雨夜', { kind: 'side', createdAt: '2026-10-20T00:00:00Z', sourceAnchor: { ...line('x').sourceAnchor, messageCount: 521, anchor: { index: 520, fingerprint: 'd'.repeat(64) } } });
const split = line('拆出来的', { contextMode: 'fresh', extractedFrom: { from: 100, to: 130, count: 31 }, createdAt: '2026-10-27T00:00:00Z' });
const chapters = [root, { file_name: 'tl-episode-meta.jsonl', chat_items: 706, chat_metadata: { integrity: randomUUID(), tavern_lite_episode: meta } },
    { file_name: 'tl-episode-rain.jsonl', chat_items: 533, chat_metadata: { integrity: randomUUID(), tavern_lite_episode: rain } },
    { file_name: 'tl-episode-split.jsonl', chat_items: 31, chat_metadata: { integrity: randomUUID(), tavern_lite_episode: split } },
    { file_name: 'other.jsonl', chat_items: 3, chat_metadata: { integrity: randomUUID() } }];

test('the 正文 lists the lines copied from it, oldest first, with where each leaves', () => {
    const b = storyBranches(chapters, 'root', account);
    assert.equal(b.line, null); assert.equal(b.parent, null);
    assert.deepEqual(b.children.map(c => [c.title, c.forkIndex]), [['雨夜', 520], ['meta', 674], ['拆出来的', 130]]);
    const marks = forksByIndex(b.children);
    assert.deepEqual(marks.get(674).map(c => c.file), ['tl-episode-meta']);
});

test('a line knows its 正文 and where its own writing starts; a split-out part copied nothing before', () => {
    const b = storyBranches(chapters, 'tl-episode-meta', account);
    assert.deepEqual(b.parent, { file: 'root' }); assert.equal(b.ownStart, 674); assert.deepEqual(b.children, []);
    assert.equal(storyBranches(chapters, 'tl-episode-split', account).ownStart, null);
});

test('a renamed 正文 is still found by its identity; an ambiguous one is not guessed', () => {
    const renamed = chapters.map(c => c === root ? { ...root, file_name: 'renamed.jsonl' } : c);
    assert.deepEqual(storyBranches(renamed, 'tl-episode-meta', account).parent, { file: 'renamed' });
    const twice = [...renamed, { ...root, file_name: 'copy.jsonl' }];
    assert.equal(storyBranches(twice, 'tl-episode-meta', account).parent, null);
});

test('another account\'s lines and ordinary stories are not branches', () => {
    assert.deepEqual(storyBranches(chapters, 'root', 'bob').children, []);
    assert.deepEqual(storyBranches(chapters, 'other', account), { line: null, parent: null, ownStart: null, children: [] });
});
