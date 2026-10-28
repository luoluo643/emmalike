// Deleting in the shell, on a phone, each asked first: presets (换预设 and 模型与预设 → 删除预设…), connection profiles
// (模型与预设 → 删除连接…), personas (我的身份 → 删除「…」) and world books (a book's page → 删除这本世界书).
// Checked on the server afterwards; the one in use moves on to another; 取消 deletes nothing.
// Usage: node e2e-delete-things.mjs <baseUrl> <handle> <password> [shotPath]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, shotArg = ''] = process.argv.slice(2);
const shot = /.png$/.test(shotArg) ? shotArg : '';
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const AVATAR = 'default_Seraphina.png';
const run = Date.now().toString(36);
const PRESETS = [`删测预设A${run}`, `删测预设B${run}`];
const BOOK = `删测世界书${run}`;
const PROFILE = `删测连接${run}`;
const PERSONAS = [`删测身份甲${run}`, `删测身份乙${run}`];
const STORY = `del-${run}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.message ?? e).slice(0, 200)));
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const { token } = await (await context.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => context.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const settings = async () => {
    const json = await (await post('/api/settings/get', {})).json();
    return { ...json, parsed: JSON.parse(json.settings) };
};
const personaIds = [];

const engineEval = (fn, arg) => page.evaluate(([source, value]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'value', `return (${source})(w, value);`)(w, value);
}, [fn.toString(), arg]);

let crashed = false;
const cleanup = async () => {
    for (const name of PRESETS) await post('/api/presets/delete', { apiId: 'openai', name }).catch(() => { });
    await post('/api/worldinfo/delete', { name: BOOK }).catch(() => { });
    await post('/api/chats/delete', { chatfile: `${STORY}.jsonl`, avatar_url: AVATAR }).catch(() => { });
    await engineEval(async (w, a) => {
        const c = w.SillyTavern.getContext();
        const manager = c.extensionSettings.connectionManager;
        if (manager) manager.profiles = (manager.profiles ?? []).filter(p => p.name !== a.profile);
        for (const id of a.personas) {
            if (!(id in (c.powerUserSettings.personas ?? {}))) continue;
            await w.TavernLiteBridge.deletePersona(id).catch(() => { });
        }
        c.saveSettingsDebounced();
    }, { profile: PROFILE, personas: personaIds }).catch(() => { });
    await page.waitForTimeout(1500);
};
process.on('uncaughtException', async error => {
    if (crashed) return;
    crashed = true;
    console.log('FAILURE', error.message.split('\n')[0], (error.stack ?? '').split('\n').find(l => l.includes('e2e-delete-things')));
    if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-fail.png') }).catch(() => { });
    await cleanup();
    await browser.close().catch(() => { });
    process.exit(2);
});

// Before the page loads, so the full app lists them: two preset copies of the current settings (switching between
// them changes nothing other suites rely on), a world book, a story.
const current = (await settings()).parsed.oai_settings;
for (const name of PRESETS) if (!(await post('/api/presets/save', { apiId: 'openai', name, preset: current })).ok()) throw new Error('preset not saved');
check('world book saved', (await post('/api/worldinfo/edit', { name: BOOK, data: { entries: { 0: { uid: 0, key: ['测试'], content: '测试条目', comment: '一条', constant: false, disable: false } } } })).ok());
const story = [{ user_name: 'unused', character_name: 'unused', chat_metadata: {} }];
for (let i = 0; i < 4; i++) story.push({ name: i % 2 ? 'User' : 'Seraphina', is_user: i % 2 === 1, is_system: false, send_date: new Date().toISOString(), extra: {}, mes: `删除测试第 ${i} 段。` });
check('story saved', (await post('/api/chats/save', { ch_name: 'Seraphina', file_name: STORY, chat: story, avatar_url: AVATAR })).ok());

await page.goto(`${appUrl}#chat=${encodeURIComponent(AVATAR)}&file=${encodeURIComponent(STORY)}`);
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
await page.waitForTimeout(1000);
// Two personas (the second in use), a connection profile (not selected), preset A in use.
const prepared = await engineEval(async (w, a) => {
    const bridge = w.TavernLiteBridge;
    const c = w.SillyTavern.getContext();
    const picture = await (await fetch('/img/ai4.png')).blob().catch(() => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }));
    const ids = [];
    for (const name of a.personas) ids.push(await bridge.createPersona({ name, description: '删除测试', image: picture }));
    await bridge.setPersona(ids[1], { autoLock: false });
    c.extensionSettings.connectionManager ??= { profiles: [], selectedProfile: null };
    const select = w.document.getElementById('connection_profiles');
    let profile = '';
    if (select) {
        await c.executeSlashCommandsWithOptions(`/profile-create ${a.profile}`);
        profile = c.extensionSettings.connectionManager.profiles.find(p => p.name === a.profile)?.id ?? '';
        select.value = '';
        select.dispatchEvent(new Event('change'));
    }
    const presets = w.document.getElementById('settings_preset_openai');
    const optionA = [...presets.options].find(o => o.textContent.trim() === a.presets[0]);
    presets.value = optionA.value;
    presets.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1500));
    return { ids, profile, current: bridge.personaList().current };
}, { personas: PERSONAS, profile: PROFILE, presets: PRESETS });
personaIds.push(...prepared.ids);
check('fixtures ready: two personas, the second in use, and a profile', prepared.ids.length === 2 && prepared.current === prepared.ids[1] && !!prepared.profile, JSON.stringify(prepared));

const storyMenu = async () => {
    await page.getByRole('button', { name: '更多', exact: true }).click();
    const sheet = page.getByRole('dialog').filter({ hasText: '这个故事' });
    await sheet.waitFor();
    return sheet;
};
const dialog = name => page.getByRole('dialog', { name });
const presetNames = async () => (await settings()).openai_setting_names ?? [];

// --- Presets: 取消 first, then delete the one in use ----------------------------------------------------------
await (await storyMenu()).getByRole('button', { name: /^预设：/ }).click();
await dialog('换预设').getByRole('button', { name: /^删除预设/ }).click();
const presetList = dialog('删除预设');
await presetList.waitFor();
check('删除预设 lists the presets, marking the one in use', (await presetList.innerText()).includes(PRESETS[0]) && /正在用/.test(await presetList.getByRole('button', { name: new RegExp(`^${PRESETS[0]}`) }).innerText()));
await presetList.getByRole('button', { name: new RegExp(`^${PRESETS[1]}`) }).click();
await dialog(`删除「${PRESETS[1]}」？`).getByRole('button', { name: '取消' }).click();
await page.waitForTimeout(500);
check('取消 deletes nothing', (await presetNames()).includes(PRESETS[1]));
await presetList.getByRole('button', { name: new RegExp(`^${PRESETS[0]}`) }).click();
const presetConfirm = dialog(`删除「${PRESETS[0]}」？`);
check('deleting the preset in use says it switches', (await presetConfirm.innerText()).includes('正在用'));
if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-preset.png') });
await presetConfirm.getByRole('button', { name: '删除', exact: true }).click();
await page.locator('.tl-toast').filter({ hasText: `已删除「${PRESETS[0]}」` }).first().waitFor({ timeout: 20000 });
let names = await presetNames();
check('preset gone from the server, the other kept', !names.includes(PRESETS[0]) && names.includes(PRESETS[1]), names.filter(n => n.includes(run)).join(', '));
const presetNow = await engineEval(w => w.document.getElementById('settings_preset_openai').selectedOptions[0]?.textContent.trim());
check('another preset is in use', !!presetNow && presetNow !== PRESETS[0], presetNow);
check('back on 换预设 without the deleted one', await dialog('换预设').isVisible() && !(await dialog('换预设').innerText()).includes(PRESETS[0]));
await dialog('换预设').getByRole('button', { name: '关闭' }).click();

// --- 模型与预设: delete the other preset copy and the connection profile ------------------------------------------
await (await storyMenu()).getByRole('button', { name: /^模型：/ }).click();
const model = dialog('模型与预设');
await model.waitFor();
await model.getByRole('button', { name: /^删除预设/ }).click();
await dialog('删除预设').getByRole('button', { name: new RegExp(`^${PRESETS[1]}`) }).click();
await dialog(`删除「${PRESETS[1]}」？`).getByRole('button', { name: '删除', exact: true }).click();
await page.locator('.tl-toast').filter({ hasText: `已删除「${PRESETS[1]}」` }).first().waitFor({ timeout: 20000 });
check('模型与预设 deletes a preset too', !(await presetNames()).includes(PRESETS[1]));
await model.waitFor();
await model.getByRole('button', { name: /^删除连接/ }).click();
const profiles = dialog('删除连接');
await profiles.waitFor();
await profiles.getByRole('button', { name: new RegExp(`^${PROFILE}`) }).click();
await dialog(`删除「${PROFILE}」？`).getByRole('button', { name: '删除', exact: true }).click();
await page.locator('.tl-toast').filter({ hasText: `已删除「${PROFILE}」` }).first().waitFor({ timeout: 20000 });
check('profile gone in the full app', await engineEval((w, id) => !w.SillyTavern.getContext().extensionSettings.connectionManager.profiles.some(p => p.id === id)
    && !w.document.querySelector(`#connection_profiles option[value="${id}"]`), prepared.profile));
check('模型与预设 no longer lists it', !(await model.innerText()).includes(PROFILE));
await page.waitForTimeout(3000);
check('profile gone on the server', !((await settings()).parsed.extension_settings?.connectionManager?.profiles ?? []).some(p => p.name === PROFILE));
await model.getByRole('button', { name: '关闭' }).click();

// --- Persona: delete the one in use -------------------------------------------------------------------------------
await (await storyMenu()).getByRole('button', { name: /^我的身份：/ }).click();
const personaSheet = dialog('我的身份');
await personaSheet.waitFor();
await personaSheet.getByRole('button', { name: `删除「${PERSONAS[1]}」` }).click();
const personaConfirm = dialog(`删除「${PERSONAS[1]}」？`);
await personaConfirm.waitFor();
if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-persona.png') });
await personaConfirm.getByRole('button', { name: '删除', exact: true }).click();
await page.locator('.tl-toast').filter({ hasText: `已删除「${PERSONAS[1]}」` }).first().waitFor({ timeout: 20000 });
const afterPersona = await engineEval((w, id) => ({ list: Object.keys(w.SillyTavern.getContext().powerUserSettings.personas), current: w.TavernLiteBridge.personaList().current, deleted: id }), prepared.ids[1]);
check('persona gone and another in use', !afterPersona.list.includes(prepared.ids[1]) && afterPersona.current && afterPersona.current !== prepared.ids[1], JSON.stringify(afterPersona));
const files = await (await post('/api/avatars/get', {})).json();
check('persona picture gone on the server', !files.includes(prepared.ids[1]) && files.includes(prepared.ids[0]));
check('the sheet lists it no more', !(await personaSheet.innerText()).includes(PERSONAS[1]));
await personaSheet.getByRole('button', { name: '关闭' }).click();

// --- World book -------------------------------------------------------------------------------------------------------
await page.evaluate(book => { location.hash = '#' + new URLSearchParams({ world: book }).toString(); }, BOOK);
const deleteBook = page.getByRole('button', { name: /^删除这本世界书/ });
await deleteBook.waitFor({ timeout: 30000 });
await deleteBook.click();
const bookConfirm = dialog(`删除「${BOOK}」？`);
await bookConfirm.waitFor();
check('the confirmation says how many entries go', (await bookConfirm.innerText()).includes('1 条条目'));
if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-world.png') });
await bookConfirm.getByRole('button', { name: '删除', exact: true }).click();
await page.waitForFunction(() => location.hash === '#worlds', null, { timeout: 20000 }).catch(() => { });
check('back on the world book list', await page.evaluate(() => location.hash) === '#worlds');
check('world book gone on the server', !((await settings()).world_names ?? []).includes(BOOK));
check('the list shows it no more', !(await page.locator('.tl-worlds').innerText()).includes(BOOK));

await cleanup();
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
console.log(failed ? `FAILURE ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
