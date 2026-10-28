// A sheet as tall as the screen stays below the status bar (iPhone notch / Dynamic Island): its title and close button
// can be tapped. Chromium's safe-area override stands in for the iPhone. Usage: node e2e-sheet-top.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `顶部测试${run}`;
const TOP = 59;
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
let avatar = '';
try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: TOP, bottom: 34, left: 0, right: 0 } });
    if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
    const created = await page.request.post(`${base}/api/characters/create`, {
        headers: { 'X-CSRF-Token': token },
        multipart: {
            ch_name: NAME, description: '测试面板顶部', first_mes: '“你来了。”', personality: '', scenario: '', mes_example: '',
            creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '',
        },
    });
    avatar = (await created.text()).trim();
    if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);
    await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: '' })}`);
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    const inset = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top)';
        document.body.append(probe);
        const h = probe.getBoundingClientRect().height;
        probe.remove();
        return h;
    });
    check('safe-area override applies', inset === TOP, inset);

    // The 番外与平行线 sheet is allowed the whole screen height.
    await page.getByRole('button', { name: '番外与平行线' }).click();
    const sheet = page.getByRole('dialog', { name: '番外与平行线' });
    await sheet.waitFor();
    // Long content, so the sheet grows to its largest.
    await page.evaluate(() => {
        const body = document.querySelector('.tl-episodes-sheet .tl-episodes-body') ?? document.querySelector('.tl-episodes-sheet');
        const filler = document.createElement('div');
        filler.style.height = '3000px';
        body.append(filler);
    });
    await page.waitForTimeout(400);
    const box = await page.evaluate(() => {
        const s = document.querySelector('.tl-episodes-sheet').getBoundingClientRect();
        const close = document.querySelector('.tl-episodes-sheet .tl-sheet-close').getBoundingClientRect();
        return { sheetTop: s.top, closeTop: close.top };
    });
    check('tall sheet starts below the status bar', box.sheetTop >= TOP, box);
    check('close button is below the status bar', box.closeTop >= TOP, box);
    await sheet.getByRole('button', { name: '关闭' }).click();
    await sheet.waitFor({ state: 'detached', timeout: 5000 }).then(() => check('close button closes the sheet', true))
        .catch(() => check('close button closes the sheet', false, 'still open'));
} finally {
    if (avatar) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
    await browser.close();
}
console.log(results.every(Boolean) ? 'ALL PASS' : 'PROBLEMS');
process.exit(results.every(Boolean) ? 0 : 1);
