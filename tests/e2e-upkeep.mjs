// 我的 → 酒馆助手 and 检查更新, on an official SillyTavern with only tavern-lite installed:
// - Tavern Helper is named with its author, official repository and license, and really installs from GitHub
//   (removed again at the end);
// - tavern-lite copied in by hand (as here) is said not to be updatable from the page;
// - with the server answering that a newer version is in the repository (stood in for: the git pull itself is
//   SillyTavern's own code), 更新 calls the update endpoint for tavern-lite's own folder and offers a reload, and the
//   daily check says so once per version.
// Usage: node e2e-upkeep.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const problems = [], pageErrors = [];
const check = (name, ok, detail = '') => { if (!ok) problems.push(name); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : String(detail).slice(0, 400)); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript(() => {
    window.__tlToasts = [];
    new MutationObserver(rs => { for (const r of rs) for (const n of r.addedNodes) if (n.classList?.contains('tl-toast')) window.__tlToasts.push(n.textContent); })
        .observe(document, { childList: true, subtree: true });
});
const page = await context.newPage();
page.setDefaultTimeout(30000);
page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 200)));
const token = (await (await page.request.get(`${base}/csrf-token`)).json()).token;
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const discover = async () => (await (await page.request.get(`${base}/api/extensions/discover`)).json()).map(x => x.name);
const helperFolder = 'JS-Slash-Runner';
const helperWasThere = (await discover()).some(n => n.endsWith(`/${helperFolder}`));
const openMe = async () => {
    await page.goto(appUrl + '#me');
    await page.getByRole('button', { name: /^检查更新/ }).waitFor({ timeout: 60000 });
};
const sheet = title => page.getByRole('dialog', { name: title });

try {
    // --- 酒馆助手 ---------------------------------------------------------------------------------------------------
    await openMe();
    await page.getByRole('button', { name: /^酒馆助手/ }).click();
    const helper = sheet('酒馆助手');
    await helper.waitFor();
    const text = await helper.innerText();
    check('helper: names the author, the official repository and the license', text.includes('KAKAA') && text.includes('github.com/N0VI028/JS-Slash-Runner')
        && text.includes('PolyForm Noncommercial License 1.0.0') && text.includes('不附带'), text.slice(0, 300));
    if (helperWasThere) {
        check('helper: an installed Tavern Helper is not offered again', (await helper.innerText()).includes('不用再装') || (await helper.innerText()).includes('停用'), await helper.innerText());
    } else {
        await helper.getByRole('button', { name: /^安装酒馆助手/ }).click();
        await helper.getByRole('button', { name: '重新载入', exact: true }).waitFor({ timeout: 180000 }).catch(() => { });
        const installed = (await discover()).some(n => n.endsWith(`/${helperFolder}`));
        check('helper: installs from the official repository', installed, await helper.innerText());
        check('helper: says it takes effect after a reload', (await helper.innerText()).includes('重新载入'), await helper.innerText());
        if (installed) await post('/api/extensions/delete', { extensionName: helperFolder, global: false });
    }
    await page.getByRole('dialog').last().getByRole('button', { name: '关闭' }).click();

    // --- 检查更新: copied in by hand ------------------------------------------------------------------------------
    await page.getByRole('button', { name: /^检查更新/ }).click();
    const updates = sheet('检查更新');
    await updates.getByText(/不是从 GitHub 安装的|已是最新版本|更新到新版本|没能检查更新/).first().waitFor({ timeout: 60000 });
    check('update: a copy not installed from git is said not to be updatable here', (await updates.innerText()).includes('不是从 GitHub 安装的'), await updates.innerText());
    await page.getByRole('dialog').last().getByRole('button', { name: '关闭' }).click();

    // --- 检查更新: a newer version in the repository (server answers stood in for) ------------------------------
    const calls = [];
    await context.route('**/api/extensions/version', async route => {
        calls.push({ path: 'version', body: route.request().postDataJSON() });
        return route.fulfill({ json: { currentBranchName: 'main', currentCommitHash: '1234567abcdef', isUpToDate: false, remoteUrl: 'https://github.com/someone/tavern-lite' } });
    });
    await context.route('**/api/extensions/update', async route => {
        calls.push({ path: 'update', body: route.request().postDataJSON() });
        return route.fulfill({ json: { shortCommitHash: '89abcde', isUpToDate: false, remoteUrl: 'https://github.com/someone/tavern-lite' } });
    });
    await context.route('https://raw.githubusercontent.com/someone/tavern-lite/main/manifest.json', route => route.fulfill({ json: { version: '9.9.9' } }));
    await page.getByRole('button', { name: /^检查更新/ }).click();
    await updates.getByRole('button', { name: /^更新到新版本/ }).waitFor({ timeout: 30000 });
    check('update: shows the new version from the repository', (await updates.innerText()).includes('9.9.9'), await updates.innerText());
    check('update: asks about tavern-lite\'s own folder', calls.some(c => c.path === 'version' && c.body?.extensionName === 'emmalike'), JSON.stringify(calls));
    await updates.getByRole('button', { name: /^更新到新版本/ }).click();
    await updates.getByRole('button', { name: '重新载入', exact: true }).waitFor({ timeout: 30000 });
    const updateCall = calls.find(c => c.path === 'update');
    check('update: 更新 calls the update endpoint for tavern-lite, in the scope it is installed in', updateCall?.body?.extensionName === 'emmalike' && typeof updateCall.body.global === 'boolean', JSON.stringify(updateCall));
    await page.getByRole('dialog').last().getByRole('button', { name: '关闭' }).click();

    // The daily check: told once per version, then quiet.
    await page.evaluate(() => { localStorage.removeItem('tavern-lite:update-checked'); localStorage.removeItem('tavern-lite:update-notified'); });
    await page.goto('about:blank'); await page.goto(appUrl + '#me');
    // The daily check starts 20 seconds after the page opens.
    await page.waitForFunction(() => window.__tlToasts.some(t => t.includes('有新版本')), null, { timeout: 60000 }).catch(() => { });
    check('daily check: says a new version is there', await page.evaluate(() => window.__tlToasts.some(t => t.includes('9.9.9') && t.includes('检查更新'))), JSON.stringify(await page.evaluate(() => window.__tlToasts)));
    await page.evaluate(() => localStorage.removeItem('tavern-lite:update-checked'));
    await page.goto('about:blank'); await page.goto(appUrl + '#me');
    await page.getByRole('button', { name: /^检查更新/ }).waitFor({ timeout: 60000 });
    await page.waitForTimeout(30000);
    check('daily check: the same version is not said twice', !(await page.evaluate(() => window.__tlToasts.some(t => t.includes('有新版本')))), JSON.stringify(await page.evaluate(() => window.__tlToasts)));
    await context.unrouteAll({ behavior: 'wait' });
} catch (error) {
    check('no exception', false, String(error.message).split('\n')[0]);
    if (process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT }).catch(() => { });
} finally {
    if (!helperWasThere && (await discover().catch(() => [])).some(n => n.endsWith(`/${helperFolder}`))) await post('/api/extensions/delete', { extensionName: helperFolder, global: false }).catch(() => { });
    await browser.close();
}
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
if (problems.length) { console.log('PROBLEMS', problems.join(' | ')); process.exit(1); }
console.log('ALL PASS');
