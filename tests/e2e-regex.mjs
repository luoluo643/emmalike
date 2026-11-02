// Regex scripts changed in the shell, on an official SillyTavern with tavern-lite only: a new global display script
// (tried on the story's greeting first) hides part of the greeting in the open story; its switch turns it back; it moves
// into the preset (which is then allowed); a saved set of switches brings it back on; one goes onto the character; a
// script changed in the app meanwhile is not overwritten silently; a file is imported; several are deleted at once.
// Each change is checked in what the app saved (account settings, preset file, character card) and in the app's own
// regex panel. Nothing is sent to the model.
// Usage: node e2e-regex.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `正则${run}`, RX = `藏想法${run}`, ROLE_RX = `角色的${run}`, COMBO = `只看正文${run}`, IMPORTED = `导入的${run}`;
const results = {}, problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 400); if (!ok) problems.push(name); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
const pageErrors = [], modelCalls = [];
context.on('request', request => { if (/chat-completions\/generate/.test(request.url())) modelCalls.push(request.url()); });
const api = context.request;
const { token } = await (await api.get(`${base}/csrf-token`)).json();
const post = (path, data) => api.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const created = await api.post(`${base}/api/characters/create`, { headers: { 'X-CSRF-Token': token },
    multipart: { ch_name: NAME, description: '', first_mes: `你来了。<thinking>其实我在想别的${run}</thinking>坐吧。`, personality: '', scenario: '', mes_example: '', creator_notes: '',
        system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' } });
const avatar = (await created.text()).trim();

const settings = async () => JSON.parse((await (await post('/api/settings/get', {})).json()).settings);
const ext = async () => (await settings()).extension_settings ?? {};
const presetFile = async name => { const all = await (await post('/api/settings/get', {})).json(); const i = all.openai_setting_names.indexOf(name);
    return i < 0 ? null : typeof all.openai_settings[i] === 'string' ? JSON.parse(all.openai_settings[i]) : all.openai_settings[i]; };
const cardScripts = async () => (await (await post('/api/characters/get', { avatar_url: avatar })).json())?.data?.extensions?.regex_scripts ?? [];

const page = await context.newPage();
page.setDefaultTimeout(30000);
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
const until = async (condition, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await condition().catch(() => false)) return true; await page.waitForTimeout(400); }
    return false;
};
const inApp = (fn, arg) => page.evaluate(([source, value]) => { const w = document.querySelector('iframe.engine')?.contentWindow; return new w.Function('w', 'value', source)(w, value); }, [fn, arg]);
const nativeRow = id => inApp(`const el = w.document.getElementById(value); return el ? { list: el.parentElement?.id, off: !!el.querySelector('.disable_regex')?.checked, name: el.querySelector('.regex_script_name')?.textContent } : null;`, id);
const synced = () => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const openStory = async () => { await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar })}`); await synced(); };
const greeting = () => page.locator('.tl-message').first().innerText();
const openList = async () => { await page.goto(`${appUrl}#regex`); await page.locator('.tl-regex-group').first().waitFor({ timeout: 240000 }); };
const row = name => page.locator('.tl-regex-row', { has: page.locator('.tl-list-label', { hasText: name }) });
const flip = async locator => {
    const expected = await locator.getAttribute('aria-checked') === 'true' ? 'false' : 'true';
    await locator.click();
    await page.waitForFunction(([el, want]) => el.getAttribute('aria-checked') === want && el.getAttribute('aria-busy') !== 'true', [await locator.elementHandle(), expected], { timeout: 30000 });
};
const status = () => page.locator('.tl-regex-status').innerText().catch(() => '');

try {
    // The character's story is open, so its own list is there and the greeting can be watched.
    await openStory();
    check('the greeting shows the thought before any script', (await greeting()).includes(`其实我在想别的${run}`));

    // A new script from the shell, tried on the greeting first.
    await openList();
    const groups = await page.locator('.tl-regex-group h2').allInnerTexts();
    check('three lists in the order the app runs them', groups.length === 3 && groups[0].startsWith('全局') && groups[1].startsWith('预设') && groups[2].startsWith(`角色「${NAME}」`), groups);
    await page.getByRole('button', { name: '＋ 新建' }).click();
    await page.getByLabel('名字').fill(RX);
    await page.getByLabel('查找').fill('/<thinking>[\\s\\S]*?<\\/thinking>/g');
    check('the find box explains how it matches', (await page.locator('#tl-rx-find ~ .tl-field-hint[role="status"]').innerText()).includes('替换所有找到的'));
    check('new scripts default to replies, display only', await page.getByRole('checkbox', { name: 'AI 回复' }).getAttribute('aria-checked') === 'true'
        && await page.getByRole('radio', { name: /^只改显示/ }).getAttribute('aria-checked') === 'true');
    await page.getByRole('button', { name: '填入最近一条回复' }).click();
    await page.waitForFunction(() => document.querySelector('.tl-regex-output')?.textContent?.includes('坐吧'), null, { timeout: 10000 });
    const tried = await page.locator('.tl-regex-output').innerText();
    check('trying it on the greeting shows the result, run by the app', tried.includes('你来了。坐吧。') && !tried.includes('其实我在想'), tried);
    check('and says how much it found', (await page.locator('.tl-regex-try [role="status"]').innerText()).includes('找到 1 处'));
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.tl-regex-group').first().waitFor({ timeout: 30000 });
    check('a new script, once saved, leads back to the list showing it', await row(RX).count() === 1);
    let id = '';
    await until(async () => { id = (await ext()).regex?.find(s => s.scriptName === RX)?.id ?? ''; return !!id; });
    check('saved into the account settings as the app saves it', await until(async () => (await ext()).regex?.some(s => s.id === id && s.scriptName === RX && s.markdownOnly && s.placement.includes(2) && !s.disabled)));
    check('the app\'s own regex panel lists it (redrawn)', (await nativeRow(id))?.list === 'saved_regex_scripts');

    await openStory();
    check('the open story no longer shows the thought', await until(async () => !(await greeting()).includes('其实我在想') && (await greeting()).includes('坐吧')), await greeting());

    // Its switch, in the list.
    await openList();
    await flip(row(RX).getByRole('switch'));
    check('switched off: saved, and the app panel shows it off', await until(async () => (await ext()).regex?.find(s => s.id === id)?.disabled === true) && (await nativeRow(id))?.off === true);
    await openStory();
    check('the thought is back in the story', await until(async () => (await greeting()).includes(`其实我在想别的${run}`)));

    // Into the preset: written in the preset file, and the preset's scripts allowed to run (as the app does).
    await page.goto(`${appUrl}#${new URLSearchParams({ regex: 'global', id })}`);
    await page.getByRole('button', { name: /^移到别的组/ }).click({ timeout: 240000 });
    const presetName = (await settings()).oai_settings?.preset_settings_openai;
    const presetAllowed = async () => !!(await ext()).preset_allowed_regex?.openai?.includes(presetName);
    const allowedBefore = await presetAllowed();
    await page.getByRole('dialog').getByRole('button', { name: new RegExp(`^预设「`) }).click();
    await page.waitForFunction(() => new URLSearchParams(location.hash.slice(1)).get('regex') === 'preset', null, { timeout: 30000 });
    check('moved: gone from the account list', await until(async () => !(await ext()).regex?.some(s => s.id === id)));
    check('moved: in the preset file', await until(async () => (await presetFile(presetName))?.extensions?.regex_scripts?.some(s => s.id === id)), presetName);
    check('moved while switched off: the preset is not allowed just for that', await presetAllowed() === allowedBefore);
    check('moved: the app panel shows it under the preset', (await nativeRow(id))?.list === 'saved_preset_scripts');

    // Switched on there: the preset allowed. A saved set of switches with it on; switched off; the set brings it back.
    await openList();
    await flip(row(RX).getByRole('switch'));
    check('switched on in the preset: the preset is allowed to run its scripts', await until(presetAllowed));
    await page.getByRole('button', { name: '把现在的开关存成组合' }).click();
    await page.getByLabel('名字').fill(COMBO);
    await page.getByRole('dialog').getByRole('button', { name: '保存' }).click();
    check('the set is saved in the account settings, chosen', await until(async () => (await ext()).regex_presets?.some(p => p.name === COMBO && p.isSelected && p.preset.some(i => i.id === id))));
    check('the set says it is in use', (await page.locator('.tl-regex-combos .tl-list-item', { hasText: COMBO }).innerText()).includes('正在用'));
    await flip(row(RX).getByRole('switch'));
    check('after a switch changes, the set says so', await until(async () => (await page.locator('.tl-regex-combos .tl-list-item', { hasText: COMBO }).innerText()).includes('之后又改过开关')));
    await page.locator('.tl-regex-combos .tl-list-item', { hasText: COMBO }).click();
    const comboSheet = page.getByRole('dialog', { name: `「${COMBO}」` });
    check('the set shows what applying it changes', (await comboSheet.innerText()).includes(`会打开 1 条：「${RX}」`), await comboSheet.innerText());
    await comboSheet.getByRole('button', { name: /^换成这一套/ }).click();
    await comboSheet.waitFor({ state: 'detached', timeout: 30000 });
    check('applied: the script is on again in the preset file', await until(async () => (await presetFile(presetName))?.extensions?.regex_scripts?.find(s => s.id === id)?.disabled === false));
    check('applied through the app\'s own set picker', await inApp(`return w.document.getElementById('regex_presets')?.selectedOptions?.[0]?.textContent;`) === COMBO);

    // The app moves the scripts a set switches off to the front of their list; the shell puts the order back.
    const order = await inApp(`const b = w.TavernLiteBridge, owner = () => b.regexEditorState().owner, names = () => b.regexEditorState().groups[0].scripts.map(s => s.scriptName);
        return (async () => {
            const first = await b.regexSave({ group: 'global', id: '', script: { scriptName: value + '甲', findRegex: '/甲甲/g', placement: [2] }, owner: owner() });
            await b.regexSave({ group: 'global', id: '', script: { scriptName: value + '乙', findRegex: '/乙乙/g', placement: [2] }, owner: owner() });
            await b.regexToggle({ group: 'global', id: first.id, disabled: true, owner: owner() });
            const combo = await b.regexComboSave({ name: '只看正文' + value });
            await b.regexToggle({ group: 'global', id: first.id, disabled: false, owner: owner() });
            const before = names();
            await b.regexComboApply({ id: combo.id, owner: owner() });
            return { before, after: names(), off: b.regexEditorState().groups[0].scripts.find(s => s.id === first.id)?.disabled };
        })();`, RX);
    check('applying a set keeps the order scripts run in', order.off === true && JSON.stringify(order.before) === JSON.stringify(order.after), order);
    check('and the account settings keep that order', await until(async () => { const names = (await ext()).regex?.map(s => s.scriptName).filter(n => n.startsWith(RX)); return JSON.stringify(names) === JSON.stringify([`${RX}甲`, `${RX}乙`]); }));

    // One for the character: written on the card, and the character allowed.
    await page.getByRole('button', { name: '＋ 新建' }).click();
    await page.getByRole('radio', { name: `角色「${NAME}」` }).click();
    await page.getByLabel('名字').fill(ROLE_RX);
    await page.getByLabel('查找').fill('/坐吧/g');
    await page.getByLabel('替换为').fill('请坐');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.tl-regex-group').first().waitFor({ timeout: 30000 });
    let roleId = '';
    await until(async () => { roleId = (await cardScripts()).find(s => s.scriptName === ROLE_RX)?.id ?? ''; return !!roleId; });

    // Kept from running: switching one of its scripts off leaves it so; switching one on allows it again.
    const roleAllow = page.locator('.tl-regex-group[data-group="scoped"] .tl-regex-allow');
    await flip(roleAllow);
    check('the character can be kept from running its scripts', await until(async () => !(await ext()).character_allowed_regex?.includes(avatar)));
    await flip(row(ROLE_RX).getByRole('switch'));
    check('switching one off does not allow the character again', await roleAllow.getAttribute('aria-checked') === 'false'
        && !await inApp(`return w.SillyTavern.getContext().extensionSettings.character_allowed_regex?.includes(value);`, avatar));
    await flip(row(ROLE_RX).getByRole('switch'));
    check('switching one on allows it again', await roleAllow.getAttribute('aria-checked') === 'true' && await until(async () => (await ext()).character_allowed_regex?.includes(avatar)));
    await row(ROLE_RX).locator('.tl-regex-open').click();
    await page.getByLabel('替换为').waitFor();
    check('the character\'s script is on its card', await until(async () => (await cardScripts()).some(s => s.id === roleId && s.replaceString === '请坐')), JSON.stringify({ roleId, card: (await cardScripts()).map(s => [s.id, s.scriptName, s.replaceString]) }));
    check('and the character is allowed to run its scripts', await until(async () => (await ext()).character_allowed_regex?.includes(avatar)));

    // Changed in the app while the shell has its own unsaved edit: shown, not overwritten.
    await page.getByLabel('替换为').fill('您请坐');
    await inApp(`const s = w.SillyTavern.getContext().characters.find(c => c.avatar === value).data.extensions.regex_scripts[0]; s.replaceString = '在原版里改的'; return true;`, avatar);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const conflict = page.locator('.tl-regex-conflict');
    check('a change made in the app meanwhile is shown, not overwritten', await conflict.waitFor({ timeout: 15000 }).then(() => true, () => false) && (await conflict.innerText()).includes('替换为'));
    await conflict.getByRole('button', { name: '用我写的覆盖' }).click();
    check('and kept mine when asked to', await until(async () => (await cardScripts()).find(s => s.id === roleId)?.replaceString === '您请坐'));

    // A file the app exported, imported into the global list. Back to the list the way a reader goes.
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: '返回' }).click();
    await page.locator('.tl-regex-group').first().waitFor({ timeout: 30000 });
    check('back from the editor leads to the list, without asking (nothing left unsaved)', await page.getByRole('dialog').count() === 0);
    const file = `/tmp/tl-regex-import-${run}.json`;
    writeFileSync(file, JSON.stringify([{ id: 'from-elsewhere', scriptName: IMPORTED, findRegex: '/x/g', replaceString: '', placement: [2], markdownOnly: true }, { nothing: 1 }]));
    await page.locator('.tl-regex-page input[type="file"]').setInputFiles(file);
    const importSheet = page.getByRole('dialog', { name: '导入 1 条正则' });
    await importSheet.getByRole('button', { name: /^全局/ }).click();
    check('imported into the account list with a new id', await until(async () => (await ext()).regex?.some(s => s.scriptName === IMPORTED && s.id !== 'from-elsewhere')));

    // Several deleted at once (the preset one and the imported one are in different lists: one list at a time).
    await page.getByRole('button', { name: '批量与排序' }).click();
    await page.getByRole('checkbox', { name: `选择「${RX}」` }).check();
    await page.getByRole('checkbox', { name: `选择「${IMPORTED}」` }).check();
    check('a selection across lists cannot be deleted in one go', await page.locator('.tl-regex-bulkbar').getByRole('button', { name: '删除' }).isDisabled());
    await page.getByRole('checkbox', { name: `选择「${IMPORTED}」` }).uncheck();
    await page.locator('.tl-regex-bulkbar').getByRole('button', { name: '删除' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除' }).click();
    check('deleted from the preset file', await until(async () => !(await presetFile(presetName))?.extensions?.regex_scripts?.some(s => s.id === id)));
    check('the app panel no longer lists it', await nativeRow(id) === null);

    await page.getByRole('button', { name: '完成' }).click();

    // The same file again: the sheet says the list has it, and it is left out.
    await page.locator('.tl-regex-page input[type="file"]').setInputFiles(file);
    const importAgain = page.getByRole('dialog', { name: '导入 1 条正则' });
    check('importing the same file again: the sheet says the list has one alike', (await importAgain.getByRole('button', { name: /^全局/ }).innerText()).includes('已经有一样的'));
    await importAgain.getByRole('button', { name: /^全局/ }).click();
    check('and leaves it out', await until(async () => (await status()).includes('都已经有一样的')) && (await ext()).regex.filter(s => s.scriptName === IMPORTED).length === 1);

    // A save the server refuses: said so, what was written stays; saved again once it takes it, still one script.
    await row(IMPORTED).locator('.tl-regex-open').click();
    await page.getByLabel('替换为').waitFor();
    const importedId = new URLSearchParams((await page.evaluate(() => location.hash)).slice(1)).get('id');
    await page.route('**/api/settings/save', route => route.fulfill({ status: 500, body: 'down' }));
    await page.getByLabel('替换为').fill('存不上');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    check('a save the server refuses says so and keeps what was written', await until(async () => (await status()).includes('没存到服务器'))
        && await page.getByLabel('替换为').inputValue() === '存不上' && (await page.locator('.tl-regex-editor-actions').innerText()).includes('有没保存的改动'), await status());
    await page.unroute('**/api/settings/save');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    check('saved again once the server takes it (not taken for a change made elsewhere)', await until(async () => (await ext()).regex?.filter(s => s.scriptName === IMPORTED).map(s => s.replaceString).join() === '存不上'), await status());

    // Typing while it saves: what was typed after stays, unsaved.
    await page.route('**/api/settings/save', async route => { await new Promise(resolve => setTimeout(resolve, 3000)); await route.continue().catch(() => {}); });
    await page.getByLabel('替换为').fill('先存的');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.tl-regex-editor-actions button[aria-busy="true"]').waitFor({ timeout: 10000 });
    await page.getByLabel('替换为').fill('后写的');
    check('typing while it saves: what was typed after stays', await until(async () => (await status()).includes('之后写的还没存'), 30000)
        && await page.getByLabel('替换为').inputValue() === '后写的' && (await page.locator('.tl-regex-editor-actions').innerText()).includes('有没保存的改动'), await status());
    await page.unroute('**/api/settings/save');
    check('and what was sent is saved', await until(async () => (await ext()).regex?.find(s => s.id === importedId)?.replaceString === '先存的'));

    // Away from the regex page and back, the way the shell's own links go (a "back" would ask first): the draft is still there.
    const appGo = hash => page.evaluate(to => { const { tlLayer, ...kept } = history.state ?? {};
        if (tlLayer) history.replaceState({ ...kept, tavernLite: true }, '', to); else history.pushState({ tavernLite: true }, '', to); dispatchEvent(new Event('tl-route')); }, hash);
    await appGo('#me');
    await page.waitForFunction(() => !document.querySelector('.tl-regex-editor'), null, { timeout: 15000 });
    await appGo(`#${new URLSearchParams({ regex: 'global', id: importedId })}`);
    await page.getByLabel('替换为').waitFor({ timeout: 60000 });
    check('back on the script after another page: the unsaved draft is there', await page.getByLabel('替换为').inputValue() === '后写的', await page.getByLabel('替换为').inputValue());
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await until(async () => (await status()).startsWith('已保存'));

    // A copy starts switched off.
    await page.getByRole('button', { name: /^复制一份/ }).click();
    await page.waitForFunction(id => { const now = new URLSearchParams(location.hash.slice(1)).get('id'); return now && now !== id; }, importedId, { timeout: 30000 });
    check('a copy starts switched off', await page.getByRole('switch', { name: /^打开/ }).getAttribute('aria-checked') === 'false'
        && await until(async () => (await ext()).regex?.find(s => s.scriptName === `${IMPORTED} 副本`)?.disabled === true));

    // A set applied again while in use: nothing to do, said so.
    await openList();
    await page.getByRole('button', { name: '把现在的开关存成组合' }).click();
    await page.getByLabel('名字').fill(`${COMBO}二`);
    await page.getByRole('dialog').getByRole('button', { name: '保存' }).click();
    await until(async () => (await status()).includes(`已存成「${COMBO}二」`));
    await page.locator('.tl-regex-combos .tl-list-item', { hasText: `${COMBO}二` }).click();
    const inUse = page.getByRole('dialog', { name: `「${COMBO}二」` });
    check('a set in use says so', (await inUse.getByRole('button', { name: /^换成这一套/ }).innerText()).includes('正在用这一套'));
    await inUse.getByRole('button', { name: /^换成这一套/ }).click();
    check('applying it again changes nothing', await until(async () => (await status()).includes(`本来就是「${COMBO}二」`)));

    await page.screenshot({ path: `/tmp/tl-regex-list.png`, fullPage: true });
    // The preset page points here.
    await page.goto(`${appUrl}#preset`);
    check('the preset page links its own scripts', await page.getByRole('button', { name: /^这个预设自带的正则 · / }).waitFor({ timeout: 240000 }).then(() => true, () => false));
    await page.screenshot({ path: `/tmp/tl-regex-preset-link.png` });
    // Where that link leads: the preset's list, where a new one goes by default. (Opened afresh: the preset page holds
    // on to its unsaved differences when the address changes under it.)
    await page.goto('about:blank');
    await page.goto(`${appUrl}#regex=preset`);
    await page.locator('.tl-regex-group').first().waitFor({ timeout: 240000 });
    await page.getByRole('button', { name: '＋ 新建' }).click();
    check('a new one from the preset\'s list goes into the preset by default', await page.getByRole('radio', { name: /^预设「/ }).getAttribute('aria-checked') === 'true');
} catch (error) {
    check('ran to the end', false, String(error.stack ?? error).slice(0, 600));
    await page.screenshot({ path: '/tmp/tl-regex-failure.png' }).catch(() => { });
}

// Clean up what this run added to the account.
await inApp(`const b = w.TavernLiteBridge, s = b.regexEditorState();
    const names = value; const own = s.groups.flatMap(g => g.scripts.filter(x => names.some(n => x.scriptName.startsWith(n))).map(x => ({ group: g.type, id: x.id })));
    return (async () => { for (const g of ['global', 'preset']) { const items = own.filter(i => i.group === g); if (items.length) await b.regexDelete({ group: g, items, owner: s.owner }).catch(() => {}); }
        for (const c of s.combos.filter(c => c.name.startsWith(names[3]))) await b.regexComboDelete({ id: c.id }).catch(() => {}); })();`, [RX, IMPORTED, ROLE_RX, `只看正文`]).catch(() => { });
await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
check('nothing was sent to the model', modelCalls.length === 0, modelCalls.length);
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `FAILED: ${problems.join(', ')}` : 'ALL PASS');
await browser.close();
process.exit(problems.length ? 1 : 0);
