// Sharing part of a story: as text (copied or saved) or as a long picture drawn in the reader's colours. Loaded only
// when used (see reader.jsx).
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as engine from './engine.js';
import { NAME_MASK, bySpeaker, floorAt, floorLabel, hasShortNames, hideInRuns, hideInText, hideNames, readerNames, storyRounds, summarize } from './share-model.js';
import { checkActive, waitForPictureFonts } from './share-dom.js';
import { Choices, copyText, EngineWait, Sheet, SheetItem, useEngine } from './ui.jsx';

const RECENT_ROUNDS = 10;
const HIDE_NAME_KEY = 'tavern-lite:share-hide-name';
const THEMED_KEY = 'tavern-lite:share-theme-colors';
const IMAGE_WIDTH = 1080;
// Phones refuse canvases much taller than this (iOS limits the area), so a long story becomes several pictures.
const PAGE_HEIGHT = 14000;
const BLOCKS = /^(P|DIV|BLOCKQUOTE|LI|UL|OL|H[1-6]|PRE|TABLE|TR|HR|SECTION|ARTICLE|Q)$/;
// What the reader colours inside a message (styles.css: .tl-message-body q / em / strong); the innermost one wins.
const STYLED = { Q: 'quote', EM: 'em', I: 'em', STRONG: 'strong', B: 'strong' };

/** Walks a rendered message: frontend cards, folded blocks and styles left out; `emit(text, kind)` gets the words. */
function walkHtml(html, emit) {
    const doc = new DOMParser().parseFromString(`<body>${html ?? ''}</body>`, 'text/html');
    doc.body.querySelectorAll('.tl-frontend-card, .tl-card-placeholder, details, style, script, iframe, button').forEach(el => el.remove());
    let atLineStart = true;
    const say = (text, kind) => {
        if (!text) return;
        emit(text, kind);
        atLineStart = text.endsWith('\n');
    };
    const walk = (node, kind) => {
        if (node.nodeType === 3) { say(node.textContent, kind); return; }
        if (node.nodeType !== 1) return;
        if (node.tagName === 'BR') { say('\n', 'text'); return; }
        const block = BLOCKS.test(node.tagName);
        if (block && !atLineStart) say('\n', 'text');
        for (const child of node.childNodes) walk(child, STYLED[node.tagName] ?? kind);
        if (block && !atLineStart) say('\n', 'text');
    };
    walk(doc.body, 'text');
}

/** The text of a rendered message: paragraphs kept, frontend cards, folded blocks and styles left out. */
export function htmlToText(html) {
    let out = '';
    walkHtml(html, text => { out += text; });
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The same text as paragraphs of runs ({ text, kind }: 'text', 'quote', 'em' or 'strong'), tidied exactly like
 * htmlToText, so a themed picture has the same words as a plain one.
 */
export function htmlToRuns(html) {
    const chars = [];
    walkHtml(html, (text, kind) => { for (const ch of text) chars.push({ ch, kind }); });
    const tidy = [];
    for (const c of chars) {
        if (c.ch === '\n') {
            while (tidy.length && /[ \t]/.test(tidy.at(-1).ch)) tidy.pop();
            if (tidy.length >= 2 && tidy.at(-1).ch === '\n' && tidy.at(-2).ch === '\n') continue;
        }
        tidy.push(c);
    }
    let from = 0, to = tidy.length;
    while (from < to && /\s/.test(tidy[from].ch)) from++;
    while (to > from && /\s/.test(tidy[to - 1].ch)) to--;
    const paragraphs = [[]];
    for (const { ch, kind } of tidy.slice(from, to)) {
        if (ch === '\n') { paragraphs.push([]); continue; }
        const runs = paragraphs.at(-1);
        if (runs.at(-1)?.kind === kind) runs.at(-1).text += ch;
        else runs.push({ text: ch, kind });
    }
    return paragraphs;
}

/** Plain text as paragraphs of one run each. */
const plainRuns = text => String(text).split('\n').map(line => line ? [{ text: line, kind: 'text' }] : []);

/** Every message a reader would see in the story (the app's own notes left out), not yet turned into text. */
function storyItems(bridge) {
    const total = bridge.snapshot(1).total;
    return bridge.snapshot(total).messages
        .filter(m => !(m.is_system && m.type))
        .map(m => ({ index: m.index, name: m.name, user: m.is_user, mes: m.mes, html: m.html }));
}

/** The shared messages as text; only the chosen ones are converted, so a long story stays quick to share. */
function sharedMessages(items) {
    return items
        .map(m => ({ name: m.name, user: m.user, html: m.html ?? m.mes, text: htmlToText(m.html ?? m.mes) }))
        .filter(m => m.text);
}

function readSetting(key) {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
}

function writeSetting(key, on) {
    try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* storage unavailable: kept for this time only */ }
}

function asText(title, messages) {
    return `${title}\n\n${messages.map(m => `${m.name}：\n${m.text}`).join('\n\n')}\n`;
}

// --- Long picture ---------------------------------------------------------------------------------------------

const NO_LINE_START = /^[，。！？、；：,.!?;:」』）)】》〉”’…—]/;
const TOKENS = /[⺀-鿿豈-﫿　-〿＀-￯]|[^\s⺀-鿿豈-﫿　-〿＀-￯]+|[ \t]+/g;
const SPACE = /^[ \t]+$/;

/** Breaks paragraphs of runs into lines of runs no wider than `width`; `font(kind)` is the font each run is drawn in. */
function wrap(ctx, paragraphs, width, font) {
    const measure = (text, kind) => { ctx.font = font(kind); return ctx.measureText(text).width; };
    const lines = [];
    for (const runs of paragraphs) {
        let line = [], used = 0;
        const add = token => {
            if (line.at(-1)?.kind === token.kind) line.at(-1).text += token.text;
            else line.push({ ...token });
            used += measure(token.text, token.kind);
        };
        const close = () => {
            const end = line.at(-1);
            if (end) end.text = end.text.trimEnd();
            lines.push(line.filter(r => r.text));
            line = [];
            used = 0;
        };
        for (const run of runs) {
            for (const text of run.text.match(TOKENS) ?? []) {
                let token = { text, kind: run.kind };
                if (!line.length && SPACE.test(token.text)) continue;
                if (used + measure(token.text, token.kind) <= width || (NO_LINE_START.test(token.text) && line.length)) {
                    add(token);
                    continue;
                }
                // A word longer than the line is cut where it has to be.
                while (measure(token.text, token.kind) > width) {
                    let cut = token.text.length - 1;
                    while (cut > 1 && measure(token.text.slice(0, cut), token.kind) > width) cut--;
                    if (line.length) close();
                    lines.push([{ text: token.text.slice(0, cut), kind: token.kind }]);
                    token = { text: token.text.slice(cut), kind: token.kind };
                }
                if (line.length) close();
                if (!SPACE.test(token.text)) add(token);
            }
        }
        lines.push(line);
    }
    return lines;
}

function themeColors(themed) {
    const style = getComputedStyle(document.documentElement);
    const read = (name, fallback) => {
        const value = style.getPropertyValue(name).trim();
        // "inherit" and the like are valid CSS but mean nothing on a canvas.
        return value && CSS.supports('color', value) && !/^(inherit|initial|unset|revert|currentcolor)/i.test(value) ? value : fallback;
    };
    const font = getComputedStyle(document.querySelector('.tl-message-body') ?? document.body).fontFamily || 'sans-serif';
    const text = read('--tl-text', '#e8e2d9'), accent = read('--tl-accent', '#d0a676');
    return {
        bg: read('--tl-bg', '#1c1b1f'),
        text,
        muted: read('--tl-text-muted', '#9c958b'),
        accent,
        font,
        // Without the theme's colours every run is the body colour, as pictures always were.
        name: themed ? read('--tl-name-color', accent) : accent,
        runs: themed ? { text, quote: read('--tl-quote', text), em: read('--tl-em', text), strong: read('--tl-strong', text) }
            : { text, quote: text, em: text, strong: text },
        themed,
    };
}

function isLight(ctx, color) {
    ctx.fillStyle = '#000';
    ctx.fillStyle = color;
    const value = String(ctx.fillStyle);
    const rgb = value.startsWith('#') ? [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) : (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    return rgb.length === 3 && (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 > 140;
}

/** Lays the story out as drawing commands, then paints them onto as many pages as it needs. */
async function asPictures(title, messages, themed, { font, signal } = {}) {
    checkActive(signal);
    const colors = themeColors(themed);
    if (font) colors.font = font;
    const scratch = document.createElement('canvas').getContext('2d');
    const pad = 72, width = IMAGE_WIDTH - pad * 2;
    const body = { size: 40, height: 70 }, name = { size: 30, height: 52 }, head = { size: 56, height: 84 };
    const bodyFont = kind => !colors.themed ? `${body.size}px ${colors.font}`
        : kind === 'em' ? `italic ${body.size}px ${colors.font}` : kind === 'strong' ? `600 ${body.size}px ${colors.font}` : `${body.size}px ${colors.font}`;
    const items = [];
    let y = pad;
    for (const line of wrap(scratch, plainRuns(title), width, () => `600 ${head.size}px ${colors.font}`)) {
        items.push({ y, runs: line, font: () => `600 ${head.size}px ${colors.font}`, color: () => colors.text });
        y += head.height;
    }
    items.push({ y: y + 10, rule: true });
    y += 56;
    for (const message of messages) {
        items.push({ y, runs: [{ text: message.name, kind: 'text' }], font: () => `${name.size}px ${colors.font}`, color: () => message.user ? colors.muted : colors.name });
        y += name.height;
        const paragraphs = colors.themed && message.html ? hideInRuns(htmlToRuns(message.html), message.hiddenNames ?? [])
            : plainRuns(message.text);
        for (const line of wrap(scratch, paragraphs, width, bodyFont)) {
            if (line.length) items.push({ y, runs: line, font: bodyFont, color: kind => colors.runs[kind] ?? colors.text });
            y += line.length ? body.height : body.height * 0.5;
        }
        y += 40;
    }
    // Split into pages at line boundaries.
    const pages = [];
    let start = 0;
    while (start < y) {
        let end = Math.min(y, start + PAGE_HEIGHT);
        if (end < y) {
            const last = items.filter(i => i.y >= start && i.y < end - body.height).pop();
            if (last) end = last.y + body.height;
        }
        pages.push([start, end]);
        start = end;
    }
    const files = [];
    for (const [index, [from, to]] of pages.entries()) {
        checkActive(signal);
        const canvas = document.createElement('canvas');
        canvas.width = IMAGE_WIDTH;
        canvas.height = Math.ceil(to - from + (index === pages.length - 1 ? pad - 40 : 0));
        const ctx = canvas.getContext('2d');
        // Theme backgrounds may be see-through (a picture shows behind them); the picture needs a solid one.
        ctx.fillStyle = isLight(ctx, colors.text) ? '#1c1b1f' : '#faf7f2';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = colors.bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.textBaseline = 'top';
        for (const item of items) {
            if (item.y < from || item.y >= to) continue;
            const top = item.y - from;
            if (item.rule) {
                ctx.fillStyle = colors.accent;
                ctx.fillRect(pad, top, 96, 4);
                continue;
            }
            let x = pad;
            for (const run of item.runs) {
                ctx.font = item.font(run.kind);
                ctx.fillStyle = item.color(run.kind);
                ctx.fillText(run.text, x, top);
                x += ctx.measureText(run.text).width;
            }
        }
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        checkActive(signal);
        if (!blob) throw new Error('图太长了，手机画不出来，少选一些');
        files.push(new File([blob], `${title.replace(/[\\/:*?"<>|]/g, '')}${pages.length > 1 ? `-${index + 1}` : ''}.png`, { type: 'image/png' }));
    }
    return files;
}

function saveFile(file) {
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Phones share files through the system sheet (WeChat, gallery…); elsewhere they are downloaded. */
async function hand(files, signal) {
    checkActive(signal);
    if (navigator.canShare?.({ files })) {
        try {
            await navigator.share({ files });
            return 'shared';
        } catch (error) {
            checkActive(signal);
            if (error?.name === 'AbortError') return 'cancelled';
        }
    }
    for (const file of files) { checkActive(signal); saveFile(file); }
    return 'saved';
}

/**
 * The share sheet. A range of floors (presets, or any start and end, of everyone or one side), or with `excerpt`
 * ({ index, text, html }) just a passage selected inside one message.
 */
export function ExportSheet({ character, chapterTitle, startIndex, excerpt, notify, onClose }) {
    useEngine(); // Opened while the full app prepares: shown again once it is ready.
    const bridge = engine.getBridge();
    const items = useMemo(() => bridge ? storyItems(bridge) : [], [bridge]);
    const rounds = useMemo(() => storyRounds(items), [items]);
    const last = items.length - 1;
    // Counted in the reader's rounds: the greeting before them is not one, but comes along with "整章".
    const readerRounds = rounds.filter(r => r.number > 0).length;
    const recent = Math.min(RECENT_ROUNDS, readerRounds);
    const from = startIndex > 0 ? floorAt(items, startIndex) : -1;
    const presets = [
        ...(from >= 0 ? [{ key: 'from', label: `从 #${items[from]?.index} 到最后`, start: from, end: last }] : []),
        ...(recent && recent < readerRounds ? [{ key: 'recent', label: `最近 ${recent} 轮`, start: floorAt(items, rounds[rounds.length - recent].from), end: last }] : []),
        { key: 'all', label: `整章（${readerRounds} 轮）`, start: 0, end: last },
    ];
    const [choice, setChoice] = useState(presets[0].key);
    const [picked, setPicked] = useState({ start: presets[0].start, end: presets[0].end });
    const [who, setWho] = useState('all');
    const [hide, setHide] = useState(() => readSetting(HIDE_NAME_KEY));
    const [themed, setThemed] = useState(() => readSetting(THEMED_KEY));
    const [busy, setBusy] = useState(false);
    const task = useRef(null);
    useLayoutEffect(() => () => task.current?.abort(), []);
    const close = () => { task.current?.abort(); onClose(); };
    const preset = presets.find(p => p.key === choice);
    const start = Math.max(0, preset ? preset.start : picked.start);
    const end = Math.max(start, preset ? preset.end : picked.end);
    // What would really be shared: floors without any text are left out of the count as they are of the result.
    const chosen = useMemo(() => bySpeaker(items.slice(start, end + 1), who).filter(m => htmlToText(m.html ?? m.mes)), [items, start, end, who]);
    const nothing = !excerpt && !chosen.length;
    const author = excerpt ? items.find(m => m.index === excerpt.index) ?? { index: excerpt.index, name: character.name, user: false } : null;
    const names = useMemo(() => {
        let current = '';
        try {
            const personas = bridge?.personaList?.();
            current = personas?.list?.find(p => p.id === personas.current)?.name ?? '';
        } catch { /* no persona list in this version: names from the messages only */ }
        return readerNames(items, current);
    }, [items]);
    const speakers = { all: { label: '都要' }, char: { label: `只要${character.name}` }, user: { label: '只要我' } };

    const pick = (key, value) => {
        const next = { start, end, [key]: Number(value) };
        if (key === 'start' && next.end < next.start) next.end = next.start;
        if (key === 'end' && next.start > next.end) next.start = next.end;
        setPicked(next);
    };
    const toggle = (key, on, set) => {
        writeSetting(key, !on);
        set(!on);
    };

    const run = async kind => {
        if (task.current) return;
        const controller = new AbortController();
        task.current = controller;
        const { signal } = controller;
        setBusy(kind);
        try {
            let messages = excerpt ? [{ name: author.name, user: author.user, html: excerpt.html, text: excerpt.text.trim() }].filter(m => m.text) : sharedMessages(chosen);
            if (!messages.length) throw new Error('这一段没有能分享的文字');
            let title = `${character.name} · ${chapterTitle}`;
            if (hide && names.length) {
                const masked = hideNames(messages, names);
                messages = masked.map((m, i) => ({ ...m, html: messages[i].html, hiddenNames: names }));
                title = hideInText(title, names);
            }
            if (kind === 'copy') {
                const copied = await copyText(asText(title, messages));
                checkActive(signal);
                notify(copied ? `已复制 ${messages.length} 条` : '复制失败，试试「文本文件」', 'info');
            } else if (kind === 'text') {
                const file = new File([asText(title, messages)], `${title.replace(/[\\/:*?"<>|]/g, '')}.txt`, { type: 'text/plain' });
                const result = await hand([file], signal);
                checkActive(signal);
                if (result !== 'cancelled') notify(result === 'shared' ? '已分享' : '已保存文本文件', 'info');
            } else {
                // A font site's font comes in pieces by character: fetch the ones this text needs, off-screen ones too.
                const family = getComputedStyle(document.querySelector('.tl-message-body') ?? document.body).fontFamily;
                const loaded = await waitForPictureFonts(family, asText(title, messages), themed, { signal });
                checkActive(signal);
                const files = await asPictures(title, messages, themed, { font: loaded ? family : 'system-ui, sans-serif', signal });
                const result = await hand(files, signal);
                checkActive(signal);
                if (result !== 'cancelled') notify(`${result === 'shared' ? '已分享' : '已保存'} ${files.length > 1 ? `${files.length} 张图` : '长图'}${loaded ? '' : '（字体未加载完成，已使用系统字体）'}`, 'info');
            }
            checkActive(signal);
            onClose();
        } catch (e) {
            if (!signal.aborted) notify(e.message);
        } finally {
            if (task.current === controller) task.current = null;
            if (!signal.aborted) setBusy(false);
        }
    };

    if (!bridge) {
        return (
            <Sheet title="分享" onClose={close}>
                <EngineWait />
            </Sheet>
        );
    }
    if (!items.length) {
        return (
            <Sheet title="分享" onClose={close}>
                <p class="tl-muted tl-sheet-note">这个故事还没有能分享的内容</p>
            </Sheet>
        );
    }
    return (
        <Sheet title="分享" onClose={close}>
            {busy && <p class="tl-muted tl-sheet-note" role="status">正在准备，关闭面板会取消尚未完成的导出</p>}
            <fieldset class="tl-share-fields" disabled={!!busy} aria-label="分享设置" style={{ border: 0, margin: 0, padding: 0, minWidth: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }}>
            {excerpt ? <>
                <p class="tl-sheet-section">分享选中的一段</p>
                <p class="tl-muted tl-sheet-note">来自 #{author.index} {author.name}：{summarize(excerpt.text)}</p>
            </> : <>
                <p class="tl-sheet-section">分享哪些（一轮 = 你说的一句加之后的回复）</p>
                <div class="tl-choice-list" role="radiogroup" aria-label="分享范围">
                    {[...presets, { key: 'pick', label: '自己选楼层' }].map(p => (
                        <button key={p.key} class="tl-sheet-item tl-choice-row" data-pick role="radio" aria-checked={choice === p.key ? 'true' : 'false'}
                            onClick={() => {
                                if (p.key === 'pick') setPicked({ start, end });
                                setChoice(p.key);
                            }}>
                            <span class="tl-sheet-item-label">{p.label}</span>
                        </button>
                    ))}
                </div>
                {choice === 'pick' && (
                    <div class="tl-share-rounds">
                        <label class="tl-field-group">从
                            <select class="tl-input" aria-label="从哪一楼开始" value={String(start)} onChange={e => pick('start', e.currentTarget.value)}>
                                {items.map((m, i) => <option key={m.index} value={String(i)}>{floorLabel(m)}</option>)}
                            </select>
                        </label>
                        <label class="tl-field-group">到
                            <select class="tl-input" aria-label="到哪一楼结束" value={String(end)} onChange={e => pick('end', e.currentTarget.value)}>
                                {items.map((m, i) => <option key={m.index} value={String(i)} disabled={i < start}>{floorLabel(m)}</option>)}
                            </select>
                        </label>
                    </div>
                )}
                <p class="tl-sheet-section">谁的发言</p>
                <Choices label="谁的发言" options={speakers} value={who} onChange={setWho} />
                <p class="tl-muted tl-sheet-note" aria-live="polite">
                    {nothing ? (who === 'all' ? '这一段没有能分享的文字，换个范围试试' : `这一段里没有${who === 'user' ? '你' : character.name}的发言，换个范围或选「都要」`)
                        : chosen.length === 1 ? `#${chosen[0].index}，共 1 条` : `#${chosen[0].index} 到 #${chosen.at(-1).index}，共 ${chosen.length} 条`}
                </p>
            </>}
            {names.length > 0 && (
                <button class="tl-sheet-item tl-switch-row" role="switch" aria-checked={hide ? 'true' : 'false'} onClick={() => toggle(HIDE_NAME_KEY, hide, setHide)}>
                    <span class="tl-sheet-item-label">隐藏我的名字</span>
                    <span class="tl-sheet-item-hint">
                        {`分享的内容里，${names.map(n => `「${n}」`).join('')}都换成 ${NAME_MASK}，正文里提到的也换${hasShortNames(names) ? '（只有一个字的名字只换署名）' : ''}。故事本身不变`}
                    </span>
                </button>
            )}
            <p class="tl-sheet-section">分享成</p>
            <button class="tl-sheet-item tl-switch-row" role="switch" aria-checked={themed ? 'true' : 'false'} onClick={() => toggle(THEMED_KEY, themed, setThemed)}>
                <span class="tl-sheet-item-label">长图用主题配色</span>
                <span class="tl-sheet-item-hint">对白、旁白、粗体和名字按现在阅读主题的颜色画；关着时和以前一样，正文一种颜色</span>
            </button>
            <SheetItem label={busy === 'image' ? '正在生成长图…' : '长图'} hint="底色跟着现在的阅读主题，适合发给朋友；太长会分成几张" disabled={!!busy || nothing} onClick={() => run('image')} />
            <SheetItem label={busy === 'text' ? '正在准备…' : '文本文件'} hint="TXT，可以存档或在别处读" disabled={!!busy || nothing} onClick={() => run('text')} />
            <SheetItem label="复制文字" disabled={!!busy || nothing} onClick={() => run('copy')} />
            </fieldset>
        </Sheet>
    );
}
