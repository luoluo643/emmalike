// Horae storylines in the shell: each line reads as a story of its own (its messages, where other lines leave it, a path
// back), what is written there goes on it, and the full app still shows the whole story; Horae's tags are not mirrored.
// Needs Horae (SillyTavern-Horae with storylines) installed next to tavern-lite.
// Usage: node e2e-storylines.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `故事线测试${run}`;
const LINE = 'sl_test1';
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
let avatar = '';

let failing = false;
process.on('uncaughtException', async error => {
    if (failing) process.exit(3);
    failing = true;
    console.log('FAILURE', error.message.split('\n').slice(0, 12).join(' | '), (error.stack ?? '').split('\n').find(l => l.includes('e2e-storylines.mjs')));
    console.log(JSON.stringify({ toasts: await page.evaluate(() => window.__tlToasts).catch(() => null), results, pageErrors }, null, 1));
    if (process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT }).catch(() => { });
    if (avatar) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
    await browser.close();
    process.exit(2);
});

if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const created = await page.request.post(`${base}/api/characters/create`, {
    headers: { 'X-CSRF-Token': token },
    multipart: {
        ch_name: NAME, description: '测试 Horae 故事线', first_mes: '“你来了。”', personality: '', scenario: '', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '',
    },
});
avatar = (await created.text()).trim();
if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);

// A story with 正文 (#0–2), a 番外 「古风」 (#3–4), a 番外 of that one 「丧尸男友」 (#5–6), then 「古风」 again (#7–8),
// as Horae records it.
const ZOMBIE = 'sl_test2';
const now = () => new Date().toISOString();
const meta = { user_name: 'User', character_name: NAME, create_date: now(),
    chat_metadata: { horae_storylines: { version: 1, lines: {
        [LINE]: { title: '古风', kind: 'side', parent: 'main', createdAt: now(), borrowProfiles: true },
        [ZOMBIE]: { title: '丧尸男友', kind: 'side', parent: LINE, createdAt: now(), borrowProfiles: true },
    }, pending: null } } };
const lines = [
    { name: NAME, is_user: false, mes: '“你来了。”', send_date: now(), extra: {} },
    { name: 'User', is_user: true, mes: '正文里的一句话', send_date: now(), extra: {} },
    { name: NAME, is_user: false, mes: '正文里的回答', send_date: now(), extra: {} },
    { name: 'User', is_user: true, mes: '开一个古风番外', send_date: now(), extra: {}, horae_storyline: LINE },
    { name: NAME, is_user: false, mes: '古风番外的开头', send_date: now(), extra: {} },
    { name: 'User', is_user: true, mes: '再写个丧尸小剧场', send_date: now(), extra: {}, horae_storyline: ZOMBIE },
    { name: NAME, is_user: false, mes: '丧尸小剧场的回答', send_date: now(), extra: {} },
    { name: 'User', is_user: true, mes: '回到古风', send_date: now(), extra: {}, horae_storyline: LINE },
    { name: NAME, is_user: false, mes: '古风接着写', send_date: now(), extra: {} },
];
const file = `故事线${run}`;
if (!(await post('/api/chats/save', { ch_name: NAME, file_name: file, avatar_url: avatar, chat: [meta, ...lines], force: true })).ok()) throw new Error('chat not saved');

await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file })}`);
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const hasHorae = await engineEval(w => typeof w.Horae?.getStorylines === 'function');
check('Horae with storylines is installed', hasHorae);
if (!hasHorae) throw new Error('Horae storylines not available');
const bar = () => page.locator('.tl-episode-bar > span').textContent();
const shown = () => page.evaluate(() => [...document.querySelectorAll('.tl-messages .tl-message[data-index]')].map(n => Number(n.dataset.index)));
const path = () => page.locator('.tl-branch-path').textContent().catch(() => '');
const showing = (list, timeout = 20000) => page.waitForFunction(want => JSON.stringify([...document.querySelectorAll('.tl-messages .tl-message[data-index]')]
    .map(n => Number(n.dataset.index))) === JSON.stringify(want), list, { timeout }).catch(() => { });

// Each line reads as a story of its own: it opens on the line being written, with only that line's messages.
await showing([3, 4, 7, 8]);
check('opens on the line being written, with only its messages', JSON.stringify(await shown()) === '[3,4,7,8]', JSON.stringify(await shown()));
check('path leads from the 正文 to the line', (await path()).includes('正文') && (await path()).includes('番外 · 古风'), await path());
check('send bar names the line', (await bar()).includes('发送到：') && (await bar()).includes('番外 · 古风'), await bar());
// A story with lines is their 正文, not an ordinary story; each line is named by the kind its request asked for.
check('top bar calls the story 正文', (await page.locator('.tl-chapter').textContent()).startsWith('正文 · '), await page.locator('.tl-chapter').textContent());
const markAt = async title => page.locator('.tl-branch-mark').filter({ hasText: title })
    .evaluate(el => el.closest('.tl-branch-marks')?.previousElementSibling?.dataset.index ?? null).catch(() => null);
check('the 番外 of this line is marked where it leaves', await markAt('丧尸男友') === '4', String(await markAt('丧尸男友')));
// The full app still shows the whole story in one.
const nativeCount = await engineEval(w => w.document.querySelectorAll('#chat .mes').length);
check('the full app still shows every message', nativeCount === 9, String(nativeCount));

// Horae's own tags exist in the full app, but are not mirrored under the shell's messages.
await page.waitForTimeout(2000);
const chips = await engineEval(w => w.document.querySelectorAll('#chat .horae-storyline-chip').length);
check('Horae drew its storyline tags in the full app', chips > 0, String(chips));
const panels = await page.evaluate(() => [...document.querySelectorAll('iframe.tl-panel-frame')].map(f => f.contentDocument?.body?.innerHTML ?? ''));
check('storyline tags not mirrored under messages', !panels.some(html => html.includes('horae-storyline-chip') || html.includes('番外 · 古风')), `${panels.length} frames`);

// Into the nested 番外 and back through the path.
await page.locator('.tl-branch-mark').filter({ hasText: '丧尸男友' }).click();
await showing([5, 6]);
check('a mark opens that line alone', JSON.stringify(await shown()) === '[5,6]', JSON.stringify(await shown()));
check('its path goes through the line it was opened from', /正文.*番外 · 古风.*小剧场 · 丧尸男友/.test(await path()), await path());
check('no reply buttons where the story does not end', await page.locator('.tl-swipe, .tl-continue-writing').count() === 0);
await page.locator('.tl-branch-path').getByRole('button', { name: '正文', exact: true }).click();
await showing([0, 1, 2]);
check('the path opens the 正文 alone', JSON.stringify(await shown()) === '[0,1,2]', JSON.stringify(await shown()));
check('the 正文 marks where 古风 leaves', await markAt('番外 · 古风') === '2', String(await markAt('番外 · 古风')));
check('no path on the 正文 of a story', await page.locator('.tl-branch-path').count() === 0);

// Horae's own feature is not mixed into the shell's 番外与平行线 sheet (those are separate stories).
await page.getByRole('button', { name: '番外与平行线' }).click();
const episodes = page.getByRole('dialog', { name: '番外与平行线' });
await episodes.waitFor();
check('番外与平行线 sheet has no Horae storyline section', await episodes.locator('.tl-storyline-section').count() === 0);
await episodes.getByRole('button', { name: '关闭' }).click();
// It sits under ＋ 扩展功能, with the other extension functions: the lines to read.
const openSheet = async () => {
    await page.getByRole('button', { name: '扩展功能', exact: true }).click();
    await page.getByRole('dialog', { name: '扩展功能' }).getByRole('button', { name: /^Horae 故事线/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Horae 故事线' });
    await sheet.waitFor();
    return sheet.locator('.tl-storyline-section');
};
let section = await openSheet();
const rows = await section.locator('.tl-storyline-row').allInnerTexts();
check('sheet lists the lines, the one being read marked', rows.length === 3 && rows[0].includes('正文') && rows[0].includes('正在读')
    && rows[1].includes('番外 · 古风') && rows[1].includes('最新写到这里') && rows[2].includes('小剧场 · 丧尸男友'), JSON.stringify(rows));
await section.getByRole('button', { name: /^小剧场 · 丧尸男友/ }).click();
await showing([5, 6]);
check('a line in the sheet opens it', JSON.stringify(await shown()) === '[5,6]', JSON.stringify(await shown()));

// Written while reading a line, the message goes on that line (Horae is told first).
const toast = text => page.waitForFunction(t => window.__tlToasts.some(x => x.includes(t)), text, { timeout: 20000 });
const pending = () => engineEval(w => w.Horae.getStorylines().pending ?? null);
await page.getByRole('textbox', { name: '输入消息' }).fill('丧尸线里接着写');
await page.getByRole('button', { name: '发送', exact: true }).click();
await page.waitForFunction(() => document.querySelectorAll('.tl-messages .tl-message[data-index]').length >= 4, null, { timeout: 120000 }).catch(() => { });
await page.waitForFunction(() => !document.querySelector('.tl-stop'), null, { timeout: 120000 }).catch(() => { });
const placed = await engineEval(w => { const s = w.Horae.getStorylines(); return { last: s.segments.at(-1), pending: s.pending ?? null }; });
check('the message went on the line being read', placed.last?.id === ZOMBIE && placed.last.start === 9 && placed.last.end >= 10, JSON.stringify(placed));
await showing([5, 6, 9, 10]);
check('it shows on that line', JSON.stringify(await shown()) === '[5,6,9,10]', JSON.stringify(await shown()));
check('the line now ends the story: reply buttons back', await page.locator('.tl-swipe, .tl-continue-writing').count() > 0);
check('send bar names the line', (await bar()).includes('小剧场 · 丧尸男友'), await bar());

// A new 番外 from the sheet: it opens empty, and the next message goes there; the switch can be cancelled.
section = await openSheet();
await section.getByRole('textbox', { name: '新番外的名字' }).fill('小剧场');
await section.getByRole('button', { name: '开新番外' }).click();
await toast('已开新番外「小剧场」');
const after = await engineEval(w => w.Horae.getStorylines());
const made = Object.entries(after.lines).find(([, l]) => l.title === '小剧场');
check('new 番外 line made for the next message', !!made && after.pending === made[0], JSON.stringify(after));
await page.locator('.tl-line-empty').waitFor({ timeout: 10000 }).catch(() => { });
check('the new line opens, empty', (await page.locator('.tl-line-empty').textContent().catch(() => '')).includes('番外 · 小剧场')
    && (await shown()).length === 0, JSON.stringify(await shown()));
section = await openSheet();
check('sheet shows the switch', (await section.textContent()).includes('下一句起换到「番外 · 小剧场」'), await section.textContent());
await section.getByRole('button', { name: '取消切换' }).click();
await toast('接着写「小剧场 · 丧尸男友」');
check('switch cancelled', await pending() === null, String(await pending()));
await page.getByRole('dialog').last().getByRole('button', { name: '关闭' }).click();

// Saved with the story (Horae saves the chat after a change).
await page.waitForTimeout(2500);
const saved = await (await post('/api/chats/get', { ch_name: NAME, file_name: file, avatar_url: avatar })).json();
const reg = saved?.[0]?.chat_metadata?.horae_storylines;
check('Horae saved the change with the story', !!reg && Object.values(reg.lines).some(l => l.title === '小剧场'), JSON.stringify(reg));

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS ${problems.join(', ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
