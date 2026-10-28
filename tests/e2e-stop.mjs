// Stopping and repeated taps (2026-10-22): a reply asked for three times while the first is still starting is written
// once (a queued 让角色回复 used to replace the reply written meanwhile); 停止 before the request reaches the app sends
// nothing; a stop the app would swallow while its generation is starting still stops it; 让角色回复 asked for when the
// story already ends with a reply leaves that reply alone.
// Needs the mock model's 【慢】 delay and /count (tests/mock-llm.mjs).
// Usage: node e2e-stop.mjs <baseUrl> <handle> <password> [latencyMs] [downKbps]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, latency = '200', downKbps = '5000'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const countUrl = process.env.MOCK_COUNT_URL ?? 'http://127.0.0.1:5001/count';
const run = Date.now().toString(36);
const NAME = `停止测试${run}`;
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
let avatar = '';

const engineEval = (fn, arg) => page.evaluate(([source, a]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'a', `return (${source})(w, a);`)(w, a);
}, [fn.toString(), arg]);

const removeSlowStart = () => engineEval(w => {
    const c = w.SillyTavern.getContext();
    if (w.__tlSlowStart) c.eventSource.removeListener(c.eventTypes.GENERATION_STARTED, w.__tlSlowStart);
    w.__tlSlowStart = null;
});

const cleanup = async () => {
    await removeSlowStart().catch(() => { });
    if (avatar) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
};

let failing = false;
process.on('uncaughtException', async error => {
    // An error while reporting or cleaning up must not start the report again.
    if (failing) process.exit(3);
    failing = true;
    console.log('FAILURE', error.message.split('\n').slice(0, 12).join(' | '), (error.stack ?? '').split('\n').find(l => l.includes('e2e-stop.mjs')));
    console.log(JSON.stringify({ toasts: await page.evaluate(() => window.__tlToasts).catch(() => null), results, pageErrors }, null, 1));
    if (process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT }).catch(() => { });
    await cleanup();
    await browser.close();
    process.exit(2);
});

const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
const setLatency = ms => cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: ms, downloadThroughput: Number(downKbps) * 1024 / 8, uploadThroughput: 1024 * 1024 / 8,
});
await setLatency(Number(latency));
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');

const created = await page.request.post(`${base}/api/characters/create`, {
    headers: { 'X-CSRF-Token': token },
    multipart: {
        ch_name: NAME, description: '测试停止与连点的角色', first_mes: '“你来了。”', personality: '', scenario: '', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '',
    },
});
avatar = (await created.text()).trim();
if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);

const streamed = async () => (await (await fetch(countUrl)).json()).streamed;
const synced = () => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const idle = () => page.waitForFunction(() => !document.querySelector('.tl-stop') && !document.querySelector('[data-pending="true"]'), null, { timeout: 120000 });
// Waits out anything a queued tap would still start: a queued request begins within a few seconds of the last one.
const settled = async () => { for (let k = 0; k < 3; k++) { await idle(); await page.waitForTimeout(4000); } await idle(); };
const chatState = () => engineEval(w => {
    const chat = w.SillyTavern.getContext().chat;
    const last = chat.at(-1);
    return { length: chat.length, lastIsUser: !!last?.is_user, lastText: String(last?.mes ?? '') };
});
const endWithUser = async () => {
    if (!(await chatState()).lastIsUser) await engineEval(async w => { await w.SillyTavern.getContext().deleteLastMessage(); });
    await page.waitForFunction(() => [...document.querySelectorAll('.tl-message')].pop()?.dataset.role === 'user', null, { timeout: 30000 });
};
const replyButton = () => page.getByRole('button', { name: `让${NAME}回复` }).last();

await page.goto(appUrl);
await page.locator('.tl-library').waitFor({ timeout: 60000 });
await page.evaluate(a => { location.hash = new URLSearchParams({ chat: a, file: '' }).toString(); }, avatar);
await synced();

// The user's words carry 【慢】: every reply to them takes 5 s before its first words, like a slow model.
await page.locator('.tl-composer-input').fill(`【慢】第一句${run}`);
await page.getByRole('button', { name: '发送' }).click();
await idle();
await page.locator('.tl-message[data-role="char"]').last().locator('.tl-message-body', { hasText: '模拟回复' }).waitFor({ timeout: 60000 });
await endWithUser();

// Account checks before a start take a while on a phone; slow requests make the gap wide enough for repeated taps.
await setLatency(600);

// Three quick taps on 让角色回复: one reply, written once. The stop button shows at once, and the later taps, landing
// on it, do not stop the reply.
{
    const before = await streamed();
    const { length } = await chatState();
    const box = await page.locator('.tl-send').boundingBox();
    for (let k = 0; k < 3; k++) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        if (k === 0) check('stop shows right after the tap', await page.locator('.tl-stop').isVisible().catch(() => false));
        await page.waitForTimeout(150);
    }
    await settled();
    const sent = await streamed() - before;
    const after = await chatState();
    check('three quick taps send one generation', sent === 1, `sent ${sent}`);
    check('three quick taps add one reply', after.length === length + 1 && !after.lastIsUser && after.lastText.includes('模拟回复'),
        JSON.stringify({ length, after: { ...after, lastText: after.lastText.slice(0, 40) } }));
}

// 让角色回复 asked for in a story that already ends with a reply (as a queued tap would find it) leaves the reply alone.
{
    const before = await streamed();
    const state = await chatState();
    const outcome = await engineEval(w => w.TavernLiteBridge.regenerate({ after: 'user' }).then(() => 'ran', e => e.code ?? e.message));
    await settled();
    const after = await chatState();
    check('reply request after a reply does nothing', outcome === 'cancelled' && await streamed() === before
        && after.length === state.length && after.lastText === state.lastText, JSON.stringify({ outcome }));
}

// 停止 pressed before the request reaches the app (still checking the account) sends nothing.
{
    await endWithUser();
    const before = await streamed();
    await replyButton().click();
    await page.waitForTimeout(750);
    await page.locator('.tl-stop').click();
    await settled();
    check('stop before the start sends nothing', await streamed() === before, `sent ${await streamed() - before}`);
    check('story still ends with the user after an early stop', (await chatState()).lastIsUser);
}

// 停止 pressed while the app is starting its generation (its GENERATION_STARTED listeners still running, here a slow
// one) is swallowed by the app, which then sends the request anyway; the shell keeps stopping it.
{
    await setLatency(Number(latency));
    await engineEval(w => {
        const c = w.SillyTavern.getContext();
        w.__tlSlowStart = async (_type, _options, dryRun) => {
            if (dryRun) return;
            w.__tlStarting = true;
            await new Promise(resolve => setTimeout(resolve, 3000));
            w.__tlStarting = false;
        };
        c.eventSource.on(c.eventTypes.GENERATION_STARTED, w.__tlSlowStart);
    });
    await endWithUser();
    await replyButton().click();
    await page.waitForFunction(() => document.querySelector('iframe.engine').contentWindow.__tlStarting === true, null, { timeout: 30000 });
    await page.waitForTimeout(800);
    await page.locator('.tl-stop').click();
    await settled();
    const after = await chatState();
    check('stop while the app is starting is not swallowed', after.lastIsUser || !after.lastText.includes('模拟回复'),
        JSON.stringify({ ...after, lastText: after.lastText.slice(0, 40) }));
    await removeSlowStart();
}

check('no notice for a cancelled tap', !(await page.evaluate(() => window.__tlToasts)).some(t => t.includes('已停止')),
    JSON.stringify(await page.evaluate(() => window.__tlToasts)));
// Stopping a request the app has just sent rejects its fetch with an AbortError the app leaves unhandled; its own stop
// button does the same at that moment. Stopped before the request goes out, the app's own 重新生成 handler (which does
// not await Generate) leaves "Generation was aborted." unhandled instead.
const errors = pageErrors.filter(e => !(e.startsWith('AbortError: signal is aborted without reason') && e.includes('onStopStreaming'))
    && !(e.startsWith('Error: Generation was aborted.') && e.includes('sendStreamingRequest')));
check('no page errors', errors.length === 0, errors.join(' | '));

await cleanup();
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS: ${problems.join(', ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
