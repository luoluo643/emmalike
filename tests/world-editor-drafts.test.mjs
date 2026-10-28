import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldDraftStore } from '../src/world-editor-drafts.js';
const storage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k,v) => m.set(k,v), removeItem: k => m.delete(k) }; };
test('fresh store restores assigned UID and later input under original new scope', () => {
 const s=storage(), a=createWorldDraftStore({storage:()=>s}), key=JSON.stringify(['alice','Book','new']);
 const state={assignedUid:7,revision:5,form:{content:'typed after save'},base:{uid:7,content:'submitted'},pending:null};
 assert.equal(a.set(key,state),true); const reload=createWorldDraftStore({storage:()=>s});
 assert.deepEqual(reload.get(key),state); assert.equal(reload.get(JSON.stringify(['bob','Book','new'])),undefined);
});
test('storage getter failure does not break construction and never claims persistence', () => {
 const store=createWorldDraftStore({storage:()=>{throw new DOMException('disabled','SecurityError');}});
 assert.equal(store.get('scope'),undefined); assert.ok(store.error);
 assert.equal(store.set('scope',{revision:1,form:{content:'keep in memory'}}),false);
 assert.equal(store.get('scope').form.content,'keep in memory');
});
test('quota failure retains previous durable draft and never clears retained memory on failed remove', () => {
 const s=storage(), a=createWorldDraftStore({storage:()=>s}); a.set('scope',{revision:1});
 s.setItem=()=>{throw new Error('quota');}; assert.equal(a.set('scope',{revision:2}),false);
 assert.equal(createWorldDraftStore({storage:()=>s}).get('scope').revision,1);
 s.removeItem=()=>{throw new Error('blocked');}; assert.equal(a.delete('scope'),false); assert.equal(a.get('scope').revision,2);
});
