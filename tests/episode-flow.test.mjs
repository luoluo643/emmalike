import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createEpisodeFlow, unsavedBeyondOpening } from '../bridge-episode-flow.js';
import { EPISODE_NAMESPACE as NS, canonicalChat, cloneJson, fingerprintChat, sameLocator, sameOperationIdentity, findCreation, resolveSourceIdentity, buildEpisodeFile, creationIdFor } from '../src/episode-model.js';
import { validateOperationCapture, applyOperationTransition } from '../src/episode-journal.js';

const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(options = {}) {
    const account = 'alice', rootId = randomUUID();
    const source = { locator: { account, avatar: 'a.png', file: 'root' }, header: { user_name: 'unused', chat_metadata: options.legacy ? {} : { integrity: rootId } }, messages: [{ mes: 'parent history', extra: { value: 'root' } }] };
    source.fingerprint = await fingerprintChat(source);
    const files = new Map([['root', cloneJson(source)]]), operations = new Map(), calls = [], transitionCalls = [], switches = [], updates = [];
    let current = cloneJson(source), queue = Promise.resolve(), active = true, draftRevision = 4, text = 'author request', saveCalls = 0;
    const lease = { account }, submitted = gate(), acceptedFailure = gate(), verifyEntered = gate(), isolation = [];
    const copyFile = async file => { const copy = cloneJson(file); copy.fingerprint = await fingerprintChat(copy); return copy; };
    const journal = {
        async captureIntent(input) { const op = { ...validateOperationCapture(input), revision: 1, stage: 'captured' }; operations.set(op.operationId, op); return cloneJson(op); },
        async readOperation(a, id) { return a === account && operations.has(id) ? cloneJson(operations.get(id)) : null; },
        async transition(input) {
            transitionCalls.push(cloneJson(input));
            if (options.failAccepted && input.patch.stage === 'accepted') { acceptedFailure.release(); throw Object.assign(new Error('accepted journal injected failure'), { code: 'JOURNAL_UNAVAILABLE' }); }
            const op = applyOperationTransition(operations.get(input.operationId), input, 123);
            operations.set(op.operationId, op); return cloneJson(op);
        },
        async listUnfinished(a) { return a === account ? [...operations.values()].filter(x => !['confirmed', 'cancelled', 'dismissed'].includes(x.stage)).map(cloneJson) : []; },
        async writeDraft() { throw new Error('Reader draft must never be overwritten by flow'); },
        async readDraft() { throw new Error('Reader draftRevision is not an IDB revision'); },
        async clearDraftIfRevision() { throw new Error('Reader owns conditional draft cleanup'); },
    };
    const entries = () => [...files.values()].map(file => ({ locator: file.locator, metadata: file.header.chat_metadata ?? {}, fullFile: cloneJson(file) }));
    const native = {
        async readFullChat(locator) { const file = files.get(locator.file); return file ? { kind: 'present', file: await copyFile(file) } : { kind: 'missing-or-unreadable' }; },
        async listChatHeaders() { return { complete: true, entries: entries() }; },
        async resolveRoot({ source, newRootId }) { return resolveSourceIdentity(source, entries(), { newRootId }); },
        async createOrRecoverTarget({ operationId, initialFile, assertIntentCurrent }) {
            assertIntentCurrent?.(); if (options.createGate) await options.createGate.promise; assertIntentCurrent?.();
            let op = operations.get(operationId);
            op = await journal.transition({ account, operationId, expectedRevision: op.revision, expectedStage: op.stage, patch: { stage: 'create-armed', initialFingerprint: (await fingerprintChat(initialFile)).hash } });
            files.set(initialFile.locator.file, await copyFile(initialFile)); calls.push('create');
            op = await journal.transition({ account, operationId, expectedRevision: op.revision, expectedStage: op.stage, patch: { stage: 'created' } });
            return { kind: 'created', operation: op, creationEvidence: { initialContent: 'confirmed' } };
        },
        async recoverTarget({ operationId }) {
            const op = cloneJson(operations.get(operationId)), found = findCreation(entries(), op);
            return found.kind === 'unique' ? { kind: 'recovered', operation: op, file: await copyFile(files.get(found.candidate.locator.file)) } : { kind: found.kind, operation: op };
        },
        async confirmTarget({ operationId, locator, expectedFingerprint }) {
            const op = cloneJson(operations.get(operationId)), file = await copyFile(files.get(locator.file));
            if (!sameOperationIdentity(file.header.chat_metadata[NS], op) || file.fingerprint.hash !== expectedFingerprint) return { kind: 'unconfirmed', operation: op, file };
            return { kind: 'confirmed', operation: op, file, confirmation: { state: 'confirmed', ownerAccount: account, locator, episodeId: op.target.episodeId,
                creationOperationId: creationIdFor(op), expectedFingerprint, observedFingerprint: file.fingerprint.hash, operationRevision: op.revision - (options.staleConfirmation ? 1 : 0) } };
        },
    };
    const d = { account, journal, native, uuid: randomUUID, ...(options.snapshotBytes !== undefined ? { snapshotBytes: options.snapshotBytes } : {}),
        enqueue(action) { const run = queue.then(action); queue = run.catch(() => {}); return run; },
        makeLease: () => lease,
        assertLease(l) { if (l !== lease || !active) throw Object.assign(new Error('lease replaced'), { code: 'ENGINE_REPLACED' }); },
        status: () => ({ enabled: true, verified: true, configurationId: 'unit-flow', contextModes: ['continued', 'fresh'], continuedMetadataKeys: [], reasons: [] }),
        waitStable: async () => {}, currentLocator: () => current.locator, currentMetadata: () => current.header.chat_metadata,
        currentFull: () => cloneJson(current), currentLength: () => current.messages.length,
        async assertSourceCurrent(op) {
            if (!sameLocator(current.locator, op.source.locator) || (await fingerprintChat(current)).hash !== op.sourceFingerprint) throw Object.assign(new Error('source changed'), { code: options.unsavedOpen ? 'SOURCE_UNCONFIRMED' : 'SOURCE_CHANGED' });
        },
        ...(options.unsavedOpen ? { async saveCurrent() { saveCalls++; files.set(current.locator.file, await copyFile(current)); } } : {}),
        async switchChat(locator) {
            switches.push(cloneJson(locator));
            current = cloneJson(files.get(locator.file));
            if (!current.messages.length) { current.messages.push({ mes: 'native greeting' }); current.header.chat_metadata.note_prompt = 'native default note'; files.set(locator.file, await copyFile(current)); }
        },
        ensureConnected: async () => {},
        async verifyAccount() { verifyEntered.release(); if (options.verifyGate) await options.verifyGate.promise; if (options.invalidateOnVerify) active = false; },
        submit(value) {
            calls.push('submit'); current.messages.push({ mes: value, is_user: true }); submitted.release();
            return (async () => {
                if (options.submitGate) await options.submitGate.promise;
                current.messages.push({ mes: 'child response' });
                if (!options.skipNativeSave) files.set(current.locator.file, await copyFile(current));
                if (options.mutateParent) files.get('root').messages[0].extra.value = 'leaked';
            })();
        },
        async waitFor(predicate) { for (let i = 0; i < 50; i++) { if (predicate()) return true; await turn(); } return false; },
        async saveExact(file) { saveCalls++; if (!options.skipExplicitSave) files.set(file.locator.file, await copyFile(file)); if (options.saveThrows) throw new Error('lost save response'); },
        updateCurrentEpisode(metadata, locator) {
            updates.push({ metadata: cloneJson(metadata), locator });
            if (sameLocator(current.locator, locator)) current.header.chat_metadata[NS] = cloneJson(metadata);
        },
        onIsolationFailure: evidence => isolation.push(evidence),
    };
    if (options.unsavedOpen) { current.messages[0].swipes = [current.messages[0].mes]; current.header.chat_metadata.note_prompt = ''; }
    const flow = createEpisodeFlow(d);
    const assertDraft = expected => expected.text === text && expected.draftRevision === draftRevision;
    const input = () => ({ account, scope: current.locator, text, draftRevision, assertDraft, kind: 'side', contextMode: options.fresh ? 'fresh' : 'continued', title: 'Story' });
    return { flow, d, native, files, operations, calls, transitionCalls, switches, updates, lease, source, submitted, acceptedFailure, verifyEntered, isolation,
        saveCalls: () => saveCalls, input, assertDraft,
        setDraft(next) { text = next; draftRevision++; }, setCurrent(file) { current = cloneJson(file); },
        prepare: () => flow.prepareEpisode(input()),
        send: reviewed => flow.sendEpisode({ account, operationId: reviewed.operation.operationId, reviewReceipt: reviewed.reviewReceipt, assertDraft }),
    };
}

test('flow keeps Reader draft revision independent and never writes ordinary/IDB drafts', async () => {
    const f = await fixture(), reviewed = await f.prepare();
    assert.equal(reviewed.operation.draftRevision, 4); assert.equal(reviewed.operation.capturedText, 'author request');
    assert.equal(reviewed.operation.initialFile.header.chat_metadata[NS].openingRequest, 'author request');
    const result = await f.send(reviewed); assert.equal(result.kind, 'confirmed'); assert.equal(result.operation.stage, 'confirmed');
    assert.deepEqual(f.calls, ['create', 'submit']);
});

test('Reader changes after capture or while preparing prevent unnoticed create/send', async () => {
    const f = await fixture(), reviewed = await f.prepare(); f.setDraft('later text');
    await assert.rejects(f.send(reviewed), { code: 'DRAFT_CHANGED' }); assert.deepEqual(f.calls, ['create']);
    const pause = gate(), pending = await fixture({ createGate: pause }), prepared = pending.prepare();
    await turn(); pending.setDraft('changed during preparation'); pause.release();
    await assert.rejects(prepared, { code: 'DRAFT_CHANGED' }); assert.deepEqual(pending.calls, []);
});

test('recovering creation is read-only until an explicit new review, and never replays a submitted operation', async () => {
    const f = await fixture(), first = await f.prepare(), id = first.operation.operationId;
    f.operations.get(id).stage = 'created';
    const recovered = await f.flow.recoverEpisode({ account: 'alice', operationId: id });
    assert.equal(recovered.reviewReceipt, undefined); assert.deepEqual(f.calls, ['create']);
    const reviewed = await f.flow.reviewRecoveredEpisode({ account: 'alice', operationId: id, assertDraft: f.assertDraft });
    assert.equal(reviewed.operation.stage, 'awaiting-review'); assert.notEqual(reviewed.reviewReceipt, first.reviewReceipt);
    assert.deepEqual(f.calls, ['create']);
    const sent = await f.send(reviewed); assert.equal(sent.kind, 'confirmed');
    await assert.rejects(f.flow.reviewRecoveredEpisode({ account: 'alice', operationId: id, assertDraft: f.assertDraft }), { code: 'REVIEW_STALE' });
    assert.deepEqual(f.calls, ['create', 'submit']);
});

test('re-review rejects a changed target or source and accepts only a synchronous true draft guard', async () => {
    const f = await fixture(), first = await f.prepare(), input = { account: 'alice', operationId: first.operation.operationId, assertDraft: f.assertDraft };
    await assert.rejects(f.flow.reviewRecoveredEpisode({ ...input, assertDraft: () => undefined }), { code: 'DRAFT_CHANGED' });
    f.files.get(first.target.file).messages.push({ mes: 'another page wrote this' });
    await assert.rejects(f.flow.reviewRecoveredEpisode(input), { code: 'TARGET_CHANGED' });
    assert.deepEqual(f.calls, ['create']);
    const changed = await fixture(), review = await changed.prepare();
    changed.setCurrent({ ...changed.source, messages: [{ mes: 'new unsaved parent' }] });
    await assert.rejects(changed.flow.reviewRecoveredEpisode({ account: 'alice', operationId: review.operation.operationId, assertDraft: changed.assertDraft }), { code: 'SOURCE_CHANGED' });
    assert.deepEqual(changed.calls, ['create']);
});

test('target rename after review requires reviewing its actual locator again', async () => {
    const f = await fixture(), review = await f.prepare(), old = f.files.get(review.target.file);
    f.files.delete(review.target.file); old.locator.file = 'renamed-child'; f.files.set(old.locator.file, old);
    await assert.rejects(f.send(review), { code: 'REVIEW_STALE' });
    assert.deepEqual(f.calls, ['create']);
});

test('cancel while submit-armed persists proof that native was not called and queued cancel resolves idempotently', async () => {
    const pause = gate(), f = await fixture({ verifyGate: pause }), reviewed = await f.prepare();
    const sending = f.send(reviewed), failure = assert.rejects(sending, { code: 'CANCELLED' });
    await f.verifyEntered.promise;
    const cancelled = f.flow.cancelEpisode({ account: 'alice', operationId: reviewed.operation.operationId }); pause.release();
    await failure;
    const op = await cancelled; assert.equal(op.stage, 'cancelled'); assert.equal(op.cancellationProof.kind, 'native-not-called');
    assert.deepEqual(f.calls, ['create']);
});

test('accepted journal failure still waits for native run before releasing the queue', async () => {
    const run = gate(), f = await fixture({ submitGate: run, failAccepted: true }), reviewed = await f.prepare();
    const sending = f.send(reviewed), failure = assert.rejects(sending, { code: 'JOURNAL_UNAVAILABLE' });
    await f.acceptedFailure.promise;
    let nextRan = false; const next = f.d.enqueue(() => { nextRan = true; });
    await turn(); assert.equal(nextRan, false); assert.equal(f.flow.episodeNavigationBusy(), true); assert.equal(sending.cancel(), false);
    run.release(); await failure; await next;
    assert.equal(nextRan, true); assert.equal(f.flow.episodeNavigationBusy(), false);
    assert.equal(f.operations.get(reviewed.operation.operationId).stage, 'save-unconfirmed');
});

test('final synchronous lease check catches changes during the last account await', async () => {
    const f = await fixture({ invalidateOnVerify: true }), reviewed = await f.prepare();
    await assert.rejects(f.send(reviewed), { code: 'ENGINE_REPLACED' }); assert.deepEqual(f.calls, ['create']);
});

test('fresh initialization is a separate opened baseline and parent content remains exact', async () => {
    const f = await fixture({ fresh: true }), parent = canonicalChat(f.files.get('root')), reviewed = await f.prepare();
    assert.equal(reviewed.operation.initialFile.messages.length, 0);
    const result = await f.send(reviewed); assert.equal(result.kind, 'confirmed');
    assert.equal(result.operation.recoverySnapshot.messages[0].mes, 'native greeting');
    assert.equal(result.operation.recoverySnapshot.header.chat_metadata.note_prompt, 'native default note');
    assert.equal(canonicalChat(f.files.get('root')), parent);
});

test('legacy graph gives an exact root locator for continuing existing child without creating another', async () => {
    const f = await fixture({ legacy: true }), first = await f.prepare();
    const child = f.files.get(first.target.file); f.setCurrent(child);
    const indexed = await f.flow.episodeIndex('a.png'); assert.equal(indexed.nodes[0].rootLocator.file, 'root');
    const continued = await f.flow.prepareEpisodeContinuation({ ...f.input(), target: child.locator });
    assert.equal(continued.operation.action, 'continue'); assert.equal(continued.operation.parentSnapshot.locator.file, 'root');
    assert.equal(continued.operation.target.creationOperationId, first.operation.operationId);
    assert.notEqual(continued.operation.operationId, first.operation.operationId);
    assert.deepEqual(f.calls, ['create']);
});

test('unconfirmed save blocks leaving and save retry writes once without another model request', async () => {
    const f = await fixture({ skipNativeSave: true }), reviewed = await f.prepare(), result = await f.send(reviewed);
    assert.equal(result.kind, 'unconfirmed');
    await assert.rejects(f.flow.episodeNavigationGuard(), error => ['SOURCE_CHANGED', 'SAVE_UNCONFIRMED'].includes(error.code));
    await f.flow.episodeNavigationGuard(result.target);
    const switches = f.switches.length, unsaved = canonicalChat(f.d.currentFull());
    assert.deepEqual(await f.flow.openEpisode(result.target), result.target);
    assert.equal(f.switches.length, switches); assert.equal(canonicalChat(f.d.currentFull()), unsaved);
    await assert.rejects(f.flow.episodeNavigationGuard(f.source.locator), error => ['SOURCE_CHANGED', 'SAVE_UNCONFIRMED'].includes(error.code));
    const saved = await f.flow.confirmEpisodeSave({ account: 'alice', operationId: reviewed.operation.operationId });
    assert.equal(saved.kind, 'confirmed'); assert.equal(f.saveCalls(), 1); assert.deepEqual(f.calls, ['create', 'submit']);
});

test('save failure remains unconfirmed and a later exact read confirms without rewriting', async () => {
    const f = await fixture({ skipNativeSave: true, saveThrows: true }), reviewed = await f.prepare(); await f.send(reviewed);
    await assert.rejects(f.flow.confirmEpisodeSave({ account: 'alice', operationId: reviewed.operation.operationId }), /lost save response/);
    assert.equal(f.operations.get(reviewed.operation.operationId).stage, 'save-unconfirmed');
    assert.equal((await f.flow.confirmEpisodeSave({ account: 'alice', operationId: reviewed.operation.operationId })).kind, 'confirmed');
    assert.equal(f.saveCalls(), 1); assert.deepEqual(f.calls, ['create', 'submit']);
});

test('stale confirmation revision and parent mutation can never mark confirmed', async () => {
    const stale = await fixture({ staleConfirmation: true }), first = await stale.prepare();
    await assert.rejects(stale.send(first), { code: 'SAVE_UNCONFIRMED' });
    assert.equal(stale.operations.get(first.operation.operationId).stage, 'save-unconfirmed');
    const changed = await fixture({ mutateParent: true }), second = await changed.prepare();
    await assert.rejects(changed.send(second), { code: 'PARENT_CHANGED' });
    assert.equal(changed.isolation.length, 1); assert.equal(changed.operations.get(second.operation.operationId).stage, 'save-unconfirmed');
});

test('title changes affect only child title/kind and update current namespace after exact confirmation', async () => {
    const f = await fixture(), reviewed = await f.prepare(), original = cloneJson(f.files.get(reviewed.target.file)), root = canonicalChat(f.files.get('root'));
    f.setCurrent(original);
    const result = await f.flow.renameEpisode({ ...reviewed.target, title: ' New title ', kind: 'parallel', expectedTitle: 'Story' });
    assert.equal(result.kind, 'confirmed'); assert.equal(result.title, 'New title'); assert.equal(f.saveCalls(), 1);
    original.header.chat_metadata[NS].title = 'New title'; original.header.chat_metadata[NS].kind = 'parallel';
    assert.equal(canonicalChat(f.files.get(reviewed.target.file)), canonicalChat(original));
    assert.equal(canonicalChat(f.d.currentFull()), canonicalChat(original)); assert.equal(canonicalChat(f.files.get('root')), root);
    assert.equal(f.updates.length, 1); assert.deepEqual(f.calls, ['create']);
});

test('title response loss confirms from full readback; unknown writes never blind retry', async () => {
    const f = await fixture({ saveThrows: true }), reviewed = await f.prepare();
    const input = { ...reviewed.target, title: 'Changed', expectedTitle: 'Story' };
    assert.equal((await f.flow.renameEpisode(input)).kind, 'confirmed'); assert.equal(f.saveCalls(), 1);
    await assert.rejects(f.flow.renameEpisode(input), { code: 'TITLE_CHANGED' }); assert.equal(f.saveCalls(), 1);
    const unknown = await fixture({ skipExplicitSave: true }), other = await unknown.prepare();
    const request = { ...other.target, title: 'Unknown', expectedTitle: 'Story' };
    assert.equal((await unknown.flow.renameEpisode(request)).kind, 'unconfirmed');
    assert.equal((await unknown.flow.renameEpisode(request)).kind, 'unconfirmed'); assert.equal(unknown.saveCalls(), 1);
    assert.equal(unknown.updates.length, 0);
    unknown.files.get(other.target.file).header.chat_metadata[NS].title = 'Unknown';
    assert.equal((await unknown.flow.renameEpisode(request)).kind, 'confirmed'); assert.equal(unknown.saveCalls(), 1);
});

test('rename refuses active unsaved memory, stale title, foreign owner and changes seen before writing', async () => {
    const f = await fixture(), reviewed = await f.prepare(), input = { ...reviewed.target, title: 'New', expectedTitle: 'Story' };
    await assert.rejects(f.flow.renameEpisode({ ...input, expectedTitle: 'Stale' }), { code: 'TITLE_CHANGED' });
    const dirty = cloneJson(f.files.get(reviewed.target.file)); dirty.messages[0].mes = 'unsaved'; f.setCurrent(dirty);
    await assert.rejects(f.flow.renameEpisode(input), { code: 'SOURCE_CHANGED' }); assert.equal(f.saveCalls(), 0);
    f.setCurrent(f.source); f.files.get(reviewed.target.file).header.chat_metadata[NS].ownerAccount = 'bob';
    await assert.rejects(f.flow.renameEpisode(input), { code: 'INVALID_IDENTITY' }); assert.equal(f.saveCalls(), 0);
    f.files.get(reviewed.target.file).header.chat_metadata[NS].ownerAccount = 'alice';
    const read = f.native.readFullChat; let count = 0;
    f.native.readFullChat = async locator => { if (++count === 2) f.files.get(locator.file).messages[0].mes = 'remote edit'; return read(locator); };
    await assert.rejects(f.flow.renameEpisode(input), { code: 'TITLE_CHANGED' }); assert.equal(f.saveCalls(), 0);
});

test('leaving a story outside any episode family answers at once, without waiting for queued work', async () => {
    const f = await fixture(), hold = gate();
    const blocker = f.d.enqueue(() => hold.promise);
    let left = false;
    const leaving = f.flow.episodeNavigationGuard().then(() => { left = true; });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(left, true);
    hold.release(); await blocker; await leaving;
});

test('leaving an episode still waits for queued work before it is checked', async () => {
    const f = await fixture(), reviewed = await f.prepare(), result = await f.send(reviewed);
    assert.ok(f.d.currentMetadata()?.[NS], 'the current story is the episode');
    const hold = gate();
    const blocker = f.d.enqueue(() => hold.promise);
    let left = false;
    const leaving = f.flow.episodeNavigationGuard().then(() => { left = true; }, () => { left = true; });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(left, false);
    hold.release(); await blocker; await leaving;
    assert.equal(left, true);
    assert.ok(result);
});

test('a long story is journalled by identity only, and a re-save rebuilds it exactly from the line', async () => {
    const f = await fixture({ snapshotBytes: 0, skipNativeSave: true }), reviewed = await f.prepare();
    for (const key of ['sourceSnapshot', 'parentSnapshot', 'initialFile']) {
        assert.equal(reviewed.operation[key].slim, true, key); assert.equal(reviewed.operation[key].messages, undefined, key);
    }
    assert.equal(reviewed.operation.initialFile.messageCount, 1);
    const result = await f.send(reviewed); assert.equal(result.kind, 'unconfirmed');
    const op = f.operations.get(reviewed.operation.operationId);
    assert.equal(op.recoverySnapshot.slim, true); assert.equal(op.saveIntent.expected, undefined);
    assert.deepEqual(op.saveIntent.tail.map(m => m.mes), ['author request', 'child response']);
    const saved = await f.flow.confirmEpisodeSave({ account: 'alice', operationId: reviewed.operation.operationId });
    assert.equal(saved.kind, 'confirmed'); assert.equal(f.saveCalls(), 1); assert.deepEqual(f.calls, ['create', 'submit']);
    assert.deepEqual(f.files.get(reviewed.target.file).messages.map(m => m.mes), ['parent history', 'author request', 'child response']);
});

test('a long story re-save refuses when the line no longer rebuilds to the recorded result', async () => {
    const f = await fixture({ snapshotBytes: 0, skipNativeSave: true }), reviewed = await f.prepare(); await f.send(reviewed);
    const op = f.operations.get(reviewed.operation.operationId); op.saveIntent.tail[1].mes = 'not what was written';
    await assert.rejects(f.flow.confirmEpisodeSave({ account: 'alice', operationId: op.operationId }), { code: 'NO_SAVE_SNAPSHOT' });
    assert.equal(f.saveCalls(), 0);
});

test('a send left half-way settles from the line itself, read-only, and only when the reply is there', async () => {
    const f = await fixture({ snapshotBytes: 0 }), reviewed = await f.prepare(); await f.send(reviewed);
    const id = reviewed.operation.operationId, op = f.operations.get(id);
    // The page was stopped right after writing: the journal still says generated, with no save record.
    Object.assign(op, { stage: 'generated', recoverySnapshot: { slim: true, messageCount: 1 } }); delete op.saveIntent; delete op.confirmation;
    const saved = canonicalChat(f.files.get(reviewed.target.file));
    const [settled] = await f.flow.settleEpisodes();
    assert.equal(settled.stage, 'dismissed'); assert.equal(settled.resolution.kind, 'landed'); assert.equal(settled.resolution.evidence, 'reply-in-line');
    assert.equal(canonicalChat(f.files.get(reviewed.target.file)), saved); assert.equal(f.saveCalls(), 0);
    assert.deepEqual(await f.flow.unfinishedEpisodes(), []);

    const g = await fixture({ snapshotBytes: 0 }), second = await g.prepare(); await g.send(second);
    const stuck = g.operations.get(second.operation.operationId);
    Object.assign(stuck, { stage: 'accepted', recoverySnapshot: { slim: true, messageCount: 1 } }); delete stuck.saveIntent; delete stuck.confirmation;
    g.files.get(second.target.file).messages.pop();
    assert.deepEqual(await g.flow.settleEpisodes(), []);
    assert.equal(g.operations.get(stuck.operationId).stage, 'accepted');
});

test('the author can set aside a sent record but not one that was never sent', async () => {
    const f = await fixture({ skipNativeSave: true }), reviewed = await f.prepare();
    await assert.rejects(f.flow.dismissEpisode({ account: 'alice', operationId: reviewed.operation.operationId }), { code: 'NOT_SENT' });
    await f.send(reviewed);
    const op = await f.flow.dismissEpisode({ account: 'alice', operationId: reviewed.operation.operationId });
    assert.equal(op.stage, 'dismissed'); assert.equal(op.resolution.kind, 'user'); assert.equal(op.confirmation, undefined);
    assert.deepEqual(f.calls, ['create', 'submit']);
});

test('a save record left half-way settles when the line was saved as recorded or holds the reply', async () => {
    const f = await fixture({ skipNativeSave: true, skipExplicitSave: true }), reviewed = await f.prepare(), result = await f.send(reviewed);
    assert.equal(result.kind, 'unconfirmed');
    assert.deepEqual(await f.flow.settleEpisodes(), []);
    // The full app saved it later (after the page came back), with one more line written since.
    const done = cloneJson(f.d.currentFull()); done.messages.push({ mes: 'written afterwards', is_user: true }); f.files.set(done.locator.file, done);
    const [settled] = await f.flow.settleEpisodes();
    assert.equal(settled.resolution.evidence, 'reply-in-line'); assert.equal(f.saveCalls(), 0);
});

test('a story opened but not saved since (what the app adds on opening) is saved once, then the line is made from it', async () => {
    const f = await fixture({ unsavedOpen: true }), reviewed = await f.prepare();
    assert.equal(f.saveCalls(), 1); assert.deepEqual(f.calls, ['create']);
    assert.deepEqual(f.files.get('root').messages[0].swipes, ['parent history']);
    assert.equal(reviewed.operation.stage, 'awaiting-review');
});

test('an unsaved change beyond what opening adds (a timed world-info entry) is refused, not saved', async () => {
    const f = await fixture({ unsavedOpen: true });
    f.setCurrent({ ...f.d.currentFull(), header: { ...f.d.currentFull().header, chat_metadata: { ...f.d.currentFull().header.chat_metadata, timedWorldInfo: { sticky: { 1: 3 } } } } });
    await assert.rejects(f.prepare(), error => error.code === 'SOURCE_UNCONFIRMED' && error.unsaved.includes('chat_metadata.timedWorldInfo'));
    assert.equal(f.saveCalls(), 0); assert.deepEqual(f.calls, []);
    assert.equal(f.files.get('root').header.chat_metadata.timedWorldInfo, undefined);
});

test('only additions count as what opening adds', async () => {
    const saved = { header: { chat_metadata: { note_prompt: 'kept', other: 1 } }, messages: [{ mes: 'hi', swipes: ['hi'] }, { mes: 'me', is_user: true }] };
    const opened = structuredClone(saved);
    Object.assign(opened.header.chat_metadata, { note_depth: 4, integrity: 'x', timedWorldInfo: { sticky: {}, cooldown: {} } }); opened.messages[0].swipe_id = 0; opened.messages[0].swipe_info = [];
    assert.deepEqual(unsavedBeyondOpening(saved, opened), []);
    const edited = structuredClone(opened); edited.header.chat_metadata.note_prompt = 'changed'; edited.messages[0].swipes = ['hi', 'new']; edited.messages[1].swipes = ['me'];
    assert.deepEqual(unsavedBeyondOpening(saved, edited), ['messages.0.swipes', 'messages.1.swipes', 'chat_metadata.note_prompt']);
    assert.deepEqual(unsavedBeyondOpening(saved, { ...opened, messages: opened.messages.slice(0, 1) }), ['messages']);
    const timed = structuredClone(opened); timed.header.chat_metadata.timedWorldInfo.sticky = { 1: 3 };
    assert.deepEqual(unsavedBeyondOpening(saved, timed), ['chat_metadata.timedWorldInfo']);
});

test('a story that still differs after that one save is refused, not saved again', async () => {
    const f = await fixture({ unsavedOpen: true });
    f.d.saveCurrent = async () => {}; // the save did not reach the file
    await assert.rejects(f.prepare(), { code: 'SOURCE_UNCONFIRMED' }); assert.deepEqual(f.calls, []);
});
