import { createNativeSettleBarrier, ST119_RENDER_QUIET_MS } from './bridge-native-settle.js';
import { isTauriTavern, ttSillyTavernVersion } from './src/tt-host.js';

const installed = new WeakMap();
const GLOBAL = 'TavernLiteNativeSettle';

/** Called at extension-module top level, while native getSettings is awaiting
 * extension activation and BEFORE getCharacters/initRossMods/auto-load-chat.
 * Existing native modules must already be evaluated; no requests or settings edits.
 *
 * `late`: TT 酒馆 (src/tt-host.js) activates extensions only after its app is ready, so there is no early moment. The
 * observer is then installed on TT's page as soon as the module runs and reports lateVerified instead of
 * earlyVerified: background work already running when it was installed cannot be seen, so it only counts the page as
 * settled after a longer quiet time (LATE_QUIET_MS) with nothing in flight that it saw start.
 */
export const LATE_QUIET_MS = 3000;
export function installNativeSettleBootstrap({ window: win, document: doc, st, openai, groups,
    createBarrier = createNativeSettleBarrier, late = false } = {}) {
    try {
        if (late ? !isTauriTavern(win) || win.frameElement : win?.frameElement?.dataset?.tavernLite !== 'engine') return null;
    } catch { return null; }
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
        if (!late && (phase.appInitializedAlready || phase.appReadyAlready || phase.hasChatId || phase.messageCount !== 0 ||
            phase.characterCount !== 0 || st.this_chid !== undefined || groups.selected_group != null)) {
            throw Object.assign(new Error(), { code: 'NATIVE_BOOTSTRAP_LATE' });
        }
        // firstLoadInit awaits getClientVersion BEFORE getSettings activates us.
        // Unknown displayVersion here represents a real failed/unverified native
        // version read, not an expected initialization placeholder to poll past.
        observer = createBarrier({ version: () => late ? ttSillyTavernVersion(st.CLIENT_VERSION) : st.displayVersion, promptManager: manager,
            getPromptManager: () => openai.promptManager, eventSource: events, eventTypes: types, eventTarget: doc,
            quietMs: late ? Math.max(LATE_QUIET_MS, ST119_RENDER_QUIET_MS) : ST119_RENDER_QUIET_MS,
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
    const lateVerified = late && earlyVerified;
    if (late) earlyVerified = false;
    const state = Object.freeze({ schemaVersion: 1, document: doc, manager, earlyVerified, lateVerified, late, observer, errorCode,
        phase: Object.freeze(phase) });
    if (doc && typeof doc === 'object') installed.set(doc, state);
    try {
        // Do not replace another script's object or a stale same-window identity.
        if (win[GLOBAL] === undefined) Object.defineProperty(win, GLOBAL, { value: state, enumerable: false, configurable: false, writable: false });
    } catch { observer?.dispose?.(); }
    if (observer) win.addEventListener('pagehide', () => observer.dispose(), { once: true });
    return state;
}
