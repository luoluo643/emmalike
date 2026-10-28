import { useEffect, useRef, useState } from 'preact/hooks';
import * as engine from './engine.js';
import { chatId, getCurrentUser } from './api.js';
import { EPISODE_NAMESPACE, sameLocator, validateEpisodeMeta } from './episode-model.js';
import { CONTEXT_MODES, EPISODE_KINDS, resolveNamedEpisode } from './episode-intent.js';
import { Sheet, SheetItem, Spinner, chapterLabel, friendlyError, go } from './ui.jsx';
import { readStory, storyKey, writeStory } from './story-state.js';
import { InlineEpisodesSection } from './inline-episodes.jsx';
import './episodes.css';

// A visual identity comes from the file header, never from its name or from an author/model keyword.
export function episodeIdentity(metadata, account) {
    const parsed = validateEpisodeMeta(metadata?.[EPISODE_NAMESPACE], account);
    if (parsed.kind === 'valid') return { kind: parsed.value.kind, title: parsed.value.title,
        type: EPISODE_KINDS[parsed.value.kind] || '正文', episode: parsed.value };
    return { kind: parsed.kind === 'absent' ? 'ordinary' : 'unconfirmed',
        type: parsed.kind === 'absent' ? '普通故事' : '来源没确认', episode: null };
}

export function storyIdentityLabel(chapter, characterName, numbers, account) {
    const identity = episodeIdentity(chapter?.chat_metadata, account);
    return `${identity.type} · ${identity.title || chapterLabel(chatId(chapter?.file_name), characterName, numbers)}`;
}

export function EpisodeTag({ metadata, account }) {
    const identity = episodeIdentity(metadata, account);
    return <span class="tl-tag tl-episode-tag" data-kind={identity.kind}>{identity.type}</span>;
}

export function EpisodeRenameSheet({ account, avatar, file, episode, withBridge, onClose, onChanged }) {
    const [title, setTitle] = useState(episode.title), [kind, setKind] = useState(episode.kind);
    const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState('');
    const lock = useRef(false), alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);
    const save = async () => {
        if (lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try {
            const result = await withBridge('改标题', b => {
                if (!b.renameEpisode) throw new Error('暂时改不了标题，刷新页面后再试');
                return b.renameEpisode({ account, avatar, file, title, kind, expectedTitle: episode.title });
            }, { quiet: true });
            if (!alive.current) return;
            if (result.kind !== 'confirmed') { setUncertain(true); setError('标题还没确认改好。点「检查一下」，不会重新生成'); }
            else { onChanged?.({ type: 'title', file }); onClose(); }
        } catch (e) { if (alive.current) setError(friendlyError(e.message)); }
        finally { lock.current = false; if (alive.current) setBusy(false); }
    };
    return <Sheet title="改标题" onClose={() => { if (!lock.current) onClose(); }} busy={busy}>
        <div class="tl-episode-section tl-episode-form">
            <label>标题<input class="tl-input" maxLength={100} value={title} disabled={busy || uncertain} onInput={e => setTitle(e.currentTarget.value)} /></label>
            <label>类型<select class="tl-input" value={kind} disabled={busy || uncertain} onChange={e => setKind(e.currentTarget.value)}>{Object.entries(EPISODE_KINDS).map(([value, label]) => <option value={value}>{label}</option>)}</select></label>
            <p class="tl-muted">只改标题和类型，内容不变</p>
            {error && <p class="tl-error" role="alert">{error}</p>}
            <button class="tl-button tl-primary" disabled={busy || !title.trim() || !uncertain && title === episode.title && kind === episode.kind} aria-busy={busy ? 'true' : undefined} onClick={save}>
                {busy ? <><Spinner />正在检查…</> : uncertain ? '检查一下' : '保存标题'}</button>
        </div>
    </Sheet>;
}

const stages = {
    captured: '记下了，还没建好这条线', 'source-confirmed': '正在建这条线…', 'create-armed': '不知道这条线建好没有',
    'create-unconfirmed': '不知道这条线建好没有', created: '这条线建好了，还没发送', 'continue-ready': '还没发送',
    'awaiting-review': '还没发送，等你确认', preparing: '正在准备这条线…（故事长的话要等一会儿）', pending: '正在发出…',
    'submit-armed': '发出时页面停了，不知道发出去没有', submitted: '已发出', accepted: 'AI 正在写…',
    generated: '写完了，还没核对保存', saving: '写完了，还没核对保存', 'save-unconfirmed': '写完了，还没核对上保存',
    confirmed: '已保存', conflict: '没发出：那条线或正文有变化', cancelled: '没发送', dismissed: '已移出', failed: '没完成',
};
// Stages shown as the send in progress; and those after the request may have reached the model.
const SENDING = new Set(['pending', 'submit-armed', 'submitted', 'accepted', 'generated', 'saving']);
const AFTER_SUBMIT = new Set(['submit-armed', 'accepted', 'generated', 'saving', 'save-unconfirmed']);
// Other extensions' state that a new line carries along, named for people rather than by its storage key.
const STATE_NAMES = [[/^horae/i, 'Horae 记忆与故事线'], [/^ooc_guard/i, '人设守护'], [/^variables$/, '变量'], [/^(note_|timedWorldInfo)/, '作者注释与世界书计时'],
    [/^persona$/, '身份锁定'], [/^(quickReply|qr)/i, '快捷回复'], [/^(tainted|lastInContextMessageId)$/, '酒馆自己的记录']];
export const stateNames = keys => [...new Set(keys.map(key => STATE_NAMES.find(([pattern]) => pattern.test(key))?.[1] ?? '其他扩展的记录'))];
// The reply being written, as a line of plain text: tags, comments and the thinking block are not the story.
const liveTail = text => String(text ?? '').replace(/<!--[\s\S]*?(-->|$)/g, '').replace(/<thinking>[\s\S]*?(<\/thinking>|$)/gi, '')
    .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(-80);
const cancellable = new Set(['captured', 'source-confirmed', 'created', 'continue-ready', 'awaiting-review']);
const sameFile = (a, b) => a?.avatar === b?.avatar && chatId(a?.file) === chatId(b?.file);
const operationTarget = op => op?.resolvedLocator || op?.target?.locator;

/** Merge only the author's request. A storage failure must not be presented as a successful copy. */
export async function copyEpisodeRequest(account, target, text) {
    if (!text || !target?.avatar || !target?.file) throw new Error('信息不全，没有复制');
    const current = await getCurrentUser();
    if (current?.handle !== account) throw new Error('换了账号，没有复制');
    const key = storyKey('draft', account, target.avatar, target.file);
    const stored = localStorage.getItem(key);
    const existing = stored === null ? '' : JSON.parse(stored);
    if (typeof existing !== 'string') throw new Error('那边的草稿格式不对，没有覆盖');
    const merged = [existing, text].filter(Boolean).join('\n\n');
    localStorage.setItem(key, JSON.stringify(merged));
    return merged;
}

function siblings(graph, scope, account) {
    const here = graph?.nodes?.find(node => sameFile(node.locator, scope));
    if (here?.episode?.kind !== 'root' && here?.episode) return (graph.nodes || []).filter(node =>
        node.relationship === 'resolved' && node.episode.rootId === here.episode.rootId && node.episode.kind !== 'root');
    return (graph?.nodes || []).filter(node => node.relationship === 'resolved' && node.episode.kind !== 'root' &&
        sameLocator(node.rootLocator, { account, ...scope }));
}

// What the form holds for one story until it is sent: the request, title, kind and whether to bring the 正文.
const FORM_FIELDS = ['request', 'title', 'titleTyped', 'kind', 'contextMode', 'carryVariables'];
const autoTitle = text => text.trim().replace(/\s+/g, ' ').slice(0, 36);
export function readEpisodeForm(account, scope) {
    const value = readStory(storyKey('episode-form', account, scope?.avatar, scope?.file));
    return value && typeof value === 'object' && typeof value.request === 'string' ? value : null;
}
export function writeEpisodeForm(account, scope, form) {
    const key = storyKey('episode-form', account, scope?.avatar, scope?.file);
    const empty = !form.request.trim() && !form.titleTyped;
    writeStory(key, empty ? null : Object.fromEntries(FORM_FIELDS.map(k => [k, form[k]])));
}

/**
 * One entry for creation, continuation, navigation, correction and durable recovery. The request is the sheet's own,
 * kept per story with the rest of the form: writing it never changes the story's input box. It starts from the input
 * box only when the input was what asked for a line (`initialIntent`) or when the author takes it from there; then a
 * confirmed send clears the input, if it still holds that text (`onSent`).
 */
export function EpisodesSheet({ account, scope, characterName, currentTitle, draft, draftRevision,
    initialIntent, currentRequest, onClose, onSent, onCopied, onBusyChange, onJump, onSendHere, notify }) {
    const bridge = engine.getBridge();
    const mounted = useRef(true), lock = useRef(false), job = useRef(null);
    const [saved] = useState(() => readEpisodeForm(account, scope));
    const fromInput = useRef(initialIntent && draft.trim() ? { text: draft, revision: draftRevision } : null);
    const [request, setRequestValue] = useState(fromInput.current ? draft : saved?.request ?? '');
    const requestRevision = useRef(0), requestValue = useRef(request);
    const [status, setStatus] = useState(() => bridge?.episodeStatus?.() || { enabled: false, verified: false, reasons: ['还没准备好'], contextModes: [] });
    const [graph, setGraph] = useState(null), [unfinished, setUnfinished] = useState([]);
    const [mode, setMode] = useState(initialIntent?.action === 'create' ? 'create' : initialIntent ? 'continue' : 'list');
    const [kind, setKind] = useState(initialIntent?.kind || saved?.kind || 'side');
    const [titleTyped, setTitleTyped] = useState(!!initialIntent?.title || !initialIntent && !!saved?.titleTyped);
    const [title, setTitle] = useState(initialIntent?.title || (!initialIntent && saved?.titleTyped ? saved.title : autoTitle(request)));
    const [contextMode, setContextMode] = useState(initialIntent?.action === 'create' ? initialIntent.contextMode
        : initialIntent ? 'continued' : saved?.contextMode ?? 'continued');
    const [selection, setSelection] = useState(null), [query, setQuery] = useState('');
    const [prepared, setPrepared] = useState(null), [recovery, setRecovery] = useState(null);
    const [busy, setBusy] = useState(false), [stage, setStage] = useState(''), [error, setError] = useState('');
    const [copying, setCopying] = useState(null), [carryVariables, setCarryVariables] = useState(!initialIntent && !!saved?.carryVariables);
    const [moreOpen, setMoreOpen] = useState(false), [tick, setTick] = useState(Date.now()), [live, setLive] = useState('');
    const sentAt = useRef(0);
    const captured = useRef(null);
    const current = graph?.nodes?.find(node => sameFile(node.locator, scope));
    const isChild = !!current?.episode && current.episode.kind !== 'root';
    const candidates = siblings(graph, scope, account);
    const available = status.enabled && status.verified && !!bridge?.prepareEpisode;
    const currentOperation = recovery?.operation || prepared?.operation;
    const target = recovery?.target || recovery?.file?.locator || prepared?.target || operationTarget(currentOperation);
    const visibleStage = stage || currentOperation?.stage;
    const availableModes = status.contextModes || [];
    const labelFor = node => `${EPISODE_KINDS[node.episode?.kind] || '正文'} · ${node.episode?.title || node.locator.file}${node.nativeCopyOf ? '（走向）' : ''}`;
    const variableCount = sameFile(bridge?.currentChat?.(), scope) ? bridge?.storyVariables?.() ?? 0 : 0;
    // Words taken from the input box stay its words when edited here: the send still clears them from the box.
    const setRequest = (value, source = fromInput.current) => {
        if (value !== requestValue.current) requestRevision.current++;
        requestValue.current = value; setRequestValue(value);
        fromInput.current = source;
        if (!titleTyped) setTitle(autoTitle(value));
        remember({ request: value, ...titleTyped ? {} : { title: autoTitle(value) } });
    };
    const assertDraft = (revision, text) => mounted.current && revision === requestRevision.current && text === requestValue.current;
    // Closing the sheet, leaving the page or switching stories keeps what was written and chosen here: each change
    // is stored as it is made, not after the next render.
    const form = useRef({ request, title, titleTyped, kind, contextMode, carryVariables });
    const remember = patch => { Object.assign(form.current, patch); writeEpisodeForm(account, scope, form.current); };

    useEffect(() => () => { mounted.current = false; job.current?.cancel?.(); onBusyChange?.(false); }, []);
    // The check of other extensions finishes a few seconds after the page loads.
    useEffect(() => engine.onEngine(type => { if (type === 'episodes-changed' && mounted.current && bridge?.episodeStatus) setStatus(bridge.episodeStatus()); }), []);
    const assertBridge = () => {
        if (!mounted.current || engine.getBridge() !== bridge) throw new Error('页面或账号变了，请重新打开');
    };
    const load = async () => {
        if (!bridge?.episodeIndex) return;
        const [index, operations] = await Promise.all([bridge.episodeIndex(scope.avatar), bridge.unfinishedEpisodes()]);
        assertBridge();
        setGraph(index); setUnfinished(operations.filter(op => op.account === account));
        setStatus(bridge.episodeStatus());
        return { index, operations };
    };
    useEffect(() => {
        load().then(data => {
            if (!data || !initialIntent || initialIntent.action === 'create') return;
            const nodes = siblings(data.index, scope, account);
            const resolved = resolveNamedEpisode(initialIntent, nodes, nodes[0]?.episode.rootId);
            if (resolved.kind === 'unique') setSelection(resolved.candidate);
        }).catch(e => mounted.current && setError(friendlyError(e.message)));
        // A send left half-way (the page was stopped) is settled by looking at its line; only what is still unclear stays listed.
        bridge?.settleEpisodes?.().then(settled => {
            if (!mounted.current || !settled.length) return;
            notify?.(`上次没核对完的 ${settled.length} 次发送，回复已经在那条线里了`, 'info');
            load().catch(() => {});
        }).catch(() => {});
    }, []);
    // While sending: the clock, and the last words of the reply being written in the line.
    const sendingNow = mode === 'review' && SENDING.has(stage);
    useEffect(() => {
        if (!sendingNow) return;
        const timer = setInterval(() => { setTick(Date.now()); try { setLive(liveTail(bridge?.episodeLiveText?.())); } catch { /* Preview only. */ } }, 1000);
        return () => clearInterval(timer);
    }, [sendingNow]);
    // A busy sheet owns the existing modal/back layer; closing never submits or retries anything.
    const close = async () => {
        if (lock.current) return;
        const alignOrClose = async () => {
            const actual = bridge?.currentChat?.();
            if (actual?.avatar && actual?.file && !sameFile(actual, scope)) {
                await bridge.openEpisode({ account, avatar: actual.avatar, file: actual.file }); assertBridge();
                go({ name: 'chat', avatar: actual.avatar, file: actual.file });
            } else onClose();
        };
        if (prepared?.operation && cancellable.has(prepared.operation.stage) && !recovery) {
            await act(async () => { await bridge.cancelEpisode({ account, operationId: prepared.operation.operationId }); assertBridge(); await alignOrClose(); });
        } else await act(alignOrClose);
    };
    const act = async action => {
        if (lock.current) return;
        lock.current = true; setBusy(true); setError(''); onBusyChange?.(true);
        try { assertBridge(); await action(); }
        catch (e) { if (mounted.current) setError(friendlyError(e.message) || '操作没完成，去「需要你看一下」里看看'); }
        finally { lock.current = false; if (mounted.current) { setBusy(false); onBusyChange?.(false); } }
    };
    const open = locator => act(async () => {
        await bridge.openEpisode({ account, avatar: locator.avatar, file: locator.file }); assertBridge();
        go({ name: 'chat', avatar: locator.avatar, file: locator.file });
    });
    const prepare = () => act(async () => {
        const capture = { text: request, revision: requestRevision.current, input: fromInput.current };
        if (!capture.text.trim()) throw new Error('先写下这条线的开场要求');
        if (!assertDraft(capture.revision, capture.text)) throw new Error('草稿变了，请再看一遍');
        // An uncertain previous attempt is inspected, never retried as another creation.
        const existing = await bridge.unfinishedEpisodes(); assertBridge();
        const duplicate = existing.find(op => op.account === account && sameFile(op.source?.locator, scope) && op.capturedText === capture.text);
        if (duplicate) { setRecovery({ operation: duplicate }); setStage(duplicate.stage); setMode('recovery'); return; }
        captured.current = capture; setStage('preparing');
        const input = { account, scope, text: capture.text, draftRevision: capture.revision,
            assertDraft: () => assertDraft(capture.revision, capture.text) };
        const result = mode === 'continue'
            ? await bridge.prepareEpisodeContinuation({ ...input, target: selection.locator })
            : await bridge.prepareEpisode({ ...input, kind, title, contextMode, carryVariables: contextMode === 'fresh' && carryVariables });
        assertBridge();
        if (!result.reviewReceipt || !result.target) {
            setRecovery(result); setMode('recovery'); setStage(result.operation?.stage || 'create-unconfirmed');
        } else { setPrepared(result); setRecovery(null); setMode('review'); setStage('awaiting-review'); }
    });
    const send = () => act(async () => {
        const capture = captured.current;
        if (!capture || !assertDraft(capture.revision, capture.text)) throw new Error('草稿变了，没有发送。点「先不发」后重新确认一次');
        sentAt.current = Date.now(); setTick(sentAt.current); setLive('');
        setStage('pending');
        const promise = bridge.sendEpisode({ account, operationId: prepared.operation.operationId, reviewReceipt: prepared.reviewReceipt,
            assertDraft: () => assertDraft(capture.revision, capture.text),
            onState: state => { if (mounted.current) { setStage(state.stage); if (state.operation) setPrepared(p => ({ ...p, operation: state.operation })); if (state.error) setError(state.error); } } });
        job.current = promise;
        try {
            const result = await promise; assertBridge();
            if (result.kind === 'confirmed') {
                if (!capture.preserve) {
                    writeStory(storyKey('episode-form', account, scope.avatar, scope.file), null);
                    if (capture.input) onSent?.(capture.input, result.target);
                }
                notify?.('已保存', 'info');
                go({ name: 'chat', avatar: result.target.avatar, file: result.target.file });
            } else { setRecovery(result); setMode('recovery'); setStage(result.operation?.stage || 'save-unconfirmed'); }
        } catch (e) {
            if (mounted.current) {
                const operations = await bridge.unfinishedEpisodes().catch(() => []);
                const operation = operations.find(op => op.operationId === prepared.operation.operationId);
                setRecovery({ operation: operation || prepared.operation, target: prepared.target }); setMode('recovery');
            }
            throw e;
        } finally { job.current = null; }
    });
    const recover = operation => act(async () => {
        const result = await bridge.recoverEpisode({ account, operationId: operation.operationId }); assertBridge();
        setRecovery({ ...result, operation: result.operation || operation }); setPrepared(null); setMode('recovery'); setStage(result.operation?.stage || operation.stage);
        // This action does not use a returned receipt to send. Recovery always requires a fresh explicit workflow.
    });
    const saveAgain = () => act(async () => {
        const result = await bridge.confirmEpisodeSave({ account, operationId: currentOperation.operationId }); assertBridge();
        setRecovery(result); setStage(result.operation?.stage || 'save-unconfirmed');
        if (result.kind === 'confirmed') { notify?.('已确认保存，没有重新生成', 'info'); await load(); }
    });
    const reviewRecovered = () => act(async () => {
        if (!sameFile(currentOperation.source?.locator, scope)) throw new Error('先回到原来的故事，再重新确认发送。草稿会保留');
        if (!bridge.reviewRecoveredEpisode) throw new Error('暂时没法重新确认，刷新页面后再试');
        // A revision is local to this page. After recovery it cannot prove that same-looking text is the original
        // request, so what is written now is always retained; the journal supplies the author request.
        const capture = { text: request, revision: requestRevision.current, preserve: true };
        const result = await bridge.reviewRecoveredEpisode({ account, operationId: currentOperation.operationId,
            assertDraft: () => assertDraft(capture.revision, capture.text) });
        assertBridge();
        if (!result.reviewReceipt || !result.target) throw new Error('还没确认发到哪条线，没有发送');
        captured.current = capture; setPrepared(result); setRecovery(null); setMode('review'); setStage('awaiting-review');
    });
    const restore = operation => act(async () => {
        const destination = operation.source?.locator;
        const text = await copyEpisodeRequest(account, destination, operation.capturedText); assertBridge();
        if (sameFile(destination, scope)) onCopied?.(destination, text);
        // The request is in the input box now: a form still holding the same words would make a second copy.
        if (readEpisodeForm(account, destination)?.request.trim() === operation.capturedText?.trim()) writeStory(storyKey('episode-form', account, destination.avatar, destination.file), null);
        if (cancellable.has(operation.stage)) await bridge.cancelEpisode({ account, operationId: operation.operationId });
        assertBridge(); setStage('cancelled'); setRecovery({ operation: { ...operation, stage: 'cancelled' }, target: operationTarget(operation) });
        notify?.('已放回原来故事的输入框，没有发送', 'info'); await load();
    });
    const dismiss = operation => act(async () => {
        await bridge.dismissEpisode({ account, operationId: operation.operationId }); assertBridge();
        notify?.('已移出，故事里的内容都没动', 'info');
        setMode('list'); setRecovery(null); setPrepared(null); setStage(''); await load();
    });
    const copyTo = locator => act(async () => {
        const text = await copyEpisodeRequest(account, locator, copying); assertBridge();
        if (sameFile(locator, scope)) onCopied?.(locator, text);
        setCopying(null); notify?.('已放进那个故事的输入框，原来的内容还在', 'info');
    });
    const filtered = candidates.filter(node => `${node.episode.title} ${node.episode.openingRequest || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const copyTargets = [...(graph?.roots || []), ...(graph?.nodes || []), ...(graph?.ordinaryChats || [])]
        .filter((node, index, all) => all.findIndex(other => sameFile(node.locator, other.locator)) === index && node.locator.account === account);
    const here = current?.episode ? labelFor(current) : currentTitle || '普通故事';
    const rootReady = isChild && current.relationship === 'resolved' && !!current.rootLocator;
    // Where a line leaves the 正文 (the message it copied up to, or the part split out).
    const forkPlace = node => {
        const e = node.episode, at = e?.sourceAnchor?.anchor?.index;
        if (e?.extractedFrom) return `第 ${e.extractedFrom.from}～${e.extractedFrom.to} 楼拆出`;
        if (Number.isSafeInteger(at)) return e.contextMode === 'fresh' ? `第 ${at} 楼处新开，没带正文` : `第 ${at} 楼后分出`;
        return CONTEXT_MODES[e?.contextMode] || '';
    };
    const sending = mode === 'review' && SENDING.has(visibleStage);
    const operationLabel = op => `${EPISODE_KINDS[op.kind] || '番外'} · ${op.title}`;
    const settledBefore = op => AFTER_SUBMIT.has(op.stage) || op.stage === 'conflict';
    const reviewSummary = () => {
        const op = prepared.operation, made = op.action === 'continue' ? '接着这条线写'
            : `这条${EPISODE_KINDS[op.kind] || '番外'}已经建好${prepared.contextMode === 'fresh' ? '（没带正文消息）' : '，带上了正文到现在的内容'}`;
        return `${made}。点「发送」后在那里发出下面这句，AI 写完会打开那条线${op.action === 'continue' ? '' : `；「${currentTitle || '正文'}」本身不变`}。`;
    };
    const stepState = index => {
        const at = ['pending', 'submit-armed', 'submitted'].includes(visibleStage) ? 0 : visibleStage === 'accepted' ? 1 : 2;
        return index < at ? 'done' : index === at ? 'now' : 'later';
    };
    const seconds = Math.max(0, Math.floor((tick - (sentAt.current || tick)) / 1000));
    const waited = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

    return <Sheet title={sending ? '正在发送' : mode === 'review' ? '确认发送' : mode === 'recovery' ? '需要看一下' : '番外与平行线'} onClose={close}
        busy={busy} className="tl-episodes-sheet" bodyClassName="tl-episodes-body">
        {(mode === 'list' || error || busy && !sending) && <div class="tl-episode-heading">
            {mode === 'list' && <div class="tl-episode-here">
                <p>你在：<strong>{here}</strong></p>
            </div>}
            {mode === 'list' && isChild && current.relationship !== 'resolved' && <p class="tl-muted">{current.relationship === 'ambiguous' ? '有重复的记录' : '原故事找不到或还没确认'}，不会跳到名字相似的故事。</p>}
            {error && <p class="tl-error" role="alert">{error}</p>}
            {busy && !sending && <p role="status"><Spinner />{stages[visibleStage] || '正在检查…'}</p>}
        </div>}
        {copying !== null ? <section class="tl-episode-section">
            <h3>把请求放进别的故事</h3><p class="tl-muted">只放进那个故事的输入框，不自动发送</p>
            {copyTargets.map(node => <SheetItem key={node.locator.file} disabled={busy} label={node.episode ? labelFor(node) : `普通故事 · ${node.locator.file}`} onClick={() => copyTo(node.locator)} />)}
            <button class="tl-button" disabled={busy} onClick={() => setCopying(null)}>取消复制</button>
        </section> : <>
            {mode === 'list' && unfinished.length > 0 && <section class="tl-episode-section tl-episode-attention"><h3>需要你看一下</h3>
                {unfinished.map(op => <div class="tl-episode-list-row" key={op.operationId}>
                    <SheetItem label={operationLabel(op)} hint={stages[op.stage] || op.stage} disabled={busy}
                        onClick={() => { setRecovery({ operation: op }); setStage(op.stage); setMode('recovery'); }} />
                    {settledBefore(op) && bridge?.dismissEpisode && <button class="tl-button" disabled={busy} onClick={() => dismiss(op)}>移出</button>}
                </div>)}
            </section>}
            {mode === 'list' && <>
                {/* The 正文 and the lines copied from it, as a main story and its branches: each a separate story, one tap away. */}
                <section class="tl-episode-section tl-episode-tree"><h3>正文与番外、平行线</h3>
                    {graph === null && <p class="tl-muted">正在加载…</p>}
                    {graph && !graph.complete && <p class="tl-muted">有些故事还没读到，列表可能不全</p>}
                    {candidates.length > 5 && <input class="tl-input" type="search" aria-label="搜索标题" placeholder="搜索标题" value={query} onInput={e => setQuery(e.currentTarget.value)} />}
                    <div class="tl-episode-list-row" data-depth="0">
                        <SheetItem label="正文" hint={isChild ? '这些线是从它分出来的' : here} current={!isChild} disabled={busy || !isChild || !rootReady}
                            onClick={() => open(current.rootLocator)} />
                        {isChild && <button class="tl-button" disabled={busy || !rootReady} onClick={() => open(current.rootLocator)}>回正文</button>}
                    </div>
                    {filtered.map(node => {
                        const reading = sameFile(node.locator, scope);
                        return <div class="tl-episode-list-row" data-depth="1" key={node.locator.file}>
                            <SheetItem label={labelFor(node)} current={reading} disabled={busy || reading}
                                hint={[forkPlace(node), node.episode.openingRequest?.slice(0, 60)].filter(Boolean).join(' · ')}
                                onClick={() => open(node.locator)} />
                            {!reading && <button class="tl-button" disabled={busy} onClick={() => open(node.locator)}>打开</button>}
                        </div>;
                    })}
                    {graph && !candidates.length && <p class="tl-muted">还没有番外或平行线</p>}
                    {graph && !!candidates.length && !filtered.length && <p class="tl-muted">没找到</p>}
                    {isChild ? <p class="tl-muted">要接着这条线写，直接在下面输入框里写；要新开一条，先回正文</p> : <>
                        <button class="tl-button tl-primary" disabled={!available || busy || !scope.file || !graph?.complete} onClick={() => setMode('create')}>＋ 新开番外 / 平行线 / 小剧场</button>
                        {!available && <p class="tl-muted">{status.enabled ? '现在不能分开写，原因在下面「更多」里' : '「分开写番外与平行线」关着，在下面「更多」里打开'}</p>}
                    </>}
                </section>
                {!isChild && <InlineEpisodesSection account={account} scope={scope} available={status.enabled && (status.extractable ?? status.verified) && !!bridge?.extractEpisode}
                    reasons={status.extractReasons ?? status.reasons} busy={busy} notify={notify}
                    onBusy={value => { setBusy(value); onBusyChange?.(value); }} onJump={onJump} onExtracted={() => load().catch(e => setError(friendlyError(e.message)))} />}
                <section class="tl-episode-section"><details class="tl-more-fields" open={moreOpen || undefined} onToggle={e => setMoreOpen(e.currentTarget.open)}>
                    <summary>更多</summary>
                    {currentRequest && <button class="tl-button" disabled={busy} onClick={() => setCopying(currentRequest)}>把最近一句请求放进别的故事</button>}
                    {(graph?.nodes || []).some(node => node.relationship !== 'resolved') && <>
                        <h3>没确认来源的番外与平行线</h3><p class="tl-muted">还能单独读，但不会和正文关联</p>
                        {(graph.nodes || []).filter(node => node.relationship !== 'resolved').map(node => <SheetItem key={node.locator.file}
                            label={labelFor(node)} hint={node.relationship === 'ambiguous' ? '记录重复' : '来源没确认'} disabled={busy} onClick={() => open(node.locator)} />)}
                    </>}
                    <label class="tl-episode-switch"><input type="checkbox" checked={status.enabled} disabled={busy || !bridge?.setEpisodeEnabled}
                        onChange={e => { try { setStatus(bridge.setEpisodeEnabled(e.currentTarget.checked)); } catch (err) { setError(friendlyError(err.message) || '设置没存上'); } }} />分开写番外与平行线</label>
                    <p class="tl-muted">打开时，新开的番外与平行线各是一个故事，和正文分开存</p>
                    {!status.enabled && <p class="tl-muted">已关闭，写好的番外与平行线都还在</p>}
                    {!status.verified && <div class="tl-muted tl-episode-limit" role="note">
                        <p>现在不会自动分开写：请求照常发在当前故事里，写好的照样能看、跳转和拆出来</p>
                        <p>原因：{status.reasons.join('；')}。</p>
                        {!!status.recordWriters?.length && <p>这些扩展在你切换故事时可能还在后台写入，手动分开写也不保证和正文完全分开</p>}
                    </div>}
                    {status.verified && !!status.warnings?.length && <p class="tl-muted tl-episode-limit" role="note">{status.warnings.join('；')}。</p>}
                </details></section>
            </>}
            {(mode === 'create' || mode === 'continue') && <section class="tl-episode-section tl-episode-form">
                <button class="tl-link" disabled={busy} onClick={() => setMode('list')}>返回列表</button>
                {mode === 'continue' ? <>
                    <h3>接着写已有的线</h3><p class="tl-muted">接着写选中的那条，不新建，也不重新复制正文</p>
                    {!selection && <p>请选一条{initialIntent?.title ? `：「${initialIntent.title}」有不止一个` : ''}。</p>}
                    <div class="tl-episode-options" role="radiogroup" aria-label="接着写哪条">
                        {candidates.map(node => <button class="tl-button" role="radio" aria-checked={sameFile(selection?.locator, node.locator)} disabled={busy}
                            onClick={() => setSelection(node)}>{labelFor(node)}</button>)}
                    </div>
                    {selection && <p class="tl-episode-destination">发到：{labelFor(selection)}</p>}
                </> : <>
                    {isChild && <p class="tl-error">这已经是一条番外或平行线，不能在里面再开。回正文再新开</p>}
                    <label>类型<select class="tl-input" disabled={busy} value={kind} onChange={e => { setKind(e.currentTarget.value); remember({ kind: e.currentTarget.value }); }}>{Object.entries(EPISODE_KINDS).map(([value, label]) => <option value={value}>{label}</option>)}</select></label>
                    <label>标题<input class="tl-input" maxLength={100} disabled={busy} value={title} onInput={e => { const value = e.currentTarget.value; setTitle(value); setTitleTyped(!!value.trim()); remember({ title: value, titleTyped: !!value.trim() }); }} /></label>
                    {initialIntent?.historical && <p class="tl-muted">没法回到过去某一刻的状态。可以接着最新进度写，或不带正文新开</p>}
                    {contextMode === null && <p>换了世界，要不要带上正文？选一个</p>}
                    <div class="tl-episode-options" role="radiogroup" aria-label="要不要带上正文">
                        {Object.entries(CONTEXT_MODES).map(([value, label]) => <button class="tl-button" role="radio" aria-checked={contextMode === value}
                            disabled={busy || !availableModes.includes(value)} onClick={() => { setContextMode(value); remember({ contextMode: value }); }}>{label}</button>)}
                    </div>
                    <p class="tl-muted">{contextMode === 'fresh' ? '不带正文消息；角色卡、开场白和世界书照常用' : '接着现在的进度写；正文之后的新进展不会自动带过来'}</p>
                    {contextMode === 'fresh' && variableCount > 0 && <label class="tl-episode-switch"><input type="checkbox" checked={carryVariables} disabled={busy}
                        onChange={e => { setCarryVariables(e.currentTarget.checked); remember({ carryVariables: e.currentTarget.checked }); }} />带上这个故事的变量（{variableCount} 个，状态栏、MVU 这类卡片用）</label>}
                </>}
                <label>开场或续写要求<textarea class="tl-input tl-episode-request" disabled={busy} value={request} onInput={e => setRequest(e.currentTarget.value)} /></label>
                {!request.trim() && draft.trim() && <button class="tl-link" disabled={busy} onClick={() => setRequest(draft, { text: draft, revision: draftRevision })}>用输入框里写的</button>}
                <p class="tl-muted">{saved && !initialIntent && saved.request.trim() ? '上次在这里写的还在，没发出去。' : ''}这里写的单独保存，不会改故事的输入框</p>
                <button class="tl-button tl-primary" disabled={busy || !available || !graph?.complete || !request.trim() || (mode === 'continue' ? !selection : isChild || !contextMode || !title.trim())} onClick={prepare}>下一步：确认发送</button>
                <p class="tl-muted">下一步会显示发到哪条线，现在还不会让 AI 写</p>
                {initialIntent && onSendHere && <button class="tl-link" disabled={busy || !request.trim()} onClick={() => onSendHere(request)}>还是发在当前故事里</button>}
            </section>}
            {mode === 'review' && prepared && !sending && <section class="tl-episode-section">
                <p class="tl-episode-destination">发到：{prepared.label}</p>
                <p>{reviewSummary()}</p>
                <blockquote class="tl-episode-request-preview">{prepared.operation.capturedText}</blockquote>
                {captured.current?.preserve && <p class="tl-muted">这是上次没发出的请求，输入框里现在的草稿会保留</p>}
                {!!prepared.carriedMetadataKeys?.length && <details class="tl-more-fields"><summary>详细</summary>
                    <p class="tl-muted">一起带过去的扩展记录：{stateNames(prepared.carriedMetadataKeys).join('、')}</p>
                </details>}
                <div class="tl-row"><button class="tl-button tl-primary" disabled={busy || !available} onClick={send}>发送</button>
                    <button class="tl-button" disabled={busy} onClick={close}>先不发</button></div>
            </section>}
            {sending && prepared && <section class="tl-episode-section tl-episode-progress" role="status">
                <p class="tl-episode-destination">发到：{prepared.label}</p>
                <ol class="tl-episode-steps">
                    {['发出', `AI 写${visibleStage === 'accepted' ? ` · 已等 ${waited}` : ''}`, '核对保存，打开这条线'].map((text, index) =>
                        <li key={index} data-state={stepState(index)}>{stepState(index) === 'now' && <Spinner />}{text}</li>)}
                </ol>
                {visibleStage === 'accepted' && live && <p class="tl-episode-live" aria-hidden="true">…{live}</p>}
                <p class="tl-muted">{visibleStage === 'accepted' ? '写的时候别切到别的应用：手机可能会停掉页面，中断这次生成'
                    : stepState(2) === 'now' ? '写完了，正在核对，马上打开' : '正在发出…'}</p>
                <div class="tl-row"><button class="tl-button" disabled={!['pending', 'preparing'].includes(stage)} onClick={() => {
                    // It sits where 发送 was: the second tap of a double tap must not cancel what the first one sent.
                    if (Date.now() - sentAt.current < 800) return;
                    if (job.current) { if (!job.current.cancel?.()) setError('已经发出，撤不回了，等它保存好'); } else close();
                }}>{['pending', 'preparing'].includes(stage) ? '先不发' : '已发出，撤不回'}</button></div>
            </section>}
            {mode === 'recovery' && currentOperation && <section class="tl-episode-section">
                <h3>{operationLabel(currentOperation)}</h3>
                <p role="status">{stages[visibleStage] || visibleStage}</p>
                {currentOperation.error && <p class="tl-error" role="alert">{friendlyError(typeof currentOperation.error === 'string' ? currentOperation.error : currentOperation.error.message)}</p>}
                <blockquote class="tl-episode-request-preview">{currentOperation.capturedText}</blockquote>
                <p class="tl-muted">检查和补存都不会让 AI 重写</p>
                <div class="tl-row tl-episode-actions">
                    {target && <button class={`tl-button${settledBefore(currentOperation) ? ' tl-primary' : ''}`} disabled={busy} onClick={() => open(target)}>打开那条线</button>}
                    {['created', 'awaiting-review'].includes(currentOperation.stage) && <button class="tl-button tl-primary" disabled={busy || !available} onClick={reviewRecovered}>重新确认发送</button>}
                    <button class="tl-button" disabled={busy} onClick={() => recover(currentOperation)}>再检查一次</button>
                    {currentOperation.saveIntent && ['saving', 'save-unconfirmed'].includes(currentOperation.stage) && <button class="tl-button" disabled={busy} onClick={saveAgain}>补存</button>}
                    {cancellable.has(currentOperation.stage) && <button class="tl-button" disabled={busy} onClick={() => restore(currentOperation)}>取消，把文字放回原来的输入框</button>}
                    {settledBefore(currentOperation) && bridge?.dismissEpisode && <button class="tl-button" disabled={busy} onClick={() => dismiss(currentOperation)}>看过了，移出列表</button>}
                    {currentOperation.source?.locator && !sameFile(currentOperation.source.locator, scope) && <button class="tl-button" disabled={busy} onClick={() => open(currentOperation.source.locator)}>回到原来的故事</button>}
                    <button class="tl-button" disabled={busy} onClick={() => setCopying(currentOperation.capturedText)}>把请求放进别的故事</button>
                </div>
                <button class="tl-link" disabled={busy} onClick={() => { setMode('list'); setRecovery(null); setPrepared(null); setStage(''); load().catch(e => setError(friendlyError(e.message))); }}>返回列表</button>
            </section>}
        </>}
    </Sheet>;
}
