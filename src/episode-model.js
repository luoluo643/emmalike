// Pure episode identities and file comparisons. No account, network, or native-chat effects.
export const EPISODE_NAMESPACE = 'tavern_lite_episode';
export const EPISODE_SCHEMA_VERSION = 1;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const identityKey = value => typeof value === 'string' ? value.toLowerCase() : value;
export const creationIdFor = operation => identityKey(operation.target?.creationOperationId ?? operation.operationId);
const HASH = /^[0-9a-f]{64}$/;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export const episodeError = (code, message, detail) => Object.assign(new Error(message), { code, ...(detail === undefined ? {} : { detail }) });
export const cloneJson = value => JSON.parse(JSON.stringify(value));

export function normalizeLocator(value) {
    if (!object(value) || value.groupId != null) throw episodeError('INVALID_LOCATOR', '群聊不能开番外');
    const { account, avatar } = value, file = String(value.file ?? '').replace(/\.jsonl$/, '');
    if (![account, avatar, file].every(x => typeof x === 'string' && x.trim() && !/[\x00-\x1f]/.test(x)) ||
        /[\\/]/.test(avatar) || /[\\/]/.test(file) || ['.', '..'].includes(file)) {
        throw episodeError('INVALID_LOCATOR', '账号、角色或聊天文件定位不完整');
    }
    return { account, avatar, file };
}

export const locatorKey = locator => { const l = normalizeLocator(locator); return JSON.stringify([l.account, l.avatar, l.file]); };
export const sameLocator = (a, b) => { try { return locatorKey(a) === locatorKey(b); } catch { return false; } };

export function validateEpisodeMeta(raw, expectedAccount) {
    if (raw === undefined) return { kind: 'absent' };
    if (!object(raw)) return { kind: 'invalid', reason: 'namespace-not-object' };
    if (raw.schemaVersion !== EPISODE_SCHEMA_VERSION) return { kind: 'unsupported', reason: 'schema-version' };
    if (typeof raw.ownerAccount !== 'string' || !raw.ownerAccount.trim()) return { kind: 'invalid', reason: 'owner-account' };
    if (expectedAccount !== undefined && raw.ownerAccount !== expectedAccount) return { kind: 'foreign-owner', reason: 'owner-account' };
    if (!['episodeId', 'rootId', 'creationOperationId'].every(k => typeof raw[k] === 'string' && UUID.test(raw[k])) ||
        !(raw.parentId === null || typeof raw.parentId === 'string' && UUID.test(raw.parentId))) return { kind: 'invalid', reason: 'identity' };
    if (!['root', 'side', 'parallel', 'skit'].includes(raw.kind) || !['continued', 'fresh'].includes(raw.contextMode) ||
        typeof raw.title !== 'string' || !raw.title.trim() || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) {
        return { kind: 'invalid', reason: 'fields' };
    }
    if (raw.openingRequest !== undefined && (typeof raw.openingRequest !== 'string' || !raw.openingRequest.trim())) return { kind: 'invalid', reason: 'opening-request' };
    if (raw.kind === 'root' ? raw.parentId !== null || identityKey(raw.episodeId) !== identityKey(raw.rootId) :
        raw.parentId === null || identityKey(raw.episodeId) === identityKey(raw.rootId) || identityKey(raw.episodeId) === identityKey(raw.parentId)) return { kind: 'invalid', reason: 'relationship' };
    if (raw.sourceIdentityKind != null && !['native-integrity', 'episode-id', 'legacy-anchor'].includes(raw.sourceIdentityKind)) return { kind: 'invalid', reason: 'source-identity-kind' };
    if (raw.sourceAnchor !== undefined) {
        const a = raw.sourceAnchor;
        if (!object(a) || !UUID.test(a.sourceId) || !HASH.test(a.sourceFingerprint) || !Number.isSafeInteger(a.messageCount) || a.messageCount < 0 ||
            !(a.sourceIntegrity === null || typeof a.sourceIntegrity === 'string') || !Number.isFinite(Date.parse(a.capturedAt))) {
            return { kind: 'invalid', reason: 'source-anchor' };
        }
        if (raw.sourceIdentityKind === 'legacy-anchor') {
            try {
                if (normalizeLocator(a.locator).account !== raw.ownerAccount || !HASH.test(a.messagePrefixFingerprint) ||
                    (a.messageCount > 0 ? !object(a.anchor) || a.anchor.index !== a.messageCount - 1 || !HASH.test(a.anchor.fingerprint) : a.anchor !== null)) return { kind: 'invalid', reason: 'legacy-anchor' };
            } catch { return { kind: 'invalid', reason: 'legacy-anchor' }; }
        }
    }
    if (raw.sourceIdentityKind === 'legacy-anchor' && !raw.sourceAnchor) return { kind: 'invalid', reason: 'legacy-anchor' };
    const value = cloneJson(raw);
    for (const key of ['episodeId', 'rootId', 'parentId', 'creationOperationId']) value[key] = identityKey(value[key]);
    if (value.sourceAnchor) value.sourceAnchor.sourceId = identityKey(value.sourceAnchor.sourceId);
    return { kind: 'valid', value };
}

export function parseFullChat(data, locator) {
    const normalized = normalizeLocator(locator);
    if (Array.isArray(data) && !data.length || object(data) && !Object.keys(data).length) return { kind: 'missing-or-unreadable', locator: normalized };
    if (!Array.isArray(data) || !object(data[0]) || !(object(data[0].chat_metadata) || data[0].chat_metadata === undefined && ('user_name' in data[0] || 'character_name' in data[0])) || data.slice(1).some(m => !object(m))) {
        return { kind: 'invalid', locator: normalized, reason: 'header-or-messages' };
    }
    return { kind: 'present', file: { locator: normalized, header: cloneJson(data[0]), messages: cloneJson(data.slice(1)) } };
}

export function serializeChat(file) {
    if (!object(file?.header) || !(object(file.header.chat_metadata) || file.header.chat_metadata === undefined && ('user_name' in file.header || 'character_name' in file.header)) || !Array.isArray(file.messages) || file.messages.some(m => !object(m))) {
        throw episodeError('INVALID_CHAT', '完整聊天数据缺少 header 或消息数组');
    }
    return cloneJson([file.header, ...file.messages]);
}

// Normalize using JSON's actual rules first, then sort only object keys. All fields remain covered.
export function canonicalJson(value) {
    const normalized = cloneJson(value);
    const visit = x => Array.isArray(x) ? `[${x.map(visit).join(',')}]` : object(x)
        ? `{${Object.keys(x).sort().map(key => `${JSON.stringify(key)}:${visit(x[key])}`).join(',')}}` : JSON.stringify(x);
    return visit(normalized);
}
export const canonicalChat = file => canonicalJson(serializeChat(file));

// SHA-256 has a synchronous portable implementation because plain HTTP lacks crypto.subtle.
// Uint32 operations are intentional. Tests compare standard vectors and Node's independent implementation.
const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotr = (n, count) => n >>> count | n << (32 - count);
export function sha256(text) {
    const bytes = new TextEncoder().encode(text), length = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(length), view = new DataView(padded.buffer), words = new Uint32Array(64);
    padded.set(bytes); padded[bytes.length] = 0x80;
    view.setUint32(length - 8, Math.floor(bytes.length / 0x20000000));
    view.setUint32(length - 4, (bytes.length * 8) >>> 0);
    const hash = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    for (let offset = 0; offset < length; offset += 64) {
        for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
        for (let i = 16; i < 64; i++) {
            const a = words[i - 15], b = words[i - 2];
            words[i] = words[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ a >>> 3) + words[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ b >>> 10);
        }
        let [a,b,c,d,e,f,g,h] = hash;
        for (let i = 0; i < 64; i++) {
            const t1 = (h + (rotr(e,6) ^ rotr(e,11) ^ rotr(e,25)) + ((e & f) ^ (~e & g)) + K[i] + words[i]) >>> 0;
            const t2 = ((rotr(a,2) ^ rotr(a,13) ^ rotr(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        [a,b,c,d,e,f,g,h].forEach((x, i) => { hash[i] = (hash[i] + x) >>> 0; });
    }
    return [...hash].map(x => x.toString(16).padStart(8, '0')).join('');
}
/**
 * The same SHA-256 by the browser's own digest where it has one (HTTPS): a long story is hashed several times per 番外
 * send, and the portable version above takes seconds on a phone for a 15MB story.
 */
async function digestHex(bytes) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle?.digest) return null;
    try { return [...new Uint8Array(await subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join(''); }
    catch { return null; }
}
export async function fingerprintChat(file) {
    const canonical = canonicalChat(file), bytes = new TextEncoder().encode(canonical);
    return { algorithm: 'sha256-json-v1', hash: await digestHex(bytes) ?? sha256(canonical), utf8Bytes: bytes.length };
}

// tavern_lite_lines: the lines written inside this story (own-lines.js); a copy is a story of its own and starts without them.
const IGNORED_METADATA = new Set([EPISODE_NAMESPACE, 'integrity', 'chat_id_hash', 'tavern_lite_lines']);
/**
 * A 番外 that does not continue the story still keeps the story's persona lock, and Horae's one-time migration marker
 * (without it Horae migrates and saves the new story as soon as it is opened).
 */
export const FRESH_METADATA_KEYS = Object.freeze(['persona', 'horae_native_visibility_migration']);

const mainChatOf = entry => typeof entry?.metadata?.main_chat === 'string' ? entry.metadata.main_chat.replace(/\.jsonl$/, '') : null;
/**
 * The full app's branch and checkpoint copy a chat's whole header, identities included, and name the chat they were
 * made from in main_chat. Of several files holding one identity, the ones naming another holder are such copies.
 */
export function nativeOriginals(holders) {
    return holders.filter(h => !holders.some(o => o !== h && mainChatOf(h) === normalizeLocator(o.locator).file));
}

/** A story message hidden from the AI (native /hide, or hidden by an extension), not one of the app's own system notes. */
export const hiddenStoryMessage = m => m?.is_system === true && !m.extra?.type && !m.extra?.isSmallSys;

/** Chat state keys a continued copy would carry although nobody reviewed them (other extensions' state). */
export function unreviewedMetadataKeys(metadata, policy) {
    return Object.keys(metadata ?? {}).filter(key => !IGNORED_METADATA.has(key) && !policy?.continuedMetadataKeys?.includes(key) &&
        !policy?.blockedMetadataKeys?.includes(key));
}

/**
 * policy is a verified metadata allowlist. Keys it blocks always fail; other unreviewed keys fail too unless
 * policy.carryUnreviewedMetadata (then they are copied, as a native branch copies them, and the caller shows them).
 */
export function buildEpisodeFile({ source, intent, ids, policy }) {
    ids = { ...ids };
    for (const key of ['episodeId', 'rootId', 'parentId', 'operationId', 'integrity']) ids[key] = identityKey(ids[key]);
    const mode = intent?.contextMode;
    if (!policy?.verified || !policy.configurationId || !policy.contextModes?.includes(mode)) throw episodeError('CONFIG_UNVERIFIED', '此配置的背景策略尚未验证');
    if (!source?.fingerprint || !HASH.test(source.fingerprint.hash)) throw episodeError('SOURCE_UNCONFIRMED', '来源尚未确认保存');
    if (sha256(canonicalChat(source)) !== source.fingerprint.hash) throw episodeError('SOURCE_CHANGED', '来源快照已在确认后改变');
    const locator = normalizeLocator(source.locator), target = normalizeLocator({ ...locator, file: ids.file });
    const sourceMetadata = source.header.chat_metadata ?? {}, sourceEpisode = validateEpisodeMeta(sourceMetadata[EPISODE_NAMESPACE], locator.account);
    if (!['absent', 'valid'].includes(sourceEpisode.kind)) throw episodeError('INVALID_IDENTITY', '来源命名空间无法确认');
    if (sourceEpisode.kind === 'valid' && sourceEpisode.value.kind !== 'root' || ids.rootId !== ids.parentId) throw episodeError('NESTING_UNSUPPORTED', '已有子线应直接续写');
    const sourceId = sourceEpisode.kind === 'valid' ? sourceEpisode.value.episodeId : identityKey(sourceMetadata.integrity);
    const legacy = intent.sourceIdentityKind === 'legacy-anchor';
    if (sameLocator(locator, target) || !['episodeId','operationId','integrity','rootId','parentId'].every(k => UUID.test(ids[k])) ||
        !legacy && ids.parentId !== sourceId || ids.episodeId === ids.parentId || ids.episodeId === ids.rootId || ids.integrity === identityKey(sourceMetadata.integrity) ||
        sourceEpisode.kind === 'valid' && ids.operationId === sourceEpisode.value.creationOperationId) {
        throw episodeError('INVALID_IDENTITY', '子会话必须使用独立身份与文件');
    }
    const meta = {
        schemaVersion: 1, ownerAccount: locator.account, episodeId: ids.episodeId, rootId: ids.rootId, parentId: ids.parentId,
        kind: intent.kind, title: intent.title, contextMode: mode, createdAt: intent.createdAt,
        creationOperationId: ids.operationId, sourceIdentityKind: intent.sourceIdentityKind ?? 'episode-id',
        sourceAnchor: makeSourceAnchor(source, ids.parentId, intent.createdAt),
        ...(intent.openingRequest === undefined ? {} : { openingRequest: intent.openingRequest }),
    };
    if (validateEpisodeMeta(meta).kind !== 'valid' || meta.kind === 'root') throw episodeError('INVALID_IDENTITY', '子会话归属不完整');
    // Native {{chat_id}} hashes are derived from the physical file. Never carry a parent's cached value.
    const metadata = {};
    if (mode === 'continued') {
        if (!Array.isArray(policy.continuedMetadataKeys)) throw episodeError('CONFIG_UNVERIFIED', '接续状态清单尚未验证');
        for (const [key, value] of Object.entries(sourceMetadata)) {
            if (IGNORED_METADATA.has(key)) continue;
            if (!policy.continuedMetadataKeys.includes(key) && (policy.blockedMetadataKeys?.includes(key) || !policy.carryUnreviewedMetadata)) {
                throw episodeError('CHANNEL_UNVERIFIED', '来源包含未核验会话状态', { key });
            }
            Object.defineProperty(metadata, key, { value: cloneJson(value), enumerable: true, configurable: true, writable: true });
        }
    } else if (mode === 'fresh') {
        for (const key of FRESH_METADATA_KEYS) if (sourceMetadata[key] !== undefined) metadata[key] = cloneJson(sourceMetadata[key]);
        if (intent.carryVariables === true && object(sourceMetadata.variables)) metadata.variables = cloneJson(sourceMetadata.variables);
    } else throw episodeError('INVALID_CONTEXT_MODE', '背景策略不支持');
    // A 番外 written inside the story, copied out: only these messages of the confirmed source and the state above.
    let messages = mode === 'continued' ? cloneJson(source.messages) : [];
    if (intent.extracted) {
        const { from, to } = intent.extracted, count = Array.isArray(source.messages) ? source.messages.length : 0;
        if (mode !== 'fresh' || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to >= count) {
            throw episodeError('INVALID_INTENT', '拆分范围超出这个故事');
        }
        messages = cloneJson(source.messages.slice(from, to + 1));
        // In the story these were hidden from the AI (most often after being summarized); in a story of their own they
        // are the story, and the summary does not come along.
        let unhidden = 0;
        if (intent.extracted.unhide) for (const message of messages) {
            if (!hiddenStoryMessage(message)) continue;
            message.is_system = false;
            if (message.is_hidden === true) message.is_hidden = false;
            unhidden++;
        }
        meta.extractedFrom = { from, to, count: to - from + 1, ...(unhidden ? { unhidden } : {}) };
    }
    metadata.integrity = ids.integrity;
    metadata[EPISODE_NAMESPACE] = meta;
    return { locator: target,
        header: mode === 'continued' ? { ...cloneJson(source.header), chat_metadata: metadata } : { user_name: 'unused', character_name: 'unused', chat_metadata: metadata },
        messages,
    };
}

export function sameOperationIdentity(meta, operation) {
    const parsed = validateEpisodeMeta(meta, operation.account ?? operation.target?.locator?.account), expected = operation.target;
    return parsed.kind === 'valid' && !!expected && parsed.value.creationOperationId === creationIdFor(operation) &&
        ['episodeId', 'rootId', 'parentId'].every(k => parsed.value[k] === identityKey(expected[k])) && parsed.value.contextMode === operation.contextMode;
}

export function findCreation(entries, operation) {
    const candidates = [], suspicious = [];
    for (const entry of entries) {
        const l = normalizeLocator(entry.locator), target = normalizeLocator(operation.target.locator);
        if (l.account !== target.account || l.avatar !== target.avatar) continue;
        const meta = entry.metadata?.[EPISODE_NAMESPACE];
        if (sameOperationIdentity(meta, operation) && (!operation.target.integrity || identityKey(entry.metadata?.integrity) === identityKey(operation.target.integrity))) candidates.push(entry);
        else if (identityKey(meta?.creationOperationId) === creationIdFor(operation) || identityKey(meta?.episodeId) === identityKey(operation.target.episodeId) ||
            operation.target.integrity && identityKey(entry.metadata?.integrity) === identityKey(operation.target.integrity)) suspicious.push(entry);
    }
    // A branch or checkpoint the full app made of the new story afterwards is not another creation.
    const originals = nativeOriginals([...candidates, ...suspicious]);
    if (originals.length === 1 && candidates.includes(originals[0])) return { kind: 'unique', candidate: cloneJson(originals[0]) };
    if (suspicious.length || candidates.length > 1) return { kind: 'ambiguous', candidates: cloneJson([...candidates, ...suspicious]) };
    return candidates.length ? { kind: 'unique', candidate: cloneJson(candidates[0]) } : { kind: 'none', candidates: [] };
}

/** Resolution is scoped. A duplicate logical/native identity never silently chooses a file. */
export function resolveEpisodeGraph(entries, { account, avatar }) {
    const ordinaryChats = [], nodes = [], invalid = [], byId = new Map();
    const add = (id, node) => { id = identityKey(id); const list = byId.get(id) ?? []; if (!list.includes(node)) list.push(node); byId.set(id, list); };
    for (const entry of entries) {
        const locator = normalizeLocator(entry.locator);
        if (locator.account !== account || locator.avatar !== avatar) continue;
        const parsed = validateEpisodeMeta(entry.metadata?.[EPISODE_NAMESPACE], account);
        const node = { ...cloneJson(entry), locator, identityStatus: parsed.kind, ...(parsed.kind === 'valid' ? { episode: parsed.value } : {}) };
        if (parsed.kind === 'valid') { nodes.push(node); add(parsed.value.episodeId, node); }
        else if (parsed.kind === 'absent') ordinaryChats.push(node);
        else invalid.push({ ...node, reason: parsed.reason });
        // Children get independent native integrity; a reused integrity is still ambiguous.
        const integrity = entry.metadata?.integrity;
        if (parsed.kind !== 'foreign-owner' && typeof integrity === 'string' && UUID.test(integrity)) add(integrity, node);
    }
    // The full app's copies of a file share its identities; the file they were copied from keeps them.
    for (const [id, list] of byId) {
        const originals = list.length > 1 ? nativeOriginals(list) : list;
        if (originals.length !== 1 || originals === list) continue;
        for (const node of list) if (node !== originals[0]) node.nativeCopyOf = cloneJson(originals[0].locator);
        byId.set(id, originals);
    }
    const ambiguousIds = [...byId].filter(([, list]) => list.length !== 1).map(([id]) => id);
    const legacyClaims = new Map();
    for (const node of nodes.filter(x => x.episode.sourceIdentityKind === 'legacy-anchor')) {
        const id = node.episode.rootId, claims = legacyClaims.get(id) ?? new Set();
        claims.add(locatorKey(node.episode.sourceAnchor.locator)); legacyClaims.set(id, claims);
    }
    for (const [id, claims] of legacyClaims) if (claims.size > 1 && !ambiguousIds.includes(id)) ambiguousIds.push(id);
    const roots = [], missingSources = [];
    for (const node of nodes) {
        let root = byId.get(node.episode.rootId) ?? [], parent = node.episode.parentId && byId.get(node.episode.parentId) || [];
        if (node.episode.sourceIdentityKind === 'legacy-anchor') {
            const candidates = [...ordinaryChats, ...nodes].filter(candidate => candidate.fullFile && matchLegacySource(node.episode, candidate.fullFile).kind === 'matched');
            root = candidates; parent = candidates;
        }
        const conflict = [node.episode.episodeId, node.episode.rootId, node.episode.parentId, identityKey(node.metadata?.integrity)].some(id => ambiguousIds.includes(id)) ||
            [...root, ...parent].some(x => !['valid', 'absent'].includes(x.identityStatus)) ||
            root.some(x => x.episode && (x.episode.kind !== 'root' || x.episode.rootId !== node.episode.rootId));
        node.relationship = conflict ? 'ambiguous' : root.length === 1 && (node.episode.parentId === null || parent.length === 1) ? 'resolved' : 'source-missing';
        if (node.relationship === 'resolved') node.rootLocator = cloneJson(root[0].locator);
        if (node.relationship === 'source-missing') missingSources.push(node.locator);
        if (root.length === 1 && !conflict && !roots.some(x => sameLocator(x.locator, root[0].locator))) roots.push(root[0]);
    }
    return { nodes, roots, ordinaryChats, invalid, ambiguousIds, missingSources };
}

export function makeSourceAnchor(source, sourceId, capturedAt) {
    return { sourceId: identityKey(sourceId), sourceIntegrity: source.header.chat_metadata?.integrity ?? null,
        sourceFingerprint: source.fingerprint?.hash ?? sha256(canonicalChat(source)), messageCount: source.messages.length,
        messagePrefixFingerprint: sha256(canonicalJson(source.messages)),
        anchor: source.messages.length ? { index: source.messages.length - 1, fingerprint: sha256(canonicalJson(source.messages.at(-1))) } : null,
        locator: normalizeLocator(source.locator), capturedAt };
}

/** Legacy roots have no writes or filename guessing. Only the exact stored locator is considered. */
export function matchLegacySource(meta, source) {
    const parsed = validateEpisodeMeta(meta, source.locator?.account);
    if (parsed.kind !== 'valid' || parsed.value.sourceIdentityKind !== 'legacy-anchor') return { kind: 'invalid' };
    const a = parsed.value.sourceAnchor;
    if (!sameLocator(a.locator, source.locator)) return { kind: 'source-missing' };
    const full = sha256(canonicalChat(source));
    if (full === a.sourceFingerprint) return { kind: 'matched', basis: 'full-file' };
    if (!a.messageCount || source.messages.length < a.messageCount) return { kind: 'source-changed' };
    if (sha256(canonicalJson(source.messages[a.anchor.index])) !== a.anchor.fingerprint ||
        sha256(canonicalJson(source.messages.slice(0, a.messageCount))) !== a.messagePrefixFingerprint) return { kind: 'source-changed' };
    return { kind: 'matched', basis: 'exact-locator-and-prefix' };
}

/** The complete account+avatar inventory is required; this function never registers a parent. */
export function resolveSourceIdentity(source, entries, { newRootId, naturalSaveEvidence } = {}) {
    const locator = normalizeLocator(source.locator), metadata = source.header.chat_metadata ?? {};
    const parsed = validateEpisodeMeta(metadata[EPISODE_NAMESPACE], locator.account);
    if (!['absent', 'valid'].includes(parsed.kind)) return { kind: 'invalid', reason: parsed.reason };
    if (parsed.kind === 'valid' && parsed.value.kind !== 'root') return { kind: 'existing-episode', episode: parsed.value };
    const scoped = entries.filter(x => x.locator.account === locator.account && x.locator.avatar === locator.avatar);
    const aliases = new Set();
    for (const entry of scoped) {
        const child = validateEpisodeMeta(entry.metadata?.[EPISODE_NAMESPACE], locator.account);
        if (child.kind === 'valid' && child.value.sourceIdentityKind === 'legacy-anchor' && matchLegacySource(child.value, source).kind === 'matched') aliases.add(child.value.rootId);
    }
    if (aliases.size > 1) return { kind: 'ambiguous', reason: 'legacy-root-ids' };
    const integrity = identityKey(metadata.integrity), ownId = parsed.kind === 'valid' ? parsed.value.episodeId : undefined;
    for (const candidateId of [ownId, UUID.test(integrity) ? integrity : undefined].filter(Boolean)) {
        const matches = nativeOriginals(scoped.filter(x => identityKey(x.metadata?.integrity) === candidateId || identityKey(x.metadata?.[EPISODE_NAMESPACE]?.episodeId) === candidateId));
        if (matches.length !== 1 || !sameLocator(matches[0].locator, locator)) return { kind: 'ambiguous', reason: 'duplicate-identity' };
    }
    const fingerprint = source.fingerprint?.hash ?? sha256(canonicalChat(source));
    if (aliases.size) {
        const rootId = [...aliases][0], evidence = naturalSaveEvidence;
        if (scoped.some(entry => {
            const child = validateEpisodeMeta(entry.metadata?.[EPISODE_NAMESPACE], locator.account);
            return child.kind === 'valid' && child.value.sourceIdentityKind === 'legacy-anchor' && child.value.rootId === rootId && !sameLocator(child.value.sourceAnchor.locator, locator);
        })) return { kind: 'ambiguous', reason: 'legacy-root-locators' };
        const upgrade = UUID.test(integrity) && evidence?.kind === 'native-natural-save' && sameLocator(evidence.locator, locator) && evidence.fingerprint === fingerprint;
        return { kind: 'resolved', sourceIdentityKind: 'legacy-anchor', rootId, parentId: rootId, sourceFingerprint: fingerprint,
            ...(upgrade ? { upgradeCandidate: { rootId, integrity, locator, fingerprint } } : {}) };
    }
    if (ownId || UUID.test(integrity)) return { kind: 'resolved', sourceIdentityKind: ownId ? 'episode-id' : 'native-integrity', rootId: ownId ?? integrity, parentId: ownId ?? integrity, sourceFingerprint: fingerprint };
    if (!UUID.test(newRootId)) return { kind: 'needs-root-id', sourceFingerprint: fingerprint };
    const allocated = identityKey(newRootId);
    if (scoped.some(x => [x.metadata?.integrity, x.metadata?.[EPISODE_NAMESPACE]?.episodeId, x.metadata?.[EPISODE_NAMESPACE]?.rootId].some(id => identityKey(id) === allocated))) return { kind: 'ambiguous', reason: 'allocated-root-id-collision' };
    return { kind: 'resolved', sourceIdentityKind: 'legacy-anchor', rootId: allocated, parentId: allocated, sourceFingerprint: fingerprint };
}
