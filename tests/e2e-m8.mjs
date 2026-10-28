// 0.9.0 acceptance: settings read once while the full app loads, installable as an app (manifest, icons), screen kept
// on while a reply is written and the tab title says when it is done, the reply reminder, quick model / preset
// switching, persona and default persona from "我的", favourites / export / delete on the bookshelf, chapter search
// (names and the text inside), export as text and long picture, and the login page when the session ends.
// Needs the fixture extension (tests/prepare.sh). Usage: node e2e-m8.mjs <baseUrl> <handle> <password> [latencyMs] [downKbps]
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, latency = '200', downKbps = '5000'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `M8测试${run}`;
const DOOMED = `M8删除${run}`;
const PERSONA = `tltest8-${run}.png`;
let profileId = '';
const results = {};
const problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`; if (!ok) problems.push(name); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
await context.grantPermissions(['notifications'], { origin: base });
await context.addInitScript(() => {
    window.__tlToasts = [];
    new MutationObserver(rs => { for (const r of rs) for (const n of r.addedNodes) if (n.classList?.contains('tl-toast')) window.__tlToasts.push(n.textContent); })
        .observe(document, { childList: true, subtree: true });
    // Screen wake lock and page visibility, observable and switchable from the test.
    if (location.pathname.includes('/emmalike/app/')) {
        window.__wake = [];
        Object.defineProperty(navigator, 'wakeLock', {
            configurable: true,
            value: {
                request: async type => {
                    const sentinel = new EventTarget();
                    sentinel.type = type;
                    sentinel.release = async () => { window.__wake.push('release'); sentinel.dispatchEvent(new Event('release')); };
                    window.__wake.push('request');
                    return sentinel;
                },
            },
        });
        window.__hidden = false;
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') });
    }
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
const settingsReads = [];
page.on('request', r => { if (r.url().includes('/api/settings/get')) settingsReads.push(r.frame()?.url() ?? ''); });

const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
const avatars = [];
let originalPersona = null;
const engineEval = (fn, arg) => page.evaluate(([source, a]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'a', `return (${source})(w, a);`)(w, a);
}, [fn.toString(), arg]);

const cleanup = async () => {
    await engineEval(async (w, a) => {
        const c = w.SillyTavern.getContext();
        const manager = c.extensionSettings.connectionManager;
        if (manager) {
            if (manager.selectedProfile === a.profile) {
                const select = w.document.getElementById('connection_profiles');
                if (select) { select.value = ''; select.dispatchEvent(new Event('change')); }
            }
            manager.profiles = (manager.profiles ?? []).filter(p => p.id !== a.profile);
            w.document.querySelector(`#connection_profiles option[value="${a.profile}"]`)?.remove();
        }
        if (a.original !== null) {
            await w.TavernLiteBridge.setPersona(a.original, { autoLock: false, isDefault: false }).catch(() => { });
            const p = c.powerUserSettings;
            delete p.personas[a.persona];
            delete p.persona_descriptions[a.persona];
        }
        c.saveSettingsDebounced();
    }, { profile: profileId, original: originalPersona, persona: PERSONA }).catch(() => { });
    await page.evaluate(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); }).catch(() => { });
    await page.waitForTimeout(1500);
    const { token: fresh } = await (await page.request.get(`${base}/csrf-token`)).json().catch(() => ({ token }));
    for (const name of PRESETS) await page.request.post(`${base}/api/presets/delete`, { headers: { 'X-CSRF-Token': fresh }, data: { apiId: 'openai', name } }).catch(() => { });
    for (const a of avatars) await page.request.post(`${base}/api/characters/delete`, { headers: { 'X-CSRF-Token': fresh }, data: { avatar_url: a, delete_chats: true } }).catch(() => { });
};

let failing = false;
process.on('uncaughtException', async error => {
    // An error while reporting or cleaning up must not start the report again.
    if (failing) process.exit(3);
    failing = true;
    console.log('FAILURE', error.message.split('\n').slice(0, 12).join(' | '), (error.stack ?? '').split('\n').find(l => l.includes('e2e-m8.mjs')));
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

const create = async name => {
    const created = await page.request.post(`${base}/api/characters/create`, {
        headers: { 'X-CSRF-Token': token },
        multipart: {
            ch_name: name, description: '测试 0.9.0 的角色', first_mes: '“你来了。”', personality: '', scenario: '', mes_example: '',
            creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '',
        },
    });
    const avatar = (await created.text()).trim();
    if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);
    avatars.push(avatar);
    return avatar;
};
// Two chat completion presets that are copies of the current settings: switching between them changes nothing the
// other suites rely on (a preset can carry the connection; the instance's own "Default" would point it elsewhere).
const PRESETS = [`测试预设A${run}`, `测试预设B${run}`];
const current = JSON.parse((await (await post('/api/settings/get', {})).json()).settings).oai_settings;
for (const name of PRESETS) {
    if (!(await post('/api/presets/save', { apiId: 'openai', name, preset: current })).ok()) throw new Error('preset not saved');
}
const avatar = await create(NAME);
const doomed = await create(DOOMED);

// Six chapters, so the search box shows; one has a word in the middle of its text.
const SECRET = `月光石${run}`;
for (let i = 0; i < 6; i++) {
    const meta = { user_name: 'User', character_name: NAME, create_date: new Date().toISOString(), chat_metadata: {} };
    const lines = [{ name: NAME, is_user: false, mes: `第 ${i} 章的开头`, send_date: new Date().toISOString(), extra: {} }];
    lines.push({ name: 'User', is_user: true, mes: i === 3 ? `口袋里有一块${SECRET}` : '普通的一句话', send_date: new Date().toISOString(), extra: {} });
    lines.push({ name: NAME, is_user: false, mes: `第 ${i} 章的结尾`, send_date: new Date().toISOString(), extra: {} });
    const saved = await post('/api/chats/save', { ch_name: NAME, file_name: `章节${i}-${run}`, avatar_url: avatar, chat: [meta, ...lines], force: true });
    if (!saved.ok()) throw new Error(`chat not saved: ${saved.status()}`);
}

const synced = () => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const idle = () => page.waitForFunction(() => !document.querySelector('.tl-stop') && !document.querySelector('[data-pending="true"]'), null, { timeout: 120000 });
const sheet = title => page.getByRole('dialog', { name: title });
const closeSheet = async () => { await page.getByRole('dialog').last().getByRole('button', { name: '关闭' }).click(); await page.waitForTimeout(300); };
// A sheet that closed removes its history entry a moment later; navigating before that would be undone by it.
const settled = async () => {
    await page.waitForFunction(() => !history.state?.tlLayer && !document.querySelector('[role="dialog"]'), null, { timeout: 10000 }).catch(() => { });
    await page.waitForTimeout(300);
};
const toast = text => page.waitForFunction(t => window.__tlToasts.some(x => x.includes(t)), text, { timeout: 60000 });

// Installable: manifest and icons.
const manifest = await (await page.request.get(`${appUrl}manifest.webmanifest`)).json().catch(() => null);
check('manifest served', manifest?.name === '轻酒馆' && manifest.display === 'standalone' && manifest.start_url === './', JSON.stringify(manifest));
const iconTypes = await Promise.all(['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']
    .map(async f => (await page.request.get(`${appUrl}${f}`)).headers()['content-type']));
check('icons served', iconTypes.every(t => t?.startsWith('image/png')), iconTypes.join(', '));

// Open a story; while the full app loads, the account settings are read once.
await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: '' })}`);
await synced();
await page.waitForTimeout(3000);
check('settings read once while the full app loads', settingsReads.length === 1, `${settingsReads.length} reads`);
check('the page links its manifest', await page.locator('link[rel="manifest"]').count() === 1);

// Screen kept on while the reply is written; done while away → the title says so, and goes back on return.
await page.evaluate(() => { window.__wake.length = 0; });
await page.locator('.tl-composer-input').fill(`【思考】慢慢想${run}`);
await page.getByRole('button', { name: '发送' }).click();
await page.locator('.tl-stop').waitFor({ timeout: 60000 });
await page.waitForTimeout(400);
check('screen kept on while generating', (await page.evaluate(() => window.__wake)).includes('request'));
await page.evaluate(() => { window.__hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
await idle();
await page.waitForTimeout(500);
check('screen lock released when done', (await page.evaluate(() => window.__wake)).includes('release'));
check('title says the reply is ready while away', (await page.title()).startsWith('（回复写好了）'), await page.title());
await page.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
check('title back to normal on return', !(await page.title()).includes('回复写好了'), await page.title());

// Found on an Android phone: after a reply the full app focused its own (hidden) input, which opened the keyboard
// for an invisible box; pulling down at the top reloaded the page; a long press also selected text under the menu.
const focusAfterReply = await engineEval(w => { const a = w.document.activeElement; return a ? `${a.tagName}#${a.id}` : ''; });
check('hidden full app keeps no input focused after a reply', !/TEXTAREA|INPUT/.test(focusAfterReply), focusAfterReply);
check('no pull-to-refresh', await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY) === 'none');
const touchSelect = await page.evaluate(() => [matchMedia('(pointer: coarse)').matches, getComputedStyle(document.querySelector('.tl-message')).userSelect]);
check('messages not selectable by long press on touch screens', !touchSelect[0] || touchSelect[1] === 'none', JSON.stringify(touchSelect));
await page.locator('.tl-message[data-role="char"]').last().locator('.tl-message-menu').click();
await sheet('消息操作').waitFor();
// The sheet moves the focus after it is painted; give it a moment, then no button inside it may hold the focus.
await page.waitForFunction(() => document.activeElement?.closest('.tl-sheet'), null, { timeout: 3000 }).catch(() => { });
const sheetFocus = await page.evaluate(() => { const a = document.activeElement; return `${a?.tagName}.${a?.className}`; });
check('sheet opened by touch shows no focus ring on its first button', !/^BUTTON/.test(sheetFocus) || !sheetFocus.includes('tl-sheet'), sheetFocus);
await closeSheet();

// Quick model switching: a connection profile and a preset.
const presetBefore = await engineEval(w => {
    const c = w.SillyTavern.getContext();
    c.extensionSettings.connectionManager ??= { profiles: [], selectedProfile: null };
    return w.document.getElementById('settings_preset_openai')?.value ?? null;
});
// Start on preset copy A (before the profile is made, so the profile records the copy); the shell later switches to B.
const presetValues = await engineEval((w, names) => {
    const select = w.document.getElementById('settings_preset_openai');
    const values = names.map(n => [...(select?.options ?? [])].find(o => o.textContent.trim() === n)?.value ?? null);
    if (values[0]) { select.value = values[0]; select.dispatchEvent(new Event('change')); }
    return values;
}, PRESETS);
await page.waitForTimeout(1500);
// A profile made from the current connection (the mock model), as the full app's own command makes it, so applying
// it changes nothing the other suites rely on.
const profileAdded = await engineEval(async (w, a) => {
    const c = w.SillyTavern.getContext();
    if (!w.document.getElementById('connection_profiles')) return false;
    await c.executeSlashCommandsWithOptions(`/profile-create ${a.name}`);
    const made = c.extensionSettings.connectionManager.profiles.find(p => p.name === a.name);
    if (!made) return false;
    // Start from "no profile", so choosing it in the shell is a real switch.
    const select = w.document.getElementById('connection_profiles');
    select.value = '';
    select.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1000));
    return made.id;
}, { name: `测试配置${run}` });
if (profileAdded) profileId = profileAdded;
await page.getByRole('button', { name: '更多', exact: true }).click();
await sheet(NAME).getByRole('button', { name: /^模型：/ }).click();
const modelSheet = sheet('模型与预设');
await modelSheet.waitFor();
if (profileAdded) {
    await modelSheet.getByRole('radio', { name: new RegExp(`测试配置${run}`) }).click();
    await toast(`测试配置${run}`).catch(() => { });
    check('connection profile switched', await engineEval((w, id) => w.SillyTavern.getContext().extensionSettings.connectionManager.selectedProfile === id, profileId));
} else {
    check('connection profile switched', false, 'no profile select in the full app');
}
await closeSheet();
if (presetValues.every(Boolean)) {
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await sheet(NAME).getByRole('button', { name: /^模型：/ }).click();
    await sheet('模型与预设').getByRole('radio', { name: new RegExp(`^${PRESETS[1]}`) }).click();
    await toast(PRESETS[1]).catch(() => { });
    const now = await engineEval(w => w.document.getElementById('settings_preset_openai').value);
    check('preset switched', now === presetValues[1], `${presetValues.join('/')} -> ${now}`);
    await closeSheet();
} else {
    check('preset switched', false, `presets missing: ${presetValues}`);
}
// The instance's own preset is selected again without applying it (the settings in use are the same copy).
await engineEval((w, v) => {
    const select = w.document.getElementById('settings_preset_openai');
    select.value = v;
    const c = w.SillyTavern.getContext();
    c.chatCompletionSettings.preset_settings_openai = select.selectedOptions[0]?.textContent.trim() ?? c.chatCompletionSettings.preset_settings_openai;
    c.saveSettingsDebounced();
}, presetBefore);

// Export: text file and long picture.
await page.getByRole('button', { name: '更多', exact: true }).click();
await sheet(NAME).getByRole('button', { name: /^分享这个故事/ }).click();
await sheet('分享').getByRole('radio', { name: /^整章/ }).waitFor({ timeout: 30000 });
await sheet('分享').getByRole('radio', { name: /^整章/ }).click();
const [textDownload] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), sheet('分享').getByRole('button', { name: /^文本文件/ }).click()]);
const text = await readFile(await textDownload.path(), 'utf8');
check('export as text has the story', text.includes(`慢慢想${run}`) && text.includes('模拟回复') && text.startsWith(NAME), text.slice(0, 120));
await page.getByRole('button', { name: '更多', exact: true }).click();
await sheet(NAME).getByRole('button', { name: /^分享这个故事/ }).click();
await sheet('分享').getByRole('button', { name: /^长图/ }).waitFor({ timeout: 30000 });
const [imageDownload] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), sheet('分享').getByRole('button', { name: /^长图/ }).click()]);
const png = await readFile(await imageDownload.path());
check('export as long picture is a 1080px PNG', png.subarray(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 1080, `${png.length} bytes, width ${png.readUInt32BE(16)}`);

// Chapter search: names right away, the text inside through the app's search.
await settled();
await page.evaluate(a => { location.hash = new URLSearchParams({ work: a }).toString(); }, avatar);
const search = page.getByRole('searchbox', { name: '搜索故事' });
await search.waitFor({ timeout: 30000 });
await search.fill(`章节2-${run}`);
await page.waitForTimeout(500);
check('chapter search by name', await page.locator('.tl-chapter-row').count() === 1);
await search.fill(SECRET);
// The text search answers after a short pause (and a round trip); wait for its answer, not for the name filter.
await page.waitForFunction(name => {
    const rows = [...document.querySelectorAll('.tl-chapter-row')];
    return rows.length === 1 && rows[0].textContent.includes(name);
}, `章节3-${run}`, { timeout: 30000 }).catch(() => { });
const found = await page.locator('.tl-chapter-row').allInnerTexts();
check('chapter search finds words inside a chapter', found.length === 1 && found[0].includes(`章节3-${run}`), JSON.stringify(found));
await search.fill('');

// Persona from "我的": chosen without locking the open story; default persona.
originalPersona = await engineEval((w, a) => {
    const c = w.SillyTavern.getContext();
    c.powerUserSettings.personas[a.id] = a.name;
    c.powerUserSettings.persona_descriptions[a.id] = { description: '测试用身份', position: 0, depth: 2, role: 0, lorebook: '', connections: [], title: '' };
    c.powerUserSettings.persona_auto_lock = true;
    return w.TavernLiteBridge.personaList().current;
}, { id: PERSONA, name: `默认身份${run}` });
await settled();
await page.evaluate(() => { location.hash = '#me'; });
await page.getByRole('button', { name: '我的身份' }).click();
await sheet('我的身份').getByRole('radio', { name: new RegExp(`默认身份${run}`) }).click();
await toast(`默认身份${run}`);
const afterPick = await engineEval((w, a) => ({ name: w.SillyTavern.getContext().name1, locked: w.SillyTavern.getContext().chatMetadata?.persona === a }), PERSONA);
check('persona chosen from 我的', afterPick.name === `默认身份${run}`, JSON.stringify(afterPick));
check('…without locking the open story', !afterPick.locked);
await sheet('我的身份').getByRole('switch').click();
await toast('已设为默认身份');
check('default persona set', await engineEval((w, a) => w.SillyTavern.getContext().powerUserSettings.default_persona === a, PERSONA));
await closeSheet();
check('我的 shows the persona', (await page.getByRole('button', { name: '我的身份' }).innerText()).includes(`默认身份${run}`));
await engineEval(w => { w.SillyTavern.getContext().powerUserSettings.persona_auto_lock = false; });

// Reply reminder: permission given, the notification worker registered for the app.
await page.getByRole('switch', { name: /回复写好时通知我/ }).click();
await toast('回复写完时会提醒你');
const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('./'))?.scope ?? '');
check('reminder registers the notification worker', scope.endsWith('/emmalike/app/'), scope);

// Bookshelf: favourite, export, delete.
await settled();
await page.evaluate(() => { location.hash = '#'; });
const book = page.locator('.tl-book', { hasText: NAME });
await book.getByRole('button', { name: `${NAME} 的更多操作` }).click();
await sheet(NAME).getByRole('button', { name: /^收藏/ }).click();
await toast(`已收藏「${NAME}」`);
check('favourite shows a star', await page.locator('.tl-book', { hasText: NAME }).locator('.tl-book-fav').count() === 1);
check('favourites filter', await page.getByRole('button', { name: '★ 收藏' }).count() === 1);
check('favourite saved on the card', !!(await (await post('/api/characters/get', { avatar_url: avatar })).json()).fav);
await page.locator('.tl-book', { hasText: NAME }).getByRole('button', { name: `${NAME} 的更多操作` }).click();
const exportLink = sheet(NAME).getByRole('link', { name: /^导出角色卡/ });
check('export card link', (await exportLink.getAttribute('download')) === `${NAME}.png` && (await exportLink.getAttribute('href')).startsWith('/characters/'));
await closeSheet();
await page.locator('.tl-book', { hasText: DOOMED }).getByRole('button', { name: `${DOOMED} 的更多操作` }).click();
await sheet(DOOMED).getByRole('button', { name: /^删除角色/ }).click();
await sheet(`删除「${DOOMED}」？`).getByRole('button', { name: '删除', exact: true }).click();
await toast(`已删除「${DOOMED}」`);
check('deleted character leaves the shelf', await page.locator('.tl-book', { hasText: DOOMED }).count() === 0);
check('deleted on the server', !(await (await post('/api/characters/all', {})).json()).some(c => c.avatar === doomed));

// The session ends: the login page comes back, and the draft survives.
await settled();
await page.evaluate(a => { location.hash = new URLSearchParams({ chat: a, file: '' }).toString(); }, avatar);
await synced();
await page.locator('.tl-composer-input').fill(`没发出的草稿${run}`);
await page.waitForTimeout(500);
await post('/api/users/logout', {});
await page.getByRole('button', { name: '更多', exact: true }).click();
await sheet(NAME).getByRole('button', { name: /^角色主页/ }).click();
await page.locator('.tl-login').waitFor({ timeout: 30000 })
    .then(() => check('login page when the session ends', true)).catch(() => check('login page when the session ends', false));
check('…with a notice', (await page.evaluate(() => window.__tlToasts)).some(t => t.includes('登录过期了')));
check('no empty notices', !(await page.evaluate(() => window.__tlToasts)).some(t => !t.trim()));
await page.getByPlaceholder('账号').fill(handle);
await page.getByPlaceholder(/^密码/).fill(password);
await page.getByRole('button', { name: '登录' }).click();
await page.locator('.tl-work').waitFor({ timeout: 30000 });
await settled();
await page.evaluate(a => { location.hash = new URLSearchParams({ chat: a, file: '' }).toString(); }, avatar);
await synced();
check('draft kept after logging in again', (await page.locator('.tl-composer-input').inputValue()).includes(`没发出的草稿${run}`));
await page.locator('.tl-composer-input').fill('');

await cleanup();
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `FAILED: ${problems.join(', ')}` : 'ALL PASS');
await browser.close();
process.exit(problems.length ? 1 : 0);
