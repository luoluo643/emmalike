// Local real components + real IndexedDB + injected native contract. No ST server or provider/network data.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const repo = fileURLToPath(new URL('..', import.meta.url)), output = path.resolve(process.env.TEST_OUTPUT || path.join(repo, '..', 'world-editor-ui-evidence'));
await fs.mkdir(output, { recursive: true });
const checks = [], errors = [], external = [];
const check = (name, condition, detail) => { checks.push({ name, pass: !!condition, detail }); console.log(condition ? 'PASS' : 'FAIL', name); assert.ok(condition, name); };
const internalSeen = [];
async function endWaiting(page) {
    await page.getByRole('button', { name: '结束这次等待，继续编辑', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: '结束等待，继续编辑', exact: true });
    // The sheet speaks of entries by their titles: no entry numbers, no raw saved data.
    const text = await sheet.innerText(); if (/条目 \d|"entries"|"uid"/.test(text)) internalSeen.push(text.slice(0, 200));
    await sheet.getByRole('button', { name: '按酒馆里现在的内容接着改', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '不等了' }).waitFor();
}
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import { h,render } from 'preact'; import { useEffect,useState } from 'preact/hooks';
import { WorldBookPage,WorldsPage } from '/world-editor.jsx'; import { parseHash,go,wasLayerPop } from '/ui.jsx';
import { createWorldEditorAdapter } from '/@fs/REPO/bridge-world-editor.js';
import { createWorldEditorJournal } from '/world-editor-journal.js';
import { worldFingerprint } from '/world-editor-model.js'; import '/styles.css';
const copy=x=>JSON.parse(JSON.stringify(x));
const seed={entries:{0:{uid:0,comment:'Synthetic first',content:'Original long text. '+ '文本 '.repeat(600),key:['first'],keysecondary:[],group:'ADVANCED_NEEDLE',disable:false,constant:false,unknown:{keep:17}},1:{uid:1,comment:'Second',content:'Second body',key:['second'],disable:false}},originalData:{entries:[{uid:0,content:'Original long text. '+ '文本 '.repeat(600),enabled:true},{uid:1,content:'Second body',enabled:true}]},unknown:{book:'preserved'}};
const files=new Map(JSON.parse(localStorage.getItem('fixture-files')||'null')||[['Book',seed]]),cache=new Map([...files].map(([name,value])=>[name,copy(value)])), listeners=new Set();
let queue=Promise.resolve(),writes=0,fault='',active=true,hold=null,release=null,watcher=null,readsBlocked=false;
const lease={account:'editor-test'}; const persist=()=>localStorage.setItem('fixture-files',JSON.stringify([...files]));
const notify=()=>listeners.forEach(fn=>fn('world-editor-changed'));
let failJournal=''; const journal=createWorldEditorJournal(), updateJournal=journal.update.bind(journal);
journal.update=async(op,patch)=>{if(failJournal && (patch.stage===failJournal || patch.writeSettled===failJournal)){failJournal='';throw Object.assign(new Error('Injected post-write journal failure'),{code:'WORLD_JOURNAL_UNAVAILABLE'});}return updateJournal(op,patch);};
const decideJournal=journal.decide.bind(journal); journal.decide=async(...args)=>{if(failJournal==='decision'){failJournal='';throw Object.assign(new Error('Injected decision persistence failure'),{code:'WORLD_JOURNAL_UNAVAILABLE'});}return decideJournal(...args);};
const bridge=createWorldEditorAdapter({account:lease.account,journal,uuid:()=>crypto.randomUUID(),
 enqueue(fn){const promise=queue.then(fn);queue=promise.catch(()=>{});return promise;},makeLease:()=>lease,
 assertLease(l){if(l!==lease||!active)throw Object.assign(new Error('Account changed'),{code:'ACCOUNT_CHANGED'});},verifyAccount:async()=>{},
 listBooks:async()=>[...files.keys()],readServerBook:async name=>{if(readsBlocked)throw new Error('Server read unavailable');return copy(files.get(name)||{entries:{}});},
 cacheGet:name=>cache.get(name),cacheSet:(name,value)=>cache.set(name,copy(value)),cacheDelete:name=>cache.delete(name),
 async saveNativeImmediate(name,value,lease,before){if(fault==='before-native')throw Object.assign(new Error('Injected before native invocation'),{nativeWriteStarted:false});before();writes++;cache.set(name,copy(value));if(hold)await hold;
  if(!['http500','never'].includes(fault)){files.set(name,copy(value));persist();}if(fault==='unknown'){readsBlocked=true;throw new Error('Lost response');}if(fault==='never')throw new Error('Unconfirmed delivery');
  watcher?.();notify();},watchUpdates(name,fn){watcher=fn;return()=>{watcher=null;};},
  emitUpdated:async()=>{if(fault==='emit-error')throw new Error('Synthetic emitUpdated runtime-sync error');notify();},
  reloadEditor:async()=>{if(fault==='reload-error')throw new Error('Synthetic reloadEditor runtime-sync error');},refreshBookList:async()=>{},
 describeSources:async()=>({global:false,characters:['Synthetic character'],currentChat:true,persona:true,otherReferences:'unknown'}),
 createEntry(name,data){let uid=0;while(data.entries[uid])uid++;return data.entries[uid]={uid,content:'',comment:'',key:[],keysecondary:[],disable:false,constant:false};},
 setOriginal(data,uid,key,value){const entry=data.originalData?.entries.find(e=>e.uid===uid);if(entry&&key==='content')entry.content=value;},
 deleteOriginal(data,uid){if(data.originalData)data.originalData.entries=data.originalData.entries.filter(e=>e.uid!==uid);}
});
bridge.worldBooks=()=>[...files.keys()].map(name=>({name,global:false,characters:[]}));bridge.on=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
window.fixture={bridge,files,cache,seed,go,writes:()=>writes,async disk(name='Book'){return copy(files.get(name));},
 fault(value){fault=value;},journalFault(value){failJournal=value;},hold(){hold=new Promise(resolve=>{release=resolve;});},release(){release?.();hold=null;},readable(){readsBlocked=false;fault='';},
 external(patch){Object.assign(files.get('Book').entries[0],patch);cache.set('Book',copy(files.get('Book')));persist();notify();},
 addBook(name){const value=copy(seed);value.entries[0].content='OLD_UI';value.originalData.entries[0].content='OLD_UI';files.set(name,value);cache.set(name,copy(value));persist();},
 async deliver(name){const op=(await journal.unfinished(lease.account)).find(x=>x.name===name&&x.userDecision);if(!op)throw new Error('No decided operation');files.set(name,copy(op.expectedBook));persist();notify();},
 async staleDraft(name,pendingStage='armed'){this.addBook(name);const expectedBook=copy(files.get(name)),base=copy(expectedBook.entries[0]);
  let op=await journal.create({account:lease.account,name,operationId:crypto.randomUUID(),action:'entry-edit',uid:0,draftRevision:1,expectedBook,expectedFingerprint:worldFingerprint(expectedBook),baseFingerprint:worldFingerprint(expectedBook)});
  op=await journal.update(op,{stage:'confirmed',runtimeState:'conflict',writeSettled:'resolved'});
  const pending={...copy(op),stage:pendingStage};localStorage.setItem('tavern-lite:world-draft:v1:'+JSON.stringify([lease.account,name,0]),JSON.stringify({base,opened:base,form:{...base,content:'RETAINED_LOCAL',keyText:base.key.join('\\n'),secondaryText:''},revision:2,pending,submitted:base}));},
 async reset(){files.clear();files.set('Book',copy(seed));cache.clear();cache.set('Book',copy(seed));persist();writes=0;fault='';readsBlocked=false;}}
if(!location.hash)history.replaceState({tavernLite:false},'', '#world=Book');
function App(){const [route,setRoute]=useState(parseHash());useEffect(()=>{const update=event=>{if(event.type==='popstate'&&wasLayerPop())return;setRoute(parseHash());};
 addEventListener('tl-route',update);addEventListener('popstate',update);return()=>{removeEventListener('tl-route',update);removeEventListener('popstate',update);};},[]);
return h('div',{class:'tl-app'},route.name==='worlds'?h(WorldsPage,{eng:{state:'idle'},bridge,notify:()=>{},onOpenNative:()=>{}}):h(WorldBookPage,{key:route.book||'Book',book:route.book||'Book',entry:route.entry,eng:{state:'idle'},bridge,notify:()=>{},onOpenNative:()=>{}}));}
render(h(App),document.getElementById('root'));
</script></body></html>`.replaceAll('REPO', repo.replaceAll('\\', '/').replace(/\/$/, ''));
const server = await createServer({ configFile: false, root: path.join(repo, 'src'), cacheDir: path.join(repo, '.vite-world-editor-ui'),
    define: { __APP_VERSION__: JSON.stringify('editor-next-fixture') }, logLevel: 'error', server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } },
    plugins: [preact(), { name: 'world-editor-fixture', configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/__world-editor') return next(); res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__world-editor', html));
    }); } }],
});
let browser, page, fatal;
try {
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    let executablePath = process.env.CHROME_PATH;
    if (!executablePath && process.platform === 'win32') for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']) {
        if (await fs.access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
    }
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) { external.push(url.origin + url.pathname); return route.abort(); }
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: [] });
        return route.continue();
    });
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/__world-editor'); await page.getByRole('searchbox', { name: '搜索本书条目' }).waitFor();
    if (!process.env.WORLD_F7_ONLY) {
    check('少量条目的本书搜索始终可见', await page.getByRole('searchbox', { name: '搜索本书条目' }).isVisible());
    check('当前聊天和人设来源及其他引用未知持续可见', (await page.locator('.tl-world-scope').innerText()).includes('当前聊天') && (await page.locator('.tl-world-scope').innerText()).includes('人设') && (await page.locator('.tl-world-scope').innerText()).includes('没法列全'));
    await page.getByRole('searchbox', { name: '搜索本书条目' }).fill('ADVANCED_NEEDLE');
    check('搜索命中高级字段并显示片段', await page.locator('.tl-world-hit').innerText() === '分组：ADVANCED_NEEDLE');
    await page.locator('.tl-world-open').click(); await page.locator('#tl-wi-content').waitFor();
    check('高级命中临时展开但常用偏好不变', await page.locator('details.tl-wi-more').getAttribute('open') !== null && await page.getByRole('button', { name: '常用', exact: true }).getAttribute('aria-pressed') === 'true');
    await page.getByRole('button', { name: '返回', exact: true }).click(); await page.getByRole('searchbox').waitFor();
    check('从条目返回恢复搜索内容', await page.getByRole('searchbox').inputValue() === 'ADVANCED_NEEDLE');
    await page.getByRole('searchbox').fill('');

    await page.getByRole('button', { name: '＋ 新条目', exact: true }).click(); await page.locator('#tl-wi-comment').fill('Cancelled draft');
    await page.getByRole('button', { name: '返回', exact: true }).click(); await page.getByRole('button', { name: '放弃草稿，返回', exact: true }).click();
    await page.getByRole('searchbox').waitFor();
    check('新条目取消不发写请求也不留下空条目', await page.evaluate(() => fixture.writes() === 0 && Object.keys(fixture.files.get('Book').entries).length === 2));

    await page.locator('.tl-world-open').first().click(); await page.locator('#tl-wi-content').fill('My unsaved body');
    await page.locator('#tl-wi-comment').fill('My new title');
    check('修改计数比较实际字段而非输入次数', await page.getByRole('button', { name: '本次已改 2 处', exact: true }).isVisible());
    await page.getByRole('button', { name: '恢复标题', exact: true }).click();
    check('恢复单字段保留其他草稿', await page.locator('#tl-wi-comment').inputValue() === 'Synthetic first' && await page.locator('#tl-wi-content').inputValue() === 'My unsaved body');
    await page.evaluate(() => fixture.fault('before-native')); await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '这次没存，草稿还在' }).waitFor();
    check('本调用明确未派发保留草稿且允许新提交，不制造未知等待', await page.locator('#tl-wi-content').inputValue() === 'My unsaved body'
        && await page.getByRole('button', { name: '保存', exact: true }).isEnabled()
        && await page.evaluate(async () => fixture.writes() === 0 && (await fixture.bridge.worldEditorUnfinished()).length === 0));
    await page.evaluate(() => fixture.fault('http500')); await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '还不知道存没存上' }).waitFor();
    check('HTTP500加OLD仍未知保留输入且阻止重复保存和发送', await page.locator('#tl-wi-content').inputValue() === 'My unsaved body' && await page.getByRole('button', { name: '保存', exact: true }).isDisabled()
        && await page.evaluate(() => { try { fixture.bridge.assertWorldRuntimeReady(); return false; } catch (e) { return e.code==='WORLD_RUNTIME_UNCONFIRMED'; } }));
    await page.getByRole('button', { name: '检查上次保存', exact: true }).click(); await page.getByRole('status').filter({ hasText: '还不知道存没存上' }).waitFor();
    check('只读再次查验OLD不声称未提交且不解除发送门槛', await page.evaluate(() => { try { fixture.bridge.assertWorldRuntimeReady(); return false; } catch { return fixture.writes()===1; } }));
    await page.getByRole('button', { name: '用酒馆里的版本，恢复聊天', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已按酒馆里的版本检查过' }).waitFor();
    check('明确服务器出口才按实际磁盘恢复cache，未知写锁仍保留', await page.evaluate(() => { fixture.bridge.assertWorldRuntimeReady(); return JSON.stringify(fixture.cache.get('Book')) === JSON.stringify(fixture.files.get('Book')); }) && await page.getByRole('button',{name:'保存',exact:true}).isDisabled());
    await endWaiting(page);

    await page.evaluate(() => { fixture.fault(''); fixture.hold(); }); await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '正在保存…', exact: true }).waitFor(); await page.locator('#tl-wi-content').fill('Later input while saving');
    await page.getByRole('button', { name: '返回', exact: true }).click();
    check('保存中返回保持编辑页和后续输入', await page.locator('#tl-wi-content').inputValue() === 'Later input while saving');
    await page.evaluate(() => fixture.release()); await page.getByRole('status').filter({ hasText: '之后写的' }).waitFor();
    check('只确认提交快照，继续输入仍为草稿', await page.locator('#tl-wi-content').inputValue() === 'Later input while saving' && await page.evaluate(() => fixture.files.get('Book').entries[0].content === 'My unsaved body'));

    const writesBeforeIme = await page.evaluate(() => fixture.writes());
    await page.locator('#tl-wi-content').dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, keyCode: 229, bubbles: true });
    await page.waitForTimeout(100);
    check('组合态自定义Ctrl+Enter不提交', await page.evaluate(() => fixture.writes()) === writesBeforeIme);
    await page.evaluate(() => fixture.external({ content: 'Externally revised body', comment: 'Externally revised title' }));
    await page.getByRole('button', { name: '把我的版本留作草稿', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '这几项' }).waitFor();
    check('外部版本变化冻结本页版本并明确保留冲突正文', await page.locator('#tl-wi-comment').inputValue() === 'Synthetic first' && await page.locator('#tl-wi-content').inputValue() === 'Later input while saving');
    await page.locator('.tl-world-conflicts > div').filter({ has: page.locator('strong', { hasText: '标题' }) }).getByRole('button', { name: '用酒馆里的', exact: true }).click();
    await page.getByRole('button', { name: '保留我的内容', exact: true }).click(); await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已确认存好' }).waitFor();
    check('明确选择冲突内容后保存保留其他远端字段', await page.evaluate(() => fixture.files.get('Book').entries[0].content === 'Later input while saving' && fixture.files.get('Book').entries[0].comment === 'Externally revised title'));

    await page.getByRole('button', { name: '返回', exact: true }).click(); await page.getByRole('button', { name: '＋ 新条目', exact: true }).waitFor();
    await page.getByRole('button', { name: '＋ 新条目', exact: true }).click(); await page.locator('#tl-wi-comment').fill('Held creation'); await page.locator('#tl-wi-content').fill('Captured new body');
    const beforeHeld = await page.evaluate(() => fixture.writes());
    await page.evaluate(() => fixture.hold()); await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(n => fixture.writes() > n, beforeHeld); await page.locator('#tl-wi-content').fill('Typed during creation');
    await page.evaluate(() => fixture.release()); await page.getByRole('status').filter({ hasText: '之后写的' }).waitFor();
    const heldUid = await page.evaluate(() => Object.values(fixture.files.get('Book').entries).find(e => e.comment === 'Held creation').uid);
    await page.reload(); await page.locator('#tl-wi-content').waitFor();
    check('新建保存等待期间继续输入在确认和刷新后保留', await page.locator('#tl-wi-content').inputValue() === 'Typed during creation');
    await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已确认存好' }).waitFor();
    check('普通新增确认后刷新再次保存仍写原UID', await page.evaluate(uid => fixture.files.get('Book').entries[uid].content === 'Typed during creation' && Object.values(fixture.files.get('Book').entries).filter(e => e.comment === 'Held creation').length === 1, heldUid));
    await page.getByRole('button', { name: '返回', exact: true }).click(); await page.getByRole('button', { name: '＋ 新条目', exact: true }).waitFor();
    await page.getByRole('button', { name: '＋ 新条目', exact: true }).click(); await page.locator('#tl-wi-comment').fill('Unknown creation'); await page.locator('#tl-wi-content').fill('Single captured new entry');
    await page.evaluate(() => fixture.fault('unknown')); await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '检查上次保存', exact: true }).waitFor();
    const unknownWrites = await page.evaluate(() => fixture.writes());
    check('未知新增停留草稿并禁止重复提交', await page.getByRole('button', { name: '保存', exact: true }).isDisabled() && await page.locator('#tl-wi-content').inputValue() === 'Single captured new entry');
    await page.locator('#tl-wi-content').fill('Later unknown draft');
    await page.reload(); await page.getByRole('button', { name: '检查上次保存', exact: true }).waitFor();
    check('刷新后真实IndexedDB恢复未知提交且不重发', await page.locator('#tl-wi-content').inputValue() === 'Later unknown draft' && await page.evaluate(() => fixture.writes()) === 0);
    await page.evaluate(() => fixture.readable()); await page.getByRole('button', { name: '检查上次保存', exact: true }).click();
    await page.getByRole('status').filter({ hasText: /已.*保存/ }).waitFor();
    check('核对未知创建不再写入也不重复UID', await page.evaluate(() => fixture.writes()) === 0 && await page.evaluate(() => Object.values(fixture.files.get('Book').entries).filter(e => e.comment === 'Unknown creation').length) === 1, { originalWrites: unknownWrites });
    const assigned = await page.evaluate(() => Object.values(fixture.files.get('Book').entries).find(e => e.comment === 'Unknown creation').uid);
    await page.reload(); await page.locator('#tl-wi-content').waitFor();
    check('确认新增后刷新仍为同一UID且继续输入保留', await page.locator('#tl-wi-content').inputValue() === 'Later unknown draft' && await page.getByRole('button', { name: '保存', exact: true }).isEnabled());
    await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已确认存好' }).waitFor();
    check('刷新后再保存只更新已分配UID不重复创建', await page.evaluate(uid => fixture.files.get('Book').entries[uid].content === 'Later unknown draft' && Object.values(fixture.files.get('Book').entries).filter(e => e.comment === 'Unknown creation').length === 1, assigned));
    await page.getByRole('button', { name: '返回', exact: true }).click(); await page.getByRole('button', { name: /^复制这本世界书/ }).waitFor();
    await page.getByRole('button', { name: /^复制这本世界书/ }).click();
    const copyDialog = page.getByRole('dialog', { name: '复制世界书', exact: true }); await copyDialog.getByRole('textbox').fill('Independent copy'); await copyDialog.getByRole('button', { name: '复制并编辑', exact: true }).click();
    await page.getByRole('heading', { name: 'Independent copy', exact: true }).waitFor();
    check('复制后编辑副本且原书仍保留', await page.evaluate(() => fixture.files.has('Book') && fixture.files.has('Independent copy')));
    await page.evaluate(() => { fixture.fault('http500'); fixture.journalFault('unconfirmed'); });
    await page.locator('.tl-world-toggle').first().click(); await page.getByRole('button', { name: '检查保存结果', exact: true }).waitFor();
    check('开关写后日志失败保留操作身份和查回入口', await page.locator('.tl-world-toggle').first().isDisabled());
    await page.getByRole('button', { name: '检查保存结果', exact: true }).click(); await page.getByRole('status').filter({ hasText: '还要检查存没存上' }).waitFor();
    check('开关旧内容查回仍未知，未自动解除提交锁', await page.locator('.tl-world-toggle').first().isDisabled());
    await endWaiting(page); check('开关经用户明确裁定后允许新操作', await page.locator('.tl-world-toggle').first().isEnabled());
    await page.evaluate(() => { fixture.fault(''); fixture.journalFault('resolved'); });
    await page.getByRole('button', { name: /^复制这本世界书/ }).click();
    const laterCopy = page.getByRole('dialog', { name: '复制世界书', exact: true }); await laterCopy.getByRole('textbox').fill('Recovered copy'); await laterCopy.getByRole('button', { name: '复制并编辑', exact: true }).click();
    await page.getByRole('button', { name: '检查保存结果', exact: true }).waitFor();
    check('复制写后日志故障保留查回入口并禁止重复复制', await page.getByRole('button', { name: /^复制这本世界书/ }).isDisabled());
    await page.getByRole('button',{name:'用酒馆里的版本，恢复聊天',exact:true}).click();
    await page.getByRole('status').filter({hasText:'保存记录还在'}).waitFor();
    check('复制目标的服务器核对解锁不误清原书并保留查回', await page.evaluate(()=>{fixture.bridge.assertWorldRuntimeReady();return true;}) && await page.getByRole('button',{name:'检查保存结果',exact:true}).isVisible());
    const writesBeforeCopyRecovery=await page.evaluate(()=>fixture.writes());
    await page.getByRole('button', { name: '检查保存结果', exact: true }).click(); await page.getByRole('heading',{name:'Recovered copy',exact:true}).waitFor();
    check('副本按原操作查回成功且零重发', await page.evaluate(()=>fixture.writes())===writesBeforeCopyRecovery);
    await page.locator('.tl-world-open').first().click(); await page.locator('#tl-wi-content').waitFor();
    const deleteUid=await page.evaluate(()=>new URLSearchParams(location.hash.slice(1)).get('entry'));
    await page.evaluate(()=>fixture.journalFault('resolved')); await page.getByText('删除这一条',{exact:true}).click();
    await page.getByRole('dialog',{name:/^删除「/}).getByRole('button',{name:'删除',exact:true}).click();
    await page.getByRole('button',{name:'检查上次保存',exact:true}).waitFor(); const beforeDeleteRecovery=await page.evaluate(()=>fixture.writes());
    check('删除写后日志故障停留编辑页并保留查回身份', await page.getByRole('button',{name:'检查上次保存',exact:true}).isVisible());
    await page.getByRole('button',{name:'检查上次保存',exact:true}).click(); await page.getByRole('searchbox',{name:'搜索本书条目'}).waitFor();
    check('删除查回确认后返回列表且不重发', await page.evaluate(uid=>!fixture.files.get('Recovered copy').entries[uid],deleteUid) && await page.evaluate(()=>fixture.writes())===beforeDeleteRecovery);
    await page.evaluate(() => fixture.go({ name:'worlds' })); await page.getByRole('button',{name:'＋ 新建',exact:true}).waitFor();
    await page.evaluate(()=>{fixture.fault('http500');fixture.journalFault('unconfirmed');});
    await page.getByRole('button',{name:'＋ 新建',exact:true}).click(); const newDialog=page.getByRole('dialog',{name:'新建世界书',exact:true});
    await newDialog.getByRole('textbox').fill('Missing new book'); await newDialog.getByRole('button',{name:'新建',exact:true}).click();
    await page.getByRole('button',{name:'检查新建结果',exact:true}).waitFor();
    check('新建书写后日志故障保留查回入口',await page.getByRole('button',{name:'＋ 新建',exact:true}).isDisabled());
    await page.getByRole('button',{name:'检查新建结果',exact:true}).click(); await page.getByRole('status').filter({hasText:'结果还要检查'}).waitFor();
    check('新建书读回缺失仍未知，不因原生resolved释放重试', await page.getByRole('button',{name:'＋ 新建',exact:true}).isDisabled() && await page.evaluate(()=>!fixture.files.has('Missing new book')));
    await endWaiting(page); check('新建书明确按服务器缺失裁定才释放新操作', await page.getByRole('button',{name:'＋ 新建',exact:true}).isEnabled());

    await page.evaluate(() => { fixture.fault(''); fixture.addBook('Decision'); fixture.go({ name: 'world', book: 'Decision' }); });
    await page.locator('.tl-world-open').first().click(); await page.locator('#tl-wi-content').fill('LATE_UI');
    await page.evaluate(() => fixture.fault('never')); await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '检查上次保存', exact: true }).waitFor(); await page.locator('#tl-wi-content').fill('NEW_UI');
    await page.getByRole('button', { name: '结束这次等待，继续编辑', exact: true }).click();
    let decisionDialog = page.getByRole('dialog', { name: '结束等待，继续编辑', exact: true });
    check('裁定弹层展示实际服务器正文与迟到覆盖警告', await decisionDialog.getByRole('textbox', { name: '酒馆里现在的内容' }).inputValue() === 'OLD_UI'
        && (await decisionDialog.innerText()).includes('不会取消刚才的保存') && (await decisionDialog.innerText()).includes('暂停发送'));
    await page.evaluate(() => fixture.journalFault('decision'));
    await decisionDialog.getByRole('button', { name: '按酒馆里现在的内容接着改', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Injected decision persistence failure' }).waitFor();
    check('裁定IDB失败保持保存阻断且输入不丢', await page.getByRole('button', { name: '保存', exact: true }).isDisabled() && await page.locator('#tl-wi-content').inputValue() === 'NEW_UI');
    await page.getByRole('button', { name: '结束这次等待，继续编辑', exact: true }).click();
    decisionDialog = page.getByRole('dialog', { name: '结束等待，继续编辑', exact: true });
    await decisionDialog.getByRole('button', { name: '按酒馆里现在的内容接着改', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '不等了' }).waitFor();
    check('裁定后旧结果仍未知且保留新输入和历史入口', await page.locator('#tl-wi-content').inputValue() === 'NEW_UI'
        && await page.getByRole('button', { name: '保存', exact: true }).isEnabled() && await page.getByRole('button', { name: '再检查一次结果', exact: true }).isVisible());
    await page.evaluate(() => fixture.fault('')); await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已确认存好' }).waitFor();
    const beforeLate = await page.evaluate(() => fixture.writes());
    await page.evaluate(() => fixture.deliver('Decision')); await page.getByRole('button', { name: '把我的版本留作草稿', exact: true }).waitFor();
    check('已确认干净NEW遇服务器LATE仍保留NEW而非自动刷新', await page.locator('#tl-wi-content').inputValue() === 'NEW_UI'
        && await page.evaluate(() => fixture.files.get('Decision').entries[0].content === 'LATE_UI' && fixture.cache.get('Decision').entries[0].content === 'NEW_UI'));
    await page.getByRole('button', { name: '再检查一次结果', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '酒馆里的版本变了' }).waitFor();
    check('旧记录观察不回滚缓存且暂停发送不重发', await page.evaluate(n => { try { fixture.bridge.assertWorldRuntimeReady(); return false; } catch (e) { return e.code === 'WORLD_RUNTIME_UNCONFIRMED' && fixture.writes() === n && fixture.cache.get('Decision').entries[0].content === 'NEW_UI'; } }, beforeLate));
    await page.getByRole('button', { name: '把我的版本留作草稿', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '这几项' }).waitFor();
    check('保留版本成为草稿后要求字段选择且发送仍暂停', await page.locator('#tl-wi-content').inputValue() === 'NEW_UI' && await page.getByRole('button', { name: '保存', exact: true }).isDisabled()
        && await page.evaluate(() => { try { fixture.bridge.assertWorldRuntimeReady(); return false; } catch { return true; } }));
    await page.getByRole('button', { name: '返回', exact: true }).click(); await page.getByRole('button', { name: '放弃草稿，返回', exact: true }).click();
    await page.getByRole('searchbox', { name: '搜索本书条目' }).waitFor();
    check('中途明确放弃草稿仍不解除发送门槛', await page.evaluate(() => { try { fixture.bridge.assertWorldRuntimeReady(); return false; } catch { return true; } }));
    await page.locator('.tl-world-open').first().click(); await page.locator('#tl-wi-content').fill('NEW_UI_RESAVED');
    await page.getByRole('button', { name: '把我的版本留作草稿', exact: true }).click();
    await page.getByRole('button', { name: '保留我的内容', exact: true }).click();
    await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已确认存好' }).waitFor();
    check('新操作保存确认后自动恢复发送且cache等于服务器新版本', await page.evaluate(n => { fixture.bridge.assertWorldRuntimeReady(); return fixture.writes() === n + 1 && fixture.files.get('Decision').entries[0].content === 'NEW_UI_RESAVED' && JSON.stringify(fixture.files.get('Decision')) === JSON.stringify(fixture.cache.get('Decision')); }, beforeLate));
    await page.evaluate(() => fixture.deliver('Decision')); await page.getByRole('button', { name: '用酒馆里的版本，恢复聊天', exact: true }).waitFor();
    await page.getByRole('button', { name: '用酒馆里的版本，恢复聊天', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已按酒馆里的版本检查过' }).waitFor();
    check('另一明确入口按服务器版本恢复发送且不新增保存', await page.evaluate(n => { fixture.bridge.assertWorldRuntimeReady(); return fixture.writes() === n + 1 && fixture.cache.get('Decision').entries[0].content === 'LATE_UI'; }, beforeLate));

    await page.evaluate(() => { fixture.addBook('Early'); fixture.go({ name: 'world', book: 'Early' }); });
    await page.locator('.tl-world-open').first().click(); await page.locator('#tl-wi-content').fill('EARLY_LATE'); await page.evaluate(() => fixture.fault('never'));
    await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('button', { name: '结束这次等待，继续编辑', exact: true }).waitFor();
    await page.locator('#tl-wi-content').fill('EARLY_NEW'); await page.getByRole('button', { name: '结束这次等待，继续编辑', exact: true }).click();
    await page.getByRole('dialog', { name: '结束等待，继续编辑', exact: true }).getByRole('button', { name: '按酒馆里现在的内容接着改', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '不等了' }).waitFor();
    const beforeEarly = await page.evaluate(() => fixture.writes()); await page.evaluate(() => { fixture.fault(''); return fixture.deliver('Early'); });
    await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('status').filter({ hasText: '酒馆里的版本变了' }).waitFor();
    check('裁定后先迟到再首次保存显示冲突且零新写入', await page.locator('#tl-wi-content').inputValue() === 'EARLY_NEW' && await page.evaluate(n => fixture.writes() === n && fixture.files.get('Early').entries[0].content === 'EARLY_LATE', beforeEarly));

    for (const branch of ['historical', 'authority', 'already-confirmed']) {
        await page.evaluate(async mode => { const name='Stale '+mode;await fixture.staleDraft(name,mode==='already-confirmed'?'confirmed':'armed');fixture.go({name:'world',book:name,entry:'0'}); }, branch);
        await page.locator('#tl-wi-content').waitFor();
        if (branch === 'historical') {
            await page.getByRole('button', { name: '检查上次保存', exact: true }).click(); await page.getByRole('status').filter({ hasText: '只检查了上次的保存' }).waitFor();
        } else if (branch === 'authority') {
            await page.getByRole('button', { name: '用酒馆里的版本，恢复聊天', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已按酒馆里的版本检查过' }).waitFor();
        }
        check(`旧本地pending已确认后通过${branch}解除写锁且不覆盖草稿`, await page.getByRole('button', { name: '保存', exact: true }).isEnabled()
            && await page.locator('#tl-wi-content').inputValue() === 'RETAINED_LOCAL' && await page.getByRole('button', { name: '结束这次等待，继续编辑', exact: true }).count() === 0);
    }

    }

    // F7: controlled hook failures in a fresh adapter with a durable unknown operation.
    // This tests the actual component/adapter contract, not a claim that native ST always throws.
    for (const hook of ['emit-error', 'reload-error']) {
        const book = `F7 ${hook}`, content = `FULL expected ${hook}`;
        await page.evaluate(name => { fixture.fault(''); fixture.addBook(name); fixture.go({ name: 'world', book: name, entry: '0' }); }, book);
        await page.locator('#tl-wi-content').fill(content);
        await page.evaluate(() => fixture.fault('unknown')); await page.getByRole('button', { name: '保存', exact: true }).click();
        await page.getByRole('button', { name: '检查上次保存', exact: true }).waitFor();
        const original = await page.evaluate(async name => ({ writes: fixture.writes(), operation: (await fixture.bridge.worldEditorUnfinished()).find(op => op.name === name) }), book);
        check(`${hook} 原提交已落盘但读回未知`, original.operation.stage === 'unconfirmed' && original.writes > 0
            && await page.evaluate(({ name, body }) => fixture.files.get(name).entries[0].content === body, { name: book, body: content }));
        await page.reload(); await page.getByRole('button', { name: '检查上次保存', exact: true }).waitFor();
        check(`${hook} 新文档只加载旧日志时门槛正常且零写入`, await page.evaluate(() => { fixture.bridge.assertWorldRuntimeReady(); return fixture.writes() === 0; }));
        await page.evaluate(value => fixture.fault(value), hook);
        await page.getByRole('button', { name: '检查上次保存', exact: true }).click();
        await page.getByRole('status').filter({ hasText: /已.*保存/ }).waitFor();
        const failed = await page.evaluate(async id => {
            let gate = 'ready'; try { fixture.bridge.assertWorldRuntimeReady(); } catch (error) { gate = error.code; }
            const op = await fixture.bridge.worldEditorOperation(id);
            return { stage: op.stage, runtimeState: op.runtimeState, error: op.error, gate, runtime: fixture.bridge.worldEditorRuntime(), writes: fixture.writes() };
        }, original.operation.operationId);
        check(`${hook} 已保存事实与同步失败分别展示且恢复按钮可见`, failed.stage === 'confirmed' && failed.runtimeState === 'unconfirmed'
            && failed.gate === 'WORLD_RUNTIME_UNCONFIRMED' && failed.writes === 0
            && (await page.getByRole('status').innerText()).includes('runtime-sync error')
            && await page.getByRole('button', { name: '用酒馆里的版本，恢复聊天', exact: true }).isVisible(), failed);
        check(`${hook} 确认后不再显示未知裁定且保留正文`, await page.getByRole('button', { name: '结束这次等待，继续编辑', exact: true }).count() === 0
            && await page.getByRole('button', { name: '检查上次保存', exact: true }).count() === 0 && await page.locator('#tl-wi-content').inputValue() === content);
        await page.screenshot({ path: path.join(output, `f7-${hook}-recovery.png`), fullPage: true });
        await page.evaluate(() => fixture.fault(''));
        await page.getByRole('button', { name: '用酒馆里的版本，恢复聊天', exact: true }).click();
        await page.getByRole('status').filter({ hasText: '已按酒馆里的版本检查过' }).waitFor();
        check(`${hook} 解除故障后真实恢复按钮解锁且不重复写`, await page.evaluate(name => {
            fixture.bridge.assertWorldRuntimeReady(); return fixture.writes() === 0 && JSON.stringify(fixture.files.get(name)) === JSON.stringify(fixture.cache.get(name));
        }, book) && await page.getByRole('button', { name: '用酒馆里的版本，恢复聊天', exact: true }).count() === 0);
    }

    // A save whose answer was lost and that reached the server later: the book page checks it by itself on the next visit.
    await page.evaluate(() => { fixture.fault(''); fixture.addBook('Auto check'); fixture.go({ name: 'world', book: 'Auto check' }); });
    await page.locator('.tl-world-toggle').first().waitFor();
    await page.evaluate(() => fixture.fault('http500'));
    await page.locator('.tl-world-toggle').first().click(); await page.getByRole('button', { name: '检查保存结果', exact: true }).waitFor();
    const autoWrites = await page.evaluate(() => fixture.writes());
    await page.evaluate(() => { fixture.fault(''); fixture.files.set('Auto check', JSON.parse(JSON.stringify(fixture.cache.get('Auto check')))); localStorage.setItem('fixture-files', JSON.stringify([...fixture.files])); });
    await page.reload(); await page.locator('.tl-world-toggle').first().waitFor();
    await page.waitForFunction(() => !document.querySelector('.tl-world-recovery'), null, { timeout: 8000 }).catch(() => {});
    check('书页打开时自动核对上次没核对完的保存，对上了就不再拦着，也不重写', await page.locator('.tl-world-recovery').count() === 0
        && await page.locator('.tl-world-toggle').first().isEnabled() && await page.evaluate(() => fixture.writes()) === 0, { before: autoWrites });

    const disabledContext = await browser.newContext();
    await disabledContext.addInitScript(() => Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get() { throw new DOMException('disabled', 'SecurityError'); } }));
    await disabledContext.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const disabled = await disabledContext.newPage(); await disabled.goto(origin + '/__world-editor'); await disabled.getByRole('searchbox', { name: '搜索本书条目' }).waitFor();
    check('IDB getter禁用时世界书仍可阅读且编辑只读', await disabled.getByRole('button', { name: '＋ 新条目', exact: true }).isDisabled() && (await disabled.locator('.tl-error').innerText()).includes('只能看'));
    check('IDB禁用的全新页面普通聊天同步门槛不依赖存储', await disabled.evaluate(() => { fixture.bridge.assertWorldRuntimeReady(); return fixture.writes() === 0; }));
    await disabledContext.close();
    check('结束等待的说明不露条目编号和原始数据', internalSeen.length === 0, internalSeen);
    check('全部写入路径没有外部请求', external.length === 0);
    await page.screenshot({ path: path.join(output, 'world-book.png'), fullPage: true });
    check('页面无运行异常', errors.length === 0, errors);
} catch (error) { fatal = { message: error.message, stack: error.stack }; console.error(error.stack); await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally { await browser?.close(); await server.close(); await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ pass: !fatal && checks.every(x => x.pass), checks, errors, external, fatal,
    unverified: ['Real ST integration is separate', 'Synthetic composition event is not a real IME test', 'Real phone keyboard and novice usability are not tested'] }, null, 2));
    console.log(JSON.stringify({ passed: checks.filter(x => x.pass).length, total: checks.length, output })); if (fatal || checks.some(x => !x.pass)) process.exitCode = 1; }

