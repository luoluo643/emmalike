// What a shared part of a story contains: its floors (messages, numbered as the full app numbers them), the story cut
// into rounds (one message of the reader and the replies after it), and the reader's own name hidden on request. No DOM
// here, so it is tested on its own.

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

/** A floor in a list to pick from: its number as the full app shows it, who wrote it and how it starts. */
export function floorLabel(message) {
    return `#${message.index} ${message.name ?? ''}：${summarize(message.mes) || '（没有文字）'}`;
}

/** The floor holding message `index` (or the first one after it), as a position in `messages`. */
export function floorAt(messages, index) {
    const at = messages.findIndex(m => m.index >= index);
    return at < 0 ? Math.max(0, messages.length - 1) : at;
}

/** Only one side's messages: 'char' (the characters), 'user' (the reader) or 'all'. */
export function bySpeaker(messages, who) {
    if (who === 'char') return messages.filter(m => !m.user);
    if (who === 'user') return messages.filter(m => m.user);
    return messages;
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

const namePattern = names => {
    const list = cleanNames(names).filter(n => [...n].length >= 2).sort((a, b) => b.length - a.length);
    return list.length ? new RegExp(list.map(escape).join('|'), 'g') : null;
};

/**
 * The names inside a text hidden, when they are at least two characters long: a one-character name would also hide
 * that character in other words.
 */
export function hideInText(text, names, mask = NAME_MASK) {
    const pattern = namePattern(names);
    return pattern ? String(text).replace(pattern, mask) : String(text);
}

/** Match across style boundaries first; keep the surrounding styles and give each mask the first letter's style. */
export function hideInRuns(paragraphs, names, mask = NAME_MASK) {
    const pattern = namePattern(names);
    if (!pattern) return paragraphs;
    // UTF-16 offsets match RegExp.index, including names containing emoji.
    const chars = paragraphs.flatMap((runs, i) => [
        ...(i ? [{ ch: '\n', kind: 'text' }] : []),
        ...runs.flatMap(run => run.text.split('').map(ch => ({ ch, kind: run.kind }))),
    ]);
    const text = chars.map(c => c.ch).join('');
    const matches = [...text.matchAll(pattern)];
    const out = [[]];
    const add = (text, kind) => {
        for (const ch of text.split('')) {
            if (ch === '\n') { out.push([]); continue; }
            const runs = out.at(-1);
            if (runs.at(-1)?.kind === kind) runs.at(-1).text += ch;
            else runs.push({ text: ch, kind });
        }
    };
    let at = 0;
    for (const match of matches) {
        while (at < match.index) { const c = chars[at++]; add(c.ch, c.kind); }
        add(mask, chars[at].kind);
        at += match[0].length;
    }
    while (at < chars.length) { const c = chars[at++]; add(c.ch, c.kind); }
    return out;
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
