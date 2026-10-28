// Nothing on the device keeps growing with use: preset entry drafts and world book entry drafts are kept only while
// something is unsaved, and world book save records that are settled are cleared after a while.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryStorage } from './preset-editor-fixture.js';
import { createPromptDraftStore, makePromptDraft } from '../src/preset-editor-model.js';
import { createWorldDraftStore } from '../src/world-editor-drafts.js';
import { createWorldEditorJournal } from '../src/world-editor-journal.js';
import { WORLD_DECISION_ACK, worldFingerprint } from '../src/world-editor-model.js';

const keys = (storage, prefix) => [...Array(storage.length)].map((_, i) => storage.key(i)).filter(k => k.startsWith(prefix));

test('a preset entry draft is stored only while text is unapplied', () => {
    const storage = memoryStorage(), store = createPromptDraftStore(storage);
    const state = { account: 'a', name: 'P', epoch: 0 }, draft = makePromptDraft(state, { identifier: 'main', content: 'x'.repeat(5000) });
    store.write(draft);
    assert.equal(keys(storage, 'tavern-lite:preset-draft:').length, 0);
    assert.equal(store.read(draft), null);
    store.write({ ...draft, text: 'changed', revision: 1 });
    assert.equal(store.read(draft).text, 'changed');
    store.write({ ...draft, text: 'changed', base: 'changed', revision: 2 });
    assert.equal(store.read(draft), null);
    // A conflict is kept even when the text equals what was applied.
    store.write({ ...draft, conflict: { missing: true } });
    assert.ok(store.read(draft).conflict);
});

test('drafts earlier versions kept with nothing unapplied are cleared, unapplied ones stay', () => {
    const storage = memoryStorage(), put = (id, value) => storage.setItem(`tavern-lite:preset-draft:${JSON.stringify(['a', 'P', id])}`, JSON.stringify({ account: 'a', name: 'P', identifier: id, revision: 0, conflict: null, ...value }));
    put('clean', { opened: 'x', base: 'x', text: 'x' });
    put('dirty', { opened: 'x', base: 'x', text: 'y' });
    put('conflict', { opened: 'x', base: 'x', text: 'x', conflict: { missing: true } });
    storage.setItem('tavern-lite:preset-draft:broken', '{');
    createPromptDraftStore(storage).pruneClean();
    assert.deepEqual(keys(storage, 'tavern-lite:preset-draft:').map(k => k.includes('[') ? JSON.parse(k.slice(25))[2] : 'broken').sort(), ['broken', 'conflict', 'dirty']);
});

test('world entry drafts: dropped from the device but kept for the visit; leftovers pruned by the page’s rule', () => {
    const storage = memoryStorage(), drafts = createWorldDraftStore({ storage: () => storage }), prefix = 'tavern-lite:world-draft:v1:';
    assert.equal(drafts.set('open', { revision: 1, form: { content: 'a' } }), true);
    drafts.drop('open');
    assert.equal(keys(storage, prefix).length, 0);
    assert.equal(drafts.get('open').form.content, 'a');
    storage.setItem(`${prefix}left-clean`, JSON.stringify({ revision: 1, clean: true }));
    storage.setItem(`${prefix}left-dirty`, JSON.stringify({ revision: 1, clean: false }));
    drafts.set('open', { revision: 2, clean: true });
    drafts.prune(value => value.clean);
    assert.deepEqual(keys(storage, prefix).sort(), [`${prefix}left-dirty`, `${prefix}open`]);
});

// An IndexedDB with only what the journal uses; each transaction commits once its requests ran.
function fakeIndexedDB() {
    const stored = new Map(), clone = value => value === undefined ? undefined : structuredClone(value);
    const db = { close() {}, transaction() {
        const tx = {}; let open = 0;
        const request = fn => { const req = {}; open++; queueMicrotask(() => { try { req.result = fn(); req.onsuccess?.({ target: req }); } catch (error) { req.error = error; req.onerror?.({ target: req }); }
            if (--open === 0) queueMicrotask(() => { if (!open) tx.oncomplete?.(); }); }); return req; };
        tx.objectStore = () => ({ add: value => request(() => { if (stored.has(value.key)) throw Object.assign(new Error('duplicate'), { name: 'ConstraintError' }); stored.set(value.key, clone(value)); }),
            get: key => request(() => clone(stored.get(key))), getAll: () => request(() => [...stored.values()].map(clone)),
            put: value => request(() => stored.set(value.key, clone(value))), delete: key => request(() => stored.delete(key)) });
        tx.abort = () => queueMicrotask(() => tx.onabort?.());
        return tx;
    } };
    return { stored, indexedDB: { open() { const req = {}; queueMicrotask(() => { req.result = db; req.onsuccess?.(); }); return req; } } };
}

test('settled world book save records are cleared after a while; open and decided ones stay', async () => {
    let clock = 1_000_000;
    const fake = fakeIndexedDB(), journal = createWorldEditorJournal({ indexedDB: fake.indexedDB, now: () => clock });
    const book = { entries: { 0: { uid: 0, content: 'x'.repeat(2000) } } };
    const make = id => journal.create({ account: 'alice', name: 'Book', operationId: id, draftRevision: 0, expectedBook: book, expectedFingerprint: worldFingerprint(book) });
    const confirmed = await make('confirmed'); await journal.update(confirmed, { stage: 'confirmed' });
    const notWritten = await make('not-written'); await journal.update(notWritten, { stage: 'not-submitted', outcomeVersion: 2, writeSettled: 'not-started' });
    await make('open');
    const unknown = await make('decided'), armed = await journal.update(unknown, { stage: 'unconfirmed' });
    await journal.decide(armed, { kind: 'missing' }, WORLD_DECISION_ACK);
    assert.equal(await journal.pruneSettled(10 * 60 * 1000), 0, 'just settled ones stay a while');
    clock += 11 * 60 * 1000;
    assert.equal(await journal.pruneSettled(10 * 60 * 1000), 2);
    assert.deepEqual([...fake.stored.values()].map(op => op.operationId).sort(), ['decided', 'open']);
    assert.deepEqual((await journal.unfinished('alice')).map(op => op.operationId).sort(), ['decided', 'open']);
});
