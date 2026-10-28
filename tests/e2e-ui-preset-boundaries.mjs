// F5/F6: actual Preact + adapter, synthetic fixture only; no ST, model, or external requests.
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
import { createServer } from 'vite'; import preact from '@preact/preset-vite';
import fs from 'node:fs/promises'; import path from 'node:path';
const require = createRequire(import.meta.url), { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const repo = fileURLToPath(new URL('..', import.meta.url)), output = path.resolve(process.env.TEST_OUTPUT || path.join(repo, '..', 'p2-followup', 'preset-boundaries'));
await fs.mkdir(output, { recursive: true }); const checks = [], errors = [], external = [], snapshots = [];
const check = (name, condition, detail) => { checks.push({ name, pass: !!condition, detail }); console.log(condition ? 'PASS' : 'FAIL', name); };
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import {h,render} from 'preact'; import {PresetPage} from '/preset-editor.jsx'; import '/styles.css';
import {createPresetFixture,memoryStorage} from '/@fs/REPO/tests/preset-editor-fixture.js';
window.fixture=createPresetFixture({storage:memoryStorage()}); window.backCount=0;
render(h('div',{class:'tl-app'},h(PresetPage,{eng:{state:'idle'},bridge:fixture.bridge,onBack:()=>{window.backCount++;}})),document.getElementById('root'));
</script></body></html>`.replaceAll('REPO', repo.replaceAll('\\', '/').replace(/\/$/, ''));
const server = await createServer({ configFile: false, root: path.join(repo, 'src'), cacheDir: path.join(repo, '.vite-preset-boundaries'),
    define: { __APP_VERSION__: JSON.stringify('preset-boundaries-synthetic') }, logLevel: 'error', server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } },
    plugins: [preact(), { name: 'preset-boundaries', configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/__preset-boundaries') return next(); res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__preset-boundaries', html));
    }); } }],
});
let browser, page, fatal;
try {
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`; let executablePath = process.env.CHROME_PATH;
    if (!executablePath && process.platform === 'win32') for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']) {
        if (await fs.access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
    }
    browser = await chromium.launch({ executablePath, headless: true }); const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
    await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin !== origin || url.pathname.startsWith('/api/')) { external.push(url.origin + url.pathname); return route.abort(); } return route.continue(); });
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
    const reset = async () => { await page.goto(origin + '/__preset-boundaries'); await page.getByRole('searchbox', { name: '搜索当前预设' }).waitFor(); };
    const snapshot = async label => {
        const state = await page.evaluate(() => ({ name: fixture.current().name, temperature: fixture.current().full.temperature, file: fixture.files.get('Original').temperature,
            numbers: [...document.querySelectorAll('input[type="number"]')].map(el => ({ id: el.id, value: el.value, disabled: el.disabled })),
            switches: [...document.querySelectorAll('[role="switch"]')].map(el => ({ name: el.getAttribute('aria-label'), disabled: el.disabled, checked: el.getAttribute('aria-checked') })),
            counters: fixture.counters(), backCount, dialogs: [...document.querySelectorAll('[role="dialog"]')].map(el => ({ title: el.getAttribute('aria-label'), text: el.innerText })),
            status: document.querySelector('.tl-preset-savebar [role="status"]')?.textContent })); snapshots.push({ label, ...state }); return state;
    };
    for (const phase of ['write-pending', 'confirmed-read-pending']) {
        await reset(); await page.getByRole('button', { name: '全部设置', exact: true }).click();
        await page.evaluate(phase => {
            fixture.externalRuntime({ temperature: 1.1 });
            if (phase === 'write-pending') fixture.hold('write');
            else {
                const read = fixture.bridge.presetEditorState, save = fixture.bridge.presetEditorSave; let holding = false;
                const gate = new Promise(resolve => { window.releaseRead = resolve; });
                fixture.bridge.presetEditorState = async () => { if (holding) await gate; return read(); };
                fixture.bridge.presetEditorSave = async input => { const result = await save(input); holding = result.kind === 'confirmed'; return result; };
            }
        }, phase);
        await page.getByRole('button', { name: '查看这 1 处改动', exact: true }).waitFor();
        await page.getByRole('button', { name: '保存到此预设', exact: true }).click(); await page.waitForFunction(() => fixture.counters().writes === 1);
        if (phase === 'confirmed-read-pending') await page.getByRole('status').filter({ hasText: '已存进预设，正在检查' }).waitFor();
        const held = await snapshot(phase + '-held');
        check(`${phase}:全部6个即时数字被禁用`, held.numbers.length === 6 && held.numbers.every(x => x.disabled), held.numbers);
        check(`${phase}:显示开关及全部3个提示词开关被禁用`, held.switches.length === 4 && held.switches.every(x => x.disabled), held.switches);
        await page.screenshot({ path: path.join(output, `preset-${phase}-held.png`), fullPage: true });
        const input = page.locator('#tl-preset-temperature');
        if (await input.isEnabled()) { await input.fill('1.6'); await input.press('Tab'); }
        await page.locator('[role="switch"]').evaluateAll(elements => elements.forEach(el => el.click()));
        await page.evaluate(phase => phase === 'write-pending' ? fixture.release('write') : window.releaseRead(), phase);
        await page.getByRole('status').filter({ hasText: '已存进预设；之后' }).waitFor();
        const settled = await snapshot(phase + '-settled');
        check(`${phase}:没有接受再静默丢弃数字或开关`, settled.numbers.find(x => x.id === 'tl-preset-temperature').value === '1.1' && settled.temperature === 1.1 && settled.file === 1.1
            && settled.switches.every((x, i) => x.checked === held.switches[i].checked) && settled.counters.writes === 1, settled);
        check(`${phase}:完成后即时控件恢复可用`, settled.numbers.every(x => !x.disabled) && settled.switches.every(x => !x.disabled));
        await page.locator('.tl-page-header').getByRole('button', { name: '返回', exact: true }).click();
        check(`${phase}:成功后立即返回无额外Sheet`, await page.getByRole('dialog').count() === 0 && await page.evaluate(() => backCount === 1));
        await page.screenshot({ path: path.join(output, `preset-${phase}.png`) });
    }
    for (const phase of ['write-pending', 'confirmed-read-pending']) {
        await reset();
        await page.evaluate(phase => {
            fixture.externalRuntime({ temperature: 1.1 });
            if (phase === 'write-pending') fixture.hold('write');
            else {
                const read = fixture.bridge.presetEditorState, save = fixture.bridge.presetEditorSave; let holding = false;
                const gate = new Promise(resolve => { window.releaseExternalRead = resolve; });
                fixture.bridge.presetEditorState = async () => { if (holding) await gate; return read(); };
                fixture.bridge.presetEditorSave = async input => { const result = await save(input); holding = result.kind === 'confirmed'; return result; };
            }
        }, phase);
        await page.getByRole('button', { name: '查看这 1 处改动', exact: true }).waitFor();
        await page.getByRole('button', { name: '保存到此预设', exact: true }).click(); await page.waitForFunction(() => fixture.counters().writes === 1);
        if (phase === 'confirmed-read-pending') await page.getByRole('status').filter({ hasText: '已存进预设，正在检查' }).waitFor();
        await page.evaluate(phase => { fixture.externalRuntime({ temperature: 1.6 }); phase === 'write-pending' ? fixture.release('write') : window.releaseExternalRead(); }, phase);
        await page.getByRole('status').filter({ hasText: '已存进预设；之后' }).waitFor();
        const afterExternal = await snapshot(phase + '-external-change');
        check(`${phase}:外部后续修改仍如实显示且原文件只保存捕获快照`, afterExternal.temperature === 1.6 && afterExternal.file === 1.1
            && afterExternal.numbers.find(x => x.id === 'tl-preset-temperature').value === '1.6' && afterExternal.counters.writes === 1, afterExternal);
        await page.locator('.tl-page-header').getByRole('button', { name: '返回', exact: true }).click();
        await page.getByRole('dialog', { name: '改动已经生效', exact: true }).waitFor();
        check(`${phase}:外部真实差异仍保留即时返回提醒`, await page.evaluate(() => backCount === 0 && fixture.current().full.temperature === 1.6));
    }

    const setupUnknown = async dirty => {
        await reset();
        if (dirty) { await page.evaluate(() => fixture.externalRuntime({ temperature: 1.1 })); await page.getByRole('button', { name: '查看这 1 处改动', exact: true }).waitFor(); }
        await page.evaluate(() => {
            const read = fixture.bridge.presetEditorState, save = fixture.bridge.presetEditorSave; window.failRead = false;
            fixture.bridge.presetEditorState = async () => { if (window.failRead) throw new Error('Synthetic unknown current differences'); return read(); };
            fixture.bridge.presetEditorSave = async input => { const result = await save(input); if (result.kind === 'confirmed') { window.failRead = true; fixture.externalRuntime({ temperature: 1.6 }); } return result; };
        });
        await page.getByRole('button', { name: '保存到此预设', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已存进预设，但还没检查完' }).waitFor();
    };
    for (const dirty of [false, true]) for (const action of ['cancel', 'close', 'escape', 'confirm', 'reread-dirty', 'reread-clean']) {
        const label = `old-${dirty ? 'dirty' : 'clean'}-${action}`; await setupUnknown(dirty);
        await page.locator('select').selectOption('Other'); await page.waitForFunction(() => document.querySelector('[role="dialog"]') || fixture.counters().uses > 0);
        const proposed = await snapshot(label + '-proposed'), risk = page.getByRole('dialog', { name: '切换前改动还没检查完', exact: true });
        const guarded = await risk.count() === 1 && proposed.counters.uses === 0 && proposed.temperature === 1.6 && proposed.counters.writes === 1;
        check(`${label}:未知差异先明确风险且尚未替换`, guarded, proposed);
        if (!guarded) { await page.screenshot({ path: path.join(output, `preset-${label}-unguarded.png`) }); continue; }
        check(`${label}:风险说明后续修改并给明确选择`, (await risk.innerText()).includes('没存') && await risk.getByRole('button', { name: '暂不切换', exact: true }).isVisible()
            && await risk.getByRole('button', { name: '仍要切换', exact: true }).isVisible());
        if (!dirty && action === 'cancel') await page.screenshot({ path: path.join(output, 'preset-unverified-switch-risk.png') });
        if (action === 'confirm') {
            await risk.getByRole('button', { name: '仍要切换', exact: true }).click(); await page.waitForFunction(() => fixture.current().name === 'Other');
            check(`${label}:仅明确确认后调用一次使用且无额外保存`, await page.evaluate(() => fixture.counters().uses === 1 && fixture.counters().writes === 1 && fixture.current().full.temperature === .2));
            continue;
        }
        if (action === 'close') await risk.getByRole('button', { name: '关闭', exact: true }).click();
        else if (action === 'escape') await page.keyboard.press('Escape');
        else await risk.getByRole('button', { name: '暂不切换', exact: true }).click();
        await risk.waitFor({ state: 'hidden' });
        check(`${label}:拒绝或关闭不调用使用不改变运行值`, await page.evaluate(() => fixture.counters().uses === 0 && fixture.counters().writes === 1 && fixture.current().name === 'Original' && fixture.current().full.temperature === 1.6)
            && await page.locator('select').inputValue() === 'Original');
        if (action.startsWith('reread')) {
            const retry = page.getByRole('button', { name: '重新加载', exact: true });
            await retry.evaluate((el, clean) => el.addEventListener('click', () => { if (clean) fixture.externalRuntime({ temperature: fixture.files.get('Original').temperature }); window.failRead = false; }, { once: true, capture: true }), action === 'reread-clean');
            await retry.click(); await page.getByRole('status').filter({ hasText: '已重新加载' }).waitFor();
            await page.locator('select').selectOption('Other');
            if (action === 'reread-dirty') {
                await page.getByRole('dialog', { name: '确认切换预设', exact: true }).waitFor();
                check(`${label}:重读后真实新差异仍要求确认`, await page.evaluate(() => fixture.counters().uses === 0 && fixture.current().full.temperature === 1.6));
                await page.getByRole('button', { name: '关闭', exact: true }).click();
            } else {
                await page.waitForFunction(() => fixture.current().name === 'Other');
                check(`${label}:重读确认当前无差异才直接切换`, await page.getByRole('dialog').count() === 0 && await page.evaluate(() => fixture.counters().uses === 1));
            }
        } else {
            await page.locator('.tl-page-header').getByRole('button', { name: '返回', exact: true }).click();
            await page.getByRole('dialog', { name: '改动还没检查完', exact: true }).waitFor();
            await page.getByRole('button', { name: '继续返回', exact: true }).click();
            check(`${label}:仍保留明确主动退出且不替换配置`, await page.evaluate(() => backCount === 1 && fixture.counters().uses === 0 && fixture.counters().writes === 1));
        }
        if (!dirty && action === 'cancel') await page.screenshot({ path: path.join(output, 'preset-unverified-cancel-return.png') });
    }
    await setupUnknown(false); await page.locator('select').selectOption('Other');
    const staleRisk = page.getByRole('dialog', { name: '切换前改动还没检查完', exact: true }); await staleRisk.waitFor();
    await page.evaluate(() => { window.failRead = false; fixture.switchPreset('Other'); });
    await page.locator('.tl-preset-savebar strong').filter({ hasText: 'Other' }).waitFor();
    await staleRisk.getByRole('button', { name: '仍要切换', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '预设变了，请重新选要切到哪个' }).waitFor();
    check('来源变化使旧切换确认失效，不能重放到新预设', await page.evaluate(() => fixture.counters().uses === 0 && fixture.counters().writes === 1 && fixture.current().name === 'Other'));

    // Explicitly using a previously saved copy also replaces runtime, so it must show the same unknown-risk choice.
    await reset(); await page.evaluate(() => {
        const read = fixture.bridge.presetEditorState, save = fixture.bridge.presetEditorSave; window.failCopyRead = false; fixture.fault('use');
        fixture.bridge.presetEditorState = async () => { if (window.failCopyRead) throw new Error('Synthetic saved-copy current-state read failure'); return read(); };
        fixture.bridge.presetEditorSave = async input => { const result = await save(input); if (result.kind === 'saved-not-applied') { window.failCopyRead = true; fixture.externalRuntime({ temperature: 1.6 }); } return result; };
    });
    await page.getByRole('button', { name: '另存并使用', exact: true }).click();
    await page.getByRole('dialog', { name: '另存并使用', exact: true }).getByRole('textbox').fill('Saved pending copy');
    await page.getByRole('button', { name: '保存副本并切换使用', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已存进预设，但还没检查完' }).waitFor();
    await page.getByRole('button', { name: '使用已保存副本', exact: true }).click();
    const copyRisk = page.getByRole('dialog', { name: '切换前改动还没检查完', exact: true }); await copyRisk.waitFor();
    check('未知差异时使用已保存副本也先提示风险，无额外使用或保存', await page.evaluate(() => fixture.counters().uses === 1 && fixture.counters().writes === 1 && fixture.current().full.temperature === 1.6));
    await copyRisk.getByRole('button', { name: '暂不切换', exact: true }).click();
    check('取消使用已保存副本保留后续配置', await page.evaluate(() => fixture.counters().uses === 1 && fixture.counters().writes === 1 && fixture.current().name === 'Original' && fixture.current().full.temperature === 1.6));
    await page.getByRole('button', { name: '使用已保存副本', exact: true }).click();
    await page.evaluate(() => fixture.fault('')); await copyRisk.getByRole('button', { name: '仍要切换', exact: true }).click();
    await page.waitForFunction(() => fixture.current().name === 'Saved pending copy');
    check('明确风险确认后才使用已存副本且不再保存', await page.evaluate(() => fixture.counters().uses === 2 && fixture.counters().writes === 1 && fixture.current().full.temperature === .7));
    check('没有ST、模型或外网调用', external.length === 0, external); check('页面无JS异常', errors.length === 0, errors);
} catch (e) { fatal = { message: e.message, stack: e.stack }; console.error(e.stack); await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally { await browser?.close(); await server.close(); await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ pass: !fatal && checks.every(x => x.pass), checks, snapshots, errors, external, fatal,
    scope: 'Synthetic actual component/adapter, phone-sized browser; not a real phone, ST, model provider or natural network fault' }, null, 2));
    console.log(JSON.stringify({ passed: checks.filter(x => x.pass).length, total: checks.length, output })); if (fatal || checks.some(x => !x.pass)) process.exitCode = 1; }
