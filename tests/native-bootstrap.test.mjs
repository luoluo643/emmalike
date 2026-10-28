import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installNativeSettleBootstrap as install } from '../bridge-native-bootstrap.js';
import { ST119_RENDER_EVENT_KEYS } from '../bridge-native-settle.js';

class ReplayEmitter extends EventEmitter {
    emitted = new Set();
    on(name, listener) { super.on(name, listener); if (this.emitted.has(name)) listener(); return this; }
    emit(name, ...args) { const result = super.emit(name, ...args); this.emitted.add(name); return result; }
}
function fixture() {
    const events = new ReplayEmitter(), doc = new EventTarget(), win = new EventTarget();
    const context = { chat: [], getCurrentChatId: () => undefined }, manager = {
        tryGenerate() { return Promise.resolve(); }, renderDebounced() {}, render() {}, saveServiceSettings() {},
    };
    Object.assign(win, { document: doc, frameElement: { dataset: { tavernLite: 'engine' } }, SillyTavern: { getContext: () => context } });
    doc.defaultView = win;
    const st = { eventSource: events, event_types: Object.fromEntries([...ST119_RENDER_EVENT_KEYS, 'APP_READY', 'APP_INITIALIZED'].map(key => [key, key])),
        displayVersion: "SillyTavern 1.19.0 'release' (fixture)", characters: [], this_chid: undefined, is_send_press: false, isChatSaving: false };
    return { window: win, document: doc, st, openai: { promptManager: manager }, groups: { selected_group: null, is_group_generating: false }, context, events };
}
test('early engine entry installs before any source exists and is reused without duplicate listeners', () => {
    const f = fixture(), original = f.openai.promptManager.tryGenerate, state = install(f);
    assert.equal(state.earlyVerified, true); assert.equal(state.document, f.document); assert.equal(state.manager, f.openai.promptManager);
    assert.equal(f.window.TavernLiteNativeSettle, state); assert.notEqual(f.openai.promptManager.tryGenerate, original);
    assert.equal(state.phase.messageCount, 0); assert.equal(state.phase.hasChatId, false);
    assert.equal(install(f), state); assert.equal(f.events.listenerCount('CHAT_CHANGED'), 1);
    assert.equal(f.events.listenerCount('APP_INITIALIZED'), 0); assert.equal(f.events.listenerCount('APP_READY'), 0);
    f.window.dispatchEvent(new Event('pagehide')); assert.equal(f.openai.promptManager.tryGenerate, original);
    assert.equal(state.observer.snapshot().supported, false);
});
test('APP_INITIALIZED and APP_READY replay independently reject late installation even for an empty account', () => {
    for (const event of ['APP_INITIALIZED', 'APP_READY']) {
        const f = fixture(), original = f.openai.promptManager.tryGenerate; f.events.emit(event);
        const state = install(f); assert.equal(state.earlyVerified, false); assert.equal(state.errorCode, 'NATIVE_BOOTSTRAP_LATE');
        assert.equal(f.openai.promptManager.tryGenerate, original); assert.equal(f.events.listenerCount('CHAT_CHANGED'), 0);
    }
});
test('chat identity or message content count rejects uncovered bootstrap even with zero characters', () => {
    const active = fixture(); active.context.getCurrentChatId = () => 'synthetic'; assert.equal(install(active).earlyVerified, false);
    const content = fixture(); content.context.chat.push({ mes: 'SYNTHETIC_MUST_NOT_LEAK' }); const state = install(content);
    assert.equal(state.earlyVerified, false); assert.equal(state.phase.messageCount, 1); assert.equal(JSON.stringify(state.phase).includes('SYNTHETIC'), false);
    const inventory = fixture(); inventory.st.characters.push({}); assert.equal(install(inventory).earlyVerified, false);
    const group = fixture(); group.groups.selected_group = 'fixture'; assert.equal(install(group).earlyVerified, false);
});
test('unknown version or mismatched manager produces a failure record without breaking ordinary app startup', () => {
    const version = fixture(); version.st.displayVersion = 'SillyTavern'; const a = install(version);
    assert.equal(a.earlyVerified, false); assert.equal(a.errorCode, 'NATIVE_BOOTSTRAP_SETUP_FAILED'); assert.equal(a.observer, null);
    const manager = fixture(); delete manager.openai.promptManager.renderDebounced; assert.equal(install(manager).earlyVerified, false);
    const throws = fixture(); const b = install({ ...throws, createBarrier() { throw new Error('fixture'); } }); assert.equal(b.earlyVerified, false);
});
test('non-engine native page retains menu-only behavior and receives no observer or global marker', () => {
    const f = fixture(), original = f.openai.promptManager.tryGenerate; f.window.frameElement = null;
    assert.equal(install(f), null); assert.equal(f.window.TavernLiteNativeSettle, undefined); assert.equal(f.openai.promptManager.tryGenerate, original);
});
