import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import * as api from './api.js';
import * as engine from './engine.js';
import { FONT_FILE, MAX_FONTS, MAX_FONT_BYTES, familyInCss, fontKey, fontLinkIn, fontNameOf, isFontFileLink, newFontId } from './fonts.js';
import { cachedFonts, deleteFont, fontOptions, saveFont } from './theme.js';
import { Choices, Spinner, friendlyError } from './ui.jsx';
import { checkActive } from './share-dom.js';

const BLOCKED = '这个网址的字体加载不了：可能网址不对，或者对方不允许别的网站使用';

function checkRoom() {
    if (cachedFonts().length >= MAX_FONTS) throw new Error(`最多 ${MAX_FONTS} 个字体，先删掉不用的`);
}

async function addFile(file, signal) {
    const extension = file.name.match(FONT_FILE)?.[1].toLowerCase();
    if (!extension) throw new Error('只支持 ttf、otf、woff、woff2 字体文件');
    if (file.size > MAX_FONT_BYTES) throw new Error('字体太大了，请选 30MB 以内的');
    const bytes = await file.arrayBuffer();
    checkActive(signal);
    const digest = globalThis.crypto?.subtle ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('') : undefined;
    checkActive(signal);
    const existing = digest && cachedFonts().find(f => f.kind === 'upload' && f.digest === digest);
    if (existing) return existing;
    checkRoom();
    try {
        await new FontFace('tl-font-probe', bytes).load();
    } catch {
        throw new Error('这个文件打不开，可能不是字体或已经损坏');
    }
    checkActive(signal);
    const id = newFontId();
    const url = await api.uploadFontFile(file, `tavern-lite-font-${id}.${extension}`);
    let kept = false;
    try {
        checkActive(signal);
        const saved = saveFont({ id, name: fontNameOf(file.name), kind: 'upload', url, digest }, engine.getBridge());
        kept = saved?.url === url;
        return saved;
    } finally {
        // A cancelled upload or a duplicate completed elsewhere must not leave another account file behind.
        if (!kept) await api.deleteFontFile(url).catch(() => { });
    }
}

/** What a link is: a font file the browser can open, or a stylesheet of fonts. Null family: its name must be asked for. */
async function readLink(url, signal) {
    const openable = () => new FontFace('tl-font-probe', `url("${url}")`).load();
    if (isFontFileLink(url)) {
        await openable().catch(() => { throw new Error(BLOCKED); });
        checkActive(signal);
        return { kind: 'file', name: fontNameOf(new URL(url).pathname) };
    }
    let css;
    try {
        const response = await fetch(url, { credentials: 'omit', signal });
        if (!response.ok) throw new Error(BLOCKED);
        css = await response.text();
    } catch {
        checkActive(signal);
        return { kind: 'css', family: null };
    }
    checkActive(signal);
    const family = familyInCss(css);
    if (family) return { kind: 'css', family };
    // Some font links have no file extension.
    if (!css.trimStart().startsWith('<') && await openable().then(() => true, () => false)) return { kind: 'file', name: fontNameOf(new URL(url).pathname) };
    return { kind: 'css', family: null };
}

/**
 * The font choices with "upload a file" and "fill in a link" underneath. `value` and `onChange` are the setting being
 * edited (the reading font, or a theme's font); the list of added fonts itself is saved right away.
 */
export function FontPicker({ label, value, onChange }) {
    const [, refresh] = useState(0);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [linkOpen, setLinkOpen] = useState(false);
    const [link, setLink] = useState('');
    const [askFamily, setAskFamily] = useState(false);
    const [family, setFamily] = useState('');
    const [confirming, setConfirming] = useState(false);
    const fileInput = useRef(null);
    const task = useRef(null);
    useLayoutEffect(() => () => task.current?.abort(), []);

    const options = fontOptions();
    const current = cachedFonts().find(font => fontKey(font) === value);

    const run = async (kind, work) => {
        if (task.current) return;
        const controller = new AbortController();
        task.current = controller;
        setBusy(kind);
        setError('');
        try {
            await work(controller.signal);
        } catch (e) {
            if (!controller.signal.aborted) setError(friendlyError(e.message) || '字体没加上，再试一次');
        } finally {
            if (task.current === controller) {
                task.current = null;
                if (!controller.signal.aborted) setBusy('');
            }
        }
    };
    const choose = font => {
        task.current?.abort();
        task.current = null;
        setBusy(''); setError(''); setConfirming(false);
        onChange(font);
    };
    const added = (font, signal) => {
        checkActive(signal);
        if (!font) throw new Error('这个字体名或网址用不了，换一个试试');
        setLink(''); setFamily(''); setAskFamily(false); setLinkOpen(false);
        setConfirming(false);
        refresh(n => n + 1);
        onChange(fontKey(font));
    };
    const addLink = () => run('link', async signal => {
        const url = fontLinkIn(link);
        if (!url) throw new Error('请填 http 或 https 开头的字体网址');
        const read = await readLink(url, signal);
        checkActive(signal);
        const name = read.family ?? family.trim();
        if (read.kind === 'css' && !name) {
            setAskFamily(true);
            throw new Error('读不到这个链接里的字体名，把网页上写的 font-family 填在下面');
        }
        const saved = saveFont({ id: newFontId(), kind: read.kind, url, family: name, name: read.kind === 'css' ? name : read.name }, engine.getBridge());
        if (!saved) throw new Error('这个字体名或网址用不了，换一个试试');
        added(saved, signal);
    });
    const remove = () => run('delete', async () => {
        const font = current;
        deleteFont(font.id, engine.getBridge());
        setConfirming(false);
        refresh(n => n + 1);
        onChange('default');
        // The list no longer points at it; a file left behind on a failed delete only takes up room.
        if (font.kind === 'upload') await api.deleteFontFile(font.url).catch(() => { });
    });

    return (
        <div class="tl-font-picker">
            <Choices label={label} options={options} value={options[value] ? value : 'default'} onChange={choose} />
            <div class="tl-row">
                <button class="tl-button" disabled={!!busy} aria-busy={busy === 'file' ? 'true' : undefined} onClick={() => fileInput.current.click()}>
                    {busy === 'file' ? <><Spinner />正在上传…</> : '上传字体文件'}
                </button>
                <button class="tl-button" disabled={!!busy} aria-expanded={linkOpen} onClick={() => { setLinkOpen(x => !x); setError(''); }}>填字体网址</button>
            </div>
            <input ref={fileInput} type="file" accept=".ttf,.otf,.woff,.woff2" hidden aria-label="选择字体文件" onChange={e => {
                const file = e.currentTarget.files[0];
                e.currentTarget.value = '';
                if (file) run('file', signal => addFile(file, signal).then(font => added(font, signal)));
            }} />
            {linkOpen && (
                <form class="tl-font-link" noValidate onSubmit={e => { e.preventDefault(); if (!busy) addLink(); }}>
                    <input class="tl-input" readOnly={!!busy} inputMode="url" autocomplete="off" spellcheck={false} aria-label="字体网址" placeholder="字体文件或字体 CSS 的网址"
                        value={link} onInput={e => setLink(e.currentTarget.value)} />
                    {askFamily && <input class="tl-input" readOnly={!!busy} spellcheck={false} maxLength={80} aria-label="字体名" placeholder="font-family 后面的名字"
                        value={family} onInput={e => setFamily(e.currentTarget.value)} />}
                    <button class="tl-button tl-primary" disabled={!!busy || !link.trim()} aria-busy={busy === 'link' ? 'true' : undefined}>
                        {busy === 'link' ? <><Spinner />正在读取…</> : '添加这个字体'}
                    </button>
                </form>
            )}
            {error && <p class="tl-error" role="alert">{error}</p>}
            {confirming && <p class="tl-muted tl-choice-hint">将从账号字体库删除，也会影响其他使用它的主题。取消主题编辑不会恢复已删除的字体。</p>}
            {current && (confirming
                ? <div class="tl-row">
                    <button class="tl-button tl-danger-text" disabled={!!busy} onClick={remove}>确定删除「{current.name}」</button>
                    <button class="tl-button" onClick={() => setConfirming(false)}>取消</button>
                </div>
                : <button class="tl-link tl-font-remove" onClick={() => setConfirming(true)}>删除字体「{current.name}」</button>)}
            <p class="tl-muted tl-choice-hint">支持 ttf、otf、woff、woff2，30MB 以内，换设备也能用。中文字体比较大，第一次打开要下载一会儿；填网址的字体由你的浏览器直接从那个网站加载。</p>
        </div>
    );
}
