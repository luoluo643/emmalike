// The line hash and line diff of server-chat-save/chat-diff.mjs, for code the full app loads straight from the extension
// folder (the bridge), where that folder is not served. Kept identical: tests/chat-diff.test.mjs compares the two.
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
