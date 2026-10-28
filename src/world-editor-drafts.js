import { cloneJson } from './episode-model.js';
import { pruneSettledPresetReceipts } from './preset-editor-model.js';

// Drafts are device-local only; this factory never touches storage during bridge initialization.
// Each identity includes the authenticated account. A new-entry draft retains its assigned UID
// after confirmation, so reloading its original URL can never create a second entry.
// The error stands only until storage works again: one full moment must not leave every entry read-only.
export function createWorldDraftStore({ storage = () => globalThis.localStorage, prefix = 'tavern-lite:world-draft:v1:' } = {}) {
    const memory = new Map();
    let error = '';
    const fail = () => { error = '本机存不了世界书草稿，现在只能看；先把写的内容复制下来'; };
    // Device storage is shared with old preset save receipts; settled ones are cleared before giving up.
    const write = (target, key, encoded) => {
        try { target.setItem(key, encoded); }
        catch (e) { if (!pruneSettledPresetReceipts(target)) throw e; target.setItem(key, encoded); }
    };
    return {
        get error() { return error; },
        get(scope) {
            if (memory.has(scope)) return cloneJson(memory.get(scope));
            try {
                const raw = storage().getItem(prefix + scope);
                if (!raw) return undefined;
                const value = JSON.parse(raw);
                if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.revision)) throw new Error('Invalid draft');
                memory.set(scope, value); return cloneJson(value);
            } catch { fail(); return undefined; }
        },
        has(scope) { return this.get(scope) !== undefined; },
        set(scope, value) {
            memory.set(scope, cloneJson(value));
            try {
                const encoded = JSON.stringify(value), target = storage();
                write(target, prefix + scope, encoded);
                if (target.getItem(prefix + scope) !== encoded) throw new Error('Draft readback mismatch');
                error = ''; return true;
            } catch { fail(); return false; }
        },
        // Off the device only (kept for this visit): an entry with nothing unsaved needs no stored draft, and stored
        // ones held three copies of the entry each, never removed when leaving by the phone's back.
        drop(scope) { try { storage().removeItem(prefix + scope); } catch { /* kept in memory; the next set reports storage */ } },
        /** Removes stored drafts `stale(value, scope)` calls left over (scopes open in this visit are left alone). */
        prune(stale) {
            try {
                const target = storage(), keys = [];
                for (let i = 0; i < target.length; i++) { const key = target.key(i); if (key?.startsWith(prefix) && !memory.has(key.slice(prefix.length))) keys.push(key); }
                for (const key of keys) { let value; try { value = JSON.parse(target.getItem(key)); } catch { continue; } if (value && stale(value, key.slice(prefix.length))) target.removeItem(key); }
            } catch { /* storage unavailable: nothing to clear */ }
        },
        delete(scope) {
            try {
                const target = storage(); target.removeItem(prefix + scope);
                if (target.getItem(prefix + scope) !== null) throw new Error('Draft delete mismatch');
                memory.delete(scope); return true;
            } catch { fail(); return false; }
        },
    };
}
