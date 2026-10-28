import test from 'node:test';
import assert from 'node:assert/strict';
import { detectEpisodeIntent, resolveNamedEpisode } from '../src/episode-intent.js';
test('only explicit author commands preselect a destination', () => {
    for (const text of ['【番外】一起做早餐', '[小剧场] 两个人的周末', '请写一个番外：下雨天', '开一篇平行线：另一个结局']) {
        assert.equal(detectEpisodeIntent(text)?.action, 'create', text);
    }
    for (const text of ['不要写番外', '别开小剧场', '“写一个番外：相遇”', '他说：写一个番外', '角色想要一个番外', '梦见我们去了平行世界', '第二天我们一起做早餐', '十年后的小剧场', '我喜欢那篇番外', '如果写一个番外呢', '假如到了平行世界']) {
        assert.equal(detectEpisodeIntent(text), null, text);
    }
});
test('new world is a choice, reset is fresh and history is never a historical fork', () => {
    assert.equal(detectEpisodeIntent('【番外】一起吃饭').contextMode, 'continued');
    assert.equal(detectEpisodeIntent('【平行线】校园AU').contextMode, null);
    assert.equal(detectEpisodeIntent('【番外】不要继承正文，全新背景').contextMode, 'fresh');
    assert.equal(detectEpisodeIntent('【番外】回到第3章，我们重新相遇').historical, true);
});
test('continuation selects only a unique exact title in the same resolved root', () => {
    const intent = detectEpisodeIntent('继续番外《下雨天》：走进咖啡馆');
    const node = { relationship: 'resolved', episode: { title: '下雨天', rootId: 'root-a', kind: 'side' } };
    assert.equal(resolveNamedEpisode(intent, [node], 'root-a').kind, 'unique');
    assert.equal(resolveNamedEpisode(intent, [node, node], 'root-a').kind, 'choose');
    assert.equal(resolveNamedEpisode(intent, [node], 'root-b').kind, 'choose');
    assert.equal(resolveNamedEpisode(detectEpisodeIntent('继续上次的番外'), [node], 'root-a').kind, 'choose');
});
