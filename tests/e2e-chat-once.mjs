// Opening a story downloads it once (official SillyTavern with tavern-lite and the tavern-lite-save plugin,
// INSTALL_SAVE_PLUGIN=1): the shell reads the story for its preview, and the full app's read of the same story is
// answered from that copy after the plugin says the file is unchanged. A story changed in between, or no plugin,
// is read from the server as before. Also: a failed reply in the provider's words is said in Chinese.
// Usage: node e2e-chat-once.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `一次${run}`, FILE = `一次-${run}`;
const results = {}, problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 400); if (!ok) problems.push(name); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript(() => {
    window.__tlToasts = [];
    new MutationObserver(rs => { for (const r of rs) for (const n of r.addedNodes) if (n.classList?.contains('tl-toast')) window.__tlToasts.push(n.textContent); })
        .observe(document, { childList: true, subtree: true });
});
const pageErrors = [];
let page;
// Every read of the test story from either page, and every plugin check.
const reads = [], checks = [];
context.on('request', request => {
    const url = request.url();
    // Only this story: opening the character, the app first reads the new chat it makes for it.
    if (/\/api\/chats\/get$/.test(url) && JSON.parse(request.postData() ?? '{}').file_name === FILE) reads.push(request.frame()?.parentFrame() ? 'app' : 'shell');
    if (/\/api\/plugins\/tavern-lite-save\/patch$/.test(url)) checks.push(JSON.parse(request.postData() ?? '{}'));
    if (process.env.TRACE && /\/api\/(chats\/(get|save)|plugins\/tavern-lite-save\/)/.test(url)) console.log('>>', Date.now() % 100000, request.frame()?.parentFrame() ? 'app' : 'shell', url.replace(base, ''), (request.postData() ?? '').slice(0, 160));
});
if (process.env.TRACE) context.on('response', async response => {
    if (/\/api\/plugins\/tavern-lite-save\//.test(response.url())) console.log('<<', Date.now() % 100000, response.url().replace(base, ''), response.status(), (await response.text().catch(() => '')).slice(0, 160));
});
async function openPage() {
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
    await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: FILE })}`);
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
}
const engineChat = () => page.evaluate(() => document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().chat.map(m => m.mes));
const toasts = () => page.evaluate(() => window.__tlToasts.slice());

const api = context.request;
const { token } = await (await api.get(`${base}/csrf-token`)).json();
const post = (path, data) => api.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
console.log('SillyTavern', (await (await api.get(`${base}/version`)).json()).pkgVersion);
const created = await api.post(`${base}/api/characters/create`, { headers: { 'X-CSRF-Token': token },
    multipart: { ch_name: NAME, description: '', first_mes: '你来了。', personality: '', scenario: '', mes_example: '', creator_notes: '',
        system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' } });
const avatar = (await created.text()).trim();
const now = new Date().toISOString();
let seed = 11;
const pool = '雨一直下屋檐滴水灯在风里晃他她们说走来看见山河城门夜色远处有人低声笑着回头问你是谁我等了很久终于还是没能开口';
const filler = () => Array.from({ length: 1300 }, () => pool[(seed = (seed * 1103515245 + 12345) % 2147483648) % pool.length]).join('');
const story = Array.from({ length: 300 }, (_, i) => ({ name: i % 2 ? 'User' : NAME, is_user: i % 2 === 1, mes: `第${i}段。${filler()}`, send_date: now, extra: {} }));
const header = { user_name: 'User', character_name: NAME, create_date: now, chat_metadata: { integrity: `t-${run}` } };
const saveStory = chat => post('/api/chats/save', { ch_name: NAME, file_name: FILE, avatar_url: avatar, chat: [header, ...chat], force: true });
await saveStory(story);

try {
    // 1. Opening the story: one download, one small check, and the full app has the whole story.
    await openPage();
    console.log('reads', reads, 'checks', checks.length);
    check('the story is downloaded once', reads.length === 1 && reads[0] === 'shell', reads);
    // A check is a patch from the file to itself (saves the app makes while opening are patches too, with changes).
    const sameChecks = checks.filter(c => c.base === c.target && !c.set && !c.length);
    check('the app asked the plugin once whether it changed', sameChecks.length === 1 && JSON.stringify(sameChecks[0]).length < 1000, checks);
    const chat1 = await engineChat();
    // The app's chat leaves out the file's first line (the story's settings).
    check('the full app has the whole story', chat1.length === story.length && chat1.at(-1) === story.at(-1).mes && chat1[0] === story[0].mes, chat1.length);
    check('the story on the server is untouched', (await (await post('/api/chats/get', { ch_name: NAME, file_name: FILE, avatar_url: avatar })).json()).length === story.length + 1);
    await page.close();

    // 2. The story changes on the server between the two reads (another device): the app reads it from the server.
    reads.length = 0; checks.length = 0;
    const later = [...story, { name: NAME, is_user: false, mes: `另一台设备写的${run}`, send_date: now, extra: {} }];
    await context.route(/\/api\/plugins\/tavern-lite-save\/patch$/, async route => {
        await saveStory(later);
        await route.continue();
    });
    await openPage();
    await context.unrouteAll({ behavior: 'wait' });
    console.log('reads', reads);
    check('a story changed in between is read again', reads.length === 2 && reads[1] === 'app', reads);
    const chat2 = await engineChat();
    check('the full app has the newer story', chat2.at(-1) === `另一台设备写的${run}` && chat2.length === later.length, chat2.at(-1)?.slice(0, 30));
    await page.close();

    // 3. Without the plugin: read twice, as before, and the story is right.
    reads.length = 0; checks.length = 0;
    await context.route(/\/api\/plugins\/tavern-lite-save\//, route => route.fulfill({ status: 404, body: 'Not found' }));
    await openPage();
    check('without the plugin the app reads it itself', reads.length === 2, reads);
    check('without the plugin the story is right', (await engineChat()).at(-1) === `另一台设备写的${run}`);
    await context.unrouteAll({ behavior: 'wait' });

    // 4. A failed reply: the provider's words become Chinese with what to do; an unknown one stays as it was.
    const failWith = async message => {
        await context.route(/\/api\/backends\/chat-completions\/generate$/, route => route.fulfill({ status: 400, json: { error: { message } } }));
        const before = (await toasts()).length;
        await page.evaluate(() => document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().generate('normal').catch(() => { }));
        const end = Date.now() + 20000;
        while (Date.now() < end && (await toasts()).length === before) await new Promise(r => setTimeout(r, 300));
        await context.unrouteAll({ behavior: 'wait' });
        const shown = (await toasts()).slice(before).join(' | ');
        await page.waitForFunction(() => !document.querySelector('iframe.engine').contentWindow.document.body.dataset.generating, null, { timeout: 30000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 1500));
        return shown;
    };
    const blocked = await failWith('Candidate was blocked due to PROHIBITED_CONTENT');
    check('a blocked reply is said in Chinese with what to do', /审掉/.test(blocked) && /反截断/.test(blocked) && /PROHIBITED_CONTENT/.test(blocked) && !/Candidate was blocked/.test(blocked), blocked);
    const relay = await failWith('预扣费额度失败, 用户剩余额度: 3.5, 需要预扣费额度: 4.0');
    check('a relay out of balance is said plainly', /额度用完了/.test(relay), relay);
    const unknown = await failWith(`奇怪的错误${run}`);
    check('an unknown error is shown as it was', unknown.includes(`奇怪的错误${run}`), unknown);

    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
    problems.push('crashed');
    console.log('FAILURE', error.stack);
    await page?.screenshot({ path: '/tmp/tl-chat-once-fail.png' }).catch(() => { });
}
await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS: ${problems.join(', ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
