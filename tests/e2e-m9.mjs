// 0.10.0 acceptance (newcomer review): the shelf says when no model service is set up and leads to 开始使用, which
// connects a service in plain steps (relay address + key here, the mock model), lists its models and shows a test
// reply; no "完整版" wording anywhere the user looks; the story menu grouped; the message menu short with the rest
// under 更多; the + button only for extension features; consistent names (角色 / 故事).
// Needs the mock model at http://mock:5001/v1 (tests/prepare.sh). Usage: node e2e-m9.mjs <baseUrl> <handle> <password> [latencyMs] [downKbps]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, latency = '200', downKbps = '5000'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const MOCK_URL = process.env.SETUP_RELAY_URL ?? 'http://mock:5001/v1';
const run = Date.now().toString(36);
const NAME = `M9测试${run}`;
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
let avatar = '';
let savedUrl = null;
const engineEval = (fn, arg) => page.evaluate(([source, a]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'a', `return (${source})(w, a);`)(w, a);
}, [fn.toString(), arg]);

const cleanup = async () => {
    // The relay address is put back whatever happened (the other suites use the mock model).
    if (savedUrl !== null) {
        await engineEval((w, url) => {
            const c = w.SillyTavern.getContext();
            const input = w.document.getElementById('custom_api_url_text');
            input.value = url;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            c.chatCompletionSettings.custom_url = url;
            c.saveSettingsDebounced();
        }, savedUrl).catch(() => { });
        await page.waitForTimeout(1500);
    }
    if (avatar) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
};

let failing = false;
process.on('uncaughtException', async error => {
    if (failing) process.exit(3);
    failing = true;
    console.log('FAILURE', error.message.split('\n').slice(0, 12).join(' | '), (error.stack ?? '').split('\n').find(l => l.includes('e2e-m9.mjs')));
    console.log(JSON.stringify({ toasts: await page.evaluate(() => window.__tlToasts).catch(() => null), results, pageErrors }, null, 1));
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
const created = await page.request.post(`${base}/api/characters/create`, {
    headers: { 'X-CSRF-Token': token },
    multipart: {
        ch_name: NAME, description: '测试 0.10.0 的角色', first_mes: '“你来了。”', personality: '', scenario: '', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '',
    },
});
avatar = (await created.text()).trim();
if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);

const synced = () => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const idle = () => page.waitForFunction(() => !document.querySelector('.tl-stop') && !document.querySelector('[data-pending="true"]'), null, { timeout: 120000 });
const sheet = title => page.getByRole('dialog', { name: title });
const closeSheet = async () => { await page.getByRole('dialog').last().getByRole('button', { name: '关闭' }).click(); await page.waitForTimeout(300); };
const toast = text => page.waitForFunction(t => window.__tlToasts.some(x => x.includes(t)), text, { timeout: 60000 });
const noJargon = async where => {
    const text = await page.evaluate(() => document.body.innerText);
    check(`no “完整版” on ${where}`, !text.includes('完整版'), text.match(/.{0,20}完整版.{0,20}/)?.[0] ?? '');
};

// The story page: grouped menu, short message menu, + only for extensions.
await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: '' })}`);
await synced();
await noJargon('the story page');
await page.locator('.tl-composer-input').fill(`你好${run}`);
await page.getByRole('button', { name: '发送' }).click();
await idle();
await page.locator('.tl-message[data-role="char"]').last().locator('.tl-message-body', { hasText: '模拟回复' }).waitFor({ timeout: 60000 });

await page.getByRole('button', { name: '更多', exact: true }).click();
const storyMenu = await sheet(NAME).innerText();
check('story menu is grouped', ['这个故事', '设置', '其他'].every(t => storyMenu.includes(t)), storyMenu.slice(0, 200));
check('story menu has one way to the character page and none to edit directly',
    await sheet(NAME).getByRole('button', { name: /^角色主页/ }).count() === 1 && await sheet(NAME).getByRole('button', { name: /^编辑角色/ }).count() === 0);
check('story menu says 开始新故事 and what it means', storyMenu.includes('开始新故事') && storyMenu.includes('从头开始'));
await noJargon('the story menu');
await closeSheet();

await page.locator('.tl-message[data-role="char"]').last().locator('.tl-message-menu').click();
const messageItems = await sheet('消息操作').locator('.tl-sheet-item-label').allInnerTexts();
// Like a chat app's long press: copy first, the common edits next, delete last (查看摘录 is under 更多).
check('message menu is short', JSON.stringify(messageItems) === JSON.stringify(['复制', '编辑', '重新生成', '收藏原句', '先留这一版', '换个走向', '更多', '删除']), JSON.stringify(messageItems));
await sheet('消息操作').getByRole('button', { name: /^更多/ }).click();
await sheet('更多').getByText('原版界面里的其他按钮').waitFor({ timeout: 30000 });
check('the rest is under 更多', await sheet('更多').getByRole('button', { name: /^选择文字/ }).count() === 1
    && await sheet('更多').getByRole('button', { name: /^从这条开始分享/ }).count() === 1);
await noJargon('the 更多 sheet');
await closeSheet();

const plus = page.getByRole('button', { name: '扩展功能' });
check('+ is for extension features', await plus.count() === 1);
await plus.click();
check('+ lists only extension features', await sheet('扩展功能').getByRole('button', { name: /^(继续写|换一个回复|重新生成|开始新故事)/ }).count() === 0);
await closeSheet();

// 我的: plain words, advanced things grouped.
await page.evaluate(() => { location.hash = '#me'; });
await page.locator('.tl-me').waitFor();
await noJargon('我的');
const me = await page.locator('.tl-me').innerText();
check('我的 groups advanced settings', me.includes('高级') && me.includes('省流量') && me.lastIndexOf('\n自定义 CSS') > me.indexOf('\n高级\n'), me.slice(0, 400));

// No model service set up: the shelf says so and leads to 开始使用.
savedUrl = await engineEval(w => w.SillyTavern.getContext().chatCompletionSettings.custom_url);
await engineEval(w => {
    const c = w.SillyTavern.getContext();
    const input = w.document.getElementById('custom_api_url_text');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    c.chatCompletionSettings.custom_url = '';
});
await page.evaluate(() => { location.hash = '#'; });
const banner = page.getByRole('button', { name: /^还没连上 AI 模型/ });
await banner.waitFor({ timeout: 15000 }).then(() => check('shelf says no model service is set up', true)).catch(() => check('shelf says no model service is set up', false));
await noJargon('the shelf');
await banner.click();
await page.locator('.tl-setup').waitFor({ timeout: 15000 });
await noJargon('开始使用');
await page.getByRole('radio', { name: /^中转站（OpenAI 格式）/ }).click();
// First an address nobody answers: the page must not call it connected (the app reports any relay as "check
// bypassed", and its status still says the previous service was fine).
await page.getByRole('textbox', { name: '地址' }).fill('http://127.0.0.1:5999/v1');
await page.getByLabel('密钥').fill(`sk-test-${run}`);
// 连接 is enabled once both fields are filled and the app is ready; say which of these is missing if it never is.
await page.waitForFunction(() => [...document.querySelectorAll('.tl-setup button')].some(b => b.textContent === '连接' && !b.disabled), null, { timeout: 120000 })
    .catch(async () => {
        const state = await page.evaluate(() => ({
            url: document.getElementById('tl-setup-url')?.value, key: !!document.getElementById('tl-setup-secret')?.value,
            status: document.querySelector('.tl-setup [role="status"], .tl-setup .tl-engine-status')?.textContent ?? '',
            bridge: !!document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge,
        }));
        throw new Error(`连接 stays disabled: ${JSON.stringify(state)}`);
    });
await page.getByRole('button', { name: '连接', exact: true }).click();
await page.locator('#tl-setup-result').waitFor({ timeout: 60000 });
const unanswered = await page.locator('#tl-setup-result').innerText();
check('an address nobody answers is not called connected', /没连上|没读到模型列表/.test(unanswered) && !unanswered.includes('选一个模型'), unanswered);
check('a relay without a model list asks for the model name', await page.getByRole('textbox', { name: '模型名' }).count() === 1);
await page.getByRole('textbox', { name: '地址' }).fill(MOCK_URL);
await page.getByRole('button', { name: '重新连接', exact: true }).click();
await page.getByRole('radiogroup', { name: '模型', exact: true }).waitFor({ timeout: 60000 })
    .then(() => check('setup connects and lists the models', true)).catch(() => check('setup connects and lists the models', false));
check('the mock model is offered', await page.getByRole('radio', { name: /mock-model/ }).count() >= 1);
await page.getByRole('button', { name: /^试一句/ }).click();
await page.locator('.tl-setup-reply').waitFor({ timeout: 60000 });
check('test sentence comes back', (await page.locator('.tl-setup-reply').innerText()).includes('模拟回复'), await page.locator('.tl-setup-reply').innerText());
const connection = await engineEval(w => { const c = w.SillyTavern.getContext(); return { source: c.chatCompletionSettings.chat_completion_source, url: c.chatCompletionSettings.custom_url, status: c.onlineStatus }; });
check('the full app is connected the same way', connection.source === 'custom' && connection.url === MOCK_URL && connection.status !== 'no_connection', JSON.stringify(connection));
savedUrl = null;
await page.getByRole('button', { name: /^完成，开始聊天/ }).click();
await page.locator('.tl-composer-input').waitFor({ timeout: 15000 })
    .then(() => check('finishing setup opens a story', true)).catch(() => check('finishing setup opens a story', false));
await page.evaluate(() => { location.hash = '#'; });
await page.locator('.tl-character').first().waitFor({ timeout: 15000 });
check('no banner once set up', await page.getByRole('button', { name: /^还没连上 AI 模型/ }).count() === 0);

// A send that cannot reach a model leads to 开始使用 (and keeps the text).
// (Covered by the bridge's no-connection error; the setup page is the same one tested above.)

await cleanup();
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `FAILED: ${problems.join(', ')}` : 'ALL PASS');
await browser.close();
process.exit(problems.length ? 1 : 0);
