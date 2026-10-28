// Feedback while work is on its way, on an official SillyTavern with only tavern-lite and a slow network: after
// "删除" / "保存" / "换个走向" / "收藏" / deleting a story or a character, the sheet stays open and the tapped button
// says what is happening ("正在删除…") until it is done, cannot be tapped twice or closed meanwhile, then closes.
// Usage: node e2e-busy-feedback.mjs <baseUrl> <handle> <password> [screenshot dir]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234', shotArg] = process.argv.slice(2);
// Runners pass the other suites' delay numbers in this place.
const shots = shotArg && !/^\d+$/.test(shotArg) ? shotArg : '/root';
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = Date.now().toString(36);
const NAME = `等待${run}`, FILE = `等待-${run}`;
const SLOW_MS = 3000;
const results = {}, problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 400); if (!ok) problems.push(name); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript(() => {
    window.__tlToasts = [];
    new MutationObserver(rs => { for (const r of rs) for (const n of r.addedNodes) if (n.classList?.contains('tl-toast')) window.__tlToasts.push(n.textContent); })
        .observe(document, { childList: true, subtree: true });
});
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
const story = [
    { name: NAME, is_user: false, mes: '你来了。' },
    { name: 'User', is_user: true, mes: '外面下雨了吗？' },
    { name: NAME, is_user: false, mes: '下了一整夜。', swipes: ['下了一整夜。', '刚停。'], swipe_id: 0, swipe_info: [{ send_date: now, extra: {} }, { send_date: now, extra: {} }] },
    { name: 'User', is_user: true, mes: '那我们出去走走。' },
    { name: NAME, is_user: false, mes: '好，带上伞。' },
].map(m => ({ ...m, send_date: now, extra: {} }));
await post('/api/chats/save', { ch_name: NAME, file_name: FILE, avatar_url: avatar, chat: [{ user_name: 'User', character_name: NAME, create_date: now, chat_metadata: {} }, ...story], force: true });

const toasts = () => page.evaluate(() => window.__tlToasts.slice());
const message = text => page.locator('.tl-message', { hasText: text }).first();
const openMenu = async text => { await message(text).locator('.tl-message-menu').click(); return page.getByRole('dialog', { name: '消息操作' }); };
const slow = pattern => context.route(pattern, async route => { await new Promise(r => setTimeout(r, SLOW_MS)); return route.continue().catch(() => { }); });
const fast = () => context.unrouteAll({ behavior: 'ignoreErrors' });
// On a phone the wait is mostly the account check before each change (about 1 MB); it is reused for 2 seconds.
const slowStory = async () => { await slow('**/api/users/me'); await slow('**/api/chats/save'); };
const past = () => page.waitForTimeout(2600);
// Right after the tap (well before the slow request is answered): what the sheet shows.
const busyState = dialog => dialog.evaluate(d => {
    const busy = [...d.querySelectorAll('[aria-busy="true"]')].map(b => b.textContent.trim());
    return { open: d.isConnected, busy, closeDisabled: !!d.querySelector('.tl-sheet-close')?.disabled, ring: !!d.querySelector('[aria-busy="true"] .tl-spinner') };
});
const settle = (dialog, ms = 60000) => dialog.waitFor({ state: 'detached', timeout: ms }).then(() => true).catch(() => false);

try {
    await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: FILE })}`);
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    await message('那我们出去走走').waitFor();

    // 1. Deleting one message: the confirmation stays and says "正在删除…" until the story is saved.
    await slowStory();
    await past();
    let menu = await openMenu('那我们出去走走');
    await menu.getByRole('button', { name: /^删除/ }).click();
    let confirm = page.getByRole('dialog', { name: '删除这条消息' });
    await confirm.getByRole('button', { name: '删除', exact: true }).click();
    await page.waitForTimeout(400);
    let state = await busyState(confirm);
    check('delete: the confirmation stays open and says 正在删除…', state.open && state.busy.includes('正在删除…') && state.ring, state);
    check('delete: it cannot be closed meanwhile', state.closeDisabled && await confirm.getByRole('button', { name: '取消' }).isDisabled(), state);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const afterEscape = await busyState(confirm).catch(() => ({ open: false, busy: [] }));
    check('delete: Escape does not close it while deleting', afterEscape.open && afterEscape.busy.includes('正在删除…'), afterEscape);
    await page.screenshot({ path: `${shots}/tl-busy-delete.png` });
    check('delete: it closes when done and the message is gone', await settle(confirm) && await message('那我们出去走走').count() === 0);
    check('delete: then says 已删除', (await toasts()).includes('已删除'), await toasts());

    // 2. Deleting one of two replies: the tapped item says so, the other one waits.
    await past();
    menu = await openMenu('下了一整夜');
    await menu.getByRole('button', { name: /^删除/ }).click();
    const choose = page.getByRole('dialog', { name: '删除' });
    await choose.getByRole('button', { name: /只删这个回复/ }).click();
    await page.waitForTimeout(400);
    state = await busyState(choose);
    const otherDisabled = await choose.getByRole('button', { name: /删除整条消息/ }).isDisabled();
    check('delete one reply: the item says 正在删除这个回复… and the other waits', state.open && state.busy.some(t => t.startsWith('正在删除这个回复…')) && otherDisabled, { state, otherDisabled });
    check('delete one reply: it closes when done', await settle(choose) && (await toasts()).includes('已删除这个回复'), await toasts());

    // 3. Editing: the sheet stays with 正在保存… and the text cannot change meanwhile.
    await past();
    menu = await openMenu('外面下雨了吗');
    await menu.getByRole('button', { name: /^编辑/ }).click();
    const edit = page.getByRole('dialog', { name: '编辑我说的话' });
    await edit.locator('textarea').fill('外面还在下雨吗？');
    await edit.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForTimeout(400);
    state = await busyState(edit);
    check('edit: the sheet stays open and says 正在保存…', state.open && state.busy.includes('正在保存…'), state);
    check('edit: the text is read-only while saving', await edit.locator('textarea').evaluate(t => t.readOnly));
    check('edit: it closes when saved, with the new text', await settle(edit) && await message('外面还在下雨吗').count() === 1);

    // 4. 换个走向: the item says it is starting a new story, then the new story opens.
    const before = location => new URLSearchParams(location.split('#')[1] ?? '').get('file');
    const fileBefore = before(page.url());
    await past();
    menu = await openMenu('外面还在下雨吗');
    await menu.getByRole('button', { name: /^换个走向/ }).click();
    await page.waitForTimeout(400);
    state = await busyState(menu).catch(() => ({ open: false, busy: [] }));
    check('branch: the item says 正在另开一个故事…', state.open && state.busy.some(t => t.startsWith('正在另开一个故事…')), state);
    await page.waitForFunction(f => new URLSearchParams(location.hash.slice(1)).get('file') !== f, fileBefore, { timeout: 60000 }).catch(() => { });
    check('branch: the new story opens and the menu is gone', before(page.url()) !== fileBefore && await menu.count() === 0, page.url());
    await fast();

    // 5. Favourite on the shelf: the item says 正在收藏… until the card is saved.
    await page.goto(`${appUrl}#`);
    await page.getByRole('button', { name: `${NAME} 的更多操作` }).click();
    await slow('**/api/characters/merge-attributes');
    const book = page.getByRole('dialog', { name: NAME });
    await book.getByRole('button', { name: /^收藏/ }).click();
    await page.waitForTimeout(400);
    state = await busyState(book);
    check('favourite: the item says 正在收藏…', state.open && state.busy.some(t => t.startsWith('正在收藏…')), state);
    check('favourite: it closes when saved', await settle(book) && (await toasts()).includes(`已收藏「${NAME}」`), await toasts());
    await fast();

    // 6. Deleting a story on the character page.
    await page.goto(`${appUrl}#${new URLSearchParams({ work: avatar })}`);
    await page.locator('.tl-chapter-row').nth(1).waitFor();
    // The full app may have started a story of its own when the character was opened: count, do not assume.
    const storiesBefore = await page.locator('.tl-chapter-row').count();
    await slow('**/api/chats/delete');
    await page.locator('.tl-chapter-row', { hasText: '走向' }).first().getByRole('button', { name: '故事操作' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^删除/ }).click();
    confirm = page.getByRole('dialog', { name: /^删除「/ });
    await confirm.getByRole('button', { name: '删除', exact: true }).click();
    await page.waitForTimeout(400);
    state = await busyState(confirm);
    check('delete story: the confirmation says 正在删除…', state.open && state.busy.includes('正在删除…'), state);
    const storyClosed = await settle(confirm);
    await page.waitForFunction(n => document.querySelectorAll('.tl-chapter-row').length === n - 1, storiesBefore, { timeout: 15000 }).catch(() => { });
    check('delete story: it closes when done, one story fewer', storyClosed && (await toasts()).includes('故事已删除')
        && await page.locator('.tl-chapter-row').count() === storiesBefore - 1, { toasts: await toasts(), rows: await page.locator('.tl-chapter-name').allInnerTexts() });
    await fast();

    // 7. Deleting the character.
    await page.goto(`${appUrl}#`);
    await page.getByRole('button', { name: `${NAME} 的更多操作` }).click();
    await page.getByRole('dialog', { name: NAME }).getByRole('button', { name: /^删除角色/ }).click();
    await slow('**/api/characters/delete');
    confirm = page.getByRole('dialog', { name: `删除「${NAME}」？` });
    await confirm.getByRole('button', { name: '删除', exact: true }).click();
    await page.waitForTimeout(400);
    state = await busyState(confirm);
    check('delete character: the confirmation says 正在删除…', state.open && state.busy.includes('正在删除…'), state);
    check('delete character: it closes when done', await settle(confirm) && (await toasts()).includes(`已删除「${NAME}」`), await toasts());
    await fast();

    check('no "正在…" line is left on screen', await page.locator('.tl-toast[data-level="busy"]').count() === 0);
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
    problems.push('crashed');
    console.log('FAILURE', error.stack);
    await page.screenshot({ path: `${shots}/tl-busy-fail.png` }).catch(() => { });
}
await fast().catch(() => { });
await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS: ${problems.join(', ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
