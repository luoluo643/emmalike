import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changesSince, compareVersions } from '../src/changelog.js';

test('versions compared part by part', () => {
    assert.equal(compareVersions('0.15.2', '0.15.10'), -1);
    assert.equal(compareVersions('0.16.0', '0.15.9'), 1);
    assert.equal(compareVersions('v1.0', '1.0.0'), 0);
});

test('changes after the current version, up to the latest, newest first', () => {
    const md = [
        '# 更新说明', '', '## 0.17.0（未发布）', '- 还没上线的', '',
        '## 0.16.0 · 2026-11-03', '- 书架上的故事按 **第 N 个故事** 叫', '* 长图可以用 `主题` 配色', '说明文字不算', '',
        '## [0.15.3]', '- 修了 [登录](https://example.com) 提示', '',
        '## 0.15.2', '- 当前版本，不再列出', '',
        '## 没有版本号的标题', '- 跳过',
    ].join('\n');
    assert.deepEqual(changesSince(md, '0.15.2', '0.16.0'), [
        { version: '0.16.0', items: ['书架上的故事按 第 N 个故事 叫', '长图可以用 主题 配色'] },
        { version: '0.15.3', items: ['修了 登录 提示'] },
    ]);
    assert.equal(changesSince(md, '0.15.2').length, 3, 'without a known latest version everything newer is listed');
    assert.deepEqual(changesSince(md, '0.17.0'), []);
    assert.deepEqual(changesSince('', '0.1.0'), []);
    assert.equal(changesSince(md, '0.0.1', '', 2).length, 2);
});
