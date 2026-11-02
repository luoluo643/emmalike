// Isolated-server regression for deletion before the native engine is ready.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
assert.equal(base, 'http://127.0.0.1:8098', 'Only the dedicated disposable instance is allowed');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.setDefaultTimeout(20000);
const avatars = [];
const { token } = await (await context.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => context.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
let checks = 0;
const check = (name, ok) => { assert.ok(ok, name); checks++; console.log(`PASS ${name}`); };

try {
    check('test-account login', (await post('/api/users/login', { handle, password })).ok());
    await context.addInitScript(() => {
        window.__deleteJSONCalls = 0;
        const original = Response.prototype.json;
        Response.prototype.json = function (...args) {
            if (new URL(this.url || location.href).pathname === '/api/characters/delete') {
                window.__deleteJSONCalls++;
                return Promise.reject(new DOMException('The string did not match the expected pattern.', 'SyntaxError'));
            }
            return original.apply(this, args);
        };
    });
    await context.route('**/*', async route => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame().parentFrame() && new URL(request.url()).pathname === '/') {
            return route.abort(); // Keep the native bridge unavailable, selecting the direct API fallback.
        }
        return route.continue();
    });

    const name = `Delete regression ${Date.now()}`;
    const created = await context.request.post(`${base}/api/characters/create`, {
        headers: { 'X-CSRF-Token': token },
        multipart: { ch_name: name, description: '', first_mes: 'Synthetic test character.', personality: '', scenario: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' },
    });
    check('synthetic character created', created.ok());
    const avatar = (await created.text()).trim();
    avatars.push(avatar);
    await page.goto(`${base}/scripts/extensions/third-party/emmalike/app/#`);
    const more = page.getByRole('button', { name: `${name} 的更多操作` });
    await more.click();
    await page.getByRole('dialog', { name, exact: true }).getByRole('button', { name: /^删除角色/ }).click();
    const dialog = page.getByRole('dialog', { name: `删除「${name}」？`, exact: true });
    check('native engine page has not loaded', page.frames().every(frame => frame === page.mainFrame() || !frame.url().startsWith(base + '/')));

    let requests = 0, first = true, actualStatus, actualBody;
    await context.route('**/api/characters/delete', async route => {
        requests++;
        if (first) {
            first = false;
            return route.fulfill({ status: 500, contentType: 'text/plain', body: 'Synthetic delete failure' });
        }
        const response = await route.fetch();
        actualStatus = response.status();
        actualBody = await response.text();
        await new Promise(resolve => setTimeout(resolve, 700));
        return route.fulfill({ response });
    });
    await dialog.getByRole('button', { name: '删除', exact: true }).click();
    await page.locator('.tl-toast').filter({ hasText: 'Synthetic delete failure' }).waitFor();
    check('HTTP failure leaves confirmation open', await dialog.isVisible());
    check('HTTP failure preserves the character on the server', (await (await post('/api/characters/all', {})).json()).some(c => c.avatar === avatar));
    check('HTTP failure enables retry', await dialog.getByRole('button', { name: '删除', exact: true }).isEnabled());

    await dialog.getByRole('button', { name: '删除', exact: true }).click();
    await dialog.locator('[aria-busy="true"]').waitFor();
    check('waiting for deletion displays progress', (await dialog.locator('[aria-busy="true"]').innerText()).includes('正在删除'));
    await dialog.waitFor({ state: 'detached' });
    await more.waitFor({ state: 'detached' });
    check('real endpoint returns plain OK', actualStatus === 200 && actualBody.trim() === 'OK');
    check('success closes confirmation and refreshes shelf', await more.count() === 0);
    check('success notification appears', (await page.locator('.tl-toast').allTextContents()).some(t => t.includes(`已删除「${name}」`)));
    check('delete body never reaches JSON parser', await page.evaluate(() => window.__deleteJSONCalls === 0));
    check('only one request per click', requests === 2);
    check('server confirms character is gone', !(await (await post('/api/characters/all', {})).json()).some(c => c.avatar === avatar));
    console.log(`ALL PASS (${checks} checks)`);
} finally {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    // Only fixtures created by this run, on the guarded disposable server.
    for (const avatar of avatars) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => {});
    await browser.close();
}
