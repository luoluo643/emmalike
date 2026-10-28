import { cloneJson } from './episode-model.js';
import { WORLD_DECISION_ACK, hasWorldUserDecision, isBlockingWorldOperation, normalizeWorldOperation, validWorldBasis, worldError, worldFingerprint, validateWorldBook } from './world-editor-model.js';

// A submitted snapshot survives refresh; ordinary editing stays in the page's independent draft.
export function createWorldEditorJournal({ indexedDB, name = 'tavern-lite-world-editor', now = Date.now } = {}) {
    let opening;
    const key = (account, operationId) => JSON.stringify([account, operationId]);
    function open() {
        try { if (indexedDB === undefined) indexedDB = globalThis.indexedDB; }
        catch { return Promise.reject(worldError('WORLD_JOURNAL_UNAVAILABLE', '本机存不了保存记录；世界书只能看，聊天照常')); }
        if (!indexedDB) return Promise.reject(worldError('WORLD_JOURNAL_UNAVAILABLE', '本机存不了保存记录，世界书没改'));
        if (!opening) opening = new Promise((resolve, reject) => {
            let request, failed = false;
            try { request = indexedDB.open(name, 1); } catch (error) { reject(error); return; }
            request.onupgradeneeded = () => request.result.createObjectStore('operations', { keyPath: 'key' });
            request.onsuccess = () => {
                if (failed) { request.result.close(); return; }
                request.result.onversionchange = () => { request.result.close(); opening = null; };
                resolve(request.result);
            };
            request.onerror = () => { failed = true; reject(request.error); };
            request.onblocked = () => { failed = true; reject(worldError('WORLD_JOURNAL_UNAVAILABLE', '别的页面正在保存，稍后再试')); };
        }).catch(error => { opening = null; throw worldError('WORLD_JOURNAL_UNAVAILABLE', '没记下这次操作，草稿还在', error?.message); });
        return opening;
    }
    async function transaction(mode, action) {
        const db = await open();
        return new Promise((resolve, reject) => {
            let result, failure, tx;
            try { tx = db.transaction('operations', mode); } catch (error) { reject(worldError('WORLD_JOURNAL_UNAVAILABLE', '暂时存不了', error.message)); return; }
            tx.oncomplete = () => resolve(result === undefined ? null : cloneJson(result));
            tx.onabort = tx.onerror = () => reject(failure || worldError('WORLD_JOURNAL_UNAVAILABLE', '没记下保存记录，没法确认存上', tx.error?.message));
            const fail = error => { failure = error?.code ? error : worldError('WORLD_JOURNAL_UNAVAILABLE', '没记下保存记录，草稿还在', error?.message); try { tx.abort(); } catch { reject(failure); } };
            try { action(tx.objectStore('operations'), value => { result = value; }, fail); } catch (error) { fail(error); }
        });
    }
    return {
        create(input) {
            if (![input.account, input.operationId, input.name].every(value => typeof value === 'string' && value.trim()) || !input.expectedFingerprint || !input.expectedBook || !Number.isSafeInteger(input.draftRevision) || input.draftRevision < 0) throw worldError('INVALID_WORLD_OPERATION', '世界书提交信息不完整');
            if (worldFingerprint(validateWorldBook(input.expectedBook)) !== input.expectedFingerprint) throw worldError('INVALID_WORLD_OPERATION', '内容变了，世界书没改');
            const operation = { ...cloneJson(input), key: key(input.account, input.operationId), stage: 'prepared', revision: 1, createdAt: now() };
            return transaction('readwrite', (store, done, fail) => { const request = store.add(operation); request.onsuccess = () => done(operation);
                request.onerror = () => fail(request.error?.name === 'ConstraintError' ? worldError('WORLD_OPERATION_EXISTS', '这次保存已经记下，先检查一下结果') : worldError('WORLD_JOURNAL_UNAVAILABLE', '没记下这次操作，世界书没改', request.error?.message)); });
        },
        read(account, operationId) { return transaction('readonly', (store, done) => { store.get(key(account, operationId)).onsuccess = event => done(normalizeWorldOperation(event.target.result)); }); },
        update(operation, patch) {
            return transaction('readwrite', (store, done, fail) => {
                store.get(key(operation.account, operation.operationId)).onsuccess = event => {
                    const old = event.target.result;
                    if (!old || old.revision !== operation.revision) return fail(worldError('WORLD_OPERATION_CHANGED', '记录有更新，请重新检查'));
                    const allowed = Object.fromEntries(Object.entries(patch).filter(([key]) => ['stage', 'error', 'runtimeState', 'observedFingerprint', 'writeSettled', 'lastObservation', 'retryAllowed', 'outcomeVersion'].includes(key)));
                    // Confirmation is an observed fact; a later server revision cannot erase that fact.
                    if (old.stage === 'confirmed' && allowed.stage !== 'confirmed') delete allowed.stage;
                    const next = { ...old, ...cloneJson(allowed), revision: old.revision + 1, updatedAt: now() };
                    store.put(next).onsuccess = () => done(normalizeWorldOperation(next));
                };
            });
        },
        decide(operation, basis, acknowledgement, assertCurrent = () => {}) {
            if (!validWorldBasis(basis) || acknowledgement !== WORLD_DECISION_ACK) throw worldError('INVALID_WORLD_DECISION', '请先核对服务器并明确确认旧请求仍可能迟到覆盖');
            return transaction('readwrite', (store, done, fail) => {
                store.get(key(operation.account, operation.operationId)).onsuccess = event => {
                    try {
                        const old = event.target.result;
                        if (!old || old.revision !== operation.revision || ['account', 'name', 'operationId'].some(field => old[field] !== operation[field]))
                            return fail(worldError('WORLD_OPERATION_CHANGED', '记录有更新，请重新检查'));
                        if (old.userDecision) return fail(worldError('WORLD_OPERATION_CHANGED', '这条记录已经处理过，请重新加载'));
                        assertCurrent();
                        const userDecision = { schemaVersion: 1, kind: 'user-resolved', account: old.account, name: old.name,
                            operationId: old.operationId, operationRevision: old.revision, decidedAt: now(), basis: cloneJson(basis), acknowledgement };
                        const next = { ...old, userDecision, revision: old.revision + 1, updatedAt: now() };
                        if (!hasWorldUserDecision(next)) return fail(worldError('INVALID_WORLD_DECISION', '裁定记录不完整，尚未结束等待'));
                        store.put(next).onsuccess = () => done(normalizeWorldOperation(next));
                    } catch (error) { fail(error); }
                };
            });
        },
        // A settled save (confirmed, or proven not written, and not ended by the user) is never read again, yet each
        // keeps the whole book, and every book page reads all records: removes those untouched for `olderThanMs`.
        pruneSettled(olderThanMs) {
            const cutoff = now() - olderThanMs;
            return transaction('readwrite', (store, done) => {
                const all = store.getAll();
                all.onsuccess = () => {
                    let removed = 0;
                    for (const record of all.result) {
                        const op = normalizeWorldOperation(record);
                        if (!isBlockingWorldOperation(op) && !hasWorldUserDecision(op) && (op.updatedAt ?? op.createdAt ?? 0) < cutoff) { store.delete(record.key); removed++; }
                    }
                    done(removed);
                };
            });
        },
        // Decided records remain visible history, including after a later genuine confirmation.
        unfinished(account) { return transaction('readonly', (store, done) => { store.getAll().onsuccess = event => done(event.target.result.map(normalizeWorldOperation).filter(op => op.account === account && (op.userDecision || isBlockingWorldOperation(op)))); }); },
    };
}
