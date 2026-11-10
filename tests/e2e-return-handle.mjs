// The way back from the full app on a phone: a faded tab on the screen's edge that a tap takes back and a drag moves
// (to the other edge too), remembered on this device; a drag never counts as a tap and never scrolls the full app.
// Usage: node e2e-return-handle.mjs <baseUrl> <handle> <password>   (SHOTS=<folder> keeps screenshots)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const SHOTS = process.env.SHOTS ?? '';
const results = {};
const problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`; if (!ok) problems.push(name); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
let avatar = '';
const finish = async code => {
    console.log(JSON.stringify({ results, pageErrors: pageErrors.slice(0, 12) }, null, 1));
    if (avatar) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
    await browser.close();
    console.log(problems.length ? `PROBLEMS ${problems.length}` : 'ALL PASS');
    process.exit(code);
};
process.on('uncaughtException', async error => {
    console.log('FAILURE', error.message.split('\n')[0], (error.stack ?? '').split('\n').find(l => l.includes('e2e-return-handle')));
    await finish(2);
});
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const long = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 段：窗外的灯一盏一盏亮起来，街上很安静，只有檐下的水声。`).join('\n\n');
const created = await page.request.post(`${base}/api/characters/create`, {
    headers: { 'X-CSRF-Token': token },
    multipart: {
        ch_name: `把手${Date.now().toString(36)}`, description: '测试', first_mes: long, personality: '', scenario: '', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '', alternate_greetings: '另一种开场',
    },
});
avatar = (await created.text()).trim();
if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);
const shot = async name => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }).catch(() => { }); };
const tab = page.getByRole('button', { name: '返回轻酒馆', exact: true });
const nativeShown = () => page.evaluate(() => !!document.querySelector('.tl-return'));
const state = () => page.evaluate(() => {
    const b = document.querySelector('.tl-return');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return {
        x: r.x, y: r.y, w: r.width, h: r.height, right: innerWidth - r.right, cls: b.className, opacity: Number(getComputedStyle(b).opacity),
        saved: localStorage.getItem('tavern-lite:return-handle'),
    };
});
const chatScroll = () => page.evaluate(() => document.querySelector('iframe.engine').contentDocument.querySelector('#chat')?.scrollTop ?? -1);
const openNative = async () => {
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await page.getByRole('button', { name: /^打开原版界面/ }).click();
    await tab.waitFor({ timeout: 30000 });
};
const cdp = await context.newCDPSession(page);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
const touchDrag = async (from, to, steps = 12) => {
    await touch('touchStart', from.x, from.y);
    for (let i = 1; i <= steps; i++) {
        await touch('touchMove', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
        await page.waitForTimeout(16);
    }
    await touch('touchEnd');
};

await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: '' })}`);
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
await page.evaluate(() => localStorage.removeItem('tavern-lite:return-handle'));
await openNative();
await page.waitForTimeout(400);
const fresh = await state();
await shot('1-just-opened');
check('opens in full, small, on the right edge', fresh.opacity > 0.9 && fresh.w <= 28 && fresh.h <= 54 && fresh.right <= 1 && /is-right/.test(fresh.cls), JSON.stringify(fresh));
await page.waitForTimeout(2800);
const idle = await state();
await shot('2-idle');
check('fades when left alone', Math.abs(idle.opacity - 0.5) < 0.05, JSON.stringify(idle));
check('clear of the top bar and the send row', idle.y >= 56 && idle.y + idle.h <= 844 - 110, JSON.stringify(idle));

// Touch drag up and over to the left edge: moves, is kept, does not go back, does not scroll the full app.
await page.evaluate(() => { const c = document.querySelector('iframe.engine').contentDocument.querySelector('#chat'); if (c) c.scrollTop = 400; });
const scrollBefore = await chatScroll();
await touchDrag({ x: idle.x + idle.w / 2, y: idle.y + idle.h / 2 }, { x: 30, y: 200 });
await page.waitForTimeout(500);
const left = await state();
await shot('3-dragged-left');
check('a touch drag does not go back', left !== null, 'native closed');
check('dropped on the left half, it sits on the left edge', !!left && /is-left/.test(left.cls) && left.x <= 1, JSON.stringify(left));
check('it stays where it was dropped (height)', !!left && Math.abs(left.y + left.h / 2 - 200) <= 3, JSON.stringify(left));
check('the place is kept on this device', !!left && JSON.parse(left.saved || '{}').side === 'left', String(left?.saved));
const scrollAfter = await chatScroll();
check('dragging did not scroll the full app', scrollAfter === scrollBefore, `${scrollBefore} -> ${scrollAfter}`);

// A drag can't take it under the top bar.
await touchDrag({ x: 13, y: 200 }, { x: 13, y: 0 });
await page.waitForTimeout(400);
const high = await state();
check('kept below the top bar', !!high && high.y >= 56, JSON.stringify(high));

// Mouse drag back to the right edge and down.
await page.mouse.move(13, high.y + 26);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(13 + 34 * i, high.y + 26 + 30 * i);
await page.mouse.up();
await page.waitForTimeout(400);
const right = await state();
check('a mouse drag works too and does not go back', !!right && /is-right/.test(right.cls) && right.right <= 1, JSON.stringify(right));

// A tap goes back.
await tab.tap();
await page.waitForTimeout(800);
check('a tap goes back to tavern-lite', !(await nativeShown()), 'still in the full app');

// Next time it opens where it was left; turning the phone keeps it on screen.
await openNative();
await page.waitForTimeout(400);
const again = await state();
check('opens where it was left last time', !!again && /is-right/.test(again.cls) && Math.abs(again.y - right.y) <= 2, JSON.stringify({ again, right }));
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(500);
const turned = await state();
await shot('4-landscape');
check('after turning the phone it is still on screen and clear of both bars', !!turned && turned.y >= 56 && turned.y + turned.h <= 390 - 110 + 1 && turned.right <= 1, JSON.stringify(turned));
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
await tab.focus();
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
check('Enter on the focused tab goes back', !(await nativeShown()), 'still in the full app');

await finish(problems.length ? 1 : 0);
