import './glitch-reader.css';
import { pad, pfSvg, reduced, watchGlitchSheets } from './glitch-fx.js';

/*
 * Dresses the story page (.tl-messages) under the 故障终端 theme:
 *   - chapter opening: pixel CHAPTER badge, character-by-character glitch-in (<=12 chars), 3 pixel ornament dots, sparkles;
 *   - new reply: glitch bar flash & body jitter on the newest character message when it arrives;
 *   - swipe reply: vertical number roll on .tl-swipe-count and glitch jitter on .tl-message-body;
 *   - composer send button: diamond icon + GO label;
 *   - engine loading bar: 3 little CRT monitors + LOADING tag;
 *   - bottom sheets & danger confirmation: watched via watchGlitchSheets().
 */

const NEW_BARS = [[-2, 6, 38, 8, 12, 0], [40, 26, 46, 10, -16, 24], [12, 52, 30, 6, 10, 50]];
const seenOpening = new Set();

export function attach(list, name) {
    const chat = list?.closest('.tl-chat');
    if (!chat || !window.IntersectionObserver || !window.MutationObserver) return () => {};
    list.dataset.gt = 'true';
    const offSheets = watchGlitchSheets();

    const fx = (el, frames, o) => (reduced() || !el?.animate) ? null : el.animate(frames, Object.assign({ fill: 'none' }, o));

    // Chapter opening IntersectionObserver (plays once per story opening)
    const openingIO = new IntersectionObserver(es => es.forEach(e => {
        if (!e.isIntersecting) return;
        const el = e.target, key = el.dataset.gtKey;
        openingIO.unobserve(el);
        if (seenOpening.has(key)) return;
        seenOpening.add(key);
        el.classList.add('gt-go');
    }), { root: list, threshold: .5 });

    const dressOpening = op => {
        if (op.dataset.gtDressed) return;
        op.dataset.gtDressed = 'true';
        const h = op.querySelector('.tl-chapter-heading');
        const k = op.querySelector('.tl-chapter-kicker');
        if (k && !k.querySelector('.tl-gt-kpf')) {
            const p = document.createElement('span');
            p.className = 'pf tl-gt-kpf';
            const m = (k.textContent || '').match(/(\d+)/);
            p.innerHTML = pfSvg('CHAPTER ' + pad(m ? +m[1] : 1), 1, 1);
            k.prepend(p);
        }
        if (h) {
            const title = h.textContent || name || '';
            op.dataset.gtKey = `${name}:${title}`;
            const a = [...title];
            if (a.length > 12) {
                op.classList.add('gt-whole');
            } else {
                h.dataset.gtOrig = title;
                h.textContent = '';
                a.forEach((c, i) => {
                    const s = document.createElement('span');
                    s.dataset.c = c;
                    s.textContent = c;
                    s.style.setProperty('--t', `${60 + (a.length - 1 - i) * 26}ms`);
                    h.appendChild(s);
                });
            }
        }
        [[8, 4, 180], [86, 0, 200], [92, 40, 215], [4, 46, 190], [50, -8, 205]].forEach(([x, y, t]) => {
            const s = document.createElement('i');
            s.className = 'tl-gt-xs';
            s.style.cssText = `left:${x}%;top:${y}px;--t:${t}ms`;
            op.appendChild(s);
        });
        openingIO.observe(op);
    };

    // Track message indices so only a newly appended character reply flashes
    let knownMax = -1, readyForNew = false;
    const flashNew = msg => {
        if (reduced() || msg.dataset.gtFlashed) return;
        msg.dataset.gtFlashed = 'true';
        const gb = document.createElement('div');
        gb.className = 'tl-gt-msg-gb';
        gb.innerHTML = NEW_BARS.map(([x, y, w, h, j, t]) => `<i style="--x:${x}%;--y:${y}px;--w:${w}%;--h:${h}px;--j:${j}px;--t:${t}ms"></i>`).join('');
        msg.prepend(gb);
        msg.classList.add('gt-is-new');
        setTimeout(() => { msg.classList.remove('gt-is-new'); gb.remove(); }, 420);
    };

    let lastSwipeText = '';
    const scan = () => {
        const op = list.querySelector('.tl-chapter-opening');
        if (op) dressOpening(op);
        const msgs = [...list.querySelectorAll('.tl-message[data-index]')];
        for (const m of msgs) {
            const idx = +m.dataset.index;
            if (Number.isFinite(idx)) {
                if (readyForNew && idx > knownMax && m.dataset.role === 'char' && !m.dataset.placeholder) {
                    flashNew(m);
                }
                if (idx > knownMax) knownMax = idx;
            }
        }
        readyForNew = true;
        const cnt = list.querySelector('.tl-swipe-count');
        if (cnt) {
            const curText = cnt.textContent || '';
            if (lastSwipeText && curText && curText !== lastSwipeText && !reduced()) {
                cnt.animate?.([{ transform: 'translateY(-14px)', color: '#2fe8ff', textShadow: '2px 0 #ff2fd2' }, { transform: 'none', color: '#272cc8', textShadow: 'none' }], { duration: 130, easing: 'cubic-bezier(.3,.6,.4,1)' });
                const body = cnt.closest('.tl-message')?.querySelector('.tl-message-body');
                fx(body, [
                    { opacity: .25, transform: 'translateX(8px)', textShadow: '-3px 0 rgba(56,228,255,.8),3px 0 rgba(226,60,216,.8)' },
                    { opacity: .88, transform: 'translateX(-5px)', offset: .3 },
                    { opacity: 1, transform: 'translateX(2px)', offset: .6 },
                    { opacity: 1, transform: 'none', textShadow: 'none' },
                ], { duration: 180, easing: 'steps(4, end)' });
            }
            lastSwipeText = curText;
        }
    };

    let frame = 0, alive = true;
    scan();
    const mo = new MutationObserver(() => {
        if (!frame && alive) frame = requestAnimationFrame(() => { frame = 0; if (alive) scan(); });
    });
    mo.observe(list, { childList: true, subtree: true, characterData: true });

    return () => {
        alive = false;
        cancelAnimationFrame(frame);
        offSheets();
        openingIO.disconnect();
        mo.disconnect();
        delete list.dataset.gt;
        list.querySelectorAll('.tl-gt-kpf, .tl-gt-xs, .tl-gt-msg-gb').forEach(e => e.remove());
        const op = list.querySelector('.tl-chapter-opening');
        if (op) {
            delete op.dataset.gtDressed;
            op.classList.remove('gt-go', 'gt-whole');
            const h = op.querySelector('.tl-chapter-heading');
            if (h?.dataset.gtOrig) { h.textContent = h.dataset.gtOrig; delete h.dataset.gtOrig; }
        }
    };
}
