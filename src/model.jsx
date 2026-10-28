import { useEffect, useState } from 'preact/hooks';
import * as engine from './engine.js';
import { ConfirmSheet, EngineWait, Sheet, SheetItem, Spinner, go } from './ui.jsx';
import { ConnectionTest } from './connection-test.jsx';

// The app's bundled preset is called "Default".
const presetName = name => name === 'Default' ? '默认' : name;

/** Short line for menus: the selected connection profile, else the model in use. */
export function modelSummary(choices) {
    if (!choices) return '';
    const profile = choices.profiles?.find(p => p.id === choices.profile);
    const model = choices.connection?.model || choices.connection?.source || choices.connection?.api || '';
    return profile ? profile.name : model;
}

/** The preset in use, for buttons ("我的预设"); empty when this API has no preset list. */
export function currentPresetName(choices) {
    const preset = choices?.presets?.find(p => p.id === choices.preset);
    return preset ? presetName(preset.name) : '';
}

/**
 * Deletes presets or connection profiles: the list, and a confirmation per item (open, saying "正在删除…", until done).
 * `kind` is 'preset' or 'profile'; `onDone` gets the choices after the change.
 */
function DeleteChoicesSheet({ kind, choices, notify, onDone, onClose }) {
    const [target, setTarget] = useState(null);
    const preset = kind === 'preset';
    const items = (preset ? choices.presets : choices.profiles) ?? [];
    const inUse = preset ? choices.preset : choices.profile;
    const nameOf = item => preset ? presetName(item.name) : item.name;
    if (target) {
        const current = target.id === inUse;
        return (
            <ConfirmSheet title={`删除「${nameOf(target)}」？`} confirmLabel="删除" busyLabel="正在删除…" onClose={() => setTarget(null)}
                message={preset
                    ? `${current ? '它正在用，删掉后会换成列表里的第一个预设。' : ''}预设里的提示词条目和参数会一起删掉，找不回来`
                    : `${current ? '它正在用，删掉后现在的模型和密钥照常能用，只是不再记在这个连接里。' : ''}删掉就找不回来了，密钥不受影响`}
                onConfirm={() => {
                    const bridge = engine.getBridge();
                    return (preset ? bridge.deletePreset(target.id) : bridge.deleteProfile(target.id))
                        .then(next => {
                            notify(`已删除「${nameOf(target)}」${preset && current ? `，现在用「${currentPresetName(next)}」` : ''}`, 'info');
                            onDone(next);
                        })
                        .catch(e => notify(e.message));
                }} />
        );
    }
    return (
        <Sheet title={preset ? '删除预设' : '删除连接'} onClose={onClose}>
            <p class="tl-muted tl-sheet-note">{preset ? '点一个删掉，删之前会再问一次' : '只删存起来的连接，不影响现在的连接和密钥'}</p>
            {preset && items.length < 2 && <p class="tl-muted tl-sheet-note">只剩一个预设，不能再删</p>}
            {items.map(item => (
                <SheetItem key={item.id} label={nameOf(item)} hint={item.id === inUse ? '正在用' : ''} danger
                    disabled={preset && items.length < 2} onClick={() => setTarget(item)} />
            ))}
        </Sheet>
    );
}

/** Just the presets of the current API, reachable from the story in one tap (the quick row and the story menu). */
export function PresetPickSheet({ notify, onModel, onClose }) {
    const [choices, setChoices] = useState(() => engine.getBridge()?.modelChoices?.() ?? null);
    const [busy, setBusy] = useState('');
    // Opened while the full app prepares: the list comes in by itself once it is ready.
    useEffect(() => engine.onEngine(type => { if (type === 'state') setChoices(current => current ?? engine.getBridge()?.modelChoices?.() ?? null); }), []);
    const [filter, setFilter] = useState('');
    const [deleting, setDeleting] = useState(false);
    const generating = engine.getBridge()?.isGenerating();
    const pick = preset => {
        const bridge = engine.getBridge();
        if (!bridge || busy || preset.id === choices.preset) return;
        setBusy(preset.id);
        bridge.selectPreset(preset.id)
            .then(next => { setChoices(next); notify(`已换成「${presetName(preset.name)}」`, 'info'); onClose(); })
            .catch(e => notify(e.message))
            .finally(() => setBusy(''));
    };
    const query = filter.trim().toLowerCase();
    const shown = (choices?.presets ?? []).filter(p => !query || presetName(p.name).toLowerCase().includes(query));
    if (deleting) {
        return <DeleteChoicesSheet kind="preset" choices={choices} notify={notify} onClose={() => setDeleting(false)}
            onDone={next => { setChoices(next); setDeleting(false); }} />;
    }
    return (
        <Sheet title="换预设" onClose={onClose}>
            {!choices?.presets?.length
                ? choices ? <p class="tl-muted tl-sheet-note">这个连接没有可选的预设</p> : <EngineWait />
                : (
                    <>
                        <p class="tl-sheet-section">换一个预设</p>
                        <p class="tl-muted tl-sheet-note">预设决定提示词和回复参数，换了从下一次回复起生效{generating ? '。生成完才能切换' : ''}</p>
                        {choices.presets.length > 8 && (
                            <div class="tl-chapter-search">
                                <input class="tl-input tl-search" type="search" placeholder="搜索预设" aria-label="搜索预设" value={filter} onInput={e => setFilter(e.currentTarget.value)} />
                            </div>
                        )}
                        <div class="tl-choice-list" role="radiogroup" aria-label="预设">
                            {shown.map(p => (
                                <button key={p.id} class="tl-sheet-item tl-choice-row" role="radio" aria-checked={p.id === choices.preset ? 'true' : 'false'}
                                    disabled={!!busy || generating} aria-busy={busy === p.id ? 'true' : undefined} onClick={() => pick(p)}>
                                    <span class="tl-sheet-item-label">{busy === p.id && <Spinner />}{presetName(p.name)}{busy === p.id ? ' · 正在切换…' : ''}</span>
                                </button>
                            ))}
                        </div>
                        <SheetItem label="开关和编辑条目" hint={`「${presetName(choices.presets.find(p => p.id === choices.preset)?.name ?? '')}」的提示词条目、回复长度和随机程度`}
                            onClick={() => { onClose(); go({ name: 'preset' }); }} />
                        <SheetItem label="删除预设…" hint="删掉不用的预设" disabled={!!busy || generating} onClick={() => setDeleting(true)} />
                    </>
                )}
            <SheetItem label="模型与连接" hint="换模型或连接" onClick={() => { onClose(); onModel(); }} />
        </Sheet>
    );
}

/**
 * The model under a profile's name. For the profile in use, the model actually in use: it can differ from the saved one
 * when the model was changed in the full app without updating the profile.
 */
function profileModelHint(profile, current) {
    if (current && profile.model && current !== profile.model) {
        return <span class="tl-sheet-item-hint">{current}（配置里存的是 {profile.model}，下次换回这个配置会用它）</span>;
    }
    const model = current || profile.model;
    return model ? <span class="tl-sheet-item-hint">{model}</span> : null;
}

/** Switch the connection profile (API + model + preset saved together) or the preset, without opening the full app. */
export function ModelSheet({ notify, onOpenPanel, onClose }) {
    const read = () => engine.getBridge()?.modelChoices?.() ?? null;
    const [choices, setChoices] = useState(read);
    const [busy, setBusy] = useState('');
    useEffect(() => engine.onEngine(type => { if (type === 'state') setChoices(current => current ?? read()); }), []);
    const [models, setModels] = useState(() => engine.getBridge()?.modelOptions?.() ?? { models: [], current: '' });
    const [filter, setFilter] = useState('');
    // 'preset' or 'profile' while their delete list is open.
    const [deleting, setDeleting] = useState('');

    const pick = (kind, id, name) => {
        const bridge = engine.getBridge();
        if (!bridge || busy) return;
        setBusy(id);
        // A model chosen while a profile is in use goes into that profile too, so the profile list and the model in
        // use stay the same (the profile is applied again on the next switch or when the app loads it).
        const profile = kind === 'model' ? choices.profiles?.find(p => p.id === choices.profile) : null;
        const action = kind === 'profile' ? bridge.selectProfile(id) : kind === 'model' ? bridge.chooseModel(id, { profile: profile?.id ?? '' }).then(() => bridge.modelChoices()) : bridge.selectPreset(id);
        action
            .then(next => {
                setChoices(next);
                setModels(bridge.modelOptions?.() ?? { models: [], current: '' });
                const connected = next.connection?.connected;
                const saved = profile ? `，已存进连接「${profile.name}」` : '';
                notify(kind === 'profile' && !connected ? `已换成「${name}」，但没连上，检查密钥或网络` : `已换成「${name}」${saved}`, connected || kind !== 'profile' ? 'info' : 'warning');
            })
            .catch(e => notify(e.message))
            .finally(() => setBusy(''));
    };

    if (!choices) {
        return (
            <Sheet title="模型与预设" onClose={onClose}>
                <EngineWait />
            </Sheet>
        );
    }
    if (deleting) {
        return <DeleteChoicesSheet kind={deleting} choices={choices} notify={notify} onClose={() => setDeleting('')}
            onDone={next => { setChoices(next); setDeleting(''); }} />;
    }
    const { connection } = choices;
    const now =[connection.source || connection.api, connection.model].filter(Boolean).join(' · ') || '未设置';
    const generating = engine.getBridge()?.isGenerating();
    return (
        <Sheet title="模型与预设" onClose={onClose}>
            <p class="tl-muted tl-sheet-note">现在用的是 {now}{connection.connected ? '' : '（发送时自动连接）'}{generating ? '。生成完才能切换' : ''}</p>
            <ConnectionTest disabled={!!busy || generating} />
            {/* The model is changed most, so it comes first; connections are switched less often. */}
            {models.models.length > 0 && (
                <>
                    <p class="tl-sheet-section">模型</p>
                    {models.models.length > 12 && (
                        <div class="tl-chapter-search">
                            <input class="tl-input tl-search" type="search" placeholder="搜索模型" aria-label="搜索模型" value={filter} onInput={e => setFilter(e.currentTarget.value)} />
                        </div>
                    )}
                    <div class="tl-choice-list" role="radiogroup" aria-label="模型">
                        {models.models.filter(m => !filter.trim() || `${m.id} ${m.name}`.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 80).map(m => (
                            <button key={m.id} class="tl-sheet-item tl-choice-row" role="radio" aria-checked={m.id === models.current ? 'true' : 'false'}
                                disabled={!!busy || generating} aria-busy={busy === m.id ? 'true' : undefined} onClick={() => m.id !== models.current && pick('model', m.id, m.name)}>
                                <span class="tl-sheet-item-label">{busy === m.id && <Spinner />}{m.name}{busy === m.id ? ' · 正在切换…' : ''}</span>
                            </button>
                        ))}
                    </div>
                </>
            )}
            {choices.presets?.length > 0 && (
                <>
                    <p class="tl-sheet-section">预设（采样参数和提示词）</p>
                    <div class="tl-choice-list" role="radiogroup" aria-label="预设">
                        {choices.presets.map(p => (
                            <button key={p.id} class="tl-sheet-item tl-choice-row" role="radio" aria-checked={p.id === choices.preset ? 'true' : 'false'}
                                disabled={!!busy || generating} aria-busy={busy === p.id ? 'true' : undefined} onClick={() => p.id !== choices.preset && pick('preset', p.id, presetName(p.name))}>
                                <span class="tl-sheet-item-label">{busy === p.id && <Spinner />}{presetName(p.name)}{busy === p.id ? ' · 正在切换…' : ''}</span>
                            </button>
                        ))}
                    </div>
                </>
            )}
            {choices.presets?.length > 0 && <SheetItem label="调整这个预设" hint="回复长度、随机程度、提示词条目的开关" onClick={() => { onClose(); go({ name: 'preset' }); }} />}
            {choices.presets?.length > 0 && <SheetItem label="删除预设…" hint="删掉不用的预设" disabled={!!busy || generating} onClick={() => setDeleting('preset')} />}
            {choices.profiles?.length > 0 && (
                <>
                    <p class="tl-sheet-section">连接（模型和预设一起换）</p>
                    <div class="tl-choice-list" role="radiogroup" aria-label="连接">
                        {choices.profiles.map(p => (
                            <button key={p.id} class="tl-sheet-item tl-choice-row" role="radio" aria-checked={p.id === choices.profile ? 'true' : 'false'}
                                disabled={!!busy || generating} aria-busy={busy === p.id ? 'true' : undefined} onClick={() => p.id !== choices.profile && pick('profile', p.id, p.name)}>
                                <span class="tl-sheet-item-label">{busy === p.id && <Spinner />}{p.name}{busy === p.id ? ' · 正在切换…' : ''}</span>
                                {profileModelHint(p, p.id === choices.profile ? models.current : '')}
                            </button>
                        ))}
                    </div>
                </>
            )}
            <SheetItem label="＋ 新建连接" hint="现在的连接会保留" onClick={() => { onClose(); go({ name: 'setup' }); }} />
            {choices.profiles?.length > 0 && <SheetItem label="删除连接…" hint="删掉存起来的连接，密钥不受影响" disabled={!!busy || generating} onClick={() => setDeleting('profile')} />}
            <SheetItem label="更多连接设置" hint="在原版界面里改" onClick={() => { onClose(); onOpenPanel('api'); }} />
        </Sheet>
    );
}
