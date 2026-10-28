import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import * as api from './api.js';
import * as engine from './engine.js';
import { Icon } from './icons.jsx';

// Routes live in the hash only: a query string would also reach the full app's page and break its send button.
export function parseHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.get('chat')) {
        return { name: 'chat', avatar: params.get('chat'), file: params.get('file') ?? '', fresh: params.get('new') === '1' };
    }
    if (params.get('work')) return { name: 'work', avatar: params.get('work') };
    if (params.has('edit')) return { name: 'edit', avatar: params.get('edit') || '' };
    if (params.has('create')) return { name: 'edit', avatar: '' };
    if (params.has('theme')) return { name: 'theme', id: params.get('theme') || '', base: params.get('base') || '' };
    if (params.has('me')) return { name: 'me' };
    if (params.has('setup')) return { name: 'setup', from: params.get('setup') || '' };
    if (params.has('worlds')) return { name: 'worlds' };
    if (params.has('world')) return { name: 'world', book: params.get('world') ?? '', entry: params.get('entry') ?? '' };
    if (params.has('preset')) return { name: 'preset' };
    return { name: 'library' };
}

export function routeHash(route) {
    if (route.name === 'chat') {
        return '#' + new URLSearchParams({ chat: route.avatar, file: route.file ?? '', ...(route.fresh ? { new: '1' } : {}) }).toString();
    }
    if (route.name === 'work') return '#' + new URLSearchParams({ work: route.avatar }).toString();
    if (route.name === 'me') return '#me';
    if (route.name === 'setup') return route.from ? `#setup=${route.from}` : '#setup';
    if (route.name === 'worlds') return '#worlds';
    if (route.name === 'world') return '#' + new URLSearchParams({ world: route.book ?? '', ...(route.entry ? { entry: route.entry } : {}) }).toString();
    if (route.name === 'preset') return '#preset';
    if (route.name === 'edit') return route.avatar ? '#' + new URLSearchParams({ edit: route.avatar }).toString() : '#create';
    if (route.name === 'theme') return '#' + new URLSearchParams({ theme: route.id ?? '', ...(route.base ? { base: route.base } : {}) }).toString();
    return '#';
}

// History entries the app pushed carry a mark, which survives a reload; "back" only steps back onto such an entry.
// Leaving from inside a sheet reuses the sheet's entry (see useBackLayer), so "back" then returns to the page.
export function go(route, replace = false) {
    const hash = routeHash(route);
    const { tlLayer, ...state } = history.state ?? {};
    if (replace) history.replaceState(state, '', hash);
    else if (tlLayer) history.replaceState({ tavernLite: true }, '', hash);
    else if (location.hash !== hash) history.pushState({ tavernLite: true }, '', hash);
    window.dispatchEvent(new Event('tl-route'));
}

// Open sheets and the full app's view each answer the phone's back gesture: while any is open, the page keeps one
// extra history entry (same address, marked tlLayer); "back" removes it and closes the topmost one instead of
// leaving the page. Closing them on screen removes the entry again.
const layers = [];
let layerTimer = 0;
let ownBacks = 0;
let leaving = 0;
let layerPop = false;

function syncLayers() {
    clearTimeout(layerTimer);
    layerTimer = setTimeout(() => {
        // A traversal is asynchronous. Never enqueue a second removal while the first is still pending.
        if (ownBacks || leaving) return;
        const marked = !!history.state?.tlLayer;
        if (layers.length && !marked) history.pushState({ ...history.state, tlLayer: true }, '');
        else if (!layers.length && marked && !leaving) {
            ownBacks++;
            history.back();
        }
    });
}

// Registered when the module loads, so it runs before the app's own route listener.
addEventListener('popstate', () => {
    if (leaving > 0) {
        leaving--;
        layerPop = false;
        return;
    }
    // Our own step back (removing a closed sheet's entry) never closes the sheet that may have opened since.
    const own = ownBacks > 0;
    if (own) ownBacks--;
    layerPop = own || layers.length > 0 || !!history.state?.tlLayer;
    if (!own && layers.length && !history.state?.tlLayer) layers[layers.length - 1].back();
    syncLayers();
});

/** Whether the latest "back" only closed a sheet (or removed a closed one's entry): the page itself stays. */
export function wasLayerPop() {
    return layerPop;
}

export function useBackLayer(active, onBack, panel = null) {
    const handler = useRef(onBack);
    handler.current = onBack;
    // Registered while the screen updates (not after paint), so a sheet that closes as another view opens hands its
    // history entry over instead of removing it.
    useLayoutEffect(() => {
        if (!active) return undefined;
        const layer = { back: () => handler.current(), panel, previous: document.activeElement, lastFocus: null };
        layers.push(layer);
        syncLayers();
        if (panel) queueMicrotask(() => {
            syncModalIsolation();
            if (layers.at(-1) === layer) focusLayer(layer, keyboardUser);
        });
        return () => {
            const wasTop = layers.at(-1) === layer;
            const index = layers.indexOf(layer);
            if (index >= 0) layers.splice(index, 1);
            syncLayers();
            if (panel) queueMicrotask(() => {
                syncModalIsolation();
                if (!wasTop) return;
                const top = layers.at(-1), modal = top?.panel?.current;
                // A replacement sheet may already own focus. A departing lower layer never steals it back.
                if (modal?.contains(document.activeElement)) return;
                if (canFocus(layer.previous) && (!modal || modal.contains(layer.previous))) layer.previous.focus({ preventScroll: true });
                else if (modal) focusLayer(top);
                else if (!top) {
                    const fallback = document.querySelector('.tl-composer-input, .tl-page-header .tl-back, .tl-app button:not(:disabled)');
                    if (canFocus(fallback)) fallback.focus({ preventScroll: true });
                }
            });
        };
    }, [active]);
}

/** Back to the page this one was opened from, or to `fallback` when it was opened directly (bookmark, reload of a link). */
export function goBack(fallback) {
    const state = history.state ?? {};
    // From inside a sheet (a confirmation that ends the page): step over the sheet's entry in one go.
    if (state.tlLayer && state.tavernLite) {
        leaving++;
        history.go(-2);
    } else if (!state.tlLayer && state.tavernLite) history.back();
    else go(fallback, true);
}

export function storage(action, fallback = null) {
    try { return action(localStorage); } catch { return fallback; }
}

export function chatStorageKey(kind, avatar, file) {
    return `tavern-lite:${kind}:${avatar}:${file || '__new__'}`;
}

export function useEngine() {
    const [state, setState] = useState(engine.engineState());
    const [generating, setGenerating] = useState(engine.isGenerating());
    const [phase, setPhase] = useState(engine.engineProgress().phase);
    const [mode, setMode] = useState(engine.engineMode());
    const [tick, setTick] = useState(0);
    const frame = useRef(0);
    useEffect(() => engine.onEngine((type, detail) => {
        if (type === 'state') setState(detail);
        else if (type === 'generating') setGenerating(detail);
        else if (type === 'phase') setPhase(detail);
        else if (type === 'mode') setMode(detail);
        else if (type === 'chat' && !frame.current) {
            frame.current = requestAnimationFrame(() => {
                frame.current = 0;
                setTick(t => t + 1);
            });
        }
    }), []);
    return { state, generating, phase, mode, tick };
}

export function Avatar({ file, name }) {
    return <img class="tl-avatar" src={api.avatarUrl(file)} alt={name} loading="lazy" decoding="async" />;
}

// Checks deep in the episode, preset and world book code name the full app's internals ("原生", "会话", "队列"…). A reader
// gets a plain sentence and a short code to quote instead; the original goes to the console for whoever debugs it.
const INTERNAL = /原生|会话|队列|锚点|回执|观察器|适配依赖|指纹|命名空间|首写|子线|消息数组|定位不完整|身份不完整|裁定|header/;
// The browser's own words for a dropped connection, and the shapes of a programming error: neither says anything to a reader.
const NETWORK = /^(TypeError: )?(Load failed|Failed to fetch|NetworkError when attempting to fetch resource\.?|The network connection was lost\.?|The Internet connection appears to be offline\.?|网络连接已中断。?)$/i;
const CODE_ERROR = /^(TypeError|ReferenceError|SyntaxError|RangeError)|is not a function|Cannot read propert|is not defined|undefined is not|null is not/;
const httpWords = code => code === 401 || code === 403 ? '登录失效了' : code === 404 ? '酒馆里没找到' : code === 413 ? '内容太大，酒馆没收下'
    : code === 429 ? '请求太频繁' : code >= 500 ? '酒馆那边出了错或网络不稳' : '酒馆没接受这次请求';
export function friendlyError(message) {
    if (typeof message !== 'string') return message;
    if (NETWORK.test(message.trim())) return '网络开小差了，没连上酒馆。网络好了再试一次';
    // A status code is the server's number, not a reason: say what it means where it stood.
    if (/HTTP \d{3}/.test(message)) message = message.replace(/^HTTP (\d{3})$/, (_, code) => `${httpWords(+code)}，稍后再试`)
        .replace(/返回 ?HTTP (\d{3})/g, (_, code) => httpWords(+code)).replace(/[（(]HTTP (\d{3})[)）]/g, (_, code) => `（${httpWords(+code)}）`)
        .replace(/HTTP (\d{3})/g, (_, code) => httpWords(+code));
    if (!INTERNAL.test(message) && !CODE_ERROR.test(message)) return message;
    let hash = 0;
    for (const ch of message) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    console.warn('[tavern-lite]', message);
    return `出了点问题，刷新页面后再试（代码 ${hash.toString(36).slice(-4).toUpperCase()}）`;
}

/** Top bar for secondary pages: back on the left, a title, and optional actions on the right. */
export function PageHeader({ title, onBack, children }) {
    return (
        <header class="tl-header tl-page-header">
            <button class="tl-ghost tl-back" onClick={onBack} aria-label="返回"><Icon name="back" /></button>
            <h1 class="tl-page-title">{title}</h1>
            <span class="tl-spacer" />
            {children}
        </header>
    );
}

/** Row of mutually exclusive choices (theme, line height…). */
export function Choices({ label, options, value, onChange }) {
    return (
        <div class="tl-choices" role="radiogroup" aria-label={label}>
            {Object.entries(options).map(([key, option]) => (
                <button class="tl-choice" role="radio" aria-checked={value === key ? 'true' : 'false'} onClick={() => onChange(key)}>
                    {option.swatch && <span class="tl-swatch" style={{ background: option.swatch }} aria-hidden="true" />}
                    <span>{option.label}</span>
                </button>
            ))}
        </div>
    );
}

export function relativeTime(value) {
    const time = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(time)) return '';
    const minutes = Math.round((Date.now() - time) / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.round(hours / 24);
    return days < 30 ? `${days} 天前` : new Date(time).toLocaleDateString();
}

/** One-line plain text for previews: markdown emphasis and HTML from the story would show as raw symbols. */
export function plainSnippet(text) {
    return String(text ?? '').replace(/<[^>]*>/g, '').replace(/[*_~`#>]+/g, '').replace(/\s+/g, ' ').trim();
}

// The app names a new chat "<character> - 2023-5-12 @21h 32m 29s 224ms". The date is not always when the story began
// (the bundled cards carry a fixed one), so such stories are numbered instead: 第 1 个故事 is the oldest. A branch
// ("换个走向") or a checkpoint is the story's name plus " - Branch #2" / " - Checkpoint #1"; it keeps its story's name.
const AUTO_NAME = /^(.*) - (\d{4})-(\d{1,2})-(\d{1,2}) ?@ ?(\d{1,2})h ?(\d{1,2})m(?: ?(\d{1,2})s)?(?: ?(\d{1,3})ms)?$/;
const OFFSHOOT = / - (Branch|Checkpoint) #(\d+)$/;

function autoNameTime(file, characterName) {
    const match = String(file ?? '').replace(/\.jsonl$/, '').match(AUTO_NAME);
    if (!match || (characterName && match[1] !== characterName)) return null;
    const [, , year, month, day, hour, minute, second = 0, ms = 0] = match;
    return new Date(year, month - 1, day, hour, minute, second, ms).getTime();
}

/** Story numbers for the automatically named stories among `chapters` (oldest first), by chat id. */
export function chapterNumbers(chapters, characterName) {
    const auto = (chapters ?? []).map(c => String(c.file_name ?? c).replace(/\.jsonl$/, ''))
        .map(file => ({ file, time: autoNameTime(file, characterName) }))
        .filter(x => x.time !== null)
        .sort((a, b) => a.time - b.time);
    return new Map(auto.map((x, i) => [x.file, i + 1]));
}

/**
 * A story's name: its own when renamed, else "第 N 个故事" (just "故事" while the number is not known yet); branches
 * and checkpoints follow their story: "第 1 个故事 · 走向 2", "第 1 个故事 · 存档点 1".
 */
export function chapterLabel(file, characterName, numbers) {
    const name = String(file ?? '').replace(/\.jsonl$/, '');
    const offshoot = name.match(OFFSHOOT);
    if (offshoot) {
        const story = chapterLabel(name.slice(0, offshoot.index), characterName, numbers);
        return `${story} · ${offshoot[1] === 'Branch' ? '走向' : '存档点'} ${offshoot[2]}`;
    }
    if (autoNameTime(name, characterName) !== null) {
        const n = numbers?.get(name);
        return n ? `第 ${n} 个故事` : '故事';
    }
    return name || '新故事';
}

/** Whether the story still has the name the app gave it (renaming then starts from an empty box). */
export const hasGivenName = (file, characterName) => chapterLabel(file, characterName) !== String(file ?? '').replace(/\.jsonl$/, '');

export function GroupCover({ group }) {
    const members = (group.members ?? []).slice(0, 4);
    return (
        <span class="tl-group-cover" data-count={members.length} aria-hidden="true">
            {members.map(avatar => <img src={api.avatarUrl(avatar)} alt="" loading="lazy" decoding="async" />)}
        </span>
    );
}

/** Bottom sheet: the one container for every secondary action, so menus look and behave the same everywhere. */
// Whether the user is working with the keyboard: sheets then put the focus on their first control (with its ring);
// opened by touch they focus the sheet itself, so no ring shows on a phone.
let keyboardUser = false;
addEventListener('keydown', event => { if (event.key === 'Tab' || event.key.startsWith('Arrow')) keyboardUser = true; }, true);
addEventListener('pointerdown', () => { keyboardUser = false; }, true);

const FOCUSABLE = 'button, [href], input, textarea, select, summary, [tabindex], [contenteditable="true"], audio[controls], video[controls]';
const isolated = new Map();
function canFocus(element) {
    return element?.isConnected && element !== document.body && element !== document.documentElement && typeof element.focus === 'function'
        && !element.matches(':disabled, input[type="hidden"]') && !element.closest('[inert], [hidden]')
        && element.getClientRects().length > 0 && !['hidden', 'collapse'].includes(getComputedStyle(element).visibility);
}
function focusItems(panel) {
    return [...panel.querySelectorAll(FOCUSABLE)].filter(element => element.tabIndex >= 0 && canFocus(element));
}
function focusLayer(layer, first = false) {
    const panel = layer?.panel?.current;
    if (!panel?.isConnected) return;
    const target = !first && canFocus(layer.lastFocus) ? layer.lastFocus : first ? focusItems(panel)[0] : panel;
    (target || panel).focus({ preventScroll: true });
}
function syncModalIsolation() {
    for (const [element, wasInert] of isolated) element.inert = wasInert;
    isolated.clear();
    const panel = layers.at(-1)?.panel?.current;
    if (!panel?.isConnected) return;
    // Isolate only shell siblings. The separate native engine iframe keeps running normally.
    for (let branch = panel; branch?.parentElement && branch !== document.getElementById('root'); branch = branch.parentElement) {
        if (branch.parentElement === document.body) break;
        for (const sibling of branch.parentElement.children) {
            if (sibling === branch || sibling.matches('.tl-toasts, script, style, link, iframe.engine')) continue;
            isolated.set(sibling, sibling.inert);
            sibling.inert = true;
        }
    }
}
document.addEventListener('focusin', event => {
    const top = layers.at(-1), panel = top?.panel?.current;
    if (!panel?.isConnected) return;
    if (panel.contains(event.target)) top.lastFocus = event.target;
    else focusLayer(top);
});
document.addEventListener('keydown', event => {
    const top = layers.at(-1), panel = top?.panel?.current;
    if (!panel?.isConnected) return;
    if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); top.back();
    } else if (event.key === 'Tab') {
        const items = focusItems(panel), first = items[0], last = items.at(-1), current = document.activeElement;
        if (!items.length) { event.preventDefault(); panel.focus(); }
        else if (!items.includes(current) || (event.shiftKey ? current === first : current === last)) {
            event.preventDefault(); (event.shiftKey ? last : first).focus();
        }
    }
}, true);

function useSheetViewport() {
    const read = () => ({ height: window.visualViewport?.height || innerHeight, top: window.visualViewport?.offsetTop || 0 });
    const [viewport, setViewport] = useState(read);
    useLayoutEffect(() => {
        const update = () => setViewport(read());
        const visual = window.visualViewport;
        addEventListener('resize', update); visual?.addEventListener('resize', update); visual?.addEventListener('scroll', update);
        update();
        return () => { removeEventListener('resize', update); visual?.removeEventListener('resize', update); visual?.removeEventListener('scroll', update); };
    }, []);
    return viewport;
}

export function Sheet({ title, onClose, children, className = '', bodyClassName = '', busy = false }) {
    const panel = useRef(null), viewport = useSheetViewport();
    useBackLayer(true, onClose, panel);
    const close = () => { if (layers.at(-1)?.panel === panel) onClose(); };
    return (
        <div class="tl-sheet-backdrop" data-compact={viewport.height < 440 ? 'true' : undefined}
            style={{ top: `${viewport.top}px`, bottom: 'auto', height: `${viewport.height}px`, '--tl-viewport-height': `${viewport.height}px` }}
            onClick={e => e.target === e.currentTarget && close()}>
            <section class={`tl-sheet ${className}`} style={{ maxHeight: 'var(--tl-sheet-max-height, min(82vh, calc(var(--tl-viewport-height) - 12px - env(safe-area-inset-top))))' }}
                role="dialog" aria-modal="true" aria-label={title} aria-busy={busy ? 'true' : undefined} ref={panel} tabIndex={-1}>
                <header class="tl-sheet-header">
                    <h2 class="tl-sheet-title">{title}</h2>
                    <button class="tl-button tl-sheet-close" disabled={busy} onClick={close} aria-label="关闭">✕</button>
                </header>
                <div class={`tl-sheet-body ${bodyClassName}`}>{children}</div>
            </section>
        </div>
    );
}

/** The turning ring on a button whose work is on its way (it breathes instead when motion is reduced). */
export const Spinner = () => <span class="tl-spinner" aria-hidden="true" />;

// Work that goes on after its sheet has closed (opening a view, a deferred action) shows a line at the top until it
// is done; work that finishes before the line would appear never shows one.
const PROGRESS_DELAY_MS = 300;
let progressItems = [];
const progressListeners = new Set();
const emitProgress = () => { for (const listener of progressListeners) listener(progressItems); };
export function trackProgress(text, work) {
    const item = { id: Math.random(), text };
    const timer = setTimeout(() => { progressItems = [...progressItems, item]; emitProgress(); }, PROGRESS_DELAY_MS);
    const done = () => {
        clearTimeout(timer);
        if (progressItems.includes(item)) { progressItems = progressItems.filter(x => x !== item); emitProgress(); }
    };
    Promise.resolve(work).then(done, done);
    return work;
}
export function useProgress() {
    const [items, setItems] = useState(progressItems);
    useEffect(() => { progressListeners.add(setItems); setItems(progressItems); return () => progressListeners.delete(setItems); }, []);
    return items;
}

/** `busy`: its work is on its way; the item then says so (`busyLabel`) and cannot be tapped again. */
export function SheetItem({ label, hint, onClick, disabled, danger, current, busy, busyLabel }) {
    return (
        <button class="tl-sheet-item" data-danger={danger ? 'true' : undefined} aria-current={current ? 'true' : undefined} disabled={disabled || busy}
            aria-busy={busy ? 'true' : undefined} onClick={onClick}>
            <span class="tl-sheet-item-label">{busy && <Spinner />}{busy && busyLabel ? busyLabel : label}</span>
            {hint && <span class="tl-sheet-item-hint">{hint}</span>}
        </button>
    );
}

/** A picture shown full screen (a character's full-size card art); a tap or "back" closes it. */
export function Lightbox({ src, alt, onClose }) {
    const [loaded, setLoaded] = useState(false);
    const panel = useRef(null);
    useBackLayer(true, onClose, panel);
    return (
        <div class="tl-lightbox" role="dialog" aria-modal="true" aria-label={alt} ref={panel} tabIndex={-1} onClick={onClose}>
            <button class="tl-button" style={{ position: 'absolute', top: '16px', right: '16px', zIndex: 1 }} aria-label="关闭原图" onClick={event => { event.stopPropagation(); onClose(); }}>✕</button>
            {!loaded && <span class="tl-muted">正在加载原图…</span>}
            <img src={src} alt={alt} data-loaded={loaded ? 'true' : undefined} onLoad={() => setLoaded(true)} />
        </div>
    );
}

/** Thin status line shown while the full app loads, so waiting is never silent. */
/**
 * In place of a sheet's content that needs the full app: the real wait (and that the content appears by itself), never
 * "马上就好" while a phone may need minutes. Asks the app to load if it is not.
 */
export function EngineWait({ when = '好了这里会自动出现' }) {
    const eng = useEngine();
    useEffect(() => { if (eng.state === 'idle') engine.requestEngine('action'); }, [eng.state]);
    if (eng.state === 'ready') return <p class="tl-muted tl-sheet-note" role="status"><Spinner />正在读取…</p>;
    return <EngineStatus eng={eng} meanwhile={when} />;
}

export function EngineStatus({ eng, meanwhile = '可以先看、先写' }) {
    const [, setNow] = useState(0);
    useEffect(() => {
        if (eng.state !== 'loading') return;
        const timer = setInterval(() => setNow(n => n + 1), 1000);
        return () => clearInterval(timer);
    }, [eng.state]);
    if (eng.state === 'failed') {
        return (
            <div class="tl-engine-status" data-state="failed" role="status">
                <span>{engine.engineFailure() || '没能准备好'}</span>
                <button class="tl-button" onClick={engine.startEngine}>重试</button>
            </div>
        );
    }
    if (eng.state === 'idle') {
        return (
            <div class="tl-engine-status" data-state="idle" role="status">
                <span>省流量：{eng.mode === 'input' ? '开始写的时候' : '需要的时候'}再准备</span>
                <button class="tl-button" onClick={() => engine.requestEngine('action')}>现在准备</button>
            </div>
        );
    }
    if (eng.state !== 'loading') return null;
    // What happens inside (downloading the app, its extensions…) is not the reader's business: how long, and that
    // reading and writing do not have to wait.
    const progress = engine.engineProgress();
    const { loadingMs, expectedMs } = progress;
    const ratio = expectedMs > 0 ? Math.min(0.95, loadingMs / expectedMs) : Math.min(0.9, loadingMs / 60000);
    return (
        <div class="tl-engine-status" data-state="loading" role="status">
            <span>{engine.loadingText(progress)} · {meanwhile}</span>
            <span class="tl-engine-progress" style={{ '--tl-progress': ratio }} />
        </div>
    );
}

/** Long press (touch or mouse) that cancels when the pointer moves, so scrolling never opens a menu. */
export function useLongPress(onLongPress, ms = 500) {
    const timer = useRef(0);
    const start = useRef(null);
    const fired = useRef(false);
    const cancel = () => { clearTimeout(timer.current); timer.current = 0; };
    return {
        onPointerDown: event => {
            if (event.button > 0) return;
            fired.current = false;
            start.current = { x: event.clientX, y: event.clientY };
            cancel();
            timer.current = setTimeout(() => { fired.current = true; onLongPress(); }, ms);
        },
        onPointerMove: event => {
            if (start.current && Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > 10) cancel();
        },
        onPointerUp: cancel,
        onPointerCancel: cancel,
        onContextMenu: event => { if (fired.current) event.preventDefault(); },
        onClickCapture: event => {
            if (fired.current) {
                event.preventDefault();
                event.stopPropagation();
                fired.current = false;
            }
        },
    };
}

/** Hands the user a file to save, e.g. a theme to share. */
export function downloadFile(name, text, type = 'application/json') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.append(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
    }
}

/** Asks before something that cannot be undone. The confirm button is the only red, explicit action. */
/**
 * While the work a confirm button started is on its way (`start` got a promise): the button says what is happening
 * (`busyLabel`) and the sheet stays open until it is done; closing it afterwards is the caller's.
 */
function useConfirmWork() {
    const [busy, setBusy] = useState(false);
    const lock = useRef(false);
    const start = work => {
        if (!work?.then) return;
        lock.current = true;
        setBusy(true);
        const release = () => { lock.current = false; setBusy(false); };
        work.then(release, release);
    };
    return { busy, lock, start };
}

const busyText = (busy, label, busyLabel) => busy ? <><Spinner />{busyLabel ?? '正在处理…'}</> : label;

export function ConfirmSheet({ title, message, confirmLabel, busyLabel, onConfirm, onClose, tone = 'danger' }) {
    const { busy, lock, start } = useConfirmWork();
    return (
        <Sheet title={title} busy={busy} onClose={() => { if (!lock.current) onClose(); }}>
            <div class="tl-settings-group">
                <p class="tl-confirm-message">{message}</p>
                <div class="tl-row">
                    <button class={`tl-button ${tone === 'danger' ? 'tl-danger' : 'tl-primary'}`} disabled={busy} aria-busy={busy ? 'true' : undefined}
                        onClick={() => { if (!lock.current) start(onConfirm()); }}>{busyText(busy, confirmLabel, busyLabel)}</button>
                    <button class="tl-button" disabled={busy} onClick={onClose}>取消</button>
                </div>
            </div>
        </Sheet>
    );
}

/** Asks for one line of text, e.g. a new chapter name. `validate` returns an error message or ''. */
export function PromptSheet({ title, label, initial, placeholder, confirmLabel, busyLabel, validate, onConfirm, onClose }) {
    const [value, setValue] = useState(initial ?? '');
    const { busy, lock, start } = useConfirmWork();
    const error = validate?.(value) ?? '';
    const submit = event => {
        event.preventDefault();
        if (!error && !lock.current) start(onConfirm(value.trim()));
    };
    return (
        <Sheet title={title} busy={busy} onClose={() => { if (!lock.current) onClose(); }}>
            <form class="tl-settings-group" onSubmit={submit}>
                <label class="tl-settings-label" for="tl-prompt-input">{label}</label>
                <input id="tl-prompt-input" class="tl-input" value={value} maxLength={100} autoComplete="off" placeholder={placeholder}
                    readOnly={busy} onInput={e => setValue(e.currentTarget.value)} />
                {error && value && <p class="tl-error">{error}</p>}
                <div class="tl-row">
                    <button class="tl-button tl-primary" disabled={!!error || busy} aria-busy={busy ? 'true' : undefined}>{busyText(busy, confirmLabel, busyLabel)}</button>
                    <button class="tl-button" type="button" disabled={busy} onClick={onClose}>取消</button>
                </div>
            </form>
        </Sheet>
    );
}
