import { buildEpisodeFile, unreviewedMetadataKeys, canonicalJson, cloneJson, EPISODE_NAMESPACE, episodeError, fingerprintChat, locatorKey, normalizeLocator, resolveEpisodeGraph, sameLocator, sameOperationIdentity, sha256, validateEpisodeMeta } from './src/episode-model.js';

const err = (code, message) => episodeError(code, message);
const completed = new Set(['confirmed', 'cancelled', 'conflict', 'dismissed']);
// Stages after the request may have reached the model. Only these can be settled by looking at the line itself.
const afterSubmit = new Set(['submit-armed', 'accepted', 'generated', 'saving', 'save-unconfirmed']);
// Ended records are kept this long for a look back, then deleted (src/episode-journal.js pruneSettled).
const SETTLED_KEEP_MS = 10 * 60 * 1000;
// A story's size: exact once fingerprinted, otherwise the JSON text length (close enough for choosing what to keep).
const storyBytes = file => file?.fingerprint?.utf8Bytes ?? JSON.stringify(file?.messages ?? []).length;
const preSubmit = new Set(['captured', 'source-confirmed', 'created', 'awaiting-review', 'continue-ready']);
const receipt = op => sha256(canonicalJson({ id: op.operationId, revision: op.revision, text: op.capturedText,
    target: op.target, resolvedLocator: op.resolvedLocator, context: op.contextMode, source: op.sourceFingerprint, opened: op.openedFingerprint }));
const label = op => `${{ side: '番外', parallel: '平行线', skit: '小剧场' }[op.kind] || '番外'} · ${op.title}`;

/** All effects use the caller's existing native-chat queue. No public queued method calls another queued method. */
// What the app adds to a story when it opens it and saves only with the next message: a greeting's swipe list, the
// author's note defaults, an empty timed world-info record (and an integrity id for a file that had none). Returns every
// other unsaved difference, such as an edit or a timed world-info entry, which is the app's to save and not ours.
const OPENING_MESSAGE_KEYS = new Set(['swipes', 'swipe_id', 'swipe_info']);
const emptyRecord = value => !!value && typeof value === 'object' && Object.values(value).every(v => v && typeof v === 'object' && !Object.keys(v).length);
export function unsavedBeyondOpening(saved, current) {
    const same = (x, y) => x === y || (x !== undefined && y !== undefined && canonicalJson(x) === canonicalJson(y));
    const keys = (x, y) => new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})]);
    const a = saved?.messages ?? [], b = current?.messages ?? [];
    if (a.length !== b.length) return ['messages'];
    const out = [];
    a.forEach((m, i) => {
        const n = b[i];
        for (const key of keys(m, n)) {
            if (same(m?.[key], n?.[key])) continue;
            if (OPENING_MESSAGE_KEYS.has(key) && !(key in (m ?? {})) && !n?.is_user) continue;
            out.push(`messages.${i}.${key}`);
        }
    });
    const ma = saved?.header?.chat_metadata ?? {}, mb = current?.header?.chat_metadata ?? {};
    for (const key of keys(ma, mb)) {
        if (same(ma[key], mb[key])) continue;
        if (!(key in ma) && (key.startsWith('note_') || key === 'integrity' || (key === 'timedWorldInfo' && emptyRecord(mb[key])))) continue;
        out.push(`chat_metadata.${key}`);
    }
    return out;
}

export function createEpisodeFlow(d) {
    const { journal, native } = d;
    const jobs = new Map(), draftGuards = new Map(), renamePending = new Map();
    const operationKey = (account, operationId) => JSON.stringify([account, String(operationId).toLowerCase()]);
    const snapshotBytes = d.snapshotBytes ?? 1_000_000;
    /**
     * What the journal keeps of a story. A short one whole; a long one only by what identifies it (locator, header,
     * fingerprint, message count) plus `keep`. Every journal step rewrites the whole record, and the copies of a 15MB
     * story made each send slow enough for the phone to stop the page, and filled the device.
     */
    function journalCopy(file, keep) {
        if (!file || storyBytes(file) <= snapshotBytes) return file;
        return { locator: file.locator, header: file.header, ...(file.fingerprint ? { fingerprint: file.fingerprint } : {}),
            messageCount: file.messages.length, slim: true, ...keep };
    }
    // A long story's initial content is known by the fingerprint recorded when it was created or chosen.
    const initialHash = async op => op.initialFile?.slim ? op.initialFingerprint : (await fingerprintChat(op.initialFile)).hash;
    const messageCount = file => file?.messageCount ?? file?.messages?.length;
    function checkDraftGuard(callback, text, revision, locator) {
        if (typeof callback !== 'function') throw err('REVIEW_STALE', '先找回草稿看一遍再发送');
        const result = callback({ text, draftRevision: revision, locator });
        if (result !== true) throw err('DRAFT_CHANGED', '草稿变了，请再看一遍');
    }
    const sourceLocator = scope => {
        if (scope?.account !== undefined && scope.account !== d.account) throw err('ACCOUNT_CHANGED', '换了账号');
        return normalizeLocator({ ...scope, account: d.account });
    };
    const isCurrentTarget = scope => !!scope?.avatar && !!scope?.file && !!d.currentLocator()?.avatar && !!d.currentLocator()?.file &&
        sameLocator(sourceLocator(scope), sourceLocator(d.currentLocator()));
    async function transition(op, patch) {
        return journal.transition({ account: op.account, operationId: op.operationId, expectedRevision: op.revision, expectedStage: op.stage, patch });
    }
    async function read(locator, lease) {
        const result = await native.readFullChat(locator, lease);
        if (result.kind !== 'present') throw err('CHAT_UNREADABLE', '故事暂时没加载全，再试一次');
        const file = result.file;
        file.fingerprint ||= await fingerprintChat(file);
        return file;
    }
    async function currentSource(scope, lease) {
        await d.waitStable();
        const locator = sourceLocator(scope);
        if (!sameLocator(locator, sourceLocator(d.currentLocator()))) throw err('STORY_CHANGED', '故事已切换，文字还在');
        const check = async file => {
            if (await d.assertSourceCurrent({ source: { locator }, sourceFingerprint: file.fingerprint.hash, sourceSnapshot: file }, lease) === false) throw err('SOURCE_CHANGED', '原故事还没确认');
            return file;
        };
        const file = await read(locator, lease);
        try { return await check(file); }
        catch (error) {
            // Opening a story adds things the app only saves with the next message (a new story's greeting swipes,
            // default notes): save it as the app would, once, and check again instead of waiting for a save that never
            // comes. Any other unsaved change stops here, as before.
            if (error.code !== 'SOURCE_UNCONFIRMED' || !d.saveCurrent) throw error;
            const unsaved = unsavedBeyondOpening(file, d.currentFull(file));
            if (unsaved.length) { error.unsaved = unsaved; throw error; }
            await d.saveCurrent(lease); await d.waitStable();
            return check(await read(locator, lease));
        }
    }
    const requireEnabled = targetFile => {
        const status = d.status(targetFile);
        if (!status.enabled) throw err('EPISODES_DISABLED', '「分开写番外与平行线」已关闭，写好的都还在');
        if (!status.verified) throw err('CONFIG_UNVERIFIED', `现在不能自动分开写：${status.reasons.join('；')}`);
        return status;
    };
    async function index(avatar, lease) {
        const list = await native.listChatHeaders({ account: d.account, avatar }, lease);
        const graph = resolveEpisodeGraph(list.entries, { account: d.account, avatar });
        for (const node of graph.nodes) {
            const root = graph.roots.find(x => x.episode?.episodeId === node.episode.rootId || String(x.metadata?.integrity).toLowerCase() === node.episode.rootId || sameLocator(x.locator, node.rootLocator));
            if (root && node.relationship === 'resolved') node.rootLocator = root.locator;
        }
        return { ...graph, ...list };
    }
    async function parentProof(source, lease) {
        const meta = validateEpisodeMeta(source.header.chat_metadata?.[EPISODE_NAMESPACE], d.account);
        if (meta.kind === 'absent' || meta.kind === 'valid' && meta.value.kind === 'root') return cloneJson(source);
        const graph = await index(source.locator.avatar, lease);
        const node = graph.nodes.find(n => sameLocator(n.locator, source.locator));
        if (node?.relationship !== 'resolved' || !node.rootLocator) throw err('SOURCE_MISSING', '原故事找不到或有重复记录，先检查一下');
        return read(node.rootLocator, lease);
    }
    function checkInput(input) {
        if (input.account !== d.account || typeof input.text !== 'string' || !input.text.trim() || !Number.isSafeInteger(input.draftRevision) || input.draftRevision < 0) throw err('INVALID_INTENT', '信息不全，请重新打开');
    }
    async function capture(input, source, target, extra) {
        checkDraftGuard(input.assertDraft, input.text, input.draftRevision, source.locator);
        const { parentSnapshot, initialFile, ...rest } = extra, range = extra.extractRange;
        // Operation recovery owns its captured copy; Reader owns its independent revision and ordinary draft store.
        const operation = await journal.captureIntent({ account: d.account, operationId: extra.operationId, source: { locator: source.locator }, target,
            capturedText: input.text, draftRevision: input.draftRevision, sourceFingerprint: source.fingerprint.hash,
            sourceSnapshot: journalCopy(source, range ? { rangeMessages: source.messages.slice(range.from, range.to + 1) } : undefined),
            cancelId: d.uuid(), ...rest,
            ...(parentSnapshot ? { parentSnapshot: journalCopy(parentSnapshot) } : {}), ...(initialFile ? { initialFile: journalCopy(initialFile) } : {}) });
        draftGuards.set(operationKey(d.account, extra.operationId), input.assertDraft);
        return operation;
    }
    function reviewed(op) {
        return { operation: op, target: op.resolvedLocator ?? op.target.locator, reviewReceipt: receipt(op), label: label(op), contextMode: op.contextMode,
            carriedMetadataKeys: op.carriedMetadataKeys ?? [] };
    }
    function prepareEpisode(input) {
        return d.enqueue(async () => {
            checkInput(input); checkDraftGuard(input.assertDraft, input.text, input.draftRevision, sourceLocator(input.scope));
            const status = requireEnabled(), lease = d.makeLease();
            if (!['side', 'parallel', 'skit'].includes(input.kind) || !['continued', 'fresh'].includes(input.contextMode)) throw err('INVALID_INTENT', '请选类型和要不要带上正文');
            await assertCanLeave(lease);
            const source = await currentSource(input.scope, lease);
            const root = await native.resolveRoot({ source, newRootId: d.uuid() }, lease);
            if (root.kind !== 'resolved') throw err('ROOT_UNCONFIRMED', '正文还没确认或有重复，没有创建');
            const operationId = d.uuid(), ids = { operationId, episodeId: d.uuid(), integrity: d.uuid(), rootId: root.rootId, parentId: root.parentId, file: `tl-episode-${d.uuid()}` };
            const title = String(input.title || input.text).trim().replace(/\s+/g, ' ').slice(0, 100);
            // Other extensions' state in the story comes along, as with the app's own branches; the review shows it.
            const policy = { ...status, carryUnreviewedMetadata: true };
            const carried = input.contextMode === 'continued' ? unreviewedMetadataKeys(source.header.chat_metadata, policy) : [];
            const initialFile = buildEpisodeFile({ source, ids, intent: { kind: input.kind, title, openingRequest: input.text, contextMode: input.contextMode, sourceIdentityKind: root.sourceIdentityKind, createdAt: new Date().toISOString(),
                carryVariables: input.carryVariables === true }, policy });
            let op = await capture(input, source, { ...ids, locator: initialFile.locator, creationOperationId: operationId },
                { operationId, action: 'create', kind: input.kind, title, contextMode: input.contextMode, parentSnapshot: source, initialFile,
                    ...(carried.length ? { carriedMetadataKeys: carried } : {}) });
            op = await transition(op, { stage: 'source-confirmed' });
            const result = await native.createOrRecoverTarget({ account: d.account, operationId, initialFile,
                assertIntentCurrent: () => checkDraftGuard(input.assertDraft, input.text, input.draftRevision, source.locator) }, lease);
            op = result.operation ?? await journal.readOperation(d.account, operationId);
            if (!['created', 'recovered'].includes(result.kind) || result.creationEvidence?.initialContent === 'advanced-or-different') return { ...result, operation: op };
            if (op.stage === 'created') op = await transition(op, { stage: 'awaiting-review' });
            return reviewed(op);
        });
    }
    function prepareEpisodeContinuation(input) {
        return d.enqueue(async () => {
            checkInput(input); checkDraftGuard(input.assertDraft, input.text, input.draftRevision, sourceLocator(input.scope));
            requireEnabled(); const lease = d.makeLease();
            await assertCanLeave(lease);
            const source = await currentSource(input.scope, lease), targetFile = await read(sourceLocator(input.target), lease);
            requireEnabled(targetFile);
            const meta = validateEpisodeMeta(targetFile.header.chat_metadata?.[EPISODE_NAMESPACE], d.account);
            if (meta.kind !== 'valid' || meta.value.ownerAccount !== d.account || meta.value.kind === 'root') throw err('INVALID_IDENTITY', '这条线不属于当前账号');
            const graph = await index(targetFile.locator.avatar, lease), node = graph.nodes.find(x => sameLocator(x.locator, targetFile.locator));
            if (!graph.complete || node?.relationship !== 'resolved') throw err('INVALID_IDENTITY', '这条线的来源还没确认，不能接着写');
            const parent = await parentProof(targetFile, lease), operationId = d.uuid();
            let op = await capture(input, source, { locator: targetFile.locator, episodeId: meta.value.episodeId, rootId: meta.value.rootId,
                parentId: meta.value.parentId, integrity: targetFile.header.chat_metadata.integrity, creationOperationId: meta.value.creationOperationId },
                { operationId, action: 'continue', kind: meta.value.kind, title: meta.value.title, contextMode: meta.value.contextMode,
                    parentSnapshot: parent, initialFile: targetFile });
            op = await transition(op, { stage: 'source-confirmed' });
            op = await transition(op, { stage: 'continue-ready' });
            op = await transition(op, { stage: 'created', initialFingerprint: targetFile.fingerprint.hash });
            op = await transition(op, { stage: 'awaiting-review' });
            return reviewed(op);
        });
    }
    async function parentUnchanged(op, lease) {
        if (!op.parentSnapshot || sameLocator(op.parentSnapshot.locator, op.target.locator)) return;
        const now = await read(op.parentSnapshot.locator, lease);
        if (now.fingerprint.hash !== op.parentSnapshot.fingerprint.hash) {
            try { d.onIsolationFailure?.({ operationId: op.operationId, locator: now.locator, expectedFingerprint: op.parentSnapshot.fingerprint.hash, observedFingerprint: now.fingerprint.hash }); } catch {}
            throw err('PARENT_CHANGED', '写的时候正文变了，请分别看看两个故事');
        }
    }
    function sendEpisode({ account, operationId, reviewReceipt, onState, assertDraft }) {
        const jobKey = operationKey(account, operationId);
        if (jobs.has(jobKey)) return jobs.get(jobKey).promise;
        const job = { submitted: false, cancelled: false };
        const report = (stage, op, error) => { try { onState?.({ stage, operation: op, target: op?.resolvedLocator ?? op?.target?.locator, error }); } catch {} };
        const check = () => { if (job.cancelled) throw err('CANCELLED', '已取消，文字和建好的那条都还在'); };
        const promise = d.enqueue(async () => {
            let op = await journal.readOperation(account, operationId), lease = d.makeLease(), nativeRun;
            if (!op || account !== d.account || op.stage !== 'awaiting-review' || reviewReceipt !== receipt(op)) throw err('REVIEW_STALE', '那条线或草稿变了，再看一遍再发送');
            try {
                check(); requireEnabled(op.initialFile);
                const checkDraft = () => checkDraftGuard(assertDraft ?? draftGuards.get(jobKey), op.capturedText, op.draftRevision, op.source.locator);
                checkDraft();
                if (await d.assertSourceCurrent(op, lease) === false) throw err('SOURCE_CHANGED', '原故事还没确认'); check();
                const found = await native.recoverTarget({ account, operationId }, lease);
                if (found.kind !== 'recovered' && found.kind !== 'created') throw err('TARGET_UNCONFIRMED', '找到不止一条，没有发送');
                const target = found.file, baseline = await initialHash(op);
                if (!sameLocator(target.locator, op.resolvedLocator ?? op.target.locator)) throw err('REVIEW_STALE', '那个故事改名了，重新确认发到哪再发送');
                if (target.fingerprint.hash !== baseline) throw err('TARGET_CHANGED', '那条线有新进展，打开它再接着写');
                await d.ensureConnected(); check();
                if (await d.assertSourceCurrent(op, lease) === false) throw err('SOURCE_CHANGED', '原故事还没确认'); check();
                await assertCanLeave(lease); check();
                await d.switchChat(target.locator); await d.waitStable(); check();
                d.assertLease(lease);
                if (!sameLocator(sourceLocator(d.currentLocator()), target.locator)) throw err('STORY_CHANGED', '还没切过去，没有发送');
                const opened = d.currentFull(target);
                opened.fingerprint = await fingerprintChat(opened);
                await parentUnchanged(op, lease); check();
                const diskBefore = await read(target.locator, lease);
                op = await transition(op, { openedFingerprint: opened.fingerprint.hash, resolvedLocator: target.locator });
                // Native initialization may add greeting/default author-note state. This snapshot is distinct from creation evidence.
                op = await transition(op, { stage: 'submit-armed', recoverySnapshot: journalCopy(opened) });
                check(); d.assertLease(lease); await d.verifyAccount(); checkDraft(); check(); requireEnabled(op.initialFile);
                const before = d.currentFull(opened);
                let finished = false, failure = null;
                // Last synchronous boundary: no callback/await may switch or cancel between this and native submission.
                d.assertLease(lease); checkDraft(); check();
                if (!sameLocator(sourceLocator(d.currentLocator()), target.locator)) throw err('STORY_CHANGED', '发送前页面变了，没有发送');
                job.submitted = true;
                nativeRun = Promise.resolve(d.submit(op.capturedText)).catch(error => { failure = error; }).finally(() => { finished = true; });
                report('submitted', op);
                const accepted = await d.waitFor(() => finished || d.currentLength() > before.messages.length, 15000);
                let acceptedSnapshot = null;
                if (accepted && d.currentLength() > before.messages.length) {
                    d.assertLease(lease);
                    if (!sameLocator(sourceLocator(d.currentLocator()), target.locator)) throw err('STORY_CHANGED', '发送时页面变了，还不知道发没发出');
                    acceptedSnapshot = d.currentFull(opened);
                    op = await transition(op, { stage: 'accepted' }); report('accepted', op);
                }
                await nativeRun; await d.waitStable(); d.assertLease(lease); await d.verifyAccount();
                if (!sameLocator(sourceLocator(d.currentLocator()), target.locator)) throw err('STORY_CHANGED', '发送时页面变了，还不知道发没发出');
                if (op.stage !== 'accepted') throw failure ?? err('SUBMISSION_UNCONFIRMED', '还不知道发没发出，先去看看那个故事，别重复发送');
                op = await transition(op, { stage: 'generated' }); report('generated', op, failure?.message);
                const expected = d.currentFull(opened);
                expected.fingerprint = await fingerprintChat(expected);
                const expectedFingerprint = expected.fingerprint.hash;
                const allowedPrior = [diskBefore, opened, ...(acceptedSnapshot ? [acceptedSnapshot] : [])];
                // diskBefore and opened were fingerprinted when read; only the accepted snapshot is new.
                const beforeFingerprints = await Promise.all(allowedPrior.map(async file => file.fingerprint?.hash ?? (await fingerprintChat(file)).hash));
                const kept = journalCopy(expected);
                // A long story keeps only the messages written by this send; a later re-save rebuilds the rest from the
                // line as it was before sending and refuses unless the rebuilt story has exactly this fingerprint.
                const saveIntent = kept.slim ? { header: expected.header, prefixCount: before.messages.length, tail: expected.messages.slice(before.messages.length), expectedFingerprint, beforeFingerprints }
                    : { expected, prefixCount: before.messages.length, expectedFingerprint, beforeFingerprints };
                op = await transition(op, { stage: 'saving', saveIntent, recoverySnapshot: kept }); report('saving', op);
                const confirmation = await native.confirmTarget({ account, operationId, locator: target.locator, expectedFingerprint }, lease);
                await parentUnchanged(op, lease);
                if (confirmation.kind !== 'confirmed') {
                    op = await transition(op, { stage: 'save-unconfirmed', error: failure?.message || '写完了，但还没确认存好' });
                    report('save-unconfirmed', op); return { kind: 'unconfirmed', operation: op, target: target.locator };
                }
                op = await transition(op, { stage: 'confirmed', confirmation: confirmation.confirmation });
                draftGuards.delete(jobKey);
                report('confirmed', op, failure?.message); return { kind: 'confirmed', operation: op, target: target.locator, ...(failure ? { generationError: failure.message } : {}) };
            } catch (error) {
                if (job.submitted && ['ACCOUNT_CHANGED', 'ACCOUNT_UNCONFIRMED'].includes(error.code)) error = err(error.code,
                    '发送时换了账号，内容可能写进了另一个账号。轻酒馆不会去找或自动删除，请登录那个账号看一下');
                if (op && !completed.has(op.stage)) {
                    const stage = job.submitted ? 'save-unconfirmed' : job.cancelled ? 'cancelled' : 'conflict';
                    const cancellationProof = job.cancelled && !job.submitted && op.stage === 'submit-armed' ? { kind: 'native-not-called', cancelId: op.cancelId } : undefined;
                    try { op = await transition(op, { stage, error: error.message, ...(cancellationProof ? { cancellationProof } : {}) }); } catch { /* Preserve the last committed journal stage, never imply success. */ }
                }
                report(job.submitted ? 'save-unconfirmed' : 'failed', op, error.message);
                throw error;
            } finally {
                // Acceptance or a failing observer/journal write must never release the native queue early.
                if (nativeRun) {
                    await nativeRun;
                    try { d.assertLease(lease); await d.waitStable(); } catch { /* The old native run has still settled. */ }
                }
            }
        }, { generating: true });
        promise.cancel = () => { if (job.submitted || job.cancelled) return false; job.cancelled = true; return true; };
        job.promise = promise; jobs.set(jobKey, job);
        promise.finally(() => jobs.delete(jobKey)).catch(() => {});
        return promise;
    }
    function recoverEpisode({ account, operationId }) {
        return d.enqueue(async () => {
            const lease = d.makeLease(), result = await native.recoverTarget({ account, operationId }, lease);
            const op = result.operation;
            // Refresh is strictly read-only with respect to model and chat creation.
            return { ...result, ...(op?.stage === 'awaiting-review' ? reviewed(op) : {}) };
        });
    }
    function reviewRecoveredEpisode({ account, operationId, assertDraft }) {
        return d.enqueue(async () => {
            requireEnabled();
            const lease = d.makeLease();
            let op = await journal.readOperation(account, operationId);
            if (account !== d.account || !op || !['created', 'awaiting-review'].includes(op.stage)) throw err('REVIEW_STALE', '先检查结果；发过的不会重新发送');
            checkDraftGuard(assertDraft, op.capturedText, op.draftRevision, op.source.locator);
            if (await d.assertSourceCurrent(op, lease) === false) throw err('SOURCE_CHANGED', '原故事还没确认');
            const found = await native.recoverTarget({ account, operationId }, lease);
            op = found.operation ?? op;
            if (!['recovered', 'created'].includes(found.kind) || !found.file ||
                found.file.fingerprint.hash !== await initialHash(op)) throw err('TARGET_CHANGED', '那个故事变了或有重复，先去看看');
            d.assertLease(lease);
            checkDraftGuard(assertDraft, op.capturedText, op.draftRevision, op.source.locator);
            op = await transition(op, { stage: 'awaiting-review', resolvedLocator: found.file.locator });
            draftGuards.set(operationKey(account, operationId), assertDraft);
            return reviewed(op);
        });
    }
    function confirmEpisodeSave({ account, operationId }) {
        return d.enqueue(async () => {
            const lease = d.makeLease();
            let op = await journal.readOperation(account, operationId);
            if (account !== d.account || !op || !['saving', 'save-unconfirmed'].includes(op.stage) || !op.saveIntent) throw err('NO_SAVE_SNAPSHOT', '没法安全补存，先去看看那个故事里的内容；不会重新生成');
            const locator = op.resolvedLocator ?? op.target.locator, intent = op.saveIntent;
            try {
            let confirmation = await native.confirmTarget({ account, operationId, locator, expectedFingerprint: intent.expectedFingerprint }, lease);
            if (confirmation.kind !== 'confirmed') {
                const observed = await read(locator, lease);
                if (!sameOperationIdentity(observed.header.chat_metadata?.[EPISODE_NAMESPACE], op) || !intent.beforeFingerprints.includes(observed.fingerprint.hash)) throw err('SAVE_CONFLICT', '那个故事有新改动，两边都留着，不覆盖');
                let expected = intent.expected;
                if (!expected) {
                    expected = { locator: observed.locator, header: intent.header, messages: [...observed.messages.slice(0, intent.prefixCount), ...intent.tail] };
                    if (observed.messages.length < intent.prefixCount || (await fingerprintChat(expected)).hash !== intent.expectedFingerprint) {
                        throw err('NO_SAVE_SNAPSHOT', '这条线太长，没留整份副本，补存不了。打开那条线看看，写好的多半已经在里面；不会重新生成');
                    }
                }
                op = await transition(op, { stage: 'saving' });
                await d.saveExact(expected, lease);
                confirmation = await native.confirmTarget({ account, operationId, locator, expectedFingerprint: intent.expectedFingerprint }, lease);
            }
            await parentUnchanged(op, lease);
            if (confirmation.kind !== 'confirmed') {
                op = await transition(op, { stage: 'save-unconfirmed', error: '还没确认存好' });
                return { kind: 'unconfirmed', operation: op, target: locator };
            }
            op = await transition(op, { stage: 'confirmed', confirmation: confirmation.confirmation });
            return { kind: 'confirmed', operation: op, target: locator };
            } catch (error) {
                if (['saving', 'save-unconfirmed'].includes(op.stage)) {
                    try { op = await transition(op, { stage: 'save-unconfirmed', error: error.message }); } catch {}
                }
                throw error;
            }
        });
    }
    function cancelEpisode({ account, operationId }) {
        const job = jobs.get(operationKey(account, operationId));
        if (job && !job.cancelled && !job.promise.cancel()) return Promise.reject(err('ALREADY_SUBMITTED', '已经发出，撤不回了；去「需要你看一下」里看看'));
        return d.enqueue(async () => {
            const op = await journal.readOperation(account, operationId);
            if (account === d.account && op?.stage === 'cancelled') return op;
            if (account !== d.account || !op || !preSubmit.has(op.stage)) throw err('ALREADY_SUBMITTED', '现在只能查看或补存');
            return transition(op, { stage: 'cancelled' });
        });
    }
    /**
     * A send whose page was stopped (the phone suspends a page left in the background) or whose last check never
     * finished stays half-way in the journal, and nothing else picks it up. Settle it by looking at the line, read-only:
     * the line saved exactly as recorded, or holding the author's request with a reply after it, means it landed.
     * Anything else stays for the author. A parent check is not repeated: by now the story may rightly have moved on.
     */
    async function settleOne(op, lease) {
        const file = await read(op.resolvedLocator ?? op.target.locator, lease);
        if (!sameOperationIdentity(file.header.chat_metadata?.[EPISODE_NAMESPACE], op)) return null;
        let evidence = op.saveIntent && file.fingerprint.hash === op.saveIntent.expectedFingerprint ? 'saved-as-recorded' : null;
        if (!evidence) {
            // Messages before this send: from the save record once there is one (the snapshot then holds the result).
            const before = op.saveIntent?.prefixCount ?? (op.saveIntent ? undefined : messageCount(op.recoverySnapshot));
            const later = file.messages.slice(before ?? 0), wanted = op.capturedText.trim();
            const asked = later.findIndex(m => m?.is_user && String(m.mes ?? '').trim() === wanted);
            if (asked >= 0 && later.slice(asked + 1).some(m => !m?.is_user && String(m?.mes ?? '').trim())) evidence = 'reply-in-line';
        }
        if (!evidence) return null;
        return transition(op, { stage: 'dismissed', resolution: { kind: 'landed', evidence, messages: file.messages.length, at: Date.now() } });
    }
    function settleEpisodes() {
        return d.enqueue(async () => {
            const lease = d.makeLease(), settled = [];
            for (const op of await journal.listUnfinished(d.account)) {
                if (!afterSubmit.has(op.stage) || jobs.has(operationKey(op.account, op.operationId))) continue;
                try { const next = await settleOne(op, lease); if (next) settled.push(next); } catch { /* Left for the author to look at. */ }
            }
            try { await journal.pruneSettled?.(SETTLED_KEEP_MS); } catch { /* Old records only cost space. */ }
            return settled;
        });
    }
    // The author has looked and sets a record aside. Nothing in any story changes, and it never counts as saved.
    function dismissEpisode({ account, operationId }) {
        if (jobs.has(operationKey(account, operationId))) return Promise.reject(err('STILL_RUNNING', '这次还没结束，等它结束再移出'));
        return d.enqueue(async () => {
            const op = await journal.readOperation(account, operationId);
            if (account !== d.account || !op) throw err('OPERATION_MISSING', '没找到这条记录');
            if (op.stage === 'dismissed') return op;
            if (preSubmit.has(op.stage)) throw err('NOT_SENT', '这次还没发出，点「取消，把文字放回原来的输入框」');
            return transition(op, { stage: 'dismissed', resolution: { kind: 'user', at: Date.now() } });
        });
    }
    async function assertCanLeave(lease) {
        const current = d.currentLocator();
        if (!current?.avatar || !current?.file) return;
        const meta = d.currentMetadata()?.[EPISODE_NAMESPACE];
        if (!meta) return;
        await currentSource(current, lease);
        const pending = await journal.listUnfinished(d.account);
        if (pending.some(op => !preSubmit.has(op.stage) && !completed.has(op.stage) && sameLocator(op.resolvedLocator ?? op.target.locator, sourceLocator(current)))) throw err('SAVE_UNCONFIRMED', '这条线有一次发送还没核对完，先在「番外与平行线」的「需要你看一下」里看看再切换');
    }
    function openEpisode(input) {
        return d.enqueue(async () => {
            if (input.account !== d.account) throw err('ACCOUNT_CHANGED', '换了账号');
            const lease = d.makeLease(), alreadyCurrent = isCurrentTarget(input);
            if (!alreadyCurrent) await assertCanLeave(lease);
            const file = await read(sourceLocator(input), lease), graph = await index(input.avatar, lease);
            const ownership = validateEpisodeMeta(file.header.chat_metadata?.[EPISODE_NAMESPACE], d.account);
            if (ownership.kind === 'foreign-owner') throw err('ACCOUNT_CHANGED', '这条线属于别的账号，不关联');
            const node = graph.nodes.find(x => sameLocator(x.locator, file.locator));
            if (node?.episode?.ownerAccount !== undefined && node.episode.ownerAccount !== d.account) throw err('ACCOUNT_CHANGED', '这条线属于别的账号，不关联');
            // Align the shell with the current target without re-opening and destroying unconfirmed native memory.
            if (!alreadyCurrent) { await d.switchChat(file.locator); await d.waitStable(); }
            return d.currentLocator();
        });
    }
    function renameEpisode(input) {
        return d.enqueue(async () => {
            const locator = sourceLocator(input), lease = d.makeLease(), key = locatorKey(locator);
            if (input.account !== d.account) throw err('ACCOUNT_CHANGED', '换了账号');
            if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 100 ||
                input.kind !== undefined && !['side', 'parallel', 'skit'].includes(input.kind)) throw err('INVALID_INTENT', '标题要 1 到 100 个字，并选一个类型');
            const title = input.title.trim();
            await d.waitStable(); d.assertLease(lease);
            const original = await read(locator, lease), parsed = validateEpisodeMeta(original.header.chat_metadata?.[EPISODE_NAMESPACE], d.account);
            if (parsed.kind !== 'valid' || parsed.value.kind === 'root') throw err('INVALID_IDENTITY', '只能改当前账号的标题');
            const pending = renamePending.get(key);
            if (pending) {
                if (original.fingerprint.hash !== pending.expectedFingerprint) return { kind: 'unconfirmed', target: locator, expectedFingerprint: pending.expectedFingerprint, reason: 'prior-title-write-unconfirmed' };
                if (title !== pending.title || input.kind !== undefined && input.kind !== pending.kind) throw err('RENAME_UNCONFIRMED', '上次改的标题已经生效，刷新后再改');
                renamePending.delete(key);
                d.updateCurrentEpisode?.(original.header.chat_metadata[EPISODE_NAMESPACE], locator);
                return { kind: 'confirmed', target: locator, title: pending.title, episodeKind: pending.kind, fingerprint: original.fingerprint };
            }
            if (input.expectedTitle !== undefined && input.expectedTitle !== parsed.value.title) throw err('TITLE_CHANGED', '标题在别处改过了，刷新后再改');
            const active = isCurrentTarget(locator);
            if (active && await d.assertSourceCurrent({ source: { locator }, sourceFingerprint: original.fingerprint.hash, sourceSnapshot: original }, lease) === false) throw err('SOURCE_UNCONFIRMED', '这条番外还有没存好的内容，先不改标题');
            const next = cloneJson(original), metadata = next.header.chat_metadata[EPISODE_NAMESPACE];
            metadata.title = title;
            if (input.kind !== undefined) metadata.kind = input.kind;
            const expectedFingerprint = (await fingerprintChat(next)).hash;
            if (expectedFingerprint === original.fingerprint.hash) return { kind: 'confirmed', target: locator, title, episodeKind: metadata.kind, fingerprint: original.fingerprint };
            const latest = await read(locator, lease);
            if (latest.fingerprint.hash !== original.fingerprint.hash) throw err('TITLE_CHANGED', '故事内容变了，刷新后再改标题');
            if (active && await d.assertSourceCurrent({ source: { locator }, sourceFingerprint: original.fingerprint.hash, sourceSnapshot: original }, lease) === false) throw err('SOURCE_UNCONFIRMED', '这条番外还有没存好的内容，先不改标题');
            d.assertLease(lease);
            renamePending.set(key, { expectedFingerprint, title, kind: metadata.kind });
            let writeError;
            try { await d.saveExact(next, lease); } catch (error) { writeError = error; }
            let observed;
            try { observed = await read(locator, lease); }
            catch (error) { d.assertLease(lease); return { kind: 'unconfirmed', target: locator, expectedFingerprint, reason: writeError?.code ?? error.code ?? 'TITLE_SAVE_UNCONFIRMED' }; }
            if (observed.fingerprint.hash !== expectedFingerprint) return { kind: 'unconfirmed', target: locator, expectedFingerprint, reason: writeError?.code ?? 'title-content-mismatch' };
            d.assertLease(lease); renamePending.delete(key);
            d.updateCurrentEpisode?.(observed.header.chat_metadata[EPISODE_NAMESPACE], locator);
            return { kind: 'confirmed', target: locator, title, episodeKind: metadata.kind, fingerprint: observed.fingerprint };
        });
    }
    /**
     * Copies messages from..to of the current story (a 番外 written inside it) into a new story of its own, owned by this
     * story like any 番外. Same guards as creating one (confirmed source, create-only first write read back, journal for
     * recovery); nothing is sent to the model, so the operation ends once the file is confirmed. The story is unchanged.
     */
    function extractEpisode(input) {
        return d.enqueue(async () => {
            if (input?.account !== d.account) throw err('ACCOUNT_CHANGED', '换了账号');
            const title = String(input.title ?? '').trim().replace(/\s+/g, ' ').slice(0, 100).trimEnd();
            if (!title) throw err('INVALID_INTENT', '请输入标题');
            if (!['side', 'parallel', 'skit'].includes(input.kind)) throw err('INVALID_INTENT', '请选择类型');
            const { from, to } = input;
            if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw err('INVALID_INTENT', '请选要拆出来的范围');
            const lease = d.makeLease(), status = d.status();
            if (!status.enabled) throw err('EPISODES_DISABLED', '「分开写番外与平行线」已关闭，写好的都还在');
            // Nothing is opened or sent, so only the checks that concern a create-only copy apply (bridge extractReasons).
            if (!(status.extractable ?? status.verified)) throw err('CONFIG_UNVERIFIED', `现在不能拆：${(status.extractReasons ?? status.reasons).join('；')}`);
            if (!status.contextModes?.includes('fresh')) throw err('CONFIG_UNVERIFIED', '这种方式还不能用');
            const policy = { ...status, verified: true };
            await assertCanLeave(lease);
            await d.waitStable();
            const locator = sourceLocator(input.scope);
            if (!sameLocator(locator, sourceLocator(d.currentLocator()))) throw err('STORY_CHANGED', '故事已切换，请重新打开');
            const source = await read(locator, lease);
            if (to >= source.messages.length) throw err('INVALID_INTENT', '范围超出了这个故事，可能刚有新消息，请重新打开');
            const extractRange = { from, to };
            if (await d.assertSourceCurrent({ source: { locator }, sourceFingerprint: source.fingerprint.hash, sourceSnapshot: source, extractRange }, lease) === false) throw err('SOURCE_CHANGED', '原故事还没确认');
            // The range shown to the author must still be the same messages.
            if (input.expectedFirst !== undefined && String(source.messages[from]?.mes ?? '') !== input.expectedFirst ||
                input.expectedLast !== undefined && String(source.messages[to]?.mes ?? '') !== input.expectedLast) {
                throw err('SOURCE_CHANGED', '这段消息刚变了，重新打开再拆');
            }
            const root = await native.resolveRoot({ source, newRootId: d.uuid() }, lease);
            if (root.kind !== 'resolved') throw err('ROOT_UNCONFIRMED', '正文还没确认或有重复，没有创建');
            const operationId = d.uuid(), ids = { operationId, episodeId: d.uuid(), integrity: d.uuid(), rootId: root.rootId, parentId: root.parentId, file: `tl-episode-${d.uuid()}` };
            const initialFile = buildEpisodeFile({ source, ids, intent: { kind: input.kind, title, contextMode: 'fresh', sourceIdentityKind: root.sourceIdentityKind,
                createdAt: new Date().toISOString(), extracted: { from, to, unhide: input.unhide === true }, carryVariables: input.carryVariables === true }, policy });
            const request = { ...input, text: `拆分：${title}（第 ${from}～${to} 条，共 ${to - from + 1} 条）`, draftRevision: 0, assertDraft: () => true };
            let op = await capture(request, source, { ...ids, locator: initialFile.locator, creationOperationId: operationId },
                { operationId, action: 'create', kind: input.kind, title, contextMode: 'fresh', parentSnapshot: source, initialFile, extractRange });
            op = await transition(op, { stage: 'source-confirmed' });
            const result = await native.createOrRecoverTarget({ account: d.account, operationId, initialFile }, lease);
            op = result.operation ?? await journal.readOperation(d.account, operationId);
            if (result.kind !== 'created' || result.creationEvidence?.initialContent !== 'confirmed') return { ...result, kind: 'recovery-required', recoveryKind: result.kind, operation: op };
            // The file is confirmed by read-back; there is nothing to send, so the operation ends here.
            if (op.stage === 'created') op = await transition(op, { stage: 'cancelled', error: '已拆成独立故事，不用发送' });
            draftGuards.delete(operationKey(d.account, operationId));
            return { kind: 'extracted', target: result.locator ?? initialFile.locator, title, label: label(op), count: to - from + 1,
                unhidden: initialFile.header.chat_metadata[EPISODE_NAMESPACE].extractedFrom.unhidden ?? 0, operation: op };
        });
    }
    return { prepareEpisode, prepareEpisodeContinuation, extractEpisode, sendEpisode, recoverEpisode, reviewRecoveredEpisode, confirmEpisodeSave, cancelEpisode, openEpisode, renameEpisode,
        settleEpisodes, dismissEpisode,
        episodeIndex: avatar => d.enqueue(() => index(avatar, d.makeLease())),
        unfinishedEpisodes: () => d.enqueue(() => journal.listUnfinished(d.account)),
        // A story outside any episode family, with no episode work in flight, has nothing to confirm before leaving
        // (assertCanLeave would return at once): answer now instead of queueing behind other operations and the
        // account check, which on large accounts downloads the whole profile.
        episodeNavigationGuard: (desiredTarget = null) => !jobs.size && !d.currentMetadata()?.[EPISODE_NAMESPACE]
            ? Promise.resolve()
            : d.enqueue(() => isCurrentTarget(desiredTarget) ? undefined : assertCanLeave(d.makeLease())),
        episodeNavigationBusy: () => [...jobs.values()].some(job => job.submitted), assertCanLeave };
}
