// The 番外 panel's notice (2026-10-22): plain words; it names, by their own display names, the installed extensions
// whose code changes chat records, and only those keep 番外 from being written apart. An extension switched off
// counts as off after a reload. Expected names are read from the extensions' manifests, not written here.
// Writes screenshots to $SHOT_DIR (default /root) as tl-episode-hint-*.png.
// Usage: node e2e-episode-hint.mjs <baseUrl> <handle> <password> [latencyMs] [downKbps]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const shots = process.env.SHOT_DIR ?? '/root';
const run = Date.now().toString(36);
const NAME = `番外提示测试${run}`;
const WRITER = 'third-party/JS-Slash-Runner';
const QUIET = 'third-party/tl-test-panel';
const results = {};
const problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`; if (!ok) problems.push(name); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));

const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
let avatar = '';
let switchedOff = false;

const engineEval = (fn, arg) => page.evaluate(([source, a]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'a', `return (${source})(w, a);`)(w, a);
}, [fn.toString(), arg]);
const setDisabled = async (name, off) => {
    await engineEval((w, a) => {
        const c = w.SillyTavern.getContext();
        const list = c.extensionSettings.disabledExtensions;
        const at = list.indexOf(a.name);
        if (a.off && at < 0) list.push(a.name);
        if (!a.off && at >= 0) list.splice(at, 1);
        c.saveSettingsDebounced();
    }, { name, off });
    // Account settings are saved after a delay.
    await page.waitForTimeout(3500);
};

const cleanup = async () => {
    if (switchedOff) await setDisabled(WRITER, false).catch(() => { });
    if (avatar) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
};

let failing = false;
process.on('uncaughtException', async error => {
    if (failing) process.exit(3);
    failing = true;
    console.log('FAILURE', error.message.split('\n').slice(0, 12).join(' | '), (error.stack ?? '').split('\n').find(l => l.includes('e2e-episode-hint.mjs')));
    console.log(JSON.stringify({ results, pageErrors }, null, 1));
    if (process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT }).catch(() => { });
    await cleanup();
    await browser.close();
    process.exit(2);
});

if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const label = async name => (await (await page.request.get(`${base}/scripts/extensions/${name}/manifest.json`)).json()).display_name;
const writerLabel = await label(WRITER);
const quietLabel = await label(QUIET);

const created = await page.request.post(`${base}/api/characters/create`, {
    headers: { 'X-CSRF-Token': token },
    multipart: {
        ch_name: NAME, description: '测试番外提示的角色', first_mes: '“你来了。”', personality: '', scenario: '', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '',
    },
});
avatar = (await created.text()).trim();
if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);

const synced = () => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const status = () => engineEval(w => w.TavernLiteBridge.episodeStatus());
const openStory = async () => {
    await page.goto(appUrl);
    await page.locator('.tl-library').waitFor({ timeout: 60000 });
    await page.evaluate(a => { location.hash = new URLSearchParams({ chat: a, file: '' }).toString(); }, avatar);
    await synced();
    // The check of other extensions finishes shortly after the page loads.
    await page.waitForFunction(() => {
        const s = document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge?.episodeStatus?.();
        return s && !s.scanning;
    }, null, { timeout: 60000 });
};
const openPanel = async () => {
    await page.getByRole('button', { name: '番外与平行线' }).click();
    const dialog = page.getByRole('dialog', { name: '番外与平行线' });
    await dialog.waitFor();
    await page.waitForTimeout(500);
    return dialog;
};

// With an extension that saves chat records (Tavern Helper) and one that does not (the test panel).
await openStory();
{
    const dialog = await openPanel();
    const note = await dialog.locator('.tl-episode-limit').innerText().catch(() => '');
    const s = await status();
    check('an extension that writes chat records no longer stops writing apart', !s.reasons.some(r => r.includes('会改动聊天记录')), JSON.stringify(s.reasons));
    check('old wording is gone', !/隔离验收|仅支持整理|异步写入|共享动态记录/.test(note), note);
    check('the extension that writes chat records is named by its display name', !!writerLabel && note.includes(`${writerLabel} 会改动聊天记录`), note);
    check('the warning says the story is checked afterwards', note.includes('写完会检查正文'), note);
    check('an extension that does not write chat records is not named', !!quietLabel && !note.includes(quietLabel), note);
    check('status lists the writer', s.recordWriters?.some(e => e.name === WRITER && e.label === writerLabel) && !s.recordWriters.some(e => e.name === QUIET),
        JSON.stringify(s.recordWriters));
    await page.screenshot({ path: `${shots}/tl-episode-hint-writer.png` });
    await page.getByRole('dialog').last().getByRole('button', { name: '关闭' }).click();
}

// Switched off without a reload, its code is still running in this page: it still counts.
await setDisabled(WRITER, true);
switchedOff = true;
check('switched off without a reload still counts', (await status()).recordWriters.some(e => e.name === WRITER));

// After a reload it is off and no longer keeps 番外 from being written apart.
await openStory();
{
    const s = await status();
    check('switched off and reloaded no longer counts', !s.recordWriters.some(e => e.name === WRITER) && !s.warnings.some(r => r.includes('会改动聊天记录')),
        JSON.stringify(s.warnings));
    const dialog = await openPanel();
    const note = await dialog.locator('.tl-episode-limit').innerText().catch(() => '');
    check('the panel matches the status', !note.includes('会改动聊天记录') && (s.verified ? !s.warnings.length === (note === '') : true), JSON.stringify({ verified: s.verified, note }));
    console.log('after switching the writer off:', JSON.stringify({ verified: s.verified, reasons: s.reasons }));
    await page.screenshot({ path: `${shots}/tl-episode-hint-no-writer.png` });
    await page.getByRole('dialog').last().getByRole('button', { name: '关闭' }).click();
}

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await cleanup();
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS: ${problems.join(', ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
