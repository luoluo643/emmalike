// Real shell components, synthetic API responses and fresh IndexedDB only. Starts its own loopback Vite server.
// No SillyTavern server, account credentials, model or external requests are used.
// Usage: CHROME_PATH=/path/to/chrome TEST_OUTPUT=/tmp/ui-workspace node tests/e2e-ui-workspace.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer, transformWithEsbuild } from 'vite';
import preact from '@preact/preset-vite';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const repo = fileURLToPath(new URL('..', import.meta.url));
const output = path.resolve(process.env.TEST_OUTPUT || path.join(repo, '..', 'ui-workspace-results'));
await fs.mkdir(output, { recursive: true });
const results = [], errors = [], externalRequests = [];
const check = (name, ok, detail = null) => { results.push({ name, pass: !!ok, detail }); assert.ok(ok, name); console.log('PASS', name); };
const delay = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
import { h, render } from 'preact';
import { useState } from 'preact/hooks';
import '/styles.css';
import { Sheet, Lightbox } from '/ui.jsx';
import { CompareSheet, PersonalSheet } from '/personal.jsx';
import { CustomCssSheet } from '/appearance.jsx';
const record = { id: 'ui-record', schema: 1, revision: 1, kind: 'variant', note: '', createdAt: 1, owner: 'ui-workspace-qa',
  text: Array.from({length:120},(_,i) => '留存原文第'+i+'段：这段合成文字只用于交互验收。').join('\\n\\n'),
  source: { avatar: 'ui-fixture.png', file: 'ui-fixture', index: 0, swipe: 0, name: '合成角色', raw: '原句', mark: 'ui', is_user: false, is_system: false } };
window.fixtureRecord = record;
history.replaceState({tavernLite:true}, '', '#workspace');
function App(){
  const [kind, setKind] = useState(''), [current,setCurrent]=useState(Array.from({length:130},(_,i)=>'当前内容第'+i+'段：与留下的版不同的合成正文。').join('\\n\\n'));
  const close = () => { setKind(''); if(kind==='rapid-a')setTimeout(()=>setKind('rapid-b'),0); };
  window.workspace = { open:setKind, changeCurrent:()=>setCurrent('后台的新内容，不应进入已打开比较') };
  return h('div',{class:'tl-app'},
    h('main',null,h('input',{id:'outside',class:'tl-composer-input',value:'后台草稿',readOnly:true}),
      ...['note','compare','generic','css','rapid-a','lightbox'].map(name=>h('button',{class:'tl-button',onClick:()=>setKind(name)},'打开'+name))),
    kind==='note' && h(PersonalSheet,{user:{handle:'ui-workspace-qa'},initialRecord:{...record,storage:window.fixtureMode},onClose:close,onLocate:()=>{},notify:()=>{}}),
    kind==='compare' && h(CompareSheet,{record,current,onClose:close}),
    kind==='css' && h(CustomCssSheet,{onClose:close}),
    kind==='lightbox' && h(Lightbox,{src:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/%3E',alt:'合成图片',onClose:close}),
    ['generic','rapid-a','rapid-b'].includes(kind) && h(Sheet,{title:kind,onClose:close},
      h('a',{href:'#workspace'},'可聚焦链接'),h('select',{'aria-label':'选项'},h('option',null,'一')),
      h('div',{hidden:true},h('button',null,'隐藏按钮')),h('button',{disabled:true},'禁用按钮'),
      h('button',{tabIndex:-1},'程序焦点'),h('div',{tabIndex:0,'aria-label':'可滚动正文',style:'overflow:auto;height:80px'},'正文内容')));
}
render(h(App),document.getElementById('root'));
</script></body></html>`;
await transformWithEsbuild(fixture.match(/<script type="module">([\s\S]*?)<\/script>/)[1], 'ui-workspace-fixture.js');
const server = await createServer({ configFile: false, root: path.join(repo, 'src'), cacheDir: path.join(repo, '.vite-ui-workspace'),
    define: { __APP_VERSION__: JSON.stringify('ui-workspace-fixture') }, logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
    plugins: [preact(), { name: 'ui-workspace-fixture', configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
            if (req.url?.split('?')[0] !== '/__ui-workspace') return next();
            res.statusCode = 200; res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/__ui-workspace', fixture));
        });
    } }],
});
let browser, activePage;
try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    let executablePath = process.env.CHROME_PATH;
    if (!executablePath && process.platform === 'win32') {
        for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']) {
            if (await fs.access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
        }
    }
    browser = await chromium.launch({ executablePath, headless: true });
    for (const mode of ['account', 'device']) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
        const page = activePage = await context.newPage(); page.setDefaultTimeout(12000);
        page.on('pageerror', e => errors.push({ mode, message: e.message }));
        let savedRecord, authGate = null, held = false, rejectAuth = false;
        await page.addInitScript(mode => { window.fixtureMode = mode; }, mode);
        await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin !== origin) { externalRequests.push(url.origin + url.pathname); return route.abort(); }
            const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
            if (url.pathname === '/csrf-token') return json({ token: 'synthetic-csrf' });
            if (url.pathname === '/api/users/me') {
                if (authGate) { held = true; await authGate.promise; authGate = null; if (rejectAuth) { rejectAuth = false; return json({ error: '合成保存失败' }, 503); } }
                return json({ handle: 'ui-workspace-qa', name: '合成验收' });
            }
            if (url.pathname === '/api/plugins/tavern-lite/health') return mode === 'device' ? json({}, 404) : json({ personalRecords: true, account: 'ui-workspace-qa' });
            if (url.pathname.endsWith('/records/list')) return json({ account: 'ui-workspace-qa', records: savedRecord ? [savedRecord] : [] });
            if (url.pathname.endsWith('/records/write')) {
                const body = route.request().postDataJSON();
                savedRecord = { ...savedRecord, note: body.note, revision: savedRecord.revision + 1 };
                return json({ account: 'ui-workspace-qa', record: savedRecord });
            }
            if (url.pathname.startsWith('/api/')) return json([]);
            return route.continue();
        });
        await page.goto(origin + '/__ui-workspace'); await page.waitForFunction(() => window.workspace && window.fixtureRecord);
        savedRecord = await page.evaluate(() => window.fixtureRecord);
        if (mode === 'device') await page.evaluate(async () => {
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('tavern-lite-personal', 1);
                request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'key' });
                request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
            });
            await new Promise((resolve, reject) => {
                const tx = db.transaction('records', 'readwrite');
                tx.objectStore('records').put({ ...window.fixtureRecord, key: JSON.stringify(['ui-workspace-qa', 'ui-record']) });
                tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
            }); db.close();
        });
        const dialog = name => page.getByRole('dialog', { name, exact: true });
        const noLayer = () => page.waitForFunction(() => !history.state?.tlLayer);
        const open = async kind => { await page.getByRole('button', { name: '打开' + kind, exact: true }).click(); await page.waitForFunction(() => !!history.state?.tlLayer); };
        const note = () => page.getByLabel('只给自己看的备注');
        const tryClose = async how => {
            if (how === 'Escape') await page.keyboard.press('Escape');
            else if (how === 'button') await dialog('私人备注').getByRole('button', { name: '关闭', exact: true }).click();
            else if (how === 'backdrop') await page.locator('.tl-sheet-backdrop').click({ position: { x: 2, y: 2 } });
            else await page.evaluate(() => history.back());
        };
        for (const how of ['Escape', 'button', 'backdrop', 'back']) {
            await open('note'); await note().fill('未保存的完整备注 ' + how);
            await tryClose(how); await dialog('备注还没保存').waitFor();
            await page.keyboard.press('Escape'); await dialog('备注还没保存').waitFor({ state: 'detached' });
            check(`${mode}/${how} 确认框Esc只返回编辑且保留内容`, await note().inputValue() === '未保存的完整备注 ' + how);
            await page.waitForFunction(() => history.state?.tlLayer === true);
            await tryClose(how); await dialog('备注还没保存').waitFor();
            await dialog('备注还没保存').getByRole('button', { name: '放弃修改', exact: true }).click();
            await dialog('我的摘录').waitFor();
            await page.waitForFunction(() => history.state?.tlLayer === true);
            await page.evaluate(() => history.back()); await dialog('我的摘录').waitFor({ state: 'detached' }); await noLayer();
            check(`${mode}/${how} 连续返回及放弃后返回只离开对应层`, page.url().endsWith('#workspace'));
        }
        await open('generic'); await page.keyboard.press('Shift+Tab');
        check(`${mode} 容器初始焦点ShiftTab到最后正文`, await page.getByLabel('可滚动正文').evaluate(el => el === document.activeElement));
        await page.keyboard.press('Tab');
        check(`${mode} 正文之后Tab回关闭且不落后台`, await dialog('generic').getByRole('button', { name: '关闭', exact: true }).evaluate(el => el === document.activeElement));
        await page.keyboard.press('Tab'); check(`${mode} 焦点包含链接`, await page.getByRole('link', { name: '可聚焦链接' }).evaluate(el => el === document.activeElement));
        await page.keyboard.press('Tab'); check(`${mode} 焦点包含select`, await page.getByLabel('选项').evaluate(el => el === document.activeElement));
        await page.keyboard.press('Tab'); check(`${mode} 跳过隐藏禁用负tabindex`, await page.getByLabel('可滚动正文').evaluate(el => el === document.activeElement));
        await page.evaluate(() => document.getElementById('outside').focus());
        check(`${mode} 后台不可聚焦且引擎未被禁用`, await dialog('generic').evaluate(el => el.contains(document.activeElement)));
        await page.keyboard.press('Escape'); await noLayer();
        check(`${mode} 退出恢复存在的触发按钮`, await page.getByRole('button', { name: '打开generic', exact: true }).evaluate(el => el === document.activeElement));
        await open('rapid-a'); await page.keyboard.press('Escape'); await dialog('rapid-b').waitFor(); await page.waitForTimeout(150);
        check(`${mode} 快速关A开B不被旧history回调或焦点恢复关闭`, await dialog('rapid-b').isVisible() && await dialog('rapid-b').evaluate(el => el.contains(document.activeElement)));
        await page.keyboard.press('Escape'); await noLayer();

        await open('note'); await note().fill('保存期间继续保留'); authGate = delay(); rejectAuth = true; held = false;
        await dialog('私人备注').getByRole('button', { name: '保存备注', exact: true }).click();
        while (!held) await page.waitForTimeout(20);
        await page.keyboard.press('Escape'); await page.evaluate(() => history.back()); await page.waitForTimeout(100);
        check(`${mode} 保存中Esc和返回都不关闭`, await dialog('私人备注').isVisible() && await dialog('私人备注').getByRole('button', { name: '关闭', exact: true }).isDisabled());
        authGate.release(); await dialog('私人备注').getByRole('alert').waitFor();
        check(`${mode} 保存失败保留文字和可重试入口`, await note().inputValue() === '保存期间继续保留' && await page.getByRole('button', { name: '保存备注', exact: true }).isEnabled());
        await page.getByRole('button', { name: '保存备注', exact: true }).click(); await dialog('我的摘录').waitFor();
        await dialog('我的摘录').getByText('备注：保存期间继续保留', { exact: true }).waitFor();
        check(`${mode} 重试保存成功`, (await dialog('我的摘录').innerText()).includes('保存期间继续保留'));
        const listBefore = await dialog('我的摘录').boundingBox();
        const rowBefore = await page.locator('[data-record-id="ui-record"]').boundingBox();
        authGate = delay(); held = false;
        await page.evaluate(() => dispatchEvent(new Event('focus')));
        while (!held) await page.waitForTimeout(20);
        const listDuring = await dialog('我的摘录').boundingBox();
        const rowDuring = await page.locator('[data-record-id="ui-record"]').boundingBox();
        check(`${mode} 刷新中保留已有摘录且面板高度和内边距稳定`, !!rowDuring && listBefore.height === listDuring.height && rowBefore.x === rowDuring.x && rowBefore.y === rowDuring.y);
        authGate.release(); await page.waitForTimeout(100);
        await page.keyboard.press('Escape'); await noLayer();

        await open('note'); await note().fill('很长的备注\n'.repeat(200));
        check(`${mode} 原文摘要保留完整快照`, await page.locator('.tl-note-quote').innerText() === savedRecord.text && await page.locator('.tl-note-quote').evaluate(el => el.scrollHeight > el.clientHeight));
        await page.getByRole('button', { name: '展开原文', exact: true }).click();
        check(`${mode} 原文可展开且语义同步`, await page.getByRole('button', { name: '收起原文', exact: true }).getAttribute('aria-expanded') === 'true');
        await page.screenshot({ path: path.join(output, `${mode}-note-390.png`) });
        await page.evaluate(() => {
            Object.defineProperty(visualViewport, 'height', { configurable: true, value: 240 });
            Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 42 });
            visualViewport.dispatchEvent(new Event('resize'));
        });
        await page.waitForTimeout(100);
        const viewportSave = await page.getByRole('button', { name: '保存备注', exact: true }).boundingBox();
        check(`${mode} 模拟visualViewport独立缩小及偏移保留保存入口`, viewportSave && viewportSave.y >= 42 && viewportSave.y + viewportSave.height <= 282);
        await note().focus(); await page.keyboard.press('End'); await page.keyboard.type('当前光标内容'); await page.waitForTimeout(100);
        const visibleEditor = await note().evaluate(element => {
            const rect = element.getBoundingClientRect(), footer = document.querySelector('.tl-note-actions').getBoundingClientRect();
            const style = getComputedStyle(element), lineHeight = parseFloat(style.lineHeight);
            const visibleHeight = Math.max(0, Math.min(rect.bottom, footer.top, 282) - Math.max(rect.top, 42));
            return { visibleHeight, needed: lineHeight * 3 + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
                active: document.activeElement === element, caretAtEnd: element.selectionEnd === element.value.length };
        });
        check(`${mode} 小visualViewport聚焦后至少三行输入可见且光标仍在当前内容`, visibleEditor.active && visibleEditor.visibleHeight + 1 >= visibleEditor.needed && visibleEditor.caretAtEnd, visibleEditor);
        await page.screenshot({ path: path.join(output, `${mode}-note-visualviewport-simulated.png`) });
        await page.evaluate(() => { delete visualViewport.height; delete visualViewport.offsetTop; visualViewport.dispatchEvent(new Event('resize')); });
        for (const size of [{ width: 320, height: 640 }, { width: 640, height: 220 }]) {
            await page.setViewportSize(size); await page.waitForTimeout(100);
            const bounds = await page.getByRole('button', { name: '保存备注', exact: true }).boundingBox();
            check(`${mode} ${size.width}×${size.height}保存动作在可见视口`, bounds && bounds.y >= 0 && bounds.y + bounds.height <= size.height + 1);
            await page.screenshot({ path: path.join(output, `${mode}-note-${size.width}x${size.height}.png`) });
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await page.keyboard.press('Escape'); await dialog('备注还没保存').getByRole('button', { name: '放弃修改', exact: true }).click();
        await dialog('我的摘录').waitFor(); await page.keyboard.press('Escape'); await noLayer();

        await open('compare');
        const old = page.getByLabel('快照正文'), current = page.getByLabel('当前版正文');
        const before = await current.textContent();
        await page.evaluate(() => window.workspace.changeCurrent());
        check(`${mode} 比较始终是打开时快照`, await current.textContent() === before);
        await page.getByRole('tab', { name: '留下的版', exact: true }).focus(); await page.keyboard.press('ArrowRight');
        check(`${mode} 方向键同步选择和焦点`, await page.getByRole('tab', { name: '当前版', exact: true }).getAttribute('aria-selected') === 'true');
        await page.keyboard.press('Tab'); check(`${mode} 标签Tab可进入正文`, await current.evaluate(el => el === document.activeElement));
        await page.waitForTimeout(100); await current.evaluate(el => { el.scrollTop = 650; }); await page.waitForTimeout(80);
        await page.getByRole('tab', { name: '留下的版', exact: true }).click(); await page.waitForTimeout(100);
        await old.evaluate(el => { el.scrollTop = 430; }); await page.waitForTimeout(80);
        await page.setViewportSize({ width: 1440, height: 1000 }); await page.waitForTimeout(120);
        check(`${mode} 桌面两列保留各自阅读位置`, await old.evaluate(el => Math.abs(el.scrollTop - 430) < 3) && await current.evaluate(el => Math.abs(el.scrollTop - 650) < 3));
        check(`${mode} 桌面隐藏标签不进入焦点路径`, await page.getByRole('tab').count() === 0 && await page.getByRole('region').count() === 2);
        await page.screenshot({ path: path.join(output, `${mode}-compare-1440.png`) });
        await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(120);
        check(`${mode} 回手机后留下的版位置不变`, await old.evaluate(el => Math.abs(el.scrollTop - 430) < 3));
        await page.getByRole('tab', { name: '当前版', exact: true }).click(); await page.waitForTimeout(100);
        check(`${mode} 回手机后另一版位置不变`, await current.evaluate(el => Math.abs(el.scrollTop - 650) < 3));
        const tab = page.getByRole('tab', { name: '当前版', exact: true });
        check(`${mode} tab和tabpanel关联完整`, await tab.getAttribute('aria-controls') === await page.getByRole('tabpanel').getAttribute('id'));
        await page.screenshot({ path: path.join(output, `${mode}-compare-390.png`) });
        await page.keyboard.press('Escape'); await noLayer();
        check(`${mode} 比较保留后台草稿`, await page.locator('#outside').inputValue() === '后台草稿');
        await open('css'); await page.locator('textarea[aria-label="自定义 CSS"]').fill(':root { --tl-bg: rgb(1, 2, 3); }');
        await page.keyboard.press('Escape'); await noLayer();
        check(`${mode} CSS预览最新关闭回滚`, !await page.evaluate(() => document.getElementById('tl-user-css')?.textContent.includes('rgb(1, 2, 3)')));
        await open('lightbox'); check(`${mode} 图片层保留可达关闭`, await page.getByRole('button', { name: '关闭原图', exact: true }).isVisible());
        await page.keyboard.press('Escape'); await noLayer();
        await context.close();
    }
    check('未产生外部请求', externalRequests.length === 0, externalRequests);
    check('没有浏览器JS异常', errors.length === 0, errors);
} catch (error) {
    results.push({ name: 'unexpected_failure', pass: false, message: error.stack || error.message });
    if (activePage && !activePage.isClosed()) {
        await activePage.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
        await fs.writeFile(path.join(output, 'failure-dom.txt'), await activePage.locator('body').innerText().catch(() => ''), 'utf8');
    }
    process.exitCode = 1; console.error(error);
} finally {
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ results, errors, externalRequests,
        scope: 'Loopback Vite; real Preact components; synthetic API and fresh IndexedDB. Resized headless viewport is not an iOS/Android keyboard test.' }, null, 2));
    await browser?.close(); await server.close();
}
