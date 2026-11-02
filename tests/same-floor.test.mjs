import test from 'node:test';
import assert from 'node:assert/strict';
import { cardOnly, sameFloor } from '../src/same-floor.js';

const slot = (index, hash) => `<div class="tl-frontend-card" data-card="${index}.1.${hash}" data-frame="TH-message--${index}--1"></div>`;
const placeholder = '<span class="tl-card-placeholder">［前端卡片：只显示最近消息里的卡片］</span>';
const reply = (index, html) => ({ index, is_user: false, is_system: false, html });
const said = (index, text) => ({ index, is_user: true, is_system: false, html: `<p>${text}</p>` });

test('a message made of one card, and nothing else', () => {
    assert.deepEqual(cardOnly(reply(0, slot(0, 'abc'))), { key: '0.1.abc' });
    assert.deepEqual(cardOnly(reply(0, `<p>${placeholder}</p>`)), { key: null });
    assert.equal(cardOnly(reply(0, `<p>他推开门。</p>${slot(0, 'abc')}`)), null);
    assert.equal(cardOnly(reply(0, slot(0, 'abc') + slot(0, 'def'))), null);
    assert.equal(cardOnly(reply(0, '<p>只有文字</p>')), null);
});

test('played in place: the greeting hosts the interface, later replies were never drawn', () => {
    const messages = [reply(0, slot(0, 'ui')), said(1, '第1句'), reply(2, placeholder), said(3, '第2句'), reply(4, placeholder)];
    assert.deepEqual(sameFloor(messages), { host: 0 });
});

test('reloaded: every reply is the same interface, the newest one hosts it', () => {
    const messages = [reply(0, slot(0, 'ui')), said(1, 'a'), reply(2, slot(2, 'ui')), said(3, 'b'), reply(4, slot(4, 'ui'))];
    assert.deepEqual(sameFloor(messages), { host: 4 });
});

test('a card that differs per reply is not a same-floor card', () => {
    const messages = [reply(0, slot(0, 'one')), said(1, 'a'), reply(2, slot(2, 'two')), said(3, 'b'), reply(4, slot(4, 'three'))];
    assert.equal(sameFloor(messages), null);
});

test('old cards past the render depth do not count as played in place', () => {
    const messages = [reply(0, placeholder), said(1, 'a'), reply(2, slot(2, 'one')), said(3, 'b'), reply(4, slot(4, 'two'))];
    assert.equal(sameFloor(messages), null);
});

test('ordinary stories, and a story whose newest reply has text, are left alone', () => {
    assert.equal(sameFloor([reply(0, '<p>你好</p>'), said(1, '嗨')]), null);
    assert.equal(sameFloor([reply(0, slot(0, 'ui')), said(1, 'a'), reply(2, slot(2, 'ui')), said(3, 'b'), reply(4, '<p>正文</p>')]), null);
    assert.equal(sameFloor([reply(0, slot(0, 'ui'))]), null);
    assert.equal(sameFloor([]), null);
});
