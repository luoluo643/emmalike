// The lines written inside one story, recorded by the shell itself when Horae's storylines are not on. Kept the way
// Horae keeps them, so the same reading (line-view.js) serves both: a mark on the message a line starts at (the
// messages after it follow it until the next mark) and a registry in the story's metadata. Own names, so a Horae of
// any version never reads them as its own. Nothing is filtered before generation: the model still sees the story.
export const LINE_FIELD = 'tavern_lite_line';
export const LINES_KEY = 'tavern_lite_lines';
export const MAIN = 'main';
export const LINE_KINDS = ['side', 'parallel', 'skit'];

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const cleanTitle = title => String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 36);

/** The registry as stored, every part checked: { lines: {id: {title, kind, parent, deleted}}, pending, kinds }. */
export function readRegistry(metadata) {
    const stored = object(metadata?.[LINES_KEY]) ? metadata[LINES_KEY] : {};
    const lines = {};
    for (const [id, line] of Object.entries(object(stored.lines) ? stored.lines : {})) {
        if (!id || id === MAIN || !object(line)) continue;
        // auto: named from the request alone, when it said little; the shell names it again once the reply is there.
        lines[id] = { title: cleanTitle(line.title), kind: LINE_KINDS.includes(line.kind) ? line.kind : null,
            parent: typeof line.parent === 'string' ? line.parent : MAIN, deleted: !!line.deleted, auto: !!line.auto };
    }
    // A kind chosen by hand, for any line (Horae's too): it wins over the one guessed from the request.
    const kinds = {};
    for (const [id, kind] of Object.entries(object(stored.kinds) ? stored.kinds : {})) if (LINE_KINDS.includes(kind)) kinds[id] = kind;
    const pending = typeof stored.pending === 'string' && (stored.pending === MAIN || lines[stored.pending] && !lines[stored.pending].deleted) ? stored.pending : null;
    return { lines, pending, kinds };
}

const known = (registry, id) => id === MAIN || !!(registry.lines[id] && !registry.lines[id].deleted);

/** Stretches of messages on one line, from the marks: [{ id, start, end }]. Marks of unknown lines are not followed. */
export function ownSegments(messages, registry) {
    const segments = [];
    let current = MAIN;
    (messages ?? []).forEach((m, i) => {
        const mark = m?.[LINE_FIELD];
        if (typeof mark === 'string' && known(registry, mark)) current = mark;
        const last = segments.at(-1);
        if (last?.id === current) last.end = i;
        else segments.push({ id: current, start: i, end: i });
    });
    return segments;
}

/** The story's own lines in the shape of the bridge's storylineState (Horae's), `source: 'lite'`. */
export function ownState(messages, metadata) {
    const registry = readRegistry(metadata);
    const segments = ownSegments(messages, registry);
    const here = segments.at(-1)?.id ?? MAIN;
    const pending = registry.pending && registry.pending !== here ? registry.pending : null;
    const used = segments.some(s => s.id !== MAIN);
    return {
        source: 'lite', multi: used || !!pending, active: here, pending, segments,
        registry: Object.fromEntries(Object.entries(registry.lines).map(([id, line]) => [id, { ...line, kind: registry.kinds[id] ?? line.kind }])),
        kinds: registry.kinds,
    };
}

/**
 * The stretches written on the shell's own lines, as 故事里写过的番外 lists them for copying into a story of their own:
 * [{ from, to, requestIndex, title, kind, count }]. `titleOf` gives a line's shown name when it is named again.
 */
export function recordedEpisodes(state, titleOf = null) {
    if (state?.source !== 'lite') return [];
    return (state.segments ?? []).filter(s => s.id !== MAIN && state.registry?.[s.id]).map(s => ({
        from: s.start, to: s.end, requestIndex: s.start, count: s.end - s.start + 1, line: s.id,
        title: titleOf?.(s.id, s.start) || state.registry[s.id].title || '番外', kind: state.registry[s.id].kind || 'side',
    }));
}

/** The line of each message, as the marks say. */
export function ownIds(messages, registry) {
    const ids = [];
    for (const seg of ownSegments(messages, registry)) for (let i = seg.start; i <= seg.end; i++) ids[i] = seg.id;
    return ids;
}

const error = message => Object.assign(new Error(message), { code: 'LINE_INVALID' });

/**
 * What an action changes: { marks: [[index, line | null]], registry } (null removes a mark), for the bridge to write
 * into the open story. `makeId` names a new line.
 * - 'new-next' { title, kind, parent }: a new line, the next message starts it
 * - 'to-main' / 'to-line' { line } / 'clear-pending': the line the next message goes on
 * - 'apply-pending' { index }: the message just sent starts the line asked for
 * - 'mark' { index, line } or { index, title, kind }: from this message on, a line (an existing or a new one)
 * - 'unmark' { index }: this message follows the one before again
 * - 'set-kind' { line, kind }, 'rename' { line, title }
 * - 'apply-suggestions' { items: [{ index, action: 'start' | 'back', title, kind }] }: marks for an older story
 */
export function planLineAction(messages, metadata, action, options = {}, makeId = () => `tl-line-${Math.random().toString(36).slice(2, 10)}`) {
    const registry = readRegistry(metadata);
    const stored = object(metadata?.[LINES_KEY]) ? metadata[LINES_KEY] : {};
    const next = { version: 1, lines: object(stored.lines) ? { ...stored.lines } : {}, pending: registry.pending, kinds: { ...registry.kinds } };
    const marks = [];
    const total = messages?.length ?? 0;
    const ids = ownIds(messages, registry);
    const here = ids.at(-1) ?? MAIN;
    const newLine = ({ title, kind, parent, auto }) => {
        const id = makeId();
        next.lines[id] = { title: cleanTitle(title) || '番外', kind: LINE_KINDS.includes(kind) ? kind : 'side',
            parent: typeof parent === 'string' && known(registry, parent) ? parent : here, createdAt: Date.now(), ...(auto ? { auto: true } : {}) };
        // Known from here on, for the marks that follow in the same action.
        registry.lines[id] = { ...next.lines[id], deleted: false };
        return id;
    };
    const index = options.index;
    const atMessage = () => {
        if (!Number.isSafeInteger(index) || index < 0 || index >= total) throw error('没有这条消息');
    };
    switch (action) {
        case 'new-next': next.pending = newLine(options); break;
        case 'to-main': next.pending = here === MAIN ? null : MAIN; break;
        case 'to-line':
            if (!known(registry, options.line)) throw error('没有这条线');
            next.pending = options.line === here ? null : options.line; break;
        case 'clear-pending': next.pending = null; break;
        case 'apply-pending':
            atMessage();
            if (!next.pending) return null;
            marks.push([index, next.pending]); next.pending = null; break;
        case 'mark': {
            atMessage();
            const line = options.line ? options.line : newLine({ ...options, auto: false, parent: options.parent ?? ids[index - 1] ?? MAIN });
            if (!known(registry, line)) throw error('没有这条线');
            // A kind picked in the form is the author's choice, not to be guessed again from the request.
            if (!options.line && LINE_KINDS.includes(options.kind)) next.kinds[line] = options.kind;
            marks.push([index, line]);
            break;
        }
        case 'detected': {
            // A message sent without the shell (the full app, a quick reply): what its request says, as on sending.
            atMessage();
            const said = options.directive, before = ids[index - 1] ?? MAIN;
            if (said?.action === 'start') marks.push([index, newLine({ title: said.title, kind: said.kind, parent: before, auto: said.weak })]);
            else if (said?.action === 'back' && before !== MAIN) marks.push([index, MAIN]);
            else return null;
            break;
        }
        case 'unmark': atMessage(); marks.push([index, null]); break;
        case 'set-kind':
            if (!LINE_KINDS.includes(options.kind) || !options.line || options.line === MAIN) throw error('请选择类型');
            next.kinds[options.line] = options.kind; break;
        case 'rename': {
            const title = cleanTitle(options.title);
            if (!next.lines[options.line] || registry.lines[options.line]?.deleted) throw error('没有这条线');
            if (!title) throw error('请输入名字');
            next.lines[options.line] = { ...next.lines[options.line], title, auto: false }; break;
        }
        case 'apply-suggestions': {
            // A message that already starts a line keeps it.
            const starts = new Set(ownSegments(messages, registry).map(s => s.start));
            for (const item of options.items ?? []) {
                if (!Number.isSafeInteger(item?.index) || item.index <= 0 || item.index >= total || starts.has(item.index)) continue;
                marks.push([item.index, item.action === 'back' ? MAIN : newLine({ title: item.title, kind: item.kind, parent: MAIN })]);
            }
            if (!marks.length) throw error('没有可用的分段');
            break;
        }
        default: throw error('不认识的操作');
    }
    return { marks, registry: next };
}
