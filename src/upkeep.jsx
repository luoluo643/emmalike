import { useEffect, useState } from 'preact/hooks';
import * as engine from './engine.js';
import { HELPER, checkUpdate, helperStatus, installHelper, updateLite } from './upkeep.js';
import { Sheet, SheetItem, friendlyError } from './ui.jsx';

const reload = () => location.reload();

/** Installs Tavern Helper from its official repository, saying whose it is and under which license. */
export function HelperSheet({ notify, onClose }) {
    const [status, setStatus] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState('');
    const [done, setDone] = useState(false);
    useEffect(() => { helperStatus().then(setStatus).catch(e => setError(friendlyError(e.message) || '没读到扩展列表，再试一次')); }, []);
    const install = global => {
        setBusy(global ? 'global' : 'mine'); setError('');
        installHelper(global).then(() => { setDone(true); notify('已安装酒馆助手，重新载入后生效', 'info'); })
            .catch(e => setError(friendlyError(e.message))).finally(() => setBusy(''));
    };
    const disabled = status?.installed && engine.accountDisabledExtensions?.()?.includes(status.name);
    return (
        <Sheet title={HELPER.name} busy={!!busy} onClose={onClose}>
            <p class="tl-muted tl-sheet-note">
                有些角色卡的界面、按钮和状态栏要靠酒馆助手显示。它由 {HELPER.author} 和贡献者开发，
                以 <a href={HELPER.licenseUrl} target="_blank" rel="noopener">{HELPER.license}</a> 发布（仅限非商业使用），不是轻酒馆的一部分。
                轻酒馆不附带也不修改它，点安装后会从官方仓库直接下载。
            </p>
            <p class="tl-muted tl-sheet-note">官方仓库：<a href={HELPER.repo} target="_blank" rel="noopener">{HELPER.repo.replace('https://', '')}</a></p>
            {error && <p class="tl-error" role="alert">{error}</p>}
            {!status && !error && <p class="tl-muted tl-sheet-note">正在检查…</p>}
            {status?.installed && !done && (
                <p class="tl-muted tl-sheet-note">{disabled ? '已安装，但这个账号停用了，去原版界面的扩展面板打开' : `已安装${status.global ? '（所有用户）' : ''}，不用再装`}</p>
            )}
            {status && !status.installed && !done && (
                <>
                    <SheetItem label="安装酒馆助手" hint={status.admin ? '只给当前账号安装' : '给当前账号安装'} busy={busy === 'mine'} busyLabel="正在安装…"
                        disabled={!!busy} onClick={() => install(false)} />
                    {status.admin && <SheetItem label="为所有用户安装" hint="每个账号都能用（需要管理员）" busy={busy === 'global'} busyLabel="正在安装…"
                        disabled={!!busy} onClick={() => install(true)} />}
                </>
            )}
            {done && (
                <div class="tl-settings-group">
                    <p class="tl-muted">装好了，重新载入页面后生效</p>
                    <button class="tl-button tl-primary" disabled={engine.isGenerating()} onClick={reload}>重新载入</button>
                </div>
            )}
        </Sheet>
    );
}

/** Checks the repository tavern-lite was installed from and updates it in place. */
export function UpdateSheet({ notify, onClose }) {
    const [state, setState] = useState(null);
    const [error, setError] = useState('');
    const [updating, setUpdating] = useState(false);
    const [updated, setUpdated] = useState(false);
    const check = () => { setError(''); setState(null); checkUpdate().then(setState).catch(e => setError(`没能检查更新：${e.message.slice(0, 160)}`)); };
    useEffect(check, []);
    const update = () => {
        setUpdating(true); setError('');
        updateLite().then(() => { setUpdated(true); notify('已更新，重新载入后生效', 'info'); }).catch(e => setError(friendlyError(e.message))).finally(() => setUpdating(false));
    };
    return (
        <Sheet title="检查更新" busy={updating} onClose={onClose}>
            <p class="tl-muted tl-sheet-note">当前版本 {__APP_VERSION__}{state?.commit ? ` · ${state.commit}` : ''}</p>
            {error && <p class="tl-error" role="alert">{error}</p>}
            {!state && !error && <p class="tl-muted tl-sheet-note">正在检查…</p>}
            {state?.kind === 'current' && !updated && <p class="tl-muted tl-sheet-note">已是最新版本</p>}
            {state?.kind === 'manual' && <p class="tl-muted tl-sheet-note">这份轻酒馆不是从 GitHub 安装的，没法在这里更新，请按原来的安装方式替换文件</p>}
            {state?.kind === 'forbidden' && <p class="tl-muted tl-sheet-note">有新版本{state.remoteVersion ? ` ${state.remoteVersion}` : ''}，需要管理员来更新</p>}
            {state?.kind === 'available' && !updated && (
                <SheetItem label={`更新到新版本${state.remoteVersion ? ` ${state.remoteVersion}` : ''}`} hint="聊天记录和设置不受影响"
                    busy={updating} busyLabel="正在更新…" disabled={updating || engine.isGenerating()} onClick={update} />
            )}
            {updated && (
                <div class="tl-settings-group">
                    <p class="tl-muted">更新好了，重新载入页面后生效</p>
                    <button class="tl-button tl-primary" disabled={engine.isGenerating()} onClick={reload}>重新载入</button>
                </div>
            )}
            {state && !updated && !updating && <SheetItem label="再检查一次" onClick={check} />}
        </Sheet>
    );
}
