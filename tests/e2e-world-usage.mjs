// Where a world book is used, changed in the shell: on for every story and off again; a character without a book of
// its own gets it as its own (written on the card), one that has a book gets it as an additional book; both are taken
// off again. Each change is checked in the files the app saves (the character card and the account settings).
// Usage: node e2e-world-usage.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const BOOK = `用处${run}`, OTHER = `别的书${run}`, NAME_A = `甲${run}`, NAME_B = `乙${run}`;
const results = {}, problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`; if (!ok) problems.push(name); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
const worldSettings = async () => JSON.parse((await (await post('/api/settings/get', {})).json()).settings).world_info_settings?.world_info ?? {};
const cardWorld = async avatar => (await (await post('/api/characters/get', { avatar_url: avatar })).json())?.data?.extensions?.world ?? '';
const until = async (condition, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await condition().catch(() => false)) return true; await page.waitForTimeout(400); }
    return false;
};

let avatarA = '', avatarB = '';
const cleanup = async () => {
    await page.evaluate(([book]) => {
        const w = document.querySelector('iframe.engine')?.contentWindow, b = w?.TavernLiteBridge;
        return b?.setWorldBookGlobal?.(book, false).catch(() => { });
    }, [BOOK]).catch(() => { });
    for (const avatar of [avatarA, avatarB]) if (avatar) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
    for (const name of [BOOK, OTHER]) await post('/api/worldinfo/delete', { name }).catch(() => { });
};
let failing = false;
process.on('uncaughtException', async error => {
    if (failing) process.exit(3);
    failing = true;
    console.log('FAILURE', error.message.split('\n').slice(0, 8).join(' | '), (error.stack ?? '').split('\n').find(l => l.includes('e2e-world-usage')));
    console.log(JSON.stringify({ results, pageErrors }, null, 1));
    if (process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT }).catch(() => { });
    await cleanup(); await browser.close(); process.exit(2);
});
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');

const entry = { uid: 0, key: ['钟声'], keysecondary: [], comment: '钟声', content: '镇上的钟每天敲三次。', constant: false, disable: false, order: 100, position: 0, displayIndex: 0 };
for (const name of [BOOK, OTHER]) check(`book ${name} saved`, (await post('/api/worldinfo/edit', { name, data: { entries: { 0: entry } } })).ok());
avatarA = await (await post('/api/characters/create', { ch_name: NAME_A, description: '测试角色' })).text();
avatarB = await (await post('/api/characters/create', { ch_name: NAME_B, description: '测试角色', world: OTHER })).text();
check('characters created', avatarA.endsWith('.png') && avatarB.endsWith('.png') && await cardWorld(avatarB) === OTHER, `${avatarA} ${avatarB}`);
const fileB = avatarB.replace(/\.png$/, '');

await page.goto(`${appUrl}#${new URLSearchParams({ world: BOOK })}`);
await page.locator('.tl-world-usage').waitFor({ timeout: 240000 });
const globalSwitch = page.locator('.tl-world-usage').getByRole('switch', { name: /^所有故事都用/ });
// Clicked, then shows the new state once the save is done.
const flip = async locator => {
    const expected = await locator.getAttribute('aria-checked') === 'true' ? 'false' : 'true';
    await locator.click();
    await page.waitForFunction(([el, want]) => el.getAttribute('aria-checked') === want && el.getAttribute('aria-busy') !== 'true', [await locator.elementHandle(), expected], { timeout: 30000 });
};

// Every story.
check('starts off for every story', await globalSwitch.getAttribute('aria-checked') === 'false');
await flip(globalSwitch);
check('the switch shows on', await globalSwitch.getAttribute('aria-checked') === 'true');
check('every story: saved in the settings', await until(async () => (await worldSettings()).globalSelect?.includes(BOOK)));
await page.waitForTimeout(400);
check('the book page names it', (await page.locator('.tl-world-scope').innerText()).includes('所有故事'));
await flip(globalSwitch);
check('and off again', await until(async () => !(await worldSettings()).globalSelect?.includes(BOOK)) && await globalSwitch.getAttribute('aria-checked') === 'false');

// Characters.
await page.locator('.tl-world-usage').getByRole('button', { name: /^用它的角色 · 0/ }).click();
const sheet = page.getByRole('dialog', { name: '选择用这本世界书的角色' });
await sheet.waitFor();
const rowA = sheet.getByRole('switch', { name: `「${NAME_A}」用这本世界书` }), rowB = sheet.getByRole('switch', { name: `「${NAME_B}」用这本世界书` });
check('a character with its own book says so', (await rowB.innerText()).includes(`已有自己的世界书「${OTHER}」`));
await flip(rowA);
check('a character without a book gets it as its own (on the card)', await until(async () => await cardWorld(avatarA) === BOOK) && (await rowA.innerText()).includes('它自己的世界书'));
await flip(rowB);
const extraSaved = await until(async () => ((await worldSettings()).charLore ?? []).some(lore => lore.name === fileB && lore.extraBooks?.includes(BOOK)));
check('a character with a book gets it as an additional one', extraSaved && (await rowB.innerText()).includes('附加的世界书'));
check('its own book is left as it was', await cardWorld(avatarB) === OTHER);
await sheet.getByRole('button', { name: '关闭' }).click();
await sheet.waitFor({ state: 'detached' });
const summary = await page.locator('.tl-world-usage').getByRole('button', { name: /^用它的角色/ }).innerText();
check('the page lists both characters', summary.includes('· 2') && summary.includes(NAME_A) && summary.includes(NAME_B), summary);
check('the book page’s note names them', await until(async () => { const t = await page.locator('.tl-world-scope').innerText(); return t.includes(NAME_A) && t.includes(NAME_B); }, 5000));

// The list of books says the same.
await page.goto(`${appUrl}#worlds`);
const listed = await page.locator('.tl-worlds .tl-list-item', { hasText: BOOK }).innerText({ timeout: 30000 });
check('the list of books shows the characters', listed.includes(NAME_A) && listed.includes(NAME_B), listed);

// Taken off again.
await page.goto(`${appUrl}#${new URLSearchParams({ world: BOOK })}`);
await page.locator('.tl-world-usage').getByRole('button', { name: /^用它的角色 · 2/ }).click({ timeout: 60000 });
await sheet.waitFor();
await flip(rowA);
await flip(rowB);
check('off for the first: the card no longer points to it', await until(async () => await cardWorld(avatarA) === ''));
check('off for the second: no longer an additional book', await until(async () => !((await worldSettings()).charLore ?? []).some(lore => lore.extraBooks?.includes(BOOK))));
check('the second keeps its own book', await cardWorld(avatarB) === OTHER);
check('both switches show off', await rowA.getAttribute('aria-checked') === 'false' && await rowB.getAttribute('aria-checked') === 'false');

await cleanup();
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `FAILED: ${problems.join(', ')}` : 'ALL PASS');
await browser.close();
process.exit(problems.length ? 1 : 0);
