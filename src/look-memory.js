// How the full app showed a story's messages last time, and the display regex scripts it ran, kept in this browser
// (IndexedDB, per account) so the next visit looks the same while the full app is still getting ready.
const DB = 'tavern-lite-looks', STORE = 'looks', KEEP_STORIES = 30, KEEP_MESSAGES = 120;

let opening = null;
function db() {
    opening ??= new Promise(resolve => {
        try {
            const request = indexedDB.open(DB, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(STORE);
            request.onsuccess = () => resolve(request.result);
            request.onerror = request.onblocked = () => resolve(null);
        } catch { resolve(null); }
    });
    return opening;
}

async function run(mode, work) {
    const base = await db();
    if (!base) return null;
    return new Promise(resolve => {
        try {
            const tx = base.transaction(STORE, mode);
            const result = work(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(result?.result ?? null);
            tx.onerror = tx.onabort = () => resolve(null);
        } catch { resolve(null); }
    });
}

const storyId = (account, avatar, file) => JSON.stringify(['story', account, avatar, String(file || '').replace(/\.jsonl$/, '')]);
const rulesId = (account, avatar) => JSON.stringify(avatar ? ['rules', account, avatar] : ['rules', account]);
const indexId = account => JSON.stringify(['index', account]);

/** { html: { "index|mark": html }, rules: [...] } for a story; empty when nothing is kept (or storage is off). */
export async function readLooks(account, avatar, file) {
    if (!account || !avatar) return { html: {}, rules: [] };
    const [story, shared, scoped] = await Promise.all([
        file ? run('readonly', s => s.get(storyId(account, avatar, file))) : null,
        run('readonly', s => s.get(rulesId(account))),
        run('readonly', s => s.get(rulesId(account, avatar))),
    ]);
    // The app's order: global, preset, then the character's own scripts.
    const rules = [...(shared?.global ?? []), ...(shared?.preset ?? []), ...(Array.isArray(scoped) ? scoped : [])];
    return { html: story?.html ?? {}, rules };
}

/** Keeps the rendered messages (merged with what was kept before) and the rules the app runs right now. */
export async function keepLooks(account, avatar, file, rendered, rules) {
    if (!account || !avatar || !file) return;
    const id = storyId(account, avatar, file);
    const before = await run('readonly', s => s.get(id));
    const html = { ...(before?.html ?? {}), ...rendered };
    const keys = Object.keys(html);
    if (keys.length > KEEP_MESSAGES) {
        keys.sort((a, b) => parseInt(b) - parseInt(a));
        for (const key of keys.slice(KEEP_MESSAGES)) delete html[key];
    }
    const now = Date.now();
    const index = (await run('readonly', s => s.get(indexId(account)))) ?? {};
    index[id] = now;
    const stale = Object.entries(index).sort((a, b) => b[1] - a[1]).slice(KEEP_STORIES).map(([key]) => key);
    for (const key of stale) delete index[key];
    await run('readwrite', s => {
        s.put({ html, at: now }, id);
        s.put(index, indexId(account));
        for (const key of stale) s.delete(key);
        if (rules) {
            s.put({ global: rules.global ?? [], preset: rules.preset ?? [] }, rulesId(account));
            s.put(rules.scoped ?? [], rulesId(account, avatar));
        }
    });
}
