// Appearance has three parts, all stored per browser and account, and synced to the account:
//   reading settings (which theme, font size, spacing…) chosen in the "Aa" sheet
//   custom themes the user made: colours, background picture, font and the theme's own CSS
//   fonts the user added (fonts.js), declared in style#tl-font-css; only the one in use, so the others are not downloaded
//   custom CSS written by hand for the whole app.
// The theme and reading settings become style#tl-reading-css; the custom CSS is style#tl-user-css, placed after it
// so hand-written rules always win. index.html injects both cached stylesheets before the app loads (no flash).
// Another account signing in on this browser starts from its own copy (or the defaults), never from the last one's.
import { UI_FONT_SIZE, cleanDisplay, fontSize, reconcileDisplay } from './display-model.js';
import { MAX_FONTS, cleanFont, fontFaceCss, fontKey, fontValue, sameFont } from './fonts.js';
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

// --- CSS of the illustrated themes ----------------------------------------------------------------------------

const LATIN_SERIF = 'Georgia, "Times New Roman"';
const NUMERALS = '"Bahnschrift", "DIN Alternate", "Roboto Condensed", "Arial Narrow", sans-serif';

/** The character's name above each reply, on the left in the accent colour; number, time and ⋯ stay on the right. */
function namedCss(extra = '') {
    return `.tl-message[data-role="char"] .tl-message-name { position: static; margin: 0 -8px 6px 0; font-size: 0.8em; }
.tl-message[data-role="char"] .tl-message-name > span:first-child { display: inline; margin-right: auto; font-size: 1.2em; font-weight: 700; letter-spacing: 0.08em; color: var(--tl-accent); ${extra} }`;
}

/** Your lines as a card on the right instead of a note in the margin. */
function sideCss(look) {
    return `.tl-message[data-role="user"] { align-self: flex-end; max-width: 90%; border: 0; ${look} }`;
}

/**
 * The first "continue reading" card as a cover: the character's picture fills it and the text sits on the faded
 * bottom (on a wide screen, on the left), and the character page gets the same picture behind its hero.
 * .tl-continue-cover and .tl-work-art are the full picture; it is only downloaded where a theme gives them a
 * background, and the small one stays underneath until it has arrived.
 */
function coverCss(bg, extra = '') {
    const card = '.tl-continue-primary[data-kind="character"]';
    return `${card} { position: relative; isolation: isolate; overflow: hidden; display: block; min-height: 340px; padding: 200px 18px 18px; }
${card} > :is(.tl-avatar, .tl-continue-cover) { display: block; position: absolute; inset: 0; z-index: -2; width: 100%; height: 100%; border-radius: 0; object-fit: cover; object-position: 50% 15%; }
${card} > .tl-continue-cover { background: var(--tl-cover) 50% 15% / cover no-repeat; }
${card}::before { content: ""; position: absolute; inset: 0; z-index: -1; background: radial-gradient(130% 75% at 0% 100%, rgba(0, 0, 0, 0.62), rgba(0, 0, 0, 0.3) 42%, transparent 72%); }
${card} .tl-card-text { position: relative; color: #fff; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6), 0 0 14px rgba(0, 0, 0, 0.45); }
${card} .tl-card-text :is(.tl-card-name, .tl-card-story) { color: #fff; }
${card} .tl-card-text :is(.tl-card-snippet, .tl-card-meta) { color: rgba(255, 255, 255, 0.82); }
${card} .tl-card-name { font-size: 1.8em; white-space: normal; }
.tl-work-hero { position: relative; isolation: isolate; overflow: hidden; padding: 190px 14px 14px; border-radius: var(--tl-radius); }
.tl-work-hero > .tl-work-art { display: block; position: absolute; inset: 0; z-index: -2; background: var(--tl-cover) 50% 15% / cover no-repeat; }
.tl-work-hero::before { content: ""; position: absolute; inset: 0; z-index: -1; background: linear-gradient(180deg, transparent 40px, color-mix(in srgb, ${bg} 75%, transparent) 130px, ${bg} 185px); }
.tl-work-cover { width: 100px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35); }
.tl-continue-primary + .tl-continue-menu { color: #fff; background: rgba(0, 0, 0, 0.42); border-radius: 999px; }
@media (min-width: 700px) {
  ${card} { display: flex; align-items: flex-end; min-height: 280px; padding: 28px 50% 28px 28px; }
  ${card} > :is(.tl-avatar, .tl-continue-cover) { left: 38%; width: 62%; }
  ${card}::before { background: linear-gradient(90deg, color-mix(in srgb, ${bg} 45%, transparent) 30%, transparent 62%); }
}
${extra}`;
}

function starCss() {
    return `:root {
  --tl-bg-image: radial-gradient(1px 1px at 14% 22%, rgba(255, 255, 255, 0.7), transparent 60%), radial-gradient(1px 1px at 82% 34%, rgba(255, 255, 255, 0.6), transparent 60%), radial-gradient(1px 1px at 40% 76%, rgba(255, 255, 255, 0.6), transparent 60%), radial-gradient(1.5px 1.5px at 66% 12%, rgba(255, 255, 255, 0.5), transparent 60%), radial-gradient(1px 1px at 24% 54%, rgba(255, 255, 255, 0.45), transparent 60%), radial-gradient(70vmax 50vmax at 100% 0%, rgba(122, 92, 200, 0.28), transparent 70%), linear-gradient(180deg, #0d0f24, #17152f);
  --tl-surface: rgba(255, 255, 255, 0.07);
  --tl-border: rgba(255, 255, 255, 0.16);
  --tl-radius: 18px;
}
${namedCss()}
.tl-message[data-role="char"] .tl-message-name > span:first-child::after { content: ""; display: inline-block; width: 24px; height: 1px; margin-left: 8px; vertical-align: middle; background: currentColor; opacity: 0.6; }
${sideCss('padding: 10px 16px 12px; border-radius: 22px; background: linear-gradient(90deg, rgba(10, 10, 30, 0.85), rgba(30, 30, 64, 0.7)); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);')}
.tl-chapter-heading { letter-spacing: 0.12em; text-shadow: 0 0 18px rgba(185, 164, 240, 0.45); }
.tl-ornament { box-shadow: 0 0 10px rgba(232, 194, 122, 0.6); }
.tl-composer-box { background: rgba(255, 255, 255, 0.08); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14); }
.tl-send:not(:disabled) { background: #f3efe6; color: #1b1838; }
.tl-character { background: rgba(255, 255, 255, 0.06); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); }
.tl-sheet { background: linear-gradient(180deg, #17152f, #0d0f24 140px); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16), 0 -8px 30px rgba(0, 0, 0, 0.5); }
.tl-sheet-title { letter-spacing: 0.12em; }
.tl-sheet-title::after { content: ""; display: inline-block; width: 5px; height: 5px; margin-left: 8px; vertical-align: middle; border-radius: 50%; background: var(--tl-accent); box-shadow: 0 0 8px var(--tl-accent); }
${coverCss('#0d0f24', `.tl-continue-primary .tl-continue-label { justify-self: start; padding: 2px 12px; border-radius: 999px; background: #f3efe6; color: #1b1838; }
.tl-continue-primary .tl-card-name { letter-spacing: 0.06em; text-shadow: 0 2px 12px rgba(13, 15, 36, 0.8); }`)}`;
}

function giltCss() {
    const ring = '0 0 0 1px #c9b98f, 0 0 0 4px #f6f1e7, 0 0 0 5px rgba(201, 185, 143, 0.7), 0 6px 16px rgba(59, 66, 85, 0.18)';
    return `:root {
  --tl-bg-image: radial-gradient(70vmax 40vmax at 50% -10%, rgba(255, 255, 255, 0.7), transparent 70%), radial-gradient(60vmax 36vmax at 50% 110%, rgba(211, 188, 142, 0.3), transparent 70%);
  --tl-surface: rgba(246, 241, 231, 0.94);
  --tl-border: #d8c9a6;
}
${namedCss()}
.tl-message[data-role="char"] .tl-message-name > span:first-child::after { content: ""; display: inline-block; width: 56px; height: 1px; margin-left: 10px; vertical-align: middle; background: linear-gradient(90deg, rgba(160, 126, 69, 0.8), rgba(160, 126, 69, 0.1)); }
${sideCss('padding: 10px 16px 12px; border-radius: 24px; background: linear-gradient(90deg, rgba(30, 34, 46, 0.94), rgba(59, 66, 85, 0.9)); color: #ece5d8; box-shadow: inset 0 0 0 1px rgba(211, 188, 142, 0.45); --tl-text-muted: #d3bc8e; --tl-quote: #f0d9a8; --tl-em: #cfc6b5; --tl-accent: #d3bc8e;')}
.tl-chapter-opening { align-self: center; padding: 0.9em 2.6em 0.8em; border-radius: 6px 22px 6px 6px; background: #f6f1e7; box-shadow: ${ring}; }
.tl-chapter-heading { font-weight: 900; letter-spacing: 0.16em; }
.tl-ornament::after { background: #a07e45; border: 0; clip-path: polygon(50% 0, 61% 39%, 100% 50%, 61% 61%, 50% 100%, 39% 61%, 0 50%, 39% 39%); transform: translate(-50%, -50%); width: 10px; height: 10px; }
.tl-character { border-radius: 6px 18px 6px 6px; box-shadow: 0 0 0 1px #c9b98f, 0 3px 10px rgba(59, 66, 85, 0.1); }
.tl-character .tl-avatar { border-radius: 4px 14px 4px 4px; }
.tl-sheet { background: #f6f1e7; border-radius: 6px 22px 0 0; box-shadow: inset 0 1px 0 #c9b98f, inset 0 4px 0 #f6f1e7, inset 0 5px 0 rgba(201, 185, 143, 0.7), 0 -8px 30px rgba(59, 66, 85, 0.18); }
.tl-sheet-title { color: var(--tl-accent); font-weight: 900; letter-spacing: 0.14em; }
${coverCss('#efe8da', `.tl-continue-primary[data-kind="character"] { border-radius: 6px 22px 6px 6px; box-shadow: ${ring}; margin: 5px; }
.tl-continue-primary .tl-continue-label { justify-self: start; padding: 1px 14px; color: #f6f1e7; background: linear-gradient(90deg, #8a6532, #a07e45); border-radius: 2px; }
.tl-continue-primary .tl-card-name { font-weight: 900; letter-spacing: 0.1em; }`)}`;
}

function echoCss() {
    return `:root {
  --tl-bg-image: radial-gradient(60vmax 45vmax at 100% 0%, rgba(125, 227, 212, 0.06), transparent 70%), linear-gradient(180deg, #121417, #0e1012);
  --tl-surface: rgba(255, 255, 255, 0.05);
  --tl-border: rgba(255, 255, 255, 0.12);
  --tl-radius: 4px;
}
.tl-message-body { font-weight: 300; }
.tl-message-body :is(q, strong, b) { font-weight: 400; }
.tl-message-meta { font-family: ${NUMERALS}; letter-spacing: 0.08em; }
${namedCss(`font-weight: 500; letter-spacing: 0.2em;`)}
.tl-message[data-role="char"] .tl-message-name > span:first-child::after { content: ""; display: inline-block; width: 6px; height: 6px; margin-left: 10px; vertical-align: middle; border: 1px solid currentColor; transform: rotate(45deg); }
${sideCss('padding: 12px 14px; border-radius: 0; background: rgba(255, 255, 255, 0.05);')}
.tl-message[data-role="user"]::before, .tl-message[data-role="user"]::after { content: ""; position: absolute; width: 10px; height: 10px; pointer-events: none; }
.tl-message[data-role="user"]::before { right: 0; top: 0; border-top: 1.5px solid #e9eaea; border-right: 1.5px solid #e9eaea; }
.tl-message[data-role="user"]::after { left: 0; bottom: 0; border-bottom: 1.5px solid #e9eaea; border-left: 1.5px solid #e9eaea; }
:is(.tl-chapter-heading, .tl-library .tl-title, .tl-continue-primary .tl-card-name) { font-family: ${LATIN_SERIF}, "Songti SC", "Noto Serif SC", "SimSun", serif; color: var(--tl-accent); letter-spacing: 0.14em; font-weight: 600; }
.tl-composer-box { border-radius: 4px; }
.tl-grid { counter-reset: tl-echo; }
.tl-book { counter-increment: tl-echo; }
.tl-book::after { content: counter(tl-echo, decimal-leading-zero); position: absolute; left: 18px; bottom: 46px; font: 600 2.2em/1 ${NUMERALS}; color: rgba(255, 255, 255, 0.6); text-shadow: 0 1px 6px rgba(0, 0, 0, 0.7); pointer-events: none; }
.tl-character { border-bottom: 2px solid var(--tl-accent); }
.tl-character .tl-avatar { border-radius: 999px 999px 2px 2px; box-shadow: 0 0 0 1px rgba(240, 214, 138, 0.45); }
.tl-sheet { border-radius: 2px 2px 0 0; box-shadow: inset 0 1px 0 rgba(240, 214, 138, 0.55), 0 -8px 30px rgba(0, 0, 0, 0.6); }
.tl-sheet-title { color: var(--tl-accent); letter-spacing: 0.2em; font-weight: 500; }
${coverCss('#0e1012', `.tl-continue-primary[data-kind="character"]::after { content: ""; position: absolute; left: 18px; top: 18px; bottom: 18px; width: 1px; background: linear-gradient(180deg, transparent, rgba(240, 214, 138, 0.7), transparent); }
.tl-continue-primary .tl-continue-label { letter-spacing: 0.3em; }`)}`;
}

// Drawn decorations for the themes below, kept as inline SVG so a theme needs no picture files.
const TYPEWRITER = '"Courier New", Courier, monospace';
const svg = markup => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' ${markup}</svg>`)}")`;

/** Ridges of far hills along the bottom of the page, palest at the back. */
function ridges() {
    return svg(`width='1200' height='360' viewBox='0 0 1200 360' preserveAspectRatio='none'><path fill='#9fb3aa' fill-opacity='.16' d='M0 170 C120 120 220 150 330 110 S560 60 700 120 S960 90 1080 130 S1180 120 1200 125 V360 H0Z'/><path fill='#7f9a8f' fill-opacity='.16' d='M0 240 C150 190 260 230 400 200 S640 150 780 210 S1020 180 1200 220 V360 H0Z'/><path fill='#647f74' fill-opacity='.14' d='M0 300 C180 270 300 300 460 280 S720 250 880 290 S1080 280 1200 300 V360 H0Z'/>`);
}
const PEAK = svg(`width='60' height='14' viewBox='0 0 60 14' fill='none' stroke='#4f6b5f' stroke-width='1.2' stroke-linejoin='round'><path d='M2 13 L18 4 L26 9 L36 2 L58 13'/>`);

const VINE = svg(`width='130' height='16' viewBox='0 0 130 16' fill='none' stroke-linecap='round'><path d='M4 9 C30 2 50 15 66 8 S102 2 126 9' stroke='#6750a4' stroke-width='1.2'/><g fill='#a3c46a'><path d='M34 6 q4 -6 10 -4 q-4 6 -10 4z'/><path d='M84 10 q5 5 11 2 q-5 -6 -11 -2z'/></g><g fill='#9b87d9'><circle cx='66' cy='8' r='2.4'/><circle cx='112' cy='6' r='1.8'/></g>`);
const DASH = svg(`width='8' height='100' viewBox='0 0 8 100' preserveAspectRatio='none'><rect y='96' width='4' height='4' fill='#6750a4' fill-opacity='.3'/>`);

function mountainCss() {
    return `:root {
  --tl-bg-image: ${ridges()} center bottom / 100% 42vh no-repeat, linear-gradient(180deg, rgba(255, 255, 255, 0.85), transparent 45%), linear-gradient(180deg, #f2f4f1, #e6ebe7);
  --tl-surface: rgba(255, 255, 255, 0.42);
  --tl-surface-blur: 8px;
  --tl-border: rgba(44, 51, 48, 0.1);
  --tl-shadow: none;
}
:is(.tl-library .tl-title, .tl-chapter-heading, .tl-work-name) { font-weight: 300; letter-spacing: 0.24em; }
:is(.tl-search, input.tl-input) { border-radius: 999px; }
.tl-list { background: transparent; box-shadow: none; }
.tl-list-item { border-bottom: 1px solid var(--tl-border); }
.tl-ornament { width: 60px; height: 14px; background: ${PEAK} center / contain no-repeat; opacity: 0.7; }
.tl-ornament::after { display: none; }
.tl-message[data-role="user"] { border-left-color: rgba(79, 107, 95, 0.35); }
.tl-character { background: rgba(255, 255, 255, 0.3); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.8); }
.tl-sheet { background: rgba(242, 245, 242, 0.96); backdrop-filter: blur(14px); box-shadow: 0 -10px 40px rgba(44, 51, 48, 0.1); }
.tl-sheet-title { font-weight: 400; letter-spacing: 0.2em; }
${coverCss('#eaeeea', `.tl-continue-primary[data-kind="character"] > :is(.tl-avatar, .tl-continue-cover) { filter: saturate(0.6) brightness(1.05); }
.tl-continue-primary .tl-card-name { font-weight: 300; letter-spacing: 0.22em; }
.tl-continue-primary .tl-continue-label { color: #dfe8e2; }`)}`;
}

function wisteriaCss() {
    return `:root {
  --tl-bg-image: radial-gradient(60vmax 40vmax at 0% 0%, rgba(155, 135, 217, 0.16), transparent 70%), radial-gradient(50vmax 40vmax at 100% 100%, rgba(163, 196, 106, 0.16), transparent 70%);
  --tl-surface: rgba(255, 255, 255, 0.9);
  --tl-border: #e4dff0;
  --tl-shadow: 0 6px 22px rgba(103, 80, 164, 0.1);
}
:is(.tl-library .tl-title, .tl-chapter-heading, .tl-work-name) { font-family: ${KAI}; color: #6750a4; letter-spacing: 0.16em; }
.tl-chapter-heading { font-size: 2.1em; }
.tl-ornament { width: 130px; height: 16px; background: ${VINE} center / contain no-repeat; opacity: 0.9; }
.tl-ornament::after { display: none; }
${namedCss('color: #6750a4;')}
.tl-message-body q { padding: 0.05em 0.2em; border-radius: 0.35em; background: rgba(163, 196, 106, 0.22); -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.tl-message[data-role="char"] .tl-message-body p { background: ${DASH} 0 0 / 8px calc(var(--tl-font-size) * var(--tl-line-height)) repeat; }
${sideCss('padding: 10px 14px; border-radius: 16px; background: rgba(255, 255, 255, 0.92); box-shadow: inset 0 0 0 1px rgba(103, 80, 164, 0.28), 0 4px 14px rgba(103, 80, 164, 0.08);')}
.tl-character .tl-avatar { box-shadow: 0 6px 16px rgba(103, 80, 164, 0.18); }
.tl-sheet { box-shadow: inset 0 3px 0 rgba(163, 196, 106, 0.8), 0 -8px 30px rgba(103, 80, 164, 0.14); }
.tl-sheet-title { font-family: ${KAI}; color: #6750a4; letter-spacing: 0.14em; font-size: 1.1em; }
${coverCss('#fcfbfe', `.tl-continue-primary .tl-continue-label { justify-self: start; padding: 1px 12px; border-radius: 999px; color: var(--tl-accent-text); background: var(--tl-accent); }
.tl-continue-primary .tl-card-name { font-family: ${KAI}; color: #6750a4; letter-spacing: 0.12em; }`)}`;
}

// --- layouts of the illustrated themes ---------------------------------------------------------------------------
// Each illustrated theme also moves and reshapes the controls, so it reads as its own app rather than a new colour.
// Only the selectors THEMING.md promises are used; touch areas stay at least 44px.

/** The shelf's two buttons (添加角色, 我的) in a bar floating at the bottom of the screen. */
function dockCss(bar, button = '') {
    return `.tl-library { padding-bottom: calc(100px + env(safe-area-inset-bottom)); }
.tl-library > .tl-header > .tl-button { position: fixed; z-index: 20; bottom: calc(18px + env(safe-area-inset-bottom)); min-width: 128px; min-height: 44px; ${button} }
.tl-library > .tl-header > .tl-button:not(.tl-me-button) { right: calc(50% + 4px); }
.tl-library > .tl-header > .tl-me-button { left: calc(50% + 4px); }
.tl-library > .tl-header::after { content: ""; position: fixed; z-index: 19; left: 50%; bottom: calc(10px + env(safe-area-inset-bottom)); width: 288px; height: 60px; transform: translateX(-50%); pointer-events: none; ${bar} }`;
}

/** The reader's 目录 · Aa · ⋯ joined into one capsule. */
function capsuleCss(look) {
    return `.tl-reader-header { gap: 0; }
.tl-reader-header > .tl-ghost:not(.tl-back) { border-radius: 0; ${look} }
.tl-reader-header > .tl-spacer + .tl-ghost { border-radius: 999px 0 0 999px; padding-left: 6px; }
.tl-reader-header > .tl-ghost:last-child { border-radius: 0 999px 999px 0; padding-right: 6px; margin-right: 4px; }`;
}

/** Characters as a list: a small round picture and the name on one line. */
const SHELF_LIST = `.tl-grid { grid-template-columns: minmax(0, 1fr); gap: 0; }
.tl-character { grid-template-columns: 52px minmax(0, 1fr); justify-items: start; align-items: center; gap: 14px; padding: 10px 52px 10px 4px; text-align: left; border-radius: 0; }
.tl-character .tl-avatar { width: 52px; height: 52px; aspect-ratio: 1; border-radius: 50%; }
.tl-book-menu { top: 50%; margin-top: -22px; color: var(--tl-text-muted); background: transparent; }`;

/** Characters in one row that scrolls sideways, a card at a time. */
const SHELF_CAROUSEL = `.tl-grid { grid-template-columns: none; grid-auto-flow: column; grid-auto-columns: minmax(150px, 44%); overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x mandatory; padding: 4px 2px 14px; scrollbar-width: none; }
.tl-grid::-webkit-scrollbar { display: none; }
.tl-book { scroll-snap-align: start; }`;

/** Tags as words with a line under the chosen one instead of pills. */
function tabChipsCss(line) {
    return `.tl-library .tl-chip { background: transparent; border-radius: 0; padding: 6px 10px; color: var(--tl-text-muted); box-shadow: none; }
.tl-library .tl-chip[aria-pressed="true"] { color: var(--tl-text); font-weight: 600; background: transparent; box-shadow: inset 0 -2px 0 ${line}; }`;
}

/** Buttons cut to a shape lose their focus ring to the cut; while focused they are plain. */
const UNCLIP_FOCUS = ':is(.tl-button, .tl-send, .tl-swipe, .tl-continue-writing):focus-visible { clip-path: none; }';
const PENDING = '.tl-message[data-pending="true"] .tl-button { color: var(--tl-accent); background: transparent; border-radius: 999px; clip-path: none; transform: none; box-shadow: inset 0 0 0 1.5px currentColor; font-weight: 600; }';
const PLAIN_CLOSE = '.tl-sheet-close { clip-path: none; border-radius: 50%; background: transparent; box-shadow: none; transform: none; }';

const LAYOUTS = {
    star: `${dockCss('border-radius: 999px; background: rgba(23, 21, 47, 0.72); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16), 0 10px 30px rgba(0, 0, 0, 0.45);',
        'background: transparent; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2);')}
.tl-library > .tl-header > .tl-me-button { background: #f3efe6; color: #1b1838; }
${capsuleCss('background: rgba(255, 255, 255, 0.08); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12), inset 0 -1px 0 rgba(255, 255, 255, 0.06);')}
.tl-back { border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.24); }
.tl-button { background: rgba(255, 255, 255, 0.06); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2); }
:is(.tl-button[aria-pressed="true"], .tl-primary) { background: #f3efe6; color: #1b1838; box-shadow: 0 0 18px rgba(232, 194, 122, 0.35); }
.tl-library .tl-chip { background: transparent; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16); }
.tl-library .tl-chip[aria-pressed="true"] { background: rgba(232, 194, 122, 0.16); color: #f6dca6; box-shadow: inset 0 0 0 1px rgba(232, 194, 122, 0.6); }
.tl-search { border-radius: 999px; }
.tl-swipe { background: rgba(255, 255, 255, 0.06); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16); }
.tl-send:not(:disabled) { width: 44px; height: 44px; box-shadow: 0 0 16px rgba(232, 194, 122, 0.45); }`,

    gilt: `.tl-library > .tl-header { grid-template-columns: 1fr 1fr; justify-items: center; text-align: center; }
.tl-library > .tl-header > .tl-title { grid-column: 1 / -1; font-size: 1.4em; letter-spacing: 0.3em; }
.tl-library > .tl-header > .tl-title::before, .tl-library > .tl-header > .tl-title::after { content: ""; display: inline-block; width: 9px; height: 9px; margin: 0 12px; vertical-align: middle; background: #a07e45; clip-path: polygon(50% 0, 61% 39%, 100% 50%, 61% 61%, 50% 100%, 39% 61%, 0 50%, 39% 39%); }
.tl-library > .tl-header > .tl-button { width: 100%; }
.tl-button { border-radius: 0; padding-inline: 22px; background: #f6f1e7; box-shadow: inset 0 0 0 1px #c9b98f; clip-path: polygon(10px 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 10px 100%, 0 50%); }
:is(.tl-button[aria-pressed="true"], .tl-primary) { color: #f6f1e7; background: linear-gradient(90deg, #8a6532, #b08a4c, #8a6532); }
${tabChipsCss('#a07e45')}
.tl-search { border-radius: 6px 18px 6px 6px; box-shadow: inset 0 0 0 1px #c9b98f; }
.tl-reader-header > .tl-ghost { border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(160, 126, 69, 0.55); margin-inline: 2px; }
.tl-composer-box { border-radius: 6px 22px 6px 6px; box-shadow: inset 0 0 0 1px #c9b98f, 0 4px 14px rgba(59, 66, 85, 0.12); }
.tl-send:not(:disabled) { border-radius: 0; width: 42px; height: 42px; background: linear-gradient(135deg, #8a6532, #b08a4c); clip-path: polygon(30% 0, 70% 0, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0 70%, 0 30%); }
.tl-swipe { border-radius: 0; background: #f6f1e7; box-shadow: inset 0 0 0 1px #c9b98f; clip-path: polygon(14px 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 14px 100%, 0 50%); padding-inline: 10px; }
.tl-continue-writing { border-radius: 0; clip-path: polygon(10px 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 10px 100%, 0 50%); padding-inline: 20px; }
${UNCLIP_FOCUS}`,

    echo: `${SHELF_CAROUSEL}
.tl-library > .tl-header > .tl-button { border-radius: 0; background: transparent; box-shadow: inset 2px 0 0 #f0d68a; padding-inline: 14px; letter-spacing: 0.12em; clip-path: none; }
.tl-button { border-radius: 0; letter-spacing: 0.1em; background: rgba(255, 255, 255, 0.05); clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%); padding-inline: 20px; }
:is(.tl-button[aria-pressed="true"], .tl-primary) { color: #121212; background: #f0d68a; }
.tl-library .tl-chip { border-radius: 0; background: transparent; padding: 6px 12px; color: var(--tl-text-muted); box-shadow: inset 2px 0 0 rgba(255, 255, 255, 0.18); }
.tl-library .tl-chip[aria-pressed="true"] { color: #f0d68a; background: rgba(240, 214, 138, 0.08); box-shadow: inset 2px 0 0 #f0d68a; }
.tl-search { border-radius: 0; background: transparent; box-shadow: inset 0 -1px 0 rgba(240, 214, 138, 0.5); }
.tl-reader-header > .tl-ghost { border-radius: 0; }
.tl-reader-header > .tl-ghost + .tl-ghost { box-shadow: inset 1px 0 0 rgba(255, 255, 255, 0.14); }
.tl-composer { padding-top: 10px; box-shadow: inset 0 1px 0 rgba(240, 214, 138, 0.35); background: rgba(14, 16, 18, 0.9); }
.tl-composer-box { border-radius: 0; background: rgba(255, 255, 255, 0.05); }
.tl-send:not(:disabled) { border-radius: 0; width: 42px; height: 42px; clip-path: polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%); }
.tl-swipe, .tl-continue-writing { border-radius: 0; clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%); }
${UNCLIP_FOCUS}`,

    mountain: `${SHELF_LIST}
.tl-chat::after { content: ""; position: fixed; left: 0; right: 0; bottom: 0; z-index: -1; height: calc(190px + env(safe-area-inset-bottom)); pointer-events: none; background: linear-gradient(180deg, rgba(234, 238, 234, 0), rgba(234, 238, 234, 0.55) 55%, rgba(234, 238, 234, 0.7)); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); -webkit-mask-image: linear-gradient(180deg, transparent, #000 60%); mask-image: linear-gradient(180deg, transparent, #000 60%); }
.tl-character { background: transparent; box-shadow: none; border-bottom: 1px solid var(--tl-border); }
${dockCss('border-radius: 999px; background: rgba(255, 255, 255, 0.55); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.9), 0 8px 30px rgba(44, 51, 48, 0.12);',
        'background: transparent; box-shadow: none;')}
.tl-library > .tl-header > .tl-me-button { background: rgba(79, 107, 95, 0.12); }
${tabChipsCss('#4f6b5f')}
.tl-button { background: transparent; box-shadow: inset 0 0 0 1px rgba(44, 51, 48, 0.25); }
:is(.tl-button[aria-pressed="true"], .tl-primary) { color: #f2f4f1; background: #4f6b5f; box-shadow: none; }
${capsuleCss('background: rgba(255, 255, 255, 0.55); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);')}
.tl-composer-box { border-radius: 22px; background: transparent; box-shadow: inset 0 -1px 0 rgba(44, 51, 48, 0.35); }
.tl-send:not(:disabled) { background: transparent; color: #4f6b5f; box-shadow: inset 0 0 0 1px #4f6b5f; }
.tl-swipe { background: transparent; box-shadow: inset 0 0 0 1px rgba(44, 51, 48, 0.2); }`,

    wisteria: `.tl-grid { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); }
.tl-library > .tl-header { position: relative; }
:is(.tl-library > .tl-header, .tl-chapter-opening)::before { content: ""; position: absolute; z-index: -1; inset: -8px -16px; pointer-events: none; background: rgba(252, 251, 254, 0.38); backdrop-filter: blur(9px) saturate(1.1); -webkit-backdrop-filter: blur(9px) saturate(1.1); -webkit-mask-image: radial-gradient(closest-side, #000 72%, transparent); mask-image: radial-gradient(closest-side, #000 72%, transparent); }
.tl-library > .tl-header::before { inset: calc(-1 * max(10px, env(safe-area-inset-top))) -16px -18px; -webkit-mask-image: linear-gradient(180deg, #000 70%, transparent); mask-image: linear-gradient(180deg, #000 70%, transparent); }
.tl-chapter-opening { position: relative; }
:root { --tl-header-bg: rgba(252, 251, 254, 0.55); }
.tl-character { background: transparent; box-shadow: none; }
.tl-character .tl-avatar { aspect-ratio: 1; border-radius: 50%; box-shadow: 0 0 0 3px #fff, 0 0 0 5px rgba(155, 135, 217, 0.45), 0 8px 18px rgba(103, 80, 164, 0.18); }
.tl-book-menu { top: 0; right: 0; }
.tl-library > .tl-header > .tl-button { border-radius: 999px 999px 999px 6px; background: linear-gradient(135deg, rgba(155, 135, 217, 0.2), rgba(163, 196, 106, 0.2)), rgba(255, 255, 255, 0.4); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.6); }
.tl-button { background: rgba(155, 135, 217, 0.14); }
:is(.tl-button[aria-pressed="true"], .tl-primary) { background: linear-gradient(135deg, #6750a4, #577f2c); color: #fff; }
.tl-library .tl-chip { border-radius: 999px 999px 999px 4px; background: rgba(155, 135, 217, 0.12); }
.tl-library .tl-chip[aria-pressed="true"] { background: #6750a4; color: #fff; }
.tl-search { border-radius: 999px; box-shadow: inset 0 0 0 1px rgba(155, 135, 217, 0.35); }
.tl-reader-header > .tl-ghost { border-radius: 50%; background: rgba(155, 135, 217, 0.1); margin-inline: 2px; }
.tl-composer-box { border-radius: 26px; box-shadow: inset 0 0 0 1px rgba(155, 135, 217, 0.35), 0 6px 20px rgba(103, 80, 164, 0.12); }
.tl-send:not(:disabled) { width: 42px; height: 42px; background: linear-gradient(135deg, #6750a4, #577f2c); color: #fff; }
.tl-swipe { background: rgba(155, 135, 217, 0.12); }`,

};

// Pictures behind the illustrated themes, from the extension's skins/ folder. Each is veiled in the theme's own colour
// so text stays readable; the last layer takes the page's "center / cover no-repeat".
// The folder is wherever this extension was installed (app/ sits next to skins/). Resolved here: a relative url()
// in a custom property would be read against whichever stylesheet uses it.
const SKINS = (() => { try { return new URL('../skins/', document.baseURI).href; } catch { return '../skins/'; } })();
const SKIN = name => `url("${SKINS}${name}.webp")`;
const veil = (color, top, bottom = top) => `linear-gradient(180deg, rgba(${color}, ${top}), rgba(${color}, ${bottom}))`;
/** Orbits, a constellation and one trail, drawn faint: the sky behind 星轨, the way event pages layer line art on dark. */
const STARCHART = svg(`width='640' height='640' viewBox='0 0 640 640' fill='none'><defs><linearGradient id='t' x1='0' y1='1' x2='1' y2='0'><stop offset='0' stop-color='#e8c27a' stop-opacity='0'/><stop offset='1' stop-color='#f6dca6' stop-opacity='.3'/></linearGradient></defs><g stroke='#e8c27a' stroke-opacity='.09'><circle cx='420' cy='220' r='110'/><circle cx='420' cy='220' r='180' stroke-dasharray='2 6'/><circle cx='420' cy='220' r='260'/><circle cx='420' cy='220' r='350' stroke-opacity='.08'/></g><path d='M110 480 L310 330' stroke='url(#t)' stroke-width='1.4' stroke-linecap='round'/><path d='M150 140 L232 112 L300 170 L268 252 L190 236' stroke='#ffffff' stroke-opacity='.09'/><g fill='#ffffff'><circle cx='150' cy='140' r='2' fill-opacity='.7'/><circle cx='232' cy='112' r='1.6' fill-opacity='.6'/><circle cx='300' cy='170' r='2.2' fill-opacity='.8'/><circle cx='268' cy='252' r='1.6' fill-opacity='.6'/><circle cx='190' cy='236' r='1.4' fill-opacity='.5'/><circle cx='520' cy='420' r='1.2' fill-opacity='.4'/><circle cx='70' cy='320' r='1' fill-opacity='.4'/><circle cx='580' cy='90' r='1.4' fill-opacity='.5'/><circle cx='380' cy='520' r='1' fill-opacity='.35'/></g><circle cx='420' cy='220' r='3' fill='#f6dca6' fill-opacity='.7'/>`);
const ART = {
    star: `:root { --tl-bg-image: ${STARCHART} right -140px top -110px / 640px no-repeat, radial-gradient(70vmax 50vmax at 85% 8%, rgba(126, 116, 196, 0.2), transparent 70%), radial-gradient(60vmax 40vmax at 0% 100%, rgba(232, 194, 122, 0.08), transparent 70%), repeating-linear-gradient(115deg, rgba(255, 255, 255, 0.018) 0 1px, transparent 1px 9px), linear-gradient(180deg, #0c0e22, #141634 60%, #0f1028); --tl-bg-size: cover; }`,
    gilt: `:root { --tl-bg-image: ${veil('239, 232, 218', 0.5)}, ${SKIN('gilt')}; --tl-bg-size: cover; }`,
    echo: `:root { --tl-bg-image: ${veil('14, 16, 18', 0.5, 0.72)}, ${SKIN('echo')}; --tl-bg-size: cover; }`,
    // The fade and the multiply are baked into the picture (black, alpha = fade × darkness): iPhone ignored the mask here.
    // Where the screen is wide enough that cover crops the picture's top, a mask fades the cut edge instead.
    mountain: `:root { --tl-bg-image: linear-gradient(180deg, #f2f4f1, #e6ebe7); --tl-bg-size: cover; }
body::after { content: ""; position: fixed; left: 0; right: 0; bottom: 0; z-index: -1; height: min(56vw, 62vh); pointer-events: none; background: ${SKIN('mountain-fade')} center bottom / cover no-repeat; }
@media (min-aspect-ratio: 10/9) { body::after { -webkit-mask-image: linear-gradient(180deg, transparent, #000 45%); mask-image: linear-gradient(180deg, transparent, #000 45%); } }`,
    wisteria: `:root { --tl-bg-image: ${SKIN('wisteria')} center top / min(100%, 720px) auto no-repeat, radial-gradient(60vmax 40vmax at 0% 0%, rgba(155, 135, 217, 0.12), transparent 70%), radial-gradient(50vmax 40vmax at 100% 100%, rgba(163, 196, 106, 0.14), transparent 70%); --tl-bg-size: cover; }`,
};

// Built-in themes. Only the five main colours are chosen by hand; everything else is derived (see themeVars).
// The illustrated ones also carry their own CSS, written against the selectors THEMING.md promises.
export const PRESETS = {
    system: { name: '跟随系统' },
    paper: { name: '纸色', bg: '#f5efe3', text: '#2b2620', accent: '#8b5e34', quote: '#7a4a1e', em: '#6f6558' },
    white: { name: '白色', bg: '#ffffff', text: '#222222', accent: '#3a6ea5', quote: '#2f5d8a', em: '#5f6670' },
    green: { name: '护眼', bg: '#dfeacf', text: '#22301f', accent: '#4f7a3a', quote: '#3f6b2a', em: '#56664f' },
    sepia: { name: '羊皮', bg: '#e8d9bb', text: '#3b2e1e', accent: '#8a5a2b', quote: '#7b3f12', em: '#6a5940', font: 'serif' },
    rose: { name: '樱粉', bg: '#f8ebeb', text: '#3a2a2c', accent: '#b45a6a', quote: '#9c4152', em: '#7b6265' },
    night: { name: '夜间', bg: '#171513', text: '#d9d2c5', accent: '#d0a676', quote: '#e3b98a', em: '#aca291' },
    ink: { name: '墨蓝', bg: '#18202b', text: '#cfd6df', accent: '#86aed6', quote: '#a9c8e6', em: '#97a3b1' },
    star: { name: '星轨', bg: '#0d0f24', text: '#f1f2f7', accent: '#e8c27a', quote: '#f6dca6', em: '#b6b9d3', css: starCss() + '\n' + LAYOUTS.star + '\n' + PLAIN_CLOSE + '\n' + PENDING + '\n' + ART.star },
    gilt: { name: '金纹', bg: '#efe8da', text: '#3b4255', accent: '#8a6532', quote: '#2f5f86', em: '#6b6152', css: giltCss() + '\n' + LAYOUTS.gilt + '\n' + PLAIN_CLOSE + '\n' + PENDING + '\n' + ART.gilt },
    echo: { name: '回声', bg: '#0e1012', text: '#e9eaea', accent: '#f0d68a', quote: '#f5e3ad', em: '#9aa0a4', css: echoCss() + '\n' + LAYOUTS.echo + '\n' + PLAIN_CLOSE + '\n' + PENDING + '\n' + ART.echo },
    mountain: { name: '远山', bg: '#eaeeea', text: '#2c3330', accent: '#4f6b5f', quote: '#3d5a50', em: '#5c6862', font: 'serif', css: mountainCss() + '\n' + LAYOUTS.mountain + '\n' + PLAIN_CLOSE + '\n' + PENDING + '\n' + ART.mountain },
    wisteria: { name: '紫藤', bg: '#fcfbfe', text: '#2e2b3a', accent: '#5d8a2a', quote: '#46701a', em: '#6750a4', css: wisteriaCss() + '\n' + LAYOUTS.wisteria + '\n' + PLAIN_CLOSE + '\n' + PENDING + '\n' + ART.wisteria },
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
        'text-muted': theme.css ? readableMix(mix(theme.text, theme.bg, 0.28), theme.bg, theme.text, 6) : readableMix(mix(theme.text, theme.bg, 0.42), theme.bg, theme.text),
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
        // An added font may arrive after the theme or never (a shared theme); until it is there the theme has no font of its own.
        font: FONTS[theme.font] || /^custom:[a-z0-9]+$/.test(theme.font ?? '') ? theme.font : 'default',
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

export function cachedFonts() {
    try {
        const list = JSON.parse(stored('fonts') ?? '[]');
        return Array.isArray(list) ? list.map(cleanFont).filter(Boolean) : [];
    } catch {
        return [];
    }
}

/** The fixed fonts and the added ones, as the font choices show them. */
export function fontOptions(fonts = cachedFonts()) {
    return { ...FONTS, ...Object.fromEntries(fonts.map(font => [fontKey(font), { label: font.name, value: fontValue(font) }])) };
}

function clean(reading, themes, fonts = cachedFonts()) {
    const r = { ...DEFAULT_READING, ...(reading ?? {}) };
    if (!findTheme(r.theme, themes)) r.theme = DEFAULT_READING.theme;
    for (const [key, options] of [['font', fontOptions(fonts)], ['lineHeight', LINE_HEIGHTS], ['width', WIDTHS], ['paragraph', PARAGRAPHS], ['margin', MARGINS]]) {
        if (!options[r[key]]) r[key] = DEFAULT_READING[key];
    }
    r.indent = r.indent !== false;
    r.justify = r.justify !== false;
    const size = Math.round(Number(r.fontSize));
    r.fontSize = Number.isFinite(size) ? Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, size)) : FONT_SIZE.default;
    return r;
}

export function readingCss(reading, themes = cachedThemes(), fonts = cachedFonts()) {
    const r = clean(reading, themes, fonts);
    const theme = findTheme(r.theme, themes) ?? {};
    // The reading setting's font wins; a theme's own font applies while the reader keeps "default".
    const options = fontOptions(fonts);
    const font = options[r.font].value ?? options[theme.font]?.value;
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

/** Declares the added font in use, if any: the reading setting's, or else the theme's. */
export function fontCss(reading, themes = cachedThemes(), fonts = cachedFonts()) {
    const r = clean(reading, themes, fonts);
    const key = r.font === 'default' ? findTheme(r.theme, themes)?.font : r.font;
    const font = fonts.find(f => fontKey(f) === key);
    return font ? fontFaceCss(font) : '';
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
    storeBootLook();
}

/** What index.html applies before any code loads, compiled by this build so a changed theme reaches the loading screen. */
function storeBootLook() {
    const account = appearanceAccount;
    if (account) storage(s => {
        s.setItem(appearanceKey(account, 'look-css'), readingCss(cachedReading()));
        s.setItem(appearanceKey(account, 'font-css'), fontCss(cachedReading()));
    });
}

/**
 * Replaces the stored look with this build's as soon as the code runs, for the account that used this browser last
 * (the one index.html already showed). /users/me can take seconds on a phone, and the loading screen is up all that time.
 */
export function refreshBootLook() {
    const owner = storage(s => s.getItem(DISPLAY_OWNER_KEY));
    if (!owner || appearanceAccount) return;
    appearanceAccount = owner;
    try {
        if (stored('reading') !== null) {
            applyReading(cachedReading());
            storeBootLook();
        }
    } finally {
        appearanceAccount = null;
    }
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
    // Only rewritten when it changes: redeclaring a font makes the text flash on every setting.
    const faces = fontCss(reading, themes);
    if (faces || document.getElementById('tl-font-css')) {
        const style = styleElement('tl-font-css', 'tl-reading-css');
        if (style.textContent !== faces) style.textContent = faces;
    }
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

function cache({ reading, customCss, themes, fonts }, updated) {
    const account = appearanceAccount;
    if (!account) return;
    storage(s => {
        const put = (part, value) => s.setItem(appearanceKey(account, part), value);
        if (themes) put('themes', JSON.stringify(themes));
        if (fonts) put('fonts', JSON.stringify(fonts));
        const list = themes ?? cachedThemes();
        const r = clean(reading ?? cachedReading(), list);
        put('reading', JSON.stringify(r));
        put('look-css', readingCss(r, list));
        put('font-css', fontCss(r, list));
        if (typeof customCss === 'string') put('custom-css', customCss);
        put('updated', String(updated));
    });
}

function pushToAccount(bridge, updated) {
    if (!bridge || !appearanceAccount) return;
    const settings = bridge.extensionSettings();
    settings.tavernLite = { ...(settings.tavernLite ?? {}), customCss: cachedCss(), reading: cachedReading(), themes: cachedThemes(), fonts: cachedFonts(), themeUpdated: updated };
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

/** Adds a font to the list. Null when it cannot be used safely in a stylesheet. */
export function saveFont(font, bridge) {
    const cleaned = cleanFont(font);
    if (cleaned) {
        const fonts = cachedFonts();
        const existing = fonts.find(f => sameFont(f, cleaned));
        if (existing) return existing;
        const others = fonts.filter(f => f.id !== cleaned.id);
        if (others.length >= MAX_FONTS) throw new Error(`最多 ${MAX_FONTS} 个字体，先删掉不用的`);
        saveAppearance({ fonts: [...others, cleaned] }, bridge);
    }
    return cleaned;
}

export function deleteFont(id, bridge) {
    const fonts = cachedFonts().filter(f => f.id !== id);
    const reading = cachedReading();
    saveAppearance({ fonts, reading: reading.font === `custom:${id}` ? { ...reading, font: DEFAULT_READING.font } : reading }, bridge);
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
        const fonts = Array.isArray(remote.fonts) ? remote.fonts.map(cleanFont).filter(Boolean) : undefined;
        cache({
            themes,
            fonts,
            reading: remote.reading ? clean(remote.reading, themes ?? cachedThemes(), fonts ?? cachedFonts()) : undefined,
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
