import { useEffect, useState } from 'preact/hooks';
import * as api from './api.js';
import * as engine from './engine.js';
import { Sheet, friendlyError } from './ui.jsx';

const byLabel = (a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN');

/** Which extensions this device's lite shell loads in the full app. Off = skipped here only; the account is untouched. */
export function SkipExtensionsSheet({ eng, notify, onClose }) {
    const [list, setList] = useState(null);
    const [error, setError] = useState('');
    const [skipped, setSkipped] = useState(engine.skippedExtensions);
    const [changed, setChanged] = useState(false);
    useEffect(() => {
        api.listExtensions().then(setList).catch(e => setError(friendlyError(e.message) || '没读到扩展列表，再试一次'));
    }, []);
    const accountOff = eng.state === 'ready' ? engine.accountDisabledExtensions() : null;
    const own = engine.ownExtension();
    const items = (list ?? []).filter(x => x.name !== own).sort(byLabel);
    const toggle = name => {
        setSkipped(engine.setSkippedExtensions(skipped.includes(name) ? skipped.filter(n => n !== name) : [...skipped, name]));
        setChanged(true);
    };
    const restart = () => {
        engine.restartEngine();
        notify('正在重新准备', 'info');
        onClose();
    };
    return (
        <Sheet title="加载的扩展" onClose={onClose}>
            <p class="tl-muted tl-sheet-note">只对本机有效，关掉的不加载、准备更快。会改动发给 AI 内容的扩展，关掉后本机发的消息也会变</p>
            {error && <p class="tl-error" role="alert">{error}</p>}
            {!list && !error && <p class="tl-muted tl-sheet-note">正在加载…</p>}
            {items.map(x => {
                const off = !!accountOff?.includes(x.name);
                return (
                    <button key={x.name} class="tl-sheet-item tl-switch-row" role="switch" aria-checked={!off && !skipped.includes(x.name) ? 'true' : 'false'}
                        disabled={off} onClick={() => toggle(x.name)}>
                        <span class="tl-sheet-item-label">{x.label}</span>
                        <span class="tl-sheet-item-hint">{off ? '账号里停用了，去原版界面的扩展面板打开' : x.type === 'system' ? '酒馆自带' : '第三方扩展'}</span>
                    </button>
                );
            })}
            {changed && (
                <div class="tl-settings-group">
                    <p class="tl-muted">{eng.state === 'idle' ? '下次准备时生效' : '重新准备后生效。'}</p>
                    {eng.state !== 'idle' && <button class="tl-button" disabled={engine.isGenerating()} onClick={restart}>现在重新准备</button>}
                </div>
            )}
        </Sheet>
    );
}
