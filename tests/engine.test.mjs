import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../src/engine.js', import.meta.url), 'utf8')).replace(/^export /gm, '');
const READY = 'app_ready';
const SETTINGS_LOADED = 'extension_settings_loaded';
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

// ST 1.19.0's observed contract: emit snapshots listeners, awaits them in order,
// and only then enables replay. The real emitter/browser evidence lives in work/.
class NativeEvents {
    listeners = [];
    seen = new Set();
    replay = false;
    peak = 0;
    other = new Map();
    on(event, fn) {
        if (event === SETTINGS_LOADED) { this.other.set(fn, event); return; }
        assert.equal(event, READY);
        this.seen.add(fn);
        this.listeners.push(fn);
        this.peak = Math.max(this.peak, this.owned());
        if (this.replay) fn.apply(this, []);
    }
    removeListener(event, fn) {
        if (event === SETTINGS_LOADED) { this.other.delete(fn); return; }
        assert.equal(event, READY);
        const index = this.listeners.indexOf(fn);
        if (index >= 0) this.listeners.splice(index, 1);
    }
    fireSettingsLoaded() { for (const fn of [...this.other.keys()]) fn(); }
    prependGate(g) { this.listeners.unshift(() => g.promise); }
    owned() { return this.listeners.filter(fn => this.seen.has(fn)).length; }
    async emit() {
        for (const fn of this.listeners.slice()) await fn.apply(this, []);
        this.replay = true;
    }
}

function harness({ automaticBridge = true, mode = 'auto' } = {}) {
    let now = 1000, nextId = 1;
    const timers = new Map(), frames = [], natives = [], engineEvents = [];
    const storage = new Map([['tavern-lite:engine-mode', mode]]);
    const setTimer = (fn, delay, period, args) => {
        const id = nextId++;
        timers.set(id, { fn, at: now + Number(delay), period, args });
        return id;
    };
    async function advance(ms) {
        const end = now + ms;
        while (true) {
            const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!next) break;
            const [id, timer] = next;
            now = timer.at;
            if (timer.period) timer.at += timer.period; else timers.delete(id);
            timer.fn(...timer.args);
            await flush();
        }
        now = end;
        await flush();
    }
    function native(existingWindow) {
        const events = new NativeEvents();
        const callbacks = new Set();
        const n = { events, scripts: [], dialogs: [], subscribers: 0, unsubscribed: 0, automaticBridge, failContext: false, extensionSettings: {} };
        n.bridge = {
            on(fn) { callbacks.add(fn); n.subscribers++; return () => { callbacks.delete(fn); n.unsubscribed++; }; },
            setShellShowing() {}, setOverlay() {}, floatingLayers: () => [], version: () => '1.19.0',
        };
        n.push = (type, detail) => { for (const fn of callbacks) fn(type, detail); };
        const doc = {
            scripts: n.scripts,
            querySelectorAll: () => n.dialogs,
            createElement: () => ({}),
            head: { append(script) { n.scripts.push(script); if (n.automaticBridge) n.win.TavernLiteBridge = n.bridge; } },
        };
        const win = existingWindow || {};
        Object.assign(win, {
            document: doc, location: { href: 'http://test/#workspace-off' }, fetch: async () => ({ ok: false }),
            SillyTavern: { getContext: () => {
                if (n.failContext) throw new Error('context still initializing');
                return { eventSource: events, eventTypes: { APP_READY: READY, EXTENSION_SETTINGS_LOADED: SETTINGS_LOADED }, extensionSettings: n.extensionSettings };
            } },
        });
        delete win.TavernLiteBridge;
        delete win.__tavernLiteSettingsShared;
        n.win = win;
        n.doc = doc;
        natives.push(n);
        return n;
    }
    const shellListeners = new Map();
    const document = {
        visibilityState: 'visible',
        documentElement: {},
        body: { append(frame) { frame.isConnected = true; } },
        createElement(tag) {
            assert.equal(tag, 'iframe');
            const n = native();
            const classes = new Set();
            const frame = {
                contentWindow: n.win, get contentDocument() { return this.contentWindow.document; },
                dataset: {}, style: {}, isConnected: false,
                classList: { contains: key => classes.has(key), toggle: (key, on) => on ? classes.add(key) : classes.delete(key) },
                remove() { this.isConnected = false; },
            };
            frames.push(frame);
            return frame;
        },
    };
    class ClockDate extends Date { static now() { return now; } }
    const sandbox = {
        console, URL, Promise, Date: ClockDate, Event: class {}, Response,
        location: { href: 'http://test/scripts/extensions/third-party/emmalike/app/' },
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
        document, addEventListener: (type, fn) => shellListeners.set(type, [...(shellListeners.get(type) ?? []), fn]),
        getComputedStyle: () => ({ colorScheme: 'normal' }),
        setTimeout: (fn, ms, ...args) => setTimer(fn, ms, 0, args), clearTimeout: id => timers.delete(id),
        setInterval: (fn, ms, ...args) => setTimer(fn, ms, Number(ms), args), clearInterval: id => timers.delete(id),
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    const api = vm.runInContext('({startEngine,restartEngine,requestEngine,engineState,engineFailure,engineProgress,loadingText,getBridge,onEngine,skippedExtensions,setSkippedExtensions,ownExtension,accountDisabledExtensions,isTestedVersion})', sandbox);
    api.onEngine((type, detail) => engineEvents.push({ type, detail }));
    const shell = (type, visibility) => {
        if (visibility) document.visibilityState = visibility;
        for (const fn of shellListeners.get(type) ?? []) fn({ type });
    };
    return { ...api, advance, frames, natives, timers, storage, engineEvents, shell,
        navigateSameWindow() { return native(frames.at(-1).contentWindow); } };
}

function assertOneConnection(h, n) {
    assert.equal(h.engineState(), 'ready');
    assert.equal(h.getBridge(), n.bridge);
    assert.equal(n.scripts.length, 1);
    assert.equal(n.subscribers, 1);
    assert.equal(n.events.owned(), 0);
    assert.equal(n.events.peak, 1);
    assert.equal(n.events.seen.size, 1);
}

test('native ready before or after subscription connects once and removes its listener', async t => {
    for (const order of ['before', 'after']) await t.test(order, async () => {
        const h = harness(); h.startEngine(); const n = h.natives[0];
        if (order === 'after') await n.events.emit();
        await h.advance(300);
        if (order === 'before') await n.events.emit();
        await flush(); assertOneConnection(h, n);
    });
});

test('first subscription inside an awaited native emission recovers through replay', async () => {
    const h = harness(); h.startEngine(); const n = h.natives[0], g = gate();
    n.events.prependGate(g); const emitting = n.events.emit();
    await h.advance(3300);
    assert.equal(n.events.seen.size, 1); assert.equal(n.events.owned(), 1);
    assert.equal(h.engineState(), 'loading'); assert.equal(n.scripts.length, 0);
    g.release(); await emitting;
    assert.equal(n.scripts.length, 0);
    await h.advance(300); assertOneConnection(h, n);
});

test('a native listener snapshot and repeated rearming cannot connect twice', async () => {
    const h = harness(); h.startEngine(); const n = h.natives[0];
    await h.advance(300); const saved = [...n.events.seen][0], g = gate();
    n.events.prependGate(g); const emitting = n.events.emit();
    await h.advance(1500); assert.equal(n.events.owned(), 1); assert.equal(n.events.seen.size, 1);
    g.release(); await emitting; await flush();
    saved.call(n.events); saved.call(n.events); await h.advance(600);
    assertOneConnection(h, n);
});

test('restarting a ready page ignores the old replay while the new page has not emitted ready', async () => {
    const h = harness(); h.startEngine(); const old = h.natives[0];
    await h.advance(300); const oldListener = [...old.events.seen][0];
    await old.events.emit(); await flush(); assertOneConnection(h, old);
    h.restartEngine(); const next = h.natives[1]; await h.advance(600);
    oldListener.call(old.events); old.push('late-old-event', 'ignored'); await h.advance(300);
    assert.equal(h.engineState(), 'loading'); assert.equal(next.scripts.length, 0);
    assert.equal(old.unsubscribed, 1); assert.equal(old.events.owned(), 0);
    assert(!h.engineEvents.some(x => x.type === 'late-old-event'));
    await next.events.emit(); await flush(); assertOneConnection(h, next);
});

test('the same WindowProxy with a new document/emitter rejects the old snapshot callback', async () => {
    const h = harness(); h.startEngine(); const old = h.natives[0];
    await h.advance(300); const saved = [...old.events.seen][0];
    const next = h.navigateSameWindow(); await h.advance(300);
    assert.equal(next.win, old.win); assert.notEqual(next.doc, old.doc);
    assert.equal(old.events.owned(), 0); assert.equal(next.events.owned(), 1);
    assert.equal([...next.events.seen][0], saved, 'same startup must retain its callback reference');
    saved.call(old.events); await h.advance(300);
    assert.equal(next.scripts.length, 0); assert.equal(h.engineState(), 'loading');
    await next.events.emit(); await flush(); assertOneConnection(h, next);
});

test('an old bridge load settling after restart cannot change the new attempt', async t => {
    for (const late of ['success', 'throw']) await t.test(late, async () => {
        const h = harness({ automaticBridge: false }); h.startEngine(); const old = h.natives[0];
        await h.advance(300); await old.events.emit(); await flush();
        assert.equal(old.scripts.length, 1); h.restartEngine(); const next = h.natives[1];
        if (late === 'success') old.win.TavernLiteBridge = old.bridge;
        else Object.defineProperty(old.win, 'TavernLiteBridge', { get() { throw new Error('late old page error'); } });
        await h.advance(600);
        assert.equal(h.engineState(), 'loading'); assert.equal(next.scripts.length, 0);
        assert.equal(old.subscribers, 0); assert.equal(h.engineEvents.filter(x => x.type === 'timing').length, 0);
        next.automaticBridge = true; await next.events.emit(); await flush(); assertOneConnection(h, next);
    });
});

test('a context temporarily unavailable during bridge load reuses one script injection', async () => {
    const h = harness({ automaticBridge: false }); h.startEngine(); const n = h.natives[0];
    await h.advance(300); await n.events.emit(); await flush();
    n.failContext = true; await h.advance(300); n.failContext = false; await h.advance(300);
    assert.equal(n.scripts.length, 1);
    n.win.TavernLiteBridge = n.bridge; await h.advance(100); assertOneConnection(h, n);
});

test('no native ready event still fails at 240 seconds and leaves no ready listener', async () => {
    const h = harness(); h.startEngine(); const n = h.natives[0];
    await h.advance(240300);
    assert.equal(h.engineState(), 'failed'); assert.match(h.engineFailure(), /准备太久了/);
    assert.equal(n.scripts.length, 0); assert.equal(n.events.owned(), 0);
    await n.events.emit(); await flush(); assert.equal(h.engineState(), 'failed');
});

test('bridge missing after native ready fails after 20 seconds, and late bridge cannot revive it', async () => {
    const h = harness({ automaticBridge: false }); h.startEngine(); const n = h.natives[0];
    await h.advance(300); await n.events.emit(); await h.advance(20000);
    assert.equal(h.engineState(), 'failed'); assert.equal(n.events.owned(), 0);
    n.win.TavernLiteBridge = n.bridge; await h.advance(1000);
    assert.equal(h.engineState(), 'failed'); assert.equal(n.subscribers, 0);
});

test('an open user dialog still extends the native-ready deadline', async () => {
    const h = harness(); h.startEngine(); const n = h.natives[0];
    const visible = { offsetWidth: 10, offsetHeight: 10 };
    n.dialogs.push({ ...visible, querySelector: () => null, querySelectorAll: () => [visible] });
    await h.advance(241000); assert.equal(h.engineState(), 'loading');
    n.dialogs.length = 0; await h.advance(240300); assert.equal(h.engineState(), 'failed');
});

test('engine mode gates are unchanged and restarts leave only the current timers/listener', async () => {
    for (const [mode, reason, allowed] of [
        ['auto', 'open', true], ['auto', 'input', true], ['auto', 'action', true],
        ['input', 'open', false], ['input', 'input', true], ['input', 'action', true],
        ['manual', 'open', false], ['manual', 'input', false], ['manual', 'action', true],
    ]) {
        const h = harness({ mode }); h.restartEngine(); assert.equal(h.frames.length, 0);
        h.requestEngine(reason); assert.equal(h.frames.length, Number(allowed), `${mode}/${reason}`);
    }
    const h = harness(); h.startEngine(); await h.advance(300);
    for (let i = 0; i < 4; i++) { h.restartEngine(); await h.advance(300); }
    assert(h.natives.slice(0, -1).every(n => n.events.owned() === 0));
    assert.equal(h.natives.at(-1).events.owned(), 1);
    assert.equal([...h.timers.values()].filter(x => x.period === 300).length, 1);
    assert.equal([...h.timers.values()].filter(x => x.period === 20).length, 0);
});

const LOAD_MS = 'tavern-lite:engine-load-ms';

test('the status words count down while the estimate holds, then say how long the reader has waited', () => {
    const { loadingText } = harness();
    const at = (elapsedMs, expectedMs, loadingMs = elapsedMs) => loadingText({ elapsedMs, loadingMs, expectedMs });
    assert.equal(at(10000, 30000), '正在准备，约 20 秒');
    assert.equal(at(28000, 30000), '正在准备，约 2 秒');
    assert.equal(at(29600, 30000), '正在准备，已等 29 秒');
    assert.equal(at(95000, 30000), '正在准备，已等 1 分 35 秒');
    assert.equal(at(120000, 30000), '正在准备，已等 2 分钟');
    // Time with the phone locked does not use up the countdown, but the wait shown is the real one.
    assert.equal(at(70000, 30000, 10000), '正在准备，约 20 秒');
    assert.equal(at(3000, 0), '正在准备');
    assert.equal(at(12000, 0), '正在准备，已等 12 秒');
});

test('a slow load given up before it is ready still raises the estimate; one given up early does not', async () => {
    const h = harness(); h.storage.set(LOAD_MS, '30000'); h.startEngine();
    await h.advance(5000); h.restartEngine();
    assert.equal(h.storage.get(LOAD_MS), '30000');
    await h.advance(90000); h.restartEngine();
    assert.equal(h.storage.get(LOAD_MS), '60000');
    await h.advance(90000); h.shell('pagehide');
    assert.equal(h.storage.get(LOAD_MS), '75000');
});

test('a load that times out counts as the timeout at most', async () => {
    const h = harness(); h.storage.set(LOAD_MS, '30000'); h.startEngine();
    await h.advance(250000);
    assert.equal(h.engineState(), 'failed');
    assert.equal(h.storage.get(LOAD_MS), '135000');
});

test('time with the shell hidden is not loading time', async () => {
    const h = harness(); h.storage.set(LOAD_MS, '30000'); h.startEngine(); const n = h.natives[0];
    await h.advance(10000); h.shell('visibilitychange', 'hidden');
    await h.advance(60000);
    assert.equal(h.engineProgress().loadingMs, 10000);
    assert.equal(h.engineProgress().elapsedMs, 70000);
    h.shell('visibilitychange', 'visible'); await h.advance(30000);
    assert.equal(h.engineProgress().loadingMs, 40000);
    await n.events.emit(); await flush(); assertOneConnection(h, n);
    assert.equal(h.storage.get(LOAD_MS), '35000');
});

const SKIP = 'tavern-lite:engine-skip-extensions';

// A SillyTavern server for the engine page: settings with the account's disabled list, and every save it receives.
function serveSettings(n, disabled) {
    const saves = [];
    n.win.Response = Response;
    n.win.fetch = async (url, init) => {
        if (/settings\/save/.test(url)) { saves.push(init.body); return new Response('{}'); }
        const settings = { extension_settings: { disabledExtensions: [...disabled], memory: { x: 1 } }, power_user: { a: 1 } };
        return new Response(JSON.stringify({ settings: JSON.stringify(settings), world_names: [] }), { headers: { 'content-type': 'application/json', 'content-length': '999' } });
    };
    return saves;
}

// What SillyTavern does with the answer: parse it and take over the extension settings (Object.assign).
async function nativeReadsSettings(n) {
    const response = await n.win.fetch('/api/settings/get', { method: 'POST', body: '{}' });
    const data = await response.json();
    n.extensionSettings.disabledExtensions = JSON.parse(data.settings).extension_settings.disabledExtensions;
    return data;
}

test('skipped extensions are disabled while the full app activates them, then the account list is restored', async () => {
    const h = harness(); h.setSkippedExtensions(['tts', 'third-party/extra', 'memory']);
    h.startEngine(); const n = h.natives[0];
    const saves = serveSettings(n, ['memory']);
    await h.advance(40);
    const data = await nativeReadsSettings(n);
    assert.deepEqual(n.extensionSettings.disabledExtensions, ['memory', 'tts', 'third-party/extra']);
    assert.deepEqual(JSON.parse(data.settings).extension_settings.memory, { x: 1 }, 'the rest of the settings is untouched');
    assert.deepEqual(data.world_names, []);
    // A plain-text save before the restore never carries the extra names.
    await n.win.fetch('/api/settings/save', { method: 'POST', body: JSON.stringify({ extension_settings: { disabledExtensions: ['memory', 'tts', 'third-party/extra', 'own-choice'] } }) });
    assert.deepEqual(JSON.parse(saves[0]).extension_settings.disabledExtensions, ['memory', 'own-choice']);
    const list = n.extensionSettings.disabledExtensions;
    n.events.fireSettingsLoaded();
    assert.equal(n.extensionSettings.disabledExtensions, list, 'restored in place');
    assert.deepEqual(list, ['memory']);
    assert.equal(n.events.other.size, 0, 'the listener is removed');
    // After the restore saves go through as they are.
    await n.win.fetch('/api/settings/save', { method: 'POST', body: JSON.stringify({ extension_settings: { disabledExtensions: ['memory', 'tts'] } }) });
    assert.deepEqual(JSON.parse(saves[1]).extension_settings.disabledExtensions, ['memory', 'tts']);
    await h.advance(300); await n.events.emit(); await flush(); assertOneConnection(h, n);
    assert.deepEqual([...h.accountDisabledExtensions()], ['memory']);
});

test('without the settings-loaded event the list is restored when the app is ready', async () => {
    const h = harness(); h.setSkippedExtensions(['tts']);
    h.startEngine(); const n = h.natives[0];
    serveSettings(n, []);
    await h.advance(40);
    await nativeReadsSettings(n);
    assert.deepEqual(n.extensionSettings.disabledExtensions, ['tts']);
    await h.advance(300); await n.events.emit(); await flush(); assertOneConnection(h, n);
    assert.deepEqual(n.extensionSettings.disabledExtensions, []);
});

test('no skip list leaves the settings answer as it is; tavern lite itself is never skipped', async () => {
    const h = harness();
    assert.equal(h.ownExtension(), 'third-party/emmalike');
    assert.deepEqual([...h.setSkippedExtensions(['third-party/emmalike', 'tts', 'tts', '', 3])], ['tts']);
    assert.equal(h.storage.get(SKIP), '["tts"]');
    assert.deepEqual([...h.setSkippedExtensions([])], []);
    assert.equal(h.storage.has(SKIP), false);
    h.storage.set(SKIP, '["third-party/emmalike","vectors"]');
    assert.deepEqual([...h.skippedExtensions()], ['vectors']);
    h.storage.set(SKIP, 'not json');
    assert.deepEqual([...h.skippedExtensions()], []);
    h.startEngine(); const n = h.natives[0];
    serveSettings(n, ['memory']);
    await h.advance(40);
    const response = await n.win.fetch('/api/settings/get', { method: 'POST', body: '{}' });
    assert.equal(response.headers.get('content-length'), '999', 'the original answer is passed through');
    assert.equal(h.accountDisabledExtensions(), null, 'nothing to show before the app is ready');
});

test('a tested version counts with or without the git branch and commit after it', () => {
    const h = harness();
    for (const v of ['1.19.0', "1.19.0 'release' (06bde93)", 'SillyTavern 1.16.0', '1.18.0-preview', ' 1.17.0 ']) assert.equal(h.isTestedVersion(v), true, v);
    for (const v of ['1.15.0', "1.20.0 'staging' (abc1234)", '1.19.01', '1.19', 'unknown', '', null, undefined]) assert.equal(h.isTestedVersion(v), false, String(v));
});
