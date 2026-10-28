// M2 acceptance: library and management. Import a card from the library, filter by tag, open the work page, start
// stories, switch / rename / delete chapters, the "me" page, reading settings that follow the account, theme files,
// and the data-saving engine modes. Usage: node e2e-m2.mjs <baseUrl> <handle> <password> [latencyMs] [downKbps]
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, latency = '200', downKbps = '5000'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `M2角色${run}`;
const TAG = `m2-${run}`;
const WORLD = `m2世界${run}`;
const results = {};
const problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`; if (!ok) problems.push(name); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
await context.addInitScript(() => {
    window.__tlToasts = [];
    new MutationObserver(rs => { for (const r of rs) for (const n of r.addedNodes) if (n.classList?.contains('tl-toast')) window.__tlToasts.push(n.textContent); })
        .observe(document, { childList: true, subtree: true });
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));

let avatar = '';
const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
const cleanup = async () => {
    if (avatar) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
    await post('/api/worldinfo/delete', { name: WORLD }).catch(() => { });
};

process.on('uncaughtException', async error => {
    console.log('FAILURE', error.message.split('\n')[0], (error.stack ?? '').split('\n').find(l => l.includes('e2e-m2.mjs')));
    console.log(JSON.stringify({ toasts: await page.evaluate(() => window.__tlToasts).catch(() => null), results }, null, 1));
    await cleanup();
    await browser.close();
    process.exit(2);
});

const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: Number(latency), downloadThroughput: Number(downKbps) * 1024 / 8, uploadThroughput: 1024 * 1024 / 8,
});

const login = await post('/api/users/login', { handle, password });
if (!login.ok()) throw new Error(`login failed ${login.status()}`);

const toast = text => page.waitForFunction(t => window.__tlToasts.some(x => x.includes(t)), text, { timeout: 60000 });
const synced = () => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const idle = () => page.locator('.tl-send').waitFor({ timeout: 120000 });
const engineReady = () => page.waitForFunction(() => !!document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge && !document.querySelector('.tl-engine-status'), null, { timeout: 240000 });
const chapterFiles = async () => (await (await post('/api/characters/chats', { avatar_url: avatar })).json()).map(c => c.file_name);
const cssHas = text => page.waitForFunction(t => (document.getElementById('tl-reading-css')?.textContent ?? '').includes(t), text, { timeout: 5000 }).then(() => true, () => false);
const readingTheme = () => page.evaluate(() => document.getElementById('tl-reading-css')?.textContent ?? '');
const rootVar = name => page.evaluate(n => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const sheet = title => page.getByRole('dialog', { name: title });

// A world book linked from the card, opened from the work page.
const worldEntries = {
    0: { uid: 0, key: ['森林'], keysecondary: [], comment: '森林的设定', content: `森林深处有一口古井。${run}`, constant: false, disable: false, displayIndex: 0 },
    1: { uid: 1, key: ['古井'], keysecondary: [], comment: '', content: '旧的条目。', constant: false, disable: true, displayIndex: 1 },
};
check('world book fixture saved', (await post('/api/worldinfo/edit', { name: WORLD, data: { entries: worldEntries } })).ok());

// Library: import a card with the import button, then find it with its tag.
await page.goto(appUrl);
await page.locator('.tl-character').first().waitFor();
const card = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
        name: NAME, description: '测试用角色。', personality: '', scenario: '', first_mes: `你好，我是${NAME}。`, mes_example: '',
        creator_notes: `这是 M2 验收用的作品简介，第 ${run} 次运行。`, tags: [TAG, 'm2测试'], extensions: { world: WORLD },
    },
};
await page.locator('input[type="file"]').setInputFiles({ name: `${NAME}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(card)) });
await toast('已导入 1 个角色');
const book = page.locator('.tl-book', { hasText: NAME });
await book.waitFor({ timeout: 30000 });
avatar = (await (await post('/api/characters/all', {})).json()).find(c => c.name === NAME)?.avatar ?? '';
check('import a card from the library', !!avatar);

await page.getByRole('button', { name: TAG, exact: true }).click();
check('tag filter shows only matching works', await page.locator('.tl-book').count() === 1 && await book.count() === 1, String(await page.locator('.tl-book').count()));
check('tag filter hides continue cards', await page.locator('.tl-continue').count() === 0);
await page.getByRole('button', { name: '全部', exact: true }).click();

// Work page from the ⋯ menu: introduction, tags and the empty chapter list.
await book.getByRole('button', { name: `${NAME} 的更多操作` }).click();
await sheet(NAME).getByRole('button', { name: /^角色主页/ }).click();
await page.locator('.tl-work-name', { hasText: NAME }).waitFor();
check('work page shows the introduction', (await page.locator('.tl-work-intro').innerText()).includes(`第 ${run} 次运行`));
check('work page shows tags', await page.locator('.tl-work .tl-tag', { hasText: TAG }).count() === 1);
await page.getByText('还没有故事').waitFor({ timeout: 30000 }).then(() => check('new work has no chapters yet', true))
    .catch(async () => check('new work has no chapters yet', false, JSON.stringify(await chapterFiles())));

// World book: its own page in the shell, entries by title, one tap to an entry's settings.
await page.getByRole('button', { name: new RegExp(`^世界书：${WORLD}`) }).click();
await page.locator('.tl-world-row').nth(1).waitFor({ timeout: 240000 });
const titles = await page.locator('.tl-world-open .tl-list-label').allInnerTexts();
check('world book lists entries by title', JSON.stringify([...titles].sort()) === JSON.stringify(['古井', '森林的设定'].sort()), JSON.stringify(titles));
check('a disabled entry shows as switched off', await page.locator('.tl-world-row', { hasText: '古井' }).getByRole('switch').getAttribute('aria-checked') === 'false');
await page.locator('.tl-world-open', { hasText: '森林的设定' }).click();
await page.locator('#tl-wi-content').waitFor();
check('world book entry opens to its content', (await page.locator('#tl-wi-content').inputValue()).includes(`森林深处有一口古井。${run}`));
await page.getByRole('button', { name: '返回' }).click();
await page.locator('.tl-world-book').waitFor();
await page.getByRole('button', { name: '返回' }).click();
await page.locator('.tl-work-name', { hasText: NAME }).waitFor();

// First story: read, send, get a reply.
await page.getByRole('button', { name: '开始阅读' }).click();
await page.locator('.tl-message', { hasText: `我是${NAME}` }).waitFor();
check('reader shows the greeting before the full app is ready', true);
await synced();
const first = `第一章的话${run}`;
await page.locator('.tl-composer-input').fill(first);
await page.getByRole('button', { name: '发送' }).click();
await page.locator('.tl-message[data-role="char"]', { hasText: `收到：${first}` }).waitFor({ timeout: 120000 });
await idle();

// New story twice in a row: the second one reuses the untouched chapter instead of piling up empty ones.
// Once created, the address points at the real chapter (no "new" flag), so a reload does not start another one.
const newStory = async () => {
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await page.getByRole('button', { name: /^开始新故事/ }).click();
    await page.waitForFunction(() => !location.hash.includes('new=1') && /file=[^&]+/.test(location.hash), null, { timeout: 60000 });
    await synced();
};
await newStory();
check('new story starts with only the greeting', await page.locator('.tl-message').count() === 1);
await newStory();
const files = await chapterFiles();
check('starting a new story twice keeps one empty chapter', files.length === 2, JSON.stringify(files));

// Chapter switcher from the reader title.
await page.getByRole('button', { name: '切换故事' }).click();
const chapters = sheet('故事');
await chapters.locator('.tl-sheet-item', { hasText: /\d+ 条/ }).nth(1).waitFor({ timeout: 30000 }).catch(() => { });
check('chapter sheet lists both chapters and marks the open one',
    await chapters.locator('.tl-sheet-item[aria-current="true"]').count() === 1 && await chapters.locator('.tl-sheet-item').count() === 4,
    JSON.stringify(await chapters.locator('.tl-sheet-item').evaluateAll(items => items.map(i => `${i.getAttribute('aria-current') ?? ''}|${i.textContent}`))));
await chapters.locator('.tl-sheet-item:not([aria-current="true"])', { hasText: /\d+ 条/ }).first().click();
await page.locator('.tl-message', { hasText: first }).first().waitFor({ timeout: 30000 });
check('switching chapters opens the earlier story', true);

// Work page: rename (empty box for date-named chapters, duplicate names refused) and delete with confirmation.
await page.getByRole('button', { name: '切换故事' }).click();
await chapters.getByRole('button', { name: /^角色主页/ }).click();
await page.locator('.tl-chapter-row').nth(1).waitFor({ timeout: 30000 });
check('work page lists the chapters', await page.locator('.tl-chapter-row').count() === 2);
const newName = `雨夜${run}`;
const renameRow = async (index, name) => {
    await page.locator('.tl-chapter-row').nth(index).getByRole('button', { name: '故事操作' }).click();
    await page.getByRole('button', { name: '起名' }).click();
    const input = page.getByLabel('新的名字');
    const prefilled = await input.inputValue();
    await input.fill(name);
    return prefilled;
};
const prefilled = await renameRow(0, newName);
check('rename box starts empty for a date-named chapter', prefilled === '', prefilled);
await page.getByRole('button', { name: '保存' }).click();
await toast('故事已改名');
await page.locator('.tl-chapter-name', { hasText: newName }).waitFor({ timeout: 30000 });
check('rename a chapter', (await chapterFiles()).includes(`${newName}.jsonl`), JSON.stringify(await chapterFiles()));

const otherIndex = (await page.locator('.tl-chapter-name').allInnerTexts()).findIndex(t => !t.includes(newName));
await renameRow(otherIndex, newName.toUpperCase());
check('duplicate chapter names are refused before sending', await page.getByText('已有同名故事').count() === 1
    && await page.getByRole('button', { name: '保存' }).isDisabled());
await page.getByRole('button', { name: '取消' }).click();

const named = page.locator('.tl-chapter-row', { hasText: newName });
await named.getByRole('button', { name: '故事操作' }).click();
await page.getByRole('button', { name: /^删除/ }).click();
await sheet(/^删除「/).waitFor();
check('delete asks for confirmation', (await sheet(/^删除「/).innerText()).includes('找不回来'));
await sheet(/^删除「/).getByRole('button', { name: '删除', exact: true }).click();
await toast('故事已删除');
await page.waitForFunction(() => document.querySelectorAll('.tl-chapter-row').length === 1, null, { timeout: 30000 });
check('delete a chapter', (await chapterFiles()).length === 1, JSON.stringify(await chapterFiles()));

// Name, picture and tags are edited in the full app: from the character editor.
await page.getByRole('button', { name: /^编辑角色/ }).click();
await page.locator('.tl-editor').waitFor();
await page.getByRole('button', { name: /^在原版界面里编辑/ }).click();
await page.locator('iframe.engine.visible').waitFor({ timeout: 30000 });
const editing = await page.evaluate(() => document.querySelector('iframe.engine').contentDocument.querySelector('#character_name_pole')?.value);
check('edit character opens it in the full app', editing === NAME, editing);
await page.getByRole('button', { name: '返回轻酒馆' }).click();

// "Me" page: connection status in plain words, version check. (Editor → character page → shelf.)
await page.getByRole('button', { name: '返回' }).click();
await page.locator('.tl-work').waitFor();
await page.getByRole('button', { name: '返回' }).click();
await page.getByRole('button', { name: '我的' }).click();
await engineReady();
const meText = await page.locator('.tl-me').innerText();
check('me page shows the connection', /已连接|未连接/.test(meText), meText.slice(0, 300));
// As in M0: the versions tavern-lite lists as checked show 已验证, others 未在此版本验证.
const serverVersion = (await (await page.request.get(`${base}/version`)).json()).pkgVersion;
const testedHere = (process.env.TESTED_VERSIONS ?? '1.16.0,1.17.0,1.18.0,1.19.0').split(',').includes(serverVersion);
check('me page shows the version check', meText.includes(testedHere ? '已验证' : '未在此版本验证'), serverVersion);

// Reading settings: changes apply at once, survive a reload and are stored in the account. Start from the defaults,
// whatever an earlier run left in the account.
await page.getByRole('button', { name: /^阅读设置/ }).click();
await page.getByRole('button', { name: '恢复默认' }).click();
await page.getByRole('button', { name: '字号增大' }).click();
await page.getByRole('button', { name: '字号增大' }).click();
await sheet('阅读设置').getByRole('radio', { name: '夜间' }).click();
check('font size applies at once', await rootVar('--tl-font-size') === '19px', await rootVar('--tl-font-size'));
check('night theme applies at once', (await readingTheme()).includes('--tl-bg: #171513'), await readingTheme());
await page.getByRole('button', { name: '关闭' }).click();
await page.waitForTimeout(800);
const accountReading = await page.evaluate(() => document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().extensionSettings.tavernLite?.reading);
check('reading settings stored in the account', accountReading?.fontSize === 19 && accountReading?.theme === 'night', JSON.stringify(accountReading));
await page.reload();
await page.locator('.tl-me').waitFor();
check('reading settings survive a reload', await rootVar('--tl-font-size') === '19px' && (await readingTheme()).includes('--tl-bg: #171513'));

// Theme files: export, import, and a warning before a theme that loads from other sites.
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /^导出主题/ }).click()]);
const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
check('export theme', exported.format === 'tavern-lite-theme' && exported.reading.fontSize === 19, JSON.stringify(exported).slice(0, 200));
const themeInput = page.locator('.tl-me input[type="file"]');
const theme = (reading, customCss = '') => ({ name: 'theme.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...exported, themes: [], reading: { ...exported.reading, ...reading }, customCss })) });
await themeInput.setInputFiles(theme({ fontSize: 15, theme: 'green' }));
await toast('主题已导入');
check('import theme', await rootVar('--tl-font-size') === '15px' && (await readingTheme()).includes('--tl-bg: #dfeacf'));
await themeInput.setInputFiles(theme({ fontSize: 22 }, 'body { background: url(https://example.com/bg.png); }'));
await sheet('导入主题').waitFor();
check('external theme asks first', (await sheet('导入主题').innerText()).includes('其他网站'));
await sheet('导入主题').getByRole('button', { name: '取消' }).click();
check('cancelled theme is not applied', await rootVar('--tl-font-size') === '15px');
await themeInput.setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
await toast('这不是轻酒馆的主题文件');
check('wrong file explains itself', true);
await page.getByRole('button', { name: /^阅读设置/ }).click();
await page.getByRole('button', { name: '恢复默认' }).click();
await page.getByRole('button', { name: '关闭' }).click();

// Own theme, like a reading app's theme editor: start from a preset, pick colours, an effect and roundness, save.
const THEME = `测试主题${run}`;
const accountThemes = () => page.evaluate(() => document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().extensionSettings.tavernLite?.themes ?? []);
await page.getByRole('button', { name: /^做一个主题/ }).click();
await page.locator('.tl-theme-editor').waitFor();
await page.getByLabel('名字').fill(THEME);
await page.getByRole('button', { name: '背景 #18202b' }).click();
check('editor previews the theme on the page at once', await cssHas('--tl-bg: #18202b'), await readingTheme());
check('a dark background switches the text to a readable colour', await cssHas('--tl-text: #ddd6ca'));
await page.getByRole('button', { name: '对白加粗' }).click();
check('one-tap effect adds its CSS', (await page.locator('.tl-theme-css').inputValue()).includes('font-weight: 600') && await cssHas('q { font-weight: 600; }'));
await page.getByLabel('圆角').evaluate(el => { el.value = '4'; el.dispatchEvent(new Event('input', { bubbles: true })); });
check('roundness slider applies', await cssHas('--tl-radius: 4px'));
await page.getByRole('button', { name: '返回' }).click();
await sheet('还没保存').waitFor();
check('leaving with unsaved changes asks first', true);
await sheet('还没保存').getByRole('button', { name: '取消' }).click();
await page.getByRole('button', { name: '保存', exact: true }).click();
await toast('主题已保存并使用');
await page.locator('.tl-me').waitFor();
await engineReady();
await page.waitForTimeout(800);
const saved = (await accountThemes()).find(t => t.name === THEME);
check('own theme stored in the account', !!saved && saved.radius === 4 && saved.css.includes('font-weight: 600'), JSON.stringify(saved));
await page.reload();
await page.locator('.tl-me').waitFor();
check('own theme survives a reload', (await readingTheme()).includes('--tl-bg: #18202b'));
await engineReady();

// Share just this theme, import it back as a copy, then delete both.
await page.getByRole('button', { name: /^阅读设置/ }).click();
check('own theme appears among the theme cards', await sheet('阅读设置').getByRole('radio', { name: THEME }).getAttribute('aria-checked') === 'true');
await page.getByRole('button', { name: /^编辑「/ }).click();
await page.locator('.tl-theme-editor').waitFor();
const [shared] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '分享这个主题' }).click()]);
const sharedFile = JSON.parse(await readFile(await shared.path(), 'utf8'));
check('share one theme', sharedFile.themes?.length === 1 && sharedFile.themes[0].name === THEME && sharedFile.reading === undefined, JSON.stringify(sharedFile).slice(0, 200));
await page.getByRole('button', { name: '返回' }).click();
await page.locator('.tl-me').waitFor();
await themeInput.setInputFiles({ name: 'shared.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(sharedFile)) });
await toast(`已导入主题「${THEME}」`);
await page.waitForTimeout(800);
check('import a shared theme as a copy', (await accountThemes()).filter(t => t.name === THEME).length === 2);
for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: /^阅读设置/ }).click();
    const card = sheet('阅读设置').getByRole('radio', { name: THEME }).first();
    if (await card.getAttribute('aria-checked') !== 'true') await card.click();
    await page.getByRole('button', { name: /^编辑「/ }).click();
    await page.getByRole('button', { name: '删除主题' }).click();
    await sheet(/^删除「/).getByRole('button', { name: '删除', exact: true }).click();
    await page.locator('.tl-me').waitFor();
}
await page.waitForTimeout(800);
check('delete own themes', (await accountThemes()).every(t => t.name !== THEME) && !(await readingTheme()).includes('#18202b'));

// Saving data, per device: the 省流量 switch on 我的 (= "when typing"). The older manual mode stays supported for
// devices that chose it before: it does not load the full app until asked.
const saver = page.getByRole('switch', { name: /^省流量/ });
await saver.click();
check('省流量 switch turns on the typing mode', await saver.getAttribute('aria-checked') === 'true'
    && await page.evaluate(() => localStorage.getItem('tavern-lite:engine-mode')) === 'input');
await saver.click();
await page.evaluate(() => localStorage.setItem('tavern-lite:engine-mode', 'manual'));
await page.goto('about:blank');
await page.goto(`${appUrl}#chat=${encodeURIComponent(avatar)}&file=`);
await page.locator('.tl-message').first().waitFor();
await page.waitForTimeout(3000);
check('manual mode does not load the full app', await page.locator('iframe.engine').count() === 0);
check('manual mode says how to start', (await page.locator('.tl-engine-status').innerText()).includes('省流量'));
await page.locator('.tl-composer-input').focus();
await page.waitForTimeout(500);
check('manual mode ignores typing', await page.locator('iframe.engine').count() === 0);
await page.getByRole('button', { name: '现在准备' }).click();
await synced();
check('start now loads the full app', true);

await page.evaluate(() => localStorage.setItem('tavern-lite:engine-mode', 'input'));
await page.goto('about:blank');
await page.goto(`${appUrl}#chat=${encodeURIComponent(avatar)}&file=`);
await page.locator('.tl-message').first().waitFor();
await page.waitForTimeout(2000);
check('typing mode waits while reading', await page.locator('iframe.engine').count() === 0);
await page.locator('.tl-composer-input').focus();
await page.locator('iframe.engine').waitFor({ state: 'attached', timeout: 5000 }).then(() => check('typing mode starts on focus', true))
    .catch(() => check('typing mode starts on focus', false));
await synced();
await page.evaluate(() => localStorage.removeItem('tavern-lite:engine-mode'));

await cleanup();
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(JSON.stringify(results, null, 1));
await browser.close();
process.exit(problems.length ? 1 : 0);
