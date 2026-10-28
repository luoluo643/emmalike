// "测试API连接" for the model sheet: the same short request as the setup page's "让 AI 说句话试试" (bridge testReply), so
// a switched model or connection profile can be checked on the spot. It waits at most the limit set on the setup page.
import { useEffect, useRef, useState } from 'preact/hooks';
import * as engine from './engine.js';

const FALLBACK_LIMIT = 90;

export function ConnectionTest({ disabled }) {
    const [state, setState] = useState(null); // null | { busy, waited, limit } | { ok, text, ms, model } | { error }
    const lock = useRef(false), alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);
    const run = async () => {
        const bridge = engine.getBridge();
        if (!bridge || lock.current) return;
        lock.current = true;
        let startedAt = bridge.testReplyDetailed ? 0 : Date.now(), limit = bridge.testReplyTimeout?.() ?? 0;
        const show = () => alive.current && setState({ busy: true, counting: !!startedAt, waited: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0, limit });
        show();
        const tick = setInterval(show, 250);
        try {
            // Older bridges have no time limit of their own: stop waiting here after FALLBACK_LIMIT seconds.
            if (!bridge.testReplyDetailed && !limit) limit = FALLBACK_LIMIT;
            const result = bridge.testReplyDetailed
                ? await bridge.testReplyDetailed({ onStart: info => { startedAt = info.startedAt; limit = info.limit; show(); } })
                : { text: await Promise.race([bridge.testReply(), new Promise((_, reject) => setTimeout(() =>
                    reject(new Error(`${limit} 秒没回复，可能在排队，换个模型试试`)), limit * 1000))]), ms: Date.now() - startedAt };
            if (alive.current) setState({ ok: !!result.text, text: result.text || '（回复是空的，换个模型试试）', ms: result.ms, model: result.model });
        } catch (error) {
            if (alive.current) setState({ error: error?.message || '没有收到回复' });
        } finally {
            clearInterval(tick);
            lock.current = false;
        }
    };
    const seconds = ms => ms === undefined ? '' : ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`;
    return (
        <div class="tl-connection-test">
            <button class="tl-button" disabled={disabled || !!state?.busy} onClick={run}>
                {state?.busy ? (state.counting ? `测试中 ${state.waited}${state.limit ? ` / ${state.limit}` : ''}s` : '正在连接…') : '测试API连接'}
            </button>
            {state?.ok !== undefined && (
                <p class={state.ok ? 'tl-muted' : 'tl-error'} role="status">
                    {state.ok ? '连上了。' : ''}{state.text}{[state.model, seconds(state.ms)].filter(Boolean).length ? `（${[state.model, seconds(state.ms)].filter(Boolean).join('，')}）` : ''}
                </p>
            )}
            {state?.error && <p class="tl-error" role="alert">{state.error}</p>}
        </div>
    );
}
