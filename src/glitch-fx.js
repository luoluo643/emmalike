/*
 * Shared pixel font, full-screen block transition, bottom-sheet squash and danger-confirm ribbon for the 故障终端 theme.
 */

import './glitch-reader.css';
export const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const pad = n => String(n).padStart(2, '0');

const G = {
    A: '.XXX.X...XX...XXXXXXX...XX...XX...X', B: 'XXXX.X...XX...XXXXX.X...XX...XXXXX.', C: '.XXXXX....X....X....X....X.....XXXX', D: 'XXXX.X...XX...XX...XX...XX...XXXXX.',
    E: 'XXXXXX....X....XXXX.X....X....XXXXX', F: 'XXXXXX....X....XXXX.X....X....X....', G: '.XXXXX....X....X.XXXX...XX...X.XXXX', H: 'X...XX...XX...XXXXXXX...XX...XX...X',
    I: 'XXX.X..X..X..X..X.XXX', J: '..XXX...X....X....X....X.X..X..XX..', K: 'X...XX..X.X.X..XX...X.X..X..X.X...X', L: 'X....X....X....X....X....X....XXXXX',
    M: 'X...XXX.XXX.X.XX.X.XX...XX...XX...X', N: 'X...XXX..XX.X.XX..XXX...XX...XX...X', O: '.XXX.X...XX...XX...XX...XX...X.XXX.', P: 'XXXX.X...XX...XXXXX.X....X....X....',
    Q: '.XXX.X...XX...XX...XX.X.XX..X..XX.X', R: 'XXXX.X...XX...XXXXX.X.X..X..X.X...X', S: '.XXXXX....X.....XXX.....X....XXXXX.', T: 'XXXXX..X....X....X....X....X....X..',
    U: 'X...XX...XX...XX...XX...XX...X.XXX.', V: 'X...XX...XX...XX...XX...X.X.X...X..', W: 'X...XX...XX...XX.X.XX.X.XXX.XXX...X', X: 'X...XX...X.X.X...X...X.X.X...XX...X',
    Y: 'X...XX...X.X.X...X....X....X....X..', Z: 'XXXXX....X...X...X...X...X....XXXXX',
    0: '.XXX.X...XX..XXX.X.XXX..XX...X.XXX.', 1: '.X.XX..X..X..X..X.XXX', 2: '.XXX.X...X....X...X...X...X...XXXXX', 3: 'XXXX.....X....X.XXX.....X....XXXXX.',
    4: '...X...XX..X.X.X..X.XXXXX...X....X.', 5: 'XXXXXX....XXXX.....X....XX...X.XXX.', 6: '.XXX.X....X....XXXX.X...XX...X.XXX.', 7: 'XXXXX....X...X...X...X....X....X...',
    8: '.XXX.X...XX...X.XXX.X...XX...X.XXX.', 9: '.XXX.X...XX...X.XXXX....X....X.XXX.',
    '.': '......X', '-': '.........XXX.........', '!': 'XXXXX.X', ':': '.X...X.', '[': 'XXX.X.X.X.X.XX', ']': 'XX.X.X.X.X.XXX', '/': '....X...X....X...X...X....X...X....',
    '+': '.......X....X..XXXXX..X....X.......', '?': '.XXX.X...X....X...X...X.........X..', '»': '.....X.X...X.X...X.X.X.X.X.X...........', '×': '.....X...X.X.X...X...X.X.X...X.....', ' ': '..............', '#': '.X.X.XXXXX.X.X..X.X.XXXXX.X.X......',
};
const GW = { I: 3, 1: 3, '.': 1, '-': 3, '!': 1, ':': 1, '[': 2, ']': 2, ' ': 2 };

export function pfSvg(text, u = 1, scale = 1) {
    const d = Math.max(1, Math.round(u * scale + .25)) / scale;
    let x = 0, r = '';
    for (const ch of String(text).toUpperCase()) {
        const g = G[ch] || G['?'], w = GW[ch] || 5;
        for (let y = 0; y < 7; y++) {
            let c = 0;
            while (c < w) {
                if (g[y * w + c] !== 'X') { c++; continue; }
                let e = c;
                while (e < w && g[y * w + e] === 'X') e++;
                r += `<rect x="${((x + c) * d).toFixed(3)}" y="${(y * d).toFixed(3)}" width="${((e - c) * d).toFixed(3)}" height="${d.toFixed(3)}"/>`;
                c = e;
            }
        }
        x += w + 1;
    }
    const W = Math.max(0, x - 1) * d, H = 7 * d;
    return `<svg width="${W.toFixed(3)}" height="${H.toFixed(3)}" viewBox="0 0 ${W.toFixed(3)} ${H.toFixed(3)}" fill="currentColor" aria-hidden="true">${r}</svg>`;
}

const RIB_DANGER = "<div class=\"tl-gt-rib\"><svg class=\"rb\" viewBox=\"0 0 186 26\" width=\"186\" height=\"26\"><defs><linearGradient id=\"rbg2\" x1=\"0\" x2=\"1\"><stop offset=\"0\" stop-color=\"#3c0516\"/><stop offset=\".52\" stop-color=\"#760a2c\"/><stop offset=\"1\" stop-color=\"#a6123c\"/></linearGradient></defs><path d=\"M8 1H173A12 12 0 0 1 173 25H5L10 21 2 18 9 14 1 10 8 6 3 3Z\" fill=\"none\" stroke=\"#ff5c8c\" stroke-width=\"4.2\" opacity=\".4\"/><path d=\"M8 1H173A12 12 0 0 1 173 25H5L10 21 2 18 9 14 1 10 8 6 3 3Z\" fill=\"url(#rbg2)\" stroke=\"#ff769c\" stroke-width=\"1.35\"/></svg><svg class=\"em\" viewBox=\"-3 -2 38 24\" width=\"50\" height=\"32\" style=\"overflow:visible\"><g shape-rendering=\"crispEdges\"><rect x=\"-3\" y=\"-2\" width=\"38\" height=\"24\" rx=\"9\" fill=\"#ff2a50\" opacity=\".28\"/><rect x=\"1\" y=\"1\" width=\"30\" height=\"18\" rx=\"6\" fill=\"#ff2a50\" opacity=\".22\"/><rect x=\"10\" y=\"0\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"20\" y=\"0\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"4\" y=\"2\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"12\" y=\"2\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"18\" y=\"2\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"26\" y=\"2\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"6\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"8\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"10\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"12\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"14\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"16\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"18\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"20\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"22\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"24\" y=\"4\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"0\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"4\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"6\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"8\" y=\"6\" width=\"2\" height=\"2\" fill=\"#ff8aa0\"/><rect x=\"10\" y=\"6\" width=\"2\" height=\"2\" fill=\"#ff8aa0\"/><rect x=\"12\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"14\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"16\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"18\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"20\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"22\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"24\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"26\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"30\" y=\"6\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"2\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"4\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"6\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"8\" y=\"8\" width=\"2\" height=\"2\" fill=\"#3e0410\"/><rect x=\"10\" y=\"8\" width=\"2\" height=\"2\" fill=\"#3e0410\"/><rect x=\"12\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"14\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"16\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"18\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"20\" y=\"8\" width=\"2\" height=\"2\" fill=\"#3e0410\"/><rect x=\"22\" y=\"8\" width=\"2\" height=\"2\" fill=\"#3e0410\"/><rect x=\"24\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"26\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"28\" y=\"8\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"0\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"2\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"4\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"6\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"8\" y=\"10\" width=\"2\" height=\"2\" fill=\"#3e0410\"/><rect x=\"10\" y=\"10\" width=\"2\" height=\"2\" fill=\"#3e0410\"/><rect x=\"12\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"14\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"16\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"18\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"20\" y=\"10\" width=\"2\" height=\"2\" fill=\"#3e0410\"/><rect x=\"22\" y=\"10\" width=\"2\" height=\"2\" fill=\"#3e0410\"/><rect x=\"24\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"26\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"28\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"30\" y=\"10\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"2\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"4\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"6\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"8\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"10\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"12\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"14\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"16\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"18\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"20\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"22\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"24\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"26\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"28\" y=\"12\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"0\" y=\"14\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"6\" y=\"14\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"8\" y=\"14\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"10\" y=\"14\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"12\" y=\"14\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"14\" y=\"14\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"16\" y=\"14\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"18\" y=\"14\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"20\" y=\"14\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"22\" y=\"14\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"24\" y=\"14\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"30\" y=\"14\" width=\"2\" height=\"2\" fill=\"#e8203e\"/><rect x=\"4\" y=\"16\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"10\" y=\"16\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"20\" y=\"16\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"26\" y=\"16\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"2\" y=\"18\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/><rect x=\"28\" y=\"18\" width=\"2\" height=\"2\" fill=\"#a80c2a\"/></g></svg><span class=\"tx\"></span></div>";

let pxEl = null;
function getPx() {
    if (pxEl && pxEl.isConnected) return pxEl;
    pxEl = document.createElement('canvas');
    pxEl.className = 'tl-gt-px';
    pxEl.hidden = true;
    document.body.append(pxEl);
    return pxEl;
}

export function blocks(on) {
    return new Promise(res => {
        const px = getPx();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        px.width = Math.round(innerWidth * dpr);
        px.height = Math.round(innerHeight * dpr);
        px.hidden = false;
        const c = px.getContext('2d'), cols = 10, sz = Math.ceil(px.width / cols), rows = Math.ceil(px.height / sz);
        const pal = ['#1d1356', '#1d1356', '#1d1356', '#1d1356', '#150f3e', '#2a20a2', '#2a20a2', '#e23cd8', '#38e4ff', '#1d1356'];
        let seed = 11;
        const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
        const cells = [];
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) cells.push({ x, y, col: pal[Math.floor(rnd() * pal.length)], d: rnd() * 200 });
        if (reduced()) {
            c.fillStyle = '#1d1356';
            c.fillRect(0, 0, px.width, px.height);
            if (!on) px.hidden = true;
            return res();
        }
        const t0 = performance.now(), STEP = 34;
        let last = -1;
        (function tick(now) {
            const t = now - t0, k = Math.floor(t / STEP);
            if (k !== last) {
                last = k;
                const tt = k * STEP;
                c.clearRect(0, 0, px.width, px.height);
                for (const e of cells) if (on ? e.d <= tt : e.d > tt) { c.fillStyle = e.col; c.fillRect(e.x * sz, e.y * sz, sz, sz); }
            }
            if (t < 240) requestAnimationFrame(tick);
            else {
                if (!on) { c.clearRect(0, 0, px.width, px.height); px.hidden = true; }
                res();
            }
        })(t0);
    });
}

let pendingReturn = false, returnTimer = 0;

export function leaveGlitch(goBack) {
    if (reduced()) { goBack(); return; }
    pendingReturn = true;
    clearTimeout(returnTimer);
    returnTimer = setTimeout(() => {
        if (pendingReturn) { pendingReturn = false; blocks(false); }
    }, 1600);
    blocks(true).then(goBack);
}

export function takeGlitchReturn() {
    const p = pendingReturn;
    pendingReturn = false;
    clearTimeout(returnTimer);
    return p;
}

/* ---------- Bottom-sheet entrance bars, danger ribbon and exit squash ---------- */

const BARS = [[-10, 8, 60, 10, 12, 0], [30, 30, 45, 8, -16, 30], [5, 52, 70, 7, 10, 60]];
let sheetMO = null, sheetRefs = 0;
const sheetRects = new WeakMap();

function dressSheet(bd) {
    const s = bd.querySelector('.tl-sheet');
    if (!s || s.dataset.gtSheet) return;
    s.dataset.gtSheet = 'true';
    const sb = document.createElement('div');
    sb.className = 'tl-gt-sb';
    sb.innerHTML = BARS.map(([x, y, w, h, j, t]) => `<i style="--x:${x}%;--y:${y}px;--w:${w}%;--h:${h}px;--j:${j}px;--t:${t}ms"></i>`).join('');
    s.prepend(sb);
    const body = s.querySelector('.tl-sheet-body');
    if (body) {
        [...body.children].forEach((c, k) => c.style.setProperty('--k', k));
        const dangerBtn = body.querySelector('.tl-button.tl-danger');
        if (dangerBtn && body.querySelector('.tl-confirm-message') && !body.querySelector('.tl-gt-rib')) {
            s.dataset.gtTone = 'danger';
            const wrap = document.createElement('div');
            wrap.innerHTML = RIB_DANGER;
            const rib = wrap.firstElementChild;
            rib.querySelector('.tx').textContent = s.querySelector('.tl-sheet-title')?.textContent || '确认操作';
            body.firstElementChild?.prepend(rib);
        }
    }
    const rec = () => { if (s.isConnected) sheetRects.set(bd, s.getBoundingClientRect()); };
    rec();
    setTimeout(rec, 60);
    setTimeout(rec, 350);
    bd.addEventListener('pointerdown', rec, { capture: true, passive: true });
}

function spawnGhost(bd) {
    if (reduced() || document.documentElement.dataset.tlHome !== 'glitch') return;
    const s = bd.querySelector('.tl-sheet');
    const r = sheetRects.get(bd);
    if (!s || !r || !r.width || !r.height) return;
    const ghost = s.cloneNode(true);
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    ghost.removeAttribute('role');
    ghost.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    ghost.classList.add('tl-gt-sheet-ghost');
    Object.assign(ghost.style, {
        position: 'fixed',
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
        maxHeight: 'none',
        margin: '0',
        zIndex: '65',
        pointerEvents: 'none',
    });
    document.body.append(ghost);
    setTimeout(() => ghost.remove(), 210);
}

export function watchGlitchSheets() {
    sheetRefs++;
    if (sheetMO) return () => { if (--sheetRefs <= 0) { sheetMO?.disconnect(); sheetMO = null; sheetRefs = 0; } };
    const root = document.getElementById('root') || document.body;
    root.querySelectorAll('.tl-sheet-backdrop').forEach(dressSheet);
    sheetMO = new MutationObserver(muts => {
        if (document.documentElement.dataset.tlHome !== 'glitch') return;
        for (const m of muts) {
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1) continue;
                if (n.classList?.contains('tl-sheet-backdrop')) dressSheet(n);
                else n.querySelectorAll?.('.tl-sheet-backdrop').forEach(dressSheet);
            }
            for (const n of m.removedNodes) {
                if (n.nodeType !== 1) continue;
                if (n.classList?.contains('tl-sheet-backdrop')) spawnGhost(n);
                else n.querySelectorAll?.('.tl-sheet-backdrop').forEach(spawnGhost);
            }
        }
    });
    sheetMO.observe(root, { childList: true, subtree: true });
    return () => {
        if (--sheetRefs <= 0) { sheetMO?.disconnect(); sheetMO = null; sheetRefs = 0; }
    };
}
