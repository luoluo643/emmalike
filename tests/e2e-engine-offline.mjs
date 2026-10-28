// The full app losing the network while it loads, on an official SillyTavern with only tavern-lite: the reader is told
// in plain words and offered a retry instead of "正在准备" forever; the retry works once the network is back; a normal
// load and a failing request to another site are not reported.
// Usage: node e2e-engine-offline.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `断网${run}`, FILE = `断网-${run}`;
const NETWORK_TEXT = '网络断了，没加载完';
const problems = [];
const check = (name, ok, detail = '') => { if (!ok) problems.push(name); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.setDefaultTimeout(30000);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
console.log('SillyTavern', (await (await page.request.get(`${base}/version`)).json()).pkgVersion);
const created = await page.request.post(`${base}/api/characters/create`, { headers: { 'X-CSRF-Token': token },
    multipart: { ch_name: NAME, description: '', first_mes: '你来了。', personality: '', scenario: '', mes_example: '', creator_notes: '',
        system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' } });
const avatar = (await created.text()).trim();
const now = new Date().toISOString();
await post('/api/chats/save', { ch_name: NAME, file_name: FILE, avatar_url: avatar, force: true, chat: [
    { user_name: 'User', character_name: NAME, create_date: now, chat_metadata: {} },
    { name: NAME, is_user: false, mes: '你来了。', send_date: now, extra: {} },
] });

const readerUrl = `${appUrl}#${new URLSearchParams({ chat: avatar, file: FILE })}`;
const status = () => page.locator('.tl-engine-status');
const ready = (timeout = 240000) => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout })
    .then(() => true, () => false);
const failedText = () => page.locator('.tl-engine-status[data-state="failed"]').innerText().catch(() => '');
const waitFailed = (timeout = 60000) => page.locator('.tl-engine-status[data-state="failed"]').waitFor({ timeout }).then(() => true, () => false);
const fresh = async () => { await context.unrouteAll({ behavior: 'wait' }); await context.setOffline(false); await page.goto('about:blank'); };

try {
    // 1. A normal load: ready, never reported as a network problem.
    await page.goto(readerUrl);
    check('a normal load gets ready', await ready());
    check('a normal load shows no failure', !(await failedText()), await failedText());

    // 2. The settings request drops while loading: told within the grace time, then a retry works.
    await fresh();
    let dropped = 0;
    await context.route('**/api/settings/get', route => { dropped++; return route.abort('connectionreset'); });
    const t0 = Date.now();
    await page.goto(readerUrl);
    const failed = await waitFailed();
    const waited = Math.round((Date.now() - t0) / 1000);
    const text = await failedText();
    check('a dropped request is reported as a network problem', failed && text.includes(NETWORK_TEXT), JSON.stringify({ failed, text, dropped }));
    check('it is reported soon, not after the 4 minute limit', failed && waited < 60, `${waited}s`);
    check('the report offers a retry', await status().getByRole('button', { name: '重试' }).isVisible().catch(() => false));
    await page.screenshot({ path: '/tmp/tl-engine-offline-failed.png' });
    await context.unrouteAll({ behavior: 'wait' });
    await status().getByRole('button', { name: '重试' }).click();
    check('the retry gets ready once the network is back', await ready());
    check('no failure is left after the retry', !(await failedText()), await failedText());

    // 3. The device goes offline while loading.
    await fresh();
    await context.route('**/api/settings/get', async route => { await new Promise(r => setTimeout(r, 4000)); return route.continue().catch(() => {}); });
    await page.goto(readerUrl);
    await page.waitForTimeout(1000);
    await context.setOffline(true);
    const offlineFailed = await waitFailed();
    check('going offline while loading is reported', offlineFailed && (await failedText()).includes(NETWORK_TEXT), await failedText());
    await context.setOffline(false);
    await context.unrouteAll({ behavior: 'wait' });
    await status().getByRole('button', { name: '重试' }).click();
    check('the retry after going offline gets ready', await ready());

    // 4. A request to another site failing while loading (an extension's own service) is not reported.
    await fresh();
    await context.route('**/api/settings/get', async route => { await new Promise(r => setTimeout(r, 4000)); return route.continue().catch(() => {}); });
    await page.goto(readerUrl);
    const frame = await page.waitForSelector('iframe[data-tavern-lite="engine"]', { state: 'attached' }).then(h => h.contentFrame());
    await page.waitForFunction(() => !!document.querySelector('iframe[data-tavern-lite="engine"]')?.contentWindow?.__tavernLiteSettingsShared, null, { timeout: 30000 });
    const otherSite = await frame.evaluate(() => fetch('http://127.0.0.1:9/unreachable').then(() => 'answered', e => e.name)).catch(e => String(e));
    await context.unrouteAll({ behavior: 'wait' });
    check('the other site really failed', otherSite === 'TypeError', otherSite);
    const gotReady = await ready();
    await page.waitForTimeout(16000);
    check('a failing request to another site is not reported', gotReady && !(await failedText()), await failedText());

    // 5. Ready first, then the network drops: nothing about loading is shown.
    await context.route('**/api/**', route => route.abort('connectionreset'));
    await frame.evaluate(() => fetch('/api/settings/get', { method: 'POST' }).catch(() => {}));
    await page.waitForTimeout(16000);
    check('a drop after ready is not reported as a load failure', !(await failedText()), await failedText());
    await context.unrouteAll({ behavior: 'wait' });
} finally {
    // The full app itself throws "Failed to fetch" when its requests are dropped on purpose above; anything else counts.
    const unexpected = pageErrors.filter(e => !/^TypeError: (Failed to fetch|NetworkError)/.test(e));
    check('no unexpected page errors', !unexpected.length, unexpected);
    await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => {});
    await browser.close();
}
console.log(problems.length ? `PROBLEMS ${problems.join(' | ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
