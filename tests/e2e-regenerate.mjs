// "重新生成本轮回复" under the last reply, the story menu's "流式输出" switch, and how waiting and an empty reply look,
// on an official SillyTavern with only tavern-lite. The mock model is told over /next to send an empty reply or to wait.
// Usage: node e2e-regenerate.mjs <baseUrl> <handle> <password>   (MOCK_URL: the mock model, default 127.0.0.1:5001)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
const mock = process.env.MOCK_URL ?? 'http://127.0.0.1:5001';
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `重写${run}`, FILE = `重写-${run}`;
const results = {}, problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 400); if (!ok) problems.push(name); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.setDefaultTimeout(30000);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
console.log('SillyTavern', (await (await page.request.get(`${base}/version`)).json()).pkgVersion);
const created = await page.request.post(`${base}/api/characters/create`, { headers: { 'X-CSRF-Token': token },
    multipart: { ch_name: NAME, description: '', first_mes: '你来了。', personality: '', scenario: '', mes_example: '', creator_notes: '',
        system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' } });
const avatar = (await created.text()).trim();
const now = new Date().toISOString();
const ORIGINAL = '下了一整夜。';
const story = [
    { name: NAME, is_user: false, mes: '你来了。' },
    { name: 'User', is_user: true, mes: '外面下雨了吗？' },
    { name: NAME, is_user: false, mes: ORIGINAL, swipes: [ORIGINAL], swipe_id: 0, swipe_info: [{ send_date: now, extra: {} }] },
].map(m => ({ ...m, send_date: now, extra: {} }));
await post('/api/chats/save', { ch_name: NAME, file_name: FILE, avatar_url: avatar, chat: [{ user_name: 'User', character_name: NAME, create_date: now, chat_metadata: {} }, ...story], force: true });

const nextReply = query => page.request.get(`${mock}/next?${query}`);
const lastRequest = async () => (await page.request.get(`${mock}/last`)).json();
const streamedCount = async () => (await (await page.request.get(`${mock}/count`)).json()).streamed;
const lastChar = () => page.locator('.tl-message[data-role="char"]').last();
const regenButton = () => lastChar().getByRole('button', { name: '重新生成本轮回复' });
const lastText = () => lastChar().locator('.tl-message-body').innerText().catch(() => '');
const swipeCount = () => lastChar().locator('.tl-swipe-count').innerText().catch(() => '');
const charCount = () => page.locator('.tl-message[data-role="char"]').count();
const idle = () => page.locator('.tl-send').waitFor({ timeout: 120000 });
const replied = () => page.waitForFunction(() => {
    const body = [...document.querySelectorAll('.tl-message[data-role="char"] .tl-message-body')].pop();
    return !!document.querySelector('.tl-send') && /模拟回复/.test(body?.textContent ?? '');
}, null, { timeout: 120000 });
const openStoryMenu = async () => { await page.getByRole('button', { name: '更多', exact: true }).first().click(); return page.getByRole('switch', { name: /流式输出/ }); };
const closeSheet = () => page.locator('.tl-sheet').last().getByRole('button', { name: '关闭' }).click();
let streamAtStart = null;

try {
    await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: FILE })}`);
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    await lastChar().locator('.tl-swipe').waitFor();

    // 1. The button: an icon only, next to 换个回复 and 继续写; a tap replaces this round's reply with a new one.
    check('a regenerate button sits under the last reply', await regenButton().isVisible());
    check('the button is an icon without words', (await regenButton().innerText()).trim() === '', await regenButton().innerText());
    const sent1 = await streamedCount();
    await regenButton().click();
    await replied();
    check('regenerate replaces the reply in place', (await charCount()) === 2 && (await lastText()) !== ORIGINAL && (await swipeCount()) === '换个回复',
        { chars: await charCount(), text: await lastText(), count: await swipeCount() });
    check('regenerate sends one generation', (await streamedCount()) === sent1 + 1, { before: sent1, after: await streamedCount() });

    // 2. An empty reply says so and offers the button again; the next tap gives words.
    await idle();
    await nextReply('empty=1');
    await regenButton().click();
    const notice = page.getByRole('status').filter({ hasText: '没收到文字' });
    check('an empty reply is said in words', await notice.waitFor({ timeout: 60000 }).then(() => true).catch(() => false));
    await page.screenshot({ path: '/tmp/tl-regen-empty.png' });
    check('after an empty reply the button is there again', await regenButton().isVisible().catch(() => false));
    await regenButton().click();
    await replied();
    check('regenerating after an empty reply gives words and the notice goes', /模拟回复/.test(await lastText()) && !(await notice.isVisible().catch(() => false)), await lastText());

    // 3. With several replies the app's 重新生成 would replace them all: asked first, cancel keeps them.
    await idle();
    await page.waitForTimeout(2600);
    await lastChar().getByRole('button', { name: '生成新回复' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.tl-message[data-role="char"] .tl-swipe-count')].pop()?.textContent === '2/2', null, { timeout: 120000 });
    await idle();
    const sent3 = await streamedCount();
    await regenButton().click();
    const ask = page.locator('.tl-sheet').filter({ hasText: '重新生成？' });
    check('with several replies it asks first', await ask.waitFor({ timeout: 5000 }).then(() => true).catch(() => false) && /2 个回复/.test(await ask.innerText().catch(() => '')));
    await page.screenshot({ path: '/tmp/tl-regen-confirm.png' });
    await ask.getByRole('button', { name: '取消' }).click();
    await page.waitForTimeout(800);
    check('cancel keeps both replies and sends nothing', (await swipeCount()) === '2/2' && (await streamedCount()) === sent3, { count: await swipeCount(), sent: await streamedCount() });
    await regenButton().click();
    await ask.getByRole('button', { name: '重新生成' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.tl-message[data-role="char"] .tl-swipe-count')].pop()?.textContent === '换个回复', null, { timeout: 120000 }).catch(() => {});
    await replied();
    check('confirmed, the replies become one new reply', (await swipeCount()) === '换个回复' && (await charCount()) === 2, { count: await swipeCount(), chars: await charCount() });

    // 4. The message menu offers 重新生成 too, now also when changing replies is possible.
    await idle();
    await lastChar().getByRole('button', { name: '消息操作' }).click();
    check('the message menu has 重新生成', await page.locator('.tl-sheet-item').filter({ hasText: '重新生成' }).first().isVisible().catch(() => false));
    await closeSheet();
    await page.waitForTimeout(400);

    // 5. A slow first word: the wait shows the seconds and, later, that it may take a while.
    await idle();
    await nextReply('delay=34000');
    await regenButton().click();
    const waited = await page.getByRole('status').filter({ hasText: /已等 1\d 秒/ }).waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    check('a long wait shows the seconds waited', waited);
    const note = await page.locator('.tl-wait-note').waitFor({ timeout: 25000 }).then(() => true).catch(() => false);
    check('a very long wait says the model may take a minute or two', note);
    await page.screenshot({ path: '/tmp/tl-regen-waiting.png' });
    await replied();

    // 6. The story menu's 流式输出 switch: shows the current setting, turning it off sends without streaming, on again streams.
    await idle();
    let toggle = await openStoryMenu();
    check('the story menu has the 流式输出 switch', await toggle.isVisible().catch(() => false));
    streamAtStart = (await toggle.getAttribute('aria-checked')) === 'true';
    await page.screenshot({ path: '/tmp/tl-regen-stream-menu.png' });
    if (!streamAtStart) { await toggle.click(); await page.waitForFunction(() => document.querySelector('[role="switch"][aria-checked="true"]')?.textContent.includes('流式输出'), null, { timeout: 10000 }); }
    await toggle.click();
    const off = await page.waitForFunction(() => [...document.querySelectorAll('[role="switch"]')].some(s => s.textContent.includes('流式输出') && s.getAttribute('aria-checked') === 'false'), null, { timeout: 10000 }).then(() => true).catch(() => false);
    check('the switch turns off', off);
    await closeSheet();
    await page.waitForTimeout(400);
    await regenButton().click();
    await replied();
    check('with the switch off the reply comes without streaming', (await lastRequest())?.stream === false, String((await lastRequest())?.stream));
    await idle();
    toggle = await openStoryMenu();
    check('the menu shows it off after reopening', (await toggle.getAttribute('aria-checked')) === 'false');
    await toggle.click();
    await page.waitForFunction(() => [...document.querySelectorAll('[role="switch"]')].some(s => s.textContent.includes('流式输出') && s.getAttribute('aria-checked') === 'true'), null, { timeout: 10000 }).catch(() => {});
    await closeSheet();
    await page.waitForTimeout(400);
    await regenButton().click();
    await replied();
    check('turned on again the reply streams', (await lastRequest())?.stream === true, String((await lastRequest())?.stream));
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
    problems.push('crashed');
    console.log('FAILURE', error.stack);
    await page.screenshot({ path: '/tmp/tl-regen-fail.png' }).catch(() => { });
}
// Leave the shared account's streaming setting as it was.
if (streamAtStart === false) {
    try {
        await idle();
        const toggle = await openStoryMenu();
        if ((await toggle.getAttribute('aria-checked')) === 'true') await toggle.click();
        await page.waitForTimeout(3000);
    } catch { /* best effort */ }
}
await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS: ${problems.join(', ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
