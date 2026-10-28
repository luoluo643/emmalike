// 番外 and other parts of the official SillyTavern, with only tavern-lite installed: a split or a new 番外 keeps the
// story's persona lock and Horae's migration marker, carries the story's variables only when asked, and the full app's
// "branch" and checkpoint copies of a 番外 (or, before 1.19, of the story) do not make it "来源没确认".
// Usage: node e2e-episode-compat.mjs <baseUrl> [handle] [password]
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle = 'default-user', password = 'test1234'] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const run = `tl-epcompat-${Date.now()}`, rootFile = `${run}-root`, PERSONA = 'user-default.png';
const problems = [], results = {}, pageErrors = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`.slice(0, 400); if (!ok) problems.push(name); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); };

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
    ch_name: run, description: '番外兼容测试角色', first_mes: '“你来了。”', personality: '', scenario: '', mes_example: '',
    creator_notes: '', system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' } });
const avatar = (await created.text()).trim();
if (!avatar.endsWith('.png')) throw new Error(`character not created: ${avatar}`);
const msg = (mes, is_user = false) => ({ name: is_user ? 'User' : run, is_user, is_system: false, mes, send_date: new Date().toISOString(), extra: {} });
const root = [
    { user_name: 'unused', character_name: 'unused', chat_metadata: { integrity: randomUUID(), tainted: true, persona: PERSONA,
        variables: { EP_VAR: run }, horae_native_visibility_migration: 1 } },
    msg('“你来了。”'),
    msg('暂停当前剧情，为我生成一个番外小剧场：雨夜', true),
    msg('番外第一段'),
    msg('番外里接着写', true),
    msg('番外第二段'),
    msg('回到正文', true),
    msg('正文继续。'),
];
if (!(await post('/api/chats/save', { avatar_url: avatar, file_name: rootFile, chat: root, force: false })).ok()) throw new Error('fixture not saved');
const readChat = async file => (await post('/api/chats/get', { avatar_url: avatar, file_name: file })).json();
const listChats = async () => (await post('/api/characters/chats', { avatar_url: avatar, metadata: true })).json();
const fileOf = row => String(row.file_name).replace(/\.jsonl$/, '');

const engineEval = (fn, arg) => page.evaluate(([code, arg]) => {
    const w = document.querySelector('iframe.engine')?.contentWindow;
    if (!w?.TavernLiteBridge) throw new Error('no bridge');
    return new w.Function('w', 'arg', `return (${code})(w, arg)`)(w, arg);
}, [fn.toString(), arg]);
const openStory = async file => {
    await page.goto('about:blank');
    await page.goto(`${appUrl}#${new URLSearchParams({ chat: avatar, file })}`);
    await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
    await page.waitForFunction(() => { const s = document.querySelector('iframe.engine')?.contentWindow?.TavernLiteBridge?.episodeStatus?.(); return s && !s.scanning; }, null, { timeout: 60000 });
    // What the app wrote while opening the story is saved once, so the story on disk is what is shown (fixture setup).
    await engineEval(async w => {
        const st = await import('/script.js'), ext = await import('/scripts/extensions.js');
        await new Promise(r => setTimeout(r, 1500));
        ext.cancelDebouncedMetadataSave?.(); st.cancelDebouncedChatSave?.(); await st.saveChatConditional();
    });
};
const graph = () => engineEval(async (w, avatar) => {
    const g = await w.TavernLiteBridge.episodeIndex(avatar);
    return { ambiguousIds: g.ambiguousIds, nodes: g.nodes.map(n => ({ file: n.locator.file, relationship: n.relationship, root: n.rootLocator?.file ?? null,
        copyOf: n.nativeCopyOf?.file ?? null, title: n.episode.title })) };
}, avatar);
const carried = md => ({ persona: md.persona ?? null, horae: md.horae_native_visibility_migration ?? null, variables: md.variables ?? null });

try {
    await openStory(rootFile);
    let split1;
    // 1. Split from the sheet: the persona lock and Horae's marker come along, the variables only when ticked (not by default).
    {
        await page.getByRole('button', { name: '番外与平行线' }).click();
        const dialog = page.getByRole('dialog', { name: '番外与平行线' });
        await dialog.waitFor();
        await dialog.getByRole('button', { name: '拆成独立故事' }).first().click();
        const box = dialog.getByRole('checkbox', { name: /带上这个故事的变量/ });
        check('the split form offers the variables, not ticked', await box.isVisible() && !await box.isChecked());
        await page.screenshot({ path: '/tmp/tl-epcompat-split.png' });
        await dialog.getByRole('button', { name: '拆成独立故事' }).click();
        await page.getByText(/已拆成「/).first().waitFor({ timeout: 60000 });
        const row = (await listChats()).find(c => c.chat_metadata?.tavern_lite_episode?.extractedFrom);
        split1 = row && fileOf(row);
        const md = split1 ? (await readChat(split1))[0]?.chat_metadata ?? {} : {};
        const c = carried(md);
        check('split: the persona lock comes along', c.persona === PERSONA, JSON.stringify(c));
        check('split: Horae\'s marker comes along', c.horae === 1, JSON.stringify(c));
        check('split: the variables stay behind by default', c.variables === null, JSON.stringify(c));
        await dialog.getByRole('button', { name: '关闭' }).click();
    }
    // 2. Split with the variables.
    {
        const out = await engineEval(async (w, a) => {
            const r = await w.TavernLiteBridge.extractEpisode({ account: a.account, scope: { account: a.account, avatar: a.avatar, file: a.file },
                from: 2, to: 5, title: '带变量的拆分', kind: 'side', carryVariables: true });
            return { kind: r.kind, file: r.target?.file ?? r.locator?.file ?? null };
        }, { account: handle, avatar, file: rootFile });
        const row = (await listChats()).find(c => c.chat_metadata?.tavern_lite_episode?.title === '带变量的拆分');
        const c = carried(row?.chat_metadata ?? {});
        check('split with variables: they come along', out.kind === 'extracted' && c.variables?.EP_VAR === run && c.persona === PERSONA, JSON.stringify({ out, c }));
    }
    // 3. The full app's branch and checkpoint of a 番外 are copies; the 番外 keeps its place.
    {
        await openStory(split1);
        const made = await engineEval(async (w, name) => {
            const bm = await import('/scripts/bookmarks.js'), st = await import('/script.js');
            const last = st.chat.length - 1;
            await bm.createBranch(last);
            await bm.createNewBookmark(last, { forceName: name });
            await st.saveChatConditional();
            return last;
        }, `${run}-checkpoint`);
        const copies = (await listChats()).filter(c => c.chat_metadata?.main_chat === split1).map(fileOf);
        check('the full app made a branch and a checkpoint of the 番外, both carrying its identity', copies.length === 2 &&
            (await listChats()).filter(c => copies.includes(fileOf(c))).every(c => c.chat_metadata?.tavern_lite_episode?.title), JSON.stringify({ made, copies }));
        await openStory(rootFile);
        const g = await graph();
        const original = g.nodes.find(n => n.file === split1), copyNodes = g.nodes.filter(n => copies.includes(n.file));
        check('the 番外 is still resolved under the story', original?.relationship === 'resolved' && original.root === rootFile && !original.copyOf, JSON.stringify(original));
        check('its copies are known as copies and lead back to the story', copyNodes.length === 2 &&
            copyNodes.every(n => n.relationship === 'resolved' && n.copyOf === split1 && n.root === rootFile), JSON.stringify(copyNodes));
        check('nothing is 来源没确认', g.nodes.every(n => n.relationship === 'resolved') && !g.ambiguousIds.length, JSON.stringify(g));
        await page.getByRole('button', { name: '番外与平行线' }).click();
        const dialog = page.getByRole('dialog', { name: '番外与平行线' });
        await dialog.waitFor();
        await dialog.getByText('正文与番外、平行线').waitFor();
        await page.waitForFunction(() => !document.querySelector('[role=dialog]')?.textContent.includes('正在加载'));
        const text = await dialog.innerText();
        check('the sheet lists the copies as branches, with no 来源没确认 section', (text.match(/（走向）/g) || []).length === 2 && !text.includes('没确认来源的番外'), text.slice(0, 600));
        await page.screenshot({ path: '/tmp/tl-epcompat-branches.png' });
        await dialog.getByRole('button', { name: '关闭' }).click();
    }
    // 4. A checkpoint of the story itself (before 1.19 it keeps the story's integrity) does not stop new 番外.
    {
        await engineEval(async (w, name) => {
            const bm = await import('/scripts/bookmarks.js'), st = await import('/script.js');
            await bm.createNewBookmark(st.chat.length - 1, { forceName: name });
            await st.saveChatConditional();
        }, `${run}-story-checkpoint`);
        await openStory(rootFile);
        const g = await graph();
        check('after a checkpoint of the story, its 番外 stay resolved', g.nodes.every(n => n.relationship === 'resolved') && !g.ambiguousIds.length, JSON.stringify(g));
        // 5. A new 番外 without the story: persona lock and marker, variables only when asked.
        const fresh = async carryVariables => engineEval(async (w, a) => {
            const b = w.TavernLiteBridge;
            const p = await b.prepareEpisode({ account: a.account, scope: { account: a.account, avatar: a.avatar, file: a.file }, text: `【番外】新开 ${a.carryVariables}`,
                draftRevision: 0, assertDraft: () => true, kind: 'side', title: `新开${a.carryVariables ? '带变量' : ''}`, contextMode: 'fresh', carryVariables: a.carryVariables });
            await b.cancelEpisode({ account: a.account, operationId: p.operation.operationId });
            return p.target.file;
        }, { account: handle, avatar, file: rootFile, carryVariables });
        const plain = await fresh(false).catch(e => `ERROR ${e.message}`);
        const md = (await readChat(plain).catch(() => [{}]))[0]?.chat_metadata ?? {};
        const c = carried(md);
        check('new 番外 from the story after its checkpoint', !String(plain).startsWith('ERROR'), plain);
        check('new 番外: persona lock and Horae\'s marker, no variables', c.persona === PERSONA && c.horae === 1 && c.variables === null, JSON.stringify(c));
        const withVars = await fresh(true).catch(e => `ERROR ${e.message}`);
        const c2 = carried((await readChat(withVars).catch(() => [{}]))[0]?.chat_metadata ?? {});
        check('new 番外 with variables: they come along', c2.variables?.EP_VAR === run, JSON.stringify(c2));
    }
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
    problems.push('crashed');
    console.log('FAILURE', error.stack);
    await page.screenshot({ path: '/tmp/tl-epcompat-fail.png' }).catch(() => { });
}
await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true }).catch(() => { });
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(problems.length ? `PROBLEMS: ${problems.join(', ')}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
