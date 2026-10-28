import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Words the interface no longer uses. Checked in every string a page or the
// bridge can show, so new features keep to the same wording.
const BANNED = ['子线', '聊天引擎', '查验', '命名预设', '命名文件', '归属', '目的地', '模型服务', '本设备', '这台设备', '提交快照', '运行内容', '您'];
// Internal checks that only reach the reader through friendlyError (ui.jsx), which shows a plain sentence instead.
const INTERNAL_ONLY = new Set(['src/episode-journal.js', 'src/episode-model.js', 'src/world-editor-journal.js', 'bridge-episodes.js', 'bridge-native-settle.js']);

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [
    ...readdirSync(join(root, 'src')).filter(f => /\.(js|jsx)$/.test(f)).map(f => `src/${f}`),
    ...readdirSync(root).filter(f => /^bridge.*\.js$/.test(f)),
].filter(f => !INTERNAL_ONLY.has(f));
const LITERAL = /'[^'\n]*'|"[^"\n]*"|`[^`]*`|>[^<>{}\n]+</g;

test('interface text keeps to the shared wording', () => {
    const hits = [];
    for (const file of files) {
        readFileSync(join(root, file), 'utf8').split('\n').forEach((line, index) => {
            const code = line.trim();
            if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
            for (const [text] of line.matchAll(LITERAL)) {
                if (!/[一-鿿]/.test(text)) continue;
                for (const word of BANNED) if (text.includes(word)) hits.push(`${file}:${index + 1} 「${word}」 ${text.slice(0, 60)}`);
            }
        });
    }
    assert.deepEqual(hits, []);
});
