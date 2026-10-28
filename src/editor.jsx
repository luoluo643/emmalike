import { useEffect, useRef, useState } from 'preact/hooks';
import * as api from './api.js';
import * as engine from './engine.js';
import { deleteDraft, getDraft, keepDraftNow, putDraft } from './drafts.js';
import { fitImage } from './images.js';
import { ConfirmSheet, PageHeader, Spinner, go, relativeTime, friendlyError } from './ui.jsx';

// What a character is made of, in the order a newcomer needs them. The first three are always open.
export const FIELDS = [
    { key: 'description', label: '人物设定', hint: '外貌、身份、经历、说话方式……写得越具体，角色越像。{{user}} 指你，{{char}} 指角色自己', rows: 10, main: true },
    { key: 'first_mes', label: '开场白', hint: '每个新故事的第一段，由角色说', rows: 6, main: true },
    { key: 'alternate_greetings', label: '备选开场白', hint: '开始新故事时可以在开场白之间左右切换', list: true, main: true },
    { key: 'personality', label: '性格', hint: '几个词或一句话', rows: 3 },
    { key: 'scenario', label: '场景', hint: '故事发生的时间、地点和处境', rows: 3 },
    { key: 'mes_example', label: '对话示例', hint: '示范角色怎么说话，多段之间用 <START> 隔开', rows: 6 },
    { key: 'creator_notes', label: '简介', hint: '显示在角色主页，不会发给模型', rows: 3 },
    { key: 'system_prompt', label: '角色专属系统提示词', hint: '留空就用预设里的', rows: 3 },
    { key: 'post_history_instructions', label: '后置提示词', hint: '放在聊天记录之后的指令，留空就用预设里的', rows: 3 },
];
const LABELS = Object.fromEntries(FIELDS.map(f => [f.key, f.label]));
const SAVE_DELAY_MS = 300;

const same = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');
const readAll = card => Object.fromEntries(FIELDS.map(f => [f.key, api.readCharacterField(card, f.key)]));
const changedKeys = (values, base) => FIELDS.map(f => f.key).filter(k => !same(values[k], base[k]));
const emptyValues = () => Object.fromEntries(FIELDS.map(f => [f.key, f.list ? [] : '']));

/** A draft started from `draft.base`; fields it did not change take the card's current text (three-way merge). */
function mergeDraft(draft, base) {
    const values = {};
    const conflicts = [];
    for (const { key } of FIELDS) {
        const mine = draft.values?.[key] ?? base[key];
        const changedByMe = !same(mine, draft.base?.[key] ?? base[key]);
        const changedOnCard = draft.base && !same(draft.base[key], base[key]);
        values[key] = changedByMe ? mine : base[key];
        if (changedByMe && changedOnCard && !same(mine, base[key])) conflicts.push(key);
    }
    return { values, conflicts };
}

/** The new name a draft holds (`{ name, conflict }`), or null when it did not rename; `conflict` when the card was renamed elsewhere too. */
function draftRename(draft, current) {
    const name = draft?.name?.trim();
    if (!name || name === (draft.baseName ?? current) || name === current) return null;
    return { name: draft.name, conflict: draft.baseName !== undefined && current !== draft.baseName };
}

function GreetingList({ value, onChange }) {
    const list = value ?? [];
    const set = (i, text) => onChange(list.map((g, j) => j === i ? text : g));
    return (
        <div class="tl-greetings">
            {list.map((greeting, i) => (
                <div class="tl-greeting">
                    <div class="tl-row tl-greeting-head">
                        <span class="tl-settings-label">第 {i + 2} 个开场白</span>
                        <button class="tl-link tl-danger-text" onClick={() => onChange(list.filter((_, j) => j !== i))}>删掉</button>
                    </div>
                    <textarea class="tl-input tl-field" rows={5} value={greeting} aria-label={`备选开场白 ${i + 1}`}
                        onInput={e => set(i, e.currentTarget.value)} />
                </div>
            ))}
            <button class="tl-button" onClick={() => onChange([...list, ''])}>＋ 再加一个开场白</button>
        </div>
    );
}

function Field({ field, value, onChange, changed }) {
    const id = `tl-field-${field.key}`;
    return (
        <div class="tl-field-group" data-changed={changed ? 'true' : undefined}>
            <label class="tl-field-label" for={field.list ? undefined : id}>
                {field.label}{changed && <span class="tl-tag">已修改</span>}
            </label>
            {field.hint && <span class="tl-field-hint">{field.hint}</span>}
            {field.list
                ? <GreetingList value={value} onChange={onChange} />
                : <textarea id={id} class="tl-input tl-field" rows={field.rows} value={value} spellcheck={false}
                    onInput={e => onChange(e.currentTarget.value)} />}
        </div>
    );
}

/**
 * Character editor: `avatar` edits an existing card, without it a new one is created. Every keystroke is kept as a
 * draft on this device; the card itself only changes on
 * "保存", which checks that nobody changed the same fields meanwhile, writes just those fields and reads them back.
 * The name and the picture change too: the picture right away, the name as the app renames (chats follow).
 */
export function CharacterEditor({ account: owner, avatar, notify, withBridge, onEditInNative, onDone }) {
    const creating = !avatar;
    const draftKey = creating ? 'create:new' : `character:${avatar}`;
    const [card, setCard] = useState(null);
    const [base, setBase] = useState(null);
    const [values, setValues] = useState(null);
    const [name, setName] = useState('');
    const [image, setImage] = useState(null);
    const [preview, setPreview] = useState('');
    const [found, setFound] = useState(null);
    const [previous, setPrevious] = useState(null);
    const [status, setStatus] = useState('');
    const [sheet, setSheet] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const saveTimer = useRef(0);
    const latest = useRef(null);
    const imageInput = useRef(null);
    const sameNameOk = useRef(false);

    useEffect(() => {
        engine.requestEngine('open');
        let alive = true;
        (async () => {
            const fetched = creating ? null : await api.getCharacter(avatar);
            if (alive && fetched) setCard(fetched);
            const start = creating ? emptyValues() : readAll(fetched);
            const draft = await getDraft(owner, draftKey);
            if (!alive) return;
            setBase(start);
            setValues(start);
            if (!creating) setName(fetched?.name ?? '');
            if (creating && draft) {
                setValues({ ...start, ...draft.values });
                setName(draft.name ?? '');
                setStatus('已接着上次没写完的继续');
            } else if (draft) {
                const rename = draftRename(draft, fetched?.name);
                if (rename || changedKeys(draft.values ?? {}, draft.base ?? start).length) setFound({ ...draft, ...mergeDraft(draft, start), rename });
            }
            if (!creating) setPrevious(await getDraft(owner, `previous:${avatar}`));
        })().catch(e => alive && setError(friendlyError(e.message) || '角色没加载出来'));
        return () => { alive = false; };
    }, [avatar]);

    const save = async snapshot => {
        try {
            await putDraft(owner, draftKey, snapshot);
            if (latest.current === snapshot) setStatus(creating ? '草稿已存在本机' : '草稿已存在本机 · 点「保存」才会改到角色');
        } catch (e) {
            setStatus(friendlyError(e.message));
        }
    };
    const schedule = (nextValues, nextName = name) => {
        const snapshot = creating ? { name: nextName, values: nextValues, at: Date.now() }
            : { avatar, base, values: nextValues, name: nextName, baseName: card?.name, at: Date.now() };
        latest.current = snapshot;
        setStatus('正在保存草稿…');
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => { saveTimer.current = 0; save(snapshot); }, SAVE_DELAY_MS);
    };
    // Leaving the page never loses the last keystrokes: going back in the app saves them as usual; closing,
    // reloading or switching away keeps them at once, since a save still waiting would not run.
    useEffect(() => {
        const keep = () => { if (saveTimer.current && latest.current) keepDraftNow(owner, draftKey, latest.current); };
        const hidden = () => { if (document.visibilityState === 'hidden') keep(); };
        addEventListener('pagehide', keep);
        document.addEventListener('visibilitychange', hidden);
        return () => {
            removeEventListener('pagehide', keep);
            document.removeEventListener('visibilitychange', hidden);
            if (saveTimer.current && latest.current) {
                clearTimeout(saveTimer.current);
                putDraft(owner, draftKey, latest.current).catch(() => { });
            }
        };
    }, []);

    const change = (key, value) => {
        const next = { ...values, [key]: value };
        setValues(next);
        schedule(next);
    };

    if (error) return <main class="tl-page"><PageHeader title="编辑角色" onBack={onDone} /><p class="tl-error">{error}</p></main>;
    if (!values) return <main class="tl-page"><PageHeader title={creating ? '新建角色' : '编辑角色'} onBack={onDone} /><p class="tl-muted">正在加载…</p></main>;

    const changed = creating ? [] : changedKeys(values, base);
    const title = creating ? '新建角色' : `编辑「${card?.name ?? ''}」`;

    const foundChanges = found ? [...changedKeys(found.values, base).map(k => LABELS[k]), ...found.rename ? ['名字'] : []] : [];
    const foundConflicts = found ? [...found.conflicts.map(k => LABELS[k]), ...found.rename?.conflict ? ['名字'] : []] : [];
    const restore = () => {
        const nextName = found.rename?.name ?? name;
        setValues(found.values);
        setName(nextName);
        schedule(found.values, nextName);
        setFound(null);
        notify(foundConflicts.length ? `已恢复草稿。${foundConflicts.join('、')}在别处也改过，请看一下` : '已恢复草稿', foundConflicts.length ? 'warning' : 'info');
    };
    const discard = async () => {
        clearTimeout(saveTimer.current);
        saveTimer.current = 0;
        latest.current = null;
        await deleteDraft(owner, draftKey);
        setFound(null);
        setValues(base);
        setName(card?.name ?? '');
        setStatus('');
    };

    const refreshEngine = () => {
        if (engine.engineState() === 'idle') return;
        withBridge('同步角色', b => b.refreshCharacter(avatar), { quiet: true }).catch(() => { });
    };

    const nameChanged = !creating && !!card && !!name.trim() && name.trim() !== card.name;
    const changedAny = changed.length > 0 || nameChanged || !!image;

    /**
     * Writes the changed fields, then the picture, then the name; `force` skips the check for fields changed
     * elsewhere (after the user agreed).
     */
    const apply = async ({ force = false } = {}) => {
        setSheet(null);
        if (!creating && !name.trim()) return notify('请输入名字');
        setBusy(true);
        try {
            // The app allows two characters with one name; say so before it happens.
            if (nameChanged && !sameNameOk.current) {
                const taken = (await api.getCharacters()).some(c => c.avatar !== avatar && c.name === name.trim());
                if (taken) {
                    setSheet({ type: 'same-name' });
                    return;
                }
            }
            if (changed.length) {
                const fresh = readAll(await api.getCharacter(avatar));
                const conflicts = changed.filter(k => !same(fresh[k], base[k]) && !same(fresh[k], values[k]));
                if (conflicts.length && !force) {
                    setSheet({ type: 'conflict', conflicts });
                    return;
                }
                const patch = Object.fromEntries(changed.map(k => [k, values[k]]));
                await api.updateCharacterFields(avatar, patch);
                const saved = await api.getCharacter(avatar);
                const after = readAll(saved);
                const wrong = changed.filter(k => !same(after[k], values[k]));
                if (wrong.length) throw new Error(`${wrong.map(k => LABELS[k]).join('、')}保存后对不上，修改还在草稿里`);
                const before = { avatar, values: fresh, at: Date.now(), fields: changed };
                await putDraft(owner, `previous:${avatar}`, before);
                setPrevious(before);
                setCard(saved);
                setBase(after);
                setValues(after);
            }
            if (image) {
                await api.setCharacterImage(avatar, await fitImage(image, 400, 600));
                setImage(null);
                setPreview(old => { if (old) URL.revokeObjectURL(old); return ''; });
            }
            // Until the name is changed too, the draft keeps it (the fields it held now match the card).
            const settled = () => {
                clearTimeout(saveTimer.current);
                saveTimer.current = 0;
                latest.current = null;
                return deleteDraft(owner, draftKey);
            };
            if (nameChanged) {
                const renamed = await withBridge('改名字', b => b.renameCharacter(avatar, name.trim()), { quiet: true })
                    .catch(e => { throw Object.assign(e, { shown: true }); });
                await settled();
                notify(`已保存，名字改成了「${name.trim()}」`, 'info');
                if (renamed && renamed !== avatar) go({ name: 'edit', avatar: renamed }, true);
                return;
            }
            await settled();
            setStatus('已保存');
            notify('已保存，之后的回复会用新的设定', 'info');
            refreshEngine();
        } catch (e) {
            if (!e.shown) notify(e.message);
        } finally {
            setBusy(false);
        }
    };

    const create = async () => {
        if (!name.trim()) return notify('先给角色起个名字');
        setBusy(true);
        try {
            const created = await api.createCharacter({ ...values, name: name.trim() }, image);
            clearTimeout(saveTimer.current);
            saveTimer.current = 0;
            latest.current = null;
            await deleteDraft(owner, draftKey);
            notify(`「${name.trim()}」已创建`, 'info');
            go({ name: 'work', avatar: created }, true);
        } catch (e) {
            notify(e.message);
        } finally {
            setBusy(false);
        }
    };

    const loadPrevious = () => {
        const next = { ...values };
        for (const key of previous.fields ?? FIELDS.map(f => f.key)) next[key] = previous.values[key];
        setValues(next);
        schedule(next);
        setSheet(null);
        notify('已载入上次保存前的内容，看过没问题再点「保存」', 'info');
    };

    return (
        <main class="tl-page tl-editor">
            <PageHeader title={title} onBack={onDone}>
                {creating
                    ? <button class="tl-button tl-primary" disabled={busy || !name.trim()} aria-busy={busy ? 'true' : undefined} onClick={create}>{busy ? <><Spinner />正在创建…</> : '创建'}</button>
                    : <button class="tl-button tl-primary" disabled={busy || !changedAny} aria-busy={busy ? 'true' : undefined} onClick={() => apply()}>{busy ? <><Spinner />正在保存…</> : '保存'}</button>}
            </PageHeader>

            {found && (
                <section class="tl-banner-card" role="status">
                    <p>找到 {relativeTime(found.at)}的草稿，改了：{foundChanges.join('、')}。
                        {foundConflicts.length > 0 && <strong> 其中{foundConflicts.join('、')}在角色上也被改过。</strong>}</p>
                    <div class="tl-row">
                        <button class="tl-button tl-primary" onClick={restore}>恢复草稿</button>
                        <button class="tl-button" onClick={() => setSheet({ type: 'discard' })}>放弃草稿</button>
                    </div>
                </section>
            )}

            <p class="tl-muted tl-editor-status" role="status">
                {status || (creating ? '填的内容会自动存在本机，点「创建」才会生成角色' : '改的内容会自动存在本机，点「保存」才会改到角色')}
            </p>

            {(creating || card) && (
                <section class="tl-section tl-create-head">
                    <button class="tl-create-avatar" onClick={() => imageInput.current?.click()} aria-label={creating ? '选择头像' : '换头像'}>
                        {preview || !creating ? <img src={preview || api.avatarUrl(avatar)} alt="" /> : <span>＋ 头像</span>}
                    </button>
                    <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" hidden
                        onChange={e => {
                            const file = e.currentTarget.files?.[0] ?? null;
                            e.currentTarget.value = '';
                            setImage(file);
                            setPreview(old => { if (old) URL.revokeObjectURL(old); return file ? URL.createObjectURL(file) : ''; });
                        }} />
                    <div class="tl-field-group">
                        <label class="tl-field-label" for="tl-field-name">名字</label>
                        <input id="tl-field-name" class="tl-input" value={name} maxLength={100} placeholder="角色叫什么"
                            onInput={e => { setName(e.currentTarget.value); schedule(values, e.currentTarget.value); }} />
                        <span class="tl-field-hint">{creating ? '头像可以不选，以后也能换；头像不存草稿' : '点头像换图，换的图不存草稿，点「保存」才换上；改名字后，以前的故事里也会换成新名字'}</span>
                    </div>
                </section>
            )}

            <section class="tl-section">
                {FIELDS.filter(f => f.main).map(field => (
                    <Field field={field} value={values[field.key]} changed={changed.includes(field.key)} onChange={v => change(field.key, v)} />
                ))}
            </section>

            <details class="tl-more-fields" open={FIELDS.some(f => !f.main && changed.includes(f.key)) || undefined}>
                <summary>更多设定（性格、场景、对话示例、简介、提示词）</summary>
                {FIELDS.filter(f => !f.main).map(field => (
                    <Field field={field} value={values[field.key]} changed={changed.includes(field.key)} onChange={v => change(field.key, v)} />
                ))}
            </details>

            {!creating && (
                <section class="tl-section">
                    <div class="tl-list">
                        {changed.length > 0 && (
                            <button class="tl-list-item" onClick={() => setSheet({ type: 'discard' })}>
                                <span class="tl-list-label">放弃这些修改</span>
                                <span class="tl-list-hint">回到角色现在的内容，草稿会删掉</span>
                            </button>
                        )}
                        {previous && (
                            <button class="tl-list-item" onClick={() => setSheet({ type: 'previous' })}>
                                <span class="tl-list-label">找回上次保存前的内容</span>
                                <span class="tl-list-hint">{relativeTime(previous.at)}保存的修改：{(previous.fields ?? []).map(k => LABELS[k]).join('、') || '全部'}</span>
                            </button>
                        )}
                        <button class="tl-list-item" onClick={() => onEditInNative(avatar)}>
                            <span class="tl-list-label">在原版界面里编辑</span>
                            <span class="tl-list-hint">改标签、深度提示词等</span>
                        </button>
                    </div>
                </section>
            )}

            {sheet?.type === 'same-name' && (
                <ConfirmSheet title="已经有同名的角色" confirmLabel="还是改" tone="primary"
                    message={`书架上已有一个叫「${name.trim()}」的角色，改了会有两个同名角色，靠头像区分`}
                    onClose={() => setSheet(null)} onConfirm={() => { sameNameOk.current = true; apply(); }} />
            )}
            {sheet?.type === 'conflict' && (
                <ConfirmSheet title="角色在别处也被改过" confirmLabel="用我的版本覆盖"
                    message={`${sheet.conflicts.map(k => LABELS[k]).join('、')}在你开始编辑后被别处改过。你的草稿还在。可以回角色主页重新打开看看最新内容，或者直接用你的版本覆盖`}
                    onClose={() => setSheet(null)} onConfirm={() => apply({ force: true })} />
            )}
            {sheet?.type === 'discard' && (
                <ConfirmSheet title="放弃修改" confirmLabel="放弃" message="草稿会删掉，角色保持现在的内容。"
                    onClose={() => setSheet(null)} onConfirm={() => { setSheet(null); discard(); }} />
            )}
            {sheet?.type === 'previous' && (
                <ConfirmSheet title="找回上次保存前的内容" confirmLabel="载入为草稿" tone="primary"
                    message="把上次保存前的内容放回编辑框，角色不会马上变。看过再点「保存」"
                    onClose={() => setSheet(null)} onConfirm={loadPrevious} />
            )}
        </main>
    );
}
