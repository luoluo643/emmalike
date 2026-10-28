// A new 番外 line copied from a long story, on an official SillyTavern with tavern-lite and the tavern-lite-save plugin
// (INSTALL_SAVE_PLUGIN=1): the phone sends only what differs from the story and the plugin writes the copy, which then
// reads back exactly as the whole-file save would have written it; without the plugin the whole file goes as before.
// Usage: node e2e-episode-copy.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `长线${run}`, FILE = `长线-${run}`;
const results = {}, problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 400); if (!ok) problems.push(name); console.log(ok ? 'PASS' : 'FAIL', name); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const pageErrors = [], sent = [];
context.on('request', request => {
    const url = request.url();
    if (/\/api\/plugins\/tavern-lite-save\/copy$|\/api\/chats\/save$/.test(url)) {
        let file = ''; try { file = JSON.parse(request.postData() ?? '{}').file_name ?? ''; } catch { /* compressed */ }
        sent.push({ kind: url.endsWith('/copy') ? 'copy' : 'full', file, bytes: request.postDataBuffer()?.length ?? 0 });
    }
});
const api = context.request;
const { token } = await (await api.get(`${base}/csrf-token`)).json();
const post = (path, data) => api.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const created = await api.post(`${base}/api/characters/create`, { headers: { 'X-CSRF-Token': token },
    multipart: { ch_name: NAME, description: '', first_mes: '你来了。', personality: '', scenario: '', mes_example: '', creator_notes: '',
        system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' } });
const avatar = (await created.text()).trim();
const now = new Date().toISOString();
let seed = 11;
const pool = '雨一直下屋檐滴水灯在风里晃他她们说走来看见山河城门夜色远处有人低声笑着回头问你是谁我等了很久终于还是没能开口';
const filler = () => Array.from({ length: 1300 }, () => pool[(seed = (seed * 1103515245 + 12345) % 2147483648) % pool.length]).join('');
const story = Array.from({ length: 300 }, (_, i) => ({ name: i % 2 ? 'User' : NAME, is_user: i % 2 === 1, mes: `第${i}段。${filler()}`, send_date: now, extra: {} }));
const header = { user_name: 'User', character_name: NAME, create_date: now, chat_metadata: { integrity: crypto.randomUUID() } };
await post('/api/chats/save', { ch_name: NAME, file_name: FILE, avatar_url: avatar, chat: [header, ...story], force: true });
const chats = async () => (await (await post('/api/characters/chats', { avatar_url: avatar })).json()).map(c => c.file_name.replace(/\.jsonl$/, ''));
const read = async file => (await post('/api/chats/get', { ch_name: NAME, file_name: file, avatar_url: avatar })).json();

let page;
async function openPage() {
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
    await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: FILE })}`);
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
}
// Through the sheet up to the review: the line exists by then, nothing has gone to the model.
async function newLine(title) {
    const before = new Set(await chats());
    await page.getByRole('button', { name: '番外与平行线', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: '番外与平行线', exact: true });
    await sheet.getByRole('button', { name: '＋ 新开番外 / 平行线 / 小剧场', exact: true }).click();
    await sheet.getByRole('radio', { name: '接续正文最新进度', exact: true }).click();
    await sheet.getByLabel('标题', { exact: true }).fill(title);
    await sheet.getByLabel('开场或续写要求').fill(`开场：${title}`);
    await sheet.getByRole('button', { name: '下一步：确认发送', exact: true }).click();
    const review = page.getByRole('dialog', { name: '确认发送', exact: true });
    await review.waitFor({ timeout: 180000 });
    const file = (await chats()).find(name => !before.has(name));
    await review.getByRole('button', { name: '先不发', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 30000 }).catch(() => { });
    return file;
}
const sameStory = (copy, source) => copy.length === source.length && copy.slice(1).every((m, i) => m.mes === source[i + 1].mes && m.is_user === source[i + 1].is_user);

try {
    await openPage();
    // Saved once by the app itself, as a story written in it would be (the API-made file lacks fields it adds).
    await page.evaluate(async () => { await document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().saveChat(); });
    await page.waitForTimeout(3000);
    const source = await read(FILE);
    sent.length = 0;
    const first = await newLine(`复制${run}`);
    const copied = await read(first);
    const toNew = sent.filter(s => s.file === first);
    check('a long story becomes a new line through the plugin copy', toNew.some(s => s.kind === 'copy') && !toNew.some(s => s.kind === 'full'), toNew);
    check('only what differs is sent (well under the story size)', toNew.filter(s => s.kind === 'copy').every(s => s.bytes < 200 * 1024), toNew);
    check('the copy holds the whole story', sameStory(copied, source), { copied: copied.length, source: source.length });
    check('the copy is a 番外 line of this story', copied[0]?.chat_metadata?.tavern_lite_episode?.title === `复制${run}`);
    check('the story itself is unchanged', JSON.stringify(await read(FILE)) === JSON.stringify(source));

    // Without the plugin (an official SillyTavern without it): the whole file, as before.
    await context.route(/\/api\/plugins\/tavern-lite-save\//, route => route.fulfill({ status: 404, body: 'Not found' }));
    sent.length = 0;
    const second = await newLine(`整份${run}`);
    const whole = sent.filter(s => s.file === second);
    check('without the plugin the whole file is saved', whole.some(s => s.kind === 'full'), whole);
    check('and it holds the whole story too', sameStory(await read(second), source));
    await context.unrouteAll({ behavior: 'wait' });
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
    problems.push('crashed');
    console.log('FAILURE', error.stack);
    await page?.screenshot({ path: '/tmp/tl-episode-copy-fail.png' }).catch(() => { });
}
await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS: ${problems.join(', ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
