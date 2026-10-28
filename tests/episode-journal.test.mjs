import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createEpisodeJournal, validateOperationCapture, applyOperationTransition, applyDraftWrite } from '../src/episode-journal.js';

function input() {
    const rootId = randomUUID();
    return { account: 'alice', operationId: randomUUID(), contextMode: 'continued', capturedText: 'start side story', draftRevision: 1,
        cancelId: randomUUID(), sourceFingerprint: 'a'.repeat(64), source: { locator: { account: 'alice', avatar: 'a.png', file: 'root' } },
        target: { episodeId: randomUUID(), rootId, parentId: rootId, integrity: randomUUID(), locator: { account: 'alice', avatar: 'a.png', file: 'child' } } };
}
const transition = (old, stage, extra = {}) => applyOperationTransition(old, { account: old.account, operationId: old.operationId,
    expectedRevision: old.revision, expectedStage: old.stage, patch: { stage, ...extra } }, 123);

test('capture binds complete ownership and cannot forge persisted stage or revision', () => {
    const capture = input(), valid = validateOperationCapture({ ...capture, stage: 'confirmed', revision: 999, ownerAccount: 'bob' });
    assert.equal(valid.stage, undefined); assert.equal(valid.revision, undefined); assert.equal(valid.ownerAccount, 'alice');
    assert.throws(() => validateOperationCapture({ ...capture, account: 'bob' }), { code: 'INVALID_OPERATION' });
    assert.throws(() => validateOperationCapture({ ...capture, sourceFingerprint: 'last-message-only' }), { code: 'INVALID_OPERATION' });
    assert.throws(() => validateOperationCapture({ ...capture, target: { ...capture.target, locator: capture.source.locator } }), { code: 'INVALID_OPERATION' });
});

test('uncertain create and submission never return to retryable pre-submit stages', () => {
    const base = { ...input(), stage: 'create-armed', revision: 3 };
    const unknown = transition(base, 'create-unconfirmed');
    assert.throws(() => transition(unknown, 'create-armed'), { code: 'INVALID_STAGE' });
    assert.throws(() => transition(unknown, 'source-confirmed'), { code: 'INVALID_STAGE' });
    assert.equal(transition(unknown, 'created').stage, 'created');
    const submitted = { ...base, stage: 'submit-armed' };
    assert.throws(() => transition(submitted, 'awaiting-review'), { code: 'INVALID_STAGE' });
    assert.throws(() => transition(submitted, 'cancelled'), { code: 'INVALID_STAGE' });
    assert.equal(transition(submitted, 'save-unconfirmed').stage, 'save-unconfirmed');
});

test('operation transitions use revision and stage CAS and preserve captured identity', () => {
    const old = { ...input(), stage: 'captured', revision: 1 };
    assert.throws(() => applyOperationTransition(old, { account: old.account, operationId: old.operationId, expectedRevision: 0, expectedStage: 'captured', patch: { stage: 'source-confirmed' } }, 1), { code: 'JOURNAL_CONFLICT' });
    for (const extra of [{ capturedText: 'changed' }, { target: input().target }, { account: 'bob' }]) assert.throws(() => transition(old, 'source-confirmed', extra), { code: 'IMMUTABLE_OPERATION' });
    assert.throws(() => transition(old, 'source-confirmed', { resolvedLocator: { ...old.target.locator, account: 'bob' } }), { code: 'ACCOUNT_CHANGED' });
});

test('only exact target and full expected fingerprint can complete an operation', () => {
    const old = { ...input(), stage: 'saving', revision: 8 };
    const confirmation = { state: 'confirmed', ownerAccount: 'alice', locator: old.target.locator, episodeId: old.target.episodeId, creationOperationId: old.operationId,
        expectedFingerprint: 'a'.repeat(64), observedFingerprint: 'a'.repeat(64), operationRevision: 8 };
    assert.equal(transition(old, 'confirmed', { confirmation }).stage, 'confirmed');
    for (const patch of [{ observedFingerprint: 'b'.repeat(64) }, { operationRevision: 7 }, { episodeId: randomUUID() }, { locator: old.source.locator }]) {
        assert.throws(() => transition(old, 'confirmed', { confirmation: { ...confirmation, ...patch } }), { code: 'SAVE_UNCONFIRMED' });
    }
});

test('draft revisions detect even same-text edits and account changes', () => {
    const capture = input(), locator = capture.source.locator;
    const first = applyDraftWrite(null, { account: 'alice', locator, expectedDraftRevision: 0, text: 'same' }, 1);
    const second = applyDraftWrite(first, { account: 'alice', locator, expectedDraftRevision: 1, text: 'same' }, 2);
    assert.equal(second.draftRevision, 2);
    assert.throws(() => applyDraftWrite(second, { account: 'alice', locator, expectedDraftRevision: 1, text: '' }, 3), { code: 'DRAFT_CHANGED' });
    assert.throws(() => applyDraftWrite(second, { account: 'bob', locator, expectedDraftRevision: 2, text: '' }, 3), { code: 'ACCOUNT_CHANGED' });
});

test('missing IndexedDB and synchronous open failures are explicit and retryable', async () => {
    await assert.rejects(createEpisodeJournal({ indexedDB: null }).captureIntent(input()), { code: 'JOURNAL_UNAVAILABLE' });
    let calls = 0;
    const journal = createEpisodeJournal({ indexedDB: { open() { calls++; throw new Error('injected unavailable'); } } });
    await assert.rejects(journal.captureIntent(input()), { code: 'JOURNAL_UNAVAILABLE' });
    await assert.rejects(journal.captureIntent(input()), { code: 'JOURNAL_UNAVAILABLE' });
    assert.equal(calls, 2);
});

test('a denied indexedDB getter does not break bridge construction and journal access remains retryable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    let getterCalls = 0, denied = true, openCalls = 0;
    try {
        Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get() {
            getterCalls++;
            if (denied) throw Object.assign(new Error('storage access denied'), { name: 'SecurityError' });
            return { open() { openCalls++; throw Object.assign(new Error('storage method denied'), { name: 'SecurityError' }); } };
        } });
        const journal = createEpisodeJournal();
        assert.equal(getterCalls, 0, 'An unused journal must not acquire browser storage');
        journal.close(); assert.equal(getterCalls, 0);
        await assert.rejects(journal.captureIntent(input()), error => error.code === 'JOURNAL_UNAVAILABLE' && error.detail.name === 'SecurityError');
        await assert.rejects(journal.listUnfinished('alice'), { code: 'JOURNAL_UNAVAILABLE' });
        assert.equal(getterCalls, 2, 'A denied getter must not poison a cached opening promise');
        const explicitMissing = createEpisodeJournal({ indexedDB: null });
        await assert.rejects(explicitMissing.listUnfinished('alice'), { code: 'JOURNAL_UNAVAILABLE' });
        assert.equal(getterCalls, 2, 'Explicit missing storage must not fall back to the global getter');
        denied = false;
        await assert.rejects(journal.listUnfinished('alice'), { code: 'JOURNAL_UNAVAILABLE' });
        await assert.rejects(journal.listUnfinished('alice'), { code: 'JOURNAL_UNAVAILABLE' });
        assert.equal(openCalls, 2, 'Once acquired, denied open methods also remain retryable');
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
        else delete globalThis.indexedDB;
    }
});

// Deliberately a lifecycle fake, not a substitute for real browser IndexedDB integration tests.
function lifecycleFake({ writeThrows = false } = {}) {
    const transactions = [], db = { close() {}, transaction() {
        const tx = { objectStore() { return {
            get() { const r = {}; queueMicrotask(() => { r.result = undefined; r.onsuccess?.(); }); return r; },
            add() { if (writeThrows) throw Object.assign(new Error('injected quota'), { name: 'QuotaExceededError' }); },
        }; }, abort() { queueMicrotask(() => tx.onabort?.()); } };
        transactions.push(tx); return tx;
    } };
    return { transactions, indexedDB: { open() { const r = {}; queueMicrotask(() => { r.result = db; r.onsuccess?.(); }); return r; } } };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('fake IDB lifecycle: request success does not report persistence until transaction complete', async () => {
    const fake = lifecycleFake(), journal = createEpisodeJournal({ indexedDB: fake.indexedDB });
    let settled = false;
    const promise = journal.captureIntent(input()).then(value => { settled = true; return value; });
    await turn(); assert.equal(settled, false); assert.equal(fake.transactions.length, 1);
    fake.transactions[0].oncomplete();
    assert.equal((await promise).stage, 'captured'); assert.equal(settled, true);
});

test('fake IDB lifecycle: abort after request success and quota errors never report success', async () => {
    const fake = lifecycleFake(), journal = createEpisodeJournal({ indexedDB: fake.indexedDB });
    const promise = journal.captureIntent(input()), failure = assert.rejects(promise, { code: 'JOURNAL_UNAVAILABLE' });
    await turn(); fake.transactions[0].error = new Error('commit failed'); fake.transactions[0].onabort(); await failure;
    const quota = lifecycleFake({ writeThrows: true });
    await assert.rejects(createEpisodeJournal({ indexedDB: quota.indexedDB }).captureIntent(input()), error => error.code === 'JOURNAL_UNAVAILABLE' && error.detail.name === 'QuotaExceededError');
});

test('fake IDB lifecycle: a late open after close cannot revive a discarded connection', async () => {
    const requests = []; let closed = 0, transactions = 0;
    const journal = createEpisodeJournal({ indexedDB: { open() { const request = {}; requests.push(request); return request; } } });
    const pending = journal.captureIntent(input()), failure = assert.rejects(pending, { code: 'JOURNAL_UNAVAILABLE' });
    journal.close();
    requests[0].result = { close() { closed++; }, transaction() { transactions++; } };
    requests[0].onsuccess(); await failure;
    assert.equal(closed, 1); assert.equal(transactions, 0);
});

test('continue captures may stay in the same file and retain separate immutable creation/send IDs', () => {
    const raw = input(), creationOperationId = randomUUID();
    raw.action = 'continue'; raw.target.creationOperationId = creationOperationId; raw.source.locator = raw.target.locator;
    const captured = validateOperationCapture(raw);
    assert.equal(captured.operationId, raw.operationId); assert.equal(captured.target.creationOperationId, creationOperationId);
    let op = { ...captured, revision: 1, stage: 'captured' };
    op = transition(op, 'source-confirmed'); op = transition(op, 'continue-ready'); op = transition(op, 'created');
    assert.equal(op.stage, 'created');
    assert.throws(() => transition({ ...captured, revision: 2, stage: 'source-confirmed' }, 'create-armed', { initialFingerprint: 'a'.repeat(64) }), { code: 'INVALID_STAGE' });
    assert.throws(() => transition({ ...input(), revision: 2, stage: 'source-confirmed' }, 'continue-ready'), { code: 'INVALID_STAGE' });
    const confirmation = { state: 'confirmed', ownerAccount: raw.account, locator: raw.target.locator, episodeId: raw.target.episodeId,
        creationOperationId, expectedFingerprint: 'a'.repeat(64), observedFingerprint: 'a'.repeat(64), operationRevision: 8 };
    assert.equal(transition({ ...captured, stage: 'saving', revision: 8 }, 'confirmed', { confirmation }).stage, 'confirmed');
    assert.throws(() => transition({ ...captured, stage: 'saving', revision: 8 }, 'confirmed', { confirmation: { ...confirmation, creationOperationId: raw.operationId } }), { code: 'SAVE_UNCONFIRMED' });
});

test('setting a record aside needs a reason, never claims a save, and ends it', () => {
    const sent = { ...input(), stage: 'generated', revision: 6 };
    assert.throws(() => transition(sent, 'dismissed'), { code: 'INVALID_STAGE' });
    assert.throws(() => transition(sent, 'dismissed', { resolution: { kind: 'user' }, confirmation: { state: 'confirmed' } }), { code: 'INVALID_STAGE' });
    const dismissed = transition(sent, 'dismissed', { resolution: { kind: 'landed', evidence: 'reply-in-line' } });
    assert.equal(dismissed.stage, 'dismissed');
    assert.throws(() => transition(dismissed, 'saving'), { code: 'INVALID_STAGE' });
    assert.throws(() => transition({ ...input(), stage: 'awaiting-review', revision: 4 }, 'dismissed', { resolution: { kind: 'user' } }), { code: 'INVALID_STAGE' });
});
