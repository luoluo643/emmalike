import { fingerprint } from './story-state.js';
export const sameStory = (a, b) => !!a && !!b && (a.avatar || '') === (b.avatar || '') && String(a.groupId || '') === String(b.groupId || '') && a.file === b.file;
/** Whether a source names a story it can be found in again: a chat file of a character or of a group chat. */
export const hasStory = source => !!source?.file && !!(source.avatar || source.groupId);
export function makeSource(scope, message, index) {
    const raw = String(message.mes ?? '');
    return { ...scope, index, swipe: message.swipe_id ?? 0, raw, mark: fingerprint(raw), name: message.name || '',
        is_user: !!message.is_user, is_system: !!message.is_system, capturedAt: Date.now() };
}
export function candidates(message) {
    const list = message.swipes?.length ? [...message.swipes] : [message.mes ?? ''];
    list[message.swipe_id ?? 0] = message.mes ?? '';
    return list.map(String);
}
// Strict source lookup: never reuse the approximate reading-restoration fallback or trust an array index.
export function locateSource(messages, source) {
    const matches = [];
    messages.forEach((m, index) => {
        if ((m.name || '') !== source.name || !!m.is_user !== source.is_user || !!m.is_system !== source.is_system) return;
        candidates(m).forEach((raw, swipe) => { if (raw === source.raw && fingerprint(raw) === source.mark) matches.push({ index, swipe, current: swipe === (m.swipe_id ?? 0), message: m }); });
    });
    return matches.length === 1 ? matches[0] : null;
}
export function newRecord(kind, text, source) {
    if (!hasStory(source)) throw new Error('不知道这段话在哪个故事里，没有收藏');
    return { id: crypto.randomUUID(), schema: 1, kind, text, source, createdAt: Date.now() };
}
export function mutation(record, action, extra = {}) {
    return { id: record.id, expected: record.revision ?? 0, action, operationId: crypto.randomUUID(), ...extra };
}
