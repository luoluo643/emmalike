import { useEffect, useRef, useState } from 'preact/hooks';
import * as api from './api.js';
import * as engine from './engine.js';
import { substituteNames } from './render.js';
import { storyIdentityLabel } from './episodes.jsx';
import { ChapterActions, useChapters } from './chapters.jsx';
import { Avatar, ConfirmSheet, GroupCover, Sheet, SheetItem, chapterLabel, go, plainSnippet, relativeTime, useEngine, useLongPress, friendlyError } from './ui.jsx';

const FAVORITES = '★ 收藏';

const ACCEPT = api.IMPORT_TYPES.map(t => `.${t}`).join(',');
// The Chinese sample character (sample.js, loaded only when added).
const SAMPLE_NAME = '林小满';

function ContinueCard({ entry, character, group, user, onOpenGroup, onMenu, primary }) {
    const open = () => group ? onOpenGroup(group) : go({ name: 'chat', avatar: character.avatar, file: api.chatId(entry.file_name) });
    const name = group ? group.name : character.name;
    const story = group ? '群聊' : storyIdentityLabel(entry, character.name, undefined, user.handle);
    const snippet = group ? '群聊 · 在原版界面打开' : plainSnippet(substituteNames(entry.mes, character.name, user.name)).slice(0, primary ? 140 : 80);
    const meta = [entry.chat_items ? `${entry.chat_items} 条` : '', relativeTime(entry.last_mes)].filter(Boolean).join(' · ');
    // Group chats are managed in the full app; a character's story gets the same menu as on its page.
    const press = useLongPress(() => !group && onMenu(entry));
    return (
        <div class="tl-continue-item">
            <button class={`tl-card tl-continue${primary ? ' tl-continue-primary' : ' tl-continue-compact'}`} data-kind={group ? 'group' : 'character'}
                {...(group ? {} : press)} onClick={open}>
                {group ? <GroupCover group={group} /> : <Avatar file={character.avatar} name={character.name} />}
                <span class="tl-card-text">
                    {primary && <span class="tl-continue-label">继续阅读</span>}
                    <strong class="tl-card-name">{name}</strong>
                    <span class="tl-card-story" title={story}>{story}</span>
                    <span class="tl-card-snippet">{snippet}</span>
                    {meta && <span class="tl-card-meta">{meta}</span>}
                </span>
            </button>
            {!group && <button class="tl-message-menu tl-continue-menu" aria-label={`${story}的操作`} onClick={() => onMenu(entry)}>⋯</button>}
        </div>
    );
}

/** Rename and delete for a story on the shelf, with its character's other stories for names and numbering. */
function ContinueActions({ entry, character, user, withBridge, onChanged, onClose }) {
    const { chapters, numbers } = useChapters(character.avatar, character.name);
    const file = api.chatId(entry.file_name);
    const chapter = chapters?.find(c => api.chatId(c.file_name) === file) ?? entry;
    return (
        <ChapterActions character={character} chapter={chapter} chapters={chapters ?? []} numbers={numbers} account={user.handle} withBridge={withBridge}
            onOpen={f => go({ name: 'chat', avatar: character.avatar, file: f })} onClose={onClose} onChanged={onChanged} />
    );
}

function BookCard({ character, onMenu }) {
    const press = useLongPress(() => onMenu(character));
    return (
        <div class="tl-book">
            {api.isFavorite(character) && <span class="tl-book-fav" aria-label="已收藏">★</span>}
            <button class="tl-card tl-character" {...press} onClick={() => go({ name: 'chat', avatar: character.avatar, file: api.chatId(character.chat) })}>
                <Avatar file={character.avatar} name={character.name} />
                <strong class="tl-card-name">{character.name}</strong>
            </button>
            <button class="tl-book-menu" aria-label={`${character.name} 的更多操作`} onClick={() => onMenu(character)}>⋯</button>
        </div>
    );
}

export function Library({ user, notify, withBridge, onOpenGroup, onEditCharacter }) {
    const [characters, setCharacters] = useState(null);
    const [groups, setGroups] = useState([]);
    const [recent, setRecent] = useState([]);
    const [query, setQuery] = useState('');
    const [tag, setTag] = useState('');
    const [error, setError] = useState('');
    const [menu, setMenu] = useState(null);
    const [menuChapter, setMenuChapter] = useState(null);
    const [importing, setImporting] = useState(false);
    const [adding, setAdding] = useState(false);
    const [deleting, setDeleting] = useState(null);
    const [storyMenu, setStoryMenu] = useState(null);
    const fileInput = useRef(null);
    const eng = useEngine();
    const unconfigured = eng.state === 'ready' && engine.getBridge()?.connectionConfigured?.() === false;

    const load = () => Promise.all([api.getCharacters(), api.getRecentChats(20), api.getGroups()])
        .then(([list, recentChats, groupList]) => {
            setCharacters(list);
            setRecent(recentChats);
            setGroups(groupList);
        })
        .catch(e => setError(friendlyError(e.message)));

    useEffect(() => {
        load().finally(() => engine.requestEngine('open'));
    }, []);
    useEffect(() => {
        setMenuChapter(null);
        if (!menu?.chat) return;
        let alive = true;
        api.getChapters(menu.avatar).then(list => {
            if (alive) setMenuChapter(list.find(chapter => api.chatId(chapter.file_name) === api.chatId(menu.chat)) || null);
        }).catch(() => {});
        return () => { alive = false; };
    }, [menu]);

    const onFiles = async event => {
        const files = [...(event.currentTarget.files ?? [])];
        event.currentTarget.value = '';
        if (!files.length) return;
        setImporting(true);
        const imported = [];
        for (const file of files) {
            try {
                imported.push(await api.importCharacter(file));
            } catch (e) {
                notify(e.message);
            }
        }
        setImporting(false);
        if (!imported.length) return;
        await load();
        notify(imported.length === 1 ? '已导入 1 个角色' : `已导入 ${imported.length} 个角色`, 'info');
    };

    const byAvatar = new Map((characters ?? []).map(c => [c.avatar, c]));
    const byGroup = new Map(groups.map(g => [String(g.id), g]));
    const hasFavorites = (characters ?? []).some(api.isFavorite);
    const allTags = [...(hasFavorites ? [FAVORITES] : []), ...new Set((characters ?? []).flatMap(c => c.tags ?? []).filter(Boolean))].slice(0, 20);
    const needle = query.trim().toLocaleLowerCase();
    const matches = text => !needle || text.toLocaleLowerCase().includes(needle);
    const inTag = c => !tag || (tag === FAVORITES ? api.isFavorite(c) : (c.tags ?? []).includes(tag));
    // Favourites first, then the most recently read.
    const visible = (characters ?? [])
        .filter(c => matches(`${c.name} ${(c.tags ?? []).join(' ')}`) && inTag(c))
        .sort((a, b) => (api.isFavorite(b) - api.isFavorite(a)) || (b.date_last_chat ?? 0) - (a.date_last_chat ?? 0));

    // The menu stays open, its item saying so, until the star is saved and the shelf re-read.
    const [starring, setStarring] = useState(false);
    const toggleFavorite = async character => {
        if (starring) return;
        setStarring(true);
        const fav = !api.isFavorite(character);
        try {
            await api.setFavorite(character.avatar, fav);
            // The full app keeps its own copy of the card; reload it so its next save keeps the star.
            engine.getBridge()?.refreshCharacter(character.avatar).catch(() => { });
            await load();
            setMenu(null);
            notify(fav ? `已收藏「${character.name}」` : `已取消收藏「${character.name}」`, 'info');
        } catch (e) {
            notify(e.message);
        } finally {
            setStarring(false);
        }
    };

    // Called from the confirmation, which shows "正在删除…" until this is done.
    const remove = async character => {
        try {
            const bridge = engine.getBridge();
            if (bridge?.deleteCharacter) await bridge.deleteCharacter(character.avatar);
            else await api.deleteCharacter(character.avatar);
            await load();
            setDeleting(null);
            notify(`已删除「${character.name}」`, 'info');
        } catch (e) {
            notify(e.message);
        }
    };
    const visibleGroups = tag ? [] : groups.filter(g => matches(g.name ?? ''));
    // One card per character or group: its most recent chapter.
    const seen = new Set();
    const continueList = needle || tag ? [] : recent
        .filter(r => (r.avatar && byAvatar.has(r.avatar)) || (r.group && byGroup.has(String(r.group))))
        .filter(r => {
            const key = r.avatar ? `c:${r.avatar}` : `g:${r.group}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, 4);
    const empty = characters !== null && characters.length === 0 && groups.length === 0;
    const hasSample = (characters ?? []).some(c => c.name === SAMPLE_NAME);
    // Offered on the shelf while it holds nothing but the app's bundled (English) characters.
    const offerSample = characters !== null && !hasSample && characters.every(c => String(c.avatar ?? '').startsWith('default_'));
    const addSample = async () => {
        setAdding(false);
        setImporting(true);
        try {
            const avatar = await (await import('./sample.js')).addSample();
            go({ name: 'chat', avatar, file: '', fresh: true });
        } catch (e) {
            notify(e.message);
        } finally {
            setImporting(false);
        }
    };

    return (
        <main class="tl-library">
            <header class="tl-header">
                <h1 class="tl-title">轻酒馆</h1>
                <span class="tl-spacer" />
                <button class="tl-button" disabled={importing} onClick={() => setAdding(true)}>{importing ? '正在导入…' : '＋ 添加角色'}</button>
                <button class="tl-button tl-me-button" onClick={() => go({ name: 'me' })}>
                    {user.avatar && <img class="tl-avatar" src={user.avatar} alt="" />}
                    <span>我的</span>
                </button>
            </header>
            <input ref={fileInput} type="file" accept={ACCEPT} multiple hidden onChange={onFiles} />
            {error && <p class="tl-error">{error}</p>}
            {unconfigured && (
                <button class="tl-card tl-setup-banner" onClick={() => go({ name: 'setup' })}>
                    <strong>还没连上 AI 模型</strong>
                    <span class="tl-card-snippet">设置好才能聊天，约 2 分钟</span>
                    <span class="tl-card-action">去设置</span>
                </button>
            )}
            {characters === null && !error && <p class="tl-muted">正在加载…</p>}
            {empty && (
                <section class="tl-empty">
                    <h2 class="tl-section-title">书架空空的</h2>
                    <p class="tl-muted">导入角色卡，或自己写一个角色</p>
                    <div class="tl-row">
                        <button class="tl-button tl-primary" disabled={importing} onClick={() => fileInput.current?.click()}>导入角色卡</button>
                        <button class="tl-button" onClick={() => go({ name: 'edit', avatar: '' })}>自己写一个</button>
                    </div>
                </section>
            )}
            {continueList.length > 0 && (
                <section class="tl-section">
                    <div class="tl-continue-list">
                        {continueList.map((r, i) => (
                            <ContinueCard entry={r} primary={i === 0} user={user} onOpenGroup={onOpenGroup} onMenu={setStoryMenu}
                                character={r.avatar ? byAvatar.get(r.avatar) : null}
                                group={r.group ? byGroup.get(String(r.group)) : null} />
                        ))}
                    </div>
                </section>
            )}
            {/* While the shelf holds only the app's bundled (English) characters, the sample is the first thing to try. */}
            {offerSample && (
                <button class="tl-card tl-offer" disabled={importing} onClick={addSample}>
                    <strong>试试中文示例角色「{SAMPLE_NAME}」</strong>
                    <span class="tl-card-snippet">雨巷旧书店的店主，温和爱聊天</span>
                </button>
            )}
            {!empty && characters !== null && (
                <input class="tl-input tl-search" type="search" placeholder="搜索角色或标签" value={query} onInput={e => setQuery(e.currentTarget.value)} />
            )}
            {allTags.length > 0 && (
                <div class="tl-chips" role="group" aria-label="按标签筛选">
                    <button class="tl-chip" aria-pressed={!tag ? 'true' : 'false'} onClick={() => setTag('')}>全部</button>
                    {allTags.map(t => <button class="tl-chip" aria-pressed={tag === t ? 'true' : 'false'} onClick={() => setTag(tag === t ? '' : t)}>{t}</button>)}
                </div>
            )}
            {!empty && characters !== null && (
                <section class="tl-section">
                    <h2 class="tl-section-title">{tag ? `「${tag}」` : '全部角色'} · {visible.length}</h2>
                    <div class="tl-grid">
                        {visible.map(c => <BookCard character={c} onMenu={setMenu} />)}
                    </div>
                    {visible.length === 0 && <p class="tl-muted">没找到相关角色</p>}
                </section>
            )}
            {/* Group chats open in the full app: used less, so after the characters. */}
            {visibleGroups.length > 0 && (
                <section class="tl-section">
                    <h2 class="tl-section-title">群聊 · {visibleGroups.length}</h2>
                    <div class="tl-grid">
                        {visibleGroups.map(g => (
                            <button class="tl-card tl-group" onClick={() => onOpenGroup(g)}>
                                <GroupCover group={g} />
                                <strong class="tl-card-name">{g.name}</strong>
                                <span class="tl-card-snippet">在原版界面打开</span>
                            </button>
                        ))}
                    </div>
                </section>
            )}
            {adding && (
                <Sheet title="添加角色" onClose={() => setAdding(false)}>
                    <SheetItem label="导入角色卡" hint="PNG、JSON 文件，可多选" onClick={() => { setAdding(false); fileInput.current?.click(); }} />
                    <SheetItem label="自己写一个角色" hint="填名字、设定和开场白" onClick={() => go({ name: 'edit', avatar: '' })} />
                    {!hasSample && <SheetItem label={`添加示例角色「${SAMPLE_NAME}」`} hint="可以直接聊，也能参考写法" onClick={addSample} />}
                </Sheet>
            )}
            {menu && (
                <Sheet title={menu.name} busy={starring} onClose={() => { if (!starring) setMenu(null); }}>
                    {menuChapter && <p class="tl-muted tl-sheet-note">继续到：{storyIdentityLabel(menuChapter, menu.name, undefined, user.handle)}</p>}
                    <SheetItem label={menu.date_last_chat || recent.some(r => r.avatar === menu.avatar) ? '继续阅读' : '开始阅读'}
                        hint={menu.date_last_chat || recent.some(r => r.avatar === menu.avatar) ? '回到上次的故事' : '从开场白开始'} onClick={() => go({ name: 'chat', avatar: menu.avatar, file: api.chatId(menu.chat) })} />
                    <SheetItem label="开始新故事" hint="从头开始，不带之前的记忆" onClick={() => go({ name: 'chat', avatar: menu.avatar, file: '', fresh: true })} />
                    <SheetItem label="角色主页" hint="简介、全部故事、编辑角色" onClick={() => go({ name: 'work', avatar: menu.avatar })} />
                    <SheetItem label={api.isFavorite(menu) ? '取消收藏' : '收藏'} hint={api.isFavorite(menu) ? '' : '排到书架最前'}
                        busy={starring} busyLabel={api.isFavorite(menu) ? '正在取消收藏…' : '正在收藏…'} onClick={() => toggleFavorite(menu)} />
                    <a class="tl-sheet-item" href={api.coverUrl(menu.avatar)} download={`${menu.name}.png`} onClick={() => setMenu(null)}>
                        <span class="tl-sheet-item-label">导出角色卡</span>
                        <span class="tl-sheet-item-hint">存成 PNG，可以发给朋友</span>
                    </a>
                    <SheetItem label="删除角色" hint="故事会一起删除" danger onClick={() => { setDeleting(menu); setMenu(null); }} />
                </Sheet>
            )}
            {storyMenu && byAvatar.has(storyMenu.avatar) && (
                <ContinueActions entry={storyMenu} character={byAvatar.get(storyMenu.avatar)} user={user} withBridge={withBridge}
                    onClose={() => setStoryMenu(null)}
                    onChanged={({ type }) => {
                        notify(type === 'delete' ? '故事已删除' : type === 'title' ? '标题已保存' : '故事已改名', 'info');
                        load();
                    }} />
            )}
            {deleting && (
                <ConfirmSheet title={`删除「${deleting.name}」？`} confirmLabel="删除" busyLabel="正在删除…" onClose={() => setDeleting(null)}
                    message="所有故事会一起删掉，找不回来。可以先导出角色卡备份。"
                    onConfirm={() => remove(deleting)} />
            )}
        </main>
    );
}
