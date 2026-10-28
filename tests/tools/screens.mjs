// Phone-size screenshots of the main screens, plus a Chinese sample chapter, the theme editor and the character editor. Usage: node screens.mjs <baseUrl> <handle> <password> <outDir> [light|dark]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password, out, scheme = 'light'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme });
const page = await context.newPage();
const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
await page.request.post(`${base}/api/users/login`, { headers: { 'X-CSRF-Token': token }, data: { handle, password } });
const app = `${base}/scripts/extensions/third-party/emmalike/app/`;
const shot = async name => {
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${out}/${name}-${scheme}.png` });
};
const close = () => page.getByRole('button', { name: '关闭' }).click();

await page.goto(app);
await page.locator('.tl-character').first().waitFor();
await shot('01-library');

await page.locator('.tl-book-menu').first().click();
await shot('02-book-menu');
await close();

await page.locator('.tl-continue-primary').click();
await page.locator('.tl-message').first().waitFor();
await shot('03-reader-loading');
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
await shot('04-reader-ready');

await page.getByRole('button', { name: '阅读设置' }).click();
await shot('05-reading-sheet');
await close();

await page.getByRole('button', { name: '切换章节' }).click();
await shot('06-chapters-sheet');
await close();

await page.getByRole('button', { name: '更多操作' }).click();
await shot('07-actions-sheet');
await close();

await page.getByRole('button', { name: '更多', exact: true }).click();
await page.getByRole('button', { name: /^章节与简介/ }).click();
await page.locator('.tl-work-hero').waitFor();
await shot('08-work');

await page.getByRole('button', { name: '返回' }).click();
await page.getByRole('button', { name: '我的' }).click();
await page.locator('.tl-profile').waitFor();
await shot('09-me');

// A Chinese sample chapter, opened at its first page, to judge typography.
const sample = [{ user_name: 'unused', character_name: 'unused', chat_metadata: {} },
    { name: 'Seraphina', is_user: false, is_system: false, send_date: new Date().toISOString(), extra: {}, mes: '雨是在黄昏时停的。林子里的雾还没散，树叶上的水一滴一滴落下来，打在木屋的檐角上。\n\n*她推开门，把灯芯拨亮了一些，回头看你。*\n\n"醒了？"她的声音很轻，像怕惊动什么，"你在林子边上睡了整整一天。我给你煮了茶，趁热喝。"\n\n*炉火映在她的侧脸上，她把杯子推到你手边，又往壶里添了一勺水。*' },
    { name: 'User', is_user: true, is_system: false, send_date: new Date().toISOString(), extra: {}, mes: '我接过杯子，问她这是哪里。' },
    { name: 'Seraphina', is_user: false, is_system: false, send_date: new Date().toISOString(), extra: {}, mes: '"林子的最深处。"她在你对面坐下，*手指轻轻敲着桌面，*"一般人走不到这里，你是第三个。"\n\n窗外又起了风，吹得灯影晃了晃。' }];
await page.request.post(`${base}/api/chats/save`, { headers: { 'X-CSRF-Token': token }, data: { ch_name: 'Seraphina', file_name: '轻酒馆样张', chat: sample, avatar_url: 'default_Seraphina.png' } });
await page.goto(`${app}#chat=default_Seraphina.png&file=${encodeURIComponent('轻酒馆样张')}`);
await page.locator('.tl-chapter-opening').waitFor();
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
await page.locator('.tl-messages').evaluate(el => { el.scrollTop = 0; });
await shot('10-reader-sample');

// Theme editor, starting from the parchment preset, with two effects switched on.
await page.getByRole('button', { name: '阅读设置' }).click();
await page.getByRole('radio', { name: '羊皮', exact: true }).click();
await page.getByRole('button', { name: /做一个自己的主题/ }).click();
await page.locator('.tl-theme-editor').waitFor();
await page.getByRole('button', { name: '首字下沉' }).click();
await page.getByRole('button', { name: '纸张纹理' }).click();
await page.evaluate(() => window.scrollTo(0, 0));
await shot('11-theme-editor');
await page.locator('.tl-theme-css').scrollIntoViewIfNeeded();
await shot('12-theme-editor-more');
await page.getByRole('button', { name: '保存', exact: true }).click();
await page.locator('.tl-chapter-opening').waitFor();
await page.locator('.tl-messages').evaluate(el => { el.scrollTop = 0; });
await shot('13-reader-own-theme');

// Character editor.
await page.goto(app + '#edit=default_Seraphina.png');
await page.locator('#tl-field-description').waitFor();
await shot('14-character-editor');
await page.goto(app + '#chat=default_Seraphina.png&file=' + encodeURIComponent('轻酒馆样张'));
await page.locator('.tl-chapter-opening').waitFor();

// Put the look back for whoever uses the account next: delete the sample themes, then default reading settings.
for (;;) {
    await page.getByRole('button', { name: '阅读设置' }).click();
    const card = page.getByRole('radio', { name: '我的羊皮' }).first();
    if (!await card.count()) break;
    if (await card.getAttribute('aria-checked') !== 'true') await card.click();
    await page.getByRole('button', { name: /^编辑「/ }).click();
    await page.getByRole('button', { name: '删除主题' }).click();
    await page.getByRole('dialog', { name: '删除主题' }).getByRole('button', { name: '删除', exact: true }).click();
    await page.locator('.tl-chapter-opening').waitFor();
}
await page.getByRole('button', { name: '恢复默认' }).click();
await close();
// The full app saves account settings a moment later; give it time before closing the browser.
await page.waitForTimeout(3000);
await browser.close();
