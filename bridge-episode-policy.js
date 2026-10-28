/** ST 1.19 native capability policy. Pure: no import of ST, writes, model calls,
 * event emission, timers, or mutation of the supplied settings/metadata.
 * Call again immediately before every operation. This is NOT an idle barrier:
 * disabling a feature does not prove that previously started work has finished.
 */
export const NATIVE_CONTINUED_METADATA_KEYS = Object.freeze([
    'variables', 'note_prompt', 'note_interval', 'note_position', 'note_depth', 'note_role',
    'timedWorldInfo', 'world_info', 'scenario', 'persona', 'main_prompt', 'jailbreak_prompt',
    'custom_background', 'tainted', 'lastInContextMessageId', 'system_prompt', 'mes_example', 'main_chat',
]);
// Other extensions' chat state known to be safe to carry into a continued copy (no automation reads it on its own).
// horae_native_visibility_migration: Horae's one-time migration marker; without it Horae re-runs the migration and saves.
export const KNOWN_EXTENSION_METADATA_KEYS = Object.freeze(['horae_native_visibility_migration']);
export const RECOMPUTED_METADATA_KEYS = Object.freeze(['chat_id_hash']);
const QR_FLAGS = Object.freeze(['executeOnStartup', 'executeOnUser', 'executeOnAi',
    'executeOnChatChange', 'executeOnGroupMemberDraft', 'executeOnNewChat', 'executeBeforeGeneration']);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

/** Returns only aggregate counts; never returns script text, labels, set names,
 * character names, file names, memory prompts, credentials, or chat content.
 * Hidden QR buttons still execute automatically; isVisible is deliberately ignored.
 */
function inspectQrConfig(config, api, serialized = false) {
    const result = { sets: 0, entries: 0, nonempty: 0, automatic: 0, unresolved: 0 };
    if (config == null) return result;
    if (!object(config) || config.setList != null && !Array.isArray(config.setList)) {
        result.unresolved++; return result;
    }
    if (serialized && Object.keys(config).some(key => key !== 'setList')) result.unresolved++;
    for (const link of config.setList ?? []) {
        result.sets++;
        if (!object(link) || serialized && Object.keys(link).some(key => !['set', 'isVisible'].includes(key))) {
            result.unresolved++; continue;
        }
        let set = link.set;
        if (typeof set === 'string') {
            if (typeof api?.getSetByName !== 'function') { result.unresolved++; continue; }
            try { set = api.getSetByName(set); } catch { result.unresolved++; continue; }
            // A resolved missing set is ignored by native QuickReplyConfig.from.
            if (set == null) continue;
        } else if (serialized) { result.unresolved++; continue; }
        if (set == null) continue; // Same as native AutoExecuteHandler.getCommands.
        if (!object(set) || !Array.isArray(set.qrList)) { result.unresolved++; continue; }
        for (const qr of set.qrList) {
            if (!object(qr)) { result.unresolved++; continue; }
            result.entries++;
            if (qr.message == null || qr.message === '') continue;
            if (typeof qr.message !== 'string') { result.unresolved++; continue; }
            result.nonempty++;
            // Native execute uses message.length, not trim().length. A missing
            // onExecute hook during initialization cannot make an automatic QR safe.
            if (QR_FLAGS.some(flag => qr[flag]) || qr.automationId) result.automatic++;
        }
    }
    return result;
}

/** extensionSettings comes from native ctx.extensionSettings; modules from the
 * already-loaded extensions.js; quickReplyApi from that iframe's global.
 * currentAvatar/currentMetadata MUST describe the exact current source chat.
 * Missing QR runtime API may still allow disabled or demonstrably empty configs.
 */
export function evaluateNativeEpisodePolicy({ extensionSettings, extensionsSettings,
    modules, quickReplyApi, currentAvatar, currentMetadata = {}, disabledExtensions } = {}) {
    const settings = extensionSettings ?? extensionsSettings;
    const findings = [], observations = {};
    const add = (code, feature, message) => findings.push({ code, feature, message });
    const continuedMetadataKeys = [...NATIVE_CONTINUED_METADATA_KEYS, ...KNOWN_EXTENSION_METADATA_KEYS];
    if (!object(settings)) {
        add('NATIVE_SETTINGS_UNKNOWN', 'settings', '还没读到酒馆的扩展设置');
        return { verified: false, allowed: false, reasons: findings.map(x => x.message), findings,
            continuedMetadataKeys, recomputedMetadataKeys: [...RECOMPUTED_METADATA_KEYS], observations };
    }
    const disabled = new Set([...(Array.isArray(settings.disabledExtensions) ? settings.disabledExtensions : []),
        ...(Array.isArray(disabledExtensions) ? disabledExtensions : [])]);
    const off = name => disabled.has(name);

    const memory = settings.memory ?? {}, source = memory.source ?? 'extras';
    const modulesKnown = Array.isArray(modules), summarizeAvailable = modulesKnown && modules.includes('summarize');
    observations.memory = { disabled: off('memory'), frozen: !!memory.memoryFrozen, source: ['extras', 'main', 'webllm'].includes(source) ? source : 'unknown',
        modulesKnown, extrasSummarizeAvailable: summarizeAvailable };
    if (!off('memory') && !memory.memoryFrozen) {
        if (source === 'extras' && !modulesKnown) add('MEMORY_CAPABILITY_UNKNOWN', 'memory', '还没确认自动摘要服务能不能用');
        else if (source !== 'extras' || summarizeAvailable) add('MEMORY_AUTOMATION', 'memory', '开着自动摘要，它会往聊天里写摘要');
    }

    const vectors = settings.vectors ?? {};
    observations.vectors = { disabled: off('vectors'), chats: !!vectors.enabled_chats, legacyEnabled: !!vectors.enabled,
        files: !!vectors.enabled_files, worldInfo: !!vectors.enabled_world_info };
    if (!off('vectors') && (vectors.enabled || vectors.enabled_chats || vectors.enabled_files || vectors.enabled_world_info)) {
        add('VECTOR_AUTOMATION', 'vectors', '开着向量记忆或检索');
    }
    observations.caption = { disabled: off('caption'), automatic: !!settings.caption?.auto_mode };
    if (!off('caption') && settings.caption?.auto_mode) add('CAPTION_AUTOMATION', 'caption', '开着自动图片描述');
    observations.images = { disabled: off('stable-diffusion'), interactive: !!settings.sd?.interactive_mode, tool: !!settings.sd?.function_tool };
    if (!off('stable-diffusion') && (settings.sd?.interactive_mode || settings.sd?.function_tool)) {
        add('IMAGE_AUTOMATION', 'stable-diffusion', '开着自动生图或生图工具');
    }

    const runtime = object(quickReplyApi?.settings) ? quickReplyApi.settings : null;
    const raw = settings.quickReplyV2, legacy = settings.quickReply;
    const enabled = !!(runtime ? runtime.isEnabled : raw?.isEnabled ?? legacy?.quickReplyEnabled);
    const scopes = {
        global: inspectQrConfig(runtime?.config ?? raw?.config, quickReplyApi, !runtime),
        character: inspectQrConfig(currentAvatar ? (runtime?.characterConfigs ?? raw?.characterConfigs)?.[currentAvatar] : null, quickReplyApi, !runtime),
        // Includes a stale runtime scope conservatively until CHAT_CHANGED finishes.
        liveCharacter: inspectQrConfig(runtime?.charConfig, quickReplyApi),
        liveChat: inspectQrConfig(runtime?.chatConfig, quickReplyApi),
        metadata: inspectQrConfig(currentMetadata?.quickReply, quickReplyApi, true),
    };
    if (!runtime && !raw && enabled) scopes.global.unresolved++; // Legacy active slots need the native migration result.
    const automatic = Object.values(scopes).reduce((sum, scope) => sum + scope.automatic, 0);
    const unresolved = Object.values(scopes).reduce((sum, scope) => sum + scope.unresolved, 0);
    observations.quickReply = { disabled: off('quick-reply'), apiAvailable: !!runtime, enabled, scopes, automatic, unresolved };
    if (!off('quick-reply') && enabled) {
        if (automatic) add('QUICK_REPLY_AUTOMATION', 'quick-reply', '快捷回复里有会自动运行的条目');
        if (unresolved) add('QUICK_REPLY_UNRESOLVED', 'quick-reply', '还没确认快捷回复里有没有会自动运行的条目');
    }
    // A disabled automatic configuration may allow fresh mode, but is never
    // silently copied into a continued child. Unknown metadata stays fail-closed.
    if (own(currentMetadata, 'quickReply') && scopes.metadata.automatic === 0 && scopes.metadata.unresolved === 0) {
        continuedMetadataKeys.push('quickReply');
    }
    const blockedMetadataKeys = own(currentMetadata, 'quickReply') && !continuedMetadataKeys.includes('quickReply') ? ['quickReply'] : [];
    return { verified: findings.length === 0, allowed: findings.length === 0,
        reasons: findings.map(x => x.message), findings, continuedMetadataKeys, blockedMetadataKeys,
        recomputedMetadataKeys: [...RECOMPUTED_METADATA_KEYS], observations };
}
