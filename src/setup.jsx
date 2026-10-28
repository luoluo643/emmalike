import { useEffect, useRef, useState } from 'preact/hooks';
import * as api from './api.js';
import * as engine from './engine.js';
import { giveLetterPicture } from './persona.jsx';
import { EngineStatus, PageHeader, go, goBack } from './ui.jsx';

// Chat completion services a newcomer is likely to have, the ones reachable from China first (the others fold away).
// `source` is the app's own name for each; `url` asks for an address as well (a relay that speaks the OpenAI format);
// `recommend` picks a model for them, the first pattern that matches one the service offers.
const PROVIDERS = [
    { source: 'deepseek', name: 'DeepSeek（深度求索）', hint: '国内可以直接用', help: '在 platform.deepseek.com 登录后，左侧“API keys”里创建', recommend: [/^deepseek-chat$/] },
    { source: 'siliconflow', name: '硅基流动', hint: '国内可以直接用，模型很多', help: '在 cloud.siliconflow.cn 的“API 密钥”页面创建', recommend: [/deepseek-ai\/DeepSeek-V3(\.\d+)?$/i, /Qwen\/Qwen3/i] },
    { source: 'moonshot', name: 'Kimi（月之暗面）', hint: '国内可以直接用', help: '在 platform.moonshot.cn 的“API Key 管理”里创建', recommend: [/^kimi-k2/i, /^moonshot-v1-32k$/] },
    { source: 'zai', name: '智谱 GLM', hint: '国内可以直接用', help: '在 bigmodel.cn 的“API Keys”页面创建', recommend: [/^glm-4\.\d+$/i, /^glm-4/i] },
    { source: 'custom', name: '中转站（OpenAI 格式）', hint: '一个地址加一个密钥', url: true, help: '地址一般以 /v1 结尾。请使用官方接口、有资质的中转或社区公益站' },
    { source: 'openrouter', name: 'OpenRouter', hint: '一个密钥用很多模型', abroad: true, help: '在 openrouter.ai/keys 创建', recommend: [/^deepseek\/deepseek-chat/i] },
    { source: 'makersuite', name: 'Google Gemini', abroad: true, help: '在 aistudio.google.com 点“Get API key”', recommend: [/gemini-[\d.]+-flash$/i] },
    { source: 'claude', name: 'Claude', abroad: true, help: '在 console.anthropic.com 的“API Keys”里创建', recommend: [/claude-sonnet/i] },
    { source: 'openai', name: 'OpenAI（ChatGPT）', abroad: true, help: '在 platform.openai.com 的“API keys”里创建', recommend: [/^gpt-4o-mini$/, /^gpt-4o$/] },
];
const SHOWN_MODELS = 50;

const recommended = (provider, models) => {
    for (const pattern of provider?.recommend ?? []) {
        const hit = models.find(m => pattern.test(m.id));
        if (hit) return hit.id;
    }
    return '';
};

function scrollTo(id, focus) {
    requestAnimationFrame(() => {
        const element = document.getElementById(id);
        element?.scrollIntoView({ block: 'start' });
        if (focus) document.getElementById(focus)?.focus({ preventScroll: true });
    });
}

/** 开始使用: who you are in stories, a model service, its key, a model, and one test sentence. */
export function SetupPage({ user, eng, notify, from, onAccountChanged }) {
    const bridge = eng.state === 'ready' ? engine.getBridge() : null;
    const askName = engine.wasFirstRun();
    const [name, setName] = useState(user.name || '');
    const [provider, setProvider] = useState(null);
    const [abroad, setAbroad] = useState(false);
    const [key, setKey] = useState('');
    const [url, setUrl] = useState('');
    const [showKey, setShowKey] = useState(false);
    const [busy, setBusy] = useState('');
    const [result, setResult] = useState(null);
    const [reply, setReply] = useState('');
    const [filter, setFilter] = useState('');
    const [typedModel, setTypedModel] = useState('');
    const [sample, setSample] = useState(null);
    const [addSample, setAddSample] = useState(true);
    const named = useRef('');
    // The profile this visit saved: reconnecting or picking a model updates it instead of making another one.
    const made = useRef('');
    // A try the app could not check: { previous } until a reply comes or the user keeps it.
    const pending = useRef(null);
    const [profileName, setProfileName] = useState('');
    const choices = bridge?.modelChoices?.() ?? null;
    const keeping = choices?.profiles && bridge?.connectionConfigured?.()
        ? choices.profiles.find(p => p.id === choices.profile)?.name || '现在用的设置' : '';

    useEffect(() => { engine.requestEngine('action'); }, []);
    // Offer the Chinese sample character while the shelf has only the app's bundled (English) ones.
    useEffect(() => {
        let alive = true;
        Promise.all([import('./sample.js'), api.getCharacters()])
            .then(([m, characters]) => alive && setSample(m.wantsSample(characters) ? m : null))
            .catch(() => { });
        return () => { alive = false; };
    }, []);

    /** Saves a try that could not be checked, now that a reply came or the user keeps it. */
    const keepTry = async () => {
        if (!pending.current || !bridge?.saveSetupProfile) return;
        pending.current = null;
        const profile = await bridge.saveSetupProfile({ profileName, profile: made.current }).catch(e => { notify(e.message); return null; });
        if (profile) { made.current = profile.id; setResult(r => r && ({ ...r, profile })); }
    };
    const leave = async () => {
        if (pending.current && bridge?.putBackProfile) {
            const { previous } = pending.current;
            pending.current = null;
            const name = await bridge.putBackProfile(previous).catch(() => '');
            if (name) notify(`没测通，已换回「${name}」`, 'info');
        }
        goBack({ name: 'library' });
    };
    /** Into a story: back to the one that sent us here, else the sample character or the latest story. */
    const finish = async () => {
        await keepTry();
        if (from === 'story') return goBack({ name: 'library' });
        setBusy('finish');
        try {
            if (sample && addSample) {
                const avatar = await sample.addSample();
                return go({ name: 'chat', avatar, file: '', fresh: true }, true);
            }
            const [recent] = await api.getRecentChats(1);
            if (recent?.avatar) return go({ name: 'chat', avatar: recent.avatar, file: api.chatId(recent.file_name) }, true);
            const [first] = await api.getCharacters();
            go(first ? { name: 'chat', avatar: first.avatar, file: '' } : { name: 'library' }, true);
        } catch (e) {
            notify(e.message);
            go({ name: 'library' }, true);
        } finally {
            setBusy('');
        }
    };

    const choose = p => {
        setProvider(p);
        if (!made.current) setProfileName(p.name.replace(/（.*?）|\(.*?\)/g, '').trim());
        setResult(null);
        setFilter('');
        scrollTo('tl-setup-key', p.url ? 'tl-setup-url' : 'tl-setup-secret');
    };

    const pickModel = async (id, quiet = false) => {
        setBusy(id);
        try {
            const next = await bridge.chooseModel(id, { profile: made.current });
            setResult(r => ({ ...r, ...next }));
        } catch (e) {
            if (!quiet) notify(e.message);
        } finally {
            setBusy('');
        }
    };

    const connect = async () => {
        if (!bridge || busy) return;
        setBusy('connect');
        setResult(null);
        setReply('');
        let outcome = null;
        try {
            const wanted = name.trim();
            if (askName && wanted && named.current !== wanted) {
                await bridge.renamePersona(wanted).catch(() => { });
                // A new account's persona has the app's grey silhouette; its first character looks friendlier.
                await giveLetterPicture(wanted).then(onAccountChanged).catch(() => { });
                named.current = wanted;
            }
            outcome = await bridge.setupConnection({ source: provider.source, key, url, profileName, profile: made.current });
            if (outcome.profile) made.current = outcome.profile.id;
            // A new try replaces an earlier unchecked one; what to put back stays the profile from before both.
            pending.current = outcome.pending ? { previous: pending.current?.previous ?? outcome.pending.previous } : null;
            setResult(outcome);
            setTypedModel(outcome.models.length ? '' : outcome.current || '');
            if (!outcome.connected) notify(`没连上。检查密钥是否复制完整；海外服务需要服务器能连海外${outcome.restored ? `。已换回原来的「${outcome.restored}」` : ''}`, 'warning');
            scrollTo('tl-setup-result');
        } catch (e) {
            notify(e.message);
        } finally {
            setBusy('');
        }
        const best = outcome?.connected ? recommended(provider, outcome.models) : '';
        if (best && best !== outcome.current) await pickModel(best, true);
    };

    const tryIt = async () => {
        setBusy('test');
        setReply('');
        try {
            const text = await bridge.testReply();
            setReply(text || '（回复是空的，换个模型试试）');
            // A reply settles what the connection check could not tell.
            if (text) { setResult(r => r && ({ ...r, state: 'ok' })); await keepTry(); }
        } catch (e) {
            notify(`试一句没成功：${e.message}`);
        } finally {
            setBusy('');
        }
    };

    const run = (what, action) => {
        setBusy(what);
        action().then(next => setResult(r => r && ({ ...r, ...next }))).catch(e => notify(e.message)).finally(() => setBusy(''));
    };

    const canConnect = provider && key.trim() && (!provider.url || url.trim());
    const best = result?.connected ? recommended(provider, result.models) : '';
    const needle = filter.trim().toLowerCase();
    const models = (result?.models ?? []).filter(m => !needle || `${m.id} ${m.name}`.toLowerCase().includes(needle));
    const shown = models.slice(0, SHOWN_MODELS);
    if (result?.current && !shown.some(m => m.id === result.current)) {
        const current = models.find(m => m.id === result.current);
        if (current) shown.unshift(current);
    }
    const providers = PROVIDERS.filter(p => !p.abroad || abroad || provider?.source === p.source);
    return (
        <main class="tl-page tl-setup">
            <PageHeader title={keeping ? '新建连接' : '开始使用'} onBack={leave}>
                {!result?.connected && <button class="tl-button" onClick={leave}>先跳过</button>}
            </PageHeader>
            <p class="tl-muted">{keeping
                ? `会新建一个连接，「${keeping}」会保留，随时能换回`
                : '连上 AI 模型就能聊天，约 2 分钟。之后可在「我的」里改'}</p>
            {choices && !choices.profiles && bridge?.connectionConfigured?.() && <p class="tl-error">没开启「连接配置」扩展，这里会替换当前连接。开启后可保存多个连接</p>}

            {askName && (
                <section class="tl-section">
                    <h2 class="tl-section-title">1. 你在故事里叫什么</h2>
                    <input class="tl-input" value={name} aria-label="你的名字" placeholder="例如：小林" onInput={e => setName(e.currentTarget.value)} />
                    <p class="tl-muted tl-choice-hint">角色会这样叫你，之后可改</p>
                </section>
            )}

            <section class="tl-section">
                <h2 class="tl-section-title">{askName ? '2' : '1'}. 选一个模型服务</h2>
                <div class="tl-list" role="radiogroup" aria-label="AI 模型">
                    {providers.map(p => (
                        <button key={p.source} class="tl-list-item tl-choice-row" data-pick role="radio" aria-checked={provider?.source === p.source ? 'true' : 'false'}
                            onClick={() => choose(p)}>
                            <span class="tl-list-label tl-sheet-item-label">{p.name}</span>
                            <span class="tl-list-hint">{p.abroad ? ['需要服务器能连海外', p.hint].filter(Boolean).join('；') : p.hint}</span>
                        </button>
                    ))}
                    {!abroad && !providers.some(p => p.abroad) && (
                        <button class="tl-list-item" onClick={() => setAbroad(true)}>
                            <span class="tl-list-label">更多服务</span>
                            <span class="tl-list-hint">OpenRouter、Gemini、Claude、OpenAI · 需要服务器能连海外</span>
                        </button>
                    )}
                </div>
            </section>

            {provider && (
                <section class="tl-section" id="tl-setup-key">
                    <h2 class="tl-section-title">{askName ? '3' : '2'}. 填写{provider.url ? '地址和' : ''}密钥</h2>
                    {provider.url && (
                        <input id="tl-setup-url" class="tl-input" value={url} aria-label="地址" placeholder="地址，例如 https://example.com/v1" autocomplete="off"
                            onInput={e => setUrl(e.currentTarget.value)} />
                    )}
                    <div class="tl-row">
                        <input id="tl-setup-secret" class="tl-input" type={showKey ? 'text' : 'password'} value={key} aria-label="密钥" placeholder="粘贴密钥（API Key）"
                            autocomplete="off" spellcheck={false} onInput={e => setKey(e.currentTarget.value)} />
                        <button class="tl-button" onClick={() => setShowKey(v => !v)}>{showKey ? '隐藏' : '显示'}</button>
                    </div>
                    <p class="tl-muted tl-choice-hint">{provider.help}。密钥只保存在你的酒馆服务器上。</p>
                    {choices?.profiles && <label class="tl-field-group">新连接的名字
                        <input class="tl-input" value={profileName} aria-label="新连接的名字" placeholder="例如：DeepSeek" maxLength={60} disabled={!!made.current}
                            onInput={e => setProfileName(e.currentTarget.value)} />
                        <span class="tl-muted tl-choice-hint">{made.current ? '已经存好了；再连接或换模型会更新它。' : '连上后用这个名字保存'}</span></label>}
                    <div class="tl-row">
                        <button class="tl-button tl-primary" disabled={!canConnect || !bridge || !!busy} onClick={connect}>
                            {busy === 'connect' ? '正在连接…' : result ? '重新连接' : '连接'}
                        </button>
                    </div>
                    {!bridge && <EngineStatus eng={eng} meanwhile="填好就能连接" />}
                </section>
            )}

            {result && (
                <section class="tl-section" id="tl-setup-result">
                    <h2 class="tl-section-title">{askName ? '4' : '3'}. {!result.connected ? '没连上' : result.state === 'unverified' ? '试一句，确认能用' : '选一个模型，试一句'}</h2>
                    {!result.connected && (
                        <p class="tl-error">没连上。检查密钥是否复制完整、有没有多余空格；{provider.url ? '地址一般以 http 开头、/v1 结尾；' : ''}海外服务需要服务器能连海外</p>
                    )}
                    {result.connected && !result.profile && result.pending && <p class="tl-muted">试一句有回复、或点「完成」后存成新连接「{profileName}」；没确认就离开会换回原来的连接</p>}
                    {result.profile && <p class="tl-muted">已存成新连接「{result.profile.name}」{result.kept ? `；原来的设置也存成了「${result.kept}」` : ''}。可在「模型与预设」里切换</p>}
                    {!result.connected && result.restored && <p class="tl-muted">已换回原来的「{result.restored}」，什么都没改。</p>}
                    {result.connected && result.state === 'unverified' && (
                        <p class="tl-error">{provider.url
                            ? '没读到模型列表。填上模型名点「试一句」，有回复就能用'
                            : '这家服务没法提前检查密钥，点「试一句」，有回复就能用'}</p>
                    )}
                    {result.connected && provider.url && result.models.length === 0 && (
                        <div class="tl-row">
                            <input class="tl-input" value={typedModel} aria-label="模型名" placeholder="模型名，问给你地址的人" autocomplete="off" spellcheck={false}
                                onInput={e => setTypedModel(e.currentTarget.value)} />
                            <button class="tl-button" disabled={!!busy || !typedModel.trim() || typedModel.trim() === result.current}
                                onClick={() => run('model', () => bridge.setCustomModel(typedModel, { profile: made.current }))}>用这个</button>
                        </div>
                    )}
                    {result.connected && (
                        <>
                            {best && <p class="tl-muted tl-choice-hint">已选好推荐模型，直接用就行</p>}
                            {result.models.length > 8 && (
                                <input class="tl-input tl-search" type="search" placeholder={`搜索模型（共 ${result.models.length} 个）`} aria-label="搜索模型"
                                    value={filter} onInput={e => setFilter(e.currentTarget.value)} />
                            )}
                            {shown.length > 0 && (
                                <div class="tl-list" role="radiogroup" aria-label="模型">
                                    {shown.map(m => (
                                        <button key={m.id} class="tl-list-item tl-choice-row" role="radio" aria-checked={m.id === result.current ? 'true' : 'false'}
                                            disabled={!!busy} onClick={() => m.id !== result.current && pickModel(m.id)}>
                                            <span class="tl-list-label tl-sheet-item-label">{m.name}{m.id === best ? '（推荐）' : ''}{busy === m.id ? ' · 正在切换…' : ''}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                            {models.length > shown.length && <p class="tl-muted tl-choice-hint">还有 {models.length - shown.length} 个，输入名字搜索。</p>}
                            {needle && models.length === 0 && <p class="tl-muted tl-choice-hint">没有找到这个模型。</p>}
                            {sample && from !== 'story' && (
                                <label class="tl-check-row">
                                    <input type="checkbox" checked={addSample} onChange={e => setAddSample(e.currentTarget.checked)} />
                                    <span>顺便添加中文示例角色「{sample.SAMPLE_NAME}」，完成后直接和她聊</span>
                                </label>
                            )}
                            <div class="tl-row">
                                <button class="tl-button" disabled={!!busy} onClick={tryIt}>{busy === 'test' ? '正在等回复…' : '试一句'}</button>
                                <button class="tl-button tl-primary" disabled={!!busy} onClick={finish}>{busy === 'finish' ? '正在打开…' : '完成，开始聊天'}</button>
                            </div>
                            {reply && <p class="tl-setup-reply">{reply}</p>}
                        </>
                    )}
                </section>
            )}
        </main>
    );
}
