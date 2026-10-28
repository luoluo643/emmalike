// "故事里写过的番外" in the 番外 sheet: 番外 written inside the open story (inline-episodes.js), each one can be jumped
// to or copied into a story of its own (bridge extractEpisode). The story itself is never changed.
import { useMemo, useState } from 'preact/hooks';
import * as engine from './engine.js';
import { chatId } from './api.js';
import { findInlineEpisodes } from './inline-episodes.js';
import { EPISODE_KINDS } from './episode-intent.js';
import { SheetItem, Spinner } from './ui.jsx';

const snippet = message => `${message?.name ? `${message.name}：` : ''}${String(message?.mes ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)}`;

export function InlineEpisodesSection({ account, scope, available, reasons = [], busy, onBusy, onJump, onExtracted, notify }) {
    const bridge = engine.getBridge();
    const messages = useMemo(() => {
        const current = bridge?.currentChat?.();
        return current?.avatar === scope.avatar && chatId(current.file) === chatId(scope.file) ? bridge.readingMessages?.() ?? [] : null;
    }, [bridge, scope.avatar, scope.file]);
    const found = useMemo(() => messages ? findInlineEpisodes(messages) : [], [messages]);
    const variableCount = useMemo(() => messages ? bridge?.storyVariables?.() ?? 0 : 0, [messages]);
    const [form, setForm] = useState(null), [error, setError] = useState(''), [extracting, setExtracting] = useState(false);
    if (!messages) return null;
    const last = messages.length - 1;
    const open = item => { setError(''); setForm({ from: item.from, to: item.to, title: item.title, kind: item.kind, unhide: true, carryVariables: false }); };
    const setRange = (key, value) => setForm(f => {
        const n = Math.max(0, Math.min(last, Math.round(Number(value))));
        return Number.isFinite(n) ? { ...f, [key]: n } : f;
    });
    const valid = form && form.title.trim() && form.from <= form.to && form.to <= last;
    const hiddenCount = form ? messages.slice(form.from, form.to + 1).filter(m => m?.hidden).length : 0;
    const extract = async () => {
        if (!valid || busy) return;
        setError(''); onBusy?.(true); setExtracting(true);
        try {
            const result = await bridge.extractEpisode({ account, scope, from: form.from, to: form.to, title: form.title.trim(), kind: form.kind,
                unhide: form.unhide && hiddenCount > 0, carryVariables: form.carryVariables && variableCount > 0,
                expectedFirst: String(messages[form.from]?.mes ?? ''), expectedLast: String(messages[form.to]?.mes ?? '') });
            if (result?.kind !== 'extracted') throw new Error('没确认新故事写好了，去下面「需要处理的番外」看看');
            notify?.(`已拆成「${result.title}」，共 ${result.count} 条${result.unhidden ? `（${result.unhidden} 条隐藏的已放出来）` : ''}，已列在下面，可以打开接着写`, 'info');
            setForm(null);
            onExtracted?.();
        } catch (e) {
            setError(e?.message || '没拆成，再试一次');
        } finally { onBusy?.(false); setExtracting(false); }
    };
    return (
        <section class="tl-episode-section tl-inline-episodes">
            <h3>故事里写过的番外</h3>
            {!form && <>
                <p class="tl-muted">从「写个番外」这类请求算到「回到正文」为止，拆之前可以调整范围。拆出来的是副本，这个故事不变</p>
                {found.map(item => (
                    <div class="tl-episode-list-row" key={item.from}>
                        <SheetItem label={`${EPISODE_KINDS[item.kind] || '番外'} · ${item.title}`} hint={`第 ${item.from}～${item.to} 条 · ${item.count} 条`}
                            disabled={busy} onClick={() => onJump?.(item.from)} />
                        <button class="tl-button" disabled={busy} onClick={() => open(item)}>拆成独立故事</button>
                    </div>
                ))}
                {!found.length && <p class="tl-muted">没认出故事里写过的番外</p>}
                <button class="tl-link" disabled={busy || last < 0} onClick={() => open({ from: Math.max(0, last - 9), to: last, title: '', kind: 'side' })}>自己选一段拆出来</button>
            </>}
            {form && <div class="tl-episode-form">
                <label>类型<select class="tl-input" disabled={busy} value={form.kind} onChange={e => setForm(f => ({ ...f, kind: e.currentTarget.value }))}>
                    {Object.entries(EPISODE_KINDS).map(([value, label]) => <option value={value}>{label}</option>)}</select></label>
                <label>标题<input class="tl-input" maxLength={100} disabled={busy} value={form.title} onInput={e => setForm(f => ({ ...f, title: e.currentTarget.value }))} /></label>
                <div class="tl-row">
                    <label>从第<input class="tl-input" type="number" inputMode="numeric" min={0} max={last} disabled={busy} value={form.from} onChange={e => setRange('from', e.currentTarget.value)} />条</label>
                    <label>到第<input class="tl-input" type="number" inputMode="numeric" min={0} max={last} disabled={busy} value={form.to} onChange={e => setRange('to', e.currentTarget.value)} />条</label>
                </div>
                <p class="tl-muted">开头：{snippet(messages[form.from])}</p>
                <p class="tl-muted">结尾：{snippet(messages[form.to])}</p>
                <p class="tl-muted">共 {Math.max(0, form.to - form.from + 1)} 条。新故事只有这些消息和身份锁定，不带这个故事的其他状态；以后在新故事里接着写，不影响这个故事。</p>
                {hiddenCount > 0 && <>
                    <label class="tl-episode-switch"><input type="checkbox" checked={form.unhide} disabled={busy}
                        onChange={e => setForm(f => ({ ...f, unhide: e.currentTarget.checked }))} />把其中隐藏的 {hiddenCount} 条也放出来（推荐）</label>
                    <p class="tl-muted">隐藏的消息 AI 看不到，多半是总结后藏起来的。总结不会跟着拆过去，不放出来，新故事就少了这段前文</p>
                </>}
                {variableCount > 0 && <>
                    <label class="tl-episode-switch"><input type="checkbox" checked={form.carryVariables} disabled={busy}
                        onChange={e => setForm(f => ({ ...f, carryVariables: e.currentTarget.checked }))} />带上这个故事的变量（{variableCount} 个）</label>
                    <p class="tl-muted">状态栏、MVU 这类卡片的数值存在变量里，不带的话会在新故事里从头开始</p>
                </>}
                {!available && <p class="tl-error">暂时不能拆分{reasons.length ? `：${reasons.join('；')}` : '，先打开「分开写番外与平行线」'}。</p>}
                {error && <p class="tl-error" role="alert">{error}</p>}
                <div class="tl-row">
                    <button class="tl-button tl-primary" disabled={busy || !available || !valid} aria-busy={extracting ? 'true' : undefined} onClick={extract}>
                        {extracting ? <><Spinner />正在拆分…</> : '拆成独立故事'}</button>
                    <button class="tl-button" disabled={busy} onClick={() => setForm(null)}>取消</button>
                </div>
            </div>}
        </section>
    );
}
