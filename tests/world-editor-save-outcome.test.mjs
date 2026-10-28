import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWorldEditorAdapter } from '../bridge-world-editor.js';
import { cloneJson } from '../src/episode-model.js';
import { isBlockingWorldOperation, normalizeWorldOperation } from '../src/world-editor-model.js';

// Failure injection is confined to this fixture; HTTP/Promise results are never used as proof.
function fixture(fault = '') {
    const original = { entries: { 0: { uid: 0, content: 'OLD', key: [] } } }, records = new Map();
    let disk = cloneJson(original), cache = cloneJson(original), writes = 0, reads = 0, active = true, activeFault = fault, queue = Promise.resolve();
    const lease = { account: 'alice' };
    const journal = {
        async create(input) { const op = { ...cloneJson(input), stage: 'prepared', revision: 1 }; records.set(op.operationId, op); if (activeFault === 'account-after-create') active = false; return cloneJson(op); },
        async read(account, id) { const op = records.get(id); return op?.account === account ? normalizeWorldOperation(cloneJson(op)) : null; },
        async update(op, patch) {
            if (activeFault === 'armed-journal' && patch.stage === 'armed') { activeFault = ''; throw new Error('arm transaction failed'); }
            if (activeFault === 'receipt-journal' && patch.stage === 'not-submitted') throw new Error('receipt transaction failed');
            assert.equal(records.get(op.operationId)?.revision, op.revision);
            const next = { ...records.get(op.operationId), ...cloneJson(patch), revision: op.revision + 1 }; records.set(op.operationId, next);
            if (activeFault === 'account-after-arm' && patch.stage === 'armed' || activeFault === 'account-after-receipt' && patch.stage === 'not-submitted') active = false;
            return cloneJson(next);
        },
        async unfinished(account) { return [...records.values()].map(normalizeWorldOperation).filter(op => op.account === account && isBlockingWorldOperation(op)).map(cloneJson); },
    };
    const d = { account: 'alice', journal, uuid: randomUUID,
        enqueue(fn) { const run = queue.then(fn); queue = run.catch(() => {}); return run; },
        makeLease: () => lease, assertLease(value) { if (!active || value !== lease) throw Object.assign(new Error('Old document'), { code: 'ACCOUNT_CHANGED' }); }, verifyAccount: async () => {},
        listBooks: async () => ['Book'], async readServerBook() { reads++; if (activeFault === 'account-after-read' && reads === 2) active = false; if (activeFault === 'second-read' && reads === 2) throw new Error('read failed before dispatch'); return cloneJson(disk); },
        cacheGet: () => cache, cacheSet: (name, value) => { cache = cloneJson(value); }, cacheDelete: () => { cache = undefined; },
        watchUpdates() { if (['watch', 'receipt-journal', 'account-after-receipt'].includes(activeFault)) throw new Error('watch failed before dispatch'); return () => {}; },
        async saveNativeImmediate(name, value, passedLease, before) {
            if (activeFault === 'idle') throw Object.assign(new Error('idle failed'), { nativeWriteStarted: false });
            if (activeFault === 'account-idle') { active = false; throw Object.assign(new Error('Old document'), { code: 'ACCOUNT_CHANGED', nativeWriteStarted: false }); }
            before(); writes++; cache = cloneJson(value);
            if (!['native-resolved-old', 'native-rejected-old'].includes(activeFault)) disk = cloneJson(value);
            if (activeFault === 'native-rejected-old') throw Object.assign(new Error('fetch failed after invocation'), { nativeWriteStarted: true });
        }, emitUpdated: async () => {}, reloadEditor: async () => {}, refreshBookList: async () => {}, describeSources: async () => ({}), setOriginal() {},
    };
    const api = createWorldEditorAdapter(d), input = () => ({ account: 'alice', name: 'Book', uid: 0, baseEntry: original.entries[0], patch: { content: 'NEW' }, draftRevision: 1 });
    return { api, journal, records, input, clearFault: () => { activeFault = ''; }, writes: () => writes, cache: () => cache, disk: () => disk };
}

for (const fault of ['callback', 'second-read', 'armed-journal', 'watch', 'idle']) test(`current ${fault} failure commits zero-call terminal receipt and permits a new explicit save`, async () => {
    const f = fixture(fault), input = f.input();
    if (fault === 'callback') input.onPrepared = () => { throw new Error('capture UI callback failed'); };
    const result = await f.api.saveWorldEditorEntry(input);
    assert.equal(result.kind, 'not-submitted'); assert.equal(result.operation.writeSettled, 'not-started'); assert.equal(result.operation.outcomeVersion, 2);
    assert.equal(f.writes(), 0); assert.equal((await f.journal.unfinished('alice')).length, 0); assert.equal(f.cache().entries[0].content, 'OLD');
    assert.equal((await f.api.recoverWorldEditorWrite({ account: 'alice', operationId: result.operation.operationId })).kind, 'not-submitted');
    f.clearFault(); assert.equal((await f.api.saveWorldEditorEntry(f.input())).kind, 'confirmed'); assert.equal(f.writes(), 1);
});

for (const fault of ['account-after-create', 'account-after-read', 'account-after-arm', 'account-idle', 'account-after-receipt']) test(`${fault} records only old-identity zero-call fact and still rejects old-page result`, async () => {
    const f = fixture(fault), input = f.input(); let prepared = false; input.onPrepared = () => { prepared = true; };
    await assert.rejects(f.api.saveWorldEditorEntry(input), { code: 'ACCOUNT_CHANGED' });
    const op = [...f.records.values()][0];
    assert.equal(op.account, 'alice'); assert.equal(op.stage, 'not-submitted'); assert.equal(op.writeSettled, 'not-started'); assert.equal(op.outcomeVersion, 2);
    assert.equal(f.writes(), 0); assert.equal(f.cache().entries[0].content, 'OLD'); assert.equal(f.disk().entries[0].content, 'OLD');
    assert.equal((await f.journal.unfinished('alice')).length, 0);
    if (fault === 'account-after-create') assert.equal(prepared, false);
});

test('failure to persist the zero-call receipt keeps identity and provisional pending without inferring proof on reload', async () => {
    const f = fixture('receipt-journal'); let identity;
    await assert.rejects(f.api.saveWorldEditorEntry(f.input()), error => { identity = error.detail?.operation; return !!identity && error.message === 'receipt transaction failed'; });
    assert.equal(f.writes(), 0); assert.equal(f.records.get(identity.operationId).stage, 'armed');
    f.clearFault(); const recovered = await f.api.recoverWorldEditorWrite({ account: 'alice', operationId: identity.operationId });
    assert.equal(recovered.kind, 'unconfirmed'); assert.equal(recovered.operation.writeSettled, undefined); assert.equal(f.writes(), 0);
    await assert.rejects(f.api.saveWorldEditorEntry(f.input()), { code: 'WORLD_OPERATION_PENDING' });
});

for (const fault of ['native-resolved-old', 'native-rejected-old']) test(`${fault} cannot manufacture not-submitted; full late readback alone confirms without resending`, async () => {
    const f = fixture(fault), result = await f.api.saveWorldEditorEntry(f.input());
    assert.equal(result.kind, 'unconfirmed'); assert.equal(result.runtimeState, 'unconfirmed'); assert.equal(result.retryAllowed, false);
    assert.equal(f.writes(), 1); assert.equal(f.disk().entries[0].content, 'OLD'); assert.equal(f.cache().entries[0].content, 'NEW');
    assert.throws(() => f.api.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
    await f.api.recoverWorldEditorWrite({ account: 'alice', operationId: result.operation.operationId });
    assert.throws(() => f.api.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
    Object.assign(f.disk(), cloneJson(result.operation.expectedBook));
    const late = await f.api.recoverWorldEditorWrite({ account: 'alice', operationId: result.operation.operationId });
    assert.equal(late.kind, 'confirmed'); assert.equal(late.runtimeState, 'ready'); assert.equal(f.writes(), 1); f.api.assertWorldRuntimeReady();
});

for (const legacy of [
    { stage: 'prepared' }, { stage: 'armed', writeSettled: 'not-started' },
    { stage: 'not-saved', writeSettled: 'resolved', runtimeState: 'ready', retryAllowed: true },
    { stage: 'not-submitted', outcomeVersion: 2, runtimeState: 'ready' },
]) test(`old ${JSON.stringify(legacy)} cannot prove the request was never dispatched`, async () => {
    const f = fixture('callback'), input = f.input(); input.onPrepared = () => { throw new Error('capture only'); };
    const captured = await f.api.saveWorldEditorEntry(input), raw = f.records.get(captured.operation.operationId);
    delete raw.writeSettled; delete raw.outcomeVersion; Object.assign(raw, legacy);
    assert.ok(isBlockingWorldOperation(raw));
    const result = await f.api.recoverWorldEditorWrite({ account: 'alice', operationId: raw.operationId });
    assert.equal(result.kind, 'unconfirmed'); assert.equal(result.runtimeState, 'ready'); assert.equal(f.writes(), 0);
    // A clean document/cache is not dirtied just by historical uncertainty; saving remains blocked.
    f.api.assertWorldRuntimeReady(); await assert.rejects(f.api.saveWorldEditorEntry(f.input()), { code: 'WORLD_OPERATION_PENDING' });
});
