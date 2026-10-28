// The "正在准备" status line on a slow load: a countdown only while it holds, then how long the reader has waited;
// slow loads that are given up still raise the device's estimate, early ones do not.
// Usage: node e2e-wait.mjs <baseUrl> <handle> <password> [shotPath]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, shot = ''] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const KEY = 'tavern-lite:engine-load-ms';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

async function open(expectedMs, { cpu = 4, width = 390 } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 760 }, isMobile: true, hasTouch: true });
    // Seed the device's estimate once; reloads keep whatever the page wrote.
    await context.addInitScript(([key, value]) => {
        if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem(key, value); }
    }, [KEY, String(expectedMs)]);
    const { token } = await (await context.request.get(`${base}/csrf-token`)).json();
    if (!(await context.request.post(`${base}/api/users/login`, { headers: { 'X-CSRF-Token': token }, data: { handle, password } })).ok()) throw new Error('login failed');
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    await page.goto(appUrl);
    await page.locator('.tl-character').first().click();
    await page.locator('.tl-message').first().waitFor({ timeout: 60000 });
    return { context, page };
}

const statusText = page => page.locator('.tl-engine-status[data-state="loading"]').innerText({ timeout: 3000 }).catch(() => '');
const stored = page => page.evaluate(key => Number(localStorage.getItem(key)), KEY);

// Watches the status until the full app is ready, returning every distinct text with the time it first showed.
async function watch(page, ms = 240000) {
    const seen = [];
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const text = await statusText(page);
        if (!text && await page.evaluate(() => !!document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge)) break;
        if (text && seen.at(-1)?.text !== text) seen.push({ at: Date.now() - t0, text });
        await page.waitForTimeout(200);
    }
    return { seen, total: Date.now() - t0 };
}

// 1. Estimate shorter than this load: no frozen "约 1 秒"; the wait is shown and grows; the estimate rises after.
{
    const { context, page } = await open(1500);
    const { seen } = await watch(page);
    const texts = seen.map(s => s.text.split(' · ')[0]);
    console.log('  seen:', JSON.stringify(texts.slice(0, 4)), '…', JSON.stringify(texts.slice(-2)));
    const slow = texts.filter(t => t.startsWith('正在准备，已等 '));
    check('slow load says how long it has waited', slow.length >= 2, `${slow.length} texts`);
    const secs = slow.map(t => { const m = t.match(/已等 (?:(\d+) 分(?:钟)?)? ?(?:(\d+) 秒)?$/); return Number(m?.[1] ?? 0) * 60 + Number(m?.[2] ?? 0); });
    check('the waited time goes up', secs.every((s, i) => i === 0 || s > secs[i - 1]), secs.join(','));
    const lastCountdown = seen.filter(s => /约 \d+ 秒/.test(s.text)).at(-1);
    check('no countdown once past the estimate', !lastCountdown || lastCountdown.at < 3000, lastCountdown ? `${lastCountdown.text} @${lastCountdown.at}ms` : 'none');
    const after = await stored(page);
    check('a finished slow load raises the estimate', after > 1500, String(after));
    await context.close();
}

// 2. A slow load given up (reload) raises the estimate; 3. one given up early leaves it alone.
{
    const { context, page } = await open(1500);
    await page.waitForFunction(() => /正在准备，已等 (?:\d+ 分|[3-9] 秒|\d{2,} 秒)/.test(document.querySelector('.tl-engine-status')?.textContent ?? ''), null, { timeout: 60000 });
    await page.reload();
    const after = await stored(page);
    check('a slow load given up still raises the estimate', after >= 2500, String(after));
    await context.close();
}
{
    const { context, page } = await open(600000);
    await page.locator('.tl-engine-status[data-state="loading"]').waitFor({ timeout: 30000 });
    const text = await statusText(page);
    check('a long estimate counts down', /^正在准备，约 \d+ 秒/.test(text), text);
    await page.reload();
    const after = await stored(page);
    check('a load given up early does not change the estimate', after === 600000, String(after));
    await context.close();
}

// 4. Narrow phone: the longest text stays on one line.
{
    const { context, page } = await open(1000, { width: 320 });
    await page.waitForFunction(() => /已等 \d+ 秒/.test(document.querySelector('.tl-engine-status')?.textContent ?? ''), null, { timeout: 60000 });
    const box = await page.locator('.tl-engine-status').boundingBox();
    const text = page.locator('.tl-engine-status[data-state="loading"] > span').first();
    const oneLine = await text.evaluate(el => {
        const style = getComputedStyle(el);
        return el.scrollHeight <= (parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4) * 1.5;
    });
    const cut = await text.evaluate(el => el.scrollWidth > el.clientWidth);
    check('status stays one line at 320px', !!box && box.width <= 320 - 32 + 1 && oneLine && box.height < 36, `${Math.round(box?.width)}px wide, ${Math.round(box?.height)}px high, text cut: ${cut}`);
    if (shot) await page.screenshot({ path: shot });
    await context.close();
}

await browser.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
