// 0.12.0 acceptance: world books and the chat completion preset edited in the shell, in plain words. World books: the
// list, a new book, an entry switched off and on from the list, a new entry with every setting the page offers written
// into the book file field by field, leaving with unsaved changes asks first, deleting an entry. Preset: settings and
// prompt entries change in the full app, an entry's text is edited, and "save to preset" writes the preset file.
// The preset part runs on a copy of the current settings and puts everything back (other suites use the mock model).
// Usage: node e2e-m11.mjs <baseUrl> <handle> <password> [latencyMs] [downKbps]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, latency = '200', downKbps = '5000'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const BOOK = `M11世界${run}`;
const NEW_BOOK = `M11新建${run}`;
const PRESET = `M11预设${run}`;
const results = {};
const problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`; if (!ok) problems.push(name); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript(() => {
    window.__tlToasts = [];
    new MutationObserver(rs => { for (const r of rs) for (const n of r.addedNodes) if (n.classList?.contains('tl-toast')) window.__tlToasts.push(n.textContent); })
        .observe(document, { childList: true, subtree: true });
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));

const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
const engineEval = (fn, arg) => page.evaluate(([source, a]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'a', `return (${source})(w, a);`)(w, a);
}, [fn.toString(), arg]);
const readBook = async name => (await (await post('/api/worldinfo/get', { name })).json()) ?? {};

// What the preset part changes, put back at the end whatever happened.
let restore = null;
const cleanup = async () => {
    if (restore) {
        await engineEval(async (w, a) => {
            const b = w.TavernLiteBridge;
            await b.setPresetValue('temp_openai', a.temp).catch(() => { });
            await b.setPresetValue('openai_max_tokens', a.maxTokens).catch(() => { });
            if (a.toggled) await b.setPromptEnabled(a.toggled, a.toggledWas).catch(() => { });
            if (a.edited) await b.savePresetPrompt(a.edited, { content: a.editedWas }).catch(() => { });
            // The instance's own preset is selected again without applying it (the settings in use are the same).
            const select = w.document.getElementById('settings_preset_openai');
            const option = [...select.options].find(o => o.textContent.trim() === a.presetName);
            if (option) select.value = option.value;
            const c = w.SillyTavern.getContext();
            c.chatCompletionSettings.preset_settings_openai = select.selectedOptions[0]?.textContent.trim() ?? c.chatCompletionSettings.preset_settings_openai;
            c.saveSettingsDebounced();
        }, restore).catch(() => { });
        await page.waitForTimeout(1500);
    }
    await post('/api/presets/delete', { apiId: 'openai', name: PRESET }).catch(() => { });
    for (const name of [BOOK, NEW_BOOK]) await post('/api/worldinfo/delete', { name }).catch(() => { });
};

let failing = false;
process.on('uncaughtException', async error => {
    if (failing) process.exit(3);
    failing = true;
    console.log('FAILURE', error.message.split('\n').slice(0, 12).join(' | '), (error.stack ?? '').split('\n').find(l => l.includes('e2e-m11.mjs')));
    console.log(JSON.stringify({ toasts: await page.evaluate(() => window.__tlToasts).catch(() => null), results, pageErrors }, null, 1));
    if (process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT }).catch(() => { });
    await cleanup();
    await browser.close();
    process.exit(2);
});

const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: Number(latency), downloadThroughput: Number(downKbps) * 1024 / 8, uploadThroughput: 1024 * 1024 / 8,
});
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');

const sheet = title => page.getByRole('dialog', { name: title });
const toast = text => page.waitForFunction(t => window.__tlToasts.some(x => x.includes(t)), text, { timeout: 60000 });
const settled = () => page.waitForTimeout(400);
const until = async (condition, timeout = 60000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await condition().catch(() => false)) return true; await page.waitForTimeout(300); }
    return false;
};
const entryNamed = async (book, comment) => Object.values((await readBook(book)).entries ?? {}).find(e => e.comment === comment);
// An entry is saved when its save button is off again ("已保存" toasts repeat, so they do not tell which save).
const entrySaved = () => page.waitForFunction(() => [...document.querySelectorAll('.tl-entry-editor button')].some(b => b.textContent === '保存' && b.disabled), null, { timeout: 30000 });

// A book with two entries, made before the app loads so it is in the app's list.
const fixture = {
    0: { uid: 0, key: ['森林'], keysecondary: [], comment: '森林', content: '森林里很安静。', constant: false, disable: false, order: 100, position: 0, displayIndex: 0 },
    // As in books that come with a card: no secondary keywords field, and a keyword with a comma in it.
    3: { uid: 3, key: ['晴天、彩虹'], keysecondary: [], comment: '晴天', content: '天晴了。', constant: false, disable: true, order: 100, position: 0, displayIndex: 3 },
    2: { uid: 2, key: ['雷声、闪电'], keysecondary: [], comment: '雷雨', content: '打雷了。', constant: false, disable: false, order: 100, position: 0, displayIndex: 2 },
    1: { uid: 1, key: ['魔法,法术'], comment: '世界规则', content: '这里没有魔法。', constant: true, disable: false, order: 200, position: 1, displayIndex: 1 },
};
check('fixture book saved', (await post('/api/worldinfo/edit', { name: BOOK, data: { entries: fixture } })).ok());

// --- World books ---------------------------------------------------------------------------------------------------
await page.goto(`${appUrl}#me`);
await page.locator('.tl-me').waitFor();
await page.getByRole('button', { name: /^设置与扩展/ }).click();
await sheet('设置与扩展').getByRole('button', { name: /^世界书/ }).click();
await page.locator('.tl-worlds').waitFor();
await page.getByRole('button', { name: new RegExp(`^${BOOK}`) }).waitFor({ timeout: 240000 });
check('高级设置 opens the shell’s world book list', true);
check('the list explains world books', (await page.locator('.tl-worlds').innerText()).includes('关键词'));

await page.getByRole('button', { name: '＋ 新建' }).click();
await sheet('新建世界书').getByRole('textbox').fill(NEW_BOOK);
await sheet('新建世界书').getByRole('button', { name: '新建', exact: true }).click();
await page.waitForFunction(t => document.querySelector('.tl-page-title')?.textContent === t, NEW_BOOK, { timeout: 60000 });
await page.locator('.tl-world-book').waitFor();
check('a new book is created and opened', (await readBook(NEW_BOOK)).entries !== undefined && await page.locator('.tl-page-title').innerText() === NEW_BOOK);

await page.goto(`${appUrl}#${new URLSearchParams({ world: BOOK })}`);
await page.locator('.tl-world-row').nth(1).waitFor({ timeout: 240000 });
const rows = await page.locator('.tl-world-open .tl-list-label').allInnerTexts();
check('entries listed by title', rows.includes('森林') && rows.includes('世界规则'), JSON.stringify(rows));
check('the list says which are 常驻', (await page.locator('.tl-world-row', { hasText: '世界规则' }).innerText()).includes('常驻'));
await page.locator('.tl-world-row', { hasText: '森林' }).getByRole('switch').click();
await until(async () => (await readBook(BOOK)).entries?.[0]?.disable === true);
check('switching off from the list writes the book', (await readBook(BOOK)).entries?.[0]?.disable === true);
await page.locator('.tl-world-row', { hasText: '森林' }).getByRole('switch').click();
await until(async () => (await readBook(BOOK)).entries?.[0]?.disable === false);
check('and back on', (await readBook(BOOK)).entries?.[0]?.disable === false);
await page.getByRole('button', { name: /^常驻/ }).click();
check('filter shows only 常驻', JSON.stringify(await page.locator('.tl-world-open .tl-list-label').allInnerTexts()) === JSON.stringify(['世界规则']));
await page.getByRole('button', { name: /^全部 \d+$/ }).click();
// "雷声、闪电" is one keyword to the app: the list points it out, the entry offers to split it.
await page.getByRole('button', { name: /^关键词带顿号 2/ }).click();
check('the list finds keywords joined by 、', JSON.stringify((await page.locator('.tl-world-open .tl-list-label').allInnerTexts()).sort()) === JSON.stringify(['晴天', '雷雨'].sort()));
await page.locator('.tl-world-open', { hasText: '雷雨' }).click();
await page.getByRole('button', { name: '分成几个关键词' }).click();
await page.getByRole('button', { name: '保存', exact: true }).click();
await entrySaved();
check('splitting writes separate keywords', JSON.stringify(Object.values((await readBook(BOOK)).entries ?? {}).find(e => e.comment === '雷雨')?.key) === JSON.stringify(['雷声', '闪电']));
await page.getByRole('button', { name: '返回' }).click();
await page.locator('.tl-world-book').waitFor();
// The rest of the book in one go, after asking.
await page.getByRole('button', { name: '全部分开' }).click();
await sheet('把带顿号的关键词分开').getByRole('button', { name: '全部分开' }).click();
await until(async () => JSON.stringify((await entryNamed(BOOK, '晴天'))?.key) === JSON.stringify(['晴天', '彩虹']));
{ const key = Object.values((await readBook(BOOK)).entries ?? {}).find(e => e.comment === '晴天')?.key;
  check('全部分开 splits the rest', JSON.stringify(key) === JSON.stringify(['晴天', '彩虹']), `${JSON.stringify(key)} ${await page.locator('.tl-status, [role="status"]').allInnerTexts().catch(() => [])}`); }
check('a 常驻 entry’s keywords are left alone', JSON.stringify(Object.values((await readBook(BOOK)).entries ?? {}).find(e => e.comment === '世界规则')?.key) === JSON.stringify(['魔法,法术']));
await page.getByRole('button', { name: /^全部 \d+$/ }).click();
await page.locator('.tl-world-open', { hasText: '世界规则' }).click();
await page.locator('.tl-entry-editor').waitFor();
check('opening an entry changes nothing', await page.getByRole('button', { name: '保存', exact: true }).isDisabled());
await page.getByRole('button', { name: '返回' }).click();
await page.locator('.tl-world-book').waitFor({ timeout: 5000 }).then(() => check('leaving an unchanged entry does not ask', true))
    .catch(() => check('leaving an unchanged entry does not ask', false));

// A new entry with everything the page offers.
await page.getByRole('button', { name: '＋ 新条目' }).click();
await page.locator('.tl-entry-editor').waitFor({ timeout: 30000 });
await page.locator('#tl-wi-comment').fill('天气');
await page.getByRole('radio', { name: /^故事里提到关键词时/ }).click();
await page.locator('#tl-wi-keys').fill('下雨，打雷\n/晴+/i');
await page.locator('#tl-wi-content').fill('这几天一直在下雨。');
await page.locator('#tl-wi-position').selectOption('4');
await page.locator('#tl-wi-depth').fill('2');
await page.locator('#tl-wi-role').selectOption('2');
await page.locator('#tl-wi-order').fill('250');
await page.locator('.tl-wi-more > summary').click();
await page.locator('#tl-wi-logic').selectOption('3');
await page.locator('#tl-wi-secondary').fill('雨伞');
await page.locator('#tl-wi-probability').fill('60');
await page.locator('#tl-wi-group').fill('天气组');
await page.locator('#tl-wi-weight').fill('30');
for (const name of ['组里优先选它', '不会被别的条目带出来', '不会再带出别的条目', '只能被别的条目带出来', '放不下时也要放进去']) {
    await page.getByRole('switch', { name: new RegExp(`^${name}`) }).click();
}
await page.locator('#tl-wi-sticky').fill('2');
await page.locator('#tl-wi-cooldown').fill('3');
await page.locator('#tl-wi-delay').fill('4');
await page.locator('#tl-wi-scan').fill('5');
await page.locator('#tl-wi-case').selectOption('true');
await page.locator('#tl-wi-whole').selectOption('false');
await page.getByRole('button', { name: '保存', exact: true }).click();
await entrySaved();
const saved = Object.values((await readBook(BOOK)).entries ?? {}).find(e => e.comment === '天气') ?? {};
const expected = {
    key: ['下雨', '打雷', '/晴+/i'], content: '这几天一直在下雨。', constant: false, position: 4, depth: 2, role: 2, order: 250,
    selectiveLogic: 3, keysecondary: ['雨伞'], selective: true, probability: 60, useProbability: true, group: '天气组', groupWeight: 30,
    groupOverride: true, excludeRecursion: true, preventRecursion: true, delayUntilRecursion: true, ignoreBudget: true,
    sticky: 2, cooldown: 3, delay: 4, scanDepth: 5, caseSensitive: true, matchWholeWords: false, disable: false,
};
const wrong = Object.entries(expected).filter(([k, v]) => JSON.stringify(saved[k]) !== JSON.stringify(v)).map(([k]) => `${k}=${JSON.stringify(saved[k])}`);
check('every setting is written into the book', wrong.length === 0, wrong.join(', '));
const cached = await engineEval(async (w, a) => (await w.TavernLiteBridge.worldBook(a)).entries.find(e => e.comment === '天气')?.content, BOOK);
check('the app’s own copy has the entry too', cached === '这几天一直在下雨。', String(cached));

// Unsaved changes: leaving asks first, and nothing is written.
await page.locator('#tl-wi-content').fill('没保存的内容');
await page.getByRole('button', { name: '返回' }).click();
await sheet('还有没保存的草稿').getByRole('button', { name: '放弃草稿，返回' }).click();
await page.locator('.tl-world-book').waitFor();
check('leaving unsaved asks and keeps the book as it was',
    Object.values((await readBook(BOOK)).entries ?? {}).find(e => e.comment === '天气')?.content === '这几天一直在下雨。');

// 常驻 hides the keywords; deleting an entry.
await page.locator('.tl-world-open', { hasText: '天气' }).click();
await page.getByRole('radio', { name: /^尝试每次加入/ }).click();
check('常驻 needs no keywords', await page.locator('#tl-wi-keys').count() === 0);
await page.getByRole('button', { name: /^删除这一条/ }).click();
await sheet('还有没保存的草稿').waitFor({ timeout: 2000 }).then(() => check('delete is not mistaken for leaving', false)).catch(() => { });
await sheet(/^删除「/).getByRole('button', { name: '删除', exact: true }).click();
await until(async () => !(await entryNamed(BOOK, '天气')));
await page.locator('.tl-world-book').waitFor();
check('deleting removes the entry', !Object.values((await readBook(BOOK)).entries ?? {}).some(e => e.comment === '天气'));
await settled();

// --- Preset --------------------------------------------------------------------------------------------------------
const current = JSON.parse((await (await post('/api/settings/get', {})).json()).settings).oai_settings;
if (!(await post('/api/presets/save', { apiId: 'openai', name: PRESET, preset: current })).ok()) throw new Error('preset not saved');
await page.goto(`${appUrl}#me`);
await page.locator('.tl-me').waitFor();
await page.waitForFunction(() => !!document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge?.presetState, null, { timeout: 240000 });
// The copy was saved behind the app's back: a reload lists it; then it is selected (it holds the same settings).
await page.reload();
await page.locator('.tl-me').waitFor();
await page.waitForFunction(() => !!document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge?.presetState, null, { timeout: 240000 });
const presetName = await engineEval(w => w.SillyTavern.getContext().chatCompletionSettings.preset_settings_openai);
const selected = await engineEval(async (w, name) => {
    const select = w.document.getElementById('settings_preset_openai');
    const option = [...select.options].find(o => o.textContent.trim() === name);
    if (!option) return false;
    select.value = option.value;
    select.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1500));
    return w.SillyTavern.getContext().chatCompletionSettings.preset_settings_openai === name;
}, PRESET);
check('test preset selected', selected);
const state = await engineEval(w => w.TavernLiteBridge.presetState());
const toggleable = state?.prompts.find(p => p.canToggle);
const editable = state?.prompts.find(p => p.canEdit);
restore = {
    presetName, temp: state.samplers.temp_openai.value, maxTokens: state.samplers.openai_max_tokens.value,
    toggled: toggleable?.identifier, toggledWas: toggleable?.enabled,
    edited: editable?.identifier, editedWas: editable ? (await engineEval((w, id) => w.TavernLiteBridge.presetPrompt(id).content, editable.identifier)) : '',
};

await page.getByRole('button', { name: /^设置与扩展/ }).click();
await sheet('设置与扩展').getByRole('button', { name: /^预设与提示词/ }).click();
await page.locator('.tl-preset-page').waitFor();
await page.getByText(`「${PRESET}」`).first().waitFor({ timeout: 30000 });
check('the preset page names the preset in use', true);

const temp = restore.temp === 0.7 ? 0.8 : 0.7;
await page.locator('#tl-preset-temperature').fill(String(temp));
await page.locator('#tl-preset-temperature').press('Tab');
await page.waitForFunction(t => document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().chatCompletionSettings.temp_openai === t, temp, { timeout: 15000 }).catch(() => { });
check('温度 changes the app’s setting', await engineEval(w => w.SillyTavern.getContext().chatCompletionSettings.temp_openai) === temp);
const maxTokens = restore.maxTokens === 345 ? 346 : 345;
await page.locator('#tl-preset-openai_max_tokens').fill(String(maxTokens));
await page.locator('#tl-preset-openai_max_tokens').press('Tab');
await page.waitForFunction(t => document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().chatCompletionSettings.openai_max_tokens === t, maxTokens, { timeout: 15000 }).catch(() => { });
check('回复长度上限 changes the app’s setting', await engineEval(w => w.SillyTavern.getContext().chatCompletionSettings.openai_max_tokens) === maxTokens);
// An emptied box is not 0; out of range becomes the nearest allowed value.
await page.locator('#tl-preset-temperature').fill('');
await page.locator('#tl-preset-temperature').press('Tab');
await page.waitForTimeout(800);
check('an emptied box keeps the value', await engineEval(w => w.SillyTavern.getContext().chatCompletionSettings.temp_openai) === temp
    && await page.locator('#tl-preset-temperature').inputValue() === String(temp));

if (toggleable) {
    // Rows are in the app's order, the same as presetState().prompts.
    await page.locator('.tl-preset-page .tl-preset-row[data-id="' + toggleable.identifier + '"]').locator('.tl-preset-toggle').click();
    const enabledNow = () => engineEval((w, id) => w.TavernLiteBridge.presetState().prompts.find(p => p.identifier === id).enabled, toggleable.identifier);
    await until(async () => await enabledNow() === !toggleable.enabled, 15000);
    const now = await enabledNow();
    check('a prompt entry switches in the app', now === !toggleable.enabled, `${toggleable.identifier}: ${toggleable.enabled} -> ${now}`);
} else {
    check('a prompt entry switches in the app', false, 'no entry can be switched');
}
if (editable) {
    await page.locator('.tl-preset-page .tl-preset-row[data-id="' + editable.identifier + '"]').locator('.tl-preset-open').click();
    await page.locator('#tl-prompt-text').waitFor();
    const text = `${restore.editedWas}\n（测试 ${run}）`;
    await page.locator('#tl-prompt-text').fill(text);
    await page.getByRole('button', { name: '应用', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.tl-preset-editor-actions')?.textContent.includes('当前文字已应用'), null, { timeout: 15000 });
    const content = await engineEval((w, id) => w.TavernLiteBridge.presetPrompt(id).content, editable.identifier);
    check('a prompt entry’s text is edited in the app', content === text, content.slice(-40));
    // Applying keeps the prompt open; back goes to the preset page (nothing is left unapplied, so it does not ask).
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.locator('.tl-preset-savebar').waitFor({ timeout: 15000 });
} else {
    check('a prompt entry’s text is edited in the app', false, 'no entry can be edited');
}
check('built-in entries have Chinese names', !(await page.locator('.tl-preset-page').innerText()).includes('Chat History'));

await page.getByRole('button', { name: '保存到此预设', exact: true }).click();
await until(async () => {
    const all = await (await post('/api/settings/get', {})).json();
    const at = all.openai_setting_names?.indexOf(PRESET);
    const saved = at >= 0 ? JSON.parse(all.openai_settings[at]) : null;
    return saved?.temperature === temp && saved?.openai_max_tokens === maxTokens;
});
const presets = (await (await post('/api/settings/get', {})).json());
const index = presets.openai_setting_names?.indexOf(PRESET);
const file = index >= 0 ? JSON.parse(presets.openai_settings[index]) : null;
check('保存到预设 writes the preset file', file?.temperature === temp && file?.openai_max_tokens === maxTokens, JSON.stringify({ t: file?.temperature, m: file?.openai_max_tokens }));

await cleanup();
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `FAILED: ${problems.join(', ')}` : 'ALL PASS');
await browser.close();
process.exit(problems.length ? 1 : 0);
