// Choosing a theme the way a phone chooses a wallpaper: the whole app turns into each theme while you swipe through
// them, a sample reading page shows what a story will look like, and only 使用 keeps the choice.
import { useEffect, useRef, useState } from 'preact/hooks';
import * as engine from './engine.js';
import { PRESETS, applyReading, cachedReading, cachedThemes, saveAppearance } from './theme.js';
import { ThemeCard } from './appearance.jsx';
import { Icon } from './icons.jsx';
import { useBackLayer } from './ui.jsx';

const SWIPE_PX = 50;

/** A story page in the reader's own markup, so each theme's CSS styles it exactly as it will a real story. */
function SampleStory() {
    return (
        <div class="tl-chat tl-picker-story">
            <div class="tl-messages">
                <header class="tl-chapter-opening">
                    <span class="tl-chapter-kicker">第 3 个故事</span>
                    <h2 class="tl-chapter-heading">雨夜还书</h2>
                    <span class="tl-ornament" aria-hidden="true" />
                </header>
                <article class="tl-message" data-role="char">
                    <div class="tl-message-name"><span>店主</span></div>
                    <div class="tl-message-body">
                        <p>雨声把巷口的路灯晕成一团。她把最后一摞旧书搬进檐下，抬头时，看见你站在门口，伞尖还在滴水。</p>
                        <p><q>“进来吧，外头冷。”</q><em>她把热水壶往你那边推了推，</em><q>“你上回说想找的那本诗集，我替你留着呢。”</q></p>
                    </div>
                </article>
                <article class="tl-message" data-role="user">
                    <div class="tl-message-name"><span>你</span></div>
                    <div class="tl-message-body"><p>我收起伞，在门边跺了跺脚。<q>“真找到了？我还以为早就绝版了。”</q></p></div>
                </article>
                <article class="tl-message" data-role="char">
                    <div class="tl-message-name"><span>店主</span></div>
                    <div class="tl-message-body"><p><q>“绝版的书，总会在某家旧书店里等人。”</q><em>她从柜台下抽出一本蓝布面的小册子。</em></p></div>
                </article>
            </div>
            <footer class="tl-composer" aria-hidden="true">
                <div class="tl-composer-box">
                    <span class="tl-composer-input tl-picker-placeholder">写下你的回应…</span>
                    <span class="tl-round tl-send"><Icon name="send" size={20} /></span>
                </div>
            </footer>
        </div>
    );
}

export function ThemePicker({ onClose }) {
    const start = useRef(cachedReading());
    const [list] = useState(() => [
        ...Object.entries(PRESETS).map(([key, theme]) => ({ key, theme })),
        ...cachedThemes().map(theme => ({ key: `custom:${theme.id}`, theme })),
    ]);
    const [index, setIndex] = useState(() => Math.max(0, list.findIndex(item => item.key === start.current.theme)));
    const [sample, setSample] = useState(false);
    const panel = useRef(null);
    const strip = useRef(null);
    const swipe = useRef(null);
    const decided = useRef(false);
    const current = list[index];

    // Each theme is shown on the whole app as it is reached; nothing is saved until 使用.
    useEffect(() => {
        applyReading({ ...start.current, theme: current.key });
        strip.current?.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }, [index]);
    // Leaving any other way (back gesture, the page going away) puts the theme in use back.
    useEffect(() => {
        panel.current?.focus();
        return () => { if (!decided.current) applyReading(start.current); };
    }, []);

    const cancel = () => { decided.current = true; applyReading(start.current); onClose(); };
    const use = () => {
        decided.current = true;
        saveAppearance({ reading: { ...start.current, theme: current.key } }, engine.getBridge());
        onClose();
    };
    useBackLayer(true, cancel, panel);

    const step = by => setIndex(i => Math.min(list.length - 1, Math.max(0, i + by)));
    const onPointerDown = event => { swipe.current = { x: event.clientX, y: event.clientY }; };
    const onPointerUp = event => {
        const from = swipe.current;
        swipe.current = null;
        if (!from) return;
        const dx = event.clientX - from.x, dy = event.clientY - from.y;
        if (Math.abs(dx) > SWIPE_PX && Math.abs(dy) < 60) step(dx < 0 ? 1 : -1);
    };

    return (
        <div class="tl-picker" role="dialog" aria-modal="true" aria-label="换主题" ref={panel} tabIndex={-1} data-sample={sample ? 'true' : undefined}
            onKeyDown={e => { if (e.key === 'ArrowRight') step(1); if (e.key === 'ArrowLeft') step(-1); if (e.key === 'Escape') cancel(); }}>
            <div class="tl-picker-bar">
                <button class="tl-button" onClick={cancel}>取消</button>
                <div class="tl-picker-title" aria-live="polite">
                    <strong>{current.theme.name}</strong>
                    <span>{index + 1} / {list.length}</span>
                </div>
                <button class="tl-button tl-primary" onClick={use}>使用</button>
            </div>
            <div class="tl-picker-stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => { swipe.current = null; }}>
                {sample && <SampleStory />}
                <button class="tl-picker-arrow" data-side="left" aria-label="上一个主题" disabled={index === 0} onClick={() => step(-1)}><Icon name="left" /></button>
                <button class="tl-picker-arrow" data-side="right" aria-label="下一个主题" disabled={index === list.length - 1} onClick={() => step(1)}><Icon name="right" /></button>
            </div>
            <div class="tl-picker-dock">
                <div class="tl-picker-modes" role="radiogroup" aria-label="预览">
                    <button role="radio" aria-checked={sample ? 'false' : 'true'} onClick={() => setSample(false)}>当前页面</button>
                    <button role="radio" aria-checked={sample ? 'true' : 'false'} onClick={() => setSample(true)}>阅读样张</button>
                </div>
                <div class="tl-theme-strip tl-picker-strip" ref={strip} role="radiogroup" aria-label="主题">
                    {list.map((item, i) => <ThemeCard theme={item.theme} selected={i === index} onClick={() => setIndex(i)} />)}
                </div>
                <p class="tl-picker-hint">左右滑动换主题，点「使用」才会保存</p>
            </div>
        </div>
    );
}
