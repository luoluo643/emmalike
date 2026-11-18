// Smoke test of tavern-lite inside TT 酒馆 (TauriTavern), on an Android device or emulator with this work copy installed
// in TT's extension folder (default-user/extensions/<folder>). It drives TT's real page through the WebView's DevTools
// port, so it checks what the browser suites cannot: TT's request routing, its late extension start, its back button.
//
//   adb forward tcp:9258 localabstract:$(adb shell cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1)
//   node tests/tt-smoke.mjs http://127.0.0.1:9258 [--generate]
//
// --generate also sends, swipes and deletes in a story: TT needs a model connection for that (the mock model works:
// run tests/mock-llm.mjs on the computer and point TT's custom endpoint at http://10.0.2.2:5001/v1, which TT asks to
// trust once in a dialog of its own). The test answers TT's "Enable notifications?" question with "Not now".
// The emulator build of TT must be debuggable WebView-wise (release builds of TT are).
const [devtools = 'http://127.0.0.1:9258', ...flags] = process.argv.slice(2);
const generate = flags.includes('--generate');
// The whole run gives up after TT_SMOKE_TOTAL_MS (default 25 minutes), one page call after 200 seconds.
const TOTAL_MS = Number(process.env.TT_SMOKE_TOTAL_MS) || 25 * 60 * 1000;
const CALL_MS = 200000;
const results = [];
const summary = () => { const failed = results.filter(r => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} passed`); return failed.length; };
const giveUp = reason => { console.log(`FAIL ${reason}`); summary(); process.exit(2); };
setTimeout(() => giveUp(`the run took longer than ${Math.round(TOTAL_MS / 60000)} minutes`), TOTAL_MS).unref();

const pages = await (await fetch(`${devtools}/json/list`)).json();
const target = pages.find(p => p.type === 'page' && /tauri\.localhost\/?(#.*)?$/.test(p.url)) ?? pages.find(p => p.type === 'page');
if (!target) throw new Error('No TT page on that DevTools port');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools connection failed')); });
let seq = 0;
const waiting = new Map();
let closing = false;
ws.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { giveUp(`DevTools sent something that is not JSON: ${String(event.data).slice(0, 120)}`); return; }
    const pending = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) pending?.reject(new Error(`DevTools protocol error: ${JSON.stringify(message.error).slice(0, 300)}`));
    else pending?.resolve(message);
};
ws.onclose = () => { if (!closing) giveUp('the DevTools connection closed (TT closed or the WebView went away)'); };
ws.onerror = () => { if (!closing) giveUp('the DevTools connection broke'); };
async function evaluate(expression) {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, timeout: 180000 } }));
    let timer;
    const message = await Promise.race([
        new Promise((resolve, reject) => waiting.set(id, { resolve, reject })),
        new Promise((_, reject) => { timer = setTimeout(() => { waiting.delete(id); reject(new Error(`no answer from the page in ${CALL_MS / 1000} s`)); }, CALL_MS); }),
    ]).finally(() => clearTimeout(timer));
    const result = message.result ?? {};
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600));
    return result.result?.value;
}

// Helpers installed in TT's page: the shell's frame, its document, and waiting for things in it.
const HELPERS = `window.__ttSmoke = {
  frame: () => document.getElementById('tavern-lite-shell'),
  win() { return this.frame().contentWindow; },
  doc() { return this.frame().contentDocument; },
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  async wait(fn, ms = 30000) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = fn(); if (v) return v; } catch {} await this.sleep(250); } return null; },
  label(text) { return this.doc().querySelector('[aria-label="' + text + '"]'); },
  text() { return this.doc().body.innerText; },
  async go(hash, ms = 3000) { const w = this.win(); w.history.pushState({ tavernLite: true }, '', hash || '#'); w.dispatchEvent(new w.Event('tl-route')); await this.sleep(ms); },
  answerTt() { const b = [...this.doc().querySelectorAll('button')].find(b => b.innerText.trim() === 'Not now'); if (b) b.click(); return !!b; },
  async settle() { let saw = false; for (let i = 0; i < 100; i++) { await this.sleep(400); this.answerTt(); if (this.label('停止') || this.doc().querySelector('.tl-swipe-status')) saw = true; else if (saw) break; } await this.sleep(1200); return saw; },
  floats(rects) { this.unfloat(); return rects.map(([x, y, w, h]) => { const b = document.createElement('button'); b.className = 'tt-smoke-float'; b.textContent = 'x';
    b.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;z-index:99999;margin:0;padding:0;'; document.body.append(b); return b; }); },
  unfloat() { document.querySelectorAll('.tt-smoke-float').forEach(b => b.remove()); },
  at(x, y) { const e = document.elementFromPoint(x, y); return e === this.frame() ? 'shell' : e?.classList?.contains('tt-smoke-float') ? 'float' : 'tt'; },
  idle(ms = 90000) { return this.wait(() => !window.TavernLiteBridge.isGenerating(), ms); },
  // The open chat as saved: its messages (the header line left out), read from TT's own files.
  async disk() { const c = SillyTavern.getContext(), ch = c.characters[c.characterId];
    const r = await fetch('/api/chats/get', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ ch_name: ch.name, file_name: c.getCurrentChatId(), avatar_url: ch.avatar }) });
    const rows = await r.json(); return Array.isArray(rows) ? rows.filter(m => m && typeof m.mes === 'string') : []; },
  // Waits until the saved chat has the page's messages, then says how they compare.
  async saved(ms = 15000) { const c = SillyTavern.getContext(); let disk = [];
    const same = () => disk.length === c.chat.length && disk.every((m, i) => m.mes === c.chat[i].mes && (m.swipes?.length ?? 1) === (c.chat[i].swipes?.length ?? 1));
    const t0 = Date.now(); while (Date.now() - t0 < ms) { disk = await this.disk(); if (same()) return { same: true, count: disk.length }; await this.sleep(500); }
    return { same: false, disk: disk.length, page: c.chat.length, lastDisk: disk.at(-1)?.mes?.slice(0, 40), lastPage: c.chat.at(-1)?.mes?.slice(0, 40) }; },
  // A real reply: not the placeholder, not empty, not the words sent; the mock model's answer quotes what was sent.
  realReply(mes, sent) { const m = String(mes ?? '').trim(); if (!m || /^[.。…]+$/.test(m) || m === sent || m.length < 6) return false;
    return !m.startsWith('（模拟回复）') || m.includes(sent.slice(0, 20)); },
  async type(text) { const input = this.label('输入消息'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, text); input.dispatchEvent(new (this.win().Event)('input', { bubbles: true })); await this.sleep(200); },
}; 1`;

async function check(name, expression, expect) {
    let value, ok = false, error = '';
    try {
        value = await evaluate(`(async () => { const t = window.__ttSmoke; ${expression} })()`);
        ok = expect(value);
    } catch (cause) { error = String(cause.message ?? cause); }
    results.push({ name, ok });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${error || JSON.stringify(value)}`}`);
    return value;
}

await evaluate('location.reload(), 1');
await new Promise(resolve => setTimeout(resolve, 15000));
await evaluate(HELPERS);

await check('menu entry appears on TT', `return !!(await t.wait(() => document.getElementById('tavern-lite-open'), 40000));`, v => v === true);
await check('late native observer is verified', `const s = window.TavernLiteNativeSettle; return s && { late: s.lateVerified, early: s.earlyVerified, error: s.errorCode };`,
    v => v?.late === true && v.early === false && v.error === null);
await check('opening from the menu lays the shell over TT', `document.getElementById('tavern-lite-open').click(); await t.wait(() => t.frame()?.contentDocument?.querySelector('.tl-app'), 30000);
    return { shown: !t.frame().hidden, mark: t.frame().dataset.tavernLite };`, v => v?.shown && v.mark === 'tt-shell');
await check('shelf lists the characters (requests answered by TT)', `return !!(await t.wait(() => /全部角色 · \\d+/.test(t.text()), 30000));`, v => v === true);
await check('bridge runs in TT’s own page, no second app loaded', `await t.wait(() => window.TavernLiteBridge, 30000);
    return { bridge: !!window.TavernLiteBridge, engines: t.doc().querySelectorAll('iframe.engine').length };`, v => v?.bridge && v.engines === 0);
await check('shell page reload keeps working', `t.win().location.reload(); await t.sleep(600); return !!(await t.wait(() => t.doc()?.querySelector('.tl-app') && /全部角色/.test(t.text()), 30000));`, v => v === true);
await check('我的 shows TT and no login items', `await t.go('#me', 3500); const s = t.text(); return { tt: /TT 酒馆 \\d/.test(s), back: s.includes('回到 TT 酒馆'), logout: s.includes('退出登录'), saver: s.includes('省流量') };`,
    v => v?.tt && v.back && !v.logout && !v.saver);
const BOOK = `冒烟世界书${Date.now().toString(36)}`;
await check('a world book is made through the shell (no /api/worldinfo/list on TT)', `const b = window.TavernLiteBridge;
    const r = await b.createWorldEditorBook({ account: b.worldEditorAccount(), name: ${JSON.stringify(BOOK)} });
    const c = SillyTavern.getContext(); const server = (await (await fetch('/api/settings/get', { method: 'POST', headers: c.getRequestHeaders(), body: '{}' })).json()).world_names ?? [];
    return { kind: r.kind, runtime: r.runtimeState, onServer: server.includes(${JSON.stringify(BOOK)}) };`, v => v?.kind === 'confirmed' && v.runtime === 'ready' && v.onServer);
await check('world books: the test book is listed, every book once', `await t.go('#worlds', 5000);
    const c = SillyTavern.getContext(); const server = (await (await fetch('/api/settings/get', { method: 'POST', headers: c.getRequestHeaders(), body: '{}' })).json()).world_names ?? [];
    const names = [...t.doc().querySelectorAll('.tl-worlds .tl-list-item .tl-list-label')].map(e => e.textContent.trim()).filter(n => n !== '在原版界面里打开');
    return { error: /没加载/.test(t.text()), has: names.includes(${JSON.stringify(BOOK)}), shown: names.length, server: server.length, unique: new Set(names).size === names.length,
        same: [...names].sort().join('|') === [...server].sort().join('|') };`, v => v && !v.error && v.has && v.unique && v.shown === v.server && v.same);
await check('opening a world book does not fetch the whole settings file', `let asked = 0; const own = window.fetch;
    window.fetch = function (input, init) { if (String(input?.url ?? input).includes('/api/settings/get')) asked++; return own.call(this, input, init); };
    try { await t.go('#' + new URLSearchParams({ world: ${JSON.stringify(BOOK)} }), 5000); await t.wait(() => t.doc().querySelector('.tl-world-book'), 15000); }
    finally { window.fetch = own; }
    return { asked, open: !!t.doc().querySelector('.tl-world-book'), error: /没加载/.test(t.text()) };`, v => v?.open && !v.error && v.asked === 0);
await check('… and the test book is deleted again', `const left = await window.TavernLiteBridge.deleteWorldBook(${JSON.stringify(BOOK)});
    await t.go('#worlds', 1500); return !left.some(b => b.name === ${JSON.stringify(BOOK)});`, v => v === true);

if (generate) {
    const avatar = await evaluate(`SillyTavern.getContext().characters[0]?.avatar`);
    await check('a new story opens (TT answers a missing chat with an error)', `await t.go('#' + new URLSearchParams({ chat: ${JSON.stringify(avatar)}, file: '', new: '1' }), 5000);
        return !!t.label('输入消息') && !t.doc().querySelector('.tl-error');`, v => v === true);
    await check('send streams a real reply, saved as shown', `const before = SillyTavern.getContext().chat.length; await t.type('冒烟测试'); t.label('发送').click(); await t.settle();
        const c = SillyTavern.getContext(), last = c.chat.at(-1);
        return { added: c.chat.length - before, fromModel: !last?.is_user, real: t.realReply(last?.mes, '冒烟测试'), last: String(last?.mes ?? '').slice(0, 60), saved: await t.saved() };`,
        v => v?.added === 2 && v.fromModel && v.real && v.saved?.same);
    await check('a new reply is generated and saved', `const before = SillyTavern.getContext().chat.at(-1).swipes?.length ?? 1; t.label('生成新回复')?.click(); await t.settle();
        const last = SillyTavern.getContext().chat.at(-1);
        return { more: (last.swipes?.length ?? 1) - before, real: t.realReply(last.mes, '冒烟测试'), saved: await t.saved() };`, v => v?.more === 1 && v.real && v.saved?.same);
    await check('the last message is deleted', `const c = SillyTavern.getContext(), n = c.chat.length; const menus = t.doc().querySelectorAll('[aria-label="消息操作"]'); menus[menus.length - 1].click(); await t.sleep(800);
        [...t.doc().querySelectorAll('button')].find(b => /^删除/.test(b.innerText.trim()))?.click(); await t.sleep(800);
        [...t.doc().querySelectorAll('.tl-sheet button')].find(b => /删除整条/.test(b.innerText))?.click(); await t.sleep(2500);
        return { removed: n - c.chat.length, saved: await t.saved() };`, v => v?.removed === 1 && v.saved?.same);
    // While the shell is hidden the story goes on in TT's page; coming back shows it as it is then.
    await check('a reply that ends while the shell is hidden: back to 发送, not 停止', `await t.type('【慢】隐藏时写完'); t.label('发送').click();
        const started = !!(await t.wait(() => t.label('停止'), 8000)); window.TavernLiteTt.hide(); await t.idle(); await t.sleep(2500);
        window.TavernLiteTt.show(); await t.sleep(1200); await t.type('下一句');
        const last = SillyTavern.getContext().chat.at(-1);
        return { started, stop: !!t.label('停止'), send: !!t.label('发送'), generating: window.TavernLiteBridge.isGenerating(),
            real: t.realReply(last?.mes, '【慢】隐藏时写完'), saved: await t.saved() };`,
        v => v?.started && !v.stop && v.send && !v.generating && v.real && v.saved?.same);
    await check('a reply that starts in TT while the shell is hidden shows 停止 when back', `await t.type(''); window.TavernLiteTt.hide(); await t.sleep(500);
        const area = document.getElementById('send_textarea'); area.value = '【慢】原版里发'; area.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('send_but').click(); await t.wait(() => window.TavernLiteBridge.isGenerating(), 8000); await t.sleep(800);
        window.TavernLiteTt.show(); await t.sleep(1200); const stop = !!t.label('停止'); await t.idle(); await t.sleep(2500);
        return { stop, after: !!t.label('停止') };`, v => v?.stop === true && v.after === false);
    await check('a story switched in TT while the shell is hidden: the shell follows it', `const c = SillyTavern.getContext(), here = c.getCurrentChatId();
        const list = await (await fetch('/api/characters/chats', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ avatar_url: c.characters[c.characterId].avatar }) })).json();
        const other = Object.values(list).map(x => String(x.file_name).replace(/\.jsonl$/, '')).find(n => n !== here);
        window.TavernLiteTt.hide(); await t.sleep(300); await c.openCharacterChat(other); await t.sleep(2000);
        window.TavernLiteTt.show(); await t.sleep(2500);
        return { other, file: new URLSearchParams(t.win().location.hash.slice(1)).get('file'), native: SillyTavern.getContext().getCurrentChatId() };`,
        v => v?.other && v.file === v.other && v.native === v.other);
}

await check('floating layers that overlap take touches over all of them', `const c = SillyTavern.getContext(), avatar = c.characters[c.characterId]?.avatar ?? c.characters[0].avatar;
    await t.go('#' + new URLSearchParams({ chat: avatar, file: c.getCurrentChatId() ?? '' }), 4000);
    t.floats([[20, 100, 100, 100], [70, 150, 100, 100]]); await t.wait(() => /evenodd/.test(t.frame().style.clipPath), 5000); await t.sleep(400);
    return { one: t.at(40, 120), both: t.at(95, 175), other: t.at(150, 240), away: t.at(300, 500) };`,
    v => v?.one === 'float' && v.both === 'float' && v.other === 'float' && v.away === 'shell');
await check('a layer removed while the shell is hidden leaves no hole when back', `window.TavernLiteTt.hide(); await t.sleep(400); t.unfloat(); await t.sleep(1200);
    window.TavernLiteTt.show(); await t.sleep(1000); return { clip: t.frame().style.clipPath, at: t.at(95, 175) };`, v => v?.clip === '' && v.at === 'shell');
await check('TT’s page shown: the shell is cut down to its return tab', `const c = SillyTavern.getContext(), avatar = c.characters[c.characterId]?.avatar ?? c.characters[0].avatar;
    await t.go('#' + new URLSearchParams({ chat: avatar, file: c.getCurrentChatId() ?? '' }), 4000);
    t.label('更多').click(); await t.sleep(800);
    [...t.doc().querySelectorAll('.tl-sheet button, .tl-sheet a')].find(b => b.innerText.trim().startsWith('打开原版界面'))?.click();
    const handle = await t.wait(() => t.doc().querySelector('.tl-return'), 5000); await t.sleep(500);
    const r = handle?.getBoundingClientRect();
    return r ? { clip: t.frame().style.clipPath, away: document.elementFromPoint(innerWidth / 2, innerHeight / 2) === t.frame(),
        tab: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === t.frame() } : null;`, v => v && /^path\(/.test(v.clip) && !v.away && v.tab);
await check('return tab brings the shell back', `t.doc().querySelector('.tl-return').click(); await t.sleep(800); return { clip: t.frame().style.clipPath, tab: !!t.doc().querySelector('.tl-return') };`,
    v => v?.clip === '' && !v.tab);
await check('back button: pages first, then leaving the shell; TT keeps the press', `await t.go('#me', 1500);
    const first = window.__TAURITAVERN_HANDLE_BACK__(); await t.sleep(1200); const afterFirst = { hidden: t.frame().hidden, hash: t.win().location.hash };
    let presses = 0; while (t.win().location.hash && t.win().location.hash !== '#' && presses < 12) { window.__TAURITAVERN_HANDLE_BACK__(); presses++; await t.sleep(900); }
    const last = window.__TAURITAVERN_HANDLE_BACK__(); await t.sleep(600);
    return { first, afterFirst, presses, last, hidden: t.frame().hidden };`, v => v?.first === true && !v.afterFirst.hidden && v.presses < 12 && v.last === true && v.hidden === true);
await check('menu opens the shell again as it was', `document.getElementById('tavern-lite-open').click(); await t.sleep(800); return !t.frame().hidden && !!t.doc().querySelector('.tl-app');`, v => v === true);

await check('shell hidden while its page reloads leaves TT’s input to type in', `t.win().location.reload(); window.TavernLiteTt.hide();
    await t.sleep(12000); const area = document.getElementById('send_textarea'); area.focus(); await t.sleep(400);
    const focused = document.activeElement === area; area.blur(); window.TavernLiteTt.show(); await t.sleep(600);
    return { focused, shown: !t.frame().hidden };`, v => v?.focused && v.shown);
await check('after an install or update the shell reloads TT’s page and opens again', `sessionStorage.setItem('tavern-lite:tt-reopen', '1'); location.reload(); return 1;`, v => v === 1);
await new Promise(resolve => setTimeout(resolve, 15000));
await evaluate(HELPERS);
await check('… the shell is open again after TT’s page reloaded', `return !!(await t.wait(() => t.frame() && !t.frame().hidden && t.doc()?.querySelector('.tl-app'), 40000)) && !sessionStorage.getItem('tavern-lite:tt-reopen');`, v => v === true);

closing = true;
ws.close();
process.exit(summary() ? 1 : 0);
