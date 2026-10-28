import { UUID, identityKey, creationIdFor, cloneJson, canonicalJson, sha256, normalizeLocator, locatorKey, sameLocator, episodeError } from './episode-model.js';

export const OPERATION_TRANSITIONS = Object.freeze({
    captured: ['source-confirmed', 'cancelled'],
    'source-confirmed': ['create-armed', 'continue-ready', 'cancelled', 'conflict'],
    'continue-ready': ['created', 'cancelled', 'conflict'],
    'create-armed': ['created', 'create-unconfirmed', 'conflict'],
    'create-unconfirmed': ['created', 'conflict', 'dismissed'],
    created: ['awaiting-review', 'cancelled', 'conflict'],
    'awaiting-review': ['submit-armed', 'cancelled', 'conflict'],
    'submit-armed': ['accepted', 'save-unconfirmed', 'cancelled', 'conflict', 'dismissed'],
    accepted: ['generated', 'saving', 'save-unconfirmed', 'conflict', 'dismissed'],
    generated: ['saving', 'save-unconfirmed', 'conflict', 'dismissed'],
    saving: ['confirmed', 'save-unconfirmed', 'conflict', 'dismissed'],
    'save-unconfirmed': ['saving', 'confirmed', 'conflict', 'dismissed'],
    // conflict only ends when the reply is found in the line or the author has looked and set it aside.
    conflict: ['dismissed'],
    confirmed: [], cancelled: [], dismissed: [],
});
const TERMINAL = new Set(['confirmed', 'cancelled', 'dismissed']);
const PATCH_FIELDS = new Set(['stage', 'error', 'resolvedLocator', 'initialFingerprint', 'openedFingerprint', 'confirmation', 'creationEvidence', 'cancellationProof', 'saveIntent', 'recoverySnapshot', 'reviewReceipt', 'nativeState', 'resolution']);
const RESOLUTIONS = new Set(['landed', 'user']);
const requiredAccount = account => {
    if (typeof account !== 'string' || !account.trim()) throw episodeError('ACCOUNT_REQUIRED', '操作日志必须绑定实际账号');
    return account;
};
const operationKey = (account, id) => {
    requiredAccount(account);
    if (!UUID.test(id)) throw episodeError('INVALID_OPERATION', '操作标识不完整');
    return JSON.stringify([account, identityKey(id)]);
};
const revision = value => Number.isSafeInteger(value) && value >= 0;
const HASH = /^[0-9a-f]{64}$/;
const publicRecord = record => {
    if (!record) return null;
    const { key, ...result } = record;
    return cloneJson(result);
};

export function validateOperationCapture(input) {
    const account = requiredAccount(input?.account), operationId = identityKey(input.operationId);
    operationKey(account, operationId);
    const sourceLocator = normalizeLocator(input.source?.locator), targetLocator = normalizeLocator(input.target?.locator), action = input.action ?? 'create';
    const creationOperationId = identityKey(input.target?.creationOperationId ?? operationId);
    if (!['create', 'continue'].includes(action) || !UUID.test(creationOperationId) || action === 'create' && creationOperationId !== operationId ||
        sourceLocator.account !== account || targetLocator.account !== account || sourceLocator.avatar !== targetLocator.avatar || action !== 'continue' && sameLocator(sourceLocator, targetLocator) ||
        !['episodeId', 'rootId', 'parentId', 'integrity'].every(key => UUID.test(input.target?.[key])) ||
        typeof input.capturedText !== 'string' || !input.capturedText.trim() || !revision(input.draftRevision) ||
        !['continued', 'fresh'].includes(input.contextMode) || !HASH.test(input.sourceFingerprint) || typeof input.cancelId !== 'string' || !input.cancelId) {
        throw episodeError('INVALID_OPERATION', '来源、目标、草稿或取消身份不完整');
    }
    // Retain snapshots if supplied, but never let callers forge persisted ownership, stage or revision.
    const { key, revision: ignoredRevision, stage, ownerAccount, createdAt, updatedAt, captureFingerprint, ...data } = cloneJson(input);
    const target = { ...data.target, locator: targetLocator };
    for (const key of ['episodeId', 'rootId', 'parentId', 'integrity']) target[key] = identityKey(target[key]);
    return { ...data, action, account, ownerAccount: account, operationId, source: { ...data.source, locator: sourceLocator }, target: { ...target, creationOperationId } };
}

export function applyOperationTransition(old, input, now) {
    if (!old || old.account !== input.account || identityKey(old.operationId) !== identityKey(input.operationId)) throw episodeError('OPERATION_MISSING', '找不到此账号的操作日志');
    if (!revision(input.expectedRevision) || old.revision !== input.expectedRevision || old.stage !== input.expectedStage) throw episodeError('JOURNAL_CONFLICT', '操作已在别处推进，请重新读取');
    if (TERMINAL.has(old.stage)) throw episodeError('INVALID_STAGE', '此操作已经结束');
    const patch = cloneJson(input.patch ?? {});
    if (Object.keys(patch).some(key => !PATCH_FIELDS.has(key))) throw episodeError('IMMUTABLE_OPERATION', '操作身份与捕获的草稿不能被修改');
    const nextStage = patch.stage ?? old.stage;
    if (!OPERATION_TRANSITIONS[old.stage] || nextStage !== old.stage && !OPERATION_TRANSITIONS[old.stage].includes(nextStage)) {
        throw episodeError('INVALID_STAGE', '此阶段不能重新创建或重新提交');
    }
    if (nextStage === 'continue-ready' && old.action !== 'continue' || nextStage === 'create-armed' && old.action === 'continue') throw episodeError('INVALID_STAGE', '已有子线不能重新创建');
    if (old.stage === 'submit-armed' && nextStage === 'cancelled' && (patch.cancellationProof?.kind !== 'native-not-called' || patch.cancellationProof.cancelId !== old.cancelId)) {
        throw episodeError('INVALID_STAGE', '提交状态未知时不能伪称已撤回');
    }
    if (nextStage === 'create-armed' && !HASH.test(patch.initialFingerprint ?? old.initialFingerprint)) throw episodeError('CREATE_UNCONFIRMED', '首写前必须持久记录完整初始指纹');
    // Setting a record aside says why: the reply was found in the line, or the author chose to. It never claims a save.
    if (nextStage === 'dismissed' && (!RESOLUTIONS.has(patch.resolution?.kind) || patch.confirmation)) throw episodeError('INVALID_STAGE', '移出列表要写明原因');
    if (patch.resolvedLocator) {
        const locator = normalizeLocator(patch.resolvedLocator);
        if (locator.account !== old.account || locator.avatar !== old.target.locator.avatar) throw episodeError('ACCOUNT_CHANGED', '恢复目标属于其他账号或角色');
        patch.resolvedLocator = locator;
    }
    if (nextStage === 'confirmed') {
        const c = patch.confirmation ?? old.confirmation;
        if (c?.state !== 'confirmed' || c.ownerAccount !== old.account || c.operationRevision !== old.revision || !HASH.test(c.expectedFingerprint) || c.expectedFingerprint !== c.observedFingerprint ||
            identityKey(c.episodeId) !== identityKey(old.target.episodeId) || identityKey(c.creationOperationId) !== creationIdFor(old) || !sameLocator(c.locator, patch.resolvedLocator ?? old.resolvedLocator ?? old.target.locator)) {
            throw episodeError('SAVE_UNCONFIRMED', '缺少对应目标与完整内容的保存确认');
        }
    }
    return { ...old, ...patch, revision: old.revision + 1, updatedAt: now };
}

export function applyDraftWrite(old, { account, locator, expectedDraftRevision, text }, now) {
    requiredAccount(account);
    const target = normalizeLocator(locator);
    if (target.account !== account) throw episodeError('ACCOUNT_CHANGED', '换了账号，草稿没动');
    if (!revision(expectedDraftRevision) || (old?.draftRevision ?? 0) !== expectedDraftRevision) throw episodeError('DRAFT_CHANGED', '草稿在别处改过了');
    if (typeof text !== 'string') throw episodeError('INVALID_DRAFT', '草稿必须是文字');
    return { key: locatorKey(target), account, locator: target, text, draftRevision: expectedDraftRevision + 1, updatedAt: now };
}

/** Independent recovery data. This is not a native-chat queue or a server transaction. */
export function createEpisodeJournal({ indexedDB, now = Date.now, databaseName = 'tavern-lite-episodes' } = {}) {
    let dbPromise, database, generation = 0;
    const unavailable = cause => episodeError('JOURNAL_UNAVAILABLE', '没记下这次操作，文字还在，再试一次', { name: cause?.name ?? '', message: cause?.message ?? '' });
    function open() {
        // Constructing the bridge must not require storage access. Some browsers
        // throw at the indexedDB getter before an .open() call is possible.
        try {
            if (indexedDB === undefined) indexedDB = globalThis.indexedDB;
            if (!indexedDB?.open) return Promise.reject(unavailable());
        } catch (error) { return Promise.reject(unavailable(error)); }
        if (dbPromise) return dbPromise;
        const openingGeneration = generation;
        dbPromise = new Promise((resolve, reject) => {
            let settled = false, request;
            const fail = cause => { if (settled) return; settled = true; if (openingGeneration === generation) dbPromise = undefined; reject(unavailable(cause)); };
            try { request = indexedDB.open(databaseName, 1); } catch (error) { fail(error); return; }
            request.onupgradeneeded = () => {
                try {
                    for (const name of ['operations', 'drafts']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'key' });
                } catch (error) { try { request.transaction.abort(); } catch {} fail(error); }
            };
            request.onerror = () => fail(request.error);
            request.onblocked = () => fail(episodeError('JOURNAL_BLOCKED', '请关掉其他开着轻酒馆的页面再试'));
            request.onsuccess = () => {
                const opened = request.result;
                if (openingGeneration !== generation) { opened.close(); fail(new Error('恢复记录连接已关闭')); return; }
                if (settled) { opened.close(); return; }
                settled = true; database = opened;
                opened.onversionchange = () => { opened.close(); if (database === opened) { database = undefined; dbPromise = undefined; } };
                opened.onclose = () => { if (database === opened) { database = undefined; dbPromise = undefined; } };
                resolve(opened);
            };
        });
        // Synchronous .open() throws before assignment above completes; clear the rejected cached promise too.
        const current = dbPromise;
        current.catch(() => { if (dbPromise === current) dbPromise = undefined; });
        return current;
    }
    async function transaction(storeNames, mode, action) {
        const db = await open();
        return new Promise((resolve, reject) => {
            let tx, result, failure;
            const fail = error => {
                failure = error?.code ? error : unavailable(error);
                try { tx.abort(); } catch { reject(failure); }
            };
            try {
                tx = db.transaction(storeNames, mode);
                tx.oncomplete = () => resolve(result);
                tx.onabort = () => reject(failure ?? unavailable(tx.error));
                tx.onerror = () => { failure ??= unavailable(tx.error); };
                const stores = Object.fromEntries(storeNames.map(name => [name, tx.objectStore(name)]));
                action(stores, value => { result = value; }, fail);
            } catch (error) { if (tx) fail(error); else reject(unavailable(error)); }
        });
    }
    const checked = (fail, fn) => () => { try { fn(); } catch (error) { fail(error); } };

    async function captureIntent(input) {
        const capture = validateOperationCapture(input), key = operationKey(capture.account, capture.operationId);
        return transaction(['operations'], 'readwrite', ({ operations }, finish, fail) => {
            const request = operations.get(key);
            request.onsuccess = checked(fail, () => {
                if (request.result) {
                    if (request.result.captureFingerprint !== sha256(canonicalJson(capture))) throw episodeError('JOURNAL_CONFLICT', '操作标识已用于另一份内容');
                    finish(publicRecord(request.result)); return;
                }
                const time = now(), record = { ...capture, captureFingerprint: sha256(canonicalJson(capture)), key, stage: 'captured', revision: 1, createdAt: time, updatedAt: time };
                operations.add(record); finish(publicRecord(record));
            });
        });
    }
    async function readOperation(account, operationId) {
        const key = operationKey(account, operationId);
        return transaction(['operations'], 'readonly', ({ operations }, finish, fail) => {
            const request = operations.get(key); request.onsuccess = checked(fail, () => finish(publicRecord(request.result)));
        });
    }
    async function transition(input) {
        const key = operationKey(input.account, input.operationId);
        return transaction(['operations'], 'readwrite', ({ operations }, finish, fail) => {
            const request = operations.get(key);
            request.onsuccess = checked(fail, () => {
                const record = applyOperationTransition(request.result, input, now());
                operations.put(record); finish(publicRecord(record));
            });
        });
    }
    async function writeDraft(input) {
        const key = locatorKey(input.locator); requiredAccount(input.account);
        return transaction(['drafts'], 'readwrite', ({ drafts }, finish, fail) => {
            const request = drafts.get(key);
            request.onsuccess = checked(fail, () => {
                const record = applyDraftWrite(request.result, input, now()); drafts.put(record); finish(publicRecord(record));
            });
        });
    }
    async function readDraft(account, locator) {
        const target = normalizeLocator(locator); requiredAccount(account);
        if (target.account !== account) throw episodeError('ACCOUNT_CHANGED', '换了账号，草稿没动');
        return transaction(['drafts'], 'readonly', ({ drafts }, finish, fail) => {
            const request = drafts.get(locatorKey(target)); request.onsuccess = checked(fail, () => finish(publicRecord(request.result)));
        });
    }
    async function clearDraftIfRevision({ account, locator, draftRevision, operationId }) {
        const target = normalizeLocator(locator), opKey = operationKey(account, operationId);
        if (target.account !== account) throw episodeError('ACCOUNT_CHANGED', '换了账号，草稿没动');
        return transaction(['operations', 'drafts'], 'readwrite', ({ operations, drafts }, finish, fail) => {
            const operation = operations.get(opKey);
            operation.onsuccess = checked(fail, () => {
                const op = operation.result;
                if (!op || op.stage !== 'confirmed' || !sameLocator(op.source.locator, target) || op.draftRevision !== draftRevision) throw episodeError('INVALID_DRAFT_CLEAR', '只能清理已确认操作捕获的草稿');
                const request = drafts.get(locatorKey(target));
                request.onsuccess = checked(fail, () => {
                    const old = request.result;
                    if (!old || old.draftRevision !== draftRevision) { finish({ cleared: false }); return; }
                    const next = applyDraftWrite(old, { account, locator: target, expectedDraftRevision: draftRevision, text: '' }, now());
                    next.clearedByOperation = operationId; drafts.put(next); finish({ cleared: true, draftRevision: next.draftRevision });
                });
            });
        });
    }
    async function listUnfinished(account) {
        requiredAccount(account);
        return transaction(['operations'], 'readonly', ({ operations }, finish, fail) => {
            const request = operations.getAll(); request.onsuccess = checked(fail, () => finish(request.result.filter(x => x.account === account && !TERMINAL.has(x.stage)).map(publicRecord)));
        });
    }
    /**
     * Ended records are only history. Kept for a while so a just-finished send can still be looked at, then deleted:
     * older versions kept a whole copy of the story in each, enough to fill a phone's storage.
     */
    async function pruneSettled(keepMs) {
        const cutoff = now() - keepMs;
        return transaction(['operations'], 'readwrite', ({ operations }, finish, fail) => {
            let removed = 0;
            const request = operations.openCursor();
            request.onsuccess = checked(fail, () => {
                const cursor = request.result;
                if (!cursor) { finish(removed); return; }
                const record = cursor.value;
                if (TERMINAL.has(record?.stage) && !(record.updatedAt > cutoff)) { cursor.delete(); removed++; }
                cursor.continue();
            });
        });
    }
    const completeOperation = ({ account, operationId, expectedRevision, expectedStage, confirmation }) => transition({ account, operationId, expectedRevision, expectedStage, patch: { stage: 'confirmed', confirmation } });
    return { captureIntent, readOperation, transition, writeDraft, readDraft, clearDraftIfRevision, listUnfinished, completeOperation, pruneSettled,
        close() { generation++; database?.close(); database = undefined; dbPromise = undefined; } };
}
