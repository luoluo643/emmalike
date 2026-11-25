// The 故障终端 theme: picking it turns the shelf's top into its window and dresses the story page; stories open and
// return, replies send and arrive, searching hides the front, and going back to another theme takes it all off.
// Usage: node e2e-glitch.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAMES = [`终端甲${run}`, `终端乙${run}`, `终端丙${run}`];
const results = {};
const problems = [];
const check = (name, ok, detail = '') => { console.log(ok ? 'PASS' : 'FAIL', name, detail); results[name] = ok ? 'PASS' : `FAIL ${detail}`; if (!ok) problems.push(name); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
const pictures = [];
page.on('response', r => { if (/gt-[\w-]+\.webp$/.test(r.url())) pictures.push(r.status()); });
const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
const avatars = [];

const pickTheme = async name => {
    await page.locator('.tl-theme-entry').click();
    const picker = page.getByRole('dialog', { name: '换主题' });
    await picker.waitFor();
    await picker.getByRole('radio', { name }).first().click();
    await page.waitForTimeout(300);
    await picker.getByRole('button', { name: '使用' }).click();
    await picker.waitFor({ state: 'detached' });
};
const cleanup = async () => {
    for (const avatar of avatars) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
};

let failing = false;
process.on('uncaughtException', async error => {
    if (failing) process.exit(3);
    failing = true;
    console.log('FAILURE', error.message.split('\n').slice(0, 12).join(' | '), (error.stack ?? '').split('\n').find(l => l.includes('e2e-glitch.mjs')));
    console.log(JSON.stringify({ results, pageErrors }, null, 1));
    if (process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT }).catch(() => { });
    if (await page.locator('.tl-theme-entry').count()) await pickTheme('跟随系统').catch(() => { });
    await cleanup();
    await browser.close();
    process.exit(2);
});

if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
// Three characters, each with a story; the last one saved is the newest.
for (const [i, name] of NAMES.entries()) {
    const created = await page.request.post(`${base}/api/characters/create`, {
        headers: { 'X-CSRF-Token': token },
        multipart: {
            ch_name: name, description: '终端盒测试', first_mes: `“第${i}个开场白。”`, personality: '', scenario: '', mes_example: '',
            creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: i === 0 ? '日常' : '',
        },
    });
    const avatar = (await created.text()).trim();
    if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);
    avatars.push(avatar);
    const now = () => new Date().toISOString();
    const lines = [
        { name, is_user: false, mes: `“第${i}个开场白。”`, send_date: now(), extra: {} },
        { name: 'User', is_user: true, mes: '你好', send_date: now(), extra: {} },
        // The first character's last reply has a second version, for the change-of-reply wipe.
        { name, is_user: false, mes: `这是${name}最后说的话，雨还在下。`, send_date: now(), extra: {},
            ...(i === 0 ? { swipe_id: 0, swipes: [`这是${name}最后说的话，雨还在下。`, `换一个说法：${name}把伞收了起来。`], swipe_info: [{}, {}] } : {}) },
    ];
    const meta = { user_name: 'User', character_name: name, create_date: now(), chat_metadata: {} };
    if (!(await post('/api/chats/save', { ch_name: name, file_name: `终端${i}${run}`, avatar_url: avatar, chat: [meta, ...lines], force: true })).ok()) throw new Error('chat not saved');
await page.waitForTimeout(1100);
}

await page.goto(appUrl);
await page.locator('.tl-library').waitFor({ timeout: 60000 });
await pickTheme('故障终端');
const front = page.locator('.tl-gt');
await front.waitFor({ timeout: 20000 });
await page.waitForTimeout(1500);
check('theme selected and persisted', await page.evaluate(() => document.documentElement.dataset.tlHome) === 'glitch');
check('real latest story appears', (await front.locator('#ttl').textContent()).includes(NAMES[2]));
check('skin images loaded', pictures.includes(200) || pictures.includes(304));
check('no broken images', await front.locator('img').evaluateAll(es => es.every(e => e.complete && e.naturalWidth > 0)));
const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.tl-messages')].every(e => e.scrollWidth <= e.clientWidth));
check('phone shelf fits', await noOverflow());
check('shelf observer settles', await page.evaluate(() => new Promise(resolve => {
    let count = 0;
    const ob = new MutationObserver(ms => { count += ms.length; });
    ob.observe(document.querySelector('.tl-grid'), { childList: true, subtree: true });
    setTimeout(() => { ob.disconnect(); resolve(count < 5); }, 500);
})));
await page.screenshot({ path: `${process.env.LOG_DIR || '/tmp'}/glitch-phone-shelf.png`, fullPage: true, animations: 'disabled', timeout: 60000 });
await front.locator('#hit').focus();
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
check('keyboard opens recent stories', await front.locator('.gp').getAttribute('data-kind') === 'turn');
const touchReady = await page.waitForFunction(() => [...document.querySelectorAll('.tl-gt #rows .row')].every(e => e.getBoundingClientRect().height >= 43.9), null, { timeout: 5000 }).then(() => true).catch(() => false);
check('recent story touch targets are at least 44px', touchReady, JSON.stringify(await front.locator('#rows .row').evaluateAll(es => es.map(e => ({ height: e.getBoundingClientRect().height, css: getComputedStyle(e).height, scale: getComputedStyle(e).getPropertyValue('--s') })))));
check('all recent stories are selectable', await front.locator('#rows .row').count() >= 3);
await front.locator('#rows .row').nth(2).focus();
await page.keyboard.press('Enter');
await page.waitForTimeout(250);
check('selecting a story uses its character', (await front.locator('#ribTx').textContent()) === NAMES[0]);
await page.screenshot({ path: `${process.env.LOG_DIR || '/tmp'}/glitch-phone-recent.png`, fullPage: true, animations: 'disabled', timeout: 60000 });
await front.locator('.tl-gt-act').click();
await page.getByRole('dialog').first().waitFor();
check('story actions retained', /改名|删除/.test(await page.getByRole('dialog').first().textContent()));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('dialog exits without focusable ghost', await page.locator('.tl-gt-sheet-ghost').count() === 0);
await front.locator('.c2').focus();
await page.keyboard.press('Enter');
await page.locator('.tl-composer-input').waitFor({ timeout: 60000 });
await page.locator('.tl-messages[data-gt]').waitFor({ timeout: 10000 });
await page.waitForTimeout(1200);
check('opens selected real chat', decodeURIComponent(await page.evaluate(() => location.hash)).includes(avatars[0]));
check('reader fits phone', await noOverflow());
check('soft reading paper', await page.locator('.tl-messages').evaluate(e => getComputedStyle(e).backgroundColor) === 'rgb(243, 243, 249)');
check('transition cleared', await page.locator('.tl-gt-px').evaluateAll(es => es.every(e => e.hidden)));
await page.screenshot({ path: `${process.env.LOG_DIR || '/tmp'}/glitch-phone-reader.png`, fullPage: true, animations: 'disabled', timeout: 60000 });
const last = page.locator('.tl-message[data-role="char"]').last();
await last.locator('.tl-swipe').waitFor({ timeout: 120000 });
await last.getByRole('button', { name: '下一个回复' }).click();
await page.locator('.tl-message[data-role="char"]', { hasText: '把伞收了起来' }).last().waitFor({ timeout: 20000 });
check('alternate reply works', await last.locator('.tl-swipe-count').textContent() === '2/2');
const sent = `主题发送检查${run}`;
await page.locator('.tl-composer-input').fill(sent);
await page.locator('.tl-send').click();
await page.locator('.tl-message[data-role="char"]', { hasText: `收到：${sent}` }).waitFor({ timeout: 90000 });
check('send and mock reply work under the theme', true);
await page.locator('.tl-reader-header .tl-back').click();
await front.waitFor({ timeout: 20000 });
await page.waitForTimeout(1200);
check('return clears overlay', await page.locator('.tl-gt-px').evaluateAll(es => es.every(e => e.hidden)));
await page.locator('.tl-search').fill(NAMES[1]);
await page.waitForTimeout(300);
check('search hides front', await front.count() === 0);
await page.locator('.tl-search').fill('');
await front.waitFor();
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(800);
check('desktop shelf fits', await noOverflow());
await page.screenshot({ path: `${process.env.LOG_DIR || '/tmp'}/glitch-desktop-shelf.png`, fullPage: true, animations: 'disabled', timeout: 60000 });
await page.emulateMedia({ reducedMotion: 'reduce' });
await front.locator('#hit').focus();
await page.keyboard.press('Enter');
await page.waitForTimeout(100);
await front.locator('.c2').click();
await page.locator('.tl-composer-input').waitFor({ timeout: 60000 });
await page.waitForTimeout(700);
check('reduced motion opens real chat', await page.locator('.tl-messages').count() === 1);
check('reduced motion has no running decorative animations', await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length) === 0);
check('desktop reader fits', await noOverflow());
await page.screenshot({ path: `${process.env.LOG_DIR || '/tmp'}/glitch-desktop-reader.png`, fullPage: true, animations: 'disabled', timeout: 60000 });
// A direct reader reload also loads the shared transition styles.
await page.reload();
await page.locator('.tl-composer-input').waitFor({ timeout: 60000 });
await page.waitForTimeout(900);
check('theme survives reload', await page.evaluate(() => document.documentElement.dataset.tlHome) === 'glitch');
await page.locator('.tl-reader-header .tl-back').click();
await front.waitFor({ timeout: 20000 });
await pickTheme('跟随系统');
await page.waitForTimeout(500);
check('switching theme removes decorations', await page.locator('.tl-gt, .tl-gt-foot, .tl-gt-no, .tl-gt-cft').count() === 0);
check('usual continue cards restored', await page.locator('.tl-continue-primary').count() === 1);
check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
// Let the existing debounced account write finish before another suite starts.
await page.waitForTimeout(3500);
await cleanup();
await browser.close();
console.log(JSON.stringify({ results, pageErrors }, null, 2));
if (problems.length) { console.log('PROBLEMS', problems.join(', ')); process.exit(1); }
console.log('ALL PASS', Object.keys(results).length);

