import { useEffect, useRef, useState } from 'preact/hooks';
import * as engine from './engine.js';
import {
    DEFAULT_READING, FONTS, FONT_SIZE, UI_FONT_SIZE, LINE_HEIGHTS, MARGINS, PARAGRAPHS, PRESETS, WIDTHS,
    applyCss, applyReading, cachedCss, cachedDisplay, cachedReading, cachedThemes, findTheme, safeMode, saveAppearance, saveDisplay, themeVars,
} from './theme.js';
import { Choices, Sheet, friendlyError } from './ui.jsx';

/** A small page in the theme's colours and font, like the theme picker of a reading app. */
export function ThemeCard({ theme, selected, onClick, label }) {
    const vars = themeVars(theme);
    const style = theme.bg ? {
        background: vars['bg-image'] ? `linear-gradient(rgba(0,0,0,${vars['bg-dim'] ?? 0}), rgba(0,0,0,${vars['bg-dim'] ?? 0})), ${vars['bg-image']} center / cover, ${theme.bg}` : theme.bg,
        color: theme.text,
        fontFamily: FONTS[theme.font]?.value ?? undefined,
    } : undefined;
    return (
        <button class="tl-theme-card" role="radio" aria-checked={selected ? 'true' : 'false'} aria-label={label ?? theme.name} onClick={onClick}>
            <span class="tl-theme-page" data-system={theme.bg ? undefined : 'true'} style={style}>
                <span class="tl-theme-sample">Aa</span>
                {theme.accent && <span class="tl-theme-accent" style={{ background: theme.accent }} />}
            </span>
            <span class="tl-theme-name">{theme.name}</span>
        </button>
    );
}

function Toggle({ label, on, onChange }) {
    return (
        <button class="tl-choice" role="switch" aria-checked={on ? 'true' : 'false'} onClick={() => onChange(!on)}>
            <span class="tl-switch" aria-hidden="true" />
            <span>{label}</span>
        </button>
    );
}

/**
 * The "Aa" sheet: theme cards first, then type and spacing. Every change shows at once and is saved without a save
 * button, like a reading app. `onEditTheme(id | null, base)` opens the theme editor.
 */
export function ReadingSheet({ onClose, onEditTheme }) {
    const [reading, setReading] = useState(cachedReading);
    const themes = cachedThemes();
    const latest = useRef(reading);
    const saveTimer = useRef(0);
    const themeStrip = useRef(null);
    const [more, setMore] = useState(false);
    useEffect(() => { themeStrip.current?.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, []);

    const update = patch => {
        const next = { ...latest.current, ...patch };
        latest.current = next;
        setReading(next);
        applyReading(next);
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
            saveTimer.current = 0;
            saveAppearance({ reading: next }, engine.getBridge());
        }, 400);
    };
    // A change made just before closing is saved right away instead of being lost with the pending timer.
    const flush = () => {
        if (!saveTimer.current) return;
        clearTimeout(saveTimer.current);
        saveTimer.current = 0;
        saveAppearance({ reading: latest.current }, engine.getBridge());
    };
    useEffect(() => flush, []);

    const current = findTheme(reading.theme, themes);
    const custom = reading.theme.startsWith('custom:');
    const edit = (id, base) => { flush(); onClose(); onEditTheme(id, base); };

    return (
        <Sheet title="阅读设置" onClose={onClose}>
            <div class="tl-settings-group">
                <span class="tl-settings-label">字号</span>
                <div class="tl-stepper" role="group" aria-label="字号">
                    <button class="tl-button" aria-label="字号减小" disabled={reading.fontSize <= FONT_SIZE.min}
                        onClick={() => update({ fontSize: reading.fontSize - 1 })}><span class="tl-stepper-small">A</span></button>
                    <input class="tl-range" type="range" min={FONT_SIZE.min} max={FONT_SIZE.max} value={reading.fontSize} aria-label="字号"
                        onInput={e => update({ fontSize: Number(e.currentTarget.value) })} />
                    <button class="tl-button" aria-label="字号增大" disabled={reading.fontSize >= FONT_SIZE.max}
                        onClick={() => update({ fontSize: reading.fontSize + 1 })}><span class="tl-stepper-large">A</span></button>
                    <span class="tl-stepper-value" aria-live="polite">{reading.fontSize}</span>
                </div>
            </div>
            <div class="tl-settings-group">
                <span class="tl-settings-label">主题</span>
                <div class="tl-theme-strip" ref={themeStrip} role="radiogroup" aria-label="主题" onKeyDown={e => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                    const items = [...e.currentTarget.querySelectorAll('[role="radio"]')];
                    const index = items.indexOf(document.activeElement);
                    if (index < 0) return;
                    e.preventDefault();
                    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
                    items[next].focus(); items[next].click();
                }}>
                    {Object.entries(PRESETS).map(([key, preset]) => (
                        <ThemeCard theme={preset} selected={reading.theme === key} onClick={() => update({ theme: key })} />
                    ))}
                    {themes.map(theme => (
                        <ThemeCard theme={theme} selected={reading.theme === `custom:${theme.id}`}
                            onClick={() => update({ theme: `custom:${theme.id}` })} />
                    ))}
                    <button class="tl-theme-card tl-theme-new" onClick={() => edit(null, custom ? null : reading.theme)}>
                        <span class="tl-theme-page" aria-hidden="true"><span class="tl-theme-sample">＋</span></span>
                        <span class="tl-theme-name">自定义</span>
                    </button>
                </div>
                <button class="tl-link" onClick={() => custom ? edit(current.id) : edit(null, reading.theme)}>
                    {custom ? `编辑「${current.name}」的颜色、背景图和 CSS` : `照「${current?.name ?? '纸色'}」做一个自己的主题`}
                </button>
            </div>
            <div class="tl-settings-group tl-settings-grid">
                <span class="tl-settings-label">行距</span>
                <Choices label="行距" options={LINE_HEIGHTS} value={reading.lineHeight} onChange={lineHeight => update({ lineHeight })} />
            </div>
            <div class="tl-settings-group tl-settings-footer">
                <button class="tl-button" aria-expanded={more} aria-controls="tl-more-reading" onClick={() => setMore(x => !x)}>{more ? '收起更多排版' : '更多排版'}</button>
                <button class="tl-button" onClick={() => update({ ...DEFAULT_READING })}>恢复默认</button>
            </div>
            <div id="tl-more-reading" hidden={!more}>
            <div class="tl-settings-group">
                <span class="tl-settings-label">字体</span>
                <Choices label="字体" options={FONTS} value={reading.font} onChange={font => update({ font })} />
            </div>
            <div class="tl-settings-group tl-settings-grid">
                <span class="tl-settings-label">段距</span>
                <Choices label="段距" options={PARAGRAPHS} value={reading.paragraph} onChange={paragraph => update({ paragraph })} />
                <span class="tl-settings-label">边距</span>
                <Choices label="边距" options={MARGINS} value={reading.margin} onChange={margin => update({ margin })} />
            </div>
            <div class="tl-settings-group">
                <span class="tl-settings-label">排版</span>
                <div class="tl-choices">
                    <Toggle label="首行缩进" on={reading.indent} onChange={indent => update({ indent })} />
                    <Toggle label="中文两端对齐" on={reading.justify} onChange={justify => update({ justify })} />
                </div>
            </div>
            <div class="tl-settings-group tl-width-group">
                <span class="tl-settings-label">页宽</span>
                <Choices label="页宽" options={WIDTHS} value={reading.width} onChange={width => update({ width })} />
            </div>
            </div>
        </Sheet>
    );
}

export function DisplaySheet({ onClose }) {
    const [display, setDisplay] = useState(cachedDisplay);
    const [error, setError] = useState('');
    const update = value => {
        try { setDisplay(saveDisplay(value, engine.getBridge())); setError(''); }
        catch (e) { setError(friendlyError(e.message) || '界面字号没存上，再试一次'); }
    };
    return <Sheet title="显示设置" onClose={onClose}>
        <div class="tl-settings-group">
            <label class="tl-settings-label" for="tl-ui-size">界面字号 · {display.fontSize}</label>
            <input id="tl-ui-size" class="tl-range" type="range" min={UI_FONT_SIZE.min} max={UI_FONT_SIZE.max} value={display.fontSize}
                onInput={e => update(Number(e.currentTarget.value))} />
            <p class="tl-muted">按钮、菜单和输入框的大小。正文字号在阅读页的 Aa 里调</p>
            {error && <p class="tl-error" role="alert">{error}</p>}
            <button class="tl-button" onClick={() => update(UI_FONT_SIZE.default)}>恢复界面默认字号</button>
        </div>
    </Sheet>;
}

export function CustomCssSheet({ onClose }) {
    const [css, setCss] = useState(cachedCss());
    const [saved, setSaved] = useState(true);
    const original = useRef(css);

    const close = () => {
        if (!saved) applyCss(safeMode ? '' : original.current, { preview: true });
        onClose();
    };
    const save = () => {
        saveAppearance({ customCss: css }, engine.getBridge());
        original.current = css;
        setSaved(true);
    };
    const edit = value => {
        setCss(value);
        setSaved(false);
        applyCss(value, { preview: true });
    };

    return (
        <Sheet title="自定义 CSS" onClose={close}>
            <div class="tl-settings-group">
                {safeMode && <p class="tl-error">安全模式：这次没用你存的自定义 CSS。改好或清空后保存，再去掉网址里的 ?safe 重新打开</p>}
                <p class="tl-muted">对所有主题都生效。只想改一个主题，到「阅读设置 · 主题」里改那个主题的 CSS 更方便。输入就能预览，点保存生效。变量和类名见扩展目录里的 THEMING.md</p>
                <textarea class="tl-input tl-css-editor" spellcheck={false} value={css} aria-label="自定义 CSS"
                    onInput={e => edit(e.currentTarget.value)} />
                <div class="tl-row">
                    <button class="tl-button tl-primary" disabled={saved} onClick={save}>保存</button>
                    <button class="tl-button" onClick={() => edit('')}>清空</button>
                </div>
            </div>
        </Sheet>
    );
}
