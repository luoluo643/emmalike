import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import * as engine from './engine.js';
import { EngineStatus, PageHeader, Sheet, Spinner, friendlyError, goBack, useBackLayer } from './ui.jsx';
import { applySavedPromptDraft, canSubmitPresetKey, clonePreset, createPromptDraftStore, makePromptDraft, PRESET_FIELDS, presetScope, presetSearch, refreshPromptDraft, isBlockingPresetOperation, hasPresetUserDecision, presetTargetKey, PRESET_DECISION_ACK } from './preset-editor-model.js';
import './preset-editor.css';

const BUILT_IN = { main: '主提示词', nsfw: '辅助提示词', jailbreak: '后置指令', enhanceDefinitions: '增强定义', chatHistory: '聊天记录', worldInfoBefore: '世界书（角色设定前）', worldInfoAfter: '世界书（角色设定后）', dialogueExamples: '对话示例', charDescription: '角色设定', charPersonality: '角色性格', scenario: '场景', personaDescription: '我的身份介绍' };
const ROLE = { system: '系统', user: '用户', assistant: 'AI' };
const promptName = p => BUILT_IN[p.identifier] && /^[\x20-\x7e]*$/.test(p.name || '') ? BUILT_IN[p.identifier] : p.name || p.identifier;
const presetName = name => name === 'Default' ? '默认' : name;
const drafts = new Map(), views = new Map();
const draftStore = createPromptDraftStore();
// Earlier versions kept a stored draft for every entry opened; clear those with nothing unapplied once per visit.
let draftsPruned = false;
const savedDraft = (account, name, identifier) => {
    const scope = presetScope(account, name, identifier);
    try { return drafts.get(scope) || draftStore.read({ account, name, identifier }); } catch { return drafts.get(scope); }
};
const COMMON = ['openai_max_tokens', 'openai_max_context', 'temperature'], MORE = ['top_p', 'frequency_penalty', 'presence_penalty'];
const commonPrompt = p => ['main', 'nsfw', 'jailbreak'].includes(p.identifier) || !p.marker;
const labelValue = value => value === undefined ? '（不存在）' : typeof value === 'string' ? value : JSON.stringify(value);
function ScopeNotice({ sources }) {
    return <p class="tl-preset-scope">这个预设是账号里共用的，别的故事也会用到。
        {sources?.chat && <> 当前聊天：{sources.chat}。</>}{sources?.character && <> 角色：{sources.character}。</>}
        {sources?.persona && <> 我的身份：{sources.persona}。</>}</p>;
}
function Conflicts({ conflicts, onChoose }) {
    return <section class="tl-preset-conflicts" aria-label="字段冲突"><p>同一项在别处也改了，逐项选一下。其他改动会保留</p>
        {conflicts.map(conflict => <div key={conflict.key}><strong>{conflict.label}</strong>
            <details><summary>对比我的和现在的</summary><p>本地</p><pre>{labelValue(conflict.mine)}</pre><p>当前</p><pre>{labelValue(conflict.server)}</pre></details>
            <div class="tl-row"><button class="tl-button" onClick={() => onChoose(conflict, 'mine')}>使用我的修改</button><button class="tl-button" onClick={() => onChoose(conflict, 'server')}>使用当前内容</button></div></div>)}</section>;
}
function NumberSetting({ field, setting, busy, modified, onCommit }) {
    const [text, setText] = useState(String(setting.value ?? '')), composing = useRef(false), focused = useRef(false), focusBase = useRef(setting.value);
    useEffect(() => { if (!focused.current) { setText(String(setting.value ?? '')); focusBase.current = setting.value; } }, [setting.value]);
    const commit = () => {
        if (busy || composing.current) return;
        const number = text.trim() === '' ? NaN : Number(text);
        if (!Number.isFinite(number)) return setText(String(setting.value ?? ''));
        const value = Math.max(setting.min ?? number, Math.min(setting.max ?? number, number)); setText(String(value));
        if (value !== setting.value) onCommit(field, value, focusBase.current);
    };
    return <div class="tl-field-group" data-modified={modified || undefined}>
        <label class="tl-field-label" for={`tl-preset-${field}`}>{PRESET_FIELDS[field]}{modified && <span class="tl-preset-modified"> · 还没存进预设</span>}</label>
        <input class="tl-input" id={`tl-preset-${field}`} type="number" inputMode="decimal" value={text} min={setting.min ?? undefined} max={setting.max ?? undefined} step={setting.step || 'any'} disabled={busy}
            onFocus={() => { focused.current = true; focusBase.current = setting.value; }} onInput={e => setText(e.currentTarget.value)} onBlur={() => { focused.current = false; commit(); }}
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={e => { if (e.key === 'Enter' && !e.isComposing && !composing.current && e.keyCode !== 229) { e.preventDefault(); commit(); } }} />
        <span class="tl-field-hint">{setting.min !== null && setting.max !== null ? `范围 ${setting.min}～${setting.max}` : ''}</span>
    </div>;
}

function PromptEditor({ origin, prompt, active, bridge, onDone, reload, requestSwitch }) {
    const scope = presetScope(origin.account, origin.name, prompt.identifier);
    const initialError = useRef(''), initialReadFailed = useRef(false);
    const [draft, writeDraft] = useState(() => { try { return drafts.get(scope) || draftStore.read({ ...origin, identifier: prompt.identifier }) || makePromptDraft(origin, prompt); }
        catch (error) { initialError.current = error.message; initialReadFailed.current = true; return makePromptDraft(origin, prompt); } });
    const [saving, setSaving] = useState(false), [status, setStatus] = useState('文字先留作草稿，点「应用」才生效');
    const [leaving, setLeaving] = useState(false), [conflicts, setConflicts] = useState([]);
    const current = useRef(draft), lock = useRef(false), mounted = useRef(true), composing = useRef(false), textarea = useRef(null), page = useRef(null);
    const sameTarget = active?.account === origin.account && active?.name === origin.name, dirty = draft.text !== draft.base, modified = draft.text !== draft.opened;
    const setDraft = next => { current.current = typeof next === 'function' ? next(current.current) : next; drafts.set(scope, current.current); writeDraft(current.current);
        if (!initialReadFailed.current) { try { draftStore.write(current.current); initialError.current = ''; } catch (error) { initialError.current = error.message; } } };
    useEffect(() => () => { mounted.current = false; }, []);
    const remote = sameTarget ? active.prompts.find(p => p.identifier === prompt.identifier)?.content : undefined;
    useEffect(() => {
        if (!sameTarget) return;
        const updated = refreshPromptDraft(current.current, remote); setDraft(updated);
        if (updated.conflict) setStatus(updated.conflict.missing ? '这个条目不在了，草稿还在' : '原版也改了这里，你写的还在，看过再应用');
    }, [sameTarget, remote]);
    const back = () => { if (lock.current) return setStatus('正在应用，可以接着写，好了再返回'); dirty ? setLeaving(true) : onDone(); };
    useBackLayer(true, back);
    const showCaret = () => requestAnimationFrame(() => {
        const element = textarea.current, viewport = window.visualViewport;
        if (!element || document.activeElement !== element) return;
        const bottom = (viewport?.offsetTop || 0) + (viewport?.height || innerHeight) - 82, top = (viewport?.offsetTop || 0) + 64, rect = element.getBoundingClientRect();
        if (rect.top > bottom - 100 || rect.bottom < top + 60) element.scrollIntoView({ block: 'center', behavior: 'instant' });
        // Measure wrapping with the textarea's real typography; newline counts hide a caret
        // in a long wrapped paragraph when a phone keyboard changes the visible height.
        const style = getComputedStyle(element), line = Number.parseFloat(style.lineHeight) || 24;
        const mirror = document.createElement('div'), marker = document.createElement('span');
        for (const key of ['font', 'lineHeight', 'letterSpacing', 'wordSpacing', 'padding', 'textIndent', 'tabSize']) mirror.style[key] = style[key];
        Object.assign(mirror.style, { position: 'fixed', left: '-10000px', top: '0', width: `${element.clientWidth}px`, boxSizing: 'border-box', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', visibility: 'hidden' });
        mirror.textContent = element.value.slice(0, element.selectionEnd); marker.textContent = '.'; mirror.append(marker); document.body.append(mirror);
        const caretTop = marker.getBoundingClientRect().top - mirror.getBoundingClientRect().top; mirror.remove();
        if (caretTop < element.scrollTop) element.scrollTop = caretTop;
        else if (caretTop + line > element.scrollTop + element.clientHeight) element.scrollTop = caretTop + line - element.clientHeight + 5;
    });
    useEffect(() => {
        const resize = () => { const height = window.visualViewport?.height || innerHeight;
            page.current?.style.setProperty('--tl-preset-vh', `${height}px`); if (page.current) page.current.dataset.compact = String(height < 440); showCaret(); };
        resize(); window.visualViewport?.addEventListener('resize', resize); window.visualViewport?.addEventListener('scroll', resize);
        return () => { window.visualViewport?.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('scroll', resize); };
    }, []);
    const apply = async resolution => {
        if (lock.current || !sameTarget || composing.current || !dirty && !resolution) return;
        const submitted = clonePreset(current.current); lock.current = true; setSaving(true); setStatus('正在应用…'); setConflicts([]);
        try {
            const result = await bridge.presetEditorApplyPrompt({ account: origin.account, name: origin.name, identifier: prompt.identifier, base: submitted.base, text: submitted.text, resolution });
            if (!mounted.current) return;
            if (result.kind === 'conflict') { setConflicts(result.conflicts); setStatus('同一项在别处也改了，没有覆盖'); }
            else if (result.kind === 'confirmed') {
                setDraft(applySavedPromptDraft(current.current, submitted, result.content));
                setStatus(current.current.text === result.content ? '已用上，还没存进预设' : '已应用；之后写的还是草稿');
            } else setStatus(result.error || '还不知道应用成没成，草稿还在');
        } catch (e) { if (mounted.current) setStatus(friendlyError(e.message)); }
        finally { lock.current = false; if (mounted.current) { setSaving(false); reload(); } }
    };
    return <main class="tl-page tl-preset-page tl-prompt-editor" ref={page}>
        <PageHeader title={promptName(prompt)} onBack={back} />
        <div class="tl-preset-editor-scroll">
            <p class="tl-preset-origin">正在编辑「{presetName(origin.name)}」的文字草稿。现在用的是「{presetName(active?.name) || '还没确认'}」。</p>
            {!sameTarget && <div class="tl-preset-warning" role="status">预设或账号已切换，原稿保留，不会应用到新预设。
                {active?.account === origin.account && <button class="tl-button" disabled={saving} onClick={() => requestSwitch(origin.name)}>返回原预设继续编辑</button>}</div>}
            <ScopeNotice sources={origin.sources} /><p role="status" class="tl-preset-status">{status}</p>
            {initialError.current && <p class="tl-error" role="alert">{initialError.current}</p>}
            <div class="tl-field-group" data-modified={modified || undefined}>
                <label class="tl-field-label" for="tl-prompt-text">内容 · {ROLE[prompt.role] || prompt.role}</label>
                {modified && <span class="tl-preset-modified">本次已改 1 处 <button class="tl-link" onClick={() => { setDraft(d => ({ ...d, text: d.opened, revision: d.revision + 1 })); setStatus('已恢复成打开时的样子；要生效请再点「应用」'); }}>恢复成打开时</button></span>}
                <textarea ref={textarea} id="tl-prompt-text" class="tl-input tl-field" value={draft.text} spellcheck={false}
                    onInput={e => { const text = e.currentTarget.value; setDraft(d => ({ ...d, text, revision: d.revision + 1 })); setStatus('有没应用的文字'); }}
                    onFocus={showCaret} onClick={showCaret} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
                    onKeyDown={e => { if (canSubmitPresetKey(e) && !composing.current) { e.preventDefault(); apply(); } }} />
                <span class="tl-field-hint">{'{{char}}'} 指角色，{'{{user}}'} 指你。返回不会撤回已经应用的配置。</span>
            </div>
            {!!conflicts.length && <Conflicts conflicts={conflicts} onChoose={(conflict, take) => apply({ take, server: conflict.server })} />}
        </div>
        <footer class="tl-preset-editor-actions"><span>{dirty ? '文字还没应用' : '当前文字已应用'}</span><button class="tl-button tl-primary" disabled={!dirty || saving || !sameTarget} onClick={() => apply()}>{saving ? '正在应用…' : '应用'}</button></footer>
        {leaving && <Sheet title="还有没应用的文字" onClose={() => setLeaving(false)}><p class="tl-sheet-note">只影响这个提示词没应用的文字，已经应用的不变</p>
            <button class="tl-sheet-item" onClick={() => { setLeaving(false); onDone(); }}>保留草稿并返回</button>
            <button class="tl-sheet-item" onClick={() => { try { draftStore.remove(current.current); drafts.delete(scope); setLeaving(false); onDone(); }
                catch (error) { setLeaving(false); setStatus(friendlyError(error.message)); } }}>放弃没应用的文字，返回</button></Sheet>}
    </main>;
}

/** While the first read runs (on a large account it takes a while): what will be here, so nobody goes to the full app for it. */
function PresetLoading() {
    const [seconds, setSeconds] = useState(0);
    useEffect(() => { const timer = setInterval(() => setSeconds(s => s + 1), 1000); return () => clearInterval(timer); }, []);
    return <section class="tl-preset-loading" role="status">
        <strong>正在加载预设条目…<span aria-hidden="true">{seconds >= 3 ? ` 已等 ${seconds} 秒` : ''}</span></strong>
        <p>读完就能在这里开关、编辑、排序和复制每个条目。条目多的预设要十几秒</p>
        <span class="tl-preset-loading-bar" aria-hidden="true" />
    </section>;
}

/** Every entry in the order sent to the model: up and down, copy, or pick one and put it next to another. */
function ArrangeList({ prompts, picked, arranging, fresh, busy, onPick, onArrange }) {
    const from = prompts.findIndex(prompt => prompt.identifier === picked), moving = prompts[from];
    return <>
        <p class="tl-muted">{moving ? `把「${promptName(moving)}」移到哪里？点目标那一行的按钮。` : '按发给 AI 的先后排列。可以上下挪一格，或点「挪到…」再选位置；复制出的副本在原条目下面，先关着'}</p>
        <div class="tl-list">{prompts.map((prompt, index) => {
            const name = promptName(prompt), working = arranging?.identifier === prompt.identifier;
            return <div class="tl-preset-row tl-preset-arrange-row" key={prompt.identifier} data-id={prompt.identifier} data-off={!prompt.enabled || undefined}
                data-picked={picked === prompt.identifier || undefined} data-fresh={fresh === prompt.identifier || undefined}>
                <div class="tl-preset-arrange-name"><span class="tl-list-label">{index + 1}. {name} <span class="tl-prompt-role">{prompt.marker ? '位置标记' : ROLE[prompt.role] || prompt.role}</span></span>
                    <span class="tl-list-hint">{working ? arranging.action === 'copy' ? '正在复制…' : '正在移动…' : prompt.enabled ? '已打开' : '已关闭'}</span></div>
                <div class="tl-preset-arrange-actions">{moving
                    ? picked === prompt.identifier ? <button class="tl-chip" disabled={busy} onClick={() => onPick(null)}>取消</button>
                        : <button class="tl-chip" disabled={busy} aria-label={`把「${promptName(moving)}」移到「${name}」${index < from ? '前面' : '后面'}`} onClick={() => onArrange('move', moving, index)}>移到这条{index < from ? '前面' : '后面'}</button>
                    : <>
                        <button class="tl-chip" disabled={busy || index === 0} aria-label={`上移「${name}」`} onClick={() => onArrange('move', prompt, index - 1)}>↑</button>
                        <button class="tl-chip" disabled={busy || index === prompts.length - 1} aria-label={`下移「${name}」`} onClick={() => onArrange('move', prompt, index + 1)}>↓</button>
                        <button class="tl-chip" disabled={busy || prompts.length < 2} aria-label={`挪动「${name}」`} onClick={() => onPick(prompt.identifier)}>挪到…</button>
                        {!prompt.marker && <button class="tl-chip" disabled={busy} aria-label={`复制「${name}」`} onClick={() => onArrange('copy', prompt)}>复制</button>}
                    </>}</div>
            </div>;
        })}</div>
    </>;
}

export function PresetPage({ eng, notify = () => {}, onOpenPanel, bridge: supplied, onBack = () => goBack({ name: 'me' }) }) {
    const bridge = supplied || (eng.state === 'ready' ? engine.getBridge() : null);
    const [state, setState] = useState(null), [loaded, setLoaded] = useState(false), [editing, setEditing] = useState(null), [busy, setBusy] = useState(false), [saving, setSaving] = useState(false);
    const [status, setStatus] = useState(''), [error, setError] = useState(''), [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
    const [applying, setApplying] = useState(null), [arrangeMode, setArrangeMode] = useState(false), [picked, setPicked] = useState(null), [arranging, setArranging] = useState(null), [fresh, setFresh] = useState('');
    const [view, setView] = useState('common'), [sheet, setSheet] = useState(null), [copyName, setCopyName] = useState('');
    const [conflicts, setConflicts] = useState([]), [pending, setPending] = useState(null), [showChanges, setShowChanges] = useState(false), [needsRead, setNeedsRead] = useState(false);
    const mounted = useRef(true), lock = useRef(false), serial = useRef(0), current = useRef(state), listPage = useRef(null), currentView = useRef(null);
    const latestRead = useRef(null), unverified = useRef(false);
    const resolutions = useRef({}), saveIntent = useRef(null), composing = useRef(false); current.current = state;
    useEffect(() => { if (!supplied) engine.requestEngine('action'); if (!draftsPruned) { draftsPruned = true; draftStore.pruneClean(); } return () => { mounted.current = false; }; }, []);
    const reload = ({ fresh = true } = {}) => {
        if (!bridge?.presetEditorState) return Promise.resolve({ ok: false });
        const sequence = ++serial.current;
        // A save must await the read that actually reaches the screen. Native events
        // can supersede its first read; follow their result instead of unlocking with stale differences.
        const request = (async () => {
            try {
                const next = await bridge.presetEditorState({ fresh });
                if (!mounted.current) return { ok: false };
                if (sequence !== serial.current) return latestRead.current;
                current.current = next; setState(next); setLoaded(true);
                if (unverified.current) { unverified.current = false; setNeedsRead(false); setError(''); setStatus('已重新加载'); }
                return { ok: true, state: next };
            } catch (e) {
                if (!mounted.current) return { ok: false };
                if (sequence !== serial.current) return latestRead.current;
                setError(friendlyError(e.message)); return { ok: false, error: e };
            }
        })();
        latestRead.current = request; return request;
    };
    useEffect(() => { reload(); }, [bridge]);
    useEffect(() => {
        if (!bridge) return;
        let timer; const refresh = () => { clearTimeout(timer); timer = setTimeout(() => reload({ fresh: false }), 40); };
        const unsubscribe = bridge.onPresetEditorChange?.(refresh) || engine.onEngine(type => { if (['preset-changed', 'settings'].includes(type)) refresh(); });
        addEventListener('focus', refresh); const visible = () => { if (!document.hidden) refresh(); }; document.addEventListener('visibilitychange', visible);
        return () => { clearTimeout(timer); unsubscribe?.(); removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visible); };
    }, [bridge]);
    const viewScope = state ? presetScope(state.account, state.name) : null;
    useLayoutEffect(() => {
        if (!viewScope || viewScope === currentView.current) return;
        currentView.current = viewScope; const saved = views.get(viewScope); setQuery(saved?.query || ''); setFilter(saved?.filter || 'all');
        try { setView(localStorage.getItem(`tavern-lite:preset-view:${state.account}`) || 'common'); } catch {}
        if (listPage.current) listPage.current.scrollTop = saved?.scrollTop || 0;
    }, [viewScope]);
    const remember = () => { if (viewScope) views.set(viewScope, { query, filter, scrollTop: listPage.current?.scrollTop || 0 }); };
    useEffect(() => { remember(); }, [query, filter]);
    const leave = action => { if (lock.current || saving || busy) return setStatus('还在处理，好了再返回');
        unverified.current || current.current?.changes.length ? setSheet({ type: 'leave', action, unverified: unverified.current }) : action(); };
    useBackLayer(!editing && (!!state?.changes.length || saving || needsRead), () => leave(onBack));
    const select = async target => {
        if (lock.current) return; lock.current = true; setBusy(true); setStatus('正在切换预设…');
        try { const next = await bridge.presetEditorSelect({ account: current.current.account, name: current.current.name, target });
            if (mounted.current) { setState(next); setStatus(`现在用的是「${presetName(next.name)}」。原来的文字草稿还留在原预设里`); setSheet(null); } }
        catch (e) { if (mounted.current) setError(friendlyError(e.message)); }
        finally { lock.current = false; if (mounted.current) { setBusy(false); reload(); } }
    };
    const switchSource = () => { const now = current.current; return now && { account: now.account, apiId: now.apiId, name: now.name, epoch: now.epoch }; };
    const requestSwitch = target => {
        if (lock.current || saving || busy) return;
        if (unverified.current || current.current?.changes.length) setSheet({ type: 'switch', target, source: switchSource(), unverified: unverified.current });
        else select(target);
    };
    const change = async (key, value, base) => {
        if (lock.current) return; lock.current = true; setBusy(true); setError(''); setApplying({ key, value });
        // The answer is already a fresh read of the current configuration; only a failure needs another one.
        let fresh = false;
        try { const next = await bridge.presetEditorSetField({ account: state.account, name: state.name, key, value, base }); if (mounted.current) { current.current = next; setState(next); setStatus('已用上，还没存进预设'); fresh = true; } }
        catch (e) { if (mounted.current) setError(friendlyError(e.message)); }
        finally { lock.current = false; if (mounted.current) { setBusy(false); setApplying(null); if (!fresh) reload(); } }
    };
    const arrange = async (action, prompt, to) => {
        if (lock.current) return; lock.current = true; setBusy(true); setError(''); setArranging({ action, identifier: prompt.identifier });
        let answered = false;
        try {
            const next = await bridge.presetEditorArrangePrompt({ account: state.account, name: state.name, action, identifier: prompt.identifier,
                order: state.prompts.map(item => item.identifier), to, copyName: `${promptName(prompt)} 副本` });
            if (mounted.current) {
                current.current = next; setState(next); answered = true; setFresh(next.created || prompt.identifier);
                setStatus(action === 'copy' ? `已复制「${promptName(prompt)}」，副本在它下面、先关着；还没存进预设` : '新顺序已用上，还没存进预设');
            }
        } catch (e) { if (mounted.current) setError(friendlyError(e.message)); }
        finally { lock.current = false; if (mounted.current) { setBusy(false); setArranging(null); setPicked(null); if (!answered) reload(); } }
    };
    useEffect(() => {
        if (!fresh) return;
        document.querySelector(`.tl-preset-row[data-id="${CSS.escape(fresh)}"]`)?.scrollIntoView({ block: 'nearest' });
        const timer = setTimeout(() => setFresh(''), 2400); return () => clearTimeout(timer);
    }, [fresh]);
    const shownOn = prompt => applying?.key === `enabled:${prompt.identifier}` ? applying.value : prompt.enabled;
    const recordOperation = result => setPending(isBlockingPresetOperation(result.operation) || result.kind === 'saved-not-applied' ? result.operation : null);
    const recordResult = result => {
        const text = result.kind === 'confirmed' ? result.applied ? `副本已保存并用上：「${presetName(result.name)}」，原预设没动` : '已存进预设；之后的改动还要再存'
            : result.kind === 'saved-not-applied' ? `副本已保存，但还没确认切过去。现在用的是「${presetName(result.actualCurrent)}」。${result.error || ''}`
                : result.kind === 'not-submitted' ? result.error || '这次没存，设置和草稿都还在，可以再试'
                    : result.kind === 'user-decided' ? result.error
                        : result.kind === 'historical-observation' ? `已检查上次保存：${result.fileConfirmed ? '跟上次存的一样' : '跟上次存的不一样'}。现在的设置没动`
                            : result.error?.includes('还不知道存没存上') ? result.error : `还不知道存没存上。${result.error || '先检查一下，也可以另存一个新名字'}`;
        setStatus(text); recordOperation(result); notify(text, 'info');
    };
    const recordRefreshedResult = async result => {
        const refreshed = result.kind === 'confirmed' || result.kind === 'saved-not-applied';
        if (refreshed) {
            // Retire the previous local unknown receipt as soon as this operation is
            // confirmed. UI read failure must not resurrect it after a later successful read.
            recordOperation(result);
            unverified.current = true; setNeedsRead(true); setStatus('已存进预设，正在检查…');
            const read = await reload();
            if (!mounted.current) return true;
            if (!read.ok) { unverified.current = true; setNeedsRead(true); setStatus('已存进预设，但还没检查完。重新加载后再存'); return true; }
        }
        recordResult(result); return refreshed;
    };
    const save = async intent => {
        if (lock.current || unverified.current) return; lock.current = true; setSaving(true); setError(''); setConflicts([]); saveIntent.current = intent;
        let refreshed = false;
        const source = current.current; setStatus(intent?.copyName ? '正在保存副本，存好就切过去…' : '正在保存…');
        try {
            const result = await bridge.presetEditorSave({ account: source.account, name: source.name, ...intent, resolutions: resolutions.current });
            if (!mounted.current) return;
            if (result.kind === 'conflict' && result.conflicts) { setConflicts(result.conflicts); setSheet(null); setStatus('预设在别处也改了同一项，没有覆盖'); }
            else {
                refreshed = await recordRefreshedResult(result);
                if (mounted.current) { setSheet(null); resolutions.current = {}; }
            }
        } catch (e) { if (mounted.current) { setError(friendlyError(e.message)); setStatus(e.saveOutcome === 'not-submitted'
            ? e.receiptPersisted === false ? '这次没存，也没记下结果；设置和草稿都还在'
                : '这次没存，设置和文字草稿都还在，处理好提示的问题再试'
            : '还不知道存没存上，设置和草稿都还在。先检查一下，或者另存一个新名字'); } }
        finally { lock.current = false; if (mounted.current) { setSaving(false); if (!refreshed) reload(); } }
    };
    const recover = async (operation, use = false) => {
        if (lock.current) return; lock.current = true; setSaving(true);
        let refreshed = false;
        try { const result = await bridge[use ? 'presetEditorUseCopy' : 'presetEditorRecover']({ account: state.account, name: state.name, operationId: operation.id });
            if (mounted.current) refreshed = await recordRefreshedResult(result); }
        catch (e) { if (mounted.current) setError(friendlyError(e.message)); }
        finally { lock.current = false; if (mounted.current) { setSaving(false); if (!refreshed) reload(); } }
    };
    const prepareDecision = async operation => {
        if (lock.current) return; lock.current = true; setBusy(true); setError('');
        try { const preview = await bridge.presetEditorPrepareDecision({ account: state.account, operationId: operation.id });
            if (mounted.current) setSheet({ type: 'decision', preview }); }
        catch (e) { if (mounted.current) setError(friendlyError(e.message)); }
        finally { lock.current = false; if (mounted.current) setBusy(false); }
    };
    const decide = async preview => {
        if (lock.current) return; lock.current = true; setBusy(true); setError('');
        try { const result = await bridge.presetEditorDecide({ ...preview, acknowledgement: PRESET_DECISION_ACK });
            if (mounted.current) { recordResult(result); setSheet(null); } }
        catch (e) { if (mounted.current) setError(friendlyError(e.message)); }
        finally { lock.current = false; if (mounted.current) { setBusy(false); reload(); } }
    };
    const openPrompt = prompt => { remember(); setEditing({ origin: clonePreset(state), prompt: clonePreset(prompt) }); };
    const done = () => { setEditing(null); reload(); requestAnimationFrame(() => { if (listPage.current) listPage.current.scrollTop = views.get(viewScope)?.scrollTop || 0; }); };
    const needle = query.trim().toLocaleLowerCase();
    const shown = state?.prompts.map(prompt => ({ prompt, search: presetSearch({ ...prompt, name: promptName(prompt) }, query) }))
        .filter(({ prompt, search }) => (filter === 'all' || (filter === 'on') === prompt.enabled) && search.matched && (view === 'all' || needle || commonPrompt(prompt))) || [];
    const fieldVisible = key => view === 'all' || COMMON.includes(key) || needle && `${PRESET_FIELDS[key]} ${state.samplers[key]?.value}`.toLocaleLowerCase().includes(needle);
    const modifiedKeys = new Set(state?.changes.map(item => item.path[0]));
    const operations = [...(state?.operations || [])];
    if (pending && pending.account === state?.account && !operations.some(op => op.id === pending.id)) operations.push(pending);
    const blockedTarget = operations.some(op => isBlockingPresetOperation(op)
        && presetTargetKey(op.account, op.apiId, op.name, state?.caseSensitiveNames) === state?.targetKey);
    const immediateBusy = busy || saving;
    const confirmSwitch = action => {
        setSheet(null);
        const now = switchSource();
        if (action.source && Object.keys(action.source).some(key => action.source[key] !== now?.[key])) {
            setStatus('预设变了，请重新选要切到哪个'); return;
        }
        if (action.type === 'use-copy') recover(action.operation, true); else select(action.target);
    };
    // A save whose result was never seen (the page was stopped mid-save, or this is a later visit) is checked once on
    // its own. The check only reads the server; only a result that is still unknown is left for the author.
    // Only records there when the page opened: a save made during this visit is followed by the page itself.
    const autoChecked = useRef(new Set()), leftBefore = useRef(null);
    useEffect(() => {
        if (state && !leftBefore.current) leftBefore.current = new Set((state.operations || []).map(op => op.id));
        const next = (state?.operations || []).find(op => leftBefore.current?.has(op.id) && isBlockingPresetOperation(op) && !autoChecked.current.has(op.id));
        if (!next || lock.current || saving || busy) return;
        autoChecked.current.add(next.id); recover(next);
    }, [state, saving, busy]);

    return <>
        {editing ? <PromptEditor key={presetScope(editing.origin.account, editing.origin.name, editing.prompt.identifier)} {...editing} active={state} bridge={bridge} onDone={done} reload={reload} requestSwitch={requestSwitch} />
            : <main class="tl-page tl-preset-page tl-preset-list-page" ref={listPage} onScroll={remember}>
                <PageHeader title="调整预设" onBack={() => leave(onBack)} />
                {!bridge && <><p class="tl-muted">准备好后，就能在这里开关、编辑、排序和复制每个提示词条目</p><EngineStatus eng={eng} meanwhile="好了会自动显示" /></>}
                {bridge && !bridge.presetEditorState && <p class="tl-preset-warning">暂时没法在这里保存，刷新一下，或在原版界面里改</p>}
                {bridge?.presetEditorState && loaded && !state && <p class="tl-preset-warning">这里只能改聊天补全的预设，现在的连接是别的类型，请在原版界面里改</p>}
                {bridge?.presetEditorState && !loaded && !error && <PresetLoading />}
                {error && <p class="tl-error" role="alert">{error} <button class="tl-button" onClick={reload}>重新加载</button></p>}
                {state && <>
                    <label class="tl-field-group">切换使用的预设<select class="tl-input" value={state.name} disabled={busy || saving} onChange={e => requestSwitch(e.currentTarget.value)}>{state.choices.map(name => <option value={name}>{presetName(name)}</option>)}</select></label>
                    <div class="tl-preset-savebar"><strong>现在用的是「{presetName(state.name)}」</strong><p role="status">{status || (state.changes.length ? `当前配置有 ${state.changes.length} 处没存进预设` : '都已存进预设')}</p>
                        <div class="tl-row"><button class="tl-button tl-primary" disabled={busy || saving || needsRead || blockedTarget || state.capabilities?.namedWrite === false} onClick={() => save({})}>{saving ? '正在保存…' : '保存到此预设'}</button>
                            <button class="tl-button" disabled={busy || saving || needsRead || state.capabilities?.copyAndUse === false} onClick={() => { setCopyName(`${state.name} 副本`); setError(''); setSheet({ type: 'copy' }); }}>另存并使用</button></div></div>
                    <button class="tl-button tl-preset-jump" onClick={() => document.getElementById('tl-preset-prompts')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}>
                        提示词条目 · {state.prompts.filter(p => p.enabled).length}/{state.prompts.length} 条打开 ↓</button>
                    {state.storageError && <p class="tl-error" role="alert">{state.storageError}。设置还能看，但本机存储恢复前存不了预设。</p>}
                    {state.changes.length > 0 && <div><button class="tl-button" onClick={() => setShowChanges(value => !value)}>查看这 {state.changes.length} 处改动</button>
                        {showChanges && <div class="tl-preset-change-list">{state.changes.map(change => <button class="tl-link" onClick={() => {
                            const prompt = state.prompts.find(p => p.identifier === change.path[1]?.value);
                            if (change.path[0] === 'prompts' && prompt?.canEdit) openPrompt(prompt);
                            else { const input = document.getElementById(`tl-preset-${change.path[0]}`); if (input) input.scrollIntoView({ block: 'center' }); else setStatus('这项改动在原版高级设置里看'); }
                        }}>{change.label}</button>)}</div>}</div>}
                    {!!conflicts.length && <Conflicts conflicts={conflicts} onChoose={(conflict, take) => {
                        resolutions.current[conflict.key] = { take, server: clonePreset(conflict.server) }; const remaining = conflicts.filter(item => item.key !== conflict.key); setConflicts(remaining); if (!remaining.length) save(saveIntent.current);
                    }} />}
                    {operations.map(operation => <section class="tl-preset-warning" key={operation.id} data-preset-operation={operation.id}><p>保存到：「{presetName(operation.name)}」。{isBlockingPresetOperation(operation) ? '还不知道存没存上，先不重复保存；聊天不受影响' : hasPresetUserDecision(operation) ? '已记下，可以接着改；上次的保存可能晚到并盖掉' : '副本已保存，还没用上'}查验只读取服务器，不会再写入。</p>
                        <button class="tl-button" disabled={saving || busy} onClick={() => recover(operation)}>检查这次保存</button>
                        {isBlockingPresetOperation(operation) && bridge.presetEditorPrepareDecision && <button class="tl-button" disabled={saving || busy || state.capabilities?.namedWrite === false} onClick={() => prepareDecision(operation)}>继续存这个名字有什么风险</button>}
                        {operation.mode === 'copy' && operation.stage === 'saved-not-applied' && <button class="tl-button" disabled={saving || busy} onClick={() => setSheet({ type: 'use-copy', operation, source: switchSource(), unverified: unverified.current })}>使用已保存副本</button>}</section>)}
                    <div class="tl-chips tl-preset-view" role="group" aria-label="预设设置显示范围">{[['common', '常用'], ['all', '全部设置']].map(([id, label]) => <button class="tl-chip" aria-pressed={view === id} onClick={() => { setView(id); try { localStorage.setItem(`tavern-lite:preset-view:${state.account}`, id); } catch {} }}>{label}</button>)}</div>
                    <input class="tl-input tl-search" type="search" aria-label="搜索当前预设" placeholder="搜索当前预设的名称或正文" value={query} onInput={e => setQuery(e.currentTarget.value)} />
                    {needle && <p class="tl-muted">只搜当前预设。搜到的高级条目会临时展开</p>}
                    <section class="tl-section" aria-label="参数"><p class="tl-muted">改了马上生效；存进预设要另外点保存</p>{[...COMMON, ...MORE].filter(key => fieldVisible(key) && state.samplers[key]).map(key => <NumberSetting key={`${viewScope}:${key}`} field={key} setting={state.samplers[key]} modified={modifiedKeys.has(key)} busy={immediateBusy} onCommit={change} />)}
                        <button class="tl-list-item tl-switch-row" role="switch" aria-label="流式输出" aria-checked={state.stream} aria-busy={applying?.key === 'stream_openai' ? 'true' : undefined} disabled={immediateBusy} onClick={() => change('stream_openai', !state.stream, state.stream)}><span class="tl-list-label">流式输出</span><span class="tl-list-hint">马上生效</span></button></section>
                    <section class="tl-section" id="tl-preset-prompts"><h2 class="tl-section-title">提示词条目 · {state.prompts.filter(p => p.enabled).length}/{state.prompts.length} 条打开</h2><p class="tl-muted">下面的条目按顺序拼成发给 AI 的内容；打开的才会用上</p>
                        <div class="tl-chips tl-preset-view" role="group" aria-label="提示词条目显示方式">{!arrangeMode && [['all', '全部'], ['on', '打开的'], ['off', '关闭的']].map(([id, label]) => <button class="tl-chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
                            <button class="tl-chip" aria-pressed={arrangeMode} onClick={() => { setArrangeMode(on => !on); setPicked(null); }}>{arrangeMode ? '排好了' : '排序和复制'}</button></div>
                        {arrangeMode ? <ArrangeList prompts={state.prompts} picked={picked} arranging={arranging} fresh={fresh} busy={immediateBusy}
                            onPick={setPicked} onArrange={arrange} /> : <><div class="tl-list">{shown.map(({ prompt, search }) => {
                            const stored = savedDraft(state.account, state.name, prompt.identifier);
                            return <div class="tl-preset-row" key={prompt.identifier} data-id={prompt.identifier} data-fresh={fresh === prompt.identifier || undefined} data-off={!shownOn(prompt) || undefined}><button class="tl-list-item tl-preset-open" disabled={!prompt.canEdit && !prompt.marker} onClick={() => prompt.canEdit ? openPrompt(prompt) : setStatus(`「${promptName(prompt)}」是位置标记，没有内容可改`)}>
                                <span class="tl-list-label">{promptName(prompt)} <span class="tl-prompt-role">{prompt.marker ? '位置标记' : ROLE[prompt.role] || prompt.role}</span></span>
                                <span class="tl-list-hint">{applying?.key === `enabled:${prompt.identifier}` ? (applying.value ? '正在打开…' : '正在关闭…') : prompt.enabled ? '已打开' : '已关闭'}{stored && stored.text !== stored.base ? ' · 有没应用的文字' : ''}</span>
                                {!!search.hits.length && <span class="tl-preset-hit">{search.hits[0].label}：{search.hits[0].snippet}</span>}</button>
                                {prompt.canToggle && <button class="tl-preset-toggle tl-switch-row" role="switch" aria-label={`打开「${promptName(prompt)}」`} aria-checked={shownOn(prompt)} aria-busy={applying?.key === `enabled:${prompt.identifier}` ? 'true' : undefined} disabled={immediateBusy} onClick={() => change(`enabled:${prompt.identifier}`, !prompt.enabled, prompt.enabled)} />}</div>;
                        })}</div>{!shown.length && <p class="tl-muted">没有符合的条目</p>}</>}</section>
                    <ScopeNotice sources={state.sources} /><p class="tl-muted">参数和开关马上生效；提示词文字先留草稿，点「应用」才生效。存进预设的只有已经生效的内容</p>
                </>}
                {bridge && (loaded || error || !bridge.presetEditorState) && <button class="tl-list-item" onClick={() => leave(() => onOpenPanel?.('ai-config'))}><span class="tl-list-label">在原版界面里打开</span><span class="tl-list-hint">导入导出、删除条目等更多操作</span></button>}
            </main>}
        {sheet && <Sheet title={sheet.type === 'copy' ? '另存并使用' : sheet.type === 'decision' ? '继续存这个名字的风险' : sheet.type === 'leave' ? sheet.unverified ? '改动还没检查完' : '改动已经生效' : sheet.unverified ? '切换前改动还没检查完' : '确认切换预设'} busy={busy || saving} onClose={() => setSheet(null)}>
            {sheet.type === 'copy' ? <div class="tl-preset-copy-form"><p>把现在生效的设置另存一份并切过去，原预设不动；没应用的文字留在原预设</p>
                <p class="tl-muted">原预设还不知道存没存上时，可以另存一个不同的新名字（只改大小写不算）</p>
                <label>副本名称<input class="tl-input" value={copyName} disabled={saving} onInput={e => setCopyName(e.currentTarget.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
                    onKeyDown={e => { if (canSubmitPresetKey(e) && !composing.current) { e.preventDefault(); save({ copyName }); } }} /></label>
                {error && <p class="tl-error" role="alert">{error}</p>}<button class="tl-button tl-primary" disabled={saving || !copyName.trim()} aria-busy={saving ? 'true' : undefined} onClick={() => save({ copyName })}>{saving ? <><Spinner />正在保存副本…</> : '保存副本并切换使用'}</button></div>
                : sheet.type === 'decision' ? <div class="tl-preset-copy-form"><p>目标：「{presetName(sheet.preview.operation.name)}」。本次查验{sheet.preview.basis.kind === 'missing' ? '没找到预设文件' : '已读到酒馆里的完整内容'}，仍无法证明旧请求不会晚些写入。继续同名保存后，旧请求仍可能覆盖新版。</p>
                    <p>这样只是允许你继续存这个名字，不代表上次存上了，也不会取消上次的保存。另存一个新名字可以避开这个问题</p>
                    <details><summary>上次存的和酒馆里现在的差别（{sheet.preview.changes.length} 项）</summary>{sheet.preview.changes.map(change => <label class="tl-field-group">{change.label}<textarea class="tl-input" readOnly rows={4} value={`上次存的：${labelValue(change.before)}\n酒馆里现在：${labelValue(change.after)}`} /></label>)}</details>
                    {error && <p class="tl-error" role="alert">{error}</p>}<button class="tl-button tl-primary" disabled={saving || busy} onClick={() => decide(sheet.preview)}>知道了，继续存这个名字</button></div>
                : <div class="tl-preset-copy-form"><p>{sheet.type === 'leave' ? sheet.unverified ? '已存进预设，但没能再检查一遍。之后的改动可能还没存' : '返回不会撤回已经生效的改动。没存进预设的改动，换预设后可能就没了' : sheet.unverified ? '改动还没检查完，可能有没存的。切换会换掉现在的设置，没存的改动可能丢失。可以先不切，重新加载后再决定' : '切换会换掉现在的设置，没存进预设的改动会丢'}</p>
                    {sheet.type !== 'leave' && sheet.unverified && <button class="tl-button" disabled={busy || saving} onClick={() => setSheet(null)}>暂不切换</button>}
                    <button class="tl-button tl-primary" disabled={busy || saving} onClick={() => { const action = sheet; if (action.type === 'leave') { setSheet(null); action.action(); } else confirmSwitch(action); }}>{sheet.type === 'leave' ? '继续返回' : sheet.unverified ? '仍要切换' : '确认切换'}</button></div>}
        </Sheet>}
    </>;
}
