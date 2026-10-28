// A story and the 番外/平行线 lines copied from it, read from the stories' own headers (the chat list carries them):
// which story a line came from, and at which message it left. Used to show the 正文 as the main session and each line
// as a branch of it; every line stays a separate story.
import { EPISODE_NAMESPACE, identityKey, validateEpisodeMeta } from './episode-model.js';

const fileOf = name => String(name ?? '').replace(/\.jsonl$/, '');
const integrity = chapter => {
    try { return identityKey(chapter?.chat_metadata?.integrity); } catch { return null; }
};
const episodeOf = (chapter, account) => {
    const parsed = validateEpisodeMeta(chapter?.chat_metadata?.[EPISODE_NAMESPACE], account);
    return parsed.kind === 'valid' ? parsed.value : null;
};

/** The story a line was copied from: the file it names, if that file is still the same story, else the only story with its identity. */
function parentOf(chapters, line, account) {
    const owns = chapter => integrity(chapter) === line.parentId || episodeOf(chapter, account)?.episodeId === line.parentId;
    const named = fileOf(line.sourceAnchor?.locator?.file);
    const byFile = named && chapters.find(chapter => fileOf(chapter.file_name) === named && owns(chapter));
    if (byFile) return byFile;
    const byId = chapters.filter(owns);
    return byId.length === 1 ? byId[0] : null;
}

/**
 * Where a line leaves its story: the last message it took (a continued line copies up to there; a fresh one starts
 * from there with none), or for a part split out, the last message of that part.
 */
function forkIndex(line) {
    if (Number.isSafeInteger(line.extractedFrom?.to)) return line.extractedFrom.to;
    const anchor = line.sourceAnchor?.anchor?.index;
    if (Number.isSafeInteger(anchor)) return anchor;
    const count = line.sourceAnchor?.messageCount;
    return Number.isSafeInteger(count) && count > 0 ? count - 1 : null;
}

/**
 * For the open story `file`: its parent (when it is a line), the message where its own writing starts (continued lines
 * only: everything up to there was copied), and the lines copied from it, oldest first.
 */
export function storyBranches(chapters, file, account) {
    const list = Array.isArray(chapters) ? chapters : [];
    const here = list.find(chapter => fileOf(chapter.file_name) === fileOf(file));
    const own = here ? episodeOf(here, account) : null;
    const line = own && own.kind !== 'root' ? own : null;
    const parent = line ? parentOf(list, line, account) : null;
    const children = list.map(chapter => ({ chapter, episode: episodeOf(chapter, account) }))
        .filter(({ chapter, episode }) => episode && episode.kind !== 'root' && fileOf(chapter.file_name) !== fileOf(file)
            && here && parentOf(list, episode, account) === here)
        .map(({ chapter, episode }) => ({ file: fileOf(chapter.file_name), kind: episode.kind, title: episode.title, contextMode: episode.contextMode,
            extracted: episode.extractedFrom ?? null, forkIndex: forkIndex(episode), items: chapter.chat_items ?? null, lastAt: chapter.last_mes ?? null,
            createdAt: episode.createdAt }))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return {
        line: line ? { kind: line.kind, title: line.title } : null,
        parent: parent ? { file: fileOf(parent.file_name) } : null,
        ownStart: line && line.contextMode === 'continued' && !line.extractedFrom ? forkIndex(line) : null,
        children,
    };
}

/** The lines grouped by the message they leave at, for marks under those messages. */
export function forksByIndex(children) {
    const marks = new Map();
    for (const child of children ?? []) {
        if (child.forkIndex === null) continue;
        marks.set(child.forkIndex, [...(marks.get(child.forkIndex) ?? []), child]);
    }
    return marks;
}
