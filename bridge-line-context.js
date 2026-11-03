// What a reply on one of the story's own lines is written from (src/own-lines.js sentIndices): the messages the line
// does not send are taken out of the app's generation chat, through the extension's generate_interceptor (manifest).
// Only the copy being sent changes; the story is not. Installed in every page the app runs (the shell's engine and the
// full app opened by itself), so a line sends the same either way. When Horae keeps the lines, Horae does this.
import { replyLine, sentIndices } from './src/own-lines.js';

export const INTERCEPTOR = 'tavernLiteLineContext';
// A reply that replaces or goes on with the last one stays on that message's line, whatever is asked for next.
const AFTER_LAST = new Set(['regenerate', 'swipe', 'continue']);

function horaeKeepsLines(win) {
    const horae = win.Horae;
    if (!horae?.isEnabled?.() || typeof horae.getStorylines !== 'function') return false;
    return horae.getSettings?.()?.storylinesEnabled !== false;
}

/**
 * Takes out of `sent` (the app's chat for this generation) what the reply's line does not send. The app hands over
 * shallow copies of its messages ({...message, mes}); each is known by its `extra`, still the message's own object.
 */
export function holdBack(sent, chat, metadata, type) {
    if (!Array.isArray(sent) || !chat?.length) return 0;
    const keep = sentIndices(chat, metadata, replyLine(chat, metadata, { afterLast: AFTER_LAST.has(type) }));
    if (!keep) return 0;
    // The message being answered is always sent, also when its line was not recorded yet (the full app without the shell).
    keep.add(chat.length - 1);
    const at = new Map();
    chat.forEach((message, i) => {
        at.set(message, i);
        if (message?.extra && typeof message.extra === 'object') at.set(message.extra, i);
    });
    // A message saved without extra (an older or imported story): the next one in order from the same speaker at the same time.
    const same = (a, b) => a?.name === b?.name && !!a?.is_user === !!b?.is_user && a?.send_date === b?.send_date;
    let from = 0;
    const indices = sent.map(entry => {
        let index = at.get(entry) ?? at.get(entry?.extra);
        if (index === undefined && entry?.send_date) for (let j = from; j < chat.length; j++) if (same(chat[j], entry)) { index = j; break; }
        if (index !== undefined) from = index + 1;
        return index;
    });
    let removed = 0;
    for (let i = sent.length - 1; i >= 0; i--) {
        // Added by another extension, not a message of the story: left as it is.
        if (indices[i] === undefined || keep.has(indices[i])) continue;
        sent.splice(i, 1);
        removed++;
    }
    return removed;
}

export function installLineContext(win) {
    win[INTERCEPTOR] = (sent, _contextSize, _abort, type) => {
        try {
            if (horaeKeepsLines(win)) return;
            const c = win.SillyTavern?.getContext?.();
            const removed = holdBack(sent, c?.chat, c?.chatMetadata, type);
            if (removed) console.debug(`[轻酒馆] 这条线没发给模型的消息：${removed} 条`);
        } catch (e) {
            console.error('[轻酒馆] 按线挑选发给模型的消息时出错，这次照原样发送', e);
        }
    };
}
