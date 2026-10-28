import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createNativeWorldEditor } from '../bridge-world-editor-native.js';
import { cloneJson } from '../src/episode-model.js';
import { isBlockingWorldOperation } from '../src/world-editor-model.js';
function fixture() {
 const original={entries:{0:{uid:0,content:'old',key:[]}}}, disk=cloneJson(original), cache=new Map([['Book',cloneJson(original)]]), operations=new Map(), listeners=new Set();
 let calls=0,queue=Promise.resolve(),active=true,waitIdle=async()=>{},nativeReject=false;
 const lease={account:'alice'}, assertLease=()=>{if(!active)throw Object.assign(new Error('changed'),{code:'ACCOUNT_CHANGED'});};
 const journal={async create(x){const o={...cloneJson(x),revision:1,stage:'prepared'};operations.set(o.operationId,o);return cloneJson(o);},async update(o,p){const v={...operations.get(o.operationId),...p,revision:o.revision+1};operations.set(o.operationId,v);return cloneJson(v);},async read(a,id){return cloneJson(operations.get(id));},async unfinished(){return [...operations.values()].filter(isBlockingWorldOperation);}};
 const eventSource={on(t,f){listeners.add(f);},removeListener(t,f){listeners.delete(f);},async emit(t,...args){for(const f of listeners)await f(...args);}};
 const h={account:'alice',journal,uuid:randomUUID,st:{getRequestHeaders:()=>({})},powerUser:{},ctx:()=>({eventSource,eventTypes:{WORLDINFO_UPDATED:'updated'}}),
  worldInfo:{worldInfoCache:cache,async saveWorldInfo(name,data){calls++;cache.set(name,cloneJson(data));if(nativeReject)throw new Error('native reject after cache');Object.assign(disk,cloneJson(data));await eventSource.emit('updated',name,data);},reloadEditor:async()=>{},updateWorldInfoList:async()=>{}},
  enqueue(f){const run=queue.then(f);queue=run.catch(()=>{});return run;},makeLease:()=>lease,assertLease,assertQueueOwner:assertLease,verifyAccount:async()=>assertLease(),waitIdle:()=>waitIdle(),
  fetchImpl:async path=>({ok:true,json:async()=>path==='/api/worldinfo/list'?[{file_id:'Book'}]:cloneJson(disk)})};
 const api=createNativeWorldEditor(h);
 return {api,cache,disk,operations,calls:()=>calls,setWait:f=>{waitIdle=f;},deactivate:()=>{active=false;},reject:()=>{nativeReject=true;},input:{account:'alice',name:'Book',uid:0,baseEntry:original.entries[0],patch:{content:'mine'},draftRevision:1}};
}
test('real native binding final guard is after waitIdle and prevents cancellation of a newer native cache edit',async()=>{
 const f=fixture(); f.setWait(async()=>{f.cache.get('Book').entries[0].content='new native edit';});
 const r=await f.api.saveWorldEditorEntry(f.input);assert.equal(r.kind,'not-submitted');assert.equal(r.operation.outcomeVersion,2);assert.equal(r.operation.writeSettled,'not-started');assert.equal(f.calls(),0);assert.equal(f.cache.get('Book').entries[0].content,'new native edit');
});
test('real binding session invalidation during final idle wait prevents native invocation',async()=>{
 const f=fixture();f.setWait(async()=>f.deactivate());await assert.rejects(f.api.saveWorldEditorEntry(f.input),{code:'ACCOUNT_CHANGED'});assert.equal(f.calls(),0);assert.equal([...f.operations.values()][0].stage,'not-submitted');assert.equal([...f.operations.values()][0].writeSettled,'not-started');
});
test('real binding native rejection cannot be tagged as a proven zero-write failure',async()=>{
 const f=fixture();f.reject();const r=await f.api.saveWorldEditorEntry(f.input);assert.equal(f.calls(),1);assert.equal(r.kind,'unconfirmed');assert.equal(r.operation.writeSettled,'rejected');assert.equal(f.cache.get('Book').entries[0].content,'mine');assert.equal(f.disk.entries[0].content,'old');assert.throws(()=>f.api.assertWorldRuntimeReady(),{code:'WORLD_RUNTIME_UNCONFIRMED'});
});
test('native factory and basic chat gate tolerate both storage getters throwing before any editor use',()=>{
 const oldIdb=Object.getOwnPropertyDescriptor(globalThis,'indexedDB'),oldLs=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 for(const k of ['indexedDB','localStorage'])Object.defineProperty(globalThis,k,{configurable:true,get(){throw new DOMException('disabled','SecurityError');}});
 try{const api=createNativeWorldEditor({account:'alice',worldInfo:{},st:{},powerUser:{},ctx:()=>({})});api.assertWorldRuntimeReady();}
 finally{for(const [k,v] of [['indexedDB',oldIdb],['localStorage',oldLs]]){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}}
});
