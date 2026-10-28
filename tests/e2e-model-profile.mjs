// The model list and the connection profile in use say the same: a model chosen in the shell while a profile is in use
// is saved into that profile, and a model changed elsewhere (the full app) shows under the profile as the one in use,
// with the saved one named. Usage: node e2e-model-profile.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `模型配置测试${run}`;
const PROFILE = `测试配置${run}`;
const OTHER = `mock-model-b${run}`;
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
let avatar = '', profileId = '', modelBefore = null;

const cleanup = async () => {
    await engineEval(async (w, a) => {
        const c = w.SillyTavern.getContext();
        const manager = c.extensionSettings.connectionManager;
        const select = w.document.getElementById('connection_profiles');
        if (manager && manager.selectedProfile === a.profile && select) { select.value = ''; select.dispatchEvent(new Event('change')); }
        if (manager) manager.profiles = (manager.profiles ?? []).filter(p => p.id !== a.profile);
        w.document.querySelector(`#connection_profiles option[value="${a.profile}"]`)?.remove();
        if (a.model !== null) {
            const input = w.document.getElementById('custom_model_id');
            input.value = a.model;
            input.dispatchEvent(new Event('input'));
            const models = w.document.getElementById('model_custom_select');
            if (models) models.value = a.model;
        }
        w.document.querySelector(`#model_custom_select option[value="${a.other}"]`)?.remove();
        c.saveSettingsDebounced();
    }, { profile: profileId, model: modelBefore, other: OTHER }).catch(() => { });
    await page.waitForTimeout(2500);
    if (avatar) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
};

let failing = false;
process.on('uncaughtException', async error => {
    if (failing) process.exit(3);
    failing = true;
    console.log('FAILURE', error.message.split('\n').slice(0, 12).join(' | '), (error.stack ?? '').split('\n').find(l => l.includes('e2e-model-profile.mjs')));
    console.log(JSON.stringify({ toasts: await page.evaluate(() => window.__tlToasts).catch(() => null), results, pageErrors }, null, 1));
    if (process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT }).catch(() => { });
    await cleanup();
    await browser.close();
    process.exit(2);
});

if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const created = await page.request.post(`${base}/api/characters/create`, {
    headers: { 'X-CSRF-Token': token },
    multipart: {
        ch_name: NAME, description: '测试模型与连接配置', first_mes: '“你来了。”', personality: '', scenario: '', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '',
    },
});
avatar = (await created.text()).trim();
if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);

await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: '' })}`);
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const sheet = title => page.getByRole('dialog', { name: title });
const closeSheet = async () => { await page.getByRole('dialog').last().getByRole('button', { name: '关闭' }).click(); await page.waitForTimeout(500); };
const toast = text => page.waitForFunction(t => window.__tlToasts.some(x => x.includes(t)), text, { timeout: 30000 });
const openModels = async () => {
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await sheet(NAME).getByRole('button', { name: /^模型：/ }).click();
    const modelSheet = sheet('模型与预设');
    await modelSheet.waitFor();
    return modelSheet;
};
const profileRow = s => s.getByRole('radiogroup', { name: '连接' }).getByRole('radio', { name: new RegExp(PROFILE) });
const saved = () => engineEval((w, id) => {
    const c = w.SillyTavern.getContext();
    return { model: c.extensionSettings.connectionManager.profiles.find(p => p.id === id)?.model ?? null, current: c.chatCompletionSettings.custom_model, selected: c.extensionSettings.connectionManager.selectedProfile };
}, profileId);

// A profile made from the current connection (the mock relay) and applied, as the full app's own commands do; then a
// second model in the app's model list (the mock lists one; it answers whatever model is asked for).
modelBefore = await engineEval(w => w.SillyTavern.getContext().chatCompletionSettings.custom_model);
profileId = await engineEval(async (w, a) => {
    const c = w.SillyTavern.getContext();
    if (!w.document.getElementById('connection_profiles')) return '';
    c.extensionSettings.connectionManager ??= { profiles: [], selectedProfile: null };
    await c.executeSlashCommandsWithOptions(`/profile-create ${a.name}`);
    return c.extensionSettings.connectionManager.profiles.find(p => p.name === a.name)?.id ?? '';
}, { name: PROFILE });
if (!profileId) throw new Error('no connection profile could be made');
const addOther = () => engineEval((w, other) => {
    const select = w.document.getElementById('model_custom_select');
    if (!select.querySelector(`option[value="${other}"]`)) select.append(new w.Option(other, other));
}, OTHER);
await addOther();
check('profile made on the mock model', (await saved()).model === modelBefore, JSON.stringify(await saved()));

// 1. The model changed in the full app, the profile not updated: the profile row shows the model in use and the saved one.
await engineEval((w, other) => {
    const select = w.document.getElementById('model_custom_select');
    select.value = other;
    select.dispatchEvent(new Event('change'));
}, OTHER);
await page.waitForTimeout(800);
let s = await openModels();
let hint = await profileRow(s).locator('.tl-sheet-item-hint').textContent();
check('drifted profile shows the model in use first', hint.startsWith(OTHER), hint);
check('drifted profile names the saved model', hint.includes(`配置里存的是 ${modelBefore}`), hint);
check('model list marks the model in use', await s.getByRole('radiogroup', { name: '模型' }).getByRole('radio', { name: OTHER }).getAttribute('aria-checked') === 'true');

// 2. Choosing a model in the shell saves it into the profile in use; the row then shows just that model.
await s.getByRole('radiogroup', { name: '模型' }).getByRole('radio', { name: modelBefore, exact: true }).click();
await toast(`已存进连接「${PROFILE}」`);
let state = await saved();
check('chosen model saved into the profile', state.model === modelBefore && state.current === modelBefore && state.selected === profileId, JSON.stringify(state));
hint = await profileRow(s).locator('.tl-sheet-item-hint').textContent();
check('profile row shows the chosen model only', hint === modelBefore, hint);
await closeSheet();

await addOther();
s = await openModels();
await s.getByRole('radiogroup', { name: '模型' }).getByRole('radio', { name: OTHER }).click();
await page.waitForFunction(t => window.__tlToasts.filter(x => x.includes(t)).length >= 2, `已存进连接「${PROFILE}」`, { timeout: 30000 });
state = await saved();
check('second choice saved too', state.model === OTHER && state.current === OTHER, JSON.stringify(state));
hint = await profileRow(s).locator('.tl-sheet-item-hint').textContent();
check('profile row follows', hint === OTHER, hint);
check('profile still the one in use', await profileRow(s).getAttribute('aria-checked') === 'true');
await closeSheet();

// 3. No profile in use: choosing a model changes no profile.
await engineEval(w => { const select = w.document.getElementById('connection_profiles'); select.value = ''; select.dispatchEvent(new Event('change')); });
await page.waitForTimeout(1500);
await addOther();
s = await openModels();
const toastsBefore = await page.evaluate(() => window.__tlToasts.length);
await s.getByRole('radiogroup', { name: '模型' }).getByRole('radio', { name: modelBefore, exact: true }).click();
await page.waitForFunction(n => window.__tlToasts.length > n, toastsBefore, { timeout: 30000 });
const last = await page.evaluate(() => window.__tlToasts.at(-1));
state = await saved();
check('without a profile the model changes alone', state.model === OTHER && state.current === modelBefore && !state.selected, JSON.stringify(state));
check('without a profile the message names no profile', !last.includes('已存进连接'), last);
await closeSheet();

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await cleanup();
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS ${problems.join(', ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
