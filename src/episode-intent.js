// Deliberately small author-command grammar. It never invokes a classifier or follows model output.
export const EPISODE_KINDS = { side: '番外', parallel: '平行线', skit: '小剧场' };
export const CONTEXT_MODES = { continued: '接续正文最新进度', fresh: '不复制正文' };
const labelKind = label => ({ 番外: 'side', 平行线: 'parallel', 平行世界: 'parallel', 小剧场: 'skit' })[label];
export function detectEpisodeIntent(value) {
    const text = String(value ?? '').trim();
    // Quoted speech, negation, dreams and ordinary time changes are not commands.
    if (!text || /^[“「『"'>]|^(?:不要|别|不用|不想|并非|不是|如果|假如|梦见|梦到)/.test(text)) return null;
    const continuation = text.match(/^(?:继续|续写)(?:那个|之前的)?(?:番外|平行线|小剧场)?\s*[《「](.+?)[》」](?:[：:，,\s]|$)/);
    if (continuation) return { action: 'continue', title: continuation[1].trim(), text };
    if (/^(?:继续|续写)(?:上次|之前|刚才)(?:的)?(?:番外|平行线|小剧场)/.test(text)) return { action: 'choose-existing', text };
    const prefix = text.match(/^(?:【|\[)(番外|平行线|小剧场)(?:】|\])\s*[:：]?\s*/);
    const command = text.match(/^(?:请)?(?:写|开|新开|来)(?:一(?:个|篇|段))?(番外|平行线|小剧场)(?:[：:，,。\s]|$)/);
    const match = prefix || command;
    if (!match) return null;
    const kind = labelKind(match[1]);
    const historical = /(?:回到|回溯|从)(?:第\s*[\d一二三四五六七八九十]+(?:条|章)|那时|当时|以前|之前)|(?:这条|这里|过去|历史)(?:的)?(?:进度|状态|节点)/.test(text);
    const fresh = /(?:不(?:要)?(?:复制|继承|接续|带入)正文|清空(?:正文|前文)|重新(?:开始|认识)|全新(?:背景|世界))/i.test(text);
    const changedWorld = /(?:换(?:个|一个)?世界|平行世界|\bAU\b|现代(?:AU|背景)|校园(?:AU|背景)|架空世界)/i.test(text);
    const title = text.slice(match[0].length).replace(/\s+/g, ' ').slice(0, 36) || EPISODE_KINDS[kind];
    return { action: 'create', kind, title, text, contextMode: fresh ? 'fresh' : changedWorld ? null : 'continued', historical };
}

export function resolveNamedEpisode(intent, nodes, rootId) {
    if (!intent || !['continue', 'choose-existing'].includes(intent.action)) return { kind: 'none', candidates: [] };
    const candidates = nodes.filter(node => node.relationship === 'resolved' && node.episode.rootId === rootId && node.episode.kind !== 'root');
    if (intent.action === 'choose-existing') return { kind: 'choose', candidates };
    const exact = candidates.filter(node => node.episode.title === intent.title);
    return exact.length === 1 ? { kind: 'unique', candidate: exact[0] } : { kind: 'choose', candidates: exact.length ? exact : candidates };
}

export const episodeLabel = meta => meta && EPISODE_KINDS[meta.kind] ? `${EPISODE_KINDS[meta.kind]} · ${meta.title}` : null;
