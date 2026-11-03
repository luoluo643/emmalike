// What each of a story's own lines sends to the model (no Horae): asked the first time a line is written on, kept in
// the story's record, changed in 故事里的线. Checked on what the model really got (the mock model's /last): a line kept
// to itself sends only itself, one that left the 正文 sends the 正文 up to there, the 正文 leaves both out, and the
// full app sends the same. Run on official SillyTavern with only tavern-lite.
// Usage: node e2e-line-context.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const lastUrl = process.env.MOCK_LAST_URL ?? 'http://127.0.0.1:5001/last';
const run = Date.now().toString(36);
const NAME = `发送范围${run}`;
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
const engineEval = (fn, arg) => page.evaluate(([source, a]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'a', `return (${source})(w, a);`)(w, a);
}, [fn.toString(), arg]);
let avatar = '';

let failing = false;
process.on('uncaughtException', async error => {
    if (failing) process.exit(3);
    failing = true;
    console.log('FAILURE', error.message.split('\n').slice(0, 12).join(' | '), (error.stack ?? '').split('\n').find(l => l.includes('e2e-line-context')));
    console.log(JSON.stringify({ toasts: await page.evaluate(() => window.__tlToasts).catch(() => null), results, pageErrors }, null, 1));
    if (process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT }).catch(() => { });
    if (avatar) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
    await browser.close();
    process.exit(2);
});

if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const created = await page.request.post(`${base}/api/characters/create`, {
    headers: { 'X-CSRF-Token': token },
    multipart: {
        ch_name: NAME, description: '测试每条线发给模型的内容', first_mes: '“开场白甲。”', personality: '', scenario: '', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '',
    },
});
avatar = (await created.text()).trim();
if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);

const now = () => new Date().toISOString();
const msg = (is_user, mes) => ({ name: is_user ? 'User' : NAME, is_user, mes, send_date: now(), extra: {} });
const file = `范围${run}`;
const read = async () => await (await post('/api/chats/get', { ch_name: NAME, file_name: file, avatar_url: avatar })).json();
const saved = await post('/api/chats/save', { ch_name: NAME, file_name: file, avatar_url: avatar, force: true,
    chat: [{ user_name: 'User', character_name: NAME, create_date: now(), chat_metadata: {} }, msg(false, '“开场白甲。”'), msg(true, '正文问题乙'), msg(false, '正文回答丙')] });
if (!saved.ok()) throw new Error('chat not saved');

await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file })}`);
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
check('Horae is not installed', !(await engineEval(w => typeof w.Horae?.getStorylines === 'function')));
check('the interceptor is installed in the app', await engineEval(w => typeof w.tavernLiteLineContext === 'function'));

const sheet = title => page.getByRole('dialog', { name: title });
const toast = text => page.waitForFunction(t => window.__tlToasts.some(x => x.includes(t)), text, { timeout: 30000 });
const idle = () => page.waitForFunction(() => !document.querySelector('.tl-stop') && !document.querySelector('.tl-message[data-pending]'), null, { timeout: 120000 });
const sendText = async text => {
    await page.getByRole('textbox', { name: '输入消息' }).fill(text);
    await page.getByRole('button', { name: '发送', exact: true }).click();
};
// The text of every message the model got last time.
const lastSent = async () => {
    const body = await (await page.request.get(lastUrl)).json().catch(() => null);
    return (body?.messages ?? []).map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
};
const sends = (text, has, hasNot) => {
    const missing = has.filter(s => !text.includes(s)), extra = hasNot.filter(s => text.includes(s));
    return { ok: !missing.length && !extra.length, detail: `missing ${JSON.stringify(missing)} extra ${JSON.stringify(extra)}` };
};
const record = async () => (await read())[0]?.chat_metadata?.tavern_lite_lines ?? {};
const lineId = (reg, title) => Object.entries(reg.lines ?? {}).find(([, l]) => l.title === title)?.[0];

// A 小剧场 kept to itself, not remembered for the lines to come.
await sendText('写个小剧场：丧尸男友');
const ask = sheet('这条线发给模型什么？');
await ask.waitFor({ timeout: 20000 });
check('asked on the first message of a line, 前文 + 这条线 chosen to start', await ask.getByRole('radio', { name: '前文 + 这条线' }).getAttribute('aria-checked') === 'true');
await ask.getByRole('radio', { name: '只有这条线' }).click();
check('the choice is explained', (await ask.textContent()).includes('像另开一个故事'), await ask.textContent());
await ask.getByRole('checkbox', { name: /以后新开的线也这样/ }).uncheck();
await ask.getByRole('button', { name: '写在这里' }).click();
await idle();
let got = await lastSent();
let r = sends(got, ['写个小剧场：丧尸男友'], ['正文问题乙', '正文回答丙', '开场白甲']);
check('own: the model got the 小剧场 alone', r.ok, r.detail);
await page.waitForTimeout(1500);
let reg = await record();
const zombie = lineId(reg, '丧尸男友');
check('saved: own for that line, nothing for the lines to come', reg.contexts?.[zombie] === 'own' && !reg.defaultContext, JSON.stringify(reg));

await sendText('接着写丧尸丁');
await idle();
check('not asked again on the same line', await ask.count() === 0);
got = await lastSent();
r = sends(got, ['写个小剧场：丧尸男友', '接着写丧尸丁'], ['正文问题乙']);
check('own: the line keeps to itself', r.ok, r.detail);

// Back on the 正文: the 小剧场 kept to itself is not sent.
await sendText('回到正文');
await idle();
got = await lastSent();
r = sends(got, ['正文问题乙', '正文回答丙', '回到正文'], ['丧尸男友', '接着写丧尸丁']);
check('the 正文 leaves out a line kept apart', r.ok, r.detail);

// A 番外 that sends the 正文 up to where it left; remembered for the lines to come.
await sendText('暂停剧情，生成番外。主题是「雨夜」');
// Asked again (nothing was remembered); 前文 + 这条线 as it starts.
await ask.waitFor({ timeout: 20000 });
await ask.getByRole('button', { name: '写在这里' }).click();
await idle();
got = await lastSent();
r = sends(got, ['正文问题乙', '回到正文', '主题是「雨夜」'], ['接着写丧尸丁']);
check('fork: the 正文 before it and itself', r.ok, r.detail);
await page.waitForTimeout(1500);
reg = await record();
const rain = lineId(reg, '雨夜');
check('saved: fork, and remembered', reg.contexts?.[rain] === 'fork' && reg.defaultContext === 'fork', JSON.stringify(reg));
await sendText('雨夜里的戊');
await idle();

await sendText('回到正文');
await idle();
got = await lastSent();
r = sends(got, ['正文问题乙'], ['主题是「雨夜」', '雨夜里的戊', '接着写丧尸丁']);
check('the 正文 leaves out both lines', r.ok, r.detail);
await sendText('正文里的己');
await idle();

// A new line takes the remembered choice without asking; it sends the 正文 up to its start, not the other lines.
await sendText('小剧场：吵架');
await page.waitForTimeout(800);
check('remembered: not asked', await ask.count() === 0);
await idle();
got = await lastSent();
r = sends(got, ['正文问题乙', '正文里的己', '小剧场：吵架'], ['雨夜里的戊', '接着写丧尸丁']);
check('the remembered choice sends like fork', r.ok, r.detail);
await page.waitForTimeout(1500);
reg = await record();
check('saved: the new line got fork', reg.contexts?.[lineId(reg, '吵架')] === 'fork', JSON.stringify(reg));

// Changed in 故事里的线: the 小剧场 now sends the whole story (still without the lines kept apart).
await page.getByRole('button', { name: '更多', exact: true }).click();
await sheet(NAME).getByRole('button', { name: /^故事里的线/ }).click();
const lines = sheet('故事里的线');
await lines.waitFor();
const rows = await lines.locator('.tl-storyline-row').allInnerTexts();
check('each line says what it sends', rows.some(t => t.includes('丧尸男友') && t.includes('只发自己')) && rows.some(t => t.includes('雨夜') && t.includes('发前文和自己')), JSON.stringify(rows));
await lines.locator('.tl-storyline-row', { hasText: '丧尸男友' }).getByRole('button', { name: '改', exact: true }).click();
const edit = page.getByRole('dialog', { name: /^改「/ });
check('the form starts on the line\'s choice', await edit.getByRole('radio', { name: '只有这条线' }).getAttribute('aria-checked') === 'true');
await edit.getByRole('radio', { name: '整个故事' }).click();
await edit.getByRole('button', { name: '保存' }).click();
await toast('已改好');
await page.waitForTimeout(1500);
reg = await record();
check('saved: the whole story', reg.contexts?.[zombie] === 'all', JSON.stringify(reg));
const back = sheet('故事里的线');
await back.locator('.tl-storyline-row', { hasText: '丧尸男友' }).locator('.tl-sheet-item').click();
await page.waitForTimeout(800);
await sendText('丧尸庚');
await idle();
got = await lastSent();
r = sends(got, ['正文问题乙', '正文里的己', '接着写丧尸丁', '丧尸庚'], ['雨夜里的戊', '小剧场：吵架']);
check('all: the whole story but the lines kept apart', r.ok, r.detail);

// The full app sends the same: a message from its own input, on the 小剧场 now on the whole story.
await engineEval(w => {
    const box = w.document.querySelector('#send_textarea');
    box.value = '原版里的辛';
    box.dispatchEvent(new w.Event('input', { bubbles: true }));
    w.document.querySelector('#send_but').click();
});
for (let i = 0; i < 60 && !(await lastSent()).includes('原版里的辛'); i++) await page.waitForTimeout(1000);
got = await lastSent();
r = sends(got, ['原版里的辛', '正文问题乙'], ['雨夜里的戊', '小剧场：吵架']);
check('the full app\'s own send holds back the same', r.ok, r.detail);
check('the story itself keeps every message', (await read()).length - 1 === await engineEval(w => w.SillyTavern.getContext().chat.length));

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS ${problems.join(', ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
