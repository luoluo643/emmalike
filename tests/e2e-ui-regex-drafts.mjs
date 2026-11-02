// Real editor + Preact lifecycle, synthetic bridge. Only loopback traffic; no ST data or model calls.
import { createServer } from 'vite';
import preact from '@preact/preset-vite';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const repo = fileURLToPath(new URL('..', import.meta.url));
const output = path.resolve(process.env.TEST_OUTPUT || '/tmp/regex-draft-ui');
await fs.mkdir(output, { recursive: true });
const checks = [], errors = [], external = [];
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
import {h,render} from 'preact';
import {RegexEditor} from '/regex-editor.jsx';
import {normalizeScript} from '/regex-model.js';
import '/styles.css';
const root=document.getElementById('root');
const seed={...normalizeScript({scriptName:'测试正则',findRegex:'/a/g',replaceString:'saved',placement:[2],markdownOnly:true}),id:'shared'};
const stateFor=(name,account='test')=>({account,owner:{preset:'openai:'+name,scoped:'cat.png'},groups:[
 {type:'global',canEdit:true,allowed:true,scripts:[{...seed}]},
 {type:'preset',owner:name,canEdit:true,allowed:true,scripts:[{...seed}]},
 {type:'scoped',owner:'cat',canEdit:true,allowed:true,scripts:[{...seed}]}],combos:[]});
let props,resolveSave,rejectSave,submitted;
const bridge={regexEditorState:()=>props.state,regexTest:({text})=>({output:text}),regexSave:async request=>{
 submitted=request; await new Promise((resolve,reject)=>{resolveSave=resolve;rejectSave=reject;});
 const state=structuredClone(props.state),id=request.id||request.newId;
 const group=state.groups.find(g=>g.type===request.group),saved={...request.script,id};
 const index=group.scripts.findIndex(s=>s.id===id); if(index<0)group.scripts.push(saved);else group.scripts[index]=saved;
 return {state,id};
}};
const draw=()=>render(h('div',{class:'tl-app'},h(RegexEditor,{...props,bridge,notify:()=>{},setState:state=>{props.state=state;draw();}})),root);
window.fixture={
 mount(name='A',group='preset',id='shared',account='test'){props={state:stateFor(name,account),group,id};draw();},
 switch(name){props.state=stateFor(name,props.state.account);draw();},
 unmount(){render(null,root);},
 input(text){const el=root.querySelector('#tl-rx-replace');el.value=text;el.dispatchEvent(new Event('input',{bubbles:true}));},
 async inputAndLeave(text){this.input(text);await Promise.resolve();await Promise.resolve();this.unmount();},
 release(){resolveSave();},fail(){rejectSave(new Error('保存失败'));},get submitted(){return submitted;},
 get pending(){return !!resolveSave;},
};
addEventListener('tl-route',()=>fixture.unmount());
fixture.mount();
</script>`;
const server = await createServer({ configFile: false, root: path.join(repo,'src'), cacheDir:path.join(repo,'.vite-regex-drafts'),
 define:{__APP_VERSION__:JSON.stringify('regex-draft-test')},logLevel:'error',server:{host:'127.0.0.1',port:0,fs:{allow:[repo]}},
 plugins:[{name:'expose-editor-for-test',enforce:'pre',transform(code,id){if(id.split('?')[0]===path.join(repo,'src/regex-editor.jsx'))return code+'\nexport { RegexEditor };';}},preact(),{
 name:'regex-draft-fixture',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{if(req.url?.split('?')[0]!=='/__regex-drafts')return next();res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__regex-drafts',html));});}}]});
let browser,page;
const check=async(name,expected)=>{const actual=await page.locator('#tl-rx-replace').inputValue();const pass=actual===expected;checks.push({name,pass,actual,expected});console.log(pass?'PASS':'FAIL',name,pass?'':JSON.stringify({actual,expected}));};
try {
 await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin||u.pathname.startsWith('/api/')){external.push(u.href);return route.abort();}return route.continue();});
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
 const reset=async()=>{await page.goto(origin+'/__regex-drafts');await page.locator('#tl-rx-replace').waitFor();await page.waitForTimeout(180);};
 const mount=async(name='A',group='preset',id='shared',account='test')=>{await page.evaluate(v=>fixture.mount(...v),[name,group,id,account]);await page.locator('#tl-rx-replace').waitFor();};

 await reset();await page.evaluate(()=>fixture.inputAndLeave('typed then immediately left'));await mount();
 await check('input survives unmount before passive effects','typed then immediately left');

 await reset();await page.locator('#tl-rx-replace').fill('A initial draft');await page.waitForTimeout(180);
 await page.evaluate(()=>fixture.switch('B'));await page.locator('.tl-error').waitFor();
 await page.locator('#tl-rx-replace').fill('A draft continued while B active');await page.waitForTimeout(180);
 await page.evaluate(()=>fixture.unmount());await mount('B');await check('continued A draft never belongs to B','saved');
 await page.evaluate(()=>fixture.unmount());await mount('A');await check('A recovers the latest continued draft','A draft continued while B active');

 await reset();await page.evaluate(()=>{fixture.input('kept before save');});
 await page.locator('.tl-regex-editor-actions .tl-primary').click();
 await page.waitForFunction(()=>fixture.pending);
 await page.evaluate(()=>{fixture.input('typed at save completion');fixture.release();});
 await page.locator('.tl-regex-status').filter({hasText:'之后写的还没存'}).waitFor();
 await check('save acknowledgement preserves input from same turn','typed at save completion');
 await page.evaluate(()=>fixture.unmount());await mount();await check('post-save draft survives reopening','typed at save completion');

 await reset();await page.locator('#tl-rx-replace').fill('failed save draft');
 await page.locator('.tl-regex-editor-actions .tl-primary').click();await page.waitForFunction(()=>fixture.pending);await page.evaluate(()=>fixture.fail());
 await page.locator('.tl-regex-status').filter({hasText:'保存失败'}).waitFor();await page.evaluate(()=>fixture.unmount());await mount();await check('failed save retains draft','failed save draft');

 await reset();await page.locator('#tl-rx-replace').fill('will discard');await page.waitForTimeout(180);
 await page.getByRole('button',{name:'返回',exact:true}).click();await page.getByRole('button',{name:'放弃改动，返回',exact:true}).click();
 await page.evaluate(()=>fixture.unmount());await mount();await check('explicit discard does not resurrect draft','saved');

 await reset();await page.locator('#tl-rx-replace').fill('confirmed save');await page.locator('.tl-regex-editor-actions .tl-primary').click();
 await page.waitForFunction(()=>fixture.pending);await page.evaluate(()=>fixture.release());await page.locator('.tl-regex-status').filter({hasText:'已保存'}).waitFor();
 await page.evaluate(()=>fixture.unmount());await mount();await check('completed save clears draft cache','saved');

 await reset();await page.evaluate(()=>fixture.inputAndLeave('account A draft'));await mount('A','preset','shared','other');await check('draft isolated by account','saved');
 await page.evaluate(()=>fixture.unmount());await mount();await check('original account restores its draft','account A draft');

 await reset();await page.evaluate(()=>fixture.unmount());await mount('A','preset','new');
 await page.getByLabel('名字').fill('unsaved new rule');await page.getByRole('radio',{name:'全局',exact:true}).click();
 await page.evaluate(()=>fixture.inputAndLeave('new draft'));await mount('A','preset','new');await check('new rule draft survives rapid departure','new draft');
 const target=await page.getByRole('radio',{name:'全局',exact:true}).getAttribute('aria-checked');checks.push({name:'new rule target retained',pass:target==='true',actual:target});
 await page.screenshot({path:path.join(output,'draft-restored.png')});
} catch(error){checks.push({name:'completed all scenarios',pass:false,error:String(error.stack)});console.error(error);}
finally {
 checks.push({name:'no page errors',pass:errors.length===0,errors},{name:'no external or production requests',pass:external.length===0,external});
 await fs.writeFile(path.join(output,'results.json'),JSON.stringify(checks,null,2));
 console.log(JSON.stringify({passed:checks.filter(c=>c.pass).length,total:checks.length,failed:checks.filter(c=>!c.pass)},null,2));
 await browser?.close();await server.close();
}
process.exit(checks.some(c=>!c.pass)?1:0);
