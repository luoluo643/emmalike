// Quick row above the input: closed by default and opened from ⌃ in the 番外 bar (only when there are quick buttons;
// the preset is not in it but in the story menu); a quick button can be left out of the row (kept in the account)
// and brought back; the bar stays one line on phones.
// Usage: node e2e-quick.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `快捷测试${run}`;
const results = {}, problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`; if (!ok) problems.push(name); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const engineEval = (fn, arg) => page.evaluate(([source, a]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'a', `return (${source})(w, a);`)(w, a);
}, [fn.toString(), arg]);
const synced = () => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const settled = async () => {
    await page.waitForFunction(() => !history.state?.tlLayer && !document.querySelector('[role="dialog"]'), null, { timeout: 10000 }).catch(() => { });
    await page.waitForTimeout(500);
};

const created = await page.request.post(`${base}/api/characters/create`, {
    headers: { 'X-CSRF-Token': token },
    multipart: { ch_name: NAME, description: '', first_mes: '你来了。', personality: '', scenario: '', mes_example: '', creator_notes: '',
        system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' },
});
const avatar = (await created.text()).trim();
let hiddenBefore = null;
// A button of our own in the full app's bar above its input (#qr--bar, as Quick Replies and Tavern Helper render it).
const addQuickButton = () => engineEval(w => {
    const form = w.document.getElementById('send_form');
    if (!form || form.querySelector('.tlq-button')) return;
    let bar = [...form.querySelectorAll('div')].find(div => div.id === 'qr--bar');
    if (!bar) { bar = w.document.createElement('div'); bar.id = 'qr--bar'; form.prepend(bar); }
    let buttons = bar.querySelector('.qr--buttons');
    if (!buttons) { buttons = w.document.createElement('div'); buttons.className = 'qr--buttons'; bar.append(buttons); }
    const button = w.document.createElement('div');
    button.className = 'qr--button menu_button interactable tlq-button';
    button.textContent = '快捷测试按钮';
    buttons.append(button);
});
const toggle = () => page.locator('.tl-quick-toggle');
try {
    await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: '' })}`);
    await synced();
    hiddenBefore = await engineEval(w => w.SillyTavern.getContext().extensionSettings.tavernLite?.hiddenInputButtons ?? null);
    const bar = page.locator('.tl-episode-bar');
    check('quick row: closed by default', await page.locator('#tl-quick-row').count() === 0);
    check('番外 bar: one line on a phone', (await bar.boundingBox()).height < 56, await bar.boundingBox());
    const noButtons = !(await engineEval(w => w.TavernLiteBridge.inputButtons().length));
    if (noButtons) check('no quick buttons: no ⌃ toggle and no empty row', await toggle().count() === 0 && await page.locator('#tl-quick-row').count() === 0);
    await addQuickButton();
    await toggle().waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: '展开快捷按钮' }).click();
    const row = page.locator('#tl-quick-row');
    await row.waitFor({ timeout: 10000 });
    check('quick row: no preset chip', await row.locator('.tl-chip-preset').count() === 0 && !(await row.innerText()).includes('预设'), await row.innerText());
    const chip = row.locator('.tl-chip', { hasText: '快捷测试按钮' });
    check('quick row: low chips', (await chip.boundingBox()).height <= 32, await chip.boundingBox());
    // The preset lives in the story menu: the presets to switch to come first, adjusting the current one's entries below.
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await page.getByRole('button', { name: /^预设：/ }).click();
    const picker = page.getByRole('dialog', { name: '换预设' });
    await picker.waitFor({ timeout: 10000 });
    const items = await picker.locator('.tl-sheet-item').allInnerTexts();
    const adjust = items.findIndex(t => t.startsWith('开关和编辑条目'));
    check('preset sheet: presets first, adjusting entries below them', adjust > 0 && await picker.locator('.tl-sheet-item').first().getAttribute('role') === 'radio', items);
    const count = await picker.getByRole('radio').count();
    check('preset sheet lists presets, current checked', count > 0 && await picker.locator('[role="radio"][aria-checked="true"]').count() === 1, count);
    if (count > 1) {
        const original = (await picker.locator('[role="radio"][aria-checked="true"] .tl-sheet-item-label').innerText()).trim();
        await picker.locator('[role="radio"][aria-checked="false"]').first().click();
        await picker.waitFor({ state: 'detached', timeout: 15000 });
        await settled();
        await page.getByRole('button', { name: '更多', exact: true }).click();
        check('switching a preset shows in the story menu', !(await page.getByRole('button', { name: /^预设：/ }).innerText()).includes(original));
        await page.getByRole('button', { name: /^预设：/ }).click();
        await page.getByRole('dialog', { name: '换预设' }).getByRole('radio', { name: original }).click();
        await page.getByRole('dialog', { name: '换预设' }).waitFor({ state: 'detached', timeout: 15000 });
        await settled();
    } else {
        await picker.getByRole('button', { name: '关闭' }).click();
        await settled();
    }
    // Hiding through the manage sheet; kept in the account.
    await row.locator('.tl-chip-quiet').click();
    const manage = page.getByRole('dialog', { name: '管理快捷按钮' });
    await manage.getByRole('switch', { name: '快捷测试按钮' }).click();
    await page.waitForTimeout(300);
    const stored = await engineEval(w => w.SillyTavern.getContext().extensionSettings.tavernLite?.hiddenInputButtons ?? []);
    check('hiding a quick button is kept in the account', stored.includes('快捷测试按钮'), stored);
    check('hidden button leaves the row', !(await row.locator('.tl-chip', { hasText: '快捷测试按钮' }).count()));
    await manage.getByRole('switch', { name: '快捷测试按钮' }).click();
    await manage.getByRole('button', { name: '关闭' }).click();
    await settled();
    await page.reload();
    await synced();
    await addQuickButton();
    await row.waitFor({ timeout: 15000 });
    check('quick row: stays open on this device', await row.count() === 1);
    await page.getByRole('button', { name: '收起快捷按钮' }).click();
    check('quick row: closes', await page.locator('#tl-quick-row').count() === 0);
} finally {
    await engineEval((w, a) => {
        const c = w.SillyTavern.getContext();
        c.extensionSettings.tavernLite = { ...(c.extensionSettings.tavernLite ?? {}), hiddenInputButtons: a ?? undefined };
        if (a === null) delete c.extensionSettings.tavernLite.hiddenInputButtons;
        c.saveSettingsDebounced();
    }, hiddenBefore).catch(() => { });
    await page.waitForTimeout(3000);
    await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
    await browser.close();
}
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(JSON.stringify(results, null, 2));
if (problems.length) { console.error('FAILED:', problems.join(', ')); process.exit(1); }
