/** Complete installed bridge + lazy UI acceptance; fixed PURE ST 1.19.0 on 8032.
 * Run only after the integrated app/raw-module closure is installed:
 * TEST_OUTPUT=/tmp/editors-integration node tests/e2e-editors-integration.mjs
 * No arguments: both normal cases and all four scoped storage cases.
 * Normal --cases=world-preset,preset-world
 * Scoped storage --cases=scoped-idb-getter,scoped-idb-method,shell-storage-read,shell-storage-write
 * Historical storage-getter/storage-method intentionally reproduce the native
 * global-LS limitation; do not count them as compatibility acceptance.
 * Only this run's exact character/chats/world/preset may be written. Settings,
 * profiles and existing named presets are fingerprinted and never saved.
 * All provider requests and remote tokenizers are intercepted in the browser.
 * Scoped-IDB denial starts AFTER native APP_READY but BEFORE bridge evaluation;
 * shell key-specific faults start after readiness and before lazy editor loading.
 * This does not claim that native ST boots with global localStorage disabled.
 * Native saveWorldInfo receives one observational entry counter in its browser
 * response. PM methods are NOT replaced: real dry-run events are only counted.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8032', ACCOUNT = 'default-user';
const EXT = '/scripts/extensions/third-party/emmalike/', APP = BASE + EXT + 'app/';
const args = process.argv.slice(2), known = ['storage-getter', 'storage-method', 'world-preset', 'preset-world', 'native-idb-getter', 'native-local-getter', 'scoped-idb-getter', 'scoped-idb-method', 'shell-storage-read', 'shell-storage-write'];
assert.ok(args.every(x => x.startsWith('--cases=')) && args.length <= 1, 'Target is fixed to the pure 8032 instance');
const defaultCases = ['world-preset', 'preset-world', 'scoped-idb-getter', 'scoped-idb-method', 'shell-storage-read', 'shell-storage-write'];
const cases = args.length ? args[0].slice(8).split(',') : defaultCases;
assert.ok(cases.length && cases.every(x => known.includes(x)) && new Set(cases).size === cases.length);
const output = path.resolve(process.env.TEST_OUTPUT || '/tmp/editors-integration');
await mkdir(output, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const run = `tl-editors-${Date.now()}-${randomUUID().slice(0, 8)}`;
const book = `${run}-world`, presetName = `${run}-preset`, files = new Set(cases.map(c => `${run}-${c}`));
const clone = x => structuredClone(x);
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
const sha = x => createHash('sha256').update(x).digest('hex');
const hash = x => sha(JSON.stringify(canonical(x)));
const responseBody = request => {
    const bytes = request.postDataBuffer();
    return bytes ? JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString('utf8')) : {};
};
const modelPath = p => /^\/api\/(backends|horde|novelai|openai|kobold|textgenerationwebui|sd|images|tts|embeddings|vectors|translate|search)(\/|$)/.test(p)
    || /^\/api\/.*(?:generate|completion)/i.test(p) || /^\/api\/tokenizers\/(remote|openai)(\/|$)/.test(p);
const report = { run, base: BASE, cases: [], checks: [], cleanup: false, artifacts: {},
    categories: { bridge: 'Installed window.TavernLiteBridge and real common queue; scoped-IDB cases inject only storage into the real preset journal factory via a browser response',
        storage: 'Scoped-IDB: iframe IDB denial after native APP_READY/before bridge; native LS intact. Shell cases: only new editor key prefixes reject Storage methods. Historical dual-denial cases retain the native LS limitation',
        model: 'One browser-fulfilled chat-completions endpoint; all other providers, external URLs and remote tokenizers blocked',
        native: 'Real ST save/Generate/render behavior; saveWorldInfo entry counter only; PM dry runs not suppressed',
        recovery: 'Same browser context, full outer-document reload/new iframe, persistent real IDB journal',
        layout: 'Headless 390px/1440px geometry and screenshots; not physical keyboard or IME acceptance' },
    limits: ['No real model service', 'No arbitrary third-party extension isolation', 'No cross-device atomic saves',
        'Preset render/select may start native PM dry runs; world gate covers bridge-owned generation entry points, not every native/plugin dry run'] };
let browser, admin, csrf, avatar, initialChat, baseline, inventory, storageState, fixtureReady = false, fatal;
const contexts = new Set();
async function log(event, detail = {}) {
    const value = { at: Date.now(), event, ...detail };
    console.log(JSON.stringify(value)); await appendFile(path.join(output, 'stages.jsonl'), JSON.stringify(value) + '\n');
}
function check(name, condition, detail) {
    report.checks.push({ name, pass: !!condition, ...(detail === undefined ? {} : { detail }) });
    assert.ok(condition, name); console.log('PASS', name);
}
async function bounded(promise, label, milliseconds = 45000) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: queue/operation did not settle within ${milliseconds}ms`)), milliseconds); })]); }
    finally { clearTimeout(timer); }
}
async function post(endpoint, data = {}) {
    assert.ok(['/api/users/login', '/api/settings/get', '/api/characters/all', '/api/characters/get', '/api/characters/delete',
        '/api/chats/get', '/api/chats/save', '/api/worldinfo/list', '/api/worldinfo/get', '/api/worldinfo/edit', '/api/worldinfo/delete',
        '/api/presets/save', '/api/presets/delete', '/api/plugins/tavern-lite/health'].includes(endpoint));
    if (['/api/characters/get', '/api/characters/delete', '/api/chats/get', '/api/chats/save'].includes(endpoint)) assert.equal(data.avatar_url, avatar);
    if (data.file_name) assert.ok(files.has(data.file_name));
    if (endpoint.startsWith('/api/worldinfo/') && endpoint !== '/api/worldinfo/list') assert.equal(data.name, book);
    if (endpoint === '/api/worldinfo/edit') assert.equal(data.data?.extensions?.integrationFixture, run);
    if (endpoint.startsWith('/api/presets/')) { assert.equal(data.apiId, 'openai'); assert.equal(data.name, presetName); }
    if (endpoint === '/api/presets/save') assert.equal(data.preset?.integrationFixture, run);
    return admin.request.post(BASE + endpoint, { data, maxRedirects: 0, headers: { 'X-CSRF-Token': csrf } });
}
async function jsonPost(endpoint, data) { const r = await post(endpoint, data); assert.ok(r.ok(), `${endpoint}: HTTP ${r.status()}`); return r.json(); }
async function catalog() {
    const raw = await jsonPost('/api/settings/get', {}), settings = JSON.parse(raw.settings);
    assert.equal(raw.openai_setting_names.length, raw.openai_settings.length);
    const presets = new Map(raw.openai_setting_names.map((name, i) => [name, typeof raw.openai_settings[i] === 'string' ? JSON.parse(raw.openai_settings[i]) : raw.openai_settings[i]]));
    return { raw, settings, presets, settingsHash: sha(raw.settings), profileHash: hash(settings.extension_settings?.connectionManager ?? null) };
}
const originalPresets = presets => [...presets].filter(([name]) => name !== presetName).map(([name, value]) => [name, hash(value)]).sort(([a], [b]) => a.localeCompare(b));
const originalWorlds = rows => rows.filter(row => row.file_id !== book).map(row => [row.file_id, hash(row)]).sort(([a], [b]) => a.localeCompare(b));
const worldFixture = () => ({ name: book, extensions: { integrationFixture: run, untouched: { synthetic: 17 } }, entries: {
    0: { uid: 0, key: ['SYNTHETIC_ONLY'], keysecondary: [], comment: '整合验收合成背景', content: `SERVER_BASE_${run}`,
        constant: true, vectorized: false, selective: true, selectiveLogic: 0, order: 100, position: 0, depth: 4,
        role: null, disable: false, probability: 100, useProbability: true, displayIndex: 0, untouched: { keep: true } },
} });
function presetFixture() {
    // Preserve the native schema/default numeric fields, but no existing prompt
    // text is used in a model request. This object is written only under our name.
    const source = baseline.presets.get('Default') ?? baseline.presets.values().next().value;
    assert.ok(source?.prompts && source?.prompt_order, 'A native schema template is required');
    const value = clone(source);
    value.integrationFixture = run; value.temperature = .7; value.stream_openai = false;
    value.openai_max_context = 32768; value.openai_max_tokens = 512;
    for (const prompt of value.prompts) if (!prompt.marker) prompt.content = prompt.identifier === 'main' ? `PROMPT_BASE_${run}` : '';
    assert.ok(value.prompts.some(p => p.identifier === 'main') && value.prompts.some(p => p.identifier === 'worldInfoBefore'));
    for (const order of value.prompt_order) for (const item of order.order) item.enabled = !['enhanceDefinitions', 'nsfw', 'jailbreak'].includes(item.identifier);
    Object.assign(value, { reverse_proxy: '', proxy_password: '', assistant_prefill: '', assistant_impersonation: '', send_if_empty: '',
        new_chat_prompt: '[Synthetic chat]', new_group_chat_prompt: '', new_example_chat_prompt: '', continue_nudge_prompt: '',
        impersonation_prompt: '', wi_format: '{0}', scenario_format: '{{scenario}}', personality_format: '{{personality}}' });
    return value;
}
async function environment() {
    admin = await browser.newContext({ serviceWorkers: 'block' });
    csrf = (await (await admin.request.get(BASE + '/csrf-token', { maxRedirects: 0 })).json()).token;
    assert.ok((await post('/api/users/login', { handle: ACCOUNT, password: 'test1234' })).ok());
    assert.equal((await (await admin.request.get(BASE + '/api/users/me', { maxRedirects: 0 })).json()).handle, ACCOUNT);
    { const v = (await (await admin.request.get(BASE + '/version', { maxRedirects: 0 })).json()).pkgVersion; assert.equal(v, process.env.EXPECT_ST_VERSION ?? '1.19.0'); }
    inventory = await (await admin.request.get(BASE + '/api/extensions/discover', { maxRedirects: 0 })).json();
    assert.deepEqual(inventory.filter(x => x.name.startsWith('third-party/')).map(x => x.name), ['third-party/emmalike']);
    assert.equal((await post('/api/plugins/tavern-lite/health', {})).status(), 404, 'Pure isolate only');
    baseline = await catalog(); baseline.worlds = await jsonPost('/api/worldinfo/list', {});
    baseline.avatars = (await jsonPost('/api/characters/all', {})).map(x => x.avatar).sort();
    assert.ok(!baseline.presets.has(presetName) && !baseline.worlds.some(x => x.file_id === book));
    report.baseline = { settingsHash: baseline.settingsHash, profileHash: baseline.profileHash,
        existingPresetCount: baseline.presets.size, existingWorldCount: baseline.worlds.length, existingCharacterCount: baseline.avatars.length };
    report.nativeHashes = {};
    for (const [file, expected] of Object.entries({ 'world-info.js': '111c7f47945839e75b021e09bdbb112a54f0a9b7857d2b95435f573efc7cd9a5',
        'openai.js': '0b77c30282825540265d5a09e681e5ccacf6760b05111ec880ffe237a9250604', 'preset-manager.js': '6a4bf761140e105069f251e8db8f6a68144d6236b5175b452494a725a9a4df4c' })) {
        const response = await admin.request.get(BASE + '/scripts/' + file, { maxRedirects: 0 }); assert.ok(response.ok());
        const actual = sha((await response.text()).replace(/\r\n/g, '\n')); if ((process.env.EXPECT_ST_VERSION ?? '1.19.0') === '1.19.0') assert.equal(actual, expected, `Reviewed native ${file} required`); report.nativeHashes[file] = actual;
    }
    storageState = await admin.storageState(); fixtureReady = true;
    await log('environment-verified', report.baseline);
}
async function makeFixtures() {
    assert.ok((await post('/api/worldinfo/edit', { name: book, data: worldFixture() })).ok());
    assert.ok((await post('/api/presets/save', { apiId: 'openai', name: presetName, preset: presetFixture() })).ok());
    const created = await admin.request.post(BASE + '/api/characters/create', { maxRedirects: 0, headers: { 'X-CSRF-Token': csrf }, multipart: {
        ch_name: run, description: 'Synthetic integration character only.', first_mes: `HELLO_${run}`, world: book,
        personality: '', scenario: '', mes_example: '', creator_notes: run, system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '',
    } });
    assert.ok(created.ok()); avatar = (await created.text()).trim();
    assert.ok(avatar.startsWith(run) && avatar.endsWith('.png') && !/[\\/]/.test(avatar) && !baseline.avatars.includes(avatar));
    const character = await jsonPost('/api/characters/get', { avatar_url: avatar });
    assert.equal(character.name, run); assert.equal(character.data.extensions.world, book);
    initialChat = character.chat; assert.ok(typeof initialChat === 'string' && initialChat.startsWith(run) && !/[\\/]/.test(initialChat));
    for (const file of files) assert.ok((await post('/api/chats/save', { avatar_url: avatar, file_name: file, force: false,
        chat: [{ user_name: 'Synthetic Reader', character_name: run, chat_metadata: { integrity: randomUUID() } },
            { name: run, is_user: false, is_system: false, mes: `HELLO_${run}`, send_date: new Date().toISOString(), extra: {} }] })).ok());
    await writeFile(path.join(output, 'fixture-manifest.json'), JSON.stringify({ run, account: ACCOUNT, avatar, book, presetName, files: [...files], initialChat }, null, 2));
}

// Imported FIRST in the browser response to bridge.js, before any of its other
// dependencies evaluate. The installed product files on disk are not changed.
function storageFaultModule(mode) {
    return `const c = window.SillyTavern?.getContext?.();
if (!c?.eventSource?.autoFireLastArgs?.has(c.eventTypes.APP_READY) || window.TavernLiteBridge) throw new Error('Storage fault timing is invalid');
const evidence = window.__editorStorage = {mode:${JSON.stringify(mode)},afterAppReady:true,beforeBridge:true,getters:0,methods:0};
const deny = category => { evidence[category]++; const error = new DOMException('Synthetic integration storage denial','SecurityError');
Object.defineProperty(error,'stack',{value:new Error('Storage denial caller trace').stack}); throw error; };
${mode === 'getter' ? `for (const key of ['indexedDB','localStorage']) Object.defineProperty(window,key,{configurable:true,get(){return deny('getters')}});`
        : `Object.defineProperty(window,'indexedDB',{configurable:true,get(){evidence.getters++;return {open(){return deny('methods')}}}});
Object.defineProperty(window,'localStorage',{configurable:true,get(){evidence.getters++;return {getItem(){return deny('methods')},setItem(){return deny('methods')},removeItem(){return deny('methods')},key(){return deny('methods')},get length(){return deny('methods')}}}});`}
`;
}
function scopedFaultModule(mode) {
    return `const c=window.SillyTavern?.getContext?.();
if(!c?.eventSource?.autoFireLastArgs?.has(c.eventTypes.APP_READY)||window.TavernLiteBridge)throw Error('Invalid scoped fault timing');
const e=window.__editorStorage={mode:${JSON.stringify(mode)},afterAppReady:true,beforeBridge:true,getters:0,methods:0,receiptMode:'length',receipt:[]};
const deny=()=>{throw new DOMException('Synthetic scoped storage denial','SecurityError')};
Object.defineProperty(window,'indexedDB',{configurable:true,get(){e.getters++;${mode === 'idb-getter' ? 'return deny();' : 'return {open(){e.methods++;return deny()}};'}}});
const real=window.localStorage;
window.__editorDeniedReceipt={get length(){e.receipt.push('length');if(e.receiptMode==='length')deny();return e.receiptMode==='list-get'?1:0},
key(){e.receipt.push('key');return 'tavern-lite:preset-operation:synthetic'},
getItem(k){e.receipt.push('getItem');if(e.receiptMode==='put')return null;deny()},setItem(k,v){e.receipt.push('setItem');deny()},removeItem(k){e.receipt.push('removeItem');deny()}};
e.nativeLocalStorageAccessible=typeof real.getItem==='function';`;
}
const native = (s, fn, arg) => bounded(s.page.evaluate(([source, arg]) => {
    const w = document.querySelector('iframe.engine')?.contentWindow;
    if (!w?.TavernLiteBridge) throw new Error('Installed product bridge unavailable');
    return new w.Function('w', 'arg', `return (${source})(w,arg)`)(w, arg);
}, [fn.toString(), arg]), `${s.name}/${s.phase}`);
async function invoke(s, method, ...args) {
    return native(s, async (w, { method, args }) => {
        try { return { ok: true, result: await w.TavernLiteBridge[method](...args) }; }
        catch (error) { return { ok: false, error: { code: error.code, name: error.name, message: error.message, stack: error.stack, operation: error.detail?.operation } }; }
    }, { method, args });
}
function unwrap(value) { assert.equal(value.ok, true, JSON.stringify(value.error)); return value.result; }
async function navigate(s, hash) {
    await s.page.evaluate(hash => { history.pushState({ tavernLite: true }, '', hash); dispatchEvent(new Event('tl-route')); }, hash);
}
async function ready(s, reload = false) {
    s.phase = reload ? 'reload' : 'bootstrap';
    if (reload) { await s.page.evaluate(() => history.replaceState({}, '', '#me')); await s.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }); }
    else await s.page.goto(APP + '#me', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await s.page.waitForFunction(() => !!document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge, null, { timeout: 270000 });
    const info = await native(s, w => ({ id: w.__editorsDocumentId, bootstrap: { verified: w.TavernLiteNativeSettle?.earlyVerified, phase: w.TavernLiteNativeSettle?.phase },
        storage: w.__editorStorage ?? null, methods: ['worldEditorBook', 'worldEditorRuntime', 'worldEditorOperation', 'worldEditorUnfinished', 'saveWorldEditorEntry',
            'useWorldServerAuthority', 'recoverWorldEditorWrite', 'presetEditorState', 'presetEditorSave', 'presetEditorSetField'].filter(k => typeof w.TavernLiteBridge[k] === 'function') }));
    assert.equal(info.methods.length, 10, 'Complete installed integration is required');
    assert.equal(info.bootstrap.verified, true, 'Early native settle installation must remain intact');
    if (s.mode) assert.ok(info.storage?.afterAppReady && info.storage.beforeBridge && info.storage.mode === s.mode);
    s.documents.push(info); await log('installed-bridge-ready', { case: s.name, ...info });
    await native(s, w => {
        const c = w.SillyTavern.getContext(); w.__editorDryRuns = [];
        c.eventSource.on(c.eventTypes.GENERATION_AFTER_COMMANDS, (_type, _options, dryRun) => { w.__editorDryRuns.push({ at: Date.now(), dryRun: !!dryRun }); });
    });
    return info.id;
}
async function openOwnedChat(s) {
    s.phase = 'open-owned-chat';
    const current = unwrap(await invoke(s, 'openChat', avatar, s.file));
    assert.equal(current.avatar, avatar); assert.equal(current.file, s.file); s.allowInitial = false;
    // Observer wait observes existing native work; it does not initiate dry runs.
    await native(s, w => w.TavernLiteNativeSettle.observer.wait());
}
async function newSession(name) {
    const mode = name.startsWith('storage-') ? name.slice(8) : name.startsWith('scoped-') ? name.slice(7) : null;
    const context = await browser.newContext({ storageState, viewport: { width: name === 'preset-world' ? 1440 : 390, height: 900 }, serviceWorkers: 'block' });
    contexts.add(context);
    const s = { name, mode, context, file: `${run}-${name}`, phase: 'setup', fault: '', faultArmed: false, allowInitial: true,
        documents: [], worldWrites: [], presetWrites: [], chatWrites: [], blocked: [], forwardedApis: [], models: [], routeErrors: [], pageErrors: [],
        dryRuns: [], layouts: [], calls: [], expectedWorld: `SERVER_BASE_${run}`, phantom: new Set(), reply: `MOCK_REPLY_${run}_${name}` };
    report.cases.push(s);
    await context.addInitScript(({ appPath }) => {
        window.__editorsDocumentId = crypto.randomUUID(); window.__editorNativeWorldWrites = [];
        if (location.pathname.startsWith(appPath)) localStorage.setItem('tavern-lite:engine-mode', 'auto');
    }, { appPath: EXT + 'app/' });
    const readPaths = new Set(['/api/plugins/tavern-lite-save/probe', '/api/extensions/version', '/api/ping', '/api/avatars/get', '/api/backgrounds/all', '/api/backgrounds/folders', '/api/image-metadata/all',
        '/api/extensions/manifest', '/api/users/list', '/api/assets/get', '/api/files/sanitize-filename']);
    await context.route('**/*', async route => {
        try {
            const request = route.request(), url = new URL(request.url()), p = url.pathname;
            const json = (value, status = 200) => route.fulfill({ status, json: value });
            const actual = async () => { if (p.startsWith('/api/')) s.forwardedApis.push({ phase: s.phase, path: p }); return route.fetch({ maxRedirects: 0 }); };
            if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
            if (url.origin !== BASE) { s.blocked.push({ phase: s.phase, kind: 'external', origin: url.origin, path: p }); return route.abort('blockedbyclient'); }
            if (p === '/__editors-integration/storage-fault.mjs') {
                assert.ok(s.mode); return route.fulfill({ contentType: 'text/javascript', body: s.name.startsWith('scoped-') ? scopedFaultModule(s.mode) : storageFaultModule(s.mode) });
            }
            if (p === EXT + 'bridge.js') {
                const r = await actual(), source = await r.text(); assert.ok(r.ok()); report.artifacts[p] = sha(source);
                let body=source;
                if(s.name.startsWith('scoped-')) {
                    const target='const presetEditor = createNativePresetEditor({';
                    assert.equal(body.split(target).length,2);
                    body='import { createPresetEditorJournal as __testReceipt } from "./bridge-preset-editor.js";\n'+body.replace(target,target+'\n    journal: __testReceipt(window.__editorDeniedReceipt),');
                }
                return route.fulfill({ response: r, body: (s.mode ? 'import "/__editors-integration/storage-fault.mjs";\n' : '') + body });
            }
            if (p === '/scripts/world-info.js') {
                const r = await actual(), source = await r.text();
                const signature = 'export async function saveWorldInfo(name, data, immediately = false) {';
                assert.equal(source.split(signature).length, 2);
                return route.fulfill({ response: r, body: source.replace(signature, signature + `\nwindow.__editorNativeWorldWrites.push({at:Date.now(),owned:name===${JSON.stringify(book)},immediately:!!immediately});`) });
            }
            if (p.startsWith(EXT + 'app/assets/') && /\.(?:js|css)$/.test(p)) {
                const r = await actual(), source = await r.text(); report.artifacts[p] = sha(source); return route.fulfill({ response: r, body: source });
            }
            if (p === '/api/settings/get') {
                const r = await actual(), data = await r.json(), settings = clone(baseline.settings), fixture = presetFixture();
                Object.assign(settings, { active_character: null, active_group: null, firstRun: false, main_api: 'openai', name1: 'Synthetic Reader', api_server: '', api_server_textgenerationwebui: '' });
                settings.power_user = { ...settings.power_user, auto_connect: false, personas: {}, persona_descriptions: {}, persona_description: '', persona_description_lorebook: '' };
                settings.world_info_settings = { ...settings.world_info_settings, world_info: { globalSelect: [], charLore: [] }, world_info_budget: 25, world_info_budget_cap: 0, world_info_recursive: false };
                settings.extension_settings = { disabledExtensions: inventory.filter(x => x.name !== 'third-party/emmalike').map(x => x.name), connectionManager: { profiles: [], selectedProfile: '' } };
                settings.oai_settings = { ...settings.oai_settings, ...fixture, temp_openai: fixture.temperature, preset_settings_openai: presetName,
                    chat_completion_source: 'custom', custom_url: 'http://editors-mock.invalid/v1', custom_model: 'editors-mock',
                    bind_preset_to_connection: false, stream_openai: false, openai_max_context: 32768, openai_max_tokens: 512 };
                const owned = data.openai_setting_names.map((name, i) => [name, data.openai_settings[i]]).filter(([name]) => name === presetName);
                assert.equal(owned.length, 1); data.openai_setting_names = owned.map(x => x[0]); data.openai_settings = owned.map(x => x[1]);
                data.world_names = [book]; data.settings = JSON.stringify(settings); return route.fulfill({ response: r, json: data });
            }
            if (['/api/settings/save', '/api/quick-replies/save', '/api/stats/update'].includes(p)) {
                s.blocked.push({ phase: s.phase, path: p, kind: 'preserve-settings/native-init' }); return json({ result: 'ok' });
            }
            if (p === '/api/secrets/read' || p === '/api/secrets/find' || p === '/api/stats/get') return json({});
            if (p === '/api/groups/all' || p === '/api/chats/recent') return json([]);
            if (p === '/api/characters/all') { const r = await actual(); return route.fulfill({ response: r, json: (await r.json()).filter(x => x.avatar === avatar) }); }
            if (p === '/api/extensions/discover') return json(inventory);
            if (p === '/api/worldinfo/list') { const r = await actual(); return route.fulfill({ response: r, json: (await r.json()).filter(x => x.file_id === book) }); }
            if (p === '/api/worldinfo/get') {
                assert.equal(responseBody(request).name, book, 'No reading unrelated world bodies');
                if (s.fault === '500-unreadable' && s.faultArmed) return json({ error: 'Synthetic readback unavailable' }, 503);
                return route.fulfill({ response: await actual() });
            }
            // Every provider/remote-tokenizer path is handled before generic GETs.
            if (modelPath(p)) {
                if (p === '/api/backends/chat-completions/status') return json({ data: [{ id: 'editors-mock', object: 'model' }] });
                if (p === '/api/tokenizers/openai/count') return json({ token_count: 32 });
                if (p === '/api/tokenizers/openai/encode') return json({ ids: [1, 2], chunks: ['synthetic'], count: 2 });
                if (p === '/api/sd/comfy/workflows' || /\/horde\/(text-models|text-workers|sd-models|sd-samplers)$/.test(p)) return json([]);
                if (p === '/api/backends/chat-completions/generate') {
                    const data = responseBody(request), text = JSON.stringify(data.messages);
                    const record = { at: Date.now(), phase: s.phase, requestHash: hash(data), worldIncluded: text.includes(s.expectedWorld),
                        phantomIncluded: [...s.phantom].some(marker => text.includes(marker)), model: data.model, mocked: true };
                    s.models.push(record); assert.equal(data.model, 'editors-mock'); assert.ok(record.worldIncluded, 'Actual native prompt must include server world body');
                    assert.equal(record.phantomIncluded, false, 'Unconfirmed phantom world text must never reach a model request');
                    if (data.stream) return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: s.reply }, finish_reason: null }] })}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n` });
                    return json({ choices: [{ index: 0, message: { role: 'assistant', content: s.reply }, finish_reason: 'stop' }] });
                }
                s.blocked.push({ phase: s.phase, path: p, kind: 'provider/remote-tokenizer' }); return json({ error: 'Real model/provider access disabled' }, 503);
            }
            if (p === '/api/worldinfo/edit') {
                const data = responseBody(request); assert.equal(data.name, book); assert.equal(data.data?.extensions?.integrationFixture, run);
                const record = { phase: s.phase, at: Date.now(), expectedHash: hash(data.data), forwarded: !s.fault.startsWith('500') }; s.worldWrites.push(record);
                if (s.fault.startsWith('500')) { s.faultArmed = true; record.status = 500; return json({ error: 'Synthetic HTTP 500; no product-visible proof of non-dispatch' }, 500); }
                const r = await actual(); record.status = r.status(); return route.fulfill({ response: r });
            }
            if (p === '/api/presets/save') {
                const data = responseBody(request); assert.equal(data.apiId, 'openai'); assert.equal(data.name, presetName); assert.equal(data.preset?.integrationFixture, run);
                s.presetWrites.push({ phase: s.phase, at: Date.now(), hash: hash(data.preset) }); return route.fulfill({ response: await actual() });
            }
            if (['/api/chats/get', '/api/chats/save', '/api/characters/get', '/api/characters/chats'].includes(p)) {
                const data = responseBody(request); assert.equal(data.avatar_url, avatar);
                if (data.file_name) assert.ok(files.has(data.file_name) || s.allowInitial && data.file_name === initialChat);
                if (p === '/api/chats/save') { assert.notEqual(data.force, true); s.chatWrites.push({ phase: s.phase, file: data.file_name, at: Date.now(), hash: hash(data.chat) }); }
                return route.fulfill({ response: await actual() });
            }
            if (p === '/api/characters/edit' && request.headers()['content-type']?.includes('multipart/form-data')) {
                const text = request.postData() || '', field = key => text.match(new RegExp(`name="${key}"\\r?\\n\\r?\\n([^\\r\\n]+)`))?.[1];
                assert.equal(field('avatar_url'), avatar); assert.ok(files.has(field('chat')) || s.allowInitial && field('chat') === initialChat);
                return route.fulfill({ response: await actual() });
            }
            if (['/api/characters/edit-attribute', '/api/characters/merge-attributes'].includes(p)) {
                const data = responseBody(request); assert.equal(data.avatar_url ?? data.avatar, avatar); return route.fulfill({ response: await actual() });
            }
            if (p.startsWith('/api/tokenizers/') && !p.startsWith('/api/tokenizers/remote/')) return json({ count: 32, ids: [1, 2], chunks: ['synthetic'] });
            // Static files go to the browser itself: forwarding them through route.fetch without retries reused a socket
            // the server had closed (socket hang up), the script was blocked and the full app never started.
            if (!p.startsWith('/api/') && ['GET', 'HEAD'].includes(request.method())) return route.continue();
            if (!p.startsWith('/api/') || ['GET', 'HEAD'].includes(request.method()) || readPaths.has(p)) return route.fulfill({ response: await actual() });
            s.blocked.push({ phase: s.phase, path: p, kind: 'unexpected-write' }); return json({ error: 'Only exact owned fixture writes are allowed' }, 409);
        } catch (error) {
            s.routeErrors.push({ phase: s.phase, message: error.message }); await route.abort('blockedbyclient').catch(() => {});
        }
    });
    s.page = await context.newPage(); s.page.setDefaultTimeout(30000);
    s.page.on('pageerror', error => s.pageErrors.push({ phase: s.phase, name: error.name, message: error.message, stack: error.stack }));
    return s;
}

async function send(s, label) {
    s.phase = label; const before = s.models.length, text = `SYNTHETIC_SEND_${label}_${run}`;
    unwrap(await invoke(s, 'send', text, { scope: { avatar, file: s.file } }));
    await s.page.waitForFunction(({ reply, text }) => {
        const w = document.querySelector('iframe.engine')?.contentWindow, chat = w?.SillyTavern?.getContext().chat;
        return !w?.TavernLiteBridge?.isGenerating() && chat?.some(m => m.is_user && m.mes === text) && chat.at(-1)?.mes === reply;
    }, { reply: s.reply, text }, { timeout: 60000 });
    check(`${s.name}/${label}: actual bridge send completed with exactly one mock`, s.models.length === before + 1);
    unwrap(await invoke(s, 'worldEditorBook', book)); // queued work after send must remain live
}
async function concurrentReads(s, label) {
    s.phase = label;
    const [world, preset] = await bounded(Promise.all([invoke(s, 'worldEditorBook', book), invoke(s, 'presetEditorState')]), label);
    assert.equal(unwrap(world).name, book); assert.equal(unwrap(preset).name, presetName);
    check(`${s.name}/${label}: concurrent real bridge editor reads settle`, true);
}
async function storageCase(s) {
    await ready(s); await openOwnedChat(s); await concurrentReads(s, 'storage-concurrent-reads');
    s.phase = 'denied-writes';
    const state = unwrap(await invoke(s, 'presetEditorState'));
    assert.equal(state.capabilities.namedWrite, false); assert.ok(state.storageError);
    const world = unwrap(await invoke(s, 'worldEditorBook', book));
    s.phantom.add(`DENIED_${run}`);
    const writesBefore = await native(s, w => w.__editorNativeWorldWrites.length), httpBefore = s.presetWrites.length;
    const worldSave = await invoke(s, 'saveWorldEditorEntry', { account: ACCOUNT, name: book, uid: 0, baseEntry: world.entries[0], patch: { content: `DENIED_${run}` }, draftRevision: 1 });
    const presetSave = await invoke(s, 'presetEditorSave', { account: ACCOUNT, name: presetName });
    check(`${s.name}: world write rejects before native save`, !worldSave.ok && worldSave.error.code === 'WORLD_JOURNAL_UNAVAILABLE'
        && await native(s, w => w.__editorNativeWorldWrites.length) === writesBefore && s.worldWrites.length === 0);
    check(`${s.name}: named preset write rejects before HTTP`, !presetSave.ok && presetSave.error.code === 'PRESET_RECEIPT_UNAVAILABLE' && s.presetWrites.length === httpBefore);
    assert.equal(unwrap(await invoke(s, 'worldEditorRuntime')).kind, 'ready');
    await send(s, 'ordinary-send-with-storage-denied');
    const evidence = await native(s, w => w.__editorStorage);
    check(`${s.name}: injected denial actually exercised`, evidence[s.mode === 'getter' ? 'getters' : 'methods'] > 0, evidence);
    s.storageEvidence = evidence;
}
async function nativeStorageBaseline(s) {
    s.phase = 'native-only-bootstrap';
    await s.page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await s.page.waitForFunction(() => { const c = window.SillyTavern?.getContext?.(); return c?.eventSource?.autoFireLastArgs?.has(c.eventTypes.APP_READY); }, null, { timeout: 240000 });
    s.phase = 'native-only-storage-denial';
    const beforeApis = s.forwardedApis.length, beforeWorld = s.worldWrites.length, beforePreset = s.presetWrites.length;
    const result = await bounded(s.page.evaluate(async ({ avatar, file, property }) => {
        if (window.TavernLiteBridge) throw new Error('Native baseline must not install the light bridge');
        const c = window.SillyTavern.getContext(), index = c.characters.findIndex(x => x.avatar === avatar);
        if (index < 0) throw new Error('Unique fixture missing');
        const previous = Object.getOwnPropertyDescriptor(window, property);
        const result = { property, bridgeInstalled: false, denialCount: 0, denialStacks: [], calls: [], error: null };
        Object.defineProperty(window, property, { configurable: true, get() {
            result.denialCount++;
            // Chromium DOMException has no .stack. Capture the actual getter's
            // caller stack at the throw boundary; preserve DOMException identity.
            const stack = new Error(`Native ${property} denial caller trace`).stack;
            result.denialStacks.push(stack);
            const error = new DOMException(`Synthetic native baseline ${property} denial`, 'SecurityError');
            Object.defineProperty(error, 'stack', { value: stack }); throw error;
        } });
        try {
            result.calls.push({ method: 'ctx.selectCharacterById', at: Date.now() });
            await c.selectCharacterById(index, { switchMenu: false });
            result.calls.push({ method: 'ctx.openCharacterChat', at: Date.now() });
            await window.SillyTavern.getContext().openCharacterChat(file);
            result.currentIsTarget = window.SillyTavern.getContext().getCurrentChatId() === file;
        } catch (error) { result.error = { name: error.name, code: error.code, message: error.message, stack: error.stack }; }
        finally {
            if (previous) Object.defineProperty(window, property, previous); else delete window[property];
        }
        return result;
    }, { avatar, file: s.file, property: s.name === 'native-idb-getter' ? 'indexedDB' : 'localStorage' }), s.name);
    s.nativeBaseline = { ...result, actualApiCalls: s.forwardedApis.slice(beforeApis), worldWrites: s.worldWrites.length - beforeWorld, presetWrites: s.presetWrites.length - beforePreset };
    await log('native-storage-baseline-result', { case: s.name, ...s.nativeBaseline });
    check(`${s.name}: no new editor or light bridge involved`, !result.bridgeInstalled && !s.worldWrites.length && !s.presetWrites.length && !s.models.length);
    if (s.name === 'native-idb-getter') check('Native select/open completes with only IndexedDB getter denied', !result.error && result.currentIsTarget);
    else check('Native select/open itself reproduces localStorage SecurityError', result.error?.name === 'SecurityError' && result.denialCount > 0 && !!result.error.stack);
}
async function episodesDefault(s, label) {
    const value=await native(s,w=>({stored:w.localStorage.getItem('tavern-lite:episodes-enabled:'+JSON.stringify('default-user')),enabled:w.TavernLiteBridge.episodeStatus().enabled}));
    check(`${s.name}/${label}: episodes retain absent preference and enabled default`,value.stored===null&&value.enabled===true,value);
}
async function scopedStorageCase(s) {
    await ready(s); await episodesDefault(s,'before'); await openOwnedChat(s); await concurrentReads(s,'scoped-concurrent-reads');
    s.phase='scoped-denied-writes';
    const state=unwrap(await invoke(s,'presetEditorState'));
    check(`${s.name}: receipt length denial disables named saving visibly`,state.capabilities.namedWrite===false&&!!state.storageError);
    const world=unwrap(await invoke(s,'worldEditorBook',book)), before=await native(s,w=>w.__editorNativeWorldWrites.length);
    const attempt=await invoke(s,'saveWorldEditorEntry',{account:ACCOUNT,name:book,uid:0,baseEntry:world.entries[0],patch:{content:`DENIED_${run}`},draftRevision:1});
    check(`${s.name}: IDB rejection causes zero native world save and zero world HTTP`,!attempt.ok&&attempt.error.code==='WORLD_JOURNAL_UNAVAILABLE'&&await native(s,w=>w.__editorNativeWorldWrites.length)===before&&s.worldWrites.length===0);
    for(const mode of ['length','list-get','put']) {
        const beforePaths=await native(s,(w,mode)=>{w.__editorStorage.receiptMode=mode;return w.__editorStorage.receipt.length;},mode);
        const value=await invoke(s,'presetEditorSave',{account:ACCOUNT,name:presetName});
        check(`${s.name}: real receipt ${mode} failure rejects named save before HTTP`,!value.ok&&value.error.code==='PRESET_RECEIPT_UNAVAILABLE'&&s.presetWrites.length===0);
        const paths=await native(s,(w,index)=>w.__editorStorage.receipt.slice(index),beforePaths);
        check(`${s.name}: ${mode} denial reaches its intended storage path`,paths.includes(mode==='length'?'length':mode==='list-get'?'getItem':'setItem'),paths);
    }
    // put first reads its prior revision. Permit that empty read only in put
    // mode, so the test still reaches a real setItem denial. Recovery separately
    // rejects getItem; this does not weaken either production error assertion.
    await native(s,w=>{w.__editorStorage.receiptMode='get';});
    const recovery=await invoke(s,'presetEditorRecover',{account:ACCOUNT,name:presetName,operationId:'synthetic-not-submitted'});
    check(`${s.name}: receipt get failure rejects recovery without HTTP save`,!recovery.ok&&recovery.error.code==='PRESET_RECEIPT_UNAVAILABLE'&&s.presetWrites.length===0);
    await native(s,w=>{w.__editorStorage.receiptMode='length';});
    await navigate(s,'#preset');
    await s.page.getByRole('button',{name:'保存到此预设',exact:true}).waitFor();
    check(`${s.name}: actual preset UI exposes receipt error and disables named action`,await s.page.getByRole('button',{name:'保存到此预设',exact:true}).isDisabled()&&await s.page.locator('.tl-preset-page .tl-error').count()>0);
    await navigate(s,'#'+new URLSearchParams({world:book,entry:'0'}));
    await s.page.locator('#tl-wi-content').fill(`UNSAVED_${run}`);
    check(`${s.name}: actual world UI is read only for persistence while text remains visible`,await s.page.locator('.tl-entry-editor').getByRole('button',{name:'保存',exact:true}).isDisabled()&&await s.page.locator('.tl-entry-editor .tl-error').count()>0);
    s.phantom.add(`UNSAVED_${run}`); await navigate(s,'#me');
    await send(s,'ordinary-send-global-idb-denied'); await episodesDefault(s,'after');
    s.storageEvidence=await native(s,w=>w.__editorStorage);
    check(`${s.name}: all actual receipt paths and IDB denial were exercised`,s.storageEvidence.nativeLocalStorageAccessible&&s.storageEvidence[s.mode==='idb-getter'?'getters':'methods']>0&&['length','key','getItem','setItem'].every(k=>s.storageEvidence.receipt.includes(k)),s.storageEvidence);
}
async function shellStorageCase(s) {
    await ready(s); await openOwnedChat(s); await episodesDefault(s,'before');
    s.phase='shell-storage-fault';
    await s.page.evaluate(mode=>{
        const prefixes={worldDraft:'tavern-lite:world-draft:v1:',presetDraft:'tavern-lite:preset-draft:',worldView:'tavern-lite:world-view:',presetView:'tavern-lite:preset-view:'};
        const evidence=window.__editorShellStorage={realm:'outer-shell',mode,accesses:[]};
        for(const method of ['getItem','setItem','removeItem']) {
            const original=Storage.prototype[method];
            Storage.prototype[method]=function(key,...args){
                const category=Object.keys(prefixes).find(k=>String(key).startsWith(prefixes[k]));
                if(category){const denied=category.endsWith('View')|| (mode==='read'?method==='getItem':method!=='getItem');
                    evidence.accesses.push({category,method,denied}); if(denied)throw new DOMException('Synthetic editor-key storage denial','SecurityError');}
                return original.call(this,key,...args);
            };
        }
    },s.name.endsWith('-read')?'read':'write');
    await navigate(s,'#'+new URLSearchParams({world:book,entry:'0'}));
    const worldText=`SHELL_WORLD_UNSAVED_${run}`;s.phantom.add(worldText);
    await s.page.locator('#tl-wi-content').fill(worldText);
    await s.page.getByRole('group',{name:'显示设置',exact:true}).getByRole('button',{name:'全部设置',exact:true}).click();
    check(`${s.name}: world draft failure retains current input and blocks persistence`,await s.page.locator('#tl-wi-content').inputValue()===worldText&&await s.page.locator('.tl-entry-editor').getByRole('button',{name:'保存',exact:true}).isDisabled()&&await s.page.locator('.tl-entry-editor .tl-error').count()>0);
    if(s.name.endsWith('-write')) {
        await navigate(s,'#'+new URLSearchParams({world:book}));
        await s.page.getByRole('button',{name:'＋ 新条目',exact:true}).click();
        check(`${s.name}: failed blank-draft removal does not navigate to a new entry`,await s.page.locator('.tl-world-book').count()===1&&await s.page.locator('.tl-world-save-status').innerText().then(t=>t.includes('存不了')));
    }
    await navigate(s,'#preset');
    await s.page.getByRole('group',{name:'预设设置显示范围'}).getByRole('button',{name:'全部设置',exact:true}).click();
    await s.page.locator('.tl-preset-open').filter({hasText:'主提示词'}).click();
    const presetText=`SHELL_PRESET_UNAPPLIED_${run}`;s.phantom.add(presetText);
    await s.page.locator('#tl-prompt-text').fill(presetText);
    check(`${s.name}: preset draft error keeps unapplied text with explicit warning`,await s.page.locator('#tl-prompt-text').inputValue()===presetText&&await s.page.locator('.tl-prompt-editor .tl-error').count()>0);
    if(s.name.endsWith('-write')) {
        await s.page.locator('.tl-prompt-editor .tl-page-header button').first().click();
        await s.page.getByRole('button',{name:'放弃没应用的文字，返回',exact:true}).click();
        check(`${s.name}: failed removal keeps prompt and typed text`,await s.page.locator('#tl-prompt-text').inputValue()===presetText);
    }
    await navigate(s,'#me'); await send(s,'ordinary-send-editor-key-storage-denied'); await episodesDefault(s,'after');
    s.shellStorageEvidence=await s.page.evaluate(()=>window.__editorShellStorage);
    const accessed=(category,method,denied=true)=>s.shellStorageEvidence.accesses.some(a=>a.category===category&&a.method===method&&a.denied===denied);
    const method=s.name.endsWith('-read')?'getItem':'setItem';
    check(`${s.name}: both draft stores and both view get/set faults exercised`,['worldDraft','presetDraft'].every(c=>accessed(c,method))&&['worldView','presetView'].every(c=>accessed(c,'getItem')&&accessed(c,'setItem')),s.shellStorageEvidence);
    if(method==='setItem')check(`${s.name}: both actual UI draft removal failures exercised`,['worldDraft','presetDraft'].every(c=>accessed(c,'removeItem')));
    check(`${s.name}: UI storage faults cause zero world native save and zero editor HTTP`,await native(s,w=>w.__editorNativeWorldWrites.length)===0&&s.worldWrites.length===0&&s.presetWrites.length===0);
}
async function layout(s, label, selector, actionSelector) {
    await s.page.locator(selector).waitFor({ state: 'visible' });
    await s.page.locator(actionSelector).first().scrollIntoViewIfNeeded();
    const value = await s.page.evaluate(({ selector, actionSelector }) => {
        const page = document.querySelector(selector), button = document.querySelector(actionSelector), rect = button?.getBoundingClientRect();
        const style = button && getComputedStyle(button), pageStyle = page && getComputedStyle(page);
        const role = document.querySelector('.tl-preset-row .tl-prompt-role'), roleStyle = role && getComputedStyle(role);
        return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, pageWidth: page?.getBoundingClientRect().width,
            button: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, buttonFont: style?.fontSize,
            minHeight: style?.minHeight, pageDisplay: pageStyle?.display,
            promptRole: roleStyle && { text: role.textContent, marginLeft: roleStyle.marginLeft, marginRight: roleStyle.marginRight,
                font: roleStyle.font, fontSize: roleStyle.fontSize, lineHeight: roleStyle.lineHeight, letterSpacing: roleStyle.letterSpacing } };
    }, { selector, actionSelector });
    assert.ok(value.documentWidth <= value.width + 2, `${label}: horizontal overflow`);
    assert.ok(value.button && value.button.width >= 40 && value.button.height >= 40 && value.button.x >= -1 && value.button.x + value.button.width <= value.width + 1);
    assert.notEqual(value.pageDisplay, 'none'); s.layouts.push({ label, ...value });
    await s.page.screenshot({ path: path.join(output, `${s.name}-${label}.png`), fullPage: false });
}
async function worldUi(s) {
    s.phase = 'world-ui'; await navigate(s, '#' + new URLSearchParams({ world: book, entry: '0' }));
    const content = `SERVER_UI_${run}_${s.name}`;
    await s.page.locator('#tl-wi-content').fill(content);
    await layout(s, 'world-layout', '.tl-entry-editor', '.tl-entry-editor .tl-page-header button.tl-primary');
    const before = s.worldWrites.length;
    await s.page.locator('.tl-entry-editor').getByRole('button', { name: '保存', exact: true }).click();
    await s.page.waitForFunction(() => document.querySelector('.tl-world-save-status')?.textContent.includes('已确认存好'), null, { timeout: 45000 });
    const disk = await jsonPost('/api/worldinfo/get', { name: book });
    check(`${s.name}: real world UI save/readback`, disk.entries[0].content === content && disk.entries[0].untouched.keep && s.worldWrites.length === before + 1);
    s.expectedWorld = content;
}
async function presetUi(s) {
    s.phase = 'preset-ui'; await navigate(s, '#preset');
    await s.page.getByRole('button', { name: '保存到此预设', exact: true }).waitFor();
    await layout(s, 'preset-layout', '.tl-preset-page', '.tl-preset-savebar button.tl-primary');
    const state = unwrap(await invoke(s, 'presetEditorState'));
    const prompt = state.prompts.find(p => p.identifier === 'main'); assert.ok(prompt?.canEdit);
    // Apply through the real bridge to avoid depending on translated prompt labels;
    // the persistent save action and its resulting status are exercised via UI.
    unwrap(await invoke(s, 'presetEditorApplyPrompt', { account: ACCOUNT, name: presetName, identifier: 'main', base: prompt.content, text: `PROMPT_UI_${run}_${s.name}` }));
    const before = s.presetWrites.length;
    await s.page.getByRole('button', { name: '保存到此预设', exact: true }).click();
    await s.page.waitForFunction(() => document.querySelector('.tl-preset-savebar [role="status"]')?.textContent.includes('已存进预设；之后'), null, { timeout: 45000 });
    const disk = (await catalog()).presets.get(presetName);
    check(`${s.name}: real preset UI named save/readback`, s.presetWrites.length === before + 1 && disk.prompts.find(p => p.identifier === 'main').content === `PROMPT_UI_${run}_${s.name}`);
    await native(s, w => w.TavernLiteNativeSettle.observer.wait());
    s.dryRuns.push({ stage: 'after-preset-render/save', events: await native(s, w => w.__editorDryRuns) });
}
async function phantomAttempt(s, content, unreadable) {
    s.phase = unreadable ? 'world-500-readback503' : 'world-500-readable-old'; s.phantom.add(content);
    const before = unwrap(await invoke(s, 'worldEditorBook', book));
    s.fault = unreadable ? '500-unreadable' : '500'; s.faultArmed = false;
    const answer = await invoke(s, 'saveWorldEditorEntry', { account: ACCOUNT, name: book, uid: 0, baseEntry: before.entries[0], patch: { content }, draftRevision: 2 });
    s.fault = ''; s.faultArmed = false; const result = unwrap(answer);
    assert.equal(hash(await jsonPost('/api/worldinfo/get', { name: book })), hash(before.snapshot), 'Injected HTTP 500 must leave actual server body unchanged');
    return result;
}
async function gateCase(s) {
    // Editors have completed their UI saves before generation assertions.
    await navigate(s, '#me'); await concurrentReads(s, 'pre-fault-queue');
    const known = await phantomAttempt(s, `PHANTOM_READABLE_OLD_${run}`, false);
    check('500 plus complete OLD readback is still unknown and leaves this document dirty', known.kind === 'unconfirmed'
        && unwrap(await invoke(s, 'worldEditorRuntime')).kind === 'dirty');
    const firstWriteCount = s.worldWrites.length;
    const firstPreview = unwrap(await invoke(s, 'prepareWorldOperationDecision', { account: ACCOUNT, operationId: known.operation.operationId }));
    const firstDecision = unwrap(await invoke(s, 'resolveWorldOperation', { ...firstPreview, acknowledgement: 'late-write-can-overwrite-v1' }));
    check('only explicit user decision ends the first unknown lock without a retry or saved claim', firstDecision.kind === 'user-resolved'
        && firstDecision.operation.stage === 'unconfirmed' && !!firstDecision.operation.userDecision && s.worldWrites.length === firstWriteCount);
    const unknown = await phantomAttempt(s, `PHANTOM_UNKNOWN_${run}`, true);
    check('500 plus unreadable independent readback leaves current iframe dirty', unknown.kind === 'unconfirmed'
        && unwrap(await invoke(s, 'worldEditorRuntime')).kind === 'dirty');
    s.phase = 'blocked-send'; const modelBefore = s.models.length, chatBefore = await native(s, w => w.SillyTavern.getContext().chat.length);
    const rejected = await invoke(s, 'send', `MUST_NOT_APPEND_${run}`, { scope: { avatar, file: s.file } });
    check('dirty world gate rejects actual bridge send before chat append or model request', !rejected.ok && rejected.error.code === 'WORLD_RUNTIME_UNCONFIRMED'
        && s.models.length === modelBefore && await native(s, w => w.SillyTavern.getContext().chat.length) === chatBefore);
    // The same failed operation must not poison the common queue.
    await concurrentReads(s, 'reads-after-gate-rejection');
    s.phase = 'server-authority'; const writesBefore = s.worldWrites.length;
    const authority = unwrap(await invoke(s, 'useWorldServerAuthority', { account: ACCOUNT, name: book }));
    check('explicit server authority restores runtime without an HTTP write', authority.kind === 'ready' && s.worldWrites.length === writesBefore
        && authority.snapshot.entries[0].content === s.expectedWorld);
    await send(s, 'send-after-server-authority');
    const recovered = unwrap(await invoke(s, 'recoverWorldEditorWrite', { account: ACCOUNT, operationId: unknown.operation.operationId }));
    check('OLD recovery after explicit authority retains unknown but does not dirty accepted runtime', recovered.kind === 'unconfirmed'
        && recovered.runtimeState === 'ready' && s.worldWrites.length === writesBefore);
    const secondPreview = unwrap(await invoke(s, 'prepareWorldOperationDecision', { account: ACCOUNT, operationId: unknown.operation.operationId }));
    const secondDecision = unwrap(await invoke(s, 'resolveWorldOperation', { ...secondPreview, acknowledgement: 'late-write-can-overwrite-v1' }));
    check('explicit decision is required before another same-book write', secondDecision.kind === 'user-resolved' && s.worldWrites.length === writesBefore);
    const retained = await phantomAttempt(s, `PHANTOM_RELOAD_${run}`, true); assert.equal(retained.kind, 'unconfirmed');
    const oldId = s.documents.at(-1).id, beforeReloadWrites = s.worldWrites.length, id = await ready(s, true);
    assert.notEqual(id, oldId, 'Outer reload must create a new native iframe document');
    assert.equal(unwrap(await invoke(s, 'worldEditorRuntime')).kind, 'ready');
    const records = unwrap(await invoke(s, 'worldEditorUnfinished'));
    check('fresh iframe retains old unknown journal as recovery data without becoming dirty', records.some(x => x.operationId === retained.operation.operationId)
        && unwrap(await invoke(s, 'worldEditorRuntime')).kind === 'ready' && s.worldWrites.length === beforeReloadWrites);
    const record = unwrap(await invoke(s, 'worldEditorOperation', retained.operation.operationId));
    assert.equal(record.stage, 'unconfirmed');
    await openOwnedChat(s); await send(s, 'ordinary-send-with-old-journal');
    const restored = unwrap(await invoke(s, 'recoverWorldEditorWrite', { account: ACCOUNT, operationId: retained.operation.operationId }));
    check('fresh iframe OLD recovery retains unknown as read-only recovery data, never resubmits old phantom', restored.kind === 'unconfirmed' && restored.runtimeState === 'ready'
        && s.worldWrites.length === beforeReloadWrites);
}
async function runCase(name) {
    // A completed case's context is closed before resetting its owned fixtures.
    assert.ok((await post('/api/worldinfo/edit', { name: book, data: worldFixture() })).ok());
    assert.ok((await post('/api/presets/save', { apiId: 'openai', name: presetName, preset: presetFixture() })).ok());
    const s = await newSession(name); await log('case-started', { case: name });
    try {
        if (name.startsWith('native-')) await nativeStorageBaseline(s);
        else if(name.startsWith('scoped-')) await scopedStorageCase(s);
        else if(name.startsWith('shell-')) await shellStorageCase(s);
        else if (s.mode) await storageCase(s);
        else {
            await ready(s); await openOwnedChat(s); await concurrentReads(s, 'initial-concurrent-reads');
            if (name === 'world-preset') { await worldUi(s); await presetUi(s); }
            else { await presetUi(s); await worldUi(s); }
            // Revisit both already-loaded chunks to catch CSS order dependence.
            await navigate(s, '#preset'); await layout(s, 'preset-revisit', '.tl-preset-page', '.tl-preset-savebar button.tl-primary');
            await navigate(s, '#' + new URLSearchParams({ world: book, entry: '0' }));
            await layout(s, 'world-revisit', '.tl-entry-editor', '.tl-entry-editor .tl-page-header button.tl-primary');
            await send(s, 'send-after-both-editors');
            if (name === 'world-preset') await gateCase(s);
        }
        if (!name.startsWith('native-')) {
            s.nativeWorldWrites = await native(s, w => w.__editorNativeWorldWrites);
            s.dryRuns.push({ stage: 'case-end', events: await native(s, w => w.__editorDryRuns) });
        }
        check(`${name}: no actual provider/remote tokenizer request forwarded`, !s.forwardedApis.some(x => modelPath(x.path)));
        check(`${name}: no request guard errors`, s.routeErrors.length === 0, s.routeErrors);
        check(`${name}: no unexpected mutations attempted`, !s.blocked.some(x => x.kind === 'unexpected-write'));
        if (!name.startsWith('native-')) check(`${name}: no uncaught page errors`, s.pageErrors.length === 0, s.pageErrors);
        else check(`${name}: all native page errors are retained and attributable to injected storage denial`,
            s.pageErrors.every(error => error.name === 'SecurityError' && error.message.includes('Synthetic native baseline')), s.pageErrors);
        s.passed = true;
    } catch (error) {
        s.failure = { phase: s.phase, message: error.message, stack: error.stack };
        await s.page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: false }).catch(() => {});
        throw error;
    } finally {
        await contextClose(s); await log('case-finished', { case: name, passed: !!s.passed, failure: s.failure?.message });
    }
}
async function contextClose(s) {
    if (contexts.has(s.context)) { await s.context.close(); contexts.delete(s.context); }
    delete s.context; delete s.page; s.phantom = [...s.phantom];
}
async function protectExisting() {
    const after = await catalog();
    check('Existing account settings and connection profiles unchanged', after.settingsHash === baseline.settingsHash && after.profileHash === baseline.profileHash);
    check('Existing named preset content unchanged', hash(originalPresets(after.presets)) === hash(originalPresets(baseline.presets)));
    check('Existing world catalog metadata unchanged', hash(originalWorlds(await jsonPost('/api/worldinfo/list', {}))) === hash(originalWorlds(baseline.worlds)));
    check('Existing character inventory unchanged', hash((await jsonPost('/api/characters/all', {})).map(x => x.avatar).filter(x => x !== avatar).sort()) === hash(baseline.avatars));
}
try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    await environment(); await makeFixtures();
    for (const name of cases) await runCase(name);
    const roleSamples = report.cases.flatMap(s => s.layouts.filter(x => x.label.startsWith('preset-')).map(x => ({ case: s.name, label: x.label, computed: x.promptRole })));
    if (roleSamples.length) {
        assert.ok(roleSamples.every(x => x.computed), 'The first real preset prompt role must be measured');
        check('Prompt role spacing/font remain identical before/after world chunk and across both lazy orders',
            roleSamples.every(x => hash(x.computed) === hash(roleSamples[0].computed)), roleSamples);
    }
    await protectExisting();
} catch (error) { fatal = { message: error.message, stack: error.stack }; console.error('FAIL', error.message); }
finally {
    for (const context of contexts) await context.close().catch(() => {});
    if (fixtureReady) try {
        // Only exact names verified absent before the first write are removable.
        if (avatar) {
            const character = await jsonPost('/api/characters/get', { avatar_url: avatar }); assert.equal(character.name, run);
            assert.ok((await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true })).ok());
        }
        const worlds = await jsonPost('/api/worldinfo/list', {});
        if (worlds.some(x => x.file_id === book)) { assert.equal((await jsonPost('/api/worldinfo/get', { name: book })).extensions.integrationFixture, run); assert.ok((await post('/api/worldinfo/delete', { name: book })).ok()); }
        const presets = (await catalog()).presets;
        if (presets.has(presetName)) { assert.equal(presets.get(presetName).integrationFixture, run); assert.ok((await post('/api/presets/delete', { apiId: 'openai', name: presetName })).ok()); }
        await protectExisting();
        report.cleanup = !(await jsonPost('/api/characters/all', {})).some(x => x.avatar === avatar)
            && !(await jsonPost('/api/worldinfo/list', {})).some(x => x.file_id === book) && !(await catalog()).presets.has(presetName);
        assert.equal(report.cleanup, true); await log('owned-fixtures-cleaned');
    } catch (error) { report.cleanupError = error.message; fatal ??= { message: error.message, stage: 'cleanup' }; }
    await admin?.close().catch(() => {}); await browser?.close().catch(() => {});
    report.fatal = fatal; report.passed = report.checks.filter(x => x.pass).length; report.failed = report.checks.filter(x => !x.pass).length;
    // Also serialize partial setup failures, whose context/page objects may not
    // yet have reached contextClose. Never dump browser internals or cookies.
    await writeFile(path.join(output, 'results.json'), JSON.stringify(report, (key, value) => ['context', 'page'].includes(key) ? undefined : value instanceof Set ? [...value] : value, 2));
    console.log(JSON.stringify({ passed: report.passed, failed: report.failed, cleanup: report.cleanup, fatal: fatal?.message, output }));
    if (fatal || report.failed || !report.cleanup) process.exitCode = 1;
}
