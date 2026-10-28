import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRules, previewHtml } from '../src/render.js';

const rule = (find, replace, extra = {}) => ({ find, replace, trim: [], placement: [2], minDepth: null, maxDepth: null, ...extra });

test('display rules run like the app: pattern parsing, {{match}}, groups, trim strings, placement', () => {
    const hide = rule('/<horae>[\\s\\S]*?<\\/horae>/gim', '');
    assert.equal(applyRules('a<horae>\nx\n</horae>b', [hide]), 'ab');
    assert.equal(applyRules('<horae>x</horae>', [hide], { user: true }), '<horae>x</horae>', 'AI-only rule skips user messages');
    assert.equal(applyRules('hi Bob', [rule('/(\\w+) (?<who>\\w+)/', '[{{match}}|$1|$<who>]')]), '[hi Bob|hi|Bob]');
    assert.equal(applyRules('<t>x-y</t>', [rule('/<t>(.*?)<\\/t>/', '$1', { trim: ['-'] })]), 'xy');
    assert.equal(applyRules('x', [rule('/x/', '{{char}} and {{user}}')], { charName: 'C', userName: 'U' }), 'C and U');
    assert.equal(applyRules('aaa', [rule('a', 'b')]), 'baa', 'plain pattern without slashes, no global flag');
    assert.equal(applyRules('x', [rule('/(/g', 'y')]), 'x', 'invalid pattern is skipped');
});

test('depth limits follow the app (minDepth -1 allowed, maxDepth from 0)', () => {
    const last = rule('/x/g', 'y', { maxDepth: 0 });
    assert.equal(applyRules('x', [last], { depth: 0 }), 'y');
    assert.equal(applyRules('x', [last], { depth: 1 }), 'x');
    assert.equal(applyRules('x', [rule('/x/g', 'y', { minDepth: 2 })], { depth: 1 }), 'x');
    assert.equal(applyRules('x', [last]), 'y', 'no depth (hidden message) means no depth check');
});

test('without a DOM the preview stays escaped text with light markdown', () => {
    assert.equal(previewHtml('<b>x</b>\n**y**', 'C', 'U'), '&lt;b&gt;x&lt;/b&gt;<br><strong>y</strong>');
    assert.equal(previewHtml('## 标题\n---\n* 一\n「话」'), '<h2>标题</h2><hr>• 一<br><q>「话」</q>');
});
