// Chat saves from the lite shell on an official SillyTavern with tavern-lite and the tavern-lite-save plugin
// (INSTALL_SAVE_PLUGIN=1; request compression on, as behind many proxies: TL_REQUEST_COMPRESSION=1):
// a save of a long story sends only what changed; a save the network drops is kept on the device, the app does not
// report "聊天无法保存", and it goes out once the network is back, also after a reload; a kept save never replaces a
// story changed elsewhere in between; without the plugin whole chats are saved, and still kept when dropped.
// Usage: node e2e-chat-save.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `存档${run}`, FILE = `存档-${run}`;
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
// Every save the pages send, with its size as it went over the network.
const sent = [];
context.on('request', request => {
    const url = request.url();
    if (/\/api\/chats\/save$|\/api\/plugins\/tavern-lite-save\/patch$/.test(url)) {
        sent.push({ kind: url.endsWith('/patch') ? 'patch' : 'full', bytes: request.postDataBuffer()?.length ?? 0, exact: !!request.headers()['x-tavern-lite-exact'] });
    }
});
async function openPage() {
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
    await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: FILE })}`);
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
}

// The test's own requests share the pages' sign-in; context routes do not apply to them.
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
// About 1.5 MB of text that does not compress away (like real writing): a long story, past the size the app compresses.
let seed = 7;
const pool = '雨一直下屋檐滴水灯在风里晃他她们说走来看见山河城门夜色远处有人低声笑着回头问你是谁我等了很久终于还是没能开口';
const filler = () => Array.from({ length: 1300 }, () => pool[(seed = (seed * 1103515245 + 12345) % 2147483648) % pool.length]).join('');
const story = Array.from({ length: 400 }, (_, i) => ({ name: i % 2 ? 'User' : NAME, is_user: i % 2 === 1, mes: `第${i}段。${filler()}` }))
    .map(m => ({ ...m, send_date: now, extra: {} }));
const header = { user_name: 'User', character_name: NAME, create_date: now, chat_metadata: { integrity: `t-${run}` } };
await post('/api/chats/save', { ch_name: NAME, file_name: FILE, avatar_url: avatar, chat: [header, ...story], force: true });

const serverChat = async () => (await post('/api/chats/get', { ch_name: NAME, file_name: FILE, avatar_url: avatar })).json();
const serverLast = async () => (await serverChat()).at(-1)?.mes;
// Changes the last message the way the app itself does, then saves as it would.
const editAndSave = text => page.evaluate(async t => {
    const c = document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext();
    c.chat.at(-1).mes = t;
    await c.saveChat();
}, text);
const appToasts = () => page.evaluate(() => document.querySelector('iframe.engine').contentWindow.document.querySelector('#toast-container')?.textContent ?? '');
const syncBar = () => page.locator('.tl-sync-bar');
const toasts = () => page.evaluate(() => window.__tlToasts.slice());
const offline = () => context.route(/\/api\/chats\/save$|\/api\/plugins\/tavern-lite-save\/patch$/, route => route.abort('internetdisconnected'));
const online = async () => { await context.unrouteAll({ behavior: 'wait' }); await page.evaluate(() => dispatchEvent(new Event('online'))); };
const waitFor = async (fn, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 300)); } return false; };

try {
    await openPage();
    const fileBytes = JSON.stringify([header, ...story]).length;

    // 1. A save of the long story sends only the changed message.
    sent.length = 0;
    await editAndSave(`改过的结尾${run}`);
    const patches = sent.filter(s => s.kind === 'patch'), fulls = sent.filter(s => s.kind === 'full');
    console.log('one save sent', JSON.stringify(sent), 'chat file', fileBytes, 'bytes');
    check('a save sends only what changed', patches.length === 1 && fulls.length === 0 && patches[0].bytes < 20000,
        { sent, fileBytes });
    check('the server has the change', (await serverLast()) === `改过的结尾${run}`, await serverLast());
    check('the rest of the story is untouched', (await serverChat()).length === story.length + 1);

    // 2. Writing in the shell: the message and the reply are saved, as patches only.
    sent.length = 0;
    await page.locator('.tl-composer-input').fill(`下雨了吗${run}`);
    await page.getByRole('button', { name: '发送' }).click();
    await page.locator('.tl-message[data-role="char"]').last().locator('.tl-message-body', { hasText: '模拟回复' }).waitFor({ timeout: 120000 });
    await page.locator('.tl-send').waitFor({ timeout: 120000 });
    await waitFor(async () => (await serverChat()).length === story.length + 3);
    const chat2 = await serverChat();
    check('a sent message and its reply are saved', chat2.length === story.length + 3 && chat2.at(-2).mes === `下雨了吗${run}` && /模拟回复/.test(chat2.at(-1).mes),
        chat2.slice(-2).map(m => m.mes.slice(0, 30)));
    check('sending saved only patches', sent.length > 0 && sent.every(s => s.kind === 'patch' && s.bytes < 40000), sent);

    // 3. The network drops during a save: kept on the device, no "聊天无法保存", sent once it is back.
    await offline();
    await editAndSave(`断网时写的${run}`);
    check('a dropped save is not reported as lost by the app', !/无法保存|could not be saved/i.test(await appToasts()), await appToasts());
    await syncBar().waitFor({ timeout: 10000 }).catch(() => { });
    check('the shell says the change is kept on the device', await syncBar().isVisible(), await page.locator('.tl-toasts').innerText().catch(() => ''));
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
    check('nothing reached the server yet', (await serverLast()) !== `断网时写的${run}`);
    await editAndSave(`断网时又改了${run}`);
    await online();
    check('it is saved once the network is back', await waitFor(async () => (await serverLast()) === `断网时又改了${run}`), await serverLast());
    await syncBar().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => { });
    check('the bar goes away', !(await syncBar().isVisible()));
    check('the shell says so', (await toasts()).some(t => /补存好/.test(t)), await toasts());

    // 3b. The app itself answers with an error (not a dropped connection): reported as before, nothing kept.
    await context.route(/\/api\/chats\/save$|\/api\/plugins\/tavern-lite-save\/patch$/, route => route.fulfill({ status: 500, json: { error: 'injected' } }));
    await editAndSave(`服务器出错时写的${run}`);
    await waitFor(async () => /无法保存|could not be saved/i.test(await appToasts()), 10000);
    check('an error from the app is still reported', /无法保存|could not be saved/i.test(await appToasts()), await appToasts());
    check('an error from the app is not kept for later', !(await syncBar().isVisible()) && (await page.evaluate(async () => {
        const db = await new Promise(r => { const q = indexedDB.open('tavern-lite-chat-sync'); q.onsuccess = () => r(q.result); });
        return new Promise(r => { const q = db.transaction('pending').objectStore('pending').count(); q.onsuccess = () => r(q.result); });
    })) === 0);
    await context.unrouteAll({ behavior: 'wait' });
    await editAndSave(`断网时又改了${run}`);

    // 4. Dropped, then the page is reloaded while still offline: the story shows the kept version; it goes out later.
    await offline();
    await editAndSave(`重开前写的${run}`);
    await syncBar().waitFor({ timeout: 10000 }).catch(() => { });
    await page.close();
    await openPage();
    await page.locator('.tl-message', { hasText: `重开前写的${run}` }).first().waitFor({ timeout: 20000 }).catch(() => { });
    check('after a reload the kept change is shown', await page.locator('.tl-message', { hasText: `重开前写的${run}` }).count() > 0);
    const engineLast = await page.evaluate(() => document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().chat.at(-1).mes);
    check('the full app has the kept change too', engineLast === `重开前写的${run}`, engineLast);
    check('the bar shows after the reload', await syncBar().isVisible());
    await online();
    check('after a reload it is saved once the network is back', await waitFor(async () => (await serverLast()) === `重开前写的${run}`), await serverLast());

    // 5. A kept save of a story changed elsewhere meanwhile: the other version stays, and the shell says so.
    await offline();
    await editAndSave(`被别处盖掉的${run}`);
    await page.close();
    const other = await serverChat();
    other.at(-1).mes = `另一台设备写的${run}`;
    await post('/api/chats/save', { ch_name: NAME, file_name: FILE, avatar_url: avatar, chat: other, force: true });
    await context.unrouteAll({ behavior: 'wait' });
    await openPage();
    await waitFor(async () => (await toasts()).some(t => /没能补上/.test(t)), 20000);
    check('the shell says a kept save could not be applied', (await toasts()).some(t => /没能补上/.test(t)), await toasts());
    check('the story changed elsewhere is kept', (await serverLast()) === `另一台设备写的${run}`, await serverLast());
    check('no bar for it afterwards', !(await syncBar().isVisible()));

    // 6. Without the plugin: whole chats, and a dropped one is still kept and sent again.
    await page.close();
    await context.route(/\/api\/plugins\/tavern-lite-save\//, route => route.fulfill({ status: 404, body: 'Not found' }));
    await openPage();
    sent.length = 0;
    await editAndSave(`没有插件${run}`);
    check('without the plugin the whole chat is saved', sent.some(s => s.kind === 'full') && (await serverLast()) === `没有插件${run}`, { sent: sent.map(s => s.kind) });
    await context.route(/\/api\/chats\/save$/, route => route.abort('internetdisconnected'));
    await editAndSave(`没有插件断网${run}`);
    await syncBar().waitFor({ timeout: 10000 }).catch(() => { });
    check('without the plugin a dropped save is kept', await syncBar().isVisible() && !/无法保存|could not be saved/i.test(await appToasts()));
    await context.unroute(/\/api\/chats\/save$/);
    await page.evaluate(() => dispatchEvent(new Event('online')));
    check('without the plugin it is sent again', await waitFor(async () => (await serverLast()) === `没有插件断网${run}`), await serverLast());
    await context.unrouteAll({ behavior: 'wait' });

    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
    problems.push('crashed');
    console.log('FAILURE', error.stack);
    await page?.screenshot({ path: '/tmp/tl-chat-save-fail.png' }).catch(() => { });
}
await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS: ${problems.join(', ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
