// M3 acceptance: writing moves into the shell. Create a character, edit one with drafts that survive a reload, apply
// with a check for changes made elsewhere, undo, and edit / delete
// messages without opening the full app. Usage: node e2e-m3.mjs <baseUrl> <handle> <password> [latencyMs] [downKbps]
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { trackFixtureWrites } from './regression-fixtures.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, latency = '200', downKbps = '5000'] = process.argv.slice(2);
assert.ok(['http://127.0.0.1:8031', 'http://127.0.0.1:8035'].includes(base), 'This regression writes fixtures only to the isolated test instances (8031, or the temporary 8035)');
const output = process.env.TEST_OUTPUT || '/tmp/tavern-improvements/m3-regression';
await mkdir(output, { recursive: true });
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `M3角色${run}`;
await writeFile(output + '/fixtures.json', JSON.stringify({ name: NAME }));
const results = {};
const problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`; if (!ok) problems.push(name); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const device = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const context = await browser.newContext(device);
await trackFixtureWrites(context, output);
const watchToasts = ctx => ctx.addInitScript(() => {
    window.__tlToasts = [];
    new MutationObserver(rs => { for (const r of rs) for (const n of r.addedNodes) if (n.classList?.contains('tl-toast')) window.__tlToasts.push(n.textContent); })
        .observe(document, { childList: true, subtree: true });
});
await watchToasts(context);
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));

const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
let avatar = '';
const cleanup = async () => { if (avatar) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { }); };

process.on('uncaughtException', async error => {
    console.log('FAILURE', error.message.split('\n')[0], (error.stack ?? '').split('\n').find(l => l.includes('e2e-m3.mjs')));
    console.log(JSON.stringify({ toasts: await page.evaluate(() => window.__tlToasts).catch(() => null), results, pageErrors,
        engine: await page.evaluate(() => {
            const frame = document.querySelector('iframe.engine'), w = frame?.contentWindow;
            return { iframe: !!frame, iframeSrc: frame?.getAttribute('src'), readyState: w?.document?.readyState,
                mode: localStorage.getItem('tavern-lite:engine-mode') || 'auto',
                context: !!w?.SillyTavern?.getContext, bridge: !!w?.TavernLiteBridge,
                bridgeScripts: [...(w?.document?.querySelectorAll('script[src]') || [])].filter(x => x.src.includes('/bridge.js')).map(x => x.src),
                shellStatus: [...document.querySelectorAll('.tl-engine-status')].map(x => x.textContent),
                dialogs: [...(w?.document?.querySelectorAll('dialog[open]') || [])].map(x => x.textContent.slice(0, 400)) };
        }).catch(() => null) }, null, 1));
    if (process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT }).catch(() => { });
    await cleanup();
    await browser.close();
    process.exit(2);
});

const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: Number(latency), downloadThroughput: Number(downKbps) * 1024 / 8, uploadThroughput: 1024 * 1024 / 8,
});
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');

const toast = (text, p = page) => p.waitForFunction(t => window.__tlToasts.some(x => x.includes(t)), text, { timeout: 60000 });
const sheet = (title, p = page) => p.getByRole('dialog', { name: title });
const field = (key, p = page) => p.locator(`#tl-field-${key}`);
const saved = (p = page) => p.getByText(/草稿已存在本机/).waitFor({ timeout: 10000 });
const synced = () => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const idle = () => page.locator('.tl-send').waitFor({ timeout: 120000 });
const card = async () => (await post('/api/characters/get', { avatar_url: avatar })).json();
const native = (fn, arg) => page.evaluate(fn, arg);

// Create a character in the shell; what was typed survives a reload before "创建".
await page.goto(appUrl);
await page.locator('.tl-character').first().waitFor();
await page.getByRole('button', { name: '＋ 添加角色' }).click();
await sheet('添加角色').getByRole('button', { name: /^自己写一个角色/ }).click();
await page.locator('.tl-editor').waitFor();
await page.getByLabel('名字').fill(NAME);
await field('description').fill(`她是一名夜班图书管理员。${run}`);
await field('first_mes').fill('“这么晚了，还要借书吗？”');
await saved();
await page.reload();
await page.locator('.tl-editor').waitFor();
await page.getByLabel('名字').waitFor();
check('new character draft survives a reload', await page.getByLabel('名字').inputValue() === NAME && (await field('description').inputValue()).includes(run));
await page.getByRole('button', { name: '创建', exact: true }).click();
await toast(`「${NAME}」已创建`);
await page.locator('.tl-work-name', { hasText: NAME }).waitFor({ timeout: 30000 });
avatar = (await (await post('/api/characters/all', {})).json()).find(c => c.name === NAME)?.avatar ?? '';
await writeFile(output + '/fixtures.json', JSON.stringify({ name: NAME, avatar }));
const created = await card();
check('create a character from the shell', !!avatar && created.data?.description?.includes(run) && created.data?.first_mes === '“这么晚了，还要借书吗？”', JSON.stringify(created.data ?? {}).slice(0, 200));

// Open its story so the full app has it selected, and leave a message to edit later.
await page.getByRole('button', { name: '开始阅读' }).click();
await synced();
const line = `我把书放在柜台上。${run}`;
await page.locator('.tl-composer-input').fill(line);
await page.getByRole('button', { name: '发送' }).click();
await page.locator('.tl-message[data-role="char"]', { hasText: `收到：${line}` }).waitFor({ timeout: 120000 });
await idle();

// Edit: a draft is kept across a reload and comes back through the banner.
await page.getByRole('button', { name: '更多', exact: true }).click();
await page.getByRole('button', { name: /^角色主页/ }).click();
await page.getByRole('button', { name: /^编辑角色/ }).click();
await page.locator('.tl-editor').waitFor();
await field('description').waitFor();
const mine = `她是一名夜班图书管理员，说话很轻。${run}`;
await field('description').fill(mine);
await saved();
await page.reload();
await page.locator('.tl-banner-card').waitFor({ timeout: 30000 });
check('editing draft is offered after a reload', (await page.locator('.tl-banner-card').innerText()).includes('人物设定'));
await page.getByRole('button', { name: '恢复草稿' }).click();
check('restore the draft', await field('description').inputValue() === mine);

// The full app holds this character in its own form with the old text (as after the user opened its editor there).
await page.waitForFunction(() => !!document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge, null, { timeout: 240000 });
await native(a => {
    const c = document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext();
    return c.selectCharacterById(c.characters.findIndex(x => x.avatar === a), { switchMenu: false });
}, avatar);
const engineForm = () => native(a => {
    const w = document.querySelector('iframe.engine').contentWindow;
    const c = w.SillyTavern.getContext();
    return { form: w.document.querySelector('#description_textarea')?.value, current: c.characters[c.characterId]?.avatar === a, index: c.characters.findIndex(x => x.avatar === a) };
}, avatar);
await page.waitForFunction(() => !!document.querySelector('iframe.engine').contentDocument.querySelector('#description_textarea')?.value, null, { timeout: 15000 }).catch(() => { });
const formBefore = await engineForm();
check('full app form holds the old text before applying', formBefore.current && formBefore.form === `她是一名夜班图书管理员。${run}`, JSON.stringify(formBefore));

// Someone else changes the same field; saving asks before overwriting it.
await post('/api/characters/merge-attributes', { avatar, description: '别处改的设定', data: { description: '别处改的设定' } });
await page.getByRole('button', { name: '保存', exact: true }).click();
await sheet('角色在别处也被改过').waitFor({ timeout: 30000 });
check('a change made elsewhere is caught before writing', (await card()).data.description === '别处改的设定');
await sheet('角色在别处也被改过').getByRole('button', { name: '用我的版本覆盖' }).click();
await toast('已保存');
check('save writes the field and verifies it', (await card()).data.description === mine && (await card()).description === mine);
await page.waitForFunction(text => {
    const doc = document.querySelector('iframe.engine').contentDocument;
    return doc.querySelector('#description_textarea')?.value === text;
}, mine, { timeout: 30000 }).then(() => check('full app form refreshed, so it cannot write the old text back', true))
    .catch(async () => check('full app form refreshed, so it cannot write the old text back', false, JSON.stringify(await engineForm())));
check('full app uses the new text for replies', await native(t => { const c = document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext(); return c.characters[c.characterId]?.description === t; }, mine));

// Alternate greetings.
await page.getByRole('button', { name: '＋ 再加一个开场白' }).click();
await page.getByLabel('备选开场白 1').fill('“你又来了。”');
await saved();
await page.getByRole('button', { name: '保存', exact: true }).click();
await page.waitForFunction(() => window.__tlToasts.filter(t => t.includes('已保存')).length >= 2, null, { timeout: 30000 });
check('alternate greetings saved', JSON.stringify((await card()).data.alternate_greetings) === JSON.stringify(['“你又来了。”']));

// Undo: the version before the last save comes back as a draft, not straight onto the card.
await page.getByRole('button', { name: /^找回上次保存前的内容/ }).click();
await sheet('找回上次保存前的内容').getByRole('button', { name: '载入为草稿' }).click();
check('previous version loads into the editor', JSON.stringify(await page.getByLabel('备选开场白 1').count()) === '0' && (await card()).data.alternate_greetings.length === 1);

// Drafts stay on this device: the editor offers nothing from elsewhere.
await saved();
check('no account draft entry', await page.getByRole('button', { name: /^另一台设备上的草稿/ }).count() === 0);
await page.getByRole('button', { name: /^放弃这些修改/ }).click();
await sheet('放弃修改').getByRole('button', { name: '放弃' }).click();
check('discard returns to the card as it is', await page.getByLabel('备选开场白 1').inputValue() === '“你又来了。”');

// Messages: edit and delete in the shell. (The editor was opened from the character page.)
await page.getByRole('button', { name: '返回' }).click();
await page.locator('.tl-work').waitFor();
await page.getByRole('button', { name: '继续阅读' }).click();
await page.locator('.tl-composer-input').waitFor();
await synced();
const userMessage = page.locator('.tl-message[data-role="user"]', { hasText: line });
await userMessage.locator('.tl-message-menu').click();
await sheet('消息操作').getByRole('button', { name: /^编辑/ }).click();
const edited = `我把那本旧书轻轻放在柜台上。${run}`;
await page.getByLabel('消息内容').fill(edited);
await page.getByRole('button', { name: '保存', exact: true }).click();
await toast('已保存');
await page.locator('.tl-message[data-role="user"]', { hasText: edited }).waitFor({ timeout: 30000 });
const chatFile = await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('file')) ||
    await native(() => document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().getCurrentChatId());
const stored = async () => (await post('/api/chats/get', { ch_name: NAME, file_name: chatFile, avatar_url: avatar })).json();
// The full app writes the chat file shortly after the edit; give it up to 10 seconds.
let editSaved = false;
for (let i = 0; i < 20 && !editSaved; i++) {
    await page.waitForTimeout(500);
    editSaved = (await stored()).some(m => m.is_user && m.mes === edited);
}
check('edit a message in the shell, saved in the chat file', editSaved);

const lastChar = () => page.locator('.tl-message[data-role="char"]').last();
await lastChar().getByRole('button', { name: '生成新回复' }).click();
await page.waitForFunction(() => /2\/2/.test([...document.querySelectorAll('.tl-message[data-role="char"] .tl-swipe-count')].pop()?.textContent ?? ''), null, { timeout: 120000 });
await idle();
await lastChar().locator('.tl-message-menu').click();
await sheet('消息操作').getByRole('button', { name: /^删除/ }).click();
await sheet('删除').getByRole('button', { name: /^只删这个回复/ }).click();
await toast('已删除这个回复');
await page.waitForFunction(() => [...document.querySelectorAll('.tl-message[data-role="char"] .tl-swipe-count')].pop()?.textContent === '换个回复', null, { timeout: 30000 })
    .then(() => check('delete one reply among several', true)).catch(() => check('delete one reply among several', false));

const before = await page.locator('.tl-message').count();
await page.locator('.tl-message[data-role="user"]', { hasText: edited }).locator('.tl-message-menu').click();
await sheet('消息操作').getByRole('button', { name: /^删除/ }).click();
await sheet('删除这条消息').getByRole('button', { name: '删除', exact: true }).click();
await toast('已删除');
await page.waitForFunction(n => document.querySelectorAll('.tl-message').length === n - 1, before, { timeout: 30000 });
await page.waitForTimeout(1500);
check('delete a message in the shell, saved in the chat file', !(await stored()).some(m => m.is_user && m.mes === edited));

await cleanup();
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(JSON.stringify(results, null, 1));
await browser.close();
process.exit(problems.length ? 1 : 0);
