// Isolated real SillyTavern + mock model: recovery, cancellation, HTTP save races and mobile layout.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { trackFixtureWrites } from './regression-fixtures.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const [base = 'http://127.0.0.1:8031', handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
assert.ok(['http://127.0.0.1:8031', 'http://127.0.0.1:8035'].includes(base), 'This regression writes fixtures only to the isolated test instances (8031, or the temporary 8035)');
const out = process.env.TEST_OUTPUT ?? '/tmp/tavern-improvements/evidence';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await trackFixtureWrites(context, out);
const page = await context.newPage(); page.setDefaultTimeout(20000);
const errors = [], results = [];
page.on('pageerror', e => errors.push(e.message));
await context.addInitScript(() => {
    window.__toasts = [];
    new MutationObserver(rs => rs.forEach(r => r.addedNodes.forEach(n => {
        if (n.classList?.contains('tl-toast')) window.__toasts.push(n.textContent);
    }))).observe(document, { childList: true, subtree: true });
});
const check = (name, ok) => { assert.ok(ok, name); results.push(name); console.log('PASS', name); };
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
const { token } = await (await context.request.get(base + '/csrf-token')).json();
const post = (path, data) => context.request.post(base + path, { headers: { 'X-CSRF-Token': token }, data });
await post('/api/users/login', { handle, password });
const app = base + '/scripts/extensions/third-party/emmalike/app/';
const avatar = 'default_Seraphina.png', file = `reliability-${Date.now()}`, preset = `reliability-preset-${Date.now()}`;
await writeFile(out + '/fixtures.json', JSON.stringify({ avatar, file, preset }));
const url = app + '#' + new URLSearchParams({ chat: avatar, file });
const chat = [{ user_name: 'User', character_name: 'Seraphina', chat_metadata: {} }];
for (let n = 0; n < 90; n++) chat.push({ name: n % 2 ? 'User' : 'Seraphina', is_user: !!(n % 2), is_system: false,
    send_date: new Date().toISOString(), extra: { regressionFixture: file }, mes: Array.from({ length: 5 }, (_, p) => `消息${n}段落${p}。雨停了，书店里响起翻书的声音。`.repeat(3)).join('\n\n') });
await post('/api/chats/save', { ch_name: 'Seraphina', file_name: file, chat, avatar_url: avatar });
const native = (fn, arg) => page.evaluate(([source, a]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'a', `return (${source})(w,a)`)(w, a);
}, [fn.toString(), arg]);
const synced = () => page.locator('.tl-composer-input[data-synced="true"]').waitFor({ timeout: 240000 });
const topMessage = () => page.locator('.tl-messages').evaluate(el => {
    const top = el.getBoundingClientRect().top + 81;
    const article = [...el.querySelectorAll('.tl-message[data-index]')].find(n => n.getBoundingClientRect().bottom > top);
    const p = [...article.querySelectorAll('p')].find(n => n.getBoundingClientRect().bottom > top);
    return { index: Number(article.dataset.index), text: p?.textContent, y: p?.getBoundingClientRect().top };
});
let initialPreset;
try {
    const engineGate = gate();
    await page.route(base + '/', async r => { await engineGate.promise; await r.continue().catch(() => {}); });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('.tl-composer-input').fill('取消测试：不应发送');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.locator('[data-pending="true"]').waitFor();
    await page.locator('.tl-composer-input').fill('后来输入的内容');
    await page.getByRole('button', { name: '改一改', exact: true }).click();
    check('取回编辑保留后来输入的内容', await page.locator('.tl-composer-input').inputValue() === '后来输入的内容\n取消测试：不应发送');
    await page.screenshot({ path: out + '/pending-restored.png' });
    engineGate.release(); await page.unroute(base + '/'); await synced();
    initialPreset = await native(w => w.SillyTavern.getContext().chatCompletionSettings.preset_settings_openai);
    await writeFile(out + '/fixtures.json', JSON.stringify({ avatar, file, preset, initialPreset }));
    check('引擎就绪后取消的消息没有进入聊天', !await native(w => w.SillyTavern.getContext().chat.some(m => m.mes.includes('取消测试'))));
    const stored = await (await post('/api/chats/get', { ch_name: 'Seraphina', file_name: file, avatar_url: avatar })).json();
    check('服务器聊天文件也没有取消的消息', !JSON.stringify(stored).includes('取消测试'));
    await page.locator('.tl-composer-input').fill('');
    while (!await page.locator('.tl-message[data-index="12"]').count()) await page.getByRole('button', { name: /查看更早/ }).click();
    await page.locator('.tl-messages').evaluate(el => {
        el.dispatchEvent(new WheelEvent('wheel'));
        const p = el.querySelector('.tl-message[data-index="12"] p:nth-of-type(3)');
        el.scrollTop += p.getBoundingClientRect().top - el.getBoundingClientRect().top - 80;
        el.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(300);
    const before = await topMessage();
    check('基准位置位于旧消息12的段落2', before.index === 12 && before.text.includes('段落2'));
    await page.reload(); await synced(); await page.waitForTimeout(800);
    const after = await topMessage();
    check('刷新后加载更早消息并恢复同一段落', after.index === before.index && after.text === before.text && Math.abs(after.y - before.y) < 8);
    await page.screenshot({ path: out + '/reading-restored.png' });
    await page.locator('.tl-message[data-index="11"]').evaluate(el => { el.style.minHeight = (el.clientHeight + 400) + 'px'; });
    await page.waitForTimeout(300);
    check('上方内容延迟撑高后保持段落位置', Math.abs((await topMessage()).y - before.y) < 8);
    // A real generated reply while the reader is holding old content must not force the list to the end.
    await native(w => w.TavernLiteBridge.send('测试新内容不推底'));
    await page.waitForFunction(() => !document.querySelector('iframe.engine').contentWindow.TavernLiteBridge.isGenerating(), null, { timeout: 120000 });
    check('读旧内容时新回复不会推到底部', (await topMessage()).index === 12);
    // Exercise cancellation in the real bridge's queue, held behind a pending preset HTTP operation.
    const queueGate = gate(); let queueEntered = false;
    await page.route('**/api/presets/save', async r => { queueEntered = true; await queueGate.promise; await r.continue(); });
    await native(w => { w.__hold = w.TavernLiteBridge.savePreset(); return null; });
    while (!queueEntered) await page.waitForTimeout(30);
    await page.locator('.tl-composer-input').fill('桥接队列取消测试');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByRole('button', { name: '取消发送', exact: true }).click();
    queueGate.release(); await native(w => w.__hold); await page.unroute('**/api/presets/save');
    await page.waitForTimeout(300);
    check('桥接队列取消后也不发送', !await native(w => w.SillyTavern.getContext().chat.some(m => m.mes.includes('桥接队列取消'))));
    // Restore old anchor, then delete its message. The previous neighbor is an explicit approximation.
    await page.locator('.tl-messages').evaluate(el => {
        el.dispatchEvent(new WheelEvent('wheel'));
        const p = el.querySelector('.tl-message[data-index="12"] p:nth-of-type(3)');
        el.scrollTop += p.getBoundingClientRect().top - el.getBoundingClientRect().top - 80;
        el.dispatchEvent(new Event('scroll'));
    });
    await page.reload(); await synced();
    await native(async w => { await w.TavernLiteBridge.deleteMessageAt(12); });
    await page.waitForTimeout(400);
    check('删除锚点后明确提示大致位置', await page.evaluate(() => window.__toasts.some(t => t.includes('大致位置'))));
    await page.getByRole('button', { name: '回到最新', exact: true }).click();
    check('回到最新定位末尾', await page.locator('.tl-messages').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 5));
    // Rename migrates only this account and this story's state.
    const renamed = file + '-renamed';
    await native((w, a) => w.TavernLiteBridge.renameChapter(a.avatar, a.file, a.renamed), { avatar, file, renamed });
    check('改名同步迁移阅读状态', await page.evaluate(({ handle, avatar, file, renamed }) => {
        const key = f => `tavern-lite:v2:reading:${JSON.stringify([handle, avatar, f])}`;
        return !localStorage.getItem(key(file)) && !!localStorage.getItem(key(renamed));
    }, { handle, avatar, file, renamed }));
    await native((w, a) => w.TavernLiteBridge.renameChapter(a.avatar, a.renamed, a.file), { avatar, renamed, file });

    // Clone the active preset and add enough prompts to reproduce the long-page save problem.
    initialPreset = await native(w => w.SillyTavern.getContext().chatCompletionSettings.preset_settings_openai);
    const config = await native(w => JSON.parse(JSON.stringify(w.SillyTavern.getContext().chatCompletionSettings)));
    const extras = Array.from({ length: 222 }, (_, n) => ({ identifier: `reliability-${n}`, name: `测试条目${n}`, role: 'system', content: `测试${n}`, system_prompt: false }));
    // A prior run can leave test prompts in the account's active settings. Replace our
    // fixture namespace instead of opening an older duplicate with already-applied text.
    config.prompts = [...(config.prompts || []).filter(p => !p.identifier?.startsWith('reliability-')), ...extras];
    config.prompt_order.forEach(order => {
        order.order = order.order.filter(p => !p.identifier?.startsWith('reliability-'));
        order.order.push(...extras.map(p => ({ identifier: p.identifier, enabled: false })));
    });
    await post('/api/presets/save', { apiId: 'openai', name: preset, preset: config });
    await page.goto(app + '#me'); await page.reload();
    await page.waitForFunction(() => !!document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge, null, { timeout: 240000 });
    await native(async (w, name) => {
        const el = w.document.getElementById('settings_preset_openai');
        el.value = [...el.options].find(o => o.textContent.trim() === name).value;
        el.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 1000));
    }, preset);
    await page.getByRole('button', { name: /^设置与扩展/ }).click();
    await page.getByRole('button', { name: /^预设与提示词/ }).click();
    await page.locator('.tl-preset-savebar').waitFor();
    await page.getByRole('group', { name: '预设设置显示范围' }).getByRole('button', { name: '全部设置' }).click();
    check('至少222条提示词已呈现', await page.locator('.tl-preset-row').count() >= 222);
    check('手机首屏能看到保存入口', (await page.locator('.tl-preset-savebar').boundingBox()).y < 700);
    await page.locator('.tl-preset-row').last().scrollIntoViewIfNeeded();
    const bar = await page.locator('.tl-preset-savebar').boundingBox();
    check('滚到底部时保存入口仍在视窗', bar.y >= 0 && bar.y + bar.height < 844);
    await page.screenshot({ path: out + '/preset-sticky.png' });
    // The preset page applies a change to the current settings at once and saves to the named preset on request;
    // while a save runs the boxes are locked, so nothing typed meanwhile can be lost or half saved.
    const temp = page.locator('#tl-preset-temperature');
    const saveButton = page.getByRole('button', { name: '保存到此预设', exact: true });
    const serverTemp = async () => { const s = await (await post('/api/settings/get', {})).json(); return JSON.parse(s.openai_settings[s.openai_setting_names.indexOf(preset)]).temperature; };
    await temp.fill('0.61'); await temp.press('Tab');
    await page.waitForFunction(v => document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().chatCompletionSettings.temp_openai === v, 0.61);
    const saveGate = gate(); let entered = false;
    await page.route('**/api/presets/save', async r => { entered = true; await saveGate.promise; await r.continue(); });
    await saveButton.click();
    while (!entered) await page.waitForTimeout(30);
    check('保存进行中禁用重复提交', await page.getByRole('button', { name: '正在保存…', exact: true }).isDisabled());
    check('保存进行中参数框锁定', await temp.isDisabled());
    saveGate.release();
    await saveButton.waitFor(); await page.waitForFunction(() => !document.querySelector('#tl-preset-temperature')?.disabled);
    await page.unroute('**/api/presets/save');
    check('服务器写入点击保存时的版本', await serverTemp() === 0.61);
    await temp.fill('0.72'); await temp.press('Tab');
    await page.waitForFunction(v => document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().chatCompletionSettings.temp_openai === v, 0.72);
    await page.route('**/api/presets/save', r => r.fulfill({ status: 500, body: 'test failure' }));
    await saveButton.click();
    await saveButton.waitFor(); await page.waitForFunction(() => !document.querySelector('#tl-preset-temperature')?.disabled);
    check('保存失败时修改仍保留', await temp.inputValue() === '0.72' && await serverTemp() === 0.61);
    await page.unroute('**/api/presets/save');
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('dialog', { name: '改动已经生效' }).waitFor();
    check('离开未保存预设会确认', true);
    await page.getByRole('dialog', { name: '改动已经生效' }).getByRole('button', { name: '关闭' }).click();
    // A failed save counts as unknown: saving under the same name again waits until that save has been checked.
    check('保存失败后同名保存先要查验', await saveButton.isDisabled() && (await page.locator('.tl-preset-savebar').innerText()).includes('还不知道存没存上'));
    // Checking only reads the server; saving under the same name again means accepting that the old request may land.
    await page.getByRole('button', { name: '检查这次保存', exact: true }).click();
    await page.getByRole('button', { name: '继续存这个名字有什么风险', exact: true }).click();
    await page.getByRole('dialog', { name: '继续存这个名字的风险' }).getByRole('button', { name: /^知道了，继续存这个名字/ }).click();
    await page.waitForFunction(() => { const b = [...document.querySelectorAll('.tl-preset-savebar button')].find(x => x.textContent === '保存到此预设'); return b && !b.disabled; }, null, { timeout: 30000 });
    await saveButton.click();
    await page.waitForFunction(() => document.querySelector('.tl-preset-savebar')?.textContent.includes('都已存进预设'), null, { timeout: 30000 }).catch(() => {});
    check('再次手动保存成功', await serverTemp() === 0.72);
    // Local prompt application also must not close over and discard text typed while it waits in the bridge queue.
    const localGate = gate(); let localEntered = false;
    await page.route('**/api/presets/save', async r => { localEntered = true; await localGate.promise; await r.continue(); });
    await native(w => { w.__hold = w.TavernLiteBridge.savePreset(); return null; });
    while (!localEntered) await page.waitForTimeout(30);
    await page.locator('.tl-preset-open').filter({ hasText: '测试条目0' }).first().click();
    await page.locator('#tl-prompt-text').fill('应用时的文字');
    await page.getByRole('button', { name: '应用', exact: true }).click();
    await page.locator('#tl-prompt-text').fill('应用期间继续写的文字');
    localGate.release(); await native(w => w.__hold); await page.unroute('**/api/presets/save');
    await page.getByRole('button', { name: '应用', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.tl-preset-editor-actions button')?.textContent === '应用');
    check('局部应用期间的新文字仍留在编辑器', await page.locator('#tl-prompt-text').inputValue() === '应用期间继续写的文字');
    check('当前配置只应用捕获的文字', await native(w => w.TavernLiteBridge.presetPrompt('reliability-0').content) === '应用时的文字');
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('dialog', { name: '还有没应用的文字' }).getByRole('button', { name: '放弃没应用的文字，返回' }).click();
    await page.getByRole('button', { name: /^在原版界面里打开/ }).click();
    await page.getByRole('dialog', { name: '改动已经生效' }).getByRole('button', { name: '继续返回', exact: true }).click();
    await page.locator('iframe.engine.visible').waitFor();
    await native(async (w, name) => {
        const el = w.document.getElementById('settings_preset_openai');
        el.value = [...el.options].find(o => o.textContent.trim() === name).value;
        el.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 500));
    }, initialPreset);
    await page.getByRole('button', { name: '返回轻酒馆', exact: true }).click();
    check('原版切换预设后保存栏同步更新', (await page.locator('.tl-preset-savebar').innerText()).includes(initialPreset === 'Default' ? '默认' : initialPreset)
        && !(await page.locator('.tl-preset-savebar').innerText()).includes(preset));
    check('没有浏览器运行错误', errors.length === 0);
} catch (e) {
    console.error(e); await page.screenshot({ path: out + '/failure.png' }).catch(() => {}); process.exitCode = 1;
} finally {
    // Back to the preset the account had (Default when that one is gone), saved for sure before the test preset is
    // deleted: the app saves settings with a delay, and an account left on a deleted preset breaks later suites.
    if (initialPreset) await native(async (w, name) => {
        const el = w.document.getElementById('settings_preset_openai');
        const option = [...el.options].find(o => o.textContent.trim() === name) ?? [...el.options].find(o => o.textContent.trim() === 'Default');
        if (!option) return;
        el.value = option.value; el.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 1500));
        w.SillyTavern.getContext().saveSettingsDebounced();
    }, initialPreset).catch(() => {});
    for (let i = 0; i < 40; i++) {
        const saved = await post('/api/settings/get', {}).then(r => r.json()).then(s => JSON.parse(s.settings).oai_settings?.preset_settings_openai).catch(() => null);
        if (saved && saved !== preset) break;
        await new Promise(r => setTimeout(r, 500));
    }
    await post('/api/presets/delete', { apiId: 'openai', name: preset });
    await page.close().catch(() => {});
    for (const chatfile of [file, file + '-renamed']) await post('/api/chats/delete', { avatar_url: avatar, chatfile }).catch(() => {});
    await writeFile(out + '/results.json', JSON.stringify({ results, errors, passed: !process.exitCode }, null, 2));
    await browser.close();
}
