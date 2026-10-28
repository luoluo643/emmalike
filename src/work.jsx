import { useEffect, useState } from 'preact/hooks';
import * as api from './api.js';
import * as engine from './engine.js';
import { ChapterActions, ChapterRow, ChapterSearch, useChapterSearch, useChapters } from './chapters.jsx';
import { substituteNames } from './render.js';
import { Lightbox, PageHeader, go, friendlyError } from './ui.jsx';
import { storyIdentityLabel } from './episodes.jsx';

/** A character presented as a book: cover, introduction, and its chapters (chat files). */
export function WorkPage({ avatar, user, withBridge, onOpenPanel, onEditCharacter, notify }) {
    const [character, setCharacter] = useState(() => api.lastCharacter(avatar));
    const [error, setError] = useState('');
    const [expanded, setExpanded] = useState(false);
    const [menu, setMenu] = useState(null);
    const [coverOpen, setCoverOpen] = useState(false);
    const { chapters, numbers, error: chaptersError, reload } = useChapters(avatar, character?.name);
    const [query, setQuery] = useState('');
    const { list: shown, searching } = useChapterSearch(character ?? { avatar, name: '' }, chapters, query, numbers);

    useEffect(() => {
        api.getCharacter(avatar).then(setCharacter).catch(e => setError(friendlyError(e.message)));
        engine.requestEngine('open');
    }, [avatar]);

    const read = file => go({ name: 'chat', avatar, file });
    const lastFile = character && chapters?.length
        ? (chapters.some(c => api.chatId(c.file_name) === api.chatId(character.chat)) ? api.chatId(character.chat) : api.chatId(chapters[0].file_name))
        : '';
    const intro = character ? substituteNames(character.data?.creator_notes || character.creatorcomment || character.description || '', character.name, user.name).trim() : '';
    const tags = character?.tags ?? character?.data?.tags ?? [];
    const world = character?.data?.extensions?.world;
    const lastChapter = chapters?.find(chapter => api.chatId(chapter.file_name) === lastFile);

    return (
        <main class="tl-page tl-work">
            {/* Editing is a management action: top right, as on a profile page. */}
            <PageHeader title={character?.name ?? '角色'} onBack={() => go({ name: 'library' })}>
                {character && <button class="tl-button" aria-label="编辑角色" onClick={() => go({ name: 'edit', avatar })}>编辑</button>}
            </PageHeader>
            {error && <p class="tl-error">{error}</p>}
            {character && (
                <>
                    <section class="tl-work-hero">
                        {/* The small picture: card files are often several MB (the story data lives inside the PNG). */}
                        <button class="tl-work-cover-button" aria-label="查看大图" onClick={() => setCoverOpen(true)}>
                            <img class="tl-work-cover" src={api.avatarUrl(avatar)} alt={character.name} decoding="async" />
                        </button>
                        <div class="tl-work-info">
                            <h2 class="tl-work-name">{character.name}</h2>
                            {tags.length > 0 && <div class="tl-tags">{tags.slice(0, 8).map(tag => <span class="tl-tag">{tag}</span>)}</div>}
                            <div class="tl-row">
                                <button class="tl-button tl-primary" onClick={() => read(lastFile)}>{lastFile ? '继续阅读' : '开始阅读'}</button>
                                {lastFile && <button class="tl-button" onClick={() => go({ name: 'chat', avatar, file: '', fresh: true })}>开始新故事</button>}
                            </div>
                            {lastChapter && <p class="tl-muted">继续到：{storyIdentityLabel(lastChapter, character.name, numbers, user.handle)}</p>}
                        </div>
                    </section>
                    {intro && (
                        <section class="tl-section">
                            <h2 class="tl-section-title">简介</h2>
                            <p class="tl-work-intro" data-expanded={expanded ? 'true' : undefined}>{intro}</p>
                            {intro.length > 160 && <button class="tl-link" onClick={() => setExpanded(e => !e)}>{expanded ? '收起' : '展开全部'}</button>}
                        </section>
                    )}
                    <section class="tl-section">
                        <h2 class="tl-section-title">故事{chapters ? ` · ${chapters.length}` : ''}</h2>
                        {chaptersError && <p class="tl-error">{chaptersError}</p>}
                        {chapters === null && !chaptersError && <p class="tl-muted">正在加载…</p>}
                        {chapters?.length === 0 && <p class="tl-muted">还没有故事</p>}
                        <ChapterSearch chapters={chapters} query={query} onQuery={setQuery} searching={searching} found={shown?.length ?? 0} />
                        <div class="tl-chapter-list">
                            {shown?.map(chapter => (
                                <ChapterRow character={character} chapter={chapter} numbers={numbers} account={user.handle} current={api.chatId(chapter.file_name) === lastFile}
                                    onOpen={read} onMenu={setMenu} />
                            ))}
                        </div>
                    </section>
                    {world && (
                        <section class="tl-section tl-work-more">
                            <button class="tl-list-item" onClick={() => go({ name: 'world', book: world })}>
                                <span class="tl-list-label">世界书：{world}</span>
                                <span class="tl-list-hint">角色的设定资料</span>
                            </button>
                        </section>
                    )}
                </>
            )}
            {coverOpen && character && <Lightbox src={api.coverUrl(avatar)} alt={character.name} onClose={() => setCoverOpen(false)} />}
            {menu && character && (
                <ChapterActions character={character} chapter={menu} chapters={chapters ?? []} numbers={numbers} account={user.handle} withBridge={withBridge} onOpen={read} onClose={() => setMenu(null)}
                    onChanged={({ type }) => {
                        notify(type === 'delete' ? '故事已删除' : type === 'title' ? '标题已保存' : '故事已改名', 'info');
                        reload();
                        api.getCharacter(avatar).then(setCharacter).catch(() => { });
                    }} />
            )}
        </main>
    );
}
