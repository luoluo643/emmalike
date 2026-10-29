import { Fragment } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as api from './api.js';
import * as engine from './engine.js';
import { mountCards, mirrorPanels } from './cards.js';
import { ChapterActions, ChaptersSheet, useChapters } from './chapters.jsx';
import { Icon } from './icons.jsx';
import { previewHtml } from './render.js';
import { ConfirmSheet, EngineStatus, Sheet, SheetItem, Spinner, chapterLabel, copyText, go, relativeTime, routeHash, useLongPress, friendlyError } from './ui.jsx';
import { PersonaSheet } from './persona.jsx';
import { modelSummary, currentPresetName, PresetPickSheet } from './model.jsx';
import { hiddenInputButtons, setInputButtonHidden } from './input-buttons.js';
import { storyKey, readStory, writeStory, messageMark } from './story-state.js';
import { readLooks, keepLooks } from './look-memory.js';
import { useReadingPosition } from './reading-position.js';
import { CaptureSheet, PersonalNotice, PersonalSheet } from './personal.jsx';
import { makeSource, mutation, saveRecord, locateSource, requestSourceJump, takeSourceJump } from './personal-records.js';
import { EpisodesSheet, episodeIdentity } from './episodes.jsx';
import { LineFormSheet, LineMemorySheet, StorylineSheet } from './storylines.jsx';
import { EPISODE_KINDS, detectEpisodeIntent } from './episode-intent.js';
import { lineDirective, lineName, requestKind } from './inline-episodes.js';
import { forksByIndex, storyBranches } from './branches.js';
import { MAIN_LINE, idsFromMarks, lineView } from './line-view.js';
import { ownIds, readRegistry } from './own-lines.js';
import { TocSheet } from './toc.jsx';

const PAGE = 40;

/**
 * What Horae has to be told so the next message goes on `line` (Horae's storyline state from the bridge), or null when
 * it goes there already.
 */
function lineSwitch(state, line) {
    if (!line || !state?.multi) return null;
    const writing = state.pending || state.active;
    if (line === writing) return null;
    if (line === state.active) return 'clear-pending';
    return line === MAIN_LINE ? 'to-main' : 'to-line';
}

/** Under a line's message where another of the story's lines (Horae) leaves it: one tap reads that line. */
function LineMarks({ lines, onOpen }) {
    return <div class="tl-branch-marks">{lines.map(line => (
        <button key={line.id} class="tl-branch-mark" data-line={line.id} onClick={() => onOpen(line.id)}>
            <Icon name="branch" size={15} />
            <span class="tl-branch-mark-text">
                <span>从这里分出：{line.label}</span>
                <span class="tl-branch-mark-hint">{line.count ? `${line.count} 条 · ` : ''}点开去看</span>
            </span>
        </button>))}
    </div>;
}

/**
 * Where a line kept by the shell starts, from a message on: a new line, back to the 正文, an existing line, or no
 * longer a start (following the message before).
 */
function MessageLineSheet({ index, lines, busy, waiting, onNew, onPick, onMark, onClose }) {
    const on = lines.enabled ? lines.lineOf(index) : MAIN_LINE;
    const starts = lines.enabled && index > 0 && on !== lines.lineOf(index - 1);
    const others = lines.enabled ? lines.lines.filter(line => line.id !== MAIN_LINE && line.id !== on) : [];
    return <Sheet title="分线" busy={!!busy && !waiting} onClose={onClose}>
        <p class="tl-muted tl-sheet-note">从这条起，后面的都跟着它，直到下一个分线的地方。{on && on !== MAIN_LINE ? `现在在「${lines.label(on)}」` : ''}</p>
        <SheetItem label="从这里开一条番外…" hint="小剧场、平行线也在这里" disabled={!!busy} onClick={onNew} />
        {on && on !== MAIN_LINE && <SheetItem label="从这里回正文" busy={busy === 'line-main'} busyLabel="正在分…" disabled={!!busy}
            onClick={() => onMark('line-main', { action: 'mark', line: MAIN_LINE }, '从这条起回到正文')} />}
        {others.length > 0 && <SheetItem label="划进已有的线…" disabled={!!busy} onClick={onPick} />}
        {starts && <SheetItem label="这里不分线" hint="跟着上一条" busy={busy === 'line-unmark'} busyLabel="正在改…" disabled={!!busy}
            onClick={() => onMark('line-unmark', { action: 'unmark' }, '这条起跟着上一条了')} />}
    </Sheet>;
}

/** Under the 正文 message a 番外/平行线 left at: one tap opens that line, the 正文 is not touched. */
function BranchMarks({ lines, onOpen }) {
    return <div class="tl-branch-marks">{lines.map(line => (
        <button key={line.file} class="tl-branch-mark" onClick={() => onOpen(line.file)}>
            <Icon name="branch" size={15} />
            <span class="tl-branch-mark-text">
                <span>{line.extracted ? `第 ${line.extracted.from}～${line.extracted.to} 楼拆成了` : line.contextMode === 'fresh' ? '在这里新开（没带正文）' : '从这里分出'}：{EPISODE_KINDS[line.kind] || '番外'} · {line.title}</span>
                <span class="tl-branch-mark-hint">{[line.items ? `${line.items} 楼` : '', line.lastAt ? `${relativeTime(line.lastAt)}写过` : '', '点开去看'].filter(Boolean).join(' · ')}</span>
            </span>
        </button>))}
    </div>;
}
const EDGE_PX = 24;
const SWIPE_PX = 70;

/** Edits one message's text in place; the full app saves it the same way as its own editor. */
function EditMessageSheet({ message, onSave, onClose }) {
    const [text, setText] = useState(message.mes ?? '');
    const [busy, setBusy] = useState(false);
    const area = useRef(null);
    useEffect(() => {
        const el = area.current;
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }, []);
    const unchanged = text === (message.mes ?? '');
    // `onSave` gives the saving's promise; the sheet stays open, saying so, until it is done.
    const save = () => {
        const work = busy ? null : onSave(text);
        if (!work?.then) return;
        setBusy(true);
        work.finally(() => setBusy(false));
    };
    return (
        <Sheet title={message.is_user ? '编辑我说的话' : '编辑这段内容'} busy={busy} onClose={() => { if (!busy) onClose(); }}>
            <div class="tl-settings-group">
                <textarea ref={area} class="tl-input tl-edit-textarea" value={text} aria-label="消息内容" spellcheck={false} readOnly={busy}
                    onInput={e => setText(e.currentTarget.value)} />
                {message.swipes > 1 && <p class="tl-muted tl-choice-hint">只改当前这个回复</p>}
                <div class="tl-row">
                    <button class="tl-button tl-primary" disabled={unchanged || !text.trim() || busy} aria-busy={busy ? 'true' : undefined} onClick={save}>
                        {busy ? <><Spinner />正在保存…</> : '保存'}</button>
                    <button class="tl-button" disabled={busy} onClick={onClose}>取消</button>
                </div>
            </div>
        </Sheet>
    );
}

/** The export sheet is loaded when first used: drawing long pictures is not needed for reading. */
function ExportLoader(props) {
    const [Loaded, setLoaded] = useState(null);
    useEffect(() => {
        import('./export.jsx').then(m => setLoaded(() => m.ExportSheet)).catch(() => props.notify('导出没加载出来，检查网络后再试'));
    }, []);
    return Loaded ? <Loaded {...props} /> : (
        <Sheet title="导出" onClose={props.onClose}>
            <p class="tl-muted tl-sheet-note">正在准备…</p>
        </Sheet>
    );
}

/** The message as selectable text: a long press on a message opens its menu, so picking out a passage happens here. */
function SelectTextSheet({ message, html, onClose }) {
    return (
        <Sheet title="选择文字" onClose={onClose}>
            <p class="tl-muted tl-sheet-note">按住文字拖动选择，再用系统菜单复制。</p>
            <div class="tl-select-text tl-message-body" dangerouslySetInnerHTML={{ __html: html }} />
        </Sheet>
    );
}

// Mostly-Chinese text may break inside Latin words: justified lines otherwise stretch the characters apart in
// front of a long word that does not fit.
const CJK = /[㐀-鿿豈-﫿　-〿＀-￯]/g;
function markCjk(body) {
    const text = body.textContent ?? '';
    const cjk = text.match(CJK)?.length ?? 0;
    const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
    if (cjk > latin) body.dataset.cjk = 'true';
    else delete body.dataset.cjk;
}

/** The model's reasoning above a reply, folded like in the full app; while it is thinking, a running clock. */
function Reasoning({ reasoning, open }) {
    const thinking = reasoning.state === 'thinking';
    const [, tick] = useState(0);
    const started = useRef(Date.now());
    useEffect(() => {
        if (!thinking) return undefined;
        started.current = Date.now();
        const timer = setInterval(() => tick(n => n + 1), 1000);
        return () => clearInterval(timer);
    }, [thinking]);
    const seconds = thinking
        ? Math.round((Date.now() - started.current) / 1000)
        : reasoning.durationMs ? Math.max(1, Math.round(reasoning.durationMs / 1000)) : null;
    const label = thinking ? `正在思考…${seconds ? ` ${seconds} 秒` : ''}`
        : reasoning.state === 'hidden' ? (seconds ? `思考了 ${seconds} 秒（未公开）` : '思考过程未公开')
            : seconds ? `思考了 ${seconds} 秒` : '思考过程';
    return (
        <details class="tl-reasoning" data-state={reasoning.state} open={open || undefined}>
            <summary>{label}</summary>
            {reasoning.html && <div class="tl-reasoning-body" dangerouslySetInnerHTML={{ __html: reasoning.html }} />}
        </details>
    );
}

/** The rest of the full app's buttons on a message (translate, read aloud, hide, extensions' own…), loaded on demand. */
function NativeMessageButtons({ index, disabled, onPick }) {
    const [buttons, setButtons] = useState(null);
    useEffect(() => {
        let alive = true;
        const bridge = engine.getBridge();
        if (!bridge?.messageButtons || index === undefined) {
            setButtons([]);
            return undefined;
        }
        bridge.messageButtons(index).then(list => alive && setButtons(list)).catch(() => alive && setButtons([]));
        return () => { alive = false; };
    }, [index]);
    if (disabled) return null;
    if (buttons === null) return <p class="tl-muted tl-sheet-section">正在读取原版界面里的按钮…</p>;
    if (!buttons.length) return null;
    return (
        <>
            <p class="tl-sheet-section">原版界面里的其他按钮</p>
            {buttons.map(button => <SheetItem key={button.key} label={button.label} onClick={() => onPick(button)} />)}
        </>
    );
}

/** One of the full app's quick buttons: a tap presses it, a long press offers to leave it out of the row. */
function QuickChip({ button, onPress, onHold }) {
    const hold = useLongPress(() => onHold(button));
    return <button class="tl-chip" title={button.title || undefined} {...hold} onClick={() => onPress(button)}>{button.label}</button>;
}

// Whether the quick row above the input is open on this device (closed by default: it takes reading space).
const QUICK_OPEN_KEY = 'tavern-lite:quick-row-open';
const readQuickOpen = () => { try { return localStorage.getItem(QUICK_OPEN_KEY) === '1'; } catch { return false; } };
const writeQuickOpen = open => { try { localStorage.setItem(QUICK_OPEN_KEY, open ? '1' : '0'); } catch { /* private mode */ } };

/** Extension panels under a message (Horae's status bar…), mirrored from the full app; see cards.js. */
function PanelMirror({ index, html }) {
    const slot = useRef(null);
    useLayoutEffect(() => { mirrorPanels(slot.current, index, html); }, [index, html]);
    return <div class="tl-panel-slot" ref={slot} />;
}

const NETWORK_FAILURE = /^(Load failed|Failed to fetch|NetworkError when attempting to fetch resource\.?|The network connection was lost\.?)$/;

/**
 * "正在写…" with the time waited since `since` (the generation's start). Some models (thinking ones, relays that hold
 * the reply) send their first words only after a minute or more, so a long quiet wait should not look like nothing is
 * coming.
 */
function Waiting({ since }) {
    const start = useRef(since || Date.now());
    const elapsed = () => Math.max(0, Math.floor((Date.now() - start.current) / 1000));
    const [seconds, setSeconds] = useState(elapsed);
    useEffect(() => {
        const timer = setInterval(() => setSeconds(elapsed()), 1000);
        return () => clearInterval(timer);
    }, []);
    return (
        <p class="tl-typing" role="status">正在写…
            {seconds >= 10 && <span class="tl-wait-time" aria-hidden="true"> 已等 {seconds} 秒</span>}
            {seconds >= 30 && <span class="tl-wait-note">有的模型要等一两分钟，先别急着停</span>}
        </p>
    );
}

function Message({ message, character, user, display, isLast, synced, generating, waitingSince, swiping, onMenu, onSwipe, onContinue, onReply, onRegenerate, onShowInNative }) {
    // Hidden messages (excluded from the prompt) keep their speaker; only the app's own notices are "system".
    const type = message.type ?? message.extra?.type;
    const role = message.is_user ? 'user' : message.is_system && type ? 'system' : 'char';
    const hidden = message.hidden ?? !!message.is_system;
    const meta = [
        display?.ids && `#${message.index}`,
        display?.timestamps && message.meta?.time,
        display?.timer && role === 'char' && message.meta?.timer,
        display?.tokens && message.meta?.tokens && `${message.meta.tokens} tokens`,
    ].filter(Boolean).join(' · ');
    const text = String(message.mes ?? '').trim();
    const blank = !text && !message.reasoning;
    // Until the first word arrives the full app holds the reply's place with "...".
    const waiting = isLast && generating && role === 'char' && !message.reasoning && (!text || text === '...');
    // A finished reply with no words: the model or relay sent back nothing (or it was stopped before the first word).
    const emptyReply = isLast && !generating && synced && role === 'char' && !hidden && blank;
    const html = message.html ?? previewHtml(message.mes, character.name, user.name);
    const body = useRef(null);
    useLayoutEffect(() => {
        if (!body.current) return;
        markCjk(body.current);
        mountCards(body.current);
    }, [html]);
    const press = useLongPress(() => onMenu(message));
    const gesture = useRef(null);
    const swipeable = isLast && role === 'char' && synced && !generating && engine.getBridge()?.capabilities.swipe && engine.getBridge()?.swipeAllowed();

    const onPointerDown = event => {
        press.onPointerDown(event);
        gesture.current = swipeable && event.clientX > EDGE_PX && event.clientX < innerWidth - EDGE_PX
            ? { x: event.clientX, y: event.clientY } : null;
    };
    const onPointerUp = event => {
        press.onPointerUp(event);
        const start = gesture.current;
        gesture.current = null;
        if (!start) return;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (Math.abs(dx) > SWIPE_PX && Math.abs(dy) < 40) onSwipe(dx < 0 ? 'right' : 'left');
    };

    const atLastSwipe = message.swipe_id >= message.swipes - 1;
    return (
        <article class="tl-message" data-role={role} data-index={message.index} data-swipeable={swipeable ? 'true' : undefined}
            data-hidden={hidden ? 'true' : undefined} {...press} onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
            <div class="tl-message-name" data-meta={meta ? 'true' : undefined}>
                <span>{message.name}</span>
                {hidden && <span class="tl-tag tl-hidden-mark" title="这条消息不会发给 AI">AI 看不到</span>}
                {meta && <span class="tl-message-meta">{meta}</span>}
                <button class="tl-message-menu" aria-label="消息操作" onClick={() => onMenu(message)}>⋯</button>
            </div>
            {message.reasoning && <Reasoning reasoning={message.reasoning} open={display?.reasoningOpen} />}
            {waiting
                ? <Waiting since={waitingSince} />
                : <div class="tl-message-body" ref={body} dangerouslySetInnerHTML={{ __html: html }}
                    onClick={event => event.target.closest('.tl-native-jump') && onShowInNative?.(message.index)} />}
            {emptyReply && <p class="tl-muted tl-empty-reply" role="status">这次没收到文字，点 ↻ 重新生成或「继续写」</p>}
            {message.panels && <PanelMirror index={message.index} html={message.panels} />}
            {isLast && role === 'char' && swiping && !waiting && <p class="tl-typing tl-swipe-status" role="status">正在换一个回复…</p>}
            {isLast && role === 'char' && synced && !generating && (
                <div class="tl-reply-tools">
                    {swipeable && (
                        <div class="tl-swipe" role="group" aria-label="换回复">
                            <button class="tl-swipe-button" aria-label="上一个回复" disabled={message.swipe_id <= 0} onClick={() => onSwipe('left')}><Icon name="left" size={18} /></button>
                            <span class="tl-swipe-count">{message.swipes > 1 ? `${message.swipe_id + 1}/${message.swipes}` : '换个回复'}</span>
                            <button class="tl-swipe-button" aria-label={atLastSwipe ? '生成新回复' : '下一个回复'} onClick={() => onSwipe('right')}><Icon name="right" size={18} /></button>
                        </div>
                    )}
                    {onRegenerate && !hidden && (
                        <button class="tl-swipe-button tl-regen-button" aria-label="重新生成本轮回复" title="重新生成本轮回复" onClick={onRegenerate}>
                            <Icon name="regen" size={18} /></button>
                    )}
                    <button class="tl-continue-writing" onClick={onContinue}><Icon name="pen" size={16} />继续写</button>
                </div>
            )}
            {isLast && role === 'user' && !hidden && synced && !generating && onReply && (
                <div class="tl-reply-tools">
                    <button class="tl-continue-writing" onClick={onReply}><Icon name="send" size={16} />让{character.name}回复</button>
                </div>
            )}
        </article>
    );
}

export function Reader({ route, user, eng, notify, withBridge, onNative, onTools, onModel, onReading, onEditInNative, onShowInNative, onOpenPanel, onPendingChange }) {
    const [character, setCharacter] = useState(null);
    const [preview, setPreview] = useState(null);
    const [looks, setLooks] = useState({ html: {}, rules: [] });
    // The chat file actually shown. The route may leave it empty ("latest chat"); resolving it never changes the
    // route, so the component keeps its draft and queued message while the full app opens the chat.
    const [chatFile, setChatFile] = useState(route.file);
    const [synced, setSynced] = useState(false);
    const [syncError, setSyncError] = useState('');
    const [limit, setLimit] = useState(PAGE);
    const [draft, setDraftValue] = useState('');
    const draftRevision = useRef(0), draftValue = useRef('');
    const setDraft = value => {
        const next = typeof value === 'function' ? value(draftValue.current) : value;
        if (next !== draftValue.current) draftRevision.current++;
        draftValue.current = next; setDraftValue(next);
    };
    const [episodeBusy, setEpisodeBusy] = useState(false);
    const [pending, setPending] = useState(null);
    const pendingRef = useRef(null);
    const sendJob = useRef(null);
    const alive = useRef(true);
    const [sendState, setSendState] = useState('pending');
    const [restored, setRestored] = useState(false);
    const [headerHidden, setHeaderHidden] = useState(false);
    const [sheet, setSheet] = useState(null);
    const [inputButtons, setInputButtons] = useState([]);
    const [selection, setSelection] = useState(null), [recent, setRecent] = useState(null), [undoBusy, setUndoBusy] = useState(false);
    const recentUndo = useRef(null);
    const list = useRef(null);
    // The stop button takes the send button's place the moment a reply is asked for; a quick second tap meant for the
    // reply button must not stop it.
    const generatingSince = useRef(0);
    if (!eng.generating) generatingSince.current = 0;
    else if (!generatingSince.current) generatingSince.current = Date.now();
    const stopReply = () => { if (Date.now() - generatingSince.current >= 700) run(b => b.stop()); };
    const nearBottom = useRef(true);
    const lastScrollTop = useRef(0);
    const sending = useRef(false);
    const keyFile = useRef(route.file);
    // Numbers for unnamed stories ("第 2 个故事"); read again when another story opens or a new one is saved.
    const { chapters: storyList, numbers, reload: reloadNumbers } = useChapters(route.avatar, character?.name);
    const numbersFor = useRef('');
    useEffect(() => {
        const id = api.chatId(chatFile);
        // Once per story, and once more after it is open (a new story's file is written then).
        const key = `${id}:${synced}`;
        if (!storyList || !id || numbers.has(id) || numbersFor.current === key) return;
        numbersFor.current = key;
        reloadNumbers();
    }, [chatFile, storyList, synced]);

    const scopedKey = (kind, file) => storyKey(kind, user.handle, route.avatar, file);
    const draftKey = scopedKey('draft', chatFile);
    const pendingKey = scopedKey('pending', chatFile);

    // Brings back what an earlier page session left for this chat file: its draft, plus a message that was still
    // queued when that page closed. The current session's queued message lives in state and is never read back here.
    const restoreFrom = file => {
        const stored = readStory(scopedKey('draft', file)) ?? '';
        const recovered = readStory(scopedKey('pending', file));
        const queued = typeof recovered === 'string' ? recovered : recovered?.text ?? '';
        writeStory(scopedKey('pending', file), null);
        if (queued) notify(recovered?.state === 'submitted' ? '上次发出的文字已放回输入框，先看看聊天里是不是已经发了' : '上次没发出的消息已放回输入框', 'info');
        setDraft(d => [queued, d || stored].filter(Boolean).join('\n'));
    };

    useEffect(() => {
        restoreFrom(route.file);
        setRestored(true);
    }, []);

    const resolveFile = file => {
        if (!file || file === keyFile.current) return;
        const from = keyFile.current;
        writeStory(scopedKey('draft', from), null);
        writeStory(scopedKey('pending', from), null);
        keyFile.current = file;
        restoreFrom(file);
        setChatFile(file);
    };

    useEffect(() => {
        let alive = true;
        api.getCharacter(route.avatar)
            .then(async c => {
                if (!alive) return;
                setCharacter(c);
                const file = route.fresh ? '' : route.file || api.chatId(c.chat);
                resolveFile(file);
                const [messages, kept] = await Promise.all([file ? api.getChat(c, file) : [], readLooks(user.handle, route.avatar, file)]);
                if (!alive) return;
                setLooks(kept);
                setPreview(messages.length ? messages : [{ name: c.name, is_user: false, mes: c.first_mes ?? '' }]);
            })
            .catch(e => notify(e.message))
            .finally(() => engine.requestEngine('open'));
        return () => { alive = false; };
    }, []);

    // A new story is created once the full app is ready; the address then points at the real chapter, so reloading
    // the page reopens it instead of starting yet another one. The route itself is kept to avoid remounting.
    const creating = useRef(route.fresh);
    useEffect(() => {
        const bridge = engine.getBridge();
        if (!bridge || synced || syncError) return;
        const open = creating.current
            ? bridge.openChat(route.avatar, null).then(() => bridge.newChat({ reuseEmpty: true })).then(current => {
                creating.current = false;
                if (current?.file) history.replaceState(null, '', routeHash({ name: 'chat', avatar: route.avatar, file: current.file }));
                return current;
            })
            : bridge.openChat(route.avatar, keyFile.current);
        open
            .then(current => {
                if (current?.file) resolveFile(current.file);
                setSynced(true);
            })
            .catch(e => setSyncError(friendlyError(e.message)));
    }, [eng.state, synced, syncError]);

    useEffect(() => { onPendingChange?.(!!pending || episodeBusy); }, [pending, episodeBusy]);
    useEffect(() => () => { alive.current = false; sendJob.current?.cancel?.(); onPendingChange?.(false); }, []);

    useEffect(() => {
        if (restored) writeStory(draftKey, draft || null);
    }, [draft, draftKey, restored]);

    useEffect(() => {
        if (restored) writeStory(pendingKey, pending || null);
    }, [pending, pendingKey, restored]);

    // The line a queued message goes to (when the story has lines): the one being read when it was written; or what
    // the message itself asks for when the shell keeps the lines (a new line, back to the 正文).
    const pendingLine = useRef(null), pendingStep = useRef(null), appliedStep = useRef(false);
    // A line asked for by the message itself waits for that message: when it is not sent after all, the line is not kept waiting.
    const undoStep = () => {
        if (!appliedStep.current) return;
        appliedStep.current = false;
        engine.getBridge()?.storylineAction?.('clear-pending', { scope: { avatar: route.avatar, file: chatFile } }).catch(() => {});
    };
    useEffect(() => {
        const bridge = engine.getBridge();
        if (!bridge || !synced || !pending || eng.generating || sending.current) return;
        sending.current = true;
        const switchTo = lineSwitch(bridge.storylineState?.(), pendingLine.current);
        const asked = pendingStep.current;
        const step = asked ?? (switchTo ? { action: switchTo, line: pendingLine.current } : null);
        pendingStep.current = null;
        if (!step) { sendNow(bridge); return; }
        // The next message goes on the line it is told to (by Horae, or the shell's own record); told first, through the same queue.
        bridge.storylineAction(step.action, { ...step, scope: { avatar: route.avatar, file: chatFile } })
            .then(() => {
                appliedStep.current = !!asked;
                if (alive.current && pendingRef.current === pending) sendNow(bridge);
                else { sending.current = false; undoStep(); }
            }, e => {
                sending.current = false;
                if (!alive.current || pendingRef.current !== pending) return;
                notify(`没切到这条线，没有发出：${e.message}`);
                setDraft(d => d ? `${pending}\n${d}` : pending);
                pendingRef.current = null;
                setPending(null);
            });
    }, [synced, pending, eng.generating]);
    const sendNow = bridge => {
        const job = bridge.send(pending, { scope: { avatar: route.avatar, file: chatFile }, onState: state => {
            if (state === 'submitted') { writeStory(pendingKey, { text: pending, state }); appliedStep.current = false; }
            if (state === 'accepted') writeStory(pendingKey, null);
            if (alive.current) setSendState(state);
        } });
        sendJob.current = job;
        job.then(() => { if (alive.current && pendingRef.current === pending) { pendingRef.current = null; setPending(null); } })
            .catch(e => {
                if (!alive.current || e.code === 'cancelled') return;
                undoStep();
                notify(e.message);
                if (e.code === 'no-connection') go({ name: 'setup', from: 'story' });
                setDraft(d => d ? `${pending}\n${d}` : pending);
                pendingRef.current = null;
                setPending(null);
            })
            .finally(() => { if (sendJob.current === job) { sending.current = false; sendJob.current = null; } });
    };

    // Buttons the full app shows above its input (Quick Replies, Tavern Helper script buttons).
    useEffect(() => {
        const read = () => setInputButtons(engine.getBridge()?.inputButtons?.() ?? []);
        read();
        return engine.onEngine(type => { if (type === 'inputs' || type === 'state') read(); });
    }, [synced]);
    const pressInputButton = button => {
        if (!engine.getBridge()?.clickInputButton(button.key)) notify('这个按钮刚刚变了，请再点一次', 'info');
    };
    const [quickOpen, setQuickOpenValue] = useState(readQuickOpen);
    const setQuickOpen = open => { setQuickOpenValue(open); writeQuickOpen(open); };
    const [hiddenButtons, setHiddenButtons] = useState(() => hiddenInputButtons(engine.getBridge()));
    useEffect(() => { if (synced) setHiddenButtons(hiddenInputButtons(engine.getBridge())); }, [synced]);
    const hideInputButton = (label, hidden) => {
        if (!setInputButtonHidden(engine.getBridge(), label, hidden)) { notify('准备好后才能设置', 'info'); return; }
        setHiddenButtons(hiddenInputButtons(engine.getBridge()));
        notify(hidden ? `已隐藏「${label}」` : `「${label}」会显示在这一排`, 'info');
    };
    const shownButtons = inputButtons.filter(button => !hiddenButtons.includes(button.label));
    const presetLabel = synced ? currentPresetName(engine.getBridge()?.modelChoices?.()) : '';
    // "流式输出" (the app's streaming switch, kept in the current preset), read when the story menu opens.
    const [stream, setStream] = useState(null);
    const [streamBusy, setStreamBusy] = useState(false);
    useEffect(() => {
        if (sheet?.type !== 'header' || !synced) return;
        try { setStream(engine.getBridge()?.presetState?.()?.stream ?? null); } catch { setStream(null); }
    }, [sheet?.type, synced]);
    const toggleStream = () => {
        const bridge = engine.getBridge();
        if (streamBusy || stream === null || !bridge?.setPresetValue) return;
        setStreamBusy(true);
        Promise.resolve(bridge.setPresetValue('stream_openai', !stream))
            .then(state => { setStream(!!state?.stream); notify(state?.stream ? '已打开流式输出' : '已关闭流式输出，回复会写完后一次显示', 'info'); })
            .catch(error => notify(error?.message || '没有改成功，请再试一次'))
            .finally(() => setStreamBusy(false));
    };

    // The 正文 and its lines as a main story and branches: marks where lines leave, a way back from inside one.
    const branches = useMemo(() => storyBranches(storyList, chatFile, user.handle), [storyList, chatFile, user.handle]);
    // A line copied from the 正文 starts with that copy; it is shown folded so the line reads as a story of its own.
    const [copiedOpen, setCopiedOpen] = useState(false);
    // Horae's lines inside this story, each read as a sub-story: the one chosen here, else the one being written.
    const [lineChoice, setLineChoice] = useState(null);
    useEffect(() => { setCopiedOpen(false); setLineChoice(null); }, [chatFile]);
    const bridgeNow = synced ? engine.getBridge() : null;
    const storyTotal = bridgeNow ? bridgeNow.storyLength?.() ?? 0 : preview?.length ?? 0;
    const copiedCount = branches.ownStart !== null && branches.ownStart + 1 <= storyTotal ? branches.ownStart + 1 : 0;
    const ownFrom = copiedOpen ? 0 : copiedCount;
    const all = synced ? engine.getBridge()?.readingMessages?.() ?? [] : preview ?? [];
    // The lines: Horae's when it keeps them, else the shell's own record (also read from the file before the app is ready).
    const storylineNow = bridgeNow?.storylineState?.() ?? null;
    const previewOwn = !bridgeNow && preview && !preview.metadata?.horae_storylines && preview.metadata?.tavern_lite_lines ? readRegistry(preview.metadata) : null;
    // Kinds chosen by hand are kept in the shell's own record also for Horae's lines.
    const handKinds = (bridgeNow ? storylineNow?.kinds : preview?.metadata ? readRegistry(preview.metadata).kinds : null) ?? {};
    // A line's kind: chosen by hand, else what the request that started it asked for (小剧场, 平行线), else the record's.
    const kindOf = (id, first) => handKinds[id] || (all[first]?.is_user ? requestKind(all[first].mes) : null);
    const ownRegistry = (bridgeNow ? storylineNow?.source === 'lite' && storylineNow.registry : previewOwn?.lines) || {};
    const nameOf = (id, first) => lineName(ownRegistry[id], all, first);
    const layoutOf = from => {
        if (bridgeNow) return lineView({ storyline: storylineNow, total: storyTotal, from, kindOf, nameOf });
        if (!preview) return { enabled: false };
        const registry = previewOwn?.lines ?? preview.metadata?.horae_storylines?.lines ?? null;
        const ids = previewOwn ? ownIds(preview, previewOwn) : idsFromMarks(preview, registry);
        return lineView({ ids, registry, total: preview.length, from, kindOf, nameOf });
    };
    const lines = layoutOf(ownFrom);
    const view = lines.enabled ? (lineChoice && lines.has(lineChoice) ? lineChoice : lines.writing) : null;
    // The messages this page shows, when not the whole story: one line's, or the line's own writing after the copy.
    const pick = view ? lines.indices(view) : ownFrom ? Array.from({ length: storyTotal - ownFrom }, (_, n) => ownFrom + n) : null;
    const viewLabel = view && view !== MAIN_LINE ? lines.label(view) : '';
    const live = synced ? bridgeNow?.snapshot(limit, pick) : null;
    const total = live ? live.total : pick ? pick.length : preview?.length ?? 0;
    // Before the full app is ready: how it showed each message last time, else the display rules it runs.
    const pickKey = pick ? `${pick.length}:${pick[0]}:${pick.at(-1)}` : '';
    const previewMessages = useMemo(() => {
        // Once the app is ready its story is shown (and may have grown past what was read here).
        if (!preview || synced) return [];
        const order = pick ?? preview.map((_, i) => i);
        const out = [];
        let depth = 0;
        for (let n = order.length - 1; n >= Math.max(0, order.length - limit); n--) {
            const i = order[n], m = preview[i];
            const html = looks.html[`${i}|${messageMark(m)}`] ?? previewHtml(m.mes, character?.name, user.name,
                { rules: looks.rules, user: !!m.is_user, depth: m.is_system ? undefined : depth });
            out.push({ ...m, index: i, html });
            if (!m.is_system) depth++;
        }
        return out.reverse();
    }, [preview, limit, looks, character?.name, user.name, pickKey, synced]);
    const messages = live ? live.messages : previewMessages;
    const last = messages[messages.length - 1];
    // Replying, retrying and continuing work on the story's last message: only when this page shows it.
    const atEnd = !!last && last.index === storyTotal - 1;
    const openLine = id => {
        setSheet(null);
        nearBottom.current = true;
        setLimit(PAGE);
        setLineChoice(id);
    };
    // Show one message: on its line, unfolding the copy from the 正文 if it is there, then scroll to it.
    const [seekTo, setSeekTo] = useState(null);
    const showMessage = index => {
        setSheet(null);
        if (index < ownFrom) setCopiedOpen(true);
        const whole = index < ownFrom ? layoutOf(0) : lines;
        if (whole.enabled && whole.lineOf(index)) setLineChoice(whole.lineOf(index));
        setSeekTo(index);
    };
    // Remember how the full app shows this story, for the next visit (look-memory.js).
    const lookMark = live ? `${chatFile}|${live.total}|${last?.index}|${last?.html?.length ?? 0}|${limit}` : '';
    useEffect(() => {
        if (!lookMark || eng.generating) return;
        const timer = setTimeout(() => {
            const bridge = engine.getBridge(), current = bridge?.currentChat?.();
            if (!bridge || current?.avatar !== route.avatar || !current?.file) return;
            const rendered = {};
            for (const m of bridge.snapshot(limit, pick).messages) {
                if (m.html && !m.html.includes('tl-frontend-card')) rendered[`${m.index}|${messageMark(m)}`] = m.html;
            }
            keepLooks(user.handle, route.avatar, current.file, rendered, bridge.displayRules?.());
        }, 1500);
        return () => clearTimeout(timer);
    }, [lookMark, eng.generating]);
    // Each line keeps its own place; the 正文 (or a story without lines) keeps the story's.
    const rank = pick ? index => { const at = pick.indexOf(index); return at < 0 ? null : pick.length - at; } : null;
    const reading = useReadingPosition({ list, key: scopedKey('reading', chatFile) + (view && view !== MAIN_LINE ? `#${view}` : ''), all,
        ready: !!character && (synced || preview !== null), limit, setLimit, nearBottom, notify, rank });
    useEffect(() => {
        if (seekTo === null) return;
        setSeekTo(null);
        reading.seek(seekTo);
    }, [seekTo]);
    const storyScope = { avatar: route.avatar, file: chatFile };
    useEffect(() => {
        const update = () => {
            const selected = getSelection();
            const start = selected?.anchorNode?.parentElement?.closest('.tl-message-body');
            const end = selected?.focusNode?.parentElement?.closest('.tl-message-body');
            const article = start?.closest('.tl-message[data-index]');
            setSelection(start && start === end && list.current?.contains(article) && selected.toString().trim()
                ? { index: Number(article.dataset.index), text: selected.toString() } : null);
        };
        document.addEventListener('selectionchange', update);
        return () => document.removeEventListener('selectionchange', update);
    }, []);
    useEffect(() => {
        if (!character || !all.length) return;
        const source = takeSourceJump(user.handle, storyScope);
        if (!source) return;
        const raw = synced ? engine.getBridge()?.personalConversation?.().messages : preview;
        const found = locateSource(raw || [], source);
        if (!found?.current) return notify('原文已改动或无法定位，摘录仍保留', 'info');
        showMessage(found.index);
    }, [chatFile, synced, preview]);
    const captureMessage = (index, kind, text) => {
        if (eng.generating) return notify('生成结束后才能保存一致的快照', 'info');
        const raw = synced ? engine.getBridge()?.personalConversation?.().messages : preview;
        const message = raw?.[index];
        if (!message || !chatFile) return notify('原文还没准备好，请稍后再试', 'info');
        setSheet({ type: 'capture', kind, source: makeSource(storyScope, message, index), initialText: text });
    };
    // The contents: the whole story with what Horae recorded per message, and where the page is now (the message at the
    // top, as the reading position counts it).
    const openToc = () => {
        const el = list.current, top = (el?.getBoundingClientRect().top ?? 0) + 80;
        const article = el && [...el.querySelectorAll('.tl-message[data-index]')].find(n => n.getBoundingClientRect().bottom > top);
        const bridge = synced ? engine.getBridge() : null;
        const story = bridge ? bridge.tocMessages?.() ?? bridge.readingMessages?.() ?? []
            : (preview ?? []).map(m => ({ is_user: !!m.is_user, notice: !!(m.is_system && m.extra?.type), hidden: !!m.is_system, mes: m.mes, horae_meta: m.horae_meta }));
        setSheet({ type: 'toc', story, current: article ? Number(article.dataset.index) : story.length - 1 });
    };
    const undoRecent = async () => {
        if (undoBusy || !recent) return;
        setUndoBusy(true);
        recentUndo.current ||= mutation(recent, 'delete');
        try { await saveRecord(user.handle, recentUndo.current, recent.storage); setRecent(null); recentUndo.current = null; }
        catch (e) { notify(e.message); }
        finally { setUndoBusy(false); }
    };

    useLayoutEffect(() => {
        const element = list.current;
        if (element && nearBottom.current && !reading.holding()) element.scrollTop = element.scrollHeight;
    });

    // Cards, panel mirrors and the button row above the input settle after the text is shown and change heights
    // without a render; a reader at the end of the story stays at the end.
    useEffect(() => {
        const element = list.current;
        if (!element || typeof ResizeObserver !== 'function') return undefined;
        const keep = () => { if (nearBottom.current && element.isConnected) element.scrollTop = element.scrollHeight; };
        const resized = new ResizeObserver(keep);
        const watch = () => { resized.observe(element); for (const child of element.children) resized.observe(child); };
        watch();
        const added = new MutationObserver(watch);
        added.observe(element, { childList: true });
        return () => { resized.disconnect(); added.disconnect(); };
    }, []);

    // Reading chrome: scrolling down into the story hides the header, scrolling back up brings it back.
    const onScroll = () => {
        const element = list.current;
        // A scroll the page caused while it was being left arrives after the list is gone.
        if (!element) return;
        reading.scroll();
        if (reading.holding()) return;
        const delta = element.scrollTop - lastScrollTop.current;
        lastScrollTop.current = element.scrollTop;
        if (delta > 8 && element.scrollTop > 60 && !nearBottom.current) setHeaderHidden(true);
        else if (delta < -8 || nearBottom.current) setHeaderHidden(false);
    };

    const onReadingClick = event => {
        if (!event.target.closest('button, a, input, textarea, .tl-swipe')) setHeaderHidden(h => !h);
    };

    const lineHereKey = scopedKey('line-here', chatFile);
    // `confirmed`: the author chose to write on a line the shell keeps, knowing the model reads the whole story.
    const send = ({ here = false, text: chosen, confirmed = false } = {}) => {
        const text = (chosen ?? draft).trim();
        if (!text || pendingRef.current || episodeBusy) return;
        const bridge = engine.getBridge();
        const status = bridge?.episodeStatus?.();
        const intent = !here && status?.enabled && status?.verified && synced ? detectEpisodeIntent(text) : null;
        if (intent) { setSheet({ type: 'episodes', intent }); return; }
        // Without Horae the shell records the lines itself: from a request that starts one, or goes back to the 正文
        // (the same rules as Horae's). With Horae, Horae reads the request itself.
        const state = synced ? bridge?.storylineState?.() : null;
        const asked = state?.source === 'lite' ? detectEpisodeIntent(text) : null;
        const directive = state?.source === 'lite' ? lineDirective(text)
            ?? (asked?.action === 'create' ? { action: 'start', kind: asked.kind, title: asked.title } : null) : null;
        const from = view ?? state?.active ?? MAIN_LINE;
        const step = directive?.action === 'start' ? { action: 'new-next', title: directive.title, kind: directive.kind, parent: from, auto: !!directive.weak }
            : directive?.action === 'back' && from !== MAIN_LINE ? { action: 'to-main' } : null;
        const target = step?.action === 'new-next' ? 'new' : step ? MAIN_LINE : from;
        if (state?.source === 'lite' && target !== MAIN_LINE && !confirmed && !readStory(lineHereKey)) {
            setSheet({ type: 'line-memory', text, step, target,
                label: target === 'new' ? `${EPISODE_KINDS[step.kind] || '番外'} · ${step.title}` : lines.enabled ? lines.label(target) : '这条线' });
            return;
        }
        reading.release();
        nearBottom.current = true;
        pendingLine.current = step ? null : view;
        pendingStep.current = step;
        pendingRef.current = text;
        setSendState('pending');
        setPending(text);
        setDraft('');
        engine.requestEngine('action');
    };

    // A line kept by the shell, copied out into a story of its own (its last stretch, as 故事里写过的番外 does) and opened
    // there with the words that were about to be sent: its memory is then really apart from the 正文.
    const splitLine = async (id, text) => {
        const bridge = engine.getBridge();
        if (!bridge?.extractEpisode) throw new Error('原版界面还在准备，好了再拆');
        const at = lines.indices(id);
        let first = at.length - 1;
        while (first > 0 && at[first - 1] === at[first] - 1) first--;
        if (first < 0) throw new Error('这条线还没有内容，没什么可拆');
        const from = at[first], to = at.at(-1), story = bridge.readingMessages?.() ?? [];
        const line = lines.lines.find(l => l.id === id);
        const result = await bridge.extractEpisode({ account: user.handle, scope: storyScope, from, to, title: line?.title || '番外', kind: lines.kind(id),
            unhide: true, carryVariables: false, expectedFirst: String(story[from]?.mes ?? ''), expectedLast: String(story[to]?.mes ?? '') });
        if (result?.kind !== 'extracted' || !result.target?.file) throw new Error('没确认新故事写好了，去「番外与平行线」里看看');
        writeStory(storyKey('draft', user.handle, result.target.avatar ?? route.avatar, result.target.file), text);
        if (draftValue.current.trim() === text) setDraft('');
        setSheet(null);
        notify(`已拆成「${result.title}」，共 ${result.count} 条，在这里接着写`, 'info');
        go({ name: 'chat', avatar: result.target.avatar ?? route.avatar, file: result.target.file });
    };

    const cancelPending = () => {
        if (!pendingRef.current) return;
        if (sendJob.current && !sendJob.current.cancel?.()) return notify('已经发出，撤不回了', 'info');
        sendJob.current = null;
        sending.current = false;
        pendingStep.current = null;
        undoStep();
        const text = pendingRef.current;
        pendingRef.current = null;
        writeStory(pendingKey, null);
        setPending(null);
        // Both cancel and edit preserve the original, without overwriting later input.
        setDraft(d => [d, text].filter(Boolean).join('\n'));
        notify('已取消发送，文字已放回输入框', 'info');
    };

    const onKeyDown = event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(pointer: fine)').matches) {
            event.preventDefault();
            send();
        }
    };

    const failed = e => {
        if (e.code === 'cancelled') return;
        // The browser's own words for a dropped connection ("Load failed", "Failed to fetch") say nothing to a reader.
        notify(e?.name === 'TypeError' && NETWORK_FAILURE.test(e.message) ? '网络开小差了，再试一次' : e.message);
        if (e.code === 'no-connection') go({ name: 'setup', from: 'story' });
    };
    // A tap made while the full app prepares is carried out once it is ready (on a phone that can take minutes), with a
    // word saying so, instead of being dropped.
    const run = (action, label = '') => {
        setSheet(null);
        const bridge = engine.getBridge();
        if (!bridge) notify(`原版界面还在准备，好了自动${label || '接着做'}`, 'info');
        return (bridge ? Promise.resolve(bridge) : engine.whenBridge()).then(b => {
            reading.release();
            nearBottom.current = true;
            return action(b);
        }).catch(failed);
    };
    // Saving, deleting and branching first check the account over the network, seconds on a phone: the sheet stays
    // open and the tapped item says what is happening (`busy` names it) until it is done; on failure it stays for a retry.
    const [sheetBusy, setSheetBusy] = useState(''), [sheetWaiting, setSheetWaiting] = useState(false);
    const hereLock = useRef(false), hereTicket = useRef(null);
    // While the full app prepares, the tapped item waits for it; closing the sheet then drops the tap (nothing ran yet).
    const runHere = (busy, action) => {
        if (hereLock.current) return undefined;
        const ticket = {}, bridge = engine.getBridge();
        hereLock.current = true; hereTicket.current = ticket;
        setSheetBusy(busy); setSheetWaiting(!bridge);
        if (!bridge) notify('原版界面还在准备，好了自动接着做；关掉这个菜单就不做了', 'info');
        return (bridge ? Promise.resolve(bridge) : engine.whenBridge()).then(b => {
            if (hereTicket.current !== ticket) throw Object.assign(new Error('已取消'), { code: 'cancelled' });
            setSheetWaiting(false);
            reading.release();
            nearBottom.current = true;
            return action(b);
        }).then(() => { if (hereTicket.current === ticket) setSheet(null); }, failed)
            .finally(() => { if (hereTicket.current === ticket) { hereTicket.current = null; hereLock.current = false; setSheetBusy(''); setSheetWaiting(false); } });
    };
    const closeSheet = () => {
        if (hereLock.current && sheetWaiting) { hereTicket.current = null; hereLock.current = false; setSheetBusy(''); setSheetWaiting(false); }
        if (!hereLock.current) setSheet(null);
    };

    // A new reply first checks the account and the connection over the network: say so from the tap until it is done.
    const [swiping, setSwiping] = useState(false);
    const swipe = direction => {
        if (direction === 'right') setSwiping(true);
        return Promise.resolve(run(b => b.swipe(direction), direction === 'right' ? '换个回复' : '翻回上一个回复')).finally(() => setSwiping(false));
    };

    const openChat = current => {
        if (current?.avatar) go({ name: 'chat', avatar: current.avatar, file: current.file });
    };
    const startNewChapter = () => go({ name: 'chat', avatar: route.avatar, file: '', fresh: true });
    const extensionItems = synced ? engine.getBridge()?.extensionMenu?.() ?? [] : [];

    const ready = synced && !eng.generating;
    const currentChapter = storyList?.find(chapter => api.chatId(chapter.file_name) === chatFile);
    const identity = episodeIdentity(currentChapter?.chat_metadata, user.handle);
    const chapterName = character ? (route.fresh && !synced ? '新故事' : identity.title || chapterLabel(chatFile, character.name, numbers)) : '';
    // A story lines were opened from (inside it, or as stories of their own) is their 正文, not an "ordinary" story.
    const storyType = identity.kind === 'ordinary' && (lines.enabled || branches.children?.length > 0) ? '正文' : identity.type;
    const lineLabel = `${storyType} · ${chapterName}`;
    // Where the page is: this story, and the line of it being read.
    const hereLabel = viewLabel ? `${lineLabel} › ${viewLabel}` : lineLabel;
    const forkMarks = useMemo(() => forksByIndex(branches.children), [branches]);
    const lineMarks = view ? lines.marks(view) : null;
    // From the 正文 to here: the story a line was copied from (another story), then Horae's lines inside this one.
    const crumbs = lines.enabled ? lines.path(view).map((step, n, all) => ({
        key: step.id, label: n === 0 && branches.parent ? lineLabel : step.label,
        open: n < all.length - 1 && step.readable ? () => openLine(step.id) : null,
    })) : branches.parent ? [{ key: 'here', label: lineLabel, open: null }] : [];
    const showPath = !!branches.parent || crumbs.length > 1;
    const openStory = file => go({ name: 'chat', avatar: route.avatar, file });
    // Horae storylines inside this story: the line in use (and the one the next message switches to), for its sheet under ＋.
    const storyline = synced ? live?.storyline ?? null : null;
    const lastIsChar = atEnd && !last.is_user && !last.is_system;
    // After a stopped or failed generation the story ends with the user's words; the app then generates a reply.
    const lastIsUser = atEnd && !!last.is_user && !last.is_system && !pending;
    const notReadyHint = synced ? (eng.generating ? '生成完再操作' : '') : '准备好后可用';
    const askReply = () => run(b => b.regenerate({ after: 'user' }), `让${character?.name ?? '角色'}回复`);
    const regenerateReply = () => run(b => b.regenerate({ after: 'char' }), '重新生成');
    // The app's 重新生成 replaces the whole last message, every reply in it; with several, say so first.
    const regenerateTap = () => {
        if (last?.swipes > 1) setSheet({ type: 'regenerate', message: last });
        else { setSheet(null); regenerateReply(); }
    };
    const persona = synced && engine.getBridge()?.capabilities.persona ? engine.getBridge().personaList?.() : null;
    const personaName = persona?.list.find(p => p.id === persona.current)?.name ?? user.name;

    return (
        <main class="tl-chat">
            <header class="tl-header tl-reader-header" data-hidden={headerHidden ? 'true' : undefined}>
                <button class="tl-ghost tl-back" onClick={() => go({ name: 'library' })} aria-label="返回书架"><Icon name="back" /></button>
                <button class="tl-reader-title" aria-label="切换故事" disabled={!character} onClick={() => setSheet({ type: 'chapters' })}>
                    <strong class="tl-chat-title">{character?.name ?? '…'}</strong>
                    <span class="tl-chapter">{lineLabel}<Icon name="chevronDown" size={14} /></span>
                </button>
                <span class="tl-spacer" />
                <button class="tl-ghost" aria-label="目录" disabled={!character} onClick={openToc}><Icon name="toc" /></button>
                <button class="tl-ghost tl-aa" aria-label="阅读设置" onClick={onReading}>Aa</button>
                <button class="tl-ghost" aria-label="更多" onClick={() => setSheet({ type: 'header' })}><Icon name="more" /></button>
            </header>
            {showPath && (
                <nav class="tl-branch-path" aria-label="所在位置" data-hidden={headerHidden ? 'true' : undefined}>
                    {branches.parent && <>
                        <button class="tl-link" onClick={() => openStory(branches.parent.file)}>正文</button>
                        <span aria-hidden="true">›</span>
                    </>}
                    {crumbs.map((crumb, n) => <Fragment key={crumb.key}>
                        {n > 0 && <span aria-hidden="true">›</span>}
                        {crumb.open ? <button class="tl-link tl-branch-path-step" onClick={crumb.open}>{crumb.label}</button>
                            : <span class={n === crumbs.length - 1 ? 'tl-branch-path-here' : 'tl-branch-path-step'}>{crumb.label}</span>}
                    </Fragment>)}
                </nav>
            )}
            {syncError && <p class="tl-error tl-banner">{syncError} <button class="tl-button" onClick={() => setSyncError('')}>重试</button></p>}
            <div class="tl-messages" ref={list} onScroll={onScroll} onClick={onReadingClick} tabIndex={0}
                onWheel={reading.release} onTouchStart={reading.release} onPointerDown={reading.release} onKeyDown={reading.release}>
                {total > messages.length && (
                    <button class="tl-button tl-more" onClick={() => { nearBottom.current = false; setLimit(l => l + PAGE); }}>查看更早的 {Math.min(PAGE, total - messages.length)} 条</button>
                )}
                {preview === null && !live && <p class="tl-muted">正在加载…</p>}
                {character && total <= messages.length && ownFrom > 0 && (
                    <div class="tl-card tl-copied-note">
                        <p>前面 {ownFrom} 条是开这条线时从正文带过来的，这里只显示这条线自己写的</p>
                        <div class="tl-row">
                            {branches.parent && <button class="tl-button" onClick={() => openStory(branches.parent.file)}>去正文看</button>}
                            <button class="tl-button" onClick={() => { nearBottom.current = false; setCopiedOpen(true); }}>在这里展开</button>
                        </div>
                    </div>
                )}
                {character && total <= messages.length && (
                    <header class="tl-chapter-opening">
                        <span class="tl-chapter-kicker">{viewLabel || lineLabel}</span>
                        <h2 class="tl-chapter-heading">{character.name}</h2>
                        <span class="tl-ornament" aria-hidden="true" />
                    </header>
                )}
                {character && view && !total && <p class="tl-muted tl-line-empty">「{viewLabel || '正文'}」还没有内容，发一句就从这里开始写</p>}
                {character && messages.map(m => <Fragment key={m.index}>
                    <Message message={m} character={character} user={user} display={live?.display} isLast={m === last && atEnd && !pending}
                        synced={synced} generating={eng.generating} waitingSince={generatingSince.current} swiping={swiping && m === last}
                        onMenu={message => setSheet({ type: 'message', message })}
                        onSwipe={swipe}
                        onContinue={() => run(b => b.continueReply(), '接着写')} onReply={askReply} onRegenerate={regenerateTap} onShowInNative={onShowInNative} />
                    {lineMarks?.has(m.index) && <LineMarks lines={lineMarks.get(m.index)} onOpen={openLine} />}
                    {forkMarks.has(m.index) && <BranchMarks lines={forkMarks.get(m.index)} onOpen={openStory} />}
                    {copiedOpen && branches.ownStart === m.index && <p class="tl-branch-divider" role="separator">以上来自正文 · 从这里起是这条线
                        <button class="tl-link" onClick={() => { nearBottom.current = true; setCopiedOpen(false); }}>收起</button></p>}
                </Fragment>)}
                {/* The app adds the reply only once the model service answers (a minute or more with some relays). */}
                {character && synced && eng.generating && lastIsUser && (
                    <article class="tl-message" data-role="char" data-placeholder="true">
                        <div class="tl-message-name"><span>{character.name}</span></div>
                        <Waiting since={generatingSince.current} />
                    </article>
                )}
                {pending && (
                    <article class="tl-message" data-role="user" data-pending="true">
                        <div class="tl-message-name" role="status">{personaName} · {sendState === 'submitted' || sendState === 'accepted' ? '已发出' : synced ? '等待发送' : '准备好后自动发出'}</div>
                        <div class="tl-message-body">{pending}</div>
                        <div class="tl-row">
                            <button class="tl-button" disabled={sendState !== 'pending'} onClick={cancelPending}>取消发送</button>
                            <button class="tl-button" disabled={sendState !== 'pending'} onClick={cancelPending}>改一改</button>
                        </div>
                    </article>
                )}
            </div>
            {reading.away && <button class="tl-button tl-jump-latest" onClick={reading.jump}>回到最新</button>}
            {selection && !sheet && <button class="tl-button tl-selection-collect" onPointerDown={e => e.preventDefault()}
                onClick={() => captureMessage(selection.index, 'quote', selection.text)}>收藏这句</button>}
            {recent && <PersonalNotice record={recent} busy={undoBusy} onUndo={undoRecent} onClose={() => setRecent(null)}
                onNote={() => setSheet({ type: 'personal', record: recent })} />}
            {synced && engine.getBridge()?.currentChat()?.avatar === route.avatar && engine.getBridge()?.currentChat()?.file === chatFile
                && engine.getBridge()?.isReplying?.() && <p class="tl-story-status" role="status">正在回复 · 停止不会撤回你发的话</p>}
            <EngineStatus eng={eng} />
            {synced && engine.getBridge()?.connectionConfigured?.() === false && (
                <button class="tl-card tl-setup-banner tl-setup-bar" onClick={() => go({ name: 'setup', from: 'story' })}>
                    <strong>还没连上 AI 模型，消息发不出去</strong>
                    <span class="tl-card-snippet">写好的文字会留着</span>
                    <span class="tl-card-action">去设置</span>
                </button>
            )}
            {synced && quickOpen && inputButtons.length > 0 && (
                <div class="tl-chips tl-input-buttons" id="tl-quick-row" role="toolbar" aria-label="快捷按钮">
                    {shownButtons.map(button => (
                        <QuickChip key={button.key} button={button} onPress={pressInputButton} onHold={b => setSheet({ type: 'quick-button', button: b })} />
                    ))}
                    {inputButtons.length > 0 && (
                        <button class="tl-chip tl-chip-quiet" onClick={() => setSheet({ type: 'quick-manage' })}>
                            {inputButtons.length > shownButtons.length ? `已隐藏 ${inputButtons.length - shownButtons.length} 个` : '管理'}
                        </button>
                    )}
                </div>
            )}
            <div class="tl-episode-bar" data-quick={synced ? 'true' : undefined}>
                <span>发送到：{hereLabel}</span>
                <button class="tl-button" aria-disabled={!synced || !!pending || eng.generating || episodeBusy ? 'true' : undefined} onClick={() => {
                    // Not greyed out without a word: a tap says what it waits for.
                    const wait = eng.generating ? '正在写回复，写完再打开' : pending ? '有一句还在排队发送，发出去再打开' : episodeBusy ? '番外正在发送，等它写完'
                        : !synced ? '故事还在载入，载完再打开' : '';
                    if (wait) notify(wait, 'info'); else setSheet({ type: 'episodes' });
                }}>番外与平行线</button>
                {synced && inputButtons.length > 0 && (
                    <button class="tl-button tl-quick-toggle" aria-expanded={quickOpen ? 'true' : 'false'} aria-controls="tl-quick-row"
                        aria-label={quickOpen ? '收起快捷按钮' : '展开快捷按钮'} title={quickOpen ? '收起' : '快捷按钮'}
                        onClick={() => setQuickOpen(!quickOpen)}>
                        <span aria-hidden="true">{quickOpen ? '⌄' : '⌃'}</span>
                    </button>
                )}
            </div>
            <footer class="tl-composer">
                {(extensionItems.length > 0 || storyline?.multi) && (
                    <button class="tl-ghost tl-plus" aria-label="扩展功能" onClick={() => setSheet({ type: 'actions' })}><Icon name="plus" /></button>
                )}
                <div class="tl-composer-box">
                    <textarea class="tl-composer-input" rows={1} placeholder={synced ? '写下你的回应…' : '可以先写，准备好自动发出'}
                        aria-label="输入消息" data-synced={synced ? 'true' : 'false'} value={draft} onInput={e => setDraft(e.currentTarget.value)} onKeyDown={onKeyDown}
                        onFocus={() => engine.requestEngine('input')} />
                    {eng.generating
                        ? <button class="tl-round tl-stop" aria-label="停止" onClick={stopReply}><Icon name="stop" size={16} /></button>
                        : !draft.trim() && lastIsUser && ready
                            ? <button class="tl-round tl-send" aria-label={`让${character?.name ?? '角色'}回复`} title="让角色回复你的最后一句" onClick={askReply}><Icon name="send" size={20} /></button>
                            : <button class="tl-round tl-send" aria-label="发送" disabled={!draft.trim() || !!pending} onClick={send}><Icon name="send" size={20} /></button>}
                </div>
            </footer>

            {sheet?.type === 'actions' && (
                <Sheet title="扩展功能" onClose={() => setSheet(null)}>
                    <p class="tl-muted tl-sheet-note">扩展提供的功能（原版 ✨ 菜单）</p>
                    {storyline?.multi && <SheetItem label={storyline.source === 'horae' ? 'Horae 故事线' : '故事里的线'}
                        hint={view ? `正在读「${viewLabel || '正文'}」` : `现在在「${lines.enabled ? lines.label(lines.writing) : '正文'}」`}
                        onClick={() => setSheet({ type: 'storylines' })} />}
                    {extensionItems.map(item => (
                        <SheetItem key={item.key} label={item.label} onClick={() => {
                            setSheet(null);
                            if (!engine.getBridge()?.clickExtensionMenu(item.key)) notify('这个功能刚刚变了，请再点一次', 'info');
                        }} />
                    ))}
                </Sheet>
            )}
            {sheet?.type === 'header' && (
                <Sheet title={character?.name ?? '故事'} onClose={() => setSheet(null)}>
                    <p class="tl-sheet-section">这个故事</p>
                    <p class="tl-muted tl-sheet-note">{lineLabel}</p>
                    <SheetItem label="目录" hint="跳到任意一段" onClick={openToc} />
                    {storyline && storyline.source !== 'horae' && <SheetItem label="故事里的线" hint={lines.enabled ? `正文和 ${lines.lines.length - 1} 条番外，分开显示` : '故事里写的番外分开显示'}
                        onClick={() => setSheet({ type: 'storylines' })} />}
                    <SheetItem label="我的摘录" hint="收藏的句子和备注" onClick={() => setSheet({ type: 'personal' })} />
                    <SheetItem label="分享这个故事" hint={synced ? '长图、文本或复制' : '准备好后可用'} disabled={!synced}
                        onClick={() => setSheet({ type: 'export', from: 0 })} />
                    <SheetItem label="开始新故事" hint="从头开始，这个故事会保留" onClick={startNewChapter} />
                    {/* A new story has no file until its first save, so nothing to rename or delete yet. */}
                    {currentChapter && !identity.episode && (
                        <SheetItem label="给这个故事起名" hint={eng.generating ? '生成完再操作' : ''} disabled={eng.generating}
                            onClick={() => setSheet({ type: 'story-actions', start: 'rename' })} />
                    )}
                    {currentChapter && (
                        <SheetItem label="删除这个故事" hint={eng.generating ? '生成完再操作' : '无法恢复'} danger disabled={eng.generating}
                            onClick={() => setSheet({ type: 'story-actions', start: 'delete' })} />
                    )}
                    <SheetItem label="角色主页" hint="简介、全部故事、编辑角色" onClick={() => go({ name: 'work', avatar: route.avatar })} />
                    {/* Settings by how often they are changed; the switch closes the group. */}
                    {(persona || stream !== null || (synced && engine.getBridge()?.modelChoices)) && <p class="tl-sheet-section">设置</p>}
                    {synced && engine.getBridge()?.modelChoices && (
                        <SheetItem label={`模型：${modelSummary(engine.getBridge().modelChoices()) || '未设置'}`} hint="换模型或连接"
                            onClick={() => { setSheet(null); onModel(); }} />
                    )}
                    {presetLabel && (
                        <SheetItem label={`预设：${presetLabel}`} hint="换预设或调整条目" disabled={eng.generating}
                            onClick={() => setSheet({ type: 'preset-pick' })} />
                    )}
                    {persona && (
                        <SheetItem label={`我的身份：${personaName}`} hint={persona.locked ? '这个故事固定用这个身份' : '你在故事里的名字和介绍'}
                            disabled={eng.generating} onClick={() => setSheet({ type: 'persona' })} />
                    )}
                    {stream !== null && (
                        <button class="tl-sheet-item tl-switch-row" role="switch" aria-checked={stream ? 'true' : 'false'} aria-busy={streamBusy ? 'true' : undefined}
                            disabled={eng.generating || streamBusy} onClick={toggleStream}>
                            <span class="tl-sheet-item-label">流式输出</span>
                            <span class="tl-sheet-item-hint">{eng.generating ? '生成完才能改' : stream ? '改的是当前预设' : '写完后一次显示 · 改的是当前预设'}</span>
                        </button>
                    )}
                    <p class="tl-sheet-section">其他</p>
                    <SheetItem label="打开原版界面" hint="酒馆的完整界面，高级功能都在这里"
                        onClick={() => { setSheet(null); if (eng.state === 'ready') onNative(); else { notify('原版界面还在准备，好了自动打开', 'info'); engine.whenBridge().then(() => onNative(), failed); } }} />
                </Sheet>
            )}
            {sheet?.type === 'story-actions' && currentChapter && character && (
                // Afterwards the app has the renamed story open, or after a delete the most recent remaining one (or a new one).
                <ChapterActions start={sheet.start} character={character} chapter={currentChapter} chapters={storyList ?? []} numbers={numbers}
                    account={user.handle} withBridge={withBridge} onClose={() => setSheet(null)}
                    onChanged={({ type, current }) => {
                        notify(type === 'delete' ? '故事已删除' : '故事已改名', 'info');
                        if (current?.avatar) openChat(current);
                        else go({ name: 'work', avatar: route.avatar });
                    }} />
            )}
            {sheet?.type === 'preset-pick' && (
                <PresetPickSheet notify={notify} onModel={onModel} onClose={() => setSheet(null)} />
            )}
            {sheet?.type === 'quick-button' && (
                <Sheet title={sheet.button.label} onClose={() => setSheet(null)}>
                    <SheetItem label="按一下" onClick={() => { setSheet(null); pressInputButton(sheet.button); }} />
                    <SheetItem label="隐藏" hint="可在「管理快捷按钮」找回"
                        onClick={() => { setSheet(null); hideInputButton(sheet.button.label, true); }} />
                    <SheetItem label="管理快捷按钮" onClick={() => setSheet({ type: 'quick-manage' })} />
                </Sheet>
            )}
            {sheet?.type === 'quick-manage' && (
                <Sheet title="管理快捷按钮" onClose={() => setSheet(null)}>
                    <p class="tl-muted tl-sheet-note">来自快捷回复和酒馆助手。关掉只是不显示，长按按钮也能隐藏</p>
                    <div class="tl-list">
                        {inputButtons.map(button => {
                            const shown = !hiddenButtons.includes(button.label);
                            return (
                                <button key={button.key} class="tl-list-item tl-switch-row" role="switch" aria-checked={shown ? 'true' : 'false'}
                                    onClick={() => hideInputButton(button.label, shown)}>
                                    <span class="tl-list-label">{button.label}</span>
                                    {button.title && <span class="tl-list-hint">{button.title}</span>}
                                </button>
                            );
                        })}
                    </div>
                </Sheet>
            )}
            {sheet?.type === 'export' && character && (
                <ExportLoader character={character} chapterTitle={chapterName} startIndex={sheet.from} notify={notify} onClose={() => setSheet(null)} />
            )}
            {sheet?.type === 'persona' && (
                <PersonaSheet characterName={character?.name} notify={notify} onOpenPanel={onOpenPanel} onClose={() => setSheet(null)} />
            )}
            {sheet?.type === 'select' && (
                <SelectTextSheet message={sheet.message} html={sheet.message.html ?? previewHtml(sheet.message.mes, character?.name, user.name)} onClose={() => setSheet(null)} />
            )}
            {sheet?.type === 'toc' && (
                <TocSheet storyTitle={lineLabel} messages={sheet.story} currentIndex={sheet.current} onClose={() => setSheet(null)}
                    onJump={showMessage} />
            )}
            {sheet?.type === 'chapters' && character && (
                <ChaptersSheet character={character} account={user.handle} currentFile={chatFile} onClose={() => setSheet(null)}
                    onOpen={file => go({ name: 'chat', avatar: route.avatar, file })} onNew={startNewChapter}
                    onManage={() => go({ name: 'work', avatar: route.avatar })} />
            )}
            {sheet?.type === 'message' && (
                <Sheet title="消息操作" busy={!!sheetBusy && !sheetWaiting} onClose={closeSheet}>
                    {/* Like a chat app's long press: copy first, the common edits next, delete last. */}
                    <SheetItem label="复制" onClick={async () => {
                        setSheet(null);
                        notify(await copyText(sheet.message.mes ?? '') ? '已复制' : '复制失败，试试「更多 → 选择文字」', 'info');
                    }} />
                    <SheetItem label="编辑" hint={notReadyHint || undefined}
                        disabled={!ready || sheet.message.index === undefined || !engine.getBridge()?.capabilities.editText}
                        onClick={() => setSheet({ type: 'edit', message: sheet.message })} />
                    {sheet.message.index === last?.index && lastIsChar && (
                        <SheetItem label="重新生成" hint={notReadyHint || '换掉这条回复'} disabled={!ready} onClick={regenerateTap} />
                    )}
                    <SheetItem label="收藏原句" hint={eng.generating ? '生成完再操作' : '收藏一句或整段'} disabled={eng.generating} onClick={() => captureMessage(sheet.message.index, 'quote')} />
                    {!sheet.message.is_user && <SheetItem label="先留这一版" hint={eng.generating ? '生成完再操作' : '存个快照，不影响现在这版'} disabled={eng.generating} onClick={() => captureMessage(sheet.message.index, 'variant')} />}
                    <SheetItem label="换个走向" hint={notReadyHint || '从这里另开一个故事'}
                        busy={sheetBusy === 'branch'} busyLabel="正在另开一个故事…"
                        disabled={!ready || !engine.getBridge()?.capabilities.branch} onClick={() => runHere('branch', b => b.branchFrom(sheet.message.index).then(openChat))} />
                    {storyline && storyline.source !== 'horae' && sheet.message.index > 0 && sheet.message.index >= ownFrom && (
                        <SheetItem label="分线" hint={notReadyHint || '从这条起开番外，或回到正文'} disabled={!ready}
                            onClick={() => setSheet({ type: 'message-line', message: sheet.message })} />
                    )}
                    <SheetItem label="更多" hint="选择文字、分享等" onClick={() => setSheet({ type: 'message-more', message: sheet.message })} />
                    <SheetItem label="删除" hint={notReadyHint || undefined} danger
                        disabled={!ready || sheet.message.index === undefined || !engine.getBridge()?.capabilities.deleteMessage}
                        onClick={() => setSheet({ type: 'delete', message: sheet.message })} />
                </Sheet>
            )}
            {sheet?.type === 'message-more' && (
                <Sheet title="更多" onClose={() => setSheet(null)}>
                    <SheetItem label="选择文字" hint="只复制其中一段" onClick={() => setSheet({ type: 'select', message: sheet.message })} />
                    <SheetItem label="从这条开始分享" hint={synced ? '把这一段做成长图或文本' : '准备好后可用'} disabled={!synced || sheet.message.index === undefined}
                        onClick={() => setSheet({ type: 'export', from: sheet.message.index })} />
                    <SheetItem label="查看摘录" hint="收藏的句子和快照" onClick={() => setSheet({ type: 'personal' })} />
                    <SheetItem label="在原版界面里编辑" hint={notReadyHint || '原版的消息编辑器：思考过程、附件等'}
                        disabled={!ready || sheet.message.index === undefined} onClick={() => { setSheet(null); onEditInNative(sheet.message.index); }} />
                    <NativeMessageButtons index={sheet.message.index} disabled={!ready}
                        onPick={button => run(b => b.clickMessageButton(sheet.message.index, button.key), `点「${button.label}」`)} />
                </Sheet>
            )}
            {sheet?.type === 'edit' && (
                <EditMessageSheet message={sheet.message} onClose={() => setSheet(null)}
                    onSave={text => runHere('edit', b => b.editText(sheet.message.index, text).then(() => notify('已保存', 'info')))} />
            )}
            {sheet?.type === 'capture' && <CaptureSheet user={user} {...sheet} onClose={() => setSheet(null)} onSaved={record => {
                recentUndo.current = null; setRecent(record); setSheet(null); getSelection()?.removeAllRanges();
            }} />}
            {sheet?.type === 'storylines' && <StorylineSheet initial={storyline} lines={lines} view={view} onOpen={openLine}
                onEdit={line => setSheet({ type: 'line-edit', line })} notify={notify} scope={storyScope} onClose={() => setSheet(null)} />}
            {sheet?.type === 'line-edit' && <LineFormSheet title={`改「${sheet.line.label}」`} line={sheet.line} named={storyline?.source !== 'horae'}
                confirmLabel="保存" onClose={() => setSheet({ type: 'storylines' })} onSave={async ({ kind, title }) => {
                    const b = engine.getBridge();
                    if (!b) throw new Error('原版界面还在准备，好了再改');
                    if (kind !== sheet.line.kind) await b.storylineAction('set-kind', { line: sheet.line.id, kind, scope: storyScope });
                    if (storyline?.source !== 'horae' && title !== sheet.line.title) await b.storylineAction('rename', { line: sheet.line.id, title, scope: storyScope });
                    notify('已改好', 'info');
                }} />}
            {sheet?.type === 'message-line' && <MessageLineSheet index={sheet.message.index} lines={lines} busy={sheetBusy} waiting={sheetWaiting}
                onNew={() => setSheet({ type: 'line-new', message: sheet.message })} onPick={() => setSheet({ type: 'line-pick', message: sheet.message })}
                onMark={(busy, options, done) => runHere(busy, b => b.storylineAction(options.action, { ...options, index: sheet.message.index, scope: storyScope })
                    .then(() => notify(done, 'info')))} onClose={closeSheet} />}
            {sheet?.type === 'line-pick' && (
                <Sheet title="划进已有的线" busy={!!sheetBusy && !sheetWaiting} onClose={closeSheet}>
                    <p class="tl-muted tl-sheet-note">从这条起，后面的都跟着它，直到下一个分线的地方</p>
                    {lines.enabled && lines.lines.filter(line => line.id !== MAIN_LINE && line.id !== lines.lineOf(sheet.message.index)).map(line => (
                        <SheetItem key={line.id} label={line.label} busy={sheetBusy === `line-${line.id}`} busyLabel="正在分…" disabled={!!sheetBusy}
                            onClick={() => runHere(`line-${line.id}`, b => b.storylineAction('mark', { index: sheet.message.index, line: line.id, scope: storyScope })
                                .then(() => notify(`从这条起是「${line.label}」`, 'info')))} />))}
                </Sheet>
            )}
            {sheet?.type === 'line-new' && <LineFormSheet title="从这里开一条番外" confirmLabel="开始" onClose={() => setSheet(null)}
                onSave={({ kind, title }) => engine.whenBridge().then(b => b.storylineAction('mark', { index: sheet.message.index, title, kind, scope: storyScope }))
                    .then(() => notify(`从这条起是${EPISODE_KINDS[kind]}「${title}」`, 'info'))} />}
            {sheet?.type === 'line-memory' && (() => {
                const bridge = engine.getBridge(), status = bridge?.episodeStatus?.();
                const isNew = sheet.target === 'new';
                const canSplit = !!status?.enabled && (isNew ? !!status.verified : !!(status.extractable ?? status.verified) && !!bridge?.extractEpisode);
                return <LineMemorySheet label={sheet.label} isNew={isNew} canSplit={canSplit} onClose={() => setSheet(null)}
                    onHere={() => { writeStory(lineHereKey, true); setSheet(null); send({ here: true, text: sheet.text, confirmed: true }); }}
                    onSplit={() => isNew
                        ? setSheet({ type: 'episodes', intent: { action: 'create', kind: sheet.step.kind, title: sheet.step.title, text: sheet.text, contextMode: 'continued', historical: false } })
                        : splitLine(sheet.target, sheet.text)} />;
            })()}
            {sheet?.type === 'episodes' && <EpisodesSheet account={user.handle} scope={storyScope} characterName={character?.name}
                currentTitle={lineLabel} draft={draft} draftRevision={draftRevision.current} initialIntent={sheet.intent}
                currentRequest={[...all].reverse().find(message => message.is_user && !message.is_system)?.mes || ''}
                onBusyChange={setEpisodeBusy} notify={notify} onJump={showMessage}
                // A line made or renamed here shows as a mark in the 正文 at once: the story list is read again.
                onClose={() => { setSheet(null); reloadNumbers(); }}
                onSendHere={text => { setSheet(null); send({ here: true, text }); }}
                onCopied={(target, merged) => { if (target.avatar === route.avatar && target.file === chatFile) setDraft(merged); }}
                // Only a request taken from this input box clears it, and only while the box still holds those words.
                onSent={capture => {
                    if (!alive.current || capture.revision !== draftRevision.current || capture.text !== draftValue.current) return;
                    try { localStorage.removeItem(draftKey); setDraft(''); }
                    catch { notify('已保存；原来的草稿没能清掉，还在本机，别重复发送', 'info'); }
                }} />}
            {sheet?.type === 'personal' && <PersonalSheet user={user} scope={storyScope} initialRecord={sheet.record} notify={notify}
                onClose={() => setSheet(null)} onLocate={async source => {
                    if (source.groupId) {
                        const b = engine.getBridge();
                        if (!b?.revealPersonalSource) throw new Error('请先启动原版，再回到群聊出处');
                        await b.revealPersonalSource(source); setSheet(null); onNative(); return;
                    }
                    requestSourceJump(user.handle, source); setSheet(null);
                    if (source.avatar === route.avatar && source.file === chatFile) {
                        const requested = takeSourceJump(user.handle, storyScope);
                        const raw = synced ? engine.getBridge()?.personalConversation?.().messages : preview;
                        const found = locateSource(raw || [], requested);
                        if (!found?.current) throw new Error('原文已改动或无法定位');
                        showMessage(found.index);
                    } else go({ name: 'chat', avatar: source.avatar, file: source.file });
                }} />}
            {sheet?.type === 'delete' && (sheet.message.swipes > 1
                ? (
                    <Sheet title="删除" busy={!!sheetBusy && !sheetWaiting} onClose={closeSheet}>
                        <SheetItem label={`只删这个回复（第 ${sheet.message.swipe_id + 1}/${sheet.message.swipes} 个）`} hint="其他回复保留"
                            busy={sheetBusy === 'delete-swipe'} busyLabel="正在删除这个回复…" disabled={!!sheetBusy}
                            onClick={() => runHere('delete-swipe', b => b.deleteMessageAt(sheet.message.index, { swipeOnly: true }).then(() => notify('已删除这个回复', 'info')))} />
                        <SheetItem label="删除整条消息" hint={`${sheet.message.swipes} 个回复全部删掉`} danger
                            busy={sheetBusy === 'delete'} busyLabel="正在删除…" disabled={!!sheetBusy}
                            onClick={() => runHere('delete', b => b.deleteMessageAt(sheet.message.index).then(() => notify('已删除', 'info')))} />
                    </Sheet>
                )
                : (
                    <ConfirmSheet title="删除这条消息？" confirmLabel="删除" busyLabel="正在删除…" message="删掉就找不回来了，后面的内容不受影响"
                        onClose={() => setSheet(null)}
                        onConfirm={() => runHere('delete', b => b.deleteMessageAt(sheet.message.index).then(() => notify('已删除', 'info')))} />
                ))}
            {sheet?.type === 'regenerate' && (
                <ConfirmSheet title="重新生成？" confirmLabel="重新生成" onClose={() => setSheet(null)}
                    message={`会替换这条消息的全部 ${sheet.message.swipes} 个回复。想保留原来的，用右箭头「换个回复」`}
                    onConfirm={() => { setSheet(null); regenerateReply(); }} />
            )}
        </main>
    );
}
