import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForPictureFonts } from '../src/share-dom.js';

test('the font deadline covers both loading and a pending FontFaceSet.ready', async () => {
    for (const stuckAt of ['load', 'ready']) {
        const never = new Promise(() => {});
        const fonts = { load: () => stuckAt === 'load' ? never : Promise.resolve([]), ready: stuckAt === 'ready' ? never : Promise.resolve() };
        assert.equal(await waitForPictureFonts('Audit', '阿青', true, { fonts, timeout: 20 }), false);
    }
});

test('font preparation includes the title, body and italic weight and succeeds when all are ready', async () => {
    const calls = [];
    const fonts = { load: async (...args) => { calls.push(args); return []; }, ready: Promise.resolve() };
    assert.equal(await waitForPictureFonts('Audit', '阿青', true, { fonts, timeout: 100 }), true);
    assert.deepEqual(calls, [['16px Audit', '阿青'], ['600 16px Audit', '阿青'], ['italic 16px Audit', '阿青']]);
    assert.equal(await waitForPictureFonts('Audit', '阿青', false, { fonts: { load: () => Promise.reject(new Error('network')) }, timeout: 100 }), false);
});

test('closing aborts font waiting immediately, even when the browser request cannot be aborted', async () => {
    const controller = new AbortController();
    const pending = waitForPictureFonts('Audit', '阿青', false, { signal: controller.signal, fonts: { load: () => new Promise(() => {}) }, timeout: 10000 });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.throws(() => waitForPictureFonts('Audit', '', false, { signal: controller.signal }), { name: 'AbortError' });
});
