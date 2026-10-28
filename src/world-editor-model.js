import { canonicalJson, cloneJson, sha256 } from './episode-model.js';

export const WORLD_ENTRY_FIELDS = ['comment', 'content', 'key', 'keysecondary', 'constant', 'vectorized', 'selective', 'selectiveLogic',
    'order', 'position', 'depth', 'role', 'disable', 'probability', 'useProbability', 'group', 'groupOverride', 'groupWeight',
    'excludeRecursion', 'preventRecursion', 'delayUntilRecursion', 'scanDepth', 'caseSensitive', 'matchWholeWords',
    'useGroupScoring', 'sticky', 'cooldown', 'delay', 'ignoreBudget'];
export const WORLD_FIELD_LABELS = { comment: '标题', content: '内容', key: '关键词', keysecondary: '补充关键词', constant: '常驻', vectorized: '向量匹配',
    selective: '补充条件开关', selectiveLogic: '补充条件', order: '顺序', position: '放置位置', depth: '深度', role: '消息身份', disable: '停用',
    probability: '触发概率', useProbability: '概率开关', group: '分组', groupOverride: '组内优先', groupWeight: '组内权重',
    excludeRecursion: '排除连带触发', preventRecursion: '不触发其他条目', delayUntilRecursion: '仅连带触发', scanDepth: '查看消息数',
    caseSensitive: '区分大小写', matchWholeWords: '匹配整个词', useGroupScoring: '分组评分', sticky: '持续', cooldown: '冷却', delay: '推迟', ignoreBudget: '忽略预算' };
export const COMMON_WORLD_FIELDS = ['comment', 'content', 'key', 'constant', 'vectorized', 'disable'];
export const worldError = (code, message, detail) => Object.assign(new Error(message), { code, ...(detail === undefined ? {} : { detail }) });
const valueKey = value => value === undefined ? 'undefined' : canonicalJson(value);
export const sameWorldValue = (a, b) => valueKey(a) === valueKey(b);
export const worldFingerprint = value => sha256(canonicalJson(value));
export const WORLD_DECISION_ACK = 'late-write-can-overwrite-v1';
// Only the previous binding's explicit before-call terminal receipt is trusted.
// Provisional prepared/armed records, OLD and resolved do not prove a finished no-write attempt.
export const isWorldNotSubmitted = op => ['not-saved', 'not-submitted'].includes(op?.stage) && op.writeSettled === 'not-started';
export function normalizeWorldOperation(op) {
    if (!op || op.stage === 'confirmed') return op;
    if (isWorldNotSubmitted(op)) return { ...op, stage: 'not-submitted', retryAllowed: true };
    if (['not-saved', 'not-submitted'].includes(op.stage)) return { ...op, stage: 'unconfirmed', retryAllowed: false, legacyOutcome: op.stage };
    return op;
}
export const validWorldBasis = value => !!value && (value.kind === 'missing' && value.fingerprint === undefined
    || value.kind === 'present' && /^[a-f0-9]{64}$/.test(value.fingerprint));
export function hasWorldUserDecision(op) {
    const value = op?.userDecision;
    return !!value && value.schemaVersion === 1 && value.kind === 'user-resolved' && value.acknowledgement === WORLD_DECISION_ACK
        && ['account', 'name', 'operationId'].every(key => typeof op[key] === 'string' && op[key].length > 0 && value[key] === op[key])
        && Number.isSafeInteger(value.decidedAt) && value.decidedAt > 0
        && Number.isSafeInteger(value.operationRevision) && value.operationRevision > 0 && value.operationRevision < op.revision
        && validWorldBasis(value.basis);
}
export const isBlockingWorldOperation = op => !hasWorldUserDecision(op)
    && op?.stage !== 'confirmed'
    && !isWorldNotSubmitted(op);
export const worldEntryTitle = entry => entry?.comment?.trim() || (entry?.key ?? []).filter(Boolean).join('、') || '未命名条目';
export function validateWorldName(name) {
    if (typeof name !== 'string' || !name.trim() || name !== name.trim() || /[\\/:*?"<>|\x00-\x1f]/.test(name) || ['.', '..'].includes(name)) throw worldError('INVALID_WORLD_NAME', '名字不能包含 \\ / : * ? " < > |');
    return name;
}
export function validateWorldBook(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) throw worldError('WORLD_UNREADABLE', '世界书没加载全');
    for (const entry of Object.values(value.entries)) if (!entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.uid) || entry.uid < 0) throw worldError('WORLD_UNREADABLE', '条目身份不完整，不能覆盖保存');
    return cloneJson(value);
}
export function worldChanges(base, next) {
    return WORLD_ENTRY_FIELDS.filter(key => !sameWorldValue(base?.[key], next?.[key])).map(key => ({ key, label: WORLD_FIELD_LABELS[key], before: base?.[key], after: next?.[key] }));
}
export function mergeWorldEntry(base, current, patch, resolutions = {}) {
    if (!current) return { kind: 'missing', conflicts: [{ key: 'uid', label: '此条目', before: base, mine: patch, server: null }] };
    const next = cloneJson(current), conflicts = [];
    for (const [key, value] of Object.entries(patch)) {
        if (!WORLD_ENTRY_FIELDS.includes(key)) continue;
        if (resolutions[key] === 'server') continue;
        if (resolutions[key] !== 'mine' && !sameWorldValue(current[key], base?.[key]) && !sameWorldValue(current[key], value)) {
            conflicts.push({ key, label: WORLD_FIELD_LABELS[key], before: base?.[key], mine: value, server: current[key] }); continue;
        }
        next[key] = cloneJson(value);
    }
    return { kind: conflicts.length ? 'conflict' : 'merged', entry: next, conflicts };
}
export function worldSearch(entry, query) {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return { matched: true, hits: [] };
    const hits = [];
    for (const key of WORLD_ENTRY_FIELDS) {
        const value = entry[key];
        if (value == null) continue;
        const text = Array.isArray(value) ? value.join('、') : typeof value === 'object' ? JSON.stringify(value) : String(value);
        const index = text.toLocaleLowerCase().indexOf(needle);
        if (index < 0) continue;
        const start = Math.max(0, index - 24), end = Math.min(text.length, index + needle.length + 54);
        hits.push({ key, label: WORLD_FIELD_LABELS[key], advanced: !COMMON_WORLD_FIELDS.includes(key),
            snippet: `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`, index, length: needle.length });
    }
    return { matched: hits.length > 0, hits };
}
export function refreshWorldDraft({ opened, base, draft, server }) {
    if (!server) return { base, draft, conflicts: [{ key: 'uid', label: '此条目', server: null }], opened };
    const nextBase = cloneJson(base), nextDraft = cloneJson(draft), conflicts = [];
    for (const key of WORLD_ENTRY_FIELDS) {
        const dirty = !sameWorldValue(draft[key], base[key]);
        if (!dirty) {
            if (server[key] === undefined) { delete nextDraft[key]; delete nextBase[key]; }
            else { nextDraft[key] = cloneJson(server[key]); nextBase[key] = cloneJson(server[key]); }
        } else if (!sameWorldValue(server[key], base[key]) && !sameWorldValue(server[key], draft[key])) conflicts.push({ key, label: WORLD_FIELD_LABELS[key], before: base[key], mine: draft[key], server: server[key] });
        else if (sameWorldValue(server[key], draft[key])) nextBase[key] = cloneJson(server[key]);
    }
    return { opened, base: nextBase, draft: nextDraft, conflicts };
}
export function applySavedWorldDraft({ current, submitted, saved }) {
    const next = cloneJson(saved);
    for (const key of WORLD_ENTRY_FIELDS) if (!sameWorldValue(current[key], submitted[key])) {
        if (current[key] === undefined) delete next[key]; else next[key] = cloneJson(current[key]);
    }
    return next;
}
