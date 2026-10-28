// Owns the hidden full-app page. Everything the shell asks of SillyTavern goes through the bridge injected into it
// (bridge.js); this module only manages the page's lifecycle and surfaces dialogs the user has to answer.
const READY_TIMEOUT_MS = 240000;
const BRIDGE_TIMEOUT_MS = 20000;
// A dropped connection while the full app loads usually leaves it waiting forever on what it was fetching. After a
// network failure the load gets this long to finish anyway before the reader is told and offered a retry.
const NETWORK_GRACE_MS = 15000;
export const NETWORK_FAILURE = '网络断了，没加载完';
const BRIDGE_URL = new URL('../bridge.js', location.href).href;
// The official releases the browser tests pass on; another version still works but shows 未在此版本验证.
export const TESTED_VERSIONS = ['1.16.0', '1.17.0', '1.18.0', '1.19.0'];
// A git install reports its branch and commit after the number ("1.19.0 'release' (06bde93)"); only x.y.z is compared.
export function isTestedVersion(version) {
    const number = /^(?:SillyTavern\s+)?(\d+\.\d+\.\d+)(?:$|[\s+-])/.exec(String(version ?? '').trim())?.[1];
    return !!number && TESTED_VERSIONS.includes(number);
}

const listeners = new Set();
let iframe;
let bridge;
let state = 'idle';
let failure = '';
let pollTimer;
let earlyTimer;
let startedAt = 0;
let deadline = 0;
let attempt;
let unsubscribe;
let phase = null;
// Time this load spent with the shell hidden (phone locked, another app in front): the page is paused then, so it
// says nothing about how long loading takes on this device.
let hiddenMs = 0;
let hiddenSince = 0;
// When this load first saw the network fail (a same-site request or script that could not be fetched, or the
// device going offline); 0 while none has.
let networkTroubleAt = 0;

const LOAD_MS_KEY = 'tavern-lite:engine-load-ms';
const MODE_KEY = 'tavern-lite:engine-mode';
const SKIP_KEY = 'tavern-lite:engine-skip-extensions';
// Tavern Lite's own folder (…/scripts/extensions/<name>/bridge.js): never skipped, or the shell loses the app.
const OWN_EXTENSION = decodeURIComponent(new URL('./', BRIDGE_URL).pathname)
    .replace(/^\/scripts\/extensions\//, '').replace(/\/$/, '');

// When the full app (about 3 MB, several hundred requests) loads. Saved per device: data plans differ by device.
export const ENGINE_MODES = {
    auto: { label: '打开就准备', hint: '推荐。打开轻酒馆就在后台准备，发送最快' },
    input: { label: '开始输入时', hint: '省流量。只读不写时不加载；阅读时显示简化排版' },
    manual: { label: '手动', hint: '只在你点“现在启动”或使用需要它的功能时加载' },
};
const NEEDS = { auto: ['open', 'input', 'action'], input: ['input', 'action'], manual: ['action'] };

export function engineMode() {
    try {
        const mode = localStorage.getItem(MODE_KEY);
        return ENGINE_MODES[mode] ? mode : 'auto';
    } catch {
        return 'auto';
    }
}

export function setEngineMode(mode) {
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* storage unavailable */ }
    emit('mode', mode);
    if (NEEDS[mode].includes('open')) startEngine();
}

/**
 * Starts the full app when the device's loading mode allows it for this reason:
 * 'open' (a page was opened), 'input' (the user started typing), 'action' (a feature that needs it was used).
 */
export function requestEngine(reason) {
    if (NEEDS[engineMode()].includes(reason)) startEngine();
}
export const PHASES = { download: '下载', init: '初始化', connect: '接入' };

/** Tavern Lite's own extension name, as SillyTavern lists it. */
export function ownExtension() {
    return OWN_EXTENSION;
}

/**
 * Extensions this device's lite shell does not load in the full app (saved per device: phones are the slow ones).
 * The account's own switches are untouched; the original interface loads everything as before.
 */
export function skippedExtensions() {
    try {
        const list = JSON.parse(localStorage.getItem(SKIP_KEY) || '[]');
        return Array.isArray(list) ? [...new Set(list.filter(name => typeof name === 'string' && name && name !== OWN_EXTENSION))] : [];
    } catch {
        return [];
    }
}

/** Takes effect the next time the full app loads (see restartEngine). */
export function setSkippedExtensions(names) {
    const list = [...new Set((names ?? []).filter(name => typeof name === 'string' && name && name !== OWN_EXTENSION))];
    try {
        if (list.length) localStorage.setItem(SKIP_KEY, JSON.stringify(list));
        else localStorage.removeItem(SKIP_KEY);
    } catch { /* storage unavailable */ }
    emit('skip', list);
    return list;
}

/** The account's disabled extensions as the full app holds them, or null before it is ready. */
export function accountDisabledExtensions() {
    if (state !== 'ready') return null;
    try {
        const list = nativeContext()?.extensionSettings?.disabledExtensions;
        return Array.isArray(list) ? [...list] : [];
    } catch {
        return null;
    }
}

function emit(type, detail) {
    for (const fn of listeners) {
        try { fn(type, detail); } catch (error) { console.error(error); }
    }
}

function setState(next, reason = '') {
    if (state === 'loading' && next !== 'loading' && next !== 'ready') rememberUnfinishedLoad();
    state = next;
    failure = reason;
    if (next !== 'loading') removeReadyListener(attempt);
    applyOverlay();
    emit('state', next);
}

export function onEngine(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function engineState() {
    return state;
}

export function engineFailure() {
    return failure;
}

function setPhase(next) {
    if (phase === next) return;
    phase = next;
    emit('phase', next);
}

function expectedLoadMs() {
    try { return Number(localStorage.getItem(LOAD_MS_KEY)) || 0; } catch { return 0; }
}

function loadingMs() {
    if (!startedAt) return 0;
    const now = Date.now();
    return Math.max(0, now - startedAt - hiddenMs - (hiddenSince ? now - hiddenSince : 0));
}

/**
 * Loading progress for the status bar: `elapsedMs` is how long the reader has waited, `loadingMs` the part of it the
 * shell was on screen, `expectedMs` how long loads took on this device lately.
 */
export function engineProgress() {
    return { phase, elapsedMs: startedAt ? Date.now() - startedAt : 0, loadingMs: loadingMs(), expectedMs: expectedLoadMs() };
}

function formatWait(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60), rest = seconds % 60;
    return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

/** The status bar's words: a countdown while it is honest, then how long the reader has been waiting. */
export function loadingText({ elapsedMs, loadingMs: shownMs, expectedMs }) {
    const remaining = expectedMs > 0 ? Math.round((expectedMs - shownMs) / 1000) : 0;
    if (remaining >= 1) return `正在准备，约 ${remaining} 秒`;
    // Past the estimate (or with none yet, after a while): no countdown, only the real wait. Kept short so the
    // line still fits a 320px screen with the page's own note after it.
    return expectedMs > 0 || elapsedMs >= 10000 ? `正在准备，已等 ${formatWait(elapsedMs)}` : '正在准备';
}

function rememberLoadTime(ms) {
    ms = Math.min(ms, READY_TIMEOUT_MS);
    try {
        const previous = Number(localStorage.getItem(LOAD_MS_KEY)) || ms;
        localStorage.setItem(LOAD_MS_KEY, String(Math.round(previous * 0.5 + ms * 0.5)));
    } catch { /* storage unavailable */ }
}

// A load that ends without being ready (failed, restarted, the page closed or reloaded) after running past the
// expected time took at least that long; leaving it out would keep the estimate short and the countdown wrong.
// One given up early says nothing either way.
function rememberUnfinishedLoad() {
    const ms = loadingMs();
    if (ms > expectedLoadMs()) rememberLoadTime(ms);
}

export function getBridge() {
    return state === 'ready' ? bridge : null;
}

/**
 * The bridge once the full app is ready, asking it to load if it is not: a tap made while it prepares is carried out
 * when it is ready instead of being dropped. Rejects if loading fails.
 */
export function whenBridge() {
    if (getBridge()) return Promise.resolve(getBridge());
    requestEngine('action');
    return new Promise((resolve, reject) => {
        const off = onEngine((type, detail) => {
            if (type !== 'state') return;
            if (detail === 'ready' && getBridge()) { off(); resolve(getBridge()); }
            else if (detail === 'failed') { off(); reject(new Error(engineFailure() || '原版界面没准备好，刷新页面再试')); }
        });
    });
}

export function isGenerating() {
    return !!bridge?.isGenerating();
}

export function engineInfo() {
    if (!bridge) return null;
    const version = bridge.version();
    return { version, tested: isTestedVersion(version), capabilities: bridge.capabilities };
}

function nativeWindow() {
    return iframe?.contentWindow;
}

/** The full app's window, for frontend cards that call its helper API (see cards.js). */
export function engineWindow() {
    return state === 'ready' ? nativeWindow() : undefined;
}

function nativeContext(win = nativeWindow()) {
    try {
        return win?.SillyTavern?.getContext?.();
    } catch {
        // getContext() throws while the full app's modules are still initializing.
        return undefined;
    }
}

function removeReadyListener(run) {
    if (!run?.listening) return;
    const { emitter, eventName } = run.listening;
    run.listening = null;
    emitter.removeListener(eventName, run.listener);
}

// A WindowProxy can survive a document navigation. Read the current document and
// emitter as well as the iframe identity; never reuse a previous page's ready replay.
function currentBinding(run) {
    if (!run || run !== attempt || run.frame !== iframe || !run.frame.isConnected) return null;
    try {
        const win = run.frame.contentWindow;
        const document = run.frame.contentDocument;
        const ctx = nativeContext(win);
        const emitter = ctx?.eventSource, eventName = ctx?.eventTypes?.APP_READY;
        if (!document || !eventName || typeof emitter?.on !== 'function' || typeof emitter?.removeListener !== 'function') return null;
        return { win, document, emitter, eventName };
    } catch {
        return null;
    }
}

function sameBinding(left, right) {
    return !!left && !!right && left.win === right.win && left.document === right.document &&
        left.emitter === right.emitter && left.eventName === right.eventName;
}

function currentConnection(run, connection) {
    return state === 'loading' && run.connection === connection && sameBinding(currentBinding(run), connection.binding);
}

function createAttempt(frame) {
    const run = { frame, binding: null, listening: null, connection: null, listener: null };
    // ST 1.19.0 invokes both event snapshots and replays with the emitter as `this`.
    // A removed listener may still be in an old emitter's in-flight snapshot.
    run.listener = function () {
        const binding = run.binding;
        if (state !== 'loading' || run.connection || this !== binding?.emitter || !sameBinding(currentBinding(run), binding)) return;
        const connection = { binding };
        run.connection = connection;
        removeReadyListener(run);
        setPhase('connect');
        connectBridge(run, connection)
            .catch(error => {
                if (currentConnection(run, connection)) setState('failed', String(error?.message ?? error));
            })
            .finally(() => {
                if (run.connection === connection) run.connection = null;
            });
    };
    return run;
}

// Dialogs are watched from the shell because some (the first-run welcome) open before the app is ready.
const DIALOG_SETTLE_MS = 600;
const DIALOG_CONTROLS = 'button, input, textarea, select, .menu_button, [role="button"]';
const dialogFirstSeen = new WeakMap();
const reportedDialogs = new WeakSet();
let dialogWasOpen = false;

function visible(element) {
    return element.offsetWidth > 0 && element.offsetHeight > 0;
}

function needsUser(dialog) {
    return visible(dialog) && [...dialog.querySelectorAll(DIALOG_CONTROLS)].some(visible);
}

// A new account's first start: the app asks, in English, for the user's name. The shell asks that itself on its
// 开始使用 page, so the dialog is answered here with the account's name (changed there later) and never shown.
let firstRunName = '';
let firstRunSeen = false;

export function setFirstRunName(name) {
    firstRunName = String(name ?? '');
}

/** Whether this account just went through the app's first start (the shell then offers its own setup). */
export function wasFirstRun() {
    return firstRunSeen;
}

function answerFirstRun(dialog) {
    if (!dialog.querySelector('.onboarding')) return false;
    const input = dialog.querySelector('.popup-input');
    if (input && firstRunName) {
        input.value = firstRunName;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const ok = dialog.querySelector('.popup-button-ok');
    if (!ok) return false;
    ok.click();
    firstRunSeen = true;
    emit('first-run');
    return true;
}

function watchDialogs() {
    let open = false;
    const now = Date.now();
    for (const dialog of iframe?.contentDocument?.querySelectorAll('dialog[open]') ?? []) {
        if (answerFirstRun(dialog)) continue;
        if (!needsUser(dialog)) continue;
        if (!dialogFirstSeen.has(dialog)) dialogFirstSeen.set(dialog, now);
        if (now - dialogFirstSeen.get(dialog) < DIALOG_SETTLE_MS) continue;
        open = true;
        if (reportedDialogs.has(dialog)) continue;
        reportedDialogs.add(dialog);
        emit('popup');
    }
    if (dialogWasOpen && !open) emit('popup-closed');
    dialogWasOpen = open;
    return open;
}

async function connectBridge(run, connection) {
    if (!currentConnection(run, connection)) return;
    const { win, document: doc } = connection.binding;
    if (!win.TavernLiteBridge) {
        // A transient context read can interrupt a connection while its module is
        // still loading. Reuse that document's one injection when trying again.
        if (![...doc.scripts].some(script => script.src === BRIDGE_URL)) {
            const script = doc.createElement('script');
            script.type = 'module';
            script.src = BRIDGE_URL;
            doc.head.append(script);
        }
        const until = Date.now() + BRIDGE_TIMEOUT_MS;
        while (currentConnection(run, connection) && !win.TavernLiteBridge && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!currentConnection(run, connection)) return;
    bridge = win.TavernLiteBridge;
    if (!bridge) {
        setState('failed', '轻酒馆还不支持这个版本的酒馆，请先用原版界面');
        return;
    }
    unsubscribe?.();
    unsubscribe = bridge.on((type, detail) => {
        if (run !== attempt || run.frame !== iframe || run.frame.contentDocument !== connection.binding.document) return;
        if (type === 'floats') setFloats(detail);
        emit(type, detail);
    });
    bridge.setShellShowing?.(!isNativeVisible());
    setFloats(bridge.floatingLayers?.() ?? []);
    if (!currentConnection(run, connection)) return;
    emit('timing', Date.now() - startedAt);
    if (!currentConnection(run, connection)) return;
    restoreSkipped();
    rememberLoadTime(loadingMs());
    setPhase(null);
    if (!currentConnection(run, connection)) return;
    setState('ready');
}

// While the full app loads, the app itself and two common extensions (Quick Replies, Tavern Helper) each fetch the
// account's settings, which hold every chat completion preset: megabytes each time. The page's fetch is wrapped so
// that during loading the later reads reuse the first answer; a save in between, or any later read, goes to the
// server as usual.
const SETTINGS_GET = /\/api\/settings\/get(?:[?#]|$)/;
const SETTINGS_SAVE = /\/api\/settings\/save(?:[?#]|$)/;
const CHAT_SAVE = /^\/api\/chats\/save(?:[?#]|$)/;
const CHAT_GET = /^\/api\/chats\/get(?:[?#]|$)/;
// The page's chat saves and reads: { save, get }(win, send, input, init), see chat-sync.js (set by main.jsx).
let chatRequests = null;
export function routeChatRequests(handlers) {
    chatRequests = handlers;
}
let settingsShared = null;

// Skipping extensions on this device: SillyTavern activates extensions by the account's disabled list right after it
// reads the settings, so the names are added to that list in the settings answer, and taken out of the live list again
// when it reports the extension settings loaded. That is before it allows any save (settingsReady), so the account's
// own switches are what gets saved. A plain-text save before that point is cleaned as a fallback.
let skipRestore = null;

async function skipInSettings(win, response, names) {
    if (!response.ok) return response;
    try {
        const data = await response.clone().json();
        if (typeof data?.settings !== 'string') return response;
        const settings = JSON.parse(data.settings);
        const ext = settings.extension_settings && typeof settings.extension_settings === 'object' ? settings.extension_settings : (settings.extension_settings = {});
        const disabled = Array.isArray(ext.disabledExtensions) ? ext.disabledExtensions : (ext.disabledExtensions = []);
        const added = names.filter(name => !disabled.includes(name));
        if (!added.length) return response;
        disabled.push(...added);
        data.settings = JSON.stringify(settings);
        armSkipRestore(win, added);
        const headers = [...response.headers].filter(([key]) => !/^content-(length|encoding)$/i.test(key));
        return new win.Response(JSON.stringify(data), { status: response.status, statusText: response.statusText, headers });
    } catch {
        return response;
    }
}

function armSkipRestore(win, added) {
    const run = skipRestore = { win, added, restored: false };
    try {
        const ctx = nativeContext(win);
        const event = ctx?.eventTypes?.EXTENSION_SETTINGS_LOADED;
        if (!event || typeof ctx.eventSource?.on !== 'function') return;
        const listener = () => {
            ctx.eventSource.removeListener?.(event, listener);
            restoreSkipped(run);
        };
        ctx.eventSource.on(event, listener);
    } catch { /* restored when the app is ready */ }
}

function restoreSkipped(run = skipRestore) {
    if (!run || run.restored) return;
    run.restored = true;
    try {
        const list = nativeContext(run.win)?.extensionSettings?.disabledExtensions;
        if (!Array.isArray(list)) return;
        for (const name of run.added) {
            const index = list.lastIndexOf(name);
            if (index >= 0) list.splice(index, 1);
        }
    } catch { /* the page is gone */ }
}

function withoutSkipped(win, init) {
    const run = skipRestore;
    if (!run || run.restored || run.win !== win || typeof init?.body !== 'string') return init;
    try {
        const payload = JSON.parse(init.body);
        const list = payload?.extension_settings?.disabledExtensions;
        if (!Array.isArray(list)) return init;
        payload.extension_settings.disabledExtensions = list.filter(name => !run.added.includes(name));
        return { ...init, body: JSON.stringify(payload) };
    } catch {
        return init;
    }
}

function shareSettingsRequests(win) {
    if (!win || win.__tavernLiteSettingsShared || win.location.href === 'about:blank') return;
    win.__tavernLiteSettingsShared = true;
    settingsShared = null;
    const original = win.fetch;
    const send = (input, init) => original.call(win, input, init);
    watchLoadNetwork(win);
    win.fetch = function (input, init) {
        const pending = routeRequest.call(this, input, init);
        if (state === 'loading' && sameSite(win, input)) watchLoadRequest(pending);
        return pending;
    };
    function routeRequest(input, init) {
        const url = typeof input === 'string' ? input : String(input?.url ?? input ?? '');
        const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
        // Chats are saved as only what changed, and kept on this device when the network drops (chat-sync.js).
        if (chatRequests && method === 'POST' && typeof input === 'string' && CHAT_SAVE.test(url)) return chatRequests.save(win, send, input, init);
        if (chatRequests && method === 'POST' && typeof input === 'string' && CHAT_GET.test(url)) return chatRequests.get(win, send, input, init);
        if (method === 'POST' && SETTINGS_SAVE.test(url)) {
            settingsShared = null;
            return original.call(this, input, withoutSkipped(win, init));
        }
        if (state !== 'loading' || method !== 'POST' || !SETTINGS_GET.test(url)) return original.call(this, input, init);
        if (settingsShared) {
            return settingsShared.then(saved => saved
                ? new win.Response(saved.body.slice(0), { status: saved.status, statusText: saved.statusText, headers: saved.headers })
                : original.call(this, input, init));
        }
        const skip = skippedExtensions();
        const fetched = original.call(this, input, init);
        const response = skip.length ? fetched.then(r => skipInSettings(win, r, skip)) : fetched;
        settingsShared = response
            .then(async r => r.ok ? { body: await r.clone().arrayBuffer(), status: r.status, statusText: r.statusText, headers: [...r.headers] } : null)
            .catch(() => null);
        return response;
    }
}

// Requests to other sites (an extension's own service) can fail for reasons of their own and are not watched.
function sameSite(win, input) {
    try {
        const url = typeof input === 'string' ? input : String(input?.url ?? input ?? '');
        return new URL(url, win.location.href).origin === win.location.origin;
    } catch {
        return false;
    }
}

// Status codes gateways answer with when the connection to the server broke or timed out.
const NETWORK_STATUS = new Set([408, 502, 503, 504]);

function watchLoadRequest(pending) {
    Promise.resolve(pending).then(
        response => { if (NETWORK_STATUS.has(response?.status)) noteNetworkTrouble(); },
        error => { if (error?.name !== 'AbortError') noteNetworkTrouble(); },
    );
}

// Scripts and styles the page could not download, and the device reporting that it went offline.
function watchLoadNetwork(win) {
    try {
        win.addEventListener('error', event => {
            const element = event.target;
            if (state !== 'loading' || !element || element === win) return;
            const url = element.tagName === 'SCRIPT' ? element.src : element.tagName === 'LINK' ? element.href : '';
            if (url && sameSite(win, url)) noteNetworkTrouble();
        }, true);
        win.addEventListener('offline', noteNetworkTrouble);
    } catch { /* the page is between documents */ }
}

function noteNetworkTrouble() {
    if (state === 'loading' && !networkTroubleAt) networkTroubleAt = Date.now();
}

function tick() {
    try { if (state === 'loading') shareSettingsRequests(nativeWindow()); } catch { /* the page is between documents */ }
    const dialogOpen = watchDialogs();
    if (state !== 'loading') return;
    if (dialogOpen) deadline = Date.now() + READY_TIMEOUT_MS;
    const run = attempt;
    const binding = currentBinding(run);
    if (!sameBinding(binding, run?.binding)) {
        removeReadyListener(run);
        if (run) { run.binding = binding; run.connection = null; }
    }
    if (binding && !run.connection) {
        setPhase('init');
        if (state !== 'loading' || !sameBinding(currentBinding(run), binding)) return;
        // APP_READY replays after dispatch finishes, but a first subscription made
        // during an awaited listener can miss its snapshot. Re-arm the same callback.
        removeReadyListener(run);
        run.listening = binding;
        binding.emitter.on(binding.eventName, run.listener);
    }
    if (state === 'loading' && networkTroubleAt && Date.now() - networkTroubleAt > NETWORK_GRACE_MS) {
        setState('failed', NETWORK_FAILURE);
        return;
    }
    if (state === 'loading' && Date.now() > deadline) setState('failed', '准备太久了，可能是网络慢');
}

export function startEngine() {
    if (state === 'loading' || state === 'ready') return;
    removeReadyListener(attempt);
    attempt = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    bridge = undefined;
    iframe?.remove();
    clearInterval(pollTimer);
    clearInterval(earlyTimer);
    floats = [];
    iframe = document.createElement('iframe');
    iframe.className = 'engine';
    iframe.title = '酒馆原版界面';
    iframe.dataset.tavernLite = 'engine';
    // Any query string stops the full app's send button from working (SillyTavern 1.19.0), so only a hash is used.
    iframe.src = '/#workspace-off';
    startedAt = Date.now();
    skipRestore = null;
    networkTroubleAt = 0;
    hiddenMs = 0;
    hiddenSince = document.visibilityState === 'hidden' ? startedAt : 0;
    deadline = startedAt + READY_TIMEOUT_MS;
    const run = attempt = createAttempt(iframe);
    setPhase('download');
    setState('loading');
    document.body.append(iframe);
    pollTimer = setInterval(tick, 300);
    // The page's fetch has to be wrapped before its scripts run: check often until it is.
    const early = earlyTimer = setInterval(() => {
        if (run !== attempt || state !== 'loading') { clearInterval(early); return; }
        try { shareSettingsRequests(run.frame.contentWindow); } catch { /* the page is between documents */ }
        if (run.frame.contentWindow?.__tavernLiteSettingsShared) clearInterval(early);
    }, 20);
}

/** Loads the full app again from scratch, e.g. after logging in again (its page still has the old session). */
export function restartEngine() {
    if (state === 'idle') return;
    setState('idle');
    startEngine();
}

export function showNative(visibleNow) {
    iframe?.classList.toggle('visible', visibleNow);
    // Frontend cards run in the shell while it is on screen; the full app gets its own copies back while shown.
    getBridge()?.setShellShowing?.(!visibleNow);
    applyOverlay();
}

// Floating layers (see the bridge): while the shell is on screen and the full app has any, its page is laid over
// the shell, transparent, and cut down to their rectangles, so only they show and only they take touches.
let floats = [];
const FLOAT_MARGIN = 2;

function setFloats(rects) {
    floats = Array.isArray(rects) ? rects : [];
    applyOverlay();
}

function applyOverlay() {
    if (!iframe) return;
    const on = floats.length > 0 && !iframe.classList.contains('visible') && state === 'ready';
    iframe.classList.toggle('overlay', on);
    iframe.style.clipPath = on
        ? `path('${floats.map(r => {
            const x = r.x - FLOAT_MARGIN, y = r.y - FLOAT_MARGIN, w = r.width + 2 * FLOAT_MARGIN, h = r.height + 2 * FLOAT_MARGIN;
            return `M${x} ${y}h${w}v${h}h${-w}z`;
        }).join('')}')`
        : '';
    // Both sides need the same colour scheme, or the browser paints the frame opaque.
    const scheme = on ? getComputedStyle(document.documentElement).colorScheme || 'normal' : '';
    iframe.style.colorScheme = scheme;
    getBridge()?.setOverlay?.(on, scheme);
}

addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden';
    if (hidden && !hiddenSince) hiddenSince = Date.now();
    if (!hidden && hiddenSince) {
        hiddenMs += Date.now() - hiddenSince;
        hiddenSince = 0;
    }
});

addEventListener('offline', noteNetworkTrouble);

addEventListener('pagehide', () => {
    if (state === 'loading') rememberUnfinishedLoad();
});

// Taps on the shell reach floating layers that react to taps on the page.
addEventListener('pointerdown', event => {
    if (iframe?.classList.contains('overlay')) getBridge()?.pointerAt?.(event.clientX, event.clientY);
}, true);

export function isNativeVisible() {
    return !!iframe?.classList.contains('visible');
}
