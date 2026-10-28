/**
 * Which installed extensions can change chat records, read from the extensions themselves instead of a list of names.
 * The label is the manifest's display_name. An extension counts as writing records when its scripts (the manifest's
 * js and the scripts it imports from its own folder) call the app's chat or chat-metadata saving, its chat save API,
 * or the slash commands that set chat variables. An extension whose code cannot be read counts as writing; one whose
 * script is missing does not run, so it does not.
 * `fetchText(url)` returns the text, null for a missing file, and throws when the file cannot be read.
 */
export const CHAT_WRITE_PATTERN = /\bsaveChat(?:Debounced|Conditional)?\b|\bsaveMetadata(?:Debounced)?\b|\/api\/chats\/(?:group\/)?save\b|\/(?:setvar|addvar|incvar|decvar|flushvar)\b/;
const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
const SCRIPT_PATH = /\.m?js(?:[?#]|$)/;
const MAX_FILES = 80;
const MAX_CHARS = 16 * 1024 * 1024;

const fallbackLabel = name => name.replace(/^third-party\//, '');

export async function inspectExtension(name, { fetchText, origin }) {
    const folder = new URL(`/scripts/extensions/${name.split('/').map(encodeURIComponent).join('/')}/`, origin).href;
    const unreadable = label => ({ name, label, writes: true, unreadable: true });
    let manifest;
    try {
        const text = await fetchText(`${folder}manifest.json`);
        if (text === null) return { name, label: fallbackLabel(name), writes: false };
        manifest = JSON.parse(text);
    } catch {
        return unreadable(fallbackLabel(name));
    }
    const label = String(manifest?.display_name ?? '').trim() || fallbackLabel(name);
    if (!manifest?.js) return { name, label, writes: false };
    // Fetched the way the app loads them (the entry keeps its ?ver query), so the browser cache answers.
    const queue = [new URL(manifest.js, folder).href];
    const seen = new Set();
    let chars = 0;
    while (queue.length) {
        const url = queue.shift();
        if (seen.has(url)) continue;
        if (seen.size >= MAX_FILES || chars >= MAX_CHARS) return unreadable(label);
        seen.add(url);
        let text;
        try {
            text = await fetchText(url);
        } catch {
            return unreadable(label);
        }
        if (text === null) continue;
        chars += text.length;
        if (CHAT_WRITE_PATTERN.test(text)) return { name, label, writes: true };
        for (const [, specifier] of text.matchAll(IMPORT_PATTERN)) {
            if (!SCRIPT_PATH.test(specifier)) continue;
            const next = new URL(specifier, url).href;
            if (next.startsWith(folder) && !seen.has(next)) queue.push(next);
        }
    }
    return { name, label, writes: false };
}

export function scanExtensions(names, options) {
    return Promise.all(names.map(name => inspectExtension(name, options)));
}
