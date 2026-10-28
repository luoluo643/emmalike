// The line with the full app's message details (number, time, generation time, tokens) at phone width: shown, it
// takes its own line and never covers a reply that starts with plain text ("[ACTION]"); not shown, the reply keeps only
// the ⋯ in its corner as before. Usage: node e2e-message-meta.mjs <baseUrl> [handle] [password]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
const run = `tl-meta-${Date.now()}`;
const problems = [], results = {};
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`.slice(0, 400); if (!ok) problems.push(name); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.setDefaultTimeout(30000);
const token = (await (await page.request.get(`${base}/csrf-token`)).json()).token;
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const created = await page.request.post(`${base}/api/characters/create`, { headers: { 'X-CSRF-Token': token }, multipart: {
    ch_name: run, description: '排版测试', first_mes: '', personality: '', scenario: '', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' } });
const avatar = (await created.text()).trim();
const at = new Date('2026-10-23T08:12:00Z');
const extra = { token_count: 12836, gen_started: new Date(at - 116000).toISOString(), gen_finished: at.toISOString() };
const chat = [{ user_name: 'unused', character_name: 'unused', chat_metadata: { integrity: crypto.randomUUID() } },
    { name: run, is_user: false, is_system: false, mes: '　　开场的一段正文，写得长一些，好让它在手机上占满好几行，看看第一行和上面的信息有没有叠在一起。', send_date: at.toISOString(), extra },
    { name: 'User', is_user: true, is_system: false, mes: '按照第二章的思路继续写', send_date: at.toISOString(), extra: {} },
    { name: run, is_user: false, is_system: false, mes: '<!-- 模型的注释 -->\n[ACTION]\n\n　　太微历三百一十二年冬月十八，辰时初刻。后山竹林的晨雾尚未散尽。', send_date: at.toISOString(), extra }];
await post('/api/chats/save', { avatar_url: avatar, file_name: run, chat, force: false });
const original = JSON.parse((await (await post('/api/settings/get', {})).json()).settings);
const setDetails = async on => {
    const settings = JSON.parse((await (await post('/api/settings/get', {})).json()).settings);
    Object.assign(settings.power_user, { timestamps_enabled: on, mesIDDisplay_enabled: on, timer_enabled: on, message_token_count_enabled: on });
    if (!(await post('/api/settings/save', settings)).ok()) throw new Error('settings not saved');
};
const open = async () => {
    await page.goto('about:blank');
    await page.goto(`${base}/scripts/extensions/third-party/emmalike/app/#${new URLSearchParams({ chat: avatar, file: run })}`);
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    await page.waitForTimeout(1500);
};
// For each reply: where its detail line, its ⋯ and the first line of its text are.
const measure = () => page.evaluate(() => [...document.querySelectorAll('.tl-message[data-role="char"]')].map(article => {
    article.scrollIntoView({ block: 'center' });
    const line = article.querySelector('.tl-message-name'), menu = line.querySelector('.tl-message-menu'), body = article.querySelector('.tl-message-body');
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, { acceptNode: n => n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
    const range = document.createRange(); range.selectNodeContents(walker.nextNode());
    const text = range.getClientRects()[0], meta = line.querySelector('.tl-message-meta')?.getBoundingClientRect(), a = article.getBoundingClientRect();
    return { first: body.textContent.trim().slice(0, 8), position: getComputedStyle(line).position, metaText: line.querySelector('.tl-message-meta')?.textContent ?? '',
        metaBottom: meta?.bottom ?? null, textTop: text.top, menuHeight: menu.getBoundingClientRect().height, bodyOffset: body.getBoundingClientRect().top - a.top };
}));

try {
    await setDetails(true);
    await open();
    const shown = await measure();
    await page.locator('.tl-message[data-role="char"]').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/tl-meta-on.png' });
    check('details shown on both replies', shown.length === 2 && shown.every(r => /#\d/.test(r.metaText) && /tokens/.test(r.metaText)), JSON.stringify(shown));
    check('the detail line takes its own line', shown.every(r => r.position === 'static'), JSON.stringify(shown));
    check('it never covers the first line of the reply, also one starting with [ACTION]', shown.every(r => r.metaBottom <= r.textTop + 0.5), JSON.stringify(shown));
    check('the ⋯ keeps its 44px touch area', shown.every(r => r.menuHeight >= 44), JSON.stringify(shown.map(r => r.menuHeight)));
    check('the detail line adds little height', shown.every(r => r.bodyOffset > 0 && r.bodyOffset < 32), JSON.stringify(shown.map(r => r.bodyOffset)));

    await setDetails(false);
    await open();
    const hidden = await measure();
    await page.screenshot({ path: '/tmp/tl-meta-off.png' });
    check('without details the ⋯ stays in the corner and the reply does not move', hidden.length === 2 &&
        hidden.every(r => r.position === 'absolute' && r.metaText === '' && Math.abs(r.bodyOffset) < 1), JSON.stringify(hidden));
} catch (error) {
    problems.push('crashed');
    console.log('FAILURE', error.stack);
}
await post('/api/settings/save', original).catch(() => { });
await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS: ${problems.join(', ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
