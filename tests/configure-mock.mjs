// Points an account at the mock model service. Usage: node configure-mock.mjs <baseUrl> <handle> <password>
const [base, handle, password] = process.argv.slice(2);

async function waitForServer() {
    for (let i = 0; i < 120; i++) {
        try {
            if ((await fetch(`${base}/login`)).ok) return;
        } catch { /* not listening yet */ }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('SillyTavern did not start');
}

const cookies = new Map();
const keepCookies = response => {
    for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        cookies.set(pair.slice(0, pair.indexOf('=')), pair);
    }
};
const cookieHeader = () => [...cookies.values()].join('; ');

await waitForServer();
const tokenResponse = await fetch(`${base}/csrf-token`);
keepCookies(tokenResponse);
const { token } = await tokenResponse.json();

async function call(path, body) {
    const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Cookie: cookieHeader() },
        body: JSON.stringify(body ?? {}),
    });
    keepCookies(response);
    if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
    return response.headers.get('content-type')?.includes('json') ? response.json() : response.text();
}

await call('/api/users/login', { handle, password });
const settings = JSON.parse((await call('/api/settings/get')).settings);
settings.main_api = 'openai';
Object.assign(settings.oai_settings, {
    chat_completion_source: 'custom',
    custom_url: 'http://mock:5001/v1',
    custom_model: 'mock-model',
    stream_openai: true,
});
await call('/api/settings/save', settings);
console.log(`configured ${handle} to use the mock model service`);
