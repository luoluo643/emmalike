import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldEditorJournal } from '../src/world-editor-journal.js';
import { WORLD_DECISION_ACK, hasWorldUserDecision, isBlockingWorldOperation, worldFingerprint } from '../src/world-editor-model.js';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
const input = () => { const expectedBook = { entries: { 0: { uid: 0, content: 'submitted' } } }; return { account: 'alice', name: 'Book', operationId: 'owned-operation', draftRevision: 3, expectedBook, expectedFingerprint: worldFingerprint(expectedBook) }; };
function lifecycle({ quota = false } = {}) {
    let stored = new Map(); const transactions = [];
    const db = { close() {}, transaction(name, mode) {
        const snapshot = new Map([...stored].map(([key, value]) => [key, clone(value)]));
        const request = fn => { const req = {}; queueMicrotask(() => { try { req.result = fn(); req.onsuccess?.({ target: req }); } catch (error) { req.error = error; req.onerror?.({ target: req }); } }); return req; };
        const tx = { objectStore: () => ({ add(value) { return request(() => { if (quota) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); if (snapshot.has(value.key)) throw Object.assign(new Error('duplicate'), { name: 'ConstraintError' }); snapshot.set(value.key, clone(value)); }); },
            get: key => request(() => clone(snapshot.get(key))), getAll: () => request(() => [...snapshot.values()].map(clone)), put: value => request(() => snapshot.set(value.key, clone(value))) }),
            commit() { if (mode === 'readwrite') stored = snapshot; tx.oncomplete?.(); }, abort() { queueMicrotask(() => tx.onabort?.()); } };
        transactions.push(tx); return tx;
    } };
    return { transactions, records: () => [...stored.values()].map(clone), indexedDB: { open() { const req = {}; queueMicrotask(() => { req.result = db; req.onsuccess?.(); }); return req; } } };
}
async function complete(fake, promise) { await turn(); fake.transactions.at(-1).commit(); return promise; }
test('real transaction completion, not request success, is the persistence boundary', async () => {
    const fake = lifecycle(), journal = createWorldEditorJournal({ indexedDB: fake.indexedDB }); let resolved = false;
    const promise = journal.create(input()).then(value => { resolved = true; return value; }); await turn(); assert.equal(resolved, false);
    fake.transactions[0].commit(); assert.equal((await promise).stage, 'prepared'); assert.equal(resolved, true);
});
test('commit abort or request quota cannot acknowledge a durable snapshot', async () => {
    const fake = lifecycle(), journal = createWorldEditorJournal({ indexedDB: fake.indexedDB }), pending = journal.create(input());
    const rejected = assert.rejects(pending, { code: 'WORLD_JOURNAL_UNAVAILABLE' }); await turn(); fake.transactions[0].abort(); await rejected;
    const quota = lifecycle({ quota: true }); await assert.rejects(createWorldEditorJournal({ indexedDB: quota.indexedDB }).create(input()), { code: 'WORLD_JOURNAL_UNAVAILABLE' });
});
test('account scope and revision CAS retain the immutable submitted snapshot', async () => {
    const fake = lifecycle(), journal = createWorldEditorJournal({ indexedDB: fake.indexedDB });
    const op = await complete(fake, journal.create(input()));
    assert.equal(await complete(fake, journal.read('bob', op.operationId)), null);
    const armed = await complete(fake, journal.update(op, { stage: 'armed', expectedBook: { entries: {} }, account: 'bob' }));
    assert.deepEqual(armed.expectedBook, input().expectedBook); assert.equal(armed.account, 'alice');
    await assert.rejects(journal.update(op, { stage: 'confirmed' }), { code: 'WORLD_OPERATION_CHANGED' });
});
test('duplicate operation IDs cannot allocate a new save snapshot and malformed fingerprints are rejected', async () => {
    const fake = lifecycle(), journal = createWorldEditorJournal({ indexedDB: fake.indexedDB });
    await complete(fake, journal.create(input())); await assert.rejects(journal.create(input()), { code: 'WORLD_OPERATION_EXISTS' });
    assert.throws(() => journal.create({ ...input(), expectedFingerprint: 'bad' }), { code: 'INVALID_WORLD_OPERATION' });
});
test('blocked open can retry and a late success closes its discarded database', async () => {
    const requests = []; let closed = 0;
    const journal = createWorldEditorJournal({ indexedDB: { open() { const request = {}; requests.push(request); return request; } } });
    const pending = journal.create(input()), rejected = assert.rejects(pending, { code: 'WORLD_JOURNAL_UNAVAILABLE' });
    requests[0].onblocked(); await rejected; requests[0].result = { close() { closed++; } }; requests[0].onsuccess(); assert.equal(closed, 1);
    const next = journal.create(input()), secondFailure = assert.rejects(next, { code: 'WORLD_JOURNAL_UNAVAILABLE' });
    assert.equal(requests.length, 2); requests[1].onerror(); await secondFailure;
});

test('a throwing indexedDB getter is deferred until editor storage use', async () => {
    const old = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get() { throw new DOMException('disabled', 'SecurityError'); } });
    try {
        const journal = createWorldEditorJournal();
        await assert.rejects(journal.unfinished('alice'), { code: 'WORLD_JOURNAL_UNAVAILABLE' });
    } finally { if (old) Object.defineProperty(globalThis, 'indexedDB', old); else delete globalThis.indexedDB; }
});

test('user decision commits independently of unknown outcome and cannot be overwritten by generic update', async () => {
    const fake = lifecycle(), journal = createWorldEditorJournal({ indexedDB: fake.indexedDB });
    const op = await complete(fake, journal.create(input()));
    const armed = await complete(fake, journal.update(op, { stage: 'armed', runtimeState: 'saving' }));
    let completed = false;
    const saving = journal.decide(armed, { kind: 'present', fingerprint: worldFingerprint({ entries: {} }) }, WORLD_DECISION_ACK).then(value => { completed = true; return value; });
    await turn(); assert.equal(completed, false); fake.transactions.at(-1).commit(); const decided = await saving;
    assert.equal(decided.stage, 'armed'); assert.equal(decided.runtimeState, 'saving'); assert.ok(hasWorldUserDecision(decided)); assert.equal(isBlockingWorldOperation(decided), false);
    assert.deepEqual(decided.expectedBook, op.expectedBook);
    const updated = await complete(fake, journal.update(decided, { userDecision: null, stage: 'confirmed', lastObservation: { kind: 'matches-submitted' } }));
    assert.deepEqual(updated.userDecision, decided.userDecision);
    const later = await complete(fake, journal.update(updated, { stage: 'conflict', lastObservation: { kind: 'differs' } }));
    assert.equal(later.stage, 'confirmed'); assert.equal(later.lastObservation.kind, 'differs');
    assert.equal((await complete(fake, journal.unfinished('alice'))).length, 1);
});

test('decision CAS, final synchronous guard and transaction abort cannot release pending writes', async () => {
    const fake = lifecycle(), journal = createWorldEditorJournal({ indexedDB: fake.indexedDB });
    const op = await complete(fake, journal.create(input()));
    const armed = await complete(fake, journal.update(op, { stage: 'armed' }));
    await assert.rejects(journal.decide(op, { kind: 'missing' }, WORLD_DECISION_ACK), { code: 'WORLD_OPERATION_CHANGED' });
    await assert.rejects(journal.decide(armed, { kind: 'missing' }, WORLD_DECISION_ACK, () => { throw Object.assign(new Error('new cache'), { code: 'WORLD_RUNTIME_CONFLICT' }); }), { code: 'WORLD_RUNTIME_CONFLICT' });
    const waiting = journal.decide(armed, { kind: 'missing' }, WORLD_DECISION_ACK), rejected = assert.rejects(waiting, { code: 'WORLD_JOURNAL_UNAVAILABLE' });
    await turn(); fake.transactions.at(-1).abort(); await rejected;
    const actual = await complete(fake, journal.read('alice', op.operationId)); assert.equal(actual.userDecision, undefined); assert.ok(isBlockingWorldOperation(actual));
});

test('malformed or mismatched decision records never bypass the pending predicate', async () => {
    const fake = lifecycle(), journal = createWorldEditorJournal({ indexedDB: fake.indexedDB });
    const op = await complete(fake, journal.create(input()));
    assert.throws(() => journal.decide(op, { kind: 'present', fingerprint: 'invalid' }, WORLD_DECISION_ACK), { code: 'INVALID_WORLD_DECISION' });
    assert.throws(() => journal.decide(op, { kind: 'missing' }, 'yes'), { code: 'INVALID_WORLD_DECISION' });
    const decided = await complete(fake, journal.decide(op, { kind: 'missing' }, WORLD_DECISION_ACK));
    for (const field of ['account', 'operationId', 'name', 'acknowledgement']) {
        const malformed = clone(decided); malformed.userDecision[field] = 'different'; assert.equal(hasWorldUserDecision(malformed), false); assert.ok(isBlockingWorldOperation(malformed));
    }
});

test('legacy resolved plus not-saved is normalized to unknown without silently rewriting its stored evidence', async () => {
    const fake = lifecycle(), journal = createWorldEditorJournal({ indexedDB: fake.indexedDB });
    let op = await complete(fake, journal.create(input()));
    op = await complete(fake, journal.update(op, { stage: 'not-saved', writeSettled: 'resolved', runtimeState: 'ready', retryAllowed: true }));
    const before = fake.records(), read = await complete(fake, journal.read(op.account, op.operationId));
    assert.equal(read.stage, 'unconfirmed'); assert.equal(read.retryAllowed, false); assert.equal(read.legacyOutcome, 'not-saved');
    assert.equal((await complete(fake, journal.unfinished('alice'))).length, 1); assert.deepEqual(fake.records(), before);
    const decided = await complete(fake, journal.decide(read, { kind: 'missing' }, WORLD_DECISION_ACK));
    assert.equal(decided.stage, 'unconfirmed'); assert.ok(hasWorldUserDecision(decided));
    assert.equal(fake.records()[0].stage, 'not-saved'); assert.equal(fake.records()[0].writeSettled, 'resolved');
    const historical = await complete(fake, journal.update(decided, { lastObservation: { kind: 'matches-base' } }));
    assert.equal(historical.stage, 'unconfirmed'); assert.equal(fake.records()[0].stage, 'not-saved');
});

test('legacy explicit before-call terminal receipt is preserved, unlike a provisional armed row', async () => {
    const fake = lifecycle(), journal = createWorldEditorJournal({ indexedDB: fake.indexedDB });
    let op = await complete(fake, journal.create(input()));
    op = await complete(fake, journal.update(op, { stage: 'armed', writeSettled: 'not-started' }));
    assert.equal((await complete(fake, journal.unfinished('alice'))).length, 1);
    op = await complete(fake, journal.update(op, { stage: 'not-saved', writeSettled: 'not-started' }));
    const read = await complete(fake, journal.read('alice', op.operationId));
    assert.equal(read.stage, 'not-submitted'); assert.equal(read.retryAllowed, true);
    assert.equal((await complete(fake, journal.unfinished('alice'))).length, 0); assert.equal(fake.records()[0].stage, 'not-saved');
});
