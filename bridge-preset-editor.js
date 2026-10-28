import { clonePreset, mergePresetDocument, overlayPresetDocument, presetChanges, presetError, samePreset, validatePresetName, normalizePresetTargetName, normalizePresetOperation, presetTargetKey, presetFingerprint, isBlockingPresetOperation, hasPresetUserDecision, PRESET_DECISION_ACK, PRESET_RECEIPT_PREFIX, pruneSettledPresetReceipts } from './src/preset-editor-model.js';
import { classifySaveOutcome } from './src/save-outcome.js';

/** Persist an armed named-save receipt before HTTP. Recover only reads; it never repeats a write. */
export function createPresetEditorJournal(storage) {
    // Access can itself throw (SecurityError), before any storage method is called.
    // Resolve it only inside method guards so importing/installing the main bridge stays safe.
    const resolveStorage = () => storage === undefined ? globalThis.localStorage : storage;
    const key = (account, id) => `${PRESET_RECEIPT_PREFIX}${JSON.stringify([account, id])}`;
    const journal = {
        put(op) {
            try {
                const deviceStorage = resolveStorage(), previous = JSON.parse(deviceStorage.getItem(key(op.account, op.id)));
                if (previous && (previous.revision || 0) !== (op.revision || 0)) throw presetError('PRESET_RECEIPT_CHANGED', '保存记录变了，请重新检查');
                const value = { ...clonePreset(op), revision: (previous?.revision || 0) + 1 }, encoded = JSON.stringify(value);
                // A new save first clears receipts whose outcome is settled; a full storage gets one more try after that.
                if (!previous) pruneSettledPresetReceipts(deviceStorage, key(op.account, op.id));
                try { deviceStorage.setItem(key(op.account, op.id), encoded); }
                catch (error) { if (!pruneSettledPresetReceipts(deviceStorage, key(op.account, op.id))) throw error; deviceStorage.setItem(key(op.account, op.id), encoded); }
                if (deviceStorage.getItem(key(op.account, op.id)) !== encoded) throw new Error('Receipt readback differs');
                return normalizePresetOperation(value);
            } catch (error) { if (error.code === 'PRESET_RECEIPT_CHANGED') throw error; throw presetError('PRESET_RECEIPT_UNAVAILABLE', '没记下这次保存，草稿还在；检查一下本机存储'); }
        },
        get(account, id) {
            try { const value = JSON.parse(resolveStorage().getItem(key(account, id))); return value?.account === account && value?.id === id ? normalizePresetOperation(value) : null; }
            catch { throw presetError('PRESET_RECEIPT_UNAVAILABLE', '读不到保存记录，草稿先留着'); }
        },
        list(account) {
            const prefix = PRESET_RECEIPT_PREFIX, list = [];
            try { const deviceStorage = resolveStorage(); for (let i = 0; i < deviceStorage.length; i++) { const k = deviceStorage.key(i); if (!k?.startsWith(prefix)) continue;
                const value = normalizePresetOperation(JSON.parse(deviceStorage.getItem(k)));
                if (value?.account === account && (value.writeOutcome === 'unknown' || value.stage === 'saved-not-applied' || hasPresetUserDecision(value))) list.push(value); } }
            catch { throw presetError('PRESET_RECEIPT_UNAVAILABLE', '读不到上次没完成的保存记录'); }
            return list;
        },
        decide(op, basis, acknowledgement, assertCurrent) {
            if (acknowledgement !== PRESET_DECISION_ACK) throw presetError('PRESET_DECISION_ACK', '先确认：上次的保存可能晚到并盖掉');
            assertCurrent();
            const current = journal.get(op.account, op.id);
            if (!current || current.revision !== op.revision || !isBlockingPresetOperation(current)) throw presetError('PRESET_RECEIPT_CHANGED', '保存记录变了，请重新检查');
            // Synchronous localStorage compare + write has no await gap. This is not
            // a server CAS or a multi-tab/multi-device transaction.
            assertCurrent();
            return journal.put({ ...current, userDecision: { acknowledgement, operationId: op.id, basis: clonePreset(basis), at: Date.now() } });
        },
    };
    return journal;
}

/** Host operations are private/unqueued; this adapter owns sequencing through the existing bridge queue.
 * readNamed/listNamed must use HTTP, not native preset cache. All lease/account checks fail closed.
 */
export function createPresetEditorAdapter(d) {
    const bases = new Map(), journal = d.journal ?? createPresetEditorJournal(), uuid = d.uuid ?? (() => crypto.randomUUID());
    const apiId = d.apiId || 'openai', caseSensitive = d.caseSensitiveNames === true;
    const targetKey = name => presetTargetKey(d.account, apiId, name, caseSensitive);
    const operationKey = op => presetTargetKey(op.account, op.apiId, op.name, caseSensitive);
    // Once HTTP may have started, a local receipt failure must not turn into a second write.
    // The earlier armed receipt is retained for explicit read-only recovery.
    const record = op => { try { return journal.put(op); } catch (error) { return { ...op, receiptError: error.message }; } };
    const fail = (code, message, detail) => { throw presetError(code, message, detail); };
    const identity = input => {
        const current = d.current();
        if (!current || current.account !== d.account || input?.account !== d.account) fail('PRESET_ACCOUNT_CHANGED', '换了账号，草稿留在原账号');
        if (input?.name !== undefined && input.name !== current.name) fail('PRESET_CHANGED', `已切到「${current.name}」，原预设的草稿还在`);
        return current;
    };
    const guarded = async (lease, action) => { d.assertLease(lease); await d.verifyAccount(); d.assertLease(lease);
        const value = await action(); d.assertLease(lease); await d.verifyAccount(); d.assertLease(lease); return value; };
    const read = (name, lease) => guarded(lease, () => d.readNamed(name));
    // The named preset only changes through a save (which reads it back itself) or from elsewhere. Opening the page,
    // an explicit re-read and saving read the server; the answer to a switch and refreshes after the app's own
    // events reuse a copy read in the last moments, since each read downloads every preset of the account.
    const NAMED_REUSE_MS = 15000;
    const namedCopies = new Map();
    async function readNamedFor(name, lease, fresh) {
        const copy = namedCopies.get(name);
        if (!fresh && copy && Date.now() - copy.at < NAMED_REUSE_MS) return clonePreset(copy.value);
        const value = await read(name, lease);
        if (value) namedCopies.set(name, { at: Date.now(), value: clonePreset(value) }); else namedCopies.delete(name);
        return value;
    }
    async function state(lease = d.makeLease(), { fresh = true } = {}) {
        const current = d.current();
        if (!current) return null;
        const named = await readNamedFor(current.name, lease, fresh);
        if (!named) fail('PRESET_MISSING', '这个预设文件不在了，设置先留着，请重新看看');
        if (!bases.has(current.name)) bases.set(current.name, clonePreset(named));
        const full = overlayPresetDocument(bases.get(current.name), current.full);
        let operations = [], storageError = '';
        try { operations = journal.list(d.account); } catch (error) { storageError = error.message; }
        return { ...clonePreset(current), full, named: clonePreset(named), changes: presetChanges(named, overlayPresetDocument(named, current.full)),
            apiId, targetKey: targetKey(current.name), caseSensitiveNames: caseSensitive,
            operations: operations.filter(op => op.apiId === apiId).map(op => ({ ...op, targetKey: operationKey(op) })), storageError,
            capabilities: { namedReadback: true, namedWrite: !storageError, copyAndUse: !storageError } };
    }
    function presetEditorState({ fresh = true } = {}) { return d.enqueue(() => state(undefined, { fresh })); }
    function presetEditorApplyPrompt(input) {
        identity(input); const captured = clonePreset(input), lease = d.makeLease();
        return d.enqueue(async () => {
            d.assertLease(lease); const current = identity(captured);
            const prompt = current.prompts.find(item => item.identifier === captured.identifier);
            if (!prompt?.canEdit) fail('PRESET_PROMPT_MISSING', '这个提示词不在了或不能改，原稿还在');
            const remote = prompt.content;
            if (remote !== captured.base && remote !== captured.text && !(['mine', 'server'].includes(captured.resolution?.take) && captured.resolution.server === remote)) {
                return { kind: 'conflict', conflicts: [{ key: 'content', label: '提示词内容', before: captured.base, mine: captured.text, server: remote }] };
            }
            if (captured.resolution?.take === 'server' && captured.resolution.server === remote) return { kind: 'confirmed', content: remote, applied: false };
            await guarded(lease, () => d.applyPrompt(captured.identifier, captured.text));
            const actual = identity(captured).prompts.find(item => item.identifier === captured.identifier);
            return actual?.content === captured.text ? { kind: 'confirmed', content: actual.content, applied: true }
                : { kind: 'unconfirmed', content: actual?.content, error: '应用时原版又改了，草稿还在，看一下' };
        });
    }
    function presetEditorSetField(input) {
        identity(input); const captured = clonePreset(input), lease = d.makeLease();
        return d.enqueue(async () => {
            d.assertLease(lease); identity(captured);
            const remote = d.fieldValue(captured.key);
            if (!samePreset(remote, captured.base) && !samePreset(remote, captured.value)) fail('PRESET_FIELD_CONFLICT', '这一项原版改过了，刷新后看一下', { key: captured.key, mine: captured.value, server: remote });
            await guarded(lease, () => d.applyField(captured.key, captured.value));
            if (!samePreset(d.fieldValue(captured.key), captured.value)) fail('PRESET_FIELD_UNCONFIRMED', '原版还没用上这个值，看一下现在的设置');
            return state(lease, { fresh: false });
        });
    }
    // Order and copies change the current configuration like a switch does. The page sends the order it showed; a
    // list changed meanwhile (in the full app, another tab) is not rearranged blindly.
    function presetEditorArrangePrompt(input) {
        identity(input); const captured = clonePreset(input), lease = d.makeLease();
        return d.enqueue(async () => {
            d.assertLease(lease); identity(captured);
            const order = () => d.current().prompts.map(prompt => prompt.identifier);
            if (!samePreset(order(), captured.order)) fail('PRESET_ORDER_CONFLICT', '条目顺序已在别处变化，请看一下现在的顺序再试');
            const from = captured.order.indexOf(captured.identifier);
            if (from < 0) fail('PRESET_PROMPT_MISSING', '这个条目不在了');
            const expected = [...captured.order];
            let created = '';
            if (captured.action === 'move') {
                const to = Math.max(0, Math.min(expected.length - 1, Math.trunc(Number(captured.to))));
                if (!Number.isFinite(to)) fail('PRESET_FIELD_INVALID', '没有选好要移到哪里');
                expected.splice(to, 0, expected.splice(from, 1)[0]);
                if (to !== from) await guarded(lease, () => d.movePrompt(captured.identifier, to));
            } else if (captured.action === 'copy') {
                created = uuid();
                expected.splice(from + 1, 0, created);
                await guarded(lease, () => d.copyPrompt(captured.identifier, created, String(captured.copyName || '')));
            } else fail('PRESET_FIELD_UNKNOWN', '这个操作请在原版调整');
            if (!samePreset(order(), expected)) fail('PRESET_FIELD_UNCONFIRMED', '原版还没用上新顺序，看一下现在的设置');
            return { ...(await state(lease, { fresh: false })), created };
        });
    }
    async function reconcile(op, lease) {
        const actual = await read(op.name, lease);
        const exact = actual !== null && samePreset(actual, op.expected);
        const outcome = classifySaveOutcome({ matchesExpected: exact, notSubmitted: op.writeOutcome === 'not-submitted' && op.notSubmittedProof?.kind === 'write-not-invoked' });
        const stage = outcome === 'confirmed' ? op.mode === 'copy' ? 'saved-not-applied' : 'confirmed' : outcome === 'not-submitted' ? 'not-submitted' : 'unconfirmed';
        const historical = hasPresetUserDecision(op) || op.writeOutcome === 'confirmed';
        // Current observation cannot rewrite a past confirmation into "never saved".
        op = record({ ...op, ...(historical ? {} : { stage, writeOutcome: outcome }), observation: { outcome, fingerprint: presetFingerprint(actual), at: Date.now() } });
        if (exact && !historical) { bases.set(op.name, clonePreset(actual)); namedCopies.set(op.name, { at: Date.now(), value: clonePreset(actual) }); await d.registerNamed(op.name, clonePreset(actual)); d.assertLease(lease); }
        return { kind: historical ? 'historical-observation' : stage, operation: op, name: op.name, actualCurrent: d.current()?.name, fileConfirmed: exact,
            observedChanged: !samePreset(actual, op.before) && !exact,
            ...(outcome === 'unknown' ? { error: '还不知道存没存上，上次的保存可能晚到。可以再检查、另存一个新名字，或者确认继续存这个名字' } : {}) };
    }
    async function useSavedCopy(op, lease, expectedCurrent) {
        const actual = await read(op.name, lease);
        if (!samePreset(actual, op.expected)) return { kind: 'conflict', operation: op, error: '副本存好后又变了，先检查一下', actualCurrent: d.current()?.name };
        const now = d.current();
        if (now.name !== expectedCurrent.name || !samePreset(now.full, expectedCurrent.full)) {
            op = record({ ...op, stage: 'saved-not-applied' });
            return { kind: 'saved-not-applied', operation: op, fileConfirmed: true, actualCurrent: now.name, error: '保存时设置又改了；副本已保存，还没切过去' };
        }
        await d.registerNamed(op.name, clonePreset(actual)); d.assertLease(lease);
        try {
            // Native preset application necessarily advances the preset epoch. The host checks
            // the account/document lease while awaiting its real application Promise.
            await d.useNamed(op.name, lease);
            d.assertAccount(lease); await d.verifyAccount(); d.assertAccount(lease);
            const current = d.current();
            if (current.name !== op.name || !d.matchesApplied(op.expected, current)) throw presetError('PRESET_APPLY_UNCONFIRMED', '副本已保存，但还没确认用上了');
            op = record({ ...op, stage: 'confirmed', writeOutcome: 'confirmed' });
            return { kind: 'confirmed', operation: op, name: op.name, fileConfirmed: true, applied: true, actualCurrent: current.name };
        } catch (error) {
            op = record({ ...op, stage: 'saved-not-applied' });
            return { kind: 'saved-not-applied', operation: op, name: op.name, fileConfirmed: true, actualCurrent: d.current()?.name, error: error.message };
        }
    }
    function presetEditorSave(input) {
        const current = identity(input), captured = clonePreset(current), lease = d.makeLease();
        let dispatched = false;
        return d.enqueue(async () => {
            d.assertLease(lease); identity(input);
            const copy = input.copyName !== undefined;
            const requestedName = copy ? validatePresetName(input.copyName) : captured.name;
            const name = await guarded(lease, () => d.canonicalName ? d.canonicalName(requestedName) : normalizePresetTargetName(requestedName));
            if (typeof name !== 'string' || !name || name !== requestedName) fail('INVALID_PRESET_NAME', '这个名字存下来会被改掉，换一个名字');
            if (journal.list(d.account).some(op => isBlockingPresetOperation(op) && operationKey(op) === targetKey(name))) fail('PRESET_SAVE_PENDING', '还不知道上次存没存上；先检查、另存一个新名字，或者确认继续存这个名字');
            if (copy) {
                const names = await guarded(lease, () => d.listNamed());
                if (names.some(item => targetKey(item) === targetKey(name))) fail('PRESET_NAME_EXISTS', '已有同名预设，换个名字（只改大小写不算）');
            }
            const original = await read(captured.name, lease);
            if (!original && !copy) fail('PRESET_MISSING', '原预设不在了，设置先留着');
            const base = bases.get(captured.name) || original || captured.full;
            const mine = overlayPresetDocument(base, captured.full);
            // A genuinely new target captures the user's current runtime. Changes
            // to the source named file must not close this escape from uncertainty.
            const merged = copy ? { kind: 'merged', snapshot: mine } : mergePresetDocument(base, mine, original, input.resolutions);
            if (merged.kind === 'conflict') return merged;
            const expected = merged.snapshot;
            // Only what recovery compares: the file to expect and the one it replaces (each a whole preset).
            let op = journal.put({ version: 2, id: uuid(), account: d.account, apiId, targetKey: targetKey(name), name, sourceName: captured.name, mode: copy ? 'copy' : 'save',
                stage: 'armed', writeOutcome: 'unknown', expected, before: copy ? null : original, writeSettled: null });
            try {
                // All asynchronous preflight occurs before the synchronous dispatch
                // boundary. A surviving armed receipt is never proof of non-dispatch.
                const latest = await read(name, lease);
                if (!samePreset(latest, op.before)) throw presetError('PRESET_BEFORE_CHANGED', '保存前预设文件变了，看一下再存');
                d.assertLease(lease); await d.verifyAccount(); d.assertLease(lease);
                const snapshot = clonePreset(expected);
                dispatched = true;
                const writing = d.writeNamed(name, snapshot);
                await writing;
                d.assertLease(lease); await d.verifyAccount(); d.assertLease(lease);
                op = record({ ...op, writeSettled: 'resolved' });
            }
            catch (error) {
                if (!dispatched) {
                    // This immutable zero-invocation fact belongs to the captured
                    // account/id even if its UI lease expired. Persist only this
                    // receipt (revision guarded), never current runtime/server data.
                    op = record({ ...op, stage: 'not-submitted', writeOutcome: classifySaveOutcome({ notSubmitted: true }),
                        notSubmittedProof: { kind: 'write-not-invoked' }, writeSettled: null, error: error.message });
                    try { d.assertLease(lease); } catch (leaseError) { leaseError.operation = op; leaseError.receiptPersisted = !op.receiptError; throw leaseError; }
                    return { kind: 'not-submitted', operation: op, receiptPersisted: !op.receiptError,
                        error: op.receiptError ? '这次没存，但也没记下结果；设置和草稿都还在'
                            : '这次没存，设置和草稿都还在，可以再试' };
                }
                d.assertLease(lease);
                op = record({ ...op, writeSettled: 'rejected', error: error.message });
            }
            let result;
            try { result = await reconcile(op, lease); }
            catch (error) { d.assertLease(lease); return { kind: 'unconfirmed', operation: record({ ...op, stage: 'unconfirmed', writeOutcome: 'unknown' }), error: '还不知道存没存上；先检查一下，也可以另存一个新名字' }; }
            if (result.fileConfirmed && copy) {
                const originalAfter = await read(captured.name, lease);
                const used = await useSavedCopy(result.operation, lease, captured);
                return { ...used, originalUnchanged: samePreset(originalAfter, original) };
            }
            return result;
        }).catch(error => { if (!dispatched) error.saveOutcome = 'not-submitted'; throw error; });
    }
    const requireOperation = (input, lease) => {
        d.assertLease(lease);
        const op = journal.get(input.account, input.operationId);
        if (!op || op.account !== d.account || op.apiId !== apiId || typeof op.name !== 'string') fail('PRESET_OPERATION_MISSING', '没找到当前账号的保存记录');
        return op;
    };
    function presetEditorRecover(input) {
        identity({ account: input.account }); const lease = d.makeLease();
        return d.enqueue(async () => {
            const op = requireOperation(input, lease);
            return reconcile(op, lease);
        });
    }
    const decisionBasis = actual => ({ kind: actual === null ? 'missing' : 'present', fingerprint: presetFingerprint(actual) });
    function presetEditorPrepareDecision(input) {
        identity({ account: input.account }); const lease = d.makeLease();
        return d.enqueue(async () => {
            const op = requireOperation(input, lease);
            if (!isBlockingPresetOperation(op)) fail('PRESET_DECISION_UNNEEDED', '这次保存已经有结果了，请重新加载');
            const actual = await read(op.name, lease), currentOp = requireOperation(input, lease);
            if (currentOp.revision !== op.revision) fail('PRESET_RECEIPT_CHANGED', '保存记录变了，请重新检查');
            return { kind: 'decision-preview', account: d.account, operationId: op.id, operation: op, expectedRevision: op.revision,
                basis: decisionBasis(actual), changes: presetChanges(op.expected, actual), serverSnapshot: clonePreset(actual) };
        });
    }
    function presetEditorDecide(input) {
        identity({ account: input.account }); const lease = d.makeLease();
        return d.enqueue(async () => {
            const op = requireOperation(input, lease);
            if (input.acknowledgement !== PRESET_DECISION_ACK) fail('PRESET_DECISION_ACK', '先确认：上次的保存可能晚到并盖掉');
            if (!isBlockingPresetOperation(op) || op.revision !== input.expectedRevision) fail('PRESET_RECEIPT_CHANGED', '保存记录变了，请重新检查');
            const actual = await read(op.name, lease);
            if (!samePreset(decisionBasis(actual), input.basis)) fail('PRESET_DECISION_CHANGED', '酒馆里的内容变了，请重新确认');
            const operation = journal.decide(op, decisionBasis(actual), input.acknowledgement, () => { d.assertLease(lease); identity({ account: input.account }); });
            return { kind: 'user-decided', operation, name: op.name, fileConfirmed: false,
                error: '已记下，可以接着改；上次的保存可能晚到并盖掉。设置和草稿都没动' };
        });
    }
    function presetEditorUseCopy(input) {
        const current = identity(input), captured = clonePreset(current), lease = d.makeLease();
        return d.enqueue(async () => {
            const op = requireOperation(input, lease);
            if (!op || op.mode !== 'copy') fail('PRESET_OPERATION_MISSING', '没找到当前账号的副本记录');
            return useSavedCopy(op, lease, captured);
        });
    }
    function presetEditorSelect(input) {
        identity(input); const lease = d.makeLease();
        return d.enqueue(async () => {
            const target = await read(input.target, lease);
            if (!target) fail('PRESET_MISSING', '要切的预设不在了');
            await d.registerNamed(input.target, clonePreset(target)); d.assertLease(lease);
            await d.useNamed(input.target, lease); d.assertAccount(lease);
            const current = d.current();
            if (current.name !== input.target || !d.matchesApplied(target, current)) fail('PRESET_APPLY_UNCONFIRMED', '还没确认切过去，看一下现在用的是哪个');
            return state();
        });
    }
    return { presetEditorState, presetEditorApplyPrompt, presetEditorSetField, presetEditorArrangePrompt, presetEditorSave, presetEditorRecover, presetEditorUseCopy, presetEditorSelect, presetEditorPrepareDecision, presetEditorDecide };
}
