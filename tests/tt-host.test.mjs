import test from 'node:test';
import assert from 'node:assert/strict';
import { clipToRects, clipWithHoles, disjointRects, installTtRequests, isTauriTavern, isTestedTtVersion, missingChatAnswer, ttHostWindow, ttSillyTavernVersion, ttUser, ttVersionOf, unsupportedEndpoint, TT_ACCOUNT, TT_SHELL_MARK } from '../src/tt-host.js';

function shellIn(host, mark = TT_SHELL_MARK) {
    return { parent: host, frameElement: { dataset: { tavernLite: mark } }, location: { href: 'http://tauri.localhost/scripts/extensions/third-party/x/app/index.html', origin: 'http://tauri.localhost' }, URL };
}

test('TT is recognised by its host object; a shell only by its frame mark over a TT page', () => {
    const tt = { __TAURITAVERN__: {} };
    assert.equal(isTauriTavern(tt), true);
    assert.equal(isTauriTavern({}), false);
    assert.equal(isTauriTavern({ get __TAURITAVERN__() { throw new Error('cross-origin'); } }), false);
    assert.equal(ttHostWindow(shellIn(tt)), tt);
    assert.equal(ttHostWindow(shellIn({})), null, 'a server page is not TT');
    assert.equal(ttHostWindow(shellIn(tt, 'engine')), null, 'the engine frame is not the shell');
    assert.equal(ttHostWindow({ frameElement: null }), null);
    const self = shellIn(null); self.parent = self; self.__TAURITAVERN__ = {};
    assert.equal(ttHostWindow(self), null);
});

test('the single user matches SillyTavern without accounts', () => {
    assert.equal(ttUser().handle, TT_ACCOUNT);
    assert.equal(TT_ACCOUNT, 'default-user');
});

test('TT answers are read as TT words them', () => {
    assert.equal(unsupportedEndpoint('{"error":"Unsupported endpoint: /api/users/me"}'), '/api/users/me');
    assert.equal(unsupportedEndpoint('{"error":"Failed"}'), null);
    assert.equal(unsupportedEndpoint('<!DOCTYPE html>'), null);
    const missing = '{"error":"Failed to load chat","details":"Not found: /x/chats/default_A/story.jsonl"}';
    assert.equal(missingChatAnswer(500, missing), true);
    assert.equal(missingChatAnswer(200, missing), false);
    assert.equal(missingChatAnswer(500, '{"error":"Failed to load chat","details":"Permission denied"}'), false);
    assert.equal(ttVersionOf({ pkgVersion: '1.19.0', tauriVersion: '2.4.0' }), '2.4.0');
    assert.equal(ttVersionOf({}), '');
    assert.equal(isTestedTtVersion('2.4.0'), true);
    assert.equal(isTestedTtVersion('2.5.0'), false);
    assert.equal(ttSillyTavernVersion('SillyTavern:1.19.0:TauriTavern'), 'SillyTavern 1.19.0');
    assert.equal(ttSillyTavernVersion('SillyTavern:UNKNOWN:Cohee#1207'), '');
    assert.equal(ttSillyTavernVersion(undefined), '');
});

test('clip paths: holes keep the whole frame and cut the rectangles out; the tab path is only the rectangles', () => {
    assert.equal(clipWithHoles([{ x: 10, y: 20, width: 30, height: 40 }], 100, 200, 0), "path(evenodd, 'M0 0H100V200H0zM10 20h30v40h-30z')");
    assert.equal(clipToRects([{ x: 10, y: 20, width: 30, height: 40 }], 2), "path('M8 18h34v44h-34z')");
});

test('the shell sends API reads to TT\'s page and everything else on as before', async () => {
    const seen = [];
    const host = { __TAURITAVERN__: {}, fetch: (input, init) => { seen.push(['host', input, init?.method]); return 'host'; } };
    const shell = shellIn(host);
    shell.fetch = function (input) { seen.push(['own', String(input)]); return 'own'; };
    assert.equal(installTtRequests(shell), true);
    assert.equal(installTtRequests(shell), false, 'once');
    assert.equal(await shell.fetch('/api/characters/all', { method: 'POST' }), 'host');
    assert.equal(await shell.fetch('/csrf-token'), 'host');
    assert.equal(await shell.fetch('/version'), 'host');
    assert.equal(await shell.fetch('/thumbnail?type=avatar&file=a.png'), 'own');
    assert.equal(await shell.fetch('./assets/x.js'), 'own');
    assert.equal(await shell.fetch('https://example.com/api/x'), 'own');
    assert.deepEqual(seen[0], ['host', 'http://tauri.localhost/api/characters/all', 'POST']);
    assert.equal(installTtRequests(shellIn({})), false, 'not on a server');
});

// Whether (x, y) is cut out by an even-odd clip made of the outer frame and `holes`: the number of holes holding it,
// plus the frame, is even.
function cutAt(holes, x, y) {
    return holes.filter(r => x > r.x && x < r.x + r.width && y > r.y && y < r.y + r.height).length % 2 === 1;
}

test('holes that overlap are cut out as one area: every point of any rectangle is cut, nothing else is', () => {
    const cases = {
        crossing: [{ x: 20, y: 100, width: 100, height: 100 }, { x: 70, y: 150, width: 100, height: 100 }],
        inside: [{ x: 10, y: 10, width: 200, height: 200 }, { x: 50, y: 50, width: 20, height: 20 }],
        same: [{ x: 30, y: 30, width: 40, height: 40 }, { x: 30, y: 30, width: 40, height: 40 }],
        touching: [{ x: 0, y: 0, width: 50, height: 50 }, { x: 50, y: 0, width: 50, height: 50 }],
        outside: [{ x: -40, y: -40, width: 80, height: 80 }, { x: 380, y: 780, width: 100, height: 100 }, { x: 500, y: 500, width: 10, height: 10 }],
        three: [{ x: 10, y: 10, width: 60, height: 60 }, { x: 40, y: 40, width: 60, height: 60 }, { x: 25, y: 55, width: 10, height: 100 }],
    };
    const W = 400, H = 800;
    for (const [name, rects] of Object.entries(cases)) {
        const holes = disjointRects(rects, W, H);
        for (const r of holes) {
            assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= W && r.y + r.height <= H, `${name}: inside the frame`);
        }
        for (let x = 0.5; x < W; x += 5) {
            for (let y = 0.5; y < H; y += 5) {
                const want = rects.some(r => x > r.x && x < r.x + r.width && y > r.y && y < r.y + r.height);
                assert.equal(cutAt(holes, x, y), want, `${name} at ${x},${y}`);
            }
        }
    }
    assert.equal(disjointRects(cases.crossing, W, H).length, 3);
    assert.equal(disjointRects(cases.same, W, H).length, 1);
    assert.deepEqual(disjointRects([], W, H), []);
    assert.equal(clipWithHoles(cases.same, 100, 100, 0), "path(evenodd, 'M0 0H100V100H0zM30 30h40v40h-40z')");
});
