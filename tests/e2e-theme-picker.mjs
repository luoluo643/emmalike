// The full-screen theme picker: open from the shelf, browse, sample story, swipe, cancel restores, 使用 keeps it
// across a reload, and the reading sheet opens the same picker. Usage: node e2e-theme-picker.mjs <baseUrl>
// (screenshots go to TEST_OUTPUT, default /tmp). Exits 1 if any check fails.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const base = process.argv[2] ?? 'http://127.0.0.1:8031';
const out = process.env.TEST_OUTPUT ?? '/tmp';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
await page.request.post(`${base}/api/users/login`, { headers: { 'X-CSRF-Token': token }, data: { handle: 'default-user', password: 'test1234' } });
const app = `${base}/scripts/extensions/third-party/emmalike/app/`;
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tl-bg').trim());
const shot = name => page.screenshot({ path: `${out}/pk-${name}.png` });
const picker = page.locator('.tl-picker');
const title = () => picker.locator('.tl-picker-title strong').innerText();

await page.goto(app);
await page.locator('.tl-library .tl-character').first().waitFor({ timeout: 60000 });
const before = await bg();
const entry = page.getByRole('button', { name: '换主题' });
check('shelf has the theme entry', await entry.isVisible());
await entry.click();
await picker.waitFor();
await shot('1-open');
check('picker opens on the theme in use', (await title()).length > 0, await title());

for (let i = 0; i < 30 && (await title()) !== '墨蓝'; i++) await page.getByRole('button', { name: '下一个主题' }).click();
await page.waitForTimeout(500);
check('next arrow reaches 墨蓝', (await title()) === '墨蓝');
check('app shows the theme being browsed', (await bg()) !== before, `${before} -> ${await bg()}`);
await shot('2-star-shelf');

await page.getByRole('radio', { name: '阅读样张' }).click();
await page.locator('.tl-picker-story .tl-message').first().waitFor();
await page.waitForTimeout(400);
await shot('3-star-story');
check('sample story shows', await page.locator('.tl-picker-story .tl-message').count() >= 3);

const stage = picker.locator('.tl-picker-stage');
const box = await stage.boundingBox();
const name0 = await title();
await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.52, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(500);
check('swiping left goes to the next theme', (await title()) !== name0, `${name0} -> ${await title()}`);
await shot('4-swiped-story');

await picker.getByRole('button', { name: '取消' }).click();
await picker.waitFor({ state: 'detached' });
await page.waitForTimeout(300);
check('取消 puts the theme in use back', (await bg()) === before, `${await bg()} vs ${before}`);

await entry.click();
await picker.waitFor();
await picker.getByRole('radio', { name: '夜间', exact: true }).click();
await page.waitForTimeout(400);
await shot('5-night-shelf');
const nightBg = await bg();
await picker.getByRole('button', { name: '使用' }).click();
await picker.waitFor({ state: 'detached' });
await page.waitForTimeout(3500);
await page.reload();
await page.locator('.tl-library .tl-character').first().waitFor({ timeout: 60000 });
check('使用 keeps the theme after a reload', (await bg()) === nightBg, `${await bg()} vs ${nightBg}`);
await shot('6-night-after-reload');

await page.locator('.tl-library .tl-character').first().click();
await page.locator('.tl-message').first().waitFor({ timeout: 60000 });
await page.getByRole('button', { name: '阅读设置' }).click();
await page.getByRole('button', { name: '全屏预览所有主题' }).click();
await picker.waitFor();
await page.waitForTimeout(400);
await shot('7-from-reader');
check('reading settings open the same picker', await picker.isVisible());
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
check('Escape closes the picker', !(await picker.isVisible().catch(() => false)));
check('no page errors', errors.length === 0, errors.join(' | '));

// back to the default theme so other runs start clean
await page.goto(app);
await page.locator('.tl-library .tl-character').first().waitFor({ timeout: 60000 });
await entry.click();
await picker.waitFor();
await picker.getByRole('radio', { name: '跟随系统', exact: true }).click();
await picker.getByRole('button', { name: '使用' }).click();
await page.waitForTimeout(3500);
console.log(results.join('\n'));
await browser.close();
if (results.some(r => r.startsWith('FAIL'))) process.exit(1);
