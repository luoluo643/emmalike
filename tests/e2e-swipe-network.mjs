// "换个回复" over an unreliable phone network, on an official SillyTavern with only tavern-lite: the tap shows at once
// that a new reply is coming, a dropped or failed account check is tried again, a network that stays down is reported
// in plain words (never the browser's "Failed to fetch" / "Load failed"), and the next tap works.
// Usage: node e2e-swipe-network.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `换回复${run}`, FILE = `换回复-${run}`;
const results = {}, problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 400); if (!ok) problems.push(name); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript(() => {
    window.__tlToasts = [];
    new MutationObserver(rs => { for (const r of rs) for (const n of r.addedNodes) if (n.classList?.contains('tl-toast')) window.__tlToasts.push(n.textContent); })
        .observe(document, { childList: true, subtree: true });
});
const page = await context.newPage();
page.setDefaultTimeout(30000);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const version = (await (await page.request.get(`${base}/version`)).json()).pkgVersion;
console.log('SillyTavern', version);
const created = await page.request.post(`${base}/api/characters/create`, { headers: { 'X-CSRF-Token': token },
    multipart: { ch_name: NAME, description: '', first_mes: '你来了。', personality: '', scenario: '', mes_example: '', creator_notes: '',
        system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' } });
const avatar = (await created.text()).trim();
const now = new Date().toISOString();
const story = [
    { name: NAME, is_user: false, mes: '你来了。' },
    { name: 'User', is_user: true, mes: '外面下雨了吗？' },
    { name: NAME, is_user: false, mes: '下了一整夜。', swipes: ['下了一整夜。'], swipe_id: 0, swipe_info: [{ send_date: now, extra: {} }] },
].map(m => ({ ...m, send_date: now, extra: {} }));
await post('/api/chats/save', { ch_name: NAME, file_name: FILE, avatar_url: avatar, chat: [{ user_name: 'User', character_name: NAME, create_date: now, chat_metadata: {} }, ...story], force: true });

const lastChar = () => page.locator('.tl-message[data-role="char"]').last();
const swipeCount = () => lastChar().locator('.tl-swipe-count').innerText().catch(() => '');
const idle = () => page.locator('.tl-send').waitFor({ timeout: 120000 });
const toasts = () => page.evaluate(() => window.__tlToasts.slice());
const waitCount = text => page.waitForFunction(t => [...document.querySelectorAll('.tl-message[data-role="char"] .tl-swipe-count')].pop()?.textContent === t, text, { timeout: 120000 });
// The account check passed moments ago is reused for 2 seconds; wait past that so each tap checks over the network.
const tap = async () => { await idle(); await page.waitForTimeout(2600); await lastChar().getByRole('button', { name: '生成新回复' }).click(); };
let meCalls = 0;
const routeMe = handler => context.route('**/api/users/me', route => { meCalls++; return handler(route); });

try {
    await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: FILE })}`);
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    await lastChar().locator('.tl-swipe').waitFor();

    // 1. A slow check: the tap says at once that a new reply is coming.
    await routeMe(async route => { await new Promise(r => setTimeout(r, 3000)); return route.continue(); });
    await tap();
    const shown = await page.getByRole('status').filter({ hasText: '正在换一个回复' }).waitFor({ timeout: 1000 }).then(() => true).catch(() => false);
    check('the tap shows at once that a new reply is coming', shown);
    await page.screenshot({ path: '/tmp/tl-swipe-feedback.png' });
    await waitCount('2/2');
    check('the slow check still gives a new reply', (await swipeCount()) === '2/2', await swipeCount());
    await context.unrouteAll({ behavior: 'wait' });

    // 2. One dropped connection: tried again, the reply comes, no error.
    let dropped = 0;
    await routeMe(route => dropped++ ? route.continue() : route.abort('failed'));
    const before2 = (await toasts()).length;
    await tap();
    await waitCount('3/3').catch(() => {});
    check('a dropped account check is tried again and the reply comes', (await swipeCount()) === '3/3' && (await toasts()).length === before2,
        JSON.stringify({ count: await swipeCount(), toasts: (await toasts()).slice(before2) }));
    await context.unrouteAll({ behavior: 'wait' });

    // 3. A gateway error (the server restarting): tried again, not taken for a changed account.
    let bad = 0;
    await routeMe(route => bad++ ? route.continue() : route.fulfill({ status: 502, body: 'Bad Gateway' }));
    const before3 = (await toasts()).length;
    await tap();
    await waitCount('4/4').catch(() => {});
    check('a gateway error is tried again, not taken for another account', (await swipeCount()) === '4/4' && (await toasts()).length === before3,
        JSON.stringify({ count: await swipeCount(), toasts: (await toasts()).slice(before3) }));
    await context.unrouteAll({ behavior: 'wait' });

    // 4. The network stays down: plain words, nothing generated, and the next tap works.
    await routeMe(route => route.abort('failed'));
    const before4 = (await toasts()).length;
    await tap();
    await page.waitForFunction(n => window.__tlToasts.length > n, before4, { timeout: 30000 }).catch(() => {});
    const said = (await toasts()).slice(before4).join(' | ');
    check('a network that stays down is said in plain words', /网络/.test(said) && !/Failed to fetch|Load failed/.test(said), said);
    check('nothing was generated', (await swipeCount()) === '4/4', await swipeCount());
    await page.screenshot({ path: '/tmp/tl-swipe-offline.png' });
    await context.unrouteAll({ behavior: 'wait' });
    await tap();
    await waitCount('5/5').catch(() => {});
    check('the next tap works once the network is back', (await swipeCount()) === '5/5', JSON.stringify({ count: await swipeCount(), toasts: (await toasts()).slice(before4) }));
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
    problems.push('crashed');
    console.log('FAILURE', error.stack);
    await page.screenshot({ path: '/tmp/tl-swipe-fail.png' }).catch(() => { });
}
console.log('account checks over the network:', meCalls);
await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS: ${problems.join(', ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
