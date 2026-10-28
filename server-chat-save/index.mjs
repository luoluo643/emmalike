// tavern-lite-save server plugin (optional). AGPL-3.0-or-later.
// Lets the lite shell save a chat by sending only the lines that changed instead of the whole file: on a phone a long
// story is megabytes per save. The patch names the file it was made against (a hash of its text) and is refused when
// the file on disk is any other, so it never lands on a version it was not made for. Writing goes through
// SillyTavern's own save (its integrity check and backups), and only the signed-in account's chats are touched.
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyPatch, hashLines, isSwitchGapSave } from './chat-diff.mjs';

export const info = {
    id: 'tavern-lite-save',
    name: 'Tavern Lite chat saves',
    description: 'Saves chats from the Tavern Lite shell as only the changed messages.',
};

const VERSION = 2; // 2: /copy
const locks = new Map();
let native = null;

const appModule = file => import(new URL(`../../${file}`, import.meta.url).href);

/**
 * What the app's own /api/chats/save uses (1.19: trySaveChat, the avatar check and the file name rules), or null
 * when this version does not have them: the shell then saves whole chats as before.
 */
function nativeSave() {
    native ??= Promise.all([appModule('src/endpoints/chats.js'), appModule('src/middleware/validateFileName.js'), import('sanitize-filename')])
        .then(([chats, validate, sanitize]) => typeof chats.trySaveChat === 'function' && typeof validate.default === 'function' && typeof sanitize.default === 'function'
            ? { save: chats.trySaveChat, validateAvatar: validate.default, sanitize: sanitize.default }
            : null)
        .catch(error => { console.warn('[tavern-lite-save] SillyTavern chat save not found', error?.message); return null; });
    return native;
}

async function serial(key, fn) {
    const prior = locks.get(key) ?? Promise.resolve();
    const next = prior.catch(() => { }).then(fn);
    locks.set(key, next);
    try {
        return await next;
    } finally {
        if (locks.get(key) === next) locks.delete(key);
    }
}

// The same path as the app's /api/chats/save: the card's folder, then the file name made safe.
function chatFile(req, sanitize) {
    const avatar = req.body?.avatar_url, file = req.body?.file_name;
    if (typeof avatar !== 'string' || !avatar || typeof file !== 'string' || !file) return null;
    const cardName = avatar.replace('.png', '');
    const root = req.user.directories.chats;
    const target = path.join(root, cardName, sanitize(`${file}.jsonl`));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return { target, cardName };
}

async function readText(file) {
    try {
        return await fs.readFile(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

export async function init(router) {
    const express = (await import('express')).default;
    router.use(express.json({ limit: '200mb' }));

    router.post('/probe', async (req, res) => {
        res.send({ ok: true, version: VERSION, supported: !!(await nativeSave()) });
    });

    // { avatar_url, file_name, base, target, length, set } → { ok, hash } | 409 { error: 'base', current }
    // | 400 { error: 'integrity' }. A patch already on disk (its answer was lost) is answered as saved.
    router.post('/patch', async (req, res, next) => {
        const app = await nativeSave();
        if (!app) return res.status(501).send({ error: 'unsupported' });
        app.validateAvatar(req, res, next);
    }, async (req, res) => {
        try {
            const { save, sanitize } = await nativeSave();
            const where = chatFile(req, sanitize);
            const { base, target } = req.body ?? {};
            if (!where || typeof base !== 'string' || typeof target !== 'string') return res.status(400).send({ error: 'request' });
            const outcome = await serial(where.target, async () => {
                const text = await readText(where.target);
                const lines = text === null ? null : text.split('\n');
                const current = lines === null ? null : hashLines(lines);
                if (current === target) return { status: 200, body: { ok: true, hash: current, unchanged: true } };
                if (current !== base) return { status: 409, body: { error: 'base', current } };
                const next = applyPatch(lines, req.body);
                if (!next) return { status: 400, body: { error: 'patch' } };
                let chat;
                try { chat = next.map(line => JSON.parse(line)); } catch { return { status: 400, body: { error: 'patch' } }; }
                // A story with messages is never replaced by an unmarked empty one (see isSwitchGapSave).
                if (isSwitchGapSave(chat) && lines.length > 1) return { status: 400, body: { error: 'integrity' } };
                try {
                    await save(chat, where.target, false, req.user.profile.handle, where.cardName, req.user.directories.backups);
                } catch (error) {
                    if (error?.constructor?.name === 'IntegrityMismatchError') return { status: 400, body: { error: 'integrity' } };
                    throw error;
                }
                return { status: 200, body: { ok: true, hash: hashLines(chat.map(entry => JSON.stringify(entry))) } };
            });
            res.status(outcome.status).send(outcome.body);
        } catch (error) {
            console.error('[tavern-lite-save]', error);
            res.status(500).send({ error: 'server' });
        }
    });

    // { avatar_url, from_file, file_name, base, length, set } → { ok, hash } | 409 { error: 'exists' | 'base' }
    // | 404 { error: 'source' }. Creates file_name as from_file (which must still be the text hashed as base) with the
    // patch applied: a new 番外 line copied from a long story without sending the story. Never overwrites a file.
    router.post('/copy', async (req, res, next) => {
        const app = await nativeSave();
        if (!app) return res.status(501).send({ error: 'unsupported' });
        app.validateAvatar(req, res, next);
    }, async (req, res) => {
        try {
            const { save, sanitize } = await nativeSave();
            const where = chatFile(req, sanitize), from = typeof req.body?.from_file === 'string' && req.body.from_file
                ? chatFile({ ...req, body: { ...req.body, file_name: req.body.from_file } }, sanitize) : null;
            if (!where || !from || from.target === where.target || typeof req.body?.base !== 'string') return res.status(400).send({ error: 'request' });
            const outcome = await serial(where.target, () => serial(from.target, async () => {
                if (await readText(where.target) !== null) return { status: 409, body: { error: 'exists' } };
                const text = await readText(from.target);
                if (text === null) return { status: 404, body: { error: 'source' } };
                const lines = text.split('\n');
                if (hashLines(lines) !== req.body.base) return { status: 409, body: { error: 'base' } };
                const next = applyPatch(lines, req.body);
                if (!next) return { status: 400, body: { error: 'patch' } };
                let chat;
                try { chat = next.map(line => JSON.parse(line)); } catch { return { status: 400, body: { error: 'patch' } }; }
                await save(chat, where.target, false, req.user.profile.handle, where.cardName, req.user.directories.backups);
                return { status: 200, body: { ok: true, hash: hashLines(chat.map(entry => JSON.stringify(entry))) } };
            }));
            res.status(outcome.status).send(outcome.body);
        } catch (error) {
            console.error('[tavern-lite-save]', error);
            res.status(500).send({ error: 'server' });
        }
    });
}

export async function exit() { }
