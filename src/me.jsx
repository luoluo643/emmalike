import { useEffect, useRef, useState } from 'preact/hooks';
import * as api from './api.js';
import * as engine from './engine.js';
import { cachedReading, exportTheme, importTheme, parseTheme, themeLabel } from './theme.js';
import { ConfirmSheet, PageHeader, Spinner, downloadFile, go, trackProgress } from './ui.jsx';
import { PersonaSheet, personaThumb } from './persona.jsx';
import { modelSummary } from './model.jsx';
import { DisplaySheet } from './appearance.jsx';
import { installApp, installState, reminderSupported, reminderEnabled, setReminder } from './attention.js';

const CAPABILITY_LABELS = {
    send: '发送消息', format: '旧消息排版', editText: '编辑消息', deleteMessage: '删除消息', swipe: '换回复', newChat: '开始新故事', groups: '群聊', branch: '换个走向', chapters: '故事起名和删除', cards: '前端卡片',
};

function About({ engineReady }) {
    const [serverVersion, setServerVersion] = useState('');
    useEffect(() => { api.getServerVersion().then(setServerVersion); }, []);
    const info = engineReady ? engine.engineInfo() : null;
    const version = info?.version ?? serverVersion;
    const tested = engine.isTestedVersion(version);
    const missing = info ? Object.entries(info.capabilities).filter(([, ok]) => !ok).map(([name]) => CAPABILITY_LABELS[name] ?? name) : [];
    return (
        <section class="tl-about">
            <p class="tl-muted">轻酒馆 {__APP_VERSION__} · 酒馆 {version || '未知'} · {version ? (tested ? '已验证' : '未验证此版本') : '版本未知'}</p>
            {missing.length > 0 && <p class="tl-error">当前酒馆版本缺少：{missing.join('、')}，请在原版界面使用</p>}
        </section>
    );
}

function Item({ label, hint, onClick, danger, busy }) {
    return (
        <button class="tl-list-item" data-danger={danger ? 'true' : undefined} disabled={busy} aria-busy={busy ? 'true' : undefined} onClick={onClick}>
            <span class="tl-list-label">{label}</span>
            {hint && <span class="tl-list-hint">{hint}</span>}
        </button>
    );
}

function connectionHint(eng) {
    if (eng.state !== 'ready') return '准备好后显示';
    const info = engine.getBridge()?.connection();
    if (!info) return '';
    const what = [info.source || info.api, info.model].filter(Boolean).join(' · ');
    return `${what || '未设置'} · ${info.connected ? '已连接' : '发送时自动连接'}`;
}

export function MePage({ user, eng, notify, onOpenReading, onOpenCss, onOpenTools, onOpenPanel, onOpenModel, onOpenPersonal }) {
    const [pendingTheme, setPendingTheme] = useState(null);
    const [personaOpen, setPersonaOpen] = useState(false);
    const [displayOpen, setDisplayOpen] = useState(false);
    const [SkipSheet, setSkipSheet] = useState(null);
    const [UpkeepSheet, setUpkeepSheet] = useState(null);
    const openUpkeep = which => import('./upkeep.jsx').then(m => setUpkeepSheet(() => m[which])).catch(e => notify(e.message));
    const [remind, setRemind] = useState(reminderEnabled);
    const [install, setInstall] = useState(installState);
    useEffect(() => {
        const update = () => setInstall(installState());
        addEventListener('tl-install-offer', update);
        addEventListener('appinstalled', update);
        return () => { removeEventListener('tl-install-offer', update); removeEventListener('appinstalled', update); };
    }, []);
    const bridge = eng.state === 'ready' ? engine.getBridge() : null;
    const persona = bridge?.personaList?.() ?? null;
    const current = persona?.list.find(p => p.id === persona.current);
    const models = bridge?.modelChoices?.() ?? null;
    const configured = bridge?.connectionConfigured ? bridge.connectionConfigured() : null;
    const fileInput = useRef(null);
    const reading = cachedReading();

    useEffect(() => { engine.requestEngine('open'); }, []);

    // Background pictures go into the theme file and come out of it as uploads: either can take a while.
    const download = () => trackProgress('正在生成主题文件…', exportTheme().then(text => downloadFile('轻酒馆主题.json', text)))
        .catch(e => notify(e.message));

    const applyTheme = parsed => trackProgress('正在导入主题…', importTheme(parsed, engine.getBridge(), api.uploadBackground).then(imported => {
        notify(imported.length ? `已导入主题「${imported[0].name}」${imported.length > 1 ? ` 等 ${imported.length} 个` : ''}` : '主题已导入', 'info');
    }));

    const onFile = async event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (!file) return;
        try {
            const parsed = parseTheme(await file.text());
            if (parsed.loadsExternal) setPendingTheme(parsed);
            else await applyTheme(parsed);
        } catch (e) {
            notify(e.message);
        }
    };
    const [leaving, setLeaving] = useState(false);
    const logout = async () => {
        if (leaving) return;
        setLeaving(true);
        try { await api.logout(); location.hash = ''; location.reload(); }
        catch (e) { notify(e.message); setLeaving(false); }
    };

    return (
        <main class="tl-page tl-me">
            <PageHeader title="我的" onBack={() => go({ name: 'library' })} />
            <button class="tl-profile" aria-label="我的身份" disabled={!persona} onClick={() => setPersonaOpen(true)}>
                {current ? <img class="tl-avatar" src={personaThumb(current.id)} alt="" /> : user.avatar && <img class="tl-avatar" src={user.avatar} alt="" />}
                <span class="tl-card-text">
                    <strong class="tl-card-name">{current?.name || user.name || user.handle}</strong>
                    <span class="tl-card-meta">{persona ? `我的身份${persona.isDefault ? ' · 默认' : ''}` : '准备好后可换身份'} · 账号 {user.handle}</span>
                </span>
            </button>

            {/* The model first: without it nothing can be written. */}
            <section class="tl-list">
                {configured === false
                    ? <Item label="连接 AI 模型" hint="还没设置，设置好才能聊天" onClick={() => go({ name: 'setup' })} />
                    : <Item label="模型与预设" hint={models ? `${modelSummary(models) || '未设置'} · ${models.connection.connected ? '已连接' : '发送时自动连接'}` : connectionHint(eng)}
                        onClick={onOpenModel} />}
                <Item label="我的摘录" hint="收藏的句子和备注" onClick={onOpenPersonal} />
            </section>

            <section class="tl-section">
                <h2 class="tl-section-title">阅读与外观</h2>
                <div class="tl-list">
                    <Item label="阅读设置" hint={`${themeLabel(reading.theme)} · ${reading.fontSize} 号字`} onClick={onOpenReading} />
                    <Item label="显示设置" hint="按钮和菜单的字号" onClick={() => setDisplayOpen(true)} />
                    <Item label="做一个主题" hint="背景、配色、字体" onClick={() => go({ name: 'theme', id: '', base: '' })} />
                    <Item label="导入主题" hint="用别人分享的主题文件" onClick={() => fileInput.current?.click()} />
                    <Item label="导出主题" hint="存成文件，可以发给朋友" onClick={download} />
                </div>
                <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={onFile} />
            </section>
            {displayOpen && <DisplaySheet onClose={() => setDisplayOpen(false)} />}

            {reminderSupported() && (
                <section class="tl-section">
                    <h2 class="tl-section-title">通知</h2>
                    <div class="tl-list">
                        <button class="tl-list-item tl-switch-row" role="switch" aria-checked={remind ? 'true' : 'false'}
                            onClick={async () => {
                                const result = await setReminder(!remind);
                                setRemind(result.enabled);
                                if (result.message) notify(result.message, result.enabled ? 'info' : 'warning');
                            }}>
                            <span class="tl-list-label">回复写好时通知我</span>
                            <span class="tl-list-hint">仅本机</span>
                        </button>
                    </div>
                </section>
            )}

            {/* Everything about the app's settings and extensions in one place. */}
            <section class="tl-section">
                <h2 class="tl-section-title">设置与扩展</h2>
                <div class="tl-list">
                    <Item label="设置与扩展" hint="世界书、预设、扩展的面板、原版设置" onClick={onOpenTools} />
                    <Item label="加载的扩展（仅本机）"
                        hint={engine.skippedExtensions().length
                            ? `已关掉 ${engine.skippedExtensions().length} 个`
                            : '全部加载 · 关掉用不到的能更快'}
                        onClick={() => import('./extensions-sheet.jsx').then(m => setSkipSheet(() => m.SkipExtensionsSheet)).catch(e => notify(e.message))} />
                    <Item label="酒馆助手" hint="显示角色卡里的界面和按钮" onClick={() => openUpkeep('HelperSheet')} />
                </div>
            </section>
            <section class="tl-section">
                <h2 class="tl-section-title">高级</h2>
                <div class="tl-list">
                    <button class="tl-list-item tl-switch-row" role="switch" aria-checked={eng.mode !== 'auto' ? 'true' : 'false'}
                        onClick={() => engine.setEngineMode(eng.mode === 'auto' ? 'input' : 'auto')}>
                        <span class="tl-list-label">省流量（仅本机）</span>
                        <span class="tl-list-hint">开始写时才准备，第一次发送稍慢</span>
                    </button>
                    <Item label="自定义 CSS" hint="自己写样式" onClick={onOpenCss} />
                </div>
            </section>
            {SkipSheet && <SkipSheet eng={eng} notify={notify} onClose={() => setSkipSheet(null)} />}
            {UpkeepSheet && <UpkeepSheet notify={notify} onClose={() => setUpkeepSheet(null)} />}

            {/* Used once: near the bottom. */}
            {(install === 'offer' || install === 'ios') && (
                <section class="tl-section">
                    <div class="tl-list">
                        {install === 'offer' && (
                            <Item label="添加到桌面" hint="像 App 一样全屏打开" onClick={async () => {
                                if (await installApp()) notify('已添加到桌面', 'info');
                                setInstall(installState());
                            }} />
                        )}
                        {install === 'ios' && (
                            <Item label="添加到桌面" hint="Safari 底部「分享」→「添加到主屏幕」" onClick={() => notify('在 Safari 底部点「分享」，再选「添加到主屏幕」', 'info')} />
                        )}
                    </div>
                </section>
            )}

            {/* Like an app's About: the update check sits by the version, just above signing out. */}
            <section class="tl-section">
                <div class="tl-list">
                    <Item label="检查更新" hint={`当前版本 ${__APP_VERSION__}`} onClick={() => openUpkeep('UpdateSheet')} />
                </div>
            </section>

            <section class="tl-section">
                <div class="tl-list">
                    <Item label={leaving ? <><Spinner />正在退出…</> : '退出登录'} danger busy={leaving} onClick={logout} />
                </div>
                <About engineReady={eng.state === 'ready'} />
            </section>

            {personaOpen && <PersonaSheet inStory={false} notify={notify} onOpenPanel={onOpenPanel} onClose={() => setPersonaOpen(false)} />}
            {pendingTheme && (
                <ConfirmSheet title="导入主题" confirmLabel="仍然导入" busyLabel="正在导入…" onClose={() => setPendingTheme(null)}
                    message="这个主题会从其他网站加载图片或字体，对方能看到你的访问记录。确认来源可信再导入。"
                    onConfirm={() => applyTheme(pendingTheme).then(() => setPendingTheme(null), e => notify(e.message))} />
            )}
        </main>
    );
}
