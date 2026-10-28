import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNativeEpisodePolicy as policy } from '../bridge-episode-policy.js';

const base = () => ({ extensionSettings: { memory: { source: 'extras', memoryFrozen: false } }, modules: [] });
const codes = result => result.findings.map(item => item.code);
function qrFixture(entries = [{ message: 'hello' }]) {
    const set = { qrList: entries }, config = { setList: [{ set, isVisible: false }] };
    return { ...base(), currentAvatar: 'fixture.png', quickReplyApi: {
        settings: { isEnabled: true, config, characterConfigs: {} },
        getSetByName(name) { return name === 'fixture' ? set : undefined; },
    } };
}

test('default extras without summarize is allowed only for the current capability snapshot', () => {
    const input = base(); assert.equal(policy(input).verified, true);
    input.modules.push('summarize'); assert.deepEqual(codes(policy(input)), ['MEMORY_AUTOMATION']);
    input.modules.length = 0; assert.equal(policy(input).verified, true);
    delete input.modules; assert.deepEqual(codes(policy(input)), ['MEMORY_CAPABILITY_UNKNOWN']);
});
test('main, webllm and unknown memory sources block; frozen or disabled memory permits a current check', () => {
    for (const source of ['main', 'webllm', 'unknown']) {
        const input = base(); input.extensionSettings.memory.source = source;
        assert.deepEqual(codes(policy(input)), ['MEMORY_AUTOMATION']);
        input.extensionSettings.memory.memoryFrozen = true; assert.equal(policy(input).verified, true);
        input.extensionSettings.memory.memoryFrozen = false; input.disabledExtensions = ['memory'];
        assert.equal(policy(input).verified, true);
    }
});
test('all three vector channels and legacy enabled are blocked, while unrelated vector preferences are harmless', () => {
    for (const key of ['enabled', 'enabled_chats', 'enabled_files', 'enabled_world_info']) {
        const input = base(); input.extensionSettings.vectors = { [key]: true };
        assert.deepEqual(codes(policy(input)), ['VECTOR_AUTOMATION']);
        input.extensionSettings.disabledExtensions = ['vectors']; assert.equal(policy(input).verified, true);
    }
    const input = base(); input.extensionSettings.vectors = { summarize: true, enabled_for_all: true };
    assert.equal(policy(input).verified, true);
});
test('automatic caption and either image automation path block without examining prompts', () => {
    const input = base(); input.extensionSettings.caption = { auto_mode: true };
    input.extensionSettings.sd = { interactive_mode: true, function_tool: true };
    assert.deepEqual(codes(policy(input)), ['CAPTION_AUTOMATION', 'IMAGE_AUTOMATION']);
    input.disabledExtensions = ['caption', 'stable-diffusion']; assert.equal(policy(input).verified, true);
    input.disabledExtensions = []; input.extensionSettings.caption.auto_mode = false;
    input.extensionSettings.sd.interactive_mode = false; assert.deepEqual(codes(policy(input)), ['IMAGE_AUTOMATION']);
});
test('enabled empty and manual-only QuickReply configurations are allowed, including hidden sets', () => {
    for (const entries of [[], [{ message: '' , executeOnAi: true }], [{ message: 'hello' }]]) {
        const input = qrFixture(entries); input.currentMetadata = { quickReply: { setList: [{ set: 'fixture', isVisible: false }] } };
        const result = policy(input); assert.equal(result.verified, true); assert.ok(result.continuedMetadataKeys.includes('quickReply'));
    }
});
test('every native automatic trigger and WI automation ID blocks nonempty QR even when buttons are hidden', () => {
    for (const flag of ['executeOnStartup', 'executeOnUser', 'executeOnAi', 'executeOnChatChange', 'executeOnGroupMemberDraft', 'executeOnNewChat', 'executeBeforeGeneration', 'automationId']) {
        const input = qrFixture([{ message: 'hello', [flag]: flag === 'automationId' ? 'fixture' : true }]);
        assert.deepEqual(codes(policy(input)), ['QUICK_REPLY_AUTOMATION']);
    }
    assert.equal(policy(qrFixture([{ message: ' ', executeOnAi: true }])).verified, false, 'native message.length does not trim whitespace');
});
test('role config and chat metadata are checked independently of current runtime global config', () => {
    const input = qrFixture([]), set = { qrList: [{ message: 'hello', executeOnChatChange: true }] };
    input.quickReplyApi.settings.characterConfigs['fixture.png'] = { setList: [{ set }] };
    assert.equal(policy(input).verified, false);
    input.quickReplyApi.settings.characterConfigs = {};
    input.quickReplyApi.getSetByName = () => set;
    input.currentMetadata = { quickReply: { setList: [{ set: 'fixture' }] } };
    const result = policy(input); assert.equal(result.verified, false); assert.equal(result.continuedMetadataKeys.includes('quickReply'), false);
});
test('stale live chat/role automation remains blocked until the native switch has settled', () => {
    for (const key of ['charConfig', 'chatConfig']) {
        const input = qrFixture([]); input.quickReplyApi.settings[key] = { setList: [{ set: { qrList: [{ message: 'hello', executeOnAi: true }] } }] };
        assert.equal(policy(input).verified, false);
    }
});
test('disabled QuickReply may allow fresh operation but never adds automatic metadata to the copy list', () => {
    const input = qrFixture([{ message: 'hello', executeOnAi: true }]);
    input.quickReplyApi.settings.isEnabled = false;
    input.currentMetadata = { quickReply: { setList: [{ set: 'fixture' }] } };
    const result = policy(input); assert.equal(result.verified, true); assert.equal(result.continuedMetadataKeys.includes('quickReply'), false);
});
test('without runtime API only demonstrably empty/disabled QR configuration is allowed', () => {
    const input = base(); input.extensionSettings.quickReplyV2 = { isEnabled: true, config: { setList: [] } };
    assert.equal(policy(input).verified, true);
    input.extensionSettings.quickReplyV2.config.setList = [{ set: 'fixture' }];
    assert.deepEqual(codes(policy(input)), ['QUICK_REPLY_UNRESOLVED']);
    input.extensionSettings.quickReplyV2.isEnabled = false; assert.equal(policy(input).verified, true);
    input.currentMetadata = { quickReply: { setList: [{ set: 'fixture' }] } };
    assert.equal(policy(input).continuedMetadataKeys.includes('quickReply'), false);
    delete input.extensionSettings.quickReplyV2; input.extensionSettings.quickReply = { quickReplyEnabled: true };
    assert.equal(policy(input).verified, false);
});
test('missing resolved QR sets are ignored exactly like native, lookup failures and malformed metadata are not', () => {
    const input = qrFixture([]); input.currentMetadata = { quickReply: { setList: [{ set: 'deleted-set' }] } };
    assert.equal(policy(input).verified, true); assert.ok(policy(input).continuedMetadataKeys.includes('quickReply'));
    input.quickReplyApi.getSetByName = () => { throw new Error('fixture unavailable'); };
    assert.equal(policy(input).verified, false);
    input.currentMetadata = { quickReply: { setList: 'bad' } }; assert.equal(policy(input).verified, false);
});
test('ordinary continued metadata is allowed, chat_id_hash is explicitly recomputed and no unknown key is permitted', () => {
    const result = policy(base());
    for (const key of ['tainted', 'lastInContextMessageId', 'system_prompt', 'mes_example']) assert.ok(result.continuedMetadataKeys.includes(key));
    assert.equal(result.continuedMetadataKeys.includes('chat_id_hash'), false);
    assert.deepEqual(result.recomputedMetadataKeys, ['chat_id_hash']);
    assert.equal(result.continuedMetadataKeys.includes('unreviewedPlugin'), false);
});
test('no input mutation or content leaks and missing settings fail closed', () => {
    const input = qrFixture([{ message: 'SYNTHETIC_PRIVATE_SCRIPT', label: 'SYNTHETIC_LABEL' }]);
    input.currentMetadata = { quickReply: { setList: [{ set: 'fixture' }] }, unreviewedPlugin: { secret: 'SYNTHETIC_CHAT' } };
    const before = JSON.stringify(input), result = policy(input);
    assert.equal(JSON.stringify(input), before); assert.equal(JSON.stringify(result).includes('SYNTHETIC'), false);
    assert.deepEqual(codes(policy()), ['NATIVE_SETTINGS_UNKNOWN']);
});

test('Horae\'s migration marker is carried; a quick reply with automation is blocked rather than carried', () => {
    assert.ok(policy(base()).continuedMetadataKeys.includes('horae_native_visibility_migration'));
    assert.ok(policy(base()).continuedMetadataKeys.includes('main_chat'));
    assert.deepEqual(policy(base()).blockedMetadataKeys, []);
    const input = qrFixture([{ message: '/echo', executeOnUser: true }]);
    input.currentMetadata = { quickReply: { setList: [{ set: 'fixture' }] } };
    assert.deepEqual(policy(input).blockedMetadataKeys, ['quickReply']);
    const quiet = qrFixture([{ message: '' }]);
    quiet.currentMetadata = { quickReply: { setList: [{ set: 'fixture' }] } };
    assert.deepEqual(policy(quiet).blockedMetadataKeys, []);
});
