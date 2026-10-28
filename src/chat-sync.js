// Chat saves from the full app's page. SillyTavern sends the whole chat file on every save (megabytes for a long
// story, which a phone's upload often cannot finish); with the optional tavern-lite-save server plugin only the
// lines that changed go out. A save the network drops is kept in this browser (IndexedDB, per account) and sent
// again when the network is back, also after the page is reloaded, instead of the app's "Chat could not be saved".
// A kept save is only ever applied to the exact file it was made from: when the story was changed elsewhere in
// between, the server's version stays and the user is told. With the plugin, the app's read of the story the shell
// has just read is answered from the shell's copy when the file is unchanged, so a long story downloads once.
import { applyPatch, diffLines, hashLines, isSwitchGapSave } from '../server-chat-save/chat-diff.mjs';
import { EPISODE_NAMESPACE } from './episode-model.js';

const PLUGIN = '/api/plugins/tavern-lite-save';
const DB = 'tavern-lite-chat-sync', STORE = 'pending';
const PATCH_TIMEOUT_MS = 30000;
const FLUSH_BEFORE_READ_MS = 15000;
const RETRY_MS = [2000, 5000, 10000, 20000, 30000];
const KEEP_KNOWN = 3;
const SHELL_READ_MS = 10 * 60 * 1000;
const SAME_CHECK_TIMEOUT_MS = 8000;
// Requests the bridge makes itself and checks the answer of (番外 files): sent exactly as they are.
export const EXACT_HEADER = 'X-Tavern-Lite-Exact';

let account = null;
// The server's copy of a chat as last read or saved: { lines, hash } (hash worked out when first needed).
const known = new Map();
// The newest content the app asked to save that the server does not have yet (this page only).
const latest = new Map();
const queues = new Map();
let plugin = null;
let token = null;
const listeners = new Set();
let status = { pending: 0 };
let retryTimer = 0, retryStep = 0;
// The story the shell read for its preview: { key, lines, at }. The full app opens the same story moments later, and a
// long one is megabytes; its read is answered from this copy once the server says the file is still exactly it.
let shellRead = null;

const keyOf = (handle, avatar, file) => JSON.stringify([handle, String(avatar), String(file).replace(/\.jsonl$/, '')]);
const sameLines = (a, b) => a.length === b.length && a.every((line, i) => line === b[i]);

function emit(type, detail) {
    for (const fn of listeners) {
        try { fn(type, detail); } catch (error) { console.error(error); }
    }
}

/** fn(type, detail): 'status' { pending }, 'synced' (everything kept is saved now), 'conflict' { file }. */
export function onChatSync(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export const chatSyncStatus = () => status;

/** The signed-in account (null when signed out); saves kept for it are sent again from now on. */
export function setChatSyncAccount(handle) {
    // A new sign-in has a new token, even for the same account.
    token = null;
    if ((handle || null) !== account) {
        account = handle || null;
        known.clear();
        latest.clear();
        shellRead = null;
        plugin = null;
        refreshStatus();
    }
    if (account) scheduleRetry(500);
}

export function retryChatSync() {
    retryStep = 0;
    scheduleRetry(0);
}

if (typeof window !== 'undefined') {
    addEventListener('online', retryChatSync);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && status.pending) retryChatSync(); });
}

// ---- kept saves (IndexedDB) ----

let opening = null;
function db() {
    opening ??= new Promise(resolve => {
        try {
            const request = indexedDB.open(DB, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
            request.onsuccess = () => resolve(request.result);
            request.onerror = request.onblocked = () => resolve(null);
        } catch { resolve(null); }
    });
    return opening;
}

async function run(mode, work) {
    const base = await db();
    if (!base) return { ok: false, value: null };
    return new Promise(resolve => {
        try {
            const tx = base.transaction(STORE, mode);
            const request = work(tx.objectStore(STORE));
            tx.oncomplete = () => resolve({ ok: true, value: request?.result ?? null });
            tx.onerror = tx.onabort = () => resolve({ ok: false, value: null });
        } catch { resolve({ ok: false, value: null }); }
    });
}

const putKept = async record => (await run('readwrite', s => s.put(record))).ok;
const getKept = async id => (await run('readonly', s => s.get(id))).value;
const listKept = async () => ((await run('readonly', s => s.getAll())).value ?? []).filter(r => r.account === account);
async function dropKept(id, target) {
    // Only the save that was sent: a newer one kept meanwhile stays.
    if (target !== undefined) {
        const record = await getKept(id);
        if (record && record.target !== target) return;
    }
    await run('readwrite', s => s.delete(id));
}

async function refreshStatus() {
    const before = status.pending;
    const pending = account ? (await listKept()).length : 0;
    if (pending === status.pending) return;
    status = { pending };
    emit('status', status);
    if (before > 0 && pending === 0) emit('synced');
}

function scheduleRetry(delay) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(retryAll, delay ?? RETRY_MS[Math.min(retryStep, RETRY_MS.length - 1)]);
}

async function retryAll() {
    if (!account) return;
    const records = await listKept();
    let again = false;
    for (const record of records) {
        if ((await flushKept(record.id)) === 'retry') again = true;
    }
    retryStep = again ? retryStep + 1 : 0;
    if (again) scheduleRetry();
    refreshStatus();
}

// ---- requests ----

function enqueue(key, work) {
    const prior = queues.get(key) ?? Promise.resolve();
    const next = prior.catch(() => { }).then(work);
    queues.set(key, next);
    next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => { });
    return next;
}

async function csrf() {
    if (!token) {
        const response = await fetch('/csrf-token', { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error(`csrf ${response.status}`);
        token = (await response.json()).token;
    }
    return token;
}

async function shellHeaders() {
    return { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrf() };
}

/** Whether the server plugin takes patches; unknown (null) after a network failure, so it is asked again. */
async function pluginReady(headers) {
    if (plugin !== null) return plugin;
    try {
        const response = await fetch(`${PLUGIN}/probe`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: headers ?? await shellHeaders(), body: '{}' });
        if (response.ok) plugin = (await response.json().catch(() => ({})))?.supported === true;
        else if (response.status === 404 || response.status === 501) plugin = false;
        return plugin === true;
    } catch {
        return false;
    }
}

async function withTimeout(ms, signal, work) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const stop = () => controller.abort();
    signal?.addEventListener?.('abort', stop);
    try {
        return await work(controller.signal);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', stop);
    }
}

async function gzipped(text) {
    if (text.length < 32 * 1024 || typeof CompressionStream !== 'function') return null;
    try {
        return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    } catch {
        return null;
    }
}

// The request did not get through (a gateway or the connection), as opposed to the app answering with an error: only
// those are kept and sent again. An error the app itself gave is reported as before.
const dropped = status => status === 0 || status === 408 || status === 429 || status === 502 || status === 503 || status === 504;

/** 'ok' (with hash) | 'base' | 'integrity' | 'auth' | 'missing' | 'network' */
async function sendPatch(headers, info, base, target, patch) {
    const text = JSON.stringify({ avatar_url: info.avatar, file_name: info.file, base, target, ...patch });
    const packed = await gzipped(text);
    const sendHeaders = new Headers(headers);
    sendHeaders.set('Content-Type', 'application/json');
    sendHeaders.delete('Content-Encoding');
    if (packed) sendHeaders.set('Content-Encoding', 'gzip');
    try {
        const response = await withTimeout(PATCH_TIMEOUT_MS, null, signal => fetch(`${PLUGIN}/patch`, {
            method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: sendHeaders, body: packed ?? text, signal,
        }));
        const data = await response.json().catch(() => ({}));
        if (response.ok && data?.ok) return { kind: 'ok', hash: data.hash };
        if (response.status === 409) return { kind: 'base' };
        if (response.status === 400 && data?.error === 'integrity') return { kind: 'integrity' };
        if (response.status === 401 || response.status === 403) { token = null; return { kind: 'auth' }; }
        if (response.status === 404 || response.status === 501) { plugin = false; return { kind: 'missing' }; }
        if (dropped(response.status)) return { kind: 'network' };
        // Anything else (the plugin failed): the whole chat, as the app would have sent it.
        return { kind: 'missing' };
    } catch {
        return { kind: 'network' };
    }
}

/** A whole-chat save; 'ok' | 'integrity' (with the answer for the app) | 'auth' | 'network' | 'error'. */
async function classifyFull(promise) {
    try {
        const response = await promise;
        if (response.ok) return { kind: 'ok', response };
        if (response.status === 401 || response.status === 403) { token = null; return { kind: 'auth', response }; }
        if (response.status === 400) {
            const data = await response.clone().json().catch(() => ({}));
            if (data?.error === 'integrity') return { kind: 'integrity', response };
        }
        if (dropped(response.status)) return { kind: 'network', response };
        return { kind: 'error', response };
    } catch {
        return { kind: 'network' };
    }
}

// A slow phone uploads around 10 KB/s: whole-chat saves get time for that, then count as dropped.
const fullTimeout = bytes => Math.min(300000, Math.max(60000, bytes / 8));

function remember(key, lines, hash = null) {
    known.delete(key);
    known.set(key, { lines, hash });
    while (known.size > KEEP_KNOWN) known.delete(known.keys().next().value);
}

const baseHash = entry => entry ? (entry.hash ??= hashLines(entry.lines)) : null;

const okFor = win => new win.Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });

function headerValue(headers, name) {
    try { return new Headers(headers ?? {}).get(name); } catch { return null; }
}

async function bodyText(init) {
    const body = init?.body;
    if (typeof body === 'string') return body;
    if (!body || !/gzip/i.test(headerValue(init.headers, 'Content-Encoding') ?? '') || typeof DecompressionStream !== 'function') return null;
    try {
        return await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    } catch {
        return null;
    }
}

function sizeOf(body) {
    return typeof body === 'string' ? body.length : (body?.byteLength ?? 0);
}

// ---- the full app's /api/chats/save and /api/chats/get ----

/** Handles the page's POST /api/chats/save; `send` is the page's own fetch. */
export async function saveThroughSync(win, send, input, init) {
    const handle = account;
    if (!handle || headerValue(init?.headers, EXACT_HEADER)) {
        if (handle) forgetFrom(init);
        return send(input, init);
    }
    const text = await bodyText(init);
    let payload = null;
    try { payload = text === null ? null : JSON.parse(text); } catch { /* sent as it is */ }
    if (!payload || !Array.isArray(payload.chat) || typeof payload.avatar_url !== 'string' || payload.file_name === undefined) return send(input, init);
    const info = { avatar: payload.avatar_url, file: String(payload.file_name), chName: payload.ch_name };
    // Not sent: it would empty the story the app is about to open (see isSwitchGapSave). The app reads the file next
    // and saves its real content with a mark from then on.
    if (isSwitchGapSave(payload.chat)) {
        console.warn('[tavern-lite] a save made while switching stories was not sent', info.file);
        return okFor(win);
    }
    const key = keyOf(handle, info.avatar, info.file);
    const lines = payload.chat.map(entry => JSON.stringify(entry));
    // A 番外 file has its own record of saves that did not go through and recovers them itself (bridge-episodes.js):
    // it is sent as only what changed, but a dropped save is reported, not kept.
    const keep = !payload.chat[0]?.chat_metadata?.[EPISODE_NAMESPACE];
    return enqueue(key, () => saveOne({ win, send, input, init, handle, key, info, lines, force: payload.force === true, keep }));
}

async function saveOne({ win, send, input, init, handle, key, info, lines, force, keep }) {
    const headers = plainHeaders(init.headers);
    const full = () => classifyFull(withTimeout(fullTimeout(sizeOf(init.body)), init.signal, signal => send(input, { ...init, signal })));
    if (force) {
        const result = await full();
        if (result.kind === 'ok') { remember(key, lines); latest.delete(key); await dropKept(key); refreshStatus(); }
        return result.response ?? Promise.reject(new TypeError('Failed to fetch'));
    }
    const base = known.get(key);
    if (base && sameLines(base.lines, lines)) {
        latest.delete(key);
        await dropKept(key);
        refreshStatus();
        return okFor(win);
    }
    latest.set(key, { lines, info });
    const target = hashLines(lines);
    const record = { id: key, account: handle, ...info, base: baseHash(base), target, time: Date.now() };
    if (base && await pluginReady(headers)) {
        const patch = diffLines(base.lines, lines);
        const kept = keep && await putKept({ ...record, patch });
        const result = await sendPatch(headers, info, record.base, target, patch);
        if (result.kind === 'ok') {
            saved(key, lines, result.hash, target);
            return okFor(win);
        }
        if (result.kind === 'integrity') {
            latest.delete(key); await dropKept(key, target); refreshStatus();
            return new win.Response(JSON.stringify({ error: 'integrity' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        if (result.kind === 'network' || result.kind === 'auth') return keptForLater(win, kept, result.kind);
        // 'base' (the file is not the one the patch was made for, e.g. changed in another tab) or no plugin: the
        // whole chat, as the app would have sent it.
    }
    const result = await full();
    if (result.kind === 'ok') { saved(key, lines, target, target); return result.response; }
    if (result.kind === 'network' || result.kind === 'auth') return keptForLater(win, keep && await putKept({ ...record, lines }), result.kind, result.response);
    // The app answered with an error: reported as before, and nothing is kept for it (a patch kept just before this
    // attempt is let go too).
    latest.delete(key);
    await dropKept(key, target);
    refreshStatus();
    return result.response;
}

function saved(key, lines, hash, target) {
    remember(key, lines, hash);
    latest.delete(key);
    dropKept(key, target).then(refreshStatus);
}

// The app is told the save went through only when it is safely kept on this device; it then goes out later. A
// session that has ended takes the shell to its login page; the save goes out once signed in again.
function keptForLater(win, kept, kind, response) {
    if (kind === 'auth') dispatchEvent(new Event('tl-auth-required'));
    if (!kept) return response ?? Promise.reject(new TypeError('Failed to fetch'));
    scheduleRetry();
    refreshStatus();
    return okFor(win);
}

// The app's request headers (its session token) for our own requests, without what described its body.
function plainHeaders(headers) {
    try {
        const copy = new Headers(headers ?? {});
        copy.delete('Content-Encoding');
        copy.delete('Content-Length');
        copy.set('Content-Type', 'application/json');
        return Object.fromEntries(copy);
    } catch {
        return { 'Content-Type': 'application/json' };
    }
}

function forgetFrom(init) {
    try {
        const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        if (payload?.avatar_url) known.delete(keyOf(account, payload.avatar_url, payload.file_name));
    } catch { /* not a chat */ }
}

/** Sends a kept save again: 'done' | 'retry' | 'conflict' | 'none'. */
function flushKept(key) {
    return enqueue(key, async () => {
        const record = await getKept(key);
        if (!record || record.account !== account) return 'none';
        const info = { avatar: record.avatar, file: record.file, chName: record.chName };
        const mine = latest.get(key), base = known.get(key);
        let headers;
        try { headers = await shellHeaders(); } catch { return 'retry'; }
        // This page's newest content goes out against the server copy it knows; a save kept from an earlier visit
        // goes out as it was kept.
        if (await pluginReady(headers) && (mine ? !!base : !!record.patch)) {
            const target = mine ? hashLines(mine.lines) : record.target;
            const result = mine
                ? await sendPatch(headers, info, baseHash(base), target, diffLines(base.lines, mine.lines))
                : await sendPatch(headers, info, record.base, target, record.patch);
            if (result.kind === 'ok') {
                if (mine) remember(key, mine.lines, result.hash);
                else known.delete(key);
                latest.delete(key);
                await dropKept(key, record.target);
                return 'done';
            }
            if (result.kind === 'network' || result.kind === 'auth') return 'retry';
            if (result.kind === 'integrity') return conflict(key, record);
            // 'base', or the plugin is gone: the whole chat (see below).
        }
        let lines = mine?.lines ?? record.lines ?? null;
        // Without this page's own copy, only the version the save was made from may be replaced.
        if (!mine) {
            const server = await readServer(headers, info);
            if (server === 'network') return 'retry';
            const now = server ? hashLines(server) : null;
            if (now === record.target) { known.delete(key); await dropKept(key, record.target); return 'done'; }
            if (record.base ? now !== record.base : server?.length) return conflict(key, record);
            lines ??= server && record.patch ? applyPatch(server, record.patch) : null;
        }
        if (!lines) return conflict(key, record);
        const body = `{"ch_name":${JSON.stringify(info.chName ?? '')},"file_name":${JSON.stringify(info.file)},"avatar_url":${JSON.stringify(info.avatar)},"force":false,"chat":[${lines.join(',')}]}`;
        const packed = await gzipped(body);
        const sendHeaders = { ...headers, ...(packed ? { 'Content-Encoding': 'gzip' } : {}) };
        const result = await classifyFull(withTimeout(fullTimeout(sizeOf(packed ?? body)), null, signal => fetch('/api/chats/save', {
            method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: sendHeaders, body: packed ?? body, signal })));
        if (result.kind === 'ok') {
            remember(key, lines);
            latest.delete(key);
            await dropKept(key, record.target);
            return 'done';
        }
        if (result.kind === 'auth') dispatchEvent(new Event('tl-auth-required'));
        if (result.kind === 'integrity' || result.kind === 'error') return conflict(key, record);
        return 'retry';
    });
}

async function conflict(key, record) {
    latest.delete(key);
    known.delete(key);
    await dropKept(key, record.target);
    emit('conflict', { avatar: record.avatar, file: record.file });
    return 'conflict';
}

async function readServer(headers, info) {
    try {
        const response = await fetch('/api/chats/get', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers,
            body: JSON.stringify({ ch_name: info.chName, file_name: info.file, avatar_url: info.avatar }) });
        if (!response.ok) return response.status >= 500 || response.status === 401 || response.status === 403 ? 'network' : null;
        const data = await response.json();
        return Array.isArray(data) ? data.map(entry => JSON.stringify(entry)) : null;
    } catch {
        return 'network';
    }
}

/**
 * The lines the app should see for a chat just read from the server: those of a save kept for it when it was made
 * from exactly this version (it is then sent again), otherwise the server's.
 */
async function resolveKept(key, serverLines) {
    const record = await getKept(key);
    if (!record || record.account !== account) return serverLines;
    const now = hashLines(serverLines);
    if (now === record.target) {
        await dropKept(key, record.target);
        refreshStatus();
        return serverLines;
    }
    if (record.base ? now !== record.base : serverLines.length) {
        await conflict(key, record);
        refreshStatus();
        return serverLines;
    }
    const lines = latest.get(key)?.lines ?? record.lines ?? (record.patch ? applyPatch(serverLines, record.patch) : null);
    if (!lines) { await conflict(key, record); refreshStatus(); return serverLines; }
    latest.set(key, { lines, info: { avatar: record.avatar, file: record.file, chName: record.chName } });
    scheduleRetry(300);
    return lines;
}

/** The shell read this chat (`data` as the server answered, before kept saves are applied); see fromShellRead. */
export function rememberShellRead(avatar, file, data) {
    shellRead = account && Array.isArray(data)
        ? { key: keyOf(account, avatar, file), lines: data.map(entry => JSON.stringify(entry)), at: Date.now() }
        : null;
}

/** The shell's read of this chat when the file on the server is still exactly that text, otherwise null. */
async function fromShellRead(key, request) {
    const read = shellRead;
    if (!read || read.key !== key) return null;
    // Used once: from here on the app has its own copy, and the preview's is not kept around.
    shellRead = null;
    if (Date.now() - read.at > SHELL_READ_MS) return null;
    try {
        const headers = await shellHeaders();
        if (!(await pluginReady(headers))) return null;
        const hash = hashLines(read.lines);
        // A patch from the file to itself writes nothing: the plugin answers "unchanged" when the file is exactly this
        // text and refuses it (409) when it is anything else.
        const response = await withTimeout(SAME_CHECK_TIMEOUT_MS, null, signal => fetch(`${PLUGIN}/patch`, {
            method: 'POST', credentials: 'same-origin', cache: 'no-store', headers, signal,
            body: JSON.stringify({ avatar_url: request.avatar_url, file_name: String(request.file_name), base: hash, target: hash }),
        }));
        const data = await response.json().catch(() => null);
        return response.ok && data?.unchanged === true ? read.lines : null;
    } catch {
        return null;
    }
}

/** Handles the page's POST /api/chats/get: a kept save is sent first, and shown if it still cannot be. */
export async function getThroughSync(win, send, input, init) {
    const handle = account;
    if (headerValue(init?.headers, EXACT_HEADER)) return send(input, init);
    let request = null;
    try { request = typeof init?.body === 'string' ? JSON.parse(init.body) : null; } catch { /* sent as it is */ }
    if (!handle || typeof request?.avatar_url !== 'string' || request.file_name === undefined) return send(input, init);
    const key = keyOf(handle, request.avatar_url, request.file_name);
    if (await getKept(key)) {
        await Promise.race([flushKept(key), new Promise(resolve => setTimeout(resolve, FLUSH_BEFORE_READ_MS))]);
        refreshStatus();
    }
    const reused = await fromShellRead(key, request);
    const response = reused
        ? new win.Response(`[${reused.join(',')}]`, { status: 200, headers: { 'Content-Type': 'application/json' } })
        : await send(input, init);
    if (!response.ok || handle !== account) return response;
    let lines = reused;
    if (!lines) {
        let data;
        try { data = await response.clone().json(); } catch { return response; }
        if (!Array.isArray(data)) return response;
        lines = data.map(entry => JSON.stringify(entry));
    }
    await queues.get(key)?.catch(() => { });
    remember(key, lines);
    const shown = await resolveKept(key, lines);
    if (shown === lines) return response;
    const headers = [...response.headers].filter(([name]) => !/^content-(length|encoding)$/i.test(name));
    return new win.Response(`[${shown.join(',')}]`, { status: 200, statusText: response.statusText, headers });
}

/** For the shell's own reads (the story before the full app is ready): the same as the app will see. */
export async function withKeptChat(avatar, file, data) {
    if (!account || !Array.isArray(data)) return data;
    const key = keyOf(account, avatar, file);
    if (!(await getKept(key))) return data;
    const lines = data.map(entry => JSON.stringify(entry));
    const shown = await resolveKept(key, lines);
    return shown === lines ? data : shown.map(line => JSON.parse(line));
}
