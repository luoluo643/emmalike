import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectExtension, scanExtensions } from '../bridge-extension-scan.js';

const origin = 'http://tavern.test';
const at = path => `${origin}/scripts/extensions/third-party/${path}`;
const site = files => {
    const fetched = [];
    return {
        origin,
        fetched,
        fetchText: async url => {
            fetched.push(url);
            const file = files[url];
            if (file instanceof Error) throw file;
            return file ?? null;
        },
    };
};

test('label comes from the manifest; a write found in an imported file counts', async () => {
    const options = site({
        [at('mem/manifest.json')]: JSON.stringify({ display_name: '记忆扩展', js: 'index.js?ver=2' }),
        [at('mem/index.js?ver=2')]: "import { a } from './lib/a.js';\nimport x from '../../../../script.js';",
        [at('mem/lib/a.js')]: "import('./b.js');",
        [at('mem/lib/b.js')]: 'export const save = () => ctx.saveMetadataDebounced();',
    });
    assert.deepEqual(await inspectExtension('third-party/mem', options), { name: 'third-party/mem', label: '记忆扩展', writes: true });
    assert.ok(options.fetched.includes(at('mem/index.js?ver=2')), 'the entry is fetched with its query, as the app loads it');
    assert.ok(!options.fetched.some(url => url.endsWith('/script.js')), 'imports outside the extension are not read');
});

test('an extension that never saves the chat does not count', async () => {
    const options = site({
        [at('avatar/manifest.json')]: JSON.stringify({ display_name: '头像', js: 'index.js' }),
        [at('avatar/index.js')]: 'eventSource.on(event_types.CHAT_CHANGED, refreshAvatars);',
    });
    assert.equal((await inspectExtension('third-party/avatar', options)).writes, false);
});

test('chat save API and variable commands count as writing', async () => {
    for (const code of ["fetch('/api/chats/save', {})", "executeSlashCommands('/setvar key=a 1')", 'getContext().saveChat()']) {
        const options = site({
            [at('x/manifest.json')]: JSON.stringify({ js: 'i.js' }),
            [at('x/i.js')]: code,
        });
        assert.equal((await inspectExtension('third-party/x', options)).writes, true, code);
    }
});

test('unreadable code counts as writing; a missing script or no script does not run', async () => {
    const broken = site({
        [at('b/manifest.json')]: JSON.stringify({ display_name: 'B', js: 'i.js' }),
        [at('b/i.js')]: new Error('HTTP 500'),
    });
    assert.deepEqual(await inspectExtension('third-party/b', broken), { name: 'third-party/b', label: 'B', writes: true, unreadable: true });
    const badManifest = site({ [at('c/manifest.json')]: 'Forbidden' });
    assert.deepEqual(await inspectExtension('third-party/c', badManifest), { name: 'third-party/c', label: 'c', writes: true, unreadable: true });
    const missing = site({ [at('d/manifest.json')]: JSON.stringify({ display_name: 'D', js: 'gone.js' }) });
    assert.equal((await inspectExtension('third-party/d', missing)).writes, false);
    const styleOnly = site({ [at('e/manifest.json')]: JSON.stringify({ display_name: ' ', css: 'style.css' }) });
    assert.deepEqual(await inspectExtension('third-party/e', styleOnly), { name: 'third-party/e', label: 'e', writes: false });
});

test('scanExtensions reports every extension', async () => {
    const options = site({
        [at('one/manifest.json')]: JSON.stringify({ display_name: '一', js: 'i.js' }),
        [at('one/i.js')]: 'saveChatConditional()',
        [at('two/manifest.json')]: JSON.stringify({ display_name: '二', js: 'i.js' }),
        [at('two/i.js')]: 'console.log(1)',
    });
    assert.deepEqual((await scanExtensions(['third-party/one', 'third-party/two'], options)).map(e => [e.label, e.writes]), [['一', true], ['二', false]]);
});
