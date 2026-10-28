// Test fixture: what extensions and scripts add to the full app, the way real ones do —
// - a panel under each character message (Horae's status bar): own stylesheet, click and input handlers, and a
//   button that opens a window on the page;
// - a button in the bar above the input (#qr--bar, shared by Quick Replies and Tavern Helper script buttons);
// - an item in the extensions menu (the wand);
// - a button in each message's button row;
// - for characters whose name starts with "M6", a floating ball on the page itself (like a Live2D figure).
const { eventSource, eventTypes } = SillyTavern.getContext();

function addPanel(id) {
    const message = document.querySelector(`#chat .mes[mesid="${id}"]`);
    if (!message) return;
    if (!message.querySelector('.tltest_mes_button')) {
        const button = document.createElement('div');
        button.className = 'mes_button tltest_mes_button fa-solid fa-flask';
        button.title = '测试消息按钮';
        button.addEventListener('click', () => { window.__tltestMesButton = Number(message.getAttribute('mesid')); });
        message.querySelector('.extraMesButtons')?.append(button);
    }
    if (message.getAttribute('is_user') === 'true' || message.querySelector('.tltest-panel')) return;
    message.querySelector('.mes_text')?.insertAdjacentHTML('afterend', `
        <div class="tltest-panel">
            <div class="tltest-toggle"><i class="fa-solid fa-clock"></i> 状态</div>
            <div class="tltest-content" style="display: none;">
                第一天 · 黄昏 <input class="tltest-input" aria-label="备注" value="">
                <button class="tltest-open">详情</button>
            </div>
        </div>`);
    const panel = message.querySelector('.tltest-panel');
    panel.querySelector('.tltest-toggle').addEventListener('click', () => {
        const content = panel.querySelector('.tltest-content');
        content.style.display = content.style.display === 'none' ? 'block' : 'none';
    });
    panel.querySelector('.tltest-input').addEventListener('input', event => { window.__tltestInput = event.target.value; });
    panel.querySelector('.tltest-open').addEventListener('click', () => {
        document.body.insertAdjacentHTML('beforeend', '<div class="tltest-window" style="position: fixed; inset: 20%; background: #fff;">详情窗口</div>');
    });
}

function addInputButton() {
    const form = document.getElementById('send_form');
    if (!form || form.querySelector('.tltest-input-button')) return;
    let bar = [...form.querySelectorAll('div')].find(div => div.id === 'qr--bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'qr--bar';
        bar.className = 'flex-container flexGap5';
        form.prepend(bar);
    }
    let buttons = bar.querySelector('.qr--buttons');
    if (!buttons) {
        buttons = document.createElement('div');
        buttons.className = 'qr--buttons';
        bar.append(buttons);
    }
    const button = document.createElement('div');
    button.className = 'qr--button menu_button interactable tltest-input-button';
    button.textContent = '测试快捷按钮';
    buttons.append(button);
}

// Delegated: Quick Replies rebuilds its bar and the button with it.
document.addEventListener('click', event => {
    if (event.target.closest?.('.tltest-input-button')) window.__tltestInputButton = (window.__tltestInputButton ?? 0) + 1;
});

function addMenuItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('tltest-menu-item')) return;
    const item = document.createElement('div');
    item.id = 'tltest-menu-item';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.innerHTML = '<div class="fa-solid fa-flask extensionsMenuExtensionButton"></div><span>测试扩展功能</span>';
    item.addEventListener('click', () => { window.__tltestMenu = (window.__tltestMenu ?? 0) + 1; });
    menu.append(item);
}

function updateFloat() {
    const c = SillyTavern.getContext();
    const name = c.characters?.[c.characterId]?.name ?? '';
    const existing = document.getElementById('tltest-float');
    if (!name.startsWith('M6')) {
        existing?.remove();
        return;
    }
    if (existing) return;
    const ball = document.createElement('div');
    ball.id = 'tltest-float';
    ball.textContent = '球';
    ball.style.cssText = 'position: fixed; right: 12px; top: 200px; width: 56px; height: 56px; border-radius: 50%; background: #c63; color: #fff; display: grid; place-items: center; z-index: 9990;';
    ball.addEventListener('click', () => { window.__tltestFloat = (window.__tltestFloat ?? 0) + 1; ball.textContent = String(window.__tltestFloat); });
    document.body.append(ball);
}

document.addEventListener('pointerdown', event => { window.__tltestPointer = [Math.round(event.clientX), Math.round(event.clientY)]; }, true);

const addAll = () => {
    document.querySelectorAll('#chat .mes').forEach(m => addPanel(m.getAttribute('mesid')));
    addInputButton();
    addMenuItem();
    updateFloat();
};
eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, addPanel);
eventSource.on(eventTypes.USER_MESSAGE_RENDERED, addPanel);
eventSource.on(eventTypes.CHAT_CHANGED, () => setTimeout(addAll, 300));
eventSource.on(eventTypes.APP_READY, addAll);
