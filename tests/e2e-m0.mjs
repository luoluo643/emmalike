// M0 regressions: queued messages survive chat resolution and reloads, group chats are reachable, old messages use
// the app's own formatting, and the version gate reports. Usage: node e2e-m0.mjs <baseUrl> <handle> <password> [latencyMs] [downKbps]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, latency = '200', downKbps = '5000'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const AVATAR = 'default_Seraphina.png';
const run = Date.now().toString(36);
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

let groupId = '';
const deleteGroup = async () => { if (groupId) await post('/api/groups/delete', { id: groupId }).catch(() => { }); groupId = ''; };
process.on('uncaughtException', async error => {
    console.log('FAILURE', error.message.split('\n')[0], (error.stack ?? '').split('\n').find(l => l.includes('e2e-m0.mjs')));
    console.log(JSON.stringify({ toasts: await page.evaluate(() => window.__tlToasts).catch(() => null), results }, null, 1));
    await deleteGroup();
    await browser.close();
    process.exit(2);
});

const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: Number(latency), downloadThroughput: Number(downKbps) * 1024 / 8, uploadThroughput: 1024 * 1024 / 8,
});

const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const login = await page.request.post(`${base}/api/users/login`, { headers: { 'X-CSRF-Token': token }, data: { handle, password } });
if (!login.ok()) throw new Error(`login failed ${login.status()}`);
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });

const engineReady = () => page.waitForFunction(() => !!document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge && !document.querySelector('.tl-engine-status'), null, { timeout: 240000 });
const inEngine = fn => page.evaluate(fn);

// P0-1: a link without a chat file resolves to the latest chat; a message queued meanwhile must still be sent.
const first = `无文件名链接${run}`;
await page.goto(`${appUrl}#chat=${AVATAR}&file=`);
await page.locator('.tl-message').first().waitFor();
const hashBefore = await page.evaluate(() => location.hash);
await page.locator('.tl-composer-input').fill(first);
await page.getByRole('button', { name: '发送' }).click();
check('P0-1 message queued during load', await page.locator('[data-pending="true"]').count() === 1);
await page.locator('.tl-message[data-role="char"]', { hasText: `收到：${first}` }).waitFor({ timeout: 240000 });
check('P0-1 queued message delivered after chat resolution', true);
check('P0-1 route not rewritten', await page.evaluate(() => location.hash) === hashBefore);

// P0-3: a queued message must come back into the input box after a reload.
const queued = `刷新前排队${run}`;
await page.reload();
await page.locator('.tl-message').first().waitFor();
const loadingAfterReload = await page.locator('.tl-engine-status[data-state="loading"]').count() > 0;
await page.locator('.tl-composer-input').fill(queued);
await page.getByRole('button', { name: '发送' }).click();
await page.waitForTimeout(300);
if (loadingAfterReload) {
    await page.reload();
    await page.locator('.tl-composer-input').waitFor();
    await page.waitForFunction(text => document.querySelector('.tl-composer-input')?.value.includes(text), queued, { timeout: 10000 })
        .then(() => check('P0-3 queued message restored after reload', true))
        .catch(async () => check('P0-3 queued message restored after reload', false, await page.locator('.tl-composer-input').inputValue()));
    await page.locator('.tl-composer-input').fill('');
} else {
    check('P0-3 queued message restored after reload', false, 'full app was already ready; could not queue');
}

// Old messages beyond the app's rendered window must use its formatting pipeline (lists, not raw markdown).
const longFile = `m0-long-${run}`;
const longChat = [{ user_name: 'unused', character_name: 'unused', chat_metadata: {} }];
for (let i = 0; i < 160; i++) {
    longChat.push({
        name: i % 2 ? 'User' : 'Seraphina', is_user: i % 2 === 1, is_system: false, send_date: new Date().toISOString(), extra: {},
        mes: i === 0 ? `开头的清单${run}\n\n- 第一项\n- 第二项` : `第 ${i} 条`,
    });
}
const saved = await post('/api/chats/save', { ch_name: 'Seraphina', file_name: longFile, chat: longChat, avatar_url: AVATAR });
check('long chat fixture saved', saved.ok(), String(saved.status()));
await page.goto(`${appUrl}#chat=${AVATAR}&file=${encodeURIComponent(longFile)}`);
await page.locator('.tl-message').first().waitFor();
await engineReady();
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 60000 });
for (let i = 0; i < 6 && await page.locator('.tl-more').count(); i++) {
    await page.locator('.tl-more').click();
    await page.waitForTimeout(300);
}
const oldest = page.locator('.tl-message[data-index="0"] .tl-message-body');
await oldest.waitFor();
const inDom = await inEngine(() => !!document.querySelector('iframe.engine').contentDocument.querySelector('#chat .mes[mesid="0"]'));
check('fixture message 0 is outside the app DOM', !inDom);
check('old message rendered by app formatting (list items)', await oldest.locator('li').count() === 2, await oldest.innerHTML());

// P0-2: group chats are listed and open in the full app.
const groupName = `测试合集${run}`;
// avatar_url as the app's own 新建群组 stores it; without it SillyTavern 1.16 fails to show any group.
const created = await post('/api/groups/create', { name: groupName, members: [AVATAR], avatar_url: 'img/ai4.png' });
const group = await created.json();
groupId = group.id ?? '';
check('group fixture created', created.ok() && !!group.id);
await page.goto(appUrl);
const card = page.locator('.tl-group', { hasText: groupName });
await card.waitFor();
check('P0-2 group listed in library', true);
await card.click();
await page.locator('iframe.engine.visible').waitFor({ timeout: 240000 });
const openedGroup = await inEngine(() => String(document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().groupId));
check('P0-2 group opened in full app', openedGroup === String(group.id), openedGroup);
await page.getByRole('button', { name: '返回轻酒馆' }).click();
await deleteGroup();

// Version gate and bridge capabilities.
await page.getByRole('button', { name: '我的' }).click();
const about = await page.locator('.tl-about').innerText();
const serverVersion = (await (await page.request.get(`${base}/version`)).json()).pkgVersion;
const tested = (process.env.TESTED_VERSIONS ?? '1.16.0,1.17.0,1.18.0,1.19.0').split(',').includes(serverVersion);
// A git install shows its branch and commit after the number ("1.19.0 'release' (06bde93)"); the verdict is the number's.
const shownVersion = new RegExp(`酒馆 ${serverVersion.replace(/\./g, '\\.')}( [^·]*)? · ${tested ? '已验证' : '未验证此版本'}`);
check('version gate reports the server version correctly', shownVersion.test(about), about);
const capabilities = await inEngine(() => document.querySelector('iframe.engine').contentWindow.TavernLiteBridge?.capabilities);
check('bridge capabilities all available', capabilities && Object.values(capabilities).every(Boolean), JSON.stringify(capabilities));
await page.getByRole('button', { name: '返回' }).click();

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(JSON.stringify(results, null, 1));
await browser.close();
process.exit(problems.length ? 1 : 0);
