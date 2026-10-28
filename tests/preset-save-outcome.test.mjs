import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresetFixture, memoryStorage, seedPreset } from './preset-editor-fixture.js';
import { createPresetEditorJournal } from '../bridge-preset-editor.js';
import { normalizePresetTargetName, presetTargetKey, validatePresetName, isBlockingPresetOperation, PRESET_DECISION_ACK } from '../src/preset-editor-model.js';
const input = extra => ({ account: 'preset-test', name: 'Original', ...extra });
const clone = value => structuredClone(value);
const decide = async (f, operation) => {
    const preview = await f.bridge.presetEditorPrepareDecision(input({ operationId: operation.id }));
    return f.bridge.presetEditorDecide({ ...preview, acknowledgement: PRESET_DECISION_ACK });
};
const legacy = (f, extra = {}) => f.journal.put({ id: 'legacy', account: 'preset-test', name: 'Original', mode: 'save', stage: 'armed', before: seedPreset(), expected: { ...seedPreset(), temperature: 1.1 }, ...extra });

for (const fault of ['abort', 'reject', '502', '503', '504', 'bad-response', 'resolved-old']) test(`dispatched ${fault} plus OLD stays unknown; read-only recovery never resends`, async () => {
    const f = createPresetFixture(); await f.bridge.presetEditorState(); f.externalRuntime({ temperature: 1.1 }); f.fault(fault);
    const result = await f.bridge.presetEditorSave(input());
    assert.equal(result.kind, 'unconfirmed'); assert.equal(result.operation.writeOutcome, 'unknown'); assert.equal(f.files.get('Original').temperature, .7);
    assert.equal(f.current().full.temperature, 1.1); assert.equal(f.counters().writes, 1);
    f.fault(''); await assert.rejects(f.bridge.presetEditorSave(input()), { code: 'PRESET_SAVE_PENDING' });
    const recovered = await f.bridge.presetEditorRecover(input({ operationId: result.operation.id }));
    assert.equal(recovered.kind, 'unconfirmed'); assert.equal(f.counters().writes, 1);
    // Controlled in-memory delayed commit, not a real server scheduling claim.
    f.files.set('Original', clone(result.operation.expected));
    assert.equal((await f.bridge.presetEditorRecover(input({ operationId: result.operation.id }))).kind, 'confirmed');
    assert.equal(f.counters().writes, 1);
});

for (const ordinal of [1, 2]) test(`preflight named read ${ordinal} fails with zero writes; reload leaves no false pending`, async () => {
    const storage = memoryStorage(), f = createPresetFixture({ storage, persist: true }); await f.bridge.presetEditorState(); f.externalRuntime({ temperature: 1.1 });
    const before = f.counters().reads; f.onRead(n => { if (n === before + ordinal) throw new Error('Read503'); });
    if (ordinal === 1) await assert.rejects(f.bridge.presetEditorSave(input()), error => error.saveOutcome === 'not-submitted');
    else { const result = await f.bridge.presetEditorSave(input()); assert.equal(result.kind, 'not-submitted'); assert.equal(result.operation.notSubmittedProof.kind, 'write-not-invoked'); }
    assert.equal(f.counters().writes, 0); assert.equal(f.current().full.temperature, 1.1);
    const next = createPresetFixture({ storage, persist: true }); assert.equal((await next.bridge.presetEditorState()).operations.length, 0);
    assert.equal(next.current().full.temperature, 1.1); assert.equal((await next.bridge.presetEditorSave(input())).kind, 'confirmed');
});

test('canonical-name and final account preflight failures do not invoke write', async () => {
    const f = createPresetFixture(); await f.bridge.presetEditorState(); f.externalRuntime({ temperature: 1 });
    f.onCanonical(() => { throw new Error('Canonical503'); });
    await assert.rejects(f.bridge.presetEditorSave(input()), error => error.saveOutcome === 'not-submitted'); assert.equal(f.journal.list('preset-test').length, 0);
    f.onCanonical(null); const firstRead = f.counters().reads;
    f.onVerify(() => { if (f.counters().reads >= firstRead + 2 && f.journal.list('preset-test').length) throw new Error('Account verification unavailable'); });
    const result = await f.bridge.presetEditorSave(input()); assert.equal(result.kind, 'not-submitted'); assert.equal(f.counters().writes, 0);
    f.onVerify(null); assert.equal((await f.bridge.presetEditorSave(input())).kind, 'confirmed');
});

test('pre-dispatch concurrent file change is proved not-submitted without overwriting', async () => {
    const f = createPresetFixture(); await f.bridge.presetEditorState(); f.externalRuntime({ temperature: 1 }); const before = f.counters().reads;
    f.onRead(n => { if (n === before + 2) f.files.set('Original', { ...seedPreset(), temperature: 1.4 }); });
    const result = await f.bridge.presetEditorSave(input()); assert.equal(result.kind, 'not-submitted'); assert.equal(f.counters().writes, 0);
    assert.equal(f.files.get('Original').temperature, 1.4); assert.equal(f.current().full.temperature, 1);
});

for (const change of ['account', 'preset']) test(`pre-dispatch ${change} lease loss records captured zero-write fact without touching new runtime`, async () => {
    const f = createPresetFixture(); await f.bridge.presetEditorState(); f.externalRuntime({ temperature: 1.1 }); const before = f.counters().reads;
    f.onRead(n => { if (n === before + 2) { if (change === 'account') f.changeAccount(); else f.switchPreset('Other'); } });
    await assert.rejects(f.bridge.presetEditorSave(input()), error => error.code === (change === 'account' ? 'PRESET_ACCOUNT_CHANGED' : 'PRESET_CHANGED') && error.saveOutcome === 'not-submitted' && error.receiptPersisted === true);
    assert.equal(f.counters().writes, 0); assert.equal(f.journal.list('preset-test').length, 0);
    const key = [...Array(f.storage.length)].map((_, i) => f.storage.key(i)).find(k => k.startsWith('tavern-lite:preset-operation:'));
    const receipt = JSON.parse(f.storage.getItem(key)); assert.equal(receipt.account, 'preset-test'); assert.equal(receipt.writeOutcome, 'not-submitted');
    assert.equal(receipt.notSubmittedProof.kind, 'write-not-invoked');
    if (change === 'account') assert.equal(f.current().account, 'other-account'); else { assert.equal(f.current().name, 'Other'); assert.equal(f.current().full.temperature, .2); }
});

test('zero-write terminal receipt failure stays explicit and durable armed lock is not silently released', async () => {
    const f = createPresetFixture(); await f.bridge.presetEditorState(); f.externalRuntime({ temperature: 1.1 }); const before = f.counters().reads, originalSet = f.storage.setItem;
    f.onRead(n => { if (n === before + 2) { f.storage.setItem = () => { throw new Error('Quota after armed'); }; throw new Error('Read failed'); } });
    const result = await f.bridge.presetEditorSave(input()); assert.equal(result.kind, 'not-submitted'); assert.equal(result.receiptPersisted, false);
    assert.ok(result.operation.receiptError); assert.match(result.error, /没记下结果/); assert.doesNotMatch(result.error, /可以再试/); assert.equal(f.counters().writes, 0);
    f.storage.setItem = originalSet; f.onRead(null);
    const durable = f.journal.get('preset-test', result.operation.id); assert.equal(durable.writeOutcome, 'unknown'); assert.equal(isBlockingPresetOperation(durable), true);
    await assert.rejects(f.bridge.presetEditorSave(input()), { code: 'PRESET_SAVE_PENDING' }); assert.equal(f.counters().writes, 0);
});

test('unknown A does not lock B or a genuinely new copy; source changes do not overwrite captured mine', async () => {
    const f = createPresetFixture(); await f.bridge.presetEditorState(); f.externalRuntime({ temperature: 1.1 }); f.fault('abort');
    await f.bridge.presetEditorSave(input()); f.fault(''); f.switchPreset('Other'); f.externalRuntime({ temperature: .5 });
    assert.equal((await f.bridge.presetEditorSave(input({ name: 'Other' }))).kind, 'confirmed');
    f.switchPreset('Original'); f.externalRuntime({ temperature: 1.2 }); f.externalFile({ temperature: 1.7 });
    const copied = await f.bridge.presetEditorSave(input({ copyName: 'Independent copy' }));
    assert.equal(copied.kind, 'confirmed'); assert.equal(f.files.get('Independent copy').temperature, 1.2); assert.equal(f.files.get('Original').temperature, 1.7);
    assert.equal(f.counters().writes, 3);
});

test('target locks bind account, API and server-normalized names; default folds case conservatively', async () => {
    const f = createPresetFixture(); legacy(f, { name: 'Original.' });
    await assert.rejects(f.bridge.presetEditorSave(input()), { code: 'PRESET_SAVE_PENDING' });
    await assert.rejects(f.bridge.presetEditorSave(input({ copyName: 'original' })), { code: 'PRESET_SAVE_PENDING' });
    await assert.rejects(f.bridge.presetEditorSave(input({ copyName: 'Original.' })), { code: 'INVALID_PRESET_NAME' });
    const preview = await f.bridge.presetEditorPrepareDecision(input({ operationId: 'legacy' })); assert.equal(preview.basis.kind, 'present'); assert.equal(preview.operation.name, 'Original');
    assert.equal(f.counters().writes, 0);
    const other = createPresetFixture(); legacy(other, { apiId: 'novel' }); legacy(other, { id: 'another-account', account: 'other-account' });
    assert.equal((await other.bridge.presetEditorSave(input())).kind, 'confirmed');
});

test('explicit case-sensitive host uses distinct targets; native binding never guesses from browser OS', async () => {
    const f = createPresetFixture({ caseSensitiveNames: true }); legacy(f);
    const saved = await f.bridge.presetEditorSave(input({ copyName: 'original' })); assert.equal(saved.kind, 'confirmed');
    assert.ok(f.files.has('Original') && f.files.has('original'));
    assert.notEqual(presetTargetKey('a', 'openai', 'A', true), presetTargetKey('a', 'openai', 'a', true));
    assert.equal(presetTargetKey('a', 'openai', 'A'), presetTargetKey('a', 'openai', 'a'));
});

for (const stage of ['armed', 'not-saved']) test(`legacy ${stage} has conservative unknown migration and explicit decision separate from write facts`, async () => {
    const f = createPresetFixture(); legacy(f, { stage, writeSettled: 'rejected' });
    const state = await f.bridge.presetEditorState(); assert.equal(state.operations[0].writeOutcome, 'unknown'); assert.equal(state.operations[0].stage, 'unconfirmed');
    const before = clone(f.current()); const result = await decide(f, state.operations[0]);
    assert.equal(result.kind, 'user-decided'); assert.equal(result.operation.writeOutcome, 'unknown'); assert.equal(result.operation.stage, 'unconfirmed');
    assert.equal(isBlockingPresetOperation(result.operation), false); assert.deepEqual(f.current(), before); assert.equal(f.counters().writes, 0);
    const journal = createPresetEditorJournal(f.storage); assert.equal(isBlockingPresetOperation(journal.get('preset-test', 'legacy')), false);
    assert.equal((await f.bridge.presetEditorSave(input())).kind, 'confirmed');
});

test('decision requires fresh revision, unchanged server basis, explicit acknowledgement and durable storage', async () => {
    const f = createPresetFixture(); legacy(f); let preview = await f.bridge.presetEditorPrepareDecision(input({ operationId: 'legacy' }));
    await assert.rejects(f.bridge.presetEditorDecide(preview), { code: 'PRESET_DECISION_ACK' });
    await f.bridge.presetEditorRecover(input({ operationId: 'legacy' }));
    await assert.rejects(f.bridge.presetEditorDecide({ ...preview, acknowledgement: PRESET_DECISION_ACK }), { code: 'PRESET_RECEIPT_CHANGED' });
    preview = await f.bridge.presetEditorPrepareDecision(input({ operationId: 'legacy' })); f.externalFile({ temperature: 1.4 });
    await assert.rejects(f.bridge.presetEditorDecide({ ...preview, acknowledgement: PRESET_DECISION_ACK }), { code: 'PRESET_DECISION_CHANGED' });
    preview = await f.bridge.presetEditorPrepareDecision(input({ operationId: 'legacy' })); const originalSet = f.storage.setItem;
    f.storage.setItem = () => { throw new Error('quota'); };
    await assert.rejects(f.bridge.presetEditorDecide({ ...preview, acknowledgement: PRESET_DECISION_ACK }), { code: 'PRESET_RECEIPT_UNAVAILABLE' });
    f.storage.setItem = originalSet; assert.equal(isBlockingPresetOperation(f.journal.get('preset-test', 'legacy')), true); assert.equal(f.counters().writes, 0);
});

test('decision stale account and local revision changes are rejected before releasing target', async () => {
    const f = createPresetFixture(); legacy(f); const preview = await f.bridge.presetEditorPrepareDecision(input({ operationId: 'legacy' }));
    f.changeAccount(); assert.throws(() => f.bridge.presetEditorDecide({ ...preview, acknowledgement: PRESET_DECISION_ACK }), { code: 'PRESET_ACCOUNT_CHANGED' });
    assert.equal(isBlockingPresetOperation(f.journal.get('preset-test', 'legacy')), true);
    const g = createPresetFixture(), op = legacy(g); const changed = g.journal.put({ ...op, observation: { marker: 'new' } });
    assert.throws(() => g.journal.decide(op, { kind: 'missing' }, PRESET_DECISION_ACK, () => {}), { code: 'PRESET_RECEIPT_CHANGED' });
    assert.equal(g.journal.get('preset-test', 'legacy').revision, changed.revision);
});

test('controlled delayed old commit after decision/new save is observed without replacing running/cache NEW', async () => {
    const f = createPresetFixture(); await f.bridge.presetEditorState(); f.externalRuntime({ temperature: 1.1 }); f.fault('abort');
    const old = await f.bridge.presetEditorSave(input()); f.fault(''); await decide(f, old.operation);
    f.externalRuntime({ temperature: 1.2 }); const newer = await f.bridge.presetEditorSave(input()); assert.equal(newer.kind, 'confirmed');
    const cache = clone(f.cache.get('Original')); f.files.set('Original', clone(old.operation.expected));
    const history = await f.bridge.presetEditorRecover(input({ operationId: old.operation.id }));
    assert.equal(history.kind, 'historical-observation'); assert.equal(history.fileConfirmed, true); assert.equal(history.operation.writeOutcome, 'unknown');
    assert.deepEqual(f.cache.get('Original'), cache); assert.equal(f.current().full.temperature, 1.2); assert.equal(f.counters().writes, 2);
    const newHistory = await f.bridge.presetEditorRecover(input({ operationId: newer.operation.id })); assert.equal(newHistory.kind, 'historical-observation');
    assert.equal(newHistory.operation.writeOutcome, 'confirmed'); assert.deepEqual(f.cache.get('Original'), cache); assert.equal(f.counters().writes, 2);
});

test('normalization matches ST sanitize-filename default rules; changed names are rejected for new writes', () => {
    const vectors = [['a/b?c*', 'abc'], ['a\u0080b', 'ab'], ['CON.txt', ''], ['COM0', ''], ['...', ''], ['safe... ', 'safe'], ['😀'.repeat(64), '😀'.repeat(63)], ['中'.repeat(86), '中'.repeat(85)]];
    for (const [raw, expected] of vectors) { assert.equal(normalizePresetTargetName(raw), expected); assert.throws(() => validatePresetName(raw), { code: 'INVALID_PRESET_NAME' }); }
    assert.equal(validatePresetName('有效 New 名称'), '有效 New 名称');
});
