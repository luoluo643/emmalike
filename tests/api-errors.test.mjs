import test from 'node:test';
import assert from 'node:assert/strict';
import { explainApiError } from '../src/api-errors.js';

// What the full app's toast says (title and message joined by the bridge) → what the reader sees.
test('provider errors are said in Chinese with what to do and the code', () => {
    const cases = [
        ['Chat Completion API：Candidate was blocked due to PROHIBITED_CONTENT', /审掉.*反截断.*（PROHIBITED_CONTENT）$/],
        ['API returned an error：The prompt was blocked. blockReason: OTHER', /拦下.*最近两楼/],
        ['Chat Completion API：User location is not supported for the API use.', /地区.*代理节点/],
        ['Chat Completion API：The model is overloaded. Please try again later.', /正忙/],
        ['Chat Completion API：Got response status 503', /正忙.*（503）$/],
        ['Chat Completion API：429 Resource has been exhausted (e.g. check quota). RESOURCE_EXHAUSTED', /太频繁.*（429）$/],
        ['Chat Completion API：预扣费额度失败, 用户剩余额度: 🍪3.53, 需要预扣费额度: 🍪4.03', /额度用完了/],
        ['Chat Completion API：You exceeded your current quota, please check your plan and billing details.', /额度用完了/],
        ['Chat Completion API：cdn.example.com | 524: A timeout occurred Error code 524', /超时/],
        ['Chat Completion API：request to https://x/v1 failed, reason: connect ETIMEDOUT', /网络断了.*（ETIMEDOUT）$/],
        ['Chat Completion API：read ECONNRESET', /网络断了/],
        ['Chat Completion API：getaddrinfo ENOTFOUND api.example.com', /地址.*填错/],
        ['Chat Completion API：connect ECONNREFUSED 127.0.0.1:7860', /拒绝连接/],
        ['Chat Completion API：API key not valid. Please pass a valid API key.', /密钥/],
        ['Mandatory prompts exceed the context size.', /上下文长度.*65535/],
        ['必要的提示词超过了上下文大小', /上下文长度/],
        ['Could not get a reply from API. Check your connection settings / API key and try again.', /没有回复/],
        ['DeepSeek：Content Exists Risk', /审掉/],
    ];
    for (const [text, expected] of cases) assert.match(explainApiError(text) ?? '', expected, text);
});

test('anything else is left as it was', () => {
    for (const text of ['Chat could not be saved', '已删除 401 条消息里的旧版本？', 'Settings could not be saved', '', null, '奇怪的错误']) {
        assert.equal(explainApiError(text), null, String(text));
    }
});

test('relay balance is not taken for a rate limit', () => {
    assert.match(explainApiError('Streaming request failed with status 403 Forbidden: 预扣费额度失败'), /额度用完了/);
});
