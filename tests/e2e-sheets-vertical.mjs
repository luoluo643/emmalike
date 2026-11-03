// On a phone every menu only moves up and down: nothing inside a sheet is wider than the sheet, and a sideways swipe
// moves nothing, with long unbroken names and text on the smallest screen. Usage: node e2e-sheets-vertical.mjs <base> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const AVATAR = 'default_Seraphina.png';
const FILE = `vertical-${Date.now().toString(36)}`;
const LONG = 'Averyveryverylongunbrokenwordwithoutanyplacetobreakitinsideamenu'.repeat(2);

const results = {};
const problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`; if (!ok) problems.push(name); };
process.on('uncaughtException', error => {
    console.log(`FAILURE ${String(error?.message ?? error).split('\n')[0]}`);
    console.log(JSON.stringify(results, null, 1));
    process.exit(2);
});

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 200)));
const sheet = title => page.getByRole('dialog', { name: title });

const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
if (!(await page.request.post(`${base}/api/users/login`, { headers: { 'X-CSRF-Token': token }, data: { handle, password } })).ok()) throw new Error('login failed');
const now = new Date().toISOString();
const story = [{ user_name: 'unused', character_name: 'unused', chat_metadata: {} },
    { name: 'Seraphina', is_user: false, is_system: false, send_date: now, extra: {}, mes: `${LONG} 开场白` }];
for (let k = 1; k <= 4; k++) {
    story.push({ name: `读者${LONG}`, is_user: true, is_system: false, send_date: now, extra: {}, mes: `${LONG} 第${k}轮` });
    story.push({ name: 'Seraphina', is_user: false, is_system: false, send_date: now, extra: {}, mes: `回答${k} ${LONG}` });
}
check('story fixture saved', (await page.request.post(`${base}/api/chats/save`, { headers: { 'X-CSRF-Token': token }, data: { ch_name: 'Seraphina', file_name: FILE, chat: story, avatar_url: AVATAR } })).ok());

const cdp = await context.newCDPSession(page);
// A real sideways swipe over the open sheet. Each direction is judged on its own: there and back would cancel out.
const swipe = async (from, distance) => {
    const box = await page.getByRole('dialog').last().boundingBox();
    const y = Math.round(box.y + Math.min(box.height / 2, 200));
    const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await touch('touchStart', from);
    for (let i = 1; i <= 12; i++) {
        await touch('touchMove', from + distance * i / 12);
        await page.waitForTimeout(16);
    }
    // Held still before letting go, so nothing flings on: what moved is what the finger moved.
    await page.waitForTimeout(120);
    await touch('touchEnd');
    await page.waitForTimeout(200);
};
const facts = () => page.evaluate(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1);
    const moved = [dialog, ...dialog.querySelectorAll('*')].filter(el => el.scrollLeft !== 0).map(el => el.className || el.tagName);
    const width = dialog.getBoundingClientRect();
    const wide = [dialog, ...dialog.querySelectorAll('*')].filter(el => {
        const r = el.getBoundingClientRect();
        return r.width && (r.right > width.right + 1 || r.left < width.left - 1) && getComputedStyle(el).position !== 'fixed';
    }).map(el => `${el.tagName}.${el.className}`.slice(0, 60));
    const sideways = [dialog, ...dialog.querySelectorAll('*')].filter(el => {
        const x = getComputedStyle(el).overflowX;
        return (x === 'auto' || x === 'scroll') && el.scrollWidth > el.clientWidth + 1 && !el.closest('option');
    }).map(el => `${el.tagName}.${el.className}`.slice(0, 60));
    return { moved, wide: [...new Set(wide)].slice(0, 6), sideways: [...new Set(sideways)].slice(0, 6), page: document.documentElement.scrollWidth - document.documentElement.clientWidth, x: window.scrollX };
});
const verify = async name => {
    await page.getByRole('dialog').last().waitFor({ timeout: 30000 });
    const before = await facts();
    check(`${name}: nothing wider than the menu`, before.wide.length === 0 && before.page <= 0, JSON.stringify(before));
    check(`${name}: nothing scrolls sideways`, before.sideways.length === 0, JSON.stringify(before.sideways));
    await swipe(290, -220);
    const left = await facts();
    await swipe(30, 220);
    const right = await facts();
    check(`${name}: a sideways swipe moves nothing`, !left.moved.length && !right.moved.length && left.x === 0 && right.x === 0, JSON.stringify({ left: left.moved, right: right.moved }));
};

await page.goto(`${appUrl}#${new URLSearchParams({ chat: AVATAR, file: FILE })}`);
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });

const openMenu = async () => {
    await page.locator('.tl-messages').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.locator('.tl-message[data-role="char"]').last().locator('.tl-message-menu').click();
};
const closeAll = async () => {
    for (let i = 0; i < 4 && await page.getByRole('dialog').count(); i++) {
        await page.getByRole('dialog').last().getByRole('button', { name: '关闭' }).click();
        await page.waitForTimeout(300);
    }
};

await openMenu();
await verify('message menu');
await sheet('消息操作').getByRole('button', { name: /^更多/ }).click();
await verify('more menu');
await sheet('更多').getByRole('button', { name: /^选择文字/ }).click();
await verify('select text');
await closeAll();

await openMenu();
await sheet('消息操作').getByRole('button', { name: /^更多/ }).click();
await sheet('更多').getByRole('button', { name: /^从这条开始分享/ }).click();
await sheet('分享').getByRole('radio').first().waitFor({ timeout: 30000 });
await verify('share');
await sheet('分享').getByRole('radio', { name: /^自己选/ }).click();
await verify('share, choosing floors');
await sheet('分享').getByRole('radio', { name: /^只要我/ }).click();
await verify('share, one side');
await closeAll();

await page.getByRole('button', { name: '阅读设置' }).click();
await verify('reading settings');
// The size slider is dragged sideways, and still has to work with sideways panning off.
const slider = sheet('阅读设置').getByRole('slider', { name: '字号' });
await slider.scrollIntoViewIfNeeded();
const sizeBefore = await slider.inputValue();
const track = await slider.boundingBox();
const drag = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: track.y + track.height / 2 }] });
await drag('touchStart', track.x + track.width * 0.3);
for (let i = 1; i <= 8; i++) { await drag('touchMove', track.x + track.width * (0.3 + i * 0.06)); await page.waitForTimeout(16); }
await drag('touchEnd');
check('the size slider still drags', await slider.inputValue() !== sizeBefore, `${sizeBefore} -> ${await slider.inputValue()}`);
await sheet('阅读设置').getByRole('button', { name: '恢复默认' }).click();
await sheet('阅读设置').getByRole('button', { name: '更多排版' }).click();
await sheet('阅读设置').getByRole('button', { name: '填字体网址' }).click();
await verify('reading settings, all of it');
await closeAll();

// Everything else the reader's top bar opens.
const bar = await page.locator('.tl-reader-header button, header button').evaluateAll(els => els.map(e => e.getAttribute('aria-label') || e.textContent.trim()));
results['top bar buttons'] = JSON.stringify(bar).slice(0, 300);
for (const label of ['切换故事', '目录', '更多']) {
    const button = page.getByRole('button', { name: label, exact: true }).first();
    if (!await button.count()) continue;
    await button.click();
    if (await page.getByRole('dialog').count()) await verify(`top bar: ${label}`);
    await closeAll();
}

await page.request.post(`${base}/api/chats/delete`, { headers: { 'X-CSRF-Token': token }, data: { chatfile: `${FILE}.jsonl`, avatar_url: AVATAR } }).catch(() => { });
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(JSON.stringify(results, null, 1));
await browser.close();
console.log(problems.length ? `PROBLEMS ${problems.length}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
