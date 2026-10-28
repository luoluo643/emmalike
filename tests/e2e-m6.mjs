// M6 acceptance: what the full app shows around messages is in the shell too. Reasoning (streaming "thinking" with
// a clock, then folded with its duration), hidden messages marked and unhidden from the shell, the per-message small
// print following the full app's settings, the bar above the input (Quick Replies / script buttons), the extensions
// menu, the full app's other message buttons, floating layers placed on the page (a Live2D figure) shown and
// touchable over the shell, and panel mirrors readable in any theme.
// Needs the fixture extension (tests/prepare.sh) and the mock model's 【思考】 reasoning.
// Usage: node e2e-m6.mjs <baseUrl> <handle> <password> [latencyMs] [downKbps]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, latency = '200', downKbps = '5000'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `M6测试${run}`;
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
    console.log('FAILURE', error.message.split('\n').slice(0, 12).join(' | '), (error.stack ?? '').split('\n').find(l => l.includes('e2e-m6.mjs')));
    // Floating layers laid over the shell are the usual reason a tap on the shell times out.
    console.log('FLOATS', await page.evaluate(() => {
        const f = document.querySelector('iframe.engine');
        const d = f?.contentDocument;
        return JSON.stringify({
            overlay: f?.className, clip: f?.style.clipPath,
            floats: d ? [...d.querySelectorAll('body > [data-tl-float]')].map(e => `${e.tagName}#${e.id}.${e.className} ${JSON.stringify(e.getBoundingClientRect())} ${e.textContent.trim().slice(0, 80)}`) : null,
        });
    }).catch(e => e.message));
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
        ch_name: NAME, description: '测试 M6 的角色', first_mes: '“你来了。”', personality: '', scenario: '', mes_example: '',
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
const synced = () => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const idle = () => page.locator('.tl-send').waitFor({ timeout: 120000 });
const sheet = title => page.getByRole('dialog', { name: title });
// Tapping the close button, as on a phone: after a tap on a floating layer the keyboard focus is in the full app.
const closeSheet = async () => { await page.getByRole('dialog').last().getByRole('button', { name: '关闭' }).click(); await page.waitForTimeout(300); };

await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: '' })}`);
await synced();

// Reasoning: shown while it streams, with a clock, then folded with its duration; the content opens on a tap.
await page.locator('.tl-composer-input').fill(`【思考】你在想什么？${run}`);
await page.getByRole('button', { name: '发送' }).click();
await page.locator('.tl-reasoning[data-state="thinking"]').waitFor({ timeout: 60000 })
    .then(() => check('reasoning shows while the model thinks', true)).catch(() => check('reasoning shows while the model thinks', false));
await idle();
const lastChar = page.locator('.tl-message[data-role="char"]').last();
await lastChar.locator('.tl-reasoning summary', { hasText: /思考了 \d+ 秒/ }).waitFor({ timeout: 30000 })
    .then(() => check('finished reasoning folds with its duration', true))
    .catch(async () => check('finished reasoning folds with its duration', false, await lastChar.locator('.tl-reasoning').innerText().catch(e => e.message)));
await lastChar.locator('.tl-reasoning summary').click();
const thought = await lastChar.locator('.tl-reasoning-body').innerText().catch(() => '');
check('reasoning content opens on a tap', thought.includes('先想一想'), thought);
check('reply text stays outside the reasoning', (await lastChar.locator('.tl-message-body').innerText()).includes('模拟回复'));
const lastIndex = Number(await lastChar.getAttribute('data-index'));

// Older messages (not in the full app's page) show their stored reasoning too.
await page.reload();
await synced();
await page.locator(`.tl-message[data-index="${lastIndex}"] .tl-reasoning summary`, { hasText: /思考了 \d+ 秒/ }).waitFor({ timeout: 30000 })
    .then(() => check('stored reasoning shows after a reload', true)).catch(() => check('stored reasoning shows after a reload', false));

// Small print follows the full app's settings: time on (default), message number switched on. The time is written
// in Chinese whatever language the full app uses ("10月11日 16:31").
await engineEval(w => { w.SillyTavern.getContext().powerUserSettings.mesIDDisplay_enabled = true; });
await page.getByRole('button', { name: '阅读设置' }).click();
await closeSheet();
const meta = await page.locator(`.tl-message[data-index="${lastIndex}"] .tl-message-meta`).innerText().catch(() => '');
check('time (in Chinese) and message number shown like the full app', /\d{1,2}月\d{1,2}日 \d{2}:\d{2}/.test(meta) && meta.includes(`#${lastIndex}`), meta);
await engineEval(w => { w.SillyTavern.getContext().powerUserSettings.mesIDDisplay_enabled = false; });

// Hidden messages are marked; the full app's "unhide" is reachable from the message sheet.
const userIndex = lastIndex - 1;
await engineEval(async (w, i) => w.SillyTavern.getContext().executeSlashCommandsWithOptions(`/hide ${i}`), userIndex);
const userMessage = page.locator(`.tl-message[data-index="${userIndex}"]`);
await userMessage.locator('.tl-hidden-mark').waitFor({ timeout: 15000 })
    .then(() => check('hidden message is marked', true)).catch(() => check('hidden message is marked', false));
check('hidden message keeps its speaker', await userMessage.getAttribute('data-role') === 'user');
await userMessage.locator('.tl-message-menu').click();
await sheet('消息操作').getByRole('button', { name: /^更多/ }).click();
await sheet('更多').getByText('原版界面里的其他按钮').waitFor({ timeout: 30000 });
await sheet('更多').getByRole('button', { name: /^取消隐藏/ }).click();
await page.waitForFunction(i => !document.querySelector(`.tl-message[data-index="${i}"] .tl-hidden-mark`), userIndex, { timeout: 15000 })
    .then(() => check('unhide from the shell', true)).catch(() => check('unhide from the shell', false));
check('the full app has it unhidden', await engineEval((w, i) => w.SillyTavern.getContext().chat[i].is_system, userIndex) === false);

// Another extension's button on a message.
await lastChar.locator('.tl-message-menu').click();
await sheet('消息操作').getByRole('button', { name: /^更多/ }).click();
await sheet('更多').getByRole('button', { name: '测试消息按钮' }).click();
await page.waitForTimeout(800);
const mesButton = await engineEval(w => w.__tltestMesButton);
check("an extension's message button works from the shell", mesButton === lastIndex, String(mesButton));

// The bar above the input, opened from ⌃ next to 番外 (closed by default).
if (!(await page.locator('#tl-quick-row').count())) await page.getByRole('button', { name: '展开快捷按钮' }).click();
const inputButton = page.locator('.tl-input-buttons').getByRole('button', { name: '测试快捷按钮' });
await inputButton.waitFor({ timeout: 15000 });
await inputButton.click();
await page.waitForTimeout(500);
const pressed = await engineEval(w => ({ count: w.__tltestInputButton, buttons: [...w.document.querySelectorAll('.tltest-input-button')].length, bars: [...w.document.querySelectorAll('#send_form div')].filter(d => d.id === 'qr--bar').length }));
if (pressed.count !== 1) {
    pressed.toasts = await page.evaluate(() => window.__tlToasts.slice(-3));
    pressed.listed = await engineEval(w => w.TavernLiteBridge.inputButtons());
    pressed.direct = await engineEval(w => { const b = w.TavernLiteBridge.inputButtons()[0]; return b && w.TavernLiteBridge.clickInputButton(b.key); });
    pressed.after = await engineEval(w => w.__tltestInputButton);
    pressed.chips = await page.locator('.tl-input-buttons button').allTextContents();
}
check('button above the input works from the shell', pressed.count === 1, JSON.stringify(pressed));

// The extensions menu.
await page.getByRole('button', { name: '扩展功能' }).click();
await sheet('扩展功能').getByRole('button', { name: '测试扩展功能' }).click();
await page.waitForTimeout(500);
check('extensions menu item works from the shell', await engineEval(w => w.__tltestMenu) === 1);

// A floating layer on the page shows over the shell and takes touches; the rest of the shell still does.
await page.waitForFunction(() => document.querySelector('iframe.engine')?.classList.contains('overlay'), null, { timeout: 15000 })
    .then(() => check('floating layer is laid over the shell', true)).catch(() => check('floating layer is laid over the shell', false));
const ball = await engineEval(w => {
    const r = w.document.getElementById('tltest-float')?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
});
const hit = ball && await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, ball);
check('the shell hands touches on the layer to it', hit === 'engine overlay', String(hit));
if (ball) await page.mouse.click(ball.x, ball.y);
await page.waitForTimeout(500);
check('tap on the floating layer reaches it', await engineEval(w => w.__tltestFloat) === 1);
const aa = page.getByRole('button', { name: '阅读设置' });
const aaBox = await aa.boundingBox();
await aa.click();
await sheet('阅读设置').waitFor({ timeout: 5000 })
    .then(() => check('the rest of the shell still takes touches', true)).catch(() => check('the rest of the shell still takes touches', false));
const pointer = await engineEval(w => w.__tltestPointer);
await closeSheet();
check('taps on the shell are passed on to the page', !!pointer && Math.abs(pointer[0] - (aaBox.x + aaBox.width / 2)) < 3, JSON.stringify(pointer));
const covered = await engineEval(w => getComputedStyle(w.document.getElementById('sheld')).visibility);
check('the rest of the full app stays hidden under the shell', covered === 'hidden', covered);
await page.getByRole('button', { name: '更多', exact: true }).click();
await page.getByRole('button', { name: /^打开原版界面/ }).click();
await page.waitForTimeout(500);
check('no overlay while the full app is shown', !(await page.locator('iframe.engine.overlay').count()) && await engineEval(w => getComputedStyle(w.document.getElementById('sheld')).visibility) === 'visible');
await page.getByRole('button', { name: '返回轻酒馆' }).click();
await page.waitForTimeout(500);
check('overlay comes back after returning', await page.locator('iframe.engine.overlay').count() === 1);

// Panel mirrors use the full app's text colour on its own backdrop (readable in any shell theme).
const mirrorColors = await page.evaluate(i => {
    const doc = document.querySelector(`.tl-message[data-index="${i}"] iframe.tl-panel-frame`)?.contentDocument;
    if (!doc) return null;
    return { text: getComputedStyle(doc.body).color, back: getComputedStyle(doc.getElementById('tl-panels')).backgroundColor };
}, lastIndex);
const engineText = await engineEval(w => getComputedStyle(w.document.body).color);
check('panel mirror uses the full app colours', !!mirrorColors && mirrorColors.text === engineText && mirrorColors.back !== 'rgba(0, 0, 0, 0)', JSON.stringify({ mirrorColors, engineText }));

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await cleanup();
console.log(JSON.stringify(results, null, 1));
await browser.close();
if (problems.length) {
    console.log(`FAILED: ${problems.join(', ')}`);
    process.exit(1);
}
console.log('ALL PASS');
