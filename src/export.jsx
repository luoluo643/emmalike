// Sharing part of a story: as text (copied or saved) or as a long picture drawn in the reader's colours. Loaded only
// when used (see reader.jsx).
import { useMemo, useState } from 'preact/hooks';
import * as engine from './engine.js';
import { NAME_MASK, hasShortNames, hideInText, hideNames, readerNames, roundAt, storyRounds } from './share-model.js';
import { copyText, EngineWait, Sheet, SheetItem, useEngine } from './ui.jsx';

const RECENT_ROUNDS = 10;
const HIDE_NAME_KEY = 'tavern-lite:share-hide-name';
const IMAGE_WIDTH = 1080;
// Phones refuse canvases much taller than this (iOS limits the area), so a long story becomes several pictures.
const PAGE_HEIGHT = 14000;
const BLOCKS = /^(P|DIV|BLOCKQUOTE|LI|UL|OL|H[1-6]|PRE|TABLE|TR|HR|SECTION|ARTICLE|Q)$/;

/** The text of a rendered message: paragraphs kept, frontend cards, folded blocks and styles left out. */
export function htmlToText(html) {
    const doc = new DOMParser().parseFromString(`<body>${html ?? ''}</body>`, 'text/html');
    doc.body.querySelectorAll('.tl-frontend-card, .tl-card-placeholder, details, style, script, iframe, button').forEach(el => el.remove());
    let out = '';
    const walk = node => {
        if (node.nodeType === 3) { out += node.textContent; return; }
        if (node.nodeType !== 1) return;
        if (node.tagName === 'BR') { out += '\n'; return; }
        const block = BLOCKS.test(node.tagName);
        if (block && out && !out.endsWith('\n')) out += '\n';
        for (const child of node.childNodes) walk(child);
        if (block && !out.endsWith('\n')) out += '\n';
    };
    walk(doc.body);
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Every message a reader would see in the story (the app's own notes left out), not yet turned into text. */
function storyItems(bridge) {
    const total = bridge.snapshot(1).total;
    return bridge.snapshot(total).messages
        .filter(m => !(m.is_system && m.type))
        .map(m => ({ index: m.index, name: m.name, user: m.is_user, mes: m.mes, html: m.html }));
}

/** The shared messages as text; only the chosen rounds are converted, so a long story stays quick to share. */
function sharedMessages(rounds) {
    return rounds.flatMap(r => r.messages)
        .map(m => ({ name: m.name, user: m.user, text: htmlToText(m.html ?? m.mes) }))
        .filter(m => m.text);
}

function readSetting(key) {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
}

function writeSetting(key, on) {
    try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* storage unavailable: kept for this time only */ }
}

const roundLabel = round => `${round.number ? `第 ${round.number} 轮` : '开场'} · ${round.summary || '（没有文字）'}`;

function asText(title, messages) {
    return `${title}\n\n${messages.map(m => `${m.name}：\n${m.text}`).join('\n\n')}\n`;
}

// --- Long picture ---------------------------------------------------------------------------------------------

const NO_LINE_START = /^[，。！？、；：,.!?;:」』）)】》〉”’…—]/;
const TOKENS = /[⺀-鿿豈-﫿　-〿＀-￯]|[^\s⺀-鿿豈-﫿　-〿＀-￯]+|[ \t]+/g;

function wrap(ctx, text, width) {
    const lines = [];
    for (const paragraph of text.split('\n')) {
        let line = '';
        for (let token of paragraph.match(TOKENS) ?? []) {
            if (!line && /^[ \t]+$/.test(token)) continue;
            if (ctx.measureText(line + token).width <= width || (NO_LINE_START.test(token) && line)) {
                line += token;
                continue;
            }
            // A word longer than the line is cut where it has to be.
            while (ctx.measureText(token).width > width) {
                let cut = token.length - 1;
                while (cut > 1 && ctx.measureText(token.slice(0, cut)).width > width) cut--;
                if (line) lines.push(line);
                line = '';
                lines.push(token.slice(0, cut));
                token = token.slice(cut);
            }
            if (line) lines.push(line.trimEnd());
            line = /^[ \t]+$/.test(token) ? '' : token;
        }
        lines.push(line);
    }
    return lines;
}

function themeColors() {
    const style = getComputedStyle(document.documentElement);
    const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    const font = getComputedStyle(document.querySelector('.tl-message-body') ?? document.body).fontFamily || 'sans-serif';
    return {
        bg: read('--tl-bg', '#1c1b1f'),
        text: read('--tl-text', '#e8e2d9'),
        muted: read('--tl-text-muted', '#9c958b'),
        accent: read('--tl-accent', '#d0a676'),
        font,
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
async function asPictures(title, messages) {
    const colors = themeColors();
    const scratch = document.createElement('canvas').getContext('2d');
    const pad = 72, width = IMAGE_WIDTH - pad * 2;
    const body = { size: 40, height: 70 }, name = { size: 30, height: 52 }, head = { size: 56, height: 84 };
    const items = [];
    let y = pad;
    scratch.font = `600 ${head.size}px ${colors.font}`;
    for (const line of wrap(scratch, title, width)) {
        items.push({ y, text: line, font: `600 ${head.size}px ${colors.font}`, color: colors.text });
        y += head.height;
    }
    items.push({ y: y + 10, rule: true });
    y += 56;
    for (const message of messages) {
        items.push({ y, text: message.name, font: `${name.size}px ${colors.font}`, color: message.user ? colors.muted : colors.accent });
        y += name.height;
        scratch.font = `${body.size}px ${colors.font}`;
        for (const line of wrap(scratch, message.text, width)) {
            if (line) items.push({ y, text: line, font: `${body.size}px ${colors.font}`, color: colors.text });
            y += line ? body.height : body.height * 0.5;
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
            ctx.font = item.font;
            ctx.fillStyle = item.color;
            ctx.fillText(item.text, pad, top);
        }
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
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
async function hand(files) {
    if (navigator.canShare?.({ files })) {
        try {
            await navigator.share({ files });
            return 'shared';
        } catch (error) {
            if (error?.name === 'AbortError') return 'cancelled';
        }
    }
    for (const file of files) saveFile(file);
    return 'saved';
}

export function ExportSheet({ character, chapterTitle, startIndex, notify, onClose }) {
    useEngine(); // Opened while the full app prepares: shown again once it is ready.
    const bridge = engine.getBridge();
    const rounds = useMemo(() => bridge ? storyRounds(storyItems(bridge)) : [], [bridge]);
    const last = rounds.length - 1;
    // Counted in the reader's rounds: the greeting before them is not one, but comes along with "整章".
    const readerRounds = rounds.filter(r => r.number > 0).length;
    const recent = Math.min(RECENT_ROUNDS, readerRounds);
    const presets = [
        ...(startIndex > 0 ? [{ key: 'from', label: '从选中的这轮到最后', start: roundAt(rounds, startIndex), end: last }] : []),
        ...(recent && recent < readerRounds ? [{ key: 'recent', label: `最近 ${recent} 轮`, start: rounds.length - recent, end: last }] : []),
        { key: 'all', label: `整章（${readerRounds} 轮）`, start: 0, end: last },
    ];
    const [choice, setChoice] = useState(presets[0].key);
    const [picked, setPicked] = useState({ start: presets[0].start, end: presets[0].end });
    const [hide, setHide] = useState(() => readSetting(HIDE_NAME_KEY));
    const [busy, setBusy] = useState(false);
    const preset = presets.find(p => p.key === choice);
    const start = Math.max(0, preset ? preset.start : picked.start);
    const end = Math.max(start, preset ? preset.end : picked.end);
    const chosen = rounds.slice(start, end + 1);
    const count = chosen.reduce((n, r) => n + r.messages.length, 0);
    const names = useMemo(() => {
        let current = '';
        try {
            const personas = bridge?.personaList?.();
            current = personas?.list?.find(p => p.id === personas.current)?.name ?? '';
        } catch { /* no persona list in this version: names from the messages only */ }
        return readerNames(rounds.flatMap(r => r.messages), current);
    }, [rounds]);
    const roundName = r => r?.number ? `第 ${r.number} 轮` : '开场';

    const pick = (key, value) => {
        const next = { start, end, [key]: Number(value) };
        if (key === 'start' && next.end < next.start) next.end = next.start;
        if (key === 'end' && next.start > next.end) next.start = next.end;
        setPicked(next);
    };
    const toggleHide = () => {
        writeSetting(HIDE_NAME_KEY, !hide);
        setHide(!hide);
    };

    const run = async kind => {
        if (busy) return;
        setBusy(kind);
        try {
            let messages = sharedMessages(chosen);
            if (!messages.length) throw new Error('这一段没有能分享的文字');
            let title = `${character.name} · ${chapterTitle}`;
            if (hide && names.length) {
                messages = hideNames(messages, names);
                title = hideInText(title, names);
            }
            if (kind === 'copy') {
                notify(await copyText(asText(title, messages)) ? `已复制 ${messages.length} 条` : '复制失败，试试「文本文件」', 'info');
            } else if (kind === 'text') {
                const file = new File([asText(title, messages)], `${title.replace(/[\\/:*?"<>|]/g, '')}.txt`, { type: 'text/plain' });
                const result = await hand([file]);
                if (result !== 'cancelled') notify(result === 'shared' ? '已分享' : '已保存文本文件', 'info');
            } else {
                await document.fonts?.ready;
                const files = await asPictures(title, messages);
                const result = await hand(files);
                if (result !== 'cancelled') notify(`${result === 'shared' ? '已分享' : '已保存'} ${files.length > 1 ? `${files.length} 张图` : '长图'}`, 'info');
            }
            onClose();
        } catch (e) {
            notify(e.message);
        } finally {
            setBusy(false);
        }
    };

    if (!bridge) {
        return (
            <Sheet title="分享" onClose={onClose}>
                <EngineWait />
            </Sheet>
        );
    }
    if (!rounds.length) {
        return (
            <Sheet title="分享" onClose={onClose}>
                <p class="tl-muted tl-sheet-note">这个故事还没有能分享的内容</p>
            </Sheet>
        );
    }
    return (
        <Sheet title="分享" onClose={onClose}>
            <p class="tl-sheet-section">分享哪些（一轮 = 你说的一句加之后的回复）</p>
            <div class="tl-choice-list" role="radiogroup" aria-label="分享范围">
                {[...presets, { key: 'pick', label: '自己选范围' }].map(p => (
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
                        <select class="tl-input" aria-label="从第几轮开始" value={String(start)} onChange={e => pick('start', e.currentTarget.value)}>
                            {rounds.map((r, i) => <option key={i} value={String(i)}>{roundLabel(r)}</option>)}
                        </select>
                    </label>
                    <label class="tl-field-group">到
                        <select class="tl-input" aria-label="到第几轮结束" value={String(end)} onChange={e => pick('end', e.currentTarget.value)}>
                            {rounds.map((r, i) => <option key={i} value={String(i)} disabled={i < start}>{roundLabel(r)}</option>)}
                        </select>
                    </label>
                </div>
            )}
            <p class="tl-muted tl-sheet-note" aria-live="polite">
                {start === end ? roundName(rounds[start]) : `${roundName(rounds[start])}到${roundName(rounds[end])}`}，共 {count} 条
            </p>
            {names.length > 0 && (
                <button class="tl-sheet-item tl-switch-row" role="switch" aria-checked={hide ? 'true' : 'false'} onClick={toggleHide}>
                    <span class="tl-sheet-item-label">隐藏我的名字</span>
                    <span class="tl-sheet-item-hint">
                        {`分享的内容里，${names.map(n => `「${n}」`).join('')}都换成 ${NAME_MASK}，正文里提到的也换${hasShortNames(names) ? '（只有一个字的名字只换署名）' : ''}。故事本身不变`}
                    </span>
                </button>
            )}
            <p class="tl-sheet-section">分享成</p>
            <SheetItem label={busy === 'image' ? '正在生成长图…' : '长图'} hint="用现在的阅读配色，适合发给朋友；太长会分成几张" disabled={!!busy} onClick={() => run('image')} />
            <SheetItem label={busy === 'text' ? '正在准备…' : '文本文件'} hint="TXT，可以存档或在别处读" disabled={!!busy} onClick={() => run('text')} />
            <SheetItem label="复制文字" disabled={!!busy} onClick={() => run('copy')} />
        </Sheet>
    );
}
