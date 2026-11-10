// Preset page and new connections on an official SillyTavern with only tavern-lite:
// - while the preset is read, the page says what will be there (and does not offer only the full app);
// - entries move up/down and to a picked place, and a single entry is copied (below it, off), all in the full app's own
//   prompt order and kept after a reload;
// - an entry is renamed from the arrange list or its own page, shows the new name (a built-in one too), and is kept
//   when the preset is saved and after a reload;
// - setting up a model service saves it as a new connection profile and keeps the one in use; a failed try puts the
//   one in use back.
// Usage: node e2e-preset-arrange.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const MOCK = process.env.MOCK_INTERNAL_URL || 'http://mock:5001/v1';
const results = {}, problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`; if (!ok) problems.push(name); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript(() => {
    // Seen at any moment before the list: the loading notice, and whether the full-app button was offered with it.
    window.__presetLoading = { seen: false, nativeWithIt: false };
    new MutationObserver(() => {
        if (document.querySelector('.tl-preset-loading')) {
            window.__presetLoading.seen = true;
            if ([...document.querySelectorAll('.tl-preset-page .tl-list-item')].some(b => b.textContent.includes('在原版界面里打开'))) window.__presetLoading.nativeWithIt = true;
        }
    }).observe(document, { childList: true, subtree: true });
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const engineEval = (fn, arg) => page.evaluate(([source, a]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'a', `return (${source})(w, a);`)(w, a);
}, [fn.toString(), arg]);
const nativeOrder = () => engineEval(async w => (await w.TavernLiteBridge.presetEditorState({ fresh: false })).prompts.map(p => ({ id: p.identifier, name: p.name, enabled: p.enabled })));
const arrangeNames = () => page.locator('.tl-preset-arrange-row .tl-list-label').allInnerTexts().then(list => list.map(t => t.replace(/^\d+\.\s*/, '').replace(/\s*(系统|用户|AI|位置标记)$/, '').trim()));

let startProfiles = null; // the account's connection profiles before the suite, kept; the ones it makes are removed
try {
    // --- Preset page ----------------------------------------------------------------------------------------------
    await page.goto(`${appUrl}#preset`);
    await page.locator('.tl-preset-row').first().waitFor({ timeout: 240000 });
    const loading = await page.evaluate(() => window.__presetLoading);
    check('preset: a loading notice says entries can be changed here', loading.seen, loading);
    check('preset: the full app is not the only thing offered while reading', !loading.nativeWithIt, loading);
    check('preset: a jump to the entries near the top', await page.locator('.tl-preset-jump').count() === 1);

    await page.getByRole('button', { name: '排序、复制、改名', exact: true }).click();
    await page.locator('.tl-preset-arrange-row').first().waitFor();
    const before = await nativeOrder();
    const names = await arrangeNames();
    check('arrange: every entry in the full app order', names.length === before.length, { ui: names.length, native: before.length });

    await page.getByRole('button', { name: `下移「${names[0]}」`, exact: true }).click();
    await page.waitForFunction(n => document.querySelector('.tl-preset-arrange-row .tl-list-label')?.textContent.includes(n), names[1], { timeout: 30000 });
    let after = await nativeOrder();
    check('arrange: down swaps with the next entry in the full app', after[0].id === before[1].id && after[1].id === before[0].id, after.slice(0, 3));

    // Pick the last one and put it in front of the first.
    const last = names.at(-1);
    await page.getByRole('button', { name: `挪动「${last}」`, exact: true }).click();
    const first = (await arrangeNames())[0];
    await page.getByRole('button', { name: `把「${last}」移到「${first}」前面`, exact: true }).click();
    await page.waitForFunction(n => document.querySelector('.tl-preset-arrange-row .tl-list-label')?.textContent.includes(n), last, { timeout: 30000 });
    after = await nativeOrder();
    check('arrange: pick and place moves to the chosen spot', after[0].id === before.at(-1).id, after.slice(0, 2));

    const main = before.find(p => p.id === 'main');
    await page.getByRole('button', { name: '复制「主提示词」', exact: true }).click();
    await page.locator('.tl-preset-arrange-row', { hasText: '主提示词 副本' }).waitFor({ timeout: 30000 });
    after = await nativeOrder();
    const mainAt = after.findIndex(p => p.id === 'main'), copy = after[mainAt + 1];
    check('copy: right below its source, named 副本, off', copy?.name === '主提示词 副本' && copy.enabled === false && after.length === before.length + 1, copy);
    const copyContent = await engineEval((w, id) => w.SillyTavern.getContext().chatCompletionSettings.prompts.find(p => p.identifier === id), copy?.id);
    const mainContent = await engineEval(w => w.SillyTavern.getContext().chatCompletionSettings.prompts.find(p => p.identifier === 'main'));
    check('copy: same text, an entry of the user\'s own', copyContent?.content === mainContent?.content && copyContent?.system_prompt === false && !!main);
    check('copy: the page says it still needs saving to the preset', (await page.locator('.tl-preset-savebar [role="status"]').innerText()).includes('还没存进预设'));

    // --- Rename ---------------------------------------------------------------------------------------------------
    const nameBox = page.getByRole('textbox', { name: '条目名字' });
    await page.getByRole('button', { name: '改「主提示词 副本」的名字', exact: true }).click();
    check('rename: the sheet starts with the name on screen', await nameBox.inputValue() === '主提示词 副本');
    await nameBox.fill('   ');
    check('rename: an empty name cannot be confirmed', await page.getByRole('button', { name: '确定', exact: true }).isDisabled());
    await nameBox.fill('我的写作要求');
    if (process.env.SHOTS) { await page.waitForTimeout(800); await page.screenshot({ path: `${process.env.SHOTS}/rename-sheet.png` }); }
    await page.getByRole('button', { name: '确定', exact: true }).click();
    await page.locator('.tl-preset-arrange-row', { hasText: '我的写作要求' }).waitFor({ timeout: 30000 });
    let renamed = await nativeOrder();
    check('rename from the arrange list: same place, same identifier, still off',
        renamed.find(p => p.id === copy.id)?.name === '我的写作要求' && renamed.find(p => p.id === copy.id)?.enabled === false && JSON.stringify(renamed.map(p => p.id)) === JSON.stringify(after.map(p => p.id)), renamed);
    check('rename: the page says it still needs saving to the preset', (await page.locator('.tl-preset-savebar [role="status"]').innerText()).includes('还没存进预设'));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/rename-arrange.png` });
    check('rename: a position marker has no rename button', await page.locator('.tl-preset-arrange-row', { hasText: '位置标记' }).getByRole('button', { name: /的名字$/ }).count() === 0);
    await page.getByRole('button', { name: '排好了', exact: true }).click();

    await page.locator('.tl-preset-open').filter({ hasText: '主提示词' }).first().click();
    await page.getByRole('button', { name: '改名', exact: true }).click();
    const mainText = await page.locator('#tl-prompt-text').inputValue();
    await nameBox.fill('My Main');
    await nameBox.press('Enter');
    await page.locator('.tl-page-title', { hasText: 'My Main' }).waitFor({ timeout: 30000 });
    check('rename from the entry page: a built-in entry shows the English name it was given', (await nativeOrder()).find(p => p.id === 'main')?.name === 'My Main');
    check('rename from the entry page: the text is untouched', await page.locator('#tl-prompt-text').inputValue() === mainText);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/rename-entry.png` });
    await page.locator('.tl-back').click();
    await page.locator('.tl-preset-open', { hasText: 'My Main' }).waitFor({ timeout: 30000 });
    check('rename: the list shows the new name', await page.locator('.tl-preset-open', { hasText: '主提示词' }).count() === 0);

    const savedName = await engineEval(async w => (await w.TavernLiteBridge.presetEditorState({ fresh: false })).name);
    await page.getByRole('button', { name: '保存到此预设', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.tl-preset-savebar [role="status"]')?.textContent.includes('都已存进预设') || document.querySelector('.tl-preset-savebar [role="status"]')?.textContent.includes('已存进预设'), null, { timeout: 60000 });
    const settings = await (await post('/api/settings/get', {})).json();
    const stored = JSON.parse(settings.openai_settings[settings.openai_setting_names.indexOf(savedName)] || '{}').prompts || [];
    check('rename: both names are in the saved preset file', stored.find(p => p.identifier === 'main')?.name === 'My Main' && stored.find(p => p.identifier === copy.id)?.name === '我的写作要求', { savedName, names: stored.map(p => p.name).slice(0, 6) });

    await page.waitForTimeout(2000);
    await page.reload();
    await page.locator('.tl-preset-row').first().waitFor({ timeout: 240000 });
    const reloaded = await nativeOrder();
    check('arrange and copy are kept after a reload', JSON.stringify(reloaded.map(p => p.id)) === JSON.stringify(after.map(p => p.id)));
    check('rename: names are kept after a reload', reloaded.find(p => p.id === 'main')?.name === 'My Main' && reloaded.find(p => p.id === copy.id)?.name === '我的写作要求');

    // --- New connection -----------------------------------------------------------------------------------------------
    const profiles = () => engineEval(w => { const m = w.SillyTavern.getContext().extensionSettings.connectionManager; return { names: m.profiles.map(p => p.name), selected: m.profiles.find(p => p.id === m.selectedProfile)?.name ?? '', url: w.SillyTavern.getContext().chatCompletionSettings.custom_url }; });
    const start = await profiles();
    startProfiles = start.names;
    await page.goto(`${appUrl}#setup`);
    // Leaving the preset page with changes not saved to the named preset asks first.
    const goOn = page.getByRole('button', { name: '继续返回', exact: true });
    if (await goOn.waitFor({ timeout: 5000 }).then(() => true, () => false)) { await goOn.click(); await page.goto(`${appUrl}#setup`); }
    await page.locator('.tl-setup').waitFor({ timeout: 30000 });
    await page.getByRole('heading', { name: '新建连接' }).waitFor({ timeout: 240000 }).catch(() => { });
    check('setup: titled 新建连接 and says the one in use is kept', (await page.locator('.tl-setup').innerText()).includes('会保留'));
    await page.getByRole('radio', { name: /^中转站（OpenAI 格式）/ }).click();
    await page.getByRole('textbox', { name: '地址' }).fill(MOCK);
    await page.getByRole('textbox', { name: '密钥' }).fill('test-key');
    await page.getByRole('textbox', { name: '新连接的名字' }).fill('测试新连接');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.locator('#tl-setup-result').waitFor({ timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('#tl-setup-result')?.textContent.includes('已存成新连接'), null, { timeout: 30000 }).catch(() => { });
    const made = await profiles();
    check('setup: saved as a new profile and selected', made.names.includes('测试新连接') && made.selected === '测试新连接', made);
    const keptBefore = start.names.includes('原来的连接');
    check('setup: the setting in use before was kept as a profile', made.names.length === start.names.length + (keptBefore ? 1 : 2) && made.names.includes('原来的连接'), { start, made });
    const resultText = await page.locator('#tl-setup-result').innerText();
    check('setup: says what it saved', resultText.includes('测试新连接') && (keptBefore || resultText.includes('原来的连接')), resultText.slice(0, 200));

    // A relay that cannot be checked (no model list here) is not saved until it answers; leaving puts the one in use back.
    await page.goto(`${appUrl}#library`);
    await page.goto(`${appUrl}#setup`);
    await page.getByRole('radio', { name: /^中转站（OpenAI 格式）/ }).click();
    await page.getByRole('textbox', { name: '地址' }).fill('http://127.0.0.1:9/v1');
    await page.getByRole('textbox', { name: '密钥' }).fill('wrong-key');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.locator('#tl-setup-result').waitFor({ timeout: 90000 });
    const unchecked = await profiles();
    check('setup: an unchecked try is not saved as a profile yet', unchecked.names.length === made.names.length, unchecked);
    await page.getByRole('button', { name: '返回', exact: true }).first().click();
    await page.waitForFunction(() => !document.querySelector('.tl-setup'), null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    const left = await profiles();
    check('setup: leaving an unchecked try puts the one in use back', left.selected === '测试新连接' && left.url === MOCK && left.names.length === made.names.length, left);
} catch (error) {
    check('no exception', false, String(error.message).split('\n')[0]);
    if (process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT }).catch(() => { });
} finally {
    // Later suites on this instance talk to the mock model: leave the connection on it.
    await engineEval((w, { url, keep }) => {
        const d = w.document, set = (id, value, type) => { const e = d.getElementById(id); if (e) { e.value = value; e.dispatchEvent(new w.Event(type, { bubbles: true })); } };
        set('chat_completion_source', 'custom', 'change'); set('custom_api_url_text', url, 'input'); set('custom_model_id', 'mock-model', 'input');
        if (keep) {
            const m = w.SillyTavern.getContext().extensionSettings.connectionManager;
            m.profiles = m.profiles.filter(p => keep.includes(p.name));
            if (!m.profiles.some(p => p.id === m.selectedProfile)) m.selectedProfile = null;
        }
        w.SillyTavern.getContext().saveSettingsDebounced();
    }, { url: MOCK, keep: startProfiles }).catch(() => { });
    await page.waitForTimeout(3000);
    await browser.close();
}
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(JSON.stringify(results, null, 2));
if (problems.length) { console.error('FAILED:', problems.join(', ')); process.exit(1); }
console.log('ALL PASS');
