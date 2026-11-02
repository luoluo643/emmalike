// Same-floor ("同层") frontend cards in the shell. Such a card shows one whole interface on every AI message (a display
// regex turns any reply into the interface) and plays the story inside it: sending adds the user's message and the
// reply to the chat without refreshing it (Tavern Helper's createChatMessages with refresh 'none'), and the interface
// reads the latest reply itself. This suite carries its own minimal card written for the test.
// Needs Tavern Helper (TAVERN_HELPER_REF). Usage: node e2e-same-floor.mjs <baseUrl> <handle> <password> [latencyMs] [downKbps]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `同层${run}`;
const SHOTS = process.env.SHOTS ?? '/tmp';

// The interface: the latest reply's <maintext>, which floor it sits on, and a box that plays the next turn in place.
// No "$" anywhere: the text is a regex replacement.
const UI = [
    '```html',
    '<!DOCTYPE html><html><head><style>',
    'body{margin:0;font:15px/1.6 sans-serif}#app{padding:12px;background:#eef3f8;border-radius:12px;min-height:260px}',
    '#floor{font-size:12px;color:#456}#text{margin:8px 0;min-height:60px}textarea{width:100%;box-sizing:border-box}',
    '</style></head><body><div id="app"><div id="floor"></div><div id="text">…</div>',
    '<textarea id="say" rows="2"></textarea><button id="send">发送</button><div id="err"></div></div>',
    '<script>',
    'const show = async () => {',
    '  const last = getLastMessageId();',
    "  const all = await getChatMessages('0-' + last);",
    "  const ai = all.filter(m => m.role === 'assistant').pop();",
    "  const raw = ai ? ai.message : '';",
    '  const found = raw.match(/<maintext>([\\s\\S]*?)<\\/maintext>/);',
    "  document.getElementById('text').textContent = found ? found[1] : raw;",
    "  document.getElementById('floor').textContent = 'floor ' + getCurrentMessageId() + ' / latest ' + last;",
    '};',
    "document.getElementById('send').addEventListener('click', async () => {",
    "  const text = document.getElementById('say').value.trim();",
    '  if (!text) return;',
    '  try {',
    "    await createChatMessages([{ role: 'user', message: text }], { refresh: 'none' });",
    '    const reply = await generate({ should_stream: true });',
    "    await createChatMessages([{ role: 'assistant', message: '<maintext>' + reply + '</maintext>' }], { refresh: 'none' });",
    "    document.getElementById('say').value = '';",
    '    await show();',
    '    document.body.dataset.sent = String(Number(document.body.dataset.sent || 0) + 1);',
    "  } catch (e) { document.getElementById('err').textContent = 'ERR ' + e; }",
    '});',
    'show();',
    '</script></body></html>',
    '```',
].join('\n');

const results = {};
const problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`; if (!ok) problems.push(name); };
const note = {};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 300)));
const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
let avatar = '';
const finish = async code => {
    console.log(JSON.stringify({ results, note, pageErrors: pageErrors.slice(0, 5) }, null, 1));
    if (avatar) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
    // The regex is the instance's own setting: it must be saved before the browser closes, or later suites inherit it.
    await engineEval(w => {
        const c = w.SillyTavern.getContext();
        c.extensionSettings.regex = (c.extensionSettings.regex ?? []).filter(s => s.scriptName !== 'tl-same-floor-test');
        c.saveSettingsDebounced();
    }).catch(() => { });
    await page.waitForTimeout(3000);
    const left = await page.request.post(`${base}/api/settings/get`, { headers: { 'X-CSRF-Token': token }, data: {} })
        .then(r => r.json()).then(s => String(s.settings ?? '').includes('tl-same-floor-test')).catch(() => null);
    if (left) console.log('WARNING: the test regex is still in the saved settings');
    await browser.close();
    process.exit(code);
};
process.on('uncaughtException', async error => {
    console.log('FAILURE', error.message.split('\n')[0], (error.stack ?? '').split('\n').find(l => l.includes('e2e-same-floor')));
    await page.screenshot({ path: `${SHOTS}/sf-fail.png` }).catch(() => { });
    await finish(2);
});
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');

const created = await page.request.post(`${base}/api/characters/create`, {
    headers: { 'X-CSRF-Token': token },
    multipart: {
        ch_name: NAME, description: '同层前端卡测试', first_mes: '<maintext>雨夜，旧书店的门开着。</maintext>', personality: '', scenario: '',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '',
    },
});
avatar = (await created.text()).trim();
if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);

const engineEval = (fn, arg) => page.evaluate(([source, a]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'a', `return (${source})(w, a);`)(w, a);
}, [fn.toString(), arg]);

await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: '' })}`);
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });

// The card's display regex: every AI message becomes the interface.
await engineEval(async (w, ui) => {
    const c = w.SillyTavern.getContext();
    c.extensionSettings.regex ??= [];
    c.extensionSettings.regex.push({
        id: 'tl-same-floor-test', scriptName: 'tl-same-floor-test', findRegex: '/^[\\s\\S]+$/', replaceString: ui, trimStrings: [],
        placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null,
    });
    c.saveSettingsDebounced();
    await c.reloadCurrentChat();
}, UI);

const frames = () => page.locator('.tl-message iframe.tl-card-frame');
await frames().first().waitFor({ timeout: 60000 });
check('the interface shows on the greeting', await frames().count() === 1, String(await frames().count()));

// Three turns played inside the interface, as a same-floor card does.
const counts = [];
for (let turn = 1; turn <= 3; turn++) {
    const card = page.frameLocator('iframe.tl-card-frame').last();
    const before = await engineEval(w => w.SillyTavern.getContext().chat.length);
    // The last turn is slow (the mock waits 5 s before the words): while the interface waits, nothing else appears.
    await card.locator('#say').fill(turn === 3 ? `第${turn}句【慢】` : `第${turn}句`);
    await card.locator('#send').click();
    if (turn === 3) {
        await page.waitForTimeout(2000);
        note.whileWaiting = { shellMessages: await page.locator('.tl-message').count(), waiting: await page.locator('.tl-message[data-placeholder]').count() };
        await page.screenshot({ path: `${SHOTS}/sf-waiting.png` });
    }
    for (let t = 0; t < 90 && await engineEval(w => w.SillyTavern.getContext().chat.length) < before + 2; t++) await page.waitForTimeout(1000);
    await page.waitForTimeout(2500);
    const chatLength = await engineEval(w => w.SillyTavern.getContext().chat.length);
    const shown = await page.locator('.tl-message').count();
    const mounted = await frames().count();
    const text = await card.locator('#text').textContent().catch(e => 'ERR ' + e.message);
    const err = await card.locator('#err').textContent().catch(() => '');
    counts.push({ turn, chatLength, shellMessages: shown, cardFrames: mounted, cardText: text?.slice(0, 40), err });
}
note.turns = counts;
const final = counts.at(-1);
check('each turn reaches the chat (2 messages per turn)', final.chatLength === 7, String(final.chatLength));
check('the reply shows inside the interface', /模拟回复/.test(final.cardText ?? ''), final.cardText);
check('only the interface is on screen while playing', final.shellMessages === 1 && final.cardFrames === 1, `${final.shellMessages} messages, ${final.cardFrames} interfaces`);
const noteText = () => page.locator('.tl-same-floor-note').innerText().catch(() => '');
check('a line says the other messages are folded', (await noteText()).includes(`已收起 ${final.chatLength - 1} 条`), await noteText());
await page.locator('.tl-same-floor-note button').click();
await page.waitForTimeout(800);
note.expanded = await page.locator('.tl-message').count();
check('展开 shows every message', note.expanded === final.chatLength, `${note.expanded} of ${final.chatLength}`);
await page.locator('.tl-same-floor-note button').click();
await page.waitForTimeout(800);
check('收起 folds them again', await page.locator('.tl-message').count() === 1);
check('while the interface waits for a reply nothing is added under it', note.whileWaiting?.shellMessages === 1 && note.whileWaiting?.waiting === 0, JSON.stringify(note.whileWaiting));

// Going to a folded message from the contents unfolds the story and shows it.
await page.getByRole('button', { name: '目录', exact: true }).click();
const toc = page.getByRole('dialog', { name: '目录' });
await toc.waitFor();
await page.waitForTimeout(300);
// The greeting hosts the interface here, so the newest reply's entry points at a folded message.
await toc.locator('.tl-toc-entry').last().click();
await page.waitForTimeout(1500);
note.afterToc = { note: await noteText(), shellMessages: await page.locator('.tl-message').count() };
check('a contents entry unfolds the story', note.afterToc.shellMessages === final.chatLength && note.afterToc.note.includes('已展开'), JSON.stringify(note.afterToc));
await page.locator('.tl-same-floor-note button').click();
await page.waitForTimeout(800);

await page.locator('.tl-messages').evaluate(el => { el.scrollTop = 0; });
await page.waitForTimeout(800);
await page.screenshot({ path: `${SHOTS}/sf-top.png` });
await page.locator('.tl-messages').evaluate(el => { el.scrollTop = el.scrollHeight; });
await page.waitForTimeout(800);
await page.screenshot({ path: `${SHOTS}/sf-bottom.png` });
note.heights = await page.locator('.tl-messages').evaluate(el => ({ scroll: el.scrollHeight, view: el.clientHeight }));

// After a reload the same chat must still read as one interface.
await page.reload();
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
await frames().first().waitFor({ timeout: 60000 }).catch(() => { });
await page.waitForTimeout(3000);
note.afterReload = { shellMessages: await page.locator('.tl-message').count(), cardFrames: await frames().count() };
check('after a reload only one interface is on screen', note.afterReload.cardFrames === 1 && note.afterReload.shellMessages === 1, `${note.afterReload.shellMessages} messages, ${note.afterReload.cardFrames} interfaces`);
const hostText = await page.frameLocator('iframe.tl-card-frame').last().locator('#text').textContent().catch(e => 'ERR ' + e.message);
check('after a reload the interface shows the latest reply', hostText?.includes('第3句'), hostText);
await page.screenshot({ path: `${SHOTS}/sf-reload.png` });

// A card that is different on every reply (one line of data drawn as a panel) is not folded.
const ordinary = await engineEval(async w => {
    const c = w.SillyTavern.getContext();
    c.extensionSettings.regex = c.extensionSettings.regex.filter(s => s.scriptName !== 'tl-same-floor-test');
    c.extensionSettings.regex.push({
        id: 'tl-same-floor-test', scriptName: 'tl-same-floor-test', findRegex: '/^([\\s\\S]+)$/',
        replaceString: '```html\n<!DOCTYPE html><html><body><div class="panel">$1</div></body></html>\n```', trimStrings: [],
        placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null,
    });
    c.saveSettingsDebounced();
    await c.reloadCurrentChat();
});
await page.waitForTimeout(4000);
note.perReply = { shellMessages: await page.locator('.tl-message').count(), note: await page.locator('.tl-same-floor-note').count() };
check('a card that differs per reply is left as it was', note.perReply.note === 0 && note.perReply.shellMessages === 7, JSON.stringify(note.perReply));

for (const [k, v] of Object.entries(results)) console.log(`${k}: ${v}`);
await finish(problems.length ? 1 : 0);
