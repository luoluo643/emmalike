// On a phone: Tavern Helper's 变量管理器 (✨ menu, 扩展功能 in the shell) opens its window into #movingDivs, not body;
// the shell must still offer to show it, also when it was left open by an earlier tap. The shelf's 继续阅读 cards
// have a ⋯ with rename and delete, and a long press opens the same menu.
// Run on an official SillyTavern with tavern-lite and Tavern Helper (prepare.sh installs 4.11.2).
// Usage: node e2e-varmgr-story-menu.mjs <baseUrl> <handle> <password> [shotPath]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, shotArg = ''] = process.argv.slice(2);
const shot = /.png$/.test(shotArg) ? shotArg : '';
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const AVATAR = 'default_Seraphina.png';
const run = Date.now().toString(36);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
// The app (and Tavern Helper through it) tells a phone by its user agent.
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.message ?? e).slice(0, 200)));
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
let crashed = false;
process.on('uncaughtException', async error => {
    if (crashed) return;
    crashed = true;
    console.log('FAILURE', error.message.split('\n')[0]);
    await browser.close().catch(() => { });
    process.exit(2);
});

const { token } = await (await context.request.get(`${base}/csrf-token`)).json();
if (!(await context.request.post(`${base}/api/users/login`, { headers: { 'X-CSRF-Token': token }, data: { handle, password } })).ok()) throw new Error('login failed');
const saveStory = (file, text) => {
    const story = [{ user_name: 'unused', character_name: 'unused', chat_metadata: {} }];
    for (let i = 0; i < 6; i++) {
        story.push({ name: i % 2 ? 'User' : 'Seraphina', is_user: i % 2 === 1, is_system: false, send_date: new Date().toISOString(), extra: {}, mes: `${text} 第 ${i} 段。` });
    }
    return context.request.post(`${base}/api/chats/save`, { headers: { 'X-CSRF-Token': token }, data: { ch_name: 'Seraphina', file_name: file, chat: story, avatar_url: AVATAR } });
};
const listStories = async () => (await (await context.request.post(`${base}/api/characters/chats`, { headers: { 'X-CSRF-Token': token }, data: { avatar_url: AVATAR } })).json())
    .map(c => String(c.file_name).replace(/\.jsonl$/, ''));
const older = `vm-old-${run}`;
const newer = `vm-new-${run}`;
check('older story saved', (await saveStory(older, '较早的故事')).ok());
await new Promise(r => setTimeout(r, 1100));
check('newer story saved', (await saveStory(newer, '最近的故事')).ok());

const engineEval = (fn, arg) => page.evaluate(([source, value]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'value', `return (${source})(w, value);`)(w, value);
}, [fn.toString(), arg]);
const bar = page.locator('.tl-popup-bar').filter({ hasText: '原版界面里打开了一个窗口' });

// --- 变量管理器 from 扩展功能 -------------------------------------------------------------------------------------
await page.goto(appUrl);
await page.locator('.tl-continue-primary').click();
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const openVariableManager = async () => {
    await page.getByRole('button', { name: '扩展功能' }).click();
    const sheet = page.getByRole('dialog', { name: '扩展功能' });
    await sheet.waitFor();
    const item = sheet.getByRole('button', { name: '变量管理器' });
    check('扩展功能 lists 变量管理器', await item.count() === 1, (await sheet.locator('.tl-sheet-item-label').allInnerTexts()).join(' | '));
    await item.click();
};
await openVariableManager();
await bar.waitFor({ timeout: 5000 }).catch(() => { });
check('tapping 变量管理器 offers to show its window', await bar.isVisible());
const where = await engineEval(w => {
    const moving = w.document.getElementById('movingDivs');
    const open = [...(moving?.children ?? [])].filter(el => el.getClientRects().length > 0);
    return { inMoving: open.length, text: open.map(el => el.textContent.trim().slice(0, 40)).join(' | ') };
});
check('Tavern Helper put the window into #movingDivs (the phone layout)', where.inMoving > 0 && where.text.includes('变量管理器'), JSON.stringify(where));
await bar.getByRole('button', { name: '去看看' }).click();
await page.locator('iframe.engine.visible').waitFor({ timeout: 15000 });
await page.waitForTimeout(600);
const seen = await engineEval(w => {
    const el = [...w.document.getElementById('movingDivs').children].find(e => e.textContent.includes('变量管理器'));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), vis: w.getComputedStyle(el).visibility };
});
check('去看看 shows the variable manager in the full app', !!seen && seen.w > 100 && seen.h > 100 && seen.vis !== 'hidden', JSON.stringify(seen));
if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-varmgr.png') });

// Back without closing it: the next tap still has an answer (it was already open, so nothing new appears).
await page.getByRole('button', { name: '返回轻酒馆' }).click();
await page.locator('iframe.engine.visible').waitFor({ state: 'detached', timeout: 15000 }).catch(() => { });
await page.waitForTimeout(500);
if (await bar.isVisible()) await bar.getByRole('button', { name: '关闭提示' }).click();
await openVariableManager();
await bar.waitFor({ timeout: 5000 }).catch(() => { });
check('tapping it again while it is still open offers it again', await bar.isVisible());
if (await bar.isVisible()) await bar.getByRole('button', { name: '关闭提示' }).click();
// Close it in the full app so it does not stay over later runs.
await engineEval(w => {
    const el = [...w.document.getElementById('movingDivs').children].find(e => e.textContent.includes('变量管理器'));
    el?.querySelector('[class*="close"], .fa-xmark, button[title*="关闭"]')?.click();
});

// --- The shelf's story menu ----------------------------------------------------------------------------------------
await page.evaluate(() => { location.hash = ''; });
await page.locator('.tl-continue-primary').waitFor();
await page.waitForTimeout(800);
const primaryStory = await page.locator('.tl-continue-primary .tl-card-story').innerText();
check('the newest story is on the big card', primaryStory.includes(newer), primaryStory);
const menuButton = page.locator('.tl-continue-item').first().locator('.tl-continue-menu');
check('the big card has a ⋯', await menuButton.isVisible());
const box = await menuButton.boundingBox();
const card = await page.locator('.tl-continue-primary').boundingBox();
check('the ⋯ sits inside the big card, 44px', !!box && box.x + box.width <= card.x + card.width + 1 && box.y >= card.y - 1 && box.width >= 44 && box.height >= 44, JSON.stringify({ box, card }));
check('the shelf has no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await menuButton.click();
const menu = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: /^删除/ }) });
await menu.waitFor({ timeout: 10000 });
const labels = await menu.locator('.tl-sheet-item-label').allInnerTexts();
check('the menu offers open, rename and delete', ['打开', '起名', '删除'].every(t => labels.includes(t)), labels.join(' | '));
if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-menu.png') });
await menu.getByRole('button', { name: /^删除/ }).click();
const confirm = page.getByRole('dialog', { name: /^删除「/ });
await confirm.waitFor();
check('delete asks first, naming the story', (await confirm.innerText()).includes(newer));
await confirm.getByRole('button', { name: '删除', exact: true }).click();
await page.locator('.tl-toast, [role="status"]').filter({ hasText: '故事已删除' }).first().waitFor({ timeout: 30000 }).catch(() => { });
await page.waitForTimeout(800);
const left = await listStories();
check('the story is deleted on the server', !left.includes(newer) && left.includes(older), left.filter(f => f.startsWith('vm-')).join(', '));
const after = await page.locator('.tl-continue-primary .tl-card-story').innerText().catch(() => '');
check('the shelf now continues the other story', !after.includes(newer), after);

// Long press on a compact card (or the big one) opens the same menu; Esc / close leaves everything as it was.
await page.locator('.tl-continue-primary').dispatchEvent('pointerdown', { button: 0, clientX: 100, clientY: 100 });
await page.waitForTimeout(700);
await page.locator('.tl-continue-primary').dispatchEvent('pointerup');
const pressed = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: /^删除/ }) });
check('a long press opens the story menu', await pressed.isVisible());
check('a long press does not open the story', await page.evaluate(() => !location.hash.includes('chat')));
await pressed.getByRole('button', { name: '关闭' }).click().catch(() => { });

// Clean up the remaining fixture.
await context.request.post(`${base}/api/chats/delete`, { headers: { 'X-CSRF-Token': token }, data: { chatfile: `${older}.jsonl`, avatar_url: AVATAR } });
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
console.log(failed ? `FAILURE ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
