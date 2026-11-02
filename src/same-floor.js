// "Same-floor" (同层) frontend cards: a display regex turns every reply into one whole interface, and the story is played
// inside it. Sending adds the user's message and the reply to the chat without the full app drawing them (Tavern
// Helper's createChatMessages with refresh 'none'); the card hides the full app's other messages itself. The shell
// draws messages on its own, so it finds such a chat here and shows it the same way: one interface, the rest folded.

const SLOT = /<div class="tl-frontend-card" data-card="([^"]+)"[^>]*><\/div>/g;
// A card the full app has not drawn (a message added without a refresh, or past Tavern Helper's render depth).
const PLACEHOLDER = /<(span|div) class="tl-card-placeholder">[^<]*<\/\1>/g;

/** The card in a message made of nothing but one frontend card: { key } when it runs here, { key: null } when it is a
 *  placeholder; null for any other message. */
export function cardOnly(message) {
    const html = String(message?.html ?? '');
    const keys = [...html.matchAll(SLOT)].map(m => m[1]);
    const placeholders = html.match(PLACEHOLDER)?.length ?? 0;
    if (keys.length + placeholders !== 1) return null;
    const rest = html.replace(SLOT, '').replace(PLACEHOLDER, '').replace(/<[^>]*>/g, '').replace(/&nbsp;|\s/g, '');
    return rest ? null : { key: keys[0] ?? null };
}

// A card's key is "<message>.<frame>.<hash of its page>": the same interface on two messages has the same hash.
const page = key => key.split('.').pop();

/** When the messages are a same-floor card's: { host } — the index of the one message whose interface to show. */
export function sameFloor(messages) {
    const replies = (messages ?? []).filter(m => !m.is_user && !m.is_system);
    if (!replies.length || !cardOnly(replies.at(-1))) return null;
    // The newest reply whose interface can run here, counting back over replies that are only a card.
    let host = null;
    for (let i = replies.length - 1; i >= 0; i--) {
        const card = cardOnly(replies[i]);
        if (!card) break;
        if (card.key) { host = { message: replies[i], key: card.key }; break; }
    }
    if (!host) return null;
    // Same-floor, not a card that differs per reply: the same page on another reply, or replies added after it that
    // the full app never drew.
    const twin = replies.some(m => m !== host.message && cardOnly(m)?.key && page(cardOnly(m).key) === page(host.key));
    const silent = replies.some(m => m.index > host.message.index && cardOnly(m) && !cardOnly(m).key);
    return twin || silent ? { host: host.message.index } : null;
}
