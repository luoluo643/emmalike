// Frontend cards through a trip to the full app and back: the shell's copy keeps running, so it still moves, is still the
// right size and still holds what the reader did in it, even when the card freezes on hearing a newer copy of itself
// over a BroadcastChannel (the full app's copy starts up meanwhile).
// Needs Tavern Helper (TAVERN_HELPER_REF). Usage: node e2e-native-return.mjs <baseUrl> <handle> <password> [latencyMs] [downKbps]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `返回卡片${run}`;
const SHOTS = process.env.SHOTS ?? '';
const CARD = [
    '“欢迎。”',
    '',
    '```html',
    '<!DOCTYPE html><html><head><style>',
    '#bar{height:90px;background:#123;color:#fff;position:relative;overflow:hidden}',
    '#dot{width:20px;height:20px;background:#fc0;border-radius:50%;animation:slide 1s linear infinite}',
    '@keyframes slide{from{transform:translateX(0)}to{transform:translateX(200px)}}',
    '#more{height:0;overflow:hidden;background:#345;transition:height .2s}#sw:checked~#more{height:200px}',
    '</style></head><body>',
    '<input type="checkbox" id="sw"><div id="bar"><div id="dot"></div></div><div id="more">面板</div>',
    '<textarea id="draft"></textarea><button id="add">+1</button><span id="n">0</span>',
    '<script>',
    'window.ticks=0;(function loop(){window.ticks++;requestAnimationFrame(loop)})();',
    // A status bar that freezes when a newer copy of itself announces itself on the channel, as real cards do.
    "window.channelName=new BroadcastChannel('tl-test-status').name;",
    "var born=Date.now()+Math.random(),ch=new BroadcastChannel('tl-test-status');",
    "ch.onmessage=function(e){if(e.data>born){document.documentElement.classList.add('retired');document.getElementById('dot').style.animationPlayState='paused';window.requestAnimationFrame=function(){return 0}}};",
    'ch.postMessage(born);',
    "var n=0;document.getElementById('add').onclick=function(){n++;document.getElementById('n').textContent=n;};",
    "window.parentGlobals=typeof SillyTavern==='object'&&!!TavernHelper;",
    '</script></body></html>',
    '```',
].join('\n');
const results = {};
const problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`; if (!ok) problems.push(name); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
let avatar = '';
const finish = async code => {
    console.log(JSON.stringify({ results, pageErrors: pageErrors.slice(0, 12) }, null, 1));
    if (avatar) await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
    await browser.close();
    console.log(problems.length ? `PROBLEMS ${problems.length}` : 'ALL PASS');
    process.exit(code);
};
process.on('uncaughtException', async error => {
    console.log('FAILURE', error.message.split('\n')[0], (error.stack ?? '').split('\n').find(l => l.includes('e2e-native-return')));
    await finish(2);
});
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const created = await page.request.post(`${base}/api/characters/create`, {
    headers: { 'X-CSRF-Token': token },
    multipart: {
        ch_name: NAME, description: '测试', first_mes: CARD, personality: '', scenario: '', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '',
    },
});
avatar = (await created.text()).trim();
if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);

const shot = async name => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }).catch(() => { }); };
const engineEval = (fn, arg) => page.evaluate(([source, a]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'a', `return (${source})(w, a);`)(w, a);
}, [fn.toString(), arg]);

/** How the shell's card is doing: same frame as before, running, moving, sized to its content, what the reader left in it. */
const measure = () => page.evaluate(async () => {
    const frame = document.querySelector('.tl-message[data-index="0"] iframe.tl-card-frame');
    if (!frame) return { missing: true };
    frame.__mark ??= Math.random();
    const w = frame.contentWindow, doc = frame.contentDocument;
    const dot = doc?.getElementById('dot');
    const t0 = w?.ticks;
    const x0 = dot?.getBoundingClientRect().left;
    await new Promise(r => setTimeout(r, 600));
    const x1 = dot?.getBoundingClientRect().left;
    const rect = frame.getBoundingClientRect();
    return {
        mark: frame.__mark, id: frame.id, ticks: (w?.ticks ?? 0) - (t0 ?? 0), moved: Math.abs((x1 ?? 0) - (x0 ?? 0)),
        height: rect.height, width: rect.width, bodyHeight: doc?.body?.scrollHeight, retired: doc?.documentElement.classList.contains('retired'),
        draft: doc?.getElementById('draft')?.value, n: doc?.getElementById('n')?.textContent, channel: w?.channelName, globals: w?.parentGlobals,
    };
});

await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: '' })}`);
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
await page.locator('.tl-message[data-index="0"] iframe.tl-card-frame').waitFor({ timeout: 60000 });
await page.waitForFunction(() => document.querySelector('.tl-message[data-index="0"] iframe.tl-card-frame')?.contentWindow?.ticks > 0, null, { timeout: 60000 });
await page.waitForTimeout(1500);

const card = page.frameLocator('.tl-message[data-index="0"] iframe.tl-card-frame');
await card.locator('#draft').fill('没发出去的字');
await card.locator('#add').tap();
await card.locator('#add').tap();

const before = await measure();
console.log('before', JSON.stringify(before));
await shot('1-before');
check('card moves before the trip', before.ticks > 5 && before.moved > 1, JSON.stringify(before));
check('card is sized to its content before the trip', Math.abs(before.height - before.bodyHeight) <= 2, JSON.stringify(before));
check('card sees the channel name it asked for', before.channel === 'tl-test-status', String(before.channel));

const trip = async () => {
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await page.getByRole('button', { name: /^打开原版界面/ }).click();
    await page.getByRole('button', { name: '返回轻酒馆' }).waitFor({ timeout: 30000 });
    await page.waitForTimeout(2500);
    const inside = await engineEval(w => {
        const frame = w.document.querySelector('#chat .mes[mesid="0"] iframe[id^="TH-message--0--"]');
        return { ticks: frame?.contentWindow?.ticks, doc: frame?.contentDocument?.body?.scrollHeight };
    });
    console.log('native', JSON.stringify(inside));
    await shot('2-native');
    check('the full app runs its own copy while shown', inside.ticks > 0, JSON.stringify(inside));
    await page.getByRole('button', { name: '返回轻酒馆' }).click();
    await page.waitForTimeout(2500);
};

for (const round of [1, 2]) {
    await trip();
    const after = await measure();
    console.log(`after${round}`, JSON.stringify(after));
    await shot(`3-after${round}`);
    check(`round ${round}: card still moves (rAF)`, after.ticks > 5, JSON.stringify(after));
    check(`round ${round}: CSS animation still moves`, after.moved > 1, JSON.stringify(after));
    check(`round ${round}: frame height matches content`, Math.abs(after.height - after.bodyHeight) <= 2, JSON.stringify(after));
    check(`round ${round}: frame width unchanged`, Math.abs(after.width - before.width) <= 1, JSON.stringify(after));
    check(`round ${round}: card was not told to freeze`, after.retired === false, JSON.stringify(after));
    check(`round ${round}: same frame as before the trip`, after.mark === before.mark, JSON.stringify(after));
    check(`round ${round}: what the reader typed and counted is still there`, after.draft === '没发出去的字' && after.n === '2', JSON.stringify(after));
}

// The panel still opens and the frame follows it.
await card.locator('#sw').check({ force: true });
await page.waitForTimeout(1200);
const opened = await measure();
console.log('opened', JSON.stringify(opened));
check('frame grows when the card grows after returning', opened.height > before.height + 100, JSON.stringify(opened));
await shot('4-opened');

await finish(problems.length ? 1 : 0);
