import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createNativeSettleBarrier, ST119_RENDER_EVENT_KEYS } from '../bridge-native-settle.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(overrides = {}) {
    let time = 0, idle = true, current, version = 'SillyTavern 1.19.0';
    const jobs = [], events = new EventEmitter(), eventTypes = Object.fromEntries(ST119_RENDER_EVENT_KEYS.map(key => [key, key]));
    const manager = { tryGenerate() { return Promise.resolve(); }, renderDebounced() {}, render() {}, saveServiceSettings() {} };
    current = manager;
    const original = overrides.tryGenerate || manager.tryGenerate; manager.tryGenerate = original;
    const at = (when, action) => { jobs.push({ when, action }); jobs.sort((a, b) => a.when - b.when); };
    const sleep = async ms => {
        time += ms;
        while (jobs.length && jobs[0].when <= time) jobs.shift().action();
        await Promise.resolve(); await Promise.resolve();
    };
    const barrier = createNativeSettleBarrier({ version: () => version, promptManager: manager,
        getPromptManager: () => current, eventSource: events, eventTypes, isNativeIdle: () => idle,
        now: () => time, sleep, ...overrides });
    return { barrier, manager, original, events, eventTypes, at, sleep, time: () => time,
        setIdle: value => { idle = value; }, setCurrent: value => { current = value; }, setVersion: value => { version = value; } };
}

test('observer never initiates rendering/generation/saving and requires the full1100ms quiet interval', async () => {
    let calls = 0; const f = fixture({ tryGenerate() { calls++; return Promise.resolve(); } });
    const result = await f.barrier.wait(); assert.equal(calls, 0); assert.equal(result.waitedMs, 1100);
    f.barrier.dispose();
});
test('tryGenerate preserves receiver, arguments, exact Promise identity and fulfilled value', async () => {
    const d = deferred(), receiver = {}, args = ['fixture', 3]; let seen;
    const f = fixture({ tryGenerate(...values) { seen = { receiver: this, values }; return d.promise; } });
    const result = f.manager.tryGenerate.apply(receiver, args);
    assert.equal(result, d.promise); assert.equal(seen.receiver, receiver); assert.deepEqual(seen.values, args);
    assert.equal(f.barrier.snapshot().inFlight, 1); d.resolve('value'); assert.equal(await result, 'value');
    await Promise.resolve(); assert.equal(f.barrier.snapshot().inFlight, 0); f.barrier.dispose();
});
test('synchronous return/throw and Promise rejection retain original behavior and failures fail closed', async () => {
    const sync = fixture({ tryGenerate() { return 42; } }); assert.equal(sync.manager.tryGenerate(), 42); sync.barrier.dispose();
    const thrown = new Error('fixture'); const fail = fixture({ tryGenerate() { throw thrown; } });
    assert.throws(() => fail.manager.tryGenerate(), value => value === thrown); assert.equal(fail.barrier.snapshot().inFlight, 0);
    await assert.rejects(fail.barrier.wait(), { code: 'NATIVE_BACKGROUND_FAILED' }); fail.barrier.dispose();
    const d = deferred(), rejected = fixture({ tryGenerate() { return d.promise; } });
    const promise = rejected.manager.tryGenerate(); assert.equal(promise, d.promise); d.reject(thrown);
    await assert.rejects(promise, value => value === thrown); await Promise.resolve();
    assert.equal(rejected.barrier.snapshot().inFlight, 0); await assert.rejects(rejected.barrier.wait(), { code: 'NATIVE_BACKGROUND_FAILED' }); rejected.barrier.dispose();
});
test('old observed run prevents leaving while native idle; finishing requires another quiet interval', async () => {
    const d = deferred(), f = fixture({ tryGenerate() { return d.promise; } });
    f.manager.tryGenerate(); f.at(2500, () => d.resolve());
    const result = await f.barrier.wait(); assert.equal(result.observedRuns, 1); assert.ok(f.time() >= 3600); f.barrier.dispose();
});
test('a never-ending observed dry run times out and cannot permit a switch', async () => {
    const d = deferred(), f = fixture({ tryGenerate() { return d.promise; } }); f.manager.tryGenerate();
    await assert.rejects(f.barrier.wait({ timeoutMs: 1500 }), { code: 'NATIVE_SETTLE_TIMEOUT' });
    assert.equal(f.barrier.snapshot().inFlight, 1); f.barrier.dispose(); d.resolve(); await Promise.resolve();
});
test('delayed timedWorldInfo computation completes before capture; removing the barrier is caught by the same contract', async () => {
    async function scenario(useBarrier) {
        const d = deferred(), state = { timedWorldInfo: null }; let chatWrites = 0, worldWrites = 0;
        const f = fixture({ tryGenerate() { return d.promise.then(() => { state.timedWorldInfo = { sticky: { fixture: { end: 3 } } }; }); } });
        f.manager.saveServiceSettings = () => { chatWrites++; };
        f.manager.render = () => { worldWrites++; };
        f.manager.tryGenerate(); f.at(1700, () => d.resolve());
        try {
            await (useBarrier ? f.barrier.wait() : Promise.resolve());
            assert.deepEqual(state.timedWorldInfo, { sticky: { fixture: { end: 3 } } }, 'source capture must include completion of the delayed native WI computation');
            assert.equal(chatWrites, 0); assert.equal(worldWrites, 0);
        } finally { f.barrier.dispose(); d.resolve(); await Promise.resolve(); }
    }
    await scenario(true);
    await assert.rejects(scenario(false), { code: 'ERR_ASSERTION' }); // Deliberate no-op-barrier mutation must fail.
});
test('a render started after relaxed debounce is observed rather than escaped at1100ms', async () => {
    const d = deferred(), f = fixture({ tryGenerate() { return d.promise; } });
    f.events.emit('MESSAGE_RECEIVED'); f.at(1000, () => f.manager.tryGenerate()); f.at(1800, () => d.resolve());
    await f.barrier.wait(); assert.ok(f.time() >= 2900); f.barrier.dispose();
});
test('CHAT_LOADED waits for actual SETTINGS_UPDATED then its delayed render and run', async () => {
    const d = deferred(), f = fixture({ tryGenerate() { return d.promise; } });
    f.events.emit('CHAT_LOADED'); f.at(2500, () => f.events.emit('SETTINGS_UPDATED'));
    f.at(3500, () => f.manager.tryGenerate()); f.at(4000, () => d.resolve());
    await f.barrier.wait(); assert.ok(f.time() >= 5100); f.barrier.dispose();
});
test('unconfirmed settings persistence times out without fabricating a new save', async () => {
    const f = fixture(); f.events.emit('CHARACTER_EDITED');
    await assert.rejects(f.barrier.wait({ timeoutMs: 1800 }), { code: 'NATIVE_SETTLE_TIMEOUT' });
    assert.equal(f.barrier.snapshot().runs, 0); assert.equal(f.barrier.snapshot().waitingSettings, true); f.barrier.dispose();
});
test('every source event restarts the observation window, including groupSelected', async () => {
    for (const name of [...ST119_RENDER_EVENT_KEYS, 'groupSelected']) {
        const f = fixture(); f.at(1000, () => { f.events.emit(name); if (['CHAT_LOADED','CHARACTER_EDITED','CHARACTER_DELETED','groupSelected'].includes(name)) f.events.emit('SETTINGS_UPDATED'); });
        await f.barrier.wait(); assert.ok(f.time() >= 2100, name); f.barrier.dispose();
    }
});
test('native busy needs continuous idle afterwards even without a recent event', async () => {
    const f = fixture(); f.setIdle(false); f.at(2000, () => f.setIdle(true));
    await f.barrier.wait(); assert.ok(f.time() >= 3100); f.barrier.dispose();
});
test('identity/version/lease changes fail closed while waiting', async () => {
    const a = fixture(); a.at(300, () => a.setCurrent({})); await assert.rejects(a.barrier.wait(), { code: 'NATIVE_MANAGER_CHANGED' }); a.barrier.dispose();
    const b = fixture(); b.at(300, () => b.setVersion('1.15.0')); await assert.rejects(b.barrier.wait(), { code: 'NATIVE_VERSION_UNVERIFIED' }); b.barrier.dispose();
    const c = fixture(); let valid = true; c.at(300, () => { valid = false; });
    await assert.rejects(c.barrier.wait({ assertCurrent: () => valid }), { code: 'NATIVE_SCOPE_CHANGED' }); c.barrier.dispose();
});
test('dispose restores only its own wrapper/listeners, and a pending old run cannot mutate a new observer', async () => {
    const d = deferred(), f = fixture({ tryGenerate() { return d.promise; } }); const external = () => {};
    f.events.on('CHAT_CHANGED', external); f.manager.tryGenerate(); f.barrier.dispose();
    assert.equal(f.manager.tryGenerate, f.original); assert.equal(f.events.listenerCount('CHAT_CHANGED'), 1);
    await assert.rejects(f.barrier.wait(), { code: 'NATIVE_BARRIER_DISPOSED' });
    d.resolve(); await Promise.resolve(); assert.equal(f.barrier.snapshot().inFlight, 0);
    const other = () => Promise.resolve(); const g = fixture(); g.manager.tryGenerate = other; g.barrier.dispose(); assert.equal(g.manager.tryGenerate, other);
});
test('unverified shape and shortened timing are refused and observer arguments never include content', async () => {
    for (const overrides of [{ version: '1.19.01' }, { quietMs: 1099 }, { getPromptManager: () => null }, { isNativeIdle: () => Promise.resolve(true) }]) {
        const f = fixture(overrides); await assert.rejects(f.barrier.wait()); f.barrier.dispose();
    }
    const f = fixture(); f.manager.tryGenerate('SYNTHETIC_CONTENT'); await Promise.resolve();
    assert.equal(JSON.stringify(f.barrier.snapshot()).includes('SYNTHETIC'), false); f.barrier.dispose();
});

test('versions from 1.16.0 on are accepted; malformed or older ones are not', async () => {
    const { supportedNativeVersion } = await import('../bridge-native-settle.js');
    for (const v of ['1.16.0', 'SillyTavern 1.17.0', "1.18.0 'release' (abc)", '1.19.0', '1.19.3', '1.20.0', '2.0.0', '1.19.0+dev']) assert.equal(supportedNativeVersion(v), true, v);
    for (const v of ['1.15.9', '1.9.0', '1.19.01', '1.19', 'unknown', '', undefined, 'SillyTavern'] ) assert.equal(supportedNativeVersion(v), false, String(v));
    for (const version of ['SillyTavern 1.16.0', '1.18.0']) { const f = fixture({ version }); assert.equal(f.barrier.snapshot().supported, true); f.barrier.dispose(); }
    const old = fixture({ version: '1.15.0' }); await assert.rejects(old.barrier.wait(), { code: 'NATIVE_VERSION_UNVERIFIED' }); old.barrier.dispose();
});
