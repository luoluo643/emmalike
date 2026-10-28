// Skipping extensions in this device's lite shell: the chosen ones are not loaded in the full app, the account's own
// extension switches (settings.json on the server) never change, the original interface still loads everything, and
// switching them back on loads them again. Run on an official SillyTavern with only tavern-lite installed.
// Usage: node e2e-skip-extensions.mjs <baseUrl> <handle> <password> [shotPath]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, shotArg = ''] = process.argv.slice(2);
const shot = /.png$/.test(shotArg) ? shotArg : '';
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const SKIP = ['tts', 'translate'];
const ACCOUNT_OFF = 'caption';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.message ?? e).slice(0, 200)));
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const { token } = await (await context.request.get(`${base}/csrf-token`)).json();
if (!(await context.request.post(`${base}/api/users/login`, { headers: { 'X-CSRF-Token': token }, data: { handle, password } })).ok()) throw new Error('login failed');
const serverDisabled = async () => {
    const data = await (await context.request.post(`${base}/api/settings/get`, { headers: { 'X-CSRF-Token': token }, data: {} })).json();
    return JSON.parse(data.settings).extension_settings?.disabledExtensions ?? [];
};
const label = async name => (await (await context.request.get(`${base}/scripts/extensions/${name}/manifest.json`)).json()).display_name;

const ready = () => page.waitForFunction(() => !!document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge && !document.querySelector('.tl-engine-status[data-state="loading"]'), null, { timeout: 240000 });
const loaded = names => page.evaluate(list => {
    const doc = document.querySelector('iframe.engine').contentDocument;
    return Object.fromEntries(list.map(name => [name, !!doc.querySelector(`script[src^="/scripts/extensions/${name}/"]`)]));
}, names);
const engineDisabled = () => page.evaluate(() => [...document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().extensionSettings.disabledExtensions]);
const saveInEngine = async () => {
    await page.evaluate(() => document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().saveSettingsDebounced());
    await page.waitForTimeout(4000);
};
const sheet = () => page.getByRole('dialog', { name: '加载的扩展' });
const openSheet = async () => {
    await page.getByRole('button', { name: /^加载的扩展（仅本机）/ }).click();
    await sheet().getByRole('switch').first().waitFor({ timeout: 30000 });
};
const switchFor = name => sheet().getByRole('switch', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) });

const before = await serverDisabled();
const labels = Object.fromEntries(await Promise.all([...SKIP, ACCOUNT_OFF, 'regex'].map(async n => [n, await label(n)])));
console.log('  labels:', JSON.stringify(labels), 'account disabled before:', JSON.stringify(before));

await page.goto(`${appUrl}#me`);
await ready();
check('everything loads by default', Object.values(await loaded([...SKIP, 'regex'])).every(Boolean));

// Turn two system extensions off for this device, then reload the full app.
await openSheet();
const names = await sheet().getByRole('switch').allInnerTexts();
check('tavern lite itself is not offered', !names.some(t => /Tavern Lite|轻酒馆/.test(t)), `${names.length} switches`);
for (const name of SKIP) await switchFor(labels[name]).click();
check('switched off', (await Promise.all(SKIP.map(n => switchFor(labels[n]).getAttribute('aria-checked')))).every(v => v === 'false'));
check('stored per device', await page.evaluate(() => localStorage.getItem('tavern-lite:engine-skip-extensions')) === JSON.stringify(SKIP));
if (shot) await page.screenshot({ path: shot });
await sheet().getByRole('button', { name: '现在重新准备' }).click();
await page.waitForTimeout(1500);
await ready();
const afterSkip = await loaded([...SKIP, 'regex']);
check('skipped extensions are not loaded', SKIP.every(n => !afterSkip[n]), JSON.stringify(afterSkip));
check('the others still load', afterSkip.regex);
check('the full app keeps the account list after loading', JSON.stringify(await engineDisabled()) === JSON.stringify(before), JSON.stringify(await engineDisabled()));
await saveInEngine();
check('a settings save leaves the account switches as they were', JSON.stringify(await serverDisabled()) === JSON.stringify(before), JSON.stringify(await serverDisabled()));
check('the menu hint counts them', /已关掉 2 个/.test(await page.getByRole('button', { name: /^加载的扩展（仅本机）/ }).innerText()));

// The original interface (no lite shell around it) still loads everything for this account.
{
    const plain = await context.newPage();
    await plain.goto(`${base}/`);
    await plain.waitForFunction(() => !!window.SillyTavern?.getContext?.()?.characters?.length && !document.querySelector('.splash-screen'), null, { timeout: 240000 });
    await plain.waitForTimeout(2000);
    const native = await plain.evaluate(list => Object.fromEntries(list.map(name => [name, !!document.querySelector(`script[src^="/scripts/extensions/${name}/"]`)])), SKIP);
    check('the original interface still loads them', Object.values(native).every(Boolean), JSON.stringify(native));
    await plain.close();
}

// An extension switched off for the whole account shows as such and cannot be toggled here.
await page.evaluate(name => {
    const ctx = document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext();
    ctx.extensionSettings.disabledExtensions.push(name);
}, ACCOUNT_OFF);
await saveInEngine();
await openSheet();
const accountRow = switchFor(labels[ACCOUNT_OFF]);
check('account-disabled extension is marked and locked', await accountRow.isDisabled() && /账号里停用了/.test(await accountRow.innerText()));
await sheet().getByRole('button', { name: '关闭' }).click();
await page.evaluate(name => {
    const list = document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().extensionSettings.disabledExtensions;
    list.splice(list.indexOf(name), 1);
}, ACCOUNT_OFF);
await saveInEngine();
check('account list back to the start', JSON.stringify(await serverDisabled()) === JSON.stringify(before), JSON.stringify(await serverDisabled()));

// Back on: they load again.
await openSheet();
for (const name of SKIP) await switchFor(labels[name]).click();
await sheet().getByRole('button', { name: '现在重新准备' }).click();
await page.waitForTimeout(1500);
await ready();
const again = await loaded(SKIP);
check('switched back on, they load again', Object.values(again).every(Boolean), JSON.stringify(again));
check('nothing stored when none is skipped', await page.evaluate(() => localStorage.getItem('tavern-lite:engine-skip-extensions')) === null);
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
