// Renaming stories where they are listed, on an official SillyTavern with tavern-lite only: the 故事 list renames
// another story (its file) and a 番外 (its title) and stays open; the 番外与平行线 sheet renames the 正文 being read
// (its file: the line stays its line, the draft follows) and the line being read (its title). Nothing is sent to the model.
// Usage: node e2e-story-rename.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `改名${run}`, TITLE = `岔路${run}`, TITLE2 = `雨夜${run}`, TITLE3 = `灯塔${run}`;
const OTHER = `另一个${run}`, OTHER2 = `另一个改过${run}`, ROOT2 = `正文改过${run}`, DRAFT = `正文里没发的草稿 ${run}`;
let FILE = '';
const results = {}, problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 400); if (!ok) problems.push(name); console.log(ok ? 'PASS' : 'FAIL', name); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const pageErrors = [], modelCalls = [];
context.on('request', request => { if (/chat-completions\/generate/.test(request.url())) modelCalls.push(request.url()); });
const api = context.request;
const { token } = await (await api.get(`${base}/csrf-token`)).json();
const post = (path, data) => api.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const created = await api.post(`${base}/api/characters/create`, { headers: { 'X-CSRF-Token': token },
    multipart: { ch_name: NAME, description: '', first_mes: '你来了。', personality: '', scenario: '', mes_example: '', creator_notes: '',
        system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' } });
const avatar = (await created.text()).trim();
const chats = async () => (await (await post('/api/characters/chats', { avatar_url: avatar })).json()).map(c => c.file_name.replace(/\.jsonl$/, ''));

const page = await context.newPage();
page.setDefaultTimeout(30000);
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
const synced = () => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const openStory = async file => { await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file })}`); await synced(); };
const routeFile = () => page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('file'));
const dialog = name => page.getByRole('dialog', { name, exact: true });
const rows = sheet => sheet.locator('.tl-sheet-item-label').allInnerTexts();

try {
    await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar })}`); await synced();
    for (let i = 0; i < 20 && !FILE; i++) { FILE = (await chats())[0] ?? ''; if (!FILE) await page.waitForTimeout(1000); }
    if (!FILE) throw new Error('the app made no story');
    // Another story of the same character, with a name of its own.
    const saved = await post('/api/chats/save', { ch_name: NAME, file_name: OTHER, avatar_url: avatar, force: true, chat: [
        { user_name: 'User', character_name: NAME, create_date: new Date().toISOString(), chat_metadata: {} },
        { name: NAME, is_user: false, is_system: false, send_date: new Date().toISOString(), mes: '另一个故事的开头。' }] });
    check('a second story is there', saved.ok() && (await chats()).includes(OTHER), await saved.text());

    // A line of the 正文, made through the sheet and stopped before sending.
    await openStory(FILE);
    const before = new Set(await chats());
    await page.getByRole('button', { name: '番外与平行线', exact: true }).click();
    const episodes = dialog('番外与平行线');
    await episodes.getByRole('button', { name: '＋ 新开番外 / 平行线 / 小剧场', exact: true }).click();
    await episodes.getByRole('radio', { name: '接续正文最新进度', exact: true }).click();
    await episodes.getByLabel('标题', { exact: true }).fill(TITLE);
    await episodes.getByLabel('开场或续写要求').fill(`开场：${TITLE}`);
    await episodes.getByRole('button', { name: '下一步：确认发送', exact: true }).click();
    const review = dialog('确认发送');
    await review.waitFor({ timeout: 180000 });
    await review.getByRole('button', { name: '先不发', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 30000 }).catch(() => { });
    const line = (await chats()).find(name => !before.has(name));
    if (!line) throw new Error('no line was made');
    await openStory(FILE);

    // The 故事 list: another story renamed, without leaving the one being read.
    await page.getByRole('button', { name: '切换故事', exact: true }).click();
    const list = dialog('故事');
    await list.getByRole('button', { name: `给「${OTHER}」改名`, exact: true }).click();
    const prompt = dialog('给故事起名');
    check('a named story starts from its name', await prompt.getByLabel('新的名字').inputValue() === OTHER);
    await prompt.getByLabel('新的名字').fill(OTHER2);
    await prompt.getByRole('button', { name: '保存', exact: true }).click();
    await list.getByRole('button', { name: `给「${OTHER2}」改名`, exact: true }).waitFor({ timeout: 60000 });
    const names = await chats();
    check('renamed from the list: the file has the new name, and the list is back with it', names.includes(OTHER2) && !names.includes(OTHER), names);
    check('the story being read stays open', await routeFile() === FILE);
    await page.screenshot({ path: '/tmp/tl-rename-list.png' });

    // The 故事 list: a 番外 renamed by its title; its file stays.
    await list.getByRole('button', { name: `给「番外 · ${TITLE}」改名`, exact: true }).click();
    const titleSheet = dialog('改标题');
    check('a 番外 opens its title', await titleSheet.getByLabel('标题', { exact: true }).inputValue() === TITLE);
    check('its file name is one step further, under 更多', await titleSheet.getByText('更多', { exact: true }).isVisible()
        && !await titleSheet.getByRole('button', { name: '改原版界面里显示的文件名', exact: true }).isVisible());
    await titleSheet.getByLabel('标题', { exact: true }).fill(TITLE2);
    await titleSheet.getByRole('button', { name: '保存标题', exact: true }).click();
    await list.getByRole('button', { name: `给「番外 · ${TITLE2}」改名`, exact: true }).waitFor({ timeout: 60000 });
    check('the title changed, the file did not', (await chats()).includes(line) && (await rows(list)).some(x => x.includes(`番外 · ${TITLE2}`)), await rows(list));
    await list.getByRole('button', { name: '关闭' }).click();

    // A draft in the 正文, then the 正文 renamed from the 番外与平行线 sheet it is read in.
    await page.locator('.tl-composer-input').fill(DRAFT);
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: '番外与平行线', exact: true }).click();
    await episodes.locator('.tl-episode-tree [data-depth="1"]').first().waitFor({ timeout: 60000 });
    await page.screenshot({ path: '/tmp/tl-rename-episodes-root.png' });
    await episodes.locator('.tl-episode-here').getByRole('button', { name: /改名$/ }).click();
    const rootPrompt = dialog('给故事起名');
    await rootPrompt.getByLabel('新的名字').fill(ROOT2);
    await rootPrompt.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(f => new URLSearchParams(location.hash.slice(1)).get('file') === f, ROOT2, { timeout: 60000 });
    await synced();
    check('the 正文 has its new name and stays open', (await chats()).includes(ROOT2) && !(await chats()).includes(FILE));
    check('the draft followed the 正文', await page.locator('.tl-composer-input').inputValue() === DRAFT);
    await page.locator('.tl-branch-mark').filter({ hasText: TITLE2 }).waitFor({ timeout: 30000 }).catch(() => { });
    check('the 正文 still marks its line', await page.locator('.tl-branch-mark').filter({ hasText: TITLE2 }).count() === 1);
    await page.getByRole('button', { name: '番外与平行线', exact: true }).click();
    const tree = episodes.locator('.tl-episode-tree');
    await tree.locator('[data-depth="1"]').first().waitFor({ timeout: 60000 });
    const treeRows = await tree.locator('.tl-episode-list-row').allInnerTexts();
    check('the sheet names the 正文 and still hangs the line under it', treeRows.length === 2 && treeRows[0].startsWith(`正文 · ${ROOT2}`) && treeRows[1].includes(TITLE2), treeRows);

    // Into the line, and its title changed from the sheet: the sheet comes back with it.
    await tree.locator('[data-depth="1"] .tl-sheet-item').click();
    await page.waitForFunction(f => new URLSearchParams(location.hash.slice(1)).get('file') === f, line, { timeout: 60000 });
    await synced();
    await page.getByRole('button', { name: '番外与平行线', exact: true }).click();
    await tree.locator('[data-depth="1"] .tl-sheet-item[aria-current="true"]').waitFor({ timeout: 60000 });
    check('inside the line 回正文 is still there', await tree.getByRole('button', { name: '回正文', exact: true }).isVisible());
    await page.screenshot({ path: '/tmp/tl-rename-episodes-line.png' });
    await tree.locator('[data-depth="1"]').getByRole('button', { name: /改名$/ }).click();
    await titleSheet.getByLabel('标题', { exact: true }).fill(TITLE3);
    await titleSheet.getByRole('button', { name: '保存标题', exact: true }).click();
    await episodes.getByText(`你在：番外 · ${TITLE3}`).waitFor({ timeout: 60000 });
    check('back in the sheet with the new title, the same file open', await routeFile() === line);
    await episodes.getByRole('button', { name: '关闭' }).click();
    await page.locator('.tl-chapter').filter({ hasText: TITLE3 }).waitFor({ timeout: 30000 }).catch(() => { });
    check('the page title follows', (await page.locator('.tl-chapter').innerText()).includes(TITLE3), await page.locator('.tl-chapter').innerText());

    // The 更多 menu of a line offers its title too (it used to offer nothing).
    await page.getByRole('button', { name: '更多', exact: true }).click();
    check('the 更多 menu of a line has 改标题', await dialog(NAME).getByRole('button', { name: /^改标题/ }).count() === 1);
    await dialog(NAME).getByRole('button', { name: '关闭' }).click();

    check('nothing was sent to the model', modelCalls.length === 0, modelCalls);
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
    problems.push('crashed');
    console.log('FAILURE', error.stack);
    await page.screenshot({ path: '/tmp/tl-rename-fail.png' }).catch(() => { });
}
await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS: ${problems.join(', ')}` : 'ALL PASS');
process.exitCode = problems.length ? 1 : 0;
