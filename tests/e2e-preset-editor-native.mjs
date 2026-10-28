// Native ST 1.19 + route-injected adapter. Only unique synthetic preset files may be changed.
import assert from 'node:assert/strict'; import { createRequire } from 'node:module'; import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib'; import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const base = process.argv[2] || 'http://127.0.0.1:8031'; assert.equal(base, 'http://127.0.0.1:8031', 'Only coordinated isolated 8031 is permitted');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.TEST_OUTPUT || '/tmp/tavern-improvements/preset-editor-native-evidence'); await mkdir(output, { recursive: true });
const run = `tl-preset-${Date.now()}-${randomUUID().slice(0, 8)}`, account = 'default-user', original = run, copy = `${run}-copy`, pendingCopy = `${run}-pending`;
const allowed = new Set([original, copy, pendingCopy]);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const staticSettings = JSON.parse(await readFile(path.join(root, 'tests/fixtures/preset-native-settings.json'), 'utf8'));
const fixture = JSON.parse(await readFile(path.join(root, 'tests/fixtures/preset-native-default.json'), 'utf8'));
fixture.importedUnknown = { marker: run, keep: 23 }; fixture.temperature = .7;
fixture.prompts.find(p => p.identifier === 'main').content = `BASE_${run}`;
fixture.prompts.find(p => p.identifier === 'main').extensionUnknown = { keep: 17 };
const files = ['bridge-preset-editor-native.js', 'bridge-preset-editor.js', 'src/preset-editor-model.js', 'src/save-outcome.js', 'src/episode-model.js'];
const modules = new Map(await Promise.all(files.map(async file => [`/__presetfix/${file}`, await readFile(path.join(root, file), 'utf8')])));
const checks = [], blocked = [], forwarded = [], routeErrors = [], pageErrors = [], observations = [];
let browser, context, page, token, fatal, phase = 'setup', fault = '', namesUnique = false, originalSettingsHash, originalPresetHashes, writes = 0, cleanup = false;
const check = (name, condition, detail) => { checks.push({ name, pass: !!condition, ...(detail === undefined ? {} : { detail }) }); console.log(condition ? 'PASS' : 'FAIL', name); assert.ok(condition, name); };
const modelPath = p => /^\/api\/(backends|horde|novelai|openai|kobold|sd|embeddings|vectors)(\/|$)/.test(p) || /^\/api\/.*(?:generate|completion)/i.test(p) || p.startsWith('/api/tokenizers/remote/');
const body = request => { const bytes = request.postDataBuffer(); return bytes ? JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString()) : {}; };
async function post(endpoint, data = {}) {
    assert.ok(['/api/users/login', '/api/settings/get', '/api/presets/save', '/api/presets/delete'].includes(endpoint));
    if (endpoint.startsWith('/api/presets/')) { assert.ok(namesUnique && allowed.has(data.name)); assert.equal(data.apiId, 'openai'); }
    if (endpoint === '/api/presets/save') assert.equal(data.preset?.importedUnknown?.marker, run);
    return context.request.post(base + endpoint, { data, headers: { 'X-CSRF-Token': token }, maxRedirects: 0 });
}
async function catalog() { const r = await post('/api/settings/get'); assert.ok(r.ok()); const data = await r.json();
    assert.equal(data.openai_setting_names.length, data.openai_settings.length);
    return { settingsHash: hash(data.settings), presets: new Map(data.openai_setting_names.map((name, i) => [name, typeof data.openai_settings[i] === 'string' ? JSON.parse(data.openai_settings[i]) : data.openai_settings[i]])) }; }
const fingerprints = presets => [...presets].filter(([name]) => !allowed.has(name)).map(([name, value]) => [name, hash(value)]).sort(([a], [b]) => a.localeCompare(b));
async function invoke(method, data = {}) { return page.evaluate(async ({ method, data }) => { try { return { settled: 'resolved', result: await __presetfix.adapter[method](data) }; }
    catch (e) { return { settled: 'rejected', error: { code: e.code, message: e.message } }; } }, { method, data }); }
const input = extra => ({ account, name: original, ...extra });
const save = extra => invoke('presetEditorSave', input(extra));
try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true }); context = await browser.newContext({ viewport: { width: 1060, height: 800 }, serviceWorkers: 'block' });
    const csrf = await context.request.get(base + '/csrf-token'); assert.ok(csrf.ok()); token = (await csrf.json()).token;
    assert.ok((await post('/api/users/login', { handle: account, password: process.env.TEST_PASSWORD || 'test1234' })).ok());
    const me = await context.request.get(base + '/api/users/me'); assert.ok(me.ok()); assert.equal((await me.json()).handle, account);
    const version = await context.request.get(base + '/version'); assert.ok(version.ok()); check('隔离服务为指定的酒馆版本', (await version.json()).pkgVersion === (process.env.EXPECT_ST_VERSION ?? '1.19.0'));
    for (const [file, expected] of [['openai.js', '0b77c30282825540265d5a09e681e5ccacf6760b05111ec880ffe237a9250604'], ['preset-manager.js', '6a4bf761140e105069f251e8db8f6a68144d6236b5175b452494a725a9a4df4c']]) {
        const r = await context.request.get(base + '/scripts/' + file); assert.ok(r.ok()); const source = await r.text();
        const rawHash = createHash('sha256').update(source).digest('hex'), normalizedHash = createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex');
        if ((process.env.EXPECT_ST_VERSION ?? '1.19.0') === '1.19.0') check(`实际${file}与审核源码一致（仅统一CRLF/LF）`, normalizedHash === expected, { rawHash, normalizedHash, expected });
        else console.log('native', file, normalizedHash);
    }
    const baseline = await catalog(); originalSettingsHash = baseline.settingsHash; originalPresetHashes = fingerprints(baseline.presets);
    assert.ok([...allowed].every(name => !baseline.presets.has(name)), 'Names must be absent before first write and any cleanup permission'); namesUnique = true;
    assert.ok((await post('/api/presets/save', { apiId: 'openai', name: original, preset: fixture })).ok());
    await context.route('**/*', async route => { try {
        const request = route.request(), url = new URL(request.url()), p = url.pathname;
        const forward = () => { forwarded.push(p); return route.continue(); }, actual = () => { forwarded.push(p); return route.fetch({ maxRedirects: 0 }); };
        if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
        if (url.origin !== base) { blocked.push({ phase, path: url.origin + p, reason: 'external' }); return route.abort('blockedbyclient'); }
        if (modules.has(p)) return route.fulfill({ contentType: 'text/javascript', body: modules.get(p) });
        if (p.startsWith('/__presetfix/')) return route.fulfill({ status: 404, body: 'Unknown fixture module' });
        if (p === '/api/settings/get') {
            if (fault === 'unknown-read') return route.fulfill({ status: 503, json: { error: 'Injected unavailable readback' } });
            const r = await actual(), data = await r.json(), settings = structuredClone(staticSettings);
            settings.main_api = 'openai'; settings.active_character = null; settings.active_group = null; settings.firstRun = false;
            settings.oai_settings = { ...settings.oai_settings, preset_settings_openai: original, prompts: structuredClone(fixture.prompts), prompt_order: structuredClone(fixture.prompt_order), temp_openai: fixture.temperature, bind_preset_to_connection: false };
            settings.extension_settings = { disabledExtensions: [], connectionManager: { profiles: [], selectedProfile: '' } };
            const owned = data.openai_setting_names.map((name, i) => [name, data.openai_settings[i]]).filter(([name]) => allowed.has(name));
            data.settings = JSON.stringify(settings); data.openai_setting_names = owned.map(x => x[0]); data.openai_settings = owned.map(x => x[1]);
            return route.fulfill({ response: r, json: data });
        }
        if (p === '/api/settings/save' || p === '/api/quick-replies/save' || p === '/api/stats/update') { blocked.push({ phase, path: p, reason: 'preserve-existing' }); return route.fulfill({ json: { result: 'ok' } }); }
        if (p === '/api/extensions/discover') return route.fulfill({ json: [] });
        if (p === '/api/secrets/read' || p === '/api/secrets/find') return route.fulfill({ json: {} });
        if (['/api/characters/all', '/api/characters/chats', '/api/chats/recent', '/api/groups/all', '/api/worldinfo/all', '/api/worldinfo/list'].includes(p)) return route.fulfill({ json: [] });
        if (p === '/api/stats/get') return route.fulfill({ json: {} });
        if (modelPath(p)) { blocked.push({ phase, path: p, reason: 'no-provider' }); return route.fulfill({ status: /\/horde\/(text-models|text-workers|sd-models|sd-samplers)$/.test(p) ? 200 : 503, json: [] }); }
        if (p === '/api/presets/save') {
            const data = body(request); assert.ok(namesUnique && allowed.has(data.name)); assert.equal(data.apiId, 'openai'); assert.equal(data.preset?.importedUnknown?.marker, run); writes++;
            if (fault === '500') return route.fulfill({ status: 500, json: { error: 'Injected before disk write' } });
            const r = await actual(); if (fault === 'lost' || fault === 'unknown') { if (fault === 'unknown') fault = 'unknown-read'; return route.abort('failed'); }
            return route.fulfill({ response: r });
        }
        if (!p.startsWith('/api/') || ['GET', 'HEAD'].includes(request.method()) || ['/api/avatars/get', '/api/backgrounds/all', '/api/users/list', '/api/assets/get', '/api/files/sanitize-filename'].includes(p) || p.startsWith('/api/tokenizers/')) return forward();
        blocked.push({ phase, path: p, reason: 'non-owned-write' }); return route.fulfill({ status: 409, json: { error: 'Only owned preset writes permitted' } });
    } catch (error) { routeErrors.push({ phase, message: error.message }); await route.fulfill({ status: 409, json: { error: 'Owned preset guard rejected request' } }).catch(() => route.abort('blockedbyclient').catch(() => {})); } });
    page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', e => pageErrors.push({ phase, message: e.message }));
    phase = 'bootstrap'; await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => { const c = window.SillyTavern?.getContext?.(); return c?.eventSource?.autoFireLastArgs?.has(c.eventTypes.APP_READY); }, null, { timeout: 240000 });
    const state = await page.evaluate(async ({ account, original }) => {
        const st = await import('/script.js'), openai = await import('/scripts/openai.js'), presetManager = await import('/scripts/preset-manager.js');
        const { createNativePresetEditor } = await import('/__presetfix/bridge-preset-editor-native.js');
        const ctx = () => SillyTavern.getContext(); let queue = Promise.resolve();
        const verifyAccount = async () => { const r = await fetch('/api/users/me'); if (!r.ok || (await r.json()).handle !== account) throw new Error('Account changed'); };
        // 1.19 has getPresetApplicationPromise; 1.16 to 1.18 end a preset change with PRESET_CHANGED for it.
        const changed = typeof openai.getPresetApplicationPromise === 'function' ? null : new Promise(resolve => {
            const on = data => { if (data?.name === original) { ctx().eventSource.removeListener(ctx().eventTypes.PRESET_CHANGED, on); resolve(); } };
            ctx().eventSource.on(ctx().eventTypes.PRESET_CHANGED, on); });
        await presetManager.getPresetManager('openai').selectPreset(String(openai.openai_setting_names[original]));
        await (changed ?? openai.getPresetApplicationPromise());
        const adapter = createNativePresetEditor({ account, st, openai, presetManager, ctx, verifyAccount,
            enqueue(fn) { const promise = queue.then(fn); queue = promise.catch(() => {}); return promise; } });
        window.__presetfix = { adapter, st, openai, presetManager, ctx, delayed: false, release: null };
        return adapter.presetEditorState();
    }, { account, original });
    check('实际原生活动预设及提示词权限读取正确', state.name === original && state.prompts.find(p => p.identifier === 'main')?.canEdit && state.full.importedUnknown.marker === run);
    phase = 'prompt-apply'; const applied = await invoke('presetEditorApplyPrompt', input({ identifier: 'main', base: `BASE_${run}`, text: `APPLIED_${run}` }));
    check('文字应用走真实PromptManager且未写命名文件', applied.result?.kind === 'confirmed' && writes === 0 && (await catalog()).presets.get(original).prompts.find(p => p.identifier === 'main').content === `BASE_${run}`);
    const numeric = await invoke('presetEditorSetField', input({ key: 'temperature', base: .7, value: .9 }));
    check('数值经过真实原生输入事件并读回', numeric.result?.samplers.temperature.value === .9);
    const streaming = await invoke('presetEditorSetField', input({ key: 'stream_openai', base: true, value: false }));
    check('流式开关经过真实原生change事件并读回', streaming.result?.stream === false);
    const toggle = await invoke('presetEditorSetField', input({ key: 'enabled:main', base: true, value: false }));
    check('提示词开关更新真实PromptManager条目且立即读回', toggle.result?.prompts.find(p => p.identifier === 'main')?.enabled === false);
    await invoke('presetEditorSetField', input({ key: 'enabled:main', base: false, value: true }));
    phase = 'http500'; fault = '500'; const rejected = await save(); check('HTTP500加OLD读回保持未知且实际文件不变', rejected.result?.kind === 'unconfirmed' && rejected.result.operation.writeOutcome === 'unknown' && hash((await catalog()).presets.get(original)) === hash(fixture));
    fault = ''; const preview = await invoke('presetEditorPrepareDecision', { account, operationId: rejected.result.operation.id });
    const decided = await invoke('presetEditorDecide', { ...preview.result, acknowledgement: 'late-write-can-overwrite-v1' });
    check('显式风险决定未伪造保存事实也未自动写入', decided.result?.kind === 'user-decided' && decided.result.operation.writeOutcome === 'unknown' && writes === 1);
    phase = 'save'; const saved = await save(); const disk = (await catalog()).presets.get(original);
    check('命名保存经服务器完整读回确认', saved.result?.kind === 'confirmed' && disk.temperature === .9 && disk.prompts.find(p => p.identifier === 'main').content === `APPLIED_${run}`);
    check('实际命名文件保留未知顶层和提示词字段', disk.importedUnknown.keep === 23 && disk.prompts.find(p => p.identifier === 'main').extensionUnknown.keep === 17);
    phase = 'three-way'; await invoke('presetEditorSetField', input({ key: 'temperature', base: .9, value: 1.1 }));
    const remote = structuredClone(disk); remote.top_p = .8; remote.temperature = 1.3; assert.ok((await post('/api/presets/save', { apiId: 'openai', name: original, preset: remote })).ok());
    const conflict = await save(); check('真实外部同字段修改触发三方冲突且不再写入', conflict.result?.kind === 'conflict' && conflict.result.conflicts.some(c => c.path[0] === 'temperature'));
    const choices = Object.fromEntries(conflict.result.conflicts.map(c => [c.key, { take: 'mine', server: c.server }])); const merged = await save({ resolutions: choices });
    const mergedDisk = (await catalog()).presets.get(original); check('显式选择只解决冲突，非冲突外部字段保留', merged.result?.kind === 'confirmed' && mergedDisk.temperature === 1.1 && mergedDisk.top_p === .8);
    phase = 'copy'; const originalBefore = hash(mergedDisk);
    await page.evaluate(copy => { const { ctx } = __presetfix; const hook = async data => { if (data.presetName === copy) { __presetfix.delayed = true; await new Promise(resolve => { __presetfix.release = resolve; }); } };
        ctx().eventSource.on(ctx().eventTypes.OAI_PRESET_CHANGED_BEFORE, hook); __presetfix.hook = hook; }, copy);
    const copyPromise = save({ copyName: copy }); await page.waitForFunction(() => __presetfix.delayed);
    const during = await page.evaluate(() => ({ name: __presetfix.openai.oai_settings.preset_settings_openai, released: !!__presetfix.release }));
    check('副本选择真实触发异步原生应用阶段', during.released);
    await page.evaluate(() => __presetfix.release()); const copied = await copyPromise;
    check('另存等待原生Promise后核验实际活动名和应用字段', copied.result?.kind === 'confirmed' && copied.result.applied && copied.result.actualCurrent === copy);
    check('另存保留原命名文件完整哈希', hash((await catalog()).presets.get(original)) === originalBefore && copied.result.originalUnchanged);
    await invoke('presetEditorSelect', { account, name: copy, target: original });
    phase = 'unknown-copy'; fault = 'unknown'; const unknown = await save({ copyName: pendingCopy });
    check('副本已落盘但读回不可用停为未知', unknown.result?.kind === 'unconfirmed' && (await catalog()).presets.has(pendingCopy)); const beforeRepeat = writes;
    const repeat = await save({ copyName: pendingCopy }); check('未知保存只阻断同目标重复提交且没有新HTTP写入', repeat.error?.code === 'PRESET_SAVE_PENDING' && writes === beforeRepeat);
    fault = ''; const recovered = await invoke('presetEditorRecover', input({ operationId: unknown.result.operation.id }));
    check('查验只读取已有副本，不重写也不自动切换', recovered.result?.kind === 'saved-not-applied' && writes === beforeRepeat && recovered.result.actualCurrent === original);
    const use = await invoke('presetEditorUseCopy', input({ operationId: unknown.result.operation.id })); check('明确使用已有副本完整核验且不再写入', use.result?.applied && use.result.actualCurrent === pendingCopy && writes === beforeRepeat);
    const final = await catalog(); check('所有原有命名预设完整哈希不变', hash(fingerprints(final.presets)) === hash(originalPresetHashes));
    check('原账号settings完整哈希不变', final.settingsHash === originalSettingsHash);
    check('未转发模型或远程分词请求', !forwarded.some(modelPath)); check('请求守护没有断言异常', routeErrors.length === 0, routeErrors);
    observations.push({ namedWrites: writes, actualCurrent: use.result.actualCurrent, copyConfirmed: copied.result.fileConfirmed, pendingRecovered: recovered.result.fileConfirmed });
} catch (error) { fatal = { phase, message: error.message, stack: error.stack }; console.error('FAIL', phase, error.message); await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
finally {
    phase = 'cleanup'; fault = ''; await page?.close().catch(() => {});
    if (context && namesUnique) try { const before = await catalog(); for (const name of allowed) if (before.presets.has(name)) assert.ok((await post('/api/presets/delete', { apiId: 'openai', name })).ok());
        const after = await catalog(); cleanup = [...allowed].every(name => !after.presets.has(name)); check('全部本次唯一命名预设已清理', cleanup);
        check('清理后原预设与settings完整一致', hash(fingerprints(after.presets)) === hash(originalPresetHashes) && after.settingsHash === originalSettingsHash);
    } catch (error) { fatal ||= { phase, message: error.message }; cleanup = false; }
    await browser?.close(); const result = { run, base, checks, passed: checks.filter(x => x.pass).length, failed: checks.filter(x => !x.pass).length, fatal, cleanup, observations, blocked, forwarded, routeErrors, pageErrors,
        moduleHashes: Object.fromEntries([...modules].map(([file, text]) => [file, createHash('sha256').update(text).digest('hex')])),
        unverified: ['Root product bridge wiring not applied', 'Actual phone keyboard and IME are not tested here', 'Cross-device atomic named save is not provided by native server', 'Third-party extensions disabled in this isolated browser fixture'] };
    await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ passed: result.passed, failed: result.failed, cleanup, pageErrors: pageErrors.length, fatal: fatal?.message, output }));
    if (fatal || result.failed || !cleanup || routeErrors.length || pageErrors.length) process.exitCode = 1;
}
