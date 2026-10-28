// Fresh account: the full app's first-run dialog is answered inside the hidden engine; the shelf leads to 开始使用, which
// sets the name, a model service and (offered) the Chinese sample character, and ends in a story with it.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const base = process.env.ST_URL ?? 'http://127.0.0.1:8031';
const handle = `friend-${Date.now().toString(36)}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const admin = await browser.newContext();
const { token } = await (await admin.request.get(`${base}/csrf-token`)).json();
await admin.request.post(`${base}/api/users/login`, { headers: { 'X-CSRF-Token': token }, data: { handle: 'default-user', password: 'test1234' } });
const created = await admin.request.post(`${base}/api/users/create`, { headers: { 'X-CSRF-Token': token }, data: { handle, name: '新朋友', password: 'pw123456', admin: false } });
console.log('create user', created.status());

const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript(() => {
    window.__tlToasts = [];
    new MutationObserver(rs => { for (const r of rs) for (const n of r.addedNodes) if (n.classList?.contains('tl-toast')) window.__tlToasts.push(n.textContent); }).observe(document, { childList: true, subtree: true });
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e.stack ?? e).slice(0, 300)));
await page.goto(`${base}/scripts/extensions/third-party/emmalike/app/`);
await page.getByPlaceholder('账号').fill(handle);
await page.getByPlaceholder('密码（没设可不填）').fill('pw123456');
await page.getByRole('button', { name: '登录' }).click();
// The shelf: nothing jumps away while it is read; a banner leads to 开始使用, and a Chinese sample is offered.
await page.locator('.tl-character').first().waitFor();
const t = Date.now();
await page.getByRole('button', { name: /^还没连上 AI 模型/ }).waitFor({ timeout: 240000 });
console.log('setup banner shown after', Date.now() - t, 'ms: PASS');
if (await page.locator('.tl-setup').count()) throw new Error('the shelf jumped to 开始使用 by itself');
if (await page.locator('.tl-popup-bar').count()) throw new Error('the full app’s first-run dialog was offered instead of answered');
if (await page.locator('iframe.engine.visible').count()) throw new Error('the full app took over the screen');
console.log('no English first-run dialog, no jump: PASS');
if (!await page.getByRole('button', { name: /^试试中文示例角色/ }).count()) throw new Error('no Chinese sample offered on a new shelf');
console.log('sample character offered: PASS');
await page.getByRole('button', { name: /^还没连上 AI 模型/ }).click();
await page.locator('.tl-setup').waitFor({ timeout: 15000 });
const nameField = page.getByRole('textbox', { name: '你的名字' });
if (await nameField.inputValue() !== '新朋友') throw new Error(`name prefilled with ${await nameField.inputValue()}`);
await nameField.fill('小林');
if (await page.getByRole('radio', { name: /^Claude/ }).count()) throw new Error('services abroad are not folded away');
await page.getByRole('radio', { name: /^中转站（OpenAI 格式）/ }).click();
await page.waitForFunction(() => document.activeElement?.id === 'tl-setup-url', null, { timeout: 5000 })
    .catch(() => { throw new Error('choosing a service did not move on to its key'); });
console.log('choosing a service moves on to the key: PASS');
await page.getByRole('textbox', { name: '地址' }).fill(process.env.SETUP_RELAY_URL ?? 'http://mock:5001/v1');
await page.getByLabel('密钥').fill('sk-newcomer');
await page.waitForFunction(() => [...document.querySelectorAll('.tl-setup button')].some(b => b.textContent === '连接' && !b.disabled), null, { timeout: 120000 })
    .catch(() => { throw new Error('连接 stays disabled'); });
await page.getByRole('button', { name: '连接', exact: true }).click();
await page.getByRole('radiogroup', { name: '模型', exact: true }).waitFor({ timeout: 60000 });
console.log('setup connected: PASS');
if (await page.getByRole('button', { name: '先跳过' }).count()) throw new Error('先跳过 still offered after connecting');
if (!await page.getByRole('checkbox', { name: /中文示例角色/ }).isChecked()) throw new Error('sample checkbox not offered or not checked');
await page.getByRole('button', { name: /^完成，开始聊天/ }).click();
await page.locator('.tl-composer-input').waitFor({ timeout: 30000 });
// The title reads "…" until the character is loaded.
await page.waitForFunction(() => (document.querySelector('.tl-chat-title')?.textContent ?? '…') !== '…', null, { timeout: 30000 }).catch(() => { });
const title = await page.locator('.tl-chat-title').innerText();
if (title !== '林小满') throw new Error(`finishing opened ${title}, not the sample`);
console.log('finishing opens a story with the sample character: PASS');
await page.waitForFunction(() => document.querySelector('.tl-chapter')?.textContent.includes('第 1 个故事'), null, { timeout: 30000 })
    .catch(async () => { throw new Error(`story title is ${await page.locator('.tl-chapter').innerText()}`); });
console.log('unnamed story is numbered: PASS');
await page.locator('.tl-composer-input[data-synced="true"]').waitFor({ timeout: 60000 });
const persona = await page.evaluate(() => document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().name1);
if (persona !== '小林') throw new Error(`persona name is ${persona}`);
console.log('name from setup used in stories: PASS');
const picture = await page.evaluate(async () => {
    const id = document.querySelector('iframe.engine').contentWindow.TavernLiteBridge.personaList().current;
    const [mine, silhouette] = await Promise.all([`/User Avatars/${encodeURIComponent(id)}`, '/img/user-default.png']
        .map(url => fetch(url, { cache: 'no-store' }).then(r => r.arrayBuffer()).then(b => b.byteLength)));
    return { mine, silhouette };
});
if (picture.mine === picture.silhouette) throw new Error(`persona picture is still the silhouette (${JSON.stringify(picture)})`);
console.log('persona picture is the first character of the name: PASS');
if (await page.locator('.tl-setup-bar').count()) throw new Error('the story still says no model service is set up');
await page.locator('.tl-composer-input').fill('新账号测试');
await page.getByRole('button', { name: '发送' }).click();
await page.locator('.tl-message[data-role="char"]', { hasText: '模拟回复' }).last().waitFor({ timeout: 120000 });
console.log('first message answered: PASS');
if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
console.log('page errors: none');
await browser.close();
