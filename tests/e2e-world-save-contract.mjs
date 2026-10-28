// ED-00 characterization of native ST 1.19.0 saveWorldInfo on isolated 8031.
// Writes only one uniquely named synthetic book. No product files, settings, characters or associations are changed.
// Intentional failures are PASS only when independently observed; this is not a repaired-save acceptance test.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [base = 'http://127.0.0.1:8031'] = process.argv.slice(2);
assert.equal(base, 'http://127.0.0.1:8031', 'This probe permits only isolated loopback 8031; production and 8032 are forbidden');
const output = path.resolve(process.env.TEST_OUTPUT || '/tmp/tavern-world-save-contract-evidence');
await mkdir(output, { recursive: true });
const run = `tl-ed00-${Date.now()}-${randomUUID().slice(0, 8)}`, book = run, account = 'default-user';
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sourceHash = text => createHash('sha256').update(text).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const checks = [], network = [], blocked = [], errors = [], observations = [], forwardedBrowserPaths = [];
let browser, context, page, token, fatal, phase = 'setup', fault = '', owned = false, cleanup = false, settingsFingerprint, originalBookList;
let forwardedWorldWrites = 0;
const modelPath = endpoint => /^\/api\/(backends|horde|novelai|openai|kobold|sd|embeddings|vectors)(\/|$)/.test(endpoint) || /^\/api\/.*(?:generate|completion)/i.test(endpoint);
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }); console.log(pass ? 'PASS' : 'FAIL', name); assert.ok(pass, name); };
const fixture = {
    name: book, extensions: { ed00_probe: run, untouched_unknown: { nested: ['keep', 17] } },
    entries: { 0: { uid: 0, key: ['ED00_KEY'], keysecondary: [], comment: '合成条目', content: `BASE_${run}`, constant: false, vectorized: false,
        selective: true, selectiveLogic: 0, order: 100, position: 0, depth: 4, role: null, disable: false, probability: 100, useProbability: true, displayIndex: 0,
        probe_unknown: { preserve: true } } },
    originalData: { name: book, entries: [{ uid: 0, keys: ['ED00_KEY'], content: `BASE_${run}`, enabled: true, extensions: { unknown: 'retained' } }] },
};
function payload(request) {
    const bytes = request.postDataBuffer();
    if (!bytes) return {};
    return JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString('utf8'));
}
async function post(endpoint, data = {}) {
    assert.ok(['/api/users/login', '/api/settings/get', '/api/worldinfo/get', '/api/worldinfo/edit', '/api/worldinfo/delete', '/api/worldinfo/list'].includes(endpoint));
    if (endpoint.startsWith('/api/worldinfo/') && endpoint !== '/api/worldinfo/list') assert.equal(data.name, book);
    if (endpoint === '/api/worldinfo/edit') assert.equal(data.data?.extensions?.ed00_probe, run);
    return context.request.post(base + endpoint, { data, headers: { 'X-CSRF-Token': token }, maxRedirects: 0 });
}
async function disk() { const response = await post('/api/worldinfo/get', { name: book }); assert.ok(response.ok()); return response.json(); }
async function list() { const response = await post('/api/worldinfo/list'); assert.ok(response.ok()); return response.json(); }
const bookListHash = rows => hash(rows.filter(row => row.file_id !== book));
async function reset() {
    fault = '';
    assert.ok((await post('/api/worldinfo/edit', { name: book, data: fixture })).ok());
    await page.evaluate(async book => {
        const wi = await import('/scripts/world-info.js'); wi.worldInfoCache.delete(book);
        await wi.loadWorldInfo(book); window.__ed00.events.length = 0;
    }, book);
    assert.equal(hash(await disk()), hash(fixture));
}
async function state() {
    return page.evaluate(async book => {
        const wi = await import('/scripts/world-info.js');
        return { cached: await wi.loadWorldInfo(book), events: structuredClone(window.__ed00.events) };
    }, book);
}
async function invoke(method, value) {
    return page.evaluate(async ({ book, method, value }) => {
        try {
            // Deliberately bypass the repaired adapter: this characterizes native semantics only.
            const wi = await import('/scripts/world-info.js'), data = await wi.loadWorldInfo(book);
            const entry = method === 'save' ? data.entries[0] : wi.createWorldInfoEntry(book, data);
            if (!entry) throw new Error('Owned native entry was not available');
            entry.content = value;
            if (method === 'save') wi.setWIOriginalDataValue(data, entry.uid, 'content', value);
            else Object.assign(entry, { comment: '合成新增', key: ['ED00_NEW'], constant: false });
            await wi.saveWorldInfo(book, data, true);
            return { settled: 'resolved', result: structuredClone(entry) };
        } catch (error) { return { settled: 'rejected', error: { name: error.name, message: error.message, code: error.code ?? null } }; }
    }, { book, method, value });
}
try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    context = await browser.newContext({ viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' });
    const csrfResponse = await context.request.get(base + '/csrf-token'); assert.ok(csrfResponse.ok()); token = (await csrfResponse.json()).token;
    const login = await post('/api/users/login', { handle: account, password: process.env.TEST_PASSWORD || 'test1234' }); assert.ok(login.ok(), `isolated login HTTP ${login.status()}`);
    const me = await context.request.get(base + '/api/users/me'); assert.ok(me.ok()); assert.equal((await me.json()).handle, account);
    const versionResponse = await context.request.get(base + '/version'); assert.ok(versionResponse.ok(), `/version HTTP ${versionResponse.status()}`);
    const version = await versionResponse.json(); check('隔离实例为指定的酒馆版本', version.pkgVersion === (process.env.EXPECT_ST_VERSION ?? '1.19.0'), { pkgVersion: version.pkgVersion });
    const worldSource = await context.request.get(base + '/scripts/world-info.js'); assert.ok(worldSource.ok());
    const worldHash = sourceHash(await worldSource.text());
    // Recorded only: the file differs between versions; the save behaviour checks below decide.
    observations.push({ phase, nativeWorldSha256: worldHash, adapterBypassed: true });
    const settings = await post('/api/settings/get'); assert.ok(settings.ok()); settingsFingerprint = hash((await settings.json()).settings);
    originalBookList = await list(); assert.ok(!originalBookList.some(row => row.file_id === book), 'Unique fixture name must not pre-exist');
    const created = await post('/api/worldinfo/edit', { name: book, data: fixture }); assert.ok(created.ok()); owned = true;
    check('唯一合成世界书首写完整读回', hash(await disk()) === hash(fixture));

    const readPaths = new Set(['/api/plugins/tavern-lite-save/probe', '/api/extensions/version', '/api/characters/all', '/api/characters/get', '/api/characters/chats', '/api/chats/get', '/api/chats/recent', '/api/groups/all',
        '/api/backgrounds/all', '/api/avatars/get', '/api/worldinfo/get', '/api/worldinfo/all', '/api/worldinfo/list', '/api/secrets/read', '/api/secrets/find',
        '/api/extensions/manifest', '/api/users/list', '/api/assets/get']);
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
        const forward = () => { forwardedBrowserPaths.push(endpoint); return route.continue(); };
        const fetchActual = () => { forwardedBrowserPaths.push(endpoint); return route.fetch({ maxRedirects: 0 }); };
        if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
        if (url.origin !== base) { blocked.push({ phase, endpoint: url.origin + endpoint, reason: 'external-origin' }); return route.abort('blockedbyclient'); }
        if (endpoint === '/api/settings/get') {
            const response = await fetchActual(), data = await response.json(), settings = JSON.parse(data.settings);
            settings.active_character = null; settings.active_group = null; settings.firstRun = false;
            // In-memory bootstrap only. Prevent opening a real story or automatic connections; original settings never leave their server.
            if (settings.extension_settings?.connectionManager) settings.extension_settings.connectionManager = { ...settings.extension_settings.connectionManager, profiles: [], selectedProfile: '' };
            data.settings = JSON.stringify(settings); return route.fulfill({ response, json: data });
        }
        if (endpoint === '/api/settings/save') { blocked.push({ phase, endpoint, reason: 'settings-preserved' }); return route.fulfill({ status: 200, json: { result: 'ok' } }); }
        if (endpoint === '/api/extensions/discover') {
            const response = await fetchActual(), entries = await response.json();
            // Test native save behavior without loading third-party plugin code or the product bridge.
            return route.fulfill({ response, json: entries.filter(entry => !entry.name.startsWith('third-party/')) });
        }
        if (modelPath(endpoint) || endpoint.startsWith('/api/tokenizers/remote/')) {
            blocked.push({ phase, endpoint, reason: 'model-network-blocked' });
            if (/\/horde\/(text-models|text-workers|sd-models|sd-samplers)$/.test(endpoint)) return route.fulfill({ json: [] });
            return route.fulfill({ status: 503, json: { error: 'ED00 permits no model/provider requests' } });
        }
        if (endpoint === '/api/worldinfo/edit') {
            const data = payload(request);
            assert.equal(data.name, book, 'Browser may write only owned temporary book'); assert.equal(data.data?.extensions?.ed00_probe, run);
            if (fault === 'http500') { network.push({ phase, endpoint, status: 500, forwarded: false }); return route.fulfill({ status: 500, json: { error: 'Injected ED00 save failure before server' } }); }
            const response = await fetchActual(); forwardedWorldWrites++;
            network.push({ phase, endpoint, status: response.status(), forwarded: true, lostResponse: fault === 'lost-response' });
            if (fault === 'lost-response') return route.abort('failed');
            return route.fulfill({ response });
        }
        if (!endpoint.startsWith('/api/') || ['GET', 'HEAD'].includes(request.method()) || readPaths.has(endpoint) || endpoint.startsWith('/api/tokenizers/')) return forward();
        blocked.push({ phase, endpoint, reason: 'non-owned-write' }); return route.fulfill({ status: 409, json: { error: 'ED00 blocks settings, chats, associations and unrelated writes' } });
    });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push({ phase, message: error.message }));
    phase = 'native-bootstrap'; await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Read the tested emitter's completed APP_READY record; a late event subscription is not a readiness guarantee.
    await page.waitForFunction(() => { const c = window.SillyTavern?.getContext?.(); return c?.eventSource?.autoFireLastArgs?.has(c.eventTypes.APP_READY); }, null, { timeout: 240000 });
    const ready = await page.evaluate(async book => {
        const wi = await import('/scripts/world-info.js'), st = await import('/script.js');
        window.__ed00 = { events: [] };
        st.eventSource.on(st.event_types.WORLDINFO_UPDATED, (name, data) => { if (name === book) window.__ed00.events.push({ name, data: structuredClone(data) }); });
        if (!wi.world_names.includes(book)) throw new Error('Owned fixture absent from native world names');
        return { native: typeof wi.saveWorldInfo === 'function' && typeof wi.createWorldInfoEntry === 'function', loaded: await wi.loadWorldInfo(book) };
    }, book);
    check('原生世界书 API 已加载，未调用轻酒馆保存 API', ready.native);
    check('native 初次缓存与磁盘完整一致', hash(ready.loaded) === hash(await disk()));

    phase = 'http500-existing-entry'; fault = 'http500';
    const before500 = await disk(), failedText = `NOT_PERSISTED_${run}`, failed = await invoke('save', failedText), state500 = await state(), disk500 = await disk();
    observations.push({ phase, invocation: failed, cached: state500.cached, events: state500.events, disk: disk500 });
    check('HTTP500 已在唯一目标拦截且未转发落盘', network.at(-1)?.status === 500 && network.at(-1)?.forwarded === false);
    check('原生缺陷证据：HTTP500 后 saveWorldInfo 仍 resolve', failed.settled === 'resolved' && failed.result?.content === failedText);
    check('HTTP500 后 native 仍发出 WORLDINFO_UPDATED', state500.events.length === 1 && state500.events[0].data.entries[0].content === failedText);
    check('HTTP500 后缓存已有新内容而磁盘保持原文', state500.cached.entries[0].content === failedText && hash(disk500) === hash(before500) && hash(state500.cached) !== hash(disk500));
    check('originalData 同样出现缓存已改但磁盘未改', state500.cached.originalData.entries[0].content === failedText && disk500.originalData.entries[0].content === fixture.originalData.entries[0].content);
    check('同 UID 同条目数不能证明保存成功', state500.cached.entries[0].uid === disk500.entries[0].uid && Object.keys(state500.cached.entries).length === Object.keys(disk500.entries).length);

    await reset(); phase = 'lost-response-existing-entry'; fault = 'lost-response';
    const persistedText = `PERSISTED_BUT_UNKNOWN_${run}`, lost = await invoke('save', persistedText), lostState = await state(), lostDisk = await disk();
    observations.push({ phase, invocation: lost, cached: lostState.cached, events: lostState.events, disk: lostDisk });
    check('回包丢失前服务器确已接收成功写入', network.at(-1)?.forwarded === true && network.at(-1)?.status === 200 && network.at(-1)?.lostResponse);
    check('落盘后回包丢失时原生 Promise 拒绝', lost.settled === 'rejected');
    check('拒绝并不代表未保存：独立磁盘读回完整新内容', lostDisk.entries[0].content === persistedText && hash(lostDisk) === hash(lostState.cached));
    check('失响应时缓存先更新但更新事件没有发生', lostState.events.length === 0 && lostState.cached.originalData.entries[0].content === persistedText);
    check('未知导入字段及原书扩展完整保留', hash(lostDisk.extensions) === hash(fixture.extensions) && hash(lostDisk.entries[0].probe_unknown) === hash(fixture.entries[0].probe_unknown));

    await reset(); phase = 'unknown-create-then-naive-retry'; fault = 'lost-response';
    const duplicateText = `ONE_AUTHOR_REQUEST_${run}`, firstAdd = await invoke('add', duplicateText), firstDisk = await disk();
    check('新增落盘但回包未知时第一次调用拒绝', firstAdd.settled === 'rejected' && Object.keys(firstDisk.entries).length === 2);
    fault = ''; const retried = await invoke('add', duplicateText), retriedDisk = await disk();
    const duplicates = Object.values(retriedDisk.entries).filter(entry => entry.content === duplicateText);
    observations.push({ phase, firstInvocation: firstAdd, firstDisk, naiveRetryInvocation: retried, retriedDisk });
    check('受控演示：原样重试新增会产生第二个 UID', retried.settled === 'resolved' && duplicates.length === 2 && duplicates[0].uid !== duplicates[1].uid, { duplicateCount: duplicates.length, uids: duplicates.map(entry => entry.uid) });
    check('UID 分配不具备作者操作幂等语义', Object.keys(retriedDisk.entries).length === 3);

    phase = 'protect-original-data';
    const finalSettings = await post('/api/settings/get'); assert.ok(finalSettings.ok());
    check('原账号 settings 文件内容未改变', hash((await finalSettings.json()).settings) === settingsFingerprint);
    check('其余世界书清单与元信息保持不变', bookListHash(await list()) === hash(originalBookList));
    check('测试没有转发任何模型或远程分词请求', !forwardedBrowserPaths.some(p => modelPath(p) || p.startsWith('/api/tokenizers/remote/')));
} catch (error) {
    fatal = { phase, name: error.name, message: error.message, stack: error.stack }; console.error('FAIL', phase, error.message);
} finally {
    phase = 'cleanup'; fault = '';
    await page?.close().catch(error => errors.push({ phase, message: error.message }));
    if (owned && context) {
        try {
            const response = await post('/api/worldinfo/delete', { name: book }); assert.ok(response.ok());
            const remaining = await list(); cleanup = !remaining.some(row => row.file_id === book);
            check('唯一临时世界书已删除', cleanup);
            check('清理后原世界书清单完整恢复', hash(remaining) === hash(originalBookList));
            const after = await post('/api/settings/get'); assert.ok(after.ok()); check('清理后 settings 仍与开始完全一致', hash((await after.json()).settings) === settingsFingerprint);
        } catch (error) { cleanup = false; errors.push({ phase, message: error.message }); fatal ||= { phase, message: error.message }; }
    }
    await browser?.close().catch(() => {});
    const result = { run, book, base, account, purpose: 'Native ST saveWorldInfo characterization only; repaired Lite adapter deliberately bypassed',
        pass: !fatal && checks.every(x => x.pass) && cleanup, checks, observations, network, blocked, browserErrors: errors,
        forwardedWorldWrites, modelCallsForwarded: forwardedBrowserPaths.filter(modelPath).length, cleanup, fatal,
        unverified: ['No product fix was applied or accepted', 'No production writes', 'Third-party plugins were not loaded',
            'No cross-device atomic conflict prevention or exactly-once guarantee', 'No real phone or editor UX acceptance'] };
    await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ pass: result.pass, passed: checks.filter(x => x.pass).length, total: checks.length, cleanup, output }));
    if (!result.pass) process.exitCode = 1;
}
