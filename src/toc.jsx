import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Sheet } from './ui.jsx';
import { buildToc, currentEntry, filterToc } from './toc-model.js';
import './toc.css';

// How this device last left the contents: oldest or newest first.
const ORDER_KEY = 'tavern-lite:toc-order';
const readChoice = (key, values) => { try { const v = localStorage.getItem(key); return values.includes(v) ? v : values[0]; } catch { return values[0]; } };
const writeChoice = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };

function TocEntry({ entry, current, onJump }) {
    return (
        <button class="tl-toc-entry" aria-current={current ? 'true' : undefined} data-hidden={entry.hidden ? 'true' : undefined}
            onClick={() => onJump(entry.index)}>
            <span class="tl-toc-floor">#{entry.index}</span>
            <span class="tl-toc-main">
                <span class="tl-toc-title">{entry.title}</span>
            </span>
            {(current || entry.hidden) && (
                <span class="tl-toc-tags">
                    {current && <span class="tl-tag">在读</span>}
                    {entry.hidden && <span class="tl-tag">AI 看不到</span>}
                </span>
            )}
        </button>
    );
}

/**
 * The story's contents as a drawer from the left, the way novel apps show theirs: one entry per reply, the one being
 * read marked and in view; a tap goes there. `messages` is the whole story (see buildToc), `currentIndex` the message
 * at the top of the page.
 */
export function TocSheet({ storyTitle, messages, currentIndex, onJump, onClose }) {
    const toc = useMemo(() => buildToc(messages), [messages]);
    const [order, setOrder] = useState(() => readChoice(ORDER_KEY, ['asc', 'desc']));
    const [query, setQuery] = useState('');
    const [floor, setFloor] = useState('');
    const [floorError, setFloorError] = useState('');
    const list = useRef(null);
    const current = currentEntry(toc.entries, currentIndex);
    const total = messages?.length ?? 0;

    const groups = useMemo(() => {
        const keep = new Set(filterToc(toc.entries, query));
        const out = toc.groups.map(g => ({ ...g, entries: g.entries.filter(e => keep.has(e)) })).filter(g => g.entries.length);
        return order === 'desc' ? out.reverse().map(g => ({ ...g, entries: [...g.entries].reverse() })) : out;
    }, [toc, query, order]);
    const count = groups.reduce((n, g) => n + g.entries.length, 0);

    const locate = (block = 'center') => list.current?.querySelector('.tl-toc-entry[aria-current="true"]')?.scrollIntoView({ block });
    // Opened at the entry being read, like a novel app's contents.
    useLayoutEffect(() => { locate(); }, []);

    const flip = () => { const value = order === 'asc' ? 'desc' : 'asc'; writeChoice(ORDER_KEY, value); setOrder(value); };
    const jump = event => {
        event.preventDefault();
        const index = Number(floor.replace('#', '').trim());
        if (!floor.trim() || !Number.isInteger(index) || index < 0 || index >= total) {
            setFloorError(total ? `只有 #0–#${total - 1} 楼` : '故事还没有内容');
            return;
        }
        onJump(index);
    };

    return (
        <Sheet title="目录" className="tl-toc" bodyClassName="tl-toc-body" onClose={onClose}>
            <p class="tl-muted tl-toc-info">{storyTitle} · 共 {toc.entries.length} 段回复 · {total} 楼{current ? ` · 读到 #${current.index}` : ''}</p>
            <div class="tl-toc-tools">
                <span class="tl-spacer" />
                <button class="tl-chip" aria-label={order === 'asc' ? '现在是正序，点一下改成倒序' : '现在是倒序，点一下改成正序'}
                    onClick={flip}>{order === 'asc' ? '正序' : '倒序'}</button>
                <button class="tl-chip" disabled={!current} onClick={() => { setQuery(''); requestAnimationFrame(() => locate()); }}>定位</button>
            </div>
            <div class="tl-toc-tools">
                <input class="tl-input tl-toc-search" type="search" placeholder="搜索标题" aria-label="搜索目录" value={query}
                    onInput={e => setQuery(e.currentTarget.value)} />
                <form class="tl-toc-jump" onSubmit={jump}>
                    <input class="tl-input" inputMode="numeric" enterKeyHint="go" placeholder="楼层" aria-label="跳到第几楼" value={floor}
                        onInput={e => { setFloor(e.currentTarget.value); setFloorError(''); }} />
                    <button class="tl-button" type="submit">跳转</button>
                </form>
            </div>
            {floorError && <p class="tl-error tl-toc-note" role="alert">{floorError}</p>}
            <div class="tl-toc-list" ref={list}>
                {!toc.entries.length && <p class="tl-muted tl-toc-note">故事还没有回复。</p>}
                {toc.entries.length > 0 && !count && <p class="tl-muted tl-toc-note">没找到「{query.trim()}」</p>}
                {groups.map(group => (
                    <section class="tl-toc-group" key={group.key + group.entries[0].index}>
                        <h3 class="tl-toc-group-title">{group.label}</h3>
                        {group.entries.map(entry => (
                            <TocEntry key={entry.index} entry={entry} current={entry === current} onJump={onJump} />
                        ))}
                    </section>
                ))}
            </div>
        </Sheet>
    );
}
