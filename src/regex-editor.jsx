// Regex scripts in plain words: the three lists the app runs (global, the preset's, the character's), their switches,
// saved sets of switches, and one script's editor with a place to try it. Loaded only when opened. Every read and write
// goes through the full app (bridge-regex-editor.js), the way its own regex panel saves.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import * as engine from './engine.js';
import { ConfirmSheet, EngineStatus, PageHeader, PromptSheet, Sheet, SheetItem, Spinner, copyText, downloadFile, friendlyError, go, goBack, useBackLayer } from './ui.jsx';
import { regexExport } from './regex-export.js';
import { FILTERS, GROUP_NAMES, KINDS, PLACEMENTS, REGEX_GROUPS, SUBSTITUTE, alreadyIn, blankScript, ruleKey, comboChanges, comboUnknownGroups, depthInput, depthRangeEmpty, exportName, findNote,
    kindFlags, kindOf, matchesFilter, normalizeScript, parseFind, problemOf, regexSearch, scriptChanges, scriptFingerprint, scriptSummary, scriptsFromFile } from './regex-model.js';
import './regex-editor.css';

const drafts = new Map(), views = new Map(), samples = new Map();
const GROUP_HINTS = { global: '所有故事都用', preset: '跟着预设走，换预设就换一套', scoped: '只在这个角色的故事里用' };
const groupTitle = group => group.type === 'global' ? '全局' : group.owner ? `${GROUP_NAMES[group.type]}「${group.owner}」` : GROUP_NAMES[group.type];
const keyOf = (group, id) => `${group}:${id}`;
// A draft belongs to the account and to the preset or character it was written under: another with the same script
// (a copied preset, say) does not pick it up.
const draftKeyOf = (state, group, id) => `${state.account}|${group}|${id === 'new' ? `${state.owner.preset}|${state.owner.scoped}` : group === 'global' ? '' : state.owner[group]}|${id}`;
const ownerNames = state => Object.fromEntries(state.groups.map(g => [g.type, g.owner]));
// Given to a new script before its first save, so trying that save again cannot add it twice.
const newScriptId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function useBridge(eng) {
    useEffect(() => { engine.requestEngine('action'); }, []);
    return eng.state === 'ready' ? engine.getBridge() : null;
}

/** The bridge's state, read again whenever the app or this page changes something. */
function useRegexState(bridge) {
    const [state, setState] = useState(null), [error, setError] = useState('');
    const read = () => { if (!bridge?.regexEditorState) return; try { setState(bridge.regexEditorState()); setError(''); } catch (e) { setError(friendlyError(e.message)); } };
    useEffect(() => {
        read();
        if (!bridge?.onRegexEditorChange) return;
        let timer; const later = () => { clearTimeout(timer); timer = setTimeout(read, 40); };
        const off = bridge.onRegexEditorChange(later); addEventListener('focus', later);
        return () => { clearTimeout(timer); off(); removeEventListener('focus', later); };
    }, [bridge]);
    return [state, setState, error];
}

function Waiting({ eng }) {
    return <><p class="tl-muted">正则要等原版准备好才能打开</p><EngineStatus eng={eng} meanwhile="好了会自动显示" /></>;
}

export function RegexPage({ eng, notify, group, id, onOpenNative }) {
    const bridge = useBridge(eng);
    const [state, setState, error] = useRegexState(bridge);
    const [targetReady, setTargetReady] = useState(false), [targetError, setTargetError] = useState('');
    useEffect(() => {
        let active = true;
        if (!bridge?.regexSelectCharacter) return;
        setTargetReady(false); setTargetError('');
        bridge.regexSelectCharacter(null).then(result => { if (active) { setState(result.state); setTargetReady(true); } }, error => { if (active) setTargetError(friendlyError(error.message)); });
        return () => { active = false; };
    }, [bridge]);
    if (!bridge) return <main class="tl-page"><PageHeader title="正则" onBack={() => goBack({ name: 'me' })} /><Waiting eng={eng} /></main>;
    if (!bridge.regexEditorState) return <main class="tl-page"><PageHeader title="正则" onBack={() => goBack({ name: 'me' })} /><p class="tl-error">当前酒馆版本不支持，请在原版界面操作</p></main>;
    if (bridge.regexSelectCharacter && !targetReady) return <main class="tl-page"><PageHeader title="正则" onBack={() => goBack({ name: 'me' })} />{targetError ? <p class="tl-error">{targetError}</p> : <p class="tl-muted">正在加载…</p>}</main>;
    // The editor starts once the lists are read: its draft is found by account and by preset or character.
    if (id) return state ? <RegexEditor key={keyOf(group, id)} bridge={bridge} state={state} setState={setState} group={group} id={id} notify={notify} />
        : <main class="tl-page"><PageHeader title="正则" onBack={() => goBack({ name: 'regex' })} />{error ? <p class="tl-error" role="alert">{error}</p> : <p class="tl-muted">正在加载…</p>}</main>;
    return <RegexList bridge={bridge} state={state} setState={setState} error={error} notify={notify} onOpenNative={onOpenNative} generating={eng.generating} focus={REGEX_GROUPS.includes(group) ? group : ''} />;
}

/** `focus`: a list to show first (the preset page links to its own), and where a new script goes by default. */
function RegexList({ bridge, state, setState, error, notify, onOpenNative, focus, generating }) {
    const saved = views.get(state?.account) ?? {};
    const [query, setQuery] = useState(saved.query ?? ''), [filter, setFilter] = useState(saved.filter ?? 'all');
    const [working, setWorking] = useState(null), [status, setStatus] = useState(''), [sheet, setSheet] = useState(null);
    const [importSlow, setImportSlow] = useState(false);
    useEffect(() => {
        setImportSlow(false);
        if (!working?.startsWith('import:')) return;
        const timer = setTimeout(() => setImportSlow(true), 8000);
        return () => clearTimeout(timer);
    }, [working]);
    const [bulk, setBulk] = useState(false), [picked, setPicked] = useState(() => new Set());
    const [characterQuery, setCharacterQuery] = useState('');
    const selectionOwner = useRef(state?.owner?.scoped);
    useEffect(() => {
        if (selectionOwner.current !== state?.owner?.scoped) { setPicked(new Set()); setBulk(false); }
        selectionOwner.current = state?.owner?.scoped;
    }, [state?.owner?.scoped]);
    const fileInput = useRef(null), page = useRef(null);
    useEffect(() => { if (state) views.set(state.account, { ...views.get(state.account), query, filter }); }, [state?.account, query, filter]);
    // Back from a script: where the reader was. Arriving for one list: that list.
    useEffect(() => {
        if (!state) return;
        const view = views.get(state.account) ?? {};
        if (focus && view.focus !== focus) document.querySelector(`.tl-regex-group[data-group="${focus}"]`)?.scrollIntoView({ block: 'start' });
        else if (view.scroll) window.scrollTo({ top: view.scroll, behavior: 'auto' });
        views.set(state.account, { ...view, focus });
    }, [!!state]);
    useEffect(() => { const keep = () => state && views.set(state.account, { ...views.get(state.account), scroll: window.scrollY });
        addEventListener('scroll', keep, { passive: true }); return () => removeEventListener('scroll', keep); }, [state?.account]);

    /** Runs one change; the switch or button that started it shows its ring (`key`) until the answer. A failure also
     * pops up, as the switch that failed may be far below the line at the top. */
    const run = async (key, work, done) => {
        if (working) return; setWorking(key); setStatus('');
        try { const result = await work(); if (result?.state) setState(result.state); const text = done?.(result); if (text) setStatus(text); return result; }
        catch (e) {
            setStatus(friendlyError(e.message)); notify(e.message, 'error');
            if (['REGEX_OWNER_CHANGED', 'REGEX_CHANGED', 'REGEX_MISSING', 'REGEX_NOT_SAVED', 'REGEX_CHARACTER_CHANGED'].includes(e.code)) setState(bridge.regexEditorState());
        }
        finally { setWorking(null); }
    };
    const owner = state?.owner;
    const allowedNote = result => result?.allowedNow ? '，也允许运行了这一组' : '';
    const toggle = (group, script) => run(keyOf(group.type, script.id), () => bridge.regexToggle({ group: group.type, id: script.id, disabled: !script.disabled, owner, base: scriptFingerprint(script) }),
        result => `${script.disabled ? '已打开' : '已关闭'}「${script.scriptName}」${allowedNote(result)}`);
    const allow = group => run(`allow:${group.type}`, () => bridge.regexAllow({ group: group.type, allowed: !group.allowed, owner }),
        () => group.allowed ? `${groupTitle(group)}的正则不再运行` : `${groupTitle(group)}的正则开始运行`);
    const reorder = (group, script, to) => run(`move:${keyOf(group.type, script.id)}`, () => bridge.regexReorder({ group: group.type, id: script.id, to, owner }), () => '新顺序已保存');

    const needle = query.trim();
    const all = state?.groups.flatMap(g => g.scripts.map(s => ({ group: g, script: s }))) ?? [];
    const counts = Object.fromEntries(FILTERS.map(([f]) => [f, all.filter(x => matchesFilter(x.script, f)).length]));
    const shownIn = group => group.scripts.filter(s => matchesFilter(s, filter) && regexSearch(s, needle).matched);
    // Only what is shown counts as picked: a search or filter hides a pick from every action until it is shown again.
    const shownKeys = new Set(state?.groups.flatMap(g => shownIn(g).map(s => keyOf(g.type, s.id))) ?? []);
    const pickedItems = selectionOwner.current === state?.owner?.scoped ? all.filter(x => { const key = keyOf(x.group.type, x.script.id); return picked.has(key) && shownKeys.has(key); }) : [];
    const hiddenPicks = all.filter(x => { const key = keyOf(x.group.type, x.script.id); return picked.has(key) && !shownKeys.has(key); }).length;
    const pick = (group, script) => setPicked(set => { const next = new Set(set), key = keyOf(group.type, script.id); next.has(key) ? next.delete(key) : next.add(key); return next; });
    const allShownPicked = shownKeys.size > 0 && [...shownKeys].every(key => picked.has(key));
    const pickAllShown = () => setPicked(set => { const next = new Set(set); for (const key of shownKeys) allShownPicked ? next.delete(key) : next.add(key); return next; });
    const leaveBulk = () => { setBulk(false); setPicked(new Set()); };
    const pickedGroups = [...new Set(pickedItems.map(x => x.group.type))];

    // Switched on in a list kept from running (nothing in it was off, so nothing allowed it): said, as they still do not run.
    const blockedNote = (result, enabled) => {
        const blocked = enabled ? result.state.groups.filter(g => g.type !== 'global' && !g.allowed && pickedGroups.includes(g.type)) : [];
        return blocked.length ? `。${blocked.map(groupTitle).join('、')}没允许运行，开着也不执行，要在那一组上面打开「允许运行」` : '';
    };
    const bulkSet = enabled => run('bulk', () => bridge.regexSetEnabled({ items: pickedItems.map(x => ({ group: x.group.type, id: x.script.id })), enabled, owner }),
        result => (result.changed ? `已${enabled ? '打开' : '关闭'} ${result.changed} 条${allowedNote(result)}` : `选中的都已经${enabled ? '打开' : '关闭'}了`) + blockedNote(result, enabled));
    const newIn = focus && state?.groups.find(g => g.type === focus)?.canEdit ? focus : 'global';
    const exportPicked = () => {
        if (pickedItems.length) { setStatus(''); setSheet({ type: 'export-ready', file: regexExport(pickedItems.map(x => x.script), '选中的正则') }); }
    };
    const selectCharacter = avatar => run('character', () => bridge.regexSelectCharacter(avatar), () => {
        setSheet(null); setPicked(new Set()); setBulk(false); return '已加载角色的正则';
    });
    const showCharacters = () => {
        try { setCharacterQuery(''); setSheet({ type: 'characters', list: bridge.regexCharacters() }); }
        catch (error) { notify(error.message); }
    };
    const shareExport = async () => {
        if (working) return;
        setWorking('export-share');
        try {
            await navigator.share({ files: [new File([sheet.file.text], sheet.file.name, { type: 'application/json' })] });
            setStatus('已交给分享面板'); setSheet(null);
        } catch (error) { if (error.name !== 'AbortError') setStatus('没有分享成功，可以改用保存文件或复制内容'); }
        finally { setWorking(null); }
    };
    const exportFile = sheet?.type === 'export-ready' ? sheet.file : null;
    const canShareExport = (() => { try { return !!exportFile && !!navigator.canShare?.({ files: [new File([exportFile.text], exportFile.name, { type: 'application/json' })] }); } catch { return false; } })();
    const importFile = async files => {
        const scripts = [], errors = [];
        for (const file of files) { const read = scriptsFromFile(await file.text()); scripts.push(...read.scripts); if (read.error) errors.push(`${file.name}：${read.error}`); }
        if (!scripts.length) { setStatus(errors.join('；') || '文件里没有正则'); return; }
        setSheet({ type: 'import', scripts, ids: scripts.map(newScriptId), note: errors.join('；'), keepAlike: false });
    };
    // Ones alike to a script the list has already are left out unless asked for: imported twice, both would run.
    const importInto = g => {
        const have = new Set(g.scripts.map(ruleKey));
        const chosen = sheet.scripts.map((script, index) => ({ script, id: sheet.ids[index] })).filter(x => sheet.keepAlike || !have.has(ruleKey(x.script)));
        const skipped = sheet.scripts.length - chosen.length;
        if (!chosen.length) { setSheet(null); setStatus(`这些${groupTitle(g)}里都已经有一样的了，没有导入`); return; }
        run(`import:${g.type}`, () => bridge.regexImport({ group: g.type, scripts: chosen.map(x => x.script), ids: chosen.map(x => x.id), owner }),
            result => { setSheet(null); const savedGroup = result.state.groups.find(group => group.type === g.type);
                return `已导入 ${result.imported} 条到${groupTitle(g)}${skipped ? `，跳过了 ${skipped} 条一样的` : ''}${g.type !== 'global' && !savedGroup.allowed ? '；这一组仍未允许运行，需要时打开上方开关' : ''}`; });
    };
    const alikeCounts = sheet?.type === 'import' ? Object.fromEntries(state.groups.map(g => [g.type, alreadyIn(sheet.scripts, g.scripts)])) : {};

    return (
        <main class="tl-page tl-regex-page" ref={page}>
            <PageHeader title="正则" onBack={() => goBack({ name: 'me' })}>
                <button class="tl-button" disabled={!state || !!working} onClick={() => go({ name: 'regex', group: newIn, id: 'new' })}>＋ 新建</button>
            </PageHeader>
            <p class="tl-muted">按规则替换文字：折叠思维链、藏起状态栏、改掉不想看的词</p>
            {error && <p class="tl-error" role="alert">{error}</p>}
            {!state && !error && <p class="tl-muted">正在加载…</p>}
            {state && <>
                {state.extensionOff && <p class="tl-error">原版里停用了正则扩展，下面这些现在都不会执行。到「设置与扩展 → 扩展」里打开</p>}
                {status ? <p class="tl-regex-status" role="status">{status}</p> : <p class="tl-muted" role="status">{state.managingOtherCharacter ? '开关、排序马上保存到所选角色' : '开关、排序马上保存，改完故事会重新显示'}</p>}
                {state.nativeStale && <p class="tl-muted">原版界面的正则列表要刷新页面后才是最新的</p>}
                {state.managingOtherCharacter ? <div class="tl-list"><SheetItem label="当前故事的正则" hint="开关组合跟随当前故事，切回后可以使用" disabled={!!working || generating} onClick={() => selectCharacter(null)} /></div>
                    : <Combos state={state} working={working} run={run} owner={owner} bridge={bridge} />}
                <input class="tl-input tl-search" type="search" placeholder="搜索名字、查找或替换的内容" aria-label="搜索正则" value={query} onInput={e => setQuery(e.currentTarget.value)} />
                <div class="tl-chips tl-regex-filters" role="group" aria-label="按状态筛选">
                    {FILTERS.filter(([f]) => f !== 'problem' || counts.problem).map(([f, label]) => (
                        <button class="tl-chip" aria-pressed={filter === f ? 'true' : 'false'} onClick={() => setFilter(f)}>{label} {counts[f]}</button>
                    ))}
                </div>
                {!bulk && all.length > 0 && <button class="tl-button tl-regex-bulk-open" disabled={!!working} onClick={() => setBulk(true)}>批量与排序</button>}
                {bulk && <div class="tl-regex-bulkbar" role="toolbar" aria-label="对选中的正则">
                    <span>已选 {pickedItems.length} 条</span>
                    <button class="tl-chip" disabled={!shownKeys.size} onClick={pickAllShown}>{allShownPicked ? '全不选' : '全选'}</button>
                    <button class="tl-chip" disabled={!pickedItems.length || !!working} onClick={() => bulkSet(true)}>打开</button>
                    <button class="tl-chip" disabled={!pickedItems.length || !!working} onClick={() => bulkSet(false)}>关闭</button>
                    <button class="tl-chip" disabled={pickedGroups.length !== 1 || !!working} onClick={() => setSheet({ type: 'move', items: pickedItems })}>移到…</button>
                    <button class="tl-chip" disabled={!pickedItems.length || !!working} onClick={exportPicked}>导出</button>
                    <button class="tl-chip tl-danger-text" disabled={pickedGroups.length !== 1 || !!working} onClick={() => setSheet({ type: 'delete', items: pickedItems })}>删除</button>
                    <button class="tl-chip" aria-pressed="true" onClick={leaveBulk}>完成</button>
                    {pickedGroups.length > 1 && <p class="tl-regex-bulknote">选中的在不同组里：可以一起打开、关闭、导出；移动和删除要一组一组来</p>}
                    {hiddenPicks > 0 && <p class="tl-regex-bulknote">另有 {hiddenPicks} 条选中的被搜索或筛选藏起来了，不会被改</p>}
                </div>}
                {state.groups.map(group => {
                    const shown = shownIn(group), filtered = needle || filter !== 'all';
                    return <section class="tl-section tl-regex-group" aria-label={groupTitle(group)} data-group={group.type}>
                        <h2 class="tl-section-title">{group.type === 'scoped' && bridge.regexCharacters
                            ? <button class="tl-link" disabled={!!working || generating} aria-haspopup="dialog" onClick={showCharacters}>{groupTitle(group)} ▾</button>
                            : groupTitle(group)} · {group.scripts.length} 条</h2>
                        {group.type === 'scoped' && state.managingOtherCharacter && <p class="tl-muted">正在管理这个角色，阅读中的故事不变</p>}
                        <p class="tl-muted">{group.reason || GROUP_HINTS[group.type]}</p>
                        {group.type !== 'global' && group.canEdit && group.scripts.length > 0 && (
                            <div class="tl-list"><button class="tl-list-item tl-switch-row tl-regex-allow" role="switch" aria-checked={group.allowed ? 'true' : 'false'} aria-busy={working === `allow:${group.type}` ? 'true' : undefined}
                                disabled={!!working} onClick={() => allow(group)}>
                                <span class="tl-list-label">允许运行{group.type === 'preset' ? '这个预设' : '这个角色'}自带的正则</span>
                                <span class="tl-list-hint">{group.allowed ? '下面打开的会执行' : '关着：下面的全都不执行。在下面打开任意一条也会顺带允许'}</span>
                            </button></div>
                        )}
                        {group.canEdit && group.scripts.length === 0 && <p class="tl-muted">这一组还没有正则</p>}
                        {group.scripts.length > 0 && filtered && shown.length === 0 && <p class="tl-muted">这一组没有符合的</p>}
                        <div class="tl-list">{shown.map(script => {
                            const index = group.scripts.indexOf(script), problem = problemOf(script), key = keyOf(group.type, script.id);
                            const idle = !group.allowed && group.type !== 'global';
                            return <div class="tl-regex-row" data-off={script.disabled || idle ? 'true' : undefined} data-id={script.id}>
                                {bulk && <label class="tl-regex-pick"><input type="checkbox" checked={picked.has(key)} aria-label={`选择「${script.scriptName}」`} onChange={() => pick(group, script)} /></label>}
                                <button class="tl-list-item tl-regex-open" onClick={() => go({ name: 'regex', group: group.type, id: script.id })}>
                                    <span class="tl-list-label">{script.scriptName || '没有名字'}</span>
                                    <span class="tl-list-hint">{[script.disabled ? '已关闭' : idle ? '这一组没允许运行' : '', scriptSummary(script)].filter(Boolean).join(' · ')}</span>
                                    {problem && <span class="tl-list-hint tl-regex-warn">{problem}</span>}
                                    {needle && regexSearch(script, needle).hits.slice(0, 2).map(hit => <span class="tl-regex-hit">{hit.label}：{hit.snippet}</span>)}
                                </button>
                                {bulk ? <span class="tl-regex-arrange">
                                    <button class="tl-chip" disabled={!!working || index === 0 || filtered} aria-label={`移到最前「${script.scriptName}」`} onClick={() => reorder(group, script, 0)}>⤒</button>
                                    <button class="tl-chip" disabled={!!working || index === 0 || filtered} aria-label={`上移「${script.scriptName}」`} onClick={() => reorder(group, script, index - 1)}>↑</button>
                                    <button class="tl-chip" disabled={!!working || index === group.scripts.length - 1 || filtered} aria-label={`下移「${script.scriptName}」`} onClick={() => reorder(group, script, index + 1)}>↓</button>
                                    <button class="tl-chip" disabled={!!working || index === group.scripts.length - 1 || filtered} aria-label={`移到最后「${script.scriptName}」`} onClick={() => reorder(group, script, group.scripts.length - 1)}>⤓</button>
                                </span> : <button class="tl-regex-toggle tl-switch-row" role="switch" aria-checked={script.disabled ? 'false' : 'true'} aria-label={`打开「${script.scriptName}」`}
                                    aria-busy={working === key ? 'true' : undefined} disabled={!!working || !group.canEdit} onClick={() => toggle(group, script)} />}
                            </div>;
                        })}</div>
                        {bulk && filtered && group.scripts.length > 1 && <p class="tl-muted">清空搜索、选「全部」后才能排序</p>}
                    </section>;
                })}
                <div class="tl-list">
                    <button class="tl-list-item" disabled={!!working || !all.length} onClick={() => { setStatus(''); setSheet({ type: 'export' }); }}>
                        <span class="tl-list-label">导出正则</span><span class="tl-list-hint">整组导出，或者选择几条</span>
                    </button>
                    <button class="tl-list-item" disabled={!!working} onClick={() => fileInput.current?.click()}>
                        <span class="tl-list-label">导入正则</span><span class="tl-list-hint">别人分享的正则文件（.json），可以一次选几个</span>
                    </button>
                    <button class="tl-list-item" onClick={onOpenNative}>
                        <span class="tl-list-label">在原版界面里打开</span><span class="tl-list-hint">原版的正则面板和调试器</span>
                    </button>
                </div>
                <input ref={fileInput} type="file" accept=".json,application/json" multiple hidden onChange={e => { const files = [...e.currentTarget.files]; e.currentTarget.value = ''; if (files.length) importFile(files); }} />
                <p class="tl-muted">执行顺序：全局 → 预设 → 角色，同一组里从上往下。原版界面里改的也会显示在这里</p>
            </>}
            {bulk && <div class="tl-regex-export-actions"><button class="tl-button tl-primary" disabled={!pickedItems.length || !!working} onClick={exportPicked}>导出已选的 {pickedItems.length} 条</button></div>}
            {sheet?.type === 'characters' && <Sheet title="选择角色" busy={!!working} onClose={() => setSheet(null)}>
                <input class="tl-input tl-search" type="search" aria-label="搜索角色" placeholder="搜索角色" value={characterQuery} onInput={event => setCharacterQuery(event.currentTarget.value)} />
                <div class="tl-persona-list tl-choice-list tl-regex-characters" role="radiogroup" aria-label="角色">{sheet.list.filter(c => c.name.toLocaleLowerCase().includes(characterQuery.trim().toLocaleLowerCase())).map(c => <button key={c.avatar} class="tl-persona" role="radio"
                    aria-checked={state.owner.scoped === c.avatar ? 'true' : 'false'} aria-busy={working === 'character' ? 'true' : undefined} disabled={!!working || generating} onClick={() => selectCharacter(c.avatar)}>
                    <img class="tl-avatar" alt="" src={`/thumbnail?type=avatar&file=${encodeURIComponent(c.avatar)}`} loading="lazy" decoding="async" />
                    <span class="tl-persona-text"><strong>{c.name}</strong><span class="tl-muted">{c.current ? '当前故事' : c.avatar.replace(/\.png$/i, '')}</span></span>
                </button>)}</div>
                {!sheet.list.some(c => c.name.toLocaleLowerCase().includes(characterQuery.trim().toLocaleLowerCase())) && <p class="tl-muted">没有符合的角色</p>}
            </Sheet>}
            {sheet?.type === 'export' && <Sheet title="导出正则" onClose={() => setSheet(null)}>
                {state.groups.map(g => <SheetItem label={groupTitle(g)} hint={`全部 ${g.scripts.length} 条，不受搜索筛选影响`} disabled={!g.scripts.length}
                    onClick={() => setSheet({ type: 'export-ready', file: regexExport(g.scripts, groupTitle(g)) })} />)}
                <SheetItem label="自选条目" hint="勾选后一起导出" onClick={() => { setSheet(null); setBulk(true); setPicked(new Set()); }} />
            </Sheet>}
            {exportFile && <Sheet title={`导出 ${exportFile.count} 条正则`} busy={!!working} onClose={() => setSheet(null)}>
                <p class="tl-sheet-note">{exportFile.name}</p>
                <SheetItem label="保存文件" hint="保存到本机的下载列表" disabled={!!working} onClick={() => { try { downloadFile(exportFile.name, exportFile.text); setStatus(`已生成 ${exportFile.count} 条，请在下载列表中保存`); } catch { setStatus('没有下载成功，可以改用分享文件或复制内容'); } }} />
                {canShareExport && <SheetItem label="分享文件" hint="选择保存位置或发给别人" disabled={!!working} busy={working === 'export-share'} busyLabel="正在分享…" onClick={shareExport} />}
                <SheetItem label="复制内容" hint="无法下载时，可以复制为 JSON 文件" disabled={!!working} onClick={() => run('export-copy', () => copyText(exportFile.text), copied => copied ? '已复制正则内容' : '没有复制成功，请重试')} />
                {status && <p class="tl-sheet-note" role="status">{status}</p>}
            </Sheet>}
            {sheet?.type === 'import' && <Sheet title={`导入 ${sheet.scripts.length} 条正则`} busy={!!working} onClose={() => setSheet(null)}>
                <p class="tl-sheet-note">放进哪一组？{sheet.note ? ` 有的文件没读出来：${sheet.note}` : ''}</p>
                {state.groups.filter(g => g.canEdit).map(g => <SheetItem label={groupTitle(g)} disabled={!!working} busy={working === `import:${g.type}`} busyLabel={`正在导入到${groupTitle(g)}…`} onClick={() => importInto(g)}
                    hint={alikeCounts[g.type] ? `其中 ${alikeCounts[g.type]} 条这一组里已经有一样的，${sheet.keepAlike ? '也照样加' : '会跳过'}` : GROUP_HINTS[g.type]} />)}
                {Object.values(alikeCounts).some(Boolean) && <button class="tl-list-item tl-switch-row" role="switch" aria-checked={sheet.keepAlike ? 'true' : 'false'} disabled={!!working}
                    onClick={() => setSheet(s => ({ ...s, keepAlike: !s.keepAlike }))}>
                    <span class="tl-list-label">一样的也照样加</span><span class="tl-list-hint">两条一样的都开着，会先后各改一遍</span></button>}
                {importSlow && <>
                    <p class="tl-sheet-note" role="status">还在等待原版完成。可能有确认提示或连接较慢，先别重复导入。</p>
                    <SheetItem label="查看原版提示" hint="打开原版检查，当前导入继续等待" onClick={() => { setSheet(null); onOpenNative(); }} />
                </>}
            </Sheet>}
            {sheet?.type === 'move' && <MoveSheet state={state} items={sheet.items} working={working} onClose={() => setSheet(null)}
                onMove={to => run('move', () => bridge.regexMove({ from: sheet.items[0].group.type, to: to.type, items: sheet.items.map(x => ({ id: x.script.id, base: scriptFingerprint(x.script) })), owner }),
                    result => { setSheet(null); setPicked(new Set()); return `已把 ${result.moved} 条移到${groupTitle(to)}${allowedNote(result)}`; })} />}
            {sheet?.type === 'delete' && <ConfirmSheet title={`删除 ${sheet.items.length} 条正则？`} confirmLabel="删除" busyLabel="正在删除…"
                message={`${sheet.items.map(x => `「${x.script.scriptName}」`).join('')}会删掉，找不回来。想留着可以先导出`} onClose={() => setSheet(null)}
                onConfirm={() => run('delete', () => bridge.regexDelete({ group: sheet.items[0].group.type, items: sheet.items.map(x => ({ id: x.script.id, base: scriptFingerprint(x.script) })), owner }),
                    result => { setSheet(null); setPicked(new Set()); return `已删除 ${result.deleted} 条`; })} />}
        </main>
    );
}

function MoveSheet({ state, items, working, onClose, onMove }) {
    const from = items[0].group.type;
    return <Sheet title={items.length === 1 ? `把「${items[0].script.scriptName}」移到…` : `把 ${items.length} 条移到…`} busy={!!working} onClose={onClose}>
        <p class="tl-sheet-note">移过去会排在那一组最后</p>
        {state.groups.filter(g => g.type !== from).map(g => <SheetItem label={groupTitle(g)} hint={g.canEdit ? GROUP_HINTS[g.type] : g.reason} disabled={!g.canEdit}
            busy={working === 'move'} busyLabel="正在移动…" onClick={() => onMove(g)} />)}
    </Sheet>;
}

/** Saved sets of switches (the app's "regex presets"): which scripts are on, applied in one go. */
function Combos({ state, working, run, owner, bridge }) {
    const [open, setOpen] = useState(null), [naming, setNaming] = useState(false), [confirmDelete, setConfirmDelete] = useState(false);
    const combo = open && state.combos.find(c => c.id === open);
    const onCount = state.groups.reduce((n, g) => n + g.scripts.filter(s => !s.disabled).length, 0);
    const changes = combo && comboChanges(state, combo), unknown = combo ? comboUnknownGroups(state, combo) : [];
    // A set keeps switches, not whether a preset's or character's list may run: one kept from running stays so.
    const held = combo ? state.groups.filter(g => g.type !== 'global' && g.canEdit && !g.allowed && combo[g.type].some(id => g.scripts.some(s => s.id === id))) : [];
    const inUse = !!combo?.selected && !!combo?.matches;
    const names = list => list.slice(0, 6).map(x => `「${x.name}」`).join('') + (list.length > 6 ? ` 等 ${list.length} 条` : '');
    return <section class="tl-section tl-regex-combos" aria-label="开关组合">
        <h2 class="tl-section-title">开关组合</h2>
        <p class="tl-muted">记下哪些正则开着，以后一键换回这一套。原版叫「正则预设」</p>
        {state.combos.length > 0 && <div class="tl-list">{state.combos.map(c => (
            <button class="tl-list-item" aria-current={c.selected ? 'true' : undefined} onClick={() => { setConfirmDelete(false); setOpen(c.id); }}>
                <span class="tl-list-label">{c.name || '没有名字'}</span>
                <span class="tl-list-hint">{c.selected ? c.matches ? '正在用' : '上次换的是这套，之后又改过开关' : `${c.global.length + c.preset.length + c.scoped.length} 条开着`}</span>
            </button>
        ))}</div>}
        <button class="tl-button" disabled={!!working} onClick={() => setNaming(true)}>把现在的开关存成组合</button>
        {naming && <PromptSheet title="存成组合" label="名字" placeholder="例如：只看正文" confirmLabel="保存" busyLabel="正在保存…"
            validate={name => name.trim() ? '' : '请输入名字'} onClose={() => setNaming(false)}
            onConfirm={name => run('combo', () => bridge.regexComboSave({ name }), () => { setNaming(false); return `已存成「${name}」，记下了现在开着的 ${onCount} 条`; })} />}
        {combo && <Sheet title={`「${combo.name}」`} busy={!!working} onClose={() => setOpen(null)}>
            {changes.turnOn.length + changes.turnOff.length === 0
                ? <p class="tl-sheet-note">和现在开着的一样</p>
                : <>{changes.turnOn.length > 0 && <p class="tl-sheet-note">会打开 {changes.turnOn.length} 条：{names(changes.turnOn)}</p>}
                    {changes.turnOff.length > 0 && <p class="tl-sheet-note">会关闭 {changes.turnOff.length} 条：{names(changes.turnOff)}</p>}
                    {unknown.map(g => <p class="tl-sheet-note tl-regex-warn">这个组合没记下{g.type === 'preset' ? '预设' : '角色'}「{g.owner}」的正则（多半是在别的{g.type === 'preset' ? '预设' : '角色'}下存的），换过去它开着的 {g.off} 条会全部关掉</p>)}
                    <p class="tl-sheet-note">执行顺序不变</p></>}
            {held.map(g => <p class="tl-sheet-note tl-regex-warn">{groupTitle(g)}没允许运行，这一组开着的也不执行</p>)}
            <SheetItem label="换成这一套" hint={inUse ? '正在用这一套' : changes.turnOn.length + changes.turnOff.length ? '马上生效，故事会重新显示' : '开关不变，只记作正在用'} busy={working === 'combo-apply'} busyLabel="正在切换…"
                onClick={() => run('combo-apply', () => bridge.regexComboApply({ id: combo.id, owner }), result => { setOpen(null); return result.unchanged ? `本来就是「${combo.name}」` : `已换成「${combo.name}」`; })} />
            <SheetItem label="用现在的开关更新它" hint={`改成现在开着的 ${onCount} 条`} busy={working === 'combo-update'} busyLabel="正在保存…"
                onClick={() => run('combo-update', () => bridge.regexComboSave({ id: combo.id }), () => { setOpen(null); return `已更新「${combo.name}」`; })} />
            {!confirmDelete ? <SheetItem label="删除这个组合" hint="只删组合，现在的开关不变" danger onClick={() => setConfirmDelete(true)} />
                : <SheetItem label={`确定删除「${combo.name}」`} hint="删了找不回来" danger busy={working === 'combo-delete'} busyLabel="正在删除…"
                    onClick={() => run('combo-delete', () => bridge.regexComboDelete({ id: combo.id }), () => { setOpen(null); return `已删除组合「${combo.name}」`; })} />}
        </Sheet>}
    </section>;
}

const formOf = script => ({ ...normalizeScript(script), trimText: (script.trimStrings ?? []).join('\n'), minText: script.minDepth ?? '', maxText: script.maxDepth ?? '' });
const scriptOf = form => {
    const min = depthInput(form.minText), max = depthInput(form.maxText);
    return normalizeScript({ ...form, trimStrings: String(form.trimText).split('\n'), minDepth: min.value ?? null, maxDepth: max.value ?? null });
};

/** One script: its fields in plain words, a place to try it on real text, and save. `id` 'new' starts an empty one. */
function RegexEditor({ bridge, state, setState, group: groupType, id, notify }) {
    const isNew = id === 'new', draftKey = draftKeyOf(state, groupType, id);
    const group = state.groups.find(g => g.type === groupType), script = isNew ? null : group?.scripts.find(s => s.id === id);
    // Unchanged, the editor shows the script as the app has it now. The first change keeps what it started from
    // (`opened`, `base`) and whose list it was then (`owner`), so a change made elsewhere meanwhile, or another preset or
    // character since, is noticed on saving. Only that is kept as a draft.
    const [edit, renderEdit] = useState(() => drafts.get(draftKey) ?? null);
    const editNow = useRef(edit);
    const current = isNew ? blankScript() : script ? normalizeScript(script) : null;
    const form = edit?.form ?? (current && formOf(current)), opened = edit?.opened ?? current, base = edit?.base ?? (script ? scriptFingerprint(script) : null);
    // Deleted elsewhere while being changed here: what was written can still be kept, as a new script.
    const missing = !isNew && !script;
    // A new one goes where it was started from, unless that list cannot take it now.
    const [chosen, renderTarget] = useState(edit?.target ?? null);
    const targetNow = useRef(chosen);
    const target = chosen ?? (group?.canEdit ? groupType : 'global');
    const [newId] = useState(() => edit?.newId ?? newScriptId()), copyId = useRef(null);
    const [saving, setSaving] = useState(false), [status, setStatus] = useState(''), [sheet, setSheet] = useState(null), [conflict, setConflict] = useState(null);
    const [advanced, setAdvanced] = useState(false), [sample, writeSample] = useState(() => samples.get(state.account) ?? ''), [tried, setTried] = useState(null);
    const mounted = useRef(true);
    useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const setSample = text => { writeSample(text); samples.set(state.account, text); };
    const value = form && scriptOf(form), dirty = !!edit && !!opened && (isNew || scriptChanges(opened, value).length > 0);
    // Keep each input before yielding: passive effects may never run if navigation unmounts the editor first.
    // The draft stays with its original owner even when the reader keeps typing after switching presets.
    const keyForEdit = entry => draftKeyOf({ ...state, account: entry?.account ?? state.account, owner: entry?.owner ?? state.owner }, groupType, id);
    const setEdit = change => {
        const previous = editNow.current;
        const next = typeof change === 'function' ? change(previous) : change;
        const kept = next && { ...next, target: targetNow.current, newId };
        editNow.current = kept;
        const changed = kept?.opened && (isNew || scriptChanges(kept.opened, scriptOf(kept.form)).length > 0);
        if (changed) drafts.set(keyForEdit(kept), kept);
        else drafts.delete(keyForEdit(previous ?? kept));
        renderEdit(kept);
    };
    const setTarget = next => {
        targetNow.current = next;
        renderTarget(next);
        if (editNow.current) setEdit(editNow.current);
    };
    const update = change => setEdit(e => ({ form: change(e?.form ?? formOf(current)), opened: e?.opened ?? current, base: e?.base ?? base,
        account: e?.account ?? state.account, owner: e?.owner ?? state.owner, names: e?.names ?? ownerNames(state) }));
    // Written under one preset or character, which is not the open one any more: it cannot go into this one.
    const ownerGroup = isNew ? target : groupType;
    const elsewhere = !!edit?.owner && ownerGroup !== 'global' && edit.owner[ownerGroup] !== state.owner[ownerGroup];
    const set = (key, v) => update(f => ({ ...f, [key]: v }));
    // Tried by the app itself, a moment after typing stops.
    useEffect(() => {
        if (!value || !sample) { setTried(null); return; }
        const timer = setTimeout(() => { try { setTried(bridge.regexTest({ script: value, text: sample })); } catch (e) { setTried({ output: '', error: friendlyError(e.message) }); } }, 200);
        return () => clearTimeout(timer);
    }, [value && JSON.stringify(value), sample]);

    const leave = () => { drafts.delete(keyForEdit(editNow.current)); goBack({ name: 'regex' }); };
    const askLeave = () => { if (saving) setStatus('正在保存，好了再返回'); else if (dirty) setSheet('leave'); else leave(); };
    useBackLayer(dirty || saving, askLeave);

    if (!group || !form) return <main class="tl-page"><PageHeader title="正则" onBack={() => goBack({ name: 'regex' })} />
        <p class="tl-muted">{!group || !group.canEdit ? group?.reason || '这一组现在改不了' : '这条正则已经不在了'}</p></main>;

    const targetGroup = state.groups.find(g => g.type === target) ?? group, nowOwner = state.groups.find(g => g.type === ownerGroup)?.owner;
    const depthErrors = [depthInput(form.minText).error, depthInput(form.maxText).error].filter(Boolean);
    const note = findNote(value), problem = problemOf(value);
    const wiWithoutPrompt = value.placement.includes(5) && !value.promptOnly;
    // Counted here only when the pattern means what it says: {{char}} and the like are filled in by the app.
    const withMacros = !!Number(value.substituteRegex) && /\{\{/.test(value.findRegex);
    const matches = (() => { const parsed = parseFind(value.findRegex); if (!parsed.ok || !sample || withMacros) return null;
        try { return parsed.global ? (sample.match(parsed.regex) ?? []).length : parsed.regex.test(sample) ? 1 : 0; } catch { return null; } })();

    const save = async (overrideBase) => {
        if (saving || elsewhere || depthErrors.length || !value.scriptName.trim()) return;
        setSaving(true); setStatus('正在保存…'); setConflict(null);
        // What is sent; typing goes on meanwhile, and what is typed after it stays.
        const submitted = editNow.current, into = isNew ? target : groupType;
        try {
            const fresh = isNew || missing;
            const result = await bridge.regexSave({ group: into, id: fresh ? '' : id, newId: fresh ? newId : undefined, script: value, owner: edit?.owner ?? state.owner,
                base: fresh ? undefined : overrideBase ?? base });
            if (!mounted.current) return;
            const saved = result.state.groups.find(g => g.type === into)?.scripts.find(s => s.id === result.id);
            const later = editNow.current !== submitted && !!saved;
            const kept = later ? { ...editNow.current, opened: normalizeScript(saved), base: scriptFingerprint(saved), owner: result.state.owner, names: ownerNames(result.state) } : null;
            const allowed = result.allowedNow ? '，也允许运行了这一组' : '', rest = later ? '。之后写的还没存' : '';
            setState(result.state);
            if (fresh) {
                drafts.delete(keyForEdit(submitted));
                if (kept) drafts.set(draftKeyOf(result.state, into, result.id), kept);
                // A new one: back to the list (its entry, and the one the unsaved state added, are stepped over together),
                // or on to it when there is more written than was saved.
                if (isNew && !later) { notify(`已保存「${value.scriptName}」${allowed}`, 'info'); leave(); }
                else { notify(`${isNew ? '已保存' : '已存成新的一条'}「${value.scriptName}」${allowed}${rest}`, 'info'); go({ name: 'regex', group: into, id: result.id }, true); }
            } else { setEdit(kept); setStatus(`已保存${allowed}${rest}`); }
        } catch (e) {
            if (!mounted.current) return;
            if (e.code === 'REGEX_CHANGED' && e.detail?.current) setConflict(e.detail.current);
            setStatus(friendlyError(e.message)); notify(e.message, 'error');
            if (['REGEX_OWNER_CHANGED', 'REGEX_MISSING', 'REGEX_CHANGED', 'REGEX_NOT_SAVED', 'REGEX_CHARACTER_CHANGED'].includes(e.code)) setState(bridge.regexEditorState());
        } finally { if (mounted.current) setSaving(false); }
    };
    const action = async (key, work, done) => {
        setSheet(null); setSaving(true);
        try { const result = await work(); if (!mounted.current) return; setState(result.state); done(result); }
        catch (e) { if (mounted.current) setStatus(friendlyError(e.message)); }
        finally { if (mounted.current) setSaving(false); }
    };
    const exportOne = () => { downloadFile(exportName(value.scriptName), JSON.stringify({ id: isNew ? undefined : id, ...value }, null, 4)); setStatus('已导出'); };
    const kind = kindOf(value);

    return <main class="tl-page tl-regex-editor">
        <PageHeader title={isNew ? '新建正则' : script?.scriptName || value.scriptName || '正则'} onBack={askLeave} />
        <div class="tl-regex-editor-scroll">
            <p class="tl-muted">{isNew ? '存好之后才会生效，存好回到列表' : `${groupTitle(group)} · ${GROUP_HINTS[group.type]}`}{!isNew && group.type !== 'global' && !group.allowed ? `。这一组还没允许运行${value.disabled ? '' : '，打开着保存会顺带允许'}` : ''}</p>
            {status && <p class="tl-regex-status" role="status">{status}</p>}
            {elsewhere ? <p class="tl-error">这条是在{GROUP_NAMES[ownerGroup]}「{edit.names?.[ownerGroup] ?? ''}」下写的，现在{nowOwner ? `换成了「${nowOwner}」` : `没有打开的${GROUP_NAMES[ownerGroup]}`}，存不进去。可以导出，或者换回去再存{isNew ? '，也可以放进别的组' : ''}</p>
                : missing && <p class="tl-error">这条正则在别处删掉了，你写的还在：可以存成新的一条，或者导出</p>}
            {conflict && <section class="tl-regex-conflict" role="alert"><p>别处改过的这条和打开时不一样（{scriptChanges(opened, conflict).join('、') || '内容'}）。你写的还在</p>
                <div class="tl-row"><button class="tl-button" disabled={saving} onClick={() => save(scriptFingerprint(conflict))}>用我写的覆盖</button>
                    <button class="tl-button" disabled={saving} onClick={() => { setEdit(null); setConflict(null); setState(bridge.regexEditorState()); setStatus('已换成别处改过的版本'); }}>改用那边的</button></div></section>}
            {isNew && <div class="tl-field-group"><span class="tl-field-label">放在哪一组</span>
                <div class="tl-chips" role="radiogroup" aria-label="放在哪一组">{state.groups.map(g => <button class="tl-chip" role="radio" aria-checked={target === g.type ? 'true' : 'false'} disabled={!g.canEdit}
                    onClick={() => setTarget(g.type)}>{groupTitle(g)}</button>)}</div>
                <span class="tl-field-hint">{targetGroup.canEdit ? GROUP_HINTS[targetGroup.type] : targetGroup.reason}</span></div>}
            <div class="tl-field-group"><label class="tl-field-label" for="tl-rx-name">名字</label>
                <input id="tl-rx-name" class="tl-input" value={form.scriptName} placeholder="例如：折叠思维链" onInput={e => set('scriptName', e.currentTarget.value)} />
                {!form.scriptName.trim() && <span class="tl-field-hint tl-regex-warn">先起个名字才能保存</span>}</div>
            <div class="tl-field-group"><label class="tl-field-label" for="tl-rx-find">查找</label>
                <span class="tl-field-hint">写成 /内容/g，g 表示全部替换，i 表示不分大小写</span>
                <textarea id="tl-rx-find" class="tl-input tl-field tl-regex-code" rows={3} spellcheck={false} value={form.findRegex} placeholder="/<thinking>[\s\S]*?<\/thinking>/g" onInput={e => set('findRegex', e.currentTarget.value)} />
                <span class={`tl-field-hint${note.tone === 'error' ? ' tl-regex-warn' : ''}`} role="status">{note.text}</span></div>
            <div class="tl-field-group"><label class="tl-field-label" for="tl-rx-replace">替换为</label>
                <span class="tl-field-hint">空着就是删掉。{'{{match}}'} 是找到的整段，$1 是第一个括号里的</span>
                <textarea id="tl-rx-replace" class="tl-input tl-field tl-regex-code" rows={3} spellcheck={false} value={form.replaceString} onInput={e => set('replaceString', e.currentTarget.value)} /></div>
            <fieldset class="tl-field-group tl-regex-fieldset"><legend class="tl-field-label">用在哪里</legend>
                <div class="tl-chips">{PLACEMENTS.map(([p, label]) => { const on = value.placement.includes(p);
                    return <button class="tl-chip" role="checkbox" aria-checked={on ? 'true' : 'false'} onClick={() => set('placement', on ? value.placement.filter(x => x !== p) : [...value.placement, p])}>{label}</button>; })}</div>
                {wiWithoutPrompt && <span class="tl-field-hint tl-regex-warn">世界书内容只在「只改发给 AI 的」或「都改」时才会被改</span>}</fieldset>
            <fieldset class="tl-field-group tl-regex-fieldset"><legend class="tl-field-label">改哪里</legend>
                <div class="tl-list" role="radiogroup" aria-label="改哪里">{KINDS.map(([k, label, hint]) => (
                    <button class="tl-list-item tl-regex-choice" role="radio" aria-checked={kind === k ? 'true' : 'false'} onClick={() => update(f => ({ ...f, ...kindFlags(k) }))}>
                        <span class="tl-list-label">{label}</span><span class="tl-list-hint">{hint}</span>
                    </button>))}</div></fieldset>
            <button class="tl-list-item tl-switch-row" role="switch" aria-checked={value.disabled ? 'false' : 'true'} onClick={() => set('disabled', !value.disabled)}>
                <span class="tl-list-label">打开</span><span class="tl-list-hint">关着的保存了也不执行</span></button>
            <section class="tl-section tl-regex-try" aria-label="试一试">
                <h2 class="tl-section-title">试一试</h2>
                <textarea class="tl-input tl-field" rows={4} aria-label="试一试的原文" placeholder="贴一段文字，下面马上显示替换后的样子" value={sample} onInput={e => setSample(e.currentTarget.value)} />
                <div class="tl-row"><button class="tl-button" onClick={() => { const text = bridge.regexSample?.() ?? ''; setSample(text); if (!text) setStatus('当前故事里还没有回复，可以自己贴一段'); }}>填入最近一条回复</button>
                    {sample && <button class="tl-button" onClick={() => setSample('')}>清空</button>}</div>
                {sample && <><p class="tl-field-hint" role="status">{matches === null ? '' : matches ? `找到 ${matches} 处` : '一处都没找到'}{tried?.error ? ` · ${tried.error}` : ''}{withMacros && tried && !tried.error ? (tried.output === sample ? '一处都没改' : '下面是替换后的样子') : ''}</p>
                    <pre class="tl-regex-output" aria-label="替换后">{tried ? tried.output || '（替换后什么都不剩）' : '…'}</pre></>}
            </section>
            <button class="tl-button" aria-expanded={advanced ? 'true' : 'false'} onClick={() => setAdvanced(a => !a)}>{advanced ? '收起更多设置' : '更多设置'}</button>
            {advanced && <section class="tl-section" aria-label="更多设置">
                <button class="tl-list-item tl-switch-row" role="switch" aria-checked={value.runOnEdit ? 'true' : 'false'} onClick={() => set('runOnEdit', !value.runOnEdit)}>
                    <span class="tl-list-label">编辑消息时也运行</span><span class="tl-list-hint">改存下的文字时，编辑完也替换一遍</span></button>
                <div class="tl-field-group"><label class="tl-field-label" for="tl-rx-sub">查找里的 {'{{char}}'} 等</label>
                    <select id="tl-rx-sub" class="tl-input" value={value.substituteRegex} onChange={e => set('substituteRegex', Number(e.currentTarget.value))}>{SUBSTITUTE.map(([v, label]) => <option value={v}>{label}</option>)}</select>
                    <span class="tl-field-hint">「当作普通文字」：名字里的符号不会被当成规则</span></div>
                <div class="tl-regex-depth">
                    <div class="tl-field-group"><label class="tl-field-label" for="tl-rx-min">最小深度</label>
                        <input id="tl-rx-min" class="tl-input" inputMode="numeric" placeholder="不限" value={form.minText} onInput={e => set('minText', e.currentTarget.value)} /></div>
                    <div class="tl-field-group"><label class="tl-field-label" for="tl-rx-max">最大深度</label>
                        <input id="tl-rx-max" class="tl-input" inputMode="numeric" placeholder="不限" value={form.maxText} onInput={e => set('maxText', e.currentTarget.value)} /></div>
                </div>
                <span class="tl-field-hint">{depthErrors[0] ? <span class="tl-regex-warn">{depthErrors[0]}</span> : depthRangeEmpty(value)
                    ? <span class="tl-regex-warn">最小深度比最大深度大，这条不会改任何消息</span> : '0 是最新一条，1 是倒数第二条。只管显示和发给 AI 的'}</span>
                <div class="tl-field-group"><label class="tl-field-label" for="tl-rx-trim">替换前从找到的内容里去掉</label>
                    <textarea id="tl-rx-trim" class="tl-input tl-field" rows={3} value={form.trimText} placeholder="一行一个" onInput={e => set('trimText', e.currentTarget.value)} /></div>
            </section>}
            {!isNew && <div class="tl-list tl-regex-more">
                {/* A copy starts switched off: two that are the same, both on, would each change the text in turn. */}
                {script && !elsewhere && <button class="tl-list-item" disabled={saving} onClick={() => { copyId.current ??= newScriptId();
                    action('copy', () => bridge.regexSave({ group: groupType, id: '', newId: copyId.current, script: { ...value, scriptName: `${value.scriptName} 副本`, disabled: true }, owner: state.owner }),
                        result => { notify('已复制一份，副本先关着', 'info'); go({ name: 'regex', group: groupType, id: result.id }, true); }); }}>
                    <span class="tl-list-label">复制一份</span><span class="tl-list-hint">{dirty ? '按现在写的复制，原来这条不变。' : ''}副本先关着，免得和这条一起执行</span></button>}
                {script && !elsewhere && <button class="tl-list-item" disabled={saving || dirty} onClick={() => setSheet('move')}>
                    <span class="tl-list-label">移到别的组</span><span class="tl-list-hint">{dirty ? '先保存再移' : '全局、预设或角色'}</span></button>}
                <button class="tl-list-item" onClick={exportOne}><span class="tl-list-label">导出</span><span class="tl-list-hint">存成文件，可以发给别人</span></button>
                {script && !elsewhere && <button class="tl-list-item tl-danger-text" disabled={saving} onClick={() => setSheet('delete')}><span class="tl-list-label">删除这条正则</span><span class="tl-list-hint">删了找不回来</span></button>}
            </div>}
        </div>
        <footer class="tl-regex-editor-actions">
            <span>{elsewhere ? `存不进现在的${GROUP_NAMES[ownerGroup]}` : problem && !value.disabled ? problem : missing ? '原来那条已经不在了' : dirty ? '有没保存的改动' : '已保存'}</span>
            <button class="tl-button tl-primary" disabled={saving || elsewhere || !(dirty || isNew || missing) || !!depthErrors.length || !value.scriptName.trim() || !targetGroup.canEdit} aria-busy={saving ? 'true' : undefined} onClick={() => save()}>
                {saving ? <><Spinner />正在保存…</> : missing ? '存成新的一条' : '保存'}</button>
        </footer>
        {sheet === 'leave' && <Sheet title="还有没保存的改动" onClose={() => setSheet(null)}>
            <SheetItem label="继续编辑" onClick={() => setSheet(null)} />
            <SheetItem label="放弃改动，返回" danger onClick={() => { setSheet(null); leave(); }} />
        </Sheet>}
        {sheet === 'move' && <MoveSheet state={state} items={[{ group, script }]} working={saving ? 'move' : null} onClose={() => setSheet(null)}
            onMove={to => action('move', () => bridge.regexMove({ from: groupType, to: to.type, items: [{ id, base }], owner: state.owner }),
                result => { notify(`已移到${groupTitle(to)}${result.allowedNow ? '，也允许运行了那一组' : ''}`, 'info'); go({ name: 'regex', group: to.type, id }, true); })} />}
        {sheet === 'delete' && <ConfirmSheet title={`删除「${value.scriptName}」？`} message="删了找不回来。想留着可以先导出" confirmLabel="删除" busyLabel="正在删除…" onClose={() => setSheet(null)}
            onConfirm={() => action('delete', () => bridge.regexDelete({ group: groupType, items: [{ id, base }], owner: state.owner }),
                () => { notify(`已删除「${value.scriptName}」`, 'info'); leave(); })} />}
    </main>;
}
