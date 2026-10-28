// What a shared part of a story contains: the story cut into rounds (one message of the reader and the replies after
// it), and the reader's own name hidden on request. No DOM here, so it is tested on its own.

export const NAME_MASK = '■■';
const SUMMARY_LENGTH = 24;

/** One line of plain text from a message's raw text, for telling rounds apart in a list. */
export function summarize(text, length = SUMMARY_LENGTH) {
    const plain = String(text ?? '')
        .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[*_~`#>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return plain.length > length ? `${plain.slice(0, length)}…` : plain;
}

/**
 * Rounds of a story, in order. Each starts at a message the reader wrote and holds the replies after it; whatever
 * comes before the first one (the greeting) is round 0. `messages` are { index, user, name, mes }.
 */
export function storyRounds(messages) {
    const rounds = [];
    for (const message of messages) {
        if (message.user || !rounds.length) {
            rounds.push({ number: message.user ? rounds.filter(r => r.number > 0).length + 1 : 0, messages: [] });
        }
        rounds.at(-1).messages.push(message);
    }
    for (const round of rounds) {
        round.from = round.messages[0].index;
        round.to = round.messages.at(-1).index;
        round.summary = summarize(round.messages[0].mes);
    }
    return rounds;
}

/** The round holding message `index` (or the first round after it), as a position in `rounds`. */
export function roundAt(rounds, index) {
    const at = rounds.findIndex(r => r.to >= index);
    return at < 0 ? Math.max(0, rounds.length - 1) : at;
}

/** Names the reader went by in these messages, plus the current one; empty names left out. */
export function readerNames(messages, current = '') {
    const names = new Set(messages.filter(m => m.user).map(m => String(m.name ?? '').trim()));
    if (String(current).trim()) names.add(String(current).trim());
    names.delete('');
    return [...names];
}

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cleanNames = names => [...new Set(names.map(n => String(n).trim()).filter(Boolean))];

/**
 * The names inside a text hidden, when they are at least two characters long: a one-character name would also hide
 * that character in other words.
 */
export function hideInText(text, names, mask = NAME_MASK) {
    const inText = cleanNames(names).filter(n => [...n].length >= 2).sort((a, b) => b.length - a.length);
    return inText.length ? String(text).replace(new RegExp(inText.map(escape).join('|'), 'g'), mask) : String(text);
}

/**
 * Messages with the reader's names hidden: the name over the reader's messages always, and the names inside the text
 * (see hideInText). Messages are { name, user, text }; nothing else changes.
 */
export function hideNames(messages, names, mask = NAME_MASK) {
    const list = cleanNames(names);
    return messages.map(m => ({
        ...m,
        name: m.user || list.includes(String(m.name ?? '').trim()) ? mask : m.name,
        text: hideInText(m.text, list, mask),
    }));
}

/** Whether some of these names are too short to be hidden inside the text. */
export function hasShortNames(names) {
    return names.some(n => [...String(n).trim()].length === 1);
}
