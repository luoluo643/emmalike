import { cloneJson } from './src/episode-model.js';
import { classifySaveOutcome } from './src/save-outcome.js';
import { WORLD_DECISION_ACK, WORLD_ENTRY_FIELDS, hasWorldUserDecision, isBlockingWorldOperation, isWorldNotSubmitted, validWorldBasis, mergeWorldEntry, validateWorldBook, validateWorldName, worldError, worldFingerprint } from './src/world-editor-model.js';

/** The host owns its existing queue and native immediate-save dependency (including native debounce cancellation).
 * readServerBook must read the HTTP endpoint directly, check response.ok, and never consult worldInfoCache.
 * cacheGet/cacheSet, assertLease and watchUpdates are synchronous; all other native functions are private, unqueued.
 */
export function createWorldEditorAdapter(d) {
    const journal = d.journal;
    // Page-lifetime state only: this closure lives with the native iframe, including bfcache.
    // Historical journals in a fresh document cannot contaminate a newly built native cache.
    const dirtyBooks = new Map();
    // Only this page's confirmed saves and explicit server acceptance establish a baseline.
    // Old journals never hydrate this map or the runtime cache in a new document.
    const verifiedBooks = new Map(), observedChanges = new Map(), resaveRequired = new Set(), resaveOperations = new Set();
    const markDirty = op => dirtyBooks.set(op.name, op.operationId);
    const clearDirty = name => dirtyBooks.delete(name);
    const acceptObserved = (name, fingerprint) => { verifiedBooks.set(name, fingerprint); observedChanges.delete(name); };
    function observeFingerprint(name, fingerprint) {
        if (verifiedBooks.has(name) && verifiedBooks.get(name) !== fingerprint) {
            observedChanges.set(name, { expectedFingerprint: verifiedBooks.get(name), observedFingerprint: fingerprint });
            markDirty({ name, operationId: 'observed-server-change' });
        }
    }
    const changedNotice = '酒馆里的版本变了，跟这页的不一样。已暂停发送；可以用酒馆里的，或者把我的留作草稿，看过再存';
    const fail = (code, text, detail) => { throw worldError(code, text, detail); };
    const assertAccount = (account, lease) => {
        if (account !== d.account || lease?.account !== d.account) fail('ACCOUNT_CHANGED', '换了账号，原稿和保存记录留在原账号');
        d.assertLease(lease);
    };
    async function read(name, lease) {
        validateWorldName(name); assertAccount(d.account, lease);
        await d.verifyAccount(); d.assertLease(lease);
        const snapshot = validateWorldBook(await d.readServerBook(name, lease)); d.assertLease(lease);
        await d.verifyAccount(); d.assertLease(lease);
        const fingerprint = worldFingerprint(snapshot); observeFingerprint(name, fingerprint);
        return { snapshot, fingerprint };
    }
    const cached = name => { const value = d.cacheGet(name); return value ? { snapshot: cloneJson(value), fingerprint: worldFingerprint(value) } : null; };
    async function named(name, lease) {
        const names = await d.listBooks(lease); d.assertLease(lease);
        if (!Array.isArray(names) || names.some(x => typeof x !== 'string')) fail('WORLD_LIST_UNCONFIRMED', '世界书列表没加载出来');
        return names.includes(name);
    }
    async function actual(name, lease) {
        if (!await named(name, lease)) { observeFingerprint(name, null); fail('WORLD_MISSING', '这本世界书改名或删掉了，草稿先留着，请重新看看'); }
        return read(name, lease);
    }
    function checkCacheBaseline(name, server) {
        if (observedChanges.has(name)) fail('WORLD_SERVER_CHANGED', changedNotice, observedChanges.get(name));
        const value = cached(name);
        if (value && value.fingerprint !== server.fingerprint) fail('WORLD_RUNTIME_CONFLICT', '原版里这本世界书还有不一样的内容，先在原版存好；这里不会覆盖它', { serverFingerprint: server.fingerprint, cacheFingerprint: value.fingerprint });
        return value;
    }
    async function syncRuntime(op, observed, lease, observedEvents = 0) {
        d.assertLease(lease);
        if (observedChanges.has(op.name) && observed.fingerprint !== op.expectedFingerprint) return 'conflict';
        const cache = cached(op.name);
        if (cache && ![op.baseCacheFingerprint, op.expectedFingerprint, observed.fingerprint].includes(cache.fingerprint)) return 'conflict';
        markDirty(op);
        d.cacheSet(op.name, cloneJson(observed.snapshot)); d.assertLease(lease);
        // A lost response bypasses the native event. A failed native HTTP response can emit an incorrect one;
        // send a corrective event with actual data, without claiming other listeners' past effects were undone.
        if (!observedEvents || observed.fingerprint !== op.expectedFingerprint) await d.emitUpdated(op.name, cloneJson(observed.snapshot));
        d.assertLease(lease); await d.reloadEditor(op.name); d.assertLease(lease);
        // An awaited listener/editor reload may itself edit the cache; never bless that newer value.
        if (cached(op.name)?.fingerprint !== observed.fingerprint) return 'conflict';
        acceptObserved(op.name, observed.fingerprint);
        if (resaveRequired.has(op.name) && !(observed.fingerprint === op.expectedFingerprint && resaveOperations.has(op.operationId))) return 'conflict';
        resaveRequired.delete(op.name); resaveOperations.delete(op.operationId); clearDirty(op.name);
        return 'ready';
    }
    async function reconcile(op, lease, observedEvents = 0, writeError) {
        assertAccount(op.account, lease);
        let observed;
        try { observed = await actual(op.name, lease); }
        catch (error) {
            d.assertLease(lease);
            const kind = classifySaveOutcome({ matchesExpected: false }), runtimeState = dirtyBooks.has(op.name) ? 'unconfirmed' : 'ready';
            op = await journal.update(op, { stage: kind === 'unknown' ? 'unconfirmed' : kind, runtimeState, retryAllowed: false, error: error.message });
            d.assertLease(lease);
            return { kind: op.stage, operation: op, draftRevision: op.draftRevision, runtimeState, error: error.message };
        }
        const outcome = classifySaveOutcome({ matchesExpected: observed.fingerprint === op.expectedFingerprint });
        const confirmed = outcome === 'confirmed', kind = confirmed ? 'confirmed' : 'unconfirmed';
        let runtimeState = dirtyBooks.has(op.name) ? 'unconfirmed' : 'ready', runtimeError;
        // A resolved native Promise may conceal an HTTP error. Only a full match
        // permits automatic runtime reconciliation; OLD never clears an existing gate.
        if (confirmed) try { runtimeState = await syncRuntime(op, observed, lease, observedEvents); }
        catch (error) {
            d.assertLease(lease); runtimeError = error.message;
            // A hook may throw after syncRuntime marks a previously clean page dirty.
            // Keep the confirmed file fact, but report the gate as it stands now.
            runtimeState = dirtyBooks.has(op.name) ? 'unconfirmed' : 'ready';
        }
        op = await journal.update(op, { stage: kind, observedFingerprint: observed.fingerprint, runtimeState, retryAllowed: false,
            error: runtimeError ?? (confirmed ? null : writeError?.message ?? '酒馆里的内容跟要存的还对不上') });
        d.assertLease(lease);
        return { kind, operation: op, name: op.name, entry: op.uid === undefined || observed.snapshot.entries[op.uid] === undefined ? undefined : cloneJson(observed.snapshot.entries[op.uid]),
            snapshot: observed.snapshot, fingerprint: observed.fingerprint, draftRevision: op.draftRevision, runtimeState, retryAllowed: false,
            ...(op.error ? { error: op.error } : {}) };
    }
    async function recover(input, lease) {
        assertAccount(input.account, lease);
        let op = await journal.read(input.account, input.operationId);
        d.assertLease(lease);
        if (!op || op.account !== d.account) fail('WORLD_OPERATION_MISSING', '没找到当前账号的保存记录');
        if (hasWorldUserDecision(op) || op.stage === 'confirmed') return observeHistory(op, lease);
        if (isWorldNotSubmitted(op)) {
            const runtimeState = dirtyBooks.has(op.name) ? 'conflict' : 'ready';
            op = await journal.update(op, { stage: classifySaveOutcome({ notSubmitted: true }), outcomeVersion: 2, runtimeState, retryAllowed: true, writeSettled: 'not-started', error: '上次确定没存，草稿还在，可以再存一次' });
            d.assertLease(lease);
            return { kind: op.stage, operation: op, draftRevision: op.draftRevision, runtimeState, retryAllowed: true, error: op.error };
        }
        return reconcile(op, lease);
    }
    async function assertNoPending(name, lease) {
        const pending = (await journal.unfinished(d.account)).find(op => op.name === name && isBlockingWorldOperation(op));
        d.assertLease(lease);
        if (pending) fail('WORLD_OPERATION_PENDING', '这本书还有一次保存要检查，先检查那次；不会重复保存', { operation: pending });
    }
    async function serverState(name, lease) {
        await d.verifyAccount(); d.assertLease(lease);
        if (await named(name, lease)) return read(name, lease);
        await d.verifyAccount(); d.assertLease(lease); observeFingerprint(name, null); return null;
    }
    const basisOf = observed => observed ? { kind: 'present', fingerprint: observed.fingerprint } : { kind: 'missing' };
    const sameBasis = (a, b) => validWorldBasis(a) && validWorldBasis(b) && a.kind === b.kind && a.fingerprint === b.fingerprint;
    async function operationFor(input, lease) {
        assertAccount(input.account, lease); await d.verifyAccount(); d.assertLease(lease);
        const op = await journal.read(input.account, input.operationId); d.assertLease(lease);
        if (!op || op.account !== d.account || op.operationId !== input.operationId) fail('WORLD_OPERATION_MISSING', '没找到当前账号的保存记录');
        validateWorldName(op.name); return op;
    }
    async function observeHistory(op, lease) {
        let observed = null, observation;
        try {
            observed = await serverState(op.name, lease);
            observation = { observedAt: Date.now(), kind: !observed ? 'missing' : observed.fingerprint === op.expectedFingerprint ? 'matches-submitted'
                : observed.fingerprint === op.baseFingerprint ? 'matches-base' : 'differs', ...(observed ? { fingerprint: observed.fingerprint } : {}) };
        } catch (error) {
            d.assertLease(lease); if (error.code === 'ACCOUNT_CHANGED') throw error;
            observation = { observedAt: Date.now(), kind: 'unavailable', error: error.message };
        }
        // This is historical observation only. Never restore, delete or announce old runtime content.
        // A known newer server version does set the page's send gate, without reinstating save pending.
        op = await journal.update(op, { lastObservation: observation,
            ...(observation.kind === 'matches-submitted' ? { stage: 'confirmed', observedFingerprint: observed.fingerprint } : {}) });
        d.assertLease(lease);
        return { kind: 'historical-observation', operation: op, observation, runtimeChanged: false,
            runtimeState: dirtyBooks.has(op.name) ? 'conflict' : 'ready', snapshot: observed?.snapshot ?? null,
            fingerprint: observed?.fingerprint ?? null,
            notice: observedChanges.has(op.name) ? changedNotice : '只检查了上次的保存，你现在写的没动' };
    }
    async function applyAuthority(name, observed, before, lease, keepGate = false) {
        d.assertLease(lease);
        if ((cached(name)?.fingerprint ?? null) !== before) fail('WORLD_RUNTIME_CONFLICT', '检查时原版又改了，还没替换，看过再决定');
        markDirty({ name, operationId: 'server-authority' });
        if (observed) d.cacheSet(name, cloneJson(observed.snapshot)); else d.cacheDelete(name);
        if (observed) await d.emitUpdated(name, cloneJson(observed.snapshot));
        d.assertLease(lease); await d.reloadEditor(name); d.assertLease(lease);
        if ((cached(name)?.fingerprint ?? null) !== (observed?.fingerprint ?? null))
            fail('WORLD_RUNTIME_CONFLICT', '同步后原版又改了，已留着，还要检查一下');
        acceptObserved(name, observed?.fingerprint ?? null);
        if (keepGate) { resaveRequired.add(name); markDirty({ name, operationId: 'resave-draft' }); }
        else { resaveRequired.delete(name); clearDirty(name); }
    }
    function prepareWorldOperationDecision(input) {
        return d.enqueue(async () => {
            const lease = d.makeLease(), op = await operationFor(input, lease);
            if (op.userDecision) fail('WORLD_OPERATION_CHANGED', '这次保存已经处理过，请重新加载');
            if (!isBlockingWorldOperation(op)) fail('WORLD_OPERATION_CHANGED', '这次保存已经有结果了，看一下原记录');
            const before = cached(op.name)?.fingerprint ?? null, observed = await serverState(op.name, lease);
            if ((cached(op.name)?.fingerprint ?? null) !== before) fail('WORLD_RUNTIME_CONFLICT', '检查时原版又改了，请重新看看');
            return { kind: 'decision-preview', account: op.account, operationId: op.operationId, operation: op,
                expectedRevision: op.revision, basis: basisOf(observed), snapshot: observed?.snapshot ?? null, expectedCacheFingerprint: before };
        });
    }
    function resolveWorldOperation(input) {
        return d.enqueue(async () => {
            const lease = d.makeLease(); let op = await operationFor(input, lease);
            if (op.userDecision || op.revision !== input.expectedRevision || !validWorldBasis(input.basis)
                || input.acknowledgement !== WORLD_DECISION_ACK) fail('WORLD_OPERATION_CHANGED', '请重新检查，再确认不等了');
            const observed = await serverState(op.name, lease);
            if (!sameBasis(input.basis, basisOf(observed))) fail('WORLD_SERVER_CHANGED', '确认时酒馆里有了别的版本，还没结束等待，请重新看看');
            await applyAuthority(op.name, observed, input.expectedCacheFingerprint, lease);
            const assertCurrent = () => {
                assertAccount(op.account, lease);
                if ((cached(op.name)?.fingerprint ?? null) !== (observed?.fingerprint ?? null)) {
                    markDirty(op); fail('WORLD_RUNTIME_CONFLICT', '处理时原版又改了，内容留着，请重新检查');
                }
            };
            assertCurrent();
            op = await journal.decide(op, input.basis, input.acknowledgement, assertCurrent);
            // A commit is durable even if a synchronous check now fails; expose that record to the UI.
            try { assertCurrent(); } catch (error) { error.detail = { ...error.detail, operation: op }; throw error; }
            const remaining = (await journal.unfinished(d.account)).filter(item => item.name === op.name && isBlockingWorldOperation(item));
            assertCurrent();
            return { kind: 'user-resolved', operation: op, name: op.name, basis: input.basis, snapshot: observed?.snapshot ?? null,
                fingerprint: observed?.fingerprint ?? null, runtimeState: 'ready', remainingBlocking: remaining.length,
                notice: '不等了；上次存没存上还不知道，它可能晚到并盖掉之后的改动，发现版本不一致会暂停发送' };
        });
    }
    async function submit(op, lease, onPrepared) {
        const attempt = { bindingInvoked: false };
        try {
            d.assertLease(lease);
            if (resaveRequired.has(op.name)) resaveOperations.add(op.operationId);
            onPrepared?.(cloneJson(op)); return await submitOnce(op, lease, attempt);
        }
        catch (error) {
            if (!attempt.bindingInvoked || attempt.nativeNotStarted || error.nativeWriteStarted === false) {
                // This invocation never reached native save. Persist that terminal
                // fact now; recovery must not infer it from a provisional armed row.
                // An expired lease may still record this fact for the captured old
                // account/operation, but may not mutate runtime or return old-page success.
                let leaseError;
                const checkLease = () => { try { d.assertLease(lease); } catch (invalid) { leaseError ||= invalid; } };
                checkLease();
                try {
                    const current = await journal.read(op.account, op.operationId); checkLease();
                    if (!current || current.account !== op.account || current.name !== op.name || current.expectedFingerprint !== op.expectedFingerprint) throw error;
                    if (!leaseError && !resaveRequired.has(op.name) && !observedChanges.has(op.name)) clearDirty(op.name);
                    const runtimeState = leaseError ? 'unconfirmed' : dirtyBooks.has(op.name) ? 'conflict' : 'ready';
                    const ended = await journal.update(current, { stage: classifySaveOutcome({ notSubmitted: true }), outcomeVersion: 2,
                        runtimeState, retryAllowed: true, writeSettled: 'not-started', error: error.message });
                    checkLease(); if (leaseError) throw leaseError;
                    if (error.code === 'ACCOUNT_CHANGED') throw error;
                    return { kind: 'not-submitted', operation: ended, runtimeState, retryAllowed: true, draftRevision: ended.draftRevision, error: error.message };
                } catch (receiptError) {
                    checkLease(); if (leaseError) throw leaseError;
                    if (receiptError.code !== 'ACCOUNT_CHANGED') receiptError.detail = { ...receiptError.detail, operation: op };
                    throw receiptError;
                }
            }
            d.assertLease(lease);
            // The captured operation already committed. Even if a later IDB update fails, the UI must offer
            // recovery by this identity rather than losing the record and presenting another create action.
            if (error.code !== 'ACCOUNT_CHANGED') error.detail = { ...error.detail, operation: op };
            throw error;
        }
    }
    async function submitOnce(op, lease, attempt) {
        const latest = op.action === 'copy' || op.action === 'book-create' ? await named(op.name, lease) ? await read(op.name, lease) : null : await actual(op.name, lease);
        if ((latest?.fingerprint ?? null) !== op.baseFingerprint) {
            const runtimeState = dirtyBooks.has(op.name) ? 'conflict' : 'ready';
            op = await journal.update(op, { stage: classifySaveOutcome({ notSubmitted: true }), outcomeVersion: 2, runtimeState, retryAllowed: true, writeSettled: 'not-started', error: '保存前世界书变了，这次没存，草稿还在，请重新看看' });
            d.assertLease(lease);
            return { kind: 'not-submitted', operation: op, draftRevision: op.draftRevision, runtimeState, retryAllowed: true, error: op.error };
        }
        if (latest) checkCacheBaseline(op.name, latest);
        op = await journal.update(op, { stage: 'armed', runtimeState: 'saving' }); d.assertLease(lease);
        let observedEvents = 0, writeError;
        const unwatch = d.watchUpdates(op.name, () => { observedEvents++; });
        try { attempt.bindingInvoked = true; await d.saveNativeImmediate(op.name, cloneJson(op.expectedBook), lease, () => {
            // Binding invokes this synchronously after ALL waits/account checks, immediately before native save.
            assertAccount(op.account, lease);
            const current = cached(op.name);
            if (current && ![op.baseCacheFingerprint, op.baseFingerprint].includes(current.fingerprint))
                fail('WORLD_RUNTIME_CONFLICT', '等的时候原版又改了，这次没存；新内容和草稿都留着');
            markDirty(op);
        }); }
        catch (error) { writeError = error; attempt.nativeNotStarted = error.nativeWriteStarted === false; }
        finally { unwatch(); }
        if (writeError?.nativeWriteStarted === false) {
            throw writeError;
        }
        d.assertLease(lease);
        op = await journal.update(op, { writeSettled: writeError ? 'rejected' : 'resolved' }); d.assertLease(lease);
        // No automatic second save, even when native rejects after the server committed.
        if (op.action === 'copy' || op.action === 'book-create') { await d.refreshBookList(); d.assertLease(lease); }
        return reconcile(op, lease, observedEvents, writeError);
    }
    function worldEditorBook(name) {
        return d.enqueue(async () => {
            const lease = d.makeLease(), server = await actual(name, lease), cache = cached(name);
            const sources = await d.describeSources(name, lease); d.assertLease(lease);
            return { account: d.account, name, ...server, entries: Object.values(server.snapshot.entries).sort((a, b) => (a.displayIndex ?? 0) - (b.displayIndex ?? 0) || (b.order ?? 0) - (a.order ?? 0) || a.uid - b.uid),
                sources, runtimeState: !dirtyBooks.has(name) && (!cache || cache.fingerprint === server.fingerprint) ? 'ready' : 'conflict',
                ...(observedChanges.has(name) ? { notice: changedNotice } : {}) };
        });
    }
    function saveWorldEditorEntry(input) {
        return d.enqueue(async () => {
            const lease = d.makeLease(); assertAccount(input.account, lease); validateWorldName(input.name);
            if (input.operationId) return recover(input, lease);
            await assertNoPending(input.name, lease);
            if (!Number.isSafeInteger(input.draftRevision) || input.draftRevision < 0 || !input.patch || typeof input.patch !== 'object') fail('INVALID_WORLD_OPERATION', '提交草稿或版本不完整');
            const source = await actual(input.name, lease), cache = checkCacheBaseline(input.name, source), expected = cloneJson(source.snapshot);
            let entry, action;
            if (input.uid === undefined || input.uid === null) {
                action = 'entry-create'; entry = d.createEntry(input.name, expected);
                if (!entry || !Number.isSafeInteger(entry.uid) || source.snapshot.entries[entry.uid]) fail('WORLD_ENTRY_UNCONFIRMED', '新条目没准备好，还没保存');
                for (const [key, value] of Object.entries(input.patch)) if (WORLD_ENTRY_FIELDS.includes(key)) entry[key] = cloneJson(value);
                entry.displayIndex = Math.min(0, ...Object.values(source.snapshot.entries).map(x => x.displayIndex ?? 0)) - 1;
            } else {
                action = 'entry-edit';
                const merged = mergeWorldEntry(input.baseEntry, source.snapshot.entries[input.uid], input.patch, input.resolutions);
                if (merged.kind !== 'merged') return { kind: 'conflict', conflicts: merged.conflicts, snapshot: source.snapshot, draftRevision: input.draftRevision, runtimeState: 'ready' };
                entry = expected.entries[input.uid] = merged.entry;
            }
            for (const key of WORLD_ENTRY_FIELDS) if (Object.prototype.hasOwnProperty.call(input.patch, key)) d.setOriginal(expected, entry.uid, key, entry[key]);
            const expectedFingerprint = worldFingerprint(expected);
            if (expectedFingerprint === source.fingerprint) { acceptObserved(input.name, source.fingerprint); resaveRequired.delete(input.name); clearDirty(input.name); return { kind: 'confirmed', entry: cloneJson(entry), snapshot: expected, fingerprint: expectedFingerprint, draftRevision: input.draftRevision, runtimeState: 'ready' }; }
            const operation = await journal.create({ account: d.account, operationId: d.uuid(), name: input.name, action, uid: entry.uid,
                baseFingerprint: source.fingerprint, baseCacheFingerprint: cache?.fingerprint ?? null, expectedBook: expected, expectedFingerprint, draftRevision: input.draftRevision });
            return submit(operation, lease, input.onPrepared);
        });
    }
    function copyWorldEditorBook(input) {
        return d.enqueue(async () => {
            const lease = d.makeLease(); assertAccount(input.account, lease);
            if (input.operationId) return recover(input, lease);
            validateWorldName(input.newName);
            await assertNoPending(input.newName, lease);
            const names = await d.listBooks(lease); d.assertLease(lease);
            if (names.some(name => name.toLocaleLowerCase() === input.newName.toLocaleLowerCase())) fail('WORLD_NAME_EXISTS', '已有同名世界书，换个名字');
            const source = await actual(input.name, lease);
            if (input.expectedFingerprint && source.fingerprint !== input.expectedFingerprint) fail('WORLD_CHANGED', '原书变了，刷新后再复制');
            checkCacheBaseline(input.name, source);
            const expected = cloneJson(source.snapshot);
            if (Object.prototype.hasOwnProperty.call(expected, 'name')) expected.name = input.newName;
            const operation = await journal.create({ account: d.account, operationId: d.uuid(), name: input.newName, action: 'copy', sourceName: input.name,
                baseFingerprint: null, baseCacheFingerprint: null, expectedBook: expected, expectedFingerprint: worldFingerprint(expected), draftRevision: input.draftRevision ?? 0 });
            return submit(operation, lease, input.onPrepared);
        });
    }
    function deleteWorldEditorEntry(input) {
        return d.enqueue(async () => {
            const lease = d.makeLease(); assertAccount(input.account, lease);
            if (input.operationId) return recover(input, lease);
            await assertNoPending(input.name, lease);
            const source = await actual(input.name, lease), cache = checkCacheBaseline(input.name, source), entry = source.snapshot.entries[input.uid];
            if (!entry) return { kind: 'confirmed', snapshot: source.snapshot, draftRevision: input.draftRevision ?? 0, runtimeState: 'ready' };
            if (!input.baseEntry || worldFingerprint(entry) !== worldFingerprint(input.baseEntry)) fail('WORLD_CHANGED', '这一条在别处改过了，重新看看再删');
            const expected = cloneJson(source.snapshot); delete expected.entries[input.uid]; d.deleteOriginal(expected, input.uid);
            const operation = await journal.create({ account: d.account, operationId: d.uuid(), name: input.name, action: 'entry-delete', uid: input.uid,
                baseFingerprint: source.fingerprint, baseCacheFingerprint: cache?.fingerprint ?? null, expectedBook: expected, expectedFingerprint: worldFingerprint(expected), draftRevision: input.draftRevision ?? 0 });
            return submit(operation, lease, input.onPrepared);
        });
    }
    function createWorldEditorBook(input) {
        return d.enqueue(async () => {
            const lease = d.makeLease(); assertAccount(input.account, lease);
            if (input.operationId) return recover(input, lease);
            validateWorldName(input.name);
            await assertNoPending(input.name, lease);
            const names = await d.listBooks(lease); d.assertLease(lease);
            if (names.some(name => name.toLocaleLowerCase() === input.name.toLocaleLowerCase())) fail('WORLD_NAME_EXISTS', '已有同名世界书，换个名字');
            const expected = { entries: {} };
            const operation = await journal.create({ account: d.account, operationId: d.uuid(), name: input.name, action: 'book-create',
                baseFingerprint: null, baseCacheFingerprint: null, expectedBook: expected, expectedFingerprint: worldFingerprint(expected), draftRevision: input.draftRevision ?? 0 });
            return submit(operation, lease, input.onPrepared);
        });
    }
    function splitWorldEditorKeys(input) {
        return d.enqueue(async () => {
            const lease = d.makeLease(); assertAccount(input.account, lease);
            if (input.operationId) return recover(input, lease);
            await assertNoPending(input.name, lease);
            const source = await actual(input.name, lease), cache = checkCacheBaseline(input.name, source);
            if (source.fingerprint !== input.expectedFingerprint) fail('WORLD_CHANGED', '这本书变了，刷新后再处理关键词');
            const expected = cloneJson(source.snapshot); let changedCount = 0;
            for (const entry of Object.values(expected.entries)) {
                if (entry.constant || !(entry.key ?? []).some(key => !/^\/.+\/[a-z]*$/i.test(key) && /[,，、]/.test(key))) continue;
                entry.key = [...new Set(entry.key.flatMap(key => !/^\/.+\/[a-z]*$/i.test(key) && /[,，、]/.test(key) ? key.split(/[,，、]/).map(value => value.trim()).filter(Boolean) : [key]))];
                d.setOriginal(expected, entry.uid, 'key', entry.key); changedCount++;
            }
            if (!changedCount) return { kind: 'confirmed', snapshot: expected, fingerprint: source.fingerprint, changedCount, runtimeState: 'ready' };
            const operation = await journal.create({ account: d.account, operationId: d.uuid(), name: input.name, action: 'split-keys', changedCount,
                baseFingerprint: source.fingerprint, baseCacheFingerprint: cache?.fingerprint ?? null, expectedBook: expected, expectedFingerprint: worldFingerprint(expected), draftRevision: 0 });
            return { ...await submit(operation, lease), changedCount };
        });
    }
    const journalRead = query => d.enqueue(async () => {
        const lease = d.makeLease(); assertAccount(d.account, lease);
        await d.verifyAccount(); d.assertLease(lease);
        const value = await query(); d.assertLease(lease);
        await d.verifyAccount(); d.assertLease(lease); return value;
    });
    return { worldEditorBook, saveWorldEditorEntry, copyWorldEditorBook, deleteWorldEditorEntry, createWorldEditorBook, splitWorldEditorKeys,
        prepareWorldOperationDecision, resolveWorldOperation,
        worldEditorAccount: () => d.account,
        recoverWorldEditorWrite: input => d.enqueue(() => recover(input, d.makeLease())),
        worldEditorUnfinished: () => journalRead(() => journal.unfinished(d.account)),
        // No IDB access or await: caller must invoke at its last synchronous native-send boundary.
        assertWorldRuntimeReady() {
            if (dirtyBooks.size) fail('WORLD_RUNTIME_UNCONFIRMED', observedChanges.size ? changedNotice : '这页还要检查一下，回世界书检查，或选「用酒馆里的版本」', { names: [...dirtyBooks.keys()] });
        },
        worldEditorRuntime: () => ({ kind: dirtyBooks.size ? 'dirty' : 'ready', names: [...dirtyBooks.keys()], ...(observedChanges.size ? { notice: changedNotice } : {}) }),
        worldEditorOperation: id => journalRead(() => journal.read(d.account, id)),
        prepareWorldEditorResave(input) {
            return d.enqueue(async () => {
                const lease = d.makeLease(); assertAccount(input.account, lease); validateWorldName(input.name);
                await assertNoPending(input.name, lease);
                const before = cached(input.name)?.fingerprint ?? null, observed = await serverState(input.name, lease);
                if (!observed) fail('WORLD_MISSING', '酒馆里已经没有这本书了，写的先留着；不会自动重建');
                await applyAuthority(input.name, observed, before, lease, true);
                return { kind: 'resave-draft', name: input.name, snapshot: observed.snapshot, fingerprint: observed.fingerprint,
                    runtimeState: 'unconfirmed', notice: '我的版本已留作草稿。逐项看过再存；存好之前发送先暂停' };
            });
        },
        useWorldServerAuthority(input) {
            return d.enqueue(async () => {
                const lease = d.makeLease(); assertAccount(input.account, lease); validateWorldName(input.name);
                await d.verifyAccount(); d.assertLease(lease);
                const before = cached(input.name)?.fingerprint ?? null;
                const observed = await serverState(input.name, lease);
                await applyAuthority(input.name, observed, before, lease);
                return { kind: 'ready', name: input.name, snapshot: observed?.snapshot ?? null,
                    fingerprint: observed?.fingerprint ?? null, runtimeState: 'ready',
                    notice: '已按酒馆里的版本检查过；如果之前的保存还在进行，稍后可能又出现新版本' };
            });
        },
    };
}
