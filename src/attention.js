// While a reply is being written: keep the screen on (a phone that locks itself may pause the page and cut the reply
// off), and when it is done while the user is somewhere else, say so in the tab title and, if they asked for it, in a
// notification. Notifications need a service worker on phones; notify-sw.js only shows them and opens the app when
// one is tapped (no caching, it handles no requests).
import * as engine from './engine.js';

const KEY = 'tavern-lite:remind';
let lock = null;
let wasGenerating = false;
let unseen = false;
let baseTitle = document.title;
let registration = null;

async function keepAwake(on) {
    if (!('wakeLock' in navigator)) return;
    try {
        if (on && !lock && document.visibilityState === 'visible') {
            lock = await navigator.wakeLock.request('screen');
            lock.addEventListener('release', () => { lock = null; });
            // The reply may have finished while the lock was being granted.
            if (!engine.isGenerating()) await keepAwake(false);
        } else if (!on && lock) {
            const held = lock;
            lock = null;
            await held.release();
        }
    } catch {
        lock = null;
    }
}

export function reminderSupported() {
    return isSecureContext && 'Notification' in window && 'serviceWorker' in navigator;
}

export function reminderEnabled() {
    try {
        return reminderSupported() && localStorage.getItem(KEY) === '1' && Notification.permission === 'granted';
    } catch {
        return false;
    }
}

function worker() {
    registration ??= navigator.serviceWorker.register('./notify-sw.js', { scope: './' }).then(() => navigator.serviceWorker.ready);
    return registration;
}

/** Turns the reminder on (asking the browser for permission) or off. */
export async function setReminder(on) {
    if (!on) {
        try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
        return { enabled: false };
    }
    const permission = await Notification.requestPermission().catch(() => 'denied');
    if (permission !== 'granted') {
        return { enabled: false, message: '通知被关掉了：请在手机的“设置 → 应用 → 浏览器 → 通知”和浏览器的网站设置里都允许，再回来打开' };
    }
    try {
        await worker();
        localStorage.setItem(KEY, '1');
    } catch {
        return { enabled: false, message: '这个浏览器不能发通知' };
    }
    return { enabled: true, message: '好了，回复写完时会提醒你' };
}

async function remind() {
    if (!reminderEnabled()) return;
    const name = engine.getBridge()?.currentChat?.()?.name;
    try {
        const sw = await worker();
        await sw.showNotification('轻酒馆', {
            body: name ? `${name}的回复写好了` : '回复写好了',
            tag: 'tavern-lite-reply',
            renotify: true,
            icon: './icon-192.png',
            data: { url: location.href },
        });
    } catch { /* not allowed any more */ }
}

// Installing as an app: Chrome offers it with its own banner on every visit; the offer is kept for "我的" instead.
let installOffer = null;
addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installOffer = event;
    dispatchEvent(new Event('tl-install-offer'));
});
addEventListener('appinstalled', () => { installOffer = null; });

export function installState() {
    if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return 'installed';
    if (installOffer) return 'offer';
    if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return 'ios';
    return 'none';
}

/** Shows the browser's own install dialog; true when the user accepted. */
export async function installApp() {
    const offer = installOffer;
    if (!offer) return false;
    offer.prompt();
    const { outcome } = await offer.userChoice.catch(() => ({ outcome: 'dismissed' }));
    if (outcome === 'accepted') installOffer = null;
    return outcome === 'accepted';
}

export function installAttention() {
    engine.onEngine((type, generating) => {
        if (type !== 'generating') return;
        keepAwake(generating);
        if (generating) {
            wasGenerating = true;
            return;
        }
        if (!wasGenerating) return;
        wasGenerating = false;
        if (document.visibilityState !== 'hidden') return;
        if (!unseen) baseTitle = document.title;
        unseen = true;
        document.title = `（回复写好了）${baseTitle}`;
        remind();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (unseen) {
            unseen = false;
            document.title = baseTitle;
        }
        // The browser drops the lock when the page is hidden.
        if (engine.isGenerating()) keepAwake(true);
    });
}
