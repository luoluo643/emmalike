// Shared by the tavern-lite-save server plugin and the lite shell. AGPL-3.0-or-later.
// A chat file is one JSON line per entry (header first). A save sends only the lines that differ from the copy both
// sides agree on, named by a hash of the whole file, so a file that changed elsewhere in between is never patched.

/** Hash of lines joined by "\n" (the file's text), without building that text. Not cryptographic. */
export function hashLines(lines) {
    let length = 0;
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let n = 0; n < lines.length; n++) {
        if (n > 0) {
            h1 = Math.imul(h1 ^ 10, 2654435761);
            h2 = Math.imul(h2 ^ 10, 1597334677);
            length++;
        }
        const line = lines[n];
        for (let i = 0; i < line.length; i++) {
            const c = line.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 2654435761);
            h2 = Math.imul(h2 ^ c, 1597334677);
        }
        length += line.length;
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const hex = value => (value >>> 0).toString(16).padStart(8, '0');
    return `${length.toString(36)}-${hex(h2)}${hex(h1)}`;
}

export const hashText = text => hashLines(String(text).split('\n'));

/** The lines of `next` that differ from `old`, by position: { length, set: [[index, line], …] }. */
export function diffLines(old, next) {
    const set = [];
    for (let i = 0; i < next.length; i++) {
        if (i >= old.length || old[i] !== next[i]) set.push([i, next[i]]);
    }
    return { length: next.length, set };
}

export const MAX_LINES = 1000000;

/** `lines` with the patch applied, or null when the patch is malformed or leaves a line unknown. */
export function applyPatch(lines, patch) {
    const length = patch?.length;
    if (!Number.isInteger(length) || length < 0 || length > MAX_LINES || !Array.isArray(patch.set)) return null;
    const out = lines.slice(0, length);
    out.length = length;
    for (const entry of patch.set) {
        if (!Array.isArray(entry) || entry.length !== 2) return null;
        const [index, line] = entry;
        if (!Number.isInteger(index) || index < 0 || index >= length || typeof line !== 'string') return null;
        out[index] = line;
    }
    for (let i = 0; i < length; i++) if (typeof out[i] !== 'string') return null;
    return out;
}
