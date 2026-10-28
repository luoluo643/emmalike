import { useState } from 'preact/hooks';
import * as engine from './engine.js';
import { EngineWait, Sheet, SheetItem } from './ui.jsx';

// Settings beyond the everyday ones, named in plain words: world books and the preset have the shell's own pages; the
// rest are the full app's panels. Characters, the model service and personas are not listed (the shell has them).
export const NATIVE_TOOLS = [
    { route: { name: 'worlds' }, label: '世界书', hint: '角色和故事的设定资料' },
    { route: { name: 'preset' }, label: '预设与提示词', hint: '回复长度、随机程度、提示词条目的开关' },
    { panel: 'formatting', label: '格式与指令', hint: '上下文模板、指令模板、系统提示词' },
    { panel: 'extensions', label: '扩展与正则', hint: '扩展管理、正则脚本、各扩展设置' },
    { panel: 'user-settings', label: '酒馆设置', hint: '原版界面与行为设置' },
    { panel: 'backgrounds', label: '背景', hint: '原版聊天背景' },
];

export function ToolsSheet({ ready, onOpenPanel, onOpenExtensionPanel, onGo, onOpenNative, onClose }) {
    const [listing, setListing] = useState(false);
    // Read from the full app each time the sheet opens: what is there depends on which extensions are installed.
    const panels = ready ? engine.getBridge()?.extensionPanelList?.() ?? [] : [];
    if (listing) return <ExtensionPanelsSheet panels={panels} onOpen={onOpenExtensionPanel} onClose={() => setListing(false)} />;
    return (
        <Sheet title="设置与扩展" onClose={onClose}>
            {!ready && <EngineWait when="好了下面就能打开" />}
            <p class="tl-muted tl-sheet-note">世界书和预设在这里改；其余的会打开原版界面，改完点「返回轻酒馆」</p>
            {NATIVE_TOOLS.map(tool => <>
                {tool.route
                    ? <SheetItem label={tool.label} hint={tool.hint} onClick={() => onGo(tool.route)} />
                    : <SheetItem label={tool.label} hint={`${tool.hint} · 原版界面`} disabled={!ready} onClick={() => onOpenPanel(tool.panel)} />}
                {tool.panel === 'extensions' && <SheetItem label="扩展的面板" disabled={!panels.length} onClick={() => setListing(true)}
                    hint={!ready ? '准备好后列出扩展的面板' : panels.length ? `${panels.length} 个 · 原版界面` : '没有扩展提供面板'} />}
            </>)}
            <SheetItem label="打开原版界面" hint="酒馆的完整界面" disabled={!ready} onClick={onOpenNative} />
        </Sheet>
    );
}

function ExtensionPanelsSheet({ panels, onOpen, onClose }) {
    const drawers = panels.filter(p => p.kind === 'drawer'), settings = panels.filter(p => p.kind === 'settings');
    return (
        <Sheet title="扩展的面板" onClose={onClose}>
            <p class="tl-muted tl-sheet-note">扩展自己的面板和设置，名字是扩展起的。点了会打开原版界面的这个位置，改完点「返回轻酒馆」</p>
            {drawers.length > 0 && <p class="tl-sheet-section">顶栏面板</p>}
            {drawers.map(p => <SheetItem key={p.key} label={p.label} hint="在原版界面打开" onClick={() => onOpen(p.key)} />)}
            {settings.length > 0 && <p class="tl-sheet-section">扩展设置</p>}
            {settings.map(p => <SheetItem key={p.key} label={p.label} hint="在原版界面打开" onClick={() => onOpen(p.key)} />)}
        </Sheet>
    );
}
