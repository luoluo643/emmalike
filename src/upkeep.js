// Installing Tavern Helper and updating tavern-lite through SillyTavern's own extension endpoints, the ones its
// extension manager uses: the server clones, fetches and pulls the git repository; nothing is downloaded here.
// An extension installed "for all users" can only be installed or updated by an admin; the server answers 403 to
// anyone else, which here means "not allowed", not "logged out".
import * as api from './api.js';
import * as engine from './engine.js';

export const HELPER = {
    name: '酒馆助手',
    folder: 'JS-Slash-Runner',
    repo: 'https://github.com/N0VI028/JS-Slash-Runner',
    author: 'KAKAA',
    license: 'PolyForm Noncommercial License 1.0.0',
    licenseUrl: 'https://polyformproject.org/licenses/noncommercial/1.0.0',
};

const CHECKED_KEY = 'tavern-lite:update-checked';
const NOTIFIED_KEY = 'tavern-lite:update-notified';
const DAY_MS = 24 * 60 * 60 * 1000;

async function post(path, body) {
    const response = await fetch(path, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await api.getToken() },
        body: JSON.stringify(body),
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) throw Object.assign(new Error(text || `操作没成功，再试一次（${response.status}）`), { status: response.status });
    try { return JSON.parse(text); } catch { return {}; }
}

const folderOf = name => String(name).replace(/^third-party\//, '');

/** Where tavern-lite itself is installed: its folder, and whether it is installed for all users. */
async function ownInstall() {
    const own = engine.ownExtension();
    const found = (await api.listExtensions()).find(x => x.name === own);
    return { folder: folderOf(own), global: found?.type === 'global' };
}

async function isAdmin() {
    return !!(await api.getCurrentUser().catch(() => null))?.admin;
}

/** Whether Tavern Helper is installed for this account, and whether the account may install it for everyone. */
export async function helperStatus() {
    const list = await api.listExtensions();
    const found = list.find(x => folderOf(x.name) === HELPER.folder || x.label === HELPER.name);
    return { installed: !!found, global: found?.type === 'global', name: found?.name ?? '', admin: await isAdmin() };
}

/** Installs Tavern Helper from its official repository; global needs an admin. Takes effect after a reload. */
export async function installHelper(global) {
    try {
        return await post('/api/extensions/install', { url: HELPER.repo, global: !!global });
    } catch (error) {
        if (error.status === 409) throw new Error('已经装过了，重新载入页面就能用');
        if (error.status === 403) throw new Error('只有管理员能为所有用户安装，可以只装给自己');
        throw new Error(`没能安装：${error.message.slice(0, 200)}。检查酒馆能否连上 GitHub 后再试`);
    }
}

/**
 * Asks the server (git fetch) whether a newer tavern-lite is in its repository. kind: 'current' | 'available' |
 * 'manual' (not installed from git, so it cannot be updated from here) | 'forbidden' (installed for all users and this
 * account is not an admin).
 */
export async function checkUpdate() {
    const own = await ownInstall();
    const admin = own.global ? await isAdmin() : true;
    const info = await post('/api/extensions/version', { extensionName: own.folder, global: own.global });
    try { localStorage.setItem(CHECKED_KEY, String(Date.now())); } catch { /* private mode */ }
    if (!info.currentCommitHash) return { kind: 'manual' };
    const result = { kind: info.isUpToDate ? 'current' : 'available', commit: info.currentCommitHash.slice(0, 7), branch: info.currentBranchName,
        remoteUrl: info.remoteUrl, global: own.global, admin };
    if (result.kind === 'available') result.remoteVersion = await remoteVersion(info.remoteUrl, info.currentBranchName);
    if (result.kind === 'available' && !admin) result.kind = 'forbidden';
    return result;
}

/** The version in the repository's manifest, when the repository is on GitHub and public; '' otherwise. */
async function remoteVersion(remoteUrl, branch) {
    const match = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(String(remoteUrl));
    if (!match || !branch) return '';
    try {
        const signal = AbortSignal.timeout?.(8000);
        const response = await fetch(`https://raw.githubusercontent.com/${match[1]}/${match[2]}/${encodeURIComponent(branch)}/manifest.json`, { cache: 'no-store', signal });
        return response.ok ? String((await response.json()).version ?? '') : '';
    } catch {
        return '';
    }
}

/** Pulls the newest tavern-lite on the server. The page has to be reloaded afterwards. */
export async function updateLite() {
    const own = await ownInstall();
    try {
        return await post('/api/extensions/update', { extensionName: own.folder, global: own.global });
    } catch (error) {
        if (error.status === 403) throw new Error('需要管理员来更新');
        throw new Error(`没能更新：${error.message.slice(0, 200)}。检查酒馆能否连上 GitHub 后再试`);
    }
}

/** Checks quietly at most once a day; says so once per new version. Returns the result when it should be told. */
export async function dailyCheck() {
    try {
        if (Date.now() - Number(localStorage.getItem(CHECKED_KEY) || 0) < DAY_MS) return null;
    } catch { return null; }
    const result = await checkUpdate().catch(() => null);
    if (result?.kind !== 'available') return null;
    const seen = (() => { try { return localStorage.getItem(NOTIFIED_KEY); } catch { return null; } })();
    const mark = result.remoteVersion || result.commit;
    if (seen === mark) return null;
    try { localStorage.setItem(NOTIFIED_KEY, mark); } catch { /* private mode */ }
    return result;
}
