import * as st from '/script.js';
import * as openai from '/scripts/openai.js';
import * as groups from '/scripts/group-chats.js';
import { installNativeSettleBootstrap } from './bridge-native-bootstrap.js';

const appUrl = new URL('./app/', import.meta.url).href;

function runningAsEngine() {
    try {
        return window.frameElement?.dataset?.tavernLite === 'engine';
    } catch {
        return false;
    }
}

function addMenuEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('tavern-lite-open')) return;
    const item = document.createElement('div');
    item.id = 'tavern-lite-open';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-bolt extensionsMenuExtensionButton"></div><span>打开轻酒馆</span>';
    item.addEventListener('click', () => { location.href = appUrl; });
    menu.append(item);
}

// Inside the lite shell's hidden engine page, leaving the full app would detach the shell from it.
if (runningAsEngine()) {
    // Native awaits this module before character inventory and auto-load-chat.
    // Do not defer this installation to APP_READY or jQuery ready.
    installNativeSettleBootstrap({ window, document, st, openai, groups });
} else {
    const { eventSource, eventTypes } = SillyTavern.getContext();
    addMenuEntry();
    eventSource.on(eventTypes.APP_READY, addMenuEntry);
}
