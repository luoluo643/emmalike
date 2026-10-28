/** Standalone 500-message/4x CPU headless acceptance.
 * Usage: node tests/e2e-ui-performance.mjs /tmp/ui-performance-proof
 * Reuses the fixed-8032/pure environment, browser-only models/settings, owned-role
 * setup and exact cleanup in e2e-ui-appearance.mjs. Never connects elsewhere.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

function summarizePerformance(performanceData) {
    const shifts = performanceData.shifts.filter(item => !item.hadRecentInput).sort((a, b) => a.startTime - b.startTime);
    let current = { score: 0, first: 0, last: 0, entries: [] }, largest = current;
    for (const entry of shifts) {
        if (!current.entries.length || entry.startTime - current.last >= 1000 || entry.startTime - current.first >= 5000) {
            current = { score: 0, first: entry.startTime, last: entry.startTime, entries: [] };
        }
        current.score += entry.value; current.last = entry.startTime; current.entries.push(entry);
        if (current.score > largest.score) largest = { ...current, entries: [...current.entries] };
    }
    const marks = Object.fromEntries(performanceData.marks.map(item => [item.name, item.startTime]));
    const boundaries = [
        ['before-model-held', -Infinity, marks['ui-model-request-held']],
        ['model-held', marks['ui-model-request-held'], marks['ui-model-request-released']],
        ['released-to-reply', marks['ui-model-request-released'], marks['ui-reply-finished']],
        ['reply-observation-tail', marks['ui-reply-finished'], Infinity],
    ];
    return {
        scope: 'Main app frame only; native iframe layout shifts are not part of this observer.',
        largestCLSWindow: largest,
        largestIndividualShifts: [...shifts].sort((a, b) => b.value - a.value).slice(0, 5),
        phases: boundaries.map(([name, from, to]) => {
            const tasks = performanceData.longTasks.filter(item => item.startTime >= from && item.startTime < to);
            const phaseShifts = shifts.filter(item => item.startTime >= from && item.startTime < to);
            return { name, longTaskCount: tasks.length, longTaskMaxMs: Math.max(0, ...tasks.map(item => item.duration)),
                longTaskTotalMs: tasks.reduce((sum, item) => sum + item.duration, 0),
                shiftSum: phaseShifts.reduce((sum, item) => sum + item.value, 0),
                largestShift: [...phaseShifts].sort((a, b) => b.value - a.value)[0] || null };
        }),
    };
}

export async function performanceCase(result, helpers) {
    const { session, ready, fixtures, sheet, hitbox, openReading, closeSheet, shot, output, run, modelText } = helpers;
    const s = await session(result); await ready(s, `#${new URLSearchParams({ chat: fixtures[0].avatar, file: fixtures[0].file })}`);
    await s.page.locator('.tl-composer-input[data-synced="true"]').waitFor({ timeout: 120000 });
    result.buildAssets = await s.page.evaluate(() => [...document.querySelectorAll('script[src],link[rel="stylesheet"][href]')]
        .map(node => new URL(node.src || node.href).pathname).filter(value => value.includes('/app/assets/')));
    const nativeFrame = s.page.frames().find(frame => frame !== s.page.mainFrame() && new URL(frame.url()).origin === 'http://127.0.0.1:8032');
    assert(nativeFrame, 'Native frame is required for configuration evidence.');
    result.runtimeFlags = await nativeFrame.evaluate(async () => {
        const ext = await import('/scripts/extensions.js'); // Existing native module; no plugin import or execution.
        const settings = SillyTavern.getContext().extensionSettings;
        const disabled = name => (settings.disabledExtensions || []).includes(name);
        const qr = globalThis.quickReplyApi?.settings;
        const flags = ['executeOnStartup', 'executeOnUser', 'executeOnAi', 'executeOnChatChange', 'executeOnGroupMemberDraft', 'executeOnNewChat', 'executeBeforeGeneration'];
        const countScope = config => {
            const links = config?.setList || [], items = links.flatMap(link => link.set?.qrList || []);
            return { sets: links.length, entries: items.length,
                nonempty: items.filter(item => item.message?.length > 0).length,
                automatic: items.filter(item => item.message?.length > 0 && (flags.some(flag => item[flag]) || item.automationId)).length,
                unresolvedLinks: links.filter(link => !link.set).length };
        };
        return {
            memory: { disabled: disabled('memory'), source: settings.memory?.source || 'extras', frozen: !!settings.memory?.memoryFrozen, extrasSummarizeAvailable: ext.modules.includes('summarize') },
            vectors: { disabled: disabled('vectors'), chats: !!settings.vectors?.enabled_chats, legacyEnabled: !!settings.vectors?.enabled, files: !!settings.vectors?.enabled_files, worldInfo: !!settings.vectors?.enabled_world_info },
            quickReply: { disabled: disabled('quick-reply'), apiAvailable: !!qr, enabled: qr ? !!qr.isEnabled : !!(settings.quickReplyV2?.isEnabled ?? settings.quickReply?.quickReplyEnabled),
                global: countScope(qr?.config), character: countScope(qr?.charConfig), chat: countScope(qr?.chatConfig) },
            caption: { disabled: disabled('caption'), automatic: !!settings.caption?.auto_mode },
            images: { disabled: disabled('stable-diffusion'), interactive: !!settings.sd?.interactive_mode, tool: !!settings.sd?.function_tool }
        };
    });
    const cdp = await s.context.newCDPSession(s.page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const trace = []; cdp.on('Tracing.dataCollected', e => trace.push(...e.value));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,loading,latencyInfo', transferMode: 'ReportEvents' });
    let release; s.holdGeneration = new Promise(r => { release = r; });
    const geometry = async label => {
        const sample = await s.page.evaluate(label => {
            performance.mark(`ui-${label}`);
            const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
            return { label, at: performance.now(), nodes: [...document.querySelectorAll('.tl-sheet,.tl-sheet-body,.tl-messages,.tl-composer,.tl-personal-notice')]
                .map(el => ({ class: el.className, rect: rect(el), scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, children: el.children.length })) };
        }, label);
        (result.geometry ??= []).push(sample);
    };
    try {
        const initial = await s.page.evaluate(() => {
            const native = document.querySelector('iframe.engine').contentWindow;
            return { engine: !!native.TavernLiteBridge, sourceCount: native.TavernLiteBridge.personalConversation().messages.length,
                modelContext: native.SillyTavern.getContext().chatCompletionSettings.openai_max_context,
                replyTokens: native.SillyTavern.getContext().chatCompletionSettings.openai_max_tokens,
                count: document.querySelectorAll('.tl-message').length, at: performance.now() };
        });
        assert.equal(initial.sourceCount, 500, 'Native story must actually contain 500 messages.');
        await s.page.locator('.tl-message-menu').last().click();
        await sheet(s, '消息操作').getByRole('button', { name: /^收藏原句/ }).click();
        await sheet(s, '收藏原句').getByRole('button', { name: '收藏整段', exact: true }).click();
        await s.page.getByRole('button', { name: '加备注', exact: true }).waitFor();
        await s.page.locator('.tl-composer-input').fill(`性能验收发送 ${run}`); await s.page.getByRole('button', { name: '发送', exact: true }).click();
        await s.page.locator('.tl-stop').waitFor({ timeout: 30000 });
        result.stopHitbox = await hitbox(s, '.tl-stop');
        // Hold the intercepted generation pending while UI work runs: no real model latency.
        const requestDeadline = Date.now() + 30000;
        while (!s.generations && Date.now() < requestDeadline) await s.page.waitForTimeout(100);
        assert.equal(s.generations, 1, 'Exactly one real native generation request must reach the browser mock.');
        await s.page.evaluate(() => performance.mark('ui-model-request-held'));
        await s.page.locator('.tl-composer-input').fill('生成期间保留的输入草稿');
        await s.page.locator('.tl-messages').evaluate(el => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true })); el.scrollTop = Math.max(0, el.scrollTop - 800); el.dispatchEvent(new Event('scroll')); });
        const anchor = await s.page.locator('.tl-messages').evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, count: document.querySelectorAll('.tl-message').length }));
        await s.page.evaluate(() => performance.mark('ui-before-aa'));
        const start = performance.now(); await openReading(s); const openedMs = performance.now() - start;
        await s.page.evaluate(() => performance.mark('ui-aa-visible'));
        await closeSheet(s, '阅读设置');
        const after = await s.page.locator('.tl-messages').evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight }));
        assert(Math.abs(after.top - anchor.top) < 12, `Aa changed reading anchor: ${JSON.stringify({ anchor, after })}`);
        assert.equal(await s.page.locator('.tl-composer-input').inputValue(), '生成期间保留的输入草稿');
        await s.page.evaluate(() => performance.mark('ui-before-note'));
        const noteStart = performance.now(); await s.page.getByRole('button', { name: '加备注', exact: true }).click();
        await sheet(s, '私人备注').waitFor(); const noteOpenMs = performance.now() - noteStart;
        await s.page.evaluate(() => performance.mark('ui-note-visible'));
        await s.page.locator('#tl-private-note').fill('4倍 CPU 模拟下编辑私人备注，保留输入草稿。'.repeat(20));
        await shot(s, 'performance-4x-note-during-generation');
        await geometry('note-before-save');
        await sheet(s, '私人备注').getByRole('button', { name: '保存备注', exact: true }).click();
        await sheet(s, '私人备注').waitFor({ state: 'hidden' });
        await geometry('note-editor-hidden');
        assert.equal(await s.page.locator('.tl-composer-input').inputValue(), '生成期间保留的输入草稿');
        result.checks.push({ name: '500-source-messages-4x-CPU-Aa-note-during-pending-generation', initial, anchor, after, openedMs, noteOpenMs, sourceMessages: 500, note: 'Rendered message count is lazy-windowed; timings exclude native engine startup and held model wait, include Playwright dispatch.' });
        await s.page.evaluate(() => performance.mark('ui-model-request-released'));
        release(); s.holdGeneration = null;
        await s.page.locator('.tl-message[data-role=char]', { hasText: modelText }).waitFor({ timeout: 120000 });
        await s.page.locator('.tl-stop').waitFor({ state: 'hidden', timeout: 30000 });
        await geometry('reply-finished');
        assert.equal(await s.page.locator('.tl-composer-input').inputValue(), '生成期间保留的输入草稿');
        // Keep a named observation tail for delayed sheet reload/render work;
        // its cost is reported separately from reply processing, never discarded.
        await s.page.waitForTimeout(1200);
        await s.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await geometry('observation-end');
        result.performance = await s.page.evaluate(startAt => ({ longTasks: window.__uiEvidence.longTasks.filter(x => x.startTime >= startAt), shifts: window.__uiEvidence.shifts.filter(x => x.startTime >= startAt), marks: performance.getEntriesByType('mark').filter(x => x.name.startsWith('ui-')).map(x => ({ name: x.name, startTime: x.startTime })) }), initial.at);
        result.performance.longTaskCountOver50ms = result.performance.longTasks.filter(x => x.duration > 50).length;
        result.performance.layoutShiftWithoutRecentInput = result.performance.shifts.filter(x => !x.hadRecentInput).reduce((sum, x) => sum + x.value, 0);
        result.performance.summary = summarizePerformance(result.performance);
        result.contextWarnings = await s.page.evaluate(() => window.__uiEvidence.toasts.filter(x => /Mandatory prompts exceed the context size/i.test(x)));
        assert.equal(result.contextWarnings.length, 0, 'Model fixture context-limit warnings contaminate this performance sample; keep evidence, do not call it a clean baseline.');
    } finally {
        release(); s.holdGeneration = null;
        const complete = new Promise(resolveDone => cdp.once('Tracing.tracingComplete', resolveDone)); await cdp.send('Tracing.end'); await complete;
        await writeFile(resolve(output, 'performance-4x-trace.json'), JSON.stringify({ traceEvents: trace }));
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    assert(args.length === 1 && !args[0].includes('://') && !args[0].startsWith('--'), 'Supply one evidence directory, never a server URL.');
    const script = fileURLToPath(new URL('./e2e-ui-appearance.mjs', import.meta.url));
    const child = spawn(process.execPath, [script, args[0], '--cases=performance'], { stdio: 'inherit', env: process.env, windowsHide: true });
    process.exitCode = await new Promise((done, reject) => { child.on('error', reject); child.on('exit', (code, signal) => done(signal ? 1 : code ?? 1)); });
}
