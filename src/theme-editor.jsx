import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import * as api from './api.js';
import * as engine from './engine.js';
import { Icon } from './icons.jsx';
import {
    FONTS, PRESETS, SNIPPETS, applyReading, cachedReading, cachedThemes, deleteTheme, exportTheme, hasSnippet, luminance,
    newThemeId, readableOn, saveTheme, themeVars, toggleSnippet,
} from './theme.js';
import { Choices, ConfirmSheet, PageHeader, Sheet, Spinner, downloadFile, friendlyError } from './ui.jsx';

const COLORS = [
    { key: 'text', label: '文字' },
    { key: 'accent', label: '强调色', hint: '按钮、名字、进度' },
    { key: 'quote', label: '对白', hint: '引号里的话' },
    { key: 'em', label: '旁白', hint: '斜体的动作和描写' },
];
function Slider({ label, value, min, max, step, format, onChange }) {
    return (
        <label class="tl-slider-row">
            <span>{label}</span>
            <input class="tl-range" type="range" min={min} max={max} step={step} value={value} aria-label={label}
                onInput={e => onChange(Number(e.currentTarget.value))} />
            <span class="tl-slider-value">{format(value)}</span>
        </label>
    );
}

const percent = v => `${Math.round(v * 100)}%`;
const pixels = v => `${v}px`;

const BACKGROUNDS = ['#f5efe3', '#ffffff', '#dfeacf', '#e8d9bb', '#f8ebeb', '#e6ecf3', '#2a2622', '#171513', '#18202b', '#000000'];

function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

// The colours read against the background, in the order the warning names them.
const READ_ON_BACKGROUND = [['text', '文字'], ['quote', '对白'], ['em', '旁白'], ['accent', '强调色']];

/** Which colours are hard to read on `bg` (as the theme will show them, defaults filled in). */
function unreadable(theme, bg = theme.bg) {
    const vars = themeVars({ ...theme, bg });
    return READ_ON_BACKGROUND.filter(([key]) => vars[key] && contrast(vars[key], bg) < 4.5).map(([key]) => key);
}

/** The colour changes that make every hard-to-read colour readable on `bg`; the others stay as chosen. */
function readablePatch(theme, bg = theme.bg) {
    const vars = themeVars({ ...theme, bg });
    return Object.fromEntries(unreadable(theme, bg).map(key => [key,
        key === 'text' ? (luminance(bg) < 0.25 ? '#ddd6ca' : '#2b2620') : readableOn(vars[key], bg)]));
}

function startingTheme(id, base) {
    const existing = id && cachedThemes().find(t => t.id === id);
    if (existing) return existing;
    const from = PRESETS[base]?.bg ? PRESETS[base] : PRESETS.paper;
    return {
        id: newThemeId(), name: base && PRESETS[base]?.bg ? `我的${from.name}` : '我的主题',
        bg: from.bg, text: from.text, accent: from.accent, quote: from.quote, em: from.em,
        image: '', dim: 0, opacity: 0.94, blur: 0, glass: 0, radius: 16, font: from.font ?? 'default', css: '',
    };
}

/** Sample story shown while editing, built from the reader's own markup so the theme's CSS applies as it will. */
function Preview({ theme }) {
    return (
        <section class="tl-theme-preview" aria-label="预览">
            <header class="tl-chapter-opening">
                <span class="tl-chapter-kicker">预览</span>
                <h2 class="tl-chapter-heading">{theme.name || '我的主题'}</h2>
                <span class="tl-ornament" aria-hidden="true" />
            </header>
            <article class="tl-message" data-role="char">
                <div class="tl-message-name"><span>她</span></div>
                <div class="tl-message-body">
                    <p>雨停的时候，巷口的灯一盏一盏亮起来。<em>她把伞收好，抖了抖上面的水珠，</em>抬头看向你。</p>
                    <p><q>“你来得正好，茶刚泡上。”</q>她笑了笑，侧身让出门口的位置。</p>
                </div>
            </article>
            <article class="tl-message" data-role="user">
                <div class="tl-message-name"><span>你</span></div>
                <div class="tl-message-body"><p>我在门口站了一会儿，才走进去。</p></div>
            </article>
            <div class="tl-preview-controls">
                <label class="tl-field-label">输入框预览<input class="tl-input" value="这段示例不会发送" readOnly /></label>
                <div class="tl-row"><button type="button" class="tl-button tl-primary">主按钮预览</button>
                    <button type="button" class="tl-chip" aria-pressed="true">已选中</button>
                    <button type="button" class="tl-chip" aria-pressed="false">未选中</button></div>
            </div>
        </section>
    );
}

function BackgroundPicker({ onPick, onClose }) {
    const [list, setList] = useState(null);
    const [error, setError] = useState('');
    useEffect(() => { api.getBackgrounds().then(setList).catch(e => setError(friendlyError(e.message) || '没加载出来')); }, []);
    return (
        <Sheet title="从酒馆背景里选" onClose={onClose}>
            {error && <p class="tl-error tl-sheet-note">{error}</p>}
            {list === null && !error && <p class="tl-muted tl-sheet-note">正在加载…</p>}
            {list?.length === 0 && <p class="tl-muted tl-sheet-note">酒馆的背景库是空的，可以直接上传一张</p>}
            <div class="tl-bg-grid">
                {list?.map(bg => (
                    <button class="tl-bg-option" aria-label={bg.file} onClick={() => { onPick(bg.url); onClose(); }}>
                        <img src={bg.thumb} alt="" loading="lazy" decoding="async" />
                    </button>
                ))}
            </div>
        </Sheet>
    );
}

/**
 * Theme editor: the page itself is the preview — every change is shown on it at once and only kept after "保存".
 * Colours, a background picture, the theme's font, one-tap effects and the theme's own CSS.
 */
export function ThemeEditor({ id, base, notify, onDone }) {
    const [theme, setTheme] = useState(() => startingTheme(id, base));
    const [dirty, setDirty] = useState(false);
    const [sheet, setSheet] = useState(null);
    const [busy, setBusy] = useState(false);
    const fileInput = useRef(null);
    const saved = cachedThemes().some(t => t.id === theme.id);

    // Applied in the same frame as the change, so dragging a slider or picking a colour never lags behind.
    useLayoutEffect(() => {
        applyReading({ ...cachedReading(), theme: `custom:${theme.id}` }, [theme, ...cachedThemes().filter(t => t.id !== theme.id)]);
    }, [theme]);
    useEffect(() => { engine.requestEngine('open'); }, []);
    // Leaving without saving puts the saved look back.
    useEffect(() => () => applyReading(cachedReading()), []);

    const change = patch => {
        setTheme(t => ({ ...t, ...patch }));
        setDirty(true);
    };
    const save = () => {
        const kept = saveTheme(theme, engine.getBridge());
        setTheme(kept);
        setDirty(false);
        return kept;
    };
    const back = () => dirty ? setSheet('leave') : onDone();

    const onUpload = async event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (!file) return;
        setBusy(true);
        try {
            change({ image: await api.uploadBackground(file), dim: theme.dim || 0.1 });
        } catch (e) {
            notify(e.message);
        } finally {
            setBusy(false);
        }
    };

    // The background picture goes into the file, which can take a moment.
    const [sharing, setSharing] = useState(false);
    const share = async () => {
        if (sharing) return;
        const kept = save();
        setSharing(true);
        try {
            downloadFile(`轻酒馆主题-${kept.name}.json`, await exportTheme(kept.id));
            notify('主题文件已生成，朋友在「我的 → 导入主题」里就能用', 'info');
        } catch (e) {
            notify(e.message);
        } finally {
            setSharing(false);
        }
    };

    const hard = unreadable(theme);
    const hardNames = READ_ON_BACKGROUND.filter(([key]) => hard.includes(key)).map(([, label]) => label);

    return (
        <main class="tl-page tl-theme-editor">
            <PageHeader title={saved ? '编辑主题' : '新建主题'} onBack={back}>
                <button class="tl-button tl-primary" disabled={!dirty && saved} onClick={() => { save(); notify('主题已保存并使用', 'info'); onDone(); }}>保存</button>
            </PageHeader>

            <Preview theme={theme} />

            <section class="tl-section">
                <label class="tl-settings-label" for="tl-theme-name">名字</label>
                <input id="tl-theme-name" class="tl-input" value={theme.name} maxLength={20} onInput={e => change({ name: e.currentTarget.value })} />
            </section>

            <section class="tl-section">
                <h2 class="tl-section-title">背景</h2>
                <div class="tl-palette" role="group" aria-label="背景颜色">
                    {BACKGROUNDS.map(color => (
                        <button class="tl-palette-color" style={{ background: color }} aria-label={`背景 ${color}`}
                            aria-pressed={theme.bg === color ? 'true' : 'false'}
                            onClick={() => change({ bg: color, ...readablePatch(theme, color) })} />
                    ))}
                    <label class="tl-palette-color tl-palette-custom" title="自选颜色">
                        <input type="color" value={theme.bg} aria-label="自选背景颜色" onInput={e => change({ bg: e.currentTarget.value })} />
                    </label>
                </div>
                <div class="tl-row">
                    <button class="tl-button" disabled={busy} onClick={() => fileInput.current?.click()}>
                        {busy ? <Spinner /> : <Icon name="image" size={18} />} {busy ? '正在上传…' : '上传背景图'}
                    </button>
                    <button class="tl-button" onClick={() => setSheet('backgrounds')}>从酒馆背景里选</button>
                    {theme.image && <button class="tl-button" onClick={() => change({ image: '' })}>去掉图片</button>}
                </div>
                <input ref={fileInput} type="file" accept="image/*" hidden onChange={onUpload} />
            </section>

            <section class="tl-section">
                <h2 class="tl-section-title">质感</h2>
                <div class="tl-list">
                    {theme.image && <Slider label="图片变暗" value={theme.dim} min={0} max={0.8} step={0.05} format={percent} onChange={dim => change({ dim })} />}
                    {theme.image && <Slider label="背景模糊" value={theme.blur} min={0} max={20} step={1} format={pixels} onChange={blur => change({ blur })} />}
                    <Slider label="卡片不透明" value={theme.opacity} min={0.3} max={1} step={0.02} format={percent} onChange={opacity => change({ opacity })} />
                    <Slider label="毛玻璃" value={theme.glass} min={0} max={24} step={1} format={pixels} onChange={glass => change({ glass })} />
                    <Slider label="圆角" value={theme.radius} min={0} max={28} step={1} format={pixels} onChange={radius => change({ radius })} />
                </div>
                {theme.glass > 0 && theme.blur > 0 && <p class="tl-muted tl-choice-hint">背景模糊和毛玻璃同时开，旧手机滚动可能会卡</p>}
            </section>

            <section class="tl-section">
                <h2 class="tl-section-title">颜色</h2>
                <div class="tl-list">
                    {COLORS.map(({ key, label, hint }) => (
                        <label class="tl-list-item tl-color-row">
                            <span class="tl-list-label">{label}{hint && <span class="tl-list-hint"> · {hint}</span>}</span>
                            <input type="color" value={theme[key] ?? '#888888'} aria-label={`${label}颜色`} onInput={e => change({ [key]: e.currentTarget.value })} />
                        </label>
                    ))}
                </div>
                {hard.length > 0 && (
                    <p class="tl-error tl-row tl-contrast-warning" role="status">{hardNames.join('、')}和背景太接近，可能看不清
                        <button class="tl-link" onClick={() => change(readablePatch(theme))}>自动调整</button>
                    </p>
                )}
            </section>

            <section class="tl-section">
                <h2 class="tl-section-title">字体</h2>
                <Choices label="主题字体" options={FONTS} value={theme.font} onChange={font => change({ font })} />
                <p class="tl-muted tl-choice-hint">「阅读设置」里选了字体的话，以那里为准</p>
            </section>

            <section class="tl-section">
                <h2 class="tl-section-title">效果</h2>
                <div class="tl-choices">
                    {Object.entries(SNIPPETS).map(([key, snippet]) => (
                        <button class="tl-choice" aria-pressed={hasSnippet(theme.css, key) ? 'true' : 'false'}
                            onClick={() => change({ css: toggleSnippet(theme.css, key) })}>{snippet.label}</button>
                    ))}
                </div>
            </section>

            <section class="tl-section">
                <h2 class="tl-section-title">主题 CSS</h2>
                <p class="tl-muted tl-choice-hint">只在用这个主题时生效，改了马上能在上面预览。上面的「效果」也写在这里，可以照着改。变量和类名见扩展目录里的 THEMING.md</p>
                <textarea class="tl-input tl-css-editor tl-theme-css" spellcheck={false} value={theme.css} aria-label="主题 CSS"
                    placeholder={'例如：\n.tl-message-body q { font-weight: 600; }'} onInput={e => change({ css: e.currentTarget.value })} />
            </section>

            <section class="tl-section tl-row">
                <button class="tl-button" disabled={sharing} aria-busy={sharing ? 'true' : undefined} onClick={share}>{sharing ? <><Spinner />正在生成…</> : '分享这个主题'}</button>
                {saved && <button class="tl-button tl-danger-text" onClick={() => setSheet('delete')}>删除主题</button>}
            </section>

            {sheet === 'backgrounds' && <BackgroundPicker onPick={image => change({ image, dim: theme.dim || 0.1 })} onClose={() => setSheet(null)} />}
            {sheet === 'leave' && (
                <ConfirmSheet title="还没保存" message="刚才的修改还没保存，离开就丢了" confirmLabel="不保存，离开"
                    onClose={() => setSheet(null)} onConfirm={() => { setSheet(null); onDone(); }} />
            )}
            {sheet === 'delete' && (
                <ConfirmSheet title={`删除「${theme.name}」？`} message={`正在用的话会换回「跟随系统」`} confirmLabel="删除"
                    onClose={() => setSheet(null)}
                    onConfirm={() => { deleteTheme(theme.id, engine.getBridge()); setSheet(null); notify('主题已删除', 'info'); onDone(); }} />
            )}
        </main>
    );
}
