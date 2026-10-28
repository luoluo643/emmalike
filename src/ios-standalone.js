// iPhone home-screen app (standalone, black-translucent status bar, viewport-fit=cover): WebKit reports a page
// height short of the screen (bugs.webkit.org 237961), and after the keyboard closes the height can stay shrunk for
// the rest of the session; both leave a blank band under the input. There, and only there, the page is sized from
// the screen itself, and re-measured after the keyboard closes. Other devices and browser tabs are left as they are.

const FIELDS = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/** Only when the page draws under the status bar (black-translucent): then the page is the whole screen. */
export function isIphoneHomeScreen(nav = navigator, media = query => matchMedia(query).matches,
    statusBar = () => document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content) {
    const iphone = /iPhone|iPod/.test(nav.platform || '') || /\b(iPhone|iPod)\b/.test(nav.userAgent || '');
    return iphone && (nav.standalone === true || media('(display-mode: standalone)')) && statusBar() === 'black-translucent';
}

/** The full screen height for the current orientation (iOS keeps screen.width/height in portrait terms). */
export function screenHeight(scr = screen, portrait = matchMedia('(orientation: portrait)').matches) {
    const long = Math.max(scr.width, scr.height), short = Math.min(scr.width, scr.height);
    return portrait ? long : short;
}

export function fitIphoneHomeScreen() {
    if (typeof window === 'undefined' || !isIphoneHomeScreen()) return false;
    const root = document.documentElement;
    root.dataset.iosStandalone = 'true';
    const apply = () => root.style.setProperty('--tl-app-height', `${Math.max(screenHeight(), innerHeight)}px`);
    apply();
    addEventListener('resize', apply);
    addEventListener('orientationchange', () => setTimeout(apply, 300));
    // After the keyboard: back to the top of the document, and if WebKit still reports a shrunk window, make it
    // measure again by taking the app out of the layout for one frame (its own scroll position is kept).
    const heal = () => {
        if (document.activeElement?.matches?.(FIELDS)) return;
        if (scrollY) scrollTo(0, 0);
        if (screenHeight() - innerHeight <= 4) return;
        const app = document.getElementById('root');
        if (!app) return;
        const scrollers = [...app.querySelectorAll('.tl-messages, .tl-page')].map(el => [el, el.scrollTop]);
        app.style.display = 'none';
        void app.offsetHeight;
        app.style.display = '';
        for (const [el, top] of scrollers) el.scrollTop = top;
        apply();
    };
    document.addEventListener('focusout', event => { if (event.target?.matches?.(FIELDS)) setTimeout(heal, 150); }, true);
    return true;
}
