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

const pages = await (await fetch(`${devtools}/json/list`)).json();
const target = pages.find(p => p.type === 'page' && /tauri\.localhost\/?(#.*)?$/.test(p.url)) ?? pages.find(p => p.type === 'page');
if (!target) throw new Error('No TT page on that DevTools port');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const waiting = new Map();
ws.onmessage = event => {
    const message = JSON.parse(event.data);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
};
async function evaluate(expression) {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, timeout: 180000 } }));
    const message = await new Promise(resolve => waiting.set(id, resolve));
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
  async type(text) { const input = this.label('输入消息'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, text); input.dispatchEvent(new (this.win().Event)('input', { bubbles: true })); await this.sleep(200); },
}; 1`;

const results = [];
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
await check('world books are listed (no /api/worldinfo/list on TT)', `await t.go('#worlds', 5000); return !/没加载/.test(t.text()) && /世界书/.test(t.text());`, v => v === true);

if (generate) {
    const avatar = await evaluate(`SillyTavern.getContext().characters[0]?.avatar`);
    await check('a new story opens (TT answers a missing chat with an error)', `await t.go('#' + new URLSearchParams({ chat: ${JSON.stringify(avatar)}, file: '', new: '1' }), 5000);
        return !!t.label('输入消息') && !t.doc().querySelector('.tl-error');`, v => v === true);
    await check('send streams a reply', `const before = SillyTavern.getContext().chat.length; await t.type('冒烟测试'); t.label('发送').click(); await t.settle();
        const c = SillyTavern.getContext(); return { added: c.chat.length - before, last: c.chat.at(-1)?.mes ?? '' };`, v => v?.added === 2 && v.last.length > 0);
    await check('a new reply is generated', `const before = SillyTavern.getContext().chat.at(-1).swipes?.length ?? 1; t.label('生成新回复')?.click(); await t.settle();
        return (SillyTavern.getContext().chat.at(-1).swipes?.length ?? 1) - before;`, v => v === 1);
    await check('the last message is deleted', `const c = SillyTavern.getContext(), n = c.chat.length; const menus = t.doc().querySelectorAll('[aria-label="消息操作"]'); menus[menus.length - 1].click(); await t.sleep(800);
        [...t.doc().querySelectorAll('button')].find(b => /^删除/.test(b.innerText.trim()))?.click(); await t.sleep(800);
        [...t.doc().querySelectorAll('.tl-sheet button')].find(b => /删除整条/.test(b.innerText))?.click(); await t.sleep(2500); return n - c.chat.length;`, v => v === 1);
}

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
    while (t.win().location.hash && t.win().location.hash !== '#') { window.__TAURITAVERN_HANDLE_BACK__(); await t.sleep(900); }
    const last = window.__TAURITAVERN_HANDLE_BACK__(); await t.sleep(600);
    return { first, afterFirst, last, hidden: t.frame().hidden };`, v => v?.first === true && !v.afterFirst.hidden && v.last === true && v.hidden === true);
await check('menu opens the shell again as it was', `document.getElementById('tavern-lite-open').click(); await t.sleep(800); return !t.frame().hidden && !!t.doc().querySelector('.tl-app');`, v => v === true);

ws.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
