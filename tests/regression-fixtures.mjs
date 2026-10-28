import { writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

// Only mutation target identities are retained; no configuration values, passwords or prompt contents.
export async function trackFixtureWrites(context, output) {
    const writes = []; let saving = Promise.resolve();
    context.on('response', response => {
        const request = response.request(), endpoint = new URL(request.url()).pathname;
        if (!response.ok() || request.method() !== 'POST' || !/\/(save|edit|edit-attribute|merge-attributes|write|create|delete|rename|update)$/.test(endpoint)) return;
        try {
            let bytes = request.postDataBuffer(); if (!bytes) return;
            if (request.headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
            const data = JSON.parse(bytes.toString());
            writes.push({ endpoint, ...Object.fromEntries(['name', 'avatar', 'avatar_url', 'file_name', 'chatfile', 'id', 'key', 'account'].filter(k => typeof data[k] === 'string').map(k => [k, data[k]])) });
            saving = saving.then(() => writeFile(output + '/mutations.json', JSON.stringify(writes, null, 2))).catch(() => {});
        } catch { /* Multipart character mutations are attributed by the suite's exact owned-fixture manifest. */ }
    });
    await context.route('**/api/tokenizers/remote/**', route => route.fulfill({ status: 503, json: { error: 'Regression permits only local mock inference' } }));
    await context.route('**/api/backends/chat-completions/generate', async route => {
        try {
            const request = route.request(); let bytes = request.postDataBuffer();
            if (request.headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
            const data = JSON.parse(bytes.toString());
            if (data.chat_completion_source !== 'custom' || data.custom_url !== 'http://mock:5001/v1') return route.fulfill({ status: 409, json: { error: 'Only isolated mock is permitted' } });
            await route.continue();
        } catch { await route.abort('blockedbyclient').catch(() => {}); }
    });
}
