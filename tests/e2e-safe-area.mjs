// Full app shown on a notched phone: it stays out of the status bar (top safe area) and the home indicator.
// Chromium's safe-area override (CDP Emulation.setSafeAreaInsetsOverride) stands in for the iPhone.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const shot = process.argv.slice(5).find(a => a.endsWith('.png'));
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
try {
    const cdp = await context.newCDPSession(page);
    let emulated = true;
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34, left: 0, right: 0 } }).catch(e => { emulated = false; console.log('no safe-area override:', e.message); });
    const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
    if (!(await page.request.post(`${base}/api/users/login`, { headers: { 'X-CSRF-Token': token }, data: { handle, password } })).ok()) throw new Error('login failed');
    await page.goto(`${base}/scripts/extensions/third-party/emmalike/app/`);
    await page.locator('iframe.engine').waitFor({ state: 'attached', timeout: 60000 });
    await page.waitForFunction(() => !!document.querySelector('iframe.engine')?.contentDocument?.querySelector('#top-settings-holder'), null, { timeout: 240000 });
    const opened = true;
    await page.evaluate(() => document.querySelector('iframe.engine').classList.add('visible'));
    await page.waitForTimeout(500);
    const box = await page.evaluate(() => {
        const f = document.querySelector('iframe.engine.visible');
        const r = f.getBoundingClientRect(), s = getComputedStyle(f);
        return { top: r.top, height: r.height, bt: parseFloat(s.borderTopWidth), bb: parseFloat(s.borderBottomWidth), inner: f.clientHeight, vh: innerHeight };
    });
    console.log('frame', JSON.stringify(box), 'emulated', emulated, 'opened', opened);
    if (emulated) {
        check('full app starts below the status bar', box.bt === 47, box);
        check('full app ends above the home indicator', box.bb === 34, box);
        check('full app content fills the rest', Math.abs(box.inner - (box.height - 81)) <= 1, box);
        // Something in the full app's top bar is hit at its own top edge, not covered.
        const hit = await page.evaluate(() => {
            const f = document.querySelector('iframe.engine.visible');
            const doc = f.contentDocument, bar = doc.querySelector('#top-settings-holder, #top-bar');
            if (!bar) return { none: true };
            const r = bar.getBoundingClientRect(), fr = f.getBoundingClientRect();
            return { barTopOnScreen: fr.top + parseFloat(getComputedStyle(f).borderTopWidth) + r.top };
        });
        check('full app top bar is below the status bar', hit.barTopOnScreen >= 47, hit);
    } else {
        check('without safe areas the frame has no border', box.bt === 0 && box.bb === 0 && box.inner === box.vh, box);
    }
    if (shot) await page.screenshot({ path: shot });
} finally {
    await browser.close();
}
const failed = results.filter(ok => !ok).length;
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
