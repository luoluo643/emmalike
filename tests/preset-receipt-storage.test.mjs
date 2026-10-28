// Settled preset save receipts do not pile up in device storage: a long preset made each one hundreds of KB, the
// storage filled after a few saves, and then the next save stopped ("这次没存") and world book drafts went read-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresetFixture, memoryStorage, seedPreset } from './preset-editor-fixture.js';
import { PRESET_RECEIPT_PREFIX, pruneSettledPresetReceipts } from '../src/preset-editor-model.js';
import { createWorldDraftStore } from '../src/world-editor-drafts.js';

const input = extra => ({ account: 'preset-test', name: 'Original', ...extra });
const receipts = storage => [...Array(storage.length)].map((_, i) => storage.key(i)).filter(k => k.startsWith(PRESET_RECEIPT_PREFIX));
// Like a browser's: a write that would take the total past `limit` characters throws.
function limitedStorage(limit) {
    const inner = memoryStorage(), size = () => [...Array(inner.length)].reduce((n, _, i) => n + inner.key(i).length + inner.getItem(inner.key(i)).length, 0);
    return { ...inner, get length() { return inner.length; },
        setItem(k, v) { const old = inner.getItem(k); if (size() - (old === null ? 0 : k.length + old.length) + k.length + String(v).length > limit) throw new DOMException('full', 'QuotaExceededError'); inner.setItem(k, v); } };
}
// What earlier versions left behind after each confirmed save: the whole preset four times over.
const oldConfirmed = (id, filler) => [`${PRESET_RECEIPT_PREFIX}${JSON.stringify(['preset-test', id])}`, JSON.stringify({ version: 2, id, account: 'preset-test', apiId: 'openai', name: 'Original',
    mode: 'save', stage: 'confirmed', writeOutcome: 'confirmed', revision: 3, expected: filler, before: filler, sourceBefore: filler, runtimeSnapshot: filler })];

test('saving again keeps only the receipt of the latest save, and a receipt holds no unused copies', async () => {
    const f = createPresetFixture(); await f.bridge.presetEditorState();
    for (const temperature of [1.1, 1.2, 1.3]) { f.externalRuntime({ temperature }); assert.equal((await f.bridge.presetEditorSave(input())).kind, 'confirmed'); }
    const left = receipts(f.storage);
    assert.equal(left.length, 1);
    const receipt = JSON.parse(f.storage.getItem(left[0]));
    assert.equal(receipt.expected.temperature, 1.3); assert.equal('sourceBefore' in receipt, false); assert.equal('runtimeSnapshot' in receipt, false);
    // Saving with nothing new still says saved.
    assert.equal((await f.bridge.presetEditorSave(input())).kind, 'confirmed');
});

test('a storage full of old settled receipts is cleared, and the save goes through', async () => {
    const storage = limitedStorage(60000), filler = { prompts: [{ identifier: 'main', content: 'x'.repeat(3000) }] };
    for (let i = 0; ; i++) { const [k, v] = oldConfirmed(`old-${i}`, filler); try { storage.setItem(k, v); } catch { break; } }
    assert.ok(receipts(storage).length >= 3);
    const f = createPresetFixture({ storage }); await f.bridge.presetEditorState();
    for (const temperature of [1.1, 1.2]) { f.externalRuntime({ temperature }); assert.equal((await f.bridge.presetEditorSave(input())).kind, 'confirmed'); }
    assert.equal(f.files.get('Original').temperature, 1.2);
    assert.equal(receipts(storage).length, 1);
});

test('unknown, user-decided and copy-not-yet-used receipts are never pruned', () => {
    const storage = memoryStorage(), put = (id, extra) => storage.setItem(`${PRESET_RECEIPT_PREFIX}${JSON.stringify(['a', id])}`, JSON.stringify({ version: 2, id, account: 'a', name: 'P', expected: seedPreset(), ...extra }));
    put('unknown', { stage: 'armed', writeOutcome: 'unknown' });
    put('copy', { mode: 'copy', stage: 'saved-not-applied', writeOutcome: 'confirmed' });
    put('decided', { stage: 'unconfirmed', writeOutcome: 'unknown', userDecision: { acknowledgement: 'late-write-can-overwrite-v1', operationId: 'decided' } });
    put('legacy', { version: 1, stage: 'armed' });
    put('done', { stage: 'confirmed', writeOutcome: 'confirmed' });
    put('none', { stage: 'not-submitted', writeOutcome: 'not-submitted', notSubmittedProof: { kind: 'write-not-invoked' } });
    storage.setItem('tavern-lite:preset-draft:x', '{}'); storage.setItem(`${PRESET_RECEIPT_PREFIX}broken`, '{');
    assert.equal(pruneSettledPresetReceipts(storage), 2);
    assert.deepEqual(receipts(storage).map(k => k.includes('"') ? JSON.parse(k.slice(PRESET_RECEIPT_PREFIX.length))[1] : k.slice(PRESET_RECEIPT_PREFIX.length)).sort(), ['broken', 'copy', 'decided', 'legacy', 'unknown']);
    assert.equal(storage.getItem('tavern-lite:preset-draft:x'), '{}');
});

test('a world book draft gets room from old settled receipts, and a later success clears the read-only error', () => {
    const storage = limitedStorage(30000), filler = { prompts: [{ identifier: 'main', content: 'x'.repeat(3000) }] };
    for (let i = 0; ; i++) { const [k, v] = oldConfirmed(`old-${i}`, filler); try { storage.setItem(k, v); } catch { break; } }
    const drafts = createWorldDraftStore({ storage: () => storage });
    assert.equal(drafts.set('scope', { revision: 1, form: { content: 'y'.repeat(14000) } }), true);
    assert.equal(drafts.error, '');
    assert.equal(receipts(storage).length, 0);
    // Full with nothing to clear: refused and said; once there is room again, the error goes.
    const inner = memoryStorage(); let full = true;
    const flaky = { get length() { return inner.length; }, key: inner.key, getItem: inner.getItem, removeItem: inner.removeItem,
        setItem(k, v) { if (full) throw new DOMException('full', 'QuotaExceededError'); inner.setItem(k, v); } };
    const store = createWorldDraftStore({ storage: () => flaky });
    assert.equal(store.set('other', { revision: 1 }), false); assert.ok(store.error);
    full = false;
    assert.equal(store.set('other', { revision: 2 }), true); assert.equal(store.error, '');
});
