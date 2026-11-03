// Component regressions with the real controls, modal history and Canvas renderer.
// Only the SillyTavern engine and remote font responses are fixtures; no account or production server is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const root = fileURLToPath(new URL('../', import.meta.url));
const entry = `
import {h,render} from 'preact';
import {useState} from 'preact/hooks';
import {ReadingSheet} from './src/appearance.jsx';
import {ExportSheet} from './src/export.jsx';
import {selectedPassage} from './src/share-dom.js';
import * as theme from './src/theme.js';
window.theme=theme;window.selectedPassage=selectedPassage;theme.setAppearanceAccount('share-regression');
window.saved={};window.notices=[];window.downloads=[];window.drawn=[];window.fontRequests=[];
window.bridge={extensionSettings:()=>saved,saveSettings:()=>{},snapshot:()=>({total:2,messages:[
{index:0,name:'阿青',is_user:true,html:'你好',mes:'你好'},
{index:1,name:'角色',is_user:false,html:'<p>阿<strong>青</strong>，<q>慢慢来。</q></p>',mes:'阿青，慢慢来。'}]})};
window.fetch=()=>new Promise(resolve=>fontRequests.push(()=>resolve({ok:true,text:async()=> '@font-face {font-family: Audit;src:url(https://fonts.invalid/a.woff2)}'})));
const fill=CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText=function(text,...args){drawn.push({text,font:this.font});return fill.call(this,text,...args)};
HTMLAnchorElement.prototype.click=function(){downloads.push(this.download)};
Object.defineProperty(navigator,'canShare',{value:()=>false});
function App(){const[kind,setKind]=useState('');window.openKind=setKind;return h('main',{class:'tl-app'},
 kind==='reading'?h(ReadingSheet,{onClose:()=>setKind('')}):kind==='export'?h(ExportSheet,{character:{name:'角色'},chapterTitle:'故事',notify:t=>notices.push(t),onClose:()=>setKind('')}):null)}
render(h(App),document.getElementById('app'));
`;
const engine = `export const getBridge=()=>window.bridge,requestEngine=()=>{},engineState=()=> 'ready',isGenerating=()=>false,engineProgress=()=>({phase:'ready'}),engineMode=()=> 'auto',onEngine=()=>()=>{},engineFailure=()=>'',startEngine=()=>{},loadingText=()=>'',ENGINE_MODES={},LOGIN_FAILURE='';`;
const bundle = await build({stdin:{contents:entry,loader:'jsx',resolveDir:root},bundle:true,write:false,format:'iife',jsx:'automatic',jsxImportSource:'preact',plugins:[{name:'engine-fixture',setup(b){b.onResolve({filter:/\/engine\.js$/},()=>({path:'engine',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:engine,loader:'js'}));}}]});
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH,args:['--no-sandbox']});
const page = await browser.newPage({viewport:{width:390,height:844},hasTouch:true});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const checks=[];const ok=name=>checks.push(name);
try {
 await page.route('https://audit.invalid/',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<div id="app"></div><div class="tl-message-body"><q>慢慢来。</q></div>'}));
 await page.route('https://fonts.invalid/**',r=>r.fulfill({contentType:'text/css',body:''}));
 await page.goto('https://audit.invalid/');
 await page.addStyleTag({content:await readFile(new URL('../src/styles.css',import.meta.url),'utf8')});
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 const sheet=title=>page.getByRole('dialog',{name:title,exact:true});
 const open=async kind=>{await page.waitForFunction(()=>!history.state?.tlLayer);await page.evaluate(kind=>openKind(kind),kind);};
 const close=async title=>{await sheet(title).getByRole('button',{name:'关闭',exact:true}).click();await sheet(title).waitFor({state:'detached'});await page.waitForFunction(()=>!history.state?.tlLayer);};
 const fonts=async()=>{await open('reading');await sheet('阅读设置').getByRole('button',{name:'更多排版',exact:true}).click();};
 const addLink=async()=>{await sheet('阅读设置').getByRole('button',{name:'填字体网址',exact:true}).click();await page.getByLabel('字体网址',{exact:true}).fill('https://fonts.invalid/site.css');await page.getByRole('button',{name:'添加这个字体',exact:true}).click();await page.waitForFunction(()=>fontRequests.length===1);};
 await fonts();await addLink();await close('阅读设置');await fonts();await sheet('阅读设置').getByRole('radio',{name:'宋体',exact:true}).click();await page.waitForFunction(()=>theme.cachedReading().font==='serif');await page.evaluate(()=>fontRequests.shift()());await page.waitForTimeout(500);
 assert.deepEqual(await page.evaluate(()=>({font:theme.cachedReading().font,count:theme.cachedFonts().length})),{font:'serif',count:0});
 assert.equal(await sheet('阅读设置').getByRole('radio',{name:'宋体',exact:true}).getAttribute('aria-checked'),'true');ok('late response after closing cannot change selection or save a font');
 for(let i=0;i<2;i++){await addLink();await page.evaluate(()=>fontRequests.shift()());await sheet('阅读设置').getByRole('button',{name:'删除字体「Audit」',exact:true}).waitFor();}
 assert.equal(await page.evaluate(()=>theme.cachedFonts().length),1);ok('same URL reuses one font choice');
 await sheet('阅读设置').getByRole('button',{name:'删除字体「Audit」',exact:true}).click();assert((await sheet('阅读设置').innerText()).includes('也会影响其他使用它的主题'));await sheet('阅读设置').getByRole('button',{name:'取消',exact:true}).click();
 await addLink();await sheet('阅读设置').getByRole('radio',{name:'宋体',exact:true}).click();await page.evaluate(()=>fontRequests.shift()());await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>theme.cachedReading().font),'serif');ok('changing the font in place cancels a pending selection');await close('阅读设置');
 const selected=await page.evaluate(()=>{const node=document.querySelector('.tl-message-body q').firstChild;const r=document.createRange();r.setStart(node,0);r.setEnd(node,3);getSelection().removeAllRanges();getSelection().addRange(r);return selectedPassage(getSelection());});
 assert.deepEqual(selected,{text:'慢慢来',html:'<q>慢慢来</q>'});ok('partial dialogue keeps its q semantics');
 const nested=await page.evaluate(()=>{const el=document.querySelector('.tl-message-body');el.innerHTML='<em><strong>abc</strong>def</em>';const r=document.createRange();r.setStart(el.querySelector('strong').firstChild,1);r.setEnd(el.querySelector('em').lastChild,2);getSelection().removeAllRanges();getSelection().addRange(r);return selectedPassage(getSelection());});
 assert.deepEqual(nested,{text:'bcde',html:'<em><strong>bc</strong>de</em>'});ok('nested and multi-node partial selection keeps only needed wrappers');
 await page.evaluate(()=>{window.originalFonts=document.fonts;window.fontWait=[];Object.defineProperty(document,'fonts',{configurable:true,value:{load:()=>new Promise(resolve=>fontWait.push(resolve)),ready:Promise.resolve()}});});
 for(const method of ['close','escape','back','backdrop']) {
  await page.evaluate(()=>{downloads.length=0;notices.length=0;});await open('export');await sheet('分享').getByRole('button',{name:/^长图/}).click();await page.waitForFunction(()=>fontWait.length===2);
  assert(await sheet('分享').getByRole('switch',{name:/^隐藏我的名字/}).isDisabled());
  if(method==='close')await close('分享');
  else if(method==='escape')await page.keyboard.press('Escape');
  else if(method==='back'){await page.waitForFunction(()=>!!history.state?.tlLayer);await page.evaluate(()=>history.back());}
  else await page.locator('.tl-sheet-backdrop').click({position:{x:2,y:2}});
  await sheet('分享').waitFor({state:'detached'});await page.waitForFunction(()=>!history.state?.tlLayer);await open('export');
  await page.evaluate(()=>{fontWait.splice(0).forEach(resolve=>resolve([]));});await page.waitForTimeout(80);
  assert.equal(await sheet('分享').count(),1);assert.equal(await page.evaluate(()=>downloads.length),0);assert.equal(await page.evaluate(()=>notices.length),0);ok(method+' cancels old export without closing the new sheet');await close('分享');
 }
 await open('export');await sheet('分享').getByRole('switch',{name:/^隐藏我的名字/}).click();await sheet('分享').getByRole('switch',{name:/^长图用主题配色/}).click();await sheet('分享').getByRole('button',{name:/^长图/}).evaluate(button=>{button.click();button.click()});await page.waitForFunction(()=>fontWait.length===3);await page.evaluate(()=>fontWait.splice(0).forEach(resolve=>resolve([])));await page.waitForFunction(()=>downloads.length===1);await sheet('分享').waitFor({state:'detached'});
 const drawn=await page.evaluate(()=>drawn.map(x=>x.text).join(''));assert(!drawn.includes('阿青'));assert(drawn.includes('■■'));assert.equal(await page.evaluate(()=>downloads.length),1);ok('themed Canvas hides cross-style names and immediate double click delivers once');
 // A cancelled render must also stop at the asynchronous Canvas boundary, not just during fonts.
 await page.evaluate(()=>{downloads.length=0;notices.length=0;window.pngWait=[];window.blob=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(callback,...args){blob.call(this,result=>pngWait.push(()=>callback(result)),...args)};Object.defineProperty(document,'fonts',{configurable:true,value:{load:()=>Promise.resolve([]),ready:Promise.resolve()}});});
 await open('export');await sheet('分享').getByRole('button',{name:/^长图/}).click();await page.waitForFunction(()=>pngWait.length===1);await close('分享');await open('export');await page.evaluate(()=>{pngWait.splice(0).forEach(done=>done());HTMLCanvasElement.prototype.toBlob=blob;});await page.waitForTimeout(80);assert.equal(await page.evaluate(()=>downloads.length),0);assert.equal(await page.evaluate(()=>notices.length),0);assert.equal(await sheet('分享').count(),1);await close('分享');ok('closing during Canvas encoding prevents late delivery');
 // Exercise the production 15-second deadline with accelerated timer scheduling, not a changed helper argument.
 await page.evaluate(()=>{window.timer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timer(fn,ms===15000?30:ms,...args);Object.defineProperty(document,'fonts',{configurable:true,value:{load:()=>Promise.resolve([]),ready:new Promise(()=>{})}});drawn.length=0;downloads.length=0;notices.length=0;});
 await open('export');await sheet('分享').getByRole('button',{name:/^长图/}).click();await page.waitForFunction(()=>downloads.length===1);
 assert((await page.evaluate(()=>notices.join(''))).includes('系统字体'));assert((await page.evaluate(()=>drawn)).every(x=>x.font.includes('system-ui')));ok('pending ready falls back to system font and still delivers');
 // Layout and empty-content regressions for the combined share/menu changes.
 await page.waitForFunction(()=>!document.querySelector('[role="dialog"]'));
 await page.waitForFunction(()=>!history.state?.tlLayer);
 await page.evaluate(()=>{window.setTimeout=timer;Object.defineProperty(document,'fonts',{configurable:true,value:originalFonts});});
 await page.setViewportSize({width:320,height:640});
 await open('export');
 const shareGeometry=await sheet('分享').evaluate(el=>{
  const box=el.getBoundingClientRect();const first=el.querySelector('.tl-choices').firstElementChild.getBoundingClientRect();
  const buttons=[...el.querySelectorAll('button')].filter(b=>/^(长图|文本文件|复制文字)/.test(b.textContent));
  return {inset:first.left-box.left,width:box.width,buttons:buttons.map(b=>b.getBoundingClientRect().width)};
 });
 assert.equal(shareGeometry.inset,16);assert(shareGeometry.buttons.every(width=>Math.abs(width-shareGeometry.width)<1));ok('share choices keep their inset and export rows fill the fieldset');await close('分享');
 await page.evaluate(()=>{bridge.snapshot=()=>({total:3,messages:[{index:0,name:'角色',is_user:false,html:'<p>有内容</p>',mes:'有内容'},{index:1,name:'我',is_user:true,html:'<img src="data:,">',mes:'图片'},{index:2,name:'我',is_user:true,html:'<p>&nbsp;</p>',mes:'空白'}]});});
 await open('export');await sheet('分享').getByRole('radio',{name:'只要我',exact:true}).click();
 const actions=()=>Promise.all([/^长图/,/^文本文件/,/^复制文字/].map(name=>sheet('分享').getByRole('button',{name}).isDisabled()));
 assert.deepEqual(await actions(),[true,true,true]);assert((await sheet('分享').locator('.tl-sheet-note').innerText()).includes('没有你的发言'));ok('image-only and whitespace floors do not enable empty exports');
 await sheet('分享').getByRole('radio',{name:'都要',exact:true}).click();assert.deepEqual(await actions(),[false,false,false]);assert((await sheet('分享').locator('.tl-sheet-note').innerText()).includes('#0，共 1 条'));ok('changing the speaker restores actions and counts only exportable floors');await close('分享');
 const readingGeometry=()=>sheet('阅读设置').evaluate(el=>{
  const panel=el.getBoundingClientRect();const close=el.querySelector('.tl-sheet-close').getBoundingClientRect();const slider=el.querySelector('input[type="range"]').getBoundingClientRect();const strip=el.querySelector('.tl-theme-strip').getBoundingClientRect();const active=el.querySelector('.tl-theme-strip [aria-checked="true"]').getBoundingClientRect();
  return {scroll:el.scrollTop,closeVisible:close.top>=panel.top&&close.bottom<=panel.bottom,sliderVisible:slider.top>=panel.top&&slider.bottom<=panel.bottom,activeVisible:active.left>=strip.left-1&&active.right<=strip.right+1};
 });
 await page.evaluate(()=>theme.saveAppearance({reading:{...theme.cachedReading(),theme:Object.keys(theme.PRESETS).at(-1)}}));
 await open('reading');await page.waitForTimeout(300);let geometry=await readingGeometry();assert.equal(geometry.scroll,0);assert(geometry.closeVisible&&geometry.sliderVisible);ok('a late preset does not scroll the mobile close button and font slider out of view');await close('阅读设置');
 await page.evaluate(()=>{for(let i=0;i<20;i++)theme.saveTheme({id:'joint'+i,name:'主题'+i,bg:'#ffffff',text:'#000000'});theme.saveAppearance({reading:{...theme.cachedReading(),theme:'custom:joint0'}});});
 await open('reading');await page.waitForTimeout(300);geometry=await readingGeometry();assert.equal(geometry.scroll,0);assert(geometry.closeVisible&&geometry.sliderVisible);ok('the last of twenty custom themes does not move the mobile sheet on opening');await close('阅读设置');
 await page.setViewportSize({width:1024,height:768});await open('reading');await page.waitForTimeout(300);geometry=await readingGeometry();assert(geometry.activeVisible&&geometry.closeVisible&&geometry.sliderVisible);ok('desktop still reveals the active theme by scrolling only its strip');await close('阅读设置');
 await page.setViewportSize({width:320,height:640});await page.evaluate(()=>theme.saveAppearance({reading:{...theme.cachedReading(),theme:'paper'}}));await open('reading');await page.waitForTimeout(300);
 const slider=sheet('阅读设置').getByRole('slider',{name:'字号',exact:true});const track=await slider.boundingBox();const cdp=await page.context().newCDPSession(page);
 const touch=(type,ratio)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x:track.x+track.width*ratio,y:track.y+track.height/2}]});
 await touch('touchStart',0.2);await page.waitForTimeout(20);const dragValues=[await slider.inputValue()];
 for(let i=1;i<=8;i++){await touch('touchMove',0.2+i*0.07);await page.waitForTimeout(20);dragValues.push(await slider.inputValue());}await touch('touchEnd');
 assert(new Set(dragValues).size>=3,JSON.stringify(dragValues));ok('font size changes during touch movement, not just on the initial tap');await close('阅读设置');


 // Header markup fixture uses production CSS; the real-library counterpart is in e2e-ui-appearance.
 await page.evaluate(()=>{const host=document.createElement('main');host.id='header-layout-fixture';host.className='tl-library';host.innerHTML='<header class="tl-header"><h1 class="tl-title">轻酒馆</h1><button class="tl-ghost tl-aa tl-theme-entry">Aa</button><span class="tl-spacer"></span><button class="tl-button">＋ 添加角色</button><button class="tl-button tl-me-button"><img class="tl-avatar" alt=""><span>我的</span></button></header>';document.body.append(host);});
 for(const width of [320,390,421,430,480,481,600,1440])for(const size of [17,26]){
  await page.setViewportSize({width,height:844});await page.evaluate(n=>document.documentElement.style.setProperty('--tl-ui-font-size',n+'px'),size);
  const boxes=await page.locator('#header-layout-fixture .tl-header').evaluate(el=>[...el.querySelectorAll('h1,button')].map(e=>{let r;if(e.tagName==='H1'){const range=document.createRange();range.selectNodeContents(e);r=range.getBoundingClientRect();}else r=e.getBoundingClientRect();return {label:e.textContent,x:r.x,y:r.y,w:r.width,h:r.height};}));
  for(const [i,a] of boxes.entries()){
   assert(a.x>=0&&a.x+a.w<=width+1,JSON.stringify({width,size,boxes}));
   if(i)assert(a.w>=44&&a.h>=40,JSON.stringify({width,size,boxes}));
   for(const b of boxes.slice(i+1))assert(a.x+a.w<=b.x+1||b.x+b.w<=a.x+1||a.y+a.h<=b.y+1||b.y+b.h<=a.y+1,JSON.stringify({width,size,boxes}));
  }
 }
 ok('shelf title and 44px actions do not overlap across phone breakpoints and large UI text');
 await page.evaluate(()=>document.getElementById('header-layout-fixture').remove());

 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:checks.length,checks},null,2));console.log('ALL PASS');
} finally {await browser.close();}
