import { createPresetEditorAdapter, createPresetEditorJournal } from '../bridge-preset-editor.js';
import { clonePreset, samePreset, PRESET_FIELDS, normalizePresetTargetName } from '../src/preset-editor-model.js';
export function memoryStorage() {
    const values = new Map(); return { get length() { return values.size; }, key: i => [...values.keys()][i], getItem: k => values.get(k) ?? null,
        setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k), clear: () => values.clear() };
}
export const seedPreset = () => ({ temperature: .7, openai_max_tokens: 500, openai_max_context: 8000, top_p: 1, frequency_penalty: 0, presence_penalty: 0, stream_openai: true,
    prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'Original main body', extensionUnknown: { keep: 17 } },
        { identifier: 'advanced', name: 'Advanced', role: 'system', content: 'Hidden ADVANCED_NEEDLE content' },
        { identifier: 'secondary', name: 'Secondary', role: 'system', content: 'Secondary body' }],
    prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'advanced', enabled: false }, { identifier: 'secondary', enabled: true }] }],
    importedUnknown: { preserve: 'synthetic value' } });
const exported = value => { const result = clonePreset(value); delete result.importedUnknown; for (const prompt of result.prompts) delete prompt.extensionUnknown; return result; };
export function createPresetFixture({ storage = memoryStorage(), persist = false, journal = createPresetEditorJournal(storage), apiId = 'openai', caseSensitiveNames = false } = {}) {
    const stored = persist ? JSON.parse(storage.getItem('preset-fixture') || 'null') : null;
    const files = new Map(stored?.files || [['Original', seedPreset()], ['Other', { ...seedPreset(), temperature: .2 }]]);
    let runtime = stored?.runtime || exported(files.get('Original')), name = stored?.name || 'Original', account = 'preset-test', epoch = 0;
    let queue = Promise.resolve(), writes = 0, applies = 0, uses = 0, reads = 0, verifications = 0, readBlocked = false, fault = '', writeHook, readHook, verifyHook, canonicalHook;
    const held = new Map(), listeners = new Set(), cache = new Map([...files].map(([k, v]) => [k, clonePreset(v)]));
    const saveRuntime = () => { if (persist) storage.setItem('preset-fixture', JSON.stringify({ files: [...files], runtime, name })); };
    const notify = () => { saveRuntime(); listeners.forEach(fn => fn()); };
    const current = () => ({ account, name, epoch, full: clonePreset(runtime), choices: [...cache.keys()], stream: runtime.stream_openai,
        samplers: Object.fromEntries(Object.keys(PRESET_FIELDS).filter(k => k !== 'stream_openai').map(k => [k, { value: runtime[k], min: 0, max: k.includes('tokens') || k.includes('context') ? 200000 : 2, step: .1 }])),
        prompts: runtime.prompt_order[0].order.map(item => ({ ...runtime.prompts.find(p => p.identifier === item.identifier), canEdit: true, canToggle: true, enabled: item.enabled })),
        sources: { chat: '番外 · Synthetic child', character: 'Synthetic character', persona: 'Synthetic persona', otherReferences: 'unknown' } });
    const makeLease = () => ({ account, name, epoch });
    const assertAccount = lease => { if (account !== 'preset-test' || lease.account !== account) throw Object.assign(new Error('Account changed'), { code: 'PRESET_ACCOUNT_CHANGED' }); };
    const assertLease = lease => { assertAccount(lease); if (lease.name !== name || lease.epoch !== epoch) throw Object.assign(new Error('Preset changed'), { code: 'PRESET_CHANGED' }); };
    const wait = key => held.get(key)?.promise;
    const fieldValue = key => key.startsWith('enabled:') ? runtime.prompt_order[0].order.find(x => x.identifier === key.slice(8))?.enabled : runtime[key];
    const bridge = createPresetEditorAdapter({ account, apiId, caseSensitiveNames, journal, current, makeLease, assertLease, assertAccount,
        verifyAccount: async () => { verifications++; verifyHook?.(verifications); assertAccount(makeLease()); },
        enqueue(fn) { const next = queue.then(fn); queue = next.catch(() => {}); return next; },
        canonicalName: async value => { canonicalHook?.(value); return normalizePresetTargetName(value); },
        listNamed: async () => [...files.keys()], readNamed: async key => { reads++; readHook?.(reads, key); if (readBlocked) throw new Error('Read unavailable'); return clonePreset(files.get(key) ?? null); },
        writeNamed: async (key, value) => { writes++; await wait('write'); writeHook?.(key, value); if (['reject', 'abort', '502', '503', '504', 'bad-response'].includes(fault)) throw new Error(fault); if (fault === 'resolved-old') return; files.set(key, clonePreset(value)); saveRuntime();
            if (fault === 'unknown') { readBlocked = true; throw new Error('Lost response'); } },
        registerNamed: (key, value) => { cache.set(key, clonePreset(value)); notify(); },
        useNamed: async key => { uses++; await wait('use'); if (fault === 'use') throw new Error('Apply failed'); name = key; epoch++; runtime = exported(cache.get(key)); notify(); },
        matchesApplied: (expected, actual) => samePreset(exported(expected), actual.full),
        fieldValue, applyField: async (key, value) => { if (key.startsWith('enabled:')) runtime.prompt_order[0].order.find(x => x.identifier === key.slice(8)).enabled = value; else runtime[key] = value; notify(); },
        movePrompt: async (id, to) => { const order = runtime.prompt_order[0].order; order.splice(to, 0, order.splice(order.findIndex(x => x.identifier === id), 1)[0]); notify(); },
        copyPrompt: async (id, created, copyName) => { const order = runtime.prompt_order[0].order, source = runtime.prompts.find(p => p.identifier === id);
            runtime.prompts.push({ ...clonePreset(source), identifier: created, name: copyName || `${source.name} 副本` }); order.splice(order.findIndex(x => x.identifier === id) + 1, 0, { identifier: created, enabled: false }); notify(); },
        applyPrompt: async (id, text) => { applies++; await wait('apply'); runtime.prompts.find(p => p.identifier === id).content = text; notify(); },
    });
    bridge.onPresetEditorChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
    return { bridge, files, cache, current, storage, journal, counters: () => ({ writes, applies, uses, reads, verifications }), notify,
        hold(key) { let release; const promise = new Promise(resolve => { release = resolve; }); held.set(key, { promise, release }); },
        release(key) { held.get(key)?.release(); held.delete(key); }, fault: value => { fault = value; }, readable() { readBlocked = false; fault = ''; },
        onWrite: fn => { writeHook = fn; },
        onRead: fn => { readHook = fn; }, onVerify: fn => { verifyHook = fn; }, onCanonical: fn => { canonicalHook = fn; },
        externalFile(patch) { Object.assign(files.get('Original'), patch); notify(); },
        externalPrompt(text) { runtime.prompts[0].content = text; notify(); },
        externalRuntime(patch) { Object.assign(runtime, patch); notify(); },
        switchPreset(target) { name = target; epoch++; runtime = exported(cache.get(target)); notify(); },
        changeAccount() { account = 'other-account'; notify(); },
    };
}
