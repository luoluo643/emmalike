// Horae storylines read as sub-stories. Horae keeps every line of a story in one file, and the full app shows it that
// way; the shell shows one line at a time: its own messages, where other lines leave it, and the way back.
export const MAIN_LINE = 'main';

const KIND_NAMES = { side: '番外', parallel: '平行线', skit: '小剧场' };
const titleOf = (lines, id) => !id || id === MAIN_LINE ? '正文' : lines?.[id]?.title || '番外';
const known = (lines, id) => id === MAIN_LINE || !!(id && lines?.[id] && !lines[id].deleted);

/**
 * Each message's line, from the marks on the messages (the line a message switches to; the rest follow the message
 * before), as Horae reads them. For the preview, before the full app is ready.
 */
export function idsFromMarks(messages, lines) {
    let current = MAIN_LINE;
    return (messages ?? []).map(m => {
        const mark = m?.horae_storyline;
        if (mark && (lines ? known(lines, mark) : true)) current = mark;
        return current;
    });
}

/** Each message's line from Horae's segments; messages it has not placed yet belong to the line being written. */
function idsFromSegments(storyline, total) {
    const ids = new Array(total);
    for (const seg of storyline?.segments ?? []) {
        for (let i = Math.max(0, seg.start); i <= Math.min(total - 1, seg.end); i++) ids[i] = seg.id;
    }
    const writing = storyline?.pending || storyline?.active || MAIN_LINE;
    for (let i = 0; i < total; i++) if (!ids[i]) ids[i] = i > 0 && ids[i - 1] && !storyline?.pending ? ids[i - 1] : writing;
    return ids;
}

/**
 * The lines of a story as sub-stories. `storyline` is the bridge's storylineState (Horae's, or the shell's own record
 * when Horae is not on: segments, `registry` with each line's title, kind and parent, pending), or `ids` the line of
 * each message when only the marks are known (with the story's `registry` if read). Messages before `from` are not
 * this story's own (copied from the 正文) and belong to no line here. `kindOf(id, first)` names a line's kind from its
 * first message (the request that started it); else the registry's kind, else 番外.
 */
export function lineView({ storyline = null, ids: given = null, registry = null, total = 0, from = 0, kindOf = null, nameOf = null } = {}) {
    const lines = storyline?.registry ?? registry ?? {};
    const multi = given ? given.some(id => id !== MAIN_LINE) : !!storyline?.multi && Array.isArray(storyline?.segments);
    if (!multi || total <= 0) return { enabled: false };
    const ids = given ?? idsFromSegments(storyline, total);
    const own = i => i >= from && i < total;
    const counts = new Map();
    for (let i = Math.max(0, from); i < total; i++) counts.set(ids[i], (counts.get(ids[i]) ?? 0) + 1);
    const here = total - 1 >= from ? ids[total - 1] : MAIN_LINE;
    const pending = storyline?.pending && storyline.pending !== here && known(lines, storyline.pending) ? storyline.pending : null;
    const writing = pending ?? here;
    const parentOf = id => {
        const parent = id === MAIN_LINE ? null : lines[id]?.parent;
        return parent && parent !== id && known(lines, parent) ? parent : id === MAIN_LINE ? null : MAIN_LINE;
    };
    const firstAt = id => ids.findIndex((x, n) => x === id && n >= from);
    const kind = id => id === MAIN_LINE ? null : kindOf?.(id, firstAt(id)) || lines[id]?.kind || 'side';
    // `nameOf(id, first)`: a better name than the recorded one, for a line named from a request that said little.
    const title = id => id === MAIN_LINE ? '正文' : nameOf?.(id, firstAt(id)) || titleOf(lines, id);
    const label = id => id === MAIN_LINE ? '正文' : `${KIND_NAMES[kind(id)] ?? '番外'} · ${title(id)}`;
    const list = [...new Set([MAIN_LINE, ...counts.keys(), ...(pending ? [pending] : [])])]
        .filter(id => counts.has(id) || id === writing)
        .map(id => ({ id, label: label(id), title: title(id), kind: kind(id), parent: parentOf(id), count: counts.get(id) ?? 0 }));
    // Nothing to split when every message here is on one line.
    if (list.length < 2) return { enabled: false };
    const has = id => list.some(line => line.id === id);
    const depth = id => { let d = 0; for (let p = parentOf(id); p && d < 8; p = parentOf(p)) d++; return d; };
    // Lines in the order they first appear, each under its parent.
    const order = [];
    const place = id => {
        if (order.includes(id)) return;
        order.push(id);
        list.filter(line => line.parent === id).sort((a, b) => firstOf(a.id) - firstOf(b.id)).forEach(line => place(line.id));
    };
    const firstOf = id => { const i = ids.findIndex((x, n) => x === id && own(n)); return i < 0 ? Infinity : i; };
    place(MAIN_LINE);
    list.forEach(line => place(line.id));
    const tree = order.filter(has).map(id => ({ ...list.find(line => line.id === id), depth: depth(id) }));

    const indices = view => {
        const out = [];
        for (let i = Math.max(0, from); i < total; i++) if (ids[i] === view) out.push(i);
        return out;
    };
    /**
     * Where other lines leave `view`: under its last message before each of their stretches. A line shows under its
     * parent; one whose parent has nothing here shows under whatever line comes right before it.
     */
    const marks = view => {
        const out = new Map(), seen = new Set();
        for (let i = Math.max(0, from); i < total; i++) {
            const id = ids[i];
            // The 正文 never "leaves" a line: the way back to it is the path at the top.
            if (id === view || id === MAIN_LINE || (i > from && ids[i - 1] === id) || seen.has(id)) continue;
            const parent = parentOf(id);
            const anchorLine = parent && has(parent) && counts.has(parent) ? parent : ids[i - 1];
            if (anchorLine !== view) continue;
            let at = i - 1;
            while (at >= from && ids[at] !== view) at--;
            if (at < from) continue;
            seen.add(id);
            const line = list.find(l => l.id === id);
            out.set(at, [...(out.get(at) ?? []), line]);
        }
        return out;
    };
    /** From the 正文 down to `view`, through the lines it was opened from. */
    const path = view => {
        const chain = [];
        for (let id = view; id && chain.length < 8; id = parentOf(id)) chain.unshift(id);
        return chain.map(id => ({ id, label: label(id), readable: counts.has(id) || id === writing }));
    };
    return { enabled: true, lines: tree, here, pending, writing, lineOf: i => ids[i] ?? null,
        has, label, kind, indices, marks, path, count: id => counts.get(id) ?? 0 };
}
