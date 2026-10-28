// M5 acceptance: what extensions put into messages works in the shell. A Tavern Helper frontend card runs in the
// shell wired to the full app (its message, the helper API, slash commands, notices) while the full app's own copy is
// parked, and comes back when the full app is shown. A panel another extension adds under a message is mirrored with
// its stylesheet, and taps, typing and a window it opens reach the real panel.
// Needs Tavern Helper and the fixture panel extension (tests/prepare.sh installs both).
// Usage: node e2e-m5.mjs <baseUrl> <handle> <password> [latencyMs] [downKbps]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, latency = '200', downKbps = '5000'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `M5卡片${run}`;
const CARD = [
    '“欢迎来到小店。”',
    '',
    '```html',
    '<!DOCTYPE html><html><head><style>#card{padding:8px;background:#f3e9d2}</style></head><body>',
    '<div id="card">卡片加载中</div><button id="tally">记一笔</button>',
    '<script>',
    "document.getElementById('card').textContent = '楼层' + getCurrentMessageId() + (typeof TavernHelper === 'object' && TavernHelper ? '·已接入' : '·未接入');",
    "document.getElementById('tally').addEventListener('click', async () => { await triggerSlash('/setvar key=tltest clicked'); toastr.success('卡片按钮生效'); });",
    '</script></body></html>',
    '```',
].join('\n');
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
const cleanup = async () => { if (avatar) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { }); };

process.on('uncaughtException', async error => {
    console.log('FAILURE', error.message.split('\n')[0], (error.stack ?? '').split('\n').find(l => l.includes('e2e-m5.mjs')));
    console.log(JSON.stringify({ toasts: await page.evaluate(() => window.__tlToasts).catch(() => null), results, pageErrors }, null, 1));
    if (process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT }).catch(() => { });
    await cleanup();
    await browser.close();
    process.exit(2);
});

const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: Number(latency), downloadThroughput: Number(downKbps) * 1024 / 8, uploadThroughput: 1024 * 1024 / 8,
});
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');

const created = await page.request.post(`${base}/api/characters/create`, {
    headers: { 'X-CSRF-Token': token },
    multipart: {
        ch_name: NAME, description: '测试前端卡片的角色', first_mes: CARD, personality: '', scenario: '', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '',
    },
});
avatar = (await created.text()).trim();
if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);

const toast = text => page.waitForFunction(t => window.__tlToasts.some(x => x.includes(t)), text, { timeout: 60000 });
const engineEval = (fn, arg) => page.evaluate(([source, a]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'a', `return (${source})(w, a);`)(w, a);
}, [fn.toString(), arg]);

await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: '' })}`);
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });

// The card runs in the shell, knows its message and reaches the helper API.
const slot = page.locator('.tl-message[data-index="0"] .tl-frontend-card');
await slot.locator('iframe.tl-card-frame').waitFor({ timeout: 60000 });
const card = page.frameLocator('.tl-message[data-index="0"] iframe.tl-card-frame');
await card.locator('#card', { hasText: '楼层0·已接入' }).waitFor({ timeout: 60000 })
    .then(() => check('card runs in the shell with its message id and the helper API', true))
    .catch(async () => check('card runs in the shell with its message id and the helper API', false, await card.locator('#card').textContent().catch(e => e.message)));
check('card code block is not shown as text', !(await page.locator('.tl-message[data-index="0"] .tl-message-body pre').count()));
const frameHeight = await slot.locator('iframe').evaluate(f => f.getBoundingClientRect().height);
check('card frame is sized to its content', frameHeight > 30 && frameHeight < 400, String(frameHeight));

// The full app's copy is parked while the shell shows the card.
const parkedNow = () => engineEval(w => {
    const frame = w.document.querySelector('#chat .mes[mesid="0"] iframe[id^="TH-message--0--"]');
    return frame ? (frame.getAttribute('srcdoc') ?? '').length < 40 : null;
});
check('full app copy is parked', await parkedNow() === true, String(await parkedNow()));

// Its button acts on the real chat; its notice shows in the shell.
await card.locator('#tally').click();
await toast('卡片按钮生效');
const variable = await engineEval(w => w.SillyTavern.getContext().chatMetadata?.variables?.tltest);
check('card button runs a slash command on the real chat', variable === 'clicked', String(variable));

// Showing the full app gives it its card back; returning parks it again.
await page.getByRole('button', { name: '更多', exact: true }).click();
await page.getByRole('button', { name: /^打开原版界面/ }).click();
await page.waitForTimeout(500);
check('full app gets its card back while shown', await parkedNow() === false);
await page.getByRole('button', { name: '返回轻酒馆' }).click();
await page.waitForTimeout(500);
check('parked again after returning', await parkedNow() === true);

// The fixture panel under the greeting is mirrored with its stylesheet.
const mirror = page.frameLocator('.tl-message[data-index="0"] iframe.tl-panel-frame');
await mirror.locator('.tltest-toggle').waitFor({ timeout: 30000 });
check('panel is not mixed into the message text', !(await page.locator('.tl-message[data-index="0"] .tl-message-body .tltest-panel').count()));
const engineContentShown = () => engineEval(w => w.document.querySelector('#chat .mes[mesid="0"] .tltest-content')?.style.display);
await mirror.locator('.tltest-toggle').click();
await page.waitForFunction(() => {
    const doc = document.querySelector('.tl-message[data-index="0"] iframe.tl-panel-frame')?.contentDocument;
    const content = doc?.querySelector('.tltest-content');
    return content && content.style.display === 'block';
}, null, { timeout: 15000 }).then(() => check('tap in the mirror reaches the real panel and the mirror follows', true))
    .catch(async () => check('tap in the mirror reaches the real panel and the mirror follows', false, String(await engineContentShown())));
const color = await mirror.locator('.tltest-content').evaluate(el => getComputedStyle(el).color);
check("mirror uses the extension's stylesheet", color === 'rgb(1, 2, 3)', color);
const panelFrameHeight = await page.locator('.tl-message[data-index="0"] iframe.tl-panel-frame').evaluate(f => f.getBoundingClientRect().height);
check('mirror grows with the panel', panelFrameHeight > 30, String(panelFrameHeight));

await mirror.locator('.tltest-input').fill('带伞');
const typed = await engineEval(w => w.__tltestInput);
check('typing in the mirror reaches the real panel', typed === '带伞', String(typed));
await mirror.locator('.tltest-open').click();
await page.locator('.tl-popup-bar', { hasText: '原版界面里打开了一个窗口' }).waitFor({ timeout: 10000 })
    .then(() => check('a window the panel opens is offered from the shell', true))
    .catch(async () => check('a window the panel opens is offered from the shell', false,
        `window opened: ${await engineEval(w => !!w.document.querySelector('.tltest-window'))}`));
// Only a hint: it can be closed without opening the full app.
await page.locator('.tl-popup-bar').getByRole('button', { name: '关闭提示' }).click().catch(() => { });
await page.locator('.tl-popup-bar', { hasText: '原版界面里打开了一个窗口' }).waitFor({ state: 'detached', timeout: 5000 })
    .then(() => check('the window hint can be closed', true)).catch(() => check('the window hint can be closed', false, 'still shown'));

// A reply from the model gets its own mirrored panel.
await page.locator('.tl-composer-input').fill(`我推门进去。${run}`);
await page.getByRole('button', { name: '发送' }).click();
await page.locator('.tl-message[data-role="char"]', { hasText: `我推门进去。${run}` }).waitFor({ timeout: 120000 });
await page.locator('.tl-send').waitFor({ timeout: 120000 });
const lastChar = page.locator('.tl-message[data-role="char"]').last();
await lastChar.locator('iframe.tl-panel-frame').waitFor({ timeout: 30000 })
    .then(() => check('new reply gets its panel mirror', true)).catch(() => check('new reply gets its panel mirror', false));

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await cleanup();
console.log(JSON.stringify(results, null, 1));
await browser.close();
if (problems.length) {
    console.log(`FAILED: ${problems.join(', ')}`);
    process.exit(1);
}
console.log('ALL PASS');
