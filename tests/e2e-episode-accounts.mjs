// Native cookie/account race characterization on the disposable pure ST instance only.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const base = 'http://127.0.0.1:8032', app = base + '/scripts/extensions/third-party/emmalike/app/';
const out = process.env.TEST_OUTPUT || '/tmp/tavern-improvements/episode-account-evidence';
await mkdir(out, { recursive: true });
const run = `tl-ep-accounts-${Date.now()}-${randomUUID().slice(0, 6)}`, rootFile = run + '-root', rootIntegrity = randomUUID();
const accounts = ['a', 'b'].map(suffix => ({ handle: `${run}-${suffix}`, password: randomUUID() + randomUUID() }));
const created = [], checks = [], errors = [], writes = [];
let browser, admin, context, page, adminToken, token, avatar, fatal, cleanup = false;
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
const hash = x => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const check = (name, ok, detail) => { checks.push({ name, pass: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name); assert.ok(ok, name); };
const api = (c, t, endpoint, body) => c.request.post(base + endpoint, { data: body, headers: { 'X-CSRF-Token': t } });
const login = async (c, user) => { const t = (await (await c.request.get(base + '/csrf-token')).json()).token; assert.ok((await api(c, t, '/api/users/login', user)).ok()); return t; };
const native = (fn, arg) => page.evaluate(([code, data]) => { const w = document.querySelector('iframe.engine')?.contentWindow; if (!w?.TavernLiteBridge) throw Error('Engine absent'); return new w.Function('w', 'data', `return (${code})(w,data)`)(w, data); }, [fn.toString(), arg]);
const read = async (c, t, file) => { const r = await api(c, t, '/api/chats/get', { avatar_url: avatar, file_name: file }); assert.ok(r.ok()); return r.json(); };
try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    admin = await browser.newContext({ serviceWorkers: 'block' });
    adminToken = await login(admin, { handle: 'default-user', password: 'test1234' });
    assert.equal((await (await admin.request.get(base + '/version')).json()).pkgVersion, process.env.EXPECT_ST_VERSION ?? '1.19.0');
    for (const user of accounts) {
        const r = await api(admin, adminToken, '/api/users/create', { ...user, name: 'Isolated episode account test', admin: false });
        assert.ok(r.ok()); assert.equal((await r.json()).handle, user.handle); created.push(user.handle);
        await writeFile(path.join(out, 'cleanup-state.json'), JSON.stringify({ run, created }), { mode: 0o600 });
    }
    check('仅建立两个唯一非管理员隔离测试账号', created.length === 2);
    context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    token = await login(context, accounts[0]);
    const settingsBefore = (await (await api(context, token, '/api/settings/get', {})).json()).settings;
    for (const user of accounts) {
        await login(context, user);
        const r = await context.request.post(base + '/api/characters/create', { multipart: { ch_name: run, description: 'Static test card', first_mes: 'Hello', creator_notes: run }, headers: { 'X-CSRF-Token': token } });
        assert.ok(r.ok()); const actual = (await r.text()).trim(); assert.equal(actual, run + '.png'); avatar = actual;
        assert.ok((await api(context, token, '/api/chats/save', { avatar_url: avatar, file_name: rootFile, force: false, chat: [{ user_name: 'unused', character_name: 'unused', chat_metadata: { integrity: rootIntegrity } }, { name: run, is_user: false, is_system: false, mes: 'Fixture parent', send_date: '2026-01-01T00:00:00Z', extra: {} }] })).ok());
    }
    await login(context, accounts[0]);
    await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url()), p = url.pathname;
        if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
        if (url.origin !== base) return route.abort();
        if (p === '/api/settings/get') {
            const response = await route.fetch(), data = await response.json(), settings = JSON.parse(data.settings);
            settings.firstRun = false; settings.active_character = null; settings.active_group = null; settings.main_api = 'openai';
            settings.oai_settings = { ...settings.oai_settings, chat_completion_source: 'custom', custom_url: 'http://accounts-fixture.invalid', custom_model: 'fixture', openai_max_context: 8192 };
            settings.extension_settings.connectionManager = { profiles: [], selectedProfile: '' };
            data.settings = JSON.stringify(settings); return route.fulfill({ response, json: data });
        }
        if (p === '/api/settings/save' || p === '/api/quick-replies/save') return route.fulfill({ json: { result: 'ok' } });
        if (p === '/api/backends/chat-completions/status') return route.fulfill({ json: { data: [{ id: 'fixture' }] } });
        if (/generate|completion/i.test(p) || /^\/api\/(?:backends|horde|novelai|sd|embeddings|vectors)\//.test(p)) return route.fulfill({ status: 503, json: { error: 'No models in account test' } });
        if (p === '/api/chats/save') {
            const body = req.postDataJSON();
            if (body.avatar_url !== avatar || !(body.file_name?.startsWith(run) || /^tl-episode-[0-9a-f-]{36}$/.test(body.file_name)) || body.force === true) {
                errors.push('Refused unexpected chat write'); return route.fulfill({ status: 409, json: { error: 'Only disposable fixture writes are allowed' } });
            }
            writes.push({ file: body.file_name });
        }
        return route.continue();
    });
    page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(app + '#' + new URLSearchParams({ chat: avatar, file: rootFile }));
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    await native(async w => { const st = await import('/script.js'), ext = await import('/scripts/extensions.js'); await new Promise(r => setTimeout(r, 1300)); ext.cancelDebouncedMetadataSave(); st.cancelDebouncedChatSave(); await st.saveChatConditional(); });
    const aBefore = await read(context, token, rootFile);
    // Identical physical names/content in B deliberately maximize the race; only the disposable B root is overwritten.
    await login(context, accounts[1]); assert.ok((await api(context, token, '/api/chats/save', { avatar_url: avatar, file_name: rootFile, chat: aBefore, force: false })).ok()); await login(context, accounts[0]);
    const prepared = await native(async (w, input) => {
        const original = w.fetch.bind(w); let injected = false;
        w.fetch = async (url, options) => {
            if (!injected && url === '/api/chats/save' && JSON.parse(options.body).file_name !== input.file) {
                injected = true;
                const response = await original('/api/users/login', { method: 'POST', headers: options.headers, credentials: 'same-origin', body: JSON.stringify(input.second) });
                if (!response.ok) throw Error('Race login failed');
            }
            return original(url, options);
        };
        try { return await w.TavernLiteBridge.prepareEpisode({ account: input.account, scope: { avatar: input.avatar, file: input.file }, text: 'Account race fixture', title: 'Race', kind: 'side', contextMode: 'fresh', draftRevision: 1, assertDraft: () => true }); }
        finally { w.fetch = original; }
    }, { account: accounts[0].handle, avatar, file: rootFile, second: accounts[1] });
    check('最后账号检查后切换Cookie，创建结果保持未确认', prepared.kind === 'unconfirmed' && prepared.operation.stage === 'create-unconfirmed' && prepared.reason === 'ACCOUNT_CHANGED');
    check('未知提交明确说明跨账号内容风险及人工核对', /可能写进了另一个账号/.test(prepared.operation.error?.message || '') && /登录那个账号看一下/.test(prepared.operation.error?.message || ''));
    check('原生login确实切换同一浏览器当前账号', (await (await context.request.get(base + '/api/users/me')).json()).handle === accounts[1].handle);
    const orphan = await read(context, token, prepared.operation.target.locator.file);
    check('原生无账号前置条件，竞态可写入B但header保持A归属', orphan?.[0]?.chat_metadata?.tavern_lite_episode?.ownerAccount === accounts[0].handle);
    check('B的原正文未被改变', hash(await read(context, token, rootFile)) === hash(aBefore));
    const rejected = await native(async w => { try { await w.TavernLiteBridge.unfinishedEpisodes(); return null; } catch (e) { return e.code; } });
    check('下一次排队操作发现会话变化并拒绝', rejected === 'ACCOUNT_CHANGED');
    await login(context, accounts[0]);
    check('A的原正文未被改变', hash(await read(context, token, rootFile)) === hash(aBefore));
    const remainsFrozen = await native(async w => { try { await w.TavernLiteBridge.unfinishedEpisodes(); return null; } catch (e) { return e.code; } });
    check('A→B→A不会复活已冻结的旧桥接', remainsFrozen === 'ACCOUNT_CHANGED');
    await page.reload(); await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    const recovery = await native((w, op) => w.TavernLiteBridge.recoverEpisode({ account: op.account, operationId: op.operationId }), prepared.operation);
    check('回到A的恢复只查A，不搜索或清理B文件', recovery.kind === 'unconfirmed' && recovery.reason === 'not-found');
    await page.evaluate(() => { const c = new BroadcastChannel('tavern-lite-session'); c.postMessage({ type: 'session-changed' }); c.close(); });
    await page.waitForTimeout(50);
    const announced = await native(async w => { try { await w.TavernLiteBridge.unfinishedEpisodes(); return null; } catch (e) { return e.code; } });
    check('轻端跨页账号通知立即冻结旧桥接', announced === 'ACCOUNT_CHANGED');
    check('A账号设置未被浏览器测试改写', (await (await api(context, token, '/api/settings/get', {})).json()).settings === settingsBefore);
    await login(context, accounts[1]);
    // Start a new document: the old A document correctly rejects hash-only navigation.
    await page.goto('about:blank');
    await page.goto(app + '#' + new URLSearchParams({ chat: avatar, file: prepared.operation.target.locator.file }));
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    const bGraph = await native((w, avatar) => w.TavernLiteBridge.episodeIndex(avatar), avatar);
    check('B侧真实索引将ownerA文件列为异常，不挂到B同头像正文', bGraph.invalid.some(x => x.locator.file === prepared.operation.target.locator.file && x.identityStatus === 'foreign-owner') && !bGraph.nodes.some(x => x.locator.file === prepared.operation.target.locator.file));
    await page.waitForFunction(() => document.querySelector('.tl-episode-bar')?.textContent?.includes('来源没确认'), null, { timeout: 15000 });
    check('B侧阅读界面明确显示来源没确认', await page.locator('.tl-episode-bar').textContent().then(t => t.includes('来源没确认')));
} catch (error) {
    fatal = { message: error.message, stack: error.stack };
    if (page && !page.isClosed()) {
        fatal.visibleIdentity = await page.locator('.tl-episode-bar').textContent().catch(() => null);
        await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    }
    console.error('FAIL', error.stack); process.exitCode = 1;
}
finally {
    await page?.close().catch(() => {}); await context?.close().catch(() => {});
    if (admin) {
        cleanup = true;
        for (const handle of created) {
            if (!accounts.some(x => x.handle === handle) || !handle.startsWith(run + '-')) throw Error('Refusing unrelated account cleanup');
            try { assert.ok((await api(admin, adminToken, '/api/users/delete', { handle, purge: true })).ok()); }
            catch (e) { cleanup = false; fatal ||= { message: 'Disposable account cleanup failed' }; }
        }
    }
    await browser?.close().catch(() => {});
    const report = { run, passed: !fatal && cleanup && checks.every(x => x.pass), checks, fatal, errors, cleanup, writes,
        limits: ['Native account cookies have no atomic expected-account precondition. External native login during a write is unsupported; this test proves the boundary, not atomic prevention.', 'Only synthetic disposable accounts and files were used.'] };
    await writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, checks: checks.length, cleanup, out })); if (!report.passed) process.exitCode = 1;
}
