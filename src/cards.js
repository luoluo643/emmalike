// What extensions put into messages, shown in the shell:
// - Frontend cards (pages Tavern Helper makes from a message's HTML code block) run again here, in their own frame,
//   with the globals Tavern Helper's card pages take from their parent window forwarded to the full app. The card's
//   own buttons, variables and slash commands therefore act on the real chat.
// - Panels other extensions add under a message (Horae's status bar, for example) are mirrored in an isolated frame;
//   taps and input in the mirror are replayed on the real panel in the full app, which then updates the mirror.
import * as engine from './engine.js';

// What Tavern Helper's card pages read from window.parent (its iframe predefine script and helpers).
const FORWARDED = ['_', 'EjsTemplate', 'TavernHelper', 'YAML', 'showdown', 'z', 'SillyTavern', 'Mvu', '$', 'jQuery'];
const LAZY_MARGIN = '800px 0px';
let notify = () => { };
let serial = 0;

export function installCardHost(notifyUser) {
    notify = notifyUser;
    if (window.__tavernLiteCards) return;
    window.__tavernLiteCards = true;
    for (const name of FORWARDED) {
        if (name in window) continue;
        Object.defineProperty(window, name, { configurable: true, get: () => engine.engineWindow()?.[name] });
    }
    // Cards report with toastr; the full app's toasts are off screen, so show them as the shell's notices.
    if (!('toastr' in window)) {
        const show = level => (message, title) => {
            notify([title, message].filter(Boolean).map(x => String(x).replace(/<[^>]*>/g, '')).join('：'), level);
        };
        window.toastr = { success: show('info'), info: show('info'), warning: show('warning'), error: show('error'), clear() { }, remove() { }, options: {} };
    }
    // Tavern Helper sizes "100vh" in cards from the parent's height.
    addEventListener('resize', () => {
        for (const frame of document.querySelectorAll('iframe.tl-card-frame')) {
            frame.contentWindow?.postMessage({ type: 'TH_UPDATE_VIEWPORT_HEIGHT' }, '*');
        }
    });
}

// Frames are created when their message comes near the screen; long chats would otherwise load every one at once.
const observers = new WeakMap();
const starters = new WeakMap();

function whenNear(element, start) {
    const root = element.closest('.tl-messages');
    if (!root || typeof IntersectionObserver !== 'function') return start();
    let observer = observers.get(root);
    if (!observer) {
        observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                observer.unobserve(entry.target);
                starters.get(entry.target)?.();
                starters.delete(entry.target);
            }
        }, { root, rootMargin: LAZY_MARGIN });
        observers.set(root, observer);
    }
    starters.set(element, start);
    observer.observe(element);
}

/** Runs the frontend cards found in a message body (slots the bridge left in place of the full app's frames). */
export function mountCards(body) {
    for (const slot of body.querySelectorAll('.tl-frontend-card:not([data-mounted])')) {
        slot.dataset.mounted = 'true';
        whenNear(slot, () => startCard(slot));
    }
}

function startCard(slot) {
    if (!slot.isConnected) return;
    const source = engine.getBridge()?.cardSource(slot.dataset.card);
    if (!source) {
        slot.className = 'tl-card-placeholder';
        slot.textContent = '［前端卡片：准备好后显示］';
        return;
    }
    const frame = document.createElement('iframe');
    frame.className = 'tl-card-frame';
    // Tavern Helper finds the card's message from the frame's name; the suffix keeps it apart from the full app's
    // own frame for the same card (its listeners are kept per frame name).
    frame.id = frame.name = `${slot.dataset.frame}_${++serial}`;
    frame.title = '前端卡片';
    frame.srcdoc = source;
    slot.append(frame);
}

// Panel mirrors.
const mirrors = new WeakMap();
const escapeAttribute = text => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const FIELDS = /^(INPUT|TEXTAREA|SELECT)$/;

/** Shows (or updates) the mirror of a message's extension panels in `slot`. */
export function mirrorPanels(slot, index, html) {
    let mirror = mirrors.get(slot);
    if (!mirror) {
        mirror = { index, html, shown: null, frame: null, started: false };
        mirrors.set(slot, mirror);
        whenNear(slot, () => createMirror(slot, mirror));
        return;
    }
    mirror.index = index;
    mirror.html = html;
    if (!mirror.started) whenNear(slot, () => createMirror(slot, mirror));
    showPanels(mirror);
}

function createMirror(slot, mirror) {
    const styles = engine.getBridge()?.panelStyles();
    if (!styles || !slot.isConnected || mirror.started) return;
    mirror.started = true;
    const frame = document.createElement('iframe');
    frame.className = 'tl-panel-frame';
    frame.title = '扩展面板';
    const css = styles.css.replace(/<\/style/gi, '<\\/style');
    frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${styles.links.map(href => `<link rel="stylesheet" href="${escapeAttribute(href)}">`).join('\n')}
<style>${css}</style>
<style>:root{${styles.vars.replace(/<\/style/gi, '')}}
html,body{margin:0!important;padding:0!important;height:auto!important;min-height:0!important;overflow:hidden!important;background:transparent!important}
.mes,.mes_block{display:block!important;margin:0!important;padding:0!important;background:none!important;border:0!important}
body{color:var(--SmartThemeBodyColor,#dcdcd2);font-family:var(--mainFontFamily,system-ui,sans-serif)}
#tl-panels{display:flow-root!important;background:var(--SmartThemeBlurTintColor,#171717e6)!important;border-radius:10px;overflow:hidden}</style>
</head><body class="${escapeAttribute(styles.bodyClass)}"><div class="mes"><div class="mes_block" id="tl-panels"></div></div></body></html>`;
    frame.addEventListener('load', () => {
        const doc = frame.contentDocument;
        if (!doc?.body) return;
        const fit = () => { frame.style.height = `${doc.getElementById('tl-panels')?.scrollHeight ?? 0}px`; };
        new frame.contentWindow.ResizeObserver(fit).observe(doc.body);
        doc.addEventListener('click', event => forward(mirror, event, 'click'), true);
        doc.addEventListener('input', event => forward(mirror, event, 'input'), true);
        doc.addEventListener('change', event => forward(mirror, event, 'change'), true);
        // Updates wait while the user is typing in the mirror, so the field keeps its cursor.
        doc.addEventListener('focusout', () => setTimeout(() => showPanels(mirror)), true);
        mirror.frame = frame;
        showPanels(mirror);
        fit();
    }, { once: true });
    slot.append(frame);
}

function showPanels(mirror) {
    const doc = mirror.frame?.contentDocument;
    const box = doc?.getElementById('tl-panels');
    if (!box || mirror.shown === mirror.html) return;
    if (doc.activeElement && FIELDS.test(doc.activeElement.tagName)) return;
    box.innerHTML = mirror.html;
    mirror.shown = mirror.html;
}

function forward(mirror, event, kind) {
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    const root = target?.closest('[data-tl-panel]');
    if (!root) return;
    const toggle = target.type === 'checkbox' || target.type === 'radio';
    if (kind === 'click' && FIELDS.test(target.tagName) && !toggle) return;
    if (kind === 'change' && toggle) return;
    if (kind === 'click' && !toggle) event.preventDefault();
    const path = [];
    for (let element = target; element !== root; element = element.parentElement) {
        path.unshift([...element.parentElement.children].indexOf(element));
    }
    const data = { tag: target.tagName };
    if (kind !== 'click') data.value = target.value;
    const bridge = engine.getBridge();
    if (!bridge) {
        engine.requestEngine('action');
        notify('原版界面还在准备（顶上有进度），好了再点一次', 'info');
        return;
    }
    if (!bridge.panelEvent(mirror.index, Number(root.dataset.tlPanel), path, kind, data)) {
        notify('这个面板刚刚更新过，请再点一次', 'info');
    }
}
