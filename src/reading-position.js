import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { findAnchor, fingerprint, messageMark, readStory, writeStory } from './story-state.js';

const blocks = article => [...article.querySelectorAll('.tl-message-body p, .tl-message-body pre, .tl-message-body blockquote, .tl-message-body li')];
/**
 * `rank(index)`, when the page shows one line of the story: how many of its messages from that one to the end (what
 * has to be loaded to show it), or null for a message the line does not have.
 */
export function useReadingPosition({ list, key, all, ready, limit, setLimit, nearBottom, notify, rank = null }) {
    const session = useRef(null);
    const latest = useRef(null);
    const [away, setAway] = useState(false);
    if (session.current?.key !== key) {
        const saved = readStory(key);
        session.current = { key, saved, holding: !!saved && !saved.tail, loaded: false, notified: false };
        nearBottom.current = !session.current.holding;
    }
    latest.current = { all, ready, rank };
    const capture = () => {
        const s = session.current, el = list.current, data = latest.current;
        if (!s?.loaded || !el || !data.ready || !data.all.length || s.holding) return;
        const top = el.getBoundingClientRect().top + 80;
        const articles = [...el.querySelectorAll('.tl-message[data-index]')];
        const article = articles.find(n => n.getBoundingClientRect().bottom > top);
        if (!article) return;
        const index = Number(article.dataset.index), message = data.all[index];
        if (!message) return;
        const candidates = blocks(article);
        const block = candidates.find(n => n.getBoundingClientRect().bottom > top);
        const rect = (block || article).getBoundingClientRect();
        const mark = i => ({ index: i, mark: messageMark(data.all[i]) });
        s.saved = { tail: nearBottom.current, anchor: mark(index),
            neighbors: [-1, 1, -2, 2, -3, 3].map(n => index + n).filter(i => data.all[i]).map(mark),
            block: block ? { index: candidates.indexOf(block), mark: fingerprint(block.textContent) } : null,
            ratio: Math.max(0, Math.min(1, (top - rect.top) / Math.max(1, rect.height))) };
        writeStory(s.key, s.saved);
    };
    const position = () => {
        const s = session.current, el = list.current, data = latest.current;
        if (!el || !data.ready || !data.all.length) return;
        if (!s.holding) { if (nearBottom.current) el.scrollTop = el.scrollHeight; return; }
        const target = findAnchor(data.all, s.saved);
        if (!target) return;
        if (s.strict && !target.exact) { s.holding = false; notify('原文已改动或无法定位', 'info'); return; }
        const needed = data.rank ? data.rank(target.index) : data.all.length - target.index + 1;
        // A place on another line: this one opens at its end.
        if (needed === null) { s.holding = false; s.loaded = true; nearBottom.current = true; el.scrollTop = el.scrollHeight; return; }
        if (limit < needed) { setLimit(n => Math.max(n, Math.ceil(needed / 40) * 40)); return; }
        const article = el.querySelector(`.tl-message[data-index="${target.index}"]`);
        if (!article) return;
        let block = null;
        if (target.exact && s.saved.block) {
            const hits = blocks(article).filter(n => fingerprint(n.textContent) === s.saved.block.mark);
            if (hits.length === 1) block = hits[0];
        }
        const rect = (block || article).getBoundingClientRect();
        const offset = target.exact && (block || !s.saved.block) ? (s.saved.ratio || 0) * rect.height : 0;
        el.scrollTop += rect.top - el.getBoundingClientRect().top - 80 + offset;
        nearBottom.current = false;
        setAway(true);
        if (!target.exact && !s.notified) { s.notified = true; notify('已回到大致位置', 'info'); }
        s.loaded = true;
        if (s.strict && !s.highlighted) {
            s.highlighted = true; article.classList.add('tl-source-highlight');
            setTimeout(() => article.classList.remove('tl-source-highlight'), 1800);
        }
    };
    useLayoutEffect(() => {
        if (!ready || !all.length) return;
        position();
        if (!session.current.holding) session.current.loaded = true;
    });
    // Keep the selected paragraph in view through preview → native formatting and late image/card sizing.
    useEffect(() => {
        const el = list.current;
        if (!el) return;
        let frame;
        const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => positionRef.current()); };
        const resize = new ResizeObserver(update);
        const watch = () => { resize.observe(el); for (const n of el.children) resize.observe(n); update(); };
        const mutations = new MutationObserver(watch);
        mutations.observe(el, { childList: true }); watch();
        const hide = () => captureRef.current();
        addEventListener('pagehide', hide); document.addEventListener('visibilitychange', hide);
        return () => { captureRef.current(); resize.disconnect(); mutations.disconnect(); cancelAnimationFrame(frame);
            removeEventListener('pagehide', hide); document.removeEventListener('visibilitychange', hide); };
    }, [key]);
    const positionRef = useRef(position), captureRef = useRef(capture);
    positionRef.current = position; captureRef.current = capture;
    const release = event => {
        if (event?.type === 'keydown' && !['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) return;
        session.current.holding = false;
    };
    const lastHeight = useRef(0);
    const scroll = () => {
        if (session.current.holding) return;
        const el = list.current;
        if (!el) return;
        // Content that grows under a reader at the end (extension panels, cards loading late) moves the page before the
        // resize is seen: that is not the reader leaving the end.
        const grew = el.scrollHeight > lastHeight.current && lastHeight.current > 0;
        lastHeight.current = el.scrollHeight;
        if (grew && nearBottom.current) { el.scrollTop = el.scrollHeight; setAway(false); capture(); return; }
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        setAway(!nearBottom.current); capture();
    };
    const jump = () => {
        release(); nearBottom.current = true; setAway(false);
        if (list.current) list.current.scrollTop = list.current.scrollHeight;
        capture();
    };
    const seek = index => {
        const m = latest.current.all[index];
        if (!m) return;
        Object.assign(session.current, { saved: { anchor: { index, mark: messageMark(m) }, ratio: 0 }, holding: true, strict: true, highlighted: false });
        nearBottom.current = false; setAway(true);
        positionRef.current();
    };
    return { away, release, scroll, jump, seek, holding: () => session.current.holding };
}
