// Extensions' own panels: 高级设置 → 扩展的面板 lists what installed extensions add to the full app (a top-bar drawer,
// their blocks in the extensions panel), named as the extensions name them, and a tap opens the full app right there.
// A page embedded in a message offers to show that message in the full app.
// Run on an official SillyTavern with tavern-lite and Horae installed (Horae adds a top-bar drawer and a settings block).
// Usage: node e2e-extension-panels.mjs <baseUrl> <handle> <password> [shotPath]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, shotArg = ''] = process.argv.slice(2);
const shot = /.png$/.test(shotArg) ? shotArg : '';
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const AVATAR = 'default_Seraphina.png';
const run = Date.now().toString(36);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.message ?? e).slice(0, 200)));
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
process.on('uncaughtException', async error => {
    console.log('FAILURE', error.message.split('\n')[0]);
    await browser.close();
    process.exit(2);
});

const { token } = await (await context.request.get(`${base}/csrf-token`)).json();
if (!(await context.request.post(`${base}/api/users/login`, { headers: { 'X-CSRF-Token': token }, data: { handle, password } })).ok()) throw new Error('login failed');
const story = [{ user_name: 'unused', character_name: 'unused', chat_metadata: {} }];
for (let i = 0; i < 40; i++) {
    story.push({ name: i % 2 ? 'User' : 'Seraphina', is_user: i % 2 === 1, is_system: false, send_date: new Date().toISOString(), extra: {}, mes: `第 ${i} 段。`.repeat(i % 2 ? 1 : 12) });
}
story.push({ name: 'Seraphina', is_user: false, is_system: false, send_date: new Date().toISOString(), extra: {}, mes: `带嵌入页面的一条${run}` });
check('story fixture saved', (await context.request.post(`${base}/api/chats/save`, { headers: { 'X-CSRF-Token': token },
    data: { ch_name: 'Seraphina', file_name: `extp-${run}`, chat: story, avatar_url: AVATAR } })).ok());

const engineEval = (fn, arg) => page.evaluate(([source, value]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'value', `return (${source})(w, value);`)(w, value);
}, [fn.toString(), arg]);
const nativeShown = () => page.locator('iframe.engine.visible').waitFor({ timeout: 30000 });
const backToShell = async () => {
    await page.getByRole('button', { name: '返回轻酒馆' }).click();
    await page.locator('iframe.engine.visible').waitFor({ state: 'detached', timeout: 15000 }).catch(() => { });
    await page.waitForTimeout(500);
};
const dialog = name => page.getByRole('dialog', { name });

// --- An embedded page in a message -----------------------------------------------------------------------------
await page.goto(appUrl);
await page.locator('.tl-continue-primary').click();
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const last = await engineEval(w => {
    const mes = [...w.document.querySelectorAll('#chat .mes')].at(-1);
    const frame = w.document.createElement('iframe');
    frame.srcdoc = '<p>embedded</p>';
    mes.querySelector('.mes_text').append(frame);
    const c = w.SillyTavern.getContext();
    c.eventSource.emit(c.eventTypes.MESSAGE_UPDATED, Number(mes.getAttribute('mesid')));
    return Number(mes.getAttribute('mesid'));
});
const jump = page.locator('.tl-message').last().getByRole('button', { name: /在原版里看这条/ });
await jump.waitFor({ timeout: 15000 });
check('an embedded page shows a button instead of the old hint', !(await page.locator('.tl-message').last().innerText()).includes('点右上角'));
await engineEval(w => { w.document.getElementById('chat').scrollTop = 0; });
await jump.click();
await nativeShown();
await page.waitForTimeout(800);
const inView = await engineEval((w, index) => {
    const chat = w.document.getElementById('chat').getBoundingClientRect();
    const rect = w.document.querySelector(`#chat .mes[mesid="${index}"]`).getBoundingClientRect();
    return rect.bottom > chat.top && rect.top < chat.bottom;
}, last);
check('the tap shows that message in the full app', inView);
await backToShell();

// --- 高级设置 → 扩展的面板 ---------------------------------------------------------------------------------------
await page.evaluate(() => { location.hash = '#me'; });
const openList = async () => {
    await page.getByRole('button', { name: /^设置与扩展/ }).click();
    const entry = dialog('设置与扩展').getByRole('button', { name: /^扩展的面板/ });
    await entry.waitFor();
    return entry;
};
const entry = await openList();
const entryText = await entry.innerText();
check('高级设置 offers 扩展的面板 with a count', /\d+ 个/.test(entryText) && await entry.isEnabled(), entryText);
await entry.click();
const list = dialog('扩展的面板');
await list.waitFor();
const text = await list.innerText();
if (shot) { await page.waitForTimeout(800); await page.screenshot({ path: shot }); }
const items = await list.locator('.tl-sheet-item-label').allInnerTexts();
check('Horae’s top-bar drawer is listed by its own name', /顶栏面板\s*Horae Memory/.test(text), items.join(' | '));
check('extension settings blocks are listed', items.includes('Regex') && items.filter(t => t === 'Horae Memory').length === 2, items.join(' | '));
check('the full app’s own panels are not listed', !items.some(t => /AI Response|API Connections|World Info|User Settings|Character Management|Persona Management|^Extensions$/.test(t)), items.join(' | '));
check('help links are left out of names', !items.some(t => /\?$/.test(t)), items.join(' | '));
check('every item says it opens in the full app', (await list.locator('.tl-sheet-item-hint').allInnerTexts()).every(t => t === '在原版界面打开'));

await list.getByRole('button', { name: '关闭' }).click();
check('closing the list goes back to 高级设置', await dialog('设置与扩展').isVisible());
await dialog('设置与扩展').getByRole('button', { name: /^扩展的面板/ }).click();

// A top-bar drawer.
await list.getByRole('button', { name: /^Horae Memory/ }).first().click();
await nativeShown();
await page.waitForTimeout(600);
check('Horae’s drawer opens in the full app', await engineEval(w => !!w.document.querySelector('#horae_drawer .drawer-content.openDrawer')));
await backToShell();

// A settings block: the extensions panel opens with that block unfolded and in view.
for (const [name, selector] of [['Regex', '#regex_container'], ['Horae Memory', '#horae-ext-settings']]) {
    await (await openList()).click();
    const target = name === 'Horae Memory' ? list.getByRole('button', { name: /^Horae Memory/ }).last() : list.getByRole('button', { name: new RegExp(`^${name}`) });
    await target.click();
    await nativeShown();
    await page.waitForTimeout(1200);
    const state = await engineEval((w, sel) => {
        const block = w.document.querySelector(sel);
        const drawer = block.matches('.inline-drawer') ? block : block.querySelector('.inline-drawer');
        const content = drawer.querySelector(':scope > .inline-drawer-content');
        const panel = w.document.querySelector('#rm_extensions_block');
        const rect = drawer.getBoundingClientRect(), view = panel.getBoundingClientRect();
        return {
            open: !!w.document.querySelector('#extensions-settings-button .drawer-content.openDrawer'),
            unfolded: w.getComputedStyle(content).display !== 'none',
            inView: rect.top < view.bottom && rect.bottom > view.top,
        };
    }, selector);
    check(`${name} settings open unfolded and in view`, state.open && state.unfolded && state.inView, JSON.stringify(state));
    await backToShell();
}

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(failed ? `PROBLEMS ${failed}` : 'ALL PASS');
await browser.close();
process.exit(failed ? 1 : 0);
