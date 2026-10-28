import { getCurrentUser, getCharacter, getChat, getGroupChat, getGroups } from './api.js';
import * as engine from './engine.js';

export { sameStory, hasStory, makeSource, candidates, locateSource, newRecord, mutation } from './personal-model.js';
import { sameStory, hasStory, locateSource, mutation } from './personal-model.js';
async function assertAccount(account) {
    const user = await getCurrentUser();
    if (!account || user?.handle !== account) {
        dispatchEvent(new Event('tl-auth-required'));
        throw new Error('换了账号，请重新登录');
    }
}
let dbPromise;
function db() {
    return dbPromise ||= new Promise((resolve, reject) => {
        const request = indexedDB.open('tavern-lite-personal', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'key' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => { dbPromise = null; reject(new Error('打不开本机的摘录')); };
    });
}
async function deviceList(account) {
    const database = await db();
    return new Promise((resolve, reject) => {
        const request = database.transaction('records').objectStore('records').getAll();
        request.onsuccess = () => resolve(request.result.filter(x => x.owner === account).map(({ key, ...r }) => r));
        request.onerror = () => reject(new Error('本机的摘录暂时读不到'));
    });
}
async function deviceWrite(account, input) {
    const database = await db();
    return new Promise((resolve, reject) => {
        const tx = database.transaction('records', 'readwrite'), store = tx.objectStore('records');
        const key = JSON.stringify([account, input.id]);
        let result, failure;
        const request = store.get(key);
        request.onsuccess = () => {
            const old = request.result;
            if (old?.lastOperation === input.operationId) { result = old; return; }
            if ((old?.revision ?? 0) !== input.expected || input.action === 'create' && old) { failure = new Error('这条摘录在别处改过了，请重新载入'); tx.abort(); return; }
            if (input.action === 'create') result = { ...input.record, owner: account, note: '', deleted: false };
            else if (!old) { failure = new Error('这条摘录不在了'); tx.abort(); return; }
            else {
                result = { ...old };
                if (input.action === 'note' && !old.deleted) result.note = input.note;
                else if (input.action === 'delete') result.deleted = true;
                else if (input.action === 'restore' && old.deleted) result.deleted = false;
                else if (input.action === 'move' && old.source.file === input.from) result.source = { ...old.source, file: input.to };
                else { failure = new Error('摘录有变化，请重新载入'); tx.abort(); return; }
            }
            Object.assign(result, { key, revision: input.expected + 1, updatedAt: Date.now(), lastOperation: input.operationId });
            try { store.put(result); } catch (e) { failure = new Error('没存上，内容还在，再试一次'); tx.abort(); }
        };
        tx.oncomplete = () => { const { key, ...record } = result; resolve(record); };
        tx.onerror = tx.onabort = () => reject(failure ?? new Error('没存上，内容还在，再试一次'));
    });
}
// Records live in this browser, per account.
export async function readRecords(account) {
    await assertAccount(account);
    const local = await deviceList(account);
    await assertAccount(account);
    return { mode: 'device', records: local.map(r => ({ ...r, storage: 'device' })) };
}
export async function saveRecord(account, input) {
    await assertAccount(account);
    const record = await deviceWrite(account, input);
    await assertAccount(account);
    return { ...record, storage: 'device' };
}
export async function sourceMessages(source) {
    if (!hasStory(source)) return [];
    const b = engine.getBridge();
    if (b?.personalConversation && sameStory(b.currentChat(), source)) return b.personalConversation().messages;
    if (source.groupId) {
        const group = (await getGroups()).find(g => String(g.id) === String(source.groupId));
        if (!group || !(group.chats || [group.chat_id]).includes(source.file)) return [];
        return getGroupChat(source.file);
    }
    const character = await getCharacter(source.avatar);
    return getChat(character, source.file);
}
export async function verifySource(source) {
    try { return locateSource(await sourceMessages(source), source); } catch { return null; }
}
export async function movePersonalSources(account, detail) {
    const { records } = await readRecords(account);
    for (const record of records.filter(r => r.source.avatar === detail.avatar && r.source.file === detail.from)) {
        await saveRecord(account, mutation(record, 'move', { from: detail.from, to: detail.to }));
    }
}

let requestedJump = null;
export function requestSourceJump(account, source) { requestedJump = { account, source }; }
export function takeSourceJump(account, scope) {
    if (requestedJump?.account !== account || !sameStory(requestedJump.source, scope)) return null;
    const result = requestedJump.source; requestedJump = null; return result;
}
