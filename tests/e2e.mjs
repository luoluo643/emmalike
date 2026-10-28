// Usage: node e2e.mjs <baseUrl> <handle> <password> [latencyMs] [downKbps]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, latency = '200', downKbps = '5000'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const results = {};
const run = Date.now().toString(36);
const first = `你好${run}`;
const second = `第二条${run}`;
const problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`; if (!ok) problems.push(name); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const pageErrors = [];
await context.addInitScript(() => {
    window.__tlToasts = [];
    new MutationObserver(records => {
        for (const r of records) for (const n of r.addedNodes) if (n.classList?.contains('tl-toast')) window.__tlToasts.push(`${((performance.now()) / 1000).toFixed(1)}s ${n.textContent}`);
    }).observe(document, { childList: true, subtree: true });
});
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 700)));

const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
const throttle = () => cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: Number(latency), downloadThroughput: Number(downKbps) * 1024 / 8, uploadThroughput: 1024 * 1024 / 8,
});
await throttle();

async function dump(error) {
    const state = await page.evaluate(() => {
        const frame = document.querySelector('iframe.engine');
        const ctx = frame?.contentWindow?.SillyTavern?.getContext?.();
        return {
            toasts: window.__tlToasts,
            pending: document.querySelector('[data-pending]')?.innerText,
            draft: document.querySelector('.tl-composer-input')?.value,
            buttons: [...document.querySelectorAll('.tl-composer .tl-button')].map(b => b.textContent + (b.disabled ? '(disabled)' : '')),
            lastLite: [...document.querySelectorAll('.tl-message')].slice(-3).map(m => m.innerText.slice(0, 80)),
            native: ctx && { chat: ctx.chat.slice(-3).map(m => (m.is_user ? 'U:' : 'C:') + m.mes.slice(0, 60)), status: ctx.onlineStatus, textarea: frame.contentDocument.getElementById('send_textarea').value },
        };
    }).catch(e => String(e));
    const last = await (await fetch(`${process.env.MOCK_URL ?? 'http://127.0.0.1:5001'}/last`)).json().catch(() => null);
    console.log('FAILURE', error.message.split('\n')[0], (error.stack ?? '').split('\n').find(l => l.includes('e2e.mjs')));
    console.log(JSON.stringify({ state, mockLastUser: (last?.messages ?? []).filter(m => m.role === 'user').slice(-1) }, null, 1));
    console.log(JSON.stringify(results, null, 1));
    await browser.close();
    process.exit(2);
}
process.on('unhandledRejection', dump);
process.on('uncaughtException', dump);

let t = Date.now();
// A stuck step would otherwise hang without a word: after 12 minutes, print what passed so far (where it stopped) and stop.
const watchdog = setTimeout(() => { setTimeout(() => process.exit(3), 30000).unref(); dump(new Error('still running after 12 minutes')); }, 12 * 60000);
watchdog.unref();
await page.goto(appUrl);
await page.getByPlaceholder('账号').waitFor();
results.coldLoginFormMs = Date.now() - t;

await page.getByPlaceholder('账号').fill(handle);
await page.getByPlaceholder('密码（没设可不填）').fill(password);
t = Date.now();
await page.getByRole('button', { name: '登录' }).click();
await page.locator('.tl-character').first().waitFor();
results.loginToLibraryMs = Date.now() - t;
check('library lists characters', await page.locator('.tl-character').count() > 0);

t = Date.now();
await page.locator('.tl-character').first().click();
await page.locator('.tl-message').first().waitFor();
results.openChatPreviewMs = Date.now() - t;
check('chat preview visible', (await page.locator('.tl-message .tl-message-body').allInnerTexts()).some(x => x.trim().length > 0));

const engineLoading = await page.locator('.tl-engine-status[data-state="loading"]').count() > 0;
const input = page.locator('.tl-composer-input');
await input.fill(first);
await page.getByRole('button', { name: '发送' }).click();
check('message queued while full app loads', !engineLoading || await page.locator('[data-pending="true"]').count() === 1);

t = Date.now();
const reply = page.locator('.tl-message[data-role="char"]', { hasText: `收到：${first}` });
const popupShown = page.locator('iframe.engine.visible');
await Promise.race([reply.waitFor({ timeout: 240000 }), popupShown.waitFor({ timeout: 240000 })]);
if (await popupShown.count()) {
    results.popupShownAfterMs = Date.now() - t;
    const native = page.frameLocator('iframe.engine');
    results.popupText = (await native.locator('dialog[open]').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
    const ok = native.locator('dialog[open] .popup-button-ok').first();
    if (await ok.isVisible().catch(() => false)) await ok.click();
    await popupShown.waitFor({ state: 'detached', timeout: 15000 }).catch(() => { });
    check('auto-returned after native popup closed', await page.locator('iframe.engine.visible').count() === 0);
}
await reply.waitFor({ timeout: 240000 });
results.queuedSendToReplyMs = Date.now() - t;
await page.locator('.tl-send').waitFor({ timeout: 60000 });
check('pending bubble cleared', await page.locator('[data-pending="true"]').count() === 0);

const last = await (await fetch(`${process.env.MOCK_URL ?? 'http://127.0.0.1:5001'}/last`)).json();
const system = (last?.messages ?? []).filter(m => m.role === 'system').map(m => m.content).join('\n');
check('native prompt pipeline used (preset main prompt present)', /Write .*next reply|Seraphina/i.test(system), system.slice(0, 120));
check('model received user message', JSON.stringify(last?.messages ?? []).includes(first));

await input.fill(second);
await input.press('Enter');
check('enter inserts newline on touch devices', (await input.inputValue()) === `${second}\n`);
await page.getByRole('button', { name: '发送' }).click();
await page.locator('.tl-message[data-role="char"]', { hasText: `收到：${second}` }).waitFor({ timeout: 60000 });
check('direct send after ready', true);

const before = await page.locator('.tl-message').count();
await page.locator('.tl-send').waitFor();
// A new reply for the last one: "换个回复" under it; the menu also has 重新生成 (replaces this round's reply).
await page.locator('.tl-message[data-role="char"]').last().locator('.tl-message-menu').click();
check('重新生成 in the menu next to 换个回复', await page.locator('.tl-sheet .tl-sheet-item').filter({ hasText: /^重新生成/ }).count() === 1);
await page.getByRole('button', { name: '关闭' }).last().click();
await page.locator('.tl-message[data-role="char"]').last().getByRole('button', { name: /^(生成新回复|下一个回复)$/ }).click();
await page.waitForTimeout(500);
await page.locator('.tl-send').waitFor({ timeout: 60000 });
check('a new reply keeps message count', await page.locator('.tl-message').count() === before, `${before} -> ${await page.locator('.tl-message').count()}`);

await page.getByRole('button', { name: '更多', exact: true }).click();
await page.getByRole('button', { name: /^打开原版界面/ }).click();
check('full app shown', await page.locator('iframe.engine.visible').isVisible());
await page.getByRole('button', { name: '返回轻酒馆' }).click();
check('returned from full app', !(await page.locator('iframe.engine.visible').count()));
// Leaving the full app's view also removes its history entry (the back gesture closes it); let that settle.
await page.waitForTimeout(500);

t = Date.now();
await page.reload();
await page.locator('.tl-message', { hasText: `收到：${second}` }).first().waitFor();
results.warmReloadChatMs = Date.now() - t;
await page.waitForFunction(() => !!document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge && !document.querySelector('.tl-engine-status'), null, { timeout: 240000 });
results.warmEngineReadyMs = Date.now() - t;

const saved = await page.evaluate(async () => {
    const token = (await (await fetch('/csrf-token')).json()).token;
    const params = new URLSearchParams(location.hash.slice(1));
    const r = await fetch('/api/chats/get', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify({ ch_name: 'x', file_name: params.get('file'), avatar_url: params.get('chat') }) });
    return JSON.stringify(await r.json());
});
check('chat persisted to server in native format', saved.includes(first) && saved.includes('chat_metadata'));

await page.getByRole('button', { name: '返回书架' }).click();
// The list refreshes after the chat is saved; wait for it instead of reading the first render.
await page.locator('.tl-continue', { hasText: 'Seraphina' }).first().waitFor({ timeout: 15000 })
    .then(() => check('continue section shows recent chat', true)).catch(() => check('continue section shows recent chat', false));

await page.getByRole('button', { name: '我的' }).click();
await page.getByRole('button', { name: /^自定义 CSS/ }).click();
await page.locator('.tl-css-editor').fill(':root { --tl-bg: rgb(18, 52, 86); }');
await page.getByRole('button', { name: '保存' }).click();
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
check('custom css applied over base layer', bg === 'rgb(18, 52, 86)', bg);
await page.waitForFunction(() => {
    try {
        const ctx = document.querySelector('iframe.engine')?.contentWindow?.SillyTavern?.getContext?.();
        return ctx?.extensionSettings?.tavernLite?.customCss?.includes('18, 52, 86');
    } catch {
        return false;
    }
}, null, { timeout: 180000 }).then(() => check('custom css stored in account settings', true)).catch(e => check('custom css stored in account settings', false, e.message.split('\n')[0]));
results.cssAccountState = await page.evaluate(() => { let ctx; try { ctx = document.querySelector('iframe.engine')?.contentWindow?.SillyTavern?.getContext?.(); } catch { } return JSON.stringify({ engineBadge: document.querySelector('.tl-engine-status')?.textContent ?? null, tavernLite: ctx?.extensionSettings?.tavernLite ?? null, local: localStorage.getItem('tavern-lite:custom-css') }); });
await page.getByRole('button', { name: '清空' }).click();
await page.getByRole('button', { name: '保存' }).click();

check('no page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
console.log(JSON.stringify({ latency: Number(latency), downKbps: Number(downKbps), ...results }, null, 1));
await browser.close();
process.exit(problems.length ? 1 : 0);
