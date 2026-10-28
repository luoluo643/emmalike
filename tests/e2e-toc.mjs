// The story's contents (目录): a drawer from the left with one entry per reply, titled by what Horae recorded, the one
// being read marked, no 摘要 view; a tap or a floor number goes there, loading earlier messages as needed.
// The Horae records are in the chat file, so Horae itself need not be installed.
// Usage: node e2e-toc.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `目录测试${run}`;
const FLOORS = 130;
const results = {};
const problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`; if (!ok) problems.push(name); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
let avatar = '';

let failing = false;
process.on('uncaughtException', async error => {
    if (failing) process.exit(3);
    failing = true;
    console.log('FAILURE', error.message.split('\n').slice(0, 12).join(' | '), (error.stack ?? '').split('\n').find(l => l.includes('e2e-toc.mjs')));
    console.log(JSON.stringify({ results, pageErrors }, null, 1));
    if (process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT }).catch(() => { });
    if (avatar) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
    await browser.close();
    process.exit(2);
});

if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const created = await page.request.post(`${base}/api/characters/create`, {
    headers: { 'X-CSRF-Token': token },
    multipart: {
        ch_name: NAME, description: '测试目录', first_mes: '“你来了。”', personality: '', scenario: '', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '',
    },
});
avatar = (await created.text()).trim();
if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);

// #0 the opening (no Horae record), then user / reply pairs; each reply has Horae's event, a new day every 40 floors,
// a stretch summary at #61, and #21 is hidden from the AI.
const now = () => new Date().toISOString();
const meta = { user_name: 'User', character_name: NAME, create_date: now(), chat_metadata: {} };
const lines = Array.from({ length: FLOORS }, (_, i) => {
    if (i === 0) return { name: NAME, is_user: false, mes: '“你来了。”', send_date: now(), extra: {} };
    if (i % 2 === 0) return { name: 'User', is_user: true, mes: `第${i}楼我说的话`, send_date: now(), extra: {} };
    const events = [{ level: '重要', summary: `第${i}楼发生的事` }, { level: '一般', summary: `第${i}楼的小事` }];
    if (i === 61) events.push({ level: '摘要', isSummary: true, summary: '前六十楼的阶段摘要' });
    return { name: NAME, is_user: false, is_system: i === 21, mes: `第${i}楼的正文。${'雨一直下。'.repeat(30)}`, send_date: now(), extra: {},
        horae_meta: { timestamp: { story_date: `2026/10/${10 + Math.floor(i / 40)}` }, scene: { location: i < 60 ? '公寓' : '医院' }, events } };
});
const file = `目录${run}`;
if (!(await post('/api/chats/save', { ch_name: NAME, file_name: file, avatar_url: avatar, chat: [meta, ...lines], force: true })).ok()) throw new Error('chat not saved');

await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file })}`);
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
await page.waitForTimeout(1500);

const toc = page.getByRole('dialog', { name: '目录' });
const entry = n => toc.locator('.tl-toc-entry', { has: page.locator('.tl-toc-floor', { hasText: new RegExp(`^#${n}$`) }) });
const openToc = async () => { await page.getByRole('button', { name: '目录', exact: true }).click(); await toc.waitFor(); await page.waitForTimeout(300); };
// Where message `n` sits under the top of the story list (the reading position puts it about 80px down).
const offset = n => page.evaluate(i => {
    const list = document.querySelector('.tl-messages'), el = list.querySelector(`.tl-message[data-index="${i}"]`);
    return el ? Math.round(el.getBoundingClientRect().top - list.getBoundingClientRect().top) : null;
}, n);

await openToc();
const box = await page.evaluate(() => { const r = document.querySelector('.tl-toc').getBoundingClientRect(); return { left: r.left, top: r.top, height: r.height, width: r.width }; });
check('drawer comes from the left over the whole height', box.left === 0 && box.top === 0 && box.height >= 840 && box.width < 390, JSON.stringify(box));
const count = await toc.locator('.tl-toc-entry').count();
check('one entry per reply', count === 66, String(count));
check('titled by Horae\'s most telling event', (await entry(11).textContent()).includes('第11楼发生的事'), await entry(11).textContent());
check('the opening is titled by its words', (await entry(0).textContent()).includes('“你来了。”'), await entry(0).textContent());
const groups = await toc.locator('.tl-toc-group-title').allTextContents();
check('grouped by story day', groups[0] === '2026/10/10 · #0–39' && groups.length === 4, JSON.stringify(groups));
check('hidden reply is marked', (await entry(21).textContent()).includes('AI 看不到'), await entry(21).textContent());
const current = await toc.locator('.tl-toc-entry[aria-current="true"] .tl-toc-floor').textContent();
check('at the end of the story the last replies are current', Number(current.slice(1)) >= 120, current);
const currentShown = await toc.locator('.tl-toc-entry[aria-current="true"]').evaluate(el => {
    const r = el.getBoundingClientRect(), l = el.closest('.tl-toc-list').getBoundingClientRect();
    return r.top >= l.top && r.bottom <= l.bottom;
});
check('opened at the current entry', currentShown);
const text = await toc.textContent();
check('titles only, no 摘要 view', !text.includes('第11楼的小事') && !text.includes('阶段摘要') && !text.includes('医院')
    && await toc.getByRole('radio').count() === 0, text.slice(0, 200));

await toc.getByRole('searchbox', { name: '搜索目录' }).fill('第61楼发生');
check('search finds a title', await toc.locator('.tl-toc-entry').count() === 1);
await toc.getByRole('searchbox', { name: '搜索目录' }).fill('');

// A tap goes to the reply, loading earlier messages (only the last 40 are shown at first).
check('#11 not loaded before the jump', await offset(11) === null);
await entry(11).click();
await toc.waitFor({ state: 'detached', timeout: 5000 });
await page.waitForTimeout(800);
const at11 = await offset(11);
check('tap goes to the reply', at11 !== null && at11 >= 0 && at11 <= 200, String(at11));

// A floor number goes there too, a user's line included.
await openToc();
check('the reply just read is current', (await toc.locator('.tl-toc-entry[aria-current="true"] .tl-toc-floor').textContent()) === '#11');
const floor = toc.getByRole('textbox', { name: '跳到第几楼' });
await floor.fill('9999');
await toc.getByRole('button', { name: '跳转' }).click();
check('a floor past the end is refused', (await toc.getByRole('alert').textContent()).includes(`#0–#${FLOORS - 1}`), await toc.getByRole('alert').textContent().catch(() => ''));
await floor.fill('4');
await floor.press('Enter');
await toc.waitFor({ state: 'detached', timeout: 5000 });
await page.waitForTimeout(800);
const at4 = await offset(4);
check('a floor number goes there', at4 !== null && at4 >= 0 && at4 <= 200, String(at4));

await openToc();
await toc.getByRole('button', { name: /正序/ }).click();
const first = await toc.locator('.tl-toc-entry .tl-toc-floor').first().textContent();
check('倒序 puts the newest first', first === `#${FLOORS - 1}`, first);
await toc.getByRole('button', { name: '关闭' }).click();
await toc.waitFor({ state: 'detached', timeout: 5000 }).then(() => check('close button closes it', true)).catch(() => check('close button closes it', false));

// Also reachable from the story menu.
await page.getByRole('button', { name: '更多' }).click();
await page.getByRole('dialog').getByRole('button', { name: /^目录/ }).click();
await toc.waitFor({ timeout: 5000 }).then(() => check('story menu opens the contents', true)).catch(() => check('story menu opens the contents', false));

if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}-list.png` });

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS ${problems.join(', ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
