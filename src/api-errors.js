// What went wrong when the AI model did not answer, in words a reader can act on. The full app shows the provider's
// own message (English, sometimes a whole Cloudflare page); the common ones are recognised here and said in Chinese
// with what to do next, followed by the code the provider gave so it can still be searched or quoted when asking.

const RULES = [
    // The tavern's own check before anything is sent (English, or the app's Chinese translation).
    [/Mandatory prompts exceed the context size|必要的提示词超过了上下文大小/i,
        '预设里必发的内容已超过上下文长度。把预设的上下文长度调大，最大回复长度不超过 65535'],
    // Account or relay balance (relays answer in Chinese) before the generic 429.
    [/预扣费额度失败|额度不足|余额不足|insufficient[_ ](?:quota|balance)|exceeded your current quota/i,
        '这个连接的额度用完了。充值后再试，或在「模型与预设」里换一个连接'],
    [/prompt was blocked|block_?reason|PROMPT_BLOCKED/i,
        'AI 模型拦下了这次发送的内容。改一下最近两楼或世界书里敏感的地方再试'],
    [/PROHIBITED_CONTENT|finish_?reason\W+SAFETY|content_filter|Content Exists Risk|sensitive words detected/i,
        '回复被 AI 模型审掉了。可以打开预设里的「反截断」条目再试，一次只开一个'],
    [/location is not supported|unsupported_country_region_territory|not available in your (?:country|region)/i,
        'AI 模型不支持酒馆所在网络的地区。换个代理节点或中转再试'],
    [/invalid[_ ]api[_ ]?key|API key not valid|incorrect api key|\b401 Unauthorized\b/i,
        '密钥不对或已失效。在「模型与预设」里重新填密钥'],
    [/\b429\b|RESOURCE_EXHAUSTED|Too Many Requests|rate[_ ]?limit(?:ed| exceeded)|RequestsPerDay/,
        '请求太频繁，或今天的次数用完了。等一会儿再试，或换个模型'],
    [/\b503\b|overloaded|no capacity|\bUNAVAILABLE\b|Service Unavailable/,
        'AI 模型那边正忙，暂时接不了。过几分钟再试'],
    [/Error code 52[2-4]|\b52[2-4]\b|\b504\b|Gateway Time-?out/,
        '中转站等 AI 模型太久，超时了。稍后再试，常这样就换个模型或中转'],
    [/\bENOTFOUND\b|\bEAI_AGAIN\b/,
        '找不到这个地址。在「模型与预设」里看看地址有没有填错'],
    [/\bECONNREFUSED\b/,
        '对方拒绝连接：本地的中转没开，或端口填错了'],
    [/\bETIMEDOUT\b|\bECONNRESET\b|socket hang up|\bfetch failed\b|\bUND_ERR_\w+/,
        '酒馆连 AI 模型时网络断了。稍后再试，常这样就换个代理节点或中转'],
    [/Could not get a reply from API|无法从 API 获取回复/i,
        'AI 模型没有回复。在「模型与预设」里看看连接和密钥'],
];

/**
 * For an error the full app showed: a Chinese explanation with the next step, plus the provider's code in brackets
 * when the match is one (PROHIBITED_CONTENT, 429…). null when it is not a known one, so it is shown as it was.
 */
export function explainApiError(text) {
    if (typeof text !== 'string' || !text) return null;
    for (const [pattern, words] of RULES) {
        const match = text.match(pattern);
        if (!match) continue;
        const code = match[0].replace(/^Error code /, '');
        return /^(?:[A-Z][A-Z0-9_]{2,31}|\d{3})$/.test(code) ? `${words}（${code}）` : words;
    }
    return null;
}
