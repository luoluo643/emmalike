// What a reader may meet on a phone with the regex page, simulated on an official SillyTavern with tavern-lite only:
// another preset chosen (through the shell's own preset picker) while a script of the old one is being changed, the
// new preset being a copy of the old with the same script ids; drafts kept apart per preset; and the page on a phone
// screen with a slow network, then none: double taps, saving while typing, a set applied, a save that cannot reach the
// server. Timings are printed as INFO. Nothing is sent to the model.
// Usage: node e2e-regex-sim.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
if (base !== 'http://127.0.0.1:8103') throw new Error('Only the dedicated regex draft test instance on 127.0.0.1:8103 is allowed');
const evidence = process.env.TEST_OUTPUT || '/tmp/tl-regex-draft-sim';
await fs.mkdir(evidence, { recursive: true });
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `模拟${run}`, IN_PRESET = `预设里的${run}`, COPY = `复制的预设${run}`, NEW_RX = `新建的${run}`, SLOW = `慢网${run}`, COMBO = `慢网组合${run}`;
const results = {}, problems = [], notes = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 400); if (!ok) problems.push(name); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); };
const info = (name, value) => { notes.push(`${name}: ${value}`); console.log('INFO', name, value); };
const shot = name => page.screenshot({ path: path.join(evidence, `regex-sim-${name}.png`) });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const pageErrors = [], modelCalls = [];
context.on('request', request => { if (/chat-completions\/generate/.test(request.url())) modelCalls.push(request.url()); });
const api = context.request;
const { token } = await (await api.get(`${base}/csrf-token`)).json();
const post = (path, data) => api.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const created = await api.post(`${base}/api/characters/create`, { headers: { 'X-CSRF-Token': token },
    multipart: { ch_name: NAME, description: '', first_mes: `你来了。坐吧。${run}`, personality: '', scenario: '', mes_example: '', creator_notes: '',
        system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' } });
const avatar = (await created.text()).trim();

const settings = async () => JSON.parse((await (await post('/api/settings/get', {})).json()).settings);
const ext = async () => (await settings()).extension_settings ?? {};
const presetFile = async name => { const all = await (await post('/api/settings/get', {})).json(); const i = all.openai_setting_names.indexOf(name);
    return i < 0 ? null : typeof all.openai_settings[i] === 'string' ? JSON.parse(all.openai_settings[i]) : all.openai_settings[i]; };
const presetScript = async (preset, id) => (await presetFile(preset))?.extensions?.regex_scripts?.find(s => s.id === id);

const page = await context.newPage();
page.setDefaultTimeout(30000);
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
const until = async (condition, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await condition().catch(() => false)) return true; await page.waitForTimeout(300); }
    return false;
};
const inApp = (fn, arg) => page.evaluate(([source, value]) => { const w = document.querySelector('iframe.engine')?.contentWindow; return new w.Function('w', 'value', source)(w, value); }, [fn, arg]);
const synced = () => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const openList = async () => { await appGo('#regex'); await page.locator('.tl-regex-group').first().waitFor({ timeout: 240000 }); };
const row = name => page.locator('.tl-regex-row', { has: page.locator('.tl-list-label', { hasText: name }) });
const status = () => page.locator('.tl-regex-status').innerText().catch(() => '');
const saveButton = () => page.locator('.tl-regex-editor-actions .tl-primary');
// The shell's own links (a change of address would count as "back" and ask about unsaved changes first).
const appGo = hash => page.evaluate(to => { const { tlLayer, ...kept } = history.state ?? {};
    if (tlLayer) history.replaceState({ ...kept, tavernLite: true }, '', to); else history.pushState({ tavernLite: true }, '', to); dispatchEvent(new Event('tl-route')); }, hash);
// As the shell's preset picker ("换预设") does.
const choosePreset = name => inApp(`const b = w.TavernLiteBridge, p = b.modelChoices().presets.find(x => x.name === value);
    if (!p) throw new Error('no preset ' + value); return b.selectPreset(p.id).then(() => b.modelChoices().presets.find(x => x.id === b.modelChoices().preset)?.name);`, name);
const presetNow = () => inApp(`const b = w.TavernLiteBridge; return b.modelChoices().presets.find(x => x.id === b.modelChoices().preset)?.name;`);
// A window the full app opened on its own page, which the reader does not see.
const hiddenDialogs = () => inApp(`return [...w.document.querySelectorAll('dialog')].filter(d => d.open).map(d => d.innerText.replace(/\\s+/g, ' ').slice(0, 80));`);
const timed = async work => { const start = Date.now(); await work(); return Date.now() - start; };

let presetA = '', id = '';
try {
    await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar })}`);
    await synced();
    presetA = await presetNow();
    info('preset in use', presetA);

    // ---- Another preset while a script of this one is being changed ----
    id = await inApp(`const b = w.TavernLiteBridge; return b.regexSave({ group: 'preset', id: '', script: { scriptName: value, findRegex: '/坐吧/g', replaceString: '请坐', placement: [2], markdownOnly: true }, owner: b.regexEditorState().owner }).then(r => r.id);`, IN_PRESET);
    check('a script in the preset to start from', !!id && await until(async () => !!await presetScript(presetA, id)));
    // The copy: the same preset saved under another name, its scripts (and their ids) with it.
    await inApp(`const pm = w.SillyTavern.getContext().getPresetManager('openai'); const a = pm.getCompletionPresetByName(value[0]);
        return pm.savePreset(value[1], JSON.parse(JSON.stringify(a))).then(() => true);`, [presetA, COPY]);
    check('the copy has the same script, same id', await until(async () => (await presetScript(COPY, id))?.replaceString === '请坐'));
    if (await presetNow() !== presetA) await choosePreset(presetA);
    check('back on the first preset before editing', await presetNow() === presetA);

    await appGo(`#${new URLSearchParams({ regex: 'preset', id })}`);
    await page.getByLabel('替换为').waitFor({ timeout: 240000 });
    await page.getByLabel('替换为').fill('A 里写的');
    const switched = await timed(() => choosePreset(COPY));
    info('switching preset took (ms)', switched);
    check('the shell switched to the copy', await presetNow() === COPY);
    const warning = page.locator('.tl-error', { hasText: '存不进去' });
    check('editing it meanwhile: the page says it was written under the first preset', await warning.waitFor({ timeout: 15000 }).then(() => true, () => false)
        && (await warning.innerText()).includes(`「${presetA}」`) && (await warning.innerText()).includes(`「${COPY}」`), await page.locator('.tl-regex-editor-scroll').innerText().catch(() => ''));
    check('and it cannot be saved into the copy', await saveButton().isDisabled());
    check('what was written is still there', await page.getByLabel('替换为').inputValue() === 'A 里写的');
    check('copy, move and delete are not offered there; export is', await page.getByRole('button', { name: /^复制一份/ }).count() === 0
        && await page.getByRole('button', { name: /^删除这条正则/ }).count() === 0 && await page.getByRole('button', { name: /^导出/ }).count() === 1);
    await shot('switched-preset');
    const dialogs = await hiddenDialogs();
    info('windows open on the full app\'s hidden page after switching to a preset with its own scripts', JSON.stringify(dialogs));
    check('the copy is unchanged on the server', (await presetScript(COPY, id))?.replaceString === '请坐');

    await choosePreset(presetA);
    check('back on the first preset: the warning goes', await until(async () => await warning.count() === 0, 15000));
    check('the draft is still there and can be saved', await page.getByLabel('替换为').inputValue() === 'A 里写的' && !await saveButton().isDisabled());
    await saveButton().tap();
    check('saved into the first preset', await until(async () => (await presetScript(presetA, id))?.replaceString === 'A 里写的'), await status());
    check('the copy still has its own', (await presetScript(COPY, id))?.replaceString === '请坐');

    // Drafts kept apart: one for the first preset, not shown under the copy, back under the first again.
    await page.getByLabel('替换为').fill('A 的草稿');
    await appGo('#regex');
    await page.locator('.tl-regex-group').first().waitFor();
    await choosePreset(COPY);
    await appGo(`#${new URLSearchParams({ regex: 'preset', id })}`);
    await page.getByLabel('替换为').waitFor();
    check('the same script under the copy shows the copy\'s, not the other preset\'s draft', await page.getByLabel('替换为').inputValue() === '请坐', await page.getByLabel('替换为').inputValue());
    await appGo('#regex');
    await page.locator('.tl-regex-group').first().waitFor();
    await choosePreset(presetA);
    await appGo(`#${new URLSearchParams({ regex: 'preset', id })}`);
    await page.getByLabel('替换为').waitFor();
    check('back under the first preset, its draft is there', await page.getByLabel('替换为').inputValue() === 'A 的草稿', await page.getByLabel('替换为').inputValue());

    // Keep typing after a live switch: the latest draft must still belong to A, not the now active B.
    await choosePreset(COPY);
    await warning.waitFor();
    await page.getByLabel('替换为').fill('换预设后继续写的 A 草稿');
    await appGo('#regex');
    await page.locator('.tl-regex-group').first().waitFor();
    await appGo(`#${new URLSearchParams({ regex: 'preset', id })}`);
    await page.getByLabel('替换为').waitFor();
    check('continued draft from A never appears in B', await page.getByLabel('替换为').inputValue() === '请坐');
    await appGo('#regex');
    await page.locator('.tl-regex-group').first().waitFor();
    await choosePreset(presetA);
    await appGo(`#${new URLSearchParams({ regex: 'preset', id })}`);
    await page.getByLabel('替换为').waitFor();
    check('A restores edits made while B was active', await page.getByLabel('替换为').inputValue() === '换预设后继续写的 A 草稿');
    check('restoring drafts did not change B on server', (await presetScript(COPY, id))?.replaceString === '请坐');
    await shot('restored-draft');

    // A new one meant for the preset, and the preset changes: it can still go elsewhere.
    await appGo('#regex=preset');
    await page.locator('.tl-regex-group').first().waitFor();
    await page.getByRole('button', { name: '＋ 新建' }).tap();
    await page.getByLabel('名字').fill(NEW_RX);
    await page.getByLabel('查找').fill('/新的/g');
    await choosePreset(COPY);
    check('a new one meant for the first preset cannot go into the copy', await warning.waitFor({ timeout: 15000 }).then(() => true, () => false)
        && (await warning.innerText()).includes('放进别的组') && await saveButton().isDisabled());
    await page.getByRole('radio', { name: '全局' }).tap();
    check('put into the global list instead, it can be saved', await until(async () => await warning.count() === 0 && !await saveButton().isDisabled(), 5000));
    await saveButton().tap();
    check('saved into the global list', await until(async () => (await ext()).regex?.some(s => s.scriptName === NEW_RX)));
    check('and not into either preset', !(await presetFile(COPY))?.extensions?.regex_scripts?.some(s => s.scriptName === NEW_RX)
        && !(await presetFile(presetA))?.extensions?.regex_scripts?.some(s => s.scriptName === NEW_RX));
    await choosePreset(presetA);

    // ---- A phone with a slow network ----
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    const network = conditions => cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, ...conditions });
    await openList();
    await page.getByRole('button', { name: '＋ 新建' }).tap();
    await page.getByLabel('名字').fill(SLOW);
    await page.getByLabel('查找').fill('/慢/g');
    await saveButton().tap();
    await page.locator('.tl-regex-group').first().waitFor();
    // Slow: about a poor mobile connection.
    await network({ latency: 800, downloadThroughput: 40 * 1024, uploadThroughput: 20 * 1024 });
    const slowSwitch = row(SLOW).getByRole('switch');
    const toggleTime = await timed(async () => {
        await slowSwitch.tap();
        await slowSwitch.tap({ force: true, timeout: 2000 }).catch(() => {});
        await page.waitForFunction(el => el.getAttribute('aria-busy') !== 'true' && !el.disabled, await slowSwitch.elementHandle(), { timeout: 120000 });
    });
    info('a switch on a slow network, until it settles (ms)', toggleTime);
    check('two quick taps on a switch while it saves: switched once', await until(async () => (await ext()).regex?.find(s => s.scriptName === SLOW)?.disabled === true, 60000)
        && await slowSwitch.getAttribute('aria-checked') === 'false');
    await shot('slow-list');

    await row(SLOW).locator('.tl-regex-open').tap();
    await page.getByLabel('替换为').waitFor({ timeout: 60000 });
    await page.getByLabel('替换为').fill('先存的');
    await saveButton().tap();
    await page.getByLabel('替换为').fill('后写的');
    const saveTime = await timed(() => until(async () => (await status()).startsWith('已保存'), 120000));
    info('saving on a slow network (ms)', saveTime);
    check('typing on while it saves on a slow network: what was typed after stays', await page.getByLabel('替换为').inputValue() === '后写的' && (await status()).includes('之后写的还没存'), await status());
    await saveButton().tap();
    await until(async () => (await status()) === '已保存', 120000);
    check('then saved too', await until(async () => (await ext()).regex?.find(s => s.scriptName === SLOW)?.replaceString === '后写的', 60000));

    // A set applied on the slow network: the app saves, redraws and reloads the story before it counts as done.
    await openList();
    await page.getByRole('button', { name: '把现在的开关存成组合' }).tap();
    await page.getByLabel('名字').fill(COMBO);
    await page.getByRole('dialog').getByRole('button', { name: '保存' }).tap();
    await until(async () => (await status()).includes(`已存成「${COMBO}」`), 120000);
    await row(SLOW).getByRole('switch').tap();
    await until(async () => await row(SLOW).getByRole('switch').getAttribute('aria-checked') === 'true' && await row(SLOW).getByRole('switch').getAttribute('aria-busy') !== 'true', 120000);
    await page.locator('.tl-regex-combos .tl-list-item', { hasText: COMBO }).tap();
    const comboSheet = page.getByRole('dialog', { name: `「${COMBO}」` });
    const comboTime = await timed(async () => { await comboSheet.getByRole('button', { name: /^换成这一套/ }).tap(); await until(async () => /已换成|没切完|没存到/.test(await status()), 120000); });
    info('applying a set on a slow network (ms)', comboTime);
    check('a set applied on a slow network finishes', (await status()).includes(`已换成「${COMBO}」`), await status());

    // No network at all: said so, and the switch shows what is on the page; once back, the next save carries it.
    await network({ offline: true });
    await row(SLOW).getByRole('switch').tap();
    await until(async () => (await status()) !== '' && await row(SLOW).getByRole('switch').getAttribute('aria-busy') !== 'true', 60000);
    const offlineStatus = await status();
    info('switch tapped with no network, the page says', offlineStatus);
    check('with no network, the page says it was not saved', /没存到服务器|网络|连不上/.test(offlineStatus), offlineStatus);
    await shot('offline');
    info('switch shown after that', await row(SLOW).getByRole('switch').getAttribute('aria-checked'));
    await network({});
    await row(SLOW).locator('.tl-regex-open').tap();
    await page.getByLabel('替换为').waitFor();
    await page.getByLabel('替换为').fill('联网后写的');
    await saveButton().tap();
    await until(async () => (await status()).startsWith('已保存'), 60000);
    const saved = (await ext()).regex?.find(s => s.scriptName === SLOW);
    check('back online, saving again works', saved?.replaceString === '联网后写的', saved);
    info('switch on the server after that (disabled)', saved?.disabled);
} catch (error) {
    check('ran to the end', false, String(error.stack ?? error).slice(0, 600));
    await shot('failure');
}

// Clean up what this run added.
await inApp(`const b = w.TavernLiteBridge, s = b.regexEditorState();
    const own = s.groups.flatMap(g => g.scripts.filter(x => value.names.some(n => x.scriptName.startsWith(n))).map(x => ({ group: g.type, id: x.id })));
    return (async () => { for (const g of ['global', 'preset']) { const items = own.filter(i => i.group === g); if (items.length) await b.regexDelete({ group: g, items, owner: s.owner }).catch(() => {}); }
        for (const c of s.combos.filter(c => c.name.startsWith(value.combo))) await b.regexComboDelete({ id: c.id }).catch(() => {}); })();`,
{ names: [IN_PRESET, NEW_RX, SLOW], combo: COMBO }).catch(() => {});
await post('/api/presets/delete', { apiId: 'openai', name: COPY }).catch(() => {});
await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => {});
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
check('nothing was sent to the model', modelCalls.length === 0, modelCalls.length);
console.log(JSON.stringify({ results, notes }, null, 1));
console.log(problems.length ? `FAILED: ${problems.join(', ')}` : 'ALL PASS');
await browser.close();
process.exit(problems.length ? 1 : 0);
