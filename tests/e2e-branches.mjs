// The 正文 and its 番外/平行线 as a main story and branches, on an official SillyTavern with tavern-lite only: a mark
// under the 正文 message a line left at opens that line; inside it a path back to the 正文 and a divider where the
// copied 正文 ends; the 番外与平行线 sheet is a tree. Nothing is sent to the model.
// Usage: node e2e-branches.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `分支${run}`, TITLE = `岔路${run}`;
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

try {
    // The 正文 made by the app itself (the character's greeting), as a story written in it would be.
    await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar })}`); await synced();
    for (let i = 0; i < 20 && !FILE; i++) { FILE = (await chats())[0] ?? ''; if (!FILE) await page.waitForTimeout(1000); }
    if (!FILE) throw new Error('the app made no story');
    await openStory(FILE);
    const lastIndex = await page.locator('.tl-message').last().getAttribute('data-index');
    check('an ordinary story has no branch marks or path', await page.locator('.tl-branch-mark').count() === 0 && await page.locator('.tl-branch-path').count() === 0);

    // A line made through the sheet (stopped before sending: the line exists, nothing goes to the model).
    const before = new Set(await chats());
    await page.getByRole('button', { name: '番外与平行线', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: '番外与平行线', exact: true });
    await sheet.getByRole('button', { name: '＋ 新开番外 / 平行线 / 小剧场', exact: true }).click();
    await sheet.getByRole('radio', { name: '接续正文最新进度', exact: true }).click();
    await sheet.getByLabel('标题', { exact: true }).fill(TITLE);
    await sheet.getByLabel('开场或续写要求').fill(`开场：${TITLE}`);
    await sheet.getByRole('button', { name: '下一步：确认发送', exact: true }).click();
    const review = page.getByRole('dialog', { name: '确认发送', exact: true });
    await review.waitFor({ timeout: 180000 });
    await review.getByRole('button', { name: '先不发', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 30000 }).catch(() => { });
    const line = (await chats()).find(name => !before.has(name));
    check('the line exists', !!line, String(line));

    // 正文: the mark under the message the line left at.
    await openStory(FILE);
    const mark = page.locator('.tl-branch-mark').filter({ hasText: TITLE });
    await mark.waitFor({ timeout: 30000 });
    const markedAt = await mark.evaluate(el => el.closest('.tl-branch-marks')?.previousElementSibling?.dataset.index ?? null);
    check('the 正文 shows where the line left, under the last copied message', markedAt === lastIndex, `${markedAt} vs ${lastIndex}`);
    check('the mark says what it is', (await mark.innerText()).includes(`从这里分出：番外 · ${TITLE}`), await mark.innerText());
    await page.screenshot({ path: '/tmp/tl-branches-root.png' });

    // One tap into the line: the path back and the divider where the copied 正文 ends.
    await mark.click();
    await page.waitForFunction(f => new URLSearchParams(location.hash.slice(1)).get('file') === f, line, { timeout: 30000 });
    await synced();
    const path = page.locator('.tl-branch-path');
    await path.waitFor();
    check('inside the line a path leads back to the 正文', (await path.innerText()).includes('正文') && (await path.innerText()).includes(TITLE), await path.innerText());
    const dividerAfter = await page.locator('.tl-branch-divider').evaluate(el => el.previousElementSibling?.dataset.index ?? null).catch(() => null);
    check('a divider marks where the copied 正文 ends', dividerAfter === lastIndex, `${dividerAfter} vs ${lastIndex}`);
    await page.screenshot({ path: '/tmp/tl-branches-line.png' });

    // The sheet as a tree from inside the line.
    await page.getByRole('button', { name: '番外与平行线', exact: true }).click();
    const tree = page.getByRole('dialog', { name: '番外与平行线', exact: true }).locator('.tl-episode-tree');
    await tree.waitFor();
    await tree.locator('[data-depth="1"] .tl-sheet-item[aria-current="true"]').waitFor({ timeout: 30000 }).catch(() => { });
    const rows = await tree.locator('.tl-episode-list-row').allInnerTexts();
    check('the sheet lists the 正文 first, then the line marked as being read', rows.length === 2 && rows[0].startsWith('正文') && rows[1].includes(TITLE)
        && await tree.locator('[data-depth="1"] .tl-sheet-item[aria-current="true"]').count() === 1, rows);
    check('the 正文 row has 回正文', await tree.getByRole('button', { name: '回正文', exact: true }).isVisible());
    await page.screenshot({ path: '/tmp/tl-branches-sheet.png' });
    await page.getByRole('dialog', { name: '番外与平行线', exact: true }).getByRole('button', { name: '关闭' }).click();

    // Back to the 正文 from the path: a separate story, unchanged.
    await path.getByRole('button', { name: '正文', exact: true }).click();
    await page.waitForFunction(f => new URLSearchParams(location.hash.slice(1)).get('file') === f, FILE, { timeout: 30000 });
    await synced();
    check('the path opens the 正文', await routeFile() === FILE);
    await page.locator('.tl-branch-mark').filter({ hasText: TITLE }).waitFor({ timeout: 30000 }).catch(() => { });
    check('the 正文 is unchanged and still marks the line', await page.locator('.tl-branch-mark').filter({ hasText: TITLE }).count() === 1);
    check('nothing was sent to the model', modelCalls.length === 0, modelCalls);
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
    problems.push('crashed');
    console.log('FAILURE', error.stack);
    await page.screenshot({ path: '/tmp/tl-branches-fail.png' }).catch(() => { });
}
await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS: ${problems.join(', ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
