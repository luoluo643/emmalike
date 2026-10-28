import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EPISODE_NAMESPACE as NS, sha256, canonicalJson, canonicalChat, fingerprintChat, normalizeLocator, locatorKey,
    parseFullChat, serializeChat, validateEpisodeMeta, buildEpisodeFile, hiddenStoryMessage, unreviewedMetadataKeys, findCreation, resolveEpisodeGraph, resolveSourceIdentity, matchLegacySource } from '../src/episode-model.js';

const id = () => randomUUID(), hash = value => createHash('sha256').update(value).digest('hex');
function fixture() {
    const root = id(), episodeId = id(), operationId = id();
    const meta = { schemaVersion: 1, ownerAccount: 'alice', episodeId, rootId: root, parentId: root, kind: 'side', title: 'A', contextMode: 'continued', createdAt: '2026-10-13T00:00:00Z', creationOperationId: operationId };
    const locator = { account: 'alice', avatar: 'a.png', file: 'root' };
    const source = { locator, header: { user_name: 'unused', custom_header: { retained: true }, chat_metadata: { integrity: root, variables: { secret: 'parent' }, note_prompt: 'parent note' } },
        messages: [{ mes: 'first', extra: { memory: 'summary' } }, { mes: 'middle', swipes: ['middle', 'other'], swipe_info: [{ extra: { local: 1 } }], swipe_id: 0 }, { mes: 'last' }] };
    const ids = { episodeId, operationId, integrity: id(), rootId: root, parentId: root, file: `child-${id()}` };
    const policy = { verified: true, configurationId: 'pure-st-1.19.0', contextModes: ['continued', 'fresh'], continuedMetadataKeys: ['variables', 'note_prompt'] };
    const intent = { contextMode: 'continued', kind: 'side', title: 'A', createdAt: meta.createdAt, sourceIdentityKind: 'native-integrity' };
    const operation = { operationId, contextMode: 'continued', target: { episodeId, rootId: root, parentId: root, locator: { ...locator, file: ids.file } } };
    return { root, meta, locator, source, ids, policy, intent, operation };
}

test('portable SHA-256 agrees with independent vectors, padding boundaries and Unicode', () => {
    for (const value of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), 'a'.repeat(1000000), '番外🌙\ud800']) assert.equal(sha256(value), hash(value));
    assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('full fingerprint covers middle edits, alternatives, metadata and unknown header fields', async () => {
    const { source } = fixture(), original = await fingerprintChat(source);
    for (const mutate of [x => x.messages[1].mes = 'edited', x => x.messages[1].swipes[1] = 'changed', x => x.messages[1].swipe_info[0].extra.local++, x => x.header.chat_metadata.variables.secret = 'changed', x => x.header.custom_header.retained = false]) {
        const changed = structuredClone(source); mutate(changed);
        assert.notEqual((await fingerprintChat(changed)).hash, original.hash);
        assert.equal(changed.messages.length, source.messages.length); assert.equal(changed.messages.at(-1).mes, source.messages.at(-1).mes);
    }
    assert.equal(original.hash, hash(canonicalChat(source)));
    assert.equal(canonicalJson({ z: 1, a: { b: 2, a: 1 } }), canonicalJson({ a: { a: 1, b: 2 }, z: 1 }));
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
    assert.equal(canonicalJson({ omitted: undefined, list: [undefined, NaN] }), '{"list":[null,null]}');
});

test('locator keys isolate accounts and delimiters and reject groups/traversal', () => {
    assert.equal(normalizeLocator({ account: 'a', avatar: 'b.png', file: 'c.jsonl' }).file, 'c');
    assert.notEqual(locatorKey({ account: 'a:b', avatar: 'c', file: 'd' }), locatorKey({ account: 'a', avatar: 'b:c', file: 'd' }));
    for (const patch of [{ account: '' }, { file: '../bad' }, { avatar: 'a/b.png' }, { groupId: 'group' }]) assert.throws(() => normalizeLocator({ account: 'a', avatar: 'b', file: 'c', ...patch }), { code: 'INVALID_LOCATOR' });
});

test('full native reads preserve header and do not turn missing/unreadable into a guaranteed absence', () => {
    const { source, locator } = fixture();
    const parsed = parseFullChat(serializeChat(source), locator);
    assert.equal(parsed.kind, 'present'); assert.deepEqual(parsed.file, source);
    assert.equal(parseFullChat([], locator).kind, 'missing-or-unreadable');
    assert.equal(parseFullChat({}, locator).kind, 'missing-or-unreadable');
    assert.equal(parseFullChat([{ mes: 'not-header' }], locator).kind, 'invalid');
    const legacy = [{ user_name: 'unused', character_name: 'unused', unknown: 1 }, { mes: 'legacy' }];
    assert.deepEqual(serializeChat(parseFullChat(legacy, locator).file), legacy);
});

test('continued copies confirmed local state once with fresh identities and no source mutation', async () => {
    const f = fixture(); f.source.fingerprint = await fingerprintChat(f.source);
    const before = structuredClone(f.source), child = buildEpisodeFile(f);
    assert.deepEqual(f.source, before); assert.deepEqual(child.messages, f.source.messages);
    assert.deepEqual(child.header.chat_metadata.variables, { secret: 'parent' });
    assert.equal(child.header.chat_metadata[NS].creationOperationId, f.ids.operationId);
    assert.notEqual(child.header.chat_metadata.integrity, f.source.header.chat_metadata.integrity);
    child.messages[0].mes = 'child'; child.header.chat_metadata.variables.secret = 'child';
    assert.deepEqual(f.source, before);
});

test('fresh file has only identity header, never parent messages or derived state', async () => {
    const f = fixture(); f.source.fingerprint = await fingerprintChat(f.source); f.intent.contextMode = 'fresh';
    const child = buildEpisodeFile(f);
    assert.deepEqual(child.messages, []);
    assert.deepEqual(Object.keys(child.header.chat_metadata).sort(), [NS, 'integrity'].sort());
    assert.equal(child.header.custom_header, undefined);
    assert.equal(child.header.chat_metadata[NS].sourceAnchor.sourceFingerprint, f.source.fingerprint.hash);
});

test('native physical chat hash is recomputed for the child instead of copying the parent cache', async () => {
    const f = fixture(); f.source.header.chat_metadata.chat_id_hash = 'cached-parent-physical-id';
    f.source.fingerprint = await fingerprintChat(f.source);
    const child = buildEpisodeFile(f);
    assert.equal(child.header.chat_metadata.chat_id_hash, undefined);
    assert.equal(f.source.header.chat_metadata.chat_id_hash, 'cached-parent-physical-id');
    assert.notEqual(child.locator.file, f.source.locator.file);
});

test('opening request is optional for old metadata and preserved verbatim only in the child header', async () => {
    const f = fixture(); f.source.fingerprint = await fingerprintChat(f.source);
    const before = canonicalChat(f.source); f.intent.openingRequest = '  原始请求\n保留所有条件和末尾空格  ';
    const child = buildEpisodeFile(f);
    assert.equal(child.header.chat_metadata[NS].openingRequest, f.intent.openingRequest);
    assert.equal(canonicalChat(f.source), before); assert.equal(validateEpisodeMeta(f.meta).kind, 'valid');
    for (const openingRequest of [null, 1, {}, '', '   ']) assert.equal(validateEpisodeMeta({ ...f.meta, openingRequest }).kind, 'invalid');
});

test('unverified configurations or unseen dynamic channels cannot silently copy state', async () => {
    const f = fixture(); f.source.fingerprint = await fingerprintChat(f.source);
    assert.throws(() => buildEpisodeFile({ ...f, policy: { ...f.policy, verified: false } }), { code: 'CONFIG_UNVERIFIED' });
    f.source.header.chat_metadata.plugin_memory = 'unknown';
    f.source.fingerprint = await fingerprintChat(f.source);
    assert.throws(() => buildEpisodeFile(f), { code: 'CHANNEL_UNVERIFIED' });
    assert.throws(() => buildEpisodeFile({ ...f, ids: { ...f.ids, file: 'root' } }), { code: 'INVALID_IDENTITY' });
});

test('creation recovery is scoped, survives rename and rejects duplicate or damaged identities', () => {
    const { meta, operation, locator } = fixture();
    const entry = { locator: { ...locator, file: 'renamed' }, metadata: { [NS]: meta } };
    const foreign = { ...entry, locator: { ...entry.locator, account: 'bob' } };
    assert.equal(findCreation([foreign], operation).kind, 'none');
    const found = findCreation([foreign, entry], operation);
    assert.equal(found.kind, 'unique'); assert.equal(found.candidate.locator.file, 'renamed');
    assert.equal(findCreation([entry, { ...entry, locator: { ...entry.locator, file: 'imported' } }], operation).kind, 'ambiguous');
    assert.equal(findCreation([{ ...entry, metadata: { [NS]: { ...meta, schemaVersion: 999 } } }], operation).kind, 'ambiguous');
    assert.equal(findCreation([entry], { ...operation, target: { ...operation.target, integrity: id() } }).kind, 'ambiguous');
});

test('graph resolves only scoped identities, keeps children readable after source deletion, and never guesses duplicates', () => {
    const { root, meta, locator } = fixture(), scope = { account: locator.account, avatar: locator.avatar };
    const parent = { locator, metadata: { integrity: root } }, child = { locator: { ...locator, file: 'child' }, metadata: { [NS]: meta, integrity: id() } };
    const graph = resolveEpisodeGraph([parent, child], scope);
    assert.equal(graph.nodes[0].relationship, 'resolved'); assert.equal(graph.roots[0].locator.file, 'root');
    assert.equal(resolveEpisodeGraph([child], scope).nodes[0].relationship, 'source-missing');
    const copy = { ...parent, locator: { ...locator, file: 'imported' } };
    assert.equal(resolveEpisodeGraph([parent, child, copy], scope).nodes[0].relationship, 'ambiguous');
    assert.equal(resolveEpisodeGraph([child], { ...scope, account: 'bob' }).nodes.length, 0);
    assert.equal(validateEpisodeMeta({ ...meta, parentId: meta.episodeId }).kind, 'invalid');
});

test('distinct episodes sharing native integrity are ambiguous even with case variations', () => {
    const { root, meta, locator } = fixture(), shared = id();
    const parent = { locator, metadata: { integrity: root.toUpperCase() } };
    const one = { locator: { ...locator, file: 'one' }, metadata: { integrity: shared, [NS]: meta } };
    const two = { locator: { ...locator, file: 'two' }, metadata: { integrity: shared.toUpperCase(), [NS]: { ...meta, episodeId: id(), creationOperationId: id() } } };
    const graph = resolveEpisodeGraph([parent, one, two], locator);
    assert.deepEqual(graph.nodes.map(x => x.relationship), ['ambiguous', 'ambiguous']);
    assert.ok(graph.ambiguousIds.includes(shared));
});

test('UUID identity matching is case-insensitive while full file fingerprints preserve original content', async () => {
    const { meta, operation, locator, source } = fixture();
    const upper = { ...meta };
    for (const key of ['episodeId', 'rootId', 'parentId', 'creationOperationId']) upper[key] = upper[key].toUpperCase();
    assert.equal(findCreation([{ locator, metadata: { [NS]: upper } }], operation).kind, 'unique');
    assert.deepEqual(validateEpisodeMeta(upper).value, meta);
    const changed = structuredClone(source); changed.header.chat_metadata.integrity = changed.header.chat_metadata.integrity.toUpperCase();
    assert.notEqual((await fingerprintChat(changed)).hash, (await fingerprintChat(source)).hash);
});

test('legacy roots live only in child anchors and exact locators, with no parent mutation or rename guessing', async () => {
    const f = fixture(); delete f.source.header.chat_metadata.integrity; f.source.fingerprint = await fingerprintChat(f.source);
    const before = structuredClone(f.source), parent = { locator: f.source.locator, metadata: f.source.header.chat_metadata, fullFile: f.source };
    const root = resolveSourceIdentity(f.source, [parent], { newRootId: f.ids.rootId });
    assert.equal(root.sourceIdentityKind, 'legacy-anchor'); f.intent.sourceIdentityKind = root.sourceIdentityKind;
    const child = buildEpisodeFile(f), meta = child.header.chat_metadata[NS], entry = { locator: child.locator, metadata: child.header.chat_metadata };
    assert.deepEqual(f.source, before); assert.equal(meta.sourceAnchor.sourceIntegrity, null);
    assert.equal(matchLegacySource(meta, f.source).kind, 'matched');
    assert.equal(resolveEpisodeGraph([parent, entry], f.source.locator).nodes[0].relationship, 'resolved');
    const renamed = { ...f.source, locator: { ...f.source.locator, file: 'new-name' } };
    assert.equal(matchLegacySource(meta, renamed).kind, 'source-missing');
    assert.equal(resolveEpisodeGraph([{ ...parent, locator: renamed.locator, fullFile: renamed }, entry], f.source.locator).nodes[0].relationship, 'source-missing');
    const progressed = structuredClone(f.source); progressed.messages.push({ mes: 'normal parent update' }); progressed.header.chat_metadata.integrity = id();
    progressed.fingerprint = await fingerprintChat(progressed);
    const listing = [{ locator: progressed.locator, metadata: progressed.header.chat_metadata }, entry];
    const noEvidence = resolveSourceIdentity(progressed, listing); assert.equal(noEvidence.rootId, meta.rootId); assert.equal(noEvidence.upgradeCandidate, undefined);
    const upgraded = resolveSourceIdentity(progressed, listing, { naturalSaveEvidence: { kind: 'native-natural-save', locator: progressed.locator, fingerprint: progressed.fingerprint.hash } });
    assert.equal(upgraded.upgradeCandidate.integrity, progressed.header.chat_metadata.integrity);
    progressed.messages[0].extra.memory = 'different middle state';
    assert.equal(matchLegacySource(meta, progressed).kind, 'source-changed');
});

test('a foreign owner namespace is anomalous and cannot provide a root or target identity', () => {
    const { meta, locator, operation, root } = fixture();
    const foreign = { ...meta, ownerAccount: 'bob' }, entry = { locator, metadata: { [NS]: foreign, integrity: root } };
    assert.equal(validateEpisodeMeta(foreign, 'alice').kind, 'foreign-owner');
    const graph = resolveEpisodeGraph([entry], locator);
    assert.equal(graph.nodes.length, 0); assert.equal(graph.roots.length, 0); assert.equal(graph.invalid[0].reason, 'owner-account');
    assert.equal(findCreation([entry], operation).kind, 'ambiguous');
});

test('continue operations find the existing creation identity without substituting their new send ID', () => {
    const { meta, operation, locator } = fixture();
    const continuing = { ...operation, operationId: id(), action: 'continue', target: { ...operation.target, creationOperationId: meta.creationOperationId } };
    const entry = { locator, metadata: { [NS]: meta } };
    assert.equal(findCreation([entry], continuing).kind, 'unique');
    assert.equal(findCreation([{ ...entry, metadata: { [NS]: { ...meta, creationOperationId: continuing.operationId } } }], continuing).kind, 'ambiguous');
});

test('a continued copy carries other extensions\' state only when allowed, and never a blocked key', async () => {
    const f = fixture();
    f.source.header.chat_metadata.plugin_memory = { kept: 1 };
    f.source.header.chat_metadata.quickReply = { setList: [] };
    f.source.fingerprint = await fingerprintChat(f.source);
    const carry = { ...f.policy, carryUnreviewedMetadata: true, blockedMetadataKeys: ['quickReply'] };
    assert.deepEqual(unreviewedMetadataKeys(f.source.header.chat_metadata, carry), ['plugin_memory']);
    assert.throws(() => buildEpisodeFile({ ...f, policy: carry }), { code: 'CHANNEL_UNVERIFIED' });
    delete f.source.header.chat_metadata.quickReply;
    f.source.fingerprint = await fingerprintChat(f.source);
    const built = buildEpisodeFile({ ...f, policy: carry });
    assert.deepEqual(built.header.chat_metadata.plugin_memory, { kept: 1 });
    assert.equal(built.header.chat_metadata.variables.secret, 'parent');
    assert.throws(() => buildEpisodeFile(f), { code: 'CHANNEL_UNVERIFIED' });
});

test('a split can show the messages hidden in the story, never the app\'s own system notes', async () => {
    const f = fixture();
    f.source.messages = [
        { mes: 'request', is_user: true, is_system: false },
        { mes: 'summarized', is_system: true, is_hidden: true },
        { mes: 'hidden by hand', is_user: true, is_system: true },
        { mes: 'comment', is_system: true, extra: { type: 'comment' } },
        { mes: 'small', is_system: true, extra: { isSmallSys: true } },
        { mes: 'reply', is_system: false },
    ];
    f.source.fingerprint = await fingerprintChat(f.source);
    const policy = { ...f.policy, contextModes: ['fresh'] };
    const intent = extracted => ({ ...f.intent, contextMode: 'fresh', extracted });
    const kept = buildEpisodeFile({ ...f, policy, intent: intent({ from: 0, to: 5 }) });
    assert.deepEqual(kept.messages.map(m => m.is_system), [false, true, true, true, true, false]);
    assert.equal(kept.header.chat_metadata[NS].extractedFrom.unhidden, undefined);
    const shown = buildEpisodeFile({ ...f, policy, intent: intent({ from: 1, to: 4, unhide: true }) });
    assert.deepEqual(shown.messages.map(m => [m.mes, m.is_system]), [['summarized', false], ['hidden by hand', false], ['comment', true], ['small', true]]);
    assert.equal(shown.messages[0].is_hidden, false);
    assert.equal('is_hidden' in shown.messages[1], false);
    assert.deepEqual(shown.header.chat_metadata[NS].extractedFrom, { from: 1, to: 4, count: 4, unhidden: 2 });
    assert.equal(f.source.messages[1].is_system, true, 'the story itself is unchanged');
    assert.equal(hiddenStoryMessage({ is_system: true }), true);
    assert.equal(hiddenStoryMessage({ is_system: true, extra: { type: 'narrator' } }), false);
    assert.equal(hiddenStoryMessage({ is_system: false }), false);
});

test('a 番外 apart from the story keeps its persona lock and Horae\'s marker, and its variables only when asked', async () => {
    const f = fixture();
    Object.assign(f.source.header.chat_metadata, { persona: 'me.png', horae_native_visibility_migration: 1, other_extension: { x: 1 } });
    f.source.fingerprint = await fingerprintChat(f.source); f.intent.contextMode = 'fresh';
    const plain = buildEpisodeFile(f).header.chat_metadata;
    assert.deepEqual(Object.keys(plain).sort(), [NS, 'horae_native_visibility_migration', 'integrity', 'persona'].sort());
    assert.equal(plain.persona, 'me.png');
    const withVariables = buildEpisodeFile({ ...f, intent: { ...f.intent, carryVariables: true } }).header.chat_metadata;
    assert.deepEqual(withVariables.variables, { secret: 'parent' });
    assert.notEqual(withVariables.variables, f.source.header.chat_metadata.variables);
    const split = buildEpisodeFile({ ...f, intent: { ...f.intent, extracted: { from: 0, to: 1 } } }).header.chat_metadata;
    assert.equal(split.persona, 'me.png'); assert.equal(split.variables, undefined);
    delete f.source.header.chat_metadata.persona; f.source.fingerprint = await fingerprintChat(f.source);
    assert.equal('persona' in buildEpisodeFile(f).header.chat_metadata, false);
});

test('the full app\'s branches and checkpoints of a 番外 or a story are copies, not duplicate identities', () => {
    const { root, meta, locator, operation } = fixture(), scope = { account: locator.account, avatar: locator.avatar };
    const parent = { locator, metadata: { integrity: root } };
    operation.target.integrity = id();
    const child = { locator: { ...locator, file: 'child' }, metadata: { [NS]: meta, integrity: operation.target.integrity } };
    // 1.19 mints a new integrity for the copy; 1.16 keeps it. Both name the file they were made from.
    const branch = { locator: { ...locator, file: 'child - Branch #1' }, metadata: { [NS]: meta, integrity: id(), main_chat: 'child' } };
    const checkpoint = { locator: { ...locator, file: 'Checkpoint #1' }, metadata: { [NS]: meta, integrity: child.metadata.integrity, main_chat: 'child' } };
    const ofCopy = { locator: { ...locator, file: 'child - Branch #1 - Branch #1' }, metadata: { [NS]: meta, integrity: id(), main_chat: 'child - Branch #1.jsonl' } };
    const storyCheckpoint = { locator: { ...locator, file: 'root checkpoint' }, metadata: { integrity: root, main_chat: 'root' } };
    const graph = resolveEpisodeGraph([parent, child, branch, checkpoint, ofCopy, storyCheckpoint], scope);
    assert.deepEqual(graph.ambiguousIds, []);
    assert.ok(graph.nodes.every(n => n.relationship === 'resolved' && n.rootLocator.file === 'root'));
    assert.equal(graph.nodes.find(n => n.locator.file === 'child').nativeCopyOf, undefined);
    assert.deepEqual(graph.nodes.filter(n => n.nativeCopyOf).map(n => n.nativeCopyOf.file), ['child', 'child', 'child']);
    // Renamed original: nothing names it any more, so the duplicate is not guessed.
    const renamed = { ...child, locator: { ...locator, file: 'renamed' } };
    assert.ok(resolveEpisodeGraph([parent, renamed, branch], scope).nodes.every(n => n.relationship === 'ambiguous'));
    // The story itself still gives new 番外 after a 1.16 checkpoint; the checkpoint does not.
    const source = { locator, header: { chat_metadata: { integrity: root } }, messages: [] };
    assert.equal(resolveSourceIdentity(source, [parent, storyCheckpoint, child], {}).kind, 'resolved');
    assert.equal(resolveSourceIdentity({ ...source, locator: storyCheckpoint.locator, header: { chat_metadata: storyCheckpoint.metadata } }, [parent, storyCheckpoint], {}).kind, 'ambiguous');
    // An unfinished creation still finds its own file after the new story was branched.
    const found = findCreation([parent, child, branch, checkpoint], operation);
    assert.equal(found.kind, 'unique'); assert.equal(found.candidate.locator.file, 'child');
});

test('fingerprints are the same with and without the browser digest', async () => {
    const { source } = fixture(), withDigest = await fingerprintChat(source);
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try { assert.deepEqual(await fingerprintChat(source), withDigest); }
    finally { Object.defineProperty(globalThis, 'crypto', saved); }
    assert.equal(withDigest.hash, hash(canonicalChat(source)));
});
