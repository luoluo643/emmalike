// 0.11.0 acceptance (second newcomer review): the Chinese sample character and numbered stories ("第 N 个故事"
// instead of a file date), Latin text not justified, choice lists in sheets full width, 中转站 / 默认 instead of the
// app's terms, personas created and edited in the shell, a character's name and picture changed in the editor
// (its stories follow the new name), 高级设置 without what the shell already has, 我的 regrouped, and 开始使用 with
// the services abroad folded away and the key field reached right after choosing.
// Usage: node e2e-m10.mjs <baseUrl> <handle> <password> [latencyMs] [downKbps]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, latency = '200', downKbps = '5000'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `M10测试${run}`;
const RENAMED = `M10改名${run}`;
const PERSONA = `M10身份${run}`;
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

// What the suite made, removed at the end whatever happened.
const made = { avatars: [], persona: '', originalPersona: '' };
const cleanup = async () => {
    for (const a of made.avatars) await post('/api/characters/delete', { avatar_url: a, delete_chats: true }).catch(() => { });
    if (made.persona) {
        await engineEval(async (w, a) => {
            const bridge = w.TavernLiteBridge;
            if (a.original) await bridge.setPersona(a.original, { autoLock: false }).catch(() => { });
            const p = w.SillyTavern.getContext().powerUserSettings;
            delete p.personas[a.persona];
            delete p.persona_descriptions[a.persona];
            w.SillyTavern.getContext().saveSettingsDebounced();
        }, { persona: made.persona, original: made.originalPersona }).catch(() => { });
        await post('/api/avatars/delete', { avatar: made.persona }).catch(() => { });
        await page.waitForTimeout(1500);
    }
};

let failing = false;
process.on('uncaughtException', async error => {
    if (failing) process.exit(3);
    failing = true;
    console.log('FAILURE', error.message.split('\n').slice(0, 12).join(' | '), (error.stack ?? '').split('\n').find(l => l.includes('e2e-m10.mjs')));
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

const synced = () => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const idle = () => page.waitForFunction(() => !document.querySelector('.tl-stop') && !document.querySelector('[data-pending="true"]'), null, { timeout: 120000 });
const sheet = title => page.getByRole('dialog', { name: title });
const closeSheet = async () => { await page.getByRole('dialog').last().getByRole('button', { name: '关闭' }).click(); await page.waitForTimeout(300); };
const toast = text => page.waitForFunction(t => window.__tlToasts.some(x => x.includes(t)), text, { timeout: 60000 });
const chapterTitle = () => page.locator('.tl-chapter').innerText();
const listChats = async avatar => (await (await post('/api/characters/chats', { avatar_url: avatar })).json().catch(() => [])) ?? [];

// --- The Chinese sample character, and numbered stories ------------------------------------------------------------
const sampleBefore = (await (await post('/api/characters/all', {})).json()).filter(c => c.name === '林小满').map(c => c.avatar);
await page.goto(appUrl);
await page.locator('.tl-character').first().waitFor();
await page.getByRole('button', { name: '＋ 添加角色', exact: true }).click();
const addItem = sheet('添加角色').getByRole('button', { name: /^添加示例角色/ });
check('添加 offers the sample while the shelf has none', sampleBefore.length ? await addItem.count() === 0 : await addItem.count() === 1);
check('添加 says which files are character cards', (await sheet('添加角色').innerText()).includes('PNG、JSON'));
if (!sampleBefore.length) {
    await addItem.click();
    await page.locator('.tl-composer-input').waitFor({ timeout: 30000 });
    await synced();
    const listed = (await (await post('/api/characters/all', {})).json()).find(c => c.name === '林小满');
    if (listed) made.avatars.push(listed.avatar);
    const sample = listed ? await (await post('/api/characters/get', { avatar_url: listed.avatar })).json() : null;
    check('the sample is a Chinese character with a picture', !!sample && sample.first_mes.includes('书') && sample.tags?.includes('示例'), JSON.stringify(sample?.tags));
    check('adding the sample opens its first story', await page.locator('.tl-chat-title').innerText() === '林小满');
    await page.waitForFunction(() => document.querySelector('.tl-chapter')?.textContent.includes('第 1 个故事'), null, { timeout: 30000 }).catch(() => { });
    check('its story is called 第 1 个故事', (await chapterTitle()).includes('第 1 个故事'), await chapterTitle());
} else {
    await closeSheet();
}

// A test character with an English greeting, opened in a new story.
const created = await page.request.post(`${base}/api/characters/create`, {
    headers: { 'X-CSRF-Token': token },
    multipart: {
        ch_name: NAME, description: '测试 0.11.0 的角色', first_mes: 'Hello there, traveller. The rain has not stopped for three days, and the road is long.',
        personality: '', scenario: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '',
    },
});
const avatar = (await created.text()).trim();
if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);
made.avatars.push(avatar);
await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: '' })}`);
await page.waitForFunction(n => document.querySelector('.tl-chat-title')?.textContent === n, NAME, { timeout: 60000 });
await synced();
await page.waitForFunction(() => document.querySelector('.tl-chapter')?.textContent.includes('第 1 个故事'), null, { timeout: 30000 }).catch(() => { });
check('an unnamed story shows 第 1 个故事, not a date', (await chapterTitle()).includes('第 1 个故事'), await chapterTitle());
const align = await page.evaluate(() => [...document.querySelectorAll('.tl-message-body')].map(b => ({ cjk: b.dataset.cjk === 'true', align: getComputedStyle(b).textAlign, text: b.textContent.trim().slice(0, 40) })));
check('Latin text is not justified', align.some(a => !a.cjk) && align.filter(a => !a.cjk).every(a => a.align === 'start' || a.align === 'left'), JSON.stringify(align));
await page.locator('.tl-composer-input').fill(`你好${run}`);
await page.getByRole('button', { name: '发送' }).click();
await idle();
await page.locator('.tl-message[data-role="char"]').last().locator('.tl-message-body', { hasText: '模拟回复' }).waitFor({ timeout: 60000 });
const cjkAlign = await page.locator('.tl-message[data-role="char"]').last().locator('.tl-message-body').evaluate(b => ({ cjk: b.dataset.cjk, align: getComputedStyle(b).textAlign }));
check('Chinese text stays justified', cjkAlign.cjk === 'true' && cjkAlign.align === 'justify', JSON.stringify(cjkAlign));

await page.getByRole('button', { name: '更多', exact: true }).click();
await sheet(NAME).getByRole('button', { name: /^开始新故事/ }).click();
await page.waitForFunction(() => !new URLSearchParams(location.hash.slice(1)).has('new'), null, { timeout: 240000 });
await synced();
await page.waitForFunction(() => document.querySelector('.tl-chapter')?.textContent.includes('第 2 个故事'), null, { timeout: 30000 }).catch(() => { });
check('the next story is 第 2 个故事', (await chapterTitle()).includes('第 2 个故事'), await chapterTitle());
await page.getByRole('button', { name: '切换故事' }).click();
await sheet('故事').getByText('第 1 个故事').waitFor({ timeout: 30000 }).catch(() => { });
const stories = await sheet('故事').locator('.tl-sheet-item-label').allInnerTexts();
check('the story list numbers both', stories.some(t => t.includes('第 1 个故事')) && stories.some(t => t.includes('第 2 个故事')), JSON.stringify(stories));
await closeSheet();
// A branch ("换个走向") keeps its story's name instead of becoming another numbered story.
await page.locator('.tl-message').last().locator('.tl-message-menu').click();
await sheet('消息操作').getByRole('button', { name: /^换个走向/ }).click();
await page.waitForFunction(() => decodeURIComponent(location.hash).includes('Branch #'), null, { timeout: 30000 }).catch(() => { });
await synced();
await page.waitForFunction(() => document.querySelector('.tl-chapter')?.textContent.includes('走向'), null, { timeout: 30000 }).catch(() => { });
check('a branch is called 第 2 个故事 · 走向 1', (await chapterTitle()).includes('第 2 个故事 · 走向 1'), await chapterTitle());

// --- Model sheet: full-width choices, plain names ------------------------------------------------------------------
await page.getByRole('button', { name: '更多', exact: true }).click();
await sheet(NAME).getByRole('button', { name: /^模型/ }).click();
const modelSheet = sheet('模型与预设');
await modelSheet.waitFor();
const widths = await modelSheet.evaluate(d => {
    const sheetWidth = d.querySelector('.tl-sheet-body')?.getBoundingClientRect().width ?? d.getBoundingClientRect().width;
    return { sheetWidth, rows: [...d.querySelectorAll('[role="radiogroup"] .tl-sheet-item')].map(r => r.getBoundingClientRect().width) };
});
check('choices in a sheet are full width', widths.rows.length > 0 && widths.rows.every(w => Math.abs(w - widths.sheetWidth) < 2), JSON.stringify(widths));
const modelText = await modelSheet.innerText();
check('the relay is called 中转站', modelText.includes('中转站') && !modelText.includes('自定义接口'), modelText.slice(0, 80));
check('the bundled preset is called 默认', !/^Default/m.test(modelText), modelText.match(/.*Default.*/)?.[0] ?? '');
await closeSheet();

// --- Personas: created and edited in the shell ---------------------------------------------------------------------
made.originalPersona = await engineEval(w => w.TavernLiteBridge.personaList().current);
await page.getByRole('button', { name: '更多', exact: true }).click();
await sheet(NAME).getByRole('button', { name: /^我的身份/ }).click();
await sheet('我的身份').getByRole('button', { name: /^＋ 新建身份/ }).click();
await sheet('新建身份').getByRole('textbox', { name: '身份名字' }).fill(PERSONA);
await sheet('新建身份').getByLabel('介绍（会告诉 AI）').fill('一个测试用的身份');
await sheet('新建身份').getByRole('button', { name: '新建', exact: true }).click();
await toast(`已新建身份「${PERSONA}」`);
const afterCreate = await engineEval(w => {
    const c = w.SillyTavern.getContext();
    const list = w.TavernLiteBridge.personaList();
    return { name: c.name1, id: list.current, description: c.powerUserSettings.persona_description };
});
made.persona = afterCreate.id;
check('a new persona is created and used', afterCreate.name === PERSONA && afterCreate.description === '一个测试用的身份', JSON.stringify(afterCreate));
const picture = await page.evaluate(async id => (await fetch(`/User Avatars/${encodeURIComponent(id)}`, { cache: 'no-store' })).ok, afterCreate.id);
check('the new persona has a picture', picture);
await sheet('我的身份').getByRole('button', { name: new RegExp(`^修改「${PERSONA}」`) }).click();
await sheet(`修改「${PERSONA}」`).getByLabel('介绍（会告诉 AI）').fill('改过的介绍');
await sheet(`修改「${PERSONA}」`).getByRole('button', { name: '保存', exact: true }).click();
await toast('身份已保存');
check('editing a persona reaches the prompt', await engineEval(w => w.SillyTavern.getContext().powerUserSettings.persona_description) === '改过的介绍');
await closeSheet();

// --- Character name and picture from the editor --------------------------------------------------------------------
const chatsBefore = (await listChats(avatar)).length;
await page.goto(`${appUrl}#${new URLSearchParams({ edit: avatar })}`);
await page.locator('#tl-field-name').waitFor({ timeout: 30000 });
check('the editor shows the name', await page.locator('#tl-field-name').inputValue() === NAME);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
await page.locator('.tl-create-head input[type="file"]').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
await page.locator('#tl-field-name').fill(RENAMED);
await page.getByRole('button', { name: '保存', exact: true }).click();
await toast(`名字改成了「${RENAMED}」`);
await page.waitForFunction(old => !location.hash.includes(encodeURIComponent(old)), avatar, { timeout: 30000 }).catch(() => { });
const all = await (await post('/api/characters/all', {})).json();
const renamed = all.find(c => c.name === RENAMED);
if (renamed) made.avatars.push(renamed.avatar);
check('the character is renamed', !!renamed && !all.some(c => c.avatar === avatar), JSON.stringify(renamed?.avatar));
check('its stories follow the new name', !!renamed && (await listChats(renamed.avatar)).length === chatsBefore, `${chatsBefore}`);
const size = renamed ? await page.evaluate(async a => {
    const blob = await (await fetch(`/characters/${encodeURIComponent(a)}`, { cache: 'no-store' })).blob();
    const bitmap = await createImageBitmap(blob);
    return [bitmap.width, bitmap.height];
}, renamed.avatar) : [];
check('the picture is replaced (cropped to 400×600)', JSON.stringify(size) === '[400,600]', JSON.stringify(size));
await page.waitForFunction(n => document.querySelector('#tl-field-name')?.value === n, RENAMED, { timeout: 15000 }).catch(() => { });
check('the editor reopens on the renamed character', await page.locator('#tl-field-name').inputValue().catch(() => '') === RENAMED);
// Renaming onto a name another character has asks first.
const otherName = (await (await post('/api/characters/all', {})).json()).find(c => c.name !== RENAMED)?.name;
if (otherName) {
    await page.locator('#tl-field-name').fill(otherName);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await sheet('已经有同名的角色').waitFor({ timeout: 15000 }).then(() => check('renaming onto an existing name asks first', true))
        .catch(() => check('renaming onto an existing name asks first', false));
    await closeSheet();
    await page.locator('#tl-field-name').fill(RENAMED);
}

// --- 我的 and 高级设置 --------------------------------------------------------------------------------------------
await page.goto(`${appUrl}#me`);
await page.locator('.tl-me').waitFor();
const me = await page.locator('.tl-me').innerText();
check('theme import and export are under 外观', me.indexOf('导入主题') > me.indexOf('外观') && me.indexOf('导出主题') < me.indexOf('高级'), '');
check('no engine timing on 我的', !me.includes('这次准备用了'));
await page.getByRole('button', { name: /^设置与扩展/ }).click();
const tools = await sheet('设置与扩展').innerText();
check('高级设置 leaves out what the shell has', !['角色与导入', '模型接口', '我的人设'].some(t => tools.includes(t)), tools.slice(0, 200));
check('高级设置 hints are in Chinese', !/World Info|Persona/.test(tools));
await closeSheet();

// --- 开始使用: abroad folded, the key next ------------------------------------------------------------------------
await page.goto(`${appUrl}#setup`);
await page.locator('.tl-setup').waitFor();
check('services abroad are folded', await page.getByRole('radio', { name: /^Claude/ }).count() === 0 && await page.getByRole('button', { name: /^更多服务/ }).count() === 1);
await page.getByRole('radio', { name: /^DeepSeek/ }).click();
await page.waitForFunction(() => document.activeElement?.id === 'tl-setup-secret', null, { timeout: 5000 }).catch(() => { });
check('choosing a service moves to its key', await page.evaluate(() => document.activeElement?.id) === 'tl-setup-secret');
check('a chosen service says 已选, not 正在用', await page.evaluate(() => getComputedStyle(document.querySelector('.tl-choice-row[aria-checked="true"] .tl-sheet-item-label'), '::after').content).then(c => c.includes('已选')));
await page.getByRole('button', { name: /^更多服务/ }).click();
check('更多服务 shows the rest', await page.getByRole('radio', { name: /^Claude/ }).count() === 1);
await page.getByRole('button', { name: '先跳过' }).click();

await cleanup();
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `FAILED: ${problems.join(', ')}` : 'ALL PASS');
await browser.close();
process.exit(problems.length ? 1 : 0);
