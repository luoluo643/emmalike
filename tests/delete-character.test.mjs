import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const moduleUrl = process.env.TL_API_MODULE
    ? pathToFileURL(process.env.TL_API_MODULE)
    : new URL('../src/api.js', import.meta.url);
let serial = 0;

async function fixture(t, respond) {
    const calls = [], events = [];
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'dispatchEvent');
    globalThis.dispatchEvent = event => { events.push(event.type); return true; };
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, 'dispatchEvent', previous);
        else delete globalThis.dispatchEvent;
    });
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url, options });
        if (url === '/csrf-token') return Response.json({ token: 'test-csrf' });
        return respond(url, options);
    });
    const api = await import(`${moduleUrl.href}?delete-test=${++serial}`);
    return { api, calls, events };
}

test('delete accepts plain OK without invoking the Safari JSON parser', async t => {
    let parsed = 0;
    const response = new Response('OK');
    response.json = async () => {
        parsed++;
        throw new DOMException('The string did not match the expected pattern.', 'SyntaxError');
    };
    const { api, calls } = await fixture(t, () => response);
    await api.deleteCharacter('测试角色.png');
    assert.equal(parsed, 0);
    const request = calls.find(c => c.url === '/api/characters/delete');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.credentials, 'same-origin');
    assert.equal(request.options.headers['X-CSRF-Token'], 'test-csrf');
    assert.deepEqual(JSON.parse(request.options.body), { avatar_url: '测试角色.png', delete_chats: true });
});

test('delete accepts 204 without reading a body', async t => {
    const { api } = await fixture(t, () => new Response(null, { status: 204 }));
    await api.deleteCharacter('test.png');
});

for (const status of [401, 403]) {
    test(`delete preserves login-expired handling for ${status} and renews CSRF`, async t => {
        let attempt = 0;
        const { api, calls, events } = await fixture(t, () => ++attempt === 1
            ? new Response('Unauthorized', { status }) : new Response('OK'));
        await assert.rejects(api.deleteCharacter('test.png'), api.AuthRequired);
        assert.deepEqual(events, ['tl-auth-required']);
        await api.deleteCharacter('test.png');
        assert.equal(calls.filter(c => c.url === '/csrf-token').length, 2);
    });
}

for (const status of [400, 500]) {
    test(`delete propagates HTTP ${status} rather than claiming success`, async t => {
        const { api } = await fixture(t, () => new Response('delete rejected', { status }));
        await assert.rejects(api.deleteCharacter('test.png'), /delete rejected/);
    });
}

test('delete supplies a useful message when the failed response body is empty', async t => {
    const { api } = await fixture(t, () => new Response('', { status: 503 }));
    await assert.rejects(api.deleteCharacter('test.png'), /503/);
});

test('delete propagates a network failure', async t => {
    const failure = new TypeError('network unavailable');
    const { api } = await fixture(t, () => { throw failure; });
    await assert.rejects(api.deleteCharacter('test.png'), error => error === failure);
});

test('JSON endpoints still parse their responses', async t => {
    const user = { handle: 'test-user', name: 'Test User' };
    const { api } = await fixture(t, () => Response.json(user));
    assert.deepEqual(await api.getCurrentUser(), user);
});

test('JSON endpoints still reject invalid JSON', async t => {
    const { api } = await fixture(t, () => new Response('not JSON'));
    await assert.rejects(api.getCurrentUser(), SyntaxError);
});
