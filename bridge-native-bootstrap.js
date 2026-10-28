import { createNativeSettleBarrier } from './bridge-native-settle.js';

const installed = new WeakMap();
const GLOBAL = 'TavernLiteNativeSettle';

/** Called at extension-module top level, while native getSettings is awaiting
 * extension activation and BEFORE getCharacters/initRossMods/auto-load-chat.
 * Existing native modules must already be evaluated; no requests or settings edits.
 */
export function installNativeSettleBootstrap({ window: win, document: doc, st, openai, groups,
    createBarrier = createNativeSettleBarrier } = {}) {
    try { if (win?.frameElement?.dataset?.tavernLite !== 'engine') return null; } catch { return null; }
    if (installed.has(doc)) return installed.get(doc);
    let observer = null, earlyVerified = false, errorCode = null;
    const phase = { appInitializedAlready: false, appReadyAlready: false, hasChatId: false, messageCount: null, characterCount: null };
    const manager = openai?.promptManager;
    try {
        if (!doc || doc.defaultView !== win || win.document !== doc || win[GLOBAL] !== undefined) throw Object.assign(new Error(), { code: 'NATIVE_BOOTSTRAP_IDENTITY' });
        const events = st?.eventSource, types = st?.event_types;
        if (typeof events?.on !== 'function' || typeof events?.removeListener !== 'function' || !types?.APP_INITIALIZED || !types?.APP_READY) {
            throw Object.assign(new Error(), { code: 'NATIVE_BOOTSTRAP_EVENTS' });
        }
        // ST1.19's on() synchronously replays completed startup events. Remove
        // exactly these probes immediately; never inspect private emitter maps.
        const initialized = () => { phase.appInitializedAlready = true; };
        const ready = () => { phase.appReadyAlready = true; };
        try {
            events.on(types.APP_INITIALIZED, initialized);
            events.on(types.APP_READY, ready);
        } finally {
            events.removeListener(types.APP_INITIALIZED, initialized);
            events.removeListener(types.APP_READY, ready);
        }
        const ctx = win.SillyTavern?.getContext?.();
        if (typeof ctx?.getCurrentChatId !== 'function' || !Array.isArray(ctx.chat) || !Array.isArray(st.characters) ||
            typeof st.is_send_press !== 'boolean' || typeof st.isChatSaving !== 'boolean' || typeof groups?.is_group_generating !== 'boolean') {
            throw Object.assign(new Error(), { code: 'NATIVE_BOOTSTRAP_CONTEXT' });
        }
        phase.hasChatId = ctx.getCurrentChatId() != null && ctx.getCurrentChatId() !== '';
        phase.messageCount = ctx.chat.length;
        phase.characterCount = st.characters.length;
        if (phase.appInitializedAlready || phase.appReadyAlready || phase.hasChatId || phase.messageCount !== 0 ||
            phase.characterCount !== 0 || st.this_chid !== undefined || groups.selected_group != null) {
            throw Object.assign(new Error(), { code: 'NATIVE_BOOTSTRAP_LATE' });
        }
        // firstLoadInit awaits getClientVersion BEFORE getSettings activates us.
        // Unknown displayVersion here represents a real failed/unverified native
        // version read, not an expected initialization placeholder to poll past.
        observer = createBarrier({ version: () => st.displayVersion, promptManager: manager,
            getPromptManager: () => openai.promptManager, eventSource: events, eventTypes: types, eventTarget: doc,
            isNativeIdle: () => {
                const swipe = win.SillyTavern.getContext().swipe?.state?.();
                return !st.is_send_press && !st.isChatSaving && !groups.is_group_generating && (swipe === undefined || swipe === 'none');
            } });
        if (!observer?.snapshot?.().supported) throw Object.assign(new Error(), { code: 'NATIVE_BOOTSTRAP_SETUP_FAILED' });
        earlyVerified = true;
    } catch (cause) {
        errorCode = cause?.code || 'NATIVE_BOOTSTRAP_SETUP_FAILED';
        observer?.dispose?.(); observer = null;
    }
    const state = Object.freeze({ schemaVersion: 1, document: doc, manager, earlyVerified, observer, errorCode,
        phase: Object.freeze(phase) });
    if (doc && typeof doc === 'object') installed.set(doc, state);
    try {
        // Do not replace another script's object or a stale same-window identity.
        if (win[GLOBAL] === undefined) Object.defineProperty(win, GLOBAL, { value: state, enumerable: false, configurable: false, writable: false });
    } catch { observer?.dispose?.(); }
    if (observer) win.addEventListener('pagehide', () => observer.dispose(), { once: true });
    return state;
}
