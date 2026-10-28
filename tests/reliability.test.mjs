import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { storyKey, findAnchor, messageMark } from '../src/story-state.js';

const source = (await readFile(new URL('../bridge.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').split('\n// Enhanced episode operations')[0];
function harness() {
    const chat = [], calls = [], textarea = { value: '', dispatchEvent() {} };
    let file = 'story-a', account = 'unit-account', worldDirty = false, writeFetch = async () => ({ ok: true });
    const document = { body: { children: [] }, documentElement: { isConnected: true }, getElementById: () => textarea };
    const window = { document, frameElement: { isConnected: true } }; document.defaultView = window;
    const context = { chat, onlineStatus: 'connected', characters: [{ avatar: 'a.png', name: 'A' }], characterId: 0, getCurrentChatId: () => file };
    const sandbox = { console, setTimeout, clearTimeout, Date, Promise, structuredClone,
        users: { currentUser: { handle: 'unit-account' } },
        episodeError: (code, message) => Object.assign(new Error(message), { code }),
        fetch: (url, init) => url === '/api/users/me' ? Promise.resolve({ ok: true, json: async () => ({ handle: account }) }) : writeFetch(url, init),
        Event: class {}, document, window, bridgeDocument: document,
        worldEditor: { assertWorldRuntimeReady() { if (worldDirty) throw Object.assign(new Error('World needs review'), { code: 'WORLD_RUNTIME_UNCONFIRMED' }); } },
        st: { is_send_press: false, isChatSaving: false, getRequestHeaders: () => ({}), sendTextareaMessage: async () => { calls.push(textarea.value); chat.push({ mes: textarea.value }); } },
        openai: { oai_settings: { preset_settings_openai: 'P', prompts: [{ content: 'before' }] }, getChatCompletionPreset: s => ({ prompts: s.prompts }), openai_setting_names: { P: 0 }, openai_settings: [{}] },
        SillyTavern: { getContext: () => context } };
    vm.createContext(sandbox); vm.runInContext(source, sandbox);
    const api = vm.runInContext('({send, enqueue, savePreset})', sandbox);
    return { ...api, sandbox, chat, calls, textarea, markWorldDirty: () => { worldDirty = true; }, setFetch: fn => { writeFetch = fn; }, switchAccount: () => { account = 'other-account'; }, switchStory: () => { file = 'story-b'; } };
}
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };

test('cancel a bridge-queued message: no native call, even after its predecessor completes', async () => {
    const h = harness(), g = gate();
    const predecessor = h.enqueue(() => g.promise);
    const send = h.send('must never send');
    const result = assert.rejects(send, e => e.code === 'cancelled');
    assert.equal(send.cancel(), true); assert.equal(send.cancel(), false);
    g.release(); await predecessor; await result; await h.enqueue(() => {});
    assert.deepEqual(h.calls, []);
});
test('queued send checks story at execution, not just at creation', async () => {
    const h = harness(), g = gate(); h.enqueue(() => g.promise);
    const send = h.send('belongs to A');
    const result = assert.rejects(send, e => e.code === 'story-changed');
    h.switchStory(); g.release(); await result;
    assert.deepEqual(h.calls, []);
});
test('native submission is the cancellation boundary and queue waits for generation', async () => {
    const h = harness(), g = gate();
    h.sandbox.st.sendTextareaMessage = async () => { h.calls.push('first'); h.chat.push({}); await g.promise; };
    const first = h.send('first'); await first;
    assert.equal(first.cancel(), false);
    const second = h.send('second');
    const result = assert.rejects(second, e => e.code === 'cancelled');
    assert.equal(second.cancel(), true); g.release(); await result; await h.enqueue(() => {});
    assert.deepEqual(h.calls, ['first']);
});
test('a failed named preset save does not report success or overwrite the saved copy', async () => {
    const h = harness(); h.setFetch(async () => ({ ok: false }));
    await assert.rejects(h.savePreset(), /预设没存上/);
    assert.deepEqual(h.sandbox.openai.openai_settings[0], {});
});
test('a queued save cannot accidentally write to a newly selected preset', async () => {
    const h = harness(), g = gate(); let writes = 0;
    h.setFetch(async () => { writes++; return { ok: true }; });
    h.enqueue(() => g.promise);
    const save = h.savePreset();
    const result = assert.rejects(save, /预设换了/);
    h.sandbox.openai.oai_settings.preset_settings_openai = 'Other';
    g.release(); await result;
    assert.equal(writes, 0);
});
test('preset HTTP and in-memory saved copy use the same captured content', async () => {
    const h = harness(), g = gate(), entered = gate(); let body;
    h.setFetch(async (_url, init) => { body = JSON.parse(init.body); entered.release(); await g.promise; return { ok: true }; });
    const save = h.savePreset(); await entered.promise;
    h.sandbox.openai.oai_settings.prompts[0].content = 'edited while saving';
    g.release(); await save;
    assert.equal(body.preset.prompts[0].content, 'before');
    assert.equal(h.sandbox.openai.openai_settings[0].prompts[0].content, 'before');
    assert.equal(h.sandbox.openai.oai_settings.prompts[0].content, 'edited while saving');
});
test('reading keys isolate accounts and ambiguous messages never claim exact recovery', () => {
    assert.notEqual(storyKey('reading', 'alice', 'a:b', 'c'), storyKey('reading', 'bob', 'a:b', 'c'));
    assert.notEqual(storyKey('reading', 'alice', 'a:b', 'c'), storyKey('reading', 'alice', 'a', 'b:c'));
    assert.equal(storyKey('reading', '', 'a', 'b'), null);
    const messages = [{ mes: 'one' }, { mes: 'two' }, { mes: 'three' }];
    const saved = { anchor: { index: 1, mark: messageMark(messages[1]) }, neighbors: [{ index: 0, mark: messageMark(messages[0]) }] };
    assert.deepEqual(findAnchor(messages.slice(1), saved), { index: 0, exact: true });
    assert.deepEqual(findAnchor([messages[0], messages[2]], saved), { index: 0, exact: false });
    assert.deepEqual(findAnchor([messages[1], messages[1]], saved), { index: 1, exact: false });
});

test('a queued send rejects on account change instead of hanging or calling native send', async () => {
    const h = harness(); h.switchAccount();
    await assert.rejects(h.send('belongs to the previous account'), e => e.code === 'ACCOUNT_CHANGED');
    assert.deepEqual(h.calls, []);
});

test('world gate is checked again after synchronous input listeners and before native submission', async () => {
    const h = harness(); h.textarea.dispatchEvent = h.markWorldDirty;
    await assert.rejects(h.send('must remain a draft'), e => e.code === 'WORLD_RUNTIME_UNCONFIRMED');
    await h.enqueue(() => {});
    assert.deepEqual(h.calls, []);
});

test('a removed engine iframe cannot submit even while its old document remains connected', async () => {
    const h = harness(); h.sandbox.window.frameElement.isConnected = false;
    await assert.rejects(h.send('old frame'), e => e.code === 'ACCOUNT_CHANGED');
    assert.deepEqual(h.calls, []);
});
