// The loading screen shows this build's theme. index.html applies a stored copy of the look before any code loads; that
// copy used to change only when a setting did, so a fixed theme picture never reached the loading screen.
// Usage: node e2e-boot-look.mjs <baseUrl> <handle> <password> [latencyMs] [downKbps]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const results = {};
const problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`; if (!ok) problems.push(name); };

const OLD_PICTURE = '/scripts/extensions/third-party/emmalike/skins/mountain.webp';
const NEW_PICTURE = '#e8d9bb';  // the colour of the theme chosen below
// What a phone stored when it last changed a setting, before the picture's top edge was fixed.
const OLD_LOOK = `:root { --tl-bg: #eaeeea; }\n:root { --tl-bg-image: linear-gradient(180deg, #f2f4f1, #e6ebe7), url("${OLD_PICTURE}") center bottom / 100% auto no-repeat; --tl-bg-size: cover; }`;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const finish = async code => {
    console.log(JSON.stringify({ results }, null, 1));
    await browser.close();
    console.log(problems.length ? `PROBLEMS ${problems.length}` : 'ALL PASS');
    process.exit(code);
};
process.on('uncaughtException', async error => {
    console.log('FAILURE', error.message.split('\n')[0], (error.stack ?? '').split('\n').find(l => l.includes('e2e-boot-look')));
    await finish(2);
});
const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
if (!(await page.request.post(`${base}/api/users/login`, { headers: { 'X-CSRF-Token': token }, data: { handle, password } })).ok()) throw new Error('login failed');

const pictures = [];
await context.route('**/skins/*.webp', route => {
    pictures.push(new URL(route.request().url()).pathname.split('/').pop());
    return route.fulfill({ status: 200, contentType: 'image/webp', body: Buffer.alloc(0) });
});
const key = part => `tavern-lite:appearance:v1:${JSON.stringify(handle)}:${part}`;
const seed = stored => page.evaluate(([owner, entries]) => {
    localStorage.clear();
    localStorage.setItem('tavern-lite:display-owner', owner);
    for (const [k, v] of entries) localStorage.setItem(k, v);
}, [handle, stored]);
const lookNow = () => page.evaluate(() => document.getElementById('tl-reading-css')?.textContent ?? '');
const storedPart = part => page.evaluate(k => localStorage.getItem(k), key(part));

// --- 1. The first launch after this update, on a phone holding the old copy ---------------------------------------------
// Seeded from a page that runs no app code, or the app would store its own look first.
await page.goto(`${appUrl}manifest.webmanifest`);
await seed([[key('reading'), JSON.stringify({ theme: 'sepia' })], [key('reading-css'), OLD_LOOK], [key('updated'), '1']]);
pictures.length = 0;

// Hold the code and the account back: what shows then is what the page's first script applied.
let releaseCode, releaseUser;
const codeHeld = new Promise(r => { releaseCode = r; }), userHeld = new Promise(r => { releaseUser = r; });
await context.route('**/app/assets/index-*.js', async route => { await codeHeld; await route.fallback(); });
await context.route('**/api/users/me', async route => { await userHeld; await route.fallback(); });
await page.goto(appUrl, { waitUntil: 'commit' });
await page.waitForFunction(() => !!document.getElementById('tl-reading-css'), null, { timeout: 30000 });
const beforeCode = await lookNow();
check('before the code loads the old copy shows its colours', beforeCode.includes('--tl-bg: #eaeeea'), beforeCode.slice(0, 120));
check('before the code loads the old picture is left out', !beforeCode.includes('/skins/'), beforeCode.slice(0, 200));
await page.waitForTimeout(800);
check('the old picture is not requested before the code loads', !pictures.includes('mountain.webp'), pictures.join());

// The code is in, the account still on its way: the loading screen of the screenshot.
releaseCode();
await page.waitForFunction(pic => (document.getElementById('tl-reading-css')?.textContent ?? '').includes(pic), NEW_PICTURE, { timeout: 60000 })
    .then(() => check('as soon as the code runs the loading screen has this build\'s theme', true))
    .catch(async () => check('as soon as the code runs the loading screen has this build\'s theme', false, (await lookNow()).slice(0, 200)));
check('the account has not answered yet at that point', await page.evaluate(() => !!document.querySelector('.tl-boot')));
check('the stored copy is replaced at once', (await storedPart('look-css') ?? '').includes(NEW_PICTURE), String(await storedPart('look-css')).slice(0, 120));
await page.waitForTimeout(800);
check('the old picture is never requested', !pictures.includes('mountain.webp'), pictures.join());
releaseUser();
await page.locator('.tl-library').waitFor({ timeout: 240000 }).catch(() => { });
check('still this build\'s theme once signed in', (await lookNow()).includes(NEW_PICTURE));
check('the reader\'s choice of theme is kept', JSON.parse(await storedPart('reading')).theme === 'sepia');

// --- 2. The next launch: the picture is right from the first script on ---------------------------------------------------
const next = new Promise(r => { releaseCode = r; });
await context.unroute('**/app/assets/index-*.js');
await context.route('**/app/assets/index-*.js', async route => { await next; await route.fallback(); });
pictures.length = 0;
await page.goto(appUrl, { waitUntil: 'commit' });
await page.waitForFunction(() => !!document.getElementById('tl-reading-css'), null, { timeout: 30000 });
check('next launch: the first script already has this build\'s picture', (await lookNow()).includes(NEW_PICTURE), (await lookNow()).slice(0, 200));
releaseCode();

// --- 3. Nobody stored anything: nothing breaks and no theme is made up ----------------------------------------------------
await page.waitForTimeout(500);
await seed([]);
await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
await page.locator('.tl-library').waitFor({ timeout: 240000 }).catch(() => { });
check('a browser with nothing stored still opens', await page.locator('.tl-library').count() > 0);

await finish(problems.length ? 1 : 0);
