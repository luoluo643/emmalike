import test from 'node:test'; import assert from 'node:assert/strict';
import { overlayPresetDocument, mergePresetDocument, presetChanges, makePromptDraft, refreshPromptDraft, applySavedPromptDraft, createPromptDraftStore, canSubmitPresetKey, presetSearch, validatePresetName } from '../src/preset-editor-model.js';
import { seedPreset, memoryStorage } from './preset-editor-fixture.js';
test('native export overlay preserves unknown top-level and prompt fields without resurrecting deleted prompts', () => {
    const base = seedPreset(), native = { temperature: 1, prompts: [{ identifier: 'main', content: 'new' }] }, result = overlayPresetDocument(base, native);
    assert.equal(result.importedUnknown.preserve, 'synthetic value'); assert.equal(result.prompts[0].extensionUnknown.keep, 17); assert.equal(result.prompts.length, 1); assert.equal(base.temperature, .7);
});
test('three-way merge retains unrelated remote fields and merges prompt identifiers', () => {
    const base = seedPreset(), mine = structuredClone(base), remote = structuredClone(base); mine.prompts[0].content = 'mine'; remote.prompts[1].content = 'remote'; remote.temperature = 1.1;
    const result = mergePresetDocument(base, mine, remote); assert.equal(result.kind, 'merged'); assert.equal(result.snapshot.prompts[0].content, 'mine'); assert.equal(result.snapshot.prompts[1].content, 'remote'); assert.equal(result.snapshot.temperature, 1.1);
});
test('field conflict choices are bound to displayed remote value and invalidated by a new edit', () => {
    const base = seedPreset(), mine = { ...base, temperature: 1 }, remote = { ...base, temperature: 1.4 };
    const result = mergePresetDocument(base, mine, remote); assert.equal(result.conflicts.length, 1); const key = result.conflicts[0].key;
    assert.equal(mergePresetDocument(base, mine, remote, { [key]: { take: 'mine', server: 1.4 } }).snapshot.temperature, 1);
    assert.equal(mergePresetDocument(base, mine, { ...remote, temperature: 1.5 }, { [key]: { take: 'mine', server: 1.4 } }).kind, 'conflict');
});
test('semantic field changes count values once and distinguish reorder', () => {
    const base = seedPreset(), mine = structuredClone(base); mine.prompts[0].content = 'one'; mine.temperature = 1;
    assert.equal(presetChanges(base, mine).length, 2); mine.temperature = base.temperature; assert.equal(presetChanges(base, mine).length, 1);
    mine.prompts.reverse(); assert.ok(presetChanges(base, mine).some(x => x.path.at(-1) === '$order'));
});
test('saved snapshot advances base without clearing later input, survives storage reload and switch epoch', () => {
    const storage = memoryStorage(), store = createPromptDraftStore(storage), origin = { account: 'a', name: 'Original', epoch: 4 }, draft = makePromptDraft(origin, seedPreset().prompts[0]);
    const submitted = { ...draft, text: 'submitted', revision: 1 }, later = { ...submitted, text: 'later', revision: 2 };
    const saved = applySavedPromptDraft(later, submitted, 'submitted'); store.write(saved);
    const restored = createPromptDraftStore(storage).read({ ...origin, epoch: 9, identifier: 'main' }); assert.equal(restored.text, 'later'); assert.equal(restored.base, 'submitted'); assert.equal(restored.openedEpoch, 4);
    assert.equal(store.read({ account: 'other', name: 'Original', identifier: 'main' }), null);
});
test('clean drafts follow remote while dirty drafts retain conflict and opening restore baseline', () => {
    const draft = makePromptDraft({ account: 'a', name: 'n' }, seedPreset().prompts[0]); assert.equal(refreshPromptDraft(draft, 'remote').text, 'remote');
    const dirty = refreshPromptDraft({ ...draft, text: 'mine' }, 'remote'); assert.equal(dirty.text, 'mine'); assert.equal(dirty.conflict.server, 'remote'); assert.equal(dirty.opened, 'Original main body');
});
test('strict draft storage failure is explicit and corrupt or wrong-owner data is not adopted', () => {
    const storage = memoryStorage(), store = createPromptDraftStore(storage), draft = { ...makePromptDraft({ account: 'a', name: 'n' }, seedPreset().prompts[0]), text: 'unapplied' }; store.write(draft);
    storage.setItem(storage.key(0), JSON.stringify({ ...draft, account: 'b' })); assert.throws(() => store.read(draft), { code: 'PRESET_DRAFT_UNAVAILABLE' });
    storage.setItem = () => { throw new Error('quota'); }; assert.throws(() => store.write(draft), { code: 'PRESET_DRAFT_UNAVAILABLE' });
});
test('search includes hidden prompt content; all custom submit keys guard composition', () => {
    assert.equal(presetSearch(seedPreset().prompts[1], 'advanced_needle').hits[0].label, '正文');
    assert.equal(canSubmitPresetKey({ key: 'Enter', ctrlKey: true, isComposing: true }), false);
    assert.equal(canSubmitPresetKey({ key: 'Enter', metaKey: true, keyCode: 229 }), false);
    assert.equal(canSubmitPresetKey({ key: 'Enter', ctrlKey: true }), true);
    for (const name of ['../x', ' x', 'nul', 'x/y', '']) assert.throws(() => validatePresetName(name));
});
