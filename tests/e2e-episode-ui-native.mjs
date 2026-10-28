// Real ST + built Reader/episode UI. Browser responses simulate the model; no real provider request.
// Run only against the isolated pure ST instance, after the parent supplies the final build/test window.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [base = 'http://127.0.0.1:8032'] = process.argv.slice(2);
assert.equal(base, 'http://127.0.0.1:8032', 'Only the isolated pure ST instance is allowed');
const output = path.resolve(process.env.TEST_OUTPUT || '/tmp/tavern-episode-ui-native-evidence');
await mkdir(output, { recursive: true });
const run = `tl-ep-ui-${Date.now()}-${randomUUID().slice(0, 6)}`;
const account = 'default-user', rootFile = `${run}-root`, title = `灯塔番外 ${run}`;
const requestText = `[番外] 去海边看灯塔，记下开场要求 ${run}`;
const childDraft = `子线自己保存的未发送草稿 ${run}`, rootDraft = `正文自己保存的未发送草稿 ${run}`;
const checks = [], requests = [], saves = [], errors = [], consoleErrors = [], blocked = [], screenshots = [], nativeObservationEvidence = [];
const fixtureIntercepts = { settingsSave: 0, quickReplySave: 0, statsUpdate: 0 }, ownedCharacterEdits = [];
let browser, context, page, token, avatar, settingsHash, fatal, cleanup = false, phase = 'setup';
let childFile, readingBefore, baseSnapshot, rootAfterOrdinary, buildAssets = [];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const ownFile = file => typeof file === 'string' && (file.startsWith(run) || /^tl-episode-[0-9a-f-]{36}$/.test(file));
const storageKey = (kind, file) => `tavern-lite:v2:${kind}:${JSON.stringify([account, avatar, file])}`;
const record = (name, ok, detail) => { checks.push({ name, pass: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name); };
const check = (name, ok, detail) => { record(name, ok, detail); assert.ok(ok, name); };
function payload(request) {
    const bytes = request.postDataBuffer();
    if (!bytes) return {};
    return JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString('utf8'));
}
const post = (endpoint, data = {}) => {
    assert.ok(['/api/users/login', '/api/settings/get', '/api/characters/get', '/api/characters/delete', '/api/characters/chats', '/api/chats/save', '/api/chats/get'].includes(endpoint));
    if (data.avatar_url) assert.equal(data.avatar_url, avatar);
    if (data.file_name) assert.ok(ownFile(data.file_name));
    return context.request.post(base + endpoint, { data, headers: { 'X-CSRF-Token': token }, maxRedirects: 0 });
};
const read = async file => { const response = await post('/api/chats/get', { avatar_url: avatar, file_name: file }); assert.ok(response.ok()); return response.json(); };
const native = (fn, arg) => page.evaluate(([code, value]) => {
    const w = document.querySelector('iframe.engine')?.contentWindow;
    if (!w?.TavernLiteBridge) throw new Error('Product bridge is not ready');
    return new w.Function('w', 'arg', `return (${code})(w,arg)`)(w, value);
}, [fn.toString(), arg]);
// Native access is restricted to setup/read-only observations. All tested episode operations use visible UI.
async function observeNativeStage(label, assertEarly = false) {
    const evidence = await native(w => {
        const state = w.TavernLiteNativeSettle, snapshot = state?.observer?.snapshot?.();
        const status = w.TavernLiteBridge.episodeStatus();
        // Policy keys are the audited fixed capability/scope paths. Retain only
        // numeric counts and booleans as 0/1; never persist settings string values.
        const counts = {}, omitted = { strings: 0, other: 0 };
        const visit = (value, prefix) => {
            if (typeof value === 'boolean') counts[prefix] = Number(value);
            else if (typeof value === 'number' && Number.isFinite(value)) counts[prefix] = value;
            else if (value && typeof value === 'object' && !Array.isArray(value)) {
                for (const [key, child] of Object.entries(value)) visit(child, prefix ? `${prefix}.${key}` : key);
            } else if (typeof value === 'string') omitted.strings++;
            else omitted.other++;
        };
        visit(status.nativeObservations || {}, '');
        return {
            bootstrap: { present: !!state, sameDocument: state?.document === w.document, earlyVerified: state?.earlyVerified === true,
                errorCode: state?.errorCode ?? null, phase: state ? { appInitializedAlready: state.phase?.appInitializedAlready,
                    appReadyAlready: state.phase?.appReadyAlready, hasChatId: state.phase?.hasChatId,
                    messageCount: state.phase?.messageCount, characterCount: state.phase?.characterCount } : null,
                observer: snapshot ? { supported: snapshot.supported, inFlight: snapshot.inFlight, runs: snapshot.runs,
                    waitingSettings: snapshot.waitingSettings, failure: snapshot.failure, serial: snapshot.serial } : null },
            gate: { enabled: status.enabled, verified: status.verified, reasonCount: status.reasons?.length ?? 0 },
            nativePolicyObservationCounts: counts, omittedValueCounts: omitted,
        };
    });
    nativeObservationEvidence.push({ phase, label, ...evidence });
    if (assertEarly) {
        const bootstrap = evidence.bootstrap, atInstall = bootstrap.phase;
        check(`${label}：观察器在首个聊天与角色载入前已安装`, bootstrap.present && bootstrap.sameDocument
            && bootstrap.earlyVerified && bootstrap.errorCode === null && bootstrap.observer?.supported
            && atInstall?.hasChatId === false && atInstall.messageCount === 0 && atInstall.characterCount === 0
            && atInstall.appInitializedAlready === false && atInstall.appReadyAlready === false, bootstrap);
    }
    assert.ok(Object.values(evidence.nativePolicyObservationCounts).every(value => typeof value === 'number'));
    return evidence;
}
const screenshot = async name => { await page.screenshot({ path: path.join(output, name) }); screenshots.push(name); };
async function readerReady(file) {
    await page.waitForFunction(({ avatar, file }) => {
        const route = new URLSearchParams(location.hash.slice(1));
        const current = document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge?.currentChat?.();
        return route.get('chat') === avatar && route.get('file') === file && current?.avatar === avatar && current?.file === file
            && !!document.querySelector('.tl-composer-input[data-synced="true"]');
    }, { avatar, file }, { timeout: 240000 });
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 30000 });
}
async function waitUntil(probe, predicate, message, timeout = 30000) {
    const start = Date.now(); let value;
    do {
        value = await probe(); if (predicate(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() - start < timeout);
    throw new Error(message);
}
const composer = () => page.getByRole('textbox', { name: '输入消息', exact: true });
const dialog = name => page.getByRole('dialog', { name, exact: true });
async function closeDialog(name) {
    await dialog(name).getByRole('button', { name: '关闭', exact: true }).click();
    await dialog(name).waitFor({ state: 'detached' });
}
async function returnRoot() {
    await page.getByRole('button', { name: '番外与平行线', exact: true }).click();
    await dialog('番外与平行线').getByRole('button', { name: '回正文', exact: true }).click();
    await readerReady(rootFile);
}
async function rootPosition() {
    return page.evaluate(key => {
        const saved = JSON.parse(localStorage.getItem(key));
        const list = document.querySelector('.tl-messages');
        const article = saved && list?.querySelector(`.tl-message[data-index="${saved.anchor.index}"]`);
        const blocks = article && [...article.querySelectorAll('.tl-message-body p, .tl-message-body pre, .tl-message-body blockquote, .tl-message-body li')];
        const target = saved?.block ? blocks?.[saved.block.index] : article;
        const rect = target?.getBoundingClientRect();
        return { saved, scrollTop: list?.scrollTop, height: list?.clientHeight,
            anchorVisible: !!rect && rect.bottom > list.getBoundingClientRect().top && rect.top < list.getBoundingClientRect().bottom,
            restorationError: rect ? Math.abs(rect.top + (saved.ratio || 0) * rect.height - list.getBoundingClientRect().top - 80) : null };
    }, storageKey('reading', rootFile));
}
async function verifyRestored(name) {
    const position = await waitUntil(rootPosition, p => p.anchorVisible && p.restorationError < 8,
        'Source paragraph was not restored in the actual viewport');
    check(name, !position.saved.tail && position.saved.anchor.mark === readingBefore.saved.anchor.mark
        && position.saved.block?.mark === readingBefore.saved.block?.mark && position.restorationError < 8, position);
}

try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
    token = (await (await context.request.get(base + '/csrf-token')).json()).token;
    assert.ok((await post('/api/users/login', { handle: account, password: 'test1234' })).ok());
    assert.equal((await (await context.request.get(base + '/api/users/me')).json()).handle, account);
    assert.equal((await (await context.request.get(base + '/version')).json()).pkgVersion, process.env.EXPECT_ST_VERSION ?? '1.19.0');
    const installed = await (await context.request.get(base + '/api/extensions/discover')).json();
    const third = installed.filter(item => ['local', 'global'].includes(item.type));
    check('真实隔离实例仅装轻端第三方扩展', third.length === 1 && third[0].name === 'third-party/emmalike', third);
    const health = await context.request.post(base + '/api/plugins/tavern-lite/health', { data: {}, headers: { 'X-CSRF-Token': token } });
    check('纯净实例使用设备记录模式', health.status() === 404);
    settingsHash = hash((await (await post('/api/settings/get')).json()).settings);
    const created = await context.request.post(base + '/api/characters/create', {
        multipart: { ch_name: run, description: 'Synthetic fixture: a cafe owner.', first_mes: `GREETING_${run}`,
            personality: '', scenario: '', mes_example: '', creator_notes: run, system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' },
        headers: { 'X-CSRF-Token': token }, maxRedirects: 0,
    });
    assert.ok(created.ok()); avatar = (await created.text()).trim();
    assert.ok(avatar.startsWith(run) && avatar.endsWith('.png'));
    const root = [{ user_name: 'unused', character_name: 'unused', chat_metadata: {
        integrity: randomUUID(), tainted: true, lastInContextMessageId: 0, variables: { EP_PARENT_STATE: run },
        note_prompt: `PARENT_NOTE_${run}`, note_interval: 1, note_depth: 4, note_position: 1, note_role: 0,
        timedWorldInfo: { sticky: {}, cooldown: {} },
    } }, ...Array.from({ length: 100 }, (_, index) => ({ name: index % 2 ? 'Test author' : run,
        is_user: !!(index % 2), is_system: false, send_date: new Date(Date.now() - (100 - index) * 1000).toISOString(),
        mes: `PARENT_${String(index).padStart(3, '0')}_${run}\n\n第 ${index} 段合成正文，用来验证回到同一个段落。窗外的雨停了，桌上仍放着书。\n\n这段文字不来自真实聊天。`, extra: {} }))];
    root.at(-1).is_user = false; root.at(-1).name = run;
    Object.assign(root.at(-1), { swipes: [root.at(-1).mes, `PARENT_ALT_${run}`], swipe_id: 0, swipe_info: [{ extra: {} }, { extra: {} }] });
    root.at(-1).extra.memory = `PARENT_SUMMARY_${run}`;
    assert.ok((await post('/api/chats/save', { avatar_url: avatar, file_name: rootFile, chat: root, force: false })).ok());

    const readPaths = new Set(['/api/plugins/tavern-lite-save/probe', '/api/extensions/version', '/api/ping', '/api/characters/all', '/api/characters/get', '/api/characters/chats', '/api/chats/get', '/api/chats/recent', '/api/groups/all', '/api/backgrounds/all', '/api/backgrounds/folders', '/api/image-metadata/all', '/api/avatars/get', '/api/worldinfo/get', '/api/worldinfo/all', '/api/secrets/read', '/api/secrets/find', '/api/extensions/discover', '/api/extensions/manifest', '/api/users/list', '/api/assets/get', '/api/stats/get']);
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
        try {
            if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
            if (url.origin !== base) { blocked.push({ phase, pathname, origin: url.origin, reason: 'external' }); return route.abort(); }
            if (pathname === '/api/settings/get') {
                const response = await route.fetch(), data = await response.json(), settings = JSON.parse(data.settings);
                settings.active_character = null; settings.active_group = null; settings.firstRun = false; settings.main_api = 'openai';
                settings.oai_settings = { ...settings.oai_settings, chat_completion_source: 'custom', custom_url: 'http://episode-mock.invalid/v1', custom_model: 'episode-mock', stream_openai: false, openai_max_context: 32768 };
                if (settings.extension_settings?.connectionManager) settings.extension_settings.connectionManager = { ...settings.extension_settings.connectionManager, profiles: [], selectedProfile: '' };
                data.settings = JSON.stringify(settings); return route.fulfill({ response, json: data });
            }
            // Native initialization/statistics writes are acknowledged in the browser only;
            // they never reach the account's settings, QR sets or stats files.
            if (pathname === '/api/settings/save') { fixtureIntercepts.settingsSave++; return route.fulfill({ status: 200, json: { result: 'ok' } }); }
            if (pathname === '/api/quick-replies/save') { fixtureIntercepts.quickReplySave++; return route.fulfill({ status: 200, json: { result: 'ok' } }); }
            if (pathname === '/api/stats/update') { fixtureIntercepts.statsUpdate++; return route.fulfill({ status: 200, json: { result: 'ok' } }); }
            if (pathname === '/api/backends/chat-completions/status') return route.fulfill({ status: 200, json: { data: [{ id: 'episode-mock' }] } });
            if (pathname === '/api/backends/chat-completions/generate') {
                const body = payload(request), generated = `UI_GENERATED_${run}_${requests.length + 1}`;
                const actual = await native(w => w.TavernLiteBridge.currentChat());
                requests.push({ phase, body, generated, actual });
                return route.fulfill({ status: 200, json: { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: generated } }] } });
            }
            if (/^\/api\/(backends|horde|novelai|openai|kobold|sd|embeddings|vectors)(\/|$)/.test(pathname) || /^\/api\/.*(?:generate|completion)/i.test(pathname)) {
                if (/\/horde\/(text-models|text-workers|sd-models|sd-samplers)$/.test(pathname)) return route.fulfill({ json: [] });
                return route.fulfill({ status: 503, json: { error: 'Test blocks external model services' } });
            }
            if (pathname === '/api/chats/save') {
                const data = payload(request);
                assert.equal(data.avatar_url, avatar); assert.ok(ownFile(data.file_name)); assert.notEqual(data.force, true);
                const response = await route.fetch();
                saves.push({ phase, file: data.file_name, fingerprint: hash(data.chat), status: response.status() });
                return route.fulfill({ response });
            }
            if (pathname === '/api/characters/edit') {
                const contentType = request.headers()['content-type'] || '';
                assert.ok(contentType.startsWith('multipart/form-data;'), 'Unexpected character edit format');
                const fields = await new Response(request.postDataBuffer(), { headers: { 'content-type': contentType } }).formData();
                const identities = fields.getAll('avatar_url');
                assert.equal(identities.length, 1); assert.equal(identities[0], avatar);
                assert.equal(fields.get('ch_name'), run);
                ownedCharacterEdits.push({ phase, avatar });
                return route.continue();
            }
            if (!pathname.startsWith('/api/') || ['GET', 'HEAD'].includes(request.method()) || readPaths.has(pathname) || pathname.startsWith('/api/tokenizers/')) return route.continue();
            if (pathname === '/api/characters/edit-attribute') {
                const data = payload(request);
                if (data.avatar_url === avatar || data.avatar === avatar) return route.continue();
            }
            blocked.push({ phase, pathname, reason: 'unowned-or-unlisted-mutation' });
            return route.fulfill({ status: 409, json: { error: 'Only disposable fixture writes are allowed' } });
        } catch (error) {
            blocked.push({ phase, pathname, reason: error.message });
            return route.fulfill({ status: 409, json: { error: 'Fixture ownership validation failed' } }).catch(() => {});
        }
    });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push({ phase, message: error.message, stack: error.stack }));
    page.on('console', message => {
        if (message.type() !== 'error') return;
        const location = message.location(); let pathname;
        try { pathname = new URL(location.url).pathname; } catch { pathname = location.url; }
        consoleErrors.push({ phase, message: message.text(), pathname, location });
    });
    await page.goto(`${base}/scripts/extensions/third-party/emmalike/app/#${new URLSearchParams({ chat: avatar, file: rootFile })}`);
    await readerReady(rootFile);
    buildAssets = await page.locator('script[src],link[rel="stylesheet"]').evaluateAll(elements => elements.map(element => element.src || element.href));
    await observeNativeStage('首次打开页面', true);
    // One explicit fixture-only initialization save, before any tested UI operation or parent immutability baseline.
    baseSnapshot = await native(async (w, file) => {
        const st = await import('/script.js'), extensions = await import('/scripts/extensions.js'), current = w.SillyTavern.getContext();
        if (current.getCurrentChatId() !== file) throw new Error('Unexpected fixture setup target');
        await new Promise(resolve => setTimeout(resolve, 1300));
        extensions.cancelDebouncedMetadataSave(); st.cancelDebouncedChatSave(); await st.saveChatConditional();
        return [{ user_name: 'unused', character_name: 'unused', chat_metadata: JSON.parse(JSON.stringify(current.chatMetadata)) }, ...JSON.parse(JSON.stringify(current.chat))];
    }, rootFile);
    check('来源原生内存与完整落盘文件一致', hash(baseSnapshot) === hash(await read(rootFile)));
    const status = await native(w => w.TavernLiteBridge.episodeStatus());
    check('真实引擎门控允许此次纯净配置验收', status.verified && status.enabled,
        { enabled: status.enabled, verified: status.verified, reasonCount: status.reasons.length });

    phase = 'reader-author-command';
    await page.locator('.tl-messages').hover(); await page.mouse.wheel(0, -1800);
    readingBefore = await waitUntil(rootPosition, position => position.saved && !position.saved.tail && position.anchorVisible,
        'Could not establish an earlier source reading position');
    check('正文已记录非末尾段落位置', readingBefore.saved.anchor.index < 99 && !readingBefore.saved.tail, readingBefore);
    await composer().fill(requestText);
    readingBefore = await rootPosition();
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await dialog('番外与平行线').waitFor();
    check('Reader明确指令先打开编辑确认而未请求模型', requests.length === 0 && await dialog('番外与平行线').getByRole('radio', { name: '接续正文最新进度', exact: true }).getAttribute('aria-checked') === 'true');
    await dialog('番外与平行线').getByLabel('标题', { exact: true }).fill(title);
    await dialog('番外与平行线').getByRole('button', { name: '下一步：确认发送', exact: true }).click();
    await dialog('确认发送').waitFor();
    const graph = await native((w, avatar) => w.TavernLiteBridge.episodeIndex(avatar), avatar);
    const child = graph.nodes.find(node => node.episode.openingRequest === requestText);
    assert.ok(child && child.episode.title === title); childFile = child.locator.file;
    const review = await dialog('确认发送').innerText();
    check('确认页展示目的地、标题、背景及原作者请求，不露文件名', childFile !== rootFile && !review.includes(childFile)
        && review.includes(`番外 · ${title}`) && review.includes('带上了正文到现在的内容') && review.includes(requestText), { childFile, title });
    check('准备目的地没有生成或切走来源', requests.length === 0 && (await native(w => w.TavernLiteBridge.currentChat())).file === rootFile);
    const childInitial = await read(childFile);
    check('实际创建接续副本且父文件全字段不变', hash(childInitial.slice(1)) === hash(baseSnapshot.slice(1)) && hash(await read(rootFile)) === hash(baseSnapshot));
    // Seed an independently owned target draft to prove Reader navigation cannot overwrite it with the author command.
    await page.evaluate(({ key, text }) => localStorage.setItem(key, JSON.stringify(text)), { key: storageKey('draft', childFile), text: childDraft });
    await screenshot('destination-review-mobile-simulated.png');

    phase = 'review-send-child';
    await dialog('确认发送').getByRole('button', { name: '发送', exact: true }).click();
    await readerReady(childFile);
    await page.getByText(`UI_GENERATED_${run}_1`, { exact: true }).waitFor();
    await waitUntil(() => page.locator('.tl-reader-title .tl-chapter').innerText(), value => value.includes(`番外 · ${title}`), 'Child route has the wrong header');
    check('确认一次仅生成一次，路由标题与实际原生故事均为子线', requests.length === 1
        && (await native(w => w.TavernLiteBridge.currentChat())).file === childFile
        && (await page.locator('.tl-reader-title .tl-chapter').innerText()).includes(`番外 · ${title}`));
    check('模型请求发生在已确认子线且包含原作者要求', requests[0].actual?.avatar === avatar
        && requests[0].actual?.file === childFile && JSON.stringify(requests[0].body).includes(requestText));
    const childSaved = await read(childFile), childMetadata = childSaved[0].chat_metadata.tavern_lite_episode;
    check('生成后完整子线保存且请求仅出现一次', childMetadata.kind === 'side' && childMetadata.contextMode === 'continued'
        && childMetadata.openingRequest === requestText && childSaved.slice(1).filter(message => message.is_user && message.mes === requestText).length === 1
        && childSaved.some(message => message.mes === `UI_GENERATED_${run}_1`));
    check('子线原有草稿保留，原作者请求没有覆盖输入框', await composer().inputValue() === childDraft);
    check('子线生成未改写正文消息、候选或元数据', hash(await read(rootFile)) === hash(baseSnapshot));
    await observeNativeStage('子线生成确认后');
    await screenshot('generated-child-mobile-simulated.png');

    phase = 'labels-and-navigation';
    await page.getByRole('button', { name: '更多', exact: true }).click();
    check('Reader菜单显示当前子线标识', (await dialog(run).innerText()).includes(`番外 · ${title}`));
    await closeDialog(run);
    await page.getByRole('button', { name: '切换故事', exact: true }).click();
    await dialog('故事').getByRole('button', { name: new RegExp(`番外 · ${title}`) }).waitFor();
    check('章节切换列表按真实元数据显示子线标识', (await dialog('故事').innerText()).includes(`番外 · ${title}`));
    await dialog('故事').getByRole('button', { name: /^角色主页/ }).click();
    const chapter = page.locator('.tl-chapter-row').filter({ hasText: `番外 · ${title}` });
    await chapter.waitFor();
    check('角色主页章节显示子线标题', (await chapter.innerText()).includes(`番外 · ${title}`));
    await chapter.getByRole('button', { name: '故事操作', exact: true }).click();
    check('章节菜单保留子线标题与文件名的独立操作', await dialog(`番外 · ${title}`).getByRole('button', { name: /^改标题/ }).count() === 1
        && await dialog(`番外 · ${title}`).getByRole('button', { name: /^改文件名/ }).count() === 1);
    await closeDialog(`番外 · ${title}`);
    await page.getByRole('button', { name: '返回', exact: true }).click();
    const recent = page.locator('.tl-continue').filter({ hasText: title });
    await recent.waitFor();
    check('书架最近阅读卡展示子线标题', (await recent.locator('.tl-card-story').innerText()).includes(`番外 · ${title}`));
    await page.getByRole('button', { name: `${run} 的更多操作`, exact: true }).click();
    await waitUntil(() => dialog(run).innerText(), text => text.includes(`番外 · ${title}`), 'Library menu has not loaded actual current metadata');
    check('书架角色菜单继续阅读目的地含子线标识', (await dialog(run).innerText()).includes(`番外 · ${title}`));
    await closeDialog(run); await recent.click(); await readerReady(childFile);
    check('浏览章节和菜单没有额外模型请求', requests.length === 1);

    phase = 'return-root-state';
    await returnRoot();
    check('回正文后仅清理已发送的原草稿', await composer().inputValue() === '');
    await verifyRestored('首次回正文恢复原段落与段内位置');
    await composer().fill(rootDraft);
    await page.getByRole('button', { name: '番外与平行线', exact: true }).click();
    await dialog('番外与平行线').locator('.tl-sheet-item').filter({ hasText: title }).click();
    await readerReady(childFile);
    check('从列表重开子线保留其独立草稿', await composer().inputValue() === childDraft);
    await returnRoot();
    check('再次回正文保留新输入的正文草稿', await composer().inputValue() === rootDraft);
    await verifyRestored('往返子线再次恢复同一正文段落');
    await screenshot('root-restored-mobile-simulated.png');
    await page.reload(); await readerReady(rootFile);
    await observeNativeStage('真实页面刷新', true);
    check('真实页面刷新保留正文独立草稿', await composer().inputValue() === rootDraft);
    await verifyRestored('真实页面刷新仍恢复正文段落');
    check('往返与刷新没有重新生成或改写正文', requests.length === 1 && hash(await read(rootFile)) === hash(baseSnapshot));

    phase = 'disabled-normal-send';
    await page.getByRole('button', { name: '番外与平行线', exact: true }).click();
    // The switch sits under 更多 (folded).
    await dialog('番外与平行线').getByText('更多', { exact: true }).click();
    await dialog('番外与平行线').getByRole('checkbox', { name: '分开写番外与平行线', exact: true }).uncheck();
    await closeDialog('番外与平行线');
    check('关闭增强总开关已由实际引擎读回', !(await native(w => w.TavernLiteBridge.episodeStatus())).enabled);
    const childBeforeNormal = hash(await read(childFile));
    const normalText = `[番外] 关闭增强时这句话仍发送到当前正文 ${run}`;
    await composer().fill(normalText); await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText(`UI_GENERATED_${run}_2`, { exact: true }).waitFor();
    rootAfterOrdinary = await waitUntil(() => read(rootFile), messages => messages.some(message => message.mes === `UI_GENERATED_${run}_2`), 'Normal send was not saved');
    check('关闭增强后明确指令按原流程发送且没有确认层', requests.length === 2 && await page.getByRole('dialog').count() === 0
        && (await native(w => w.TavernLiteBridge.currentChat())).file === rootFile
        && new URLSearchParams(new URL(page.url()).hash.slice(1)).get('file') === rootFile);
    check('关闭增强后的模型请求仍属于当前正文', requests[1].actual?.avatar === avatar && requests[1].actual?.file === rootFile);
    check('原发送只追加一次到正文，不改子线', rootAfterOrdinary.filter(message => message.is_user && message.mes === normalText).length === 1
        && hash(await read(childFile)) === childBeforeNormal);
    const afterGraph = await native((w, avatar) => w.TavernLiteBridge.episodeIndex(avatar), avatar);
    check('关闭增强不会暗中新建第二条子线', afterGraph.nodes.filter(node => node.episode.kind !== 'root').length === 1);
    await observeNativeStage('关闭增强后原发送');
    await screenshot('disabled-ordinary-send-mobile-simulated.png');
} catch (error) {
    fatal = { phase, message: error.message, stack: error.stack }; console.error('FAIL', phase, error.stack); process.exitCode = 1;
    await screenshot('failure.png').catch(() => {});
    if (page) {
        await writeFile(path.join(output, 'failure-ui.json'), JSON.stringify(await page.evaluate(() => ({
            hash: location.hash, title: document.querySelector('.tl-reader-title')?.textContent,
            dialogs: [...document.querySelectorAll('[role="dialog"]')].map(element => element.innerText),
            banners: [...document.querySelectorAll('.tl-error,.tl-toast')].map(element => element.textContent),
        })).catch(() => ({})), null, 2));
    }
} finally {
    // Read original settings through the request context, bypassing browser response fixtures.
    if (settingsHash && context) {
        try { record('原账号设置落盘哈希保持不变', hash((await (await post('/api/settings/get')).json()).settings) === settingsHash); }
        catch (error) { record('原账号设置落盘哈希保持不变', false, error.message); }
    }
    await page?.close().catch(() => {});
    record('页面没有未捕获JavaScript异常', errors.length === 0, errors);
    record('没有外部请求或越界写入', blocked.length === 0, blocked);
    if (avatar?.startsWith(run) && context) {
        try {
            const ownCharacter = await (await post('/api/characters/get', { avatar_url: avatar })).json(); assert.equal(ownCharacter.name, run);
            assert.ok((await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true })).ok());
            cleanup = (await post('/api/characters/get', { avatar_url: avatar })).status() === 404;
        } catch (error) { fatal ||= { phase: 'cleanup', message: error.message }; }
    }
    await browser?.close().catch(() => {});
    const report = { run, avatar, rootFile, childFile, passed: !fatal && cleanup && checks.every(item => item.pass),
        checks, fatal, cleanup, errors, consoleErrors, blocked, screenshots, buildAssets, nativeObservationEvidence, fixtureIntercepts, ownedCharacterEdits,
        rootBaselineFingerprint: baseSnapshot && hash(baseSnapshot), ordinarySendFingerprint: rootAfterOrdinary && hash(rootAfterOrdinary),
        limits: ['Model replies are browser fixtures; no real model or quality claim.',
            '390×844 Chromium with touch enabled is a browser simulation, not a physical phone or software keyboard test.',
            'Real ST 1.19.0 and pure extension configuration only; this does not test real third-party plugins or production settings.',
            'Setup/cleanup use owned synthetic data. Episode create, confirm, navigation and switch actions use visible built UI.'] };
    await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    await writeFile(path.join(output, 'request-and-save-diagnostics.json'), JSON.stringify({ requests: requests.map(({ phase, body, generated, actual }) => ({
        phase, fingerprint: hash(body), generated, actual, hasAuthorRequest: JSON.stringify(body).includes(requestText),
        hasParentFixture: JSON.stringify(body).includes(`PARENT_099_${run}`),
    })), saves }, null, 2));
    console.log(JSON.stringify({ output, passed: report.passed, checks: checks.length, cleanup }));
    if (!report.passed) process.exitCode = 1;
}
