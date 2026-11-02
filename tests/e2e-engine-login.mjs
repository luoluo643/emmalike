// The full app's page loading while the session ends, and a slow or failed load, on an official SillyTavern with only
// tavern-lite: signed out is said at once (not after the 4 minute limit) and signing in again gets the full app ready;
// a slow load offers "为什么慢" and a failed one "可能原因", each opening the usual reasons inside the same line,
// which still fits a 320px screen.
// Usage: node e2e-engine-login.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `登录${run}`, FILE = `登录-${run}`;
const problems = [];
const check = (name, ok, detail = '') => { if (!ok) problems.push(name); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
// The daily update check (20 seconds after opening) would also meet the ended session; a reader who has had it today
// does not get it, so it is marked done here and only the full app's page can tell.
await context.addInitScript(() => { try { localStorage.setItem('tavern-lite:update-checked', String(Date.now())); } catch { } });
const page = await context.newPage();
page.setDefaultTimeout(30000);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
const token = async () => (await (await page.request.get(`${base}/csrf-token`)).json()).token;
const post = async (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': await token() }, data });
const login = async () => { if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed'); };
await login();
console.log('SillyTavern', (await (await page.request.get(`${base}/version`)).json()).pkgVersion);
const created = await page.request.post(`${base}/api/characters/create`, { headers: { 'X-CSRF-Token': await token() },
    multipart: { ch_name: NAME, description: '', first_mes: '你来了。', personality: '', scenario: '', mes_example: '', creator_notes: '',
        system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' } });
const avatar = (await created.text()).trim();
const now = new Date().toISOString();
await post('/api/chats/save', { ch_name: NAME, file_name: FILE, avatar_url: avatar, force: true, chat: [
    { user_name: 'User', character_name: NAME, create_date: now, chat_metadata: {} },
    { name: NAME, is_user: false, mes: '你来了。', send_date: now, extra: {} },
] });

const readerUrl = `${appUrl}#${new URLSearchParams({ chat: avatar, file: FILE })}`;
const status = () => page.locator('.tl-engine-status');
const ready = (timeout = 240000) => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout })
    .then(() => true, () => false);
const fresh = async () => { await context.unrouteAll({ behavior: 'wait' }); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('about:blank'); };
// The full app's own page (the hidden frame), not the shell or anything else at the site root.
const isFullAppPage = request => request.isNavigationRequest() && request.frame() !== page.mainFrame() && new URL(request.url()).pathname === '/';
const fits = () => page.evaluate(() => {
    const box = document.querySelector('.tl-engine-status')?.getBoundingClientRect();
    return !!box && box.left >= 0 && box.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
});

try {
    // 1. The session ends while the full app's page is on its way: told at once, and signing in again gets it ready.
    await fresh();
    let held = 0;
    await context.route(`${base}/**`, async route => {
        if (!isFullAppPage(route.request())) return route.fallback();
        // Only once the shell has the account and the story open, so it is the full app that meets the login page.
        if (!held++) {
            await page.locator('.tl-composer-input').waitFor({ timeout: 30000 }).catch(() => {});
            await post('/api/users/logout', {});
        }
        return route.continue();
    });
    const refused = [];
    const noteRefused = response => {
        if (![401, 403].includes(response.status())) return;
        let where = '?';
        try { where = response.frame() === page.mainFrame() ? 'shell' : 'full app'; } catch { /* a worker's request */ }
        refused.push(`${response.status()} ${new URL(response.url()).pathname} ${where} +${Math.round((Date.now() - t0) / 1000)}s`);
    };
    page.on('response', noteRefused);
    const t0 = Date.now();
    await page.goto(readerUrl);
    const told = await page.locator('.tl-login').waitFor({ timeout: 60000 }).then(() => true, () => false);
    const waited = Math.round((Date.now() - t0) / 1000);
    page.off('response', noteRefused);
    console.log('signed out after', waited, 's; refused:', refused.slice(0, 6).join(' | ') || 'none');
    check('signed out while loading brings back the login page', told, JSON.stringify({ held, url: page.url() }));
    check('it is said soon, not after the 4 minute limit', told && waited < 40, `${waited}s`);
    check('the reason is said in words', await page.getByText('登录过期了').first().isVisible().catch(() => false));
    await page.screenshot({ path: '/tmp/tl-engine-login-signed-out.png' });
    await context.unrouteAll({ behavior: 'wait' });
    await page.locator('.tl-login input[autocomplete="username"]').fill(handle);
    await page.locator('.tl-login input[type="password"]').fill(password);
    await page.locator('.tl-login button.tl-primary').click();
    await page.locator('.tl-login').waitFor({ state: 'detached' }).catch(() => {});
    await page.goto(readerUrl);
    const again = await ready(90000);
    if (!again) console.log('not ready:', JSON.stringify({ status: await status().innerText().catch(() => ''), url: page.url(), frames: page.frames().map(f => f.url()) }));
    check('after signing in again the full app gets ready', again);
    check('no failure is left after signing in', !(await page.locator('.tl-engine-status[data-state="failed"]').count()));

    // 2. A slow load: "为什么慢" after a while, opening the reasons inside the same line.
    await fresh();
    await context.route('**/api/settings/get', async route => { await new Promise(r => setTimeout(r, 40000)); return route.continue().catch(() => {}); });
    await page.goto(readerUrl);
    const why = status().getByRole('button', { name: '为什么慢' });
    check('a quick moment shows no button yet', !(await why.isVisible().catch(() => false)));
    check('a slow load offers 为什么慢', await why.waitFor({ timeout: 30000 }).then(() => true, () => false));
    await why.click();
    const reasons = await page.locator('.tl-engine-why').innerText().catch(() => '');
    check('the reasons open in the same line', reasons.includes('网络慢或不稳') && reasons.includes('加载的扩展'), reasons);
    check('the line says the button is open', (await why.getAttribute('aria-expanded')) === 'true');
    check('opened, it fits a 390px screen', await fits());
    await page.screenshot({ path: '/tmp/tl-engine-why-loading-390.png' });
    await page.setViewportSize({ width: 320, height: 640 });
    check('opened, it fits a 320px screen', await fits());
    await page.screenshot({ path: '/tmp/tl-engine-why-loading-320.png' });
    await why.click();
    check('it closes again', !(await page.locator('.tl-engine-why').count()));
    check('the slow load still gets ready', await ready());
    check('ready, the button is gone', !(await why.count()));

    // 3. A failed load: "可能原因" next to the retry, and the retry still works.
    await fresh();
    await context.route('**/api/settings/get', route => route.abort('connectionreset'));
    await page.goto(readerUrl);
    const failed = await page.locator('.tl-engine-status[data-state="failed"]').waitFor({ timeout: 60000 }).then(() => true, () => false);
    check('a dropped request fails as before', failed);
    const cause = status().getByRole('button', { name: '可能原因' });
    check('a failed load offers 可能原因', await cause.isVisible().catch(() => false));
    await cause.click();
    const failedReasons = await page.locator('.tl-engine-why').innerText().catch(() => '');
    check('the failed reasons point to the retry', failedReasons.includes('重试'), failedReasons);
    await page.setViewportSize({ width: 320, height: 640 });
    check('failed and opened, it fits a 320px screen', await fits());
    await page.screenshot({ path: '/tmp/tl-engine-why-failed-320.png' });
    await context.unrouteAll({ behavior: 'wait' });
    await status().getByRole('button', { name: '重试' }).click();
    check('the retry gets ready', await ready());

    // The full app's own first load throws when the test cuts its settings request.
    const unexpected = pageErrors.filter(e => !/^TypeError: (Failed to fetch|NetworkError)/.test(e));
    check('no unexpected page errors', !unexpected.length, unexpected.join('\n'));
} finally {
    await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await login().catch(() => {});
    await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => {});
    await browser.close();
}
console.log(problems.length ? `FAILED ${problems.length}: ${problems.join('; ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
