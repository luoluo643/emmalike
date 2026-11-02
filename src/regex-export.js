import { normalizeScript, exportName } from './regex-model.js';

export function regexExport(scripts, name = '正则') {
    if (!scripts.length) throw new Error('还没有选中正则');
    const list = scripts.map(script => ({ id: script.id, ...normalizeScript(script) }));
    return { name: exportName(list.length === 1 ? list[0].scriptName : name), count: list.length,
        text: JSON.stringify(list.length === 1 ? list[0] : list, null, 4) };
}
