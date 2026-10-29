import { useEffect, useMemo, useState } from 'preact/hooks';
import * as engine from './engine.js';
import { EPISODE_KINDS } from './episode-intent.js';
import { aiLinePrompt, parseAiLines, requestHeads, suggestLineMarks } from './inline-episodes.js';
import { Sheet, SheetItem, Spinner } from './ui.jsx';
import './episodes.css';

/**
 * The lines written inside this one story, read as sub-stories (line-view.js): one tap here opens a line, and what is
 * written there goes on it. Kept by Horae's storylines when they are on (each line then sends only its own memory),
 * else by the shell's own record (own-lines.js: shown apart, but the model still reads the whole story). The full app
 * shows the whole story in one. Not the 番外 sheet, whose lines are stories of their own.
 */
function StorylineSection({ initial, lines, view, onOpen, onEdit, disabled, notify, scope }) {
    const [state, setState] = useState(initial);
    const [busy, setBusy] = useState(''), [name, setName] = useState('');
    useEffect(() => { if (!busy) setState(initial); }, [initial]);
    const horae = state?.source === 'horae';
    const run = (key, action, options, done) => {
        const bridge = engine.getBridge();
        if (!bridge?.storylineAction || busy) return;
        setBusy(key);
        bridge.storylineAction(action, { ...options, scope })
            .then(next => { setState(next); done(next); })
            .catch(e => notify(e.message))
            .finally(() => setBusy(''));
    };
    const button = (key, label, action, options, done) => <button key={key} class="tl-button" disabled={disabled || !!busy}
        aria-busy={busy === key ? 'true' : undefined} onClick={() => run(key, action, options, done)}>{busy === key && <Spinner />}{label}</button>;
    const pendingLabel = state?.pending && lines?.enabled && lines.has(state.pending) ? lines.label(state.pending) : state?.pendingLabel;
    return <section class="tl-episode-section tl-storyline-section">
        <p class="tl-muted">{horae
            ? 'Horae 扩展的功能：一个故事分成几条线，每条线只把自己的内容发给模型。轻酒馆里每条线单独显示，在哪条线里写就接在哪条线后面；原版界面里还是一整个故事。'
            : '在故事里写「来个小剧场」「生成番外」，轻酒馆就从那句起记成一条线，写「回到正文」再回来；长按消息也能自己划。每条线单独显示，在哪条线里写就接在哪条线后面。'}</p>
        {!horae && <p class="tl-muted">没装 Horae 时只是分开显示：模型写的时候还是会看到整个故事。想让记忆真的分开，到「番外与平行线」里拆成独立故事。</p>}
        {lines?.enabled && <div class="tl-storyline-tree" role="list" aria-label="这个故事里的线">
            {lines.lines.map(line => <div class="tl-storyline-row" role="listitem" key={line.id} data-depth={line.depth} style={{ '--tl-line-depth': Math.min(line.depth, 4) }}>
                <SheetItem label={line.label} current={line.id === view} disabled={disabled || line.id === view}
                    hint={[line.count ? `${line.count} 条` : '还没有内容', line.id === lines.writing ? '最新写到这里' : '', line.id === view ? '正在读' : '']
                        .filter(Boolean).join(' · ')}
                    onClick={() => onOpen(line.id)} />
                {line.id !== 'main' && <button class="tl-link tl-storyline-edit" disabled={disabled || !!busy} onClick={() => onEdit(line)}>改类型{horae ? '' : '或名字'}</button>}
            </div>)}
        </div>}
        {state?.pending && <div class="tl-row">
            <p>下一句起换到「{pendingLabel}」</p>
            {button('clear', '取消切换', 'clear-pending', {}, next => notify(`接着写「${lines?.enabled && lines.has(next.active) ? lines.label(next.active) : next.label || '正文'}」`, 'info'))}
        </div>}
        <div class="tl-row tl-storyline-new">
            <input class="tl-input" maxLength={24} placeholder="新番外的名字" aria-label="新番外的名字" value={name}
                disabled={disabled || !!busy} onInput={e => setName(e.currentTarget.value)} />
            {button('new', '开新番外', 'new-next', { title: name.trim(), kind: 'side', parent: view ?? undefined }, next => {
                const title = name.trim() || '番外';
                setName('');
                notify(`已开新番外「${title}」，下一句就写在里面`, 'info');
                if (next?.pending) onOpen(next.pending);
            })}
        </div>
        {horae ? <p class="tl-muted">改名、划分楼层、整理记忆：在原版界面 Horae 的「时间线」页</p>
            : <LineSuggestions state={state} disabled={disabled || !!busy} notify={notify} scope={scope} onApplied={setState} />}
    </section>;
}

/**
 * An older story, written before its lines were recorded: where they start and end, read with the same rules as a
 * request (or asked of the author's own model), shown for the author to check; nothing is marked before that.
 */
function LineSuggestions({ state, disabled, notify, scope, onApplied }) {
    const bridge = engine.getBridge();
    const messages = useMemo(() => bridge?.readingMessages?.() ?? [], [bridge]);
    const heads = useMemo(() => requestHeads(messages), [messages]);
    const [found, setFound] = useState(null), [from, setFrom] = useState(''), [chosen, setChosen] = useState(new Set());
    const [asking, setAsking] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState('');
    // A message that already starts a line is not suggested again (asking twice adds nothing).
    const show = (all, source) => {
        const starts = new Set((state?.segments ?? []).map(s => s.start));
        const list = all.filter(item => !starts.has(item.index));
        setFound(list); setFrom(source); setChosen(new Set(list.map(item => item.index))); setError('');
    };
    const byRules = () => show(suggestLineMarks(messages), 'rules');
    const ask = () => {
        if (!bridge?.askModel || busy) return;
        setBusy('ask'); setError('');
        bridge.askModel(aiLinePrompt(heads))
            .then(answer => {
                const list = parseAiLines(answer, heads);
                if (!list) throw new Error('模型的回答没看懂，可以再问一次，或者用「按发言找」');
                setAsking(false);
                show(list, 'ai');
            })
            .catch(e => setError(e.message))
            .finally(() => setBusy(''));
    };
    const apply = () => {
        const items = found.filter(item => chosen.has(item.index));
        if (!items.length || busy) return;
        setBusy('apply'); setError('');
        bridge.storylineAction('apply-suggestions', { items, scope })
            .then(next => { onApplied(next); setFound(null); notify(`已按 ${items.length} 处分好，可以在上面点开每条线`, 'info'); })
            .catch(e => setError(e.message))
            .finally(() => setBusy(''));
    };
    const snippet = index => String(messages[index]?.mes ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const toggle = index => setChosen(set => { const next = new Set(set); next.has(index) ? next.delete(index) : next.add(index); return next; });
    return <div class="tl-storyline-suggest">
        <h3>整理以前写的</h3>
        {!found && !asking && <>
            <p class="tl-muted">以前写的番外还没分开时，可以先找出换线的地方，看过再分</p>
            <div class="tl-row">
                <button class="tl-button" disabled={disabled || !messages.length} onClick={byRules}>按发言找</button>
                <button class="tl-button" disabled={disabled || !heads.length || !bridge?.askModel} onClick={() => { setAsking(true); setError(''); }}>让 AI 帮忙找</button>
            </div>
        </>}
        {asking && <div class="tl-storyline-ask">
            <p>会把你每句发言的开头（最多 60 个字，共 {heads.length} 句）发给现在连接的模型，只问它哪里换了线。角色卡、世界书、预设和角色的回复都不发。</p>
            <details class="tl-more-fields"><summary>看看要发的内容</summary><pre class="tl-storyline-prompt">{aiLinePrompt(heads)}</pre></details>
            <p class="tl-muted">它找的只是建议，分之前还会给你看</p>
            <div class="tl-row">
                <button class="tl-button tl-primary" disabled={disabled || !!busy} aria-busy={busy === 'ask' ? 'true' : undefined} onClick={ask}>{busy === 'ask' && <Spinner />}{busy === 'ask' ? '正在问…' : '发送'}</button>
                <button class="tl-button" disabled={!!busy} onClick={() => setAsking(false)}>先不了</button>
            </div>
        </div>}
        {found && <>
            {!found.length && <p class="tl-muted">{from === 'ai' ? '模型说没有换线的地方' : '没找到换线的说法'}。也可以长按消息，从那条起自己划</p>}
            {found.length > 0 && <>
                <p class="tl-muted">{from === 'ai' ? '模型找到的' : '按「写个番外」「回到正文」这类说法找到的'}，不对的取消勾选：</p>
                <div class="tl-list">{found.map(item => <label key={item.index} class="tl-episode-switch tl-storyline-pick">
                    <input type="checkbox" checked={chosen.has(item.index)} disabled={!!busy} onChange={() => toggle(item.index)} />
                    <span>第 {item.index} 条起{item.action === 'back' ? '回到正文' : `是${EPISODE_KINDS[item.kind] || '番外'}「${item.title}」`}
                        <span class="tl-muted"> · {snippet(item.index)}</span></span>
                </label>)}</div>
                <button class="tl-button tl-primary" disabled={disabled || !!busy || !chosen.size} aria-busy={busy === 'apply' ? 'true' : undefined} onClick={apply}>
                    {busy === 'apply' && <Spinner />}按勾选的分</button>
            </>}
            <button class="tl-link" disabled={!!busy} onClick={() => setFound(null)}>返回</button>
        </>}
        {error && <p class="tl-error">{error}</p>}
    </div>;
}

export function StorylineSheet({ initial, lines, view, onOpen, onEdit, notify, scope, onClose }) {
    return <Sheet title={initial?.source === 'horae' ? 'Horae 故事线' : '故事里的线'} onClose={onClose} className="tl-episodes-sheet" bodyClassName="tl-episodes-body">
        <StorylineSection initial={initial} lines={lines} view={view} onOpen={onOpen} onEdit={onEdit} notify={notify} scope={scope} />
    </Sheet>;
}

/** A line's kind (any line) and name (the shell's own lines; Horae's are renamed in Horae). */
export function LineFormSheet({ title, line = null, named = true, confirmLabel, onSave, onClose }) {
    const [kind, setKind] = useState(line?.kind || 'side'), [name, setName] = useState(line?.title ?? '');
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    const save = event => {
        event.preventDefault();
        if (busy || named && !name.trim()) return;
        setBusy(true); setError('');
        Promise.resolve(onSave({ kind, title: name.trim() })).then(onClose, e => { setError(e?.message || '没改成，再试一次'); setBusy(false); });
    };
    return <Sheet title={title} busy={busy} onClose={() => { if (!busy) onClose(); }}>
        <form class="tl-episode-form" onSubmit={save}>
            <label>类型<select class="tl-input" disabled={busy} value={kind} onChange={e => setKind(e.currentTarget.value)}>
                {Object.entries(EPISODE_KINDS).map(([value, label]) => <option value={value}>{label}</option>)}</select></label>
            {named && <label>名字<input class="tl-input" maxLength={24} disabled={busy} value={name} placeholder="比如：丧尸男友"
                onInput={e => setName(e.currentTarget.value)} /></label>}
            {error && <p class="tl-error">{error}</p>}
            <div class="tl-row">
                <button class="tl-button tl-primary" disabled={busy || named && !name.trim()} aria-busy={busy ? 'true' : undefined}>{busy && <Spinner />}{confirmLabel}</button>
                <button class="tl-button" type="button" disabled={busy} onClick={onClose}>取消</button>
            </div>
        </form>
    </Sheet>;
}

/**
 * Before a message goes on a line kept only by the shell: the model will read the whole story, the 正文 and the other
 * lines too. Splitting it into a story of its own keeps the memory apart; or it is written here as it is.
 */
export function LineMemorySheet({ label, isNew, canSplit, onSplit, onHere, onClose }) {
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    const split = () => {
        if (busy) return;
        setBusy(true); setError('');
        Promise.resolve(onSplit()).catch(e => setError(e?.message || '没拆成，再试一次')).finally(() => setBusy(false));
    };
    return <Sheet title="写在这条线里？" busy={busy} onClose={() => { if (!busy) onClose(); }}>
        <div class="tl-settings-group">
            <p>「{label}」{isNew ? '会' : ''}和正文在同一个故事里。没装 Horae 时轻酒馆只能分开显示，模型写的时候还是会看到整个故事，包括正文和其他线。</p>
            <p class="tl-muted">想让它的记忆真的和正文分开，就{isNew ? '分开写' : '把这条线拆成独立故事，在那边接着写'}。</p>
            {error && <p class="tl-error">{error}</p>}
            <div class="tl-row">
                {canSplit && <button class="tl-button tl-primary" disabled={busy} aria-busy={busy ? 'true' : undefined} onClick={split}>
                    {busy && <Spinner />}{isNew ? '分开写' : '拆成独立故事接着写'}</button>}
                <button class="tl-button" disabled={busy} onClick={onHere}>还是写在这里</button>
            </div>
            <p class="tl-muted">选「还是写在这里」后，这个故事不再问</p>
        </div>
    </Sheet>;
}
