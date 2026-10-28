// Horae storylines in the shell: the tags Horae puts under messages are not mirrored and the send bar names only the
// story; the 番外与平行线 sheet shows the line in use and switches the next message's line through Horae's own buttons.
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

// A story with 正文 (#0–2) and a 番外 「古风」 from #3 on, as Horae records it.
const now = () => new Date().toISOString();
const meta = { user_name: 'User', character_name: NAME, create_date: now(),
    chat_metadata: { horae_storylines: { version: 1, lines: { [LINE]: { title: '古风', kind: 'side', parent: 'main', createdAt: now(), borrowProfiles: true } }, pending: null } } };
const lines = [
    { name: NAME, is_user: false, mes: '“你来了。”', send_date: now(), extra: {} },
    { name: 'User', is_user: true, mes: '正文里的一句话', send_date: now(), extra: {} },
    { name: NAME, is_user: false, mes: '正文里的回答', send_date: now(), extra: {} },
    { name: 'User', is_user: true, mes: '开一个古风番外', send_date: now(), extra: {}, horae_storyline: LINE },
    { name: NAME, is_user: false, mes: '古风番外的开头', send_date: now(), extra: {} },
];
const file = `故事线${run}`;
if (!(await post('/api/chats/save', { ch_name: NAME, file_name: file, avatar_url: avatar, chat: [meta, ...lines], force: true })).ok()) throw new Error('chat not saved');

await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file })}`);
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const hasHorae = await engineEval(w => typeof w.Horae?.getStorylines === 'function');
check('Horae with storylines is installed', hasHorae);
if (!hasHorae) throw new Error('Horae storylines not available');
const bar = () => page.locator('.tl-episode-bar > span').textContent();
await page.waitForFunction(() => document.querySelector('.tl-episode-bar > span')?.textContent.includes('发送到：'), null, { timeout: 20000 }).catch(() => { });
check('send bar leaves the storyline out', (await bar()).includes('发送到：') && !(await bar()).includes('古风'), await bar());

// Horae's own tags exist in the full app, but are not mirrored under the shell's messages.
await page.waitForTimeout(2000);
const chips = await engineEval(w => w.document.querySelectorAll('#chat .horae-storyline-chip').length);
check('Horae drew its storyline tags in the full app', chips > 0, String(chips));
const panels = await page.evaluate(() => [...document.querySelectorAll('iframe.tl-panel-frame')].map(f => f.contentDocument?.body?.innerHTML ?? ''));
check('storyline tags not mirrored under messages', !panels.some(html => html.includes('horae-storyline-chip') || html.includes('番外·古风')), `${panels.length} frames`);

// Horae's own feature is not mixed into the shell's 番外与平行线 sheet (those are separate stories).
await page.getByRole('button', { name: '番外与平行线' }).click();
const episodes = page.getByRole('dialog', { name: '番外与平行线' });
await episodes.waitFor();
check('番外与平行线 sheet has no Horae storyline section', await episodes.locator('.tl-storyline-section').count() === 0);
await episodes.getByRole('button', { name: '关闭' }).click();
// It sits under ＋ 扩展功能, with the other extension functions: switching the next message's line.
await page.getByRole('button', { name: '扩展功能', exact: true }).click();
await page.getByRole('dialog', { name: '扩展功能' }).getByRole('button', { name: /^Horae 故事线/ }).click();
const sheet = page.getByRole('dialog', { name: 'Horae 故事线' });
await sheet.waitFor();
const section = sheet.locator('.tl-storyline-section');
check('sheet shows the storyline in use', (await section.textContent()).includes('现在在「番外·古风」'), await section.textContent());
const toast = text => page.waitForFunction(t => window.__tlToasts.some(x => x.includes(t)), text, { timeout: 20000 });
const pending = () => engineEval(w => w.Horae.getStorylines().pending ?? null);

await section.getByRole('button', { name: '下一句起回到正文' }).click();
await toast('下一句起回到正文');
check('back to 正文 from the next message', await pending() === 'main', String(await pending()));
await page.waitForFunction(() => document.querySelector('.tl-storyline-section')?.textContent.includes('下一句起换到「正文」'), null, { timeout: 10000 }).catch(() => { });
check('sheet shows the switch', (await section.textContent()).includes('下一句起换到「正文」'), await section.textContent());
check('send bar leaves the switch out', !(await bar()).includes('下一句起'), await bar());

await section.getByRole('button', { name: '取消切换' }).click();
await toast('接着写「番外·古风」');
check('switch cancelled', await pending() === null, String(await pending()));

await section.getByRole('textbox', { name: '新番外的名字' }).fill('小剧场');
await section.getByRole('button', { name: '下一句起开新番外' }).click();
await toast('下一句起开新番外「小剧场」');
const after = await engineEval(w => w.Horae.getStorylines());
const made = Object.entries(after.lines).find(([, l]) => l.title === '小剧场');
check('new 番外 line made for the next message', !!made && after.pending === made[0], JSON.stringify(after));
check('section lists the new line', (await section.textContent()).includes('「番外·小剧场」'), await section.textContent());
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
