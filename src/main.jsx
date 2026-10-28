import { render } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import './styles.css';
import * as api from './api.js';
import { moveStory } from './story-state.js';
import { movePersonalSources, requestSourceJump } from './personal-records.js';
import { PersonalSheet } from './personal.jsx';
import { CustomCssSheet, ReadingSheet } from './appearance.jsx';
import * as engine from './engine.js';
import { explainApiError } from './api-errors.js';
import { chatSyncStatus, getThroughSync, onChatSync, retryChatSync, saveThroughSync, setChatSyncAccount } from './chat-sync.js';
import { installCardHost } from './cards.js';
import { installAttention } from './attention.js';
import { Library } from './library.jsx';
import { Login } from './login.jsx';
import { MePage } from './me.jsx';
import { ModelSheet } from './model.jsx';
import { giveLetterPicture } from './persona.jsx';
import { Reader } from './reader.jsx';
import { setAppearanceAccount, syncAppearanceWithAccount } from './theme.js';
import { ThemeEditor } from './theme-editor.jsx';
import { CharacterEditor } from './editor.jsx';
import { ToolsSheet } from './tools.jsx';
import { Spinner, friendlyError, go, goBack, parseHash, routeHash, storage, trackProgress, useBackLayer, useEngine, useProgress, wasLayerPop } from './ui.jsx';
import { WorkPage } from './work.jsx';
import { fitIphoneHomeScreen } from './ios-standalone.js';

// Pages most visits never show are loaded when first opened.
const PAGES = {
    setup: () => import('./setup.jsx').then(m => m.SetupPage),
    worlds: () => import('./world-editor.jsx').then(m => m.WorldsPage),
    world: () => import('./world-editor.jsx').then(m => m.WorldBookPage),
    preset: () => import('./preset-editor.jsx').then(m => m.PresetPage),
};

function Lazy({ page, ...props }) {
    const [Page, setPage] = useState(null);
    useEffect(() => {
        PAGES[page]().then(p => setPage(() => p)).catch(() => props.notify('页面没加载出来，检查网络后刷新'));
    }, [page]);
    return Page ? <Page {...props} /> : <div class="tl-boot">正在打开…</div>;
}

function App() {
    const [user, setUser] = useState(undefined);
    const [fatal, setFatal] = useState('');
    const [route, setRoute] = useState(parseHash);
    const shownRoute = useRef(route);
    shownRoute.current = route;
    // Counts navigations so that opening "new story" twice in a row still creates a fresh reader.
    const [visit, setVisit] = useState(0);
    const [nativeVisible, setNativeVisible] = useState(false);
    const [sheet, setSheet] = useState(null);
    const [toasts, setToasts] = useState([]);
    const [popupWaiting, setPopupWaiting] = useState(false);
    const progress = useProgress();
    const eng = useEngine();
    const autoShown = useRef(false);
    const readerPending = useRef(false);
    // Actions on the full app requested before it was ready; they run, in order, once it is.
    const deferred = useRef([]);

    const notify = useCallback((text, level = 'error') => {
        const id = Math.random();
        setToasts(list => [...list.slice(-2), { id, text: level === 'error' ? friendlyError(text) : text, level }]);
        setTimeout(() => setToasts(list => list.filter(t => t.id !== id)), level === 'error' ? 8000 : 4000);
    }, []);
    useEffect(() => installCardHost(notify), [notify]);

    const loadUser = () => api.getCurrentUser().then(u => { setAppearanceAccount(u?.handle); setChatSyncAccount(u?.handle); if (u) engine.setFirstRunName(u.name); setUser(u); }).catch(e => setFatal(friendlyError(e.message)));
    useEffect(() => { loadUser(); }, []);
    // A newer tavern-lite in the repository it was installed from: said once per version, checked at most daily,
    // later than the full app's own start, so the two do not compete for a slow network.
    useEffect(() => {
        if (!user) return;
        const timer = setTimeout(() => import('./upkeep.js').then(m => m.dailyCheck()).then(found => {
            if (found) notify(`轻酒馆有新版本${found.remoteVersion ? ` ${found.remoteVersion}` : ''}，可在「我的 → 检查更新」更新`, 'info');
        }).catch(() => { }), 20000);
        return () => clearTimeout(timer);
    }, [user?.handle]);

    // Chat saves the network dropped are kept on this device and sent again (chat-sync.js).
    const [unsaved, setUnsaved] = useState(chatSyncStatus().pending);
    useEffect(() => onChatSync((type, detail) => {
        if (type === 'status') setUnsaved(detail.pending);
        if (type === 'synced') notify('刚才没存上的改动已补存', 'info');
        if (type === 'conflict') notify(`「${api.chatId(detail.file)}」有一次没存上的改动没能补上：这个故事已经在别处改过，保留了酒馆里的版本`);
    }), []);

    // The session ended while the app was open: back to the login page. Drafts and unsent messages are kept on
    // this device and come back with the page after logging in.
    const signedIn = useRef(false);
    signedIn.current = !!user;
    const userRef = useRef(null);
    const lettered = useRef(false);
    userRef.current = user;
    useEffect(() => engine.onEngine((type, detail) => {
        if (type === 'account-changed') dispatchEvent(new Event('tl-auth-required'));
        if (type === 'chapter-renamed') {
            moveStory(userRef.current?.handle, detail.avatar, detail.from, detail.to);
            movePersonalSources(userRef.current?.handle, detail).catch(() => notify('故事已改名，部分摘录来源暂未更新；原文快照仍保留', 'info'));
        }
    }), []);
    useEffect(() => {
        const lost = () => {
            if (!signedIn.current) return;
            engine.getBridge()?.freezeSession?.();
            setSheet(null);
            engine.showNative(false);
            setNativeVisible(false);
            setUser(null);
            setAppearanceAccount(null);
            setChatSyncAccount(null);
            notify('登录过期了，请重新登录。没发出的文字已存在本机', 'warning');
        };
        addEventListener('tl-auth-required', lost);
        return () => removeEventListener('tl-auth-required', lost);
    }, []);
    const loggedIn = () => {
        // The full app's page still belongs to the old session.
        engine.restartEngine();
        return loadUser();
    };

    useEffect(() => {
        let navigation = 0;
        const update = async event => {
            // A "back" that only closed a sheet or the full app's view: the page stays as it is.
            if (event.type === 'popstate' && wasLayerPop()) return;
            const target = parseHash(), ticket = ++navigation, previous = shownRoute.current;
            const bridge = engine.getBridge();
            if (previous.name === 'chat' && routeHash(previous) !== routeHash(target) && bridge?.episodeNavigationGuard) {
                try { await bridge.episodeNavigationGuard(target.name === 'chat' ? { avatar: target.avatar, file: target.file } : null); }
                catch (error) {
                    if (ticket === navigation) {
                        history.replaceState({ tavernLite: true }, '', routeHash(previous));
                        notify(error.message);
                    }
                    return;
                }
            }
            if (ticket !== navigation) return;
            setRoute(target);
            setVisit(v => v + 1);
            setSheet(null);
        };
        window.addEventListener('popstate', update);
        window.addEventListener('tl-route', update);
        return () => {
            window.removeEventListener('popstate', update);
            window.removeEventListener('tl-route', update);
        };
    }, []);

    const showNative = useCallback(visible => {
        if (visible && engine.getBridge()?.episodeNavigationBusy?.()) {
            notify('还在发送，等它完成或停止生成', 'info');
            return;
        }
        engine.showNative(visible);
        setNativeVisible(visible);
        if (visible) setPopupWaiting(false);
        if (!visible) {
            const current = engine.getBridge()?.currentChat();
            const now = parseHash();
            if (current?.avatar && now.name === 'chat' && !now.fresh && (current.avatar !== now.avatar || (now.file && current.file !== now.file))) {
                go({ name: 'chat', avatar: current.avatar, file: current.file }, true);
            }
        }
    }, []);

    /**
     * Runs an action on the full app, waiting for it to load first if needed. Errors are shown and rethrown. While it
     * runs, "正在{label}…" shows at the top; `quiet` leaves that to a caller that already shows it (a busy button).
     */
    const withBridge = useCallback((label, action, { quiet = false } = {}) => {
        const run = bridge => {
            const work = Promise.resolve(action(bridge)).catch(e => {
                notify(e.message);
                throw e;
            });
            return quiet ? work : trackProgress(`正在${label}…`, work);
        };
        const bridge = engine.getBridge();
        if (bridge) return run(bridge);
        engine.requestEngine('action');
        notify(`原版界面还在准备，好了自动${label}`, 'info');
        return new Promise((resolve, reject) => deferred.current.push({ run, resolve, reject }));
    }, []);

    useEffect(() => {
        if (eng.state === 'ready') {
            const queued = deferred.current.splice(0);
            queued.reduce((previous, item) => previous.then(() => item.run(engine.getBridge()).then(item.resolve, item.reject)), Promise.resolve());
        } else if (eng.state === 'failed') {
            for (const item of deferred.current.splice(0)) item.reject(new Error(engine.engineFailure() || '没准备好，刷新页面再试'));
        }
    }, [eng.state]);

    const openGroup = useCallback(group => {
        withBridge(`打开「${group.name}」`, bridge => bridge.openGroup(group.id).then(() => showNative(true))).catch(() => { });
    }, []);

    const openPanel = useCallback(panel => {
        setSheet(null);
        withBridge('打开', bridge => {
            if (!bridge.openPanel(panel)) throw new Error('这个版本的酒馆里找不到这个功能区');
            showNative(true);
        }).catch(() => { });
    }, []);

    const openExtensionPanel = useCallback(key => {
        setSheet(null);
        withBridge('打开', bridge => {
            if (!bridge.openExtensionPanel?.(key)) throw new Error('原版界面里找不到这个面板了，请重新打开“扩展的面板”看看');
            showNative(true);
        }).catch(() => { });
    }, []);

    const showInNative = useCallback(index => {
        withBridge('打开原版界面', bridge => bridge.showMessage(index).then(() => showNative(true))).catch(() => { });
    }, []);

    // The app's world info panel, showing one book (or just the panel).
    const openWorldNative = useCallback(book => {
        withBridge('打开世界书', bridge => {
            if (!(book ? bridge.openWorldBookPanel?.(book) : bridge.openPanel('world-info'))) throw new Error('这个版本的酒馆里找不到世界书');
            showNative(true);
        }).catch(() => { });
    }, []);

    const editCharacter = useCallback(avatar => {
        withBridge('打开角色编辑', bridge => bridge.editCharacter(avatar).then(() => showNative(true))).catch(() => { });
    }, []);

    const editInNative = useCallback(index => {
        withBridge('打开编辑器', bridge => bridge.editMessage(index).then(() => showNative(true))).catch(() => { });
    }, []);

    // A dialog in the full app only takes over the screen when something the user started is waiting on it;
    // otherwise a bar offers to show it, so reading is never interrupted.
    useEffect(() => engine.onEngine((type, detail) => {
        if (type === 'toast') {
            // A failed reply arrives in the provider's words: said in Chinese with what to do, the original to the console.
            const explained = detail.level === 'error' || detail.level === 'warning' ? explainApiError(detail.text) : null;
            if (explained) console.warn('[tavern-lite]', detail.text);
            notify(explained ?? detail.text, detail.level);
        }
        if (type === 'popup' && !engine.isNativeVisible()) {
            if (readerPending.current || deferred.current.length) {
                autoShown.current = true;
                showNative(true);
                notify('需要你在原版界面里确认一下，已经切换过去', 'warning');
            } else {
                setPopupWaiting(detail?.text ?? true);
            }
        }
        if (type === 'popup-closed') {
            setPopupWaiting(false);
            if (autoShown.current) {
                autoShown.current = false;
                showNative(false);
            }
        }
        if (type === 'state' && detail === 'ready') {
            syncAppearanceWithAccount(engine.getBridge());
            // No model service yet: the shelf and the reader say so and lead to 开始使用 (no jump while reading).
            // A brand-new account also swaps the app's grey silhouette for the first character of its name.
            if (engine.wasFirstRun() && !lettered.current) {
                lettered.current = true;
                // The account's picture is read from its persona, so the header shows the new one after a re-read.
                giveLetterPicture(userRef.current?.name).then(() => api.getCurrentUser()).then(u => u && setUser(u)).catch(() => { });
            }
            const info = engine.engineInfo();
            const warnedKey = `tavern-lite:untested-warned:${info?.version}`;
            if (info && !info.tested && !storage(s => s.getItem(warnedKey))) {
                storage(s => s.setItem(warnedKey, '1'));
                notify(`酒馆 ${info.version} 还没在轻酒馆验证过，遇到问题可以用原版界面`, 'warning');
            }
        }
    }), []);

    // The phone's back gesture leaves the full app's view first.
    useBackLayer(nativeVisible, () => { autoShown.current = false; showNative(false); });

    if (fatal) return <main class="tl-login"><p class="tl-error">{fatal}</p><button class="tl-button" onClick={() => location.reload()}>重试</button></main>;
    if (user === undefined) return <div class="tl-boot">正在打开…</div>;

    const openTools = () => setSheet('tools');
    const editTheme = (id, base) => go({ name: 'theme', id: id ?? '', base: base ?? '' });
    const leaveTheme = () => goBack({ name: 'library' });
    const leaveEditor = () => goBack(route.avatar ? { name: 'work', avatar: route.avatar } : { name: 'library' });
    return (
        <div class="tl-app" data-view={user ? route.name : 'login'}>
            {!user && <Login onDone={loggedIn} />}
            {user && route.name === 'library' && (
                <Library user={user} notify={notify} withBridge={withBridge} onOpenGroup={openGroup} onEditCharacter={editCharacter} />
            )}
            {user && route.name === 'work' && (
                <WorkPage key={route.avatar} avatar={route.avatar} user={user} withBridge={withBridge} notify={notify}
                    onOpenPanel={openPanel} onEditCharacter={editCharacter} />
            )}
            {user && route.name === 'setup' && <Lazy page="setup" user={user} eng={eng} notify={notify} from={route.from} onAccountChanged={() => api.getCurrentUser().then(u => u && setUser(u))} />}
            {user && route.name === 'worlds' && <Lazy page="worlds" eng={eng} notify={notify} onOpenNative={openWorldNative} />}
            {user && route.name === 'world' && (
                <Lazy key={route.book} page="world" book={route.book} entry={route.entry} eng={eng} notify={notify} onOpenNative={openWorldNative} />
            )}
            {user && route.name === 'preset' && <Lazy page="preset" eng={eng} notify={notify} onOpenPanel={openPanel} />}
            {user && route.name === 'me' && (
                <MePage user={user} eng={eng} notify={notify} onOpenPanel={openPanel} onOpenModel={() => setSheet('model')} onOpenPersonal={() => setSheet('personal')}
                    onOpenReading={() => setSheet('reading')} onOpenCss={() => setSheet('css')} onOpenTools={openTools} />
            )}
            {user && route.name === 'edit' && (
                <CharacterEditor key={`${user.handle}|${route.avatar || 'new'}`} account={user.handle} avatar={route.avatar} notify={notify} withBridge={withBridge}
                    onEditInNative={editCharacter} onDone={leaveEditor} />
            )}
            {user && route.name === 'theme' && (
                <ThemeEditor key={`${route.id}|${route.base}`} id={route.id} base={route.base} notify={notify} onDone={leaveTheme} />
            )}
            {user && route.name === 'chat' && (
                <Reader key={`${route.avatar}|${route.file}|${route.fresh ? visit : ''}`} route={route} user={user} eng={eng} notify={notify} withBridge={withBridge}
                    onNative={() => showNative(true)} onTools={openTools} onModel={() => setSheet('model')} onReading={() => setSheet('reading')}
                    onEditInNative={editInNative} onShowInNative={showInNative} onOpenPanel={openPanel} onPendingChange={pending => { readerPending.current = pending; }} />
            )}
            {sheet === 'tools' && (
                <ToolsSheet ready={eng.state === 'ready'} onOpenPanel={openPanel} onOpenExtensionPanel={openExtensionPanel} onGo={route => { setSheet(null); go(route); }}
                    onOpenNative={() => { setSheet(null); showNative(true); }} onClose={() => setSheet(null)} />
            )}
            {sheet === 'model' && <ModelSheet notify={notify} onOpenPanel={openPanel} onClose={() => setSheet(null)} />}
            {sheet === 'reading' && <ReadingSheet onClose={() => setSheet(null)} onEditTheme={editTheme} />}
            {sheet === 'css' && <CustomCssSheet onClose={() => setSheet(null)} />}
            {popupWaiting && !nativeVisible && (
                <div class="tl-popup-bar" role="status">
                    <span>{typeof popupWaiting === 'string' ? popupWaiting : '原版界面里有一项要你确认'}</span>
                    <button class="tl-button tl-primary" onClick={() => { autoShown.current = true; showNative(true); }}>{typeof popupWaiting === 'string' ? '去看看' : '去确认'}</button>
                    {/* Only a window that merely opened can be left alone; a question the app waits on cannot. */}
                    {typeof popupWaiting === 'string' && <button class="tl-popup-close" aria-label="关闭提示" title="关闭" onClick={() => setPopupWaiting(false)}>×</button>}
                </div>
            )}
            {user && unsaved > 0 && !popupWaiting && !nativeVisible && (
                <div class="tl-popup-bar tl-sync-bar" role="status">
                    <span>改动已存在本机，联网后自动补存</span>
                    <button class="tl-button" onClick={retryChatSync}>现在补存</button>
                </div>
            )}
            {nativeVisible && <button class="tl-button tl-primary tl-return" onClick={() => { autoShown.current = false; showNative(false); }}>返回轻酒馆</button>}
            {user && sheet === 'personal' && <PersonalSheet user={user} notify={notify} onClose={() => setSheet(null)} onLocate={async source => {
                if (source.groupId) {
                    await withBridge('回到摘录出处', b => b.revealPersonalSource(source));
                    setSheet(null); showNative(true);
                } else {
                    requestSourceJump(user.handle, source); setSheet(null); go({ name: 'chat', avatar: source.avatar, file: source.file });
                }
            }} />}
            <div class="tl-toasts" aria-live="polite">
                {progress.map(p => <div key={p.id} class="tl-toast" data-level="busy" role="status"><Spinner />{p.text}</div>)}
                {toasts.map(t => <div key={t.id} class="tl-toast" data-level={t.level}>{t.text}</div>)}
            </div>
        </div>
    );
}

installAttention();
fitIphoneHomeScreen();
engine.routeChatRequests({ save: saveThroughSync, get: getThroughSync });
render(<App />, document.getElementById('root'));
