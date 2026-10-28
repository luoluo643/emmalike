// Drafts of character edits. They live in this browser (IndexedDB, falling back to localStorage) and are saved as
// you type; nothing reaches the character card until you apply.
// Each draft belongs to the account signed in when it was written: another account on this browser never sees it,
// and drafts kept before that rule (no account in the key) are not handed to whoever signs in next.

const DB = 'tavern-lite-drafts';
const STORE = 'drafts';
const FALLBACK = 'tavern-lite:draft:';
let opening;

function open() {
    opening ||= new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) return reject(new Error('no indexedDB'));
        const request = indexedDB.open(DB, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => { db.close(); opening = undefined; };
            resolve(db);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('blocked'));
    }).catch(error => {
        opening = undefined;
        throw error;
    });
    return opening;
}

async function run(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = action(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

function local(action) {
    try { return action(localStorage); } catch { return undefined; }
}

const owned = (account, key) => {
    if (!account) throw new Error('还没登录，草稿存不了');
    return `account:${JSON.stringify(account)}:${key}`;
};
const readLocal = id => {
    const text = local(s => s.getItem(FALLBACK + id));
    try { return text ? JSON.parse(text) : null; } catch { return null; }
};

/** The newer of the IndexedDB draft and a copy kept in localStorage while the page was closing. */
export async function getDraft(account, key) {
    const id = owned(account, key);
    let stored = null;
    try { stored = await run('readonly', store => store.get(id)) ?? null; } catch { /* the copy below, if any */ }
    const kept = readLocal(id);
    return kept && (!stored || (kept.at ?? 0) > (stored.at ?? 0)) ? kept : stored;
}

/** Saves a draft. Throws only when neither IndexedDB nor localStorage can keep it, so the caller can warn. */
export async function putDraft(account, key, value) {
    const id = owned(account, key);
    try {
        await run('readwrite', store => store.put(value, id));
        const kept = readLocal(id);
        if (kept && (kept.at ?? 0) <= (value.at ?? 0)) local(s => s.removeItem(FALLBACK + id));
    } catch {
        const ok = local(s => { s.setItem(FALLBACK + id, JSON.stringify(value)); return true; });
        if (!ok) throw new Error('草稿没存到本机，先别离开这个页面');
    }
}

/**
 * Keeps a draft at once, for a page that is closing or reloading: IndexedDB may not finish before the page goes,
 * localStorage does. `getDraft` prefers whichever copy is newer. Returns whether it was kept.
 */
export function keepDraftNow(account, key, value) {
    try {
        const id = owned(account, key);
        return !!local(s => { s.setItem(FALLBACK + id, JSON.stringify(value)); return true; });
    } catch { return false; }
}

export async function deleteDraft(account, key) {
    const id = owned(account, key);
    try { await run('readwrite', store => store.delete(id)); } catch { /* fall through */ }
    local(s => s.removeItem(FALLBACK + id));
}
