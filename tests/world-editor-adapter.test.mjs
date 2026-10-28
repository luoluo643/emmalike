import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWorldEditorAdapter } from '../bridge-world-editor.js';
import { cloneJson } from '../src/episode-model.js';
import { WORLD_DECISION_ACK, hasWorldUserDecision, isBlockingWorldOperation, worldFingerprint } from '../src/world-editor-model.js';

function fixture(options = {}) {
    const initial = { entries: { 0: { uid: 0, content: 'old', comment: 'original', key: ['key'], unknown: { keep: 1 } } },
        originalData: { entries: [{ uid: 0, content: 'old', enabled: true }] }, unknown: { value: 'whole book' } };
    const files = new Map([['Book', cloneJson(initial)]]), caches = new Map([['Book', cloneJson(initial)]]), operations = new Map(), events = [];
    let queue = Promise.resolve(), writes = 0, active = true, observe = null, readCount = 0;
    const lease = { account: 'alice' };
    const journal = {
        async create(input) { if (options.journalFail) throw Object.assign(new Error('quota'), { code: 'WORLD_JOURNAL_UNAVAILABLE' }); const op = { ...cloneJson(input), stage: 'prepared', revision: 1 }; operations.set(op.operationId, op); return cloneJson(op); },
        async read(a, id) { const op = operations.get(id); return op?.account === a ? cloneJson(op) : null; },
        async update(op, patch) { if (options.failAfterWrite && patch.writeSettled === 'resolved') throw Object.assign(new Error('journal quota after write'), { code: 'WORLD_JOURNAL_UNAVAILABLE' }); assert.equal(operations.get(op.operationId).revision, op.revision); const next = { ...operations.get(op.operationId), ...cloneJson(patch), revision: op.revision + 1 }; operations.set(op.operationId, next); return cloneJson(next); },
        async decide(op, basis, acknowledgement, assertCurrent) {
            await options.beforeDecision?.({ files, caches, operations });
            if (options.decisionFailure) throw Object.assign(new Error('decision quota'), { code: 'WORLD_JOURNAL_UNAVAILABLE' });
            if (operations.get(op.operationId).revision !== op.revision) throw Object.assign(new Error('changed'), { code: 'WORLD_OPERATION_CHANGED' });
            assertCurrent();
            const next = { ...operations.get(op.operationId), revision: op.revision + 1, userDecision: { schemaVersion: 1, kind: 'user-resolved',
                account: op.account, name: op.name, operationId: op.operationId, operationRevision: op.revision, decidedAt: Date.now(), basis: cloneJson(basis), acknowledgement } };
            operations.set(op.operationId, next); await options.afterDecision?.({ files, caches, operations }); return cloneJson(next);
        },
        async unfinished(a) { return [...operations.values()].filter(x => x.account === a && (x.userDecision || isBlockingWorldOperation(x))).map(cloneJson); },
    };
    const d = { account: 'alice', journal, uuid: randomUUID,
        enqueue(fn) { const run = queue.then(fn); queue = run.catch(() => {}); return run; },
        makeLease: () => lease, assertLease(value) { if (!active || value !== lease) throw Object.assign(new Error('changed'), { code: 'ACCOUNT_CHANGED' }); }, verifyAccount: async () => {},
        listBooks: async () => [...files.keys()], readServerBook: async name => {
            readCount++; options.beforeRead?.({ files, caches, writes, readCount });
            if (options.readFailureAfterWrite && writes) throw new Error('read unavailable');
            return cloneJson(files.get(name) ?? { entries: {} });
        },
        cacheGet: name => caches.get(name), cacheSet: (name, data) => caches.set(name, data), cacheDelete: name => caches.delete(name),
        async saveNativeImmediate(name, data, lease, before) {
            try { await options.beforeNative?.({ files, caches }); before(); } catch (error) { error.nativeWriteStarted = false; throw error; }
            writes++; caches.set(name, cloneJson(data));
            if (options.accountSwitch) { active = false; throw new Error('account switch'); }
            if (!options.http500) files.set(name, cloneJson(data));
            if (options.newerNativeEdit) caches.get(name).entries[0].content = 'new native edit';
            if (options.lostResponse) throw new Error('lost response');
            events.push({ name, data: cloneJson(data), source: 'native' }); observe?.();
        },
        watchUpdates(name, handler) { observe = handler; return () => { observe = null; }; },
        async emitUpdated(name, data) { events.push({ name, data: cloneJson(data), source: 'adapter' }); await options.onCorrectiveEvent?.({ files, caches }); }, reloadEditor: async () => { await options.onReload?.({ files, caches }); }, refreshBookList: async () => {},
        describeSources: async () => ({ global: false, characters: [], currentChat: false, persona: false, otherReferences: 'unknown' }),
        createEntry(name, data) { let uid = 0; while (Object.hasOwn(data.entries, uid)) uid++; return data.entries[uid] = { uid, content: '', comment: '', key: [] }; },
        setOriginal(data, uid, key, value) { const entry = data.originalData?.entries.find(x => x.uid === uid); if (entry && key === 'content') entry.content = value; },
        deleteOriginal(data, uid) { if (data.originalData) data.originalData.entries = data.originalData.entries.filter(x => x.uid !== uid); },
    };
    const adapter = createWorldEditorAdapter(d);
    const input = patch => ({ account: 'alice', name: 'Book', uid: 0, baseEntry: cloneJson(initial.entries[0]), patch, draftRevision: 3 });
    return { adapter, d, initial, files, caches, operations, events, input, writes: () => writes };
}

test('native resolved plus OLD stays unknown with send gate and no automatic retry', async () => {
    const f = fixture({ http500: true }), result = await f.adapter.saveWorldEditorEntry(f.input({ content: 'mine' }));
    assert.equal(result.kind, 'unconfirmed'); assert.equal(result.runtimeState, 'unconfirmed'); assert.equal(f.writes(), 1);
    assert.deepEqual(f.files.get('Book'), f.initial); assert.equal(f.caches.get('Book').entries[0].content, 'mine');
    const recovered = await f.adapter.recoverWorldEditorWrite({ account: 'alice', operationId: result.operation.operationId });
    assert.equal(recovered.kind, 'unconfirmed'); assert.equal(f.writes(), 1); assert.equal(f.events.length, 1);
    assert.throws(() => f.adapter.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
    await assert.rejects(f.adapter.saveWorldEditorEntry(f.input({ content: 'next' })), { code: 'WORLD_OPERATION_PENDING' });
    await f.adapter.useWorldServerAuthority({ account: 'alice', name: 'Book' }); f.adapter.assertWorldRuntimeReady();
    assert.deepEqual(f.caches.get('Book'), f.initial); assert.equal(f.writes(), 1);
});

test('persisted lost response confirms by whole server data and supplies missing native update event', async () => {
    const f = fixture({ lostResponse: true }), result = await f.adapter.saveWorldEditorEntry(f.input({ content: 'mine' }));
    assert.equal(result.kind, 'confirmed'); assert.equal(result.entry.content, 'mine'); assert.equal(result.snapshot.originalData.entries[0].content, 'mine');
    assert.equal(result.draftRevision, 3); assert.equal(f.events.length, 1); assert.equal(f.events[0].source, 'adapter');
    assert.deepEqual(result.snapshot.unknown, f.initial.unknown);
});
for (const hook of ['onCorrectiveEvent', 'onReload']) {
    test(`fresh recovery confirms the file but keeps the runtime gate when ${hook} throws`, async () => {
        const options = { lostResponse: true, readFailureAfterWrite: true }, f = fixture(options);
        const unknown = await f.adapter.saveWorldEditorEntry(f.input({ content: 'confirmed server snapshot' }));
        assert.equal(unknown.kind, 'unconfirmed'); assert.equal(f.writes(), 1);
        options.readFailureAfterWrite = false;
        const syncError = `Synthetic ${hook} runtime-sync error`;
        options[hook] = () => { throw new Error(syncError); };
        const fresh = createWorldEditorAdapter(f.d);
        fresh.assertWorldRuntimeReady(); // Old journals alone do not dirty a new document.
        const recovered = await fresh.recoverWorldEditorWrite({ account: 'alice', operationId: unknown.operation.operationId });
        assert.equal(recovered.kind, 'confirmed'); assert.equal(recovered.operation.stage, 'confirmed');
        assert.equal(recovered.fingerprint, worldFingerprint(f.files.get('Book')));
        assert.equal(recovered.runtimeState, 'unconfirmed'); assert.equal(recovered.operation.runtimeState, 'unconfirmed');
        assert.equal(recovered.error, syncError); assert.equal(recovered.operation.error, syncError);
        assert.deepEqual(fresh.worldEditorRuntime(), { kind: 'dirty', names: ['Book'] });
        assert.throws(() => fresh.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
        assert.equal(f.writes(), 1); assert.equal(isBlockingWorldOperation(recovered.operation), false);
        options[hook] = undefined;
        const history = await fresh.recoverWorldEditorWrite({ account: 'alice', operationId: unknown.operation.operationId });
        assert.equal(history.kind, 'historical-observation'); assert.notEqual(history.runtimeState, 'ready');
        assert.throws(() => fresh.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
        const restored = await fresh.useWorldServerAuthority({ account: 'alice', name: 'Book' });
        assert.equal(restored.runtimeState, 'ready'); fresh.assertWorldRuntimeReady();
        assert.deepEqual(f.caches.get('Book'), f.files.get('Book')); assert.equal(f.writes(), 1);
        assert.equal(f.operations.get(unknown.operation.operationId).stage, 'confirmed');
    });
}
test('new entry unknown readback never reallocates a second UID or sends again', async () => {
    const f = fixture({ lostResponse: true, readFailureAfterWrite: true });
    const result = await f.adapter.saveWorldEditorEntry({ ...f.input({ content: 'new' }), uid: undefined });
    assert.equal(result.kind, 'unconfirmed'); assert.equal(result.runtimeState, 'unconfirmed'); assert.equal(Object.keys(f.files.get('Book').entries).length, 2);
    assert.equal(f.caches.get('Book').entries[1].content, 'new');
    assert.throws(() => f.adapter.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
    await f.adapter.saveWorldEditorEntry({ account: 'alice', name: 'Book', operationId: result.operation.operationId });
    assert.equal(f.writes(), 1); assert.equal(Object.keys(f.files.get('Book').entries).length, 2);
});
test('journal failure prevents save and new-entry allocation stays only in a cloned book', async () => {
    const f = fixture({ journalFail: true });
    await assert.rejects(f.adapter.saveWorldEditorEntry({ ...f.input({ content: 'new' }), uid: undefined }), { code: 'WORLD_JOURNAL_UNAVAILABLE' });
    assert.equal(f.writes(), 0); assert.deepEqual(f.files.get('Book'), f.initial); assert.deepEqual(f.caches.get('Book'), f.initial);
});
test('non-overlap merges latest server changes; overlap cannot silently overwrite', async () => {
    const f = fixture(); f.files.get('Book').entries[0].comment = 'external'; f.caches.set('Book', cloneJson(f.files.get('Book')));
    const result = await f.adapter.saveWorldEditorEntry(f.input({ content: 'mine' }));
    assert.equal(result.kind, 'confirmed'); assert.equal(result.entry.comment, 'external');
    const other = fixture(); other.files.get('Book').entries[0].content = 'external'; other.caches.set('Book', cloneJson(other.files.get('Book')));
    const conflict = await other.adapter.saveWorldEditorEntry(other.input({ content: 'mine' }));
    assert.equal(conflict.kind, 'conflict'); assert.equal(conflict.conflicts[0].key, 'content'); assert.equal(other.writes(), 0);
});
test('a newer native cache edit is not erased by post-failure reconciliation', async () => {
    const f = fixture({ http500: true, newerNativeEdit: true }), result = await f.adapter.saveWorldEditorEntry(f.input({ content: 'mine' }));
    assert.equal(result.kind, 'unconfirmed'); assert.equal(result.runtimeState, 'unconfirmed'); assert.equal(f.caches.get('Book').entries[0].content, 'new native edit');
    assert.throws(() => f.adapter.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
});
test('account invalidation after native write publishes no old-account result or cache correction', async () => {
    const f = fixture({ accountSwitch: true });
    await assert.rejects(f.adapter.saveWorldEditorEntry(f.input({ content: 'mine' })), { code: 'ACCOUNT_CHANGED' });
    assert.equal([...f.operations.values()][0].stage, 'armed'); assert.equal(f.events.length, 0);
});
test('copy saves one complete independent book without touching source or associations; lost response does not duplicate', async () => {
    const f = fixture({ lostResponse: true }), before = worldFingerprint(f.files.get('Book'));
    const result = await f.adapter.copyWorldEditorBook({ account: 'alice', name: 'Book', newName: 'Copy', expectedFingerprint: before });
    assert.equal(result.kind, 'confirmed'); assert.equal(result.name, 'Copy'); assert.equal(worldFingerprint(f.files.get('Book')), before);
    assert.deepEqual(f.files.get('Copy'), f.initial);
    await f.adapter.copyWorldEditorBook({ account: 'alice', operationId: result.operation.operationId }); assert.equal(f.writes(), 1);
    await assert.rejects(f.adapter.copyWorldEditorBook({ account: 'alice', name: 'Book', newName: 'copy' }), { code: 'WORLD_NAME_EXISTS' });
});
test('delete refuses revised entry and preserves all other book fields after confirmed removal', async () => {
    const f = fixture();
    await assert.rejects(f.adapter.deleteWorldEditorEntry({ account: 'alice', name: 'Book', uid: 0, baseEntry: { uid: 0 } }), { code: 'WORLD_CHANGED' });
    assert.equal(f.writes(), 0);
    const result = await f.adapter.deleteWorldEditorEntry({ account: 'alice', name: 'Book', uid: 0, baseEntry: f.initial.entries[0] });
    assert.equal(result.kind, 'confirmed'); assert.equal(result.entry, undefined); assert.deepEqual(result.snapshot.entries, {});
    assert.deepEqual(result.snapshot.unknown, f.initial.unknown); assert.deepEqual(result.snapshot.originalData.entries, []);
});

test('a durable armed record blocks a second submission when post-write journal update failed', async () => {
    const f = fixture({ failAfterWrite: true }), input = { ...f.input({ content: 'one new entry' }), uid: undefined };
    await assert.rejects(f.adapter.saveWorldEditorEntry(input), { code: 'WORLD_JOURNAL_UNAVAILABLE' });
    const op = [...f.operations.values()][0]; assert.equal(op.stage, 'armed');
    await assert.rejects(f.adapter.saveWorldEditorEntry(input), { code: 'WORLD_OPERATION_PENDING' });
    assert.equal(f.writes(), 1); assert.equal(Object.keys(f.files.get('Book').entries).length, 2);
    const result = await f.adapter.recoverWorldEditorWrite({ account: 'alice', operationId: op.operationId });
    assert.equal(result.kind, 'confirmed'); assert.equal(f.writes(), 1);
});

test('pre-arm external change aborts without write and records a known not-submitted operation', async () => {
    let changed = false;
    const f = fixture({ beforeRead({ files, caches, readCount }) { if (readCount === 2 && !changed) { changed = true; files.get('Book').entries[0].comment = 'external'; caches.set('Book', cloneJson(files.get('Book'))); } } });
    const result = await f.adapter.saveWorldEditorEntry(f.input({ content: 'mine' }));
    assert.equal(result.kind, 'not-submitted'); assert.equal(result.operation.writeSettled, 'not-started'); assert.equal(f.writes(), 0);
    assert.equal((await f.adapter.recoverWorldEditorWrite({ account: 'alice', operationId: result.operation.operationId })).kind, 'not-submitted');
    assert.equal((await f.adapter.saveWorldEditorEntry(f.input({ content: 'mine' }))).kind, 'confirmed'); assert.equal(f.writes(), 1);
});

test('new worldbook rejects name collisions and missing write is not falsely confirmed as an empty book', async () => {
    const f = fixture({ http500: true });
    await assert.rejects(f.adapter.createWorldEditorBook({ account: 'alice', name: 'book' }), { code: 'WORLD_NAME_EXISTS' });
    const result = await f.adapter.createWorldEditorBook({ account: 'alice', name: 'Blank' });
    assert.equal(result.kind, 'unconfirmed'); assert.equal(result.runtimeState, 'unconfirmed'); assert.equal(f.files.has('Blank'), false); assert.equal(f.caches.has('Blank'), true);
    const healthy = fixture(), saved = await healthy.adapter.createWorldEditorBook({ account: 'alice', name: 'Blank' });
    assert.equal(saved.kind, 'confirmed'); assert.deepEqual(healthy.files.get('Blank'), { entries: {} });
});

test('split-key operation preserves regex, constant entries and unknown fields, and rejects stale whole-book baseline', async () => {
    const f = fixture(); f.files.get('Book').entries[0].key = ['甲，乙', '/甲,乙/i'];
    f.files.get('Book').entries[1] = { uid: 1, constant: true, key: ['丙，丁'] }; f.caches.set('Book', cloneJson(f.files.get('Book')));
    await assert.rejects(f.adapter.splitWorldEditorKeys({ account: 'alice', name: 'Book', expectedFingerprint: worldFingerprint(f.initial) }), { code: 'WORLD_CHANGED' });
    const result = await f.adapter.splitWorldEditorKeys({ account: 'alice', name: 'Book', expectedFingerprint: worldFingerprint(f.files.get('Book')) });
    assert.equal(result.kind, 'confirmed'); assert.equal(result.changedCount, 1); assert.equal(f.writes(), 1);
    assert.deepEqual(result.snapshot.entries[0].key, ['甲', '乙', '/甲,乙/i']); assert.deepEqual(result.snapshot.entries[1].key, ['丙，丁']); assert.deepEqual(result.snapshot.unknown, f.initial.unknown);
});

test('late cache edit during final idle wait prevents native call and leaves a retryable no-call record', async () => {
    let release, reached; const gate = new Promise(r => { release = r; }), held = new Promise(r => { reached = r; });
    const f = fixture({ beforeNative: async () => { reached(); await gate; } });
    const run = f.adapter.saveWorldEditorEntry(f.input({ content: 'mine' })); await held;
    f.caches.get('Book').entries[0].content = 'new original edit'; release();
    const result = await run;
    assert.equal(f.writes(), 0); assert.equal(result.kind, 'not-submitted'); assert.equal(result.operation.writeSettled, 'not-started');
    assert.equal(f.caches.get('Book').entries[0].content, 'new original edit'); assert.deepEqual(f.files.get('Book'), f.initial);
    assert.equal((await f.adapter.worldEditorUnfinished()).length, 0); f.adapter.assertWorldRuntimeReady();
    await assert.rejects(f.adapter.saveWorldEditorEntry(f.input({ content: 'again' })), { code: 'WORLD_RUNTIME_CONFLICT' });
    assert.equal(f.writes(), 0);
});
for (const hook of ['onCorrectiveEvent', 'onReload']) test(`new cache mutation inside ${hook} cannot be declared runtime ready`, async () => {
    const f = fixture({ lostResponse: true, [hook]: ({ caches }) => { caches.get('Book').entries[0].content = 'listener new edit'; } });
    const result = await f.adapter.saveWorldEditorEntry(f.input({ content: 'phantom' }));
    assert.equal(result.kind, 'confirmed'); assert.equal(result.runtimeState, 'conflict');
    assert.equal(f.caches.get('Book').entries[0].content, 'listener new edit');
    assert.throws(() => f.adapter.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
    assert.equal(f.files.get('Book').entries[0].content, 'phantom');
});
test('IDB unavailable refuses edits with zero native saves but ordinary synchronous generation gate stays open', async () => {
    const f = fixture({ journalFail: true }); f.d.journal.unfinished = async () => { throw new Error('IDB disabled'); };
    f.adapter.assertWorldRuntimeReady();
    await assert.rejects(f.adapter.saveWorldEditorEntry(f.input({ content: 'phantom' })), /IDB disabled/);
    assert.equal(f.writes(), 0); f.adapter.assertWorldRuntimeReady();
});
test('fresh document ignores old unknown journal for generation; no expected snapshot is hydrated into cache', async () => {
    const f = fixture(); f.operations.set('old', { account: 'alice', name: 'Book', stage: 'unconfirmed', runtimeState: 'unconfirmed' });
    f.adapter.assertWorldRuntimeReady(); assert.deepEqual(f.caches.get('Book'), f.initial);
});
test('server-authority unlock uses actual server, does not save, and does not rely on IDB', async () => {
    const options = { lostResponse: true, readFailureAfterWrite: true }, f = fixture(options);
    await f.adapter.saveWorldEditorEntry(f.input({ content: 'persisted' }));
    assert.throws(() => f.adapter.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
    options.readFailureAfterWrite = false; f.d.journal.unfinished = async () => { throw new Error('IDB now disabled'); };
    const result = await f.adapter.useWorldServerAuthority({ account: 'alice', name: 'Book' });
    assert.equal(result.kind, 'ready'); assert.equal(result.snapshot.entries[0].content, 'persisted'); assert.equal(f.writes(), 1);
    f.adapter.assertWorldRuntimeReady();
});
test('server-authority does not release another book dirty gate', async () => {
    const options = { lostResponse: true, readFailureAfterWrite: true }, f = fixture(options);
    await f.adapter.createWorldEditorBook({ account: 'alice', name: 'New' });
    options.readFailureAfterWrite = false;
    await f.adapter.useWorldServerAuthority({ account: 'alice', name: 'Book' });
    assert.throws(() => f.adapter.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
    assert.deepEqual(f.adapter.worldEditorRuntime().names, ['New']);
    await f.adapter.useWorldServerAuthority({ account: 'alice', name: 'New' }); f.adapter.assertWorldRuntimeReady();
});
test('native queue remains held until pending save actually settles; late write is then read back', async () => {
    let release, started; const wait = new Promise(r => { release = r; }), entered = new Promise(r => { started = r; });
    const f = fixture(), original = f.d.saveNativeImmediate;
    f.d.saveNativeImmediate = async (name, data, lease, before) => { before(); started(); await wait; return original(name, data, lease, () => {}); };
    const save = f.adapter.saveWorldEditorEntry(f.input({ content: 'late commit' })); await entered;
    assert.throws(() => f.adapter.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
    let unlocked = false; const unlock = f.adapter.useWorldServerAuthority({ account: 'alice', name: 'Book' }).then(x => { unlocked = true; return x; });
    await new Promise(r => setTimeout(r, 10)); assert.equal(unlocked, false); assert.equal(f.writes(), 0);
    release(); assert.equal((await save).kind, 'confirmed'); await unlock; f.adapter.assertWorldRuntimeReady();
    assert.equal(f.writes(), 1); assert.equal(f.caches.get('Book').entries[0].content, 'late commit');
});

function unknown(f, id = 'old-request') {
    const expectedBook = cloneJson(f.initial); expectedBook.entries[0].content = 'LATE'; expectedBook.originalData.entries[0].content = 'LATE';
    const op = { account: 'alice', name: 'Book', operationId: id, revision: 2, stage: 'armed', runtimeState: 'saving', action: 'entry-edit', uid: 0,
        draftRevision: 1, baseFingerprint: worldFingerprint(f.initial), baseCacheFingerprint: worldFingerprint(f.initial), expectedBook, expectedFingerprint: worldFingerprint(expectedBook) };
    f.operations.set(id, op); return op;
}
async function decide(f, op) {
    const preview = await f.adapter.prepareWorldOperationDecision({ account: 'alice', operationId: op.operationId });
    return f.adapter.resolveWorldOperation({ ...preview, acknowledgement: WORLD_DECISION_ACK });
}
test('unknown OLD never becomes not-saved; durable decision permits a new write without resending old request', async () => {
    const f = fixture(), op = unknown(f);
    const first = await f.adapter.recoverWorldEditorWrite({ account: 'alice', operationId: op.operationId });
    assert.equal(first.kind, 'unconfirmed'); assert.equal(f.writes(), 0); f.adapter.assertWorldRuntimeReady();
    await assert.rejects(f.adapter.saveWorldEditorEntry(f.input({ content: 'NEW' })), { code: 'WORLD_OPERATION_PENDING' });
    const resolved = await decide(f, op); assert.equal(resolved.kind, 'user-resolved'); assert.equal(resolved.operation.stage, 'unconfirmed');
    assert.ok(hasWorldUserDecision(resolved.operation)); assert.equal(f.writes(), 0);
    assert.equal((await f.adapter.worldEditorUnfinished()).length, 1);
    assert.equal((await f.adapter.saveWorldEditorEntry(f.input({ content: 'NEW' }))).kind, 'confirmed'); assert.equal(f.writes(), 1);
});
test('decision failures and stale previews preserve save blocking; only one operation is decided', async () => {
    const options = { decisionFailure: true }, f = fixture(options), op = unknown(f);
    await assert.rejects(decide(f, op), { code: 'WORLD_JOURNAL_UNAVAILABLE' });
    await assert.rejects(f.adapter.saveWorldEditorEntry(f.input({ content: 'NEW' })), { code: 'WORLD_OPERATION_PENDING' }); assert.equal(f.writes(), 0);
    options.decisionFailure = false;
    const preview = await f.adapter.prepareWorldOperationDecision({ account: 'alice', operationId: op.operationId });
    f.files.get('Book').entries[0].content = 'changed';
    await assert.rejects(f.adapter.resolveWorldOperation({ ...preview, acknowledgement: WORLD_DECISION_ACK }), { code: 'WORLD_SERVER_CHANGED' });
    f.files.set('Book', cloneJson(f.initial));
    unknown(f, 'another-old'); const resolved = await decide(f, op); assert.equal(resolved.remainingBlocking, 1);
    await assert.rejects(f.adapter.saveWorldEditorEntry(f.input({ content: 'NEW' })), { code: 'WORLD_OPERATION_PENDING' });
});
test('decision CAS and cache mutations before/after persistence do not silently unlock editing or sending', async () => {
    const f = fixture({ beforeDecision: ({ operations }) => { operations.get('old-request').revision++; } }), op = unknown(f);
    await assert.rejects(decide(f, op), { code: 'WORLD_OPERATION_CHANGED' });
    await assert.rejects(f.adapter.saveWorldEditorEntry(f.input({ content: 'NEW' })), { code: 'WORLD_OPERATION_PENDING' });
    for (const hook of ['beforeDecision', 'afterDecision']) {
        const other = fixture({ [hook]: ({ caches }) => { caches.get('Book').entries[0].content = 'new native input'; } }), old = unknown(other);
        await assert.rejects(decide(other, old), { code: 'WORLD_RUNTIME_CONFLICT' });
        assert.equal(other.caches.get('Book').entries[0].content, 'new native input'); assert.equal(other.writes(), 0);
        assert.throws(() => other.adapter.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
        assert.equal(hasWorldUserDecision(other.operations.get(old.operationId)), hook === 'afterDecision');
    }
});
test('late delivery between decision and first save conflicts even when cache is absent, with zero new writes', async () => {
    const f = fixture(), op = unknown(f); await decide(f, op);
    f.files.set('Book', cloneJson(op.expectedBook)); f.caches.delete('Book');
    await assert.rejects(f.adapter.saveWorldEditorEntry(f.input({ content: 'NEW' })), { code: 'WORLD_SERVER_CHANGED' });
    assert.equal(f.writes(), 0); assert.equal(f.files.get('Book').entries[0].content, 'LATE');
    assert.throws(() => f.adapter.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
});
test('historical decision observation preserves newer cache, gates known divergence, and never reinstates pending', async () => {
    const f = fixture(), op = unknown(f); await decide(f, op);
    await f.adapter.saveWorldEditorEntry(f.input({ content: 'NEW' }));
    f.files.set('Book', cloneJson(op.expectedBook)); const events = f.events.length;
    const observed = await f.adapter.recoverWorldEditorWrite({ account: 'alice', operationId: op.operationId });
    assert.equal(observed.kind, 'historical-observation'); assert.equal(observed.observation.kind, 'matches-submitted'); assert.equal(observed.operation.stage, 'confirmed');
    assert.equal(f.caches.get('Book').entries[0].content, 'NEW'); assert.equal(f.events.length, events); assert.equal(f.writes(), 1);
    assert.throws(() => f.adapter.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
    await f.adapter.useWorldServerAuthority({ account: 'alice', name: 'Book' }); f.adapter.assertWorldRuntimeReady();
    assert.equal(f.caches.get('Book').entries[0].content, 'LATE'); assert.equal(f.writes(), 1);
});
test('historical read never overwrites a newer intentional return to OLD or releases another dirty book', async () => {
    const options = { lostResponse: true, readFailureAfterWrite: true }, f = fixture(options), op = unknown(f);
    await decide(f, op); await f.adapter.createWorldEditorBook({ account: 'alice', name: 'Other' }); options.readFailureAfterWrite = false;
    f.files.set('Book', cloneJson(op.expectedBook)); f.caches.set('Book', cloneJson(f.initial)); const events = f.events.length;
    await f.adapter.recoverWorldEditorWrite({ account: 'alice', operationId: op.operationId });
    assert.deepEqual(f.caches.get('Book'), f.initial); assert.equal(f.events.length, events); assert.ok(f.adapter.worldEditorRuntime().names.includes('Other'));
});
test('retain-mine preparation keeps send gate through abandonment and failed save, then a new confirmed save releases it', async () => {
    const options = {}, f = fixture(options), op = unknown(f); await decide(f, op);
    await f.adapter.saveWorldEditorEntry(f.input({ content: 'NEW' })); f.files.set('Book', cloneJson(op.expectedBook));
    await f.adapter.recoverWorldEditorWrite({ account: 'alice', operationId: op.operationId });
    const draft = await f.adapter.prepareWorldEditorResave({ account: 'alice', name: 'Book' });
    assert.equal(draft.kind, 'resave-draft'); assert.equal(f.writes(), 1); assert.equal(draft.snapshot.entries[0].content, 'LATE');
    assert.throws(() => f.adapter.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
    await f.adapter.worldEditorBook('Book'); assert.throws(() => f.adapter.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
    options.http500 = true;
    const failed = await f.adapter.saveWorldEditorEntry({ ...f.input({ content: 'NEW' }), baseEntry: draft.snapshot.entries[0] });
    assert.equal(failed.kind, 'unconfirmed'); assert.notEqual(failed.runtimeState, 'ready'); assert.throws(() => f.adapter.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
    options.http500 = false;
    await f.adapter.recoverWorldEditorWrite({ account: 'alice', operationId: failed.operation.operationId });
    assert.equal(failed.retryAllowed, false); assert.equal(failed.operation.userDecision, undefined);
    await assert.rejects(f.adapter.saveWorldEditorEntry(f.input({ content: 'NEW' })), { code: 'WORLD_OPERATION_PENDING' });
    await decide(f, failed.operation); await f.adapter.prepareWorldEditorResave({ account: 'alice', name: 'Book' });
    assert.throws(() => f.adapter.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
    const saved = await f.adapter.saveWorldEditorEntry({ ...f.input({ content: 'NEW' }), baseEntry: draft.snapshot.entries[0] });
    assert.equal(saved.kind, 'confirmed'); f.adapter.assertWorldRuntimeReady(); assert.equal(f.files.get('Book').entries[0].content, 'NEW');
});
test('recovering an already confirmed save cannot adopt a different server version or unlock the send gate', async () => {
    const f = fixture(), saved = await f.adapter.saveWorldEditorEntry(f.input({ content: 'NEW' }));
    f.files.get('Book').entries[0].content = 'LATE'; await f.adapter.worldEditorBook('Book'); const events = f.events.length;
    const result = await f.adapter.recoverWorldEditorWrite({ account: 'alice', operationId: saved.operation.operationId });
    assert.equal(result.kind, 'historical-observation'); assert.equal(result.runtimeState, 'conflict'); assert.equal(f.caches.get('Book').entries[0].content, 'NEW');
    assert.equal(f.events.length, events); assert.equal(f.writes(), 1); assert.throws(() => f.adapter.assertWorldRuntimeReady(), { code: 'WORLD_RUNTIME_UNCONFIRMED' });
});
test('confirmed save with runtime conflict is not an unknown-write lock after explicit server authority', async () => {
    const options = { newerNativeEdit: true }, f = fixture(options);
    const saved = await f.adapter.saveWorldEditorEntry(f.input({ content: 'NEW' }));
    assert.equal(saved.kind, 'confirmed'); assert.equal(saved.runtimeState, 'conflict');
    await f.adapter.useWorldServerAuthority({ account: 'alice', name: 'Book' }); options.newerNativeEdit = false;
    const current = f.files.get('Book').entries[0];
    const next = await f.adapter.saveWorldEditorEntry({ ...f.input({ content: 'NEXT' }), baseEntry: current });
    assert.equal(next.kind, 'confirmed'); assert.equal(f.writes(), 2); f.adapter.assertWorldRuntimeReady();
});
for (const branch of ['failed-readback', 'never-called']) test(`account switch during ${branch} journal commit publishes no old-account result`, async () => {
    const f = fixture(branch === 'failed-readback' ? { lostResponse: true, readFailureAfterWrite: true }
        : { beforeNative: ({ caches }) => { caches.get('Book').entries[0].content = 'new original edit'; } });
    let invalid = false; const assertLease = f.d.assertLease, update = f.d.journal.update;
    f.d.assertLease = lease => { if (invalid) throw Object.assign(new Error('changed'), { code: 'ACCOUNT_CHANGED' }); assertLease(lease); };
    f.d.journal.update = async (op, patch) => { const result = await update(op, patch);
        if (branch === 'failed-readback' ? patch.stage === 'unconfirmed' : patch.writeSettled === 'not-started') invalid = true;
        return result;
    };
    await assert.rejects(f.adapter.saveWorldEditorEntry(f.input({ content: 'mine' })), { code: 'ACCOUNT_CHANGED' });
    assert.equal(f.writes(), branch === 'failed-readback' ? 1 : 0);
});
