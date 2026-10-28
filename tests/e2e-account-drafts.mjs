// One browser, two accounts: what one writes stays its own, and what is written is not lost. Character drafts (also
// right before a reload, and a rename), the look (a theme made by A never reaches B or B's settings), readable colours
// on a dark background, the episodes form kept apart from the story's input box, and no excerpts without a story.
// Two disposable accounts are made on the isolated instance and deleted afterwards.
// Usage: node e2e-account-drafts.mjs <baseUrl> <adminHandle> <adminPassword>
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const [base = 'http://127.0.0.1:8031', adminHandle = 'default-user', adminPassword = 'test1234'] = process.argv.slice(2);
assert.ok(['http://127.0.0.1:8031', 'http://127.0.0.1:8032', 'http://127.0.0.1:8035'].includes(base), 'Only the isolated test instances');
const app = base + '/scripts/extensions/third-party/emmalike/app/';
const out = process.env.TEST_OUTPUT || '/tmp/tavern-improvements/account-drafts';
await mkdir(out, { recursive: true });
const run = `tl-acct-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
const [A, B] = ['a', 'b'].map(s => ({ handle: `${run}-${s}`, password: randomUUID() }));
const created = [], checks = [], errors = [];
const check = (name, ok, detail) => { checks.push({ name, pass: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(detail ?? '')); assert.ok(ok, name); };
const api = (c, t, endpoint, body) => c.request.post(base + endpoint, { data: body, headers: { 'X-CSRF-Token': t } });
const token = async c => (await (await c.request.get(base + '/csrf-token')).json()).token;
const login = async (c, user) => { const t = await token(c); assert.ok((await api(c, t, '/api/users/login', user)).ok(), 'login ' + user.handle); return token(c); };
const luminance = hex => { const v = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const contrast = (a, b) => { const [h, l] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (h + 0.05) / (l + 0.05); };

let browser, admin, adminToken, context, page, fatal;
try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    admin = await browser.newContext({ serviceWorkers: 'block' });
    adminToken = await login(admin, { handle: adminHandle, password: adminPassword });
    for (const user of [A, B]) {
        const r = await api(admin, adminToken, '/api/users/create', { ...user, name: 'Account drafts test', admin: false });
        assert.ok(r.ok(), 'create account'); created.push(user.handle);
    }
    // One browser profile for both accounts, as on a shared phone.
    context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url()), p = url.pathname;
        if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
        if (url.origin !== base) return route.abort();
        if (p === '/api/settings/get') {
            const response = await route.fetch(), data = await response.json(), settings = JSON.parse(data.settings);
            settings.firstRun = false; settings.active_character = null; settings.active_group = null;
            data.settings = JSON.stringify(settings); return route.fulfill({ response, json: data });
        }
        // The app lists Horde models on start and sorts what it gets: an empty list, not an error object.
        if (/\/horde\/(text-models|text-workers|sd-models|sd-samplers)$/.test(p)) return route.fulfill({ json: [] });
        if (/generate|completion/i.test(p) || /^\/api\/(?:backends|horde|novelai|sd|embeddings|vectors)\//.test(p)) return route.fulfill({ status: 503, json: { error: 'No models in this test' } });
        return route.continue();
    });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', e => errors.push(`${e.message} @ ${page.url().split('#')[1] ?? ''} ${String(e.stack ?? '').split('\n').slice(1, 4).join(' | ')}`));
    // A fresh load every time: a hash change alone would stay inside the open page (and its open sheets).
    const open = async hash => { await page.goto('about:blank'); await page.goto(app + hash); await page.locator('.tl-boot').waitFor({ state: 'detached', timeout: 60000 }); };
    const engineReady = () => page.waitForFunction(() => !!document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge, null, { timeout: 270000 })
        .catch(async error => {
            const state = await page.evaluate(() => { const f = document.querySelector('iframe.engine'); let inner = null;
                try { inner = { ready: f?.contentDocument?.readyState, title: f?.contentDocument?.title, dialogs: [...(f?.contentDocument?.querySelectorAll('dialog[open], .popup') || [])].map(d => d.textContent.trim().slice(0, 200)) }; } catch (e) { inner = String(e); }
                return { iframe: !!f, src: f?.getAttribute('src'), status: [...document.querySelectorAll('.tl-engine-status, [role=status]')].map(x => x.textContent), mode: localStorage.getItem('tavern-lite:engine-mode'), inner }; }).catch(e => String(e));
            throw new Error(error.message + ' engine=' + JSON.stringify(state));
        });
    const dialog = name => page.getByRole('dialog', { name, exact: true });
    // Leave the page first, as when signing out: a request still running in the old page would otherwise set the old
    // account's session cookie again after the switch.
    const switchTo = async user => { await page.goto('about:blank'); return login(context, user); };
    const signedIn = () => page.evaluate(async () => (await (await fetch('/api/users/me', { cache: 'no-store' })).json()).handle);
    const settingsOf = async () => { const c = context, t = await token(c); return JSON.parse((await (await api(c, t, '/api/settings/get', {})).json()).settings).extension_settings?.tavernLite ?? {}; };
    const waitFor = async (read, ok, what, ms = 60000) => { const until = Date.now() + ms; let v; while (Date.now() < until) { v = await read(); if (ok(v)) return v; await page.waitForTimeout(1000); } throw new Error(what + ': ' + JSON.stringify(v)); };

    // --- B, freshly signed in, no story open: the welcome page is not a story to keep excerpts from.
    await switchTo(B);
    await open('#me'); await engineReady();
    await page.getByRole('button', { name: /^我的摘录/ }).click();
    await dialog('我的摘录').getByRole('button', { name: /^从当前对话选取/ }).click();
    const picker = dialog('从当前对话选取'); await picker.waitFor();
    check('没有打开的故事时只说先去打开一个，不列欢迎页的内容', (await picker.innerText()).includes('现在没有打开的故事')
        && await picker.getByRole('button', { name: '收藏原句', exact: true }).count() === 0, await picker.innerText());
    await page.screenshot({ path: path.join(out, 'picker-no-story.png') });

    // --- A: a new character's draft, kept even when the page is reloaded right after typing.
    let t = await switchTo(A);
    await open('#create');
    await page.getByLabel('名字').fill('账号A专属草稿');
    await page.locator('#tl-field-description').fill('只给 A 看的人物设定');
    await page.reload(); await page.getByLabel('名字').waitFor();
    await waitFor(() => page.getByLabel('名字').inputValue(), v => v === '账号A专属草稿', 'name after immediate reload', 15000);
    check('输入后马上刷新，刚写的名字和设定都还在', await page.locator('#tl-field-description').inputValue() === '只给 A 看的人物设定');
    await page.getByText(/已接着上次没写完的继续/).waitFor();

    // --- B on the same browser does not see it; A gets it back.
    await switchTo(B);
    await open('#create'); await page.getByLabel('名字').waitFor(); await page.waitForTimeout(1500);
    check('页面确实是 B 登录', await signedIn() === B.handle);
    check('换成 B 登录，新建角色是空的，看不到 A 的草稿', await page.getByLabel('名字').inputValue() === ''
        && await page.locator('#tl-field-description').inputValue() === '' && await page.getByText(/已接着上次没写完的继续/).count() === 0);
    await page.screenshot({ path: path.join(out, 'b-create-empty.png') });
    t = await switchTo(A);
    await open('#create');
    await waitFor(() => page.getByLabel('名字').inputValue(), v => v === '账号A专属草稿', 'A draft back');
    check('A 再登录，草稿还在', true);

    // --- A renames an existing character without saving: the new name is a draft too.
    const character = `审查角色${run}`;
    const made = await context.request.post(base + '/api/characters/create', { multipart: { ch_name: character, description: '原来的设定', first_mes: '你好。' }, headers: { 'X-CSRF-Token': t } });
    assert.ok(made.ok()); const avatar = (await made.text()).trim();
    await open('#' + new URLSearchParams({ edit: avatar }));
    await waitFor(() => page.getByLabel('名字').inputValue(), v => v === character, 'editor loaded');
    await page.getByLabel('名字').fill('改名草稿应保留');
    await page.getByText(/草稿已存在本机/).waitFor({ timeout: 10000 });
    await page.reload();
    const banner = page.locator('.tl-banner-card'); await banner.waitFor();
    check('改了名字没保存，刷新后提示有草稿且写明改了名字', (await banner.innerText()).includes('名字'), await banner.innerText());
    await banner.getByRole('button', { name: '恢复草稿', exact: true }).click();
    check('恢复草稿后名字回到改过的', await page.getByLabel('名字').inputValue() === '改名草稿应保留');
    await page.screenshot({ path: path.join(out, 'rename-restored.png') });

    // --- A makes a dark theme: switching the background keeps 对白、旁白、强调色 readable; a low one is named and fixed.
    await open('#theme'); await engineReady();
    await page.getByRole('button', { name: '背景 #18202b', exact: true }).click();
    const colours = async () => Object.fromEntries(await Promise.all(['文字', '对白', '旁白', '强调色'].map(async n => [n, await page.getByLabel(`${n}颜色`).inputValue()])));
    let now = await colours();
    check('切到深蓝背景，文字、对白、旁白、强调色都能看清', Object.values(now).every(c => contrast(c, '#18202b') >= 4.5), now);
    check('都能看清时不提示', await page.locator('.tl-contrast-warning').count() === 0);
    await page.getByLabel('对白颜色').fill('#7a4a1e');
    const warning = page.locator('.tl-contrast-warning'); await warning.waitFor();
    check('自己选了看不清的对白颜色，提示写明是对白', (await warning.innerText()).includes('对白') && !(await warning.innerText()).includes('旁白'), await warning.innerText());
    await page.screenshot({ path: path.join(out, 'theme-warning.png') });
    await warning.getByRole('button', { name: '自动调整', exact: true }).click();
    now = await colours();
    check('一键修正后对白能看清，其他颜色不动', contrast(now['对白'], '#18202b') >= 4.5 && await page.locator('.tl-contrast-warning').count() === 0, now);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('主题已保存并使用').waitFor();
    const aSettings = await waitFor(settingsOf, s => s.themes?.length === 1, 'A theme synced');
    check('A 的主题存进了 A 的账号设置', aSettings.reading?.theme === `custom:${aSettings.themes[0].id}`);

    // --- B on the same browser: not A's look, and nothing of A written into B's settings.
    await switchTo(B);
    await open('#me'); await engineReady(); await page.waitForTimeout(5000);
    check('页面确实是 B 登录（看外观前）', await signedIn() === B.handle);
    const css = await page.evaluate(() => document.getElementById('tl-reading-css')?.textContent ?? '');
    check('换成 B 登录，界面不是 A 的深蓝主题', !css.includes('#18202b'), css.slice(0, 200));
    const bSettings = await settingsOf();
    check('B 的账号设置里没有写进 A 的主题', !bSettings.themes?.length && !String(bSettings.reading?.theme ?? '').startsWith('custom:'), bSettings);
    await page.screenshot({ path: path.join(out, 'b-look.png') });

    // --- A: the episodes form is its own, kept per story; the story's input box is never touched.
    t = await switchTo(A);
    const rootFile = `${run}-root`;
    assert.ok((await api(context, t, '/api/chats/save', { avatar_url: avatar, file_name: rootFile, force: false, chat: [{ user_name: 'unused', character_name: 'unused', chat_metadata: { integrity: randomUUID() } }, { name: character, is_user: false, is_system: false, mes: '你好。', send_date: '2026-01-01T00:00:00Z', extra: {} }] })).ok());
    await open('#' + new URLSearchParams({ chat: avatar, file: rootFile }));
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 270000 });
    const composer = page.getByRole('textbox', { name: '输入消息', exact: true });
    const kept = '正文未发草稿A：请保留这句话。';
    await composer.fill(kept);
    const openForm = async () => {
        await page.getByRole('button', { name: '番外与平行线', exact: true }).click();
        await dialog('番外与平行线').getByRole('button', { name: '＋ 新开番外 / 平行线 / 小剧场', exact: true }).click({ timeout: 60000 });
        return dialog('番外与平行线');
    };
    let form = await openForm();
    check('新开时要求框是空的，不搬正文输入框里的字', await form.getByLabel('开场或续写要求').inputValue() === ''
        && await form.getByRole('button', { name: '用输入框里写的', exact: true }).count() === 1);
    await form.getByLabel('类型').selectOption({ label: '平行线' });
    await form.getByLabel('标题', { exact: true }).fill('需要保留的平行线标题');
    await form.getByRole('radio', { name: '不复制正文', exact: true }).click();
    await form.getByLabel('开场或续写要求').fill('另一个世界的草稿B：我们走进雨里。');
    await page.screenshot({ path: path.join(out, 'episode-form.png') });
    await form.getByRole('button', { name: '关闭', exact: true }).click();
    await form.waitFor({ state: 'detached' });
    check('关掉面板，正文输入框还是原来那句', await composer.inputValue() === kept, await composer.inputValue());
    form = await openForm();
    check('再打开，类型、标题、带不带正文和要求都还在', await form.getByLabel('类型').inputValue() === 'parallel'
        && await form.getByLabel('标题', { exact: true }).inputValue() === '需要保留的平行线标题'
        && await form.getByRole('radio', { name: '不复制正文', exact: true }).getAttribute('aria-checked') === 'true'
        && await form.getByLabel('开场或续写要求').inputValue() === '另一个世界的草稿B：我们走进雨里。');
    await page.reload(); await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 270000 });
    form = await openForm();
    check('刷新页面后表单也还在', await form.getByLabel('标题', { exact: true }).inputValue() === '需要保留的平行线标题');
    await form.getByRole('button', { name: '关闭', exact: true }).click();
    check('正文输入框的草稿刷新后也还是原来那句', await composer.inputValue() === kept, await composer.inputValue());
    check('没有浏览器报错', errors.length === 0, errors);
} catch (error) {
    fatal = { message: error.message, stack: error.stack };
    console.error('FAILURE', error.stack); process.exitCode = 1;
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    if (process.env.FAIL_SHOT && page) await page.screenshot({ path: process.env.FAIL_SHOT }).catch(() => {});
} finally {
    await context?.close().catch(() => {});
    let cleaned = true;
    for (const handle of created) {
        if (!handle.startsWith(run + '-')) throw Error('Refusing unrelated account cleanup');
        try { assert.ok((await api(admin, adminToken, '/api/users/delete', { handle, purge: true })).ok()); } catch { cleaned = false; }
    }
    await browser?.close().catch(() => {});
    const passed = !fatal && cleaned && checks.every(c => c.pass);
    await writeFile(path.join(out, 'results.json'), JSON.stringify({ run, passed, checks, fatal, errors, cleaned }, null, 2));
    console.log(JSON.stringify({ passed, checks: checks.length, cleaned, out }));
    if (!passed) process.exitCode = 1;
}
