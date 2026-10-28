// Real Preact editor and adapter, synthetic persisted native runtime. No ST or model requests.
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
import { createServer } from 'vite'; import preact from '@preact/preset-vite';
import fs from 'node:fs/promises'; import path from 'node:path'; import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const repo = fileURLToPath(new URL('..', import.meta.url)), output = path.resolve(process.env.TEST_OUTPUT || path.join(repo, '..', 'preset-editor-ui-evidence'));
await fs.mkdir(output, { recursive: true }); const checks = [], errors = [], external = [];
const check = (name, condition, detail) => { checks.push({ name, pass: !!condition, detail }); console.log(condition ? 'PASS' : 'FAIL', name); assert.ok(condition, name); };
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import {h,render} from 'preact'; import {PresetPage} from '/preset-editor.jsx'; import {goBack} from '/ui.jsx'; import '/styles.css';
import {createPresetFixture,memoryStorage} from '/@fs/REPO/tests/preset-editor-fixture.js';
import {createPresetEditorJournal} from '/@fs/REPO/bridge-preset-editor.js';
const blockedStorage=new URLSearchParams(location.search).get('blockedStorage');
window.fixture=createPresetFixture({storage:blockedStorage?memoryStorage():localStorage,persist:!blockedStorage,journal:blockedStorage?createPresetEditorJournal():undefined});
window.basicChatProbe=()=> 'available';
window.__presetBackCount=0;
render(h('div',{class:'tl-app'},h(PresetPage,{eng:{state:'idle'},bridge:fixture.bridge,onBack:()=>{window.__presetBackCount++;if(new URLSearchParams(location.search).has('realBack'))goBack({name:'me'});},onOpenPanel:()=>{}})),document.getElementById('root'));
</script></body></html>`.replaceAll('REPO', repo.replaceAll('\\', '/').replace(/\/$/, ''));
const server = await createServer({ configFile: false, root: path.join(repo, 'src'), cacheDir: path.join(repo, '.vite-preset-editor-ui'),
    define: { __APP_VERSION__: JSON.stringify('preset-next-fixture') }, logLevel: 'error', server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } },
    plugins: [preact(), { name: 'preset-editor-fixture', configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/__preset-editor') return next(); res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__preset-editor', html));
    }); } }],
});
let browser, page, fatal;
try {
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`; let executablePath = process.env.CHROME_PATH;
    if (!executablePath && process.platform === 'win32') for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']) {
        if (await fs.access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
    }
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
    await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin !== origin) { external.push(url.origin + url.pathname); return route.abort(); }
        if (url.pathname.startsWith('/api/')) { external.push(url.pathname); return route.abort(); } return route.continue(); });
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { const vv = new EventTarget(); Object.assign(vv, { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 }); Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
        const blocked = new URLSearchParams(location.search).get('blockedStorage');
        if (blocked === 'getter') Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Blocked storage getter', 'SecurityError'); } });
        if (blocked === 'methods') { localStorage.setItem('tavern-lite:preset-operation:storage-probe', '{}'); for (const key of ['getItem', 'setItem', 'removeItem']) Storage.prototype[key] = () => { throw new DOMException('Blocked storage method', 'SecurityError'); }; }
    });
    await page.goto(origin + '/__preset-editor');
    const search = () => page.getByRole('searchbox', { name: '搜索当前预设' }), text = () => page.locator('#tl-prompt-text');
    const openMain = async () => { await search().fill(''); await page.locator('.tl-preset-open').filter({ hasText: '主提示词' }).click(); await text().waitFor(); };
    const back = async preserve => { await page.getByRole('button', { name: '返回', exact: true }).click(); if (preserve) await page.getByRole('button', { name: '保留草稿并返回', exact: true }).click(); await search().waitFor(); };
    await search().waitFor(); check('小预设也始终显示当前预设搜索', await search().isVisible());
    check('来源包含当前子线和人设及其他引用未知', (await page.locator('.tl-preset-scope').innerText()).includes('番外 · Synthetic child') && (await page.locator('.tl-preset-scope').innerText()).includes('我的身份') && (await page.locator('.tl-preset-scope').innerText()).includes('别的故事也会用到'));
    check('常用也列出关着的条目，能直接打开', await page.locator('.tl-preset-open').filter({ hasText: 'Advanced' }).count() === 1);
    await search().fill('ADVANCED_NEEDLE'); await page.locator('.tl-preset-hit').waitFor();
    check('正文搜索临时显示高级匹配并保留常用偏好', (await page.locator('.tl-preset-hit').innerText()).includes('正文') && await page.getByRole('button', { name: '常用', exact: true }).getAttribute('aria-pressed') === 'true');
    await page.locator('.tl-preset-open').click(); check('已有正文打开不自动抢焦点', await text().evaluate(el => document.activeElement !== el)); await back(false);
    check('编辑器返回保留搜索及过滤', await search().inputValue() === 'ADVANCED_NEEDLE'); await search().fill('');
    await openMain(); await text().fill('Submitted main text'); await page.evaluate(() => fixture.hold('apply'));
    await page.getByRole('button', { name: '应用', exact: true }).click(); await page.getByRole('button', { name: '正在应用…', exact: true }).waitFor();
    await text().fill('Later text after submitted snapshot'); await page.getByRole('button', { name: '返回', exact: true }).click();
    check('应用中仍能输入且返回保持编辑页', await text().inputValue() === 'Later text after submitted snapshot');
    await page.evaluate(() => fixture.release('apply')); await page.getByRole('status').filter({ hasText: '之后写的' }).waitFor();
    check('确认只应用捕获正文，后续输入仍为草稿', await page.evaluate(() => fixture.current().prompts[0].content === 'Submitted main text') && await text().inputValue() === 'Later text after submitted snapshot');
    await page.reload(); await openMain();
    check('刷新后恢复后续输入且不重复应用', await text().inputValue() === 'Later text after submitted snapshot' && await page.evaluate(() => fixture.counters().applies === 0 && fixture.current().prompts[0].content === 'Submitted main text'));
    await page.getByRole('button', { name: '恢复成打开时', exact: true }).click();
    check('单字段恢复只改本地文字，原生当前配置不变', await text().inputValue() === 'Original main body' && await page.evaluate(() => fixture.current().prompts[0].content === 'Submitted main text'));
    await text().fill('Draft retained across switch'); await page.evaluate(() => fixture.switchPreset('Other'));
    await page.getByRole('status').filter({ hasText: '预设或账号已切换' }).waitFor();
    check('外部切预设时编辑器保持原草稿且禁止错目标应用', await text().inputValue() === 'Draft retained across switch' && await page.getByRole('button', { name: '应用', exact: true }).isDisabled());
    await page.reload(); await search().waitFor(); await page.evaluate(() => fixture.switchPreset('Original'));
    await page.locator('.tl-preset-savebar strong').filter({ hasText: 'Original' }).waitFor(); await openMain();
    check('刷新并切回原预设跨epoch仍恢复原草稿', await text().inputValue() === 'Draft retained across switch');
    const beforeIme = await page.evaluate(() => fixture.counters().applies); await text().dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, keyCode: 229, bubbles: true });
    await page.waitForTimeout(100); check('组合态CtrlEnter不会应用提示词', await page.evaluate(() => fixture.counters().applies) === beforeIme);
    await page.evaluate(() => fixture.externalPrompt('Native same-field revision')); await page.getByRole('status').filter({ hasText: '原版也改了这里' }).waitFor();
    await page.getByRole('button', { name: '应用', exact: true }).click(); await page.getByRole('region', { name: '字段冲突' }).waitFor();
    check('同字段冲突不覆盖远端且本地保留', await page.evaluate(() => fixture.current().prompts[0].content === 'Native same-field revision') && await text().inputValue() === 'Draft retained across switch');
    await page.getByRole('button', { name: '使用我的修改', exact: true }).click(); await page.getByRole('status').filter({ hasText: /已用上|已应用/ }).waitFor();
    check('显式选择后仅应用对应提示词', await page.evaluate(() => fixture.current().prompts[0].content === 'Draft retained across switch' && fixture.current().prompts[2].content === 'Secondary body'));
    await back(false); await page.getByRole('button', { name: '查看这 1 处改动', exact: true }).waitFor();
    check('实际字段差异计数不随多次输入膨胀', await page.getByRole('button', { name: '查看这 1 处改动', exact: true }).isVisible());
    await page.getByRole('button', { name: '查看这 1 处改动', exact: true }).click(); await page.locator('.tl-preset-change-list button').click();
    check('修改摘要可定位到该字段', await text().isVisible()); await text().fill('Unapplied original-only draft'); await back(true);
    const originalBefore = await page.evaluate(() => JSON.stringify(fixture.files.get('Original')));
    await page.getByRole('button', { name: '另存并使用', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '另存并使用', exact: true });
    await dialog.getByRole('textbox').fill('Saved copy'); const writesBeforeIme = await page.evaluate(() => fixture.counters().writes);
    await dialog.getByRole('textbox').dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, keyCode: 229, bubbles: true }); await page.waitForTimeout(100);
    check('副本命名组合态快捷键不提交', await page.evaluate(() => fixture.counters().writes) === writesBeforeIme);
    await page.evaluate(() => fixture.hold('use')); await dialog.getByRole('button', { name: '保存副本并切换使用', exact: true }).click();
    await page.waitForFunction(() => fixture.counters().uses === 1);
    check('副本状态等待真实应用Promise，未提前显示新活动项', await dialog.isVisible() && await page.evaluate(() => fixture.current().name === 'Original'));
    await page.evaluate(() => fixture.release('use')); await page.getByRole('status').filter({ hasText: '副本已保存并用上' }).waitFor();
    check('另存使用核验实际活动项和原件不变，排除未应用草稿', await page.evaluate(before => fixture.current().name === 'Saved copy' && JSON.stringify(fixture.files.get('Original')) === before && fixture.files.get('Saved copy').prompts[0].content === 'Draft retained across switch', originalBefore));
    check('另存保留未知顶层与提示词字段', await page.evaluate(() => fixture.files.get('Saved copy').importedUnknown.preserve === 'synthetic value' && fixture.files.get('Saved copy').prompts[0].extensionUnknown.keep === 17));
    await page.reload(); await search().waitFor(); await page.evaluate(() => fixture.switchPreset('Original')); await page.locator('.tl-preset-savebar strong').filter({ hasText: 'Original' }).waitFor(); await openMain();
    check('另存切换并刷新后原预设未应用草稿仍在', await text().inputValue() === 'Unapplied original-only draft');
    const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} current caret text`).join('\n'); await text().fill(lines);
    await page.evaluate(() => { visualViewport.height = 240; visualViewport.dispatchEvent(new Event('resize')); });
    await text().focus(); await text().press('End'); await page.waitForTimeout(100);
    const geometry = await text().evaluate(el => { const rect = el.getBoundingClientRect(), button = document.querySelector('.tl-preset-editor-actions button').getBoundingClientRect(); const line = parseFloat(getComputedStyle(el).lineHeight); const viewport = visualViewport.height;
        let top = Math.max(rect.top, 0), bottom = Math.min(rect.bottom, button.top, viewport);
        for (let parent = el.parentElement; parent; parent = parent.parentElement) { if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) { const box = parent.getBoundingClientRect(); top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); } }
        return { top: rect.top, bottom: rect.bottom, visible: bottom - top, line, buttonTop: button.top, buttonBottom: button.bottom, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }; });
    check('240px模拟键盘可视区实际露出至少三行并可达应用按钮', geometry.visible >= geometry.line * 3 && geometry.buttonBottom <= 241 && geometry.buttonTop >= 0, geometry);
    check('模拟键盘焦点后末尾光标所在内容可见', geometry.scrollTop + geometry.clientHeight >= geometry.scrollHeight - 35, geometry);
    await page.screenshot({ path: path.join(output, 'preset-visualviewport-240-simulated.png'), fullPage: true });
    await text().fill('手机窄屏长段落需要保留光标当前内容。'.repeat(100)); await text().press('Control+End'); await text().click({ position: { x: 30, y: 90 } }); await text().press('Control+End');
    await page.evaluate(() => visualViewport.dispatchEvent(new Event('resize'))); await page.waitForTimeout(100);
    const wrapped = await text().evaluate(el => ({ scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }));
    check('无换行长段落按实际折行保持末尾光标可见', wrapped.scrollTop + wrapped.clientHeight >= wrapped.scrollHeight - 35, wrapped);
    await text().fill(lines);
    await page.reload(); await openMain(); check('长文本刷新后仍完整持久保存', await text().inputValue() === lines);
    await page.screenshot({ path: path.join(output, 'preset-restored-draft-mobile-simulated.png'), fullPage: true });
    await page.evaluate(() => localStorage.clear()); await page.reload(); await search().waitFor();
    const temperature = page.locator('#tl-preset-temperature'); await temperature.fill('1.2');
    await temperature.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true }); await page.waitForTimeout(80);
    check('数字字段组合态Enter不提交', await page.evaluate(() => fixture.current().full.temperature === .7));
    await page.evaluate(() => fixture.externalRuntime({ temperature: 1.4 })); await page.waitForTimeout(100); await search().click();
    await page.getByRole('alert').filter({ hasText: '这一项原版改过了' }).waitFor();
    check('焦点中数值外部变更不会被失焦静默覆盖且错误持续可见', await page.evaluate(() => fixture.current().full.temperature === 1.4));
    await page.evaluate(() => localStorage.clear()); await page.reload(); await search().waitFor();
    await page.getByRole('button', { name: '关闭的', exact: true }).click(); await search().fill('ADVANCED_NEEDLE'); await page.locator('.tl-preset-open').click(); await back(false);
    check('条目返回恢复开关筛选和搜索', await search().inputValue() === 'ADVANCED_NEEDLE' && await page.getByRole('button', { name: '关闭的', exact: true }).getAttribute('aria-pressed') === 'true');
    await page.getByRole('button', { name: '全部', exact: true }).click(); await search().fill('');
    await page.evaluate(() => { fixture.externalRuntime({ temperature: .9 }); fixture.externalFile({ temperature: 1.3, remoteUnknown: { keep: 31 } }); }); await page.waitForTimeout(100);
    await page.getByRole('button', { name: '另存并使用', exact: true }).click(); await page.getByRole('dialog', { name: '另存并使用', exact: true }).getByRole('textbox').fill('Conflict copy');
    await page.getByRole('button', { name: '保存副本并切换使用', exact: true }).click(); await page.getByRole('status').filter({ hasText: '副本已保存并用上' }).waitFor();
    check('新名副本不被源文件同字段变化阻断', await page.getByRole('dialog').count() === 0 && await page.evaluate(() => fixture.counters().writes === 1));
    check('新名副本保留捕获运行配置与已知未知字段，源文件不变', await page.evaluate(() => fixture.files.get('Conflict copy').temperature === .9 && fixture.files.get('Conflict copy').importedUnknown.preserve === 'synthetic value' && fixture.files.get('Original').remoteUnknown.keep === 31 && fixture.files.get('Original').temperature === 1.3));
    // F1/F2: actual component state, explicit controls and persisted draft/receipt reload.
    await page.evaluate(() => localStorage.clear()); await page.reload(); await search().waitFor();
    await openMain(); await text().fill('F1_F2_UNAPPLIED_DRAFT'); await back(true);
    await page.evaluate(() => { fixture.externalRuntime({ temperature: 1.1 }); const target = fixture.counters().reads + 2; fixture.onRead(n => { if (n === target) throw new Error('Injected preflight503'); }); });
    await page.getByRole('button', { name: '保存到此预设', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '这次没存' }).waitFor();
    check('armed后预检失败界面明确未提交且零写入可重试', await page.getByRole('button', { name: '保存到此预设', exact: true }).isEnabled() && await page.evaluate(() => fixture.counters().writes === 0));
    await page.reload(); await search().waitFor();
    check('预检失败刷新没有假未决且当前运行配置保留', await page.locator('[data-preset-operation]').count() === 0 && await page.getByRole('button', { name: '保存到此预设', exact: true }).isEnabled() && await page.evaluate(() => fixture.current().full.temperature === 1.1));
    await openMain(); check('未提交后刷新保留逐字未应用草稿', await text().inputValue() === 'F1_F2_UNAPPLIED_DRAFT'); await back(true);
    await page.evaluate(() => fixture.fault('abort')); await page.getByRole('button', { name: '保存到此预设', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '还不知道存没存上' }).waitFor();
    check('派发abort加OLD界面未知只锁同名，另存及聊天仍可用', await page.getByRole('button', { name: '保存到此预设', exact: true }).isDisabled() && await page.getByRole('button', { name: '另存并使用', exact: true }).isEnabled() && await page.evaluate(() => basicChatProbe() === 'available' && fixture.counters().writes === 1));
    await page.screenshot({ path: path.join(output, 'preset-unknown-copy-exit.png'), fullPage: true });
    await page.evaluate(() => fixture.fault('')); await page.getByLabel('切换使用的预设').selectOption('Other');
    await page.getByRole('dialog', { name: '确认切换预设' }).getByRole('button', { name: '确认切换', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '现在用的是「Other」' }).waitFor();
    check('切A到B不会把组件pending带成B的保存锁', await page.getByRole('button', { name: '保存到此预设', exact: true }).isEnabled());
    await page.evaluate(() => fixture.externalRuntime({ temperature: .5 })); await page.getByRole('button', { name: '保存到此预设', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已存进预设；之后' }).waitFor();
    check('A未知时B真正保存成功', await page.evaluate(() => fixture.files.get('Other').temperature === .5 && fixture.counters().writes === 2));
    await page.getByLabel('切换使用的预设').selectOption('Original'); await page.getByRole('status').filter({ hasText: '现在用的是「Original」' }).waitFor();
    await page.evaluate(() => { fixture.externalRuntime({ temperature: 1.3 }); fixture.externalFile({ temperature: 1.8 }); });
    await page.getByRole('button', { name: '另存并使用', exact: true }).click(); const independent = page.getByRole('dialog', { name: '另存并使用', exact: true });
    await independent.getByRole('textbox').fill('original'); await independent.getByRole('button', { name: '保存副本并切换使用', exact: true }).click();
    await independent.getByRole('alert').waitFor(); check('仅改大小写无法绕同目标锁且POST不增加', await page.evaluate(() => fixture.counters().writes === 2));
    await independent.getByRole('textbox').fill('F1 Independent copy'); await independent.getByRole('button', { name: '保存副本并切换使用', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '副本已保存并用上' }).waitFor();
    check('A未知仍可另存真正新名称并保留运行mine及原文件', await page.evaluate(() => fixture.files.get('F1 Independent copy').temperature === 1.3 && fixture.files.get('Original').temperature === 1.8 && fixture.current().name === 'F1 Independent copy'));
    await page.evaluate(() => localStorage.clear()); await page.reload(); await search().waitFor();
    await page.evaluate(() => { const before = structuredClone(fixture.files.get('Original')); fixture.journal.put({ id: 'legacy-armed', account: 'preset-test', name: 'Original.', stage: 'armed', mode: 'save', before, expected: { ...before, temperature: 1.1 } }); fixture.notify(); });
    await page.getByRole('button', { name: '继续存这个名字有什么风险' }).waitFor(); await page.reload(); await search().waitFor();
    check('老armed刷新仍明确未知且保留查验及新名出口', await page.locator('[data-preset-operation="legacy-armed"]').innerText().then(value => value.includes('还不知道存没存上')) && await page.getByRole('button', { name: '另存并使用', exact: true }).isEnabled());
    await page.getByRole('button', { name: '继续存这个名字有什么风险' }).click(); const risk = page.getByRole('dialog', { name: '继续存这个名字的风险' });
    check('风险确认先读真实基线并说明迟到覆盖与不自动保存', (await risk.innerText()).includes('已读到酒馆里的完整内容') && (await risk.innerText()).includes('不代表上次存上了'));
    await page.screenshot({ path: path.join(output, 'preset-same-target-risk-review.png') });
    await page.evaluate(() => { window.__presetOriginalSet = Storage.prototype.setItem; Storage.prototype.setItem = function(k, v) { if (k.startsWith('tavern-lite:preset-operation:')) throw new Error('Decision quota'); return window.__presetOriginalSet.call(this, k, v); }; });
    await risk.getByRole('button', { name: '知道了，继续存这个名字' }).click(); await risk.getByRole('alert').filter({ hasText: '没记下这次保存' }).waitFor();
    check('决定持久失败不会解锁同名或自动写入', await page.getByRole('button', { name: '保存到此预设', exact: true }).isDisabled() && await page.evaluate(() => fixture.counters().writes === 0 && !fixture.journal.get('preset-test', 'legacy-armed').userDecision));
    await page.evaluate(() => { Storage.prototype.setItem = window.__presetOriginalSet; });
    await risk.getByRole('button', { name: '知道了，继续存这个名字' }).click(); await page.getByRole('status').filter({ hasText: '已记下，可以接着改' }).waitFor();
    check('明确决定解锁但保存事实仍未知且不改配置', await page.getByRole('button', { name: '保存到此预设', exact: true }).isEnabled() && await page.evaluate(() => fixture.counters().writes === 0 && fixture.current().full.temperature === .7 && fixture.journal.get('preset-test', 'legacy-armed').writeOutcome === 'unknown'));
    await page.reload(); await search().waitFor(); check('决定刷新仍有效且历史记录未删除', await page.getByRole('button', { name: '保存到此预设', exact: true }).isEnabled() && await page.locator('[data-preset-operation="legacy-armed"]').count() === 1);
    await page.screenshot({ path: path.join(output, 'preset-decided-history-retained.png'), fullPage: true });
    await page.evaluate(() => localStorage.clear()); await page.reload(); await search().waitFor();
    await page.evaluate(() => fixture.externalRuntime({ temperature: 1.2 }));
    await page.getByRole('button', { name: '查看这 1 处改动', exact: true }).waitFor();
    await page.evaluate(() => {
        const read = fixture.bridge.presetEditorState, save = fixture.bridge.presetEditorSave;
        let holdRead = false;
        const gate = new Promise(resolve => { window.__releaseReturnRead = resolve; });
        window.__heldReads = 0;
        fixture.bridge.presetEditorState = async () => { if (holdRead) { window.__heldReads++; await gate; } return read(); };
        fixture.bridge.presetEditorSave = async input => { const result = await save(input); if (result.kind === 'confirmed') holdRead = true; return result; };
    });
    await page.getByRole('button', { name: '保存到此预设', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已存进预设，正在检查' }).waitFor();
    check('文件已确认而当前差异读取未完成时保持操作中', await page.getByRole('button', { name: '正在保存…', exact: true }).isDisabled()
        && await page.getByRole('status').filter({ hasText: '已存进预设；之后' }).count() === 0 && await page.evaluate(() => fixture.counters().writes === 1));
    await page.locator('main:visible .tl-page-header').getByRole('button', { name: '返回', exact: true }).click();
    check('核对期间返回不弹假未保存Sheet也不提前导航', await page.getByRole('dialog').count() === 0 && await page.evaluate(() => window.__presetBackCount === 0));
    await page.evaluate(() => fixture.notify()); await page.waitForFunction(() => window.__heldReads >= 2);
    await page.evaluate(() => window.__releaseReturnRead());
    await page.getByRole('status').filter({ hasText: '已存进预设；之后' }).waitFor();
    // Do not wait for metadata reload, hide an overlay, or use a delayed second click:
    // a person can press Return as soon as the successful-save feedback appears.
    await page.locator('main:visible .tl-page-header').getByRole('button', { name: '返回', exact: true }).click();
    const returnWindow = await page.evaluate(() => ({ backCount: window.__presetBackCount, hash: location.hash, history: history.state,
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map(el => ({ name: el.getAttribute('aria-label'), text: el.innerText })),
        status: document.querySelector('.tl-preset-savebar [role="status"]')?.textContent,
        fileTemperature: fixture.files.get('Original').temperature, runtimeTemperature: fixture.current().full.temperature, writes: fixture.counters().writes }));
    await fs.writeFile(path.join(output, 'preset-return-window.json'), JSON.stringify(returnWindow, null, 2));
    await page.screenshot({ path: path.join(output, 'preset-return-window.png') });
    check('保存成功已可见时立即返回不弹假未保存确认', returnWindow.backCount === 1 && returnWindow.dialogs.length === 0 && returnWindow.writes === 1 && returnWindow.fileTemperature === returnWindow.runtimeTemperature, returnWindow);
    check('保存跟随较新事件读取后才公布成功与清除旧差异', await page.getByRole('button', { name: /查看这 .* 处改动/ }).count() === 0 && await page.evaluate(() => window.__heldReads >= 2));

    // Runtime changes after the captured write must survive the refreshed state and still guard leaving.
    await page.evaluate(() => localStorage.clear()); await page.reload(); await search().waitFor();
    await page.evaluate(() => { fixture.externalRuntime({ temperature: 1.1 }); fixture.hold('write'); });
    await page.getByRole('button', { name: '查看这 1 处改动', exact: true }).waitFor();
    await page.getByRole('button', { name: '保存到此预设', exact: true }).click(); await page.waitForFunction(() => fixture.counters().writes === 1);
    await page.evaluate(() => { fixture.externalRuntime({ temperature: 1.6 }); fixture.release('write'); });
    await page.getByRole('status').filter({ hasText: '已存进预设；之后' }).waitFor();
    await page.locator('main:visible .tl-page-header').getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('dialog', { name: '改动已经生效', exact: true }).waitFor();
    check('保存期间后续真实修改保留差异与离开确认', await page.getByRole('button', { name: '查看这 1 处改动', exact: true }).count() === 1
        && await page.evaluate(() => fixture.files.get('Original').temperature === 1.1 && fixture.current().full.temperature === 1.6 && fixture.counters().writes === 1 && window.__presetBackCount === 0));
    await page.screenshot({ path: path.join(output, 'preset-return-later-changes.png') });
    await page.getByRole('button', { name: '关闭', exact: true }).click();

    // A confirmed file plus failed/invalidated UI reads is not a failed save, and must have a read-only exit.
    for (const failure of ['read', 'account']) {
        await page.evaluate(() => localStorage.clear()); await page.reload(); await search().waitFor();
        await page.evaluate(failure => {
            const read = fixture.bridge.presetEditorState, save = fixture.bridge.presetEditorSave;
            window.__failReturnRead = false;
            window.__restoreReturnRead = () => { window.__failReturnRead = false; };
            fixture.bridge.presetEditorState = async () => { if (window.__failReturnRead) throw new Error('Injected current-state unavailable'); return read(); };
            fixture.bridge.presetEditorSave = async input => { const result = await save(input); if (result.kind === 'confirmed') {
                if (failure === 'account') fixture.changeAccount(); else window.__failReturnRead = true;
            } return result; };
            fixture.externalRuntime({ temperature: 1.3 });
        }, failure);
        await page.getByRole('button', { name: '查看这 1 处改动', exact: true }).waitFor();
        await page.getByRole('button', { name: '保存到此预设', exact: true }).click();
        await page.getByRole('status').filter({ hasText: '已存进预设，但还没检查完' }).waitFor();
        check(`${failure}没加载出来保留已保存事实但不假装差异已清或自动再写`, await page.getByRole('button', { name: '保存到此预设', exact: true }).isDisabled()
            && await page.getByRole('button', { name: '重新加载', exact: true }).isEnabled() && await page.evaluate(() => fixture.counters().writes === 1 && fixture.files.get('Original').temperature === 1.3));
        await page.locator('main:visible .tl-page-header').getByRole('button', { name: '返回', exact: true }).click();
        await page.getByRole('dialog', { name: '改动还没检查完', exact: true }).waitFor();
        await page.getByRole('button', { name: '继续返回', exact: true }).click();
        check(`${failure}没加载出来提供明确返回出口且不锁死页面`, await page.evaluate(() => window.__presetBackCount === 1 && fixture.counters().writes === 1));
        if (failure === 'read') {
            const retryRead = page.getByRole('button', { name: '重新加载', exact: true });
            // Release the fault at the real retry click, so a queued focus refresh cannot remove the button first.
            await retryRead.evaluate(el => el.addEventListener('click', () => window.__restoreReturnRead(), { once: true, capture: true })); await retryRead.click();
            await page.getByRole('status').filter({ hasText: '已重新加载' }).waitFor();
            check('读取恢复只更新当前差异并解锁，无第二次写入', await page.getByRole('button', { name: '保存到此预设', exact: true }).isEnabled()
                && await page.getByRole('button', { name: /查看这 .* 处改动/ }).count() === 0 && await page.evaluate(() => fixture.counters().writes === 1));
        }
    }

    // An older fulfilled read may arrive after a newer target or a newer failure.
    for (const latest of ['target', 'failure']) {
        await page.evaluate(() => localStorage.clear()); await page.reload(); await search().waitFor();
        await page.evaluate(() => {
            const read = fixture.bridge.presetEditorState, save = fixture.bridge.presetEditorSave;
            let afterSave = false; window.__returnReads = 0;
            const gate = new Promise(resolve => { window.__releaseOldReturnRead = resolve; });
            fixture.bridge.presetEditorState = async () => {
                if (!afterSave) return read();
                const index = ++window.__returnReads;
                if (window.__rejectNewReturnRead) throw new Error('Injected newer read failed');
                const snapshot = await read();
                if (index === 1) { window.__oldReturnReadCaptured = true; await gate; }
                return snapshot;
            };
            fixture.bridge.presetEditorSave = async input => { const result = await save(input); afterSave = true; return result; };
            fixture.externalRuntime({ temperature: 1.5 });
        });
        await page.getByRole('button', { name: '查看这 1 处改动', exact: true }).waitFor();
        await page.getByRole('button', { name: '保存到此预设', exact: true }).click(); await page.waitForFunction(() => window.__oldReturnReadCaptured);
        if (latest === 'target') {
            await page.evaluate(() => fixture.switchPreset('Other'));
            await page.locator('.tl-preset-savebar strong').filter({ hasText: 'Other' }).waitFor();
            await page.evaluate(() => window.__releaseOldReturnRead());
            await page.getByRole('status').filter({ hasText: '已存进预设；之后' }).waitFor();
            check('旧读取晚到不会把已切换目标覆回原预设', (await page.locator('.tl-preset-savebar strong').innerText()).includes('Other')
                && await page.locator('#tl-preset-temperature').inputValue() === '0.2'
                && await page.evaluate(() => fixture.current().name === 'Other' && fixture.files.get('Original').temperature === 1.5 && fixture.counters().writes === 1));
            await page.locator('main:visible .tl-page-header').getByRole('button', { name: '返回', exact: true }).click();
            check('旧目标完成不复活旧差异或产生额外导航', await page.getByRole('dialog').count() === 0 && await page.evaluate(() => window.__presetBackCount === 1));
        } else {
            await page.evaluate(() => fixture.notify()); await page.waitForFunction(() => window.__returnReads >= 2);
            await page.getByRole('status').filter({ hasText: '已重新加载' }).waitFor();
            await page.evaluate(() => { window.__rejectNewReturnRead = true; fixture.notify(); });
            await page.getByRole('alert').filter({ hasText: 'Injected newer read failed' }).waitFor();
            await page.evaluate(() => window.__releaseOldReturnRead());
            await page.getByRole('status').filter({ hasText: '已存进预设，但还没检查完' }).waitFor();
            check('较新没加载出来时旧成功不能解除未核对限制', await page.getByRole('button', { name: '保存到此预设', exact: true }).isDisabled()
                && await page.getByRole('button', { name: '重新加载', exact: true }).isEnabled() && await page.evaluate(() => fixture.counters().writes === 1));
        }
    }

    // Read-only recovery can newly confirm an old unknown write; it shares the same UI commit boundary.
    await page.evaluate(() => localStorage.clear()); await page.reload(); await search().waitFor();
    await page.evaluate(() => { fixture.externalRuntime({ temperature: 1.1 }); fixture.fault('abort'); });
    await page.getByRole('button', { name: '查看这 1 处改动', exact: true }).waitFor();
    await page.getByRole('button', { name: '保存到此预设', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '还不知道存没存上' }).waitFor();
    await page.evaluate(() => {
        const operation = fixture.journal.list('preset-test')[0]; fixture.files.set(operation.name, structuredClone(operation.expected)); fixture.fault('');
        const read = fixture.bridge.presetEditorState, recover = fixture.bridge.presetEditorRecover;
        let hold = false; const gate = new Promise(resolve => { window.__releaseRecoveryRead = resolve; });
        fixture.bridge.presetEditorState = async () => { if (hold) await gate; return read(); };
        fixture.bridge.presetEditorRecover = async input => { const result = await recover(input); hold = true; return result; };
    });
    await page.getByRole('button', { name: '检查这次保存', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已存进预设，正在检查' }).waitFor();
    check('只读恢复确认也等待当前差异，且不发第二次写入', await page.getByRole('button', { name: '正在保存…', exact: true }).isDisabled() && await page.evaluate(() => fixture.counters().writes === 1));
    await page.evaluate(() => window.__releaseRecoveryRead()); await page.getByRole('status').filter({ hasText: '已存进预设；之后' }).waitFor();
    await page.locator('main:visible .tl-page-header').getByRole('button', { name: '返回', exact: true }).click();
    check('只读恢复成功立即返回不误弹旧差异提醒', await page.getByRole('dialog').count() === 0 && await page.evaluate(() => window.__presetBackCount === 1 && fixture.counters().writes === 1));

    // A save whose answer was lost and that reached the server later is checked by itself on the next visit, read-only.
    await page.evaluate(() => localStorage.clear()); await page.reload(); await search().waitFor();
    await page.evaluate(() => { fixture.externalRuntime({ temperature: 1.15 }); fixture.fault('abort'); });
    await page.getByRole('button', { name: '查看这 1 处改动', exact: true }).waitFor();
    await page.getByRole('button', { name: '保存到此预设', exact: true }).click(); await page.getByRole('status').filter({ hasText: '还不知道存没存上' }).waitFor();
    await page.evaluate(() => {
        const operation = fixture.journal.list('preset-test')[0], stored = JSON.parse(localStorage.getItem('preset-fixture'));
        stored.files = stored.files.map(([name, value]) => [name, name === operation.name ? operation.expected : value]);
        localStorage.setItem('preset-fixture', JSON.stringify(stored));
    });
    await page.reload(); await search().waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-preset-operation]'), null, { timeout: 10000 }).catch(() => {});
    check('下次打开预设页自动核对上次没核对完的保存，对上就不再拦着，也不重写', await page.locator('[data-preset-operation]').count() === 0
        && await page.evaluate(() => fixture.counters().writes === 0 && fixture.journal.list('preset-test').every(op => op.writeOutcome !== 'unknown')));

    // Confirmed recovery must retire the component's old unknown receipt even if the UI read fails.
    await page.evaluate(() => localStorage.clear()); await page.reload(); await search().waitFor();
    await page.evaluate(() => { fixture.externalRuntime({ temperature: 1.2 }); fixture.fault('abort'); });
    await page.getByRole('button', { name: '查看这 1 处改动', exact: true }).waitFor();
    await page.getByRole('button', { name: '保存到此预设', exact: true }).click(); await page.getByRole('status').filter({ hasText: '还不知道存没存上' }).waitFor();
    await page.evaluate(() => {
        const operation = fixture.journal.list('preset-test')[0]; fixture.files.set(operation.name, structuredClone(operation.expected)); fixture.fault('');
        const read = fixture.bridge.presetEditorState, recover = fixture.bridge.presetEditorRecover;
        window.__failConfirmedRecoveryRead = false;
        fixture.bridge.presetEditorState = async () => { if (window.__failConfirmedRecoveryRead) throw new Error('Injected confirmed recovery read failure'); return read(); };
        fixture.bridge.presetEditorRecover = async input => { const result = await recover(input); window.__failConfirmedRecoveryRead = true; return result; };
    });
    await page.getByRole('button', { name: '检查这次保存', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已存进预设，但还没检查完' }).waitFor();
    check('恢复确认但页面没加载出来仍保留文件确认事实且只临时等待核对', await page.getByRole('button', { name: '保存到此预设', exact: true }).isDisabled()
        && await page.evaluate(() => fixture.journal.list('preset-test').length === 0 && fixture.counters().writes === 1 && fixture.files.get('Original').temperature === 1.2));
    const retryRecoveryRead = page.getByRole('button', { name: '重新加载', exact: true });
    await retryRecoveryRead.evaluate(el => el.addEventListener('click', () => { window.__failConfirmedRecoveryRead = false; }, { once: true, capture: true })); await retryRecoveryRead.click();
    await page.getByRole('status').filter({ hasText: '已重新加载' }).waitFor();
    const recoveredPending = await page.evaluate(() => ({ writes: fixture.counters().writes, operations: fixture.journal.list('preset-test'),
        visibleOperations: document.querySelectorAll('[data-preset-operation]').length,
        saveDisabled: [...document.querySelectorAll('button')].find(el => el.textContent === '保存到此预设')?.disabled,
        status: document.querySelector('.tl-preset-savebar [role="status"]')?.textContent }));
    await fs.writeFile(path.join(output, 'preset-recovery-read-retry.json'), JSON.stringify(recoveredPending, null, 2));
    await page.screenshot({ path: path.join(output, 'preset-recovery-read-retry.png') });
    check('确认恢复的页面重读成功后清除旧unknown组件锁且不重复写', !recoveredPending.saveDisabled && recoveredPending.visibleOperations === 0 && recoveredPending.operations.length === 0 && recoveredPending.writes === 1, recoveredPending);

    // Exercise the real goBack/useBackLayer history path, rather than only counting a callback.
    await page.evaluate(() => localStorage.clear()); await page.goto(origin + '/__preset-editor?realBack=1'); await search().waitFor();
    await page.evaluate(() => { history.replaceState({ tavernLite: true }, '', location.pathname + location.search + '#setup');
        history.pushState({ tavernLite: true }, '', '#preset'); fixture.externalRuntime({ temperature: 1.4 }); });
    await page.getByRole('button', { name: '查看这 1 处改动', exact: true }).waitFor();
    await page.getByRole('button', { name: '保存到此预设', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已存进预设；之后' }).waitFor();
    await page.locator('main:visible .tl-page-header').getByRole('button', { name: '返回', exact: true }).click();
    await page.waitForFunction(() => location.hash === '#setup');
    check('保存成功立即真实返回只回到高级设置来源层', await page.getByRole('dialog').count() === 0 && await page.evaluate(() => location.hash === '#setup' && !history.state?.tlLayer && window.__presetBackCount === 1));
    for (const failure of ['getter', 'methods']) {
        await page.goto(origin + '/__preset-editor?blockedStorage=' + failure); await search().waitFor();
        check(`禁存储${failure}仍完成模块与页面安装且显示只读配置`, await page.evaluate(() => basicChatProbe() === 'available') && await page.getByRole('alert').filter({ hasText: '本机存储恢复前存不了预设' }).isVisible());
        check(`禁存储${failure}明确阻止命名写入`, await page.getByRole('button', { name: '保存到此预设', exact: true }).isDisabled() && await page.evaluate(() => fixture.counters().writes === 0));
        await openMain(); await text().fill('Memory draft while storage is blocked');
        check(`禁存储${failure}保留内存输入并明确提示读取故障`, await text().inputValue() === 'Memory draft while storage is blocked' && await page.getByRole('alert').filter({ hasText: '读不到本机的草稿' }).isVisible());
    }
    check('没有访问ST、模型或外部网络', external.length === 0, external); check('页面没有JS异常', errors.length === 0, errors);
} catch (error) { fatal = { message: error.message, stack: error.stack }; console.error(error.stack); await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally { await browser?.close(); await server.close(); await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ pass: !fatal && checks.every(x => x.pass), checks, errors, external, fatal,
    unverified: ['Native SillyTavern integration is separate', 'Composition events and keyboard viewport are simulated, not real IME or phone tests', 'No novice usability study'] }, null, 2));
    console.log(JSON.stringify({ passed: checks.filter(x => x.pass).length, total: checks.length, output })); if (fatal || checks.some(x => !x.pass)) process.exitCode = 1; }
