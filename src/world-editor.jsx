// World books in plain words: the list of books, one book's entries, and one entry's settings. Loaded only when opened.
// Every read and write goes through the full app (bridge.js), so its cache and its own editor stay in step.
import { createContext } from 'preact';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import * as engine from './engine.js';
import { ConfirmSheet, EngineStatus, PageHeader, PromptSheet, Sheet, friendlyError, go, goBack, useBackLayer } from './ui.jsx';
import { cloneJson } from './episode-model.js';
import { WORLD_DECISION_ACK, WORLD_ENTRY_FIELDS, WORLD_FIELD_LABELS, hasWorldUserDecision, isBlockingWorldOperation, worldChanges, worldSearch, worldFingerprint, refreshWorldDraft, applySavedWorldDraft } from './world-editor-model.js';
import './world-editor.css';
import { createWorldDraftStore } from './world-editor-drafts.js';

const editorDrafts = createWorldDraftStore(), bookViews = new Map(), fieldContext = createContext(null);
// Saves whose result this page never saw are checked once per visit on their own; the check only reads the server.
const autoChecked = new Set();
const pendingResult = result => result.operation && isBlockingWorldOperation(result.operation) ? result.operation : null;
const entryScope = (account, book, uid) => JSON.stringify([account, book, uid ?? 'new']);
const scopeText = sources => [sources?.global ? '所有故事的全局关联' : '', sources?.characters?.length ? `角色：${sources.characters.join('、')}` : '',
    sources?.currentChat ? '当前聊天的关联' : '', sources?.persona ? '当前用户人设的关联' : '', '别的聊天或扩展也可能在用，没法列全'].filter(Boolean).join('；');
function ScopeNotice({ sources }) { return <p class="tl-world-scope">当前关联：{scopeText(sources)}。改共享世界书会影响用到它的故事。{sources?.identityWarning ? ` ${sources.identityWarning}` : ''}</p>; }
const fieldKeys = { comment: 'comment', content: 'content', keys: 'key', secondary: 'keysecondary', position: 'position', depth: 'depth', role: 'role', order: 'order',
    logic: 'selectiveLogic', probability: 'probability', group: 'group', weight: 'groupWeight', sticky: 'sticky', cooldown: 'cooldown', delay: 'delay', scan: 'scanDepth', case: 'caseSensitive', whole: 'matchWholeWords' };
const fieldIds = Object.fromEntries(Object.entries(fieldKeys).map(([id, key]) => [key, `tl-wi-${id}`]));

function OperationDecision({ operation, bridge, disabled, onResolved, onStatus, onBusy = () => {} }) {
    const [preview, setPreview] = useState(null), [busy, setBusy] = useState(false);
    const run = async callback => { setBusy(true); onBusy(true); try { await callback(); }
        catch (error) { if (hasWorldUserDecision(error.detail?.operation)) onResolved({ kind: 'user-resolved', operation: error.detail.operation, runtimeState: 'conflict' }); onStatus(error.message); }
        finally { setBusy(false); onBusy(false); } };
    if (!operation || hasWorldUserDecision(operation) || !bridge?.prepareWorldOperationDecision) return null;
    return <><button class="tl-button" disabled={disabled || busy} onClick={() => run(async () => {
        setPreview(await bridge.prepareWorldOperationDecision({ account: operation.account, operationId: operation.operationId }));
    })}>结束这次等待，继续编辑</button>
        {preview && <Sheet title="结束等待，继续编辑" onClose={() => setPreview(null)}>
            <p>这次还不知道存没存上。不等了也不会取消刚才的保存，它可能晚到并盖掉之后存的内容；发现酒馆里的版本变了会提醒你并暂停发送。原稿和保存记录都留着</p>
            <p>酒馆里现在的「{operation.name}」：{preview.basis.kind === 'missing' ? '不存在。' : `有 ${Object.keys(preview.snapshot.entries).length} 条条目。`}</p>
            {preview.basis.kind === 'present' && operation.uid !== undefined && (preview.snapshot.entries[operation.uid]
                ? <><p>这次改的是「{entryTitle(preview.snapshot.entries[operation.uid])}」</p><label>酒馆里现在的内容<textarea class="tl-input" rows={6} readOnly value={preview.snapshot.entries[operation.uid].content ?? ''} /></label></>
                : <p>这次改的「{entryTitle(operation.expectedBook?.entries?.[operation.uid] ?? {})}」在酒馆里已经没有了。</p>)}
            <div class="tl-row"><button class="tl-button tl-primary" onClick={() => { const input = preview; setPreview(null); run(async () => {
                const result = await bridge.resolveWorldOperation({ ...input, acknowledgement: WORLD_DECISION_ACK });
                onResolved(result); onStatus(result.notice);
            }); }}>按酒馆里现在的内容接着改</button><button class="tl-button" onClick={() => setPreview(null)}>暂不结束</button></div>
        </Sheet>}</>;
}
function HistoricalOperation({ operation, bridge, onStatus, onObserved = () => {} }) {
    const [busy, setBusy] = useState(false);
    return <section class="tl-world-recovery"><p>{hasWorldUserDecision(operation) ? '已由你结束等待' : '保留的保存记录'}：{operation.name}。{operation.stage === 'confirmed' ? '确认存上过。' : operation.stage === 'not-submitted' ? '这次确定没存。' : '还不知道上次存没存上。'}{hasWorldUserDecision(operation) ? '上次的保存可能晚到，盖掉新的。' : ''}</p>
        <button class="tl-button" disabled={busy} onClick={async () => { setBusy(true); try {
            const result = await bridge.recoverWorldEditorWrite({ account: operation.account, operationId: operation.operationId }); onObserved(result); onStatus(result.notice);
        } catch (error) { onStatus(error.message); } finally { setBusy(false); } }}>再检查一次结果</button></section>;
}

// Where an entry goes in what the AI reads, in the order it appears there.
const POSITIONS = [
    [0, '角色设定前面', '角色前'], [1, '角色设定后面', '角色后'], [5, '对话示例前面', '示例前'], [6, '对话示例后面', '示例后'],
    [2, '作者注释前面', '注释前'], [3, '作者注释后面', '注释后'], [4, '聊天记录里（按深度）', '深度'], [7, '锚点（给扩展用）', '锚点'],
];
const ROLES = [[0, '系统'], [1, '用户'], [2, 'AI']];
// The app's world_info_logic values.
const LOGIC = [[0, '还提到其中任意一个'], [3, '这些全都提到了'], [2, '这些一个都没提到'], [1, '这些没有全部提到']];
const TRI = [['', '跟随全局设置'], ['true', '是'], ['false', '否']];

export const entryTitle = entry => entry.comment?.trim() || (entry.key ?? []).filter(Boolean).join('、') || '未命名条目';

function placeShort(entry) {
    const position = Number(entry.position ?? 0);
    const short = POSITIONS.find(p => p[0] === position)?.[2] ?? '';
    return position === 4 ? `深度 ${entry.depth ?? 4}` : short;
}

const isRegex = key => /^\/.+\/[a-z]*$/i.test(key);
// The app matches a keyword as written: "甲、乙" only triggers on that exact text, which is rarely what was meant.
const joined = key => !isRegex(key) && /[,，、]/.test(key);

/**
 * Keywords, one per line; a new line that is not a /regex/ may hold several separated by commas or 、. A line that
 * is one of the entry's keywords as it was stays whole (see `joined`).
 */
function keysFromText(text, original = []) {
    return String(text).split('\n').flatMap(line => {
        const t = line.trim();
        if (!t) return [];
        if (isRegex(t) || original.includes(t)) return [t];
        return t.split(/[,，、]/).map(x => x.trim()).filter(Boolean);
    });
}
const keysToText = keys => (keys ?? []).join('\n');
const splitKeys = keys => keys.flatMap(k => joined(k) ? k.split(/[,，、]/).map(x => x.trim()).filter(Boolean) : [k]);

function useBridge(eng, provided) {
    useEffect(() => { if (!provided) engine.requestEngine('action'); }, [provided]);
    return provided ?? (eng.state === 'ready' ? engine.getBridge() : null);
}

function Waiting({ eng, what }) {
    return (
        <>
            <p class="tl-muted">{what}要等原版准备好才能打开。</p>
            <EngineStatus eng={eng} meanwhile="好了会自动显示" />
        </>
    );
}

/** All world books, which are on for every story and which characters use them. */
export function WorldsPage({ eng, notify, onOpenNative, bridge: providedBridge }) {
    const bridge = useBridge(eng, providedBridge);
    const [books, setBooks] = useState(null);
    const [creating, setCreating] = useState(false);
    const [query, setQuery] = useState('');
    const [operation, setOperation] = useState(null), [status, setStatus] = useState(''), [busy, setBusy] = useState(false), [readOnlyReason, setReadOnlyReason] = useState(''), [decided, setDecided] = useState(null);
    useEffect(() => { bridge?.worldEditorUnfinished?.().catch(e => setReadOnlyReason(e.message)); }, [bridge]);
    useEffect(() => { if (bridge) setBooks(bridge.worldBooks()); }, [bridge]);
    useEffect(pruneDrafts, []);
    const needle = query.trim().toLowerCase();
    const shown = (books ?? []).filter(b => !needle || `${b.name} ${b.characters.join(' ')}`.toLowerCase().includes(needle));

    // The name sheet stays open, its button saying "正在新建…", until the result is known.
    const create = name => {
        if (busy) return undefined;
        setBusy(true); setStatus('正在保存新世界书…');
        return bridge.createWorldEditorBook({ account: bridge.worldEditorAccount(), name: name.trim() })
            .then(result => {
                setOperation(pendingResult(result));
                if (result.kind === 'confirmed' && result.runtimeState === 'ready') { setStatus('已保存新世界书'); go({ name: 'world', book: result.name }); }
                else setStatus(result.kind === 'not-submitted' ? '新世界书没建，可以重新输入名字再试' : '还不知道新世界书建没建成，先检查一下，别重复新建');
            }).catch(e => { if (e.detail?.operation) setOperation(e.detail.operation); setStatus(friendlyError(e.message)); }).finally(() => { setBusy(false); setCreating(false); });
    };

    return (
        <main class="tl-page tl-worlds">
            <PageHeader title="世界书" onBack={() => goBack({ name: 'me' })}>
                <button class="tl-button" disabled={!bridge?.createWorldEditorBook || busy || !!operation || !!readOnlyReason} onClick={() => setCreating(true)}>＋ 新建</button>
            </PageHeader>
            <p class="tl-muted">世界书是共享的设定资料，故事里提到关键词时会告诉 AI</p>
            {readOnlyReason && <p class="tl-error">{readOnlyReason}；这里只能看，聊天照常</p>}
            {status && <p class="tl-world-save-status" role="status">{status}</p>}
            <OperationDecision operation={operation} bridge={bridge} disabled={busy} onBusy={setBusy} onStatus={setStatus} onResolved={result => { setOperation(null); setDecided(result.operation); setBooks(bridge.worldBooks()); }} />
            {decided && <HistoricalOperation operation={decided} bridge={bridge} onStatus={setStatus} onObserved={r => setDecided(r.operation)} />}
            {operation && <button class="tl-button" disabled={busy} onClick={async () => {
                setBusy(true); try { const result = await bridge.recoverWorldEditorWrite({ account: operation.account, operationId: operation.operationId });
                    setOperation(pendingResult(result));
                    if (result.kind === 'confirmed' && result.runtimeState === 'ready') go({ name: 'world', book: result.name }); else setStatus(result.kind === 'not-submitted' && result.runtimeState === 'ready' ? '确定没建，可以重新新建' : '结果还要检查，记录和名字都留着');
                } catch (e) { setStatus(friendlyError(e.message)); } finally { setBusy(false); }
            }}>检查新建结果</button>}
            {operation && <button class="tl-button" disabled={busy} onClick={async () => {
                setBusy(true); try { const r = await bridge.useWorldServerAuthority({ account: operation.account, name: operation.name }); setStatus(r.notice + ' 新建记录还在，没有重复新建'); }
                catch (e) { setStatus(friendlyError(e.message)); } finally { setBusy(false); }
            }}>用酒馆里的版本，恢复聊天</button>}
            {!bridge && <Waiting eng={eng} what="世界书" />}
            {books?.length === 0 && <p class="tl-muted">还没有世界书。点右上角「新建」，导入的角色卡自带的世界书也会出现在这里</p>}
            {books && (
                <input class="tl-input tl-search" type="search" placeholder="搜索世界书或角色名" aria-label="搜索世界书" value={query}
                    onInput={e => setQuery(e.currentTarget.value)} />
            )}
            {books?.length > 0 && needle && shown.length === 0 && <p class="tl-muted">没找到</p>}
            {shown.length > 0 && (
                <div class="tl-list">
                    {shown.map(book => (
                        <button class="tl-list-item" onClick={() => go({ name: 'world', book: book.name })}>
                            <span class="tl-list-label">{book.name}</span>
                            <span class="tl-list-hint">{[book.global ? '所有故事都用' : '', book.characters.length ? `角色：${book.characters.join('、')}` : '']
                                .filter(Boolean).join(' · ') || '没有绑定角色，也没有设成所有故事都用'}</span>
                        </button>
                    ))}
                </div>
            )}
            {bridge && (
                <div class="tl-list">
                    <button class="tl-list-item" onClick={() => onOpenNative('')}>
                        <span class="tl-list-label">在原版界面里打开</span>
                        <span class="tl-list-hint">{bridge.worldBookUsage ? '导入导出、改名' : '设成所有故事都用、绑定角色、导入导出、改名'}</span>
                    </button>
                </div>
            )}
            {creating && (
                <PromptSheet title="新建世界书" label="名字" placeholder="例如：雨巷书店的设定" confirmLabel="新建" busyLabel="正在新建…"
                    validate={name => !name.trim() ? '请输入名字' : /[\\/:*?"<>|]/.test(name) ? '不能包含 \\ / : * ? " < > |' : ''}
                    onClose={() => setCreating(false)} onConfirm={create} />
            )}
        </main>
    );
}

const FILTERS = [['all', '全部'], ['constant', '常驻'], ['keys', '靠关键词'], ['off', '已停用'], ['joined', '关键词带顿号']];

// The entry a form stands for: keyword lines as they were stay the keywords they were.
const formValues = (value, baseline) => ({ ...value,
    key: value.keyText === keysToText(baseline.key) ? baseline.key : keysFromText(value.keyText, baseline.key ?? []),
    keysecondary: value.secondaryText === keysToText(baseline.keysecondary) ? baseline.keysecondary : keysFromText(value.secondaryText, baseline.keysecondary ?? []),
});
// A stored draft worth keeping: unsaved text, a save still to check, a decision, or a new entry's number once saved.
const draftWorthKeeping = (draft, scope) => !!draft.pending || !!draft.historyOperation || !!draft.resaveDraft
    || JSON.parse(scope)[2] === 'new' && draft.assignedUid !== undefined
    || !!draft.base && !!draft.form && worldChanges(draft.base, formValues(draft.form, draft.base)).length > 0;
// Earlier versions stored a draft for every entry opened and kept it; clear those once per visit.
let draftsPruned = false;
const pruneDrafts = () => { if (!draftsPruned) { draftsPruned = true; editorDrafts.prune((draft, scope) => { try { return !draftWorthKeeping(draft, scope); } catch { return false; } }); } };

const usedBy = character => character.own || character.extra;
/** Which stories use this book: every story, or the characters picked here. Each switch saves at once. */
function BookUsage({ bridge, book, sources, disabled, onChanged }) {
    const [usage, setUsage] = useState(() => bridge.worldBookUsage(book)), [picking, setPicking] = useState(false), [query, setQuery] = useState('');
    const [working, setWorking] = useState(null), [error, setError] = useState('');
    useEffect(() => { setUsage(bridge.worldBookUsage(book)); }, [bridge, book, sources]);
    const run = (key, action) => {
        setWorking(key); setError('');
        return action().then(next => { setUsage(next); onChanged(); }).catch(e => setError(friendlyError(e.message))).finally(() => setWorking(null));
    };
    const using = usage.characters.filter(usedBy), needle = query.trim().toLowerCase();
    const shown = usage.characters.filter(c => !needle || c.name.toLowerCase().includes(needle));
    const hint = c => working === c.avatar ? (usedBy(c) ? '正在取消…' : '正在保存…') : c.own ? '它自己的世界书' : c.extra ? '附加的世界书'
        : c.otherOwn ? `已有自己的世界书「${c.otherOwn}」，打开后作为附加的` : '';
    return (
        <section class="tl-section tl-world-usage" aria-label="用在哪里">
            <h2 class="tl-section-title">用在哪里</h2>
            <div class="tl-list">
                <button class="tl-list-item tl-switch-row" role="switch" aria-checked={usage.global ? 'true' : 'false'} aria-busy={working === 'global' ? 'true' : undefined}
                    disabled={disabled || !!working} onClick={() => run('global', () => bridge.setWorldBookGlobal(book, !usage.global))}>
                    <span class="tl-list-label">所有故事都用</span>
                    <span class="tl-list-hint">{working === 'global' ? (usage.global ? '正在关闭…' : '正在打开…') : '打开后每个故事都会用到，不用再给角色选'}</span>
                </button>
                <button class="tl-list-item" disabled={disabled} onClick={() => { setQuery(''); setPicking(true); }}>
                    <span class="tl-list-label">用它的角色 · {using.length}</span>
                    <span class="tl-list-hint">{using.length ? using.map(c => c.name).join('、') : '还没有角色用它，点这里选'}</span>
                </button>
            </div>
            {error && <p class="tl-error" role="alert">{error}</p>}
            {picking && (
                <Sheet title="选择用这本世界书的角色" busy={!!working} onClose={() => setPicking(false)}>
                    <p class="tl-sheet-note">打开的角色，它的每个故事都会用到这本。角色还没有自己的世界书时设成它自己的，已经有了就作为附加的</p>
                    {usage.characters.length > 8 && <input class="tl-input tl-search" type="search" placeholder="搜索角色" aria-label="搜索角色" value={query} onInput={e => setQuery(e.currentTarget.value)} />}
                    {error && <p class="tl-error" role="alert">{error}</p>}
                    {usage.characters.length === 0 && <p class="tl-muted">还没有角色</p>}
                    {usage.characters.length > 0 && !shown.length && <p class="tl-muted">没找到</p>}
                    <div class="tl-list">{shown.map(c => (
                        <button class="tl-list-item tl-switch-row" role="switch" aria-checked={usedBy(c) ? 'true' : 'false'} aria-busy={working === c.avatar ? 'true' : undefined}
                            aria-label={`「${c.name}」用这本世界书`} disabled={!!working} onClick={() => run(c.avatar, () => bridge.setWorldBookCharacter(book, c.avatar, !usedBy(c)))}>
                            <span class="tl-list-label">{c.name}</span>
                            {hint(c) && <span class="tl-list-hint">{hint(c)}</span>}
                        </button>
                    ))}</div>
                </Sheet>
            )}
        </section>
    );
}

/** One book: its entries (search, filter, switch on and off) and, with `entry` in the route, one entry's editor. */
export function WorldBookPage({ book, entry: entryUid, eng, notify, onOpenNative, bridge: providedBridge }) {
    const bridge = useBridge(eng, providedBridge), account = bridge?.worldEditorAccount?.() ?? '', viewKey = JSON.stringify([account, book]);
    const [data, setData] = useState(null), [readOnlyReason, setReadOnlyReason] = useState('');
    const [error, setError] = useState('');
    const [query, setQuery] = useState(bookViews.get(viewKey)?.query ?? '');
    const [filter, setFilter] = useState(bookViews.get(viewKey)?.filter ?? 'all');
    const [busy, setBusy] = useState(false);
    const [confirmSplit, setConfirmSplit] = useState(false);
    const [deleting, setDeleting] = useState(false);
    // After this page writes an entry, the book's fingerprint is read again before 全部分开 or 复制 may use it:
    // updating only the entry left the old one, and the server took the page's own save for someone else's change.
    const [stale, setStale] = useState(false);
    const [pending, setPending] = useState(null), [status, setStatus] = useState(''), [copying, setCopying] = useState(false), [hit, setHit] = useState(null), [unfinished, setUnfinished] = useState([]);
    const pageRef = useRef(null), requestEpoch = useRef(0), oldEntry = useRef(entryUid);

    // `opening`: the first load of a visit, the only one that checks saves left from before (see autoChecked).
    const load = (opening = false) => {
        const epoch = ++requestEpoch.current;
        if (!bridge?.worldEditorBook) { setError('当前酒馆版本存不了世界书，请更新后再试'); return Promise.resolve(); }
        return Promise.all([bridge.worldEditorBook(book), (bridge.worldEditorUnfinished?.() ?? Promise.resolve([])).catch(e => { setReadOnlyReason(e.message + '；这里只能看，聊天照常'); return []; })]).then(([d, operations]) => {
            if (epoch === requestEpoch.current) {
                const resume = operations.find(op => op.operationId === history.state?.worldEditorOperation && op.account === d.account && op.name === book && op.uid !== undefined);
                if (resume && entryUid) {
                    const key = entryScope(d.account, book, entryUid === 'new' ? undefined : Number(entryUid)), desired = resume.expectedBook.entries[resume.uid];
                    if (desired && !editorDrafts.has(key)) {
                        const baseline = entryUid === 'new' ? { comment: '', content: '', key: [], keysecondary: [] } : d.snapshot.entries[resume.uid] ?? desired;
                        const restored = cloneJson(desired); if (entryUid === 'new') delete restored.uid;
                        editorDrafts.set(key, { opened: baseline, base: baseline, form: { ...restored, keyText: keysToText(restored.key), secondaryText: keysToText(restored.keysecondary) },
                            revision: resume.draftRevision, pending: resume, submitted: restored, status: '已找回这次要存的内容，先检查一下酒馆里的结果' });
                    }
                }
                if (entryUid) {
                    const key = entryScope(d.account, book, entryUid === 'new' ? undefined : Number(entryUid)), draft = editorDrafts.get(key);
                    const decided = draft?.pending && operations.find(op => op.operationId === draft.pending.operationId && hasWorldUserDecision(op));
                    if (decided) editorDrafts.set(key, { ...draft, pending: null, historyOperation: decided, status: '不等了；原稿还在，上次存没存上还不知道' });
                }
                setData(d); setStale(false); setUnfinished(operations.filter(op => op.name === book || op.sourceName === book)); setError('');
                // On opening the book page only: an entry page has its own 检查上次保存, and a save made during this
                // visit is followed by the page itself.
                const unchecked = entryUid || !opening ? [] : operations.filter(op => op.account === d.account && isBlockingWorldOperation(op) && !autoChecked.has(op.operationId));
                if (unchecked.length && bridge.recoverWorldEditorWrite) {
                    unchecked.forEach(op => autoChecked.add(op.operationId));
                    Promise.allSettled(unchecked.map(op => bridge.recoverWorldEditorWrite({ account: op.account, operationId: op.operationId })))
                        .then(results => { if (epoch === requestEpoch.current && results.some(r => r.status === 'fulfilled')) load(); });
                }
            }
        }).catch(e => { if (epoch === requestEpoch.current) setError(friendlyError(e.message)); });
    };
    useEffect(() => { setData(null); setPending(null); if (bridge) load(true); return () => { requestEpoch.current++; }; }, [bridge, book, account]);
    useEffect(() => { if (!bridge) return; const refresh = () => load(); window.addEventListener('focus', refresh);
        const off = bridge.on?.(type => { if (type === 'world-editor-changed') refresh(); });
        return () => { window.removeEventListener('focus', refresh); off?.(); }; }, [bridge, book, account]);
    useEffect(pruneDrafts, []);
    useEffect(() => { bookViews.set(viewKey, { ...bookViews.get(viewKey), query, filter }); }, [viewKey, query, filter]);
    useLayoutEffect(() => { if (oldEntry.current && !entryUid && pageRef.current) window.scrollTo({ top: bookViews.get(viewKey)?.scroll ?? 0, behavior: 'auto' }); oldEntry.current = entryUid; }, [entryUid, data]);
    useEffect(() => { if (entryUid) return; const saveScroll = () => bookViews.set(viewKey, { ...bookViews.get(viewKey), scroll: window.scrollY });
        window.addEventListener('scroll', saveScroll, { passive: true }); return () => window.removeEventListener('scroll', saveScroll); }, [viewKey, entryUid]);

    const replace = changed => setData(d => d && ({ ...d, entries: d.entries.map(e => e.uid === changed.uid ? changed : e) }));
    const changedHere = () => { setStale(true); load(); };
    // The switch that was tapped shows its ring until the save is known.
    const [toggling, setToggling] = useState(null);
    const toggle = entry => {
        setBusy(true);
        setToggling(entry.uid);
        setStatus('正在保存开关…');
        bridge.saveWorldEditorEntry({ account: data.account, name: book, uid: entry.uid, baseEntry: entry, patch: { disable: !entry.disable }, draftRevision: 0 })
            .then(result => { setPending(pendingResult(result)); if (result.kind === 'confirmed' && result.runtimeState === 'ready') { replace(result.entry); changedHere(); setStatus('开关已保存'); }
                else { setPending(pendingResult(result)); setStatus(result.kind === 'conflict' ? '这一条变了，重新加载后再决定' : result.kind === 'not-submitted' ? '开关没改成，还是原来的状态' : '还不知道开关存没存上，检查一下'); } })
            .catch(e => { if (e.detail?.operation) setPending(e.detail.operation); setStatus(friendlyError(e.message)); })
            .finally(() => { setBusy(false); setToggling(null); });
    };
    const add = () => {
        const fresh = entryScope(account, book);
        if (editorDrafts.get(fresh)?.pending) { setStatus('先检查上次新建的条目，免得重复'); go({ name: 'world', book, entry: 'new' }); return; }
        if (!editorDrafts.delete(fresh)) { setStatus(editorDrafts.error); return; }
        bookViews.set(viewKey, { ...bookViews.get(viewKey), scroll: window.scrollY });
        setHit(null); go({ name: 'world', book, entry: 'new' });
    };

    if (entryUid !== undefined && entryUid !== '') {
        const retained = editorDrafts.get(entryScope(account, book, entryUid === 'new' ? undefined : Number(entryUid)));
        const draftUid = entryUid === 'new' ? retained?.assignedUid : undefined;
        let entry;
        if (data) {
            if (entryUid === 'new' && draftUid === undefined) entry = { comment: '', content: '', key: [], keysecondary: [], constant: false, disable: false };
            else entry = data.entries.find(e => String(e.uid) === String(draftUid ?? entryUid)) ?? retained?.base;
        }
        if (entry) return <EntryEditor key={entryScope(data.account, book, entryUid === 'new' ? undefined : entry.uid)} scopeUid={entryUid === 'new' ? undefined : entry.uid} readOnlyReason={readOnlyReason} account={data.account} sources={data.sources} book={book} entry={entry} runtimeConflict={data.runtimeState !== 'ready'} bridge={bridge} notify={notify} hit={hit} onSaved={saved => {
            if (entryUid === 'new') setData(d => ({ ...d, entries: [saved, ...d.entries.filter(item => item.uid !== saved.uid)] })); else replace(saved);
            changedHere();
        }}
            onDeleted={uid => { setData(d => d && ({ ...d, entries: d.entries.filter(e => e.uid !== uid) })); changedHere(); }} />;
        return (
            <main class="tl-page">
                <PageHeader title={book} onBack={() => goBack({ name: 'world', book })} />
                {!bridge ? <Waiting eng={eng} what="世界书" /> : error ? <p class="tl-error">{error}</p> : data ? <p class="tl-muted">这一条不在了</p> : <p class="tl-muted">正在加载…</p>}
            </main>
        );
    }

    const needle = query.trim().toLowerCase();
    const counts = { all: 0, constant: 0, keys: 0, off: 0, joined: 0 };
    const kind = e => e.disable ? 'off' : e.constant ? 'constant' : 'keys';
    // Keywords do not matter for 常驻 entries.
    const suspect = e => !e.constant && (e.key ?? []).some(joined);
    for (const e of data?.entries ?? []) { counts.all++; counts[kind(e)]++; if (suspect(e)) counts.joined++; }
    const shown = (data?.entries ?? []).filter(e => (filter === 'all' || (filter === 'joined' ? suspect(e) : kind(e) === filter))
        && worldSearch(e, needle).matched);

    return (
        <main ref={pageRef} class="tl-page tl-world-book" onScroll={e => bookViews.set(viewKey, { ...bookViews.get(viewKey), scroll: e.currentTarget.scrollTop })}>
            <PageHeader title={book} onBack={() => goBack({ name: 'worlds' })}>
                <button class="tl-button" disabled={!data || busy || !!readOnlyReason} onClick={add}>＋ 新条目</button>
            </PageHeader>
            {!bridge && <Waiting eng={eng} what="世界书" />}
            {error && <p class="tl-error">{error}</p>}
            {bridge && !data && !error && <p class="tl-muted">正在加载…</p>}
            {data && (
                <>
                    {readOnlyReason && <p class="tl-error">{readOnlyReason}</p>}
                    {data.notice && <p class="tl-error" role="alert">{data.notice}</p>}
                    {unfinished.length > 0 && <section class="tl-world-recovery"><p>此设备保留了 {unfinished.length} 条保存记录。</p>{unfinished.map(op => hasWorldUserDecision(op)
                        ? <HistoricalOperation operation={op} bridge={bridge} onStatus={setStatus} onObserved={load} /> : <button class="tl-button" onClick={() => {
                        if (op.uid === undefined) { setPending(op); setStatus('找到了保存记录，只检查结果，不会重复保存'); return; }
                        const live = data.entries.find(entry => entry.uid === op.uid), desired = op.expectedBook.entries[op.uid];
                        if (!desired) { setPending(op); setStatus('删除结果待确认'); return; }
                        const editing = live ?? { comment: '', content: '', key: [], keysecondary: [] }, draft = cloneJson(desired);
                        if (!live) delete draft.uid;
                        const key = entryScope(account, book, live?.uid);
                        if (!editorDrafts.has(key)) editorDrafts.set(key, { opened: editing, base: editing,
                            form: { ...draft, keyText: keysToText(draft.key), secondaryText: keysToText(draft.keysecondary) }, revision: op.draftRevision,
                            submitted: draft, pending: op, status: '已找回这次要存的内容，先检查一下酒馆里的结果' });
                        setHit(null); go({ name: 'world', book, entry: live ? String(live.uid) : 'new' });
                    }}>查看未确认保存：{op.action === 'copy' ? op.name : op.uid === undefined ? '新世界书' : `「${entryTitle(op.expectedBook?.entries?.[op.uid] ?? {})}」`}</button>)}</section>}
                    {status ? <p class="tl-world-save-status" role="status">{status}</p> : <p class="tl-muted" role="status">列表里的开关马上保存；条目内容要在编辑页点保存</p>}
                    <OperationDecision operation={pending} bridge={bridge} disabled={busy} onBusy={setBusy} onStatus={setStatus} onResolved={() => { setPending(null); load(); }} />
                    {pending && <button class="tl-button" disabled={busy} onClick={async () => {
                        setBusy(true); try { const r = await bridge.useWorldServerAuthority({ account: pending.account, name: pending.name }); setStatus(r.notice + ' 保存记录还在'); }
                        catch (e) { setStatus(friendlyError(e.message)); } finally { setBusy(false); }
                    }}>用酒馆里的版本，恢复聊天</button>}
                    {pending && <button class="tl-button" disabled={busy} onClick={async () => {
                        setBusy(true); try { const result = await bridge.recoverWorldEditorWrite({ account: pending.account, operationId: pending.operationId });
                            setPending(pendingResult(result));
                            if (result.kind === 'confirmed' && result.runtimeState === 'ready') { setStatus('已确认存好'); if (pending.action === 'copy') go({ name: 'world', book: result.name }); else await load(); }
                            else if (result.kind === 'not-submitted' && result.runtimeState === 'ready') { setStatus('确定没存，可以重新来'); await load(); }
                            else setStatus('还要检查存没存上，先不重复保存');
                        } catch (e) { setStatus(friendlyError(e.message)); } finally { setBusy(false); }
                    }}>检查保存结果</button>}
                    {(
                        <input class="tl-input tl-search" type="search" placeholder="在本书搜索标题、关键词、正文和设置" aria-label="搜索本书条目" value={query}
                            onInput={e => setQuery(e.currentTarget.value)} />
                    )}
                    <div class="tl-chips tl-world-filters" role="group" aria-label="按状态筛选">
                        {FILTERS.filter(([id]) => id !== 'joined' || counts.joined).map(([id, label]) => (
                            <button class="tl-chip" aria-pressed={filter === id ? 'true' : 'false'} onClick={() => setFilter(id)}>{label} {counts[id]}</button>
                        ))}
                    </div>
                    {counts.joined > 0 && (
                        <section class="tl-banner-card" role="status">
                            <p>有 {counts.joined} 条的关键词像“甲、乙”这样带着顿号或逗号。原版会把它当成一整个词，故事里要原样出现才会触发，多半是想写成几个词。</p>
                            <div class="tl-row">
                                <button class="tl-button" disabled={busy} onClick={() => setFilter('joined')}>看看是哪些</button>
                                <button class="tl-button tl-primary" disabled={busy || stale || !!readOnlyReason} onClick={() => setConfirmSplit(true)}>全部分开</button>
                            </div>
                        </section>
                    )}
                    {data.entries.length === 0 && <p class="tl-muted">还没有条目。点右上角「新条目」写第一条</p>}
                    {data.entries.length > 0 && shown.length === 0 && <p class="tl-muted">没有符合的条目</p>}
                    <div class="tl-list">
                        {shown.map(e => (
                            <div class="tl-world-row" data-off={e.disable ? 'true' : undefined}>
                                <button class="tl-list-item tl-world-open" onClick={() => { bookViews.set(viewKey, { ...bookViews.get(viewKey), scroll: window.scrollY }); setHit(worldSearch(e, needle).hits[0] ?? null); go({ name: 'world', book, entry: String(e.uid) }); }}>
                                    <span class="tl-list-label">{entryTitle(e)}</span>
                                    <span class="tl-list-hint">{[
                                        e.disable ? '已停用' : e.constant ? '常驻' : '',
                                        placeShort(e), `顺序 ${e.order ?? 100}`,
                                        e.constant ? '' : (e.key ?? []).length ? `关键词：${e.key.slice(0, 3).join(' / ')}${e.key.length > 3 ? '…' : ''}` : '没有关键词，不会用到',
                                    ].filter(Boolean).join(' · ')}</span>
                                    {!e.disable && !e.constant && (e.key ?? []).length > 0 && e.key.every(joined) && <span class="tl-list-hint tl-world-warn">关键词里有顿号或逗号，要整句出现才算</span>}
                                    {needle && worldSearch(e, needle).hits.slice(0, 2).map(match => <span class="tl-world-hit">{match.label}：{match.snippet}</span>)}
                                </button>
                                <button class="tl-world-toggle tl-switch-row" role="switch" aria-checked={e.disable ? 'false' : 'true'}
                                    aria-label={`启用「${entryTitle(e)}」`} aria-busy={toggling === e.uid ? 'true' : undefined} disabled={busy || !!pending || !!readOnlyReason} onClick={() => toggle(e)} />
                            </div>
                        ))}
                    </div>
                    {confirmSplit && (
                        <ConfirmSheet title="把带顿号的关键词分开" confirmLabel="全部分开" busyLabel="正在分开…" tone="primary"
                            message={`这本世界书里 ${counts.joined} 条的关键词会拆开，比如「甲、乙」变成「甲」「乙」两个，其余不变。拆开后这些条目更容易用上`}
                            onClose={() => setConfirmSplit(false)} onConfirm={() => {
                                setBusy(true);
                                setStatus('正在分开关键词…');
                                return bridge.splitWorldEditorKeys({ account: data.account, name: book, expectedFingerprint: data.fingerprint }).then(result => {
                                    if (result.kind === 'confirmed') { setStatus(`${result.changedCount} 条关键词已改好`); setFilter('all'); return load(); }
                                    setPending(pendingResult(result));
                                    setStatus(result.kind === 'not-submitted' ? '关键词没改成，可以重来' : '还不知道关键词改没改成，先检查一下');
                                }).catch(e => { if (e.detail?.operation) setPending(e.detail.operation); setStatus(friendlyError(e.message)); }).finally(() => { setBusy(false); setConfirmSplit(false); });
                            }} />
                    )}
                    {bridge.worldBookUsage && <BookUsage bridge={bridge} book={book} sources={data.sources} disabled={busy || !!readOnlyReason} onChanged={load} />}
                    <ScopeNotice sources={data.sources} />
                    <div class="tl-list">
                        <button class="tl-list-item" disabled={!data || busy || stale || !!pending || !!readOnlyReason} onClick={() => setCopying(true)}>
                            <span class="tl-list-label">复制这本世界书</span>
                            <span class="tl-list-hint">复制一份再改，原来的不动</span>
                        </button>
                        <button class="tl-list-item" onClick={() => onOpenNative(book)}>
                            <span class="tl-list-label">在原版界面里打开这本</span>
                            <span class="tl-list-hint">角色筛选、触发时机、排序方式等少用设置</span>
                        </button>
                        {bridge?.deleteWorldBook && (
                            <button class="tl-list-item tl-danger-text" disabled={busy || !!pending || !!readOnlyReason} onClick={() => setDeleting(true)}>
                                <span class="tl-list-label">删除这本世界书</span>
                                <span class="tl-list-hint">所有条目一起删掉，无法恢复</span>
                            </button>
                        )}
                    </div>
                    {deleting && (
                        <ConfirmSheet title={`删除「${book}」？`} confirmLabel="删除" busyLabel="正在删除…" onClose={() => setDeleting(false)}
                            message={`${data.entries.length} 条条目会一起删掉，找不回来。用到它的故事以后就用不上了。当前关联：${scopeText(data.sources)}`}
                            onConfirm={() => bridge.deleteWorldBook(book)
                                .then(() => { notify(`已删除「${book}」`, 'info'); go({ name: 'worlds' }, true); })
                                .catch(e => notify(e.message))} />
                    )}
                    <button class="tl-button" disabled={busy} onClick={async () => { setBusy(true); try { const r = await bridge.useWorldServerAuthority({ account, name: book }); setStatus(r.notice); await load(); } catch (e) { setStatus(friendlyError(e.message)); } finally { setBusy(false); } }}>用酒馆里的版本，重新检查</button>
                    {copying && <PromptSheet title="复制世界书" label="副本名字" initial={`${book} 副本`} confirmLabel="复制并编辑" busyLabel="正在复制…"
                        placeholder="副本不会顶替原来的关联" validate={name => !name.trim() ? '请输入副本名字' : /[\\/:*?"<>|]/.test(name) ? '名字不能包含 \\ / : * ? " < > |' : ''}
                        onClose={() => setCopying(false)} onConfirm={name => {
                            setBusy(true); setStatus('正在保存副本，原来的关联不变…');
                            return bridge.copyWorldEditorBook({ account: data.account, name: book, newName: name.trim(), expectedFingerprint: data.fingerprint })
                                .then(result => { setPending(pendingResult(result)); if (result.kind === 'confirmed' && result.runtimeState === 'ready') go({ name: 'world', book: result.name }); else { setPending(pendingResult(result)); setStatus(result.kind === 'not-submitted' ? '副本没存，原书还在，可以重新复制' : '还不知道副本存没存上，先检查，别重复复制'); } })
                                .catch(e => { if (e.detail?.operation) setPending(e.detail.operation); setStatus(friendlyError(e.message)); }).finally(() => { setBusy(false); setCopying(false); });
                        }} />}
                </>
            )}
        </main>
    );
}

function Toggle({ label, hint, on, onChange }) {
    return (
        <button class="tl-list-item tl-switch-row" role="switch" aria-checked={on ? 'true' : 'false'} onClick={() => onChange(!on)}>
            <span class="tl-list-label">{label}</span>
            {hint && <span class="tl-list-hint">{hint}</span>}
        </button>
    );
}

function Field({ label, hint, children, id }) {
    const context = useContext(fieldContext), key = fieldKeys[id?.replace('tl-wi-', '')], modified = key && context?.changed.includes(key);
    return (
        <div class="tl-field-group" data-modified={modified || undefined}>
            <label class="tl-field-label" for={id}>{label}</label>
            {modified && <span class="tl-world-modified">已修改 <button class="tl-world-restore" onClick={() => context.restore(key)}>恢复{label}</button></span>}
            {hint && <span class="tl-field-hint">{hint}</span>}
            {children}
        </div>
    );
}

// Optional numbers (null = not set).
const optionalNumber = text => text.trim() === '' ? null : Number(text);
const triValue = v => v === null || v === undefined ? '' : String(!!v);

/** One entry. Only the fields changed here are written; the app keeps everything else on the entry. */
function EntryEditor({ account, sources, book, entry, scopeUid, readOnlyReason, runtimeConflict, bridge, notify, onSaved, onDeleted, hit }) {
    const scope = entryScope(account, book, scopeUid), restored = editorDrafts.get(scope);
    const [assignedUid, setAssignedUid] = useState(restored?.assignedUid ?? entry.uid), isNew = assignedUid === undefined;
    const toForm = value => ({ ...cloneJson(value), keyText: keysToText(value.key), secondaryText: keysToText(value.keysecondary) });
    const opened = useRef(restored?.opened ?? cloneJson(entry));
    const [base, setBase] = useState(restored?.base ?? cloneJson(entry));
    const [form, writeForm] = useState(restored?.form ?? toForm(entry));
    const [saving, setSaving] = useState(false), [sheet, setSheet] = useState(null), [draftError, setDraftError] = useState(editorDrafts.error);
    const [status, setStatus] = useState(restored?.status ?? (isNew ? '新条目草稿，第一次保存时才创建' : '内容是从酒馆读的最新版'));
    const [pending, setPending] = useState(pendingResult({ operation: restored?.pending })), [conflicts, setConflicts] = useState([]);
    const [historyOperation, setHistoryOperation] = useState(restored?.historyOperation ?? (restored?.pending && !isBlockingWorldOperation(restored.pending) ? restored.pending : null));
    const [runtimeWarning, setRuntimeWarning] = useState(!!runtimeConflict), [resaveDraft, setResaveDraft] = useState(!!restored?.resaveDraft);
    const [mode, setMode] = useState(() => { try { return localStorage.getItem(`tavern-lite:world-view:${account}`) || 'common'; } catch { return 'common'; } });
    const [advanced, setAdvanced] = useState(!!hit?.advanced), [showChanges, setShowChanges] = useState(false);
    const revision = useRef(restored?.revision ?? 0), mounted = useRef(true), busyRef = useRef(false), submitted = useRef(restored?.submitted ?? null);
    const formRef = useRef(form), baseRef = useRef(base), lastServer = useRef(worldFingerprint(restored?.base ?? entry));
    formRef.current = form; baseRef.current = base;
    const valuesFrom = (value, baseline = baseRef.current) => formValues(value, baseline);
    const values = valuesFrom(form), changes = worldChanges(opened.current, values), changed = changes.map(x => x.key), dirty = worldChanges(base, values).length > 0;
    const setForm = update => {
        revision.current++;
        writeForm(current => typeof update === 'function' ? update(current) : update);
        setStatus('有没保存的草稿');
    };
    const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
    // Written every time (a write that fails turns the page read-only before anything is typed), then taken off the
    // device again when there is nothing to keep.
    useLayoutEffect(() => {
        const draft = { form, base, opened: opened.current, revision: revision.current, pending, submitted: submitted.current, status, assignedUid, historyOperation, resaveDraft };
        const stored = editorDrafts.set(scope, draft);
        setDraftError(stored ? '' : editorDrafts.error);
        if (stored && !conflicts.length && !draftWorthKeeping(draft, scope)) editorDrafts.drop(scope);
    }, [scope, form, base, pending, status, assignedUid, historyOperation, resaveDraft, conflicts.length]);
    useEffect(() => { const { worldEditorOperation, ...state } = history.state ?? {};
        history.replaceState(pending ? { ...state, worldEditorOperation: pending.operationId } : state, '', location.href);
    }, [pending]);
    useEffect(() => () => { mounted.current = false; }, []);
    useEffect(() => {
        // A clean, previously confirmed NEW is still the user's version. Do not auto-refresh it to LATE.
        if (runtimeConflict || resaveDraft) { setRuntimeWarning(true); return; }
        const fingerprint = worldFingerprint(entry);
        if (lastServer.current === fingerprint) return;
        lastServer.current = fingerprint;
        const result = refreshWorldDraft({ opened: opened.current, base: baseRef.current, draft: valuesFrom(formRef.current), server: entry });
        setBase(result.base); writeForm(toForm(result.draft)); setConflicts(result.conflicts);
        if (result.conflicts.length) setStatus('原版或别的页面改了同一项，你写的还在');
    }, [entry, runtimeConflict, resaveDraft]);
    useEffect(() => { try { localStorage.setItem(`tavern-lite:world-view:${account}`, mode); } catch {} }, [account, mode]);
    const locate = key => {
        if (!['comment', 'content', 'key'].includes(key)) setAdvanced(true);
        requestAnimationFrame(() => { const el = document.getElementById(fieldIds[key] ?? 'tl-wi-changes'); if (!el) return;
            el.scrollIntoView({ block: 'center', behavior: 'auto' });
            if (el instanceof HTMLTextAreaElement && key === hit?.key && hit) el.setSelectionRange(hit.index, hit.index + hit.length);
            if (matchMedia('(hover: hover) and (pointer: fine)').matches) el.focus({ preventScroll: true });
        });
    };
    useEffect(() => { if (hit) locate(hit.key); else if (isNew && matchMedia('(hover: hover) and (pointer: fine)').matches) document.getElementById('tl-wi-comment')?.focus(); }, []);
    const restore = key => {
        const value = opened.current[key];
        if (key === 'key') set('keyText', keysToText(value));
        else if (key === 'keysecondary') set('secondaryText', keysToText(value));
        else setForm(current => { const next = { ...current }; if (value === undefined) delete next[key]; else next[key] = cloneJson(value); return next; });
    };
    const leave = () => goBack({ name: 'world', book });
    const askLeave = () => { if (busyRef.current) setStatus('正在保存，完成前先别离开'); else if (dirty || pending) setSheet('leave'); else { editorDrafts.delete(scope); leave(); } };
    useBackLayer(dirty || saving || !!pending, askLeave);
    const applyResult = result => {
        if (!mounted.current) return;
        if (result.kind === 'historical-observation') {
            setPending(pendingResult(result)); setHistoryOperation(result.operation); setStatus(result.notice);
            if (result.runtimeState !== 'ready') setRuntimeWarning(true);
            return;
        }
        if (result.kind === 'confirmed') {
            const runtimeError = result.error ? ` ${result.error}` : '';
            if (result.runtimeState === 'ready') { setRuntimeWarning(false); setResaveDraft(false); }
            setPending(null); setConflicts([]);
            if (result.runtimeState !== 'ready') setRuntimeWarning(true);
            if (result.operation?.action === 'entry-delete') { if (result.runtimeState === 'ready') { editorDrafts.delete(scope); onDeleted(assignedUid); leave(); } else setStatus(`酒馆里已删除，但原版界面里还要检查一下。${runtimeError}`); return; }
            const current = valuesFrom(formRef.current), captured = submitted.current ?? current;
            const next = applySavedWorldDraft({ current, submitted: captured, saved: result.entry });
            setBase(cloneJson(result.entry)); writeForm(toForm(next));
            const remaining = worldChanges(result.entry, next).length;
            setStatus(result.runtimeState !== 'ready' ? `酒馆里已保存，但原版界面里还要检查一下。${runtimeError}` : remaining ? '已保存；之后写的还是草稿' : '已确认存好');
            if (isNew) setAssignedUid(result.entry.uid);
            onSaved(result.entry);
        } else {
            setPending(pendingResult(result)); setConflicts(result.conflicts ?? []);
            if (result.runtimeState !== 'ready') setRuntimeWarning(true);
            setStatus(result.kind === 'conflict' ? '保存时发现别处也改了，原稿还在，看一下冲突的几项' : result.kind === 'not-submitted' ? `这次没存，草稿还在，可以再存一次。${result.runtimeState === 'ready' ? '' : '发送先暂停，需要检查一下。'}` : '还不知道存没存上，草稿还在。先检查结果，别重复创建');
        }
    };
    const retainOperation = operation => {
            setPending(operation);
            const retained = { form: formRef.current, base: baseRef.current, opened: opened.current, revision: revision.current,
                pending: operation, submitted: submitted.current, status: '保存记录留着，正在检查', assignedUid };
            if (!editorDrafts.set(scope, retained)) throw new Error(editorDrafts.error);
            history.replaceState({ ...history.state, worldEditorOperation: operation.operationId }, '', location.href);
        };
    const save = async () => {
        if (!bridge || busyRef.current || pending || readOnlyReason || draftError || conflicts.length) return;
        const captured = valuesFrom(formRef.current), patch = Object.fromEntries(worldChanges(baseRef.current, captured).map(x => [x.key, x.after]));
        if (patch.keysecondary?.length && !captured.selective) patch.selective = true;
        submitted.current = cloneJson(captured); busyRef.current = true; setSaving(true); setStatus('正在保存…');
        try { applyResult(await bridge.saveWorldEditorEntry({ account, name: book, uid: assignedUid, baseEntry: baseRef.current, patch, draftRevision: revision.current, onPrepared: retainOperation })); }
        catch (error) { if (mounted.current) {
            if (error.detail?.operation) { setPending(error.detail.operation); submitted.current = cloneJson(error.detail.operation.expectedBook.entries[error.detail.operation.uid] ?? submitted.current); }
            setStatus(friendlyError(error.message));
            if (['WORLD_SERVER_CHANGED', 'WORLD_RUNTIME_CONFLICT'].includes(error.code)) setRuntimeWarning(true);
        } }
        finally { busyRef.current = false; if (mounted.current) setSaving(false); }
    };
    const recover = async () => {
        if (!pending || busyRef.current) return; busyRef.current = true; setSaving(true); setStatus('只检查上次的保存结果，不会再创建…');
        try { applyResult(await bridge.recoverWorldEditorWrite({ account, operationId: pending.operationId })); }
        catch (error) { if (mounted.current) setStatus(friendlyError(error.message)); }
        finally { busyRef.current = false; if (mounted.current) setSaving(false); }
    };
    const useServer = async retainMine => {
        if (busyRef.current) return; busyRef.current = true; setSaving(true);
        try {
            const result = await (retainMine ? bridge.prepareWorldEditorResave({ account, name: book }) : bridge.useWorldServerAuthority({ account, name: book }));
            const server = result.snapshot?.entries[assignedUid], mine = valuesFrom(formRef.current);
            if (server) {
                if (retainMine) {
                    setBase(cloneJson(server)); writeForm(toForm(mine)); revision.current++;
                    setConflicts(worldChanges(server, mine).map(change => ({ key: change.key, label: change.label, mine: change.after, server: change.before })));
                } else {
                    const refreshed = refreshWorldDraft({ opened: opened.current, base: baseRef.current, draft: mine, server });
                    setBase(refreshed.base); writeForm(toForm(refreshed.draft)); setConflicts(refreshed.conflicts);
                }
                lastServer.current = worldFingerprint(server);
            } else if (!isNew) setConflicts([{ key: 'uid', label: '这一条在酒馆里已经没有了', server: null }]);
            setResaveDraft(retainMine); setRuntimeWarning(retainMine); setStatus(result.notice + (pending ? ' 原稿和保存记录还在' : ''));
            if (pending) {
                // Runtime authority stays available when IDB is disabled; failure to read the record cannot undo it.
                const latest = await bridge.worldEditorOperation?.(pending.operationId).catch(() => null);
                if (latest && !isBlockingWorldOperation(latest)) { setPending(null); setHistoryOperation(latest); }
            }
        } catch (error) { setStatus(friendlyError(error.message)); }
        finally { busyRef.current = false; setSaving(false); }
    };
    const decided = result => {
        setPending(null); setHistoryOperation(result.operation);
        const server = result.snapshot?.entries[assignedUid];
        if (server && !isNew) {
            const next = refreshWorldDraft({ opened: opened.current, base: baseRef.current, draft: valuesFrom(formRef.current), server });
            setBase(next.base); writeForm(toForm(next.draft)); setConflicts(next.conflicts);
        }
        // Unknown creation is deliberately not bound by a possibly reused numeric UID.
        if (isNew) setStatus('还不知道上次新建成没成，你写的还在。再保存会新建一条；上次的请求可能晚到，造成重复');
        setRuntimeWarning(result.runtimeState !== 'ready');
    };
    const remove = async () => {
        setSheet(null); if (busyRef.current || pending || readOnlyReason || draftError) return;
        busyRef.current = true; setSaving(true); setStatus('正在删除…');
        try { const result = await bridge.deleteWorldEditorEntry({ account, name: book, uid: assignedUid, baseEntry: base, draftRevision: revision.current, onPrepared: retainOperation });
            if (result.kind === 'confirmed' && result.runtimeState === 'ready') { editorDrafts.delete(scope); onDeleted(assignedUid); leave(); } else applyResult(result);
        } catch (error) { if (mounted.current) { if (error.detail?.operation) setPending(error.detail.operation); setStatus(friendlyError(error.message)); } }
        finally { busyRef.current = false; if (mounted.current) setSaving(false); }
    };

    const position = Number(form.position ?? 0);
    const positions = POSITIONS.filter(p => p[0] !== 7 || position === 7);
    return (
        <fieldContext.Provider value={{ changed, restore }}><main class="tl-page tl-entry-editor" onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (dirty) save(); }
        }}>
            <PageHeader title={isNew ? '新条目草稿' : entryTitle(base)} onBack={askLeave}>
                <button class="tl-button tl-primary" disabled={!dirty || saving || !!pending || !!conflicts.length || !bridge || !!readOnlyReason || !!draftError || isNew && !form.comment?.trim() && !form.content?.trim()} onClick={save}>{saving ? '正在保存…' : '保存'}</button>
            </PageHeader>
            {(readOnlyReason || draftError) && <p class="tl-error">{readOnlyReason || draftError}</p>}
            <p class="tl-world-save-status" role="status" aria-live="polite">{status}</p>
            <OperationDecision operation={pending} bridge={bridge} disabled={saving} onBusy={value => { busyRef.current = value; setSaving(value); }} onStatus={setStatus} onResolved={decided} />
            {historyOperation && <HistoricalOperation operation={historyOperation} bridge={bridge} onStatus={setStatus} onObserved={result => { setHistoryOperation(result.operation); if (result.runtimeState !== 'ready') setRuntimeWarning(true); }} />}
            {isNew && historyOperation?.action === 'entry-create' && <p class="tl-world-scope">上次新建的记录还在，这份草稿还没对应到条目。再保存会新建一条，可能跟上次的重复；先检查一下酒馆里的内容</p>}
            {runtimeWarning && !pending && <section class="tl-world-conflicts" role="alert"><p>需要检查一下，已暂停发送。你写的还在，不会被酒馆里的版本自动替换</p>
                <button class="tl-button" disabled={saving} onClick={() => useServer(false)}>用酒馆里的版本，恢复聊天</button>
                <button class="tl-button" disabled={saving || resaveDraft} onClick={() => useServer(true)}>把我的版本留作草稿</button>
                {resaveDraft && <p>逐项选好再保存。存好之前发送先暂停</p>}
            </section>}
            {pending && <><button class="tl-button" disabled={saving} onClick={recover}>检查上次保存</button>
                <button class="tl-button" disabled={saving} onClick={() => useServer(false)}>用酒馆里的版本，恢复聊天</button></>}
            {conflicts.length > 0 && <section class="tl-world-conflicts" role="alert"><p>这几项在别处也改过：</p>{conflicts.map(conflict => (
                <div><strong>{conflict.label}</strong><p>酒馆里的：{typeof conflict.server === 'string' ? conflict.server : JSON.stringify(conflict.server)}</p>
                    {conflict.key !== 'uid' && <div class="tl-row">{[['mine', '保留我的内容'], ['server', '用酒馆里的']].map(([choice, text]) => <button class="tl-button" onClick={() => {
                        setBase(current => ({ ...current, [conflict.key]: conflict.server }));
                        if (choice === 'server') { if (conflict.key === 'key') set('keyText', keysToText(conflict.server)); else if (conflict.key === 'keysecondary') set('secondaryText', keysToText(conflict.server)); else set(conflict.key, conflict.server); }
                        setConflicts(current => current.filter(item => item.key !== conflict.key)); setStatus('选好了，保存时会再检查一次');
                    }}>{text}</button>)}</div>}
                </div>))}</section>}
            <div class="tl-row tl-world-view" role="group" aria-label="显示设置">{[['common', '常用'], ['all', '全部设置']].map(([value, title]) => <button class="tl-chip" aria-pressed={mode === value ? 'true' : 'false'} onClick={() => setMode(value)}>{title}</button>)}</div>
            {changes.length > 0 && <button id="tl-wi-changes" class="tl-button" onClick={() => setShowChanges(!showChanges)}>本次已改 {changes.length} 处</button>}
            {showChanges && <div class="tl-world-change-list">{changes.length ? changes.map(change => <div><button class="tl-world-restore" onClick={() => locate(change.key)}>{change.label}</button><button class="tl-world-restore" onClick={() => restore(change.key)}>恢复成打开时</button></div>) : <p>没有没保存的改动</p>}</div>}

            <section class="tl-section">
                <Field label="标题" hint="只给你看，方便找；不会告诉 AI" id="tl-wi-comment">
                    <input id="tl-wi-comment" class="tl-input" value={form.comment ?? ''} onInput={e => set('comment', e.currentTarget.value)} />
                </Field>
            </section>

            <section class="tl-section">
                <Field label="内容" hint="满足条件时告诉 AI 的设定文字" id="tl-wi-content">
                    <textarea id="tl-wi-content" class="tl-input tl-field" rows={8} value={form.content ?? ''} onInput={e => set('content', e.currentTarget.value)} />
                </Field>
            </section>

            <div class="tl-list">
                <Toggle label="启用这一条" hint={form.disable ? '停用后不会告诉 AI，内容保留' : ''} on={!form.disable} onChange={on => set('disable', !on)} />
            </div>

            <section class="tl-section">
                <h2 class="tl-section-title">什么时候告诉 AI</h2>
                <div class="tl-list" role="radiogroup" aria-label="什么时候告诉 AI">
                    <button class="tl-list-item tl-choice-row" data-pick role="radio" aria-checked={form.constant ? 'true' : 'false'}
                        onClick={() => setForm(f => ({ ...f, constant: true, vectorized: false }))}>
                        <span class="tl-list-label tl-sheet-item-label">尝试每次加入（常驻）</span>
                        <span class="tl-list-hint">适合世界观、规则这类一直要记得的内容</span>
                    </button>
                    <button class="tl-list-item tl-choice-row" data-pick role="radio" aria-checked={!form.constant && !form.vectorized ? 'true' : 'false'}
                        onClick={() => setForm(f => ({ ...f, constant: false, vectorized: false }))}>
                        <span class="tl-list-label tl-sheet-item-label">故事里提到关键词时</span>
                        <span class="tl-list-hint">适合人物、地点、物品：提到了才告诉，省地方</span>
                    </button>
                    {entry.vectorized && (
                        <button class="tl-list-item tl-choice-row" data-pick role="radio" aria-checked={!form.constant && form.vectorized ? 'true' : 'false'}
                            onClick={() => setForm(f => ({ ...f, constant: false, vectorized: true }))}>
                            <span class="tl-list-label tl-sheet-item-label">意思相近时（向量匹配）</span>
                            <span class="tl-list-hint">需要原版的向量扩展</span>
                        </button>
                    )}
                </div>
                {!form.constant && (
                    <Field label="关键词" hint="一行一个，也可以用逗号或顿号隔开。故事里提到时才可能告诉 AI" id="tl-wi-keys">
                        <textarea id="tl-wi-keys" class="tl-input tl-field" rows={3} value={form.keyText} spellcheck={false}
                            placeholder={'例如：\n林小满\n书店'} onInput={e => set('keyText', e.currentTarget.value)} />
                    </Field>
                )}
                {!form.constant && (values.key ?? []).some(joined) && (
                    <div class="tl-banner-card" role="status">
                        <p>「{values.key.find(joined)}」是一整个关键词：原版要故事里原样出现这几个字（连同顿号或逗号）才会触发。如果本来是想写几个词，可以分开。</p>
                        <div class="tl-row">
                            <button class="tl-button tl-primary" onClick={() => set('keyText', keysToText(splitKeys(values.key)))}>分成几个关键词</button>
                        </div>
                    </div>
                )}
            </section>


            <section class="tl-section">
                <Field label="放在哪里" hint="放在 AI 读到的内容里的哪个位置" id="tl-wi-position">
                    <select id="tl-wi-position" class="tl-input" value={String(position)} onChange={e => set('position', Number(e.currentTarget.value))}>
                        {positions.map(([value, label]) => <option value={String(value)}>{label}</option>)}
                    </select>
                </Field>
                {position === 4 && (
                    <div class="tl-row tl-wi-depth">
                        <Field label="深度" hint="0 是最新一条消息后面，数字越大越往前" id="tl-wi-depth">
                            <input id="tl-wi-depth" class="tl-input" type="number" min="0" inputMode="numeric" value={form.depth ?? 4}
                                onInput={e => set('depth', Number(e.currentTarget.value) || 0)} />
                        </Field>
                        <Field label="以谁的身份" id="tl-wi-role">
                            <select id="tl-wi-role" class="tl-input" value={String(form.role ?? 0)} onChange={e => set('role', Number(e.currentTarget.value))}>
                                {ROLES.map(([value, label]) => <option value={String(value)}>{label}</option>)}
                            </select>
                        </Field>
                    </div>
                )}
                {position === 7 && <p class="tl-muted">锚点名：{entry.outletName || '（未设置）'}，在原版界面里改。</p>}
                <Field label="顺序" hint="同一个位置里，数字大的排在后面、离对话更近；放不下时也更先保留" id="tl-wi-order">
                    <input id="tl-wi-order" class="tl-input" type="number" inputMode="numeric" value={form.order ?? 100}
                        onInput={e => set('order', Number(e.currentTarget.value) || 0)} />
                </Field>
            </section>

            <details class="tl-more-fields tl-wi-more" open={mode === 'all' || advanced} onToggle={event => { if (mode !== 'all') setAdvanced(event.currentTarget.open); }}>
                <summary>更多设置（条件、概率、分组、连带触发）<span class="tl-world-hit">{form.group ? `分组「${form.group}」；` : ''}概率 {form.probability ?? 100}% · 持续 {form.sticky ?? 0} · 冷却 {form.cooldown ?? 0}；仅说明条件，不代表已用于回复。</span></summary>

                {!form.constant && (
                    <>
                        <Field label="还要满足" hint="除了关键词，再看下面这些词" id="tl-wi-logic">
                            <select id="tl-wi-logic" class="tl-input" value={String(form.selectiveLogic ?? 0)} onChange={e => set('selectiveLogic', Number(e.currentTarget.value))}>
                                {LOGIC.map(([value, label]) => <option value={String(value)}>{label}</option>)}
                            </select>
                        </Field>
                        <Field label="这些词" hint="一行一个；不填就不看这一项" id="tl-wi-secondary">
                            <textarea id="tl-wi-secondary" class="tl-input tl-field" rows={2} value={form.secondaryText} spellcheck={false}
                                onInput={e => set('secondaryText', e.currentTarget.value)} />
                        </Field>
                    </>
                )}

                <Field label="触发概率（%）" hint="100 表示每次都可能用上，仍受其他条件影响" id="tl-wi-probability">
                    <input id="tl-wi-probability" class="tl-input" type="number" min="0" max="100" inputMode="numeric" value={form.probability ?? 100}
                        onInput={e => setForm(f => ({ ...f, probability: Math.max(0, Math.min(100, Number(e.currentTarget.value) || 0)), useProbability: true }))} />
                </Field>

                <Field label="分组" hint="同一组的几条同时触发时，只留一条（填同一个组名）" id="tl-wi-group">
                    <input id="tl-wi-group" class="tl-input" value={form.group ?? ''} placeholder="不分组就留空" onInput={e => set('group', e.currentTarget.value)} />
                </Field>
                {(form.group ?? '').trim() && (
                    <>
                        <Field label="组内权重" hint="随机挑一条时，数字越大越容易被挑中" id="tl-wi-weight">
                            <input id="tl-wi-weight" class="tl-input" type="number" min="1" inputMode="numeric" value={form.groupWeight ?? 100}
                                onInput={e => set('groupWeight', Number(e.currentTarget.value) || 1)} />
                        </Field>
                        <div class="tl-list">
                            <Toggle label="组里优先选它" hint="不随机，直接选顺序最大的那条" on={!!form.groupOverride} onChange={on => set('groupOverride', on)} />
                        </div>
                    </>
                )}

                <div class="tl-list">
                    <Toggle label="不会被别的条目带出来" hint="只看故事里的话，不看别的条目内容里有没有它的关键词" on={!!form.excludeRecursion} onChange={on => set('excludeRecursion', on)} />
                    <Toggle label="不会再带出别的条目" hint="它的内容里即使有别的条目的关键词，也不让那些条目触发" on={!!form.preventRecursion} onChange={on => set('preventRecursion', on)} />
                    <Toggle label="只能被别的条目带出来" hint="故事里直接提到也不触发，要等别的条目的内容提到它" on={!!form.delayUntilRecursion}
                        onChange={on => set('delayUntilRecursion', on ? (entry.delayUntilRecursion || true) : false)} />
                    <Toggle label="放不下时也要放进去" hint="世界书太长放不下时，这一条也不让位" on={!!form.ignoreBudget} onChange={on => set('ignoreBudget', on)} />
                </div>

                <div class="tl-row tl-wi-timing">
                    <Field label="持续" hint="触发后再保持几条消息" id="tl-wi-sticky">
                        <input id="tl-wi-sticky" class="tl-input" type="number" min="0" inputMode="numeric" value={form.sticky ?? ''} placeholder="不持续"
                            onInput={e => set('sticky', optionalNumber(e.currentTarget.value))} />
                    </Field>
                    <Field label="冷却" hint="触发后几条消息内不再触发" id="tl-wi-cooldown">
                        <input id="tl-wi-cooldown" class="tl-input" type="number" min="0" inputMode="numeric" value={form.cooldown ?? ''} placeholder="不冷却"
                            onInput={e => set('cooldown', optionalNumber(e.currentTarget.value))} />
                    </Field>
                    <Field label="推迟" hint="故事不到几条消息时不触发" id="tl-wi-delay">
                        <input id="tl-wi-delay" class="tl-input" type="number" min="0" inputMode="numeric" value={form.delay ?? ''} placeholder="不推迟"
                            onInput={e => set('delay', optionalNumber(e.currentTarget.value))} />
                    </Field>
                </div>

                {!form.constant && (
                    <>
                        <Field label="往前看几条消息" hint="在最近几条消息里找关键词；不填就跟随全局设置" id="tl-wi-scan">
                            <input id="tl-wi-scan" class="tl-input" type="number" min="0" inputMode="numeric" value={form.scanDepth ?? ''} placeholder="跟随全局设置"
                                onInput={e => set('scanDepth', optionalNumber(e.currentTarget.value))} />
                        </Field>
                        <div class="tl-row tl-wi-timing">
                            <Field label="区分大小写" id="tl-wi-case">
                                <select id="tl-wi-case" class="tl-input" value={triValue(form.caseSensitive)} onChange={e => set('caseSensitive', e.currentTarget.value === '' ? null : e.currentTarget.value === 'true')}>
                                    {TRI.map(([value, label]) => <option value={value}>{label}</option>)}
                                </select>
                            </Field>
                            <Field label="只匹配整个词" hint="对英文有用" id="tl-wi-whole">
                                <select id="tl-wi-whole" class="tl-input" value={triValue(form.matchWholeWords)} onChange={e => set('matchWholeWords', e.currentTarget.value === '' ? null : e.currentTarget.value === 'true')}>
                                    {TRI.map(([value, label]) => <option value={value}>{label}</option>)}
                                </select>
                            </Field>
                        </div>
                    </>
                )}
                <p class="tl-muted">角色筛选、触发时机、自动化 ID 在原版界面里改</p>
            </details>

            <ScopeNotice sources={sources} />
            {!isNew && <div class="tl-list">
                <button class="tl-list-item" data-danger="true" disabled={!!readOnlyReason || !!draftError} onClick={() => setSheet('delete')}>
                    <span class="tl-list-label">删除这一条</span>
                </button>
            </div>}

            {sheet === 'delete' && (
                <ConfirmSheet title={`删除「${entryTitle(entry)}」？`} confirmLabel="删除" message={`删掉就找不回来了`}
                    onClose={() => setSheet(null)} onConfirm={remove} />
            )}
            {sheet === 'leave' && (
                <ConfirmSheet title={pending ? '还不知道存没存上' : '还有没保存的草稿'} confirmLabel={pending ? '保留草稿，返回' : '放弃草稿，返回'}
                    message={pending ? '本机会留着保存记录和草稿；返回不会撤回刚才的保存。稍后检查一下，别重复创建' : '只放弃这一页没保存的改动；之前保存的不受影响'}
                    onClose={() => setSheet(null)} onConfirm={() => { if (!pending) editorDrafts.delete(scope); setSheet(null); leave(); }} />
            )}
        </main></fieldContext.Provider>
    );
}
