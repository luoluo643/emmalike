// Runs inside the full SillyTavern app (the hidden engine page). The lite shell talks to SillyTavern only through
// window.TavernLiteBridge. Namespace imports keep the bridge loading when an export is renamed upstream; the
// missing capability is then reported instead of failing the whole module.
import * as st from '../../../../script.js';
import * as groupChats from '../../../../scripts/group-chats.js';
import * as bookmarks from '../../../../scripts/bookmarks.js';
import * as openai from '../../../../scripts/openai.js';
import * as utils from '../../../../scripts/utils.js';
import * as powerUser from '../../../../scripts/power-user.js';
import * as personas from '../../../../scripts/personas.js';
import * as secrets from '../../../../scripts/secrets.js';
import * as worldInfo from '../../../../scripts/world-info.js';
import * as users from '../../../../scripts/user.js';
import { OWN_FOLDER } from './bridge-own-folder.js';
import * as extensions from '../../../../scripts/extensions.js';
import * as presetManager from '../../../../scripts/preset-manager.js';
import * as regexEngine from '../../../../scripts/extensions/regex/engine.js';
import { createEpisodeJournal } from './src/episode-journal.js';
import { cloneJson, fingerprintChat, hiddenStoryMessage, normalizeLocator, sameLocator, EPISODE_NAMESPACE, episodeError, serializeChat } from './src/episode-model.js';
import { createEpisodeNative } from './bridge-episodes.js';
import { createEpisodeFlow } from './bridge-episode-flow.js';
import { evaluateNativeEpisodePolicy } from './bridge-episode-policy.js';
import { supportedNativeVersion } from './bridge-native-settle.js';
import { scanExtensions } from './bridge-extension-scan.js';
import { createNativeWorldEditor } from './bridge-world-editor-native.js';
import { createNativePresetEditor } from './bridge-preset-editor-native.js';

const API_VERSION = 1;
const SETTLE_MS = 800;

const CONNECT_BUTTONS = {
    openai: 'api_button_openai',
    textgenerationwebui: 'api_button_textgenerationwebui',
    kobold: 'api_button',
    novel: 'api_button_novel',
};

const PANELS = {
    'ai-config': 'ai-config-button',
    'api': 'sys-settings-button',
    'formatting': 'advanced-formatting-button',
    'world-info': 'WI-SP-button',
    'user-settings': 'user-settings-button',
    'backgrounds': 'backgrounds-button',
    'extensions': 'extensions-settings-button',
    'persona': 'persona-management-button',
    'characters': 'rightNavHolder',
};

const ctx = () => SillyTavern.getContext();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const listeners = new Set();

function emit(type, detail) {
    for (const fn of listeners) {
        try { fn(type, detail); } catch (error) { console.error('[tavern-lite]', error); }
    }
}

async function waitFor(condition, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (condition()) return true;
        await sleep(100);
    }
    return condition();
}

// Generation state: operations started through the bridge are tracked exactly; generations the user starts in the
// full app are tracked from events, with a short settle period because the app keeps saving after GENERATION_ENDED.
let bridgeBusy = false;
let nativeGenerating = false;
// Generating operations count from the tap, not from when the queue reaches them: the shell shows its "generating"
// state (stop button, no reply buttons) at once, so a tap during the account check before a slow start is not
// queued behind it, and 停止 can cancel one that has not started yet.
let queuedGenerations = 0;
let stopEpoch = 0;
let generationStarts = 0;
let reportedGenerating = false;
let settleTimer;

function report() {
    const generating = bridgeBusy || nativeGenerating || queuedGenerations > 0;
    if (generating !== reportedGenerating) {
        reportedGenerating = generating;
        emit('generating', generating);
    }
}

function idle() {
    const swipeState = ctx().swipe?.state?.();
    return !st.is_send_press && !st.isChatSaving && (swipeState === undefined || swipeState === 'none');
}

async function waitIdle() {
    if (!await waitFor(idle, 30000)) throw new Error('上一步还在处理，稍等几秒');
}

let queue = Promise.resolve();
let queueOwner = null;
const nativeAccount = users.currentUser?.handle;
let sessionFrozen = false, sessionEpoch = 0;
const sessionChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('tavern-lite-session') : null;
function freezeSession() {
    if (sessionFrozen) return;
    sessionFrozen = true; sessionEpoch++;
    emit('account-changed');
}
sessionChannel?.addEventListener('message', event => {
    if (event.data?.type === 'session-changed') freezeSession();
});
// One operation checks before and after each step, and the answer carries the account's whole profile (its picture
// can be a megabyte): a check that passed moments ago in this session stands, and checks made together share one
// request. Any sign of a session change (freezeSession) ends this at once.
const ACCOUNT_CHECK_REUSE_MS = 2000;
let accountCheckedAt = 0, accountCheckedEpoch = -1, accountCheck = null;
// The check goes over the phone's network like everything else: a dropped connection or a gateway error is tried
// again, and one that stays down is reported as the network. Only an answer naming another account (or none) means
// the session changed.
const ACCOUNT_CHECK_TRIES = 3;
async function currentHandle() {
    for (let attempt = 1; ; attempt++) {
        try {
            const response = await fetch('/api/users/me', { credentials: 'same-origin', cache: 'no-store' });
            if (response.status === 401 || response.status === 403) return null;
            if (response.ok) return (await response.json()).handle ?? null;
        } catch { /* dropped connection, tried again below */ }
        if (attempt >= ACCOUNT_CHECK_TRIES) throw Object.assign(new Error('网络开小差了，再试一次'), { code: 'network' });
        await new Promise(resolve => setTimeout(resolve, 700 * attempt));
    }
}
async function verifyAccount() {
    if (sessionFrozen || !nativeAccount) throw episodeError('ACCOUNT_CHANGED', '登录状态变了，请刷新页面。没发出的文字还在');
    if (accountCheckedEpoch === sessionEpoch && Date.now() - accountCheckedAt < ACCOUNT_CHECK_REUSE_MS) return nativeAccount;
    accountCheck ??= (async () => {
        const epoch = sessionEpoch;
        if (await currentHandle() !== nativeAccount) {
            freezeSession();
            throw episodeError('ACCOUNT_CHANGED', '登录状态变了，请刷新页面，再核对刚才提交的内容');
        }
        accountCheckedAt = Date.now();
        accountCheckedEpoch = epoch;
    })().finally(() => { accountCheck = null; });
    await accountCheck;
    if (sessionFrozen) throw episodeError('ACCOUNT_CHANGED', '登录状态变了，请刷新页面');
    return nativeAccount;
}

function assertBridgeSession() {
    if (sessionFrozen || !nativeAccount || document !== bridgeDocument || bridgeDocument.defaultView?.document !== bridgeDocument ||
        !bridgeDocument.documentElement?.isConnected || window.frameElement && !window.frameElement.isConnected) {
        throw episodeError('ACCOUNT_CHANGED', '页面已刷新或换了账号，刚才的操作没生效');
    }
}

// This check is synchronous and does not depend on browser storage availability.
function assertWorldGenerationReady() {
    assertBridgeSession();
    worldEditor.assertWorldRuntimeReady();
}

const cancelled = () => Object.assign(new Error('已停止'), { code: 'cancelled' });

// Operations run one at a time. Only those that start a generation put the shell into its "generating" state. Each
// operation gets `stopped()`: whether 停止 was pressed since it was asked for.
function enqueue(operation, { generating = false, usesWorldInfo = generating } = {}) {
    const epoch = stopEpoch;
    const stopped = () => stopEpoch !== epoch;
    if (generating) {
        queuedGenerations++;
        report();
    }
    const run = queue.then(async () => {
        const owner = {};
        queueOwner = owner;
        try {
        await verifyAccount();
        if (usesWorldInfo) assertWorldGenerationReady();
        if (!generating) {
            try {
                return await operation(stopped);
            } finally {
                emit('chat');
            }
        }
        bridgeBusy = true;
        report();
        try {
            return await operation(stopped);
        } finally {
            bridgeBusy = false;
            report();
            emit('chat');
        }
        } finally { if (queueOwner === owner) queueOwner = null; }
    }).finally(() => {
        if (!generating) return;
        queuedGenerations--;
        report();
    });
    queue = run.catch(() => { });
    return run;
}

// The app swallows a stop pressed while a generation is still starting (Generate() replaces its abort controller only
// after the GENERATION_STARTED listeners) and then sends that request anyway. Until the app settles, stop any stream
// that begins after the press, unless the shell has started a new generation since.
function stop() {
    const epoch = ++stopEpoch;
    const starts = generationStarts;
    const before = ctx().streamingProcessor;
    const result = ctx().stopGeneration();
    const until = Date.now() + 60000;
    (async () => {
        while (epoch === stopEpoch && starts === generationStarts && Date.now() < until) {
            await sleep(300);
            if (idle()) return;
            const processor = ctx().streamingProcessor;
            if (processor && processor !== before && !processor.isStopped && !processor.isFinished) ctx().stopGeneration();
        }
    })();
    return result;
}

// The app counts tokens for every history message with one server round trip each, one after another, and caches
// the counts per device. On a long chat the first send otherwise waits for all of them (180 messages ≈ 40 s at
// 200 ms latency). A dry run, which the app's own prompt manager also performs, fills that cache while the user reads.
function warmTokenCache() {
    if (typeof st.Generate !== 'function') return;
    enqueue(async () => {
        if (!idle() || ctx().groupId) return;
        try {
            assertWorldGenerationReady();
            await st.Generate('normal', {}, true);
        } catch (error) {
            console.warn('[tavern-lite] token cache warm-up failed', error);
        }
    }).catch(() => { });
}

function connected() {
    const status = ctx().onlineStatus;
    return !!status && status !== 'no_connection';
}

const CONNECT_WAIT_MS = 20000;
let connectingSince = 0;

function startConnecting() {
    const button = document.getElementById(CONNECT_BUTTONS[ctx().mainApi]);
    if (!button) return false;
    connectingSince = Date.now();
    button.click();
    return true;
}

// Connects to the model while the user reads, so the first send does not wait for it (and needs no notice).
function warmConnection() {
    if (!connected() && Date.now() - connectingSince > CONNECT_WAIT_MS) startConnecting();
}

// Errors the shell answers by offering the model setup.
function noConnection(message) {
    return Object.assign(new Error(message), { code: 'no-connection' });
}

async function ensureConnected() {
    if (connected()) return;
    const attempting = Date.now() - connectingSince <= CONNECT_WAIT_MS;
    if (!attempting && !startConnecting()) throw noConnection('还没连上 AI 模型，去「我的 → 模型与预设」设置');
    if (!await waitFor(connected, CONNECT_WAIT_MS)) throw noConnection('连不上 AI 模型，检查一下密钥、余额或网络');
}

function setTextarea(text) {
    const textarea = document.getElementById('send_textarea');
    if (!textarea) throw new Error('现在发不了消息，请刷新页面再试');
    textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return textarea;
}

/** Resolves once the full app has accepted the message into the chat; the generation then continues on its own. */
function send(text, { scope = currentChat(), onState } = {}) {
    if (typeof st.sendTextareaMessage !== 'function') return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    let accept, refuse;
    const accepted = new Promise((resolve, reject) => { accept = resolve; refuse = reject; });
    let state = 'pending';
    const changed = value => { state = value; try { onState?.(value); } catch { /* UI listener */ } };
    const cancelled = () => Object.assign(new Error('已取消发送'), { code: 'cancelled' });
    accepted.cancel = () => {
        if (state !== 'pending') return false;
        changed('cancelled'); refuse(cancelled()); return true;
    };
    const check = () => {
        if (state === 'cancelled') throw cancelled();
        const now = currentChat();
        if (!scope || !now || scope.avatar !== now.avatar || scope.groupId !== now.groupId || chatId(scope.file) !== chatId(now.file)) {
            throw Object.assign(new Error('故事已切换，没发出的文字已放回输入框'), { code: 'story-changed' });
        }
    };
    enqueue(async () => {
        try {
            check();
            await ensureConnected();
            await waitIdle();
            await verifyAccount();
            // Final synchronous boundary: cancel and story changes cannot slip between this and native send.
            assertWorldGenerationReady();
            check();
            const before = ctx().chat.length;
            const textarea = setTextarea(text);
            let finished = false;
            generationStarts++;
            changed('submitted');
            bridgeBusy = true;
            report();
            assertWorldGenerationReady();
            const run = Promise.resolve(st.sendTextareaMessage()).finally(() => { finished = true; });
            run.catch(() => {}); // The native promise may reject before the acceptance poll completes.
            await waitFor(() => finished || ctx().chat.length > before, 15000);
            if (ctx().chat.length <= before) await run.catch(() => { });
            if (ctx().chat.length <= before) {
                if (textarea.value === text) setTextarea('');
                throw new Error('没发出去，文字已放回输入框');
            }
            changed('accepted');
            accept();
            await run;
        } catch (error) {
            refuse(error);
            throw error;
        } finally {
            bridgeBusy = false;
            report();
        }
    }).catch(error => { refuse(error); });
    return accepted;
}

/**
 * Runs one of the app's own option-menu actions, which carry checks and arguments the app does not export.
 * `expect` is checked against the last message right before the click: an action asked for one story state (让角色回复
 * after the user's words) must not act on another (it would replace a reply written meanwhile).
 */
function optionAction(id, { expect } = {}) {
    // A tap while another generation is asked for or running is not queued behind it.
    if (queuedGenerations > 0) return Promise.reject(cancelled());
    return enqueue(async stopped => {
        await ensureConnected();
        await waitIdle();
        await verifyAccount();
        const option = document.getElementById(id);
        if (!option) throw new Error('当前酒馆版本不支持，请在原版界面操作');
        assertWorldGenerationReady();
        if (stopped() || expect && !expect(ctx().chat?.at(-1))) throw cancelled();
        generationStarts++;
        option.click();
        await waitFor(() => st.is_send_press, 3000);
        await waitFor(idle, 600000);
    }, { generating: true });
}

function swipe(direction) {
    const api = ctx().swipe;
    if (!api?.left || !api?.right) return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    if (queuedGenerations > 0) return Promise.reject(cancelled());
    return enqueue(async stopped => {
        await waitIdle();
        if (direction === 'left') await api.left(null, { source: 'tavern-lite' });
        else {
            await ensureConnected();
            await verifyAccount();
            assertWorldGenerationReady();
            if (stopped()) throw cancelled();
            generationStarts++;
            await api.right(null, { source: 'tavern-lite' });
        }
        await waitFor(idle, 600000);
    }, { generating: true, usesWorldInfo: direction !== 'left' });
}

function chatId(file) {
    return String(file ?? '').replace(/\.jsonl$/, '');
}

function currentChat() {
    const c = ctx();
    if (c.groupId) return { groupId: String(c.groupId), file: chatId(c.getCurrentChatId()) };
    const character = c.characters?.[c.characterId];
    return character ? { avatar: character.avatar, name: character.name, file: chatId(c.getCurrentChatId()) } : null;
}

/** Index of a character in the app's list; characters imported from the shell are picked up by reloading the list. */
async function characterIndex(avatar) {
    let index = ctx().characters.findIndex(x => x.avatar === avatar);
    if (index < 0 && typeof st.getCharacters === 'function') {
        await st.getCharacters();
        index = ctx().characters.findIndex(x => x.avatar === avatar);
    }
    if (index < 0) throw new Error('找不到这个角色，请刷新页面');
    return index;
}

async function selectCharacter(avatar) {
    const index = await characterIndex(avatar);
    let c = ctx();
    if (c.groupId || String(c.characterId) !== String(index)) await c.selectCharacterById(index, { switchMenu: false });
    c = ctx();
    if (String(c.characterId) !== String(index)) throw new Error('切换角色没有成功，请重试');
    return index;
}

function openChat(avatar, file) {
    return enqueue(async () => {
        await waitIdle();
        if (currentChat()?.avatar !== avatar || file && chatId(currentChat()?.file) !== chatId(file)) await episodeFlow.assertCanLeave(episodeLease());
        await selectCharacter(avatar);
        const c = ctx();
        if (file && chatId(c.getCurrentChatId()) !== chatId(file)) await c.openCharacterChat(chatId(file));
        return currentChat();
    }).then(current => {
        warmConnection();
        warmTokenCache();
        return current;
    });
}

function openGroup(groupId) {
    if (typeof groupChats.openGroupById !== 'function') return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    return enqueue(async () => {
        await waitIdle();
        await episodeFlow.assertCanLeave(episodeLease());
        await groupChats.openGroupById(String(groupId));
        return currentChat();
    });
}

/** With `reuseEmpty`, a chat that holds nothing but the greeting is reused, so empty chapters do not pile up. */
function newChat({ reuseEmpty = false } = {}) {
    if (typeof st.doNewChat !== 'function') return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    return enqueue(async () => {
        await waitIdle();
        await episodeFlow.assertCanLeave(episodeLease());
        const chat = ctx().chat ?? [];
        const untouched = chat.length <= 1 && !chat.some(m => m.is_user);
        if (!(reuseEmpty && untouched)) await st.doNewChat({ deleteCurrentChat: false });
        return currentChat();
    });
}

/** Renames a chapter (chat file). The character is selected first so the app also moves its "last chat" pointer. */
function renameChapter(avatar, file, newName) {
    if (typeof st.renameGroupOrCharacterChat !== 'function') return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    return enqueue(async () => {
        await waitIdle();
        const index = await selectCharacter(avatar);
        await st.renameGroupOrCharacterChat({ characterId: index, oldFileName: chatId(file), newFileName: newName });
        emit('chapter-renamed', { avatar, from: chatId(file), to: chatId(newName) });
        return currentChat();
    });
}

/** Deletes a chapter. When it is the one open, the app switches to the most recent remaining chapter (or a new one). */
function deleteChapter(avatar, file) {
    if (typeof st.deleteCharacterChatByName !== 'function') return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    return enqueue(async () => {
        await waitIdle();
        const index = await characterIndex(avatar);
        const c = ctx();
        const isOpen = !c.groupId && String(c.characterId) === String(index) && chatId(c.getCurrentChatId()) === chatId(file);
        await st.deleteCharacterChatByName(String(index), chatId(file));
        if (isOpen && typeof st.replaceCurrentChat === 'function') await st.replaceCurrentChat();
        return currentChat();
    });
}

/** Opens the app's character editor for one character. */
function editCharacter(avatar) {
    return enqueue(async () => {
        await waitIdle();
        await selectCharacter(avatar);
        openPanel('characters');
    });
}

const SOURCE_LABELS = {
    openai: 'OpenAI', claude: 'Claude', makersuite: 'Google AI Studio', vertexai: 'Google Vertex AI', openrouter: 'OpenRouter',
    deepseek: 'DeepSeek', mistralai: 'Mistral', cohere: 'Cohere', groq: 'Groq', xai: 'xAI', custom: '中转站',
    azure_openai: 'Azure OpenAI', moonshot: 'Moonshot', zai: '智谱', siliconflow: '硅基流动', nanogpt: 'NanoGPT',
};

const API_LABELS = {
    openai: '对话补全',
    textgenerationwebui: '文本补全',
    kobold: 'KoboldAI',
    koboldhorde: 'AI Horde',
    novel: 'NovelAI',
};

/** What the account is connected to, in words a reader understands. */
function connection() {
    const c = ctx();
    const api = c.mainApi;
    let source = '';
    let model = '';
    if (api === 'openai') {
        const raw = c.chatCompletionSettings?.chat_completion_source ?? '';
        source = SOURCE_LABELS[raw] ?? raw;
        try { model = typeof openai.getChatCompletionModel === 'function' ? openai.getChatCompletionModel() ?? '' : ''; } catch { model = ''; }
    }
    return { api: API_LABELS[api] ?? api ?? '', source, model, connected: connected() };
}

/** Makes sure a message is rendered in the app's chat, loading older messages when needed. */
async function revealMessage(index) {
    const find = () => document.querySelector(`#chat .mes[mesid="${index}"]`);
    if (!find() && typeof st.showMoreMessages === 'function') {
        const first = Number(document.querySelector('#chat .mes')?.getAttribute('mesid') ?? ctx().chat.length);
        await st.showMoreMessages(Math.max(1, first - index));
    }
    const node = find();
    if (!node) throw new Error('这条消息不在了，刷新一下');
    node.scrollIntoView({ block: 'center' });
    return node;
}

/** Scrolls the app's chat to a message; the shell then shows the full app there. */
function showMessage(index) {
    return enqueue(async () => {
        await revealMessage(index);
    });
}

/** Opens the app's own editor for a message; the shell then shows the full app. Deleting is done from there too. */
function editMessage(index) {
    return enqueue(async () => {
        await waitIdle();
        const node = await revealMessage(index);
        const edit = node.querySelector('.mes_edit');
        if (!edit) throw new Error('这条消息不能编辑');
        edit.click();
    });
}

// Explicit source navigation only. Comparing or listing private records never calls this function.
function revealPersonalSource(source) {
    return enqueue(async () => {
        await waitIdle();
        if (source.groupId) {
            if (typeof groupChats.openGroupChat !== 'function') throw new Error('请在原版打开对应的群聊故事');
            await groupChats.openGroupById(String(source.groupId));
            if (currentChat()?.file !== source.file) await groupChats.openGroupChat(String(source.groupId), source.file);
        } else {
            await selectCharacter(source.avatar);
            if (currentChat()?.file !== source.file) await ctx().openCharacterChat(source.file);
        }
        const scope = currentChat();
        if (!scope || scope.file !== source.file || (scope.avatar || '') !== (source.avatar || '') || String(scope.groupId || '') !== String(source.groupId || '')) throw new Error('原文已改动或无法定位');
        const hits = [];
        for (const [index, m] of ctx().chat.entries()) {
            if ((m.name || '') !== source.name || !!m.is_user !== source.is_user || !!m.is_system !== source.is_system) continue;
            const variants = m.swipes?.length ? [...m.swipes] : [m.mes]; variants[m.swipe_id ?? 0] = m.mes;
            variants.forEach((raw, swipe) => { if (raw === source.raw) hits.push({ index, current: swipe === (m.swipe_id ?? 0) }); });
        }
        if (hits.length !== 1 || !hits[0].current) throw new Error('原文已改动或无法定位');
        const node = await revealMessage(hits[0].index);
        const outline = node.style.outline; node.style.outline = '2px solid #bd8d55';
        setTimeout(() => { node.style.outline = outline; }, 1800);
        return hits[0].index;
    });
}

/**
 * Replaces a message's text through the app's own editor (open, fill, done), so regex scripts, macros and the
 * current swipe are handled exactly as when editing in the full app.
 */
function editText(index, text) {
    if (typeof st.messageEdit !== 'function') return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    return enqueue(async () => {
        await waitIdle();
        if (!ctx().chat?.[index]) throw new Error('这条消息不在了，刷新一下');
        const node = await revealMessage(index);
        await st.messageEdit(index);
        const area = node.querySelector('.edit_textarea');
        const done = node.querySelector('.mes_edit_done');
        if (!area || !done) throw new Error('没能打开这条消息的编辑器');
        area.value = text;
        area.dispatchEvent(new Event('input', { bubbles: true }));
        done.click();
        if (!await waitFor(() => !node.querySelector('.edit_textarea'), 5000)) throw new Error('没保存上，再试一次');
        await waitFor(() => !st.isChatSaving, 10000);
    });
}

/** Deletes one message; with `swipeOnly`, just its current reply among several. */
function deleteMessageAt(index, { swipeOnly = false } = {}) {
    if (typeof st.deleteMessage !== 'function') return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    return enqueue(async () => {
        await waitIdle();
        const message = ctx().chat?.[index];
        if (!message) throw new Error('这条消息不在了，刷新一下');
        await revealMessage(index);
        if (swipeOnly) {
            if (!(message.swipes?.length > 1) || typeof st.deleteSwipe !== 'function') throw new Error('这条消息只有一个回复');
            await st.deleteSwipe(message.swipe_id ?? 0, index);
        } else {
            const before = ctx().chat.length;
            await st.deleteMessage(index);
            if (ctx().chat.length >= before) throw new Error('没删掉，再试一次');
        }
        await waitFor(() => !st.isChatSaving, 10000);
    });
}

/**
 * After the shell changed a character card on the server, reloads it into the app. When it is the character on
 * screen, selecting it again refills the app's character form, which otherwise keeps the old text and would write it
 * back the next time that form is saved.
 */
function refreshCharacter(avatar) {
    return enqueue(async () => {
        await waitIdle();
        const index = await characterIndex(avatar);
        if (typeof st.getOneCharacter === 'function') await st.getOneCharacter(avatar);
        else if (typeof st.getCharacters === 'function') await st.getCharacters();
        const c = ctx();
        if (!c.groupId && String(c.characterId) === String(index)) await c.selectCharacterById(index, { switchMenu: false });
        return ctx().characters[index];
    });
}

function branchFrom(index) {
    if (typeof bookmarks.branchChat !== 'function') return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    return enqueue(async () => {
        await waitIdle();
        const file = await bookmarks.branchChat(index);
        if (!file) throw new Error('没能换个走向，再试一次');
        return currentChat();
    }).then(current => {
        warmConnection();
        warmTokenCache();
        return current;
    });
}

function openPanel(name) {
    const id = PANELS[name];
    const root = id && document.getElementById(id);
    if (!root) return false;
    const content = root.querySelector('.drawer-content');
    if (!content?.classList.contains('openDrawer')) root.querySelector('.drawer-toggle')?.click();
    return true;
}

// Rendering: messages still in the app's DOM are copied as rendered (extensions may post-process them); older
// messages go through the app's own formatting pipeline so regex scripts and markdown rules match.
// Same test Tavern Helper uses to decide that a code block is a frontend card.
const FRONTEND_CARD = /html>|<head>|<body/i;
const formatCache = new Map();

// Frontend cards: Tavern Helper turns a message's HTML code block into a page (iframe#TH-message--<mesid>--<n>). The
// shell runs the same page again in its own frame, wired to this app's helper API, so cards stay interactive. While
// the shell shows a card, the copy here is parked (emptied) so its scripts and sounds don't run twice; showing the
// full app puts it back.
const CARD_FRAME = /^TH-message--(\d+)--(\d+)$/;
const PARKED_PAGE = '<!DOCTYPE html><title></title>';
const cardSources = new Map(); // key → page source
const cardFrames = new Map(); // key → the app's iframe
const parked = new Map(); // the app's iframe → { attribute, value } to put back
const blobSources = new Map();
let shellShowing = true;

function hashText(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = (hash * 33 + text.charCodeAt(i)) | 0;
    return (hash >>> 0).toString(36);
}

function frameSource(frame) {
    const saved = parked.get(frame);
    if (saved) return saved.attribute === 'srcdoc' ? saved.value : blobSources.get(saved.value) ?? null;
    const srcdoc = frame.getAttribute('srcdoc');
    if (srcdoc) return srcdoc;
    // Tavern Helper's "use blob URL" option: read the page once, then refresh the chat.
    const src = frame.getAttribute('src') ?? '';
    if (!src.startsWith('blob:')) return null;
    if (!blobSources.has(src)) {
        blobSources.set(src, null);
        fetch(src).then(r => r.text()).then(text => { blobSources.set(src, text); emit('chat'); }).catch(() => { });
    }
    return blobSources.get(src);
}

function park(frame) {
    if (parked.has(frame) || !shellShowing) return;
    const attribute = frame.hasAttribute('srcdoc') ? 'srcdoc' : 'src';
    const value = frame.getAttribute(attribute);
    if (attribute === 'src' && !blobSources.get(value)) return;
    parked.set(frame, { attribute, value });
    if (attribute === 'src') frame.removeAttribute('src');
    frame.setAttribute('srcdoc', PARKED_PAGE);
}

/** The shell tells the bridge whether it is on screen (the full app hidden): park cards then, restore them otherwise. */
// While the shell is on screen this page is hidden. A field focused here (the app focuses its own input after a
// generation) would open the phone's keyboard for an invisible box and take what the user types. Floating layers
// (shown over the shell) keep their fields.
const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

function releaseFocus(element = document.activeElement) {
    if (shellShowing && element instanceof HTMLElement && element.matches(TYPING) && !element.closest('[data-tl-float]')) element.blur();
}

function watchFocus() {
    document.addEventListener('focusin', event => releaseFocus(event.target), true);
}

function setShellShowing(showing) {
    shellShowing = showing;
    if (showing) releaseFocus();
    if (!showing) {
        for (const [frame, { attribute, value }] of parked) {
            if (!frame.isConnected) continue;
            if (attribute === 'src') frame.removeAttribute('srcdoc');
            frame.setAttribute(attribute, value);
        }
        parked.clear();
    } else {
        for (const frame of cardFrames.values()) if (frame.isConnected) park(frame);
    }
}

function cardSource(key) {
    return cardSources.get(key) ?? null;
}

function cardSlot(frame) {
    const match = frame.id.match(CARD_FRAME);
    const source = match && frameSource(frame);
    const slot = document.createElement('div');
    if (!source) {
        slot.className = 'tl-card-placeholder';
        slot.textContent = match ? '［前端卡片：正在准备］' : '［前端卡片：生成完成后显示］';
        return slot;
    }
    const key = `${match[1]}.${match[2]}.${hashText(source)}`;
    cardSources.set(key, source);
    cardFrames.set(key, frame);
    park(frame);
    slot.className = 'tl-frontend-card';
    slot.dataset.card = key;
    slot.dataset.frame = frame.id;
    return slot;
}

// Why a card in a message is not shown: matches what the full app shows for the same message.
function cardMissingText() {
    const render = ctx().extensionSettings?.tavern_helper?.render;
    if (!window.TavernHelper) return '［前端卡片：需要「酒馆助手」，可在「我的 → 酒馆助手」安装］';
    if (render && render.enabled === false) return '［前端卡片：酒馆助手的“渲染前端界面”已关闭］';
    return render?.depth > 0 ? `［前端卡片：酒馆助手设置为只显示最近 ${render.depth} 条消息里的卡片］` : '［前端卡片：只显示最近消息里的卡片］';
}

function sanitizeCopy(element, original) {
    // Tavern Helper wraps a rendered card in div.TH-render with the hidden code block and a "show code" button.
    for (const render of element.querySelectorAll('div.TH-render')) {
        const frame = render.querySelector('iframe[id]');
        const live = frame && original?.querySelector(`iframe[id="${CSS.escape(frame.id)}"]`);
        if (live) render.replaceWith(cardSlot(live));
    }
    // A page embedded in the message runs only in the full app: a tap there shows this message (reader.jsx).
    for (const node of element.querySelectorAll('iframe, object, embed')) {
        const placeholder = document.createElement('button');
        placeholder.type = 'button';
        placeholder.className = 'tl-card-placeholder tl-native-jump';
        placeholder.textContent = '［嵌入内容 · 在原版里看这条］';
        node.replaceWith(placeholder);
    }
    for (const node of element.querySelectorAll('script, style, link, .TH-collapse-code-block-button')) node.remove();
    for (const node of element.querySelectorAll('[class*="hidden!"]')) node.classList.remove('hidden!');
    for (const pre of element.querySelectorAll('pre')) {
        if (FRONTEND_CARD.test(pre.textContent ?? '')) {
            const placeholder = document.createElement('span');
            placeholder.className = 'tl-card-placeholder';
            placeholder.textContent = cardMissingText();
            pre.replaceWith(placeholder);
        }
    }
    return element.innerHTML;
}

// Extension panels: other extensions (Horae's status bar, for example) add their own elements under a message's
// text. The shell mirrors them in an isolated frame and passes taps and input back to the real elements here.
const NATIVE_PARTS = /^(mes_|ch_name|swipe|mesAvatar|timestamp|tokenCounter|flex-container|TH-)/;
// Horae's storyline tags (which line a message belongs to) are shown by the shell itself: the line in the send bar,
// switching in its 番外与平行线 sheet. See storylineState().
const SHELL_SHOWN_PANELS = ['horae-storyline-chip'];

function extensionPanels(index) {
    const block = document.querySelector(`#chat .mes[mesid="${index}"] .mes_block`);
    if (!block) return [];
    return [...block.children].filter(el => !el.hidden && el.style.display !== 'none' && el.classList.length > 0
        && ![...el.classList].some(c => NATIVE_PARTS.test(c)) && !el.querySelector('.mes_text')
        && !SHELL_SHOWN_PANELS.some(c => el.classList.contains(c)));
}

// Horae storylines: a story's main text and its 番外 each keep their own memory; the line in use decides what is sent.
// Read through Horae's public API; changes go through Horae's own storyline buttons (it listens for their clicks on
// the page), so its rules for switching stay in one place.
const STORYLINE_MAIN = 'main';

function horaeStorylines() {
    const horae = window.Horae;
    if (!horae?.isEnabled?.() || typeof horae.getStorylines !== 'function') return null;
    if (horae.getSettings?.()?.storylinesEnabled === false) return null;
    try { return horae.getStorylines(); } catch { return null; }
}

function storylineState() {
    const data = horaeStorylines();
    if (!data) return null;
    const title = id => !id || id === STORYLINE_MAIN ? '正文' : `番外·${data.lines?.[id]?.title || '番外'}`;
    const lines = [{ id: STORYLINE_MAIN, label: '正文' }, ...Object.entries(data.lines ?? {})
        .filter(([, line]) => !line?.deleted).map(([id]) => ({ id, label: title(id) }))];
    // Horae's `active` is already the line a pending switch goes to; the line written so far is the last floor's.
    const here = data.segments?.at(-1)?.id || data.active || STORYLINE_MAIN;
    const pending = data.pending && data.pending !== here && lines.some(l => l.id === data.pending) ? data.pending : null;
    return { multi: !!data.multi, active: here, label: title(here), pending, pendingLabel: pending ? title(pending) : '', lines };
}

const STORYLINE_ACTIONS = ['to-main', 'to-line', 'clear-pending', 'new-next'];

/** Next message on another line: 'to-main', 'to-line' (with `line`), 'new-next' (with `title`) or 'clear-pending'. */
function storylineAction(action, { line = '', title = '' } = {}) {
    if (!STORYLINE_ACTIONS.includes(action)) return Promise.reject(new Error('不认识的故事线操作'));
    return enqueue(async () => {
        await waitIdle();
        const before = horaeStorylines();
        if (!before) throw new Error('Horae 的故事线没有开启');
        const last = (ctx().chat?.length ?? 0) - 1;
        if (last < 0) throw new Error('故事里还没有消息');
        const chip = document.createElement('div');
        chip.className = 'horae-storyline-chip';
        chip.hidden = true;
        const input = document.createElement('input');
        input.className = 'horae-sl-title';
        input.value = String(title ?? '').trim();
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.slAction = action;
        button.dataset.mesid = String(last);
        if (line) button.dataset.line = line;
        chip.append(input, button);
        document.body.append(chip);
        try {
            button.click();
            const changed = () => (horaeStorylines()?.pending ?? null) !== (before.pending ?? null)
                || Object.keys(horaeStorylines()?.lines ?? {}).length !== Object.keys(before.lines ?? {}).length;
            if (!await waitFor(changed, 5000) && action !== 'clear-pending') throw new Error('Horae 没有响应这次切换，请在原版界面里试试');
        } finally {
            chip.remove();
        }
        await sleep(SETTLE_MS);
        emit('chat');
        return storylineState();
    });
}

function panelsCopy(index) {
    const panels = extensionPanels(index);
    if (!panels.length) return null;
    return panels.map((panel, i) => {
        const copy = panel.cloneNode(true);
        for (const node of copy.querySelectorAll('script, iframe, object, embed')) node.remove();
        for (const node of [copy, ...copy.querySelectorAll('*')]) {
            for (const { name } of [...node.attributes]) if (/^on/i.test(name)) node.removeAttribute(name);
        }
        copy.dataset.tlPanel = String(i);
        return copy.outerHTML;
    }).join('');
}

/** Styles a panel mirror needs: extension and icon stylesheets, inline styles and the theme's variables. */
function panelStyles() {
    const links = [...document.querySelectorAll('link[rel="stylesheet"]')].map(link => link.href)
        .filter(href => /\/scripts\/extensions\/|fontawesome|\/css\/(solid|regular|brands)/i.test(href) && !href.includes(`/${OWN_FOLDER}/`));
    const css = [...document.querySelectorAll('head style')].map(style => style.textContent).join('\n');
    const computed = getComputedStyle(document.documentElement);
    const vars = [];
    for (const name of computed) if (name.startsWith('--')) vars.push(`${name}:${computed.getPropertyValue(name)}`);
    return { links, css, vars: vars.join(';'), bodyClass: document.body.className };
}

// Something a forwarded tap opened in the full app is announced like a dialog, so the shell can offer to show it: a
// window added to the page (popups go straight into body; floating windows into #movingDivs, where Tavern Helper's
// variable manager and prompt viewer go on phones) or one already there and only shown (the image generation menu).
// Rendered at all: the hidden page can give fixed-position windows no height. While a floating layer is up the
// overlay hides the whole page, so what is shown is judged without it.
function withoutOverlay(read) {
    const root = document.documentElement;
    if (!root.classList.contains('tl-overlay')) return read();
    root.classList.remove('tl-overlay');
    try {
        return read();
    } finally {
        root.classList.add('tl-overlay');
    }
}
const isOpenWindow = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const PAGE_WINDOWS = 'body > :not(script, style, link, template, #toast-container), #movingDivs > *';
const openWindows = () => withoutOverlay(() => [...document.querySelectorAll(PAGE_WINDOWS)].filter(isOpenWindow));
const floatingWindows = () => withoutOverlay(() => [...(document.getElementById('movingDivs')?.children ?? [])].filter(isOpenWindow));

// Toasts right after a forwarded tap are its answer ("请稍候", "已排队"): info and success ones are passed on too while
// this lasts; at other times only errors and warnings are.
const TAP_ANSWER_MS = 4000;
let tapAnswerUntil = 0;

/** `orOpen`: also announce when the tap showed nothing new but a floating window is open (opened by an earlier tap). */
function watchOpened({ orOpen = false } = {}) {
    const before = new Set(openWindows());
    tapAnswerUntil = Date.now() + TAP_ANSWER_MS;
    let reported = false;
    let pending = 0;
    const report = () => {
        if (reported) return;
        reported = true;
        observer.disconnect();
        emit('popup', { text: '原版界面里打开了一个窗口' });
    };
    // Checked at most every 50 ms: the page may change a lot meanwhile (a reply streaming in).
    const observer = new MutationObserver(() => {
        pending ||= setTimeout(() => {
            pending = 0;
            if (!reported && openWindows().some(el => !before.has(el))) report();
        }, 50);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open'] });
    setTimeout(() => {
        observer.disconnect();
        clearTimeout(pending);
        if (reported) return;
        if (openWindows().some(el => !before.has(el)) || (orOpen && floatingWindows().length)) report();
    }, 1500);
}

/** A tap or input in a panel mirror, replayed on the same element of the real panel (found by its child path). */
function panelEvent(index, panelIndex, path, kind, data = {}) {
    let element = extensionPanels(index)[panelIndex];
    for (const i of path) element = element?.children[i];
    if (!element || (data.tag && element.tagName !== data.tag)) return false;
    if (kind === 'click') {
        watchOpened();
        // click() also runs the element's default action (a checkbox toggles, a label passes the click on).
        if (typeof element.click === 'function') element.click();
        else element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
    }
    if ('checked' in data && 'checked' in element) element.checked = data.checked;
    else if ('value' in data && 'value' in element) element.value = data.value;
    element.dispatchEvent(new Event(kind, { bubbles: true }));
    return true;
}

// Panels change on their own (expanded, rescanned): refresh the shell when anything outside the message text changes.
// Hiding a message from the AI only flips its is_system attribute (no event), so that refreshes the shell too.
let panelTimer;
function watchPanels() {
    const chat = document.getElementById('chat');
    if (!chat) return;
    new MutationObserver(records => {
        for (const record of records) {
            const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            const hiding = record.attributeName === 'is_system';
            if (!hiding && (!element || element.closest('.mes_text') || !element.closest('.mes_block'))) continue;
            clearTimeout(panelTimer);
            panelTimer = setTimeout(() => emit('chat'), 120);
            return;
        }
    }).observe(chat, { subtree: true, childList: true, attributes: true, characterData: true });
}

function formatted(index, message) {
    if (typeof st.messageFormatting !== 'function') return null;
    const text = message.extra?.display_text ?? message.mes ?? '';
    const key = `${index}|${message.is_user ? 1 : 0}|${message.name}`;
    const cached = formatCache.get(key);
    if (cached?.text === text) return cached.html;
    try {
        const container = document.createElement('div');
        container.innerHTML = st.messageFormatting(text, message.name, !!message.is_system, !!message.is_user, index);
        const html = sanitizeCopy(container);
        formatCache.set(key, { text, html });
        return html;
    } catch (error) {
        console.warn('[tavern-lite] messageFormatting failed', error);
        return null;
    }
}

function rendered(index, message) {
    const element = document.querySelector(`#chat .mes[mesid="${index}"] .mes_text`);
    if (element) return sanitizeCopy(element.cloneNode(true), element);
    return formatted(index, message);
}

// Reasoning ("thinking") of a message: while the app renders it (streaming included) the block is copied with its
// state; older messages format the stored text the same way the app does.
const reasoningCache = new Map();

function reasoningOf(index, message) {
    const durationMs = message.extra?.reasoning_duration ?? null;
    const details = document.querySelector(`#chat .mes[mesid="${index}"] .mes_reasoning_details`);
    const state = details?.dataset.state;
    if (state && state !== 'none') {
        if (state === 'hidden' && !powerUser.power_user?.reasoning?.show_hidden) return null;
        const content = details.querySelector('.mes_reasoning');
        // 1.19 marks a block with visible text as data-has-content; 1.16 to 1.18 never set it, so the text decides there.
        const hasContent = details.dataset.hasContent === 'true' || !!content?.textContent.trim();
        const html = content && hasContent ? sanitizeCopy(content.cloneNode(true), content) : '';
        return { state, html, durationMs };
    }
    const text = String(message.extra?.reasoning ?? '');
    if (!text.trim() || typeof st.messageFormatting !== 'function') return null;
    const cached = reasoningCache.get(index);
    if (cached?.text === text) return { state: 'done', html: cached.html, durationMs };
    try {
        const container = document.createElement('div');
        container.innerHTML = st.messageFormatting(text, '', false, false, index, {}, true);
        const html = sanitizeCopy(container);
        reasoningCache.set(index, { text, html });
        return { state: 'done', html, durationMs };
    } catch (error) {
        console.warn('[tavern-lite] reasoning formatting failed', error);
        return null;
    }
}

// The small print the app shows next to a message (its own settings decide which): time, number, generation time.
// The shell is Chinese whatever language the full app is set to: "10月11日 16:31", with the year when it is not this one.
function chineseTime(date) {
    const pad = n => String(n).padStart(2, '0');
    const year = date.getFullYear() === new Date().getFullYear() ? '' : `${date.getFullYear()}年`;
    return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function messageMeta(index, message) {
    let time = '';
    try {
        const moment = utils.timestampToMoment?.(message.send_date);
        if (moment?.isValid?.()) time = chineseTime(moment.toDate());
    } catch { /* unparseable date */ }
    const started = Date.parse(message.gen_started ?? ''), finished = Date.parse(message.gen_finished ?? '');
    const seconds = Number.isFinite(started) && Number.isFinite(finished) && finished > started ? (finished - started) / 1000 : null;
    return { time, timer: seconds === null ? '' : `${seconds.toFixed(1)} 秒`, tokens: message.extra?.token_count ?? null };
}

// The regex scripts the app runs when it shows a message (display-only ones; the others already changed the stored
// text). The shell keeps them so a story opened before the full app is ready already looks the same. Macros in the
// find pattern are resolved here, for the open character.
function sanitizeRegexMacro(x) {
    return typeof x === 'string' ? x.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/g, s =>
        ({ '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v', '\f': '\\f', '\0': '\\0' })[s] ?? `\\${s}`) : x;
}

function displayRules() {
    const types = regexEngine.SCRIPT_TYPES;
    if (!types || typeof regexEngine.getScriptsByType !== 'function') return null;
    if (ctx().extensionSettings?.disabledExtensions?.includes('regex')) return { global: [], preset: [], scoped: [] };
    const resolve = script => {
        const mode = Number(script.substituteRegex);
        if (mode === 1) return st.substituteParamsExtended?.(script.findRegex) ?? script.findRegex;
        if (mode === 2) return st.substituteParamsExtended?.(script.findRegex, {}, sanitizeRegexMacro) ?? script.findRegex;
        return script.findRegex;
    };
    const pick = type => {
        try {
            return (regexEngine.getScriptsByType(type, { allowedOnly: true }) ?? [])
                .filter(s => s && !s.disabled && s.markdownOnly && s.findRegex && Array.isArray(s.placement) && s.placement.some(p => p === 1 || p === 2))
                .map(s => ({ find: resolve(s), replace: String(s.replaceString ?? ''), trim: Array.isArray(s.trimStrings) ? s.trimStrings : [],
                    placement: s.placement, minDepth: s.minDepth ?? null, maxDepth: s.maxDepth ?? null }));
        } catch { return []; }
    };
    return { global: pick(types.GLOBAL), preset: pick(types.PRESET), scoped: pick(types.SCOPED) };
}

function displaySettings() {
    const p = powerUser.power_user ?? {};
    return {
        timestamps: !!p.timestamps_enabled,
        ids: !!p.mesIDDisplay_enabled,
        timer: !!p.timer_enabled,
        tokens: !!p.message_token_count_enabled,
        reasoningOpen: !!p.reasoning?.auto_expand,
    };
}

// Buttons other features put into the app: the bar above the input (Quick Replies and Tavern Helper's script
// buttons share #qr--bar), the extensions menu (the wand), and each message's button row. The shell lists them and
// replays a tap on the real one; whatever they open in the app is announced through watchOpened.
// Laid out at all. Visibility is not asked: the overlay (below) hides the app's own page with it.
const isRendered = el => el.getClientRects().length > 0 && el.style.visibility !== 'hidden';
const labelOf = el => (el.textContent || el.title || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');

function keyed(elements) {
    const seen = new Map();
    return elements.map(element => {
        const label = labelOf(element);
        const n = seen.get(label) ?? 0;
        seen.set(label, n + 1);
        return { element, label, key: `${label}#${n}` };
    });
}

function inputButtonElements() {
    const found = new Set();
    for (const el of document.querySelectorAll('#send_form #qr--bar .qr--button, #send_form #qr--bar .qr--buttons > .menu_button, #send_form #qr--bar .qr--buttons > button')) {
        if (isRendered(el) && labelOf(el)) found.add(el);
    }
    return keyed([...found]);
}

function inputButtons() {
    return inputButtonElements().map(({ label, key, element }) => ({ label, key, title: element.title || '' }));
}

function clickInputButton(key) {
    const target = inputButtonElements().find(b => b.key === key);
    if (!target) return false;
    watchOpened();
    target.element.click();
    return true;
}

function extensionMenuElements() {
    return keyed([...document.querySelectorAll('#extensionsMenu .list-group-item')]
        .filter(el => el.id !== 'tavern-lite-open' && !el.hidden && getComputedStyle(el).display !== 'none' && labelOf(el)));
}

function extensionMenu() {
    return extensionMenuElements().map(({ label, key }) => ({ label, key }));
}

function clickExtensionMenu(key) {
    const target = extensionMenuElements().find(b => b.key === key);
    if (!target) return false;
    watchOpened({ orOpen: true });
    target.element.click();
    return true;
}

// Extensions' own panels in the full app: drawers they add to the top bar (Horae's, for example) and their blocks in
// the extensions panel. Each is named by what the extension itself shows there, so nothing here knows extension names.
const NATIVE_DRAWERS = new Set(Object.values(PANELS));
const shownText = element => {
    const copy = element.cloneNode(true);
    copy.querySelectorAll('a, .notes-link, .inline-drawer-icon, [class*="version"]').forEach(node => node.remove());
    return labelOf(copy);
};

function extensionPanelElements() {
    const drawers = [...document.querySelectorAll('#top-settings-holder > .drawer')]
        .filter(el => !NATIVE_DRAWERS.has(el.id) && el.querySelector('.drawer-toggle') && getComputedStyle(el).display !== 'none')
        .map(element => {
            const heading = element.querySelector('.drawer-content :is(.drawer-header, h1, h2, h3, h4, [class*="title"])');
            return { element, kind: 'drawer', label: (heading && shownText(heading)) || element.querySelector('.drawer-icon')?.title?.trim() || '' };
        });
    const blocks = [...document.querySelectorAll('#extensions_settings > *, #extensions_settings2 > *')]
        .filter(el => getComputedStyle(el).display !== 'none')
        .map(element => {
            const header = element.querySelector('.inline-drawer-header');
            return { element, kind: 'settings', label: header ? shownText(header.querySelector('b, strong') ?? header) : '' };
        });
    const seen = new Map();
    return [...drawers, ...blocks].filter(p => p.label).map(p => {
        const n = seen.get(p.kind + p.label) ?? 0;
        seen.set(p.kind + p.label, n + 1);
        return { ...p, key: `${p.kind}:${p.label}#${n}` };
    });
}

function extensionPanelList() {
    return extensionPanelElements().map(({ kind, label, key }) => ({ kind, label, key }));
}

/** Opens an extension's drawer, or the extensions panel unfolded and scrolled to its block. */
function openExtensionPanel(key) {
    const target = extensionPanelElements().find(p => p.key === key);
    if (!target) return false;
    const { element } = target;
    if (target.kind === 'drawer') {
        if (!element.querySelector('.drawer-content')?.classList.contains('openDrawer')) element.querySelector('.drawer-toggle').click();
        return true;
    }
    if (!openPanel('extensions')) return false;
    const drawer = element.matches('.inline-drawer') ? element : element.querySelector('.inline-drawer');
    const content = drawer?.querySelector(':scope > .inline-drawer-content');
    if (content && getComputedStyle(content).display === 'none') drawer.querySelector(':scope > .inline-drawer-toggle')?.click();
    // The app's own containers are display: contents (no box of their own), so scroll to the block inside.
    setTimeout(() => (drawer ?? element).scrollIntoView({ block: 'start' }), 400);
    return true;
}

// The shell has its own copy, edit, delete and branch; everything else in the row is offered as "more".
const OWN_MESSAGE_BUTTONS = ['mes_edit', 'mes_copy', 'mes_create_branch', 'extraMesButtonsHint'];
const MESSAGE_BUTTON_NAMES = {
    mes_translate: '翻译', mes_narrate: '朗读', sd_message_gen: '生成图片', mes_prompt: '查看这条用到的提示词',
    mes_hide: '对 AI 隐藏', mes_unhide: '取消隐藏（让 AI 看到）', mes_media_gallery: '图库', mes_media_list: '附件列表',
    mes_embed: '附加文件或图片', mes_swipe_picker: '跳到某个回复', mes_create_bookmark: '存为存档点', mes_bookmark: '打开存档点来源',
};

function messageButtonElements(node) {
    return [...node.querySelectorAll('.mes_buttons .mes_button')]
        .filter(el => !OWN_MESSAGE_BUTTONS.some(c => el.classList.contains(c)) && getComputedStyle(el).display !== 'none')
        .map(element => {
            const known = Object.keys(MESSAGE_BUTTON_NAMES).find(c => element.classList.contains(c));
            const key = known ?? [...element.classList].find(c => c !== 'mes_button' && !c.startsWith('fa')) ?? labelOf(element);
            return { element, key, label: known ? MESSAGE_BUTTON_NAMES[known] : (element.title || labelOf(element) || key) };
        });
}

function messageButtons(index) {
    return enqueue(async () => {
        const node = await revealMessage(index);
        return messageButtonElements(node).map(({ key, label }) => ({ key, label }));
    });
}

function clickMessageButton(index, key) {
    return enqueue(async () => {
        const node = await revealMessage(index);
        const target = messageButtonElements(node).find(b => b.key === key);
        if (!target) throw new Error('这个按钮已经不在了');
        watchOpened();
        target.element.click();
    });
}

let inputsTimer;
function watchInputs() {
    const form = document.getElementById('send_form');
    if (!form) return;
    new MutationObserver(() => {
        clearTimeout(inputsTimer);
        inputsTimer = setTimeout(() => emit('inputs'), 150);
    }).observe(form, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
}

// Floating layers: things scripts and extensions place on the page itself (a character script's Live2D figure, floating
// buttons). While the shell is on screen the app page is laid over it, transparent, with everything but these
// layers hidden; the shell cuts the overlay down to their rectangles so they can be seen and touched.
const appChildren = new WeakSet(document.body.children);
const FLOAT_MAX_SHARE = 0.4;
let overlayOn = false;
let floatObserver;

function floatingElements() {
    const area = innerWidth * innerHeight;
    return [...document.body.children].filter(el => {
        if (appChildren.has(el) || el.hasAttribute('data-tl-not-float')) return false;
        if (/^(SCRIPT|STYLE|LINK|TEMPLATE|DIALOG)$/.test(el.tagName)) return false;
        if (el.id === 'toast-container' || el.classList.contains('popup') || !isRendered(el)) return false;
        if (getComputedStyle(el).position !== 'fixed') return false;
        const r = el.getBoundingClientRect();
        return r.width * r.height > 0 && r.width * r.height < area * FLOAT_MAX_SHARE;
    });
}

function floatingLayers() {
    const elements = floatingElements();
    for (const el of document.body.children) {
        const floating = elements.includes(el);
        if (floating !== el.hasAttribute('data-tl-float')) el.toggleAttribute('data-tl-float', floating);
    }
    floatObserver?.disconnect();
    floatObserver = new MutationObserver(reportFloats);
    for (const el of document.body.children) {
        if (!appChildren.has(el)) floatObserver.observe(el, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
    }
    return elements.map(el => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    });
}

let floatsTimer;
let lastFloats = '';
function reportFloats() {
    clearTimeout(floatsTimer);
    floatsTimer = setTimeout(() => {
        const rects = floatingLayers();
        const text = JSON.stringify(rects);
        if (text === lastFloats) return;
        lastFloats = text;
        emit('floats', rects);
    }, 30);
}

function watchFloats() {
    const style = document.createElement('style');
    style.id = 'tavern-lite-overlay';
    style.textContent = 'html.tl-overlay, html.tl-overlay body { background: transparent !important; background-image: none !important; }\n'
        + 'html.tl-overlay body > :not([data-tl-float]) { visibility: hidden !important; }';
    document.head.append(style);
    new MutationObserver(reportFloats).observe(document.body, { childList: true });
    addEventListener('resize', reportFloats);
    reportFloats();
}

/** The shell lays this page over itself (true) or hides it again (false). */
function setOverlay(on, colorScheme = '') {
    overlayOn = on;
    document.documentElement.classList.toggle('tl-overlay', on);
    document.documentElement.style.colorScheme = on ? colorScheme : '';
}

/** A tap on the shell, passed on so floating layers that follow taps on the page (a figure that looks at it) see it too. */
function pointerAt(x, y) {
    if (!overlayOn) return;
    const target = document.elementFromPoint(x, y) ?? document.body;
    target.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, composed: true, pointerType: 'touch', isPrimary: true }));
}

// Model switching: the Connection Manager's profiles (API, model, preset… saved together) and the current API's
// presets. Both are chosen through the app's own selects, so everything the app does on a change still happens.
const PRESET_SELECTS = {
    openai: 'settings_preset_openai',
    textgenerationwebui: 'settings_preset_textgenerationwebui',
    kobold: 'settings_preset',
    novel: 'settings_preset_novel',
};

function modelChoices() {
    const manager = ctx().extensionSettings?.connectionManager;
    const profileSelect = document.getElementById('connection_profiles');
    const profiles = profileSelect && Array.isArray(manager?.profiles)
        ? manager.profiles.map(p => ({ id: String(p.id), name: String(p.name ?? ''), model: String(p.model ?? ''), api: String(p.api ?? '') }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : null;
    const presetSelect = document.getElementById(PRESET_SELECTS[ctx().mainApi]);
    const presets = presetSelect
        ? [...presetSelect.options].filter(o => o.value !== '' && !o.disabled).map(o => ({ id: o.value, name: o.textContent.trim() }))
        : null;
    return {
        profiles,
        profile: profiles ? String(manager.selectedProfile ?? '') : '',
        presets,
        preset: presetSelect ? presetSelect.value : '',
        connection: connection(),
    };
}

function chooseFrom(select, value) {
    if (![...select.options].some(o => o.value === value)) throw new Error('这一项不在了，重新打开列表看看');
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

function selectProfile(id) {
    return enqueue(async () => {
        await waitIdle();
        const select = document.getElementById('connection_profiles');
        if (!select) throw new Error('没开启「连接配置」扩展');
        chooseFrom(select, id);
        await waitFor(() => String(ctx().extensionSettings?.connectionManager?.selectedProfile ?? '') === id, 10000);
        // Applying a profile reconnects the API.
        await waitFor(connected, 20000);
        await sleep(SETTLE_MS);
        return modelChoices();
    });
}

function selectPreset(id) {
    return enqueue(async () => {
        await waitIdle();
        const select = document.getElementById(PRESET_SELECTS[ctx().mainApi]);
        if (!select) throw new Error('这个连接没有可选的预设');
        chooseFrom(select, id);
        await sleep(SETTLE_MS);
        return modelChoices();
    });
}

/**
 * Deletes one of the current API's presets as the app's delete button does, without its confirmation. The one in use
 * can go too: the app then switches to the first one left. The last one stays.
 */
function deletePreset(id) {
    return enqueue(async () => {
        await waitIdle();
        const c = ctx();
        const select = document.getElementById(PRESET_SELECTS[c.mainApi]);
        const options = select ? [...select.options].filter(o => o.value !== '' && !o.disabled) : [];
        const option = options.find(o => o.value === id);
        if (!option) throw new Error('找不到这个预设，重新打开列表看看');
        if (options.length < 2) throw new Error('至少要留一个预设');
        const manager = c.getPresetManager?.();
        if (typeof manager?.deletePreset !== 'function') throw new Error('当前酒馆版本不支持，请在原版界面操作');
        const name = option.textContent.trim();
        if (!await manager.deletePreset(name)) throw new Error('没删掉，再试一次');
        if (c.eventTypes.PRESET_DELETED) await c.eventSource.emit(c.eventTypes.PRESET_DELETED, { apiId: manager.apiId, name });
        c.saveSettingsDebounced?.();
        await sleep(SETTLE_MS);
        return modelChoices();
    });
}

/**
 * Deletes a connection profile as the app's delete button does, without its confirmation, and not only the selected
 * one. The connection in use stays as it is; deleting the selected profile leaves none selected.
 */
function deleteProfile(id) {
    return enqueue(async () => {
        await waitIdle();
        const c = ctx();
        const manager = c.extensionSettings?.connectionManager;
        const index = Array.isArray(manager?.profiles) ? manager.profiles.findIndex(p => String(p.id) === id) : -1;
        if (index === -1) throw new Error('找不到这个连接，重新打开列表看看');
        const [profile] = manager.profiles.splice(index, 1);
        const selected = String(manager.selectedProfile ?? '') === id;
        if (selected) manager.selectedProfile = null;
        c.saveSettingsDebounced?.();
        const select = document.getElementById('connection_profiles');
        [...(select?.options ?? [])].find(o => o.value === id)?.remove();
        if (selected && select) select.value = '';
        if (c.eventTypes.CONNECTION_PROFILE_DELETED) await c.eventSource.emit(c.eventTypes.CONNECTION_PROFILE_DELETED, profile);
        if (selected && c.eventTypes.CONNECTION_PROFILE_LOADED) await c.eventSource.emit(c.eventTypes.CONNECTION_PROFILE_LOADED, '<None>');
        return modelChoices();
    });
}

// First-time setup in plain steps (the shell's 开始使用 page): a chat completion service, its key (and address for
// a compatible relay), a model, a test reply. Everything goes through the app's own controls and secret store, as if
// the user had filled in the API panel.
const MODEL_SELECT = source => `model_${source === 'makersuite' ? 'google' : source}_select`;

function secretKeyFor(source) {
    return secrets.SECRET_KEYS?.[source.toUpperCase()] ?? `api_key_${source}`;
}

/**
 * Whether the current API looks filled in (a key, or an address for a compatible relay). A new account starts on the
 * public Horde, which counts as not set up (its queue is too slow to chat with); other API types count as set.
 */
function connectionConfigured() {
    const c = ctx();
    if (c.mainApi === 'koboldhorde') return false;
    if (c.mainApi !== 'openai') return true;
    const source = c.chatCompletionSettings?.chat_completion_source ?? '';
    if (source === 'custom') return !!c.chatCompletionSettings?.custom_url;
    const state = secrets.secret_state?.[secretKeyFor(source)];
    return Array.isArray(state) ? state.length > 0 : !!state;
}

function setControl(id, value, event = 'change') {
    const element = document.getElementById(id);
    if (!element) throw new Error('当前酒馆版本不支持，请在原版界面操作');
    element.value = value;
    element.dispatchEvent(new Event(event, { bubbles: true }));
}

function modelOptions(source = ctx().chatCompletionSettings?.chat_completion_source) {
    const select = document.getElementById(MODEL_SELECT(source));
    if (!select) return { models: [], current: '' };
    const models = [...select.querySelectorAll('option')]
        .filter(o => o.value && !o.disabled)
        .map(o => ({ id: o.value, name: o.textContent.trim() || o.value }));
    // A relay without a model list uses the model name typed in (the app's custom model field).
    const typed = source === 'custom' ? String(ctx().chatCompletionSettings?.custom_model ?? '') : '';
    return { models, current: select.value || typed };
}

/** For a relay that lists no models: the model name to use, as typed. `profile`: the setup page's new profile. */
function setCustomModel(id, { profile = '' } = {}) {
    return enqueue(async () => {
        setControl('custom_model_id', String(id ?? '').trim(), 'input');
        await sleep(300);
        const manager = profileManager();
        if (profile && manager) await updateProfile(manager, profile);
        ctx().saveSettingsDebounced?.();
        return modelOptions('custom');
    });
}

// Services the app does not check before a message (it only says the key is saved).
const UNCHECKED_SOURCES = ['claude', 'zai', 'ai21', 'vertexai', 'perplexity', 'minimax'];

/**
 * What a connection check told: `state` is 'ok', 'unverified' (the app could not tell: a relay without a model
 * list, or a service it never checks; a test sentence decides) or 'failed'.
 */
function setupOutcome(source, url, modelCount) {
    if (!connected()) return { connected: false, state: 'failed' };
    if (source === 'custom') {
        let valid = false;
        try { valid = /^https?:$/.test(new URL(String(url ?? '').trim()).protocol); } catch { valid = false; }
        // For a relay the app always reports "check bypassed"; only a model list shows the address answered.
        if (!valid) return { connected: false, state: 'failed' };
        return modelCount > 0 ? { connected: true, state: 'ok' } : { connected: true, state: 'unverified' };
    }
    return UNCHECKED_SOURCES.includes(source) ? { connected: true, state: 'unverified' } : { connected: true, state: 'ok' };
}

// Connection profiles (the Connection Manager extension): the setup page saves what it sets up as a new profile and
// keeps what was in use (a profile that already holds it, or one saved now), instead of changing it in place.
function profileManager() {
    const manager = ctx().extensionSettings?.connectionManager;
    return document.getElementById('connection_profiles') && Array.isArray(manager?.profiles) ? manager : null;
}

function activeSecretId(source) {
    const state = secrets.secret_state?.[secretKeyFor(source)];
    return Array.isArray(state) ? String(state.find(item => item.active)?.id ?? '') : '';
}

/** A saved profile that holds the current chat completion connection (service, address, model, key), if any. */
function profileForCurrent(manager) {
    const c = ctx();
    if (c.mainApi !== 'openai') return manager.profiles.find(p => p.id === manager.selectedProfile) ?? null;
    const settings = c.chatCompletionSettings ?? {}, source = settings.chat_completion_source ?? '';
    const model = modelOptions(source).current, secret = activeSecretId(source);
    return manager.profiles.find(p => p.mode !== 'tc' && p.api === source && (source !== 'custom' || p['api-url'] === settings.custom_url)
        && (!p.model || p.model === model) && (!p['secret-id'] || !secret || p['secret-id'] === secret)) ?? null;
}

async function slashCommand(command) {
    const run = ctx().executeSlashCommandsWithOptions;
    if (typeof run !== 'function') throw new Error('当前酒馆版本不支持，请在原版界面操作');
    const result = await run(command, { handleParserErrors: false, handleExecutionErrors: false });
    if (result?.isError) throw new Error(result.errorMessage || '连接没存上');
    return result?.pipe;
}

async function createProfile(manager, wanted) {
    const base = String(wanted ?? '').replace(/["\\|{}\r\n]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || '新连接';
    let name = base;
    for (let n = 2; manager.profiles.some(p => p.name === name); n++) name = `${base} ${n}`;
    await slashCommand(`/profile-create "${name}"`);
    const profile = manager.profiles.find(p => p.name === name);
    if (!profile) throw new Error('连接设好了，但没能存成新连接');
    return profile;
}

/** The profile this page made now holds the current settings: point the manager at it without applying it, then save. */
async function updateProfile(manager, id) {
    if (!manager.profiles.some(p => p.id === id)) return false;
    manager.selectedProfile = id;
    const select = document.getElementById('connection_profiles');
    if (select) select.value = id;
    await slashCommand('/profile-update');
    return true;
}

/** Applies a saved profile (as choosing it in the full app does): the connection in use before a try. */
async function applyProfile(manager, id) {
    const select = document.getElementById('connection_profiles');
    select.value = '';
    chooseFrom(select, id);
    await waitFor(() => String(manager.selectedProfile ?? '') === id, 10000);
    await sleep(SETTLE_MS);
    return manager.profiles.find(p => p.id === id)?.name ?? '';
}

/** A connection the app could not check, once a reply came or the user kept it: saved like a checked one. */
function saveSetupProfile({ profileName = '', profile = '' } = {}) {
    return enqueue(async () => {
        const manager = profileManager();
        if (!manager) return null;
        const saved = profile && await updateProfile(manager, profile) ? manager.profiles.find(p => p.id === profile) : await createProfile(manager, profileName);
        ctx().saveSettingsDebounced?.();
        return { id: saved.id, name: saved.name };
    });
}

/** Leaving a try that was never confirmed: back to the profile in use before it. */
function putBackProfile(id) {
    return enqueue(async () => {
        const manager = profileManager();
        if (!manager || !id || !manager.profiles.some(p => p.id === id)) return '';
        await waitIdle();
        const name = await applyProfile(manager, id);
        ctx().saveSettingsDebounced?.();
        return name;
    });
}

function setupConnection({ source, key, url, profileName = '', profile: madeHere = '' }) {
    if (typeof secrets.writeSecret !== 'function') return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    return enqueue(async () => {
        await waitIdle();
        const manager = profileManager();
        let kept = null, previous = '';
        if (manager) {
            if (!madeHere && connectionConfigured() && !profileForCurrent(manager)) kept = await createProfile(manager, '原来的连接');
            previous = String(manager.selectedProfile ?? '');
        }
        if (ctx().mainApi !== 'openai') setControl('main_api', 'openai');
        setControl('chat_completion_source', source);
        if (source === 'custom') setControl('custom_api_url_text', String(url ?? '').trim(), 'input');
        if (key) await secrets.writeSecret(secretKeyFor(source), String(key).trim(), '轻酒馆');
        await sleep(SETTLE_MS);
        // The status still says how the previous service answered; only the check that follows counts.
        if (typeof st.setOnlineStatus === 'function') st.setOnlineStatus('no_connection');
        connectingSince = 0;
        startConnecting();
        // The app marks its connect button disabled while it checks.
        const button = document.getElementById(CONNECT_BUTTONS.openai);
        await waitFor(() => button?.classList.contains('disabled'), 2000);
        await waitFor(() => !button?.classList.contains('disabled'), CONNECT_WAIT_MS);
        await sleep(300);
        const options = modelOptions(source), outcome = setupOutcome(source, url, options.models.length);
        let saved = null, restored = '', pending = null;
        if (manager && outcome.state === 'ok') {
            saved = madeHere && await updateProfile(manager, madeHere) ? manager.profiles.find(p => p.id === madeHere) : await createProfile(manager, profileName);
        } else if (manager && outcome.connected) {
            // Could not be checked (a relay without a model list, a service never checked): saved once a reply comes
            // or the user keeps it; leaving without that puts this profile back.
            pending = { previous };
        } else if (manager && previous && manager.profiles.some(p => p.id === previous)) {
            // Not connected: back to what was in use, so a failed try leaves it as it was.
            restored = await applyProfile(manager, previous);
        }
        ctx().saveSettingsDebounced?.();
        return { ...options, ...outcome, profile: saved ? { id: saved.id, name: saved.name } : null, kept: kept?.name ?? '', restored, pending, profiles: !!manager };
    });
}

function chooseModel(id, { profile = '' } = {}) {
    return enqueue(async () => {
        await waitIdle();
        setControl(MODEL_SELECT(ctx().chatCompletionSettings?.chat_completion_source), id);
        await sleep(SETTLE_MS);
        const manager = profileManager();
        if (profile && manager) await updateProfile(manager, profile);
        ctx().saveSettingsDebounced?.();
        return modelOptions();
    });
}

/**
 * A short reply outside any story, to show the setup works. With chat completion this is the full app's own API test
 * (its 测试消息 button): just "Hi" as a quiet request, which extensions do not add to (a raw generation carries their
 * injections, e.g. a memory extension's whole state snapshot).
 */
function testReply() {
    if (ctx().mainApi === 'openai' && typeof openai.sendOpenAIRequest === 'function') {
        return enqueue(async () => {
            await ensureConnected();
            await waitIdle();
            const data = await openai.sendOpenAIRequest('quiet', [{ role: 'user', content: 'Hi' }], new AbortController().signal);
            return String(st.extractMessageFromData?.(data) ?? data?.choices?.[0]?.message?.content ?? '').trim();
        });
    }
    const raw = ctx().generateRaw;
    if (typeof raw !== 'function') return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    return enqueue(async () => {
        await ensureConnected();
        await waitIdle();
        const prompt = '请用一句简短、友好的中文跟我打个招呼。';
        let text;
        try {
            text = await raw({ prompt, responseLength: 80 });
        } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            text = await raw(prompt, null, false, false, '', 80);
        }
        return String(text ?? '').trim();
    });
}

/** Renames the current persona (who the user is in stories). */
function renamePersona(name) {
    const value = String(name ?? '').trim();
    if (!value) return Promise.reject(new Error('请输入名字'));
    return enqueue(async () => {
        const p = powerUser.power_user;
        if (p?.personas && personas.user_avatar) p.personas[personas.user_avatar] = value;
        if (typeof st.setUserName === 'function') st.setUserName(value, { toastPersonaNameChange: false });
        ctx().saveSettingsDebounced?.();
        return personaList();
    });
}

// Personas: who the user is in the story. The app switches to a chat's locked persona when the chat opens; with
// "auto-lock" on (power_user.persona_auto_lock), choosing one in a chat locks it to that chat, as in the app.
function personaList() {
    const p = powerUser.power_user ?? {};
    const names = p.personas ?? {};
    const descriptions = p.persona_descriptions ?? {};
    let locked = false;
    try { locked = !!personas.isPersonaLocked?.('chat'); } catch { locked = false; }
    return {
        current: personas.user_avatar ?? '',
        locked,
        isDefault: !!p.default_persona && p.default_persona === personas.user_avatar,
        autoLock: !!p.persona_auto_lock,
        list: Object.keys(names)
            .map(id => ({ id, name: String(names[id] ?? ''), title: String(descriptions[id]?.title ?? ''), description: String(descriptions[id]?.description ?? '').slice(0, 160), fullDescription: String(descriptions[id]?.description ?? '') }))
            .sort((a, b) => a.name.localeCompare(b.name)),
    };
}

function removeCharacter(avatar) {
    if (typeof st.deleteCharacter !== 'function') return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    return enqueue(async () => {
        await waitIdle();
        if (!ctx().characters.some(c => c.avatar === avatar)) throw new Error('找不到这个角色，请刷新页面');
        const done = await st.deleteCharacter(avatar, { deleteChats: true });
        if (done === false) throw new Error('没删掉，再试一次');
    });
}

function setPersona(id, { lock, autoLock = true, isDefault } = {}) {
    if (typeof personas.setUserAvatar !== 'function') return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    return enqueue(async () => {
        await waitIdle();
        if (id && id !== personas.user_avatar) {
            // Chosen outside a story ("我的"): no story is locked to it, whatever auto-lock says.
            const p = powerUser.power_user;
            const saved = p?.persona_auto_lock;
            if (!autoLock && p) p.persona_auto_lock = false;
            try {
                await personas.setUserAvatar(id, { toastPersonaNameChange: false });
            } finally {
                if (!autoLock && p) p.persona_auto_lock = saved;
            }
        }
        if (isDefault !== undefined && typeof personas.setPersonaLockState === 'function' && isDefault !== personaList().isDefault) {
            await personas.setPersonaLockState(isDefault, 'default');
        }
        if (lock !== undefined && typeof personas.setPersonaLockState === 'function' && lock !== personaList().locked) {
            await personas.setPersonaLockState(lock, 'chat');
        }
        return personaList();
    });
}

/** Changes a persona's name and what the AI is told about the user (its description). */
function editPersona(id, { name, description }) {
    const value = String(name ?? '').trim();
    if (!value) return Promise.reject(new Error('请输入名字'));
    return enqueue(async () => {
        const p = powerUser.power_user;
        if (!p?.personas || !(id in p.personas)) throw new Error('找不到这个身份，请刷新页面');
        p.personas[id] = value;
        p.persona_descriptions ??= {};
        p.persona_descriptions[id] ??= { description: '', position: personas.persona_description_positions?.IN_PROMPT ?? 0, depth: 2, role: 0, lorebook: '', title: '' };
        p.persona_descriptions[id].description = String(description ?? '');
        if (id === personas.user_avatar) {
            p.persona_description = p.persona_descriptions[id].description;
            if (typeof st.setUserName === 'function') st.setUserName(value, { toastPersonaNameChange: false });
            try { personas.setPersonaDescription?.(); } catch { /* the persona panel was never drawn */ }
        }
        ctx().saveSettingsDebounced?.();
        await refreshPersonaPanel(id);
        return personaList();
    });
}

async function refreshPersonaPanel(id) {
    try { await personas.getUserAvatars?.(true, id); } catch { /* only the full app's list */ }
}

async function uploadPersonaImage(id, image) {
    const form = new FormData();
    form.append('avatar', new File([image], 'avatar.png', { type: image.type || 'image/png' }));
    form.append('overwrite_name', id);
    const response = await fetch('/api/avatars/upload', { method: 'POST', headers: st.getRequestHeaders({ omitContentType: true }), cache: 'no-cache', body: form });
    if (!response.ok) throw new Error('头像没传上去');
    await Promise.all([`/User Avatars/${encodeURIComponent(id)}`, `/thumbnail?type=persona&file=${encodeURIComponent(id)}`]
        .map(url => fetch(url, { cache: 'reload' }).catch(() => null)));
}

/** A new persona; `image` (a Blob) becomes its picture. Returns the new persona's id. */
function createPersona({ name, description = '', image }) {
    const value = String(name ?? '').trim();
    if (!value) return Promise.reject(new Error('请输入名字'));
    if (typeof personas.initPersona !== 'function') return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    return enqueue(async () => {
        // As the app does it: time + the ASCII letters of the name keeps the file name unique and safe.
        const id = `${Date.now()}-${value.replace(/[^a-zA-Z0-9]/g, '')}.png`;
        await uploadPersonaImage(id, image);
        await personas.initPersona(id, value, String(description), '');
        await refreshPersonaPanel(id);
        return id;
    });
}

function setPersonaImage(id, image) {
    return enqueue(async () => {
        await uploadPersonaImage(id, image);
        await refreshPersonaPanel(id);
        return personaList();
    });
}

/**
 * Deletes a persona and its picture as the app's delete button does, without its confirmation (the shell asks). The
 * last one stays. When it was the one in use, the default persona (else the first left) takes over, locking no story.
 */
function deletePersona(id) {
    return enqueue(async () => {
        await waitIdle();
        const p = powerUser.power_user;
        if (!p?.personas || !(id in p.personas)) throw new Error('找不到这个身份，请刷新页面');
        if (Object.keys(p.personas).length < 2) throw new Error('至少要留一个身份');
        const response = await fetch('/api/avatars/delete', { method: 'POST', headers: st.getRequestHeaders(), body: JSON.stringify({ avatar: id }) });
        if (!response.ok) throw new Error('没删掉，再试一次');
        const name = p.personas[id];
        delete p.personas[id];
        delete p.persona_descriptions?.[id];
        if (p.default_persona === id) p.default_persona = null;
        const c = ctx();
        if (c.chatMetadata?.persona === id) {
            delete c.chatMetadata.persona;
            await c.saveMetadata?.();
        }
        c.saveSettingsDebounced?.();
        if (c.eventTypes.PERSONA_DELETED) await c.eventSource.emit(c.eventTypes.PERSONA_DELETED, { avatarId: id, name });
        if (personas.user_avatar === id && typeof personas.setUserAvatar === 'function') {
            const next = p.default_persona && p.personas[p.default_persona] ? p.default_persona : Object.keys(p.personas)[0];
            const saved = p.persona_auto_lock;
            p.persona_auto_lock = false;
            try {
                await personas.setUserAvatar(next, { toastPersonaNameChange: false });
            } finally {
                p.persona_auto_lock = saved;
            }
        }
        await refreshPersonaPanel();
        return personaList();
    });
}

/** Renames a character as the app does (its file, chats and references follow); returns the new avatar file name. */
function renameCharacterTo(avatar, name) {
    const value = String(name ?? '').trim();
    if (!value) return Promise.reject(new Error('请输入名字'));
    if (typeof st.renameCharacter !== 'function') return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    return enqueue(async () => {
        await waitIdle();
        await selectCharacter(avatar);
        if (ctx().characters[ctx().characterId]?.name === value) return avatar;
        const done = await st.renameCharacter(value, { silent: true, renameChats: true });
        if (done === false) throw new Error('名字没改成');
        const c = ctx();
        return c.characters[c.characterId]?.avatar ?? avatar;
    });
}

// World books (lorebooks), edited in the shell's own page. Everything goes through the app's world-info module, so its
// cache, the open editor and a character's embedded copy (originalData) stay in step, exactly as with its own editor.
const ENTRY_FIELDS = new Set(['comment', 'content', 'key', 'keysecondary', 'constant', 'vectorized', 'selective', 'selectiveLogic',
    'order', 'position', 'depth', 'role', 'disable', 'probability', 'useProbability', 'group', 'groupOverride', 'groupWeight',
    'excludeRecursion', 'preventRecursion', 'delayUntilRecursion', 'scanDepth', 'caseSensitive', 'matchWholeWords',
    'useGroupScoring', 'sticky', 'cooldown', 'delay', 'ignoreBudget']);

function worldBooks() {
    const names = [...(worldInfo.world_names ?? [])];
    const global = new Set(worldInfo.selected_world_info ?? []);
    const bound = new Map();
    const add = (book, who) => { if (book && !(bound.get(book) ?? []).includes(who)) bound.set(book, [...(bound.get(book) ?? []), who]); };
    // A character's own book, and its additional books (kept by file name in world_info.charLore).
    const byFile = new Map();
    for (const c of ctx().characters ?? []) {
        add(c?.data?.extensions?.world, c.name);
        byFile.set(String(c.avatar ?? '').replace(/\.[^.]+$/, ''), c.name);
    }
    for (const lore of worldInfo.world_info?.charLore ?? []) {
        for (const book of lore.extraBooks ?? []) add(book, byFile.get(lore.name) ?? lore.name);
    }
    return names.sort((a, b) => a.localeCompare(b)).map(name => ({ name, global: global.has(name), characters: bound.get(name) ?? [] }));
}

/** Deletes a world book as the app does (also taken off "all stories" and the open character's link), unasked. */
function deleteWorldBook(name) {
    if (typeof worldInfo.deleteWorldInfo !== 'function') return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    return enqueue(async () => {
        await waitIdle();
        if (!(worldInfo.world_names ?? []).includes(name)) throw new Error(`找不到世界书「${name}」，可能已经改名或删除`);
        if (await worldInfo.deleteWorldInfo(name) === false) throw new Error('没删掉，再试一次');
        return worldBooks();
    });
}

/**
 * Where a world book is used: every story (the app's global list), and each character, by its own book (on the card)
 * or as one of its additional books (kept in world_info.charLore by file name), as the app's character lorebook popup.
 */
function worldBookUsage(name) {
    const extras = new Map((worldInfo.world_info?.charLore ?? []).map(lore => [lore.name, lore.extraBooks ?? []]));
    const characters = (ctx().characters ?? []).filter(c => c?.avatar).map(c => {
        const own = c.data?.extensions?.world || '';
        return { avatar: c.avatar, name: c.name, own: own === name, extra: (extras.get(c.avatar.replace(/\.[^.]+$/, '')) ?? []).includes(name), otherOwn: own !== name ? own : '' };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { name, global: (worldInfo.selected_world_info ?? []).includes(name), characters };
}

/** On or off for every story, through the app's own world list (it saves the setting and tells its listeners). */
function setWorldBookGlobal(name, on) {
    return enqueue(async () => {
        await waitIdle();
        const index = (worldInfo.world_names ?? []).indexOf(name), select = document.getElementById('world_info');
        if (index < 0) throw new Error(`找不到世界书「${name}」，可能已经改名或删除`);
        const option = [...(select?.options ?? [])].find(o => o.value === String(index));
        if (!option) throw new Error('原版的世界书列表还没准备好，稍后再试');
        option.selected = !!on;
        $(select).trigger('change');
        if ((worldInfo.selected_world_info ?? []).includes(name) !== !!on) throw new Error('没改成，再试一次');
        return worldBookUsage(name);
    });
}

/**
 * Lets a character use a world book or stop using it. Its own book is set when it has none (the card then points to
 * it, as the app's 🌐 button does, written with the same merge the app uses when a book is renamed); a character that
 * already has one gets it as an additional book. Stopping removes it from either.
 */
function setWorldBookCharacter(name, avatar, on) {
    return enqueue(async () => {
        await waitIdle();
        if (!(worldInfo.world_names ?? []).includes(name)) throw new Error(`找不到世界书「${name}」，可能已经改名或删除`);
        const index = await characterIndex(avatar), file = avatar.replace(/\.[^.]+$/, '');
        const own = ctx().characters[index].data?.extensions?.world || '';
        const extras = (worldInfo.world_info?.charLore ?? []).find(lore => lore.name === file)?.extraBooks ?? [];
        const setExtras = books => {
            if (typeof worldInfo.charSetAuxWorlds !== 'function') throw new Error('当前酒馆版本不支持，请在原版界面操作');
            worldInfo.charSetAuxWorlds(file, books);
        };
        const setOwn = async world => {
            const response = await fetch('/api/characters/merge-attributes', { method: 'POST', headers: st.getRequestHeaders(),
                body: JSON.stringify({ avatar, data: { extensions: { world } } }) });
            if (!response.ok) throw new Error('角色卡没改成，再试一次');
            if (typeof st.getOneCharacter === 'function') await st.getOneCharacter(avatar); else await st.getCharacters?.();
            const c = ctx();
            // The character on screen: refill the app's form, which would otherwise write the old book back.
            if (!c.groupId && String(c.characterId) === String(index)) {
                await c.selectCharacterById(index, { switchMenu: false });
                worldInfo.setWorldInfoButtonClass?.(index, !!world);
            }
            if ((ctx().characters[index]?.data?.extensions?.world || '') !== world) throw new Error('角色卡没改成，再试一次');
        };
        if (on && own !== name && !extras.includes(name)) {
            if (!own) await setOwn(name); else setExtras([...extras, name]);
        } else if (!on) {
            if (extras.includes(name)) setExtras(extras.filter(book => book !== name));
            if (own === name) await setOwn('');
        }
        emit('world-editor-changed', { name });
        return worldBookUsage(name);
    });
}

async function readBook(name) {
    if (!(worldInfo.world_names ?? []).includes(name)) throw new Error(`找不到世界书「${name}」，可能已经改名或删除`);
    const data = await worldInfo.loadWorldInfo(name);
    if (!data?.entries) throw new Error('世界书没加载出来，再试一次');
    return data;
}

/** `{ name, entries }`, entries in the app's default display order (its own order, then by 顺序). */
function worldBook(name) {
    return enqueue(async () => {
        const data = await readBook(name);
        const entries = Object.values(data.entries)
            .sort((a, b) => (a.displayIndex ?? 0) - (b.displayIndex ?? 0) || (b.order ?? 0) - (a.order ?? 0) || a.uid - b.uid);
        return { name, entries };
    });
}

function setOriginal(data, uid, key, value) {
    if (typeof worldInfo.setWIOriginalDataValue !== 'function') return;
    if (key === 'disable') worldInfo.setWIOriginalDataValue(data, uid, 'enabled', !value);
    else if (worldInfo.originalWIDataKeyMap?.[key]) worldInfo.setWIOriginalDataValue(data, uid, worldInfo.originalWIDataKeyMap[key], value);
}

async function writeBook(name, data) {
    await worldInfo.saveWorldInfo(name, data, true);
    try { worldInfo.reloadEditor?.(name); } catch { /* the app's editor is not open */ }
}

/** Changes the given fields of one entry (the rest of the entry and the book are left as they are). */
function saveWorldEntry(name, uid, patch) {
    return enqueue(async () => {
        const data = await readBook(name);
        const entry = data.entries[uid];
        if (!entry) throw new Error('这一条不在了，可能在别处删了');
        for (const [key, value] of Object.entries(patch)) {
            if (!ENTRY_FIELDS.has(key)) continue;
            entry[key] = value;
            setOriginal(data, entry.uid, key, value);
        }
        await writeBook(name, data);
        return structuredClone(entry);
    });
}

function addWorldEntry(name, fields = {}) {
    if (typeof worldInfo.createWorldInfoEntry !== 'function') return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    return enqueue(async () => {
        const data = await readBook(name);
        const entry = worldInfo.createWorldInfoEntry(name, data);
        if (!entry) throw new Error('新条目没建成');
        for (const [key, value] of Object.entries(fields)) if (ENTRY_FIELDS.has(key)) entry[key] = value;
        // New entries go to the top of the list, as in the app's own editor.
        entry.displayIndex = Math.min(0, ...Object.values(data.entries).map(e => e.displayIndex ?? 0)) - 1;
        await writeBook(name, data);
        return structuredClone(entry);
    });
}

// The app matches a keyword as written, so "甲、乙" only triggers on that exact text.
const JOINED_KEY = key => !/^\/.+\/[a-z]*$/i.test(key) && /[,，、]/.test(key);

/** Splits every keyword written as "甲、乙" (or with commas) in one book into separate keywords; returns how many entries changed. */
function splitJoinedKeys(name) {
    return enqueue(async () => {
        const data = await readBook(name);
        let changed = 0;
        for (const entry of Object.values(data.entries)) {
            if (entry.constant || !(entry.key ?? []).some(JOINED_KEY)) continue;
            const keys = [...new Set(entry.key.flatMap(k => JOINED_KEY(k) ? k.split(/[,，、]/).map(x => x.trim()).filter(Boolean) : [k]))];
            entry.key = keys;
            setOriginal(data, entry.uid, 'key', keys);
            changed++;
        }
        if (changed) await writeBook(name, data);
        return changed;
    });
}

function deleteWorldEntry(name, uid) {
    return enqueue(async () => {
        const data = await readBook(name);
        if (!data.entries[uid]) return;
        delete data.entries[uid];
        worldInfo.deleteWIOriginalDataValue?.(data, uid);
        await writeBook(name, data);
    });
}

function createWorldBook(name) {
    const value = String(name ?? '').trim();
    if (!value) return Promise.reject(new Error('请输入名字'));
    if (typeof worldInfo.createNewWorldInfo !== 'function') return Promise.reject(new Error('当前酒馆版本不支持，请在原版界面操作'));
    return enqueue(async () => {
        if ((worldInfo.world_names ?? []).some(n => n.toLowerCase() === value.toLowerCase())) throw new Error('已有同名世界书');
        const done = await worldInfo.createNewWorldInfo(value, { interactive: false });
        if (done === false || !(worldInfo.world_names ?? []).includes(value)) throw new Error('世界书没建成，名字不能包含 \\ / : * ? " < > |');
        return value;
    });
}

/** The app's own world info panel, showing this book. */
function openWorldBookPanel(name) {
    if (!openPanel('world-info')) return false;
    try { worldInfo.reloadEditor?.(name, true); } catch { /* the panel is open either way */ }
    return true;
}

// Chat completion preset: a few settings in plain words and the prompt manager's entries. Settings go through the
// app's own inputs (its handlers save them); "save to preset" writes the preset file as its update button does.
const PRESET_SETTINGS = {
    openai_max_tokens: 'openai_max_tokens',
    openai_max_context: 'openai_max_context',
    temp_openai: 'temp_openai',
    top_p_openai: 'top_p_openai',
    freq_pen_openai: 'freq_pen_openai',
    pres_pen_openai: 'pres_pen_openai',
};

const promptOwner = () => openai.promptManager?.activeCharacter ?? null;
const bound = value => value === '' || value === undefined ? null : Number(value);
const presetVersions = new Map();
function presetGuard() {
    const name = openai.oai_settings?.preset_settings_openai;
    return () => {
        if (name !== openai.oai_settings?.preset_settings_openai) throw new Error('预设换了，请重新看一下改动');
    };
}
function presetVersion() {
    const name = openai.oai_settings?.preset_settings_openai ?? '';
    if (!presetVersions.has(name)) presetVersions.set(name, { editRev: 0, savedRev: 0 });
    return presetVersions.get(name);
}

function presetState() {
    const settings = openai.oai_settings;
    const pm = openai.promptManager;
    if (st.main_api !== 'openai' || !settings || !pm) return null;
    const samplers = {};
    for (const [key, id] of Object.entries(PRESET_SETTINGS)) {
        const input = document.getElementById(id);
        samplers[key] = { value: Number(settings[key]), min: bound(input?.min), max: bound(input?.max), step: Number(input?.step) || null };
    }
    const prompts = pm.getPromptOrderForCharacter(promptOwner()).map(item => {
        const prompt = pm.getPromptById(item.identifier);
        if (!prompt) return null;
        return {
            identifier: prompt.identifier, name: String(prompt.name ?? prompt.identifier), role: prompt.role ?? 'system', marker: !!prompt.marker,
            enabled: !!item.enabled, canToggle: !!pm.isPromptToggleAllowed(prompt), canEdit: !!pm.isPromptEditAllowed(prompt) && !prompt.marker,
        };
    }).filter(Boolean);
    return { name: String(settings.preset_settings_openai ?? ''), samplers, stream: !!settings.stream_openai, prompts, ...presetVersion() };
}

function setPresetValue(key, value) {
    const checkPreset = presetGuard();
    return enqueue(async () => {
        checkPreset();
        if (key === 'stream_openai') {
            $('#stream_toggle').prop('checked', !!value).trigger('change');
            presetVersion().editRev++;
            return presetState();
        }
        const id = PRESET_SETTINGS[key];
        if (!id || !Number.isFinite(Number(value))) throw new Error('这个值不对');
        $(`#${id}`).val(value).trigger('input');
        presetVersion().editRev++;
        return presetState();
    });
}

function setPromptEnabled(identifier, enabled) {
    const checkPreset = presetGuard();
    return enqueue(async () => {
        checkPreset();
        const pm = openai.promptManager;
        const entry = pm?.getPromptOrderEntry(promptOwner(), identifier);
        if (!entry) throw new Error('找不到这个提示词条目，请刷新页面');
        entry.enabled = !!enabled;
        presetVersion().editRev++;
        pm.render?.();
        await pm.saveServiceSettings?.();
        return presetState();
    });
}

function presetPrompt(identifier) {
    const prompt = openai.promptManager?.getPromptById(identifier);
    return prompt ? { identifier, name: String(prompt.name ?? ''), role: prompt.role ?? 'system', content: String(prompt.content ?? '') } : null;
}

function savePresetPrompt(identifier, { content }) {
    const checkPreset = presetGuard();
    return enqueue(async () => {
        checkPreset();
        const pm = openai.promptManager;
        const prompt = pm?.getPromptById(identifier);
        if (!prompt || !pm.isPromptEditAllowed(prompt) || prompt.marker) throw new Error('这一条不能在这里改');
        pm.updatePromptByIdentifier(identifier, { content: String(content ?? '') });
        presetVersion().editRev++;
        pm.render?.();
        await pm.saveServiceSettings?.();
        return presetPrompt(identifier);
    });
}

/** Writes the current settings into the selected preset file (the app's "update preset" button). */
function savePreset() {
    const checkPreset = presetGuard();
    return enqueue(async () => {
        checkPreset();
        const settings = openai.oai_settings;
        const name = settings?.preset_settings_openai;
        if (!name || typeof openai.getChatCompletionPreset !== 'function') throw new Error('当前酒馆版本不支持，请在原版界面操作');
        // Deep capture before awaiting HTTP: later edits must not leak into the saved in-memory copy.
        const preset = structuredClone(openai.getChatCompletionPreset(settings));
        const version = presetVersion(), capturedRev = version.editRev;
        const response = await fetch('/api/presets/save', { method: 'POST', headers: st.getRequestHeaders(), body: JSON.stringify({ apiId: 'openai', name, preset }) });
        if (!response.ok) throw new Error('预设没存上');
        const index = openai.openai_setting_names?.[name];
        if (index !== undefined && openai.openai_settings?.[index]) Object.assign(openai.openai_settings[index], preset);
        version.savedRev = capturedRev;
        return name;
    });
}

function snapshot(limit) {
    const chat = ctx().chat ?? [];
    const start = Math.max(0, chat.length - limit);
    const messages = [];
    for (let i = start; i < chat.length; i++) {
        const m = chat[i];
        messages.push({
            index: i,
            name: m.name,
            is_user: !!m.is_user,
            is_system: !!m.is_system,
            mes: m.mes,
            html: rendered(i, m),
            swipes: Array.isArray(m.swipes) ? m.swipes.length : 0,
            swipe_id: m.swipe_id ?? 0,
            panels: panelsCopy(i),
            hidden: !!m.is_system,
            type: m.extra?.type ?? null,
            reasoning: reasoningOf(i, m),
            meta: messageMeta(i, m),
        });
    }
    return { total: chat.length, messages, display: displaySettings(), storyline: storylineState() };
}

function attach() {
    const c = ctx();
    const types = c.eventTypes;
    if (types.WORLDINFO_UPDATED) c.eventSource.on(types.WORLDINFO_UPDATED, name => emit('world-editor-changed', { name }));
    const presetEvent = types.OAI_PRESET_CHANGED_AFTER || types.PRESET_CHANGED;
    if (presetEvent) c.eventSource.on(presetEvent, () => {
        presetVersions.delete(openai.oai_settings?.preset_settings_openai ?? '');
        emit('preset-changed', presetState());
    });
    const refresh = () => {
        if (settleTimer) settle();
        emit('chat');
    };
    for (const key of ['MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_DELETED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED',
        'CHAT_CHANGED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MORE_MESSAGES_LOADED']) {
        if (types[key]) c.eventSource.on(types[key], refresh);
    }
    if (types.CHAT_CHANGED) {
        c.eventSource.on(types.CHAT_CHANGED, () => {
            formatCache.clear();
            cardSources.clear();
            cardFrames.clear();
            reasoningCache.clear();
            for (const frame of parked.keys()) if (!frame.isConnected) parked.delete(frame);
        });
    }
    watchPanels();
    watchInputs();
    watchFloats();
    watchFocus();
    // Until the first words arrive the shell is refreshed every second: the app adds or clears the reply when the
    // server answers, which (with servers that answer at once to keep the connection busy) comes before any words.
    let firstWordsTimer;
    const stopFirstWords = () => { clearInterval(firstWordsTimer); firstWordsTimer = undefined; };
    c.eventSource.on(types.STREAM_TOKEN_RECEIVED, () => { stopFirstWords(); emit('chat'); });
    if (types.PERSONA_CHANGED) c.eventSource.on(types.PERSONA_CHANGED, () => emit('persona'));
    c.eventSource.on(types.GENERATION_STARTED, (type, _options, dryRun) => {
        if (dryRun || type === 'quiet') return;
        clearTimeout(settleTimer);
        settleTimer = undefined;
        nativeGenerating = true;
        report();
        stopFirstWords();
        firstWordsTimer = setInterval(() => { if (nativeGenerating) emit('chat'); else stopFirstWords(); }, 1000);
    });
    for (const key of ['GENERATION_ENDED', 'GENERATION_STOPPED']) {
        c.eventSource.on(types[key], () => {
            stopFirstWords();
            settle();
            emit('chat');
        });
    }

    const toastr = window.toastr;
    if (toastr) {
        for (const level of ['error', 'warning', 'info', 'success']) {
            const original = toastr[level].bind(toastr);
            const always = level === 'error' || level === 'warning';
            toastr[level] = (message, title, ...rest) => {
                if (always || Date.now() < tapAnswerUntil) {
                    emit('toast', { level: always ? level : 'info', text: [title, message].filter(Boolean).map(x => String(x).replace(/<[^>]*>/g, '')).join('：') });
                }
                return original(message, title, ...rest);
            };
        }
    }

    // Fallback for generations that fail before the app announces their end.
    let idleSince = 0;
    setInterval(() => {
        if (!nativeGenerating || settleTimer || document.body.dataset.generating) {
            idleSince = 0;
            return;
        }
        idleSince ||= Date.now();
        if (Date.now() - idleSince > 2000) settle();
    }, 500);
}

function settle() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
        settleTimer = undefined;
        nativeGenerating = false;
        report();
        emit('chat');
    }, SETTLE_MS);
}

function version() {
    return String(st.displayVersion ?? '').replace(/^SillyTavern\s*/, '') || 'unknown';
}

// Enhanced episode operations have a separate durable journal, but share the ordinary bridge queue above.
const bridgeDocument = document;
const episodeJournal = createEpisodeJournal();
// Ended 番外 records are history only, and older versions kept whole stories in them: clear them once the page has
// settled, away from the startup work. Unfinished ones are settled when the 番外 sheet opens (settleEpisodes).
setTimeout(() => episodeJournal.pruneSettled(10 * 60 * 1000).catch(() => {}), 30000);
const episodeSettingKey = `tavern-lite:episodes-enabled:${JSON.stringify(nativeAccount)}`;
const episodeFailureKey = `tavern-lite:episodes-unverified:${JSON.stringify(nativeAccount)}`;
let episodeIsolationFailed = false;
let episodeNativeUnverified = false;
try { episodeIsolationFailed = localStorage.getItem(episodeFailureKey) === 'true'; } catch {}
// Other extensions are read once per page, as loaded with it (bridge-extension-scan.js). One switched off counts as off
// only if it was already off when this page loaded: switching off takes effect after a reload.
const disabledAtLoad = new Set(extensions.extension_settings?.disabledExtensions ?? []);
const otherExtensions = (extensions.extensionNames ?? []).filter(name => name.startsWith('third-party/') && name !== `third-party/${OWN_FOLDER}`);
let extensionRecords = null;
scanExtensions(otherExtensions, {
    origin: location.origin,
    fetchText: async url => {
        const response = await fetch(url, { credentials: 'same-origin' });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
    },
}).catch(() => otherExtensions.map(name => ({ name, label: name.replace(/^third-party\//, ''), writes: true, unreadable: true })))
    .then(list => { extensionRecords = list; emit('episodes-changed'); });
function recordWriters() {
    const disabledNow = new Set(extensions.extension_settings?.disabledExtensions ?? []);
    return (extensionRecords ?? []).filter(e => e.writes && !(disabledAtLoad.has(e.name) && disabledNow.has(e.name)))
        .map(({ name, label, unreadable }) => ({ name, label, unreadable: !!unreadable }));
}
function episodeStatus(targetFile) {
    let enabled = true;
    try { enabled = localStorage.getItem(episodeSettingKey) !== 'false'; } catch { /* The journal reports storage failures before writes. */ }
    const reasons = [];
    const nativePolicy = evaluateNativeEpisodePolicy({ extensionSettings: ctx().extensionSettings, modules: extensions.modules,
        quickReplyApi: window.quickReplyApi, currentAvatar: targetFile?.locator?.avatar ?? currentChat()?.avatar,
        currentMetadata: targetFile?.header?.chat_metadata ?? ctx().chatMetadata });
    if (!nativePolicy.verified && (!targetFile || sameLocator({ account: nativeAccount, ...currentChat() }, targetFile.locator))) episodeNativeUnverified = true;
    reasons.push(...nativePolicy.reasons);
    if (episodeNativeUnverified && nativePolicy.verified) reasons.push('刚才开着的自动功能关掉后，要刷新页面才算数');
    if (episodeIsolationFailed) reasons.push('之前写番外时正文被改动过：先分别看看两个故事，再把「分开写番外与平行线」关掉重新打开');
    const settle = window.TavernLiteNativeSettle;
    if (settle?.document !== bridgeDocument || settle?.manager !== openai.promptManager || settle?.earlyVerified !== true || !settle?.observer?.snapshot?.().supported) reasons.push('轻酒馆没在打开故事前准备好，请刷新页面再试');
    // Extensions that write chats do not block: every separate write is followed by a check that the story it came
    // from is unchanged (bridge-episode-flow parentUnchanged), and a change is reported.
    const writers = recordWriters(), warnings = [];
    if (writers.length) warnings.push(`${writers.map(e => e.unreadable ? `${e.label}（没能读到它的代码）` : e.label).join('、')} 会改动聊天记录，分开写时可能把番外记进正文；写完会检查正文，有改动会告诉你`);
    const versionOk = supportedNativeVersion(version());
    if (!versionOk) reasons.push('这个酒馆版本太旧，分开写番外与平行线需要 1.16 或更新的版本');
    if (!nativeAccount || sessionFrozen) reasons.push('还没确认当前登录的账号，请刷新页面');
    // Copying a 番外 out of the open story (extractEpisode) opens nothing and sends nothing, so automations and other
    // extensions that react to switching or sending do not concern it; version and account do.
    const extractReasons = [];
    if (!versionOk) extractReasons.push('这个酒馆版本太旧，拆分番外需要 1.16 或更新的版本');
    if (!nativeAccount || sessionFrozen) extractReasons.push('还没确认当前登录的账号，请刷新页面');
    return { enabled, verified: reasons.length === 0, extractable: extractReasons.length === 0, extractReasons, recordWriters: writers, warnings, scanning: extensionRecords === null,
        configurationId: 'st-native-lite-v1', reasons,
        contextModes: ['continued', 'fresh'], continuedMetadataKeys: nativePolicy.continuedMetadataKeys, blockedMetadataKeys: nativePolicy.blockedMetadataKeys,
        recomputedMetadataKeys: nativePolicy.recomputedMetadataKeys, nativeObservations: nativePolicy.observations };
}
function setEpisodeEnabled(enabled) {
    localStorage.setItem(episodeSettingKey, String(!!enabled));
    // Switching it back on is the re-confirmation asked for after the story was found changed.
    if (enabled && episodeIsolationFailed) {
        episodeIsolationFailed = false;
        try { localStorage.removeItem(episodeFailureKey); } catch { /* the flag is in memory only then */ }
    }
    emit('episodes-changed'); return episodeStatus();
}
function episodeLease() {
    if (!queueOwner) throw episodeError('INVALID_LEASE', '番外操作必须经过现有聊天队列');
    return { account: nativeAccount, epoch: sessionEpoch, owner: queueOwner, document: bridgeDocument };
}
function assertEpisodeLease(lease) {
    if (sessionFrozen || !nativeAccount || lease?.account !== nativeAccount || lease.epoch !== sessionEpoch || lease.document !== bridgeDocument ||
        bridgeDocument.defaultView?.document !== bridgeDocument || !bridgeDocument.documentElement?.isConnected || window.frameElement && !window.frameElement.isConnected) {
        throw episodeError('ACCOUNT_CHANGED', '页面已刷新或换了账号，刚才的操作没生效');
    }
}
function assertEpisodeQueue(lease) {
    if (!lease?.owner || queueOwner !== lease.owner) throw episodeError('INVALID_LEASE', '原操作已离开聊天队列');
}
function episodeCurrentFull(template) {
    const locator = normalizeLocator({ account: nativeAccount, ...currentChat() });
    // Native saveChat's actual serializer uses these fields. Unknown disk header fields are not silently copied back.
    return { locator, header: { user_name: 'unused', character_name: 'unused', chat_metadata: cloneJson(ctx().chatMetadata ?? {}) }, messages: cloneJson(ctx().chat ?? []) };
}
async function episodeWaitStable() {
    const lease = episodeLease(), settle = window.TavernLiteNativeSettle;
    if (settle?.document !== bridgeDocument || settle?.manager !== openai.promptManager || settle?.earlyVerified !== true || typeof settle?.observer?.wait !== 'function') throw episodeError('NATIVE_BARRIER_UNVERIFIED', '还没准备好，暂时不能自动切换番外');
    await settle.observer.wait({ assertCurrent: () => { assertEpisodeQueue(lease); assertEpisodeLease(lease); } });
}
async function assertEpisodeSourceCurrent(operation, lease) {
    assertEpisodeQueue(lease); assertEpisodeLease(lease);
    await episodeWaitStable(); await verifyAccount();
    if (!sameLocator({ account: nativeAccount, ...currentChat() }, operation.source.locator)) throw episodeError('SOURCE_CHANGED', '原来的故事已切换，请重新确认');
    const current = episodeCurrentFull(operation.sourceSnapshot);
    // A split copies only messages from..to of the saved file: those must be saved as shown (other state may still
    // differ, as the full app adds fields when it opens a story and saves them later).
    if (operation.extractRange && operation.sourceSnapshot) {
        const { from, to } = operation.extractRange;
        const shown = list => JSON.stringify((list ?? []).map(m => [m?.name ?? null, !!m?.is_user, String(m?.mes ?? '')]));
        // A long story's journal record keeps only these messages (bridge-episode-flow journalCopy).
        const saved = operation.sourceSnapshot.rangeMessages ?? operation.sourceSnapshot.messages?.slice(from, to + 1);
        if (shown(current.messages.slice(from, to + 1)) !== shown(saved)) throw episodeError('SOURCE_UNCONFIRMED', '这段消息还有没保存的修改，请等它保存后再拆分');
        assertEpisodeLease(lease);
        return;
    }
    // Loading a legacy file assigns an in-memory integrity before any natural save. It is not persisted identity.
    if (operation.sourceSnapshot && !operation.sourceSnapshot.header.chat_metadata?.integrity) delete current.header.chat_metadata.integrity;
    const expected = operation.sourceFingerprint;
    if (!expected || (await fingerprintChat(current)).hash !== expected) throw episodeError('SOURCE_UNCONFIRMED', '这个故事还有没存好的内容，等它存好再创建或离开');
    assertEpisodeLease(lease);
}
// Requests whose answer the bridge checks itself go out exactly as made: the shell otherwise sends chat saves as only
// what changed and keeps them on the device when the network drops (src/chat-sync.js).
const exactRequest = init => ({ ...init, headers: { ...init?.headers, 'X-Tavern-Lite-Exact': '1' } });
const episodeNative = createEpisodeNative({ fetchImpl: (path, init) => fetch(path, exactRequest(init)), getRequestHeaders: () => st.getRequestHeaders(),
    assertLease: assertEpisodeLease, assertQueueOwner: assertEpisodeQueue, assertSourceCurrent: assertEpisodeSourceCurrent, journal: episodeJournal,
    onAccountChanged: freezeSession });
const episodeFlow = createEpisodeFlow({
    account: nativeAccount, journal: episodeJournal, native: episodeNative, enqueue, status: episodeStatus,
    makeLease: episodeLease, assertLease: assertEpisodeLease, assertSourceCurrent: assertEpisodeSourceCurrent,
    uuid: () => utils.uuidv4(), waitStable: episodeWaitStable, currentLocator: currentChat, currentFull: episodeCurrentFull,
    currentMetadata: () => ctx().chatMetadata, currentLength: () => ctx().chat.length, waitFor, verifyAccount, ensureConnected,
    onIsolationFailure: () => {
        episodeIsolationFailed = true;
        try { localStorage.setItem(episodeFailureKey, 'true'); } catch {}
        emit('episodes-changed');
    },
    updateCurrentEpisode: (metadata, locator) => {
        if (sameLocator({ account: nativeAccount, ...currentChat() }, locator)) st.updateChatMetadata({ [EPISODE_NAMESPACE]: cloneJson(metadata) }, false);
        emit('episodes-changed');
    },
    switchChat: async locator => {
        await waitIdle(); await verifyAccount(); await selectCharacter(locator.avatar);
        if (chatId(currentChat()?.file) !== locator.file) await ctx().openCharacterChat(locator.file);
        await verifyAccount();
    },
    submit: text => {
        assertWorldGenerationReady();
        setTextarea(text);
        assertWorldGenerationReady();
        return st.sendTextareaMessage();
    },
    // The open story saved by the app itself (what it does after every message).
    saveCurrent: async lease => {
        assertEpisodeQueue(lease); assertEpisodeLease(lease); await verifyAccount();
        await ctx().saveChat();
        assertEpisodeLease(lease);
    },
    saveExact: async (file, lease) => {
        assertEpisodeQueue(lease); assertEpisodeLease(lease); await verifyAccount();
        const response = await fetch('/api/chats/save', exactRequest({ method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: st.getRequestHeaders(), body: JSON.stringify({ avatar_url: file.locator.avatar, file_name: file.locator.file, chat: serializeChat(file), force: false }) }));
        assertEpisodeLease(lease); await verifyAccount();
        if (!response.ok || (await response.json()).ok !== true) throw episodeError('SAVE_UNCONFIRMED', '还没确认存好，再检查一次；不会重新生成');
    },
});

const worldEditor = createNativeWorldEditor({
    account: nativeAccount, worldInfo, st, powerUser, ctx, uuid: () => utils.uuidv4(),
    enqueue, makeLease: episodeLease, assertLease: assertEpisodeLease, assertQueueOwner: assertEpisodeQueue,
    verifyAccount, waitIdle,
});
const presetEditor = createNativePresetEditor({
    account: nativeAccount, st, openai, presetManager, ctx, enqueue, verifyAccount, assertSession: assertBridgeSession,
});

attach();

window.TavernLiteBridge = Object.freeze({
    apiVersion: API_VERSION,
    version,
    freezeSession,
    episodeStatus,
    setEpisodeEnabled,
    ...episodeFlow,
    // The reply being written while a 番外 send runs (the full app is on that line then); empty otherwise.
    episodeLiveText() {
        if (!episodeFlow.episodeNavigationBusy()) return '';
        const last = ctx().chat?.at(-1);
        return last && !last.is_user ? String(last.mes ?? '') : '';
    },
    capabilities: Object.freeze({
        send: typeof st.sendTextareaMessage === 'function',
        format: typeof st.messageFormatting === 'function',
        swipe: !!ctx().swipe?.left,
        newChat: typeof st.doNewChat === 'function',
        groups: typeof groupChats.openGroupById === 'function',
        branch: typeof bookmarks.branchChat === 'function',
        chapters: typeof st.renameGroupOrCharacterChat === 'function' && typeof st.deleteCharacterChatByName === 'function',
        editText: typeof st.messageEdit === 'function',
        deleteMessage: typeof st.deleteMessage === 'function',
        cards: true,
        reasoning: typeof st.messageFormatting === 'function',
        persona: typeof personas.setUserAvatar === 'function',
    }),
    on(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },
    isGenerating: () => bridgeBusy || nativeGenerating || queuedGenerations > 0,
    connected,
    send,
    stop,
    // `after`: 'user' (让角色回复) or 'char' (重新生成), the story state the request was made in.
    regenerate: ({ after } = {}) => optionAction('option_regenerate', {
        expect: after && (m => !!m && !m.is_system && !!m.is_user === (after === 'user')),
    }),
    continueReply: () => optionAction('option_continue'),
    swipe,
    openChat,
    openGroup,
    newChat,
    openPanel,
    showMessage,
    editMessage,
    editText,
    deleteMessageAt,
    refreshCharacter,
    branchFrom,
    renameChapter,
    deleteChapter,
    editCharacter,
    connection,
    swipeAllowed: () => !!ctx().swipe?.isAllowed?.(),
    currentChat,
    readingMessages: () => (ctx().chat ?? []).map(m => ({ name: m.name, is_user: !!m.is_user, is_system: !!m.is_system, mes: m.mes,
        hidden: hiddenStoryMessage(m) })),
    // The story for the shell's contents (toc-model.js): what Horae recorded per message comes along.
    tocMessages: () => (ctx().chat ?? []).map(m => ({ is_user: !!m.is_user, notice: !!(m.is_system && m.extra?.type), hidden: hiddenStoryMessage(m),
        mes: m.mes, horae_meta: m.horae_meta })),
    storyVariables: () => { const v = ctx().chatMetadata?.variables; return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).length : 0; },
    personalConversation: () => ({ scope: currentChat(), messages: (ctx().chat ?? []).map(m => ({ name: m.name, is_user: !!m.is_user,
        is_system: !!m.is_system, mes: String(m.mes ?? ''), swipe_id: m.swipe_id ?? 0,
        swipes: Array.isArray(m.swipes) ? m.swipes.map(String) : [] })) }),
    revealPersonalSource,
    isReplying: () => nativeGenerating,
    personaList,
    setPersona,
    modelChoices,
    storylineState,
    storylineAction,
    connectionConfigured,
    modelOptions,
    setupConnection,
    saveSetupProfile,
    putBackProfile,
    chooseModel,
    setCustomModel,
    testReply,
    renamePersona,
    editPersona,
    createPersona,
    deletePersona,
    setPersonaImage,
    renameCharacter: renameCharacterTo,
    worldBooks,
    deleteWorldBook,
    worldBookUsage,
    setWorldBookGlobal,
    setWorldBookCharacter,
    ...worldEditor,
    ...presetEditor,
    worldBook,
    saveWorldEntry,
    addWorldEntry,
    deleteWorldEntry,
    splitJoinedKeys,
    createWorldBook,
    openWorldBookPanel,
    presetState,
    setPresetValue,
    setPromptEnabled,
    presetPrompt,
    savePresetPrompt,
    savePreset,
    selectProfile,
    selectPreset,
    deleteProfile,
    deletePreset,
    deleteCharacter: removeCharacter,
    snapshot,
    displayRules,
    cardSource,
    setShellShowing,
    panelStyles,
    panelEvent,
    inputButtons,
    clickInputButton,
    extensionMenu,
    clickExtensionMenu,
    extensionPanelList,
    openExtensionPanel,
    messageButtons,
    clickMessageButton,
    floatingLayers,
    setOverlay,
    pointerAt,
    extensionSettings: () => ctx().extensionSettings,
    saveSettings: () => ctx().saveSettingsDebounced(),
});
window.dispatchEvent(new Event('tavern-lite-bridge'));
