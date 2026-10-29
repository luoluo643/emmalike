// Lines written inside a story, kept by the shell itself when Horae is not installed: a request that starts a 小剧场 is
// recorded on its message, read as a sub-story named by its kind; "回到正文" goes back; marking by hand and changing the
// kind; an older story split from suggestions (by rules, and the AI asked with only the openings of the requests).
// Saved through the app's own save. Run on official SillyTavern with only tavern-lite (no Horae).
// Usage: node e2e-own-lines.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `分线测试${run}`;
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
    console.log('FAILURE', error.message.split('\n').slice(0, 12).join(' | '), (error.stack ?? '').split('\n').find(l => l.includes('e2e-own-lines.mjs')));
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
        ch_name: NAME, description: '测试故事里的线', first_mes: '“你来了。”', personality: '', scenario: '', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '',
    },
});
avatar = (await created.text()).trim();
if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);

const now = () => new Date().toISOString();
const msg = (is_user, mes) => ({ name: is_user ? 'User' : NAME, is_user, mes, send_date: now(), extra: {} });
const save = (file, list) => post('/api/chats/save', { ch_name: NAME, file_name: file, avatar_url: avatar, force: true,
    chat: [{ user_name: 'User', character_name: NAME, create_date: now(), chat_metadata: {} }, ...list] });
const read = async file => await (await post('/api/chats/get', { ch_name: NAME, file_name: file, avatar_url: avatar })).json();
const file = `分线${run}`;
if (!(await save(file, [msg(false, '“你来了。”'), msg(true, '正文里的一句话'), msg(false, '正文里的回答')])).ok()) throw new Error('chat not saved');

await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file })}`);
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const hasHorae = await engineEval(w => typeof w.Horae?.getStorylines === 'function');
check('Horae is not installed', !hasHorae);
const sheet = title => page.getByRole('dialog', { name: title });
const toast = text => page.waitForFunction(t => window.__tlToasts.some(x => x.includes(t)), text, { timeout: 30000 });
const bar = () => page.locator('.tl-episode-bar > span').textContent();
const chapter = () => page.locator('.tl-chapter').textContent();
const path = () => page.locator('.tl-branch-path').textContent().catch(() => '');
const shown = () => page.evaluate(() => [...document.querySelectorAll('.tl-messages .tl-message[data-index]')].map(n => Number(n.dataset.index)));
const showing = (list, timeout = 30000) => page.waitForFunction(want => JSON.stringify([...document.querySelectorAll('.tl-messages .tl-message[data-index]')]
    .map(n => Number(n.dataset.index))) === JSON.stringify(want), list, { timeout }).catch(() => { });
const idle = () => page.waitForFunction(() => !document.querySelector('.tl-stop') && !document.querySelector('.tl-message[data-pending]'), null, { timeout: 120000 });
const sendText = async text => {
    await page.getByRole('textbox', { name: '输入消息' }).fill(text);
    await page.getByRole('button', { name: '发送', exact: true }).click();
};
check('a story without lines is an ordinary story', (await chapter()).startsWith('普通故事'), await chapter());

// A request for a 小剧场: first a word that the model still reads the whole story, then it goes on its own line.
await sendText('写个小剧场：丧尸男友');
const memory = sheet('写在这条线里？');
await memory.waitFor({ timeout: 20000 });
check('asked first: the model reads the whole story', (await memory.textContent()).includes('还是会看到整个故事'), await memory.textContent());
check('offers to write it apart', await memory.getByRole('button', { name: '分开写' }).count() === 1);
await memory.getByRole('button', { name: '还是写在这里' }).click();
await page.waitForFunction(() => document.querySelectorAll('.tl-messages .tl-message[data-index]').length >= 2, null, { timeout: 120000 });
await idle();
await showing([3, 4]);
check('the 小剧场 reads on its own', JSON.stringify(await shown()) === '[3,4]', JSON.stringify(await shown()));
check('path: 正文 › 小剧场 · 丧尸男友', /正文.*小剧场 · 丧尸男友/.test(await path()), await path());
check('send bar names the line by its kind', (await bar()).includes('小剧场 · 丧尸男友'), await bar());
check('top bar calls the story 正文', (await chapter()).startsWith('正文 · '), await chapter());
await page.waitForTimeout(1500);
let saved = await read(file);
const reg = saved[0]?.chat_metadata?.tavern_lite_lines;
const zombie = Object.entries(reg?.lines ?? {}).find(([, l]) => l.title === '丧尸男友')?.[0];
check('saved: the line in the story\'s record, its kind 小剧场', !!zombie && reg.lines[zombie].kind === 'skit' && !reg.pending, JSON.stringify(reg));
check('saved: the mark on the request', saved[4]?.tavern_lite_line === zombie && !saved[5]?.tavern_lite_line, JSON.stringify(saved.slice(1).map(m => m.tavern_lite_line ?? null)));

// Inside it, no second question; "回到正文" goes back to the 正文.
await sendText('接着写丧尸');
await idle();
check('asked once per story', await sheet('写在这条线里？').count() === 0);
await showing([3, 4, 5, 6]);
check('written on the line being read', JSON.stringify(await shown()) === '[3,4,5,6]', JSON.stringify(await shown()));
await sendText('回到正文');
await idle();
await showing([0, 1, 2, 7, 8]);
check('back on the 正文', JSON.stringify(await shown()) === '[0,1,2,7,8]', JSON.stringify(await shown()));
const markAt = async title => page.locator('.tl-branch-mark').filter({ hasText: title })
    .evaluate(el => el.closest('.tl-branch-marks')?.previousElementSibling?.dataset.index ?? null).catch(() => null);
check('the 正文 marks where the 小剧场 leaves', await markAt('小剧场 · 丧尸男友') === '2', String(await markAt('小剧场 · 丧尸男友')));
await page.waitForTimeout(1500);
saved = await read(file);
check('saved: back to the 正文 on its request', saved[8]?.tavern_lite_line === 'main', JSON.stringify(saved.slice(1).map(m => m.tavern_lite_line ?? null)));

// By hand: a 平行线 from the 正文's first answer on; then back to the 正文 from the next request.
await page.locator('.tl-message[data-index="2"] .tl-message-menu').click();
await sheet('消息操作').getByRole('button', { name: /^分线/ }).click();
await sheet('分线').getByRole('button', { name: /^从这里开一条番外/ }).click();
const form = sheet('从这里开一条番外');
await form.getByLabel('类型').selectOption('parallel');
await form.getByLabel('名字').fill('古风');
await form.getByRole('button', { name: '开始' }).click();
await toast('从这条起是平行线「古风」');
await page.waitForTimeout(1500);
saved = await read(file);
const lines = saved[0]?.chat_metadata?.tavern_lite_lines?.lines ?? {};
const gufeng = Object.entries(lines).find(([, l]) => l.title === '古风')?.[0];
check('marked by hand, kind 平行线', !!gufeng && lines[gufeng].kind === 'parallel' && saved[3]?.tavern_lite_line === gufeng, JSON.stringify(lines));
await showing([0, 1, 7, 8]);
check('the 正文 no longer has that answer', JSON.stringify(await shown()) === '[0,1,7,8]', JSON.stringify(await shown()));

// Its kind changed in the sheet of the story's lines (under 更多).
await page.getByRole('button', { name: '更多', exact: true }).click();
await sheet(NAME).getByRole('button', { name: /^故事里的线/ }).click();
const linesSheet = sheet('故事里的线');
await linesSheet.waitFor();
const rows = await linesSheet.locator('.tl-storyline-row').allInnerTexts();
check('the sheet lists the lines by kind', rows.some(r => r.includes('小剧场 · 丧尸男友')) && rows.some(r => r.includes('平行线 · 古风')), JSON.stringify(rows));
check('no Horae wording, and says the model reads it all', !(await linesSheet.textContent()).includes('Horae 扩展的功能') && (await linesSheet.textContent()).includes('还是会看到整个故事'));
await linesSheet.locator('.tl-storyline-row', { hasText: '丧尸男友' }).getByRole('button', { name: /^改类型/ }).click();
const edit = page.getByRole('dialog', { name: /^改「/ });
await edit.getByLabel('类型').selectOption('side');
await edit.getByRole('button', { name: '保存' }).click();
await toast('已改好');
await page.waitForTimeout(1500);
saved = await read(file);
check('kind chosen by hand saved', saved[0]?.chat_metadata?.tavern_lite_lines?.kinds?.[zombie] === 'side', JSON.stringify(saved[0]?.chat_metadata?.tavern_lite_lines));
check('shown as 番外 now', /番外 · 丧尸男友/.test(await page.locator('.tl-branch-marks').allInnerTexts().then(t => t.join('|')).catch(() => '')) || /番外 · 丧尸男友/.test(await bar()),
    await page.locator('.tl-branch-marks').allInnerTexts().then(t => t.join('|')).catch(() => ''));
await page.getByRole('dialog').last().getByRole('button', { name: '关闭' }).click();

// Sent in the full app, not through the shell: the request is read there too.
await engineEval(w => {
    const box = w.document.querySelector('#send_textarea');
    box.value = '写个小剧场：吵架';
    box.dispatchEvent(new w.Event('input', { bubbles: true }));
    w.document.querySelector('#send_but').click();
});
const settled = async count => {
    for (let i = 0; i < 120; i++) {
        if (await engineEval((w, n) => w.SillyTavern.getContext().chat.length >= n && !w.document.querySelector('#mes_stop:not([style*="none"])')?.offsetParent, count)) return true;
        await page.waitForTimeout(1000);
    }
    return false;
};
check('the full app sent it', await settled(11));
await page.waitForTimeout(2500);
saved = await read(file);
const quarrel = Object.entries(saved[0]?.chat_metadata?.tavern_lite_lines?.lines ?? {}).find(([, l]) => l.title === '吵架')?.[0];
check('sent in the full app: the line recorded on its request', !!quarrel && saved[10]?.tavern_lite_line === quarrel
    && saved[0].chat_metadata.tavern_lite_lines.lines[quarrel].kind === 'skit', JSON.stringify(saved.slice(1).map(m => m.tavern_lite_line ?? null)));

// Deleting the message a line starts at: the next one starts it, so the reply stays on the line.
await showing([9, 10]);
await page.locator('.tl-message[data-index="9"] .tl-message-menu').click();
await sheet('消息操作').getByRole('button', { name: /^删除/ }).click();
await sheet('删除这条消息？').getByRole('button', { name: '删除' }).click();
await toast('已删除');
await page.waitForTimeout(2000);
saved = await read(file);
check('after deleting its request the line goes on from the reply', saved.length === 11 && saved[10]?.tavern_lite_line === quarrel,
    JSON.stringify(saved.slice(1).map(m => m.tavern_lite_line ?? null)));

// 故事里写过的番外 lists the lines the story records, to copy one out.
await page.getByRole('button', { name: '番外与平行线' }).click();
const episodes = sheet('番外与平行线');
await episodes.locator('.tl-inline-episodes').waitFor({ timeout: 60000 });
const listed = await episodes.locator('.tl-inline-episodes .tl-episode-list-row').allInnerTexts();
check('the recorded lines are the story\'s 番外', listed.some(t => t.includes('平行线 · 古风')) && listed.some(t => t.includes('番外 · 丧尸男友'))
    && listed.some(t => t.includes('小剧场 · 吵架')), JSON.stringify(listed));
await episodes.getByRole('button', { name: '关闭' }).click();

// An older story: suggestions from its requests, applied after checking; the AI is asked with the openings only.
const old = `旧故事${run}`;
await save(old, [msg(false, '“你来了。”'), msg(true, '他推开门'), msg(false, '门开了。'), msg(true, '暂停剧情，生成番外。主题是「雨夜」'), msg(false, '雨下了一夜。'),
    msg(true, 'gemini 暂停剧情 自检是否ooc'), msg(false, '自检。'), msg(true, '回到正文'), msg(false, '回来了。')]);
await page.goto('about:blank');
await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: old })}`);
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
await page.getByRole('button', { name: '更多', exact: true }).click();
await sheet(NAME).getByRole('button', { name: /^故事里的线/ }).click();
const oldSheet = sheet('故事里的线');
await oldSheet.getByRole('button', { name: '让 AI 帮忙找' }).click();
check('says what is sent to the model', (await oldSheet.textContent()).includes('只问它哪里换了线'), await oldSheet.textContent());
await oldSheet.getByRole('button', { name: '发送' }).click();
await oldSheet.locator('.tl-error').waitFor({ timeout: 60000 });
const asked = await (await page.request.get(`${process.env.MOCK_LAST_URL ?? 'http://127.0.0.1:5001/last'}`)).json().catch(() => null);
const sent = JSON.stringify(asked?.messages ?? asked ?? '');
check('the model got only the requests\' openings', sent.includes('#3 暂停剧情') && !sent.includes('雨下了一夜') && !sent.includes('测试故事里的线'), sent.slice(0, 300));
check('an answer that is not a list is said so', (await oldSheet.locator('.tl-error').textContent()).includes('没看懂'));
await oldSheet.getByRole('button', { name: '先不了' }).click();
await oldSheet.getByRole('button', { name: '按发言找' }).click();
const picks = await oldSheet.locator('.tl-storyline-pick').allInnerTexts();
check('rules find the 番外 and the way back, not the self-check', picks.length === 2 && picks[0].includes('第 3 条起是番外「雨夜」') && picks[1].includes('第 7 条起回到正文'), JSON.stringify(picks));
await oldSheet.getByRole('button', { name: '按勾选的分' }).click();
await toast('已按 2 处分好');
await page.waitForTimeout(1500);
const oldSaved = await read(old);
const rain = Object.entries(oldSaved[0]?.chat_metadata?.tavern_lite_lines?.lines ?? {}).find(([, l]) => l.title === '雨夜')?.[0];
check('suggestions saved as marks', !!rain && oldSaved[4]?.tavern_lite_line === rain && oldSaved[8]?.tavern_lite_line === 'main',
    JSON.stringify(oldSaved.slice(1).map(m => m.tavern_lite_line ?? null)));
await oldSheet.getByRole('button', { name: /^番外 · 雨夜/ }).click();
await showing([3, 4, 5, 6]);
check('the old 番外 reads on its own, the self-check in it', JSON.stringify(await shown()) === '[3,4,5,6]', JSON.stringify(await shown()));
check('the whole story still in the full app', await engineEval(w => w.document.querySelectorAll('#chat .mes').length) === 9);

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS ${problems.join(', ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
