// Isolated ST only: role selection does not change the story; writes and exports use the selected role.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('isolated loopback instance required');
const out = process.env.TEST_OUTPUT || '/tmp/regex-manage-ui';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
const page = await context.newPage(), api = context.request, errors = [], checks = [];
page.setDefaultTimeout(30000);
page.on('pageerror', error => errors.push(String(error)));
const check = (label, ok) => { checks.push({ label, ok }); console.log(ok ? 'PASS' : 'FAIL', label); if (!ok) throw new Error(label); };
const { token } = await (await api.get(`${base}/csrf-token`)).json();
const post = (path, data) => api.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
const app = `${base}/scripts/extensions/third-party/emmalike/app/`, run = Date.now().toString(36);
const names = [`阅读角色${run}`, `管理角色${run}`], avatars = [];
const script = (id, disabled = false) => ({ id, scriptName: id, findRegex: '/hello/g', replaceString: '你好', placement: [2], markdownOnly: true, promptOnly: false, disabled, trimStrings: [], runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null });
const card = async avatar => (await (await post('/api/characters/get', { avatar_url: avatar })).json());
const scripts = async avatar => (await card(avatar)).data.extensions.regex_scripts;
const inApp = (source, value) => page.evaluate(([source, value]) => { const w = document.querySelector('iframe.engine').contentWindow; return new w.Function('w', 'value', source)(w, value); }, [source, value]);
const state = () => inApp('return w.TavernLiteBridge.regexEditorState()');
let pickerShot = false;
const choose = async name => {
    await page.locator('[data-group="scoped"] h2 button').click();
    if (!pickerShot) { await page.waitForTimeout(350); await page.screenshot({ path: `${out}/character-picker.png` }); pickerShot = true; }
    await page.getByRole('searchbox', { name: '搜索角色', exact: true }).fill(name);
    await page.getByRole('radio', { name: new RegExp(name) }).click();
    await page.getByRole('dialog', { name: '选择角色', exact: true }).waitFor({ state: 'hidden' });
};
const until = async fn => { for (let i = 0; i < 60; i++) { if (await fn()) return true; await page.waitForTimeout(250); } return false; };
let modelCalls = 0;
context.on('request', request => { if (request.url().includes('/chat-completions/generate')) modelCalls++; });
try {
    if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
    for (const name of names) {
        const response = await api.post(`${base}/api/characters/create`, { headers: { 'X-CSRF-Token': token }, multipart: { ch_name: name, first_mes: 'hello', description: '', personality: '', scenario: '', mes_example: '', creator_notes: '', talkativeness: '0.5', fav: 'false' } });
        if (!response.ok()) throw new Error('create failed');
        avatars.push((await response.text()).trim());
    }
    for (const [i, avatar] of avatars.entries()) await post('/api/characters/merge-attributes', { avatar, data: { extensions: { regex_scripts: [script(`one-${i}-${run}`), script(`two-${i}-${run}`, true)], test_keep: 'untouched' } } });
    const settings = JSON.parse((await (await post('/api/settings/get', {})).json()).settings);
    settings.extension_settings.character_allowed_regex = [...(settings.extension_settings.character_allowed_regex || []), ...avatars];
    await post('/api/settings/save', settings);
    await page.goto(`${app}#${new URLSearchParams({ chat: avatars[0] })}`);
    await page.waitForFunction(() => document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    await page.getByRole('button', { name: '更多', exact: true }).click();
    const entranceOrder = await page.getByRole('dialog').locator('.tl-sheet-item-label').allTextContents();
    const regexIndex = entranceOrder.indexOf('正则');
    check('story details puts regex immediately under preset', regexIndex > 0 && entranceOrder[regexIndex - 1].startsWith('预设：'));
    await page.getByRole('dialog').getByRole('button', { name: /^正则/ }).click();
    await page.locator('[data-group="scoped"] h2 button').waitFor({ timeout: 240000 });
    const current = await inApp('return w.SillyTavern.getContext().characterId');
    const before = JSON.stringify(await scripts(avatars[0]));
    await page.getByRole('button', { name: '批量与排序', exact: true }).click();
    await page.getByRole('checkbox', { name: `选择「one-0-${run}」`, exact: true }).check();
    await choose(names[1]);
    check('changing the management role clears bulk selection', await page.getByRole('button', { name: '批量与排序', exact: true }).count() === 1);
    check('chosen role is independent of current story', (await state()).owner.scoped === avatars[1] && await inApp('return w.SillyTavern.getContext().characterId') === current);
    check('combos do not mix the other role into the current story', await page.getByRole('button', { name: /^当前故事的正则/ }).count() === 1);
    await page.screenshot({ path: `${out}/role-list.png`, fullPage: true });
    // Search filters do not shrink an explicitly requested whole-group export.
    await page.getByRole('searchbox', { name: '搜索正则', exact: true }).fill(`one-1`);
    await page.getByRole('button', { name: /^导出正则/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: new RegExp(`^角色「${names[1]}」`) }).click();
    const ready = page.getByRole('dialog', { name: '导出 2 条正则', exact: true });
    await ready.waitFor();
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${out}/export-sheet.png` });
    const downloading = page.waitForEvent('download');
    await ready.getByRole('button', { name: /^保存文件/ }).click();
    const download = await downloading;
    const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
    check('one downloaded JSON contains the whole group in original order and preserves switches', Array.isArray(exported) && exported.length === 2 && exported[0].id === `one-1-${run}` && exported[1].disabled === true);
    await ready.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('searchbox', { name: '搜索正则', exact: true }).fill('');
    await page.evaluate(() => {
        Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
        Object.defineProperty(navigator, 'share', { configurable: true, value: async () => { throw new DOMException('test cancel', 'AbortError'); } });
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedRegex = text; } } });
    });
    await page.getByRole('button', { name: '批量与排序', exact: true }).click();
    for (const n of ['one', 'two']) await page.getByRole('checkbox', { name: `选择「${n}-1-${run}」`, exact: true }).check();
    await page.getByRole('button', { name: '导出已选的 2 条', exact: true }).click();
    await ready.getByRole('button', { name: /^分享文件/ }).click();
    check('cancelled system share leaves export available without a success claim', await ready.isVisible() && !(await ready.innerText()).includes('已交给分享'));
    await ready.getByRole('button', { name: /^复制内容/ }).click();
    check('custom batch has a JSON copy fallback', await until(async () => await page.evaluate(() => JSON.parse(window.copiedRegex || '[]').length === 2)));
    await ready.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '完成', exact: true }).click();
    // Other role mutation goes through the native explicit-character write and readback.
    await page.getByRole('switch', { name: `打开「one-1-${run}」`, exact: true }).click();
    check('only the selected role is saved', await until(async () => (await scripts(avatars[1]))[0].disabled) && JSON.stringify(await scripts(avatars[0])) === before);
    check('unknown character extension fields survive', (await card(avatars[1])).data.extensions.test_keep === 'untouched');
    check('saving another role leaves the active character intact', await inApp('return w.SillyTavern.getContext().characterId') === current);
    // Editor navigation must retain the management target and bind its draft to that avatar.
    await page.locator(`[data-id="one-1-${run}"] .tl-regex-open`).click();
    await page.getByLabel('名字', { exact: true }).fill(`改过-${run}`);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.tl-regex-status').filter({ hasText: /^已保存/ }).waitFor();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.locator('[data-group="scoped"] h2 button').waitFor();
    check('editor saves and returns to the selected management role', (await state()).owner.scoped === avatars[1] && (await scripts(avatars[1]))[0].scriptName === `改过-${run}`);
    // Server rejection must not be reported as a successful save.
    await page.route('**/api/characters/merge-attributes', route => route.fulfill({ status: 500, body: 'test rejection' }));
    await page.getByRole('switch', { name: `打开「改过-${run}」`, exact: true }).click();
    check('failed off-role write is visibly reported', await until(async () => (await page.locator('.tl-regex-status').innerText().catch(() => '')).includes('保存成功') || (await page.locator('.tl-regex-status').innerText().catch(() => '')).includes('没存到')));
    check('failed save did not affect either server card', (await scripts(avatars[1]))[0].disabled === true && JSON.stringify(await scripts(avatars[0])) === before);
    await page.unroute('**/api/characters/merge-attributes');
    // Reopen the selected card to discard the deliberately failed candidate.
    await choose(names[1]);
    const changed = await scripts(avatars[1]); changed[1].replaceString = '外部修改';
    await post('/api/characters/merge-attributes', { avatar: avatars[1], data: { extensions: { regex_scripts: changed } } });
    await page.getByRole('switch', { name: `打开「改过-${run}」`, exact: true }).click();
    check('external changes are detected before overwriting the selected card', await until(async () => (await page.locator('.tl-regex-status').innerText().catch(() => '')).includes('别处改过')) && (await scripts(avatars[1]))[1].replaceString === '外部修改');
    await choose(names[0]);
    check('return to current role restores normal combo controls', !(await state()).managingOtherCharacter && await page.locator('.tl-regex-combos').count() === 1);
    await page.locator('[data-group="scoped"] h2 button').click();
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${out}/character-picker-after-error.png` });
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    check('mobile layout does not overflow horizontally', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check('no model calls', modelCalls === 0);
    check('no browser runtime errors', errors.length === 0);
} catch (error) {
    console.error(error.stack); await page.screenshot({ path: `${out}/failure.png`, fullPage: true }).catch(() => {});
    checks.push({ label: String(error), ok: false });
} finally {
    await fs.writeFile(`${out}/results.json`, JSON.stringify({ checks, errors }, null, 2));
    await browser.close();
}
console.log(checks.every(c => c.ok) ? 'ALL PASS' : 'FAILURE', checks.length);
process.exitCode = checks.every(c => c.ok) ? 0 : 1;
