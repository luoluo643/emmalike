import http from 'node:http';

let lastRequest = null;
// Streamed chat completions received, for tests that check how many generations were actually sent.
let streamed = 0;
// Set over GET /next?empty=1&delay=ms: the next streamed reply sends no words, or waits that long before them.
let next = {};

const reply = messages => {
    const last = [...messages].reverse().find(m => m.role === 'user');
    return `（模拟回复）收到：${String(last?.content ?? '').slice(0, 40)}。这是一段用于测试流式输出的文字。`;
};

http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
        }
        if (req.url === '/last') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(lastRequest));
        }
        if (req.url === '/count') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ streamed }));
        }
        if (req.url.startsWith('/next')) {
            const query = new URL(req.url, 'http://mock').searchParams;
            next = { empty: query.get('empty') === '1', delay: Number(query.get('delay')) || 0 };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(next));
        }
        if (!req.url.endsWith('/chat/completions')) {
            res.writeHead(404);
            return res.end();
        }
        const payload = JSON.parse(body || '{}');
        lastRequest = payload;
        const text = reply(payload.messages ?? []);
        if (!payload.stream) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                id: 'mock', object: 'chat.completion', model: 'mock-model',
                choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
            }));
        }
        streamed++;
        const once = next;
        next = {};
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const chunks = once.empty ? [] : text.match(/.{1,4}/gsu);
        // A message containing 【思考】 gets reasoning first (as reasoning models stream it), slowly enough to watch.
        const lastUser = [...(payload.messages ?? [])].reverse().find(m => m.role === 'user');
        const thoughts = String(lastUser?.content ?? '').includes('【思考】') ? '先想一想：对方在问什么，再决定怎么回答。'.match(/.{1,3}/gsu) : [];
        // A message containing 【慢】 waits 5 s before its first words, as a slow model does.
        const delay = once.delay || (String(lastUser?.content ?? '').includes('【慢】') ? 5000 : 0);
        let i = 0, timer;
        const wait = setTimeout(() => timer = setInterval(() => {
            if (thoughts.length) {
                res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock-model', choices: [{ index: 0, delta: { reasoning_content: thoughts.shift() } }] })}\n\n`);
            } else if (i < chunks.length) {
                res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock-model', choices: [{ index: 0, delta: { content: chunks[i++] } }] })}\n\n`);
            } else {
                clearInterval(timer);
                res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
                res.end('data: [DONE]\n\n');
            }
        }, thoughts.length ? 250 : 30), delay);
        res.on('close', () => { clearTimeout(wait); clearInterval(timer); });
    });
}).listen(5001, () => console.log('mock llm on 5001'));
