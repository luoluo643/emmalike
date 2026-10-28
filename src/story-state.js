// New storage is scoped to an authenticated account. Unowned legacy drafts are never adopted.
export const storyKey = (kind, account, avatar, file) => account
    ? `tavern-lite:v2:${kind}:${JSON.stringify([account, avatar, String(file || '__new__').replace(/\.jsonl$/, '')])}` : null;
export function readStory(key) {
    try { return key ? JSON.parse(localStorage.getItem(key)) : null; } catch { return null; }
}
export function writeStory(key, value) {
    try { if (key) value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch { /* private/full storage */ }
}
export function moveStory(account, avatar, from, to) {
    for (const kind of ['reading', 'pending', 'draft', 'episode-form']) {
        const old = storyKey(kind, account, avatar, from), next = storyKey(kind, account, avatar, to);
        const value = readStory(old);
        if (value != null) { writeStory(next, value); writeStory(old, null); }
    }
}

// A content check, never a claim that the array index is a stable message identity.
export function fingerprint(value) {
    const s = String(value ?? '');
    let a = 2166136261, b = 5381;
    for (let i = 0; i < s.length; i++) { a = Math.imul(a ^ s.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ s.charCodeAt(i); }
    return `${s.length}:${a >>> 0}:${b >>> 0}`;
}
export const messageMark = m => fingerprint(JSON.stringify([m.name, !!m.is_user, !!m.is_system, m.mes ?? '']));
export function findAnchor(messages, saved) {
    if (!saved?.anchor || !messages.length) return null;
    const marks = new Map();
    messages.forEach((m, index) => {
        const mark = messageMark(m);
        const hits = marks.get(mark) || []; hits.push(index); marks.set(mark, hits);
    });
    for (const candidate of [saved.anchor, ...(saved.neighbors || [])]) {
        const hits = marks.get(candidate.mark);
        if (hits?.length === 1) return { index: hits[0], exact: candidate === saved.anchor };
    }
    return { index: Math.max(0, Math.min(messages.length - 1, saved.anchor.index || 0)), exact: false };
}
