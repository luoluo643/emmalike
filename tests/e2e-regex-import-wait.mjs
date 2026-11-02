// Reproduce the first scoped import into a role whose regex has never been allowed.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:810[67]$/.test(base)) throw new Error('dedicated isolated instance only');
const out = process.env.TEST_OUTPUT || '/tmp/regex-import-wait'; await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage(), api = context.request, checks = [], errors = [];
page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(String(e)));
const check = (name, ok) => { console.log(ok ? 'PASS' : 'FAIL', name); checks.push({ name, ok }); if (!ok) throw new Error(name); };
const { token } = await (await api.get(`${base}/csrf-token`)).json();
const post = (path, data) => api.post(base + path, { headers: { 'X-CSRF-Token': token }, data });
const app = `${base}/scripts/extensions/third-party/emmalike/app/`, run = Date.now().toString(36);
const name = `导入等待${run}`;
const inApp = source => page.evaluate(source => { const w = document.querySelector('iframe.engine').contentWindow; return new w.Function('w', source)(w); }, source);
const visibleDialogs = () => inApp('return [...w.document.querySelectorAll("dialog[open]")].filter(el => el.getBoundingClientRect().width > 0).length');
try {
    await post('/api/users/login', { handle, password });
    const response = await api.post(`${base}/api/characters/create`, { headers: { 'X-CSRF-Token': token }, multipart: { ch_name: name, first_mes: '你好。', description: '', personality: '', scenario: '', mes_example: '', creator_notes: '', talkativeness: '0.5', fav: 'false' } });
    const avatar = (await response.text()).trim();
    const rules = [1,2,3,4].map(n => ({ id: `import-${n}`, scriptName: `导入-${n}-${run}`, findRegex: '/hello/g', replaceString: '', placement: [2], markdownOnly: true, disabled: false, runOnEdit: true, trimStrings: [] }));
    await page.goto(`${app}#${new URLSearchParams({ chat: avatar })}`);
    await page.waitForFunction(() => document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    await page.goto(`${app}#regex`);
    await page.locator('[data-group="scoped"]').waitFor({ timeout: 240000 });
    const importFile = () => page.locator('input[type=file]').setInputFiles({ name: 'four-rules.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(rules)) });
    const allowed = async () => { const settings = JSON.parse((await (await post('/api/settings/get', {})).json()).settings); return !!settings.extension_settings?.character_allowed_regex?.includes(avatar); };
    check('fresh role has no regex permission', !await allowed());
    await importFile();
    const sheet = page.getByRole('dialog', { name: '导入 4 条正则', exact: true });
    const started = Date.now();
    // Hold just the write briefly to inspect the loading feedback deterministically.
    await page.route('**/api/characters/merge-attributes', async route => { await new Promise(resolve => setTimeout(resolve, 600)); await route.continue(); });
    await sheet.getByRole('button', { name: /^角色/ }).click();
    if (!process.env.EXPECT_IMPORT_HANG) {
        check('only the chosen role shows importing', await sheet.getByRole('button', { name: /正在导入/ }).count() === 1);
        check('other destinations are disabled', await sheet.getByRole('button', { name: /^全局/ }).isDisabled() && await sheet.getByRole('button', { name: /^预设/ }).isDisabled());
    }
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${out}/scoped-import.png` });
    const saved = (await (await post('/api/characters/get', { avatar_url: avatar })).json()).data.extensions.regex_scripts;
    check('four rules have reached the server', saved.length === 4 && saved.map(s => s.scriptName).join('|') === rules.map(s => s.scriptName).join('|'));
    if (process.env.EXPECT_IMPORT_HANG) {
        check('reproduced: import sheet still busy after server save', await sheet.isVisible() && await sheet.getAttribute('aria-busy') === 'true');
        check('reproduced: hidden native confirmation blocks completion', await visibleDialogs() > 0);
        const popup = await page.locator('.tl-popup-bar').boundingBox(), backdrop = await page.locator('.tl-sheet-backdrop').evaluate(el => getComputedStyle(el).zIndex);
        check('reproduced: native prompt notice lies below import overlay', !!popup && Number(backdrop) > await page.locator('.tl-popup-bar').evaluate(el => Number(getComputedStyle(el).zIndex)));
    } else {
        await sheet.waitFor({ state: 'hidden', timeout: 8000 });
        check('first scoped import finishes instead of waiting on a hidden prompt', Date.now() - started < 12000 && await visibleDialogs() === 0);
        check('import retains the group permission choice', !await allowed());
        await importFile();
        check('importing again identifies all four duplicates', (await sheet.getByRole('button', { name: /^角色/ }).innerText()).includes('其中 4 条'));
        await sheet.getByRole('button', { name: /^角色/ }).click();
        await sheet.waitFor({ state: 'hidden' });
        check('duplicate import does not append anything', (await (await post('/api/characters/get', { avatar_url: avatar })).json()).data.extensions.regex_scripts.length === 4);
        await page.unroute('**/api/characters/merge-attributes');
        let releaseWrite;
        const writeGate = new Promise(resolve => { releaseWrite = resolve; });
        await page.route('**/api/characters/merge-attributes', async route => { await writeGate; await route.continue(); });
        await importFile();
        await sheet.getByRole('switch').click();
        await sheet.getByRole('button', { name: /^角色/ }).click();
        await sheet.getByRole('button', { name: /^查看原版提示/ }).waitFor({ timeout: 12000 });
        check('slow import gives a useful escape without declaring failure', (await sheet.innerText()).includes('先别重复导入'));
        await sheet.getByRole('button', { name: /^查看原版提示/ }).click();
        await page.getByRole('button', { name: '返回轻酒馆', exact: true }).waitFor();
        check('slow import can reveal the native page', true);
        releaseWrite();
        await page.getByRole('button', { name: '返回轻酒馆', exact: true }).click();
        await page.locator('.tl-regex-status').filter({ hasText: /已导入 4 条/ }).waitFor();
        check('slow write completes once after returning', (await (await post('/api/characters/get', { avatar_url: avatar })).json()).data.extensions.regex_scripts.length === 8);
        check('no runtime errors', errors.length === 0);
    }
} catch (error) { console.error(error.stack); checks.push({ name: String(error), ok: false }); }
finally { await fs.writeFile(`${out}/results.json`, JSON.stringify({ checks, errors }, null, 2)); await browser.close(); }
console.log(checks.every(c => c.ok) ? 'ALL PASS' : 'FAILURE', checks.length); process.exitCode = checks.every(c => c.ok) ? 0 : 1;
