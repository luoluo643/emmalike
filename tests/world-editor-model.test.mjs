import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeWorldEntry, worldChanges, worldSearch, refreshWorldDraft, applySavedWorldDraft, worldFingerprint, validateWorldBook } from '../src/world-editor-model.js';

test('entry merge retains external non-overlapping and unknown imported fields', () => {
    const base = { uid: 0, content: 'old', comment: 'title', unknown: { data: 'keep' } }, remote = { ...base, comment: 'new elsewhere' };
    const result = mergeWorldEntry(base, remote, { content: 'mine', unknown: null });
    assert.equal(result.kind, 'merged'); assert.equal(result.entry.content, 'mine'); assert.equal(result.entry.comment, 'new elsewhere');
    assert.deepEqual(result.entry.unknown, { data: 'keep' }); assert.equal(remote.content, 'old');
});
test('overlapping changes require field choices and never silently win', () => {
    const base = { uid: 0, content: 'old', group: 'old group' }, remote = { ...base, content: 'remote' }, patch = { content: 'mine', group: 'new group' };
    const conflict = mergeWorldEntry(base, remote, patch); assert.equal(conflict.kind, 'conflict'); assert.equal(conflict.conflicts[0].key, 'content');
    assert.equal(mergeWorldEntry(base, remote, patch, { content: 'mine' }).entry.content, 'mine');
    assert.equal(mergeWorldEntry(base, remote, patch, { content: 'server' }).entry.content, 'remote');
    assert.equal(mergeWorldEntry(base, remote, { content: 'remote' }).kind, 'merged');
});
test('changed count follows values and one-field restore cannot erase other changes', () => {
    const base = { uid: 0, content: 'old', key: ['one'], comment: 'Title' }, draft = { ...base, content: 'new', comment: 'Other' };
    assert.equal(worldChanges(base, draft).length, 2); draft.content = base.content;
    assert.deepEqual(worldChanges(base, draft).map(x => x.key), ['comment']);
    assert.equal(worldChanges(base, { ...base, key: ['one'] }).length, 0);
});
test('search detects advanced fields and returns exact field and readable snippet', () => {
    const entry = { uid: 0, content: 'body', group: 'hidden advanced marker', keysecondary: ['moon'] };
    const group = worldSearch(entry, 'ADVANCED'); assert.equal(group.matched, true); assert.equal(group.hits[0].key, 'group'); assert.equal(group.hits[0].advanced, true);
    assert.ok(group.hits[0].snippet.includes('advanced')); assert.equal(worldSearch(entry, 'moon').hits[0].key, 'keysecondary');
    assert.equal(worldSearch(entry, 'absent').matched, false);
});
test('native refresh preserves local input while refreshing untouched fields and flagging overlap', () => {
    const opened = { uid: 0, content: 'old', comment: 'Title', group: 'old group' }, draft = { ...opened, content: 'mine' }, server = { ...opened, content: 'theirs', group: 'new group' };
    const result = refreshWorldDraft({ opened, base: opened, draft, server });
    assert.equal(result.draft.content, 'mine'); assert.equal(result.draft.group, 'new group'); assert.equal(result.conflicts[0].key, 'content');
    assert.equal(result.opened.group, 'old group'); assert.equal(result.base.content, 'old');
});
test('save completion only marks submitted text saved and keeps later edits', () => {
    const submitted = { uid: 0, content: 'submitted', comment: 'Title' }, current = { ...submitted, content: 'typed later' }, saved = { ...submitted, group: 'remote preserved' };
    const next = applySavedWorldDraft({ current, submitted, saved });
    assert.equal(next.content, 'typed later'); assert.equal(next.group, 'remote preserved');
    assert.deepEqual(worldChanges(saved, next).map(x => x.key), ['content']);
});
test('book fingerprints cover whole unknown contents and native identity is structurally checked', () => {
    const data = { entries: { 0: { uid: 0, content: 'same' } }, unknown: { value: 1 } };
    assert.notEqual(worldFingerprint(data), worldFingerprint({ ...data, unknown: { value: 2 } }));
    assert.equal(worldFingerprint(data), worldFingerprint({ unknown: { value: 1 }, entries: data.entries }));
    assert.deepEqual(validateWorldBook(data), data); assert.throws(() => validateWorldBook({ entries: { bad: { content: 'no UID' } } }), { code: 'WORLD_UNREADABLE' });
});
