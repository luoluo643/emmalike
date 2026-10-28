// Sheets that need the full app, opened while it is still preparing on a slow phone: they show the real wait (not
// "马上就好") and fill in by themselves once it is ready, without being opened again.
// Usage: node e2e-engine-wait-sheets.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const context = await browser.newContext({ viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true });
const { token } = await (await context.request.get(`${base}/csrf-token`)).json();
if (!(await context.request.post(`${base}/api/users/login`, { headers: { 'X-CSRF-Token': token }, data: { handle, password } })).ok()) throw new Error('login failed');
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e.message)));
// Slows the full app's own scripts so there is time to open sheets while it prepares.
await page.route(/\/scripts\/extensions\/third-party\/tavern-lite\/bridge\.js/, async route => { await new Promise(r => setTimeout(r, 12000)); await route.continue(); });
try {
    await page.goto(appUrl);
    await page.locator('.tl-character').first().click();
    await page.locator('.tl-message').first().waitFor({ timeout: 60000 });
    const preparing = await page.evaluate(() => !document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge);
    check('the full app is still preparing', preparing);

    // From 我的 (the story menu lists the model only once the app is ready).
    await page.evaluate(() => { location.hash = '#me'; });
    await page.getByRole('button', { name: /^模型与预设/ }).click();
    check('opened while still preparing', await page.evaluate(() => !document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge));
    const sheet = page.getByRole('dialog', { name: '模型与预设', exact: true });
    await sheet.waitFor();
    const early = await sheet.innerText();
    check('the sheet shows the real wait, not 马上就好', !early.includes('马上就好') && /正在准备|正在读取/.test(early), early.slice(0, 120));
    await page.waitForFunction(() => !!document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge, null, { timeout: 240000 });
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] .tl-sheet-item')].length > 0, null, { timeout: 30000 }).catch(() => { });
    const later = await sheet.innerText().catch(() => '');
    check('once ready the same sheet fills in by itself', await sheet.locator('.tl-sheet-item').count() > 0 && !/正在准备/.test(later), later.slice(0, 160));
    check('no page errors', errors.length === 0, errors.join(' | '));
} catch (error) {
    failed++;
    console.log('FAILURE', error.stack);
    await page.screenshot({ path: '/tmp/tl-engine-wait-sheets-fail.png' }).catch(() => { });
}
await browser.close();
console.log(failed ? `PROBLEMS: ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
