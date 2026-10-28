/** ED00 repair acceptance: native ST modules + injected new adapter; no mounted-app modifications. */
import assert from 'node:assert/strict'; import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const base = process.argv[2] || 'http://127.0.0.1:8031';
assert.equal(base, 'http://127.0.0.1:8031', 'Only isolated 8031 is permitted, never production or 8032');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.TEST_OUTPUT || '/tmp/tavern-improvements/world-editor-native-evidence');
await mkdir(output, { recursive: true });
const run = `tl-ed-fix-${Date.now()}-${randomUUID().slice(0, 8)}`, book = run, copy = `${run}-copy`, blank = `${run}-blank`, account = 'default-user';
const allowed = new Set([book, copy, blank]);
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
const hash = x => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const checks = [], network = [], blocked = [], observations = [], pageErrors = [], routeErrors = [], forwarded = [];
let browser, context, page, token, fatal, phase = 'setup', fault = '', attempted = 0, forwardedWrites = 0, cleanup = false, settingsHash, originalList, namesVerifiedUnique = false;
const check = (name, condition, detail) => { checks.push({ name, pass: !!condition, ...(detail === undefined ? {} : { detail }) }); console.log(condition ? 'PASS' : 'FAIL', name, condition || detail === undefined ? '' : JSON.stringify(detail)); assert.ok(condition, name); };
const modelPath = p => /^\/api\/(backends|horde|novelai|openai|kobold|sd|embeddings|vectors)(\/|$)/.test(p) || /^\/api\/.*(?:generate|completion)/i.test(p);
const fixture = { name: book, extensions: { ed00_probe: run, unknown: { retained: ['value', 19] } }, entries: {
    0: { uid: 0, key: ['ED_FIX'], keysecondary: [], comment: '独立合成条目', content: `BASE_${run}`, constant: false, vectorized: false,
        selective: true, selectiveLogic: 0, order: 100, position: 0, depth: 4, role: null, disable: false, probability: 100, useProbability: true, displayIndex: 0,
        imported_unknown: { keep: true } },
}, originalData: { name: book, entries: [{ uid: 0, keys: ['ED_FIX'], content: `BASE_${run}`, enabled: true, extensions: { unknown: 3 } }] } };
const moduleFiles = ['bridge-world-editor-native.js', 'bridge-world-editor.js', 'src/world-editor-model.js', 'src/world-editor-journal.js', 'src/episode-model.js', 'src/save-outcome.js'];
const modules = new Map(await Promise.all(moduleFiles.map(async file => [`/__edfix/${file}`, await readFile(path.join(root, file), 'utf8')])));
const body = request => { const bytes = request.postDataBuffer(); return bytes ? JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString()) : {}; };
async function post(endpoint, data = {}) {
    assert.ok(['/api/users/login', '/api/settings/get', '/api/worldinfo/list', '/api/worldinfo/get', '/api/worldinfo/edit', '/api/worldinfo/delete'].includes(endpoint));
    if (endpoint.startsWith('/api/worldinfo/') && endpoint !== '/api/worldinfo/list') assert.ok(allowed.has(data.name));
    if (endpoint === '/api/worldinfo/edit') assert.equal(data.data?.extensions?.ed00_probe, run);
    return context.request.post(base + endpoint, { data, headers: { 'X-CSRF-Token': token }, maxRedirects: 0 });
}
async function disk(name = book) { const r = await post('/api/worldinfo/get', { name }); assert.ok(r.ok()); return r.json(); }
async function list() { const r = await post('/api/worldinfo/list'); assert.ok(r.ok()); return r.json(); }
async function invoke(method, input) { return page.evaluate(async ({ method, input }) => { try { return { settled: 'resolved', result: await window.__edfix.adapter[method](input) }; } catch (e) { return { settled: 'rejected', error: { code: e.code, message: e.message, operation: e.detail?.operation } }; } }, { method, input }); }
async function state() { return page.evaluate(async book => { const wi = await import('/scripts/world-info.js'); return { cache: wi.worldInfoCache.get(book), events: structuredClone(window.__edfix.events) }; }, book); }
const save = content => invoke('saveWorldEditorEntry', { account, name: book, uid: 0, baseEntry: fixture.entries[0], patch: { content }, draftRevision: 1 });
const recover = operation => invoke('recoverWorldEditorWrite', { account, operationId: operation.operationId });
async function reset() {
    fault = ''; attempted = 0;
    assert.ok((await post('/api/worldinfo/edit', { name: book, data: fixture })).ok());
    await page.evaluate(async ({ book }) => { const wi = await import('/scripts/world-info.js'); wi.worldInfoCache.delete(book); await wi.loadWorldInfo(book); window.__edfix.events.length = 0; }, { book });
    // Explicitly end owned prior fault cases; a read of OLD alone must never unlock saving.
    await page.evaluate(async ({ account, book }) => {
        const api = window.__edfix.adapter;
        const { isBlockingWorldOperation, WORLD_DECISION_ACK } = await import('/__edfix/src/world-editor-model.js');
        for (const op of await api.worldEditorUnfinished()) if (op.name === book && isBlockingWorldOperation(op)) {
            const preview = await api.prepareWorldOperationDecision({ account, operationId: op.operationId });
            await api.resolveWorldOperation({ ...preview, acknowledgement: WORLD_DECISION_ACK });
        }
        await api.useWorldServerAuthority({ account, name: book }); window.__edfix.events.length = 0;
    }, { account, book });
    assert.equal(hash(await disk()), hash(fixture));
}
try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    context = await browser.newContext({ viewport: { width: 1060, height: 800 }, serviceWorkers: 'block' });
    const csrf = await context.request.get(base + '/csrf-token'); assert.ok(csrf.ok()); token = (await csrf.json()).token;
    const login = await post('/api/users/login', { handle: account, password: process.env.TEST_PASSWORD || 'test1234' }); assert.ok(login.ok(), `login HTTP ${login.status()}`);
    const me = await context.request.get(base + '/api/users/me'); assert.ok(me.ok()); assert.equal((await me.json()).handle, account);
    const vr = await context.request.get(base + '/version'); assert.ok(vr.ok()); check('实际隔离实例为指定的酒馆版本', (await vr.json()).pkgVersion === (process.env.EXPECT_ST_VERSION ?? '1.19.0'));
    const ws = await context.request.get(base + '/scripts/world-info.js'); assert.ok(ws.ok());
    const worldHash = createHash('sha256').update(await ws.text()).digest('hex');
    if ((process.env.EXPECT_ST_VERSION ?? '1.19.0') === '1.19.0') check('原生 world-info 保存源码与 ED00 一致', worldHash === '111c7f47945839e75b021e09bdbb112a54f0a9b7857d2b95435f573efc7cd9a5');
    else console.log('native world-info.js', worldHash);
    const settings = await post('/api/settings/get'); assert.ok(settings.ok()); settingsHash = hash((await settings.json()).settings);
    originalList = await list(); assert.ok(!originalList.some(row => allowed.has(row.file_id)), 'All owned names must be unique before any write');
    namesVerifiedUnique = true;
    assert.ok((await post('/api/worldinfo/edit', { name: book, data: fixture })).ok());
    const readPaths = new Set(['/api/plugins/tavern-lite-save/probe', '/api/extensions/version', '/api/characters/all', '/api/characters/get', '/api/characters/chats', '/api/chats/get', '/api/chats/recent', '/api/groups/all',
        '/api/backgrounds/all', '/api/avatars/get', '/api/worldinfo/get', '/api/worldinfo/all', '/api/worldinfo/list', '/api/secrets/read', '/api/secrets/find',
        '/api/extensions/manifest', '/api/users/list', '/api/assets/get']);
    await context.route('**/*', async route => {
        try {
        const request = route.request(), url = new URL(request.url()), p = url.pathname;
        const forward = () => { forwarded.push(p); return route.continue(); };
        const fetchActual = () => { forwarded.push(p); return route.fetch({ maxRedirects: 0 }); };
        if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
        if (url.origin !== base) { blocked.push({ phase, path: url.origin + p, why: 'external' }); return route.abort('blockedbyclient'); }
        if (modules.has(p)) return route.fulfill({ contentType: 'text/javascript', body: modules.get(p) });
        if (p.startsWith('/__edfix/')) return route.fulfill({ status: 404, body: 'Unknown test module' });
        if (p === '/api/settings/get') {
            const r = await fetchActual(), data = await r.json(), s = JSON.parse(data.settings);
            s.active_character = null; s.active_group = null; s.firstRun = false;
            if (s.extension_settings?.connectionManager) s.extension_settings.connectionManager = { ...s.extension_settings.connectionManager, profiles: [], selectedProfile: '' };
            data.settings = JSON.stringify(s); return route.fulfill({ response: r, json: data });
        }
        if (p === '/api/settings/save') { blocked.push({ phase, path: p, why: 'preserve-settings' }); return route.fulfill({ json: { result: 'ok' } }); }
        if (p === '/api/extensions/discover') { const r = await fetchActual(); return route.fulfill({ response: r, json: (await r.json()).filter(x => !x.name.startsWith('third-party/')) }); }
        if (modelPath(p) || p.startsWith('/api/tokenizers/remote/')) { blocked.push({ phase, path: p, why: 'no-provider' }); return route.fulfill({ status: /\/horde\/(text-models|text-workers|sd-models|sd-samplers)$/.test(p) ? 200 : 503, json: [] }); }
        if (p === '/api/worldinfo/get' && fault === 'lost-read' && attempted && body(request).name === book) return route.fulfill({ status: 503, json: { error: 'Injected unavailable independent readback' } });
        if (p === '/api/worldinfo/edit') {
            const data = body(request); assert.ok(allowed.has(data.name), 'Only uniquely owned synthetic worlds may be written');
            assert.ok(data.name === blank && hash(data.data) === hash({ entries: {} }) || data.data?.extensions?.ed00_probe === run, 'Full owned fixture marker required');
            attempted++;
            if (fault === '500') { network.push({ phase, name: data.name, status: 500, forwarded: false }); return route.fulfill({ status: 500, json: { error: 'Injected before server write' } }); }
            const r = await fetchActual(); forwardedWrites++; network.push({ phase, name: data.name, status: r.status(), forwarded: true, lost: fault.startsWith('lost') });
            if (fault.startsWith('lost')) return route.abort('failed');
            return route.fulfill({ response: r });
        }
        if (!p.startsWith('/api/') || ['GET', 'HEAD'].includes(request.method()) || readPaths.has(p) || p.startsWith('/api/tokenizers/')) return forward();
        blocked.push({ phase, path: p, why: 'non-owned-write' }); return route.fulfill({ status: 409, json: { error: 'Test permits no other mutations' } });
        } catch (error) {
            routeErrors.push({ phase, message: error.message });
            await route.fulfill({ status: 409, json: { error: 'Test request rejected by owned-fixture guard' } }).catch(() => route.abort('blockedbyclient').catch(() => {}));
        }
    });
    page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', e => pageErrors.push({ phase, message: e.message }));
    phase = 'native-bootstrap'; await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => { const c = window.SillyTavern?.getContext?.(); return c?.eventSource?.autoFireLastArgs?.has(c.eventTypes.APP_READY); }, null, { timeout: 240000 });
    const ready = await page.evaluate(async ({ account, book, run }) => {
        const wi = await import('/scripts/world-info.js'), st = await import('/script.js'), powerUser = await import('/scripts/power-user.js');
        const { createNativeWorldEditor } = await import('/__edfix/bridge-world-editor-native.js'), { createWorldEditorJournal } = await import('/__edfix/src/world-editor-journal.js');
        const ctx = () => SillyTavern.getContext(), journal = createWorldEditorJournal({ name: `edfix-${run}` });
        let queue = Promise.resolve(), owner = null;
        window.__edfix = { events: [], failJournal: false, journal };
        const verifyAccount = async () => { const r = await fetch('/api/users/me'); if (!r.ok || (await r.json()).handle !== account) throw Object.assign(new Error('Account changed'), { code: 'ACCOUNT_CHANGED' }); };
        const adapter = createNativeWorldEditor({ account, worldInfo: wi, st, powerUser, ctx, uuid: () => crypto.randomUUID(),
            journal: { ...journal, async update(op, patch) { if (window.__edfix.failJournal && patch.writeSettled === 'resolved') { window.__edfix.failJournal = false; throw Object.assign(new Error('Injected IDB post-write failure'), { code: 'WORLD_JOURNAL_UNAVAILABLE' }); } return journal.update(op, patch); } },
            verifyAccount, waitIdle: async () => { if (window.__edfix.waitGate) { window.__edfix.idleReached = true; await window.__edfix.waitGate; } if (st.is_send_press || st.isChatSaving) throw new Error('Native is not idle'); },
            enqueue(fn) { const promise = queue.then(async () => { owner = {}; try { await verifyAccount(); return await fn(); } finally { owner = null; } }); queue = promise.catch(() => {}); return promise; },
            makeLease: () => ({ account, owner, document }), assertQueueOwner: lease => { if (!owner || lease.owner !== owner) throw new Error('Invalid queue owner'); },
            assertLease: lease => { if (lease.account !== account || lease.document !== document || !document.documentElement.isConnected) throw new Error('Invalid lease'); },
        });
        Object.assign(window.__edfix, { adapter });
        ctx().eventSource.on(ctx().eventTypes.WORLDINFO_UPDATED, (name, data) => { if (name === book) window.__edfix.events.push({ name, data: structuredClone(data) }); });
        return { native: await wi.loadWorldInfo(book), actual: await adapter.worldEditorBook(book) };
    }, { account, book, run });
    check('新桥接实际使用原生读取、缓存、完整正文基线', hash(ready.native) === hash(fixture) && hash(ready.actual.snapshot) === hash(fixture) && ready.actual.runtimeState === 'ready');

    phase = 'final-idle-cache-guard';
    await page.evaluate(({ account, book, baseline }) => {
        const f = window.__edfix; f.idleReached = false; f.waitGate = new Promise(resolve => { f.releaseIdle = resolve; });
        f.pending = f.adapter.saveWorldEditorEntry({ account, name: book, uid: 0, baseEntry: baseline, patch: { content: 'MUST_NOT_WRITE' }, draftRevision: 1 });
    }, { account, book, baseline: fixture.entries[0] });
    await page.waitForFunction(() => window.__edfix.idleReached);
    await page.evaluate(async book => { const wi = await import('/scripts/world-info.js'), value = wi.worldInfoCache.get(book); value.entries[0].content = 'LATE_NATIVE_EDIT'; wi.worldInfoCache.set(book, value); window.__edfix.releaseIdle(); window.__edfix.waitGate = null; }, book);
    const guarded = await page.evaluate(() => window.__edfix.pending);
    check('原生最后idle等待期间的新cache编辑令保存0调用且未取消其内容', guarded.kind === 'not-submitted' && guarded.operation.writeSettled === 'not-started' && attempted === 0 && (await state()).cache.entries[0].content === 'LATE_NATIVE_EDIT' && hash(await disk()) === hash(fixture));
    check('0调用终态记录可恢复明确未提交', (await recover(guarded.operation)).result?.kind === 'not-submitted' && attempted === 0);
    await reset();

    phase = 'corrective-listener-conflict'; fault = 'lost';
    await page.evaluate(async ({ book, baseline }) => {
        const wi = await import('/scripts/world-info.js'), c = SillyTavern.getContext();
        window.__edfix.conflictListener = async (name, data) => {
            if (name !== book || data?.entries?.[0]?.content !== baseline) return;
            await Promise.resolve(); const next = wi.worldInfoCache.get(name); next.entries[0].content = 'CORRECTIVE_LISTENER_NEW_EDIT'; wi.worldInfoCache.set(name, next);
        };
        c.eventSource.on(c.eventTypes.WORLDINFO_UPDATED, window.__edfix.conflictListener);
    }, { book, baseline: `COMMITTED_${run}` });
    const conflictResult = await save(`COMMITTED_${run}`);
    check('真实已落盘确认后的异步纠正监听器新编辑不会被标记runtime ready', conflictResult.result?.kind === 'confirmed' && conflictResult.result?.runtimeState === 'conflict' && (await state()).cache.entries[0].content === 'CORRECTIVE_LISTENER_NEW_EDIT' && (await invoke('assertWorldRuntimeReady')).error?.code === 'WORLD_RUNTIME_UNCONFIRMED');
    await page.evaluate(() => { const c = SillyTavern.getContext(); c.eventSource.removeListener(c.eventTypes.WORLDINFO_UPDATED, window.__edfix.conflictListener); });
    const beforeAuthority = attempted, authority = await invoke('useWorldServerAuthority', { account, name: book });
    check('以服务器为准只读核对后解除本页dirty且无第二写入', authority.result?.kind === 'ready' && hash((await state()).cache) === hash(await disk()) && attempted === beforeAuthority && (await invoke('assertWorldRuntimeReady')).settled === 'resolved');
    check('运行解锁保留原日志且已确认记录只读观察', (await recover(conflictResult.result.operation)).result?.kind === 'historical-observation' && attempted === beforeAuthority);
    await reset();

    phase = 'native-external-save';
    await page.evaluate(async ({ book, fixture }) => { const wi = await import('/scripts/world-info.js'); const next = structuredClone(fixture); next.entries[0].comment = 'NATIVE_EXTERNAL_TITLE'; await wi.saveWorldInfo(book, next, true); }, { book, fixture });
    // Decided (10-24): a book the full app saved meanwhile is not merged on its own. The save stops before writing and
    // asks; after 以服务器为准 the next save starts from the server's book and keeps what the full app wrote.
    const beforeExternal = attempted, paused = await save(`MERGED_${run}`), afterPause = await disk();
    check('原生另一保存后暂停发送、不写入并请用户选择', paused.settled === 'rejected' && paused.error?.code === 'WORLD_SERVER_CHANGED' && attempted === beforeExternal
        && afterPause.entries[0].comment === 'NATIVE_EXTERNAL_TITLE' && afterPause.entries[0].content === fixture.entries[0].content && hash(afterPause.extensions) === hash(fixture.extensions),
        { settled: paused.settled, error: paused.error ?? paused.result?.kind, writes: attempted - beforeExternal, comment: afterPause.entries[0]?.comment, content: afterPause.entries[0]?.content });
    const chosen = await invoke('useWorldServerAuthority', { account, name: book });
    const resumed = await invoke('saveWorldEditorEntry', { account, name: book, uid: 0, baseEntry: afterPause.entries[0], patch: { content: `MERGED_${run}` }, draftRevision: 2 });
    check('以服务器为准后再保存，保留原生标题与未知数据', chosen.result?.kind === 'ready' && resumed.result?.kind === 'confirmed' && resumed.result.entry.comment === 'NATIVE_EXTERNAL_TITLE'
        && resumed.result.entry.content === `MERGED_${run}` && hash(resumed.result.snapshot.extensions) === hash(fixture.extensions),
        { chosen: chosen.result?.kind ?? chosen.error, kind: resumed.result?.kind, error: resumed.error, comment: resumed.result?.entry?.comment, content: resumed.result?.entry?.content });
    await reset();

    phase = 'http500'; fault = '500'; const rejected = await save(`UNSAVED_${run}`), after500 = await state();
    observations.push({ phase, invocation: rejected, state: after500 });
    check('HTTP500原生resolved加OLD只能判还不知道存没存上', rejected.result?.kind === 'unconfirmed' && rejected.result?.runtimeState === 'unconfirmed' && network.at(-1)?.forwarded === false);
    check('读到OLD不会自动覆盖原生cache或解除门槛', hash(await disk()) === hash(fixture) && after500.cache.entries[0].content === `UNSAVED_${run}` && (await invoke('assertWorldRuntimeReady')).error?.code === 'WORLD_RUNTIME_UNCONFIRMED');
    check('未知结果不伪装为自动纠正成功', after500.events.length === 1 && after500.events[0].data.entries[0].content !== fixture.entries[0].content);
    const before500Recover = attempted, stillUnknown = await recover(rejected.result.operation);
    check('再次读OLD仍未知且保存发送继续阻断，无重试', stillUnknown.result?.kind === 'unconfirmed' && attempted === before500Recover && (await save('NO_RETRY')).error?.code === 'WORLD_OPERATION_PENDING' && (await invoke('assertWorldRuntimeReady')).error?.code === 'WORLD_RUNTIME_UNCONFIRMED');
    const explicit500Authority = await invoke('useWorldServerAuthority', { account, name: book });
    check('明确用酒馆里的后聊天可用但旧保存仍未知', explicit500Authority.result?.kind === 'ready' && hash((await state()).cache) === hash(fixture) && (await recover(rejected.result.operation)).result?.kind === 'unconfirmed' && attempted === before500Recover && (await invoke('assertWorldRuntimeReady')).settled === 'resolved');

    await reset(); phase = 'lost-response'; fault = 'lost'; const lost = await save(`SAVED_${run}`), lostState = await state();
    check('已落盘回包未知仍以完整服务器内容确认', lost.result?.kind === 'confirmed' && hash(lost.result.snapshot) === hash(await disk()) && hash(lostState.cache) === hash(await disk()));
    check('丢失响应补发缺失原生事件及 originalData', lostState.events.length === 1 && lostState.cache.originalData.entries[0].content === `SAVED_${run}`);
    check('未知导入字段完整保留', hash(lostState.cache.extensions) === hash(fixture.extensions) && hash(lostState.cache.entries[0].imported_unknown) === hash(fixture.entries[0].imported_unknown));

    await reset(); phase = 'unknown-create'; fault = 'lost-read';
    const unknown = await invoke('saveWorldEditorEntry', { account, name: book, patch: { comment: '只应新增一次', content: `ONE_${run}` }, draftRevision: 9 });
    check('新增已落盘但独立读回失败返回未知', unknown.result?.kind === 'unconfirmed' && unknown.result?.runtimeState === 'unconfirmed' && Object.keys((await disk()).entries).length === 2);
    check('未知时保留原生缓存但阻止轻酒馆继续生成', Object.keys((await state()).cache.entries).length === 2 && (await invoke('assertWorldRuntimeReady')).error?.code === 'WORLD_RUNTIME_UNCONFIRMED');
    const repeat = await invoke('saveWorldEditorEntry', { account, name: book, patch: { content: 'duplicate must not write' }, draftRevision: 10 });
    check('未知原操作存在时拒绝再次新增', repeat.error?.code === 'WORLD_OPERATION_PENDING' && attempted === 1);
    fault = ''; const beforeRecover = forwardedWrites, recovered = await recover(unknown.result.operation);
    check('查回完整确认不重发写入、不新增第二 UID', recovered.result?.kind === 'confirmed' && forwardedWrites === beforeRecover && Object.keys((await disk()).entries).length === 2);
    check('查回后缓存、完整文件一致并解除门槛', hash((await state()).cache) === hash(await disk()) && (await invoke('assertWorldRuntimeReady')).settled === 'resolved');

    await reset(); phase = 'postwrite-journal-failure'; await page.evaluate(() => { window.__edfix.failJournal = true; });
    const journalFailed = await invoke('saveWorldEditorEntry', { account, name: book, patch: { content: `DURABLE_${run}` }, draftRevision: 11 });
    check('写后日志故障仍给出持久原操作身份', journalFailed.error?.code === 'WORLD_JOURNAL_UNAVAILABLE' && !!journalFailed.error?.operation?.operationId);
    const noRepeat = await invoke('saveWorldEditorEntry', { account, name: book, patch: { content: 'must not repeat' }, draftRevision: 11 });
    check('写后日志故障不会令新提交绕过原操作', noRepeat.error?.code === 'WORLD_OPERATION_PENDING' && attempted === 1);
    check('实际 IDB 原记录可恢复确认', (await recover(journalFailed.error.operation)).result?.kind === 'confirmed' && attempted === 1);

    await reset(); phase = 'copy-and-empty-create';
    await page.evaluate(() => { window.__edfix.failJournal = true; });
    const copyUnknown = await invoke('copyWorldEditorBook', { account, name: book, newName: copy, expectedFingerprint: ready.actual.fingerprint });
    check('真实副本写后日志故障保留原操作及清单身份', copyUnknown.error?.code === 'WORLD_JOURNAL_UNAVAILABLE' && !!copyUnknown.error?.operation?.operationId && (await list()).some(x => x.file_id === copy));
    const copyAttempts = attempted, copyResult = await recover(copyUnknown.error.operation);
    check('副本未知操作只查回不重发native保存', copyResult.result?.kind === 'confirmed' && attempted === copyAttempts);
    const copied = await disk(copy), expectedCopy = structuredClone(fixture); expectedCopy.name = copy;
    check('副本完整保存且原书不变', copyResult.result?.kind === 'confirmed' && hash(copied) === hash(expectedCopy) && hash(await disk()) === hash(fixture));
    const empty = await invoke('createWorldEditorBook', { account, name: blank });
    check('空世界书经真实清单和内容双重确认', empty.result?.kind === 'confirmed' && (await list()).some(x => x.file_id === blank) && hash(await disk(blank)) === hash({ entries: {} }));
    check('本次所有写入均属于唯一合成书', network.every(x => allowed.has(x.name)));
    const settingsAfter = await post('/api/settings/get'); assert.ok(settingsAfter.ok()); check('原账号 settings 和全部关联文件内容不变', hash((await settingsAfter.json()).settings) === settingsHash);
    check('其余世界书清单与元信息不变', hash((await list()).filter(x => !allowed.has(x.file_id))) === hash(originalList));
    check('没有转发任何模型或远程分词调用', !forwarded.some(p => modelPath(p) || p.startsWith('/api/tokenizers/remote/')));
    check('所有请求均通过受控路径检查', routeErrors.length === 0);
} catch (error) { fatal = { phase, name: error.name, message: error.message, stack: error.stack }; console.error('FAIL', phase, error.message); }
finally {
    phase = 'cleanup'; fault = ''; await page?.close().catch(() => {});
    if (context && namesVerifiedUnique) try {
        for (const row of await list()) if (allowed.has(row.file_id)) assert.ok((await post('/api/worldinfo/delete', { name: row.file_id })).ok());
        const restored = await list(); cleanup = hash(restored) === hash(originalList); check('全部唯一合成书已删除，原清单完整恢复', cleanup);
        const r = await post('/api/settings/get'); assert.ok(r.ok()); check('清理后原 settings 仍完全一致', hash((await r.json()).settings) === settingsHash);
    } catch (error) { fatal ||= { phase, message: error.message }; cleanup = false; }
    await browser?.close();
    const result = { run, base, account, checks, passed: checks.filter(x => x.pass).length, failed: checks.filter(x => !x.pass).length, fatal, cleanup,
        forwardedWrites, network, blocked, observations, pageErrors, routeErrors, forwarded, moduleHashes: Object.fromEntries([...modules].map(([file, source]) => [file, createHash('sha256').update(source).digest('hex')])),
        unverified: ['Root bridge.js integration and all generation entry-point guards', 'Other third-party listeners can retain effects of the native erroneous HTTP500 event', 'Mobile soft keyboard, real IME and novice usability', 'Cross-device atomic CAS: native server has none'] };
    await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, failed: result.failed, cleanup, pageErrors: pageErrors.length, fatal: fatal?.message, output }));
    process.exitCode = fatal || result.failed || !cleanup || pageErrors.length || routeErrors.length ? 1 : 0;
}
