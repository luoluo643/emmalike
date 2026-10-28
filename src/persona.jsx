import { useEffect, useRef, useState } from 'preact/hooks';
import * as engine from './engine.js';
import { fitImage, letterImage } from './images.js';
import { ConfirmSheet, EngineWait, Sheet, SheetItem, Spinner } from './ui.jsx';

// Pictures changed in this session get a version in their address, so the new one shows at once.
const versions = new Map();
export const personaThumb = id => `/thumbnail?type=persona&file=${encodeURIComponent(id)}${versions.has(id) ? `&v=${versions.get(id)}` : ''}`;
const bumped = id => versions.set(id, Date.now());

/** A brand-new account's persona shows the app's grey silhouette; give it the first character of its name instead. */
export async function giveLetterPicture(name) {
    const bridge = engine.getBridge();
    const id = bridge?.personaList?.()?.current;
    if (!id || !bridge.setPersonaImage) return;
    await bridge.setPersonaImage(id, await letterImage(name));
    bumped(id);
}

/** Name, picture and description of one persona; without `persona` it creates a new one. */
function PersonaForm({ persona, notify, onDone }) {
    const [name, setName] = useState(persona?.name ?? '');
    const [description, setDescription] = useState(persona?.fullDescription ?? '');
    const [image, setImage] = useState(null);
    const [preview, setPreview] = useState('');
    const [busy, setBusy] = useState(false);
    const input = useRef(null);
    useEffect(() => () => preview && URL.revokeObjectURL(preview), [preview]);

    const save = async () => {
        const bridge = engine.getBridge();
        if (!bridge || busy || !name.trim()) return;
        setBusy(true);
        try {
            const picture = image ? await fitImage(image, 400, 400) : null;
            if (persona) {
                if (picture) {
                    await bridge.setPersonaImage(persona.id, picture);
                    bumped(persona.id);
                }
                await bridge.editPersona(persona.id, { name, description });
                notify('身份已保存', 'info');
            } else {
                const id = await bridge.createPersona({ name, description, image: picture ?? await letterImage(name) });
                await bridge.setPersona(id, { autoLock: false });
                notify(`已新建身份「${name.trim()}」，现在用的就是它`, 'info');
            }
            onDone();
        } catch (e) {
            notify(e.message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div class="tl-settings-group tl-persona-form">
            <div class="tl-row">
                <button class="tl-persona-picture" aria-label="换头像" onClick={() => input.current?.click()}>
                    {preview || persona ? <img class="tl-avatar" src={preview || personaThumb(persona.id)} alt="" /> : <span>＋ 头像</span>}
                </button>
                <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => {
                    const file = e.currentTarget.files?.[0] ?? null;
                    e.currentTarget.value = '';
                    setImage(file);
                    setPreview(file ? URL.createObjectURL(file) : '');
                }} />
                <input class="tl-input" value={name} maxLength={60} aria-label="身份名字" placeholder="你在故事里叫什么" onInput={e => setName(e.currentTarget.value)} />
            </div>
            <label class="tl-field-label" for="tl-persona-description">介绍（会告诉 AI）</label>
            <textarea id="tl-persona-description" class="tl-input tl-field" rows={5} value={description} placeholder="例如：二十岁的大学生，话不多，喜欢下雨天。可以不填"
                onInput={e => setDescription(e.currentTarget.value)} />
            {!persona && <p class="tl-muted">不选头像就用名字的第一个字</p>}
            <div class="tl-row">
                <button class="tl-button tl-primary" disabled={busy || !name.trim()} aria-busy={busy ? 'true' : undefined} onClick={save}>{busy ? <><Spinner />正在保存…</> : persona ? '保存' : '新建'}</button>
                <button class="tl-button" disabled={busy} onClick={onDone}>取消</button>
            </div>
        </div>
    );
}

/**
 * Who the user is in the story (the full app's personas). In a story: pick one and choose whether this story keeps it.
 * From "我的" (`inStory` false): pick one without locking any story to it, and choose the default one.
 */
export function PersonaSheet({ characterName, notify, onClose, onOpenPanel, inStory = true }) {
    const read = () => engine.getBridge()?.personaList?.() ?? null;
    const [persona, setPersona] = useState(read);
    // What is being changed: the picked persona's id, or 'lock' / 'default' for the switches.
    const [busy, setBusy] = useState('');
    const [form, setForm] = useState(null);
    useEffect(() => engine.onEngine(type => { if (type === 'persona' || type === 'chat' || type === 'state') setPersona(read()); }), []);

    const apply = (id, options) => {
        const bridge = engine.getBridge();
        if (!bridge || busy) return;
        setBusy(id || (options?.isDefault !== undefined ? 'default' : 'lock'));
        bridge.setPersona(id, options)
            .then(next => {
                setPersona(next);
                if (id) notify(`现在的身份是「${next.list.find(p => p.id === next.current)?.name ?? ''}」`, 'info');
                else if (options?.isDefault !== undefined) notify(options.isDefault ? '已设为默认身份' : '不再使用默认身份', 'info');
                else notify(options?.lock ? '这个故事会一直用这个身份' : '这个故事不再固定身份', 'info');
            })
            .catch(e => notify(e.message))
            .finally(() => setBusy(''));
    };

    if (!persona) {
        return (
            <Sheet title="我的身份" onClose={onClose}>
                <EngineWait />
            </Sheet>
        );
    }
    const current = persona.list.find(p => p.id === persona.current);
    if (form === 'delete' && current) {
        return (
            <ConfirmSheet title={`删除「${current.name}」？`} confirmLabel="删除" busyLabel="正在删除…" onClose={() => setForm(null)}
                message="名字、头像和介绍会一起删掉，找不回来。现在会换成默认身份（没有就换成列表里第一个），固定用它的故事也会改用别的身份"
                onConfirm={() => engine.getBridge().deletePersona(current.id)
                    .then(next => {
                        setPersona(next);
                        setForm(null);
                        notify(`已删除「${current.name}」，现在的身份是「${next.list.find(p => p.id === next.current)?.name ?? ''}」`, 'info');
                    })
                    .catch(e => notify(e.message))} />
        );
    }
    if (form) {
        return (
            <Sheet title={form === 'new' ? '新建身份' : `修改「${current?.name ?? ''}」`} onClose={onClose}>
                <PersonaForm key={form} persona={form === 'new' ? null : current} notify={notify}
                    onDone={() => { setForm(null); setPersona(read()); }} />
            </Sheet>
        );
    }
    const several = persona.list.length > 1;
    return (
        <Sheet title="我的身份" onClose={onClose}>
            <p class="tl-muted tl-sheet-note">
                你在故事里的名字和介绍。{several && (inStory
                    ? (persona.autoLock ? '选中的身份会固定在这个故事里' : '')
                    : '在这里换，不影响固定了身份的故事')}
            </p>
            <div class="tl-persona-list tl-choice-list" role="radiogroup" aria-label="选择身份">
                {persona.list.map(p => (
                    <button key={p.id} class="tl-persona" role="radio" aria-checked={p.id === persona.current ? 'true' : 'false'} disabled={!!busy}
                        aria-busy={busy === p.id ? 'true' : undefined} onClick={() => p.id !== persona.current && apply(p.id, inStory ? undefined : { autoLock: false })}>
                        <img class="tl-avatar" src={personaThumb(p.id)} alt="" loading="lazy" decoding="async" />
                        <span class="tl-persona-text">
                            <strong>{busy === p.id && <Spinner />}{p.name || '未命名身份'}{busy === p.id ? ' · 正在切换…' : ''}</strong>
                            {(p.title || p.description) && <span class="tl-muted">{p.title || p.description}</span>}
                        </span>
                    </button>
                ))}
            </div>
            {current && <SheetItem label={`修改「${current.name}」`} hint="名字、头像和介绍" disabled={!!busy} onClick={() => setForm('edit')} />}
            <SheetItem label="＋ 新建身份" hint="用另一个名字和介绍进故事" disabled={!!busy} onClick={() => setForm('new')} />
            {current && several && engine.getBridge()?.deletePersona && (
                <SheetItem label={`删除「${current.name}」`} hint="无法恢复" danger disabled={!!busy} onClick={() => setForm('delete')} />
            )}
            {current && !inStory && several && (
                <button class="tl-sheet-item tl-switch-row" role="switch" aria-checked={persona.isDefault ? 'true' : 'false'} disabled={!!busy}
                    aria-busy={busy === 'default' ? 'true' : undefined} onClick={() => apply('', { isDefault: !persona.isDefault })}>
                    <span class="tl-sheet-item-label">把「{current.name}」设为默认身份</span>
                    <span class="tl-sheet-item-hint">没有固定身份的故事，打开时都换成它</span>
                </button>
            )}
            {current && inStory && several && (
                <button class="tl-sheet-item tl-switch-row" role="switch" aria-checked={persona.locked ? 'true' : 'false'} disabled={!!busy}
                    aria-busy={busy === 'lock' ? 'true' : undefined} onClick={() => apply('', { lock: !persona.locked })}>
                    <span class="tl-sheet-item-label">这个故事固定用「{current.name}」</span>
                    <span class="tl-sheet-item-hint">{persona.locked
                        ? `以后打开和${characterName ?? '这个角色'}的这个故事，都会自动换成这个身份`
                        : '不固定就用你最近选的身份'}</span>
                </button>
            )}
            {onOpenPanel && <SheetItem label="更多身份设置" hint="介绍放在哪、绑定世界书等" onClick={() => { onClose(); onOpenPanel('persona'); }} />}
        </Sheet>
    );
}
