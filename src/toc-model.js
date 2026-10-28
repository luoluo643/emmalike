// The story's table of contents, like a novel app's: one entry per reply (the user's own lines are not chapters),
// titled by what Horae recorded for that floor (its most telling event), else by the reply's opening words. Entries
// are grouped by the story date Horae keeps, else in runs of RUN floors. Horae is optional: without its records the
// contents still work from the story's own words.

const RUN = 50;
// Horae's event levels, most telling first; its own summaries ("摘要" / isSummary) cover a stretch of the story, so
// they title a reply only when nothing else does.
const LEVELS = ['关键', '關鍵', '重要', '一般'];
// Thinking, scripts and folded blocks are not the story's words.
const NOT_TEXT = /<(think|thinking|reasoning|todo|details|style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Plain words of a message for a title: no tags, markdown marks or thinking. */
export function tocSnippet(text, max = 80) {
    const plain = String(text ?? '').replace(NOT_TEXT, ' ').replace(/<[^>]*>/g, ' ').replace(/[*_~`#>|]+/g, '')
        .replace(/\s+/g, ' ').trim();
    return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

// A summary is words, not a stray fragment a model left behind ("` and `").
const meaningful = text => typeof text === 'string' && (text.match(/\p{L}/gu)?.length ?? 0) >= 4;

/** What Horae recorded for one message, cut to what the contents show. */
export function horaeOutline(meta) {
    if (!meta || typeof meta !== 'object') return null;
    const events = (Array.isArray(meta.events) ? meta.events : [])
        .filter(e => e && meaningful(e.summary))
        .map(e => ({ text: e.summary.trim(), level: String(e.level ?? ''), stage: !!e.isSummary || e.level === '摘要' }));
    const date = String(meta.timestamp?.story_date ?? '').trim();
    return events.length || date ? { events, date } : null;
}

const rank = event => event.stage ? LEVELS.length + 1 : LEVELS.includes(event.level) ? LEVELS.indexOf(event.level) : LEVELS.length;

/**
 * `messages`: the story in order, each `{ is_user, notice, hidden, mes, horae_meta }` (as the chat file keeps them;
 * `notice` marks the app's own notices).
 * Returns `{ entries, groups }`: entries in story order; groups as `{ key, label, entries }`.
 */
export function buildToc(messages) {
    const entries = [];
    (messages ?? []).forEach((m, index) => {
        if (!m || m.is_user || m.notice) return;
        const horae = horaeOutline(m.horae_meta);
        const head = [...(horae?.events ?? [])].sort((a, b) => rank(a) - rank(b))[0] ?? null;
        const opening = tocSnippet(m.mes);
        if (!head && !opening) return;
        entries.push({
            index,
            title: head?.text ?? opening,
            fromHorae: !!head,
            date: horae?.date ?? '',
            hidden: !!m.hidden,
        });
    });
    // Replies without a date stay with the day before them; the opening ones join the first dated day.
    const firstDate = entries.find(e => e.date)?.date ?? '';
    const groups = [];
    for (const entry of entries) {
        const key = firstDate ? entry.date || groups.at(-1)?.key || firstDate : String(Math.floor(entry.index / RUN));
        if (groups.at(-1)?.key !== key) groups.push({ key, entries: [] });
        groups.at(-1).entries.push(entry);
    }
    for (const group of groups) {
        const first = group.entries[0].index, last = group.entries.at(-1).index;
        const floors = first === last ? `#${first}` : `#${first}–${last}`;
        group.label = firstDate ? `${group.key} · ${floors}` : `第 ${first}–${last} 楼`;
    }
    return { entries, groups };
}

/** The entry the reader is at: the last one at or before message `index` (a user line belongs to the reply before it). */
export function currentEntry(entries, index) {
    if (!Number.isFinite(index)) return null;
    let found = null;
    for (const entry of entries) {
        if (entry.index > index) break;
        found = entry;
    }
    return found ?? entries[0] ?? null;
}

/** Entries matching `query` in their title or date; a number (or #number) finds floors. */
export function filterToc(entries, query) {
    const needle = String(query ?? '').trim().toLocaleLowerCase();
    if (!needle) return entries;
    if (/^#?\d+$/.test(needle)) {
        const floor = Number(needle.replace('#', ''));
        return entries.filter(e => String(e.index).startsWith(String(floor)));
    }
    return entries.filter(e => [e.title, e.date].join('\n').toLocaleLowerCase().includes(needle));
}
