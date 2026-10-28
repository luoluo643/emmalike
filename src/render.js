const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
    return text.replace(/[&<>"']/g, c => ESCAPES[c]);
}

export function substituteNames(text, charName, userName) {
    return String(text ?? '')
        .replace(/\{\{char\}\}/gi, charName ?? '')
        .replace(/\{\{user\}\}/gi, userName ?? '');
}

const inline = line => line
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/(&quot;|“|「|『)(.+?)(&quot;|”|」|』)/g, '<q>$1$2$3</q>');

// Escaped text → light markdown: headings, rules, bullets, emphasis, quotes; blank-line runs count as one.
function inlineMarkdown(html) {
    const parts = [];
    for (const line of html.replace(/\n{3,}/g, '\n\n').split('\n')) {
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) parts.push({ block: `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>` });
        else if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) parts.push({ block: '<hr>' });
        else parts.push({ text: inline(line.replace(/^(\s*)[*+-]\s+/, '$1• ')) });
    }
    return parts.map((part, i) => part.block ?? (part.text + (parts[i + 1]?.text !== undefined ? '<br>' : ''))).join('');
}

// Display regex scripts as the app runs them (extensions/regex/engine.js runRegexScript): same pattern parsing,
// {{match}} and $n / $<name> groups, trim strings, depth limits. Rules come from bridge.displayRules().
const compiled = new Map();
function regexOf(source) {
    if (compiled.has(source)) return compiled.get(source);
    let regex = null;
    try {
        const m = source.match(/(\/?)(.+)\1([a-z]*)/i);
        regex = m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3]) ? RegExp(source) : new RegExp(m[2], m[3]);
    } catch { regex = null; }
    if (compiled.size > 500) compiled.clear();
    compiled.set(source, regex);
    return regex;
}

export function applyRules(text, rules, { user = false, depth, charName, userName } = {}) {
    const placement = user ? 1 : 2;
    let out = text;
    for (const rule of rules ?? []) {
        if (!rule?.find || !out || !rule.placement?.includes(placement)) continue;
        if (typeof depth === 'number') {
            if (rule.minDepth !== null && Number(rule.minDepth) >= -1 && depth < Number(rule.minDepth)) continue;
            if (rule.maxDepth !== null && Number(rule.maxDepth) >= 0 && depth > Number(rule.maxDepth)) continue;
        }
        const regex = regexOf(rule.find);
        if (!regex) continue;
        regex.lastIndex = 0;
        out = out.replace(regex, function (match) {
            const args = [...arguments];
            const replaced = rule.replace.replace(/{{match}}/gi, '$0').replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_, num, name) => {
                let value = num ? args[Number(num)] : args[args.length - 1]?.[name];
                if (!value) return '';
                for (const trim of rule.trim) value = value.replaceAll(substituteNames(trim, charName, userName), '');
                return value;
            });
            return substituteNames(replaced, charName, userName);
        });
    }
    return out;
}

// What the app's sanitizer keeps; other elements are unwrapped (their text stays), these go with their content.
const KEEP = new Set(('a abbr article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del details '
    + 'dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd label li mark nav ol p pre '
    + 'q rp rt ruby s samp section small span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var').split(' '));
const DROP = new Set('script style link meta base iframe frame frameset object embed noscript template textarea select input button form svg math audio video source track canvas title head'.split(' '));
const ATTRS = new Set('class style title open colspan rowspan align valign color size face lang dir alt width height href src'.split(' '));
const BLOCK = new Set('address article aside blockquote center details div dl dt dd figure footer h1 h2 h3 h4 h5 h6 header hr li nav ol p pre section summary table tbody thead tfoot tr td th ul'.split(' '));
const SAFE_URL = /^(?:https?:|\/|\.{0,2}\/|#|data:image\/)/i;

function isBlock(node) {
    return node?.nodeType === 1 && BLOCK.has(node.localName);
}

function cleanTree(root) {
    const doc = root.ownerDocument;
    for (const node of [...root.childNodes]) {
        if (node.nodeType === 8) { node.remove(); continue; }
        if (node.nodeType !== 1) continue;
        const tag = node.localName;
        if (DROP.has(tag)) { node.remove(); continue; }
        cleanTree(node);
        if (!KEEP.has(tag)) { node.replaceWith(...node.childNodes); continue; }
        for (const { name, value } of [...node.attributes]) {
            if (!ATTRS.has(name) || ((name === 'href' || name === 'src') && !SAFE_URL.test(value.trim()))) node.removeAttribute(name);
        }
        if (tag === 'a') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
    }
    // Text gets the light markdown; line breaks right next to blocks are layout, not breaks.
    for (const node of [...root.childNodes]) {
        if (node.nodeType !== 3 || root.closest?.('pre, code')) continue;
        let text = node.data;
        if (isBlock(node.previousSibling) || !node.previousSibling) text = text.replace(/^[ \t]*\n/, '');
        if (isBlock(node.nextSibling) || !node.nextSibling) text = text.replace(/\n[ \t]*$/, '');
        if (!text.trim() && (isBlock(node.previousSibling) || isBlock(node.nextSibling))) { node.remove(); continue; }
        const html = inlineMarkdown(escapeHtml(text));
        if (html === escapeHtml(node.data)) continue;
        const holder = doc.createElement('template');
        holder.innerHTML = html;
        node.replaceWith(holder.content);
    }
}

function richHtml(text) {
    const holder = document.createElement('template');
    holder.innerHTML = text.trim();
    cleanTree(holder.content);
    const box = document.createElement('div');
    box.append(holder.content);
    return box.innerHTML;
}

/**
 * Preview used until the full app has rendered the message: the remembered display regex scripts, then the HTML the
 * app would keep (tags it allows, comments and unknown tags hidden) with light markdown.
 */
export function previewHtml(text, charName, userName, { rules, user, depth } = {}) {
    const named = substituteNames(text, charName, userName);
    if (typeof document !== 'undefined' && document.createElement('template').content) {
        try {
            // Code blocks stay as written (the HTML parser drops NUL, so the marks are private-use characters); a page
            // in one is a frontend card, which only the full app can run (bridge.js uses the same test).
            const blocks = [];
            const ruled = applyRules(named, rules, { user, depth, charName, userName })
                .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => {
                    blocks.push(/html>|<head>|<body/i.test(code)
                        ? '<span class="tl-card-placeholder">［前端卡片：准备好后显示］</span>'
                        : `<pre><code>${escapeHtml(code)}</code></pre>`);
                    return `${blocks.length - 1}`;
                });
            return richHtml(ruled).replace(/(\d+)/g, (_, i) => blocks[Number(i)]);
        } catch { /* fall back to plain text */ }
    }
    let html = escapeHtml(named);
    const blocks = [];
    html = html.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => {
        blocks.push(`<pre><code>${code}</code></pre>`);
        return `\u0000${blocks.length - 1}\u0000`;
    });
    html = inlineMarkdown(html);
    return html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}
