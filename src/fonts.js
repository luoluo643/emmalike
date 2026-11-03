// Fonts the reader added: a file uploaded to their account, a link to a font file, or a link to a font stylesheet
// (how font sites hand them out). The list is kept with the rest of the appearance and follows the account.
// Only the font in use is declared, so the others are never downloaded.
export const MAX_FONTS = 20;
export const MAX_FONT_BYTES = 30 * 1024 * 1024;
export const FONT_FILE = /\.(ttf|otf|woff2?)$/i;

const FALLBACK = 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
const KINDS = ['upload', 'file', 'css'];
// Everything here ends up inside a stylesheet, including what comes back from the account copy.
const SAFE_URL = /^(https?:\/\/|\/user\/files\/)[^\s"'()\\<>]{1,1000}$/i;
const SAFE_FAMILY = /^[^"'\\;{}<>\r\n]{1,80}$/;

export function newFontId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function cleanFont(font) {
    if (!font || typeof font !== 'object' || !KINDS.includes(font.kind) || !/^[a-z0-9]{1,40}$/.test(font.id ?? '')) return null;
    if (!SAFE_URL.test(font.url ?? '')) return null;
    const family = font.kind === 'css' ? String(font.family ?? '').trim() : `tl-font-${font.id}`;
    if (!SAFE_FAMILY.test(family)) return null;
    return {
        id: font.id,
        name: String(font.name ?? '').trim().slice(0, 20) || family.slice(0, 20),
        kind: font.kind,
        url: font.url,
        family,
        ...(font.kind === 'upload' && /^[a-f0-9]{64}$/.test(font.digest ?? '') ? { digest: font.digest } : {}),
    };
}

/** IDs describe choices; source or file content describes duplicate resources. Keep query strings significant. */
export function sameFont(a, b) {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'upload' && a.digest && b.digest) return a.digest === b.digest;
    const url = value => { try { return new URL(value, 'https://tavern.invalid').href; } catch { return value; } };
    return url(a.url) === url(b.url) && (a.kind !== 'css' || a.family === b.family);
}

export const fontKey = font => `custom:${font.id}`;

export function fontValue(font) {
    return `"${font.family}", ${FALLBACK}`;
}

/** What makes the font available to the page: a stylesheet @import, or a @font-face around the file. */
export function fontFaceCss(font) {
    if (font.kind === 'css') return `@import url("${font.url}");`;
    return `@font-face { font-family: "${font.family}"; src: url("${font.url}"); font-display: swap; }`;
}

/** The address in what was pasted: a bare link, or the `@import url(…)` / `<link href=…>` a font site offers to copy. */
export function fontLinkIn(text) {
    const found = String(text ?? '').match(/https?:\/\/[^\s"'()<>]+/i)?.[0];
    if (!found) return '';
    try {
        return new URL(found).href.replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
    } catch {
        return '';
    }
}

export function isFontFileLink(url) {
    try { return FONT_FILE.test(new URL(url).pathname); } catch { return false; }
}

/** The name a font file link or a file is listed under: its file name without the extension. */
export function fontNameOf(path) {
    let name = String(path ?? '').split(/[?#]/)[0].split('/').pop() ?? '';
    try { name = decodeURIComponent(name); } catch { /* keep it as written */ }
    return name.replace(FONT_FILE, '').trim().slice(0, 20);
}

/** The first family a font stylesheet declares, or '' when it declares none. */
export function familyInCss(css) {
    const match = /@font-face\s*\{[^}]*?font-family\s*:\s*(?:"([^"]+)"|'([^']+)'|([^;}]+))/i.exec(String(css ?? ''));
    return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}
