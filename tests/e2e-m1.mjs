// M1 acceptance: the reader works as a reading app. A newcomer can go library → continue → send → swipe using only
// what is on screen; continue, new chapter, message actions, deep links and the immersive header all work.
// Usage: node e2e-m1.mjs <baseUrl> <handle> <password> [latencyMs] [downKbps]
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
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'] });
await context.addInitScript(() => {
    window.__tlToasts = [];
    new MutationObserver(rs => { for (const r of rs) for (const n of r.addedNodes) if (n.classList?.contains('tl-toast')) window.__tlToasts.push(n.textContent); })
        .observe(document, { childList: true, subtree: true });
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));

process.on('uncaughtException', async error => {
    console.log('FAILURE', error.message.split('\n')[0], (error.stack ?? '').split('\n').find(l => l.includes('e2e-m1.mjs')));
    console.log(JSON.stringify({ toasts: await page.evaluate(() => window.__tlToasts).catch(() => null), results }, null, 1));
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

const synced = () => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const idle = () => page.locator('.tl-send').waitFor({ timeout: 120000 });
const lastChar = () => page.locator('.tl-message[data-role="char"]').last();
const swipeCount = () => lastChar().locator('.tl-swipe-count').innerText();

// A fresh story that ends with a character reply, so it becomes the "continue reading" card.
const storyFile = `m1-story-${run}`;
const story = [{ user_name: 'unused', character_name: 'unused', chat_metadata: {} }];
for (let i = 0; i < 60; i++) {
    story.push({ name: i % 2 ? 'User' : 'Seraphina', is_user: i % 2 === 1, is_system: false, send_date: new Date().toISOString(), extra: {}, mes: `故事第 ${i} 段。`.repeat(i % 2 ? 1 : 6) });
}
story.push({ name: 'Seraphina', is_user: false, is_system: false, send_date: new Date().toISOString(), extra: {}, mes: `开场白${run}` });
check('story fixture saved', (await post('/api/chats/save', { ch_name: 'Seraphina', file_name: storyFile, chat: story, avatar_url: AVATAR })).ok());

// Newcomer task: library → continue → send → swipe, using only visible controls.
await page.goto(appUrl);
const primary = page.locator('.tl-continue-primary');
await primary.waitFor();
check('library shows a continue-reading card', (await primary.innerText()).includes('继续阅读'));
await primary.click();
await page.locator('.tl-message').first().waitFor();
const statusText = await page.locator('.tl-engine-status').innerText().catch(() => '');
check('loading status says to read and write meanwhile', statusText.includes('正在准备') && statusText.includes('可以先看、先写'), statusText);
await synced();
check('reader opened the continued story', await page.evaluate(f => decodeURIComponent(location.hash).includes(f), storyFile));

const message = `新手第一句${run}`;
await page.locator('.tl-composer-input').fill(message);
await page.getByRole('button', { name: '发送' }).click();
await lastChar().filter({ hasText: `收到：${message}` }).waitFor({ timeout: 120000 });
await idle();
check('newcomer sent a message and got a reply', true);

await lastChar().locator('.tl-swipe').waitFor();
await lastChar().getByRole('button', { name: '生成新回复' }).click();
await page.waitForFunction(() => /2\/2/.test(document.querySelectorAll('.tl-message[data-role="char"]')[document.querySelectorAll('.tl-message[data-role="char"]').length - 1]?.querySelector('.tl-swipe-count')?.textContent ?? ''), null, { timeout: 120000 });
await idle();
check('swipe arrow generated a second reply', (await swipeCount()) === '2/2', await swipeCount());
await lastChar().getByRole('button', { name: '上一个回复' }).click();
await page.waitForFunction(() => /1\/2/.test([...document.querySelectorAll('.tl-message[data-role="char"] .tl-swipe-count')].pop()?.textContent ?? ''), null, { timeout: 30000 });
check('swipe back to the first reply', (await swipeCount()) === '1/2', await swipeCount());

// Horizontal gesture on the last reply (away from the screen edges) goes to the next reply.
await idle();
const box = await lastChar().locator('.tl-message-body').boundingBox();
const y = box.y + Math.min(box.height / 2, 40);
await page.mouse.move(300, y);
await page.mouse.down();
await page.mouse.move(220, y, { steps: 4 });
await page.mouse.move(150, y, { steps: 4 });
await page.mouse.up();
await page.waitForFunction(() => /2\/2/.test([...document.querySelectorAll('.tl-message[data-role="char"] .tl-swipe-count')].pop()?.textContent ?? ''), null, { timeout: 30000 })
    .then(() => check('swipe gesture goes to the next reply', true))
    .catch(async () => check('swipe gesture goes to the next reply', false, await swipeCount()));
await idle();

// Continue writing extends the last reply instead of adding a message.
const countBefore = await page.locator('.tl-message').count();
const repliesBefore = ((await lastChar().innerText()).match(/模拟回复/g) ?? []).length;
await lastChar().getByRole('button', { name: '继续写' }).click();
await page.waitForFunction(n => ([...document.querySelectorAll('.tl-message[data-role="char"]')].pop()?.textContent.match(/模拟回复/g) ?? []).length > n, repliesBefore, { timeout: 120000 })
    .then(() => check('continue writing extends the last reply', true))
    .catch(() => check('continue writing extends the last reply', false));
await idle();
check('continue writing does not add a message', await page.locator('.tl-message').count() === countBefore);

// Immersive header: hides while reading upwards through the story, returns at the bottom.
await page.locator('.tl-messages').evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 1200; el.dispatchEvent(new Event('scroll')); });
await page.waitForTimeout(100);
await page.locator('.tl-messages').evaluate(el => { el.scrollTop += 300; el.dispatchEvent(new Event('scroll')); });
await page.waitForTimeout(300);
check('header hides while reading', await page.locator('.tl-reader-header[data-hidden="true"]').count() === 1);
await page.locator('.tl-messages').evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
await page.waitForTimeout(300);
check('header returns at the end of the story', await page.locator('.tl-reader-header[data-hidden="true"]').count() === 0);

// Message actions: long press opens the sheet; copy works.
const target = page.locator('.tl-message[data-role="user"]').last();
const targetBox = await target.boundingBox();
await page.mouse.move(targetBox.x + 60, targetBox.y + targetBox.height / 2);
await page.mouse.down();
await page.waitForTimeout(700);
await page.mouse.up();
await page.getByRole('dialog', { name: '消息操作' }).waitFor({ timeout: 5000 })
    .then(() => check('long press opens message actions', true))
    .catch(() => check('long press opens message actions', false));
if (await page.getByRole('dialog', { name: '消息操作' }).count()) {
    await page.getByRole('button', { name: /^复制/ }).click();
    await page.waitForFunction(() => window.__tlToasts.includes('已复制'), null, { timeout: 5000 })
        .then(() => check('copy message', true)).catch(() => check('copy message', false));
}

// Edit deep link: the full app opens with that message in its editor.
await page.locator('.tl-message[data-role="user"]').last().locator('.tl-message-menu').click();
await page.getByRole('dialog', { name: '消息操作' }).getByRole('button', { name: /^更多/ }).click();
await page.getByRole('button', { name: /^在原版界面里编辑/ }).click();
await page.locator('iframe.engine.visible').waitFor({ timeout: 30000 });
const editing = await page.evaluate(() => !!document.querySelector('iframe.engine').contentDocument.querySelector('#chat .mes .mes_edit_buttons:not([style*="none"]), #curEditTextarea'));
check('edit opens the full app editor on that message', editing);
await page.evaluate(() => document.querySelector('iframe.engine').contentDocument.querySelector('.mes_edit_cancel')?.click());
await page.getByRole('button', { name: '返回轻酒馆' }).click();

// Branch from a message: a new chapter starts with the story up to that point.
const branchHash = await page.evaluate(() => location.hash);
await page.locator('.tl-message').nth(2).locator('.tl-message-menu').click();
await page.getByRole('button', { name: /^换个走向/ }).click();
await page.waitForFunction(h => location.hash !== h, branchHash, { timeout: 60000 });
await synced();
check('branch opens a new chapter', await page.evaluate(() => decodeURIComponent(location.hash)) !== decodeURIComponent(branchHash));

// New chapter from the story menu starts a fresh story with the greeting.
const beforeNew = await page.evaluate(() => location.hash);
await page.getByRole('button', { name: '更多', exact: true }).click();
await page.getByRole('button', { name: /^开始新故事/ }).click();
await page.waitForFunction(h => location.hash !== h, beforeNew, { timeout: 60000 });
await page.waitForFunction(() => !new URLSearchParams(location.hash.slice(1)).has('new'), null, { timeout: 240000 });
await synced();
await page.locator('.tl-message').first().waitFor({ timeout: 10000 }).catch(() => { });
const freshCount = await page.locator('.tl-message').count();
const nativeCount = await page.evaluate(() => document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().chat.length);
check('new chapter starts with only the greeting', freshCount === 1, `shell ${freshCount}, full app ${nativeCount}, hash ${await page.evaluate(() => decodeURIComponent(location.hash))}`);

// Tools: world books open the shell's own page; from there, the full app's world info panel is one tap away.
await page.getByRole('button', { name: '返回书架' }).click();
await page.getByRole('button', { name: '我的' }).click();
await page.getByRole('button', { name: /^设置与扩展/ }).click();
await page.getByRole('button', { name: /^世界书/ }).click();
await page.locator('.tl-worlds').waitFor({ timeout: 30000 });
await page.getByRole('button', { name: /^在原版界面里打开/ }).click();
await page.locator('iframe.engine.visible').waitFor({ timeout: 30000 });
const worldOpen = await page.evaluate(() => !!document.querySelector('iframe.engine').contentDocument.querySelector('#WI-SP-button .drawer-content.openDrawer'));
check('tools deep link opens world info', worldOpen);
await page.getByRole('button', { name: '返回轻酒馆' }).click();

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(JSON.stringify(results, null, 1));
await browser.close();
process.exit(problems.length ? 1 : 0);
