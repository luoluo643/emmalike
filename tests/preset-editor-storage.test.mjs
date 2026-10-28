import test from 'node:test'; import assert from 'node:assert/strict';
import { createPresetEditorJournal } from '../bridge-preset-editor.js';
import { createNativePresetEditor } from '../bridge-preset-editor-native.js';
import { createPromptDraftStore } from '../src/preset-editor-model.js';
import { createPresetFixture, memoryStorage } from './preset-editor-fixture.js';
const identity = { account: 'preset-test', name: 'Original', identifier: 'main' }, op = { account: identity.account, id: 'operation', stage: 'armed' };
const draft = { ...identity, opened: 'base', base: 'base', text: 'mine', revision: 1 };
function minimalNative() {
    const document = { documentElement: { isConnected: true } }, window = { document };
    const context = { eventSource: { on() {}, removeListener() {} }, eventTypes: { OAI_PRESET_CHANGED_AFTER: 'preset-after', SETTINGS_UPDATED: 'settings' } };
    return createNativePresetEditor({ account: identity.account, st: {}, openai: {}, presetManager: {}, ctx: () => context,
        document, window, enqueue: fn => Promise.resolve().then(fn), verifyAccount: async () => {} });
}
test('throwing localStorage getter does not abort native bridge installation or draft-store construction', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'); let reads = 0;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { reads++; throw new DOMException('Blocked by browser', 'SecurityError'); } });
    try {
        let journal, drafts, native;
        assert.doesNotThrow(() => { journal = createPresetEditorJournal(); drafts = createPromptDraftStore(); native = minimalNative(); });
        assert.equal(reads, 0, 'Factories must not resolve browser storage eagerly');
        const hostBridge = Object.freeze({ send: async () => 'basic-chat-alive', ...native }); assert.equal(await hostBridge.send(), 'basic-chat-alive');
        for (const call of [() => journal.put(op), () => journal.get(op.account, op.id), () => journal.list(op.account)]) assert.throws(call, { code: 'PRESET_RECEIPT_UNAVAILABLE' });
        for (const call of [() => drafts.read(identity), () => drafts.write(draft), () => drafts.remove(identity)]) assert.throws(call, { code: 'PRESET_DRAFT_UNAVAILABLE' });
        const fixture = createPresetFixture({ journal }); const state = await fixture.bridge.presetEditorState();
        assert.equal(state.name, 'Original'); assert.equal(state.capabilities.namedReadback, true); assert.equal(state.capabilities.namedWrite, false); assert.ok(state.storageError);
        await assert.rejects(fixture.bridge.presetEditorSave({ account: identity.account, name: identity.name }), { code: 'PRESET_RECEIPT_UNAVAILABLE' });
        assert.equal(fixture.counters().writes, 0); native.disposePresetEditor();
    } finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage; }
});
test('throwing storage methods are caught and cannot permit a named write', async () => {
    const storage = { get length() { throw new Error('Blocked length'); }, key() { throw new Error('Blocked key'); },
        getItem() { throw new Error('Blocked read'); }, setItem() { throw new Error('Blocked write'); }, removeItem() { throw new Error('Blocked delete'); } };
    const journal = createPresetEditorJournal(storage), drafts = createPromptDraftStore(storage), fixture = createPresetFixture({ journal });
    for (const call of [() => journal.put(op), () => journal.get(op.account, op.id), () => journal.list(op.account)]) assert.throws(call, { code: 'PRESET_RECEIPT_UNAVAILABLE' });
    for (const call of [() => drafts.read(identity), () => drafts.write(draft), () => drafts.remove(identity)]) assert.throws(call, { code: 'PRESET_DRAFT_UNAVAILABLE' });
    assert.equal((await fixture.bridge.presetEditorState()).capabilities.namedWrite, false);
    await assert.rejects(fixture.bridge.presetEditorSave({ account: identity.account, name: identity.name }), { code: 'PRESET_RECEIPT_UNAVAILABLE' }); assert.equal(fixture.counters().writes, 0);
});
test('write-only storage denial still allows viewing and rejects receipt before network', async () => {
    const storage = memoryStorage(); storage.setItem = () => { throw new Error('Quota exceeded'); };
    const fixture = createPresetFixture({ storage }); assert.equal((await fixture.bridge.presetEditorState()).name, 'Original');
    await assert.rejects(fixture.bridge.presetEditorSave({ account: identity.account, name: identity.name }), { code: 'PRESET_RECEIPT_UNAVAILABLE' }); assert.equal(fixture.counters().writes, 0);
});
