/** Observe ST's real prompt-manager background work (1.16 and newer). This module never
 * calls tryGenerate/render/save itself. Install before opening an episode source;
 * work already started before instrumentation cannot be recovered retroactively.
 */
export const ST119_RENDER_QUIET_MS = 1100; // debounce_timeout.relaxed=1000 + waitUntilCondition poll=100.
export const ST119_RENDER_EVENT_KEYS = Object.freeze(['MESSAGE_DELETED', 'MESSAGE_EDITED', 'MESSAGE_RECEIVED',
    'CHATCOMPLETION_SOURCE_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'CHAT_LOADED', 'CHARACTER_EDITED',
    'CHARACTER_DELETED', 'OAI_PRESET_CHANGED_AFTER', 'WORLDINFO_SETTINGS_UPDATED', 'CHAT_CHANGED', 'SETTINGS_UPDATED']);
const SETTINGS_WAIT_KEYS = new Set(['CHAT_LOADED', 'CHARACTER_EDITED', 'CHARACTER_DELETED', 'groupSelected']);
// PromptManager (tryGenerate, renderDebounced), the events above and debounce_timeout.relaxed are the same in
// SillyTavern 1.16.0 to 1.19.0 (checked against its source). A later version that changes them fails validate() when
// the wrapped prompt manager is replaced.
export const MIN_NATIVE_VERSION = Object.freeze([1, 16, 0]);
export function supportedNativeVersion(value) {
    const match = String(value ?? '').match(/^(?:SillyTavern\s+)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:$|[\s+-])/);
    if (!match) return false;
    const parts = match.slice(1).map(Number);
    for (let i = 0; i < 3; i++) if (parts[i] !== MIN_NATIVE_VERSION[i]) return parts[i] > MIN_NATIVE_VERSION[i];
    return true;
}
const supportedVersion = supportedNativeVersion;
const error = (code, message) => Object.assign(new Error(message), { code });
const installations = new WeakMap();

/** Required getPromptManager/isNativeIdle are synchronous read-only predicates.
 * The original this, synchronous return, Promise identity, throw and rejection
 * remain unchanged. No args/results/errors are retained in diagnostics.
 */
export function createNativeSettleBarrier({ version, promptManager, getPromptManager, eventSource, eventTypes,
    isNativeIdle, eventTarget, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    quietMs = ST119_RENDER_QUIET_MS, pollMs = 100 } = {}) {
    let disposed = false, setupError = null, failure = false, inFlight = 0, runs = 0;
    let lastActivity = 0, idleSince = null, waitingSettings = false, serial = 0;
    const listeners = [], original = promptManager?.tryGenerate;
    const currentVersion = () => typeof version === 'function' ? version() : version;
    const tick = () => {
        const time = Number(now());
        if (!Number.isFinite(time)) throw error('NATIVE_CLOCK_INVALID', '无法确认原生后台状态的时间');
        return time;
    };
    const activity = () => { lastActivity = tick(); serial++; };
    function validate() {
        if (disposed) throw error('NATIVE_BARRIER_DISPOSED', '原生页面已更换，旧的后台确认已失效');
        if (setupError) throw setupError;
        if (!supportedVersion(currentVersion())) throw error('NATIVE_VERSION_UNVERIFIED', '当前原生后台流程尚未验收');
        if (getPromptManager() !== promptManager || promptManager.tryGenerate !== wrapped) {
            throw error('NATIVE_MANAGER_CHANGED', '页面有变化，刷新后再试');
        }
        if (failure) throw error('NATIVE_BACKGROUND_FAILED', '原生背景计算失败，尚不能确认稳定状态');
    }
    function wrapped(...args) {
        inFlight++; runs++; activity();
        let settled = false;
        const finish = rejected => {
            if (settled) return;
            settled = true; inFlight--; failure ||= rejected;
            // Disposed observations cannot mutate a later installation.
            if (!disposed) activity();
        };
        try {
            const value = Reflect.apply(original, this, args);
            if (value && typeof value.then === 'function') {
                // Observe without returning an altered Promise or leaving a
                // rejected finally-derived Promise unhandled.
                Promise.resolve(value).then(() => finish(false), () => finish(true));
            } else finish(false);
            return value;
        } catch (cause) { finish(true); throw cause; }
    }
    const removeObservers = () => {
        for (const [name, listener] of listeners) eventSource.removeListener(name, listener);
        listeners.length = 0;
        eventTarget?.removeEventListener?.('change', onTokenSettingChange, true);
    };
    function onTokenSettingChange(event) {
        if (['openai_max_context', 'openai_max_tokens'].includes(event.target?.id)) activity();
    }
    try {
        if (!supportedVersion(currentVersion())) throw error('NATIVE_VERSION_UNVERIFIED', '当前原生后台流程尚未验收');
        if (!promptManager || typeof original !== 'function' || typeof promptManager.renderDebounced !== 'function' ||
            typeof promptManager.render !== 'function' || typeof promptManager.saveServiceSettings !== 'function' ||
            typeof getPromptManager !== 'function' || getPromptManager() !== promptManager || typeof isNativeIdle !== 'function' ||
            typeof eventSource?.on !== 'function' || typeof eventSource?.removeListener !== 'function' ||
            ST119_RENDER_EVENT_KEYS.some(key => typeof eventTypes?.[key] !== 'string' || !eventTypes[key])) {
            throw error('NATIVE_MANAGER_UNVERIFIED', '尚未确认原生提示管理器与事件接口');
        }
        if (installations.has(promptManager)) throw error('NATIVE_BARRIER_DUPLICATE', '原生后台观察器已经安装');
        if (!Number.isFinite(quietMs) || quietMs < ST119_RENDER_QUIET_MS || !Number.isFinite(pollMs) || pollMs < 1 || pollMs > 100) {
            throw error('NATIVE_TIMING_UNVERIFIED', '原生后台确认时间短于已验收范围');
        }
        activity();
        promptManager.tryGenerate = wrapped;
        if (promptManager.tryGenerate !== wrapped) throw error('NATIVE_MANAGER_UNVERIFIED', '无法观察原生提示管理器');
        installations.set(promptManager, wrapped);
        for (const key of [...ST119_RENDER_EVENT_KEYS, 'groupSelected']) {
            const name = key === 'groupSelected' ? key : eventTypes[key];
            const listener = () => {
                if (disposed) return;
                if (SETTINGS_WAIT_KEYS.has(key)) waitingSettings = true;
                if (key === 'SETTINGS_UPDATED') waitingSettings = false;
                activity();
            };
            eventSource.on(name, listener); listeners.push([name, listener]);
        }
        eventTarget?.addEventListener?.('change', onTokenSettingChange, true);
    } catch (cause) {
        setupError = cause?.code ? cause : error('NATIVE_MANAGER_UNVERIFIED', '无法观察原生提示管理器');
        removeObservers();
        if (promptManager?.tryGenerate === wrapped) promptManager.tryGenerate = original;
        if (installations.get(promptManager) === wrapped) installations.delete(promptManager);
    }
    return {
        snapshot() { return { supported: !setupError && !disposed, inFlight, runs, waitingSettings, failure, serial, lastActivity, idleSince }; },
        async wait({ assertCurrent = () => true, timeoutMs = 30000 } = {}) {
            if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw error('NATIVE_TIMEOUT_INVALID', '无效的原生后台确认时限');
            const start = tick();
            while (true) {
                validate();
                const lease = assertCurrent();
                if (lease === false || lease?.then) throw error('NATIVE_SCOPE_CHANGED', '页面、账号或故事变了');
                const time = tick(), idle = isNativeIdle();
                if (typeof idle !== 'boolean') throw error('NATIVE_IDLE_UNVERIFIED', '无法确认原生生成状态');
                if (!idle) idleSince = null;
                else if (idleSince === null) idleSince = time;
                if (idle && !waitingSettings && inFlight === 0 && time - Math.max(lastActivity, idleSince) >= quietMs) {
                    // No await between the final predicates and completion.
                    validate();
                    const finalLease = assertCurrent();
                    if (finalLease === false || finalLease?.then) throw error('NATIVE_SCOPE_CHANGED', '页面、账号或故事变了');
                    return { settled: true, observedRuns: runs, quietMs, waitedMs: time - start };
                }
                if (time - start >= timeoutMs) throw error('NATIVE_SETTLE_TIMEOUT', '还在准备，稍后再试');
                await sleep(Math.min(pollMs, timeoutMs - (time - start)));
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true; removeObservers();
            if (promptManager?.tryGenerate === wrapped) promptManager.tryGenerate = original;
            if (installations.get(promptManager) === wrapped) installations.delete(promptManager);
        },
    };
}
