// Real episode UI, synthetic bridge only; this does not claim native ST transaction validation.
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
const output = path.resolve(process.env.TEST_OUTPUT || path.join(repo, '..', 'ui-episodes-results'));
await fs.mkdir(output, { recursive: true });
const results = [], errors = [], externalRequests = [];
const check = (name, ok, detail = null) => { results.push({ name, pass: !!ok, detail }); assert.ok(ok, name); console.log('PASS', name); };
const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
import { h, render } from 'preact';
import { useRef, useState } from 'preact/hooks';
import '/styles.css';
import { EpisodeRenameSheet, EpisodesSheet, storyIdentityLabel } from '/episodes.jsx';
import { storyKey } from '/story-state.js';
const account='episode-ui-qa', avatar='fixture.png', root={account,avatar,file:'source'};
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const meta=(n,title,extra={})=>({schemaVersion:1,ownerAccount:account,episodeId:id(n),rootId:id(1),parentId:id(1),kind:'side',title,contextMode:'continued',createdAt:'2026-01-01T00:00:00Z',creationOperationId:id(n+100),...extra});
const nodes=[{locator:{account,avatar,file:'child-a'},episode:meta(2,'雨夜',{openingRequest:'去海边看灯塔'}),relationship:'resolved',rootLocator:root},
{locator:{account,avatar,file:'child-b'},episode:meta(3,'雨夜',{openingRequest:'花园的约定'}),relationship:'resolved',rootLocator:root}];
const graph={nodes,roots:[{locator:root}],ordinaryChats:[{locator:root},{locator:{account,avatar,file:'other'}}],invalid:[],complete:true,entries:[]};
let status={enabled:true,verified:true,reasons:[],contextModes:['continued','fresh']}, operations=[], current=root;
const calls=[];window.calls=calls;window.fixtureGraph=graph;
let pendingResolve,pendingReject,report;
const makeOp=(input,continuation=false)=>({account,operationId:id(500+calls.length),stage:'awaiting-review',source:{locator:root},target:{locator:continuation?{account,...input.target}:{account,avatar,file:'new-child'}},capturedText:input.text,draftRevision:input.draftRevision,kind:input.kind||'side',title:input.title||'雨夜',contextMode:input.contextMode||'continued'});
window.fixtureBridge={
 episodeStatus:()=>status,setEpisodeEnabled:value=>(status={...status,enabled:value}),episodeIndex:async()=>graph,unfinishedEpisodes:async()=>operations,currentChat:()=>current,
 prepareEpisode:async input=>{if(!input.assertDraft())throw Error('草稿变了');calls.push(['prepare',input.kind,input.contextMode,input.text]);const op=makeOp(input);operations=[op];return {operation:op,target:op.target.locator,reviewReceipt:'receipt',label:'番外 · '+op.title,contextMode:op.contextMode,carriedMetadataKeys:['ooc_guard','horae_storylines','horae_storyline_migration']};},
 settleEpisodes:async()=>{calls.push(['settle']);return [];},
 dismissEpisode:async input=>{calls.push(['dismiss',input.operationId]);operations=operations.filter(op=>op.operationId!==input.operationId);return {stage:'dismissed'};},
 episodeLiveText:()=>window.liveText||'',
 prepareEpisodeContinuation:async input=>{if(!input.assertDraft())throw Error('草稿变了');calls.push(['continue',input.target.file]);const op=makeOp(input,true);operations=[op];return {operation:op,target:op.target.locator,reviewReceipt:'receipt',label:'番外 · 雨夜',contextMode:op.contextMode};},
 sendEpisode:input=>{if(!input.assertDraft())throw Error('草稿变了');calls.push(['send',input.operationId]);report=input.onState;const promise=new Promise((resolve,reject)=>{pendingResolve=resolve;pendingReject=reject;});promise.cancel=()=>{calls.push(['cancel-job']);pendingReject(Error('已取消'));return true;};return promise;},
 cancelEpisode:async input=>{calls.push(['cancel',input.operationId]);operations=operations.filter(op=>op.operationId!==input.operationId);},
 recoverEpisode:async input=>{calls.push(['recover',input.operationId]);const operation=operations.find(op=>op.operationId===input.operationId);return {kind:'recovered',operation,target:operation.target.locator};},
 reviewRecoveredEpisode:async input=>{if(!input.assertDraft())throw Error('草稿变化');calls.push(['review-recovered']);const operation={...operations.find(op=>op.operationId===input.operationId),stage:'awaiting-review'};operations=[operation];return {operation,target:operation.target.locator,reviewReceipt:'recovered-receipt',label:'番外 · '+operation.title,contextMode:'continued'};},
 confirmEpisodeSave:async input=>{calls.push(['save',input.operationId]);const operation=operations.find(op=>op.operationId===input.operationId);operations=[];return {kind:'confirmed',operation:{...operation,stage:'confirmed'},target:operation.target.locator};},
 openEpisode:async target=>{calls.push(['open',target.file]);current=target;return target;},
 renameEpisode:async input=>{calls.push(['rename',input]);return {kind:calls.filter(x=>x[0]==='rename').length===1?'unconfirmed':'confirmed'};}
};
window.fixture={setStatus:patch=>{status={...status,...patch}},setOperations:value=>{operations=value},getOperations:()=>operations,
 fail:()=>{operations=operations.map(op=>({...op,stage:'save-unconfirmed',saveIntent:{synthetic:true}}));current=operations[0].target.locator;report({stage:'save-unconfirmed',operation:operations[0]});pendingResolve({kind:'unconfirmed',operation:operations[0],target:current});},
 submit:()=>{report({stage:'submitted',operation:operations[0]});},
 accept:()=>{report({stage:'accepted',operation:operations[0]});},
 setCurrent:value=>{current=value;window.fixtureScope=value},
 finish:()=>{const operation={...operations[0],stage:'confirmed'};operations=[];pendingResolve({kind:'confirmed',operation,target:operation.target.locator});},
 reset:()=>{operations=[];calls.length=0;status={...status,enabled:true,verified:true,reasons:[]};current=root},
 draftKey:file=>storyKey('draft',account,avatar,file),
 label:()=>storyIdentityLabel({file_name:'never-title',chat_metadata:{tavern_lite_episode:meta(2,'真实标题')}},'角色',undefined,account)};
function App(){const [open,setOpen]=useState(false),[rename,setRename]=useState(false),[text,setText]=useState('请写一篇番外：雨夜'),[intent,setIntent]=useState(null);const revision=useRef(1),value=useRef(text);
 const change=next=>{revision.current++;value.current=next;setText(next)};
 window.harness={open:next=>{setIntent(next||null);setOpen(true)},rename:()=>{setOpen(false);setRename(true)},change,close:()=>setOpen(false)};
 return h('div',{class:'tl-app'},h('button',{onClick:()=>setOpen(true)},'番外入口'),h('textarea',{id:'draft',value:text,readOnly:true}),
  open&&h(EpisodesSheet,{account,scope:window.fixtureScope||root,characterName:'合成角色',currentTitle:'普通故事 · source',draft:text,draftRevision:revision.current,
   initialIntent:intent,onClose:()=>setOpen(false),
   onCopied:(_,next)=>change(next),onSent:capture=>{if(capture.revision===revision.current&&capture.text===value.current)change('')},notify:()=>{}}),
  rename&&h(EpisodeRenameSheet,{account,avatar,file:'child-a',episode:meta(2,'旧标题'),withBridge:(_,action)=>action(window.fixtureBridge),onClose:()=>setRename(false),onChanged:()=>calls.push(['renamed'])}));}
render(h(App),document.getElementById('root'));
</script></body></html>`;
await transformWithEsbuild(fixture.match(/<script type="module">([\s\S]*?)<\/script>/)[1], 'episode-fixture.jsx', { loader: 'jsx' });
const server = await createServer({ configFile: false, root: path.join(repo, 'src'), cacheDir: path.join(repo, '.vite-ui-episodes'),
    define: { __APP_VERSION__: JSON.stringify('episode-fixture') }, server: { host: '127.0.0.1', port: 0 }, plugins: [
        { name: 'synthetic-engine', enforce: 'pre', transform(_, id) { if (id.replaceAll('\\', '/').endsWith('/src/engine.js')) return 'export const getBridge=()=>window.fixtureBridge; export const onEngine=()=>()=>{}; export const engineState=()=>"ready"; export const isGenerating=()=>false;'; } },
        preact(), { name: 'fixture-html', configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
            if (req.url?.split('?')[0] !== '/__episodes') return next(); res.statusCode = 200; res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__episodes', fixture));
        }); } }],
});
let browser, page;
try {
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    const freshPage = async () => {
      await page?.close();
      page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) { externalRequests.push(url.origin + url.pathname); return route.abort(); }
        if (url.pathname === '/api/users/me') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ handle: 'episode-ui-qa' }) });
        return route.continue();
      });
    };
    const start = async intent => { await freshPage(); await page.goto(origin + '/__episodes'); await page.waitForFunction(() => window.harness); await page.evaluate(intent => window.harness.open(intent), intent); };
    const button = name => page.getByRole('button', { name, exact: true });
    const count = type => page.evaluate(type => calls.filter(x => x[0] === type).length, type);
    await start();
    check('打开面板时先核对上次停在半路的发送', await page.waitForFunction(() => calls.some(x => x[0] === 'settle')).then(() => true));
    check('面板顶上写明现在在哪', await page.getByText('你在：普通故事 · source').isVisible());
    await page.evaluate(() => { fixture.setCurrent({account:'episode-ui-qa',avatar:'fixture.png',file:'child-a'}); harness.close(); });
    await page.evaluate(() => harness.open());
    await page.getByText('你在：番外 · 雨夜').waitFor();
    check('在番外里：回正文在位置旁，当前那条标正在读，没有重复的续写入口', await button('回正文').isVisible()
        && await page.locator('.tl-sheet-item[aria-current="true"]').innerText().then(x => x.includes('番外 · 雨夜') && x.includes('去海边看灯塔'))
        && await page.locator('.tl-sheet-item[aria-current="true"]').isDisabled()
        && await page.getByRole('button', { name: /续写|接着写这条线/ }).count() === 0);
    await page.screenshot({ path: path.join(output, 'list-in-line-mobile.png') });
    await page.evaluate(() => {
        fixture.setCurrent({account:'episode-ui-qa',avatar:'fixture.png',file:'source'});
        fixture.setOperations([{account:'episode-ui-qa',operationId:'stuck-op',stage:'generated',source:{locator:{account:'episode-ui-qa',avatar:'fixture.png',file:'source'}},target:{locator:{account:'episode-ui-qa',avatar:'fixture.png',file:'child-a'}},kind:'parallel',title:'meta',capturedText:'暂停剧情'}]);
        harness.close();
    });
    await page.evaluate(() => harness.open());
    await page.getByRole('heading', { name: '需要你看一下' }).waitFor();
    await page.screenshot({ path: path.join(output, 'list-attention-mobile.png'), fullPage: true });
    check('需要看的记录排在最前', await page.locator('.tl-episode-section h3').first().innerText() === '需要你看一下');
    await button('移出').click();
    await page.waitForFunction(() => !document.querySelector('.tl-episode-attention'));
    check('移出只动记录不发送', await count('dismiss') === 1 && await count('send') === 0);
    await page.evaluate(() => harness.close()); await page.evaluate(() => harness.open());
    await page.locator('.tl-episode-tree [data-depth="1"]').nth(1).waitFor();
    check('正文在上、两条线挂在下面，各有打开按钮；只有两条时不显示搜索框', await page.locator('.tl-episode-tree .tl-episode-list-row').count() === 3
        && (await page.locator('.tl-episode-tree .tl-episode-list-row').first().innerText()).startsWith('正文')
        && await page.locator('.tl-episode-tree [data-depth="1"]').getByRole('button', { name: '打开', exact: true }).count() === 2
        && await page.getByLabel('搜索标题').count() === 0);
    check('线的说明来自 metadata 的开场要求', await page.getByRole('button', { name: /番外 · 雨夜.*灯塔/ }).count() === 1 && await page.getByRole('button', { name: /番外 · 雨夜.*花园的约定/ }).count() === 1);
    check('标题来自metadata而不是文件名', await page.evaluate(() => fixture.label()) === '番外 · 真实标题');
    await button('＋ 新开番外 / 平行线 / 小剧场').click();
    check('新开时要求框不搬输入框里的字', await page.getByLabel('开场或续写要求').inputValue() === '');
    await button('用输入框里写的').click();
    check('点了才把输入框里的放进来，标题跟着要求', await page.getByLabel('开场或续写要求').inputValue() === '请写一篇番外：雨夜'
        && await page.getByLabel('标题', { exact: true }).inputValue() === '请写一篇番外：雨夜' && await page.locator('#draft').inputValue() === '请写一篇番外：雨夜');
    await page.getByRole('radio', { name: '不复制正文', exact: true }).click();
    await button('下一步：确认发送').click();
    await page.getByRole('dialog', { name: '确认发送' }).waitFor();
    check('准备仅创建review未发送', await count('prepare') === 1 && await count('send') === 0);
    check('目的地和背景可见', await page.getByText('发到：番外 · 请写一篇番外：雨夜', { exact: true }).isVisible() && await page.getByText(/没带正文消息/).isVisible());
    const review = await page.getByRole('dialog', { name: '确认发送' }).innerText();
    check('确认页不露文件名与扩展存储名', !/new-child|ooc_guard|horae_storyline/.test(review), review);
    await page.getByText('详细', { exact: true }).click();
    check('带过去的扩展记录用人话说', await page.getByText('一起带过去的扩展记录：人设守护、Horae 记忆与故事线').isVisible());
    await page.screenshot({ path: path.join(output, 'review-mobile.png') });
    await button('发送').dblclick();
    check('双击只提交一次', await count('send') === 1);
    await page.evaluate(() => fixture.submit()); await page.keyboard.press('Escape');
    check('已提交期Escape保持发送进度', await page.getByRole('dialog', { name: '正在发送' }).isVisible());
    check('发出后不能再取消且说明原因', await button('已发出，撤不回').isDisabled());
    await page.evaluate(() => { window.liveText = '<!-- Gemini: ok --><thinking>先想想</thinking><p>他推开门，雨还在下</p>'; fixture.accept(); });
    await page.locator('.tl-episode-live').waitFor({ timeout: 4000 });
    check('AI 写的时候显示进度、计时和正在写的字（去掉标签与思考）', await page.locator('.tl-episode-steps li[data-state="now"]').innerText().then(x => x.includes('AI 写 · 已等'))
        && await page.locator('.tl-episode-live').innerText().then(x => x.endsWith('他推开门，雨还在下') && !/thinking|先想想|Gemini/.test(x)));
    await page.screenshot({ path: path.join(output, 'sending-mobile.png') });
    await page.evaluate(() => fixture.fail()); await page.getByRole('dialog', { name: '需要看一下' }).waitFor();
    await button('再检查一次').click();
    check('失败查验不重复发送', await count('send') === 1 && await count('recover') === 1);
    await button('补存').click();
    await page.getByText('已保存', { exact: true }).waitFor();
    check('保存恢复不重新生成', await count('send') === 1 && await count('save') === 1);
    await page.getByRole('dialog', { name: '需要看一下' }).getByRole('button', { name: '关闭', exact: true }).click();
    await page.waitForFunction(() => location.hash.includes('new-child'));
    check('关闭恢复页对齐引擎实际目标而不冒充来源', await count('open') === 1 && await count('send') === 1);
    await start({ action: 'create', kind: 'parallel', title: '换世界', contextMode: null, historical: true });
    check('不明确背景必须选择', await button('下一步：确认发送').isDisabled());
    check('历史状态不提供假回溯入口', await page.getByText(/没法回到过去某一刻的状态/).isVisible());
    await page.getByRole('radio', { name: '接续正文最新进度', exact: true }).click(); await button('下一步：确认发送').click();
    await page.getByRole('dialog', { name: '确认发送' }).waitFor();
    // The request is the sheet's own: what is typed in the story's input box after the review does not change it.
    await page.evaluate(() => harness.change('新的草稿，不能被旧请求清除'));
    await button('发送').click();
    check('确认后正文输入框再改不挡发送，发的是确认过的那句', await count('send') === 1 && await page.evaluate(() => calls.find(x => x[0] === 'prepare')[3]) === '请写一篇番外：雨夜');
    await page.evaluate(() => fixture.finish()); await page.waitForFunction(() => location.hash.includes('new-child'));
    check('发出后输入框里后来写的不被清掉', await page.locator('#draft').inputValue() === '新的草稿，不能被旧请求清除');
    await start({ action: 'create', kind: 'side', title: '从输入框来的', contextMode: 'continued' });
    check('输入框里的话打开的面板，要求就是那句', await page.getByLabel('开场或续写要求').inputValue() === '请写一篇番外：雨夜');
    await page.getByLabel('开场或续写要求').fill('请写一篇番外：雨夜，改一下');
    check('在面板里改要求不动输入框', await page.locator('#draft').inputValue() === '请写一篇番外：雨夜');
    await button('下一步：确认发送').click(); await page.getByRole('dialog', { name: '确认发送' }).waitFor();
    await button('发送').click(); await page.evaluate(() => fixture.finish()); await page.waitForFunction(() => location.hash.includes('new-child'));
    check('从输入框发起的请求发出后，输入框里那句清掉，不会再发进正文', await page.locator('#draft').inputValue() === '');
    await start();
    await button('＋ 新开番外 / 平行线 / 小剧场').click();
    await page.getByLabel('类型').selectOption('parallel');
    await page.getByLabel('标题', { exact: true }).fill('需要保留的平行线标题');
    await page.getByRole('radio', { name: '不复制正文', exact: true }).click();
    await page.getByLabel('开场或续写要求').fill('另一个世界的草稿B：我们走进雨里。');
    await page.evaluate(() => harness.close());
    check('关掉面板，输入框还是原来那句', await page.locator('#draft').inputValue() === '请写一篇番外：雨夜');
    await page.evaluate(() => harness.open()); await button('＋ 新开番外 / 平行线 / 小剧场').click();
    check('再打开，类型、标题、带不带正文和要求都还在', await page.getByLabel('类型').inputValue() === 'parallel'
        && await page.getByLabel('标题', { exact: true }).inputValue() === '需要保留的平行线标题'
        && await page.getByRole('radio', { name: '不复制正文', exact: true }).getAttribute('aria-checked') === 'true'
        && await page.getByLabel('开场或续写要求').inputValue() === '另一个世界的草稿B：我们走进雨里。'
        && await page.getByText(/上次在这里写的还在/).isVisible());
    await page.screenshot({ path: path.join(output, 'form-kept-mobile.png') });
    await start({ action: 'continue', title: '雨夜' });
    await page.getByRole('radiogroup', { name: '接着写哪条' }).waitFor();
    check('同名目标不自动选择或新建', await button('下一步：确认发送').isDisabled() && await count('prepare') === 0);
    await page.getByRole('radio', { name: '番外 · 雨夜', exact: true }).nth(1).click(); await button('下一步：确认发送').click();
    await page.getByRole('dialog', { name: '确认发送' }).waitFor();
    check('续写使用选定已有目标', await count('continue') === 1 && await count('prepare') === 0 && await page.evaluate(() => calls.find(x => x[0] === 'continue')[1]) === 'child-b');
    await button('先不发').click();
    await start();
    await page.evaluate(() => { fixture.setStatus({ verified: false, reasons: ['合成未知扩展'] }); harness.close(); });
    await page.evaluate(() => harness.open());
    check('未验证配置禁止新建', await button('＋ 新开番外 / 平行线 / 小剧场').isDisabled());
    check('不能新开时就地说明去哪看原因', await page.getByText('现在不能分开写，原因在下面「更多」里').isVisible());
    await page.getByText('更多', { exact: true }).click();
    await page.getByLabel('分开写番外与平行线').uncheck();
    check('总开关真实保存且已有列表仍可见', await page.evaluate(() => !fixtureBridge.episodeStatus().enabled) && await page.locator('.tl-episode-tree').isVisible());
    await page.evaluate(() => {
        const operation={account:'episode-ui-qa',operationId:'recover-op',stage:'awaiting-review',source:{locator:{account:'episode-ui-qa',avatar:'fixture.png',file:'source'}},target:{locator:{account:'episode-ui-qa',avatar:'fixture.png',file:'child-a'}},kind:'side',title:'待恢复请求',capturedText:'只复制作者请求'};
        fixture.setOperations([operation]); localStorage.setItem(fixture.draftKey('source'),JSON.stringify('原有草稿')); harness.close();
    });
    await page.evaluate(() => harness.open()); await page.getByRole('button', { name: /番外 · 待恢复请求/ }).click();
    await button('取消，把文字放回原来的输入框').click();
    await page.waitForFunction(() => document.querySelector('#draft').value === '原有草稿\n\n只复制作者请求').catch(async error => {
        throw new Error(error.message + ' diagnostic=' + JSON.stringify(await page.evaluate(() => ({ draft:document.querySelector('#draft').value,stored:localStorage.getItem(fixture.draftKey('source')),calls }))));
    });
    check('关闭增强仍可恢复草稿且追加不覆盖', await page.locator('#draft').inputValue() === '原有草稿\n\n只复制作者请求' && await count('send') === 0);
    await button('把请求放进别的故事').click();
    await page.evaluate(() => localStorage.setItem(fixture.draftKey('other'),JSON.stringify('目标已有草稿')));
    await button('普通故事 · other').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem(fixture.draftKey('other'))) === '目标已有草稿\n\n只复制作者请求');
    check('纠正目的地只追加请求不复制结果不发送', await page.evaluate(() => JSON.parse(localStorage.getItem(fixture.draftKey('other')))) === '目标已有草稿\n\n只复制作者请求' && await count('send') === 0);
    await button('把请求放进别的故事').click();
    await page.evaluate(() => { window.savedSetItem=Storage.prototype.setItem; Storage.prototype.setItem=function(){throw Error('合成配额不足')}; });
    await button('普通故事 · other').click();
    check('草稿写入失败可见且不假报复制', await page.getByRole('alert').textContent().then(x => x.includes('合成配额不足')) && await page.getByRole('heading', { name: '把请求放进别的故事' }).isVisible());
    await page.evaluate(() => { Storage.prototype.setItem=window.savedSetItem; });
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: path.join(output, 'recovery-desktop.png') });
    await start(); await page.evaluate(() => harness.rename());
    await page.getByLabel('标题', { exact: true }).fill('新的子线标题'); await button('保存标题').click();
    check('标题未确认时不假报成功且锁定原修改', await page.getByLabel('标题', { exact: true }).isDisabled() && await count('renamed') === 0);
    await button('检查一下').click(); await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    check('标题查验携带旧标题防并发覆盖', await count('renamed') === 1 && await page.evaluate(() => calls.filter(x=>x[0]==='rename').every(x=>x[1].expectedTitle==='旧标题'&&x[1].title==='新的子线标题')));
    await start(); await page.evaluate(() => {
        fixture.setOperations([{account:'episode-ui-qa',operationId:'recover-created',stage:'created',source:{locator:{account:'episode-ui-qa',avatar:'fixture.png',file:'source'}},target:{locator:{account:'episode-ui-qa',avatar:'fixture.png',file:'child-a'}},kind:'side',title:'中断的新建',capturedText:'记录中的原请求',draftRevision:1}]);
        harness.change('后来写的新草稿'); harness.close();
    });
    await page.evaluate(() => harness.open()); await page.getByRole('button', { name: /番外 · 中断的新建/ }).click();
    await button('重新确认发送').click(); await page.getByRole('dialog', { name: '确认发送' }).waitFor();
    check('恢复后显式重查review仍未创建或生成', await count('review-recovered') === 1 && await count('prepare') === 0 && await count('send') === 0 && await page.getByText('记录中的原请求', { exact: true }).isVisible());
    await button('发送').click(); await page.evaluate(() => fixture.finish());
    await page.waitForFunction(() => location.hash.includes('child-a'));
    check('恢复旧请求成功保留后来新草稿', await page.locator('#draft').inputValue() === '后来写的新草稿' && await count('send') === 1);
    check('无浏览器JS异常', errors.length === 0, errors); check('无外部请求', externalRequests.length === 0, externalRequests);
} catch (error) {
    results.push({ name: 'test failure', pass: false, detail: error.stack });
    if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(output, 'failure.html'), await page.content().catch(() => '')); }
    process.exitCode = 1; console.error(error);
} finally {
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ scope: 'Actual Preact episode UI; synthetic bridge. Not native ST or plugin isolation validation.', results, errors, externalRequests }, null, 2));
    await browser?.close(); await server.close();
}
