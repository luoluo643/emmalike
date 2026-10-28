// Real ST 1.19 + product bridge + real IndexedDB; browser model fixtures, never a provider call.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [base = 'http://127.0.0.1:8032'] = process.argv.slice(2), origin = new URL(base);
assert.equal(origin.origin, 'http://127.0.0.1:8032', 'Only the isolated pure ST instance is allowed');
const output = path.resolve(process.env.TEST_OUTPUT || '/tmp/tavern-episode-core-evidence');
await mkdir(output, { recursive: true });
const run = `tl-ep-core-${Date.now()}-${randomUUID().slice(0, 6)}`, rootFile = `${run}-root`, account = 'default-user';
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value; }
const checks = [], requests = [], saves = [], errors = [], blocked = [];
let browser, context, page, avatar, token, fatal, cleanup = false, phase = 'setup', saveFault = '', dropCreate = false;
const ownFile = file => typeof file === 'string' && (file.startsWith(run) || /^tl-episode-[0-9a-f-]{36}$/.test(file));
const check = (name, ok, detail) => { checks.push({ name, pass: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name); assert.ok(ok, name); };
const post = (endpoint, data) => {
    assert.ok(['/api/users/login', '/api/settings/get', '/api/extensions/discover', '/api/characters/all', '/api/characters/get', '/api/characters/delete', '/api/characters/chats', '/api/chats/save', '/api/chats/get', '/api/chats/rename', '/api/chats/delete'].includes(endpoint));
    if (data.avatar_url) assert.equal(data.avatar_url, avatar);
    if (data.file_name) assert.ok(ownFile(data.file_name));
    return context.request.post(base + endpoint, { data, headers: { 'X-CSRF-Token': token }, maxRedirects: 0 });
};
const read = async file => { const r = await post('/api/chats/get', { avatar_url: avatar, file_name: file }); assert.ok(r.ok()); return r.json(); };
const native = (fn, arg) => page.evaluate(([code, arg]) => {
    const w = document.querySelector('iframe.engine')?.contentWindow;
    if (!w?.TavernLiteBridge) throw new Error('No product bridge');
    return new w.Function('w', 'arg', `return (${code})(w,arg)`)(w, arg);
}, [fn.toString(), arg]);
async function open(file) { return native((w, { avatar, file }) => w.TavernLiteBridge.openChat(avatar, file), { avatar, file }); }
async function baseline(file) {
    // Test-fixture setup only, before product operation: observe natural native initialization, then explicitly save it once.
    return native(async (w, file) => {
        const st = await import('/script.js'), ext = await import('/scripts/extensions.js');
        const c = w.SillyTavern.getContext(); if (c.getCurrentChatId() !== file) throw new Error('Unexpected fixture target');
        await new Promise(r => setTimeout(r, 1300));
        ext.cancelDebouncedMetadataSave(); st.cancelDebouncedChatSave(); await st.saveChatConditional();
        return [{ user_name: 'unused', character_name: 'unused', chat_metadata: JSON.parse(JSON.stringify(c.chatMetadata)) }, ...JSON.parse(JSON.stringify(c.chat))];
    }, file);
}
function payload(req) {
    const bytes = req.postDataBuffer(); if (!bytes) return {};
    return JSON.parse((req.headers()['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString('utf8'));
}
try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
    token = (await (await context.request.get(base + '/csrf-token')).json()).token;
    assert.ok((await post('/api/users/login', { handle: account, password: 'test1234' })).ok());
    const actual = await (await context.request.get(base + '/api/users/me')).json(); assert.equal(actual.handle, account);
    const version = await (await context.request.get(base + '/version')).json(); assert.equal(version.pkgVersion, process.env.EXPECT_ST_VERSION ?? '1.19.0');
    const installed = await (await context.request.get(base + '/api/extensions/discover')).json();
    const third = installed.filter(x => ['local', 'global'].includes(x.type));
    check('真实隔离安装仅有轻端第三方扩展', third.length === 1 && third[0].name === 'third-party/emmalike', third);
    const health = await context.request.post(base + '/api/plugins/tavern-lite/health', { data: {}, headers: { 'X-CSRF-Token': token } });
    check('纯净测试没有可选个人记录插件', health.status() === 404);
    const rawSettings = await (await post('/api/settings/get', {})).json(), settingsHash = hash(rawSettings.settings);
    const created = await context.request.post(base + '/api/characters/create', { multipart: { ch_name: run, description: 'Shared static card: a cafe owner.', first_mes: `GREETING_${run}`, personality: '', scenario: '', mes_example: '', creator_notes: run, system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' }, headers: { 'X-CSRF-Token': token } });
    assert.ok(created.ok()); avatar = (await created.text()).trim(); assert.ok(avatar.startsWith(run) && avatar.endsWith('.png'));
    const msg = (mes, is_user = false) => ({ name: is_user ? 'Test author' : run, is_user, is_system: false, mes, send_date: new Date().toISOString(), extra: {} });
    const root = [{ user_name: 'unused', character_name: 'unused', chat_metadata: { integrity: randomUUID(), tainted: true, lastInContextMessageId: 0, variables: { EP_PARENT_STATE: run }, note_prompt: `PARENT_NOTE_${run}`, note_interval: 1, note_depth: 4, note_position: 1, note_role: 0, timedWorldInfo: { sticky: {}, cooldown: {} } } },
        msg(`PARENT_PLOT_${run}`), msg(`PARENT_REQUEST_${run}`, true), msg(`PARENT_REPLY_${run}`)];
    Object.assign(root[3], { swipes: [root[3].mes, `PARENT_ALT_${run}`], swipe_id: 0, swipe_info: [{ extra: {} }, { extra: {} }] });
    root[3].extra.memory = `PARENT_SUMMARY_${run}`;
    assert.ok((await post('/api/chats/save', { avatar_url: avatar, file_name: rootFile, chat: root, force: false })).ok());
    const readPaths = new Set(['/api/plugins/tavern-lite-save/probe', '/api/extensions/version', '/api/ping', '/api/characters/all', '/api/characters/get', '/api/characters/chats', '/api/chats/get', '/api/chats/recent', '/api/groups/all', '/api/backgrounds/all', '/api/backgrounds/folders', '/api/image-metadata/all', '/api/avatars/get', '/api/worldinfo/get', '/api/worldinfo/all', '/api/secrets/read', '/api/secrets/find', '/api/extensions/discover', '/api/extensions/manifest', '/api/users/list', '/api/assets/get']);
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), p = url.pathname;
        if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
        if (url.origin !== base) { blocked.push({ phase, path: url.origin + p }); return route.abort(); }
        if (p === '/api/settings/get') {
            const response = await route.fetch(), data = await response.json(), settings = JSON.parse(data.settings);
            settings.active_character = null; settings.active_group = null; settings.firstRun = false; settings.main_api = 'openai';
            settings.oai_settings = { ...settings.oai_settings, chat_completion_source: 'custom', custom_url: 'http://episode-mock.invalid/v1', custom_model: 'episode-mock', stream_openai: false, openai_max_context: 8192 };
            if (settings.extension_settings?.connectionManager) settings.extension_settings.connectionManager = { ...settings.extension_settings.connectionManager, profiles: [], selectedProfile: '' };
            data.settings = JSON.stringify(settings); return route.fulfill({ response, json: data });
        }
        if (p === '/api/settings/save') return route.fulfill({ status: 200, json: { result: 'ok' } });
        if (p === '/api/backends/chat-completions/status') return route.fulfill({ status: 200, json: { data: [{ id: 'episode-mock' }] } });
        if (p === '/api/backends/chat-completions/generate') {
            const body = payload(request); requests.push({ phase, body });
            return route.fulfill({ status: 200, json: { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `CHILD_GENERATED_${run}_${requests.length}` } }] } });
        }
        if (/^\/api\/(backends|horde|novelai|openai|kobold|sd|embeddings|vectors)(\/|$)/.test(p) || /^\/api\/.*(?:generate|completion)/i.test(p)) {
            if (/\/horde\/(text-models|text-workers|sd-models|sd-samplers)$/.test(p)) return route.fulfill({ json: [] });
            return route.fulfill({ status: 503, json: { error: 'Test blocks external model services' } });
        }
        if (p === '/api/chats/save') {
            const data = payload(request);
            assert.equal(data.avatar_url, avatar); assert.ok(ownFile(data.file_name)); assert.notEqual(data.force, true);
            if (saveFault && data.file_name !== rootFile) { saves.push({ phase, file: data.file_name, injected: saveFault }); return route.fulfill({ status: 500, json: { error: 'injected-save-failure' } }); }
            const response = await route.fetch(), body = await response.json();
            saves.push({ phase, file: data.file_name, fingerprint: hash(data.chat), status: response.status(), body });
            if (dropCreate && data.file_name !== rootFile) { dropCreate = false; return route.abort('failed'); }
            return route.fulfill({ response, json: body });
        }
        if (!p.startsWith('/api/') || ['GET', 'HEAD'].includes(request.method()) || readPaths.has(p) || p.startsWith('/api/tokenizers/')) return route.continue();
        // Native opening updates only the disposable character's last-chat pointer.
        if (p === '/api/characters/edit-attribute') { const data = payload(request); if (data.avatar_url === avatar || data.avatar === avatar) return route.continue(); }
        blocked.push({ phase, path: p }); return route.fulfill({ status: 409, json: { error: 'Only owned fixture writes are allowed' } });
    });
    page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', e => errors.push({ phase, message: e.message }));
    const app = base + '/scripts/extensions/third-party/emmalike/app/';
    await page.goto(app + '#' + new URLSearchParams({ chat: avatar, file: rootFile }));
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    const baseSnapshot = await baseline(rootFile); assert.equal(hash(await read(rootFile)), hash(baseSnapshot));
    check('当前原生内存与完整落盘来源一致', true);
    const status = await native(w => w.TavernLiteBridge.episodeStatus());
    check('纯净配置通过增强能力门控', status.verified && status.enabled, status);
    const prepare = async mode => native((w, input) => w.TavernLiteBridge.prepareEpisode({ ...input, assertDraft: () => true }), { account, scope: { avatar, file: rootFile }, text: `AUTHOR_${mode}_${run}`, title: mode === 'continued' ? '雨中的番外' : '新的相遇', kind: 'side', contextMode: mode, draftRevision: 1 });
    phase = 'continued-create';
    const continued = await prepare('continued');
    check('接续创建已读回并等待用户确认，没有模型请求', continued.operation.stage === 'awaiting-review' && requests.length === 0, { target: continued.target, stage: continued.operation.stage });
    const childInitial = await read(continued.target.file);
    check('接续复制全部正文与候选', hash(childInitial.slice(1)) === hash(baseSnapshot.slice(1)));
    check('首次header包含独立逻辑与原生身份及账号', childInitial[0].chat_metadata.tavern_lite_episode.ownerAccount === account && childInitial[0].chat_metadata.integrity !== baseSnapshot[0].chat_metadata.integrity);
    check('HTTP创建不切换正文且父文件全字段不变', (await native(w => w.TavernLiteBridge.currentChat())).file === rootFile && hash(await read(rootFile)) === hash(baseSnapshot));
    phase = 'continued-generate';
    const result = await native(async (w, review) => { const stages = [], input = { account: review.operation.account, operationId: review.operation.operationId, reviewReceipt: review.reviewReceipt, onState: value => stages.push(value.stage) }; const first = w.TavernLiteBridge.sendEpisode(input), second = w.TavernLiteBridge.sendEpisode(input); return { result: await first, stages, sameJob: first === second }; }, continued);
    check('发送仅调用一次模型并完整保存确认', result.result.kind === 'confirmed' && requests.length === 1, result.stages);
    check('双击同一发送操作共用任务，没有第二次原生提交', result.sameJob && requests.length === 1);
    check('接续请求包含父剧情和原作者要求', JSON.stringify(requests[0].body).includes(`PARENT_PLOT_${run}`) && JSON.stringify(requests[0].body).includes(`AUTHOR_continued_${run}`));
    check('子线生成没有改变父正文候选或状态', hash(await read(rootFile)) === hash(baseSnapshot));
    await open(rootFile);
    phase = 'fresh-create';
    const fresh = await prepare('fresh'), freshInitial = await read(fresh.target.file);
    check('不复制模式首次文件无父消息或派生状态', freshInitial.length === 1 && !JSON.stringify(freshInitial).includes(`PARENT_NOTE_${run}`) && !JSON.stringify(freshInitial).includes(`PARENT_SUMMARY_${run}`));
    phase = 'fresh-generate';
    const freshResult = await native((w, r) => w.TavernLiteBridge.sendEpisode({ account: r.operation.account, operationId: r.operation.operationId, reviewReceipt: r.reviewReceipt }), fresh);
    check('不复制模式在真正独立子线完成生成保存', freshResult.kind === 'confirmed' && requests.length === 2);
    const freshPrompt = JSON.stringify(requests.at(-1).body);
    check('新线请求无父派生剧情摘要作者注，保留基础开场', !freshPrompt.includes(`PARENT_PLOT_${run}`) && !freshPrompt.includes(`PARENT_SUMMARY_${run}`) && !freshPrompt.includes(`PARENT_NOTE_${run}`) && freshPrompt.includes(`GREETING_${run}`));
    check('兄弟线生成没有进入正文或另一条线', hash(await read(rootFile)) === hash(baseSnapshot) && !JSON.stringify(await read(continued.target.file)).includes(`CHILD_GENERATED_${run}_2`));
    phase = 'continue-existing';
    const existing = await native((w, input) => w.TavernLiteBridge.prepareEpisodeContinuation({ ...input, assertDraft: () => true }), { account, scope: { avatar, file: fresh.target.file }, target: { avatar, file: fresh.target.file }, text: `CONTINUE_REQUEST_${run}`, draftRevision: 2 });
    check('续写沿用创建身份而发送operation独立', existing.operation.target.creationOperationId === fresh.operation.operationId && existing.operation.operationId !== fresh.operation.operationId);
    const continuedAgain = await native((w, r) => w.TavernLiteBridge.sendEpisode({ account: r.operation.account, operationId: r.operation.operationId, reviewReceipt: r.reviewReceipt }), existing);
    check('续写只生成一次，不重新复制正文', continuedAgain.kind === 'confirmed' && requests.length === 3 && !JSON.stringify(requests.at(-1).body).includes(`PARENT_PLOT_${run}`));
    phase = 'storage-failure'; await open(rootFile);
    const beforeQuota = saves.length;
    const storageFailure = await native(async (w, input) => {
        const proto = w.IDBDatabase.prototype, original = proto.transaction;
        proto.transaction = function(stores, mode, ...rest) { if (mode === 'readwrite') throw new w.DOMException('Injected quota failure', 'QuotaExceededError'); return original.call(this, stores, mode, ...rest); };
        try { await w.TavernLiteBridge.prepareEpisode({ ...input, assertDraft: () => true }); return null; }
        catch (e) { return e.code; } finally { proto.transaction = original; }
    }, { account, scope: { avatar, file: rootFile }, text: `QUOTA_REQUEST_${run}`, title: 'quota', kind: 'side', contextMode: 'fresh', draftRevision: 3 });
    check('真实IndexedDB事务配额失败时不写子线或提交模型', storageFailure === 'JOURNAL_UNAVAILABLE' && saves.length === beforeQuota && requests.length === 3);
    phase = 'cancel-before-submit';
    const cancelledPreparation = await prepare('fresh');
    const cancellation = await native(async (w, r) => { const promise = w.TavernLiteBridge.sendEpisode({ account: r.operation.account, operationId: r.operation.operationId, reviewReceipt: r.reviewReceipt }); const cancelled = promise.cancel(); try { await promise; return { cancelled }; } catch (e) { return { cancelled, code: e.code }; } }, cancelledPreparation);
    check('排队前取消被持久记录且没有原生发送', cancellation.cancelled && cancellation.code === 'CANCELLED' && requests.length === 3);
    phase = 'save-failure';
    const failing = await prepare('fresh'); saveFault = 'http-500';
    const failedSave = await native((w, r) => w.TavernLiteBridge.sendEpisode({ account: r.operation.account, operationId: r.operation.operationId, reviewReceipt: r.reviewReceipt }), failing);
    check('原生保存500保留未确认状态而非误报成功', failedSave.kind === 'unconfirmed' && failedSave.operation.stage === 'save-unconfirmed' && requests.length === 4);
    const leaving = await native(async w => { try { await w.TavernLiteBridge.episodeNavigationGuard(); return { allowed: true }; } catch (e) { return { allowed: false, code: e.code }; } });
    check('未确认子线不能切换丢失当前内存', !leaving.allowed && ['SOURCE_UNCONFIRMED', 'SAVE_UNCONFIRMED'].includes(leaving.code), leaving);
    saveFault = ''; phase = 'refresh-recovery';
    const savesBeforeRefresh = saves.length;
    await page.reload();
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    const pendingAfterRefresh = await native(w => w.TavernLiteBridge.unfinishedEpisodes());
    check('真实IndexedDB刷新后保留完整恢复快照且不重新生成', pendingAfterRefresh.some(op => op.operationId === failing.operation.operationId && op.saveIntent?.expectedFingerprint) && requests.length === 4);
    check('刷新未再次写入失败子线', !saves.slice(savesBeforeRefresh).some(s => s.file === failing.target.file));
    const fixedSave = await native((w, op) => w.TavernLiteBridge.confirmEpisodeSave({ account: op.account, operationId: op.operationId }), failing.operation);
    check('显式恢复只补保存一次并读回完整结果', fixedSave.kind === 'confirmed' && requests.length === 4 && JSON.stringify(await read(failing.target.file)).includes(`CHILD_GENERATED_${run}_4`));
    phase = 'lost-create'; await open(rootFile); dropCreate = true;
    const uncertain = await prepare('fresh'), countBeforeRecovery = saves.filter(s => s.file === uncertain.operation.target.locator.file).length;
    check('创建返回丢失标记未确认，不调用模型', uncertain.operation.stage === 'create-unconfirmed' && requests.length === 4);
    const recovered = await native((w, op) => w.TavernLiteBridge.recoverEpisode({ account: op.account, operationId: op.operationId }), uncertain.operation);
    check('按已落盘操作身份查回，无第二次创建', ['recovered', 'created'].includes(recovered.kind) && saves.filter(s => s.file === uncertain.operation.target.locator.file).length === countBeforeRecovery && requests.length === 4);
    const rereview = await native((w, op) => w.TavernLiteBridge.reviewRecoveredEpisode({ account: op.account, operationId: op.operationId, assertDraft: () => true }), uncertain.operation);
    check('显式重新查看仅返回目的地预览，不创建或调用模型', !!rereview.reviewReceipt && rereview.operation.stage === 'awaiting-review' && saves.filter(s => s.file === uncertain.operation.target.locator.file).length === countBeforeRecovery && requests.length === 4);
    phase = 'disabled-recovery';
    await native(w => w.TavernLiteBridge.setEpisodeEnabled(false));
    const unfinished = await native(w => w.TavernLiteBridge.unfinishedEpisodes());
    check('关闭总开关仍保留恢复记录', unfinished.some(op => op.operationId === uncertain.operation.operationId));
    await native(w => w.TavernLiteBridge.setEpisodeEnabled(true));
    check('所有测试中父正文全字段保持不变', hash(await read(rootFile)) === hash(baseSnapshot));
    const settingsAfter = await (await post('/api/settings/get', {})).json();
    check('隔离账号原设置未被测试改写', hash(settingsAfter.settings) === settingsHash);
    await page.screenshot({ path: path.join(output, 'episode-core-final.png') });
} catch (error) {
    fatal = { phase, message: error.message, stack: error.stack }; console.error('FAIL', phase, error.stack); process.exitCode = 1;
    await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
    await page?.close().catch(() => {});
    if (avatar?.startsWith(run) && context) {
        try {
            const current = await (await post('/api/characters/get', { avatar_url: avatar })).json(); assert.equal(current.name, run);
            assert.ok((await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true })).ok());
            cleanup = (await post('/api/characters/get', { avatar_url: avatar })).status() === 404;
        } catch (error) { fatal ||= { phase: 'cleanup', message: error.message }; }
    }
    await browser?.close().catch(() => {});
    const report = { run, checks, passed: !fatal && cleanup && checks.every(x => x.pass), fatal, cleanup, errors, blocked,
        limits: ['Synthetic provider responses; no actual model quality claim.', 'This core bridge test does not replace episode UI, cross-account, real-plugin or physical-phone acceptance.'] };
    await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    await writeFile(path.join(output, 'requests-and-saves.json'), JSON.stringify({ requests, saves }, null, 2));
    console.log(JSON.stringify({ output, passed: report.passed, checks: checks.length, cleanup }));
    if (!report.passed) process.exitCode = 1;
}
