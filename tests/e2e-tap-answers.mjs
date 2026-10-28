// Every tap the shell passes on to the full app gets an answer in the shell, on a phone:
// - with a floating layer up (the overlay hides the app's page, as a Live2D figure does), Tavern Helper's windows and
//   the gallery still bring up the "打开了一个窗口" bar;
// - Generate Image only shows a menu that was already on the page, and that counts too; 去看看 shows it on screen;
// - Translate Chat answers with the app's own "queued" toast (info toasts are passed on right after a tap);
// - the story's ⋯ menu renames and deletes the story being read.
// Run on an official SillyTavern with tavern-lite and Tavern Helper (prepare.sh installs 4.11.2).
// Usage: node e2e-tap-answers.mjs <baseUrl> <handle> <password> [shotPath]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, shotArg = ''] = process.argv.slice(2);
const shot = /.png$/.test(shotArg) ? shotArg : '';
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const AVATAR = 'default_Seraphina.png';
const run = Date.now().toString(36);
// Longer than the bridge's TAP_ANSWER_MS.
const TAP_WAIT_MS = 4500;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
// The app (and Tavern Helper through it) tells a phone by its user agent.
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
const page = await context.newPage();
const pageErrors = [];
let step = 'start';
page.on('pageerror', e => pageErrors.push(`[${step}] ${String(e.message ?? e).slice(0, 200)} @ ${String(e.stack ?? '').split('\n').slice(1, 4).join(' < ').slice(0, 300)}`));
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
    for (let i = 0; i < 4; i++) {
        story.push({ name: i % 2 ? 'User' : 'Seraphina', is_user: i % 2 === 1, is_system: false, send_date: new Date().toISOString(), extra: {}, mes: `${text} 第 ${i} 段。` });
    }
    return context.request.post(`${base}/api/chats/save`, { headers: { 'X-CSRF-Token': token }, data: { ch_name: 'Seraphina', file_name: file, chat: story, avatar_url: AVATAR } });
};
const listStories = async () => (await (await context.request.post(`${base}/api/characters/chats`, { headers: { 'X-CSRF-Token': token }, data: { avatar_url: AVATAR } })).json())
    .map(c => String(c.file_name).replace(/\.jsonl$/, ''));
const main = `tap-main-${run}`;
const other = `tap-other-${run}`;
check('stories saved', (await saveStory(other, '另一个')).ok() && (await saveStory(main, '主要')).ok());

const engineEval = (fn, arg) => page.evaluate(([source, value]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'value', `return (${source})(w, value);`)(w, value);
}, [fn.toString(), arg]);
const bar = page.locator('.tl-popup-bar').filter({ hasText: '原版界面里打开了一个窗口' });
const openStory = async (file, overlay = false) => {
    step = `open ${file}${overlay ? ' overlay' : ''}`;
    await page.goto('about:blank');
    await page.goto(`${appUrl}#chat=${encodeURIComponent(AVATAR)}&file=${encodeURIComponent(file)}`);
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    await page.waitForTimeout(1000);
    if (overlay) {
        await engineEval(w => {
            const el = w.document.createElement('div');
            el.id = 'test-float';
            el.style.cssText = 'position:fixed;right:8px;bottom:120px;width:60px;height:60px;background:#f80;z-index:9999';
            w.document.body.append(el);
        });
        await page.locator('iframe.engine.overlay').waitFor({ timeout: 10000 });
    }
};
const tapMenu = async label => {
    step = `tap ${label}`;
    await page.getByRole('button', { name: '扩展功能' }).click();
    await page.getByRole('dialog', { name: '扩展功能' }).getByRole('button', { name: label, exact: true }).click();
};
const answered = async () => {
    await bar.waitFor({ timeout: 5000 }).catch(() => { });
    return bar.isVisible();
};

// --- With a floating layer up ------------------------------------------------------------------------------------
for (const label of ['变量管理器', '提示词查看器', 'Show Gallery']) {
    await openStory(main, true);
    await tapMenu(label);
    check(`with a floating layer: ${label} offers to show its window`, await answered());
}
await bar.getByRole('button', { name: '去看看' }).click();
await page.locator('iframe.engine.visible').waitFor({ timeout: 15000 });
check('去看看 turns the overlay off', await page.locator('iframe.engine.overlay').count() === 0);

// --- Generate Image: a menu already on the page, only shown --------------------------------------------------------
await openStory(main);
await tapMenu('Generate Image');
check('Generate Image offers to show its menu', await answered());
await bar.getByRole('button', { name: '去看看' }).click();
await page.locator('iframe.engine.visible').waitFor({ timeout: 15000 });
await page.waitForTimeout(600);
const menu = await engineEval(w => {
    const el = w.document.getElementById('sd_dropdown');
    const r = el.getBoundingClientRect();
    return { shown: w.getComputedStyle(el).display !== 'none', x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), vw: w.innerWidth, vh: w.innerHeight };
});
if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-sd.png') });
check('the image menu is on screen in the full app', menu.shown && menu.w > 50 && menu.h > 50 && menu.x >= 0 && menu.y >= 0 && menu.x + menu.w <= menu.vw + 1 && menu.y + menu.h <= menu.vh + 1, JSON.stringify(menu));

// --- Translate Chat: its own "queued" toast ------------------------------------------------------------------------
await openStory(main);
await tapMenu('Translate Chat');
const toast = page.locator('.tl-toast').filter({ hasText: /queued|排队/ });
await toast.first().waitFor({ timeout: 4000 }).catch(() => { });
check('Translate Chat answers with the app’s toast', await toast.count() > 0, (await page.locator('.tl-toast').allInnerTexts()).join(' / '));
// Info toasts without a tap before them stay in the full app.
await page.waitForTimeout(TAP_WAIT_MS);
await engineEval(w => w.toastr.info('无关的提示', '测试'));
await page.waitForTimeout(800);
check('info toasts long after a tap are not passed on', !(await page.locator('.tl-toast').allInnerTexts()).some(t => t.includes('无关的提示')));

// --- The story's ⋯: rename and delete the story being read --------------------------------------------------------
await openStory(main);
const storyMenu = async () => {
    await page.locator('header').getByRole('button', { name: '更多' }).click();
    const sheet = page.getByRole('dialog').filter({ hasText: '这个故事' });
    await sheet.waitFor();
    return sheet;
};
let sheet = await storyMenu();
const items = await sheet.locator('.tl-sheet-item-label').allInnerTexts();
check('the story menu offers rename and delete', items.includes('给这个故事起名') && items.includes('删除这个故事'), items.join(' | '));
if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-story.png') });
step = 'rename';
await sheet.getByRole('button', { name: /^给这个故事起名/ }).click();
const prompt = page.getByRole('dialog', { name: '给故事起名' });
await prompt.waitFor();
const renamed = `tap-renamed-${run}`;
await prompt.locator('input').fill(renamed);
await prompt.getByRole('button', { name: '保存' }).click();
await page.waitForFunction(name => decodeURIComponent(location.hash).includes(name), renamed, { timeout: 30000 }).catch(() => { });
let files = await listStories();
check('rename: the server has the new name', files.includes(renamed) && !files.includes(main), files.filter(f => f.includes(run)).join(', '));
check('rename: the reader stays on the renamed story', decodeURIComponent(await page.evaluate(() => location.hash)).includes(renamed));
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 60000 });

sheet = await storyMenu();
step = 'delete';
await sheet.getByRole('button', { name: /^删除这个故事/ }).click();
const confirm = page.getByRole('dialog', { name: /^删除「/ });
await confirm.waitFor();
check('delete asks first, naming the story', (await confirm.innerText()).includes(renamed));
await confirm.getByRole('button', { name: '删除', exact: true }).click();
await page.waitForFunction(name => !decodeURIComponent(location.hash).includes(name), renamed, { timeout: 30000 }).catch(() => { });
files = await listStories();
check('delete: the story is gone from the server', !files.includes(renamed) && files.includes(other), files.filter(f => f.includes(run)).join(', '));
const hash = decodeURIComponent(await page.evaluate(() => location.hash));
check('delete: the reader moves to another story of the character', hash.includes(`chat=${AVATAR}`) && !hash.includes(renamed), hash);

await context.request.post(`${base}/api/chats/delete`, { headers: { 'X-CSRF-Token': token }, data: { chatfile: `${other}.jsonl`, avatar_url: AVATAR } });
// Tavern Helper's prompt viewer runs a dry generation and stops it, and the app reports that abort as an error.
const ours = pageErrors.filter(e => !(/signal is aborted/.test(e) && /stopGeneration/.test(e) && /JS-Slash-Runner/.test(e)));
check('no page errors (besides the prompt viewer’s own stop)', ours.length === 0, ours.join(' | '));
await browser.close();
console.log(failed ? `FAILURE ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
