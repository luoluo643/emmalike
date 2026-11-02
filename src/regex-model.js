// Regex scripts in plain words (regex-editor.jsx): what a script changes and where, what is wrong with it, search,
// and what applying a saved set of switches would change. The scripts themselves are the app's own
// (extensions/regex): kept in the account settings (global), in the preset in use, or on the open character.

// The app's own order of the three lists: it runs every global script, then the preset's, then the character's.
export const REGEX_GROUPS = ['global', 'preset', 'scoped'];
export const GROUP_NAMES = { global: '全局', preset: '预设', scoped: '角色' };

// The app's regex_placement values, named for what they hold. 0 (old "Markdown") and 4 (old "sendAs") were migrated
// away by the app and are not offered.
export const PLACEMENTS = [
    [2, 'AI 回复'], [1, '你说的话'], [6, '思维链'], [5, '世界书内容'], [3, '斜杠命令'],
];
// markdownOnly / promptOnly as one choice. Both on (rare) changes what is shown and what is sent, not what is stored.
export const KINDS = [
    ['display', '只改显示', '存下的文字不变，只是看起来不一样'],
    ['prompt', '只改发给 AI 的', '你看到的不变，AI 读到的被改掉'],
    ['both', '显示和发给 AI 的都改', '存下的文字不变'],
    ['stored', '直接改存下的文字', '回复存下来时就改掉，改了就回不去'],
];
export const SUBSTITUTE = [[0, '不替换'], [1, '替换成原样'], [2, '替换并当作普通文字']];

export const kindOf = script => script.markdownOnly ? (script.promptOnly ? 'both' : 'display') : script.promptOnly ? 'prompt' : 'stored';
export const kindFlags = kind => ({ markdownOnly: kind === 'display' || kind === 'both', promptOnly: kind === 'prompt' || kind === 'both' });
export const kindName = script => KINDS.find(k => k[0] === kindOf(script))[1];

/** Same parsing as the app (utils.js regexFromString): /pattern/flags, or the whole text as a pattern. */
export function parseFind(source) {
    const text = String(source ?? '');
    if (!text) return { ok: false, empty: true, error: '还没写要找的内容' };
    try {
        const m = text.match(/(\/?)(.+)\1([a-z]*)/i);
        const regex = m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3]) ? RegExp(text) : new RegExp(m[2], m[3]);
        return { ok: true, regex, global: regex.flags.includes('g'), ignoreCase: regex.flags.includes('i') };
    } catch (error) {
        return { ok: false, error: `写法有误：${String(error.message).replace(/^Invalid regular expression: /, '')}` };
    }
}

/** One line under the find box: how it matches, or what is wrong. */
export function findNote(script) {
    const parsed = parseFind(script.findRegex);
    if (!parsed.ok) return { tone: parsed.empty ? 'muted' : 'error', text: parsed.error };
    const macro = Number(script.substituteRegex) && /\{\{.+?\}\}/.test(script.findRegex) ? '；里面的 {{…}} 会先换成当前的名字' : '';
    return { tone: 'muted', text: `${parsed.global ? '替换所有找到的' : '只替换找到的第一处'}，${parsed.ignoreCase ? '不分大小写' : '区分大小写'}${macro}` };
}

/** Why a script does nothing even when it is on. Macros make a pattern checkable only in the app, so it is let through. */
export function problemOf(script) {
    if (!String(script.scriptName ?? '').trim()) return '没有名字';
    if (!String(script.findRegex ?? '')) return '没写要找的内容，不会生效';
    if (!(Array.isArray(script.placement) && script.placement.some(p => PLACEMENTS.some(([value]) => value === Number(p))))) return '没选用在哪里，不会生效';
    if (!(Number(script.substituteRegex) && /\{\{/.test(script.findRegex)) && !parseFind(script.findRegex).ok) return '查找内容写法有误，不会生效';
    // The app only changes world book text in what is sent (its editor says so on that checkbox).
    if (script.placement.every(p => Number(p) === 5) && !script.promptOnly) return '世界书内容要选「只改发给 AI 的」才会生效';
    if (depthRangeEmpty(script)) return '最小深度比最大深度大，不会改任何消息';
    return '';
}

/** A depth range no message falls in (the app skips a message below minDepth or above maxDepth). */
export const depthRangeEmpty = script => Number.isInteger(script.minDepth) && Number.isInteger(script.maxDepth) && script.maxDepth >= 0 && script.minDepth > script.maxDepth;

export function placementText(script) {
    const names = PLACEMENTS.filter(([value]) => (script.placement ?? []).map(Number).includes(value)).map(([, name]) => name);
    return names.length ? names.join('、') : '没选用在哪里';
}

// minDepth/maxDepth as the app reads them (engine.js getRegexedString): depth 0 is the latest message.
export function depthText(script) {
    const min = Number.isInteger(script.minDepth) && script.minDepth >= 0 ? script.minDepth : null;
    const max = Number.isInteger(script.maxDepth) && script.maxDepth >= 0 ? script.maxDepth : null;
    if (min !== null && max !== null) return `只改倒数第 ${min + 1}～${max + 1} 条`;
    if (min) return `最近 ${min} 条不改`;
    if (max !== null) return `只改最近 ${max + 1} 条`;
    return '';
}

/** The hint under a script's name in the list. */
export const scriptSummary = script => [placementText(script), kindName(script), depthText(script)].filter(Boolean).join(' · ');

export const FILTERS = [['all', '全部'], ['on', '打开的'], ['off', '关闭的'], ['display', '只改显示'], ['prompt', '改发给 AI 的'], ['stored', '改存下的'], ['problem', '有问题']];
export function matchesFilter(script, filter) {
    if (filter === 'all') return true;
    if (filter === 'on') return !script.disabled;
    if (filter === 'off') return !!script.disabled;
    if (filter === 'problem') return !!problemOf(script);
    if (filter === 'prompt') return ['prompt', 'both'].includes(kindOf(script));
    if (filter === 'display') return ['display', 'both'].includes(kindOf(script));
    return kindOf(script) === filter;
}

/** Name, find and replace text; `hits` say where the search text was found. */
export function regexSearch(script, query) {
    const needle = String(query ?? '').trim().toLocaleLowerCase();
    if (!needle) return { matched: true, hits: [] };
    const hits = [['scriptName', '名字'], ['findRegex', '查找'], ['replaceString', '替换为']].flatMap(([key, label]) => {
        const text = String(script[key] ?? ''), at = text.toLocaleLowerCase().indexOf(needle);
        return at < 0 ? [] : [{ key, label, snippet: `${at > 12 ? '…' : ''}${text.slice(Math.max(0, at - 12), at + needle.length + 18)}` }];
    });
    return { matched: hits.length > 0, hits };
}

// The fields the app's own editor writes. Anything else on a script (an extension's data) is kept as it is.
export const SCRIPT_FIELDS = ['scriptName', 'findRegex', 'replaceString', 'trimStrings', 'placement', 'disabled', 'markdownOnly', 'promptOnly', 'runOnEdit', 'substituteRegex', 'minDepth', 'maxDepth'];
export const FIELD_LABELS = { scriptName: '名字', findRegex: '查找', replaceString: '替换为', trimStrings: '去掉的文字', placement: '用在哪里', disabled: '开关',
    markdownOnly: '改哪里', promptOnly: '改哪里', runOnEdit: '编辑消息时也运行', substituteRegex: '查找里的 {{…}}', minDepth: '深度范围', maxDepth: '深度范围' };

const depthValue = value => Number.isInteger(value) && value >= -1 ? value : null;
/** A script as the app's editor would save it: every field present and of the right kind. */
export function normalizeScript(script = {}) {
    return {
        scriptName: String(script.scriptName ?? ''), findRegex: String(script.findRegex ?? ''), replaceString: String(script.replaceString ?? ''),
        trimStrings: Array.isArray(script.trimStrings) ? script.trimStrings.map(String).filter(s => s.length) : [],
        placement: Array.isArray(script.placement) ? [...new Set(script.placement.map(Number).filter(Number.isInteger))].sort((a, b) => a - b) : [],
        disabled: !!script.disabled, markdownOnly: !!script.markdownOnly, promptOnly: !!script.promptOnly, runOnEdit: !!script.runOnEdit,
        substituteRegex: [0, 1, 2].includes(Number(script.substituteRegex)) ? Number(script.substituteRegex) : 0,
        minDepth: depthValue(script.minDepth), maxDepth: depthValue(script.maxDepth),
    };
}
/** A new script: shown changed and kept for the reply (the app's own editor starts with "user input" ticked instead). */
export const blankScript = () => normalizeScript({ placement: [2], markdownOnly: true, runOnEdit: true });

/** Compares only the fields the editor writes, so a script read again later is "the same" when nothing it shows changed. */
export const scriptFingerprint = script => JSON.stringify(normalizeScript(script));
/** What a script does, whatever it is called and whether it is on: two alike would each change the text in turn. */
export const ruleKey = script => scriptFingerprint({ ...normalizeScript(script), scriptName: '', disabled: false });
/** How many of `scripts` a list already has one alike of. */
export const alreadyIn = (scripts, list) => { const have = new Set(list.map(ruleKey)); return scripts.filter(s => have.has(ruleKey(s))).length; };
export function scriptChanges(before, after) {
    const a = normalizeScript(before), b = normalizeScript(after), labels = new Set();
    for (const key of SCRIPT_FIELDS) if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) labels.add(FIELD_LABELS[key]);
    return [...labels];
}

/** The form's depth boxes: empty means no limit. Returns the value or an error message. */
export function depthInput(text) {
    const t = String(text ?? '').trim();
    if (!t) return { value: null };
    if (!/^-?\d+$/.test(t) || Number(t) < -1) return { error: '填 0 或更大的整数，空着就是不限' };
    return { value: Number(t) };
}

/**
 * What applying a saved set of switches would do (the app's RegexPresetManager.applyPreset): scripts in the set are
 * switched on, every other script in the three lists off. `state.groups` as the bridge reports them.
 */
export function comboChanges(state, combo) {
    const turnOn = [], turnOff = [];
    for (const group of state.groups) {
        const listed = new Set((combo[group.type] ?? []).map(String));
        for (const script of group.scripts) {
            const on = listed.has(String(script.id));
            if (on && script.disabled) turnOn.push({ group: group.type, name: script.scriptName });
            if (!on && !script.disabled) turnOff.push({ group: group.type, name: script.scriptName });
        }
    }
    return { turnOn, turnOff };
}

/**
 * The preset's or character's list a set knows nothing of (it was saved with another preset or character, or with none
 * of these on), whose scripts applying it would switch off: a set keeps only ids, for whatever was open then.
 */
export function comboUnknownGroups(state, combo) {
    return state.groups.filter(group => group.type !== 'global' && group.scripts.length > 0).flatMap(group => {
        const ids = new Set(group.scripts.map(s => String(s.id)));
        if ((combo[group.type] ?? []).some(id => ids.has(String(id)))) return [];
        const off = group.scripts.filter(s => !s.disabled).length;
        return off ? [{ type: group.type, owner: group.owner, off }] : [];
    });
}

/** Scripts read from a file the app exported: one script or a list. Only ones with a name are taken, as the app does. */
export function scriptsFromFile(text) {
    let value;
    try { value = JSON.parse(text); } catch { return { scripts: [], skipped: 0, error: '不是正则文件（JSON 格式不对）' }; }
    const list = Array.isArray(value) ? value : [value];
    const scripts = list.filter(item => item && typeof item === 'object' && typeof item.scriptName === 'string' && item.scriptName.trim());
    return { scripts, skipped: list.length - scripts.length, error: scripts.length ? '' : '文件里没有正则' };
}

/** The app's export file name (regex-<name>.json). */
export const exportName = name => `regex-${String(name).replace(/[\s.<>:"/\\|?*\x00-\x1F\x7F]/g, '_').toLowerCase()}.json`;
