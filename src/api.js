import { rememberShellRead, withKeptChat } from './chat-sync.js';

export class AuthRequired extends Error {
    constructor() {
        super('登录过期了，请重新登录');
    }
}

let csrfToken;
// Native pages do not send these notifications; /users/me checks remain necessary.
const sessionChannel = typeof window !== 'undefined' && typeof BroadcastChannel === 'function' ? new BroadcastChannel('tavern-lite-session') : null;
sessionChannel?.addEventListener('message', event => {
    if (event.data?.type === 'session-changed') authLost();
});
const announceSession = () => sessionChannel?.postMessage({ type: 'session-changed' });

// The session ended (expired, or logged out elsewhere): the app shows the login page again (see main.jsx). The
// token belonged to that session.
function authLost() {
    csrfToken = undefined;
    lastRead.character.clear();
    lastRead.chapters.clear();
    dispatchEvent(new Event('tl-auth-required'));
    return new AuthRequired();
}

export async function getToken() {
    if (!csrfToken) {
        const response = await fetch('/csrf-token', { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error(`连不上酒馆，稍后再试（${response.status}）`);
        csrfToken = (await response.json()).token;
    }
    return csrfToken;
}

async function request(path, { method = 'POST', body } = {}) {
    const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': await getToken() },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    if (response.status === 401 || response.status === 403) throw authLost();
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `操作没成功，再试一次（${response.status}）`);
    }
    return response.json();
}

export async function getCurrentUser() {
    try {
        return await request('/api/users/me', { method: 'GET' });
    } catch (error) {
        if (error instanceof AuthRequired) return null;
        throw error;
    }
}

export async function listUsers() {
    try {
        const users = await request('/api/users/list');
        return Array.isArray(users) ? users : [];
    } catch {
        return [];
    }
}

export async function login(handle, password) {
    const response = await fetch('/api/users/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getToken() },
        body: JSON.stringify({ handle, password }),
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || (response.status === 429 ? '试的次数太多了，过几分钟再试' : '账号或密码不对'));
    }
    announceSession();
}

export async function getCharacters() {
    const list = await request('/api/characters/all');
    return Array.isArray(list) ? list : [];
}

// The last character and chapter list read this session, so a page that shows them again (the character page after
// its story) can draw at once while it reads them anew. Memory only; cleared when the session changes.
const lastRead = { character: new Map(), chapters: new Map() };
const remember = (kind, avatar, value) => {
    const map = lastRead[kind];
    map.delete(avatar);
    map.set(avatar, value);
    if (map.size > 20) map.delete(map.keys().next().value);
    return value;
};

/** What `getCharacter` / `getChapters` last returned for this avatar, or null. */
export function lastCharacter(avatar) {
    return lastRead.character.get(avatar) ?? null;
}

export function lastChapters(avatar) {
    return lastRead.chapters.get(avatar) ?? null;
}

export async function getCharacter(avatar) {
    return remember('character', avatar, await request('/api/characters/get', { body: { avatar_url: avatar } }));
}

export async function logout() {
    await request('/api/users/logout').catch(() => { });
    announceSession();
}

export async function getRecentChats(max = 6) {
    try {
        const list = await request('/api/chats/recent', { body: { max, metadata: true } });
        return Array.isArray(list) ? list.filter(x => x.avatar || x.group) : [];
    } catch (error) {
        if (error instanceof AuthRequired) throw error;
        return [];
    }
}

export async function getGroups() {
    try {
        const list = await request('/api/groups/all');
        return Array.isArray(list) ? list : [];
    } catch (error) {
        if (error instanceof AuthRequired) throw error;
        return [];
    }
}

/** Extensions SillyTavern finds for this account, named as their manifests name them. */
export async function listExtensions() {
    const found = await request('/api/extensions/discover', { method: 'GET' });
    const list = await Promise.all((Array.isArray(found) ? found : []).map(async ({ name, type }) => {
        try {
            const path = String(name).split('/').map(encodeURIComponent).join('/');
            const response = await fetch(`/scripts/extensions/${path}/manifest.json`, { credentials: 'same-origin' });
            if (!response.ok) return null;
            const manifest = await response.json();
            return { name, type, label: String(manifest?.display_name || name).trim() || name };
        } catch {
            return null;
        }
    }));
    // SillyTavern itself ignores an extension without a readable manifest.
    return list.filter(Boolean);
}

export async function getServerVersion() {
    try {
        return (await request('/version', { method: 'GET' })).pkgVersion ?? '';
    } catch {
        return '';
    }
}

export function chatId(fileName) {
    return String(fileName ?? '').replace(/\.jsonl$/, '');
}

export async function getChat(character, fileName) {
    // A save of this story the network dropped shows here as it will in the full app (chat-sync.js).
    const read = await request('/api/chats/get', {
        body: { ch_name: character.name, file_name: chatId(fileName), avatar_url: character.avatar },
    });
    // The full app opens this story next; it is answered from this read instead of downloading it again.
    rememberShellRead(character.avatar, chatId(fileName), read);
    const data = await withKeptChat(character.avatar, chatId(fileName), read);
    if (!Array.isArray(data)) return [];
    return data.filter(m => m && typeof m.mes === 'string');
}

export async function getGroupChat(file) {
    const data = await request('/api/chats/group/get', { body: { id: chatId(file) } });
    return Array.isArray(data) ? data.filter(m => m && typeof m.mes === 'string') : [];
}

/** Chapters (chat files) of a character, most recent first. */
export async function getChapters(avatar) {
    const list = await request('/api/characters/chats', { body: { avatar_url: avatar, metadata: true } });
    if (!Array.isArray(list)) return [];
    const time = value => {
        const t = typeof value === 'number' ? value : Date.parse(value);
        return Number.isFinite(t) ? t : 0;
    };
    return remember('chapters', avatar, list.filter(x => x?.file_name).sort((a, b) => time(b.last_mes) - time(a.last_mes)));
}

export async function getBackgrounds() {
    const data = await request('/api/backgrounds/all');
    const list = Array.isArray(data) ? data : data?.images ?? [];
    return list.map(x => typeof x === 'string' ? x : x?.filename).filter(Boolean)
        .map(file => ({ file, url: `/backgrounds/${encodeURIComponent(file)}`, thumb: `/thumbnail?type=bg&file=${encodeURIComponent(file)}` }));
}

/** Uploads a picture into the account's background library and returns its address. */
export async function uploadBackground(file) {
    if (!/^image\//.test(file.type)) throw new Error('请选择图片文件');
    if (file.size > 15 * 1024 * 1024) throw new Error('图片太大了，请选 15MB 以内的');
    const name = `tavern-lite-${Date.now().toString(36)}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '')}`;
    const form = new FormData();
    form.append('avatar', file, name);
    const response = await fetch('/api/backgrounds/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': await getToken() },
        body: form,
    });
    if (response.status === 401 || response.status === 403) throw authLost();
    if (!response.ok) throw new Error('图片上传失败');
    const saved = (await response.text()).trim() || name;
    return `/backgrounds/${encodeURIComponent(saved)}`;
}

// Character fields the shell edits. V1 fields also live at the card's top level (older readers use them), so they
// are written in both places, the way the app itself saves them.
const TOP_LEVEL = { description: 'description', personality: 'personality', scenario: 'scenario', first_mes: 'first_mes', mes_example: 'mes_example', creator_notes: 'creatorcomment' };

export function readCharacterField(card, key) {
    if (key === 'alternate_greetings') {
        const list = card?.data?.alternate_greetings;
        return Array.isArray(list) ? list.map(String) : [];
    }
    return String(card?.data?.[key] ?? card?.[TOP_LEVEL[key]] ?? card?.[key] ?? '');
}

/** Writes only the given fields into a character card; everything else on the card stays as it is. */
export async function updateCharacterFields(avatar, values) {
    const data = {};
    const top = {};
    for (const [key, value] of Object.entries(values)) {
        data[key] = value;
        if (TOP_LEVEL[key]) top[TOP_LEVEL[key]] = value;
    }
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getToken() },
        body: JSON.stringify({ avatar, ...top, data }),
    });
    if (response.status === 401 || response.status === 403) throw authLost();
    if (!response.ok) throw new Error('角色没有保存成功，修改仍保存在草稿里');
}

/** Creates a character from the shell's form. `image` is optional; without it the app's default picture is used. */
export async function createCharacter(fields, image) {
    const form = new FormData();
    form.append('ch_name', fields.name);
    for (const key of ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions']) {
        form.append(key, fields[key] ?? '');
    }
    for (const greeting of fields.alternate_greetings ?? []) form.append('alternate_greetings', greeting);
    form.append('talkativeness', '0.5');
    form.append('fav', 'false');
    form.append('tags', (fields.tags ?? []).join(','));
    if (image) form.append('avatar', image);
    const response = await fetch('/api/characters/create', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': await getToken() },
        body: form,
    });
    if (response.status === 401 || response.status === 403) throw authLost();
    const avatar = (await response.text().catch(() => '')).trim();
    if (!response.ok || !avatar.endsWith('.png')) throw new Error('角色没有创建成功，填写的内容仍保存在草稿里');
    return avatar;
}

export const IMPORT_TYPES = ['png', 'json', 'charx', 'yaml', 'yml', 'byaf'];

/** Imports one character card file. Returns the new card's avatar file name. */
export async function importCharacter(file) {
    const type = String(file.name.match(/\.(\w+)$/)?.[1] ?? '').toLowerCase();
    if (!IMPORT_TYPES.includes(type)) throw new Error(`「${file.name}」不是角色卡（支持 PNG、JSON 等）`);
    const form = new FormData();
    form.append('avatar', file);
    form.append('file_type', type);
    const response = await fetch('/api/characters/import', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': await getToken() },
        body: form,
    });
    if (response.status === 401 || response.status === 403) throw authLost();
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error || !data.file_name) throw new Error(`「${file.name}」导入失败，文件可能已损坏`);
    return `${data.file_name}.png`;
}

// Pictures changed in this session get a version in their address, so pages already open show the new one.
const pictureVersions = new Map();
const version = avatar => pictureVersions.has(avatar) ? `${pictureVersions.get(avatar)}` : '';

export function coverUrl(avatar) {
    const v = version(avatar);
    return `/characters/${encodeURIComponent(avatar)}${v ? `?v=${v}` : ''}`;
}

export function avatarUrl(avatar) {
    const v = version(avatar);
    return `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}${v ? `&v=${v}` : ''}`;
}

/** Replaces a character's picture (`image` is a Blob). */
export async function setCharacterImage(avatar, image) {
    const form = new FormData();
    form.append('avatar', image, 'avatar.png');
    form.append('avatar_url', avatar);
    const response = await fetch('/api/characters/edit-avatar', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': await getToken() },
        body: form,
    });
    if (response.status === 401 || response.status === 403) throw authLost();
    if (!response.ok) throw new Error('头像没有换成功');
    await Promise.all([`/characters/${encodeURIComponent(avatar)}`, `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`]
        .map(url => fetch(url, { cache: 'reload', credentials: 'same-origin' }).catch(() => null)));
    pictureVersions.set(avatar, Date.now());
}

/** Deletes a character and all of its chapters (the full app does the same when it is not running). */
export async function deleteCharacter(avatar) {
    await request('/api/characters/delete', { body: { avatar_url: avatar, delete_chats: true } }).catch(error => {
        // The endpoint answers with an empty body.
        if (error instanceof AuthRequired || !(error instanceof SyntaxError)) throw error;
    });
}

export function isFavorite(character) {
    const fav = character?.fav ?? character?.data?.extensions?.fav;
    return fav === true || fav === 'true';
}

/** Marks a character as a favourite (the full app's star), in both places the app reads it from. */
export async function setFavorite(avatar, fav) {
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getToken() },
        body: JSON.stringify({ avatar, fav, data: { extensions: { fav } } }),
    });
    if (response.status === 401 || response.status === 403) throw authLost();
    if (!response.ok) throw new Error('收藏没成功，再试一次');
}

/** Chapters of a character whose text contains every word of `query` (the full app's chat search). */
export async function searchChapters(avatar, query) {
    const list = await request('/api/chats/search', { body: { query, avatar_url: avatar } });
    return Array.isArray(list) ? list.filter(x => x?.file_name) : [];
}
