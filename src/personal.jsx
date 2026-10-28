import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import * as engine from './engine.js';
import { ConfirmSheet, friendlyError, Sheet, SheetItem } from './ui.jsx';
import { hasStory, makeSource, mutation, newRecord, readRecords, sameStory, saveRecord, sourceMessages, locateSource } from './personal-records.js';
import './personal-workspace.css';

const place = r => r.storage === 'account' ? '已保存到账号' : '仅本机';
const label = s => hasStory(s) ? `${s.groupId ? '群聊' : s.name || '故事'} · ${s.file}` : '没记下来自哪个故事';
const invalid = '原文已改动或无法定位';
const nowhere = '这条记录没记下来自哪个故事，回不到出处；记下的原文还在';

export function CaptureSheet({ user, kind = 'quote', source, initialText, onSaved, onClose }) {
    const [selection, setSelection] = useState('');
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    const frozen = useRef(null), lock = useRef(false), body = useRef(null);
    const text = initialText || source.raw;
    useEffect(() => {
        const update = () => {
            const s = getSelection();
            if (!frozen.current && s?.rangeCount && body.current?.contains(s.anchorNode) && body.current.contains(s.focusNode)) setSelection(s.toString());
        };
        document.addEventListener('selectionchange', update);
        return () => document.removeEventListener('selectionchange', update);
    }, []);
    const save = async () => {
        if (lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try {
            if (!frozen.current) {
                const record = newRecord(kind, kind === 'variant' ? source.raw : selection.trim() ? selection : text, source);
                frozen.current = mutation(record, 'create', { record });
            }
            onSaved(await saveRecord(user.handle, frozen.current));
        }
        catch (e) { setError(friendlyError(e.message)); }
        finally { lock.current = false; setBusy(false); }
    };
    return <Sheet title={kind === 'quote' ? '收藏原句' : '先留这一版'} busy={busy} onClose={() => { if (!lock.current) onClose(); }}>
        <p class="tl-muted">{kind === 'quote' ? '选一句收藏，不选就收藏整段。备注不会发给 AI' : '存下这一版的原文，不影响现在用的回复'}</p>
        <div ref={body} class="tl-select-text tl-personal-text">{text}</div>
        {error && <p class="tl-error" role="alert">{error}。待保存的原文已保留。</p>}
        <button class="tl-button tl-primary" disabled={busy} onPointerDown={e => e.preventDefault()} onClick={save}>
            {busy ? '正在保存…' : error ? '重试保存' : kind === 'variant' ? '保存这版快照' : selection ? '收藏所选原句' : '收藏整段'}</button>
    </Sheet>;
}

export function PersonalNotice({ record, onNote, onUndo, onClose, busy }) {
    return <div class="tl-personal-notice" role="status">
        <span>{record.kind === 'quote' ? '已收藏' : '已存下这一版'} · {place(record)}</span>
        <button class="tl-button" onClick={onNote}>加备注</button>
        <button class="tl-button" disabled={busy} onClick={onUndo}>撤销</button>
        <button class="tl-ghost" aria-label="关闭收藏提示" onClick={onClose}>×</button>
    </div>;
}

export function CompareSheet({ record, current, onClose }) {
    const [tab, setTab] = useState(0);
    const [wide, setWide] = useState(() => matchMedia('(min-width: 900px)').matches);
    const panels = useRef([]), tabs = useRef([]), offsets = useRef([0, 0]), restoredTops = useRef([0, 0]), restoring = useRef(false), restoreFrame = useRef(0);
    const focusAfterLayout = useRef(false), snapshot = useRef([record.text, String(current ?? '')]);
    const id = useId(), names = ['留下的版', '当前版'];
    const restore = () => {
        restoring.current = true;
        cancelAnimationFrame(restoreFrame.current);
        panels.current.forEach((panel, i) => {
            if (panel?.getClientRects().length) { panel.scrollTop = offsets.current[i]; restoredTops.current[i] = panel.scrollTop; }
        });
        // Resize/layout can emit a delayed scroll event when clamping a hidden or shorter column.
        restoreFrame.current = requestAnimationFrame(() => {
            restoreFrame.current = requestAnimationFrame(() => { restoring.current = false; });
        });
    };
    useLayoutEffect(() => {
        const media = matchMedia('(min-width: 900px)');
        const update = () => {
            focusAfterLayout.current = [...tabs.current, ...panels.current].some(element => element === document.activeElement);
            restoring.current = true;
            setWide(media.matches);
        };
        media.addEventListener('change', update);
        const observer = new ResizeObserver(restore);
        panels.current.forEach(panel => panel && observer.observe(panel));
        addEventListener('resize', restore);
        return () => { media.removeEventListener('change', update); observer.disconnect(); removeEventListener('resize', restore); cancelAnimationFrame(restoreFrame.current); };
    }, []);
    useLayoutEffect(() => {
        restore();
        if (focusAfterLayout.current) { panels.current[tab]?.focus({ preventScroll: true }); focusAfterLayout.current = false; }
    }, [tab, wide]);
    const select = (index, focus = false) => {
        if (index === tab) { if (focus) tabs.current[index]?.focus(); return; }
        restoring.current = true;
        setTab(index);
        if (focus) tabs.current[index]?.focus();
    };
    return <Sheet title="比较" onClose={onClose} className="tl-workspace-sheet tl-compare-workspace" bodyClassName="tl-compare-body">
        <p class="tl-muted tl-workspace-hint">「当前版」是打开比较时的内容。比较只是看，不会改动故事，也不会让 AI 写</p>
        <div class="tl-compare-tabs tl-version-tabs" role="tablist" aria-label="比较版本" hidden={wide} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            select(event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - tab, true);
        }}>
            {names.map((name, i) => <button id={`${id}-tab-${i}`} aria-controls={`${id}-panel-${i}`} role="tab" aria-selected={tab === i}
                tabIndex={tab === i ? 0 : -1} class="tl-version-tab" ref={element => { tabs.current[i] = element; }} onClick={() => select(i)}>{name}</button>)}
        </div>
        <div class="tl-compare-columns">
            {snapshot.current.map((text, i) => <section class="tl-compare-pane" data-active={tab === i ? 'true' : 'false'} hidden={!wide && tab !== i}
                id={`${id}-panel-${i}`} role={wide ? 'region' : 'tabpanel'} aria-labelledby={wide ? `${id}-heading-${i}` : `${id}-tab-${i}`}>
                <h3 id={`${id}-heading-${i}`}>{names[i]}{i === 1 && <span class="tl-version-caption"> · 打开时的内容</span>}</h3>
                <div class="tl-personal-text tl-compare-scroll" ref={el => { panels.current[i] = el; }} tabIndex={0}
                    aria-label={i === 0 ? '快照正文' : '当前版正文'} onScroll={e => {
                        const top = e.currentTarget.scrollTop;
                        if (e.currentTarget.getClientRects().length && (!restoring.current || top !== restoredTops.current[i])) offsets.current[i] = top;
                    }}>{text}</div>
            </section>)}
        </div>
    </Sheet>;
}

function NoteEditor({ user, record, onDone }) {
    const [current, setCurrent] = useState(record), [text, setText] = useState(record.note || '');
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const compactInput = useRef(false);
    const area = useRef(null);
    const showInput = () => requestAnimationFrame(() => {
        const input = area.current;
        if (!input?.isConnected || document.activeElement !== input) return;
        const body = input.closest('.tl-note-body'), footer = body?.querySelector('.tl-note-actions');
        if (!body || !footer) return;
        const overflow = input.getBoundingClientRect().bottom - footer.getBoundingClientRect().top + 4;
        if (overflow > 0) body.scrollTop += overflow;
    });
    const request = useRef(null), lock = useRef(false), latest = useRef(text), alive = useRef(true); latest.current = text;
    const id = useId();
    useEffect(() => () => { alive.current = false; }, []);
    useEffect(() => {
        const viewport = window.visualViewport;
        const resize = () => {
            compactInput.current = (viewport?.height || innerHeight) < 300;
            if (compactInput.current) { setExpanded(false); showInput(); }
        };
        resize(); viewport?.addEventListener('resize', resize); addEventListener('resize', resize);
        return () => { viewport?.removeEventListener('resize', resize); removeEventListener('resize', resize); };
    }, []);
    const dirty = text !== (current.note || '');
    const close = () => { if (!lock.current) dirty ? setConfirm(true) : onDone(); };
    const save = async () => {
        if (lock.current) return;
        lock.current = true; setBusy(true); setError('');
        const captured = text;
        if (request.current?.note !== captured || request.current.expected !== current.revision) request.current = mutation(current, 'note', { note: captured });
        try {
            const next = await saveRecord(user.handle, request.current, current.storage);
            if (!alive.current) return;
            setCurrent(next);
            if (latest.current === captured) onDone(next);
        } catch (e) { if (alive.current) setError(friendlyError(e.message)); }
        finally { lock.current = false; if (alive.current) setBusy(false); }
    };
    return <><Sheet title="私人备注" onClose={close} busy={busy} className="tl-workspace-sheet tl-note-workspace" bodyClassName="tl-note-body">
        <div class="tl-note-source">
            <blockquote id={`${id}-source`} class="tl-personal-text tl-note-quote" data-expanded={expanded ? 'true' : 'false'} tabIndex={expanded ? 0 : undefined}>{record.text}</blockquote>
            <button class="tl-button tl-note-expand" aria-expanded={expanded} aria-controls={`${id}-source`} onClick={() => setExpanded(value => !value)}>{expanded ? '收起原文' : '展开原文'}</button>
        </div>
        <label class="tl-field-label" for="tl-private-note">只给自己看的备注</label>
        <textarea ref={area} id="tl-private-note" class="tl-input tl-field tl-note-input" rows={5} value={text} maxLength={20000} onInput={e => setText(e.currentTarget.value)}
            onFocus={() => {
                if (!compactInput.current) return;
                setExpanded(false);
                showInput();
            }} />
        <footer class="tl-note-actions">
            <p class="tl-muted tl-note-storage">{place(current)} · 不进入模型上下文；原句快照不会改变。</p>
            {error && <p class="tl-error" role="alert">{error}</p>}
            <button class="tl-button tl-primary" disabled={!dirty || busy} onClick={save}>{busy ? '正在保存…' : '保存备注'}</button>
        </footer>
    </Sheet>{confirm && <ConfirmSheet title="备注还没保存" message="没保存的备注会丢掉，收藏的原句还在" confirmLabel="放弃修改" onClose={() => setConfirm(false)} onConfirm={() => onDone()} />}</>;
}

export function PersonalSheet({ user, scope, initialRecord, onClose, onLocate, notify }) {
    const [records, setRecords] = useState(null), [mode, setMode] = useState('');
    const [filter, setFilter] = useState(scope ? 'story' : 'all'), [limit, setLimit] = useState(20);
    const [error, setError] = useState(''), [busy, setBusy] = useState(false), [undo, setUndo] = useState(null);
    const [recent, setRecent] = useState(null);
    const [editing, setEditing] = useState(initialRecord || null), [compare, setCompare] = useState(null), [capture, setCapture] = useState(null), [picker, setPicker] = useState(false);
    const [statuses, setStatuses] = useState({});
    const operations = useRef(new Map()), alive = useRef(true);
    const listBody = useRef(null), listScroll = useRef(0), recordsOwner = useRef(user.handle);
    const epoch = useRef(0), account = useRef(user.handle); account.current = user.handle;
    const reload = async () => {
        const request = ++epoch.current, owner = user.handle;
        setError('');
        try { const data = await readRecords(owner); if (alive.current && request === epoch.current && account.current === owner) { recordsOwner.current = owner; setRecords(data.records); setMode(data.mode); } }
        catch (e) { if (alive.current && request === epoch.current && account.current === owner) setError(friendlyError(e.message)); }
    };
    useEffect(() => {
        alive.current = true;
        if (recordsOwner.current !== user.handle) { setRecords(null); setMode(''); setStatuses({}); listScroll.current = 0; }
        reload();
        const focus = () => reload(); addEventListener('focus', focus);
        return () => { alive.current = false; epoch.current++; removeEventListener('focus', focus); };
    }, [user.handle]);
    const visibleRecords = recordsOwner.current === user.handle ? records : null;
    const shown = (visibleRecords || []).filter(r => !r.deleted && (filter === 'all' || sameStory(scope, r.source))).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    useLayoutEffect(() => {
        if (listBody.current) listBody.current.scrollTop = listScroll.current;
    }, [editing, compare, capture, picker]);
    useEffect(() => {
        let active = true;
        const groups = new Map();
        for (const record of shown) {
            if (!hasStory(record.source)) { setStatuses(s => ({ ...s, [record.id]: false })); continue; }
            const key = JSON.stringify([record.source.avatar, record.source.groupId, record.source.file]);
            if (!groups.has(key)) groups.set(key, sourceMessages(record.source));
            groups.get(key).then(messages => { if (active) setStatuses(s => ({ ...s, [record.id]: locateSource(messages, record.source) || false })); })
                .catch(() => { if (active) setStatuses(s => ({ ...s, [record.id]: false })); });
        }
        return () => { active = false; };
    }, [records, filter, limit]);
    const action = async (record, type) => {
        if (busy) return;
        setBusy(true); setError('');
        const key = `${record.storage}:${record.id}:${record.revision}:${type}`;
        if (!operations.current.has(key)) operations.current.set(key, mutation(record, type));
        try {
            const next = await saveRecord(user.handle, operations.current.get(key), record.storage);
            operations.current.delete(key);
            setUndo(type === 'delete' ? next : null);
            if (type === 'delete' && recent?.id === record.id) setRecent(null);
            await reload();
        } catch (e) { setError(friendlyError(e.message)); }
        finally { setBusy(false); }
    };
    const inspect = async (record, comparison) => {
        setBusy(true); setError('');
        try {
            if (!hasStory(record.source)) throw new Error(nowhere);
            const found = locateSource(await sourceMessages(record.source), record.source);
            if (!found) throw new Error(invalid + '，快照仍保留');
            if (comparison) setCompare({ record, current: String(found.message.mes ?? '') });
            else if (!found.current) throw new Error('原句在另一个回复里，现在用的不是它；收藏还在');
            else await onLocate(record.source);
        } catch (e) { setError(friendlyError(e.message)); }
        finally { setBusy(false); }
    };
    if (editing) return <NoteEditor user={user} record={editing} onDone={next => {
        if (next && recent?.id === next.id) setRecent(next);
        setEditing(null); reload();
    }} />;
    if (compare) return <CompareSheet {...compare} onClose={() => setCompare(null)} />;
    if (capture) return <CaptureSheet user={user} {...capture} onClose={() => setCapture(null)} onSaved={record => { setCapture(null); setPicker(false); setRecent(record); reload(); }} />;
    if (picker) {
        // Only messages of an open story can be kept: anything else (the app's welcome page) has nowhere to go back to.
        const data = engine.getBridge()?.personalConversation?.();
        const here = hasStory(data?.scope) ? data.scope : null;
        return <Sheet title="从当前对话选取" onClose={() => setPicker(false)}>
            <p class="tl-muted">{here ? label({ ...here, name: here.name || '当前对话' }) : '现在没有打开的故事。先打开一个故事，或在原版界面里打开群聊，再回来选'}</p>
            {here && data.messages.map((m, index) => <div class="tl-personal-record">
                <strong>{m.name}</strong><p class="tl-personal-preview">{m.mes}</p>
                <button class="tl-button" disabled={engine.isGenerating()} onClick={() => setCapture({ kind: 'quote', source: makeSource(data.scope, m, index) })}>收藏原句</button>
                {!m.is_user && <button class="tl-button" disabled={engine.isGenerating()} onClick={() => setCapture({ kind: 'variant', source: makeSource(data.scope, m, index) })}>先留这一版</button>}
            </div>)}
            {engine.isGenerating() && <p class="tl-muted">生成完再收藏</p>}
        </Sheet>;
    }
    return <Sheet title="我的摘录" onClose={onClose} className="tl-personal-list-sheet">
        <div class="tl-personal-list-content" ref={listBody} onScroll={event => { listScroll.current = event.currentTarget.scrollTop; }}>
        <p class="tl-muted">{mode === 'account' ? '新摘录存到账号，换设备也能看；以前存在本机的还在本机' : mode === 'device' ? '只存在本机：清除网站数据会丢，换设备看不到' : '正在加载…'}。备注不会发给 AI。</p>
        {scope && <div class="tl-chips" role="group" aria-label="摘录范围">{[['story', '本故事'], ['all', '全部记录']].map(([id, name]) => <button class="tl-chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>{name}</button>)}</div>}
        {!scope && <SheetItem label="从当前对话选取" hint="也能收藏原版里正开着的群聊" disabled={!engine.getBridge()?.personalConversation} onClick={() => setPicker(true)} />}
        {error && <p class="tl-error" role="alert">{error} <button class="tl-button" onClick={reload}>重新载入</button></p>}
        {recent && <PersonalNotice record={recent} busy={busy} onNote={() => setEditing(recent)} onUndo={() => action(recent, 'delete')} onClose={() => setRecent(null)} />}
        {undo && <div class="tl-personal-notice" role="status">已删除记录 <button class="tl-button" disabled={busy} onClick={() => action(undo, 'restore')}>撤销删除</button></div>}
        {visibleRecords === null && !error && <p>正在加载…</p>}
        {visibleRecords && !shown.length && <p class="tl-muted">还没有摘录。长按消息可以收藏一句，或先留下一版回复</p>}
        {shown.map(record => <article class="tl-personal-record" key={`${record.storage}:${record.id}`} data-record-id={record.id}>
            <p class="tl-muted">{record.kind === 'quote' ? '原句' : '留下的版本'} · {place(record)} · {new Date(record.createdAt).toLocaleDateString()}</p>
            <p class="tl-personal-text">{record.text}</p>
            {record.note && <p class="tl-personal-note">备注：{record.note}</p>}
            <p class="tl-muted">{label(record.source)}{hasStory(record.source) && ` · ${statuses[record.id] === undefined ? '正在找原文…' : statuses[record.id] ? statuses[record.id].current ? '能找到原文' : '在另一个回复里' : invalid}`}</p>
            <div class="tl-row">
                {hasStory(record.source) && <button class="tl-button" disabled={busy} onClick={() => inspect(record, false)}>回到出处</button>}
                <button class="tl-button" disabled={busy} onClick={() => setEditing(record)}>修改备注</button>
                {record.kind === 'variant' && hasStory(record.source) && <button class="tl-button" disabled={busy} onClick={() => inspect(record, true)}>与当前版比较</button>}
                <button class="tl-button" disabled={busy} onClick={() => action(record, 'delete')}>删除记录</button>
            </div>
        </article>)}
        {records && shown.length >= limit && <button class="tl-button" onClick={() => setLimit(n => n + 20)}>显示更多记录</button>}
        </div>
    </Sheet>;
}
