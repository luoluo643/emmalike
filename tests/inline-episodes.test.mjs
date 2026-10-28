import test from 'node:test';
import assert from 'node:assert/strict';
import { findInlineEpisodes } from '../src/inline-episodes.js';

const u = mes => ({ is_user: true, is_system: false, mes });
const c = mes => ({ is_user: false, is_system: false, mes });
const story = (...messages) => [c('你来了。'), ...messages];
const one = messages => findInlineEpisodes(messages).map(({ from, to, title, kind }) => ({ from, to, title, kind }));

test('a macro that mentions 小剧场 is not a request for one', () => {
    const messages = story(u('{{setvar::小剧场规范:: 纯文字小剧场规范：小剧场是独立于主线剧情的番外内容，生成番外时写给{{user}}看}}'), c('好的。'), u('继续'), c('……'));
    assert.deepEqual(findInlineEpisodes(messages), []);
});

test('where a 番外 ends: going back, a dream, carrying on with the story; not "继续剧情", "回到剧情" or "禁止继续正文"', () => {
    const ends = text => one(story(u('暂停剧情，生成番外。下雨天'), c('雨下了一夜。'), u(text), c('……'), u('回归正文'), c('回来了。')))[0].to;
    assert.equal(ends('以上剧情闪回他的梦境里，他醒来，发现她还在身旁'), 2);
    assert.equal(ends('好了，以上番外都是他自己做的梦'), 2);
    assert.equal(ends('把以上番外的记忆塞正剧里面'), 2);
    assert.equal(ends('继续 正文'), 2);
    assert.equal(ends('人设自检并进行修正。继续发展剧情'), 4);
    assert.equal(ends('禁止继续正文，接着往下写'), 4);
    assert.equal(ends('回到正文'), 2);
    assert.equal(ends('回到主线剧情'), 2);
    assert.equal(ends('回到原剧情吧'), 2);
    assert.equal(ends('继续主剧情'), 2);
    assert.equal(ends('切回正剧'), 2);
    assert.equal(ends('回到剧情'), 4);
    assert.equal(ends('回到剧情，剧情加一点误会'), 4);
    assert.equal(ends('恢复剧情'), 4);
});

test('a self-check pause inside a 番外 and "回到剧情" keep the 番外 going', () => {
    const found = one(story(u('我想看他们小时候的设定，生成番外'), c('设定。'), u('gemini 暂停剧情 自检是否ooc'), c('自检报告。'),
        u('回到剧情'), c('雪下了一夜。'), u('回到正文'), c('回来了。')));
    assert.deepEqual(found.map(({ from, to }) => ({ from, to })), [{ from: 1, to: 6 }]);
});

test('a request that pauses the story and keeps it out of the story starts one, without the word 番外', () => {
    const found = one(story(u('$暂停当前剧情，禁止继续正文，不需要状态栏，不计入主线剧情和记忆区。内容为她给他发信息'), c('**藏头**\n她：在吗')));
    assert.deepEqual(found, [{ from: 1, to: 2, title: '藏头', kind: 'side' }]);
});

test('titles: named by the author, their own heading, the reply\'s heading, else what it is about', () => {
    const title = (request, reply = '正文。') => one(story(u(request), c(reply)))[0].title;
    assert.equal(title('$现在暂停当前剧情，为我生成一个“梅雨季”番外小剧场。内容为：他忘了带伞'), '梅雨季');
    assert.equal(title('$现在暂停当前剧情，为我生成一个番外，主题为“搬家那天”，不计入主线剧情'), '搬家那天');
    assert.equal(title('# 旧照片2\n暂停当前剧情，生成一个额外的世界线番外小剧场，标题自拟，内容是他翻到一张她小时候的照片'), '旧照片2');
    assert.equal(title('# XXXS 暂停当前剧情，生成一个额外的世界线番外小剧场，标题自拟，内容是他第一次去超市买东西', '**课后**\n正文。'), '课后');
    assert.equal(title('# XXXS 暂停当前剧情，生成一个额外的世界线番外小剧场，标题自拟，内容是他第一次去超市买东西'), '他第一次去超市买东西');
    assert.equal(title('claude暂停剧情，生成番外，新的时间线', '## 番外设定：「晚樱」\n设定。'), '晚樱');
    assert.equal(title('$现在暂停当前剧情，为我生成一个文字番外小剧场，标题自拟。不需要状态栏，不受正文时间内容束缚，内容：多年以后，他们在海边开了一家书店'),
        '多年以后，他们在海边开了一家书店');
    assert.equal(title('暂停剧情生成番外。他一个人去看了那场电影', '**番外**\n正文。'), '他一个人去看了那场电影');
});

test('lines that look like titles but are not', () => {
    const title = reply => one(story(u('生成番外，雨夜里的重逢'), c(reply)))[0].title;
    for (const reply of ['【[本次标题]】\n正文。', '### 一、总体评估\n正文。', '## Phase.0 准备工作\n正文。', '**ᯠ _ ̫ _ ̥ ᯄ ੭**\n正文。', '# 番外\n正文。',
        '<thinking>\n# 正确的标题\n</thinking>\n正文。']) assert.equal(title(reply), '雨夜里的重逢', reply);
    assert.equal(title('<!-- 注释 -->\n[ACTION]\n### 《重逢》\n正文。'), '重逢');
});

test('a reply hidden after a summary still gives its title; the app\'s own notes do not', () => {
    const messages = story(u('生成番外，标题自拟，下雨天'), { is_user: false, is_system: true, mes: '**备注**', extra: { type: 'comment' } },
        { is_user: false, is_system: true, is_hidden: true, mes: '**雨停之前**\n正文。' });
    assert.equal(one(messages)[0].title, '雨停之前');
    const read = story(u('生成番外，标题自拟，下雨天'), { is_user: false, is_system: true, hidden: true, mes: '**雨停之前**\n正文。' });
    assert.equal(one(read)[0].title, '雨停之前');
});
