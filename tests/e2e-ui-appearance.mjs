/**
 * UI-02/04/06/07/08/09/11 acceptance against the PURE ST 1.19.0 isolate only.
 * Fixed address: 127.0.0.1:8032 + default-user/test1234.
 * Usage: node tests/e2e-ui-appearance.mjs /tmp/ui-appearance-proof
 * Optional: --cases=migration,scope,layout,colors,preview,presets,performance,horde
 * PLAYWRIGHT_CORE and CHROME_PATH may locate an installed headless Chromium.
 * Real shell/native UI, temporary real characters/chats, browser-only settings and
 * presets, intercepted model responses. No real model request or account save.
 * Account A/B is a browser identity/settings simulation, NOT real multi-user auth.
 * Device sizes/4x CPU are emulation, NOT real phones, keyboards, or a user study.
 */
import assert from 'node:assert/strict';
import { performanceCase } from './e2e-ui-performance.mjs';
import { createRequire } from 'node:module';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const BASE = 'http://127.0.0.1:8032', HANDLE = 'default-user', PASSWORD = 'test1234';
const APP_PATH = '/scripts/extensions/third-party/emmalike/app/', APP = BASE + APP_PATH;
const options = process.argv.slice(2), outputArg = options.find(x => !x.startsWith('--'));
assert(outputArg && !outputArg.includes('://'), 'Supply an evidence directory, never a target URL.');
assert(options.every(x => x === outputArg || x.startsWith('--cases=')), 'Unknown argument.');
const cases = (options.find(x => x.startsWith('--cases='))?.slice(8) || 'migration,scope,layout,colors,preview,presets,performance,horde').split(',');
const known = ['migration', 'scope', 'layout', 'colors', 'preview', 'presets', 'performance', 'horde'];
assert(cases.every(x => known.includes(x)) && new Set(cases).size === cases.length);
const output = resolve(outputArg), run = `${Date.now().toString(36)}-${process.pid}`;
await mkdir(output, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const report = {
    started: new Date().toISOString(), base: BASE, handle: HANDLE, run, cases: [], fixtures: [],
    categories: {
        live: 'Real product DOM/CSS, native bridge, temporary role/chat files in fixed isolate.',
        settings: 'Browser response copies; no /api/settings/save reaches server.',
        scope: 'Same browser virtual /users/me identities A/B with separate mocked settings. Real multi-account login remains unverified.',
        model: 'Browser fulfilled OpenAI/Horde responses; zero external model calls. Held generation measures waiting/UI, not streamed token throughput.',
        devices: 'Headless viewports and 4x CPU emulation; not physical phones, OS text scaling, keyboards, or user observation.',
        horde: 'Default-main-api browser copy plus valid controlled responses. Request source evidence only; external Horde failure is not reproduced or fixed by this probe.',
    },
    unverified: ['Physical iPhone/Android keyboards and OS text scaling', '3–5 first-time-user observations', 'Real multi-account login/sync', 'Arbitrary imported custom CSS compatibility', 'Real network/Horde service availability'],
};
const log = async (event, detail = {}) => {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...detail });
    console.log(line); await appendFile(resolve(output, 'stages.jsonl'), `${line}\n`);
};
await writeFile(resolve(output, 'stages.jsonl'), '');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const admin = await browser.newContext({ serviceWorkers: 'block' });
const fixtures = [], contexts = new Set();
let csrf, rawSettings, baselineAvatars = [], storageState, failures = 0;
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
const clone = value => JSON.parse(JSON.stringify(value));
const reading = (fontSize = 17, theme = 'system') => ({ theme, fontSize, lineHeight: 'normal', font: 'default', width: 'normal', paragraph: 'normal', margin: 'normal', indent: true, justify: true });
const appearance = (fontSize = 17, updated = 100, display) => ({ reading: reading(fontSize), themeUpdated: updated, customCss: '', themes: [], ...(display ? { display } : {}) });
const display = (fontSize, updated = Date.now()) => ({ schemaVersion: 1, fontSize, updated });
const key = owner => `tavern-lite:display:v1:${JSON.stringify(owner)}`;
const longPreset = `界面验收_${run}_很长的预设名称_夜色里的图书馆与没说完的故事_完整名称应当换行可读`;
const modelText = `这是隔离浏览器返回的测试回复 ${run}。`;
async function post(path, data) {
    assert(['/api/users/login', '/api/settings/get', '/api/characters/all', '/api/characters/get', '/api/characters/delete', '/api/chats/save', '/api/chats/get', '/api/plugins/tavern-lite/health'].includes(path));
    return admin.request.post(BASE + path, { maxRedirects: 0, headers: { 'X-CSRF-Token': csrf }, data });
}
async function environment() {
    const token = await admin.request.get(BASE + '/csrf-token', { maxRedirects: 0 });
    assert.equal(token.status(), 200); csrf = (await token.json()).token;
    assert.equal((await post('/api/users/login', { handle: HANDLE, password: PASSWORD })).status(), 200, 'Fixed test login failed.');
    const me = await admin.request.get(BASE + '/api/users/me', { maxRedirects: 0 });
    assert.equal((await me.json()).handle, HANDLE);
    const version = await admin.request.get(BASE + '/version', { maxRedirects: 0 });
    report.nativeVersion = (await version.json()).pkgVersion;
    assert.equal(report.nativeVersion, '1.19.0');
    const inventory = await (await admin.request.get(BASE + '/api/extensions/discover', { maxRedirects: 0 })).json();
    report.extensionInventory = inventory;
    assert.deepEqual(inventory.filter(x => x.name.startsWith('third-party/')).map(x => x.name).sort(), ['third-party/emmalike'], 'Refusing non-pure isolate.');
    report.optionalPluginHealth = (await post('/api/plugins/tavern-lite/health', { account: HANDLE })).status();
    assert.equal(report.optionalPluginHealth, 404, 'Optional plugin must be absent.');
    rawSettings = await (await post('/api/settings/get', {})).json();
    assert.equal(typeof rawSettings.settings, 'string');
    report.originalSettingsSha256 = createHash('sha256').update(rawSettings.settings).digest('hex');
    report.originalMainApi = JSON.parse(rawSettings.settings).main_api;
    baselineAvatars = (await (await post('/api/characters/all', {})).json()).map(x => x.avatar);
    storageState = await admin.storageState();
    await log('pure-environment-verified', { nativeVersion: report.nativeVersion, optionalPluginHealth: report.optionalPluginHealth });
}
async function makeFixtures() {
    // Twelve real one-use roles provide a populated shelf; only four receive stories.
    for (let i = 0; i < 12; i++) {
        const name = `UI验收_${run}_${i}_${i < 4 ? '一位名字很长很长仍然需要完整辨认的夜班图书管理员' : '书架样本'}`;
        const response = await admin.request.post(BASE + '/api/characters/create', {
            maxRedirects: 0, headers: { 'X-CSRF-Token': csrf }, multipart: {
                ch_name: name, description: '一次性隔离 UI 验收角色', first_mes: `测试开场 ${run}`, personality: '', scenario: '', mes_example: '',
                creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '',
            },
        });
        assert.equal(response.status(), 200);
        const avatar = (await response.text()).trim();
        assert(avatar.endsWith('.png') && !baselineAvatars.includes(avatar) && avatar.includes(run), 'Unowned avatar returned.');
        const entry = { name, avatar, file: `UI验收故事_${run}_${i}_雨停后没有说完的长长长长故事`, count: i === 0 ? 500 : 8 };
        fixtures.push(entry); report.fixtures.push({ ...entry });
        await writeFile(resolve(output, 'fixture-manifest.json'), JSON.stringify(report.fixtures, null, 2));
        if (i >= 4) continue;
        const messages = Array.from({ length: entry.count }, (_, n) => ({
            name: n % 2 ? name : '验收读者', is_user: n % 2 === 0, is_system: false,
            send_date: new Date(1700000000000 + n * 1000).toISOString(), extra: {},
            mes: n % 2 ? `第 ${n} 条。*她合上书页，抬头望向门口。*\n\n“灯还亮着，故事也还没有结束。”\n\n${'这是只在隔离环境生成的长文样本，供阅读和滚动检查。'.repeat(5)}` : `第 ${n} 条，我把书放在桌上。${'下一页还留着一句没有写完的话。'.repeat(3)}`,
        }));
        const last = messages.at(-1);
        Object.assign(last, { swipes: [last.mes + '\n版本一。', last.mes + '\n版本二。', last.mes + '\n版本三。'], swipe_id: 1 });
        last.mes = last.swipes[1];
        const saved = await post('/api/chats/save', { ch_name: name, avatar_url: avatar, file_name: entry.file,
            chat: [{ user_name: '验收读者', character_name: name, chat_metadata: {} }, ...messages] });
        assert.equal(saved.status(), 200);
    }
    await log('temporary-fixtures-created', { roles: fixtures.length, stories: 4, largest: 500 });
}

function instrumentPage({ seed, appPath }) {
    // Observational instrumentation only. Errors are recorded, never canceled.
    window.__uiEvidence = { fetches: [], errors: [], toasts: [], longTasks: [], shifts: [] };
    const ev = window.__uiEvidence, originalFetch = window.fetch;
    window.fetch = function (...args) {
        const address = String(args[0]?.url || args[0]);
        if (address.includes('/api/horde/')) ev.fetches.push({ url: address, stack: new Error('Horde request source').stack, at: performance.now() });
        return Reflect.apply(originalFetch, this, args);
    };
    addEventListener('error', event => ev.errors.push({ kind: 'error', message: event.message, source: event.filename, line: event.lineno }));
    addEventListener('unhandledrejection', event => ev.errors.push({ kind: 'unhandledrejection', message: String(event.reason?.stack || event.reason) }));
    new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        for (const toast of [node, ...node.querySelectorAll('.toast,.tl-toast')]) if (toast.matches?.('.toast,.tl-toast')) ev.toasts.push(toast.textContent);
    } }).observe(document, { childList: true, subtree: true });
    try { new PerformanceObserver(list => ev.longTasks.push(...list.getEntries().map(x => ({ startTime: x.startTime, duration: x.duration, name: x.name })))).observe({ type: 'longtask', buffered: true }); } catch {}
    const shiftNode = node => {
        const chain = [];
        for (let el = node?.nodeType === 1 ? node : node?.parentElement; el && chain.length < 4; el = el.parentElement) {
            chain.push({ tag: el.tagName, id: el.id, class: String(el.className || ''), role: el.getAttribute('role') });
        }
        return chain;
    };
    const shiftRect = rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    try { new PerformanceObserver(list => ev.shifts.push(...list.getEntries().map(x => ({ startTime: x.startTime, value: x.value, hadRecentInput: x.hadRecentInput,
        sources: (x.sources || []).map(source => ({ node: shiftNode(source.node), previousRect: shiftRect(source.previousRect), currentRect: shiftRect(source.currentRect) }))
    })))).observe({ type: 'layout-shift', buffered: true }); } catch {}
    if (window !== top || !location.pathname.startsWith(appPath)) return;
    localStorage.setItem('tavern-lite:engine-mode', 'auto');
    const marker = 'ui-appearance-test-seeded';
    if (seed && !sessionStorage.getItem(marker)) {
        for (const [k, value] of Object.entries(seed)) localStorage.setItem(k, value);
        sessionStorage.setItem(marker, 'yes');
    }
}

function browserSettings(mode, look) {
    const settings = JSON.parse(rawSettings.settings);
    settings.active_character = null; settings.active_group = null;
    settings.firstRun = false;
    settings.main_api = mode === 'horde' ? 'koboldhorde' : 'openai';
    settings.api_server = ''; settings.api_server_textgenerationwebui = '';
    settings.power_user = { ...settings.power_user, auto_connect: false };
    settings.horde_settings = { models: [], auto_adjust_response_length: true, auto_adjust_context_length: false, trusted_workers_only: false };
    settings.oai_settings = { ...settings.oai_settings, chat_completion_source: 'custom', custom_url: 'http://ui-appearance.invalid/v1', custom_model: 'ui-appearance-mock', stream_openai: true, openai_max_context: 32768, openai_max_tokens: 512, preset_settings_openai: longPreset };
    settings.extension_settings = { ...settings.extension_settings, tavernLite: clone(look) };
    // Keep the native bundled-extension configuration, disable inherited connection profiles.
    if (settings.extension_settings.connectionManager) settings.extension_settings.connectionManager = { ...settings.extension_settings.connectionManager, profiles: [], selectedProfile: '' };
    return settings;
}
async function session(result, { seed, look = appearance(), identity = HANDLE, horde = false, width = 390, height = 844 } = {}) {
    const context = await browser.newContext({ storageState, viewport: { width, height }, hasTouch: width < 760, isMobile: width < 760, serviceWorkers: 'block', acceptDownloads: true, reducedMotion: 'reduce' });
    contexts.add(context);
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const s = { context, page, identity, recent: 4, profiles: new Map(), frameOwners: new WeakMap(), result, mode: horde ? 'horde' : 'openai', holdBundle: null, holdGeneration: null, generations: 0 };
    s.profiles.set(identity, browserSettings(s.mode, look));
    result.sessions ??= [];
    s.audit = { mode: s.mode, pageErrors: [], routeErrors: [], externalBlocked: [], blockedWrites: [], ownWrites: [], settingsSaves: 0, presetSaves: 0, modelPaths: [], bundles: [] };
    result.sessions.push(s.audit);
    page.on('pageerror', error => s.audit.pageErrors.push(String(error.stack || error)));
    await context.addInitScript(instrumentPage, { seed, appPath: APP_PATH });
    const allCharacters = await (await post('/api/characters/all', {})).json();
    const owned = allCharacters.filter(x => fixtures.some(f => f.avatar === x.avatar));
    await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url()), path = url.pathname;
        try {
            if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
            if (url.origin !== BASE) { s.audit.externalBlocked.push({ origin: url.origin, path }); return route.abort('blockedbyclient'); }
            if (path.startsWith(`${APP_PATH}assets/index-`) && path.endsWith('.js')) {
                if (s.holdBundle) await s.holdBundle;
                const response = await route.fetch({ maxRedirects: 0 });
                const source = await response.text();
                s.audit.bundles.push({ path, sha256: createHash('sha256').update(source).digest('hex') });
                return route.fulfill({ response, body: source });
            }
            if (path === '/api/users/me' && req.frame() === page.mainFrame()) {
                const response = await route.fetch({ maxRedirects: 0 }); const value = await response.json();
                assert.equal(value.handle, HANDLE);
                return json(route, { ...value, handle: s.identity, name: s.identity });
            }
            if (path === '/api/settings/get') {
                const value = clone(rawSettings), settings = s.profiles.get(s.identity);
                assert(settings, 'Missing simulated account settings.');
                s.frameOwners.set(req.frame(), s.identity);
                settings.active_character = null; settings.active_group = null;
                value.settings = JSON.stringify(settings);
                assert(Array.isArray(value.openai_settings) && Array.isArray(value.openai_setting_names));
                const preset = JSON.parse(value.openai_settings[0]);
                value.openai_settings.push(JSON.stringify(preset)); value.openai_setting_names.push(longPreset);
                return json(route, value);
            }
            if (path === '/api/settings/save') {
                const owner = s.frameOwners.get(req.frame());
                assert(owner, 'Unbound native frame attempted a settings save.');
                s.profiles.set(owner, req.postDataJSON()); s.audit.settingsSaves++;
                return json(route, { result: 'ok' });
            }
            if (path === '/api/secrets/read') return json(route, {});
            if (path === '/api/quick-replies/save') { s.audit.blockedWrites.push({ path, category: 'native-initialization' }); return json(route, { error: 'Browser probe blocks Quick Reply writes.' }, 409); }
            if (path === '/api/presets/save') { s.audit.presetSaves++; return json(route, { name: req.postDataJSON().name }); }
            if (path === '/api/characters/all') return json(route, owned);
            if (path === '/api/groups/all') return json(route, []);
            if (path === '/api/chats/recent') return json(route, fixtures.slice(0, s.recent).map((f, i) => ({ avatar: f.avatar, file_name: `${f.file}.jsonl`, chat_items: f.count, mes: `第 ${i} 个近期故事，实际打开自己的隔离文件。`, last_mes: new Date(Date.now() - i * 60000).toISOString() })));
            if (/^\/api\/(?:backends|novelai|horde|openai|kobold|textgenerationwebui|sd|images|tts|embeddings|vectors|translate|search)(?:\/|$)/.test(path) || /\/api\/.*(?:generate|completion)/.test(path) || /^\/api\/tokenizers\/(?:remote|openai)(?:\/|$)/.test(path)) {
                s.audit.modelPaths.push(path);
                if (/generate|completion/.test(path) && !path.endsWith('/status') && !path.includes('bias') && !path.includes('tokenizers')) {
                    assert.equal(path, '/api/backends/chat-completions/generate', 'Unexpected provider generation path.');
                    s.generations++; const body = req.postDataJSON();
                    if (s.holdGeneration) await s.holdGeneration;
                    if (body.stream) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ id: run, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: modelText }, finish_reason: null }] })}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n` });
                    return json(route, { choices: [{ index: 0, message: { role: 'assistant', content: modelText }, finish_reason: 'stop' }] });
                }
                if (path === '/api/horde/status') return json(route, { ok: true });
                if (/\/horde\/.*(?:models|workers)$/.test(path)) return json(route, []);
                if (path.endsWith('/status')) return json(route, { data: [{ id: 'ui-appearance-mock', object: 'model' }] });
                // Native OpenAI chat counting reads token_count, unlike encode/count
                // endpoints that read count. A missing field yields NaN prompt budgets.
                if (path === '/api/tokenizers/openai/count') return json(route, { token_count: 32 });
                if (path.includes('/tokenizers/')) return json(route, { count: 32, ids: Array(32).fill(0), chunks: Array(32).fill('x') });
                return json(route, {});
            }
            // Native opening/sending can save chat and selected-file metadata only for our own roles.
            if (/^\/api\/(?:chats|characters)\/(?:save|edit|merge-attributes)$/.test(path)) {
                let data; try { data = req.postDataJSON(); } catch { data = null; }
                if (!data && path === '/api/characters/edit' && req.headers()['content-type']?.includes('multipart/form-data')) {
                    // Native selected-chat metadata is sent as FormData. Only extract identity;
                    // the submitted body is neither logged nor changed by this probe.
                    const avatar = req.postData()?.match(/name="avatar_url"\r?\n\r?\n([^\r\n]+)/)?.[1];
                    if (avatar) data = { avatar_url: avatar };
                }
                const avatar = data?.avatar_url;
                const allowed = fixtures.find(f => f.avatar === avatar);
                // Selecting a new role can create its native first-chat file before opening the
                // requested fixture. All chat files under this unique role are owned and cleaned.
                if (allowed) { s.audit.ownWrites.push({ path, avatar, file: data.file_name || null }); return route.continue(); }
                s.audit.blockedWrites.push({ path, category: 'unowned-data' });
                return json(route, { error: 'Only this run’s role/chat writes are permitted.' }, 409);
            }
            if (/^\/api\/(?:characters|chats|groupchats|groups|worldinfo|presets|secrets|backgrounds|avatars|quick-replies)\/.*(?:create|edit|save|delete|rename|import|duplicate|merge|upload|write)/.test(path)) {
                s.audit.blockedWrites.push({ path, category: 'unowned-data' }); return json(route, { error: 'Probe blocks unrelated mutations.' }, 409);
            }
            return route.continue();
        } catch (error) {
            s.audit.routeErrors.push({ path, message: String(error.stack || error) });
            await json(route, { error: 'Probe route failed; no fallback request sent.' }, 500).catch(() => {});
        }
    });
    return s;
}
async function closeSession(s) {
    if (!s || !contexts.has(s.context)) return;
    s.audit.frames = await Promise.all(s.page.frames().map(async frame => ({ url: frame.url(), evidence: await frame.evaluate(() => window.__uiEvidence).catch(() => null) })));
    await s.context.close(); contexts.delete(s.context);
}
async function ready(s, hash = '#me') {
    // Repeated goto(...#me) can be a same-document navigation. Account/remote-sync
    // scenarios require a real document + native-frame reload, not a hash revisit.
    if (s.page.url().startsWith(APP)) {
        await s.page.evaluate(h => history.replaceState(null, '', h), hash);
        await s.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    } else await s.page.goto(APP + hash, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await s.page.waitForFunction(() => !!document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge, null, { timeout: 270000 });
    // Bridge availability precedes the shell's ready notification by a task; wait for a product control.
    await s.page.waitForFunction(() => document.querySelector('.tl-composer-input[data-synced="true"]') || document.querySelector('.tl-profile:not(:disabled)') || document.querySelector('.tl-library .tl-character'), null, { timeout: 30000 });
    await s.page.waitForTimeout(100);
}
async function navigate(s, hash) {
    await s.page.evaluate(h => { history.pushState({ tavernLite: true }, '', h); dispatchEvent(new Event('tl-route')); }, hash);
    if (hash === '#me') await s.page.locator('.tl-me').waitFor();
    else if (hash === '#') await s.page.locator('.tl-library').waitFor();
}
const sheet = (s, name) => s.page.getByRole('dialog', { name, exact: true });
async function openReading(s) {
    const button = s.page.locator('.tl-aa');
    if (await button.count()) await button.click();
    else await s.page.getByRole('button', { name: /^阅读设置/ }).click();
    await sheet(s, '阅读设置').waitFor(); return sheet(s, '阅读设置');
}
async function closeSheet(s, name) {
    await sheet(s, name).getByRole('button', { name: '关闭', exact: true }).click();
    await sheet(s, name).waitFor({ state: 'hidden' });
    await s.page.waitForFunction(() => !history.state?.tlLayer, null, { timeout: 5000 });
}
async function setRange(locator, value) {
    await locator.evaluate((el, val) => { el.value = String(val); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, value);
}
async function setUi(s, value) {
    await navigate(s, '#me'); await s.page.getByRole('button', { name: /^显示设置/ }).click();
    await setRange(s.page.locator('#tl-ui-size'), value); await closeSheet(s, '显示设置');
    await waitScale(s, value);
}
async function scale(s) { return s.page.evaluate(() => ({ body: parseFloat(getComputedStyle(document.body).fontSize), reading: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tl-font-size')), ui: getComputedStyle(document.documentElement).getPropertyValue('--tl-ui-font-size').trim(), owner: localStorage.getItem('tavern-lite:display-owner') })); }
async function waitScale(s, value) {
    await s.page.waitForFunction(n => Math.abs(parseFloat(getComputedStyle(document.body).fontSize) - n) < .1, value, { timeout: 15000 });
}
async function savedDisplay(s, value) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
        const saved = s.profiles.get(s.identity)?.extension_settings?.tavernLite?.display;
        if (saved?.fontSize === value) return clone(saved);
        await s.page.waitForTimeout(100);
    }
    throw new Error(`Browser-only account save did not receive display ${value}.`);
}
async function shot(s, name) { await s.page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true }); }
async function layoutFacts(s, selector) {
    return s.page.locator(selector).evaluate(el => {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right, display: cs.display, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, lineHeight: cs.lineHeight, fontSize: cs.fontSize, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, whiteSpace: cs.whiteSpace, text: el.textContent };
    });
}
async function noHorizontalOverflow(s) {
    const sizes = await s.page.evaluate(() => ({ viewport: innerWidth, doc: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert(sizes.doc <= sizes.viewport + 1 && sizes.body <= sizes.viewport + 1, `Page horizontal overflow: ${JSON.stringify(sizes)}`); return sizes;
}
async function hitbox(s, selector, { last = false } = {}) {
    const loc = last ? s.page.locator(selector).last() : s.page.locator(selector).first();
    await loc.scrollIntoViewIfNeeded();
    const box = await loc.evaluate(el => { const r = el.getBoundingClientRect(), target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { width: r.width, height: r.height, x: r.x, y: r.y, disabled: el.disabled, centerHits: el === target || el.contains(target) }; });
    assert(box.width >= 43.5 && box.height >= 43.5, `${selector} actual hitbox <44px: ${JSON.stringify(box)}`);
    assert(box.centerHits, `${selector} center is covered`); return { selector, ...box };
}
async function importFile(s, data) {
    await navigate(s, '#me');
    await s.page.evaluate(() => { window.__uiEvidence.toasts = []; });
    await s.page.locator('input[type=file]').setInputFiles({ name: 'ui-theme.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
    await s.page.waitForFunction(() => window.__uiEvidence.toasts.some(x => x.includes('主题已导入') || x.includes('已导入主题')));
}
async function exportFile(s) {
    await navigate(s, '#me'); const downloaded = s.page.waitForEvent('download');
    await s.page.getByRole('button', { name: /^导出主题/ }).click();
    const stream = await (await downloaded).createReadStream(), chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString());
}
async function runCase(name, fn) {
    const result = { name, status: 'RUNNING', checks: [] }; report.cases.push(result);
    const ownedBefore = new Set(contexts);
    await log('case-start', { name });
    try { await fn(result); result.status = 'PASS'; }
    catch (error) { failures++; result.status = 'FAIL'; result.error = String(error.stack || error); await log('case-failed', { name, error: result.error }); }
    finally {
        for (const context of [...contexts]) if (!ownedBefore.has(context)) {
            const page = context.pages()[0];
            await page?.screenshot({ path: resolve(output, `${name}-final.png`), fullPage: true }).catch(() => {});
            const audit = result.sessions?.find(x => !x.frames);
            if (audit) audit.frames = await Promise.all((page?.frames() || []).map(async f => ({ url: f.url(), evidence: await f.evaluate(() => window.__uiEvidence).catch(() => null) })));
            await context.close(); contexts.delete(context);
        }
        const errors = (result.sessions || []).flatMap(s => [...s.routeErrors, ...s.blockedWrites.filter(w => w.category === 'unowned-data')]);
        if (errors.length && result.status === 'PASS') { failures++; result.status = 'FAIL'; result.error = `Unexpected route/mutation errors: ${JSON.stringify(errors)}`; }
        const pageErrors = (result.sessions || []).flatMap(s => s.pageErrors);
        if (pageErrors.length && name !== 'horde' && result.status === 'PASS') { failures++; result.status = 'FAIL'; result.error = `Uncaught page errors: ${JSON.stringify(pageErrors)}`; }
        await writeFile(resolve(output, `${name}.json`), JSON.stringify(result, null, 2));
        await log('case-complete', { name, status: result.status });
    }
}

async function migration(result) {
    for (const value of [17, 26]) {
        const s = await session(result, { look: appearance(value), seed: {
            'tavern-lite:reading': JSON.stringify(reading(value)), 'tavern-lite:reading-css': `:root { --tl-font-size: ${value}px; }`, 'tavern-lite:theme-updated': '100',
        } });
        let release; s.holdBundle = new Promise(r => { release = r; });
        try {
            await s.page.goto(APP + '#me', { waitUntil: 'commit' });
            await s.page.locator('.tl-boot').waitFor();
            await waitScale(s, value);
            const preBundle = await scale(s); assert.equal(await s.page.locator('.tl-me').count(), 0, 'Bundle was not held.');
            result.checks.push({ name: `legacy-${value}-pre-bundle`, ...preBundle });
            await shot(s, `legacy-${value}-pre-bundle`);
        } finally { s.holdBundle = null; release(); }
        await s.page.waitForFunction(() => !!document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge, null, { timeout: 270000 });
        await waitScale(s, value);
        await s.page.waitForFunction(k => !!localStorage.getItem(k), key(HANDLE));
        const persisted = await s.page.evaluate(k => JSON.parse(localStorage.getItem(k)), key(HANDLE));
        assert.equal(persisted.fontSize, value); assert.equal(persisted.schemaVersion, 1);
        // Migration intentionally stays local until the user explicitly edits Display.
        // Do not require or simulate an automatic account write for a derived value.
        const account = clone(s.profiles.get(s.identity)?.extension_settings?.tavernLite?.display ?? null);
        assert.equal(persisted.source, 'migrated');
        result.checks.push({ name: `legacy-${value}-synced`, persisted, account });
        await s.page.reload(); await s.page.locator('.tl-me').waitFor(); await waitScale(s, value);
        await closeSession(s);
    }
    const cached = await session(result, { look: appearance(26), seed: {
        'tavern-lite:reading': JSON.stringify(reading(26)), 'tavern-lite:reading-css': ':root { --tl-font-size: 26px; --tl-ui-font-size: 26px; }',
        'tavern-lite:theme-updated': '100', 'tavern-lite:display-owner': HANDLE, [key(HANDLE)]: JSON.stringify({ ...display(23), source: 'explicit' }),
    } });
    let releaseCached; cached.holdBundle = new Promise(r => { releaseCached = r; });
    try {
        await cached.page.goto(APP + '#me', { waitUntil: 'commit' }); await cached.page.locator('.tl-boot').waitFor(); await waitScale(cached, 23);
        assert.equal(await cached.page.locator('.tl-me').count(), 0);
        result.checks.push({ name: 'explicit-display23-over-stale-readingCSS26-pre-bundle', state: await scale(cached) });
        await shot(cached, 'explicit-display23-pre-bundle');
    } finally { cached.holdBundle = null; releaseCached(); }
    await cached.page.locator('.tl-me').waitFor(); await waitScale(cached, 23); await closeSession(cached);
    // No local legacy cache: migrate an account's old reading-only setting.
    const s = await session(result, { look: appearance(26) }); await ready(s); await waitScale(s, 26);
    await setUi(s, 23); await savedDisplay(s, 23);
    let r = await openReading(s); await setRange(r.getByRole('slider', { name: '字号', exact: true }), 26);
    await r.getByRole('button', { name: '恢复默认', exact: true }).click(); await closeSheet(s, '阅读设置');
    assert.equal((await scale(s)).reading, 17); await waitScale(s, 23);
    const exported = await exportFile(s); assert.equal(exported.display.fontSize, 23); assert.equal(exported.reading.fontSize, 17);
    await importFile(s, { format: 'tavern-lite-theme', version: 1, reading: reading(26), customCss: '' });
    await waitScale(s, 23);
    await s.page.waitForFunction(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tl-font-size')) === 26);
    // Simulate another old client replacing the account appearance with reading-only data.
    await ready(s);
    const remote = s.profiles.get(s.identity);
    remote.extension_settings.tavernLite = appearance(17, Date.now() + 1);
    await ready(s); await waitScale(s, 23);
    assert.equal((await scale(s)).reading, 17);
    s.profiles.get(s.identity).extension_settings.tavernLite.display = { ...display(26, Date.now() + 60000), source: 'migrated' };
    await ready(s); await waitScale(s, 23);
    result.checks.push({ name: 'explicit-ui-beats-newer-derived-display', after: await scale(s) });
    await importFile(s, { format: 'tavern-lite-theme', version: 2, reading: reading(19), customCss: '', display: display(25) }); await waitScale(s, 25);
    await ready(s); await waitScale(s, 25);
    await s.page.getByRole('button', { name: /^显示设置/ }).click();
    await sheet(s, '显示设置').getByRole('button', { name: '恢复界面默认字号', exact: true }).click();
    await closeSheet(s, '显示设置'); await waitScale(s, 17); assert.equal((await scale(s)).reading, 19);
    result.checks.push({ name: 'account-old26/reset-reading/legacy-import/old-client-sync/explicit-import/ui-reset', exported, final: await scale(s) });
}
async function scope(result) {
    const A = `ui-scope-A-${run}`, B = `ui-scope-B-${run}`;
    const s = await session(result, { identity: A, look: appearance(26, 100) });
    s.profiles.set(B, browserSettings('openai', appearance(17, 1)));
    await ready(s); await waitScale(s, 26); await setUi(s, 26);
    s.identity = B; await ready(s); await waitScale(s, 17);
    await setUi(s, 19);
    s.identity = A; await ready(s); await waitScale(s, 26);
    s.identity = B; await ready(s); await waitScale(s, 19);
    const values = await s.page.evaluate(([a, b]) => ({ a: JSON.parse(localStorage.getItem(a)), b: JSON.parse(localStorage.getItem(b)) }), [key(A), key(B)]);
    assert.equal(values.a.fontSize, 26); assert.equal(values.b.fontSize, 19);
    result.checks.push({ name: 'simulated-account-A/B-legacy-default-and-explicit-preferences', values, category: report.categories.scope });
}
async function layout(result) {
    const s = await session(result); await ready(s);
    for (const [width, height] of [[320, 640], [390, 844], [1440, 1000]]) {
        await s.page.setViewportSize({ width, height });
        for (const ui of [17, 26]) {
            await setUi(s, ui);
            for (const recent of [0, 1, 4]) {
                s.recent = recent; await navigate(s, '#'); await s.page.locator('.tl-character').first().waitFor();
                await s.page.waitForFunction(count => document.querySelectorAll('.tl-continue').length === count, recent);
                assert.equal(await s.page.locator('.tl-continue-primary').count(), recent ? 1 : 0);
                assert.equal(await s.page.locator('.tl-continue-compact').count(), Math.max(0, recent - 1));
                const title = await layoutFacts(s, '.tl-library .tl-title');
                assert(title.height <= parseFloat(title.lineHeight) * 1.25, 'Brand broke into multiple lines.');
                const sizes = await noHorizontalOverflow(s);
                const controls = await s.page.locator('.tl-library > .tl-header > button').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, label: e.textContent }; }));
                assert.equal(controls.length, 2); assert(controls.every(b => b.width >= 44 && b.height >= 40 && b.x + b.width <= width + 1));
                const [a, b] = controls;
                assert(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1, 'Header action boxes overlap.');
                result.checks.push({ name: `shelf-${width}-${ui}-${recent}`, sizes, title, controls });
                await shot(s, `shelf-${width}-${ui}-${recent}`);
                // Same component route must be unmounted before changing its next fetched recent fixture.
                await navigate(s, '#me');
            }
        }
    }
    await s.page.setViewportSize({ width: 390, height: 844 }); await setUi(s, 17);
    const r = await openReading(s), group = await layoutFacts(s, '.tl-theme-strip');
    const cards = await r.getByRole('radiogroup', { name: '主题', exact: true }).getByRole('radio').evaluateAll(els => els.map(el => { const b = el.getBoundingClientRect(); return { top: b.top, height: b.height }; }));
    assert(cards.length >= 8); assert(group.height <= Math.max(...cards.map(x => x.height)) + parseFloat(group.paddingTop) + parseFloat(group.paddingBottom) + 2 && Math.abs(cards[0].top - cards[1].top) < 2, `Theme strip became vertical rows: ${JSON.stringify({ group, cards })}`);
    const font = await r.getByRole('slider', { name: '字号', exact: true }).boundingBox(), panel = await r.boundingBox();
    assert(font.y >= panel.y && font.y + font.height <= Math.min(panel.y + panel.height, 844), 'Font control starts below viewport.');
    assert.equal(await r.getByRole('radiogroup', { name: '字体', exact: true }).isVisible(), false);
    await shot(s, 'reading-first-level-390');
    await r.getByRole('button', { name: '更多排版', exact: true }).click();
    for (const label of ['字体', '段距', '边距']) assert(await r.getByRole('radiogroup', { name: label, exact: true }).isVisible());
    for (const label of ['首行缩进', '中文两端对齐']) assert(await r.getByRole('switch', { name: label }).isVisible());
    await r.getByRole('radiogroup', { name: '字体', exact: true }).getByRole('radio', { name: '宋体', exact: true }).click();
    await r.getByRole('radiogroup', { name: '段距', exact: true }).getByRole('radio', { name: '宽松', exact: true }).click();
    await shot(s, 'reading-more-390'); await closeSheet(s, '阅读设置');
    await ready(s); const reopened = await openReading(s); await reopened.getByRole('button', { name: '更多排版', exact: true }).click();
    assert.equal(await reopened.getByRole('radiogroup', { name: '字体', exact: true }).getByRole('radio', { name: '宋体', exact: true }).getAttribute('aria-checked'), 'true');
    await s.page.setViewportSize({ width: 1440, height: 1000 }); assert(await reopened.getByRole('radiogroup', { name: '页宽', exact: true }).isVisible());
    await closeSheet(s, '阅读设置');
    // Real target validation: each recent entry must resolve to its own saved story.
    s.recent = 4;
    for (let i = 0; i < 4; i++) {
        await navigate(s, '#'); await s.page.locator('.tl-continue').nth(i).waitFor();
        await s.page.locator('.tl-continue').nth(i).click();
        await s.page.waitForFunction(([avatar, file]) => { const params = new URLSearchParams(location.hash.slice(1)); return params.get('chat') === avatar && params.get('file') === file; }, [fixtures[i].avatar, fixtures[i].file]);
        await s.page.locator('.tl-composer-input[data-synced="true"]').waitFor({ timeout: 120000 });
        const target = await s.page.evaluate(() => document.querySelector('iframe.engine').contentWindow.TavernLiteBridge.currentChat());
        assert.equal(target.avatar, fixtures[i].avatar); assert.equal(target.file, fixtures[i].file);
        result.checks.push({ name: `recent-${i}-actual-target`, target });
    }
    await s.page.setViewportSize({ width: 390, height: 844 });
    result.hitboxes = [];
    for (const selector of ['.tl-send', '.tl-swipe-button[aria-label="上一个回复"]', '.tl-swipe-button[aria-label="下一个回复"]', '.tl-message-menu']) result.hitboxes.push(await hitbox(s, selector, { last: true }));
    await navigate(s, '#'); await s.page.locator('.tl-book-menu').first().waitFor(); result.hitboxes.push(await hitbox(s, '.tl-book-menu'));
    await s.page.getByPlaceholder('搜索角色或标签').fill(fixtures[0].name);
    await s.page.waitForFunction(() => document.querySelectorAll('.tl-character').length === 1);
    await s.page.getByPlaceholder('搜索角色或标签').fill('');
    await s.page.waitForFunction(() => document.querySelectorAll('.tl-character').length === 12);
    result.checks.push({ name: 'theme-horizontal/common-before-more/persisted-layout/search-and-hitboxes', group, font });
    for (const [width, height] of [[320, 640], [390, 844], [1440, 1000]]) {
        await s.page.setViewportSize({ width, height }); await setUi(s, 26);
        await navigate(s, `#${new URLSearchParams({ chat: fixtures[3].avatar, file: fixtures[3].file })}`);
        await s.page.locator('.tl-composer-input[data-synced="true"]').waitFor({ timeout: 120000 });
        const large = await openReading(s); await setRange(large.getByRole('slider', { name: '字号', exact: true }), 26); await closeSheet(s, '阅读设置');
        await noHorizontalOverflow(s);
        const boxes = [];
        for (const selector of ['.tl-send', '.tl-swipe-button[aria-label="上一个回复"]', '.tl-swipe-button[aria-label="下一个回复"]', '.tl-message-menu']) boxes.push(await hitbox(s, selector, { last: true }));
        const composer = await s.page.locator('.tl-composer').evaluate(el => [...el.querySelectorAll('.tl-plus,.tl-composer-input,.tl-send')].map(node => { const r = node.getBoundingClientRect(); return { x: r.x, right: r.right, top: r.top, bottom: r.bottom }; }));
        assert.equal(composer.length, 3);
        for (let i = 0; i < composer.length; i++) for (let j = i + 1; j < composer.length; j++) {
            const a = composer[i], b = composer[j]; assert(a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1, 'Large-text composer targets overlap.');
        }
        result.checks.push({ name: `large-reading-and-UI-${width}`, boxes, composer });
        await shot(s, `reader-${width}-ui26-reading26`);
    }
}

// Canvas resolves computed color(srgb ...) and translucent colors before WCAG luminance.
async function contrast(s, selector) {
    return s.page.locator(selector).last().evaluate(el => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const rgba = css => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].map((x, i) => i === 3 ? x / 255 : x); };
        const blend = (a, b) => [0, 1, 2].map(i => a[i] * a[3] + b[i] * (1 - a[3])).concat(1);
        const chain = []; for (let n = el; n; n = n.parentElement) chain.unshift(n);
        let background = [255, 255, 255, 1]; for (const n of chain) background = blend(rgba(getComputedStyle(n).backgroundColor), background);
        const style = getComputedStyle(el), foreground = blend(rgba(style.color), background);
        const lum = color => color.slice(0, 3).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((n, x, i) => n + x * [.2126, .7152, .0722][i], 0);
        const a = lum(foreground), b = lum(background);
        return { ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), foreground, background, color: style.color, backgroundColor: style.backgroundColor, opacity: style.opacity, text: el.textContent, fontSize: style.fontSize };
    });
}
async function colors(result) {
    const failures = result.contrastFailures = [];
    const targetHash = `#${new URLSearchParams({ chat: fixtures[3].avatar, file: fixtures[3].file })}`;
    const s = await session(result); await ready(s, targetHash);
    await s.page.locator('.tl-composer-input[data-synced="true"]').waitFor({ timeout: 120000 });
    await s.page.locator('.tl-composer-input').fill('只检查发送按钮颜色，不发送。');
    for (const [label, media] of [['纸色', 'light'], ['白色', 'light'], ['护眼', 'light'], ['羊皮', 'light'], ['樱粉', 'light'], ['夜间', 'light'], ['墨蓝', 'light'], ['跟随系统', 'light'], ['跟随系统', 'dark']]) {
        await s.page.emulateMedia({ colorScheme: media, reducedMotion: 'reduce' });
        const r = await openReading(s); await r.getByRole('radio', { name: label, exact: true }).click();
        const selected = await contrast(s, '.tl-choices [role=radio][aria-checked=true]');
        if (selected.ratio < 4.5) failures.push(`${label}/${media}: selected text ${selected.ratio}`);
        await closeSheet(s, '阅读设置');
        // Measure the chosen theme's final colors, not an arbitrary point in the
        // existing 150ms background transition between two different themes.
        await s.page.locator('.tl-send').evaluate(el => Promise.allSettled(el.getAnimations().map(animation => animation.finished)));
        const send = await contrast(s, '.tl-send'), body = await contrast(s, '.tl-message[data-role=char] .tl-message-body'), narration = await contrast(s, '.tl-message[data-role=char] .tl-message-body em');
        if (send.ratio < 3) failures.push(`${label}/${media}: send icon ${send.ratio}`);
        if (body.ratio < 4.5) failures.push(`${label}/${media}: body ${body.ratio}`);
        if (narration.ratio < 4.5) failures.push(`${label}/${media}: narration ${narration.ratio}`);
        await shot(s, `theme-${label}-${media}`);
        await navigate(s, '#preset'); await s.page.getByRole('button', { name: '保存到此预设', exact: true }).waitFor();
        const primary = await contrast(s, '.tl-preset-savebar .tl-primary'); if (primary.ratio < 4.5) failures.push(`${label}/${media}: primary text ${primary.ratio}`);
        result.checks.push({ label, media, selected, send, body, narration, primary });
        await navigate(s, targetHash);
        await s.page.locator('.tl-composer-input[data-synced="true"]').waitFor({ timeout: 120000 });
    }
    assert.equal(failures.length, 0, `Computed contrast failures: ${failures.join('; ')}`);
}
async function preview(result) {
    const s = await session(result); await ready(s);
    const beforeRequests = s.generations;
    await s.page.getByRole('button', { name: /^做一个主题/ }).click();
    const p = s.page.locator('.tl-theme-preview'); await p.waitFor();
    assert.equal(await p.locator('.tl-message[data-role=char] .tl-message-body em').count(), 1);
    assert.equal(await p.locator('.tl-message[data-role=char] .tl-message-body q').count(), 1);
    assert.equal(await p.locator('.tl-message[data-role=user]').count(), 1);
    assert.equal(await p.locator('input[readonly]').count(), 1);
    assert.equal(await p.getByRole('button', { name: '主按钮预览', exact: true }).count(), 1);
    assert.equal(await p.locator('[aria-pressed=true]').count(), 1);
    const old = await contrast(s, '.tl-theme-preview .tl-message-body em');
    await s.page.getByLabel('旁白颜色', { exact: true }).fill('#b40000');
    const changed = await contrast(s, '.tl-theme-preview .tl-message-body em'); assert.notDeepEqual(changed.foreground, old.foreground);
    assert.equal(s.generations, beforeRequests);
    const current = await s.page.evaluate(() => document.querySelector('iframe.engine').contentWindow.TavernLiteBridge.currentChat());
    assert(!current?.avatar, 'Preview opened a story.');
    result.checks.push({ name: 'actual-reading-markup-and-live-color-controls-no-story-or-generation', old, changed, current });
    await shot(s, 'theme-editor-preview-390');
}
async function presets(result) {
    const s = await session(result); await ready(s);
    await s.page.getByRole('button', { name: /^模型与预设/ }).click();
    const r = sheet(s, '模型与预设'), group = r.getByRole('radiogroup', { name: '预设', exact: true });
    // The real selected row includes a visible "正在用" state marker in its name.
    const radio = group.getByRole('radio').filter({ has: s.page.locator('.tl-sheet-item-label', { hasText: longPreset }) }); await radio.scrollIntoViewIfNeeded();
    const bounds = await radio.evaluate(el => { const a = el.getBoundingClientRect(), b = el.parentElement.getBoundingClientRect(), label = el.querySelector('.tl-sheet-item-label'); return { row: { width: a.width, height: a.height }, groupWidth: b.width, labelHeight: label.clientHeight, labelScrollHeight: label.scrollHeight, text: label.textContent, whiteSpace: getComputedStyle(label).whiteSpace }; });
    assert(bounds.row.width >= bounds.groupWidth - 4, 'Preset list is not full-width single column.');
    assert.equal(bounds.text, longPreset); assert(bounds.labelHeight >= bounds.labelScrollHeight - 1); assert.notEqual(bounds.whiteSpace, 'nowrap');
    await shot(s, 'long-preset-list-390');
    await r.getByRole('button', { name: /^调整这个预设/ }).click();
    await s.page.getByRole('button', { name: '保存到此预设', exact: true }).waitFor();
    const number = s.page.locator('#tl-preset-openai_max_tokens'); const previous = Number(await number.inputValue());
    await number.fill(String(previous + 1)); await number.blur();
    await s.page.getByRole('status').filter({ hasText: '没存进预设' }).waitFor();
    const savesBefore = s.audit.presetSaves;
    await s.page.getByRole('button', { name: '保存到此预设', exact: true }).click();
    await s.page.locator('.tl-preset-savebar [role=status]').filter({ hasText: /已存进预设/ }).waitFor();
    assert.equal(s.audit.presetSaves, savesBefore + 1);
    result.checks.push({ name: 'long-preset-layout-current-edit-vs-explicit-save', bounds, browserOnlyPresetSaves: s.audit.presetSaves });
    await shot(s, 'preset-save-state-390');
}

async function horde(result) {
    for (const isHorde of [true, false]) {
        const s = await session(result, { horde: isHorde, look: appearance() });
        await ready(s); await s.page.waitForTimeout(1500);
        const evidence = await Promise.all(s.page.frames().map(async f => ({ url: f.url(), observations: await f.evaluate(() => window.__uiEvidence).catch(() => null) })));
        const paths = s.audit.modelPaths.filter(p => p.startsWith('/api/horde/'));
        if (isHorde) assert(paths.includes('/api/horde/text-models') && paths.includes('/api/horde/status'), 'Default Horde source path did not reproduce.');
        else assert.equal(paths.length, 0, 'Explicit custom API unexpectedly requested Horde.');
        assert.equal(s.generations, 0, 'Startup generated a message.');
        result.checks.push({ name: isHorde ? 'default-Horde-browser-copy' : 'explicit-custom-browser-copy-control', paths, evidence, interpretation: 'Correct controlled response schema; any error is retained. This does not establish external-service root cause.' });
        await shot(s, isHorde ? 'horde-default-startup' : 'horde-custom-control'); await closeSession(s);
    }
    result.uncaughtErrors = result.sessions.flatMap(s => s.pageErrors);
    if (result.uncaughtErrors.length) {
        result.finding = 'Startup errors observed, inspect retained frame request stacks and errors; do not suppress or classify as fixed.';
        throw new Error(result.finding);
    }
}

try {
    await environment();
    if (cases.some(x => ['layout', 'colors', 'performance'].includes(x))) await makeFixtures();
    const handlers = { migration, scope, layout, colors, preview, presets, performance: result => performanceCase(result, { session, ready, fixtures, sheet, hitbox, openReading, closeSheet, shot, output, run, modelText }), horde };
    for (const name of cases) await runCase(name, handlers[name]);
} catch (error) { failures++; report.fatal = String(error.stack || error); await log('fatal', { error: report.fatal }); }
finally {
    for (const context of contexts) await context.close().catch(() => {});
    report.cleanup = [];
    for (const f of [...fixtures].reverse()) {
        try {
            assert(f.avatar.includes(run) && !baselineAvatars.includes(f.avatar));
            const response = await post('/api/characters/delete', { avatar_url: f.avatar, delete_chats: true });
            assert.equal(response.status(), 200); report.cleanup.push({ avatar: f.avatar, deleted: true });
        } catch (error) { failures++; report.cleanup.push({ avatar: f.avatar, deleted: false, error: String(error) }); }
    }
    if (csrf && fixtures.length) {
        try {
            const remaining = (await (await post('/api/characters/all', {})).json()).map(x => x.avatar);
            assert(baselineAvatars.every(x => remaining.includes(x)), 'A preexisting role disappeared.');
            assert(fixtures.every(f => !remaining.includes(f.avatar)), 'A temporary role remains.');
        } catch (error) { failures++; report.cleanupVerification = String(error); }
    }
    if (csrf && rawSettings) {
        try {
            const after = await (await post('/api/settings/get', {})).json();
            report.finalSettingsSha256 = createHash('sha256').update(after.settings).digest('hex');
            assert.equal(report.finalSettingsSha256, report.originalSettingsSha256, 'Real account settings changed.');
        } catch (error) { failures++; report.settingsVerification = String(error); }
    }
    report.finished = new Date().toISOString(); report.status = failures ? 'FAIL' : 'PASS';
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
    await log('complete', { status: report.status, failed: failures });
    await admin.close(); await browser.close(); process.exitCode = failures ? 1 : 0;
}
