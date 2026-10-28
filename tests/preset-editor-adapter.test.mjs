import test from 'node:test'; import assert from 'node:assert/strict';
import { createPresetFixture, memoryStorage } from './preset-editor-fixture.js';
const input = extra => ({ account: 'preset-test', name: 'Original', ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
test('named save captures runtime before asynchronous work and preserves unknown fields', async () => {
    const f = createPresetFixture(); await f.bridge.presetEditorState(); f.externalRuntime({ temperature: 1 }); f.hold('write');
    const saving = f.bridge.presetEditorSave(input()); await tick(); f.externalRuntime({ temperature: 1.2 }); f.release('write');
    assert.equal((await saving).kind, 'confirmed'); assert.equal(f.files.get('Original').temperature, 1); assert.equal(f.current().full.temperature, 1.2);
    assert.equal(f.files.get('Original').prompts[0].extensionUnknown.keep, 17); assert.equal((await f.bridge.presetEditorState()).changes.length, 1);
});
test('nonoverlap merges; same field conflict requires current remote-bound choice', async () => {
    const f = createPresetFixture(); await f.bridge.presetEditorState(); f.externalRuntime({ temperature: 1 }); f.externalFile({ top_p: .8 });
    assert.equal((await f.bridge.presetEditorSave(input())).kind, 'confirmed'); assert.equal(f.files.get('Original').top_p, .8);
    f.externalRuntime({ temperature: 1.1 }); f.externalFile({ temperature: 1.4 }); const conflict = await f.bridge.presetEditorSave(input()); assert.equal(conflict.kind, 'conflict');
    assert.equal(f.counters().writes, 1); const key = conflict.conflicts[0].key;
    assert.equal((await f.bridge.presetEditorSave(input({ resolutions: { [key]: { take: 'mine', server: 1.4 } } }))).kind, 'confirmed'); assert.equal(f.files.get('Original').temperature, 1.1);
});
test('copy waits for native application and keeps original file byte-equivalent', async () => {
    const f = createPresetFixture(); await f.bridge.presetEditorState(); const before = JSON.stringify(f.files.get('Original')); f.externalRuntime({ temperature: 1 }); f.hold('use'); let settled = false;
    const saving = f.bridge.presetEditorSave(input({ copyName: 'New copy' })).then(x => { settled = true; return x; }); await tick();
    assert.equal(settled, false); assert.equal(f.current().name, 'Original'); assert.ok(f.files.has('New copy')); f.release('use'); const result = await saving;
    assert.equal(result.applied, true); assert.equal(f.current().name, 'New copy'); assert.equal(JSON.stringify(f.files.get('Original')), before); assert.equal(result.originalUnchanged, true);
});
test('later runtime changes stop automatic copy switch and explicit use never writes again', async () => {
    const f = createPresetFixture(); await f.bridge.presetEditorState(); f.hold('write'); const saving = f.bridge.presetEditorSave(input({ copyName: 'Copy' })); await tick(); f.externalRuntime({ temperature: 1.3 }); f.release('write');
    const result = await saving; assert.equal(result.kind, 'saved-not-applied'); assert.equal(f.current().name, 'Original'); assert.equal(f.counters().uses, 0);
    const use = await f.bridge.presetEditorUseCopy(input({ operationId: result.operation.id })); assert.equal(use.applied, true); assert.equal(f.counters().writes, 1);
});
test('application failure is saved-not-applied and only explicit use retries native selection', async () => {
    const f = createPresetFixture(); await f.bridge.presetEditorState(); f.fault('use'); const result = await f.bridge.presetEditorSave(input({ copyName: 'Copy' }));
    assert.equal(result.kind, 'saved-not-applied'); assert.equal(result.fileConfirmed, true); const recovered = await f.bridge.presetEditorRecover(input({ operationId: result.operation.id }));
    assert.equal(recovered.kind, 'historical-observation'); assert.equal(recovered.operation.stage, 'saved-not-applied'); assert.equal(f.counters().uses, 1); assert.equal(f.counters().writes, 1);
});
test('lost response blocks duplicates; recreation and read-only recovery do not resend', async () => {
    const storage = memoryStorage(), f = createPresetFixture({ storage, persist: true }); await f.bridge.presetEditorState(); f.fault('unknown'); const result = await f.bridge.presetEditorSave(input({ copyName: 'Copy' }));
    assert.equal(result.kind, 'unconfirmed'); await assert.rejects(f.bridge.presetEditorSave(input({ copyName: 'Copy' })), { code: 'PRESET_SAVE_PENDING' });
    const reloaded = createPresetFixture({ storage, persist: true }); const recovery = await reloaded.bridge.presetEditorRecover(input({ operationId: result.operation.id }));
    assert.equal(recovery.fileConfirmed, true); assert.equal(reloaded.counters().writes, 0); assert.equal(reloaded.counters().uses, 0);
});
test('HTTP rejection plus unchanged readback remains unknown and blocks the same target', async () => {
    const f = createPresetFixture(); await f.bridge.presetEditorState(); f.externalRuntime({ temperature: 1 }); f.fault('reject'); const result = await f.bridge.presetEditorSave(input());
    assert.equal(result.kind, 'unconfirmed'); assert.equal(result.operation.writeOutcome, 'unknown'); f.fault(''); await assert.rejects(f.bridge.presetEditorSave(input()), { code: 'PRESET_SAVE_PENDING' });
});
test('receipt failure before HTTP forbids writing; postwrite quota preserves readback and blocks duplicate copy', async () => {
    const storage = memoryStorage(), f = createPresetFixture({ storage }); await f.bridge.presetEditorState(); const setItem = storage.setItem;
    storage.setItem = () => { throw new Error('quota'); }; await assert.rejects(f.bridge.presetEditorSave(input()), { code: 'PRESET_RECEIPT_UNAVAILABLE' }); assert.equal(f.counters().writes, 0);
    storage.setItem = setItem; f.onWrite(() => { storage.setItem = () => { throw new Error('quota'); }; }); const result = await f.bridge.presetEditorSave(input({ copyName: 'Copy' }));
    assert.equal(result.fileConfirmed, true); assert.ok(result.operation.receiptError); assert.equal(f.counters().writes, 1);
    await assert.rejects(f.bridge.presetEditorSave({ account: 'preset-test', name: 'Copy', copyName: 'Another' }), { code: 'PRESET_RECEIPT_UNAVAILABLE' }); assert.equal(f.counters().writes, 1);
});
test('queued prompt apply rejects preset switch and leaves other preset untouched', async () => {
    const f = createPresetFixture(); const request = f.bridge.presetEditorApplyPrompt(input({ identifier: 'main', base: 'Original main body', text: 'Mine' })); f.switchPreset('Other');
    await assert.rejects(request, { code: 'PRESET_CHANGED' }); assert.equal(f.counters().applies, 0); assert.equal(f.current().prompts[0].content, 'Original main body');
});
test('prompt and number conflicts never silently overwrite native changes', async () => {
    const f = createPresetFixture(); f.externalPrompt('Remote'); const result = await f.bridge.presetEditorApplyPrompt(input({ identifier: 'main', base: 'Original main body', text: 'Mine' }));
    assert.equal(result.kind, 'conflict'); assert.equal(f.counters().applies, 0);
    const accepted = await f.bridge.presetEditorApplyPrompt(input({ identifier: 'main', base: 'Original main body', text: 'Mine', resolution: { take: 'server', server: 'Remote' } })); assert.equal(accepted.content, 'Remote');
    f.externalRuntime({ temperature: 1 }); await assert.rejects(f.bridge.presetEditorSetField(input({ key: 'temperature', base: .7, value: 1.2 })), { code: 'PRESET_FIELD_CONFLICT' }); assert.equal(f.current().full.temperature, 1);
});
test('account switch during queued work prevents native writes', async () => {
    const f = createPresetFixture(); const pending = f.bridge.presetEditorSave(input()); f.changeAccount();
    await assert.rejects(pending, { code: 'PRESET_ACCOUNT_CHANGED' }); assert.equal(f.counters().writes, 0);
});
test('preset switch after HTTP started cannot auto-apply copy and leaves durable recovery identity', async () => {
    const f = createPresetFixture(); await f.bridge.presetEditorState(); f.hold('write'); const pending = f.bridge.presetEditorSave(input({ copyName: 'Copy' })); await tick();
    f.switchPreset('Other'); f.release('write'); await assert.rejects(pending, { code: 'PRESET_CHANGED' });
    assert.equal(f.counters().uses, 0); assert.equal(f.current().name, 'Other'); const state = await f.bridge.presetEditorState(); assert.equal(state.operations.length, 1);
    const result = await f.bridge.presetEditorRecover({ account: 'preset-test', operationId: state.operations[0].id });
    assert.equal(result.kind, 'saved-not-applied'); assert.equal(f.counters().writes, 1); assert.equal(f.current().name, 'Other');
});
test('a switch answers with the named preset read moments ago; opening and explicit reads go to the server', async () => {
    const f = createPresetFixture(); await f.bridge.presetEditorState();
    const reads = f.counters().reads;
    const next = await f.bridge.presetEditorSetField(input({ key: 'temperature', base: f.current().full.temperature, value: 1.1 }));
    assert.equal(next.full.temperature, 1.1);
    assert.equal(f.counters().reads, reads, 'no named read for the answer to a switch');
    await f.bridge.presetEditorState({ fresh: false });
    assert.equal(f.counters().reads, reads, 'an event refresh reuses the recent copy');
    await f.bridge.presetEditorState();
    assert.equal(f.counters().reads, reads + 1, 'a plain read still reads the server');
    f.externalFile({ top_p: .5 });
    assert.equal((await f.bridge.presetEditorState()).named.top_p, .5, 'changes made elsewhere show on the next plain read');
});
test("entries move and copy against the order the page showed; a list changed meanwhile is not rearranged", async () => {
    const f = createPresetFixture(), order = () => f.current().prompts.map(p => p.identifier);
    await f.bridge.presetEditorState();
    const moved = await f.bridge.presetEditorArrangePrompt(input({ action: "move", identifier: "secondary", to: 0, order: ["main", "advanced", "secondary"] }));
    assert.deepEqual(order(), ["secondary", "main", "advanced"]); assert.deepEqual(moved.prompts.map(p => p.identifier), order());
    assert.ok(moved.changes.some(c => c.path[0] === "prompt_order"), "the move shows as a change not yet saved to the named preset");
    const copied = await f.bridge.presetEditorArrangePrompt(input({ action: "copy", identifier: "main", order: order(), copyName: "Main 副本" }));
    assert.equal(order()[2], copied.created); const copy = copied.prompts[2];
    assert.equal(copy.name, "Main 副本"); assert.equal(copy.content, "Original main body"); assert.equal(copy.enabled, false, "the copy starts off");
    await assert.rejects(f.bridge.presetEditorArrangePrompt(input({ action: "move", identifier: "main", to: 0, order: ["main", "secondary", "advanced"] })), e => e.code === "PRESET_ORDER_CONFLICT");
    assert.equal(order()[1], "main", "nothing moved on a conflict"); assert.equal(f.counters().writes, 0, "the named preset file is not written");
});
