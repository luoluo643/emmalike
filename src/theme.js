// Appearance has three parts, all stored per browser and account, and synced to the account:
//   reading settings (which theme, font size, spacing…) chosen in the "Aa" sheet
//   custom themes the user made: colours, background picture, font and the theme's own CSS
//   custom CSS written by hand for the whole app.
// The theme and reading settings become style#tl-reading-css; the custom CSS is style#tl-user-css, placed after it
// so hand-written rules always win. index.html injects both cached stylesheets before the app loads (no flash).
// Another account signing in on this browser starts from its own copy (or the defaults), never from the last one's.
import { UI_FONT_SIZE, cleanDisplay, fontSize, reconcileDisplay } from './display-model.js';
export { UI_FONT_SIZE } from './display-model.js';
const CSS_KEY = 'tavern-lite:custom-css';
const DISPLAY_OWNER_KEY = 'tavern-lite:display-owner';
const displayKey = account => `tavern-lite:display:v1:${JSON.stringify(account)}`;
let appearanceAccount = null;
let legacyDisplay = null;
// Kept per account; the unscoped keys are from before that, adopted once by the account that last used this browser.
const appearanceKey = (account, part) => `tavern-lite:appearance:v1:${JSON.stringify(account)}:${part}`;
const READING_KEY = 'tavern-lite:reading';
const READING_CSS_KEY = 'tavern-lite:reading-css';
const THEMES_KEY = 'tavern-lite:themes';
const STAMP_KEY = 'tavern-lite:theme-updated';
const LEGACY_STAMP_KEY = 'tavern-lite:custom-css-updated';
const LEGACY_OWNER_KEY = 'tavern-lite:appearance-legacy-owner';
const LEGACY_PARTS = [['reading', READING_KEY], ['reading-css', READING_CSS_KEY], ['themes', THEMES_KEY], ['custom-css', CSS_KEY]];
const THEME_FORMAT = 'tavern-lite-theme';
const MAX_THEMES = 30;

/** `?safe` skips stored custom CSS, so a broken theme can always be repaired from the settings page. */
export const safeMode = /[?&]safe\b/.test(location.search);

const SERIF = '"Songti SC", "Noto Serif SC", "Source Han Serif SC", "SimSun", serif';
const KAI = '"Kaiti SC", "STKaiti", "KaiTi", "Noto Serif SC", serif';
const HEI = '"PingFang SC", "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif';

export const FONTS = {
    default: { label: '默认', value: null },
    serif: { label: '宋体', value: SERIF },
    kai: { label: '楷体', value: KAI },
    hei: { label: '黑体', value: HEI },
};

// Built-in themes. Only the five main colours are chosen by hand; everything else is derived (see themeVars).
export const PRESETS = {
    system: { name: '跟随系统' },
    paper: { name: '纸色', bg: '#f5efe3', text: '#2b2620', accent: '#8b5e34', quote: '#7a4a1e', em: '#6f6558' },
    white: { name: '白色', bg: '#ffffff', text: '#222222', accent: '#3a6ea5', quote: '#2f5d8a', em: '#5f6670' },
    green: { name: '护眼', bg: '#dfeacf', text: '#22301f', accent: '#4f7a3a', quote: '#3f6b2a', em: '#56664f' },
    sepia: { name: '羊皮', bg: '#e8d9bb', text: '#3b2e1e', accent: '#8a5a2b', quote: '#7b3f12', em: '#6a5940', font: 'serif' },
    rose: { name: '樱粉', bg: '#f8ebeb', text: '#3a2a2c', accent: '#b45a6a', quote: '#9c4152', em: '#7b6265' },
    night: { name: '夜间', bg: '#171513', text: '#d9d2c5', accent: '#d0a676', quote: '#e3b98a', em: '#aca291' },
    ink: { name: '墨蓝', bg: '#18202b', text: '#cfd6df', accent: '#86aed6', quote: '#a9c8e6', em: '#97a3b1' },
};

export const LINE_HEIGHTS = { compact: { label: '紧凑', value: 1.6 }, normal: { label: '标准', value: 1.85 }, loose: { label: '宽松', value: 2.1 } };
export const PARAGRAPHS = { tight: { label: '紧凑', value: '0.3em' }, normal: { label: '标准', value: '0.7em' }, loose: { label: '宽松', value: '1.3em' } };
export const MARGINS = { narrow: { label: '窄', value: '14px' }, normal: { label: '标准', value: '24px' }, wide: { label: '宽', value: '38px' } };
export const WIDTHS = { narrow: { label: '窄', value: 600 }, normal: { label: '标准', value: 720 }, wide: { label: '宽', value: 920 } };
export const FONT_SIZE = { min: 14, max: 26, default: 17 };

export const DEFAULT_READING = Object.freeze({
    theme: 'system', fontSize: FONT_SIZE.default, lineHeight: 'normal', font: 'default', width: 'normal',
    paragraph: 'normal', margin: 'normal', indent: true, justify: true,
});

/**
 * Ready-made pieces of CSS a theme can switch on, like the effects in a reading app. Each one is a marked block,
 * so it can be found and taken out again without touching what the user wrote around it.
 */
export const SNIPPETS = {
    dropCap: {
        label: '首字下沉',
        css: `.tl-chapter-opening ~ article.tl-message[data-role="char"]:first-of-type .tl-message-body::first-letter {
  float: left; font-size: 3em; line-height: 0.9; margin: 0.08em 0.1em 0 0; color: var(--tl-accent); font-weight: 600;
}
.tl-chapter-opening ~ article.tl-message[data-role="char"]:first-of-type .tl-message-body > p:first-child {
  text-indent: 0;
}`,
    },
    texture: {
        label: '纸张纹理',
        css: `body::before {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.07'/%3E%3C/svg%3E");
  background-size: 180px; background-repeat: repeat;
}`,
    },
    boldQuotes: { label: '对白加粗', css: '.tl-message-body q { font-weight: 600; }' },
    italicMine: { label: '我的话用斜体', css: '.tl-message[data-role="user"] .tl-message-body { font-style: italic; }' },
    showNames: { label: '显示角色名', css: '.tl-message[data-role="char"] .tl-message-name > span { display: inline; }' },
    noOrnament: { label: '去掉章首装饰', css: '.tl-chapter-opening { display: none; }' },
};

const snippetMarks = key => [`/* ${SNIPPETS[key].label} · 开始 */`, `/* ${SNIPPETS[key].label} · 结束 */`];

export function hasSnippet(css, key) {
    return String(css ?? '').includes(snippetMarks(key)[0]);
}

/** Adds the snippet to the CSS, or takes it out again if it is already there. */
export function toggleSnippet(css, key) {
    const [start, end] = snippetMarks(key);
    const text = String(css ?? '');
    const from = text.indexOf(start);
    if (from >= 0) {
        const to = text.indexOf(end, from);
        const cut = to >= 0 ? to + end.length : text.length;
        return (text.slice(0, from) + text.slice(cut)).replace(/\n{3,}/g, '\n\n').trim();
    }
    return [text.trim(), `${start}\n${SNIPPETS[key].css}\n${end}`].filter(Boolean).join('\n\n');
}

function storage(action) {
    try { return action(localStorage); } catch { return null; }
}

/** This account's stored part of the appearance; nothing before an account is known. */
function stored(part) {
    return appearanceAccount ? storage(s => s.getItem(appearanceKey(appearanceAccount, part))) : null;
}

/**
 * Moves the appearance kept before it was per account to the account it belonged to: the one signed in last when
 * this version first ran. Any other account leaves it alone and starts from its own copy.
 */
function adoptLegacyAppearance(account, lastOwner) {
    storage(s => {
        if (![...LEGACY_PARTS.map(([, key]) => key), STAMP_KEY, LEGACY_STAMP_KEY].some(key => s.getItem(key) !== null)) return;
        let owner = s.getItem(LEGACY_OWNER_KEY);
        if (!owner) { owner = lastOwner || account; s.setItem(LEGACY_OWNER_KEY, owner); }
        if (owner !== account) return;
        if (s.getItem(appearanceKey(account, 'updated')) === null) {
            for (const [part, key] of LEGACY_PARTS) { const value = s.getItem(key); if (value !== null) s.setItem(appearanceKey(account, part), value); }
            s.setItem(appearanceKey(account, 'updated'), s.getItem(STAMP_KEY) ?? s.getItem(LEGACY_STAMP_KEY) ?? '0');
        }
        for (const key of [...LEGACY_PARTS.map(([, key]) => key), STAMP_KEY, LEGACY_STAMP_KEY, LEGACY_OWNER_KEY]) s.removeItem(key);
    });
}

// --- colours --------------------------------------------------------------------------------------------------

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function rgb(hex) {
    let h = String(hex).slice(1);
    if (h.length === 3) h = [...h].map(c => c + c).join('');
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

const toHex = parts => '#' + parts.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

/** `amount` of colour b mixed into colour a. */
function mix(a, b, amount) {
    const x = rgb(a), y = rgb(b);
    return toHex(x.map((v, i) => v + (y[i] - v) * amount));
}

function alpha(hex, value) {
    return `rgba(${rgb(hex).join(', ')}, ${value})`;
}

export function luminance(hex) {
    const [r, g, b] = rgb(hex).map(v => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

function readableMix(color, background, toward, minimum = 4.5) {
    for (let step = 0; step <= 100; step++) {
        const candidate = mix(color, toward, step / 100);
        if (contrastRatio(candidate, background) >= minimum) return candidate;
    }
    return color; // Custom themes with unreadable base text are preserved and warned about in the editor.
}

/** `color` moved toward white (on a dark background) or black just enough to be read on `background`. */
export function readableOn(color, background) {
    return readableMix(color, background, luminance(background) < 0.25 ? '#ffffff' : '#000000');
}

export function isDark(theme) {
    return HEX.test(theme?.bg ?? '') && luminance(theme.bg) < 0.25;
}

/** Every theme variable, derived from the five main colours so a custom theme always stays readable. */
export function themeVars(theme) {
    if (!HEX.test(theme?.bg ?? '') || !HEX.test(theme?.text ?? '')) return {};
    const dark = isDark(theme);
    let accent = HEX.test(theme.accent ?? '') ? theme.accent : mix(theme.text, theme.bg, 0.3);
    if (theme.preset || Object.values(PRESETS).includes(theme)) accent = readableMix(accent, theme.bg, theme.text);
    const vars = {
        bg: theme.bg,
        text: theme.text,
        'text-muted': readableMix(mix(theme.text, theme.bg, 0.42), theme.bg, theme.text),
        accent,
        'accent-text': contrastRatio(accent, '#1c140b') >= contrastRatio(accent, '#ffffff') ? '#1c140b' : '#ffffff',
        border: mix(theme.bg, theme.text, dark ? 0.16 : 0.13),
        surface: alpha(mix(theme.bg, '#ffffff', dark ? 0.06 : 0.55), theme.opacity ?? (theme.image ? 0.82 : 0.94)),
        'surface-blur': `${theme.glass ?? 0}px`,
        radius: `${theme.radius ?? 16}px`,
        'header-bg': alpha(theme.bg, 0.86),
        'bubble-user-bg': 'transparent',
        quote: HEX.test(theme.quote ?? '') ? theme.quote : accent,
        em: HEX.test(theme.em ?? '') ? theme.em : mix(theme.text, theme.bg, 0.3),
        danger: dark ? '#e0806f' : '#a63d32',
    };
    if (theme.image) {
        vars['bg-image'] = `url("${String(theme.image).replace(/["\\\n]/g, '')}")`;
        vars['bg-dim'] = String(Math.min(0.8, Math.max(0, Number(theme.dim) || 0)));
        vars['bg-blur'] = `${theme.blur ?? 0}px`;
    }
    return vars;
}

// --- reading settings and custom themes -----------------------------------------------------------------------

export function cachedThemes() {
    try {
        const list = JSON.parse(stored('themes') ?? '[]');
        return Array.isArray(list) ? list.map(cleanTheme).filter(Boolean) : [];
    } catch {
        return [];
    }
}

export function cleanTheme(theme) {
    if (!theme || typeof theme !== 'object' || !HEX.test(theme.bg ?? '') || !HEX.test(theme.text ?? '')) return null;
    const color = key => HEX.test(theme[key] ?? '') ? theme[key].toLowerCase() : undefined;
    return {
        id: /^[\w-]{1,40}$/.test(theme.id ?? '') ? theme.id : newThemeId(),
        name: String(theme.name ?? '').trim().slice(0, 20) || '我的主题',
        bg: color('bg'), text: color('text'), accent: color('accent'), quote: color('quote'), em: color('em'),
        image: typeof theme.image === 'string' && /^(\/|https?:\/\/)/.test(theme.image) ? theme.image.slice(0, 500) : '',
        dim: clamp(theme.dim, 0, 0.8, 0),
        opacity: clamp(theme.opacity, 0.3, 1, theme.image ? 0.82 : 0.94),
        blur: clamp(theme.blur, 0, 20, 0),
        glass: clamp(theme.glass, 0, 24, 0),
        radius: clamp(theme.radius, 0, 28, 16),
        font: FONTS[theme.font] ? theme.font : 'default',
        css: typeof theme.css === 'string' ? theme.css.slice(0, 20000) : '',
    };
}

function clamp(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && value !== '' && value !== null ? Math.min(max, Math.max(min, n)) : fallback;
}

export function newThemeId() {
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** The theme a reading setting points at: a preset key, or "custom:<id>" for one the user made. */
export function findTheme(key, themes = cachedThemes()) {
    if (typeof key === 'string' && key.startsWith('custom:')) return themes.find(t => t.id === key.slice(7)) ?? null;
    return PRESETS[key] ? { ...PRESETS[key], id: key, preset: true } : null;
}

export function themeLabel(key, themes) {
    return findTheme(key, themes)?.name ?? PRESETS.system.name;
}

function clean(reading, themes) {
    const r = { ...DEFAULT_READING, ...(reading ?? {}) };
    if (!findTheme(r.theme, themes)) r.theme = DEFAULT_READING.theme;
    for (const [key, options] of [['font', FONTS], ['lineHeight', LINE_HEIGHTS], ['width', WIDTHS], ['paragraph', PARAGRAPHS], ['margin', MARGINS]]) {
        if (!options[r[key]]) r[key] = DEFAULT_READING[key];
    }
    r.indent = r.indent !== false;
    r.justify = r.justify !== false;
    const size = Math.round(Number(r.fontSize));
    r.fontSize = Number.isFinite(size) ? Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, size)) : FONT_SIZE.default;
    return r;
}

export function readingCss(reading, themes = cachedThemes()) {
    const r = clean(reading, themes);
    const theme = findTheme(r.theme, themes) ?? {};
    // The reading setting's font wins; a theme's own font applies while the reader keeps "default".
    const font = FONTS[r.font].value ?? FONTS[theme.font]?.value;
    const vars = {
        'font-size': `${r.fontSize}px`,
        'ui-font-size': `${cachedDisplay().fontSize}px`,
        'line-height': String(LINE_HEIGHTS[r.lineHeight].value),
        'paragraph-gap': PARAGRAPHS[r.paragraph].value,
        'page-margin': MARGINS[r.margin].value,
        'text-indent': r.indent ? '2em' : '0',
        'text-align': r.justify ? 'justify' : 'start',
        'chat-width': `${WIDTHS[r.width].value}px`,
        ...(font ? { font } : {}),
        ...themeVars(theme),
    };
    const body = Object.entries(vars).map(([k, v]) => `--tl-${k}: ${v};`).join(' ');
    const scheme = theme.bg ? ` color-scheme: ${isDark(theme) ? 'dark' : 'light'};` : '';
    return `:root { ${body}${scheme} }${theme.css ? `\n${theme.css}` : ''}`;
}

function styleElement(id, before) {
    let style = document.getElementById(id);
    if (!style) {
        style = document.createElement('style');
        style.id = id;
        const anchor = before && document.getElementById(before);
        if (anchor) anchor.before(style);
        else document.head.append(style);
    }
    return style;
}

export function cachedReading() {
    try { return clean(JSON.parse(stored('reading') ?? 'null')); } catch { return clean(null); }
}

export function cachedCss() {
    return stored('custom-css') ?? '';
}

function readDisplay(account = appearanceAccount) {
    if (!account) return null;
    try { return cleanDisplay(JSON.parse(storage(s => s.getItem(displayKey(account))))); } catch { return null; }
}

export function cachedDisplay() {
    return readDisplay() || legacyDisplay || reconcileDisplay(null, null, appearanceAccount ? null : cachedReading());
}

/** Bind only after /users/me succeeds. Display preferences never move between accounts. */
export function setAppearanceAccount(account) {
    if (appearanceAccount === account) return;
    const previous = storage(s => s.getItem(DISPLAY_OWNER_KEY));
    appearanceAccount = account || null;
    if (account) {
        adoptLegacyAppearance(account, previous);
        // One-time adoption of the legacy, previously unscoped device appearance.
        legacyDisplay = !previous || previous === account ? reconcileDisplay(null, null, cachedReading()) : null;
        storage(s => s.setItem(DISPLAY_OWNER_KEY, account));
    } else legacyDisplay = null;
    applyReading(cachedReading());
    applyCss(cachedCss());
}

export function saveDisplay(value, bridge) {
    if (!appearanceAccount) throw new Error('先登录才能改界面字号');
    const next = { schemaVersion: 1, fontSize: fontSize(value), updated: Date.now(), source: 'explicit' };
    // Report quota/private-mode failures instead of showing a value as saved.
    localStorage.setItem(displayKey(appearanceAccount), JSON.stringify(next));
    applyReading(cachedReading());
    if (bridge) {
        const settings = bridge.extensionSettings();
        settings.tavernLite = { ...(settings.tavernLite ?? {}), display: next };
        bridge.saveSettings();
    }
    dispatchEvent(new Event('tl-display-changed'));
    return next;
}

/** Shows reading settings (and optionally a different theme list, e.g. a theme being edited) without saving. */
export function applyReading(reading, themes) {
    document.getElementById('tl-display-boot')?.remove();
    styleElement('tl-reading-css', 'tl-user-css').textContent = readingCss(reading, themes);
    const theme = findTheme(clean(reading, themes).theme, themes);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme?.bg ?? '#1c1b1f');
}

export function applyCss(css, { preview = false } = {}) {
    if (safeMode && !preview) return;
    styleElement('tl-user-css').textContent = css;
}

function localStamp() {
    return Number(stored('updated') ?? 0);
}

function cache({ reading, customCss, themes }, updated) {
    const account = appearanceAccount;
    if (!account) return;
    storage(s => {
        const put = (part, value) => s.setItem(appearanceKey(account, part), value);
        if (themes) put('themes', JSON.stringify(themes));
        const list = themes ?? cachedThemes();
        const r = clean(reading ?? cachedReading(), list);
        put('reading', JSON.stringify(r));
        put('reading-css', readingCss(r, list));
        if (typeof customCss === 'string') put('custom-css', customCss);
        put('updated', String(updated));
    });
}

function pushToAccount(bridge, updated) {
    if (!bridge || !appearanceAccount) return;
    const settings = bridge.extensionSettings();
    settings.tavernLite = { ...(settings.tavernLite ?? {}), customCss: cachedCss(), reading: cachedReading(), themes: cachedThemes(), themeUpdated: updated };
    const display = reconcileDisplay(readDisplay(), settings.tavernLite.display, cachedReading());
    if (appearanceAccount) {
        // Migration is local only: a stale device must never publish an inferred value over an explicit choice.
        if (display.source === 'explicit') settings.tavernLite.display = display;
        storage(s => s.setItem(displayKey(appearanceAccount), JSON.stringify(display)));
    }
    bridge.saveSettings();
}

/** Applies and saves appearance changes; the account copy is updated when the full app is ready. */
export function saveAppearance(changes, bridge) {
    const updated = Date.now();
    cache(changes, updated);
    applyReading(cachedReading());
    if (typeof changes.customCss === 'string') applyCss(changes.customCss);
    pushToAccount(bridge, updated);
}

/** Saves one custom theme (new or edited) and, with `use`, switches to it. */
export function saveTheme(theme, bridge, { use = true } = {}) {
    const cleaned = cleanTheme(theme);
    const themes = cachedThemes().filter(t => t.id !== cleaned.id);
    themes.unshift(cleaned);
    const reading = use ? { ...cachedReading(), theme: `custom:${cleaned.id}` } : undefined;
    saveAppearance({ themes: themes.slice(0, MAX_THEMES), reading }, bridge);
    return cleaned;
}

export function deleteTheme(id, bridge) {
    const themes = cachedThemes().filter(t => t.id !== id);
    const reading = cachedReading();
    saveAppearance({ themes, reading: reading.theme === `custom:${id}` ? { ...reading, theme: DEFAULT_READING.theme } : reading }, bridge);
}

/** Reconciles this browser with the account once the full app is ready: the newer copy wins, so themes follow the account across devices. */
export function syncAppearanceWithAccount(bridge) {
    const settings = bridge?.extensionSettings();
    if (!settings) return;
    const remote = settings.tavernLite ?? {};
    const remoteUpdated = Number(remote.themeUpdated ?? remote.customCssUpdated ?? 0);
    const localUpdated = localStamp();
    if (appearanceAccount) {
        const legacyReading = legacyDisplay && localUpdated >= remoteUpdated ? cachedReading() : remote.reading;
        const display = reconcileDisplay(readDisplay(), remote.display, legacyReading);
        storage(s => s.setItem(displayKey(appearanceAccount), JSON.stringify(display)));
        // A separate field survives old reading-only writes and does not borrow their timestamp.
        if (display.source === 'explicit' && JSON.stringify(cleanDisplay(remote.display)) !== JSON.stringify(display)) {
            settings.tavernLite = { ...remote, display };
            bridge.saveSettings();
        }
    }
    if (remoteUpdated > localUpdated) {
        const themes = Array.isArray(remote.themes) ? remote.themes.map(cleanTheme).filter(Boolean) : undefined;
        cache({
            themes,
            reading: remote.reading ? clean(remote.reading, themes ?? cachedThemes()) : undefined,
            customCss: typeof remote.customCss === 'string' ? remote.customCss : undefined,
        }, remoteUpdated);
        applyReading(cachedReading());
        if (typeof remote.customCss === 'string') applyCss(remote.customCss);
    } else if (localUpdated > remoteUpdated) {
        pushToAccount(bridge, localUpdated);
    }
    applyReading(cachedReading());
}

// --- theme files ------------------------------------------------------------------------------------------------

async function embedImage(theme) {
    if (!theme.image?.startsWith('/')) return theme;
    try {
        const blob = await (await fetch(theme.image, { credentials: 'same-origin' })).blob();
        const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
        return { ...theme, image: '', imageData: data, imageName: theme.image.split('/').pop() };
    } catch {
        return { ...theme, image: '' };
    }
}

/**
 * A shareable theme file. Without `themeId` it holds the whole look (reading settings, custom themes, custom CSS);
 * with one, just that theme. Pictures uploaded to this server are embedded, since a friend's server will not have them.
 */
export async function exportTheme(themeId) {
    const themes = themeId ? cachedThemes().filter(t => t.id === themeId) : cachedThemes();
    const data = { format: THEME_FORMAT, version: 2, themes: await Promise.all(themes.map(embedImage)) };
    if (!themeId) Object.assign(data, { reading: cachedReading(), display: cachedDisplay(), customCss: cachedCss() });
    return JSON.stringify(data, null, 2);
}

const EXTERNAL = /url\(\s*['"]?\s*(https?:)?\/\/|@import/i;

/**
 * Parses a shared theme file (version 1: reading + custom CSS; version 2 adds custom themes). Returns the parsed
 * parts plus whether anything in it loads from other sites, which the caller asks about first.
 */
export function parseTheme(text) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('这不是轻酒馆的主题文件'); }
    if (data?.format !== THEME_FORMAT) throw new Error('这不是轻酒馆的主题文件');
    const customCss = typeof data.customCss === 'string' ? data.customCss : undefined;
    const themes = (Array.isArray(data.themes) ? data.themes : [])
        .map(t => ({ theme: cleanTheme({ ...t, image: /^https?:\/\//.test(t?.image ?? '') ? t.image : '' }), imageData: typeof t?.imageData === 'string' && t.imageData.startsWith('data:image/') ? t.imageData : '', imageName: t?.imageName }))
        .filter(t => t.theme);
    if (!themes.length && data.reading === undefined && customCss === undefined) throw new Error('这个主题文件是空的');
    const allCss = [customCss ?? '', ...themes.map(t => t.theme.css)].join('\n');
    return {
        reading: data.reading && typeof data.reading === 'object' ? data.reading : undefined,
        display: cleanDisplay(data.display),
        customCss,
        themes,
        loadsExternal: EXTERNAL.test(allCss) || themes.some(t => /^https?:\/\//.test(t.theme.image)),
    };
}

/**
 * Applies a parsed theme file. Embedded pictures are uploaded as backgrounds of this account first. Imported themes
 * always get fresh ids, so importing the same file twice never overwrites a theme the user has since changed.
 */
export async function importTheme(parsed, bridge, uploadImage) {
    const imported = [];
    for (const { theme, imageData, imageName } of parsed.themes) {
        let image = theme.image;
        if (imageData && uploadImage) {
            try {
                const blob = await (await fetch(imageData)).blob();
                image = await uploadImage(new File([blob], imageName || `theme-${theme.id}.png`, { type: blob.type }));
            } catch { image = ''; }
        }
        imported.push({ ...theme, id: newThemeId(), image });
    }
    const themes = [...imported, ...cachedThemes()].slice(0, MAX_THEMES);
    let reading = parsed.reading ? { ...parsed.reading } : undefined;
    // Version 2 files point at their themes by old id; follow them to the new ids.
    if (reading?.theme?.startsWith('custom:')) {
        const index = parsed.themes.findIndex(t => t.theme.id === reading.theme.slice(7));
        reading.theme = index >= 0 ? `custom:${imported[index].id}` : DEFAULT_READING.theme;
    }
    if (!reading && imported.length) reading = { ...cachedReading(), theme: `custom:${imported[0].id}` };
    saveAppearance({ themes, reading: reading ? clean(reading, themes) : undefined, customCss: parsed.customCss }, bridge);
    // Importing an old file adjusts reading only; it is not an explicit reset of the new interface setting.
    if (parsed.display) saveDisplay(parsed.display.fontSize, bridge);
    return imported;
}
