// The way back from the full app: a small tab on the screen's edge, faded until touched, so it covers as little of the
// full app as possible on a phone. Drag it up, down or to the other edge; where it was left is kept on this device.
import { useEffect, useRef, useState } from 'preact/hooks';
import { storage } from './ui.jsx';

const KEY = 'tavern-lite:return-handle';
const HEIGHT = 52;
const TOP_GAP = 56;      // the full app's top bar
const BOTTOM_GAP = 110;  // its send row and the last message's swipe controls
const DRAG_AFTER = 8;    // pixels the finger moves before a press counts as a drag

/** Where the tab sits: which edge, and its top as a share of the window's height (so it survives rotating). */
export function loadReturnSpot(read = key => storage(s => s.getItem(key))) {
    try {
        const saved = JSON.parse(read(KEY) || 'null');
        if ((saved?.side === 'left' || saved?.side === 'right') && Number.isFinite(saved.y) && saved.y >= 0 && saved.y <= 1) return saved;
    } catch { /* fall through to the default */ }
    return { side: 'right', y: 0.58 };
}

/** The tab's top in pixels, kept clear of the full app's top bar and send row. */
export function clampReturnTop(top, height) {
    return Math.round(Math.max(TOP_GAP, Math.min(top, height - BOTTOM_GAP - HEIGHT)));
}

export function ReturnHandle({ onReturn }) {
    const [spot, setSpot] = useState(loadReturnSpot);
    const [drag, setDrag] = useState(null);
    const [, setSize] = useState(0);
    const press = useRef(null);
    const dragged = useRef(false);
    useEffect(() => {
        const resize = () => setSize(window.innerWidth * 10000 + window.innerHeight);
        window.addEventListener('resize', resize);
        return () => window.removeEventListener('resize', resize);
    }, []);
    const height = window.innerHeight;
    const top = clampReturnTop(spot.y * height, height);

    const down = event => {
        if (event.button > 0) return;
        press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, top };
        dragged.current = false;
        event.currentTarget.setPointerCapture?.(event.pointerId);
    };
    const move = event => {
        const p = press.current;
        if (!p || p.id !== event.pointerId) return;
        const dx = event.clientX - p.x, dy = event.clientY - p.y;
        if (!dragged.current && Math.hypot(dx, dy) < DRAG_AFTER) return;
        dragged.current = true;
        setDrag({ left: Math.max(0, Math.min(event.clientX - 13, window.innerWidth - 26)), top: clampReturnTop(p.top + dy, height) });
    };
    const up = event => {
        const p = press.current;
        if (!p || p.id !== event.pointerId) return;
        press.current = null;
        setDrag(null);
        if (!dragged.current) return;
        const next = {
            side: event.clientX < window.innerWidth / 2 ? 'left' : 'right',
            y: clampReturnTop(p.top + event.clientY - p.y, height) / height,
        };
        setSpot(next);
        storage(s => s.setItem(KEY, JSON.stringify(next)));
    };
    const cancel = event => {
        if (press.current?.id !== event.pointerId) return;
        press.current = null;
        setDrag(null);
    };
    // A drag ends with a click on the same element; only a press that did not move goes back.
    const click = () => {
        if (dragged.current) { dragged.current = false; return; }
        onReturn();
    };

    return (
        <button
            type="button"
            class={`tl-button tl-primary tl-return is-${spot.side}${drag ? ' is-dragging' : ''}`}
            style={drag ? { top: `${drag.top}px`, left: `${drag.left}px`, right: 'auto' } : { top: `${top}px` }}
            aria-label="返回轻酒馆"
            title="返回轻酒馆（按住可拖动）"
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={cancel}
            onClick={click}
        >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
    );
}
