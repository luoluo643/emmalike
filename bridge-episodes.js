import { EPISODE_NAMESPACE, normalizeLocator, sameLocator, serializeChat, parseFullChat, fingerprintChat,
    canonicalJson, identityKey, creationIdFor, validateEpisodeMeta, sameOperationIdentity, findCreation, resolveSourceIdentity, episodeError } from './src/episode-model.js';
import { diffLines, hashLines } from './src/chat-lines.js';

// A new line at least this long is sent as what differs from the story it was copied from (see createOrRecoverTarget).
const COPY_FROM_CHARS = 256 * 1024;

/**
 * Private native helpers, called while the parent bridge owns its existing queue.
 * No queue, native switching, model calls, parent writes, or cleanup is implemented here.
 * assertLease/assertQueueOwner must be synchronous; assertSourceCurrent may await private native checks.
 */
export function createEpisodeNative({ fetchImpl, getRequestHeaders, assertLease, assertQueueOwner, assertSourceCurrent, journal, onAccountChanged, now = Date.now }) {
    for (const [key, value] of Object.entries({ fetchImpl, getRequestHeaders, assertLease, assertQueueOwner, assertSourceCurrent })) {
        if (typeof value !== 'function') throw episodeError('INVALID_DEPENDENCY', `缺少番外适配依赖 ${key}`);
    }
    if (!journal?.readOperation || !journal?.transition) throw episodeError('INVALID_DEPENDENCY', '缺少可靠操作日志');
    const syncCheck = (fn, lease, name) => {
        const result = fn(lease);
        if (result === false || result?.then) throw episodeError('INVALID_LEASE', `${name} 必须同步确认当前队列与会话`);
    };
    function guard(lease, account = lease?.account) {
        if (!account || lease?.account !== account) throw episodeError('ACCOUNT_CHANGED', '换了账号');
        syncCheck(assertQueueOwner, lease, 'queue owner'); syncCheck(assertLease, lease, 'lease');
    }
    async function raw(path, body, lease, method = 'POST', beforeSend) {
        guard(lease);
        const headers = method === 'GET' ? {} : await getRequestHeaders();
        guard(lease);
        if (beforeSend) {
            const checked = beforeSend();
            if (checked === false || checked?.then) throw episodeError('DRAFT_CHANGED', '请求或草稿变了，没有创建');
        }
        const response = await fetchImpl(path, { method, credentials: 'same-origin', cache: 'no-store', headers,
            ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
        guard(lease);
        return response;
    }
    async function json(path, body, lease, method) {
        const response = await raw(path, body, lease, method);
        if (!response.ok) throw episodeError(response.status === 401 || response.status === 403 ? 'ACCOUNT_UNCONFIRMED' : 'HTTP_UNCONFIRMED', '还不知道结果，先去看看那个故事', { path, status: response.status });
        const data = await response.json(); guard(lease); return data;
    }
    async function accountCheck(account, lease) {
        guard(lease, account);
        const user = await json('/api/users/me', undefined, lease, 'GET');
        // The page must stop as well, not only this step: the next operation may otherwise trust an earlier check.
        if (user?.handle !== account) { onAccountChanged?.(); throw episodeError('ACCOUNT_CHANGED', '发送时换了账号，还不知道结果'); }
        guard(lease, account);
    }
    async function readFileUnchecked(locator, lease) {
        const l = normalizeLocator(locator); guard(lease, l.account);
        const data = await json('/api/chats/get', { avatar_url: l.avatar, file_name: l.file }, lease);
        const result = parseFullChat(data, l);
        if (result.kind === 'present') result.file.fingerprint = await fingerprintChat(result.file);
        guard(lease, l.account); return result;
    }
    async function readFullChat(locator, lease) {
        const l = normalizeLocator(locator);
        await accountCheck(l.account, lease);
        const result = await readFileUnchecked(l, lease);
        await accountCheck(l.account, lease);
        return result;
    }
    function names(list, scope) {
        if (!Array.isArray(list)) throw episodeError('LIST_UNCONFIRMED', '原生聊天目录未能确认');
        const result = list.map(row => normalizeLocator({ ...scope, file: row?.file_name }).file).sort();
        if (new Set(result).size !== result.length) throw episodeError('LIST_UNCONFIRMED', '原生聊天目录包含重复定位');
        return result;
    }
    async function listChatHeaders(scope, lease) {
        const { account, avatar } = normalizeLocator({ ...scope, file: '__scope__' }), started = now();
        await accountCheck(account, lease);
        const before = names(await json('/api/characters/chats', { avatar_url: avatar, simple: true }, lease), { account, avatar });
        const metadataRows = await json('/api/characters/chats', { avatar_url: avatar, metadata: true }, lease);
        if (!Array.isArray(metadataRows)) throw episodeError('LIST_UNCONFIRMED', '原生聊天信息未能确认');
        const byFile = new Map();
        for (const row of metadataRows) {
            const file = normalizeLocator({ account, avatar, file: row?.file_name }).file;
            if (!before.includes(file) || byFile.has(file)) throw episodeError('LIST_UNCONFIRMED', '加载时故事列表变了，再试一次');
            byFile.set(file, row);
        }
        const entries = [];
        let usedHeaderFallback = false;
        for (const file of before) {
            const row = byFile.get(file), locator = { account, avatar, file };
            if (!row?.chat_metadata || typeof row.chat_metadata !== 'object' || Array.isArray(row.chat_metadata)) {
                usedHeaderFallback = true;
                const read = await readFileUnchecked(locator, lease);
                if (read.kind !== 'present') throw episodeError('LIST_UNCONFIRMED', '有些故事没读到，没法确认', { file, kind: read.kind });
                entries.push({ locator, metadata: read.file.header.chat_metadata ?? {}, fullFile: read.file, lastModified: row?.last_mes ?? null });
            } else entries.push({ locator, metadata: row.chat_metadata, lastModified: row.last_mes ?? null });
        }
        // Only exact legacy locators are read. A renamed/deleted source remains missing; no similarity search.
        for (const entry of entries) {
            const parsed = validateEpisodeMeta(entry.metadata?.[EPISODE_NAMESPACE], account);
            if (parsed.kind !== 'valid' || parsed.value.sourceIdentityKind !== 'legacy-anchor') continue;
            const sourceLocator = parsed.value.sourceAnchor.locator;
            const parent = entries.find(candidate => sameLocator(candidate.locator, sourceLocator));
            if (!parent || parent.fullFile) continue;
            const read = await readFileUnchecked(sourceLocator, lease);
            if (read.kind !== 'present') throw episodeError('LIST_UNCONFIRMED', '旧根的完整锚点暂时无法核对', { file: sourceLocator.file });
            parent.fullFile = read.file;
        }
        const after = names(await json('/api/characters/chats', { avatar_url: avatar, simple: true }, lease), { account, avatar });
        if (canonicalJson(before) !== canonicalJson(after)) throw episodeError('LIST_UNCONFIRMED', '加载时故事列表变了，再试一次');
        await accountCheck(account, lease);
        return { entries, account, avatar, complete: true, usedHeaderFallback, measuredMs: now() - started };
    }
    async function resolveRoot({ source, newRootId, naturalSaveEvidence }, lease) {
        const expected = await fingerprintChat(source), read = await readFullChat(source.locator, lease);
        if (read.kind !== 'present' || read.file.fingerprint.hash !== expected.hash) throw episodeError('SOURCE_CHANGED', '原故事变了，请重新确认');
        const listing = await listChatHeaders(source.locator, lease);
        // Pure resolution returns child-side legacy identity. It never writes a root header.
        const root = resolveSourceIdentity(read.file, listing.entries, { newRootId, naturalSaveEvidence });
        return { ...root, source: read.file, inventory: listing };
    }
    async function operationFor(account, operationId, lease) {
        await accountCheck(account, lease);
        const operation = await journal.readOperation(account, operationId); guard(lease, account);
        if (!operation || operation.account !== account || operation.ownerAccount !== account) throw episodeError('OPERATION_MISSING', '找不到此账号的可靠操作记录');
        return operation;
    }
    const change = (operation, patch) => journal.transition({ account: operation.account, operationId: operation.operationId,
        expectedRevision: operation.revision, expectedStage: operation.stage, patch });
    function matchesFile(file, operation) {
        return sameOperationIdentity(file.header.chat_metadata?.[EPISODE_NAMESPACE], operation) &&
            identityKey(file.header.chat_metadata?.integrity) === identityKey(operation.target.integrity);
    }
    function evidence(operation, file, expectedFingerprint) {
        return { state: 'confirmed', ownerAccount: operation.account, locator: file.locator, episodeId: operation.target.episodeId,
            creationOperationId: creationIdFor(operation), expectedFingerprint, observedFingerprint: file.fingerprint.hash,
            operationRevision: operation.revision, evidence: 'readback', confirmedAt: now() };
    }
    async function confirmTarget({ account, operationId, locator, expectedFingerprint }, lease) {
        const operation = await operationFor(account, operationId, lease), target = normalizeLocator(locator ?? operation.resolvedLocator ?? operation.target.locator);
        if (target.account !== account || target.avatar !== operation.target.locator.avatar) throw episodeError('ACCOUNT_CHANGED', '目标账号或角色不匹配');
        const read = await readFullChat(target, lease);
        if (read.kind !== 'present') return { kind: 'unconfirmed', operation, reason: read.kind };
        const ownership = validateEpisodeMeta(read.file.header.chat_metadata?.[EPISODE_NAMESPACE], account);
        if (ownership.kind === 'foreign-owner') return { kind: 'conflict', operation, reason: 'foreign-owner' };
        if (!matchesFile(read.file, operation)) return { kind: 'conflict', operation, reason: 'target-identity' };
        if (read.file.fingerprint.hash !== expectedFingerprint) return { kind: 'unconfirmed', operation, reason: 'content-mismatch', file: read.file };
        return { kind: 'confirmed', operation, file: read.file, locator: read.file.locator, fingerprint: read.file.fingerprint, confirmation: evidence(operation, read.file, expectedFingerprint) };
    }
    async function recoverTarget({ account, operationId }, lease) {
        let operation = await operationFor(account, operationId, lease);
        const listing = await listChatHeaders(operation.target.locator, lease), found = findCreation(listing.entries, operation);
        if (found.kind === 'ambiguous') return { kind: 'ambiguous', operation, candidates: found.candidates, reason: 'duplicate-or-invalid-identity' };
        if (found.kind === 'none') return { kind: 'unconfirmed', operation, reason: 'not-found' };
        const read = await readFullChat(found.candidate.locator, lease);
        if (read.kind !== 'present') return { kind: 'unconfirmed', operation, reason: read.kind };
        if (!matchesFile(read.file, operation)) return { kind: 'conflict', operation, reason: 'target-identity' };
        const exact = !!operation.initialFingerprint && read.file.fingerprint.hash === operation.initialFingerprint;
        const creationEvidence = { ownerAccount: account, locator: read.file.locator, episodeId: operation.target.episodeId,
            creationOperationId: creationIdFor(operation), observedFingerprint: read.file.fingerprint.hash,
            initialContent: exact ? 'confirmed' : 'advanced-or-different', verifiedAt: now() };
        if (['create-armed', 'create-unconfirmed'].includes(operation.stage)) {
            operation = await change(operation, { stage: 'created', resolvedLocator: read.file.locator, creationEvidence }); guard(lease, account);
        }
        return { kind: 'recovered', operation, file: read.file, locator: read.file.locator, fingerprint: read.file.fingerprint, creationEvidence,
            confirmation: exact ? evidence(operation, read.file, operation.initialFingerprint) : null };
    }
    async function createOrRecoverTarget({ account, operationId, initialFile, assertIntentCurrent }, lease) {
        let operation = await operationFor(account, operationId, lease);
        // In particular, armed/unknown cannot POST again, even when the supplied file looks identical.
        if (operation.action === 'continue' || !['captured', 'source-confirmed'].includes(operation.stage)) return recoverTarget({ account, operationId }, lease);
        if (!initialFile || !sameLocator(initialFile.locator, operation.target.locator) || !matchesFile(initialFile, operation)) throw episodeError('INVALID_TARGET', '首写内容与日志身份不一致');
        const payload = serializeChat(initialFile), initialFingerprint = (await fingerprintChat(initialFile)).hash;
        if (await assertSourceCurrent(operation, lease) === false) throw episodeError('SOURCE_CHANGED', '原故事还没确认'); guard(lease, account);
        const source = await readFullChat(operation.source.locator, lease);
        if (source.kind !== 'present' || source.file.fingerprint.hash !== operation.sourceFingerprint) throw episodeError('SOURCE_CHANGED', '原故事还没确认或变了，没有创建');
        const listing = await listChatHeaders(operation.target.locator, lease);
        const prior = findCreation(listing.entries, operation);
        if (prior.kind !== 'none' || listing.entries.some(x => sameLocator(x.locator, operation.target.locator))) return { kind: 'conflict', operation, reason: 'target-already-exists' };
        // A precise read also detects an incomplete/stale listing. Empty is not independently a create-only guarantee.
        const destination = await readFullChat(operation.target.locator, lease);
        if (destination.kind !== 'missing-or-unreadable') return { kind: 'conflict', operation, reason: 'target-already-exists' };
        if (await assertSourceCurrent(operation, lease) === false) throw episodeError('SOURCE_CHANGED', '原故事还没确认'); guard(lease, account);
        if (operation.stage === 'captured') { operation = await change(operation, { stage: 'source-confirmed' }); guard(lease, account); }
        if (assertIntentCurrent) {
            const checked = assertIntentCurrent();
            if (checked === false || checked?.then) throw episodeError('DRAFT_CHANGED', '请求或草稿变了，没有创建');
        }
        operation = await change(operation, { stage: 'create-armed', initialFingerprint });
        // Any failure from this point is uncertain. The durable armed marker survives a failed diagnostic write.
        let posted = false;
        try {
            await accountCheck(account, lease);
            const beforeSend = () => {
                const checked = assertIntentCurrent?.();
                if (checked === false || checked?.then) throw episodeError('DRAFT_CHANGED', '草稿变了，没有创建');
                posted = true;
            };
            const avatar = operation.target.locator.avatar, file = operation.target.locator.file, lines = payload.map(entry => JSON.stringify(entry));
            let response = null;
            // A long story copied into a new line goes as what differs from the story it was copied from: the server
            // plugin (tavern-lite-save 2+) checks it still holds exactly that story and writes the copy itself, instead
            // of the phone uploading megabytes. It never overwrites. Without the plugin, or when it wrote nothing (an
            // older plugin, another copy of the story, a refused patch), the whole file is saved as before.
            if (source.file.locator.avatar === avatar && lines.reduce((n, line) => n + line.length, 0) > COPY_FROM_CHARS) {
                const base = serializeChat(source.file).map(entry => JSON.stringify(entry));
                const copied = await raw('/api/plugins/tavern-lite-save/copy', { avatar_url: avatar, from_file: source.file.locator.file, file_name: file,
                    base: hashLines(base), ...diffLines(base, lines) }, lease, 'POST', beforeSend);
                const refused = copied.status === 409 ? (await copied.clone().json().catch(() => null))?.error !== 'exists' : [400, 401, 403, 404, 405, 501].includes(copied.status);
                if (!refused) response = copied;
            }
            response ??= await raw('/api/chats/save', { avatar_url: avatar, file_name: file, chat: payload, force: false }, lease, 'POST', beforeSend);
            await accountCheck(account, lease);
            if (!response.ok) throw episodeError('CREATE_UNCONFIRMED', '原生首写未能确认', { status: response.status });
            const receipt = await response.json(); guard(lease, account);
            if (receipt?.ok !== true) throw episodeError('CREATE_UNCONFIRMED', '原生首写缺少成功回执');
            const confirmed = await confirmTarget({ account, operationId, locator: operation.target.locator, expectedFingerprint: initialFingerprint }, lease);
            if (confirmed.kind !== 'confirmed') throw episodeError('CREATE_UNCONFIRMED', '新故事还没确认写好', { reason: confirmed.reason });
            const creationEvidence = { ...confirmed.confirmation, initialContent: 'confirmed' };
            operation = await change(operation, { stage: 'created', creationEvidence, resolvedLocator: operation.target.locator }); guard(lease, account);
            return { kind: 'created', operation, file: confirmed.file, locator: confirmed.file.locator, fingerprint: confirmed.file.fingerprint, confirmation: evidence(operation, confirmed.file, initialFingerprint), creationEvidence };
        } catch (error) {
            if (posted && ['ACCOUNT_CHANGED', 'ACCOUNT_UNCONFIRMED'].includes(error.code)) error = episodeError(error.code,
                '发送时换了账号，内容（可能包括正文）可能写进了另一个账号。轻酒馆不会去找或自动删除，请登录那个账号看一下');
            let journalError;
            try { operation = await change(operation, { stage: 'create-unconfirmed', error: { code: error.code ?? 'CREATE_UNCONFIRMED', message: String(error.message ?? error) } }); }
            catch (failure) { journalError = { code: failure.code ?? 'JOURNAL_UNAVAILABLE', message: String(failure.message ?? failure) }; }
            return { kind: 'unconfirmed', operation, reason: error.code ?? 'CREATE_UNCONFIRMED', ...(journalError ? { journalError } : {}) };
        }
    }
    return Object.freeze({ readFullChat, listChatHeaders, resolveRoot, createOrRecoverTarget, recoverTarget, confirmTarget });
}
