// A save made while the full app switches stories must not empty the story it is opening (a long story was
// replaced by its greeting). SillyTavern's openCharacterChat empties its chat and takes the next file's name before
// it reads that file; a save in that gap (here saveMetadata, in real use a debounced metadata save or an extension)
// sends an empty chat with no integrity mark, which the server's check lets through, and the read that follows then
// finds the empty file and saves the greeting over it. Official SillyTavern with tavern-lite; the plugin part needs
// INSTALL_SAVE_PLUGIN=1 and is skipped without it.
// Usage: node e2e-switch-gap.mjs <baseUrl> <handle> <password>
import { createRequire } from 'node:module';
import { diffLines, hashLines } from '../server-chat-save/chat-diff.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `切换${run}`, FILE_A = `甲-${run}`, FILE_B = `乙-${run}`;
const results = {}, problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 400); if (!ok) problems.push(name); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const pageErrors = [];
const saves = [];
context.on('request', request => {
    const url = request.url();
    if (/\/api\/chats\/save$|\/api\/plugins\/tavern-lite-save\/patch$/.test(url)) {
        const body = request.postData() ?? '';
        saves.push({ url: url.replace(base, ''), file: (body.match(/"file_name":"([^"]*)"/) ?? [])[1], size: body.length });
    }
});

const api = context.request;
const { token } = await (await api.get(`${base}/csrf-token`)).json();
const post = (path, data) => api.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
console.log('SillyTavern', (await (await api.get(`${base}/version`)).json()).pkgVersion);
const created = await api.post(`${base}/api/characters/create`, { headers: { 'X-CSRF-Token': token },
    multipart: { ch_name: NAME, description: '', first_mes: '【首页】', personality: '', scenario: '', mes_example: '', creator_notes: '',
        system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' } });
const avatar = (await created.text()).trim();
const now = new Date().toISOString();
const story = (tag, n) => Array.from({ length: n }, (_, i) => ({ name: i % 2 ? 'User' : NAME, is_user: i % 2 === 1, mes: `${tag}第${i}段。`, send_date: now, extra: {} }));
const header = file => ({ user_name: 'User', character_name: NAME, create_date: now, chat_metadata: { integrity: `${file}-mark` } });
const save = (file, chat) => post('/api/chats/save', { ch_name: NAME, file_name: file, avatar_url: avatar, chat: [header(file), ...chat], force: true });
const read = async file => (await (await post('/api/chats/get', { ch_name: NAME, file_name: file, avatar_url: avatar })).json());
await save(FILE_A, story('甲', 6));
await save(FILE_B, story('乙', 40));

try {
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', e => pageErrors.push(String(e.stack ?? e).slice(0, 400)));
    await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: FILE_A })}`);
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    const ready = await page.evaluate(() => {
        const ctx = document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext();
        return { open: typeof ctx.openCharacterChat, save: typeof ctx.saveMetadata, chat: ctx.chat.length };
    });
    check('the full app is on the first story', ready.open === 'function' && ready.save === 'function' && ready.chat === 6, ready);

    // The app's read of the second story is held for 3 seconds (a phone's network), so the gap is wide enough to save in.
    let held = 0;
    await context.route('**/api/chats/get', async route => {
        const request = route.request();
        if (request.frame()?.parentFrame() && JSON.parse(request.postData() ?? '{}').file_name === FILE_B) {
            held++;
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        await route.continue();
    });
    saves.length = 0;
    const opened = await page.evaluate(async file => {
        // A fresh context each time: the app replaces its metadata object when it switches.
        const ctx = () => document.querySelector('iframe.engine').contentWindow.SillyTavern.getContext();
        const gap = () => ctx().chat.length === 0 && ctx().characters[ctx().characterId]?.chat === file;
        const opening = ctx().openCharacterChat(file);
        // In the gap: the app's chat is empty and already named after the second story.
        const deadline = Date.now() + 2500;
        while (!gap() && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
        const inGap = gap();
        ctx().chatMetadata.variables = { 写在空档里: 1 };
        await ctx().saveMetadata();
        await opening;
        return { inGap, chat: ctx().chat.length, last: ctx().chat.at(-1)?.mes };
    }, FILE_B);
    await context.unroute('**/api/chats/get');
    console.log('saves', JSON.stringify(saves), 'held', held);
    check('the save was made in the gap', opened.inGap && held === 1, opened);
    await page.waitForTimeout(2500);
    const server = await read(FILE_B);
    check('the second story on the server keeps every message', Array.isArray(server) && server.length === 41 && server.at(-1)?.mes === '乙第39段。', Array.isArray(server) ? server.length : server);
    check('the second story keeps its mark', server?.[0]?.chat_metadata?.integrity === `${FILE_B}-mark`, server?.[0]?.chat_metadata);
    check('the full app opened the whole second story', opened.chat === 40 && opened.last === '乙第39段。', opened);
    check('no empty save of the second story reached the server', !saves.some(s => s.file === FILE_B && s.size < 2000), saves);
    const backA = await read(FILE_A);
    check('the first story is untouched', backA.length === 7, backA.length);
    await page.close();

    // The plugin refuses to turn a story with messages into an unmarked empty one (pages with an older shell).
    const probe = await post('/api/plugins/tavern-lite-save/probe', {});
    if (probe.ok()) {
        const lines = (await read(FILE_B)).map(entry => JSON.stringify(entry));
        const empty = [JSON.stringify({ chat_metadata: { variables: { a: 1 } }, user_name: 'unused', character_name: 'unused' })];
        const refused = await post('/api/plugins/tavern-lite-save/patch', { avatar_url: avatar, file_name: FILE_B, base: hashLines(lines), target: hashLines(empty), ...diffLines(lines, empty) });
        check('the plugin refuses an unmarked empty save over a story', refused.status() === 400 && (await read(FILE_B)).length === 41, refused.status());
        const marked = [JSON.stringify({ chat_metadata: { integrity: `${FILE_B}-mark` } }), ...lines.slice(1, 3)];
        const allowed = await post('/api/plugins/tavern-lite-save/patch', { avatar_url: avatar, file_name: FILE_B, base: hashLines(lines), target: hashLines(marked), ...diffLines(lines, marked) });
        check('the plugin still takes a marked save that shortens a story', allowed.ok() && (await read(FILE_B)).length === 3, allowed.status());
    } else {
        console.log('SKIP plugin checks (no tavern-lite-save plugin)');
    }
    check('no page errors', pageErrors.length === 0, pageErrors);
} finally {
    await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
    await browser.close();
}
console.log(JSON.stringify(results, null, 1));
process.exit(problems.length ? 1 : 0);
