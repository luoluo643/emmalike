/** Real ST 1.19 native tryGenerate barrier acceptance. Headless, isolated 8032 only.
 * Usage: TEST_OUTPUT=/tmp/native-settle-proof node tests/e2e-native-settle.mjs
 * Each case has a new browser context and an exactly owned disposable character.
 * Mutation changes only that browser's observer.wait; product files and the
 * already-wrapped native pm.tryGenerate are never replaced.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { mkdir, writeFile, appendFile, readFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const BASE = 'http://127.0.0.1:8032', ACCOUNT = 'default-user';
assert.equal(process.argv[2] || BASE, BASE, 'Only the pure isolated ST instance is permitted');
const output = path.resolve(process.env.TEST_OUTPUT || '/tmp/tavern-native-settle-evidence');
await mkdir(output, { recursive: true });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
assert.ok([undefined, '0', '1'].includes(process.env.SETTLE_MUTATIONS));
const variants = process.env.SETTLE_MUTATIONS === '0' ? [false] : [false, true];
const inspectOwnedBytes = process.env.SETTLE_FILE_BYTES === '1';
if (inspectOwnedBytes) assert.equal(process.platform, 'linux', 'Byte proof only reads the verified isolated Linux bind mount');
const requested = new Set((process.env.SETTLE_CASES || 'prepare,switch,timed-world-info').split(','));
for (const name of requested) assert.ok(['prepare', 'switch', 'timed-world-info'].includes(name));
function payload(request) {
    const bytes = request.postDataBuffer();
    return bytes ? JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString('utf8')) : {};
}
async function stage(result, name, detail = {}) {
    const item = { at: Date.now(), case: result.name, name, ...detail };
    result.stages.push(item); console.log(JSON.stringify(item));
    await appendFile(path.join(output, 'stages.jsonl'), JSON.stringify(item) + '\n');
}
// Exactly the same assertion is applied to real and mutated cases. The mutant
// must violate an actual invariant, not merely return an error or miss a timeout.
function assertHeld(observation) {
    assert.equal(observation.gate.releasedAt, null, 'Native test gate must still be closed');
    assert.ok(observation.snapshot.inFlight >= 1, 'The real native tryGenerate must still be counted');
    assert.equal(observation.currentFile, observation.sourceFile, 'No source switch before native dry-run settles');
    assert.equal(observation.operations.prepare?.settledAt ?? null, null, 'No prepare completion before native dry-run settles');
    assert.equal(observation.operations.switch?.settledAt ?? null, null, 'No switch completion before native dry-run settles');
    assert.equal(observation.creates, 0, 'No child creation before native dry-run settles');
    assert.equal(observation.parentWrites, 0, 'The barrier must not write the parent chat');
    assert.equal(observation.worldWrites, 0, 'The barrier must not write world info');
}
const native = (page, fn, arg) => page.evaluate(([source, arg]) => {
    const w = document.querySelector('iframe.engine')?.contentWindow;
    if (!w?.TavernLiteBridge) throw new Error('Product bridge is unavailable');
    return new w.Function('w', 'arg', `return (${source})(w,arg)`)(w, arg);
}, [fn.toString(), arg]);
async function runCase(browser, mode, mutation) {
    const name = `${mode}-${mutation ? 'wait-removed' : 'real-barrier'}`;
    const run = `tl-settle-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const result = { name, mode, mutation, run, stages: [], saves: [], characterWrites: [], blocked: [], modelRequests: [], pageErrors: [], routeErrors: [], cleanup: false };
    results.push(result);
    let context, page, token, avatar, phase = 'setup', sourceFile = `${run}-root`, settingsBefore, initialChat;
    const rootFile = sourceFile, otherFile = `${run}-other`;
    const byteSample = async label => {
        if (!inspectOwnedBytes) return;
        // docker inspect verified the 8032 container's /home/node/app/data bind
        // source is this exact /tmp path. No directory enumeration or other
        // account/file read; every component and basename belongs to this run.
        const mount = '/tmp/tavern-improvements/tests/data';
        assert.equal(await realpath(mount), mount);
        assert.ok(avatar?.startsWith(run) && avatar.endsWith('.png') && !/[\\/]/.test(avatar));
        assert.equal(rootFile, `${run}-root`);
        const parts = [ACCOUNT, 'chats', avatar.replace(/\.png$/, ''), rootFile + '.jsonl'];
        let file = mount;
        for (const part of parts) {
            file = path.join(file, part);
            assert.equal((await lstat(file)).isSymbolicLink(), false);
            assert.equal(await realpath(file), file);
        }
        const bytes = await readFile(file);
        const sample = { label, at: Date.now(), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        (result.parentByteSamples ??= []).push(sample);
        if (result.parentByteSamples.length > 1) assert.deepEqual({ bytes: sample.bytes, sha256: sample.sha256 },
            { bytes: result.parentByteSamples[0].bytes, sha256: result.parentByteSamples[0].sha256 }, 'Owned parent JSONL bytes changed');
        await stage(result, 'exact-owned-parent-byte-hash', sample);
    };
    const ownFile = file => typeof file === 'string' && (file === rootFile || file === otherFile || /^tl-episode-[0-9a-f-]{36}$/.test(file));
    const post = async (endpoint, data) => {
        assert.ok(['/api/users/login', '/api/settings/get', '/api/characters/get', '/api/characters/delete', '/api/chats/get', '/api/chats/save'].includes(endpoint));
        if (data.avatar_url) assert.equal(data.avatar_url, avatar);
        if (data.file_name) assert.ok(ownFile(data.file_name));
        return context.request.post(BASE + endpoint, { data, headers: { 'X-CSRF-Token': token }, maxRedirects: 0 });
    };
    const read = async file => { const response = await post('/api/chats/get', { avatar_url: avatar, file_name: file }); assert.ok(response.ok()); return response.json(); };
    const input = () => ({ account: ACCOUNT, scope: { avatar, file: sourceFile }, text: 'Synthetic author request for barrier acceptance.', title: '屏障合成子线', kind: 'side', contextMode: 'continued', draftRevision: 1 });
    const baseline = async file => {
        // Fixture-only explicit save outside the measured interval. The barrier
        // itself never invokes this function or any native save API.
        await native(page, async (w, file) => {
            const st = await import('/script.js'), ext = await import('/scripts/extensions.js');
            if (w.SillyTavern.getContext().getCurrentChatId() !== file) throw new Error('Wrong fixture source');
            await w.TavernLiteNativeSettle.observer.wait();
            ext.cancelDebouncedMetadataSave(); st.cancelDebouncedChatSave();
            await st.saveChatConditional(); await w.TavernLiteNativeSettle.observer.wait();
        }, file);
        const memory = await native(page, w => {
            const c = w.SillyTavern.getContext();
            return [{ user_name: 'unused', character_name: 'unused', chat_metadata: JSON.parse(JSON.stringify(c.chatMetadata)) }, ...JSON.parse(JSON.stringify(c.chat))];
        });
        assert.equal(hash(await read(file)), hash(memory), 'Synthetic source must match its actual full disk state');
        return memory;
    };
    try {
        context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
        token = (await (await context.request.get(BASE + '/csrf-token')).json()).token;
        assert.ok((await post('/api/users/login', { handle: ACCOUNT, password: 'test1234' })).ok());
        assert.equal((await (await context.request.get(BASE + '/api/users/me')).json()).handle, ACCOUNT);
        { const v = (await (await context.request.get(BASE + '/version')).json()).pkgVersion; assert.equal(v, process.env.EXPECT_ST_VERSION ?? '1.19.0'); }
        const discovered = await (await context.request.get(BASE + '/api/extensions/discover')).json();
        const third = discovered.filter(item => ['local', 'global'].includes(item.type));
        assert.deepEqual(third.map(item => item.name), ['third-party/emmalike'], 'Pure isolated extension installation required');
        const health = await context.request.post(BASE + '/api/plugins/tavern-lite/health', { data: {}, headers: { 'X-CSRF-Token': token } });
        assert.equal(health.status(), 404, 'Only the pure test server is allowed');
        settingsBefore = hash((await (await post('/api/settings/get', {})).json()).settings);
        const created = await context.request.post(BASE + '/api/characters/create', {
            multipart: { ch_name: run, description: 'Synthetic cafe role for native barrier acceptance.', first_mes: 'Synthetic greeting.', personality: '', scenario: '', mes_example: '', creator_notes: run, system_prompt: '', post_history_instructions: '', talkativeness: '0.5', fav: 'false', tags: '' },
            headers: { 'X-CSRF-Token': token }, maxRedirects: 0,
        });
        assert.ok(created.ok()); avatar = (await created.text()).trim(); assert.ok(avatar.startsWith(run) && avatar.endsWith('.png'));
        const ownCharacter = await (await post('/api/characters/get', { avatar_url: avatar })).json();
        assert.equal(ownCharacter.name, run); initialChat = ownCharacter.chat;
        assert.ok(typeof initialChat === 'string' && initialChat.startsWith(run) && !/[\\/]/.test(initialChat));
        for (const file of [rootFile, otherFile]) {
            const chat = [{ user_name: 'unused', character_name: 'unused', chat_metadata: { integrity: randomUUID(), timedWorldInfo: { sticky: {}, cooldown: {} }, tainted: true, lastInContextMessageId: 0 } },
                { name: run, is_user: false, is_system: false, mes: `SYNTHETIC_${file}`, send_date: new Date().toISOString(), extra: {} }];
            assert.ok((await post('/api/chats/save', { avatar_url: avatar, file_name: file, chat, force: false })).ok());
        }
        await writeFile(path.join(output, `${name}-fixture.json`), JSON.stringify({ run, avatar, rootFile, otherFile, initialChat }, null, 2));
        const readPaths = new Set(['/api/plugins/tavern-lite-save/probe', '/api/extensions/version', '/api/ping', '/api/characters/all', '/api/characters/get', '/api/characters/chats', '/api/chats/get', '/api/chats/recent', '/api/groups/all', '/api/backgrounds/all', '/api/backgrounds/folders', '/api/image-metadata/all', '/api/avatars/get', '/api/worldinfo/get', '/api/worldinfo/all', '/api/secrets/read', '/api/secrets/find', '/api/extensions/discover', '/api/extensions/manifest', '/api/users/list', '/api/assets/get']);
        await context.route('**/*', async route => {
            try {
                const request = route.request(), url = new URL(request.url()), p = url.pathname;
                if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
                if (url.origin !== BASE) { result.blocked.push({ phase, path: url.origin + p, external: true }); return route.abort(); }
                if (p === '/api/settings/get') {
                    const response = await route.fetch(), data = await response.json(), settings = JSON.parse(data.settings);
                    settings.active_character = null; settings.active_group = null; settings.firstRun = false; settings.main_api = 'openai';
                    settings.oai_settings = { ...settings.oai_settings, chat_completion_source: 'custom', custom_url: 'http://settle-mock.invalid/v1', custom_model: 'settle-mock', stream_openai: false, openai_max_context: 32768, openai_max_tokens: 512 };
                    if (settings.extension_settings?.connectionManager) settings.extension_settings.connectionManager = { ...settings.extension_settings.connectionManager, profiles: [], selectedProfile: '' };
                    data.settings = JSON.stringify(settings); return route.fulfill({ response, json: data });
                }
                if (p === '/api/settings/save') return route.fulfill({ json: { result: 'ok' } });
                if (p === '/api/backends/chat-completions/status') return route.fulfill({ json: { data: [{ id: 'settle-mock' }] } });
                if (p === '/api/backends/chat-completions/generate') {
                    result.modelRequests.push({ phase, at: Date.now(), path: p });
                    return route.fulfill({ json: { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Synthetic unexpected model response.' } }] } });
                }
                if (p === '/api/tokenizers/openai/count') return route.fulfill({ json: { token_count: 32 } });
                if (p === '/api/tokenizers/openai/encode') return route.fulfill({ json: { ids: [1, 2], chunks: ['synthetic'], count: 2 } });
                // This native endpoint only lists local workflow filenames. An
                // empty browser fixture is sufficient; it never invokes Comfy.
                if (p === '/api/sd/comfy/workflows') return route.fulfill({ json: [] });
                if (/^\/api\/(backends|horde|novelai|openai|kobold|sd|embeddings|vectors)(\/|$)/.test(p) || /^\/api\/.*(?:generate|completion)/i.test(p)) {
                    if (/\/horde\/(text-models|text-workers|sd-models|sd-samplers)$/.test(p)) return route.fulfill({ json: [] });
                    result.blocked.push({ phase, path: p, model: true });
                    return route.fulfill({ status: 503, json: { error: 'No real model service in barrier test' } });
                }
                if (p === '/api/chats/save') {
                    const data = payload(request);
                    assert.equal(data.avatar_url, avatar);
                    assert.ok(ownFile(data.file_name) || phase === 'setup' && data.file_name === initialChat,
                        'Only named fixture files and this owned character exact initial chat during setup are allowed');
                    assert.notEqual(data.force, true);
                    const entry = { phase, at: Date.now(), file: data.file_name, hash: hash(data.chat) };
                    result.saves.push(entry); const response = await route.fetch(); entry.status = response.status();
                    return route.fulfill({ response });
                }
                if (p === '/api/characters/edit-attribute') {
                    const data = payload(request); assert.ok(data.avatar_url === avatar || data.avatar === avatar);
                    return route.continue();
                }
                if (p === '/api/characters/edit' && request.headers()['content-type']?.includes('multipart/form-data')) {
                    // Native select/open updates this exact disposable card's
                    // selected-chat pointer using FormData. Inspect identity and
                    // file only; do not retain the card body in test evidence.
                    const body = request.postData() || '';
                    const field = key => body.match(new RegExp(`name="${key}"\\r?\\n\\r?\\n([^\\r\\n]+)`))?.[1];
                    assert.equal(field('avatar_url'), avatar);
                    const file = field('chat');
                    assert.ok(ownFile(file) || phase === 'setup' && file === initialChat);
                    result.characterWrites.push({ phase, at: Date.now(), file });
                    return route.continue();
                }
                if (!p.startsWith('/api/') || ['GET', 'HEAD'].includes(request.method()) || readPaths.has(p) || p.startsWith('/api/tokenizers/')) return route.continue();
                result.blocked.push({ phase, at: Date.now(), path: p, expectedInitialization: p === '/api/quick-replies/save' });
                return route.fulfill({ status: 409, json: { error: 'Only exact owned fixture writes are allowed' } });
            } catch (error) {
                result.routeErrors.push({ phase, message: error.message });
                await route.abort().catch(() => {});
            }
        });
        page = await context.newPage(); page.setDefaultTimeout(30000);
        page.on('pageerror', error => result.pageErrors.push({ phase, message: error.message }));
        await page.goto(BASE + '/scripts/extensions/third-party/emmalike/app/#' + new URLSearchParams({ chat: avatar, file: rootFile }));
        await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
        result.bootstrap = await native(page, w => {
            const state = w.TavernLiteNativeSettle;
            return { schemaVersion: state?.schemaVersion, earlyVerified: state?.earlyVerified, errorCode: state?.errorCode,
                documentMatched: state?.document === w.document, phase: state?.phase, snapshot: state?.observer?.snapshot() };
        });
        assert.equal(result.bootstrap.earlyVerified, true); assert.equal(result.bootstrap.documentMatched, true);
        assert.equal(result.bootstrap.phase.hasChatId, false); assert.equal(result.bootstrap.phase.messageCount, 0);
        await stage(result, 'early-bootstrap-confirmed', result.bootstrap);
        await baseline(rootFile);
        result.policy = await native(page, w => w.TavernLiteBridge.episodeStatus());
        assert.ok(result.policy.verified && result.policy.enabled, JSON.stringify(result.policy));
        if (mode === 'switch') {
            const prepared = await native(page, (w, input) => w.TavernLiteBridge.prepareEpisode({ ...input, assertDraft: () => true }), input());
            assert.equal(prepared.operation.stage, 'awaiting-review'); sourceFile = prepared.target.file;
            await native(page, (w, scope) => w.TavernLiteBridge.openChat(scope.avatar, scope.file), { avatar, file: sourceFile });
            await baseline(sourceFile);
        }
        if (mode === 'timed-world-info') {
            // Owned synthetic fixture only: native WI's real constructor removes
            // invalid timed entries even on dry runs, after the async gate.
            await native(page, async w => {
                const c = w.SillyTavern.getContext(), st = await import('/script.js');
                c.chatMetadata.timedWorldInfo.sticky.TL_SETTLE_INVALID = null;
                await st.saveChatConditional();
            });
        }
        const parentBefore = hash(await read(rootFile)), sourceBefore = hash(await read(sourceFile));
        await byteSample('before-gate');
        const saveOffset = result.saves.length;
        phase = 'measured';
        const armed = await native(page, async (w, args) => {
            const st = await import('/script.js'), openai = await import('/scripts/openai.js');
            const observer = w.TavernLiteNativeSettle.observer, originalWait = observer.wait, originalWrapped = openai.promptManager.tryGenerate;
            const state = { gate: { enteredAt: null, releasedAt: null, exitedAt: null, arrivals: 0 }, operations: {},
                nativeStartedAt: w.Date.now(), nativeSettledAt: null, nativeError: null, sourceLeftAt: null, waitCalls: 0, waitCompletions: [] };
            let release;
            const gate = new Promise(resolve => { release = resolve; });
            const listener = async (_type, _options, dryRun) => {
                if (dryRun !== true || state.gate.releasedAt !== null) return;
                state.gate.arrivals++; state.gate.enteredAt ??= w.Date.now();
                await gate; state.gate.exitedAt = w.Date.now();
            };
            const changed = () => {
                if (w.SillyTavern.getContext().getCurrentChatId() !== args.sourceFile) state.sourceLeftAt ??= w.Date.now();
            };
            st.eventSource.on(st.event_types.GENERATION_AFTER_COMMANDS, listener);
            st.eventSource.on(st.event_types.CHAT_CHANGED, changed);
            // Observer API only. The native manager method remains byte-for-byte
            // the same function reference installed by the actual early bootstrap.
            observer.wait = args.mutation ? async function(options = {}) {
                state.waitCalls++; options.assertCurrent?.();
                const answer = { settled: true, mutation: 'test-only-no-wait', waitedMs: 0 };
                state.waitCompletions.push({ at: w.Date.now(), ...answer }); return answer;
            } : async function(...parameters) {
                state.waitCalls++; const answer = await Reflect.apply(originalWait, this, parameters);
                state.waitCompletions.push({ at: w.Date.now(), ...answer }); return answer;
            };
            w.__nativeSettleProof = {
                state, originalWrapped,
                release() { if (state.gate.releasedAt === null) { state.gate.releasedAt = w.Date.now(); release(); } },
                cleanup() { this.release(); observer.wait = originalWait;
                    st.eventSource.removeListener(st.event_types.GENERATION_AFTER_COMMANDS, listener);
                    st.eventSource.removeListener(st.event_types.CHAT_CHANGED, changed); },
            };
            const pending = openai.promptManager.tryGenerate();
            Promise.resolve(pending).then(() => { state.nativeSettledAt = w.Date.now(); state.nativeEndSnapshot = observer.snapshot();
                state.invalidTimedEntryRemains = Object.hasOwn(w.SillyTavern.getContext().chatMetadata.timedWorldInfo?.sticky || {}, 'TL_SETTLE_INVALID');
            }, error => { state.nativeError = { code: error?.code, message: String(error?.message || error) }; state.nativeSettledAt = w.Date.now(); });
            return { before: observer.snapshot(), managerMethodUnchanged: originalWrapped === openai.promptManager.tryGenerate };
        }, { mutation, sourceFile });
        assert.equal(armed.managerMethodUnchanged, true);
        await page.waitForFunction(() => document.querySelector('iframe.engine')?.contentWindow.__nativeSettleProof?.state.gate.enteredAt != null, null, { timeout: 15000 });
        await stage(result, 'real-native-gate-entered', armed);
        await native(page, (w, args) => {
            const proof = w.__nativeSettleProof, track = (name, promise) => {
                const op = proof.state.operations[name] = { startedAt: w.Date.now(), settledAt: null, status: 'pending' };
                Promise.resolve(promise).then(value => { Object.assign(op, { status: 'fulfilled', settledAt: w.Date.now(), stage: value?.operation?.stage, targetFile: value?.target?.file }); },
                    error => { Object.assign(op, { status: 'rejected', settledAt: w.Date.now(), code: error?.code, message: error?.message }); });
            };
            if (args.mode !== 'switch') track('prepare', w.TavernLiteBridge.prepareEpisode({ ...args.input, assertDraft: () => true }));
            // During prepare this enters the same product queue concurrently;
            // the switch-only case separately exercises the child leave guard.
            if (args.mode !== 'timed-world-info') track('switch', w.TavernLiteBridge.openChat(args.avatar, args.destination));
        }, { mode, input: input(), avatar, destination: mode === 'switch' ? rootFile : otherFile });
        const observe = async () => {
            const data = await native(page, (w, sourceFile) => ({ ...JSON.parse(JSON.stringify(w.__nativeSettleProof.state)), sourceFile,
                currentFile: w.SillyTavern.getContext().getCurrentChatId(), snapshot: w.TavernLiteNativeSettle.observer.snapshot() }), sourceFile);
            const writes = result.saves.slice(saveOffset);
            return { ...data, creates: writes.filter(item => item.file !== rootFile && item.file !== otherFile && item.file !== sourceFile).length,
                parentWrites: writes.filter(item => item.file === rootFile).length,
                worldWrites: result.blocked.filter(item => item.phase === 'measured' && /^\/api\/worldinfo\/(?!get$|all$)/.test(item.path)).length };
        };
        // Long enough to pass the 1100-ms quiet interval if the in-flight test is
        // absent. A mutant also waits for an observable completion (up to 8 s).
        await pause(1600);
        if (mutation) {
            const deadline = Date.now() + 8000;
            while (Date.now() < deadline) { const state = await observe();
                if (Object.values(state.operations).some(op => op.settledAt !== null) || state.creates > 0 || state.currentFile !== sourceFile) break;
                await pause(100);
            }
        }
        result.held = await observe();
        if (mutation) {
            let caught;
            try { assertHeld(result.held); } catch (error) { caught = { code: error.code, message: error.message, actual: error.actual, expected: error.expected }; }
            assert.ok(caught, 'Removing observer.wait must make the exact same safety assertion fail');
            assert.equal(caught.code, 'ERR_ASSERTION');
            assert.ok(Object.values(result.held.operations).some(op => op.status === 'fulfilled') || result.held.creates > 0 || result.held.currentFile !== sourceFile,
                'A mutation rejected by an unrelated guard is inconclusive, not a successful mutation proof');
            result.mutationCaught = caught;
        } else assertHeld(result.held);
        assert.equal(result.held.parentWrites, 0); assert.equal(result.held.worldWrites, 0);
        assert.ok(result.held.snapshot.inFlight > 0); assert.ok(result.held.waitCalls > 0);
        await stage(result, mutation ? 'same-assertion-caught-mutation' : 'held-invariants-pass', { held: result.held, mutationCaught: result.mutationCaught });
        await native(page, w => w.__nativeSettleProof.release());
        await stage(result, 'gate-released');
        await page.waitForFunction(() => {
            const state = document.querySelector('iframe.engine')?.contentWindow.__nativeSettleProof?.state;
            return state?.nativeSettledAt !== null && Object.keys(state?.operations || {}).length > 0 && Object.values(state.operations).every(op => op.settledAt !== null);
        }, null, { timeout: 45000 });
        result.after = await observe();
        await byteSample('after-barrier-operation');
        assert.equal(result.after.nativeError, null, 'The real native dry run must finish without a swallowed exception');
        assert.equal(await native(page, async w => (await import('/scripts/openai.js')).promptManager.tryGenerate === w.__nativeSettleProof.originalWrapped), true);
        if (!mutation) {
            const observedCompletion = result.after.nativeEndSnapshot.lastActivity;
            for (const op of Object.values(result.after.operations)) {
                assert.ok(op.settledAt >= observedCompletion + 1100,
                    `Operation must wait for real native completion plus 1100 ms quiet: ${JSON.stringify(op)}`);
            }
            if (mode === 'timed-world-info') {
                assert.equal(result.after.invalidTimedEntryRemains, false, 'Actual native WI constructor must clean the delayed invalid timed entry');
                assert.equal(result.after.operations.prepare.status, 'rejected');
                assert.equal(result.after.operations.prepare.code, 'SOURCE_UNCONFIRMED');
                assert.equal(result.after.creates, 0, 'Changed source must never produce a stale child');
                assert.equal(hash(await read(sourceFile)), sourceBefore, 'Readiness observation must not persist the native in-memory WI change');
            } else {
                if (mode === 'prepare') assert.equal(result.after.operations.prepare.stage, 'awaiting-review');
                assert.equal(result.after.operations.switch.status, 'fulfilled');
                assert.ok(result.after.sourceLeftAt >= observedCompletion + 1100);
            }
        }
        assert.equal(hash(await read(rootFile)), parentBefore, 'Parent full file remains unchanged by the measured operations');
        if (inspectOwnedBytes) {
            await native(page, w => w.TavernLiteNativeSettle.observer.wait());
            await pause(2500);
            await byteSample('settled-plus-2500ms');
            assert.equal(result.saves.slice(saveOffset).filter(item => item.file === rootFile).length, 0,
                'No deferred parent save may be hidden after the first operation check');
        }
        assert.equal(result.after.parentWrites, 0); assert.equal(result.after.worldWrites, 0);
        assert.equal(result.modelRequests.length, 0, 'Native dry runs must not submit any model request');
        assert.deepEqual(result.routeErrors, []); assert.deepEqual(result.pageErrors, []);
        const illegal = result.blocked.filter(item => !item.expectedInitialization);
        assert.deepEqual(illegal, [], 'No unexpected write or external/model attempt may be ignored');
        assert.equal(hash((await (await post('/api/settings/get', {})).json()).settings), settingsBefore);
        result.passed = true;
        await stage(result, 'complete', { after: result.after, mutationCaught: result.mutationCaught });
    } catch (error) {
        result.passed = false; result.error = { phase, message: error.message, stack: error.stack };
        await stage(result, 'failed', result.error);
        await page?.screenshot({ path: path.join(output, `${name}-failed.png`) }).catch(() => {});
    } finally {
        if (page) await native(page, w => w.__nativeSettleProof?.cleanup()).catch(() => {});
        await page?.close().catch(() => {});
        if (context && avatar?.startsWith(run)) {
            try {
                const character = await (await post('/api/characters/get', { avatar_url: avatar })).json(); assert.equal(character.name, run);
                assert.ok((await post('/api/characters/delete', { avatar_url: avatar, delete_chats: true })).ok());
                result.cleanup = (await post('/api/characters/get', { avatar_url: avatar })).status() === 404;
            } catch (error) { result.cleanupError = error.message; result.passed = false; }
        }
        await context?.close().catch(() => {});
        result.passed = result.passed === true && result.cleanup;
        await writeFile(path.join(output, `${name}.json`), JSON.stringify(result, null, 2));
    }
}
let browser;
try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    for (const mode of requested) for (const mutation of variants) await runCase(browser, mode, mutation);
} finally {
    await browser?.close().catch(() => {});
    const report = { passed: results.length === requested.size * variants.length && results.every(result => result.passed), byteHashEnabled: inspectOwnedBytes,
        cases: results.map(({ name, passed, cleanup, error, mutationCaught }) => ({ name, passed, cleanup, error, mutationCaught })),
        limits: ['Synthetic owned data on pure ST 1.19.0 only; no production or actual model request.',
            'The controlled event delays real native work; it does not claim to reproduce the historical intermittent readiness timeout.',
            'The timedWorldInfo case covers native dry-run metadata cleanup, not third-party asynchronous plugin isolation.',
            'Browser mutations are deliberately unsafe controls in disposable contexts; no product file is changed.'] };
    await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, ...report })); if (!report.passed) process.exitCode = 1;
}
