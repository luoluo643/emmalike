// 番外 written inside a story: listed in the 番外 sheet (also where new 番外 are not verified because of other
// extensions), a tap jumps to it, "拆成独立故事" copies exactly those messages into a new owned story and leaves the
// story unchanged. Also: "测试连接" in the model sheet gets a reply.
// Usage: node e2e-inline.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `番外拆分${run}`, FILE = `正文-${run}`, TITLE = `海边的一天${run}`;
const results = {}, problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`; if (!ok) problems.push(name); };

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
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const created = await page.request.post(`${base}/api/characters/create`, {
    headers: { 'X-CSRF-Token': token },
    multipart: { ch_name: NAME, description: '', first_mes: '你来了。', personality: '', scenario: '', mes_example: '', creator_notes: '',
        system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' },
});
const avatar = (await created.text()).trim();
const now = new Date().toISOString();
const story = [
    { name: NAME, is_user: false, mes: '你来了。' },
    { name: 'User', is_user: true, mes: `$现在暂停当前剧情，为我生成一个番外，主题为“${TITLE}”，不计入主线剧情` },
    { name: NAME, is_user: false, mes: `### 《${TITLE}》\n海风吹过来。` },
    { name: 'User', is_user: true, mes: '继续' },
    { name: NAME, is_user: false, mes: '浪退下去。' },
    { name: 'User', is_user: true, mes: '回归正文继续剧情' },
    { name: NAME, is_user: false, mes: '回到正文。' },
].map(m => ({ ...m, send_date: now, extra: {} }));
await post('/api/chats/save', { ch_name: NAME, file_name: FILE, avatar_url: avatar, chat: [{ user_name: 'User', character_name: NAME, create_date: now, chat_metadata: {} }, ...story], force: true });
const readChat = async file => { const r = await post('/api/chats/get', { ch_name: NAME, file_name: file, avatar_url: avatar }); return r.ok() ? r.json() : null; };
const before = await readChat(FILE);
const synced = () => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const settled = async () => {
    await page.waitForFunction(() => !history.state?.tlLayer && !document.querySelector('[role="dialog"]'), null, { timeout: 10000 }).catch(() => { });
    await page.waitForTimeout(400);
};
const openSheet = async () => {
    await page.getByRole('button', { name: '番外与平行线', exact: true }).click();
    const sheet = page.getByRole('dialog').filter({ has: page.locator('.tl-inline-episodes') });
    await sheet.waitFor({ timeout: 15000 });
    return sheet;
};
try {
    await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: FILE })}`);
    await synced();
    let sheet = await openSheet();
    const row = sheet.locator('.tl-inline-episodes').getByRole('button', { name: new RegExp(`番外 · ${TITLE}`) });
    check('故事里写过的番外 lists the 番外 with its range', await row.count() === 1 && (await row.innerText()).includes('第 1～4 条'));
    await row.click();
    await settled();
    check('a tap jumps to the 番外', await page.locator('.tl-message[data-index="1"]').evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; }).catch(() => false));
    sheet = await openSheet();
    await sheet.locator('.tl-inline-episodes').getByRole('button', { name: '拆成独立故事' }).first().click();
    const form = sheet.locator('.tl-inline-episodes .tl-episode-form');
    check('split is available although new 番外 are not verified here', await form.getByRole('button', { name: '拆成独立故事' }).isEnabled(), await form.innerText());
    await form.getByRole('button', { name: '拆成独立故事' }).click();
    await page.waitForFunction(t => window.__tlToasts.some(x => x.includes(t)), `已拆成「${TITLE}」`, { timeout: 60000 })
        .then(() => check('split reports the new story', true)).catch(async () => check('split reports the new story', false, await sheet.innerText().catch(e => e.message)));
    const listed = await (await post('/api/characters/chats', { avatar_url: avatar, metadata: true })).json();
    const childFile = listed.map(x => String(x.file_name).replace(/\.jsonl$/, '')).find(f => f.startsWith('tl-episode-'));
    const copied = childFile ? await readChat(childFile) : null;
    const meta = Object.values(copied?.[0]?.chat_metadata ?? {}).find(v => v?.extractedFrom);
    check('the new story holds exactly those messages', JSON.stringify(copied?.slice(1).map(m => m.mes)) === JSON.stringify(story.slice(1, 5).map(m => m.mes)));
    check('the new story records its origin', JSON.stringify(meta?.extractedFrom) === JSON.stringify({ from: 1, to: 4, count: 4 }) && meta?.title === TITLE, meta);
    check('the story itself is unchanged', JSON.stringify((await readChat(FILE))?.slice(1).map(m => m.mes)) === JSON.stringify(before?.slice(1).map(m => m.mes)));
    await sheet.getByRole('button', { name: '关闭' }).click();
    await settled();
    // 测试连接 in the model sheet (reloaded: the header hides itself after the jump scrolled the story).
    await page.reload(); await synced();
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await page.getByRole('button', { name: /^模型：/ }).click();
    const modelSheet = page.getByRole('dialog', { name: '模型与预设' });
    const testButton = modelSheet.getByRole('button', { name: '测试API连接', exact: true });
    check('model sheet: the button reads 测试API连接', await testButton.isVisible().catch(() => false));
    await testButton.click();
    const tested = await modelSheet.locator('.tl-connection-test').getByText(/连上了|没有|未收到|等了/).waitFor({ timeout: 100000 })
        .then(async () => modelSheet.locator('.tl-connection-test').innerText()).catch(e => e.message);
    check('model sheet: 测试连接 gets a reply', tested.includes('连上了'), tested);
    // The same request as the full app's own API test: nothing but "Hi".
    const sent = await (await fetch(process.env.MOCK_LAST_URL ?? 'http://127.0.0.1:5001/last')).json().catch(() => null);
    check('model sheet: the test sends only "Hi"', JSON.stringify(sent?.messages) === JSON.stringify([{ role: 'user', content: 'Hi' }]),
        JSON.stringify(sent?.messages ?? null).slice(0, 300));
} finally {
    await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
    await browser.close();
}
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(JSON.stringify(results, null, 2));
if (problems.length) { console.error('FAILED:', problems.join(', ')); process.exit(1); }
