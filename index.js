import * as st from '/script.js';
import * as openai from '/scripts/openai.js';
import * as groups from '/scripts/group-chats.js';
import { installNativeSettleBootstrap } from './bridge-native-bootstrap.js';
import { installLineContext } from './bridge-line-context.js';
import { isTauriTavern, TT_SHELL_MARK } from './src/tt-host.js';

const appUrl = new URL('./app/', import.meta.url).href;

function runningAsEngine() {
    try {
        return window.frameElement?.dataset?.tavernLite === 'engine';
    } catch {
        return false;
    }
}

function addMenuEntry(open) {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('tavern-lite-open')) return;
    const item = document.createElement('div');
    item.id = 'tavern-lite-open';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-bolt extensionsMenuExtensionButton"></div><span>打开轻酒馆</span>';
    item.addEventListener('click', open);
    menu.append(item);
}

// TT 酒馆 (see src/tt-host.js): the shell is laid over this page in a frame, and this page is its full app. It opens
// only from the menu; leaving it (its 返回 on the shelf, or the phone's back there) hides it and keeps it as it was.
const SHELL_ID = 'tavern-lite-shell';

function ttShell() {
    return document.getElementById(SHELL_ID);
}

function ttShellShown() {
    const frame = ttShell();
    return !!frame && !frame.hidden;
}

function hideTtShell() {
    const frame = ttShell();
    if (!frame || frame.hidden) return;
    frame.hidden = true;
    try { frame.contentWindow?.dispatchEvent(new Event('tl-tt-hidden')); } catch { /* the shell is between pages */ }
}

function openTtShell() {
    let frame = ttShell();
    if (!frame) {
        frame = document.createElement('iframe');
        frame.id = SHELL_ID;
        frame.title = '轻酒馆';
        frame.dataset.tavernLite = TT_SHELL_MARK;
        frame.setAttribute('allowtransparency', 'true');
        // Over everything TT draws, its own sheets included; the shell asks for the page when it needs it shown.
        frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;margin:0;padding:0;z-index:2147483000;background:transparent;';
        // The address names the page itself: TT serves no folder index.
        frame.src = new URL('index.html', appUrl).href;
        document.body.append(frame);
    }
    frame.hidden = false;
    try { frame.contentWindow?.dispatchEvent(new Event('tl-tt-shown')); } catch { /* still loading: it starts shown */ }
}

// The phone's back button and edge gesture: the shell answers it while it is shown (its sheets, pages, then leaving
// it); TT's own handling runs otherwise.
function installTtBack() {
    const key = '__TAURITAVERN_HANDLE_BACK__';
    const original = window[key];
    if (typeof original !== 'function' || original.__tavernLite) return;
    const handle = function (...args) {
        if (ttShellShown()) {
            let taken = false;
            try { taken = !!ttShell().contentWindow?.tavernLiteBack?.(); } catch { /* the shell is between pages */ }
            if (!taken) hideTtShell();
            return true;
        }
        return original.apply(this, args);
    };
    handle.__tavernLite = true;
    window[key] = handle;
}

// What each of a story's lines sends to the model, in the engine and in the full app alike (manifest generate_interceptor).
installLineContext(window);

// Inside the lite shell's hidden engine page, leaving the full app would detach the shell from it.
if (runningAsEngine()) {
    // Native awaits this module before character inventory and auto-load-chat.
    // Do not defer this installation to APP_READY or jQuery ready.
    installNativeSettleBootstrap({ window, document, st, openai, groups });
} else if (isTauriTavern(window)) {
    // TT activates extensions after the app is ready, so the observer starts late (see bridge-native-bootstrap.js).
    installNativeSettleBootstrap({ window, document, st, openai, groups, late: true });
    const { eventSource, eventTypes } = SillyTavern.getContext();
    window.TavernLiteTt = Object.freeze({ show: openTtShell, hide: hideTtShell, shown: ttShellShown });
    addMenuEntry(openTtShell);
    eventSource.on(eventTypes.APP_READY, () => addMenuEntry(openTtShell));
    installTtBack();
} else {
    const { eventSource, eventTypes } = SillyTavern.getContext();
    const open = () => { location.href = appUrl; };
    addMenuEntry(open);
    eventSource.on(eventTypes.APP_READY, () => addMenuEntry(open));
}
