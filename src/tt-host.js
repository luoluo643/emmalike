// TauriTavern (TT 酒馆): SillyTavern's own frontend running in a phone or desktop app, with the server replaced by the
// app itself. It has no web server: the page's requests are answered by the app only for its main page and for frames
// placed directly on it, and the full app cannot start inside a frame. So on TT the shell is not a page of its own
// with the full app hidden inside: it is laid over TT's page in a frame, and TT's page is the full app (engine.js).
// TT has one local user and no accounts.

/** The frame mark of the shell laid over TT's page (index.js creates it). */
export const TT_SHELL_MARK = 'tt-shell';
/** TT's only user, the name SillyTavern gives the single user without accounts. */
export const TT_ACCOUNT = 'default-user';
/** TT releases the shell was checked on (in the app, on Android). */
export const TESTED_TT_VERSIONS = ['2.4.0'];
/** Set in TT's page's session storage before the shell reloads it (after an install or update): open the shell again. */
export const TT_REOPEN_KEY = 'tavern-lite:tt-reopen';

/** Whether `win` is TT's page. */
export function isTauriTavern(win = globalThis) {
    try {
        return !!win?.__TAURITAVERN__;
    } catch {
        return false;
    }
}

/** In the shell: TT's page it is laid over, or null when the shell runs on a SillyTavern server. */
export function ttHostWindow(win = globalThis) {
    try {
        if (win?.frameElement?.dataset?.tavernLite !== TT_SHELL_MARK) return null;
        const host = win.parent;
        return host && host !== win && isTauriTavern(host) ? host : null;
    } catch {
        return null;
    }
}

// What TT's page answers for the shell: its API and the two small reads SillyTavern's pages make. TT takes over a
// frame's requests only once the frame has loaded, so a shell page that reloads would send its first ones to the
// app's file server (which answers with its start page). These go to TT's page itself, from the start.
const TT_ROUTED = /^\/(?:api\/|csrf-token$|version$)/;

/** Sends the shell's API requests to TT's page; true when installed (only in the shell on TT). */
export function installTtRequests(win = globalThis) {
    const host = ttHostWindow(win);
    if (!host || win.__tavernLiteTtRequests) return false;
    win.__tavernLiteTtRequests = true;
    const own = win.fetch;
    win.fetch = function (input, init) {
        let url = null;
        try { url = new URL(typeof input === 'string' || input instanceof win.URL ? String(input) : input.url, win.location.href); } catch { /* not a URL: as is */ }
        if (url && url.origin === win.location.origin && TT_ROUTED.test(url.pathname)) {
            return host.fetch(typeof input === 'string' || input instanceof win.URL ? url.href : input, init);
        }
        return own.call(this, input, init);
    };
    return true;
}

/** What /api/users/me answers on a SillyTavern without accounts: TT has no such request. */
export function ttUser() {
    return { handle: TT_ACCOUNT, name: 'User', avatar: '', admin: true, password: false, tauriTavern: true };
}

/**
 * The SillyTavern release TT's frontend follows, as SillyTavern writes its version ("SillyTavern 1.19.0"), or ''. TT's
 * displayVersion names TT itself ("TauriTavern 2.4.0 'main' (…)"); its client version keeps SillyTavern's shape for
 * extensions that check it ("SillyTavern:1.19.0:TauriTavern").
 */
export function ttSillyTavernVersion(clientVersion) {
    const number = /^SillyTavern:(\d+\.\d+\.\d+)(?::|$)/.exec(String(clientVersion ?? ''))?.[1];
    return number ? `SillyTavern ${number}` : '';
}

/** TT's own version from its /version answer ({ tauriVersion }), or ''. */
export function ttVersionOf(info) {
    const value = info?.tauriVersion;
    return typeof value === 'string' ? value.trim() : '';
}

export function isTestedTtVersion(version) {
    const number = /^(\d+\.\d+\.\d+)/.exec(String(version ?? '').trim())?.[1];
    return !!number && TESTED_TT_VERSIONS.includes(number);
}

/** TT answers a request it has no route for with 404 { error: "Unsupported endpoint: <path>" }. */
export function unsupportedEndpoint(text) {
    try {
        const error = JSON.parse(String(text ?? '')).error;
        const match = /^Unsupported endpoint:\s*(\S+)/.exec(String(error ?? ''));
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

/** TT answers a chat file that does not exist with an error, where SillyTavern answers {} (an empty chat). */
export function missingChatAnswer(status, text) {
    if (status < 400) return false;
    try {
        const data = JSON.parse(String(text ?? ''));
        return data?.error === 'Failed to load chat' && /^Not found:/.test(String(data?.details ?? ''));
    } catch {
        return false;
    }
}

/**
 * A clip-path that leaves holes where `rects` are, so what lies under the frame shows and takes touches there
 * (the full app's floating layers while the shell is on screen).
 */
export function clipWithHoles(rects, width, height, margin = 2) {
    // Even-odd filling counts every edge crossed: two holes laid over each other would fill their overlap again. So
    // the holes are first made into rectangles that do not overlap and cover the same area.
    const grown = rects.map(r => ({ x: r.x - margin, y: r.y - margin, width: r.width + 2 * margin, height: r.height + 2 * margin }));
    const holes = disjointRects(grown, width, height).map(r => `M${r.x} ${r.y}h${r.width}v${r.height}h${-r.width}z`).join('');
    return `path(evenodd, 'M0 0H${width}V${height}H0z${holes}')`;
}

/**
 * Rectangles that do not overlap and cover the same area as `rects` within 0..width × 0..height (each one cut to
 * it): bands between the rectangles' top and bottom edges, each band's covered stretches joined, and a stretch that
 * goes on unchanged in the band below grown into it.
 */
export function disjointRects(rects, width, height) {
    const boxes = rects.map(r => [Math.max(0, r.x), Math.max(0, r.y), Math.min(width, r.x + r.width), Math.min(height, r.y + r.height)])
        .filter(([x0, y0, x1, y1]) => x1 > x0 && y1 > y0);
    const xs = [...new Set(boxes.flatMap(b => [b[0], b[2]]))].sort((a, b) => a - b);
    const ys = [...new Set(boxes.flatMap(b => [b[1], b[3]]))].sort((a, b) => a - b);
    const out = [];
    let open = new Map();
    for (let j = 0; j + 1 < ys.length; j++) {
        const y0 = ys[j], y1 = ys[j + 1];
        const spans = [];
        for (let i = 0; i + 1 < xs.length; i++) {
            const x0 = xs[i], x1 = xs[i + 1];
            if (!boxes.some(b => b[0] <= x0 && b[2] >= x1 && b[1] <= y0 && b[3] >= y1)) continue;
            const last = spans[spans.length - 1];
            if (last && last[1] === x0) last[1] = x1;
            else spans.push([x0, x1]);
        }
        const next = new Map();
        for (const [x0, x1] of spans) {
            const key = `${x0},${x1}`;
            const above = open.get(key);
            if (above) {
                above.height = y1 - above.y;
                next.set(key, above);
            } else {
                const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
                out.push(rect);
                next.set(key, rect);
            }
        }
        open = next;
    }
    return out;
}

/** A clip-path showing only `rects` (the way back to the shell while TT's page is shown). */
export function clipToRects(rects, margin = 2) {
    return `path('${rects.map(r => {
        const x = r.x - margin, y = r.y - margin, w = r.width + 2 * margin, h = r.height + 2 * margin;
        return `M${x} ${y}h${w}v${h}h${-w}z`;
    }).join('')}')`;
}
