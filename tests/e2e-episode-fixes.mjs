// 番外 fixes on an official SillyTavern with only tavern-lite installed: the supported version range, a split that
// shows the messages hidden in the story, a continued separate write that carries other extensions' chat state,
// "还是发在当前故事里" from the sheet, and switching 番外增强 off and on after the story was found changed.
// Usage: node e2e-episode-fixes.mjs <baseUrl> [handle] [password]
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = `tl-epfix-${Date.now()}`, rootFile = `${run}-root`;
const problems = [], results = {}, pageErrors = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`.slice(0, 400); if (!ok) problems.push(name); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.setDefaultTimeout(30000);
page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 200)));
const token = (await (await page.request.get(`${base}/csrf-token`)).json()).token;
const post = (path, data) => page.request.post(`${base}${path}`, { headers: { 'X-CSRF-Token': token }, data });
if (!(await post('/api/users/login', { handle, password })).ok()) throw new Error('login failed');
const version = (await (await page.request.get(`${base}/version`)).json()).pkgVersion;
console.log('SillyTavern', version);

const created = await page.request.post(`${base}/api/characters/create`, { headers: { 'X-CSRF-Token': token }, multipart: {
    ch_name: run, description: '番外修复测试角色', first_mes: '“你来了。”', personality: '', scenario: '', mes_example: '',
    creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' } });
const avatar = (await created.text()).trim();
if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);
const msg = (mes, is_user = false, more = {}) => ({ name: is_user ? 'User' : run, is_user, is_system: false, mes, send_date: new Date().toISOString(), extra: {}, ...more });
const root = [
    { user_name: 'unused', character_name: 'unused', chat_metadata: { integrity: randomUUID(), tainted: true, variables: { EP_STATE: run },
        horae_native_visibility_migration: 1, tl_test_ext_state: { kept: run } } },
    msg('“你来了。”'),
    msg('暂停当前剧情，为我生成一个番外小剧场：雨夜', true),
    msg('番外第一段（被总结后隐藏）', false, { is_system: true, is_hidden: true }),
    msg('番外里接着写（也被隐藏）', true, { is_system: true, is_hidden: true }),
    msg('作者注释', false, { is_system: true, extra: { type: 'comment' } }),
    msg('番外第二段', false),
    msg('回到正文', true),
    msg('正文继续。'),
];
if (!(await post('/api/chats/save', { avatar_url: avatar, file_name: rootFile, chat: root, force: false })).ok()) throw new Error('fixture not saved');
const readChat = async file => (await post('/api/chats/get', { avatar_url: avatar, file_name: file })).json();
const listChats = async () => (await post('/api/characters/chats', { avatar_url: avatar, metadata: true })).json();

const engineEval = (fn, arg) => page.evaluate(([code, arg]) => {
    const w = document.querySelector('iframe.engine')?.contentWindow;
    if (!w?.TavernLiteBridge) throw new Error('no bridge');
    return new w.Function('w', 'arg', `return (${code})(w, arg)`)(w, arg);
}, [fn.toString(), arg]);
const status = () => engineEval(w => w.TavernLiteBridge.episodeStatus());
const openStory = async () => {
    await page.goto('about:blank');
    await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file: rootFile })}`);
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    await page.waitForFunction(() => { const s = document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge?.episodeStatus?.(); return s && !s.scanning; }, null, { timeout: 60000 });
};
// What the app wrote while opening the story is saved once, so the story on disk is what is shown (fixture setup).
const settle = () => engineEval(async w => {
    const st = await import('/script.js'), ext = await import('/scripts/extensions.js');
    await new Promise(r => setTimeout(r, 1500));
    ext.cancelDebouncedMetadataSave?.(); st.cancelDebouncedChatSave?.(); await st.saveChatConditional();
});

try {
    // 1. The version range.
    await openStory();
    {
        const s = await status();
        check(`version ${version} is accepted for writing apart and splitting`, s.verified && s.extractable, JSON.stringify(s.reasons));
        check('nothing else installed, nothing to warn about', Array.isArray(s.warnings) && s.warnings.length === 0, JSON.stringify(s.warnings));
    }

    // 2. A split shows the hidden messages (the app's own system notes stay hidden).
    {
        await page.getByRole('button', { name: '番外与平行线' }).click();
        const dialog = page.getByRole('dialog', { name: '番外与平行线' });
        await dialog.waitFor();
        await dialog.getByRole('button', { name: '拆成独立故事' }).first().click();
        const box = dialog.getByRole('checkbox', { name: /把其中隐藏的 2 条也放出来/ });
        check('the split form offers to show the 2 hidden messages, ticked', await box.isVisible() && await box.isChecked());
        await page.screenshot({ path: '/tmp/tl-epfix-split.png' });
        await dialog.getByRole('button', { name: '拆成独立故事' }).click();
        await page.getByText(/2 条隐藏的已放出来/).first().waitFor({ timeout: 60000 });
        const split = (await listChats()).find(c => c.chat_metadata?.tavern_lite_episode?.extractedFrom);
        const file = split ? await readChat(String(split.file_name).replace(/\.jsonl$/, '')) : [];
        const messages = file.slice(1);
        check('the split story has the 5 messages of the 番外', messages.length === 5, String(messages.length));
        check('the hidden messages are shown in the split story', messages.filter(m => /隐藏/.test(m.mes)).every(m => m.is_system === false && m.is_hidden === false));
        check('the app\'s own note stays hidden', messages.find(m => m.mes === '作者注释')?.is_system === true);
        check('the split records how many were shown', file[0]?.chat_metadata?.tavern_lite_episode?.extractedFrom?.unhidden === 2, JSON.stringify(file[0]?.chat_metadata?.tavern_lite_episode?.extractedFrom));
        const story = await readChat(rootFile);
        check('the story itself keeps them hidden', story.filter(m => /隐藏/.test(m.mes ?? '')).every(m => m.is_system === true));
        await dialog.getByRole('button', { name: '关闭' }).click();
    }

    // 3. Writing apart from the latest state carries other extensions' chat state and leaves the story unchanged.
    {
        await settle();
        const before = hash(await readChat(rootFile));
        const out = await engineEval(async (w, scope) => {
            const b = w.TavernLiteBridge;
            const prepared = await b.prepareEpisode({ account: scope.account, scope, text: '【番外】测试接续正文', draftRevision: 0, assertDraft: () => true,
                kind: 'side', title: '接续测试', contextMode: 'continued' });
            const sent = await b.sendEpisode({ account: scope.account, operationId: prepared.operation.operationId, reviewReceipt: prepared.reviewReceipt, assertDraft: () => true });
            return { carried: prepared.carriedMetadataKeys, kind: sent.kind, target: sent.target };
        }, { account: handle, avatar, file: rootFile });
        check('the review lists the unreviewed state that comes along', JSON.stringify(out.carried) === JSON.stringify(['tl_test_ext_state']), JSON.stringify(out.carried));
        check('the separate write is confirmed', out.kind === 'confirmed', out.kind);
        const child = await readChat(out.target.file);
        const md = child[0]?.chat_metadata ?? {};
        check('the 番外 carries Horae\'s marker, the variables and the other state', md.horae_native_visibility_migration === 1 && md.variables?.EP_STATE === run && md.tl_test_ext_state?.kept === run, JSON.stringify(Object.keys(md)));
        check('the 番外 continues from the whole story and has the request and a reply', child.length >= root.length + 2 && child.some(m => m.mes === '【番外】测试接续正文'), String(child.length));
        check('the story it came from is unchanged', hash(await readChat(rootFile)) === before);
    }

    // 4. A 番外 command sent from the story opens the sheet, which can still send it in the story.
    {
        await openStory();
        await page.locator('.tl-composer-input').fill('【番外】就在这里写');
        await page.getByRole('button', { name: '发送' }).click();
        const dialog = page.getByRole('dialog', { name: '番外与平行线' });
        await dialog.waitFor();
        await dialog.getByRole('button', { name: '还是发在当前故事里' }).click();
        await dialog.waitFor({ state: 'hidden' });
        await page.waitForFunction(() => [...document.querySelectorAll('.tl-message')].some(m => m.textContent.includes('就在这里写')), null, { timeout: 60000 });
        await page.locator('.tl-send').waitFor({ timeout: 120000 });
        await page.waitForTimeout(2000);
        const story = await readChat(rootFile);
        check('sent in the story after all', story.some(m => m.is_user && m.mes === '【番外】就在这里写'), JSON.stringify(story.slice(-2).map(m => m.mes)));
    }

    // 5. After the story was found changed, switching 番外增强 off and on lets it write apart again.
    {
        await engineEval((w, account) => { w.localStorage.setItem(`tavern-lite:episodes-unverified:${JSON.stringify(account)}`, 'true'); }, handle);
        await openStory();
        const blocked = await status();
        check('a changed story blocks writing apart with what to do', !blocked.verified && blocked.reasons.some(r => r.includes('关掉重新打开')), JSON.stringify(blocked.reasons));
        const after = await engineEval(w => { w.TavernLiteBridge.setEpisodeEnabled(false); return w.TavernLiteBridge.setEpisodeEnabled(true); });
        const stored = await engineEval((w, account) => w.localStorage.getItem(`tavern-lite:episodes-unverified:${JSON.stringify(account)}`), handle);
        check('switching it off and on clears it', after.verified && stored === null, JSON.stringify(after.reasons));
    }
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
    problems.push('crashed');
    console.log('FAILURE', error.stack);
    await page.screenshot({ path: '/tmp/tl-epfix-fail.png' }).catch(() => { });
}
await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS: ${problems.join(', ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
