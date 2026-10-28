import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import * as api from './api.js';
import * as engine from './engine.js';
import { EpisodeRenameSheet, episodeIdentity, storyIdentityLabel } from './episodes.jsx';
import { ConfirmSheet, PromptSheet, Sheet, SheetItem, chapterLabel, chapterNumbers, hasGivenName, plainSnippet, relativeTime, friendlyError } from './ui.jsx';

const BAD_NAME = /[\\/:*?"<>|]/;

/** `taken` holds the other chapters' file names: the app refuses a name that already exists, ignoring case. */
export function validateChapterName(name, taken = []) {
    const trimmed = name.trim();
    if (!trimmed) return '请输入名字';
    if (BAD_NAME.test(trimmed)) return '不能包含 \\ / : * ? " < > |';
    const lower = trimmed.toLocaleLowerCase();
    if (taken.some(file => api.chatId(file).toLocaleLowerCase() === lower)) return '已有同名故事';
    return '';
}

/**
 * Chapters (chat files) of one character, most recent first, with a reload after changes; `numbers` gives the
 * unnamed ones their "第 N 个故事" (see chapterLabel).
 */
export function useChapters(avatar, characterName) {
    const [chapters, setChapters] = useState(() => api.lastChapters(avatar));
    const [error, setError] = useState('');
    const reload = useCallback(() => api.getChapters(avatar)
        .then(list => { setChapters(list); setError(''); })
        .catch(e => setError(friendlyError(e.message))), [avatar]);
    useEffect(() => { reload(); }, [reload]);
    const numbers = useMemo(() => chapterNumbers(chapters, characterName), [chapters, characterName]);
    return { chapters, numbers, error, reload };
}

// A search box appears once there are this many chapters.
const SEARCH_FROM = 6;

/**
 * Chapters matching `query`: by name and last line right away, and by their whole text through the app's chat search
 * (`searching` while that answer is on its way).
 */
export function useChapterSearch(character, chapters, query, numbers) {
    const [hits, setHits] = useState(null);
    const needle = query.trim();
    useEffect(() => {
        setHits(null);
        if (!needle) return undefined;
        let alive = true;
        const timer = setTimeout(() => {
            api.searchChapters(character.avatar, needle)
                .then(list => alive && setHits(new Set(list.map(x => api.chatId(x.file_name)))))
                .catch(() => alive && setHits(new Set()));
        }, 300);
        return () => { alive = false; clearTimeout(timer); };
    }, [character.avatar, needle]);
    if (!needle || !chapters) return { list: chapters, searching: false };
    const lower = needle.toLocaleLowerCase();
    const list = chapters.filter(chapter => {
        const file = api.chatId(chapter.file_name);
        return `${file} ${storyIdentityLabel(chapter, character.name, numbers)} ${plainSnippet(chapter.mes)}`.toLocaleLowerCase().includes(lower) || hits?.has(file);
    });
    return { list, searching: hits === null };
}

export function ChapterSearch({ chapters, query, onQuery, searching, found }) {
    if ((chapters?.length ?? 0) < SEARCH_FROM && !query) return null;
    return (
        <div class="tl-chapter-search">
            <input class="tl-input tl-search" type="search" placeholder="搜索故事名或内容" aria-label="搜索故事" value={query}
                onInput={e => onQuery(e.currentTarget.value)} />
            {query.trim() && <p class="tl-muted tl-sheet-note">{searching ? `找到 ${found} 个，还在搜内容…` : found ? `找到 ${found} 个故事` : '没有找到，换个词试试'}</p>}
        </div>
    );
}

export function chapterMeta(chapter) {
    return [chapter.chat_items ? `${chapter.chat_items} 条` : '', relativeTime(chapter.last_mes)].filter(Boolean).join(' · ');
}

/**
 * Rename and delete for one chapter. Both run in the full app so it also updates which chapter is "current";
 * `withBridge` waits for the full app when it is still loading. `start` skips the menu ('rename' or 'delete').
 */
export function ChapterActions({ character, chapter, chapters = [], numbers, account, withBridge, onOpen, onChanged, onClose, start = 'menu' }) {
    const [step, setStep] = useState(start);
    const file = api.chatId(chapter.file_name);
    const identity = episodeIdentity(chapter.chat_metadata, account);
    const label = storyIdentityLabel(chapter, character.name, numbers, account);
    // An automatic name is only a date, so the box starts empty instead of pre-filled with it.
    const named = !hasGivenName(file, character.name);
    const taken = chapters.map(c => c.file_name).filter(name => api.chatId(name) !== file);

    if (step === 'title') return <EpisodeRenameSheet account={account} avatar={character.avatar} file={file} episode={identity.episode}
        withBridge={withBridge} onClose={onClose} onChanged={onChanged} />;

    // With the full app ready the sheet stays open, its button saying "正在…", until the change is done (a failure is
    // shown and the sheet stays for a retry). Still loading: it closes and the change runs once ready, saying so.
    const change = (label, action, done) => {
        const work = withBridge(label, action, { quiet: !!engine.getBridge() }).then(current => { onClose(); onChanged?.({ ...done, current }); });
        if (!engine.getBridge()) { onClose(); work.catch(() => { }); return undefined; }
        return work.catch(() => { });
    };
    if (step === 'rename') {
        return (
            <PromptSheet title={identity.episode ? '改文件名' : '给故事起名'} label={identity.episode ? '原版界面里显示的名字（标题不变）' : '新的名字'} initial={named ? file : ''} placeholder="例如：初遇、雨夜的约定" confirmLabel="保存"
                busyLabel="正在保存…" validate={name => name.trim() === file ? '名字没变' : validateChapterName(name, taken)}
                onClose={onClose}
                onConfirm={name => change('给故事起名', b => b.renameChapter(character.avatar, file, name), { type: 'rename', file })} />
        );
    }
    if (step === 'delete') {
        return (
            <ConfirmSheet title={`删除「${label}」？`} confirmLabel="删除" busyLabel="正在删除…" onClose={onClose}
                message={chapter.chat_items ? `${chapter.chat_items} 条内容会一起删掉，找不回来` : '删掉就找不回来了'}
                onConfirm={() => change('删除故事', b => b.deleteChapter(character.avatar, file), { type: 'delete', file })} />
        );
    }
    return (
        <Sheet title={label} onClose={onClose}>
            {onOpen && <SheetItem label="打开" onClick={() => { onClose(); onOpen(file); }} />}
            {identity.episode && identity.kind !== 'root' && <SheetItem label="改标题" hint="可改标题和类型" onClick={() => setStep('title')} />}
            <SheetItem label={identity.episode ? '改文件名' : '起名'} hint={identity.episode ? '原版界面里显示的名字，标题不变' : ''} onClick={() => setStep('rename')} />
            <SheetItem label="删除" hint="无法恢复" danger onClick={() => setStep('delete')} />
        </Sheet>
    );
}

export function ChapterRow({ character, chapter, numbers, account, current, onOpen, onMenu }) {
    const file = api.chatId(chapter.file_name);
    return (
        <div class="tl-chapter-row" aria-current={current ? 'true' : undefined}>
            <button class="tl-chapter-open" onClick={() => onOpen(file)}>
                <strong class="tl-chapter-name">{storyIdentityLabel(chapter, character.name, numbers, account)}{current && <span class="tl-tag">正在读</span>}</strong>
                <span class="tl-card-snippet">{plainSnippet(chapter.mes).slice(0, 80)}</span>
                <span class="tl-card-meta">{chapterMeta(chapter)}</span>
            </button>
            <button class="tl-message-menu" aria-label="故事操作" onClick={() => onMenu(chapter)}>⋯</button>
        </div>
    );
}

/** Chapter switcher opened from the reader's title. */
export function ChaptersSheet({ character, account, currentFile, onOpen, onNew, onManage, onClose }) {
    const { chapters: all, numbers, error } = useChapters(character.avatar, character.name);
    const [query, setQuery] = useState('');
    const { list: chapters, searching } = useChapterSearch(character, all, query, numbers);
    return (
        <Sheet title="故事" onClose={onClose}>
            <ChapterSearch chapters={all} query={query} onQuery={setQuery} searching={searching} found={chapters?.length ?? 0} />
            {!query.trim() && <SheetItem label="＋ 开始新故事" hint="从头开始，不带之前的记忆" onClick={() => { onClose(); onNew(); }} />}
            {error && <p class="tl-error tl-sheet-note">{error}</p>}
            {chapters === null && !error && <p class="tl-muted tl-sheet-note">正在加载…</p>}
            {chapters?.map(chapter => {
                const file = api.chatId(chapter.file_name);
                return (
                    <SheetItem label={storyIdentityLabel(chapter, character.name, numbers, account)} hint={[chapterMeta(chapter), plainSnippet(chapter.mes).slice(0, 40)].filter(Boolean).join(' · ')} current={file === currentFile}
                        onClick={() => { onClose(); if (file !== currentFile) onOpen(file); }} />
                );
            })}
            <SheetItem label="角色主页" hint="简介、管理故事" onClick={() => { onClose(); onManage(); }} />
        </Sheet>
    );
}
