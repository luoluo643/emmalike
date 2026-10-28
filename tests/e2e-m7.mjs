// 0.8.1 acceptance (fixes from the 2026-10-11 walkthrough): a story ending with the user's words can get a reply
// (after a stopped or failed generation), the phone's back gesture closes sheets and the full app's view instead of
// leaving the page, a reader at the end stays there when panels load, persona switching and locking, passages can
// be selected, the work page shows the small cover (full art on a tap), sheet section titles line up, no notice
// about connecting the model, and times in Chinese.
// Needs the fixture extension (tests/prepare.sh) for the panels under messages.
// Usage: node e2e-m7.mjs <baseUrl> <handle> <password> [latencyMs] [downKbps]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, latency = '200', downKbps = '5000'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `M7测试${run}`;
const PERSONA = `tltest-${run}.png`;
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
let originalPersona = null;

const engineEval = (fn, arg) => page.evaluate(([source, a]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'a', `return (${source})(w, a);`)(w, a);
}, [fn.toString(), arg]);

const cleanup = async () => {
    if (originalPersona !== null) {
        await engineEval(async (w, a) => {
            await w.TavernLiteBridge.setPersona(a.original, { lock: false }).catch(() => { });
            const p = w.SillyTavern.getContext().powerUserSettings;
            delete p.personas[a.test];
            delete p.persona_descriptions[a.test];
            w.SillyTavern.getContext().saveSettingsDebounced();
        }, { original: originalPersona, test: PERSONA }).catch(() => { });
        await page.waitForTimeout(1500);
    }
    if (avatar) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
};

let failing = false;
process.on('uncaughtException', async error => {
    // An error while reporting or cleaning up must not start the report again.
    if (failing) process.exit(3);
    failing = true;
    console.log('FAILURE', error.message.split('\n').slice(0, 12).join(' | '), (error.stack ?? '').split('\n').find(l => l.includes('e2e-m7.mjs')));
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
        ch_name: NAME, description: '测试 0.8.1 的角色', first_mes: '“你来了。”', personality: '', scenario: '', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '',
    },
});
avatar = (await created.text()).trim();
if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);

const synced = () => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const idle = () => page.waitForFunction(() => !document.querySelector('.tl-stop') && !document.querySelector('[data-pending="true"]'), null, { timeout: 120000 });
const sheet = title => page.getByRole('dialog', { name: title });
const closeSheet = async () => { await page.getByRole('dialog').last().getByRole('button', { name: '关闭' }).click(); await page.waitForTimeout(300); };
const layerMarked = () => page.evaluate(() => !!history.state?.tlLayer);
const gapToEnd = () => page.evaluate(() => { const l = document.querySelector('.tl-messages'); return l.scrollHeight - l.scrollTop - l.clientHeight; });

// Arrive from the library, as a reader would, so "back" has a page to return to.
await page.goto(appUrl);
await page.locator('.tl-library').waitFor({ timeout: 60000 });
await page.evaluate(a => { location.hash = new URLSearchParams({ chat: a, file: '' }).toString(); }, avatar);
await synced();
const chatHash = await page.evaluate(() => location.hash);

// The first send connects the model without a notice over the header.
await page.locator('.tl-composer-input').fill(`你好${run}`);
await page.getByRole('button', { name: '发送' }).click();
await idle();
await page.locator('.tl-message[data-role="char"]').last().locator('.tl-message-body', { hasText: '模拟回复' }).waitFor({ timeout: 60000 });
check('no notice about connecting the model', !(await page.evaluate(() => window.__tlToasts)).some(t => t.includes('正在连接')),
    JSON.stringify(await page.evaluate(() => window.__tlToasts)));

// Times are written in Chinese.
const meta = await page.locator('.tl-message[data-role="char"]').last().locator('.tl-message-meta').innerText().catch(() => '');
check('message time in Chinese', /\d{1,2}月\d{1,2}日 \d{2}:\d{2}/.test(meta), meta);
check('mostly-Chinese reply may break inside Latin words', await page.locator('.tl-message[data-role="char"]').last().locator('.tl-message-body[data-cjk="true"]').count() === 1);

// A story that ends with the user's words (a stopped or failed generation) can ask for a reply.
await engineEval(async w => { await w.SillyTavern.getContext().deleteLastMessage(); });
await page.waitForFunction(() => document.querySelector('.tl-message:last-of-type')?.dataset.role === 'user', null, { timeout: 30000 });
const replyInline = page.locator('.tl-message[data-role="user"]').last().getByRole('button', { name: `让${NAME}回复` });
check('reply button under the user\'s last words', await replyInline.isVisible().catch(() => false));
const sendAsReply = page.locator('.tl-send');
check('empty send button asks for a reply', (await sendAsReply.getAttribute('aria-label')) === `让${NAME}回复` && await sendAsReply.isEnabled());
await page.getByRole('button', { name: '扩展功能' }).click();
check('+ holds only extension features', await sheet('扩展功能').getByRole('button', { name: /^(开始新故事|重新生成|继续写|让角色回复)/ }).count() === 0);
await closeSheet();
await replyInline.click();
await idle();
await page.waitForFunction(() => {
    const last = [...document.querySelectorAll('.tl-message')].pop();
    return last?.dataset.role === 'char' && last.textContent.includes('模拟回复');
}, null, { timeout: 60000 }).then(() => check('reply arrives after asking', true)).catch(() => check('reply arrives after asking', false));

// The phone's back gesture closes a sheet and stays on the story; closing it on screen leaves no extra entry.
await page.getByRole('button', { name: '更多', exact: true }).click();
await sheet(NAME).waitFor();
await page.waitForTimeout(300);
await page.goBack();
await page.waitForTimeout(800);
check('back closes the sheet', await page.getByRole('dialog').count() === 0);
check('back with a sheet open stays on the story', await page.evaluate(() => location.hash) === chatHash && await page.locator('.tl-chat').count() === 1);
await page.getByRole('button', { name: '更多', exact: true }).click();
await page.waitForTimeout(300);
check('an open sheet holds one history entry', await layerMarked());
await closeSheet();
await page.waitForTimeout(500);
check('closing a sheet on screen removes its entry', !(await layerMarked()));

// Back also leaves the full app's view first.
await page.getByRole('button', { name: '更多', exact: true }).click();
await page.getByRole('button', { name: /^打开原版界面/ }).click();
await page.locator('iframe.engine.visible').waitFor({ timeout: 30000 });
await page.waitForTimeout(300);
await page.goBack();
await page.waitForFunction(() => !document.querySelector('iframe.engine.visible'), null, { timeout: 10000 })
    .then(() => check('back leaves the full app view', true)).catch(() => check('back leaves the full app view', false));
check('…and stays on the story', await page.evaluate(() => location.hash) === chatHash);

// Selecting part of a message.
await page.locator('.tl-message[data-role="char"]').last().locator('.tl-message-menu').click();
await sheet('消息操作').getByRole('button', { name: /^更多/ }).click();
await sheet('更多').getByRole('button', { name: /^选择文字/ }).click();
const selectable = sheet('选择文字').locator('.tl-select-text');
check('select-text sheet shows the message selectable', (await selectable.innerText()).includes('模拟回复')
    && await selectable.evaluate(e => getComputedStyle(e).userSelect !== 'none'));
await closeSheet();

// Section titles in sheets line up with the items.
await page.locator('.tl-message[data-role="char"]').last().locator('.tl-message-menu').click();
await sheet('消息操作').getByRole('button', { name: /^更多/ }).click();
await sheet('更多').getByText('原版界面里的其他按钮').waitFor({ timeout: 30000 });
const offsets = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="更多"]');
    const section = dialog.querySelector('.tl-sheet-section').getBoundingClientRect().left;
    const label = dialog.querySelector('.tl-sheet-item .tl-sheet-item-label').getBoundingClientRect().left;
    return [section, label];
});
check('sheet section title lines up with the items', Math.abs(offsets[0] - offsets[1]) < 3, JSON.stringify(offsets));
await closeSheet();

// Persona: pick another one, then fix it to this story.
originalPersona = await engineEval((w, a) => {
    const c = w.SillyTavern.getContext();
    c.powerUserSettings.personas[a.id] = a.name;
    c.powerUserSettings.persona_descriptions[a.id] = { description: '测试用身份', position: 0, depth: 2, role: 0, lorebook: '', connections: [], title: '' };
    return w.TavernLiteBridge.personaList().current;
}, { id: PERSONA, name: `测试身份${run}` });
await page.getByRole('button', { name: '更多', exact: true }).click();
await sheet(NAME).getByRole('button', { name: /^我的身份/ }).click();
await sheet('我的身份').getByRole('radio', { name: new RegExp(`测试身份${run}`) }).click();
await page.waitForFunction(r => window.__tlToasts.some(t => t.includes(`测试身份${r}`)), run, { timeout: 30000 }).catch(() => { });
check('persona switched in the full app', await engineEval((w, a) => w.SillyTavern.getContext().name1 === a, `测试身份${run}`));
const lockSwitch = sheet('我的身份').getByRole('switch');
const lockedBefore = (await lockSwitch.getAttribute('aria-checked')) === 'true';
await lockSwitch.click();
await page.waitForFunction(b => document.querySelector('.tl-switch-row')?.getAttribute('aria-checked') === String(!b), lockedBefore, { timeout: 30000 }).catch(() => { });
const lockedNow = await engineEval((w, a) => w.SillyTavern.getContext().chatMetadata?.persona === a, PERSONA);
check('lock switch fixes the persona to this story (and back)', lockedNow === !lockedBefore, `before ${lockedBefore}, now ${lockedNow}`);
await closeSheet();

// A reader at the end stays at the end when the panels under messages load.
await engineEval(async w => {
    const c = w.SillyTavern.getContext();
    for (let i = 0; i < 10; i++) {
        c.chat.push({ name: c.name1, is_user: true, mes: `填充${i}`, send_date: new Date().toISOString(), extra: {} });
        c.chat.push({ name: c.name2, is_user: false, mes: `第 ${i} 段回复，${'这是用来把页面撑长的文字。'.repeat(4)}`, send_date: new Date().toISOString(), extra: {} });
    }
    await c.saveChat();
});
await page.reload();
await synced();
await page.locator('.tl-panel-frame').last().waitFor({ timeout: 60000 }).catch(() => { });
await page.waitForTimeout(3000);
const gap = await gapToEnd();
check('opening a story lands at the end after panels load', gap < 8, `gap ${gap}px, panels ${await page.locator('.tl-panel-frame').count()}`);

// Work page: the small cover first, the full art on a tap; back closes it.
await page.evaluate(a => { location.hash = new URLSearchParams({ work: a }).toString(); }, avatar);
await page.locator('.tl-work-cover').waitFor({ timeout: 30000 });
check('work page cover is the small picture', (await page.locator('.tl-work-cover').getAttribute('src')).startsWith('/thumbnail'));
await page.getByRole('button', { name: '查看大图' }).click();
check('tap opens the full art', (await page.locator('.tl-lightbox img').getAttribute('src')).startsWith('/characters/'));
await page.waitForTimeout(300);
await page.goBack();
await page.waitForTimeout(800);
check('back closes the full art and stays on the work page', await page.locator('.tl-lightbox').count() === 0 && (await page.evaluate(() => location.hash)).startsWith('#work='));

await cleanup();
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `FAILED: ${problems.join(', ')}` : 'ALL PASS');
await browser.close();
process.exit(problems.length ? 1 : 0);
