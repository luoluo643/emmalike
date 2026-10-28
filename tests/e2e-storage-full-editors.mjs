// Device storage full of earlier preset save receipts (each held the whole preset four times; a long preset is a few
// hundred KB, and they were never removed). Before the fix the next preset save stopped ("这次没存") and world book
// entries could not be kept as drafts, so their editor was read-only. Now: a world entry is edited and saved, and
// the preset saves again and again after an entry's text is applied, each time saying it was saved.
// Runs on a copy of the current settings, padded to the size of a long preset.
// Usage: node e2e-storage-full-editors.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const PRESET = `存满${run}`, BOOK = `存满世界${run}`;
const results = {}, problems = [];
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
const readPreset = async () => {
    const all = await (await post('/api/settings/get', {})).json(), at = all.openai_setting_names?.indexOf(PRESET);
    return at >= 0 ? JSON.parse(all.openai_settings[at]) : null;
};
const readBook = async name => (await (await post('/api/worldinfo/get', { name })).json()) ?? {};
const clearFill = () => page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.includes('"fill-')) localStorage.removeItem(k); }).catch(() => { });

let presetName = null;
const cleanup = async () => {
    await clearFill();
    if (presetName) await engineEval(async (w, name) => {
        const select = w.document.getElementById('settings_preset_openai');
        const option = [...select.options].find(o => o.textContent.trim() === name);
        if (option) { select.value = option.value; select.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 1500)); }
    }, presetName).catch(() => { });
    await post('/api/presets/delete', { apiId: 'openai', name: PRESET }).catch(() => { });
    await post('/api/worldinfo/delete', { name: BOOK }).catch(() => { });
};
let failing = false;
process.on('uncaughtException', async error => {
    if (failing) process.exit(3);
    failing = true;
    console.log('FAILURE', error.message.split('\n').slice(0, 8).join(' | '), (error.stack ?? '').split('\n').find(l => l.includes('e2e-storage-full')));
    console.log(JSON.stringify({ toasts: await page.evaluate(() => window.__tlToasts).catch(() => null), results, pageErrors }, null, 1));
    if (process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT }).catch(() => { });
    await cleanup(); await browser.close(); process.exit(2);
});
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');

// A long preset: one prompt padded to about the size of a large real preset (250,000 characters).
const current = JSON.parse((await (await post('/api/settings/get', {})).json()).settings).oai_settings;
const padded = structuredClone(current);
const main = padded.prompts?.find(p => p.identifier === 'main');
if (main) main.content = `${main.content}\n${'很长的预设。'.repeat(40000)}`;
if (!(await post('/api/presets/save', { apiId: 'openai', name: PRESET, preset: padded })).ok()) throw new Error('preset not saved');
check('fixture book saved', (await post('/api/worldinfo/edit', { name: BOOK, data: { entries: {
    0: { uid: 0, key: ['森林'], keysecondary: [], comment: '森林', content: '森林里很安静。', constant: false, disable: false, order: 100, position: 0, displayIndex: 0 },
} } })).ok());

await page.goto(`${appUrl}#me`);
await page.locator('.tl-me').waitFor();
await page.waitForFunction(() => !!document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge?.presetState, null, { timeout: 240000 });
await page.reload();
await page.locator('.tl-me').waitFor();
await page.waitForFunction(() => !!document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge?.presetState, null, { timeout: 240000 });
presetName = await engineEval(w => w.SillyTavern.getContext().chatCompletionSettings.preset_settings_openai);
check('test preset selected', await engineEval(async (w, name) => {
    const select = w.document.getElementById('settings_preset_openai');
    const option = [...select.options].find(o => o.textContent.trim() === name);
    if (!option) return false;
    select.value = option.value; select.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 2500));
    return w.SillyTavern.getContext().chatCompletionSettings.preset_settings_openai === name;
}, PRESET));

// Fill the device storage with receipts as earlier versions left them after confirmed saves.
const filled = await page.evaluate(account => {
    let count = 0;
    for (const size of [1 << 20, 1 << 17, 1 << 14, 1 << 11, 1 << 8]) {
        const filler = 'x'.repeat(size);
        for (;;) {
            const id = `fill-${count}`;
            try { localStorage.setItem(`tavern-lite:preset-operation:${JSON.stringify([account, id])}`, JSON.stringify({ version: 2, id, account, apiId: 'openai', name: 'old',
                mode: 'save', stage: 'confirmed', writeOutcome: 'confirmed', revision: 3, expected: { filler } })); count++; }
            catch { break; }
        }
    }
    let full = false; try { localStorage.setItem('tl-probe', 'x'.repeat(4096)); localStorage.removeItem('tl-probe'); } catch { full = true; }
    return { count, full };
}, handle);
check('device storage is full of old receipts', filled.full && filled.count > 3, JSON.stringify(filled));

// --- A world book entry: edited and saved -------------------------------------------------------------------------
await page.goto(`${appUrl}#${new URLSearchParams({ world: BOOK })}`);
await page.locator('.tl-world-row').first().waitFor({ timeout: 60000 });
await page.locator('.tl-world-open', { hasText: '森林' }).click();
await page.locator('.tl-entry-editor').waitFor();
await page.locator('#tl-wi-content').fill(`林子里起风了。${run}`);
const saveEntry = page.getByRole('button', { name: '保存', exact: true });
const readOnly = await page.locator('.tl-entry-editor').innerText().then(t => t.includes('本机存不了世界书草稿'));
check('the entry editor is not read-only', !readOnly && await saveEntry.isEnabled());
if (await saveEntry.isEnabled()) {
    await saveEntry.click();
    await page.waitForFunction(() => [...document.querySelectorAll('.tl-entry-editor button')].some(b => b.textContent === '保存' && b.disabled), null, { timeout: 30000 }).catch(() => { });
}
check('the entry is saved into the book', (await readBook(BOOK)).entries?.[0]?.content === `林子里起风了。${run}`);
await page.getByRole('button', { name: '返回', exact: true }).click();
await page.locator('.tl-world-book').waitFor({ timeout: 15000 }).catch(() => { });

// --- The preset: an entry's text applied, then saved, saved again, edited and saved ---------------------------------
const statusText = () => page.locator('.tl-preset-savebar [role=status]').innerText();
const saveButton = () => page.getByRole('button', { name: '保存到此预设', exact: true });
const saveOnce = async () => {
    await saveButton().waitFor();
    const ready = await page.waitForFunction(() => {
        const b = [...document.querySelectorAll('.tl-preset-savebar button')].find(x => x.textContent === '保存到此预设'); return b && !b.disabled;
    }, null, { timeout: 30000 }).then(() => true).catch(() => false);
    if (!ready) return `（保存按钮不可点）${await statusText()}`;
    await saveButton().click();
    await page.waitForFunction(() => {
        const s = document.querySelector('.tl-preset-savebar [role=status]')?.textContent || '';
        const b = [...document.querySelectorAll('.tl-preset-savebar button')].find(x => x.textContent === '保存到此预设');
        return b && !b.disabled && !/正在|检查…/.test(s) || /不知道|没存|失败|重新加载后再存/.test(s);
    }, null, { timeout: 90000 });
    await page.waitForTimeout(600);
    return statusText();
};
const editEntry = async (identifier, text) => {
    await page.locator(`.tl-preset-row[data-id="${identifier}"] .tl-preset-open`).click();
    await page.locator('#tl-prompt-text').waitFor();
    await page.locator('#tl-prompt-text').fill(text);
    await page.getByRole('button', { name: /^(应用|保存)$/ }).first().click();
    await page.waitForFunction(() => /已应用|已保存|已用上/.test(document.querySelector('.tl-preset-editor-actions')?.textContent || ''), null, { timeout: 30000 });
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.locator('.tl-preset-savebar').waitFor({ timeout: 15000 });
};
const saidSaved = text => /已存进预设/.test(text) && !/不知道|没存/.test(text);
const contentOf = async id => (await readPreset())?.prompts?.find(p => p.identifier === id)?.content ?? '';

await page.goto(`${appUrl}#preset`);
await page.getByText(`「${PRESET}」`).first().waitFor({ timeout: 90000 });
const state = await engineEval(w => w.TavernLiteBridge.presetState());
const editable = state.prompts.find(p => p.canEdit && p.identifier !== 'main') ?? state.prompts.find(p => p.canEdit);
const was = await engineEval((w, id) => w.TavernLiteBridge.presetPrompt(id).content, editable.identifier);

await editEntry(editable.identifier, `${was}\n（第一次 ${run}）`);
const first = await saveOnce();
check('first save after an entry edit says saved', saidSaved(first), first);
check('the file has the first edit', (await contentOf(editable.identifier)).endsWith(`（第一次 ${run}）`));
const again = await saveOnce();
check('saving again with nothing new says saved', saidSaved(again), again);
await editEntry(editable.identifier, `${was}\n（第二次 ${run}）`);
const second = await saveOnce();
check('saving after a second entry edit says saved', saidSaved(second), second);
check('the file has the second edit', (await contentOf(editable.identifier)).endsWith(`（第二次 ${run}）`));
check('no unknown-save notice is left', await page.locator('[data-preset-operation]').count() === 0);
const left = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('tavern-lite:preset-operation:')).length);
check('old settled receipts were cleared, one receipt is left', left <= 1, String(left));

// Opening entries and leaving with the phone's back leaves no drafts behind (they held each entry three times and
// were kept for every entry opened).
const storedDrafts = () => page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('tavern-lite:preset-draft:') || k.startsWith('tavern-lite:world-draft:v1:')));
await page.locator(`.tl-preset-row[data-id="${editable.identifier}"] .tl-preset-open`).click();
await page.locator('#tl-prompt-text').waitFor();
await page.waitForTimeout(500);
await page.goBack();
await page.locator('.tl-preset-savebar').waitFor({ timeout: 15000 });
await page.goto(`${appUrl}#${new URLSearchParams({ world: BOOK })}`);
await page.locator('.tl-world-open', { hasText: '森林' }).click({ timeout: 60000 });
await page.locator('.tl-entry-editor').waitFor();
await page.waitForTimeout(500);
await page.goBack();
await page.locator('.tl-world-book').waitFor({ timeout: 15000 });
const drafts = await storedDrafts();
check('opening entries and going back leaves no stored drafts', drafts.length === 0, JSON.stringify(drafts));

console.log(JSON.stringify({ toasts: await page.evaluate(() => window.__tlToasts) }, null, 1));
await cleanup();
// The app's own writes may hit the full storage before it is cleared; only the shell's errors count here.
const own = pageErrors.filter(e => !/QuotaExceeded|exceeded the quota/i.test(e));
check('no page errors', own.length === 0, own.join(' | '));
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `FAILED: ${problems.join(', ')}` : 'ALL PASS');
await browser.close();
process.exit(problems.length ? 1 : 0);
