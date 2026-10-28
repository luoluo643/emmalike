// A story opened while the full app is still getting ready already looks the way the app shows it: the rendered
// messages kept from last time, else the app's display regex scripts and the HTML it allows; never raw tags.
// Usage: node e2e-looks.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `样子测试${run}`, FILE = `样子-${run}`, RULE = `tl-looks-${run}`;
const results = {}, problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`; if (!ok) problems.push(name); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const engineEval = (fn, arg) => page.evaluate(([source, a]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'a', `return (${source})(w, a);`)(w, a);
}, [fn.toString(), arg]);

const created = await page.request.post(`${base}/api/characters/create`, {
    headers: { 'X-CSRF-Token': token },
    multipart: { ch_name: NAME, description: '', first_mes: '你来了。', personality: '', scenario: '', mes_example: '', creator_notes: '',
        system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' },
});
const avatar = (await created.text()).trim();
if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);
const reply = '<content>\n「你来了。」他说。\n</content>\n<horae>\ntime:状态秘密\n</horae>\n<!--draft 草稿秘密 -->\n<Todo>\n📅 <b>今天</b>：晴\n</Todo>';
const meta = { user_name: 'User', character_name: NAME, create_date: new Date().toISOString(), chat_metadata: {} };
const now = new Date().toISOString();
const chat = [meta,
    { name: 'User', is_user: true, mes: '你好 <b>朋友</b>', send_date: now, extra: {} },
    { name: NAME, is_user: false, mes: reply, send_date: now, extra: {} }];
if (!(await post('/api/chats/save', { ch_name: NAME, file_name: FILE, avatar_url: avatar, chat, force: true })).ok()) throw new Error('chat not saved');

const storyUrl = `${appUrl}#${new URLSearchParams({ chat: avatar, file: FILE })}`;
const synced = () => page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const last = () => page.evaluate(() => {
    const bodies = [...document.querySelectorAll('.tl-message-body')];
    const body = bodies[bodies.length - 1];
    return { text: body?.innerText ?? '', bold: !!body?.querySelector('b, strong'), synced: document.querySelector('.tl-composer-input')?.dataset.synced };
});
const leaks = text => (text.match(/<\/?[A-Za-z_][\w-]*>|<!--/g) || []);
const blockEngine = () => page.route(/\/script\.js(\?|$)/, route => route.abort());

try {
    // The app hides <horae> only with a display regex script (as the Horae extension sets up).
    await page.goto(storyUrl);
    await synced();
    await engineEval((w, a) => {
        const c = w.SillyTavern.getContext();
        c.extensionSettings.regex = [...(c.extensionSettings.regex ?? []), { id: a.rule, scriptName: a.rule, findRegex: '/<horae>[\\s\\S]*?<\\/horae>/gim',
            replaceString: '', trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: false,
            substituteRegex: 0, minDepth: null, maxDepth: null }];
        c.saveSettingsDebounced();
    }, { rule: RULE });
    await page.waitForTimeout(3000);
    await page.reload();
    await synced();
    await page.waitForTimeout(2500); // kept 1.5 s after the story settles
    const live = await last();
    check('full app: tags hidden by its rules', !live.text.includes('状态秘密') && !live.text.includes('草稿秘密') && leaks(live.text).length === 0, JSON.stringify(live.text));
    const liveHtml = await page.evaluate(() => [...document.querySelectorAll('.tl-message-body')].pop()?.innerHTML);

    // Next visit, full app not ready (blocked): the kept rendering is shown as is.
    await blockEngine();
    await page.reload();
    await page.locator('.tl-message-body').last().waitFor({ timeout: 30000 });
    await page.waitForTimeout(1500);
    const kept = await last();
    const keptHtml = await page.evaluate(() => [...document.querySelectorAll('.tl-message-body')].pop()?.innerHTML);
    check('not ready: still preparing', kept.synced === 'false', kept.synced);
    check('not ready: kept rendering shown', keptHtml === liveHtml, `${keptHtml?.slice(0, 200)} ≠ ${liveHtml?.slice(0, 200)}`);

    // Only the rules kept (this story's rendering dropped): rules + allowed HTML give the same visible result.
    await page.evaluate(() => new Promise(resolve => {
        const open = indexedDB.open('tavern-lite-looks');
        open.onsuccess = () => {
            const tx = open.result.transaction('looks', 'readwrite'), store = tx.objectStore('looks');
            store.getAllKeys().onsuccess = e => { for (const key of e.target.result) if (String(key).startsWith('["story"')) store.delete(key); };
            tx.oncomplete = () => resolve();
        };
    }));
    await page.reload();
    await page.locator('.tl-message-body').last().waitFor({ timeout: 30000 });
    await page.waitForTimeout(1500);
    const ruled = await last();
    check('rules only: horae and draft hidden', !ruled.text.includes('状态秘密') && !ruled.text.includes('草稿秘密'), JSON.stringify(ruled.text));
    check('rules only: no raw tags', leaks(ruled.text).length === 0, leaks(ruled.text).join(' '));
    check('rules only: text and bold kept', ruled.text.includes('他说') && ruled.text.includes('今天') && ruled.bold, JSON.stringify(ruled));
    const userText = await page.evaluate(() => [...document.querySelectorAll('.tl-message[data-role="user"] .tl-message-body')].pop()?.innerHTML ?? '');
    check('rules only: user message HTML shown', /<b>朋友<\/b>/.test(userText), userText);

    // Nothing kept at all (another browser): still no raw tags.
    const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await context.storageState() });
    const other = await fresh.newPage();
    await other.route(/\/script\.js(\?|$)/, route => route.abort());
    await other.goto(storyUrl);
    await other.locator('.tl-message-body').last().waitFor({ timeout: 30000 });
    await other.waitForTimeout(1500);
    const plain = await other.evaluate(() => [...document.querySelectorAll('.tl-message-body')].pop()?.innerText ?? '');
    check('nothing kept: no raw tags or comments', leaks(plain).length === 0 && !plain.includes('草稿秘密'), JSON.stringify(plain));
    await fresh.close();
} finally {
    await page.unroute(/\/script\.js(\?|$)/).catch(() => { });
    await page.reload().catch(() => { });
    await synced().catch(() => { });
    await engineEval((w, a) => {
        const c = w.SillyTavern.getContext();
        c.extensionSettings.regex = (c.extensionSettings.regex ?? []).filter(s => s.id !== a.rule);
        c.saveSettingsDebounced();
    }, { rule: RULE }).catch(() => { });
    await page.waitForTimeout(3000);
    await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
    await browser.close();
}

check('no page errors', pageErrors.length === 0, pageErrors.join('\n'));
console.log(JSON.stringify(results, null, 2));
if (problems.length) { console.error('FAILED:', problems.join(', ')); process.exit(1); }
