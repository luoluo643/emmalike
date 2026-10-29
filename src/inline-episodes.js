// 番外 written inside a story (asked for in the story itself, without a separate story file): found from the request
// that starts one ("生成番外…", "暂停当前剧情，为我生成一个番外…", "小剧场：…") up to the request that goes back to
// the main story, the next such request, or the end of the story. Only a guess from the wording: the range can be
// corrected before a part is copied into a story of its own (bridge extractEpisode).

// The verb and the 番外 word sit in the same clause ("生成一个番外", "来个小剧场"), not across a comma; or the
// request pauses the story and keeps what follows out of it ("暂停当前剧情……不计入主线剧情").
const START = /(?:生成|写|来(?:个|一个|一篇|一段|篇|段)|开(?:个|一个|一条)|整(?:个|一个))[^。\n！？!?，,；;]{0,20}(?:番外|小剧场|平行(?:世界|线|宇宙))|(?:番外|小剧场)\s*[:：]|暂停(?:当前|主线|正剧)?(?:剧情|主线|正剧)[\s\S]{0,80}不计入(?:主线|正文|正剧|记忆)/;
// Going back: a return that names the main story ("回归正文", "回到主线"), carrying on with it ("继续正文"), ending
// the 番外, or turning what was written into a dream or part of the story ("以上番外都是他做的梦", "把以上番外的记忆
// 塞进正剧"). A bare "回到剧情" / "继续剧情" is not one: inside a 番外 it follows "暂停剧情，自检……" and means going
// on with the 番外 (the same rule as Horae's storylines).
const BACK = /(?:回到|回归|返回|切回|转回|恢复)[^。\n]{0,6}(?:正剧|主线|正文|原剧情|主剧情)|(?:继续|接着)[^。\n，,]{0,4}(?:正剧|主线|正文|原剧情|主剧情)|(?:番外|小剧场)[^。\n]{0,6}(?:结束|完结|到此|作为正文)|结束(?:番外|小剧场)|(?:塞|放|写|融|带)(?:进|到|入|回)?[^。\n]{0,4}正剧|以上[^。\n]{0,8}(?:番外|剧情|小剧场|内容)[^。\n]{0,14}(?:梦|正文|正剧|主线|醒来)/;
// "禁止继续正文" in a request says the opposite of going back.
const NEGATED = /(?:禁止|不要|不许|不准|别再?|无需|不需要|不用)[^，,。；;\n]{0,10}/g;
// A title asked for by name: after 主题/标题…, or quoted right before 番外/小剧场; 《…》 is a title anywhere.
const NAMED = /(?:主题|标题|题目|名为|名叫|叫做|题为)(?:是|为)?\s*[:：]?\s*[“"「『《【]([^”"」』》】\n]{2,30})[”"」』》】]|[“"「『《【]([^”"」』》】\n]{2,30})[”"」』》】]\s*(?:番外|小剧场|篇)|《([^》\n]{2,30})》/;
// A title line: a markdown heading, a whole bold line, or 《…》/【…】 on its own.
const HEADING = /^\s*(?:#{1,6}\s*(.+?)|\*\*([^\n*]{2,40}?)\*\*|《([^\n》]{2,30})》|【([^\n】]{2,30})】)\s*$/;
// Lines that look like titles but are not: placeholders, numbered sections of an analysis, the model's own notes.
const NOT_TITLE = /标题|题目|title|^\[.*\]$|^[xX×]{2,}|^[一二三四五六七八九十]+[、.．]|^\d+\s*[、.．)）]|^第[一二三四五六七八九十\d]+(?:步|部分|节)|^phase\s*\.?\s*\d|step|think|评估|分析|大纲|规划|自检|检查|思路|说明|注意事项|状态|总结|^(?:番外|小剧场|正文|平行线|设定)$/i;
// A title says something: at least two Chinese characters or a word, not only symbols or a kaomoji.
const WORDY = /\p{Script=Han}{2}|[A-Za-z]{3}/u;
// Clauses of a request that only say how to write it, not what it is about.
const NOISE = /暂停|生成|番外|小剧场|自拟|不需要|不计入|状态栏|记忆区|严格遵守|人物设定|人设|不能ooc|不要ooc|字数|不少于|不低于|独立|无关|if线|平行世界|世界线|为我|帮我|给我/i;
const MACRO = /\{\{[^{}]*\}\}/g;

const kindOf = text => /小剧场/.test(text) ? 'skit' : /平行(?:世界|线|宇宙)/.test(text) && !/番外/.test(text) ? 'parallel' : 'side';
// The author's words: macros ({{setvar::…}}, {{user}}, also nested) say nothing about a 番外.
function said(text) {
    let s = String(text ?? ''), before;
    do { before = s; s = s.replace(MACRO, ' '); } while (s !== before);
    return s;
}
const plain = text => said(text).replace(/<[^>]*>/g, '').replace(/[*_`>]/g, '').trim();
// Thinking blocks and tagged sections come before the story in many replies; titles are looked for after them.
const storyPart = text => String(text ?? '').replace(/<(think|thinking|horae\w*|Episode|details)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, '');
const tidy = text => String(text).replace(/^[\s#①-⑳\d.、:：|｜*_`]+/, '').replace(/^(?:番外|小剧场)(?:设定|篇)?\s*[:：]\s*/, '')
    .replace(/[\s↓`*_|｜]+$/, '').replace(/^[「『“"【《](.*)[」』”"】》]$/, '$1').trim();
// A reply of the story, also when hidden from the AI after a summary (hidden: as the bridge reads it); not the app's notes.
const storyReply = x => !x?.is_user && (!x?.is_system || (x.hidden ?? !(x.extra?.type || x.extra?.isSmallSys)));
const titleLike = text => !!text && text.length >= 2 && text.length <= 30 && WORDY.test(text) && !NOT_TITLE.test(text);

const titleFor = (request, reply) => titleParts(request, reply).title;
// The title and whether it says little (the request's words as they are: nothing named, no heading, no clause left).
function titleParts(request, reply) {
    const asked = plain(request);
    const named = asked.match(NAMED);
    const name = tidy(named?.[1] ?? named?.[2] ?? named?.[3] ?? '');
    if (titleLike(name)) return { title: name, weak: false };
    // The author's own heading on the request ("# 旧照片2"), then the reply's.
    for (const lines of [said(request).split('\n').slice(0, 2), storyPart(reply).split('\n').slice(0, 8)]) {
        for (const line of lines.map(l => l.trim()).filter(Boolean)) {
            const m = line.match(HEADING);
            const heading = tidy(m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4] ?? '');
            if (titleLike(heading)) return { title: heading, weak: false };
        }
    }
    // What it is about: the words after 内容为/主要内容是…, else the request without its instructions.
    const about = asked.split(/(?:大概|大致|主要)?内容(?:(?:是|为)\s*[:：]?|\s*[:：])/).slice(1).join(' ').trim();
    const clauses = (about || asked).replace(/^#{1,6}[^\n]*\n/, '').split(/[，,。；;！!？?\n（）():：]+/).map(c => c.replace(/^[\s$]+/, '').trim())
        .filter(c => c && (about || !NOISE.test(c)));
    const title = (clauses.join('，') || asked).replace(/\s+/g, ' ').slice(0, 24) || '番外';
    return { title, weak: !clauses.length };
}

const starts = ({ text }) => START.test(text), backs = ({ text }) => BACK.test(text.replace(NEGATED, ' '));

/**
 * What one request of the author's says about the story's lines: { action: 'start', kind, title }, { action: 'back' }
 * or null. The rules findInlineEpisodes reads a whole story with, and Horae's storylines read a request with.
 */
export function lineDirective(request, reply = '') {
    const text = said(request);
    if (starts({ text })) return { action: 'start', kind: kindOf(text), ...titleParts(request, reply) };
    return backs({ text }) ? { action: 'back' } : null;
}

/**
 * The name to show for a line named from a request that said little (`auto` in own-lines.js): named again with the
 * reply it got, its heading for example; null when there is nothing better.
 */
export function lineName(line, messages, first) {
    if (!line?.auto || !messages?.[first]?.is_user) return null;
    const reply = messages.slice(first + 1, first + 4).find(storyReply)?.mes;
    return reply ? lineDirective(messages[first].mes, reply)?.title ?? null : null;
}

/** The kind a request asks for when it starts a line ('side', 'parallel', 'skit'), or null when it starts none. */
export const requestKind = request => { const text = said(request); return starts({ text }) ? kindOf(text) : null; };

/** [{ from, to, requestIndex, title, kind, count }] in story order; messages as stored ({ is_user, is_system, mes }). */
export function findInlineEpisodes(messages) {
    const list = Array.isArray(messages) ? messages : [];
    // Requests hidden from the AI afterwards (/hide) are still the author's requests.
    const asks = list.map((m, i) => ({ i, m, text: said(m?.mes) })).filter(({ m }) => m?.is_user && typeof m.mes === 'string');
    const found = [];
    for (let k = 0; k < asks.length; k++) {
        const { i, m } = asks[k];
        if (!starts(asks[k])) continue;
        let to = list.length - 1;
        for (let j = k + 1; j < asks.length; j++) {
            if (starts(asks[j]) || backs(asks[j])) { to = asks[j].i - 1; break; }
        }
        if (to <= i) continue; // nothing was written for it
        const reply = list.slice(i + 1, to + 1).find(storyReply)?.mes ?? '';
        found.push({ from: i, to, requestIndex: i, title: titleFor(m.mes, reply), kind: kindOf(said(m.mes)), count: to - i + 1 });
    }
    return found;
}

/**
 * Where an older story's lines start and end, read with the same rules: [{ index, action: 'start' | 'back', title,
 * kind }], for the author to confirm before anything is marked (own-lines.js 'apply-suggestions').
 */
export function suggestLineMarks(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const out = [];
    for (const item of findInlineEpisodes(list)) {
        if (item.from > 0) out.push({ index: item.from, action: 'start', title: item.title, kind: item.kind });
        const after = item.to + 1, next = list[after];
        // Ended by a request going back (not by the next 番外, which is a start of its own, nor by the end of the story).
        if (next?.is_user && typeof next.mes === 'string' && !starts({ text: said(next.mes) })) out.push({ index: after, action: 'back' });
    }
    return out;
}

const HEAD = 60;
/** The opening words of each of the author's requests: what "让 AI 帮忙分段" sends, and only that. */
export function requestHeads(messages, head = HEAD) {
    return (Array.isArray(messages) ? messages : []).map((m, index) => ({ index, m }))
        .filter(({ m }) => m?.is_user && typeof m.mes === 'string')
        .map(({ index, m }) => ({ index, text: plain(m.mes).replace(/\s+/g, ' ').slice(0, head) }))
        .filter(({ text }) => text);
}

export function aiLinePrompt(heads) {
    return [
        '下面是一个故事里作者每次发言的开头，# 后面是楼层号。作者有时会让 AI 暂时写番外、平行线或小剧场，之后再回到正文。',
        '请找出换线的楼层。「暂停剧情，自检……」这类检查不算换线；裸的「回到剧情」「继续剧情」是接着当前这条线写，也不算。',
        '只回答一个 JSON 数组，不要别的文字。每项：{"floor": 楼层号, "action": "start" 或 "back", "kind": "side"（番外）/"parallel"（平行线）/"skit"（小剧场）, "title": "不超过 12 个字的名字"}。',
        'start 是从这一楼起开一条新线，back 是从这一楼起回到正文。没有换线就回答 []。',
        '',
        ...heads.map(({ index, text }) => `#${index} ${text}`),
    ].join('\n');
}

/** The model's answer as suggestions, keeping only floors that are the author's requests sent to it. */
export function parseAiLines(answer, heads) {
    // A thinking model's notes come first and may hold brackets of their own.
    const text = String(answer ?? '').replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').replace(/```(?:json)?/gi, '');
    const start = text.indexOf('['), end = text.lastIndexOf(']');
    if (start < 0 || end <= start) return null;
    let items;
    try { items = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
    if (!Array.isArray(items)) return null;
    const asked = new Set(heads.map(h => h.index)), seen = new Set();
    return items.map(item => ({ index: Number(item?.floor), action: item?.action === 'back' ? 'back' : item?.action === 'start' ? 'start' : null,
        kind: ['side', 'parallel', 'skit'].includes(item?.kind) ? item.kind : 'side', title: String(item?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 24) || '番外' }))
        .filter(item => item.action && asked.has(item.index) && item.index > 0 && !seen.has(item.index) && seen.add(item.index))
        .map(item => item.action === 'back' ? { index: item.index, action: 'back' } : item)
        .sort((a, b) => a.index - b.index);
}
