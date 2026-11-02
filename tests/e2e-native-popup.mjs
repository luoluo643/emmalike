// A question the full app asks is answered in the shell, on a phone, without switching to the full app:
// - the app's own dialogs (confirm, a line of input, ticks under a confirm) show their words, take the typed text
//   and ticks, and the button pressed reaches the app as if pressed there;
// - an extension's modal (role=dialog aria-modal, as Tavern Helper draws its "enable the scripts?") is asked too;
// - two dialogs at once are asked one after the other;
// - leaving the shell's copy unanswered brings back the 去确认 bar, which still shows the original.
// Usage: [SHOT_DIR=<folder>] node e2e-native-popup.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const shotDir = process.env.SHOT_DIR ?? '';
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const AVATAR = 'default_Seraphina.png';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.message ?? e).slice(0, 200)));
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const shot = async name => { if (shotDir) await page.waitForTimeout(700), await page.screenshot({ path: `${shotDir}/${name}.png` }); };

const engineEval = (fn, arg) => page.evaluate(([source, value]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'value', `return (${source})(w, value);`)(w, value);
}, [fn.toString(), arg]);
const sheet = page.locator('.tl-native-popup');
const bar = page.locator('.tl-popup-bar').filter({ hasText: '原版界面里有一项要你确认' });
const openNative = () => engineEval(w => [...w.document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')]
    .filter(el => el.getBoundingClientRect().width > 0).length);
const result = () => engineEval(w => w.__tlResult);
const waitResult = async () => {
    for (let i = 0; i < 30; i++) {
        const value = await result();
        if (value !== undefined) return value;
        await page.waitForTimeout(100);
    }
    return undefined;
};

try {
    const { token } = await (await context.request.get(`${base}/csrf-token`)).json();
    if (!(await context.request.post(`${base}/api/users/login`, { headers: { 'X-CSRF-Token': token }, data: { handle, password } })).ok()) throw new Error('login failed');
    await page.goto(`${appUrl}#chat=${encodeURIComponent(AVATAR)}`);
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    await page.waitForTimeout(1000);

    // 1. Confirm, answered yes.
    await engineEval(w => {
        const ctx = w.SillyTavern.getContext();
        w.__tlResult = undefined;
        ctx.callGenericPopup('<h3>要继续吗？</h3><p>第二行说明文字</p>', ctx.POPUP_TYPE.CONFIRM).then(r => { w.__tlResult = r; });
    });
    await sheet.waitFor({ timeout: 5000 });
    const text = await sheet.locator('.tl-native-popup-text').innerText();
    check('原版确认框的文字在轻酒馆里显示', text.includes('要继续吗') && text.includes('第二行说明文字'), JSON.stringify(text));
    const labels = await sheet.locator('.tl-row .tl-button').allInnerTexts();
    check('按钮照原样（两个，确定那个突出）', labels.length === 2 && await sheet.locator('.tl-row .tl-button.tl-primary').count() === 1, labels.join('|'));
    check('没有切到原版界面', !await page.locator('iframe.engine.visible').count() && !await bar.count());
    await shot('np-1-confirm');
    await sheet.locator('.tl-row .tl-button.tl-primary').click();
    check('点确定 → 原版收到「确定」', await waitResult() === 1);
    await sheet.waitFor({ state: 'detached', timeout: 3000 });
    check('原版弹窗已关', await openNative() === 0);

    // 2. Confirm, answered no.
    await engineEval(w => {
        const ctx = w.SillyTavern.getContext();
        w.__tlResult = undefined;
        ctx.callGenericPopup('删掉这一条吗？', ctx.POPUP_TYPE.CONFIRM).then(r => { w.__tlResult = r; });
    });
    await sheet.waitFor({ timeout: 5000 });
    await sheet.locator('.tl-row .tl-button:not(.tl-primary)').click();
    check('点取消 → 原版收到「取消」', await waitResult() === 0);

    // 3. A line of input.
    await engineEval(w => {
        const ctx = w.SillyTavern.getContext();
        w.__tlResult = undefined;
        ctx.callGenericPopup('给它起个名字', ctx.POPUP_TYPE.INPUT, '默认的名字').then(r => { w.__tlResult = r; });
    });
    await sheet.waitFor({ timeout: 5000 });
    const field = sheet.locator('.tl-native-popup-field .tl-input');
    check('输入框带着原来的值', await field.count() === 1 && await field.inputValue() === '默认的名字');
    await field.fill('新名字');
    await shot('np-3-input');
    await sheet.locator('.tl-row .tl-button.tl-primary').click();
    check('填的字传回原版', await waitResult() === '新名字');

    // 4. Ticks under a confirm.
    await engineEval(w => {
        const ctx = w.SillyTavern.getContext();
        w.__tlResult = undefined;
        const popup = new ctx.Popup('导入前确认', ctx.POPUP_TYPE.CONFIRM, '', { customInputs: [{ id: 'tl-np-remember', label: '记住这次选择', defaultState: false }] });
        popup.show().then(r => { w.__tlResult = { r, remember: popup.inputResults?.get('tl-np-remember') }; });
    });
    await sheet.waitFor({ timeout: 5000 });
    const tick = sheet.getByRole('switch', { name: '记住这次选择' });
    check('勾选项显示成开关', await tick.count() === 1 && await tick.getAttribute('aria-checked') === 'false');
    await tick.click();
    await sheet.locator('.tl-row .tl-button.tl-primary').click();
    const ticked = await waitResult();
    check('勾选传回原版', ticked?.r === 1 && ticked?.remember === true, JSON.stringify(ticked));

    // 5. An extension's modal that is not a <dialog>.
    await engineEval(w => {
        w.__tlResult = undefined;
        const host = w.document.createElement('div');
        host.className = 'TH-popup';
        host.innerHTML = '<div class="popup" role="dialog" aria-modal="true" style="position:fixed;inset:20% 10%;background:#222;color:#fff;z-index:9999">'
            + '<p>角色卡带有脚本，是否现在就启用它们?</p><div><div class="menu_button popup-button-ok">确认</div><div class="menu_button">取消</div></div></div>';
        for (const [i, el] of [...host.querySelectorAll('.menu_button')].entries()) el.addEventListener('click', () => { w.__tlResult = i === 0 ? 'ok' : 'no'; host.remove(); });
        w.document.body.append(host);
    });
    await sheet.waitFor({ timeout: 5000 });
    check('扩展的弹窗（aria-modal）也在轻酒馆里问', (await sheet.innerText()).includes('是否现在就启用它们'));
    await shot('np-5-extension');
    await sheet.getByRole('button', { name: '确认', exact: true }).click();
    check('点确认 → 扩展收到', await waitResult() === 'ok');
    await page.waitForTimeout(800);
    check('之后没有遗留提示', !await sheet.count() && !await bar.count());

    // 6. Two at once.
    await engineEval(w => {
        const ctx = w.SillyTavern.getContext();
        w.__tlResult = [];
        ctx.callGenericPopup('第一个问题', ctx.POPUP_TYPE.CONFIRM).then(r => w.__tlResult.push(['一', r]));
        ctx.callGenericPopup('第二个问题', ctx.POPUP_TYPE.CONFIRM).then(r => w.__tlResult.push(['二', r]));
    });
    await sheet.waitFor({ timeout: 5000 });
    const first = await sheet.locator('.tl-native-popup-text').innerText();
    await sheet.locator('.tl-row .tl-button.tl-primary').click();
    await page.waitForTimeout(1200);
    const second = await sheet.count() ? await sheet.locator('.tl-native-popup-text').innerText() : '';
    check('两个弹窗依次问', !!second && second !== first, `${first} → ${second}`);
    if (second) await sheet.locator('.tl-row .tl-button.tl-primary').click();
    await page.waitForTimeout(600);
    check('两个都答到了', (await result())?.length === 2 && await openNative() === 0, JSON.stringify(await result()));

    // 7. Left unanswered: the bar comes back and still shows the original.
    await engineEval(w => {
        const ctx = w.SillyTavern.getContext();
        w.__tlResult = undefined;
        ctx.callGenericPopup('先不回答的问题', ctx.POPUP_TYPE.CONFIRM).then(r => { w.__tlResult = r; });
    });
    await sheet.waitFor({ timeout: 5000 });
    await sheet.getByRole('button', { name: '关闭' }).click();
    await bar.waitFor({ timeout: 3000 });
    check('关掉后退回「去确认」条，原版弹窗还在', await openNative() === 1);
    await bar.getByRole('button', { name: '去确认' }).click();
    await page.locator('iframe.engine.visible').waitFor({ timeout: 3000 });
    check('去确认 → 切到原版界面', true);
    await engineEval(w => w.document.querySelector('dialog[open] .popup-button-ok').click());
    await page.locator('iframe.engine.visible').waitFor({ state: 'detached', timeout: 5000 }).catch(() => { });
    await page.waitForTimeout(800);
    check('在原版答完后自动回到轻酒馆', !await page.locator('iframe.engine.visible').count() && await result() === 1);

    check('页面无报错', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
    failed++;
    console.log('FAILURE', String(error.message ?? error).split('\n')[0]);
    await shot('np-error');
}
await browser.close();
console.log(failed ? 'PROBLEMS' : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
