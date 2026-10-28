import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createEpisodeNative } from '../bridge-episodes.js';
import { EPISODE_NAMESPACE as NS, serializeChat, fingerprintChat, buildEpisodeFile, cloneJson } from '../src/episode-model.js';
import { validateOperationCapture, applyOperationTransition } from '../src/episode-journal.js';
import { applyPatch, hashLines } from '../server-chat-save/chat-diff.mjs';

// HTTP and journal fixtures; native server and browser IDB coverage are separate integration tests.
async function fixture(options = {}) {
    const rootId = randomUUID(), operationId = randomUUID(), account = 'alice';
    const source = { locator: { account, avatar: 'a.png', file: 'root' }, header: { user_name: 'unused', chat_metadata: options.legacy ? {} : { integrity: rootId } }, messages: [{ mes: 'first', extra: { memory: 'source' } }, { mes: 'last' }] };
    if (options.long) source.messages.push(...Array.from({ length: 60 }, (_, i) => ({ mes: `长篇正文 ${i} `.repeat(1000) })));
    source.fingerprint = await fingerprintChat(source);
    const creationOperationId = options.continue ? randomUUID() : operationId;
    const ids = { rootId, parentId: rootId, episodeId: randomUUID(), operationId: creationOperationId, integrity: randomUUID(), file: `child-${randomUUID()}` };
    const initialFile = buildEpisodeFile({ source, ids, intent: { kind: 'side', title: 'Side', contextMode: 'continued', createdAt: '2026-10-13T00:00:00Z', sourceIdentityKind: options.legacy ? 'legacy-anchor' : 'native-integrity' },
        policy: { verified: true, configurationId: 'unit-http', contextModes: ['continued'], continuedMetadataKeys: [] } });
    let operation = { ...validateOperationCapture({ account, operationId, action: options.continue ? 'continue' : 'create', contextMode: 'continued', capturedText: 'author request', draftRevision: 1, cancelId: randomUUID(), sourceFingerprint: source.fingerprint.hash,
        source: { locator: source.locator }, target: { ...ids, creationOperationId, locator: initialFile.locator } }), stage: 'captured', revision: 1 };
    const files = new Map([['alice:root', serializeChat(source)]]), calls = [], lease = { account, epoch: 1 };
    if (options.continue) files.set(`alice:${ids.file}`, serializeChat(initialFile));
    let actualAccount = account, active = true, writes = 0, sourceChecks = 0;
    const journal = { async readOperation(a, op) { return a === account && op === operationId ? cloneJson(operation) : null; },
        async transition(input) {
            if (options.journalFailStage === input.patch.stage) throw Object.assign(new Error('injected journal failure'), { code: 'JOURNAL_UNAVAILABLE' });
            operation = applyOperationTransition(operation, input, 123); return cloneJson(operation);
        } };
    const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const fetchImpl = async (path, init) => {
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ path, method: init.method, body: cloneJson(body ?? null), account: actualAccount });
        assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'same-origin');
        if (path === '/api/users/me') return response({ handle: actualAccount });
        if (path === '/api/characters/chats') {
            const names = [...files.keys()].filter(k => k.startsWith(actualAccount + ':')).map(k => k.slice(actualAccount.length + 1));
            if (body.simple) return response(names.map(file => ({ file_name: file + '.jsonl' })));
            return response(names.filter(file => file !== options.omitMetadataFile).map(file => ({ file_name: file + '.jsonl', chat_metadata: files.get(`${actualAccount}:${file}`)[0].chat_metadata })));
        }
        if (path === '/api/chats/get') {
            const value = cloneJson(files.get(`${actualAccount}:${body.file_name}`) ?? []);
            if (options.staleRead && writes && body.file_name === ids.file && value.length > 1) value[1].mes = 'stale middle message';
            return response(value);
        }
        if (path === '/api/plugins/tavern-lite-save/copy') {
            if (!options.copyPlugin) return response({ error: 'not found' }, 404);
            assert.equal(body.from_file, 'root'); assert.equal(body.file_name, ids.file);
            if (files.has(`${actualAccount}:${body.file_name}`)) return response({ error: 'exists' }, 409);
            const lines = files.get(`${actualAccount}:${body.from_file}`).map(entry => JSON.stringify(entry));
            if (options.copyPlugin === 'other-base' || hashLines(lines) !== body.base) return response({ error: 'base' }, 409);
            writes++;
            files.set(`${actualAccount}:${body.file_name}`, applyPatch(lines, body).map(line => JSON.parse(line)));
            return response({ ok: true, hash: 'x' });
        }
        if (path === '/api/chats/save') {
            writes++;
            assert.equal(body.force, false); assert.equal(body.file_name, ids.file, 'helper must never write a parent');
            if (options.httpFailure) return response({ error: 'injected' }, 500);
            if (options.accountSwitchOnSave) actualAccount = 'bob';
            files.set(`${actualAccount}:${body.file_name}`, cloneJson(body.chat));
            if (options.lostResponse) throw new TypeError('injected response loss after persistence');
            return response({ ok: true });
        }
        throw new Error(`unexpected endpoint ${path}`);
    };
    const helper = createEpisodeNative({ fetchImpl, getRequestHeaders: async () => {
        await options.beforeHeaders?.(operation.stage);
        return { 'Content-Type': 'application/json', 'X-CSRF-Token': 'unit' };
    }, journal,
        assertLease(l) { if (!active || l !== lease) throw Object.assign(new Error('old bridge'), { code: 'ENGINE_REPLACED' }); },
        assertQueueOwner(l) { assert.equal(l, lease); },
        async assertSourceCurrent() { sourceChecks++; if (options.sourceCheckFalse) return false; }, now: () => 123 });
    return { helper, lease, files, calls, source, initialFile, ids, operationId, account,
        operation: () => cloneJson(operation), writes: () => writes, sourceChecks: () => sourceChecks,
        setAccount(value) { actualAccount = value; }, invalidate() { active = false; },
        create: () => helper.createOrRecoverTarget({ account, operationId, initialFile, assertIntentCurrent: options.assertIntentCurrent }, lease),
        recover: () => helper.recoverTarget({ account, operationId }, lease) };
}

test('HTTP helper creates one complete file with owner and operation, confirms content, never touches parent', async () => {
    const f = await fixture(), before = cloneJson(f.files.get('alice:root'));
    const result = await f.create();
    assert.equal(result.kind, 'created'); assert.equal(result.operation.stage, 'created'); assert.equal(f.writes(), 1);
    assert.equal(result.confirmation.expectedFingerprint, result.fingerprint.hash);
    assert.equal(result.file.header.chat_metadata[NS].ownerAccount, 'alice');
    assert.deepEqual(f.files.get('alice:root'), before); assert.equal(f.sourceChecks(), 2);
    const again = await f.create(); assert.equal(again.kind, 'recovered'); assert.equal(f.writes(), 1);
});

test('lost create response becomes unknown, then recovers without another POST or overwriting later story', async () => {
    const f = await fixture({ lostResponse: true });
    assert.equal((await f.create()).kind, 'unconfirmed'); assert.equal(f.operation().stage, 'create-unconfirmed');
    f.files.get(`alice:${f.ids.file}`).push({ mes: 'later user story' });
    const recovered = await f.create();
    assert.equal(recovered.kind, 'recovered'); assert.equal(recovered.creationEvidence.initialContent, 'advanced-or-different');
    assert.equal(recovered.confirmation, null); assert.equal(f.writes(), 1); assert.equal(recovered.file.messages.at(-1).mes, 'later user story');
});

test('HTTP failure without a found file remains unknown and cannot retry create', async () => {
    const f = await fixture({ httpFailure: true });
    assert.equal((await f.create()).kind, 'unconfirmed');
    const retry = await f.create(); assert.equal(retry.kind, 'unconfirmed'); assert.equal(retry.reason, 'not-found'); assert.equal(f.writes(), 1);
});

test('old full readback is not initial confirmation even when identity and message count match', async () => {
    const f = await fixture({ staleRead: true });
    const result = await f.create(); assert.equal(result.kind, 'unconfirmed'); assert.equal(f.operation().stage, 'create-unconfirmed');
    assert.equal(f.writes(), 1);
});

test('journal failure before arming prevents POST; failure after POST leaves armed recovery evidence', async () => {
    const before = await fixture({ journalFailStage: 'create-armed' });
    await assert.rejects(before.create(), { code: 'JOURNAL_UNAVAILABLE' }); assert.equal(before.writes(), 0);
    const after = await fixture({ lostResponse: true, journalFailStage: 'create-unconfirmed' });
    const result = await after.create(); assert.equal(result.kind, 'unconfirmed'); assert.equal(result.journalError.code, 'JOURNAL_UNAVAILABLE');
    assert.equal(after.operation().stage, 'create-armed'); assert.equal((await after.create()).kind, 'recovered'); assert.equal(after.writes(), 1);
});

test('pre-submit source revalidation failure prevents creating any child', async () => {
    const f = await fixture({ sourceCheckFalse: true });
    await assert.rejects(f.create(), { code: 'SOURCE_CHANGED' }); assert.equal(f.writes(), 0);
    const changed = await fixture(); changed.files.get('alice:root')[1].mes = 'edited elsewhere';
    await assert.rejects(changed.create(), { code: 'SOURCE_CHANGED' }); assert.equal(changed.writes(), 0);
});

test('draft changes while request headers await stop the only create POST at its last synchronous boundary', async () => {
    let draftCurrent = true;
    const f = await fixture({ beforeHeaders: stage => { if (stage === 'create-armed') draftCurrent = false; }, assertIntentCurrent: () => draftCurrent });
    const result = await f.create();
    assert.equal(result.kind, 'unconfirmed'); assert.equal(result.reason, 'DRAFT_CHANGED'); assert.equal(f.writes(), 0);
    assert.equal(f.operation().stage, 'create-unconfirmed');
    draftCurrent = true;
    assert.equal((await f.create()).kind, 'unconfirmed'); assert.equal(f.writes(), 0);
});

test('post-submit account switch is unknown, embeds original owner, never cleans foreign account', async () => {
    const f = await fixture({ accountSwitchOnSave: true });
    const result = await f.create(); assert.equal(result.kind, 'unconfirmed'); assert.equal(result.reason, 'ACCOUNT_CHANGED');
    assert.equal(f.files.get(`bob:${f.ids.file}`)[0].chat_metadata[NS].ownerAccount, 'alice');
    assert.equal(f.files.has(`alice:${f.ids.file}`), false);
    assert.ok(!f.calls.some(c => /delete|rename/.test(c.path)));
    await assert.rejects(f.recover(), { code: 'ACCOUNT_CHANGED' }); assert.equal(f.writes(), 1);
});

test('late lease invalidation prevents publishing reads or starting writes', async () => {
    const f = await fixture(); f.invalidate();
    await assert.rejects(f.create(), { code: 'ENGINE_REPLACED' }); assert.equal(f.writes(), 0);
});

test('metadata omission is precisely read back; missing/unreadable roster members block completeness', async () => {
    const f = await fixture({ omitMetadataFile: 'root' });
    const list = await f.helper.listChatHeaders(f.source.locator, f.lease);
    assert.equal(list.complete, true); assert.equal(list.usedHeaderFallback, true); assert.equal(list.entries[0].fullFile.messages.length, 2);
    f.files.set('alice:root', []);
    await assert.rejects(f.helper.listChatHeaders(f.source.locator, f.lease), { code: 'LIST_UNCONFIRMED' });
});

test('recovery follows rename by exact owned IDs and reports imported identity or native-integrity duplicates', async () => {
    const f = await fixture(); await f.create();
    const data = f.files.get(`alice:${f.ids.file}`); f.files.delete(`alice:${f.ids.file}`); f.files.set('alice:renamed', data);
    assert.equal((await f.recover()).locator.file, 'renamed');
    f.files.set('alice:imported', cloneJson(data)); assert.equal((await f.recover()).kind, 'ambiguous');
    const other = f.files.get('alice:imported')[0].chat_metadata[NS]; other.episodeId = randomUUID(); other.creationOperationId = randomUUID();
    assert.equal((await f.recover()).kind, 'ambiguous'); assert.equal(f.writes(), 1);
});

test('legacy root resolution and creation have zero parent writes; owner mismatch prevents association', async () => {
    const f = await fixture({ legacy: true }), rootBefore = cloneJson(f.files.get('alice:root'));
    const resolved = await f.helper.resolveRoot({ source: f.source, newRootId: f.ids.rootId }, f.lease);
    assert.equal(resolved.kind, 'resolved'); assert.equal(resolved.sourceIdentityKind, 'legacy-anchor'); assert.equal(f.writes(), 0);
    await f.create(); assert.deepEqual(f.files.get('alice:root'), rootBefore);
    f.files.get(`alice:${f.ids.file}`)[0].chat_metadata[NS].ownerAccount = 'bob';
    assert.equal((await f.recover()).kind, 'ambiguous');
    const confirmation = await f.helper.confirmTarget({ account: 'alice', operationId: f.operationId, expectedFingerprint: 'a'.repeat(64) }, f.lease);
    assert.equal(confirmation.kind, 'conflict'); assert.equal(confirmation.reason, 'foreign-owner');
});

test('confirmTarget is read-only and does not advance the journal to confirmed', async () => {
    const f = await fixture(), created = await f.create(), revision = f.operation().revision;
    const checked = await f.helper.confirmTarget({ account: f.account, operationId: f.operationId, expectedFingerprint: created.fingerprint.hash }, f.lease);
    assert.equal(checked.kind, 'confirmed'); assert.equal(f.operation().stage, 'created'); assert.equal(f.operation().revision, revision); assert.equal(f.writes(), 1);
});

test('continuing an existing child only reads its original creation identity and never POSTs create', async () => {
    const f = await fixture({ continue: true }), before = cloneJson(f.files.get(`alice:${f.ids.file}`));
    const result = await f.create(); assert.equal(result.kind, 'recovered'); assert.equal(f.writes(), 0);
    assert.equal(result.creationEvidence.creationOperationId, f.ids.operationId);
    assert.notEqual(result.creationEvidence.creationOperationId, f.operationId);
    const checked = await f.helper.confirmTarget({ account: f.account, operationId: f.operationId, expectedFingerprint: result.fingerprint.hash }, f.lease);
    assert.equal(checked.kind, 'confirmed'); assert.equal(checked.confirmation.creationOperationId, f.ids.operationId);
    assert.deepEqual(f.files.get(`alice:${f.ids.file}`), before);
});

test('a long new line is copied by the server plugin from the story it came from, and saved whole without it', async () => {
    for (const plugin of ['ok', undefined, 'other-base']) {
        const f = await fixture({ long: true, copyPlugin: plugin }), result = await f.create();
        assert.equal(result.kind, 'created', String(plugin));
        const copy = f.calls.find(c => c.path === '/api/plugins/tavern-lite-save/copy'), whole = f.calls.find(c => c.path === '/api/chats/save');
        assert.ok(copy, 'tries the plugin first');
        if (plugin === 'ok') { assert.equal(whole, undefined); assert.ok(JSON.stringify(copy.body).length < 20000, 'sends only what differs'); }
        else assert.ok(whole, 'falls back to the whole file');
        assert.equal(f.writes(), 1);
        assert.deepEqual(f.files.get(`alice:${f.ids.file}`), serializeChat(f.initialFile));
    }
});

test('a short new line is saved whole, without asking the plugin', async () => {
    const f = await fixture({ copyPlugin: 'ok' }); await f.create();
    assert.equal(f.calls.some(c => c.path === '/api/plugins/tavern-lite-save/copy'), false);
});
