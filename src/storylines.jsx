import { useEffect, useState } from 'preact/hooks';
import * as engine from './engine.js';
import { Sheet, Spinner } from './ui.jsx';
import './episodes.css';

/**
 * Horae's storylines inside this one story (正文 and 番外 each with their own memory; only the line in use is sent).
 * Horae's own feature, so it sits with the other extension functions (the ＋ menu), not with the shell's 番外 lines,
 * which are separate stories. Renaming, assigning floors and organizing memory stay in the full app.
 */
function StorylineSection({ initial, disabled, notify }) {
    const [state, setState] = useState(initial);
    const [busy, setBusy] = useState(''), [name, setName] = useState('');
    useEffect(() => { if (!busy) setState(initial); }, [initial]);
    if (!state?.multi) return null;
    const run = (key, action, options, done) => {
        const bridge = engine.getBridge();
        if (!bridge?.storylineAction || busy) return;
        setBusy(key);
        bridge.storylineAction(action, options)
            .then(next => { setState(next); notify(done(next), 'info'); })
            .catch(e => notify(e.message))
            .finally(() => setBusy(''));
    };
    const button = (key, label, action, options, done) => <button key={key} class="tl-button" disabled={disabled || !!busy}
        aria-busy={busy === key ? 'true' : undefined} onClick={() => run(key, action, options, done)}>{busy === key && <Spinner />}{label}</button>;
    const others = state.lines.filter(line => line.id !== state.active && line.id !== state.pending);
    return <section class="tl-episode-section tl-storyline-section">
        <p class="tl-muted">Horae 扩展的功能：把这个故事分成几段，只把正在写的那段发给模型。不换故事，只决定下一句接着写哪一段。</p>
        <p>现在在「{state.label}」{state.pending ? `，下一句起换到「${state.pendingLabel}」` : ''}</p>
        <div class="tl-storyline-actions">
            {others.map(line => line.id === 'main'
                ? button(line.id, '下一句起回到正文', 'to-main', {}, () => '下一句起回到正文')
                : button(line.id, `下一句起切到「${line.label}」`, 'to-line', { line: line.id }, () => `下一句起切到「${line.label}」`))}
            {state.pending && button('clear', '取消切换', 'clear-pending', {}, next => `接着写「${next.label}」`)}
        </div>
        <div class="tl-row tl-storyline-new">
            <input class="tl-input" maxLength={24} placeholder="新番外的名字" aria-label="新番外的名字" value={name}
                disabled={disabled || !!busy} onInput={e => setName(e.currentTarget.value)} />
            {button('new', '下一句起开新番外', 'new-next', { title: name.trim() }, () => { const title = name.trim() || '番外'; setName(''); return `下一句起开新番外「${title}」`; })}
        </div>
        <p class="tl-muted">改名、划分楼层、整理记忆：在原版界面 Horae 的「时间线」页</p>
    </section>;
}


export function StorylineSheet({ initial, notify, onClose }) {
    return <Sheet title="Horae 故事线" onClose={onClose} className="tl-episodes-sheet" bodyClassName="tl-episodes-body">
        <StorylineSection initial={initial} notify={notify} />
    </Sheet>;
}
