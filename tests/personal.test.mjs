import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSource, locateSource, sameStory } from '../src/personal-model.js';

const source = makeSource({ avatar: 'a.png', file: 'story' }, { name: 'A', mes: 'original', is_user: false }, 5);

test('source lookup tolerates index shifts and candidate reordering but rejects ambiguity or edits', () => {
    const m = { name: 'A', mes: 'original', is_user: false };
    assert.equal(locateSource([{ name: 'other', mes: 'before' }, m], source).index, 1);
    const reordered = { ...m, mes: 'other version', swipes: ['other version', 'original'], swipe_id: 0 };
    assert.equal(locateSource([reordered], source).swipe, 1);
    assert.equal(locateSource([reordered], source).current, false);
    assert.equal(locateSource([m, m], source), null);
    assert.equal(locateSource([{ ...m, swipes: ['original', 'original'], swipe_id: 0 }], source), null);
    assert.equal(locateSource([{ ...m, mes: 'edited' }], source), null);
    assert.equal(locateSource([], source), null);
    assert.equal(sameStory({ groupId: 'a', file: 'same' }, { groupId: 'b', file: 'same' }), false);
    assert.equal(sameStory({ avatar: 'a', file: 'same' }, { groupId: 'a', file: 'same' }), false);
});
