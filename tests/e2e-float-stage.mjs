// A script's screen-sized stage (a shadow-DOM host that lets touches through), the way a card's phone is built:
// - the cut-out follows a button that glides to the screen's edge, to where it ends up;
// - a badge hanging over the button's corner and a note that takes no touches both show;
// - while a layer fills the screen, back goes to it one step at a time (float-back), and a reply being written goes on;
// - a layer that does not take float-back is left alone: back leaves the story and the layer does not follow to the shelf.
// Usage: node e2e-float-stage.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const AVATAR = 'default_Seraphina.png';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.message ?? e).slice(0, 200)));
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const wait = ms => page.waitForTimeout(ms);
const engineEval = (fn, arg) => page.evaluate(([source, value]) => {
    const w = document.querySelector('iframe.engine').contentWindow;
    return new w.Function('w', 'value', `return (${source})(w, value);`)(w, value);
}, [fn.toString(), arg]);
const clip = () => page.evaluate(() => {
    const f = document.querySelector('iframe.engine');
    return { overlay: f.classList.contains('overlay'), rects: [...f.style.clipPath.matchAll(/M\s*(-?[\d.]+)\s+(-?[\d.]+)\s*h\s*(-?[\d.]+)\s*v\s*(-?[\d.]+)/g)].map(m => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] })) };
});
const stageRect = sel => engineEval((w, s) => {
    const b = w.document.getElementById('tl-stage').shadowRoot.querySelector(s).getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
}, sel);
const shown = async sel => {
    const r = await stageRect(sel), { rects } = await clip();
    return rects.some(c => r.x >= c.x - .5 && r.y >= c.y - .5 && r.x + r.w <= c.x + c.w + .5 && r.y + r.h <= c.y + c.h + .5);
};
const inStory = async () => (await page.locator('.tl-composer-input').count()) > 0;
const marked = () => page.evaluate(() => !!history.state?.tlLayer);
const panel = (open, levels = 0) => engineEval((w, a) => {
    const sr = w.document.getElementById('tl-stage').shadowRoot;
    w.__levels = a.levels;
    sr.querySelector('.p').style.display = a.open ? 'block' : 'none';
}, { open, levels });
const back = async () => { await page.evaluate(() => history.back()); await wait(700); };

try {
    const { token } = await (await context.request.get(`${base}/csrf-token`)).json();
    if (!(await context.request.post(`${base}/api/users/login`, { headers: { 'X-CSRF-Token': token }, data: { handle, password } })).ok()) throw new Error('login failed');
    // From the shelf, so that leaving the story has somewhere to go.
    await page.goto(appUrl);
    await page.locator('.tl-library').waitFor({ timeout: 240000 });
    await page.evaluate(avatar => { location.hash = `#chat=${encodeURIComponent(avatar)}`; }, AVATAR);
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    await wait(1000);
    await engineEval(w => {
        const d = w.document, host = d.createElement('div');
        host.id = 'tl-stage';
        host.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:31000;pointer-events:none;overflow:hidden';
        const sr = host.attachShadow({ mode: 'open' });
        sr.innerHTML = `<style>
            .b{position:absolute;left:0;top:0;width:46px;height:46px;pointer-events:auto;background:#333;border:0;padding:0;transform:translate3d(320px,300px,0);transition:transform .5s linear}
            .d{position:absolute;top:-5px;right:-5px;width:18px;height:18px;background:red;display:none}
            .d.on{display:block}
            .p{position:absolute;inset:0;pointer-events:auto;background:rgba(0,0,0,.5);display:none}
            @keyframes fade{from{opacity:0}}
            .t{position:absolute;left:100px;top:420px;padding:8px;background:#000;color:#fff;pointer-events:none;animation:fade .2s}
        </style><div class="p"></div><button class="b"><span class="d"></span></button>`;
        d.body.append(host);
        w.__levels = 0;
        w.__backs = 0;
        d.addEventListener('float-back', e => {
            if (w.__levels <= 0) return;
            e.preventDefault();
            w.__backs++;
            if (--w.__levels === 0) sr.querySelector('.p').style.display = 'none';
        });
    });
    await page.waitForFunction(() => document.querySelector('iframe.engine').classList.contains('overlay'), null, { timeout: 10000 });
    await wait(300);
    check('the button on the stage is cut out', await shown('.b'));

    // 1. A glide.
    await engineEval(w => { w.document.getElementById('tl-stage').shadowRoot.querySelector('.b').style.transform = 'translate3d(8px,200px,0)'; });
    await wait(900);
    check('the cut-out follows the button to where it ends up', await shown('.b'), JSON.stringify([await stageRect('.b'), await clip()]));
    const oldSpot = await page.evaluate(() => document.elementFromPoint(340, 320)?.matches('iframe.engine'));
    check('where it was no longer takes touches from the shell', !oldSpot);

    // 2. Badge and note.
    await engineEval(w => { w.document.getElementById('tl-stage').shadowRoot.querySelector('.d').classList.add('on'); });
    await wait(200);
    check('a badge over the corner shows', await shown('.d'), JSON.stringify(await clip()));
    await engineEval(w => {
        const sr = w.document.getElementById('tl-stage').shadowRoot, n = w.document.createElement('div');
        n.className = 't'; n.textContent = '翻好了'; sr.append(n);
    });
    await wait(150);
    check('a note that takes no touches shows', await shown('.t'), JSON.stringify(await clip()));
    await engineEval(w => w.document.getElementById('tl-stage').shadowRoot.querySelector('.t').remove());
    await wait(200);
    check('and its place goes back to the shell when it is gone', (await clip()).rects.length === 2, JSON.stringify(await clip()));

    // 3. Back, a step at a time.
    await panel(true, 2);
    await wait(400);
    check('a layer filling the screen keeps a history entry', await marked());
    await back();
    check('back: the layer steps back, the story stays', await inStory() && await engineEval(w => w.__backs) === 1 && await engineEval(w => w.__levels) === 1, String(await engineEval(w => w.__backs)));
    await wait(300);
    check('still covering: the entry comes back for the next step', await marked());
    await back();
    check('back again closes it', await inStory() && await engineEval(w => w.__levels) === 0);
    await wait(500);
    check('no entry left behind', !(await marked()));
    check('nothing fills the screen any more', !(await clip()).rects.some(r => r.w * r.h > 300000));

    // 4. While a reply is being written.
    const before = await engineEval(w => w.SillyTavern.getContext().chat.length);
    await page.locator('.tl-composer-input').fill('【慢】等你');
    await page.locator('.tl-send').click();
    await page.waitForFunction(n => document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext().chat.length > n, before, { timeout: 15000 });
    await panel(true, 1);
    await wait(400);
    await back();
    await page.waitForFunction(n => {
        const c = document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext();
        return c.chat.length >= n + 2 && !c.chat.at(-1).is_user && c.chat.at(-1).mes.length > 0;
    }, before, { timeout: 60000 }).then(() => check('back with a layer up does not stop the reply', true)).catch(() => check('back with a layer up does not stop the reply', false));
    await wait(1000);

    // 5. A layer that knows nothing of it.
    await panel(true, 0);
    await wait(400);
    await back();
    await wait(800);
    check('a layer that does not take it: back leaves the story', !(await inStory()), await page.evaluate(() => location.hash));
    check('the layer does not follow out of the story', !(await clip()).overlay, JSON.stringify(await clip()));
    await page.evaluate(() => history.forward());
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input'), null, { timeout: 30000 });
    await wait(800);
    check('it is back with the story', (await clip()).overlay);
    await panel(false);
    await wait(400);

    // 6. The shelf, by the shell's own back button.
    await page.locator('.tl-back, .tl-header button').first().click();
    await wait(1200);
    check('off the story page the button is gone too', !(await clip()).overlay, await page.evaluate(() => location.hash));
    check('no page errors', !pageErrors.length, JSON.stringify(pageErrors.slice(0, 3)));
} catch (error) {
    check('ran to the end', false, String(error?.message ?? error).split('\n')[0]);
}
await browser.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
