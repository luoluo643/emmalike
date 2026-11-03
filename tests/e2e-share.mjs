// Sharing a story: what to share (round presets, "from this message", any start and end floor, one side only, or a
// passage selected in a message), the reader's name hidden on request in the text, the title and the long picture's
// source, and the long picture in the theme's colours on request. Usage: node e2e-share.mjs <base> <handle> <password> [shot]
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
// Where to save a picture of the export sheet, if anywhere (an argument here used to collide with the runners' extras).
const shot = process.env.SHARE_SHOT || '';
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const AVATAR = 'default_Seraphina.png';
const run = Date.now().toString(36);
const READER = `阿青${run.slice(-3)}`;
const FILE = `share-${run}`;
const ROUNDS = 12;

const results = {};
const problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`; if (!ok) problems.push(name); };
process.on('uncaughtException', error => {
    console.log(`FAILURE ${String(error?.message ?? error).split('\n')[0]}`);
    console.log(JSON.stringify(results, null, 1));
    process.exit(2);
});

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 200)));
const sheet = title => page.getByRole('dialog', { name: title });

const { token } = await (await page.request.get(`${base}/csrf-token`)).json();
if (!(await page.request.post(`${base}/api/users/login`, { headers: { 'X-CSRF-Token': token }, data: { handle, password } })).ok()) throw new Error('login failed');
const now = () => new Date().toISOString();
const story = [{ user_name: 'unused', character_name: 'unused', chat_metadata: {} },
    { name: 'Seraphina', is_user: false, is_system: false, send_date: now(), extra: {}, mes: `开场白${run}` }];
for (let k = 1; k <= ROUNDS; k++) {
    story.push({ name: READER, is_user: true, is_system: false, send_date: now(), extra: {}, mes: `第${k}轮问${run}` });
    // One reply with dialogue and italics, which the themed long picture colours.
    story.push({ name: 'Seraphina', is_user: false, is_system: false, send_date: now(), extra: {}, mes: `回答${k}：${READER}你好${run}${k === 5 ? '\n\n“慢慢来。”*她笑了笑。*' : ''}` });
}
const saved = await page.request.post(`${base}/api/chats/save`, { headers: { 'X-CSRF-Token': token }, data: { ch_name: 'Seraphina', file_name: FILE, chat: story, avatar_url: AVATAR } });
check('story fixture saved', saved.ok());

await page.goto(`${appUrl}#${new URLSearchParams({ chat: AVATAR, file: FILE })}`);
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });

// The reading header hides while reading: come back to the end of the story first, where it shows again.
async function openShare() {
    await page.locator('.tl-messages').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.waitForFunction(() => !document.querySelector('.tl-reader-header[data-hidden="true"]'), null, { timeout: 10000 }).catch(() => { });
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await sheet('Seraphina').getByRole('button', { name: /^分享这个故事/ }).click();
    await sheet('分享').getByRole('radio').first().waitFor({ timeout: 30000 });
}
async function exportText() {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), sheet('分享').getByRole('button', { name: /^文本文件/ }).click()]);
    return readFile(await download.path(), 'utf8');
}
const asked = text => [...text.matchAll(new RegExp(`第(\\d+)轮问${run}`, 'g'))].map(m => Number(m[1]));

// 1. Presets counted in rounds.
await openShare();
const radios = await sheet('分享').getByRole('radiogroup', { name: '分享范围' }).getByRole('radio').allInnerTexts();
check('presets are rounds, picking is by floor', JSON.stringify(radios.map(t => t.replace(/ · 已选$/, ''))) === JSON.stringify(['最近 10 轮', `整章（${ROUNDS} 轮）`, '自己选楼层']), JSON.stringify(radios));
check('recent rounds chosen first', (await sheet('分享').getByRole('radio', { name: /^最近 10 轮/ }).getAttribute('aria-checked')) === 'true');
check('summary says which floors', (await sheet('分享').locator('.tl-sheet-note').innerText()).includes('#5 到 #24，共 20 条'),
    await sheet('分享').locator('.tl-sheet-note').innerText());
let text = await exportText();
check('recent 10 rounds exported', JSON.stringify(asked(text)) === JSON.stringify([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) && !text.includes(`开场白${run}`), JSON.stringify(asked(text)));

// 2. Any start and end floor.
await openShare();
await sheet('分享').getByRole('radio', { name: /^自己选/ }).click();
const startSelect = sheet('分享').getByLabel('从哪一楼开始');
const endSelect = sheet('分享').getByLabel('到哪一楼结束');
const options = await startSelect.locator('option').allInnerTexts();
check('floors listed with who wrote them and their opening words', options.length === ROUNDS * 2 + 1 && options[0].startsWith('#0 Seraphina：开场白')
    && options[3].startsWith(`#3 ${READER}：第2轮问${run}`), JSON.stringify(options.slice(0, 4)));
await startSelect.selectOption({ label: options[7] });
await endSelect.selectOption({ label: options[12] });
check('picked floors summarised', (await sheet('分享').locator('.tl-sheet-note').innerText()).includes('#7 到 #12，共 6 条'), await sheet('分享').locator('.tl-sheet-note').innerText());
await startSelect.selectOption({ label: options[17] });
check('a start after the end moves the end', (await endSelect.inputValue()) === '17', await endSelect.inputValue());
await startSelect.selectOption({ label: options[0] });
await endSelect.selectOption({ label: options[4] });
const hideSwitch = sheet('分享').getByRole('switch', { name: /^隐藏我的名字/ });
check('hide-name switch off at first and names the reader', (await hideSwitch.getAttribute('aria-checked')) === 'false' && (await hideSwitch.innerText()).includes(`「${READER}」`), await hideSwitch.innerText());
text = await exportText();
check('picked floors exported with the greeting', JSON.stringify(asked(text)) === '[1,2]' && text.includes(`开场白${run}`) && text.includes(`${READER}：`), text.slice(0, 200));

// 2b. One side only, on any range.
await openShare();
await sheet('分享').getByRole('radio', { name: '只要Seraphina' }).click();
check('one side summarised', (await sheet('分享').locator('.tl-sheet-note').innerText()).includes('#6 到 #24，共 10 条'), await sheet('分享').locator('.tl-sheet-note').innerText());
text = await exportText();
check('only the character\'s floors', asked(text).length === 0 && (text.match(/回答\d+：/g) ?? []).length === 10 && !text.includes(`${READER}：`), text.slice(0, 200));
await openShare();
await sheet('分享').getByRole('radio', { name: '只要我' }).click();
text = await exportText();
check('only the reader\'s floors', JSON.stringify(asked(text)) === JSON.stringify([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) && !text.includes('回答'), text.slice(0, 200));

// 2c. One side that has nothing in the range: said at once, with nothing to press.
await openShare();
await sheet('分享').getByRole('radio', { name: /^自己选/ }).click();
const lastFloor = await sheet('分享').getByLabel('从哪一楼开始').locator('option').last().getAttribute('value');
await sheet('分享').getByLabel('从哪一楼开始').selectOption(lastFloor);
const shareButtons = () => Promise.all([/^长图/, /^文本文件/, /^复制文字/].map(name => sheet('分享').getByRole('button', { name }).isDisabled()));
const shareNote = () => sheet('分享').locator('.tl-sheet-note').innerText();
check('a floor of the character can be shared', (await shareButtons()).every(x => !x) && (await shareNote()).includes('#24，共 1 条'), await shareNote());
await sheet('分享').getByRole('radio', { name: '只要我' }).click();
check('only me on a floor of the character says so', (await shareNote()).includes('这一段里没有你的发言'), await shareNote());
check('and there is nothing to press', (await shareButtons()).every(Boolean), JSON.stringify(await shareButtons()));
await sheet('分享').getByRole('radio', { name: '只要Seraphina' }).click();
check('the other side can be shared again', (await shareButtons()).every(x => !x) && (await shareNote()).includes('#24，共 1 条'), await shareNote());
await sheet('分享').getByRole('radio', { name: '只要我' }).click();
await sheet('分享').getByRole('radio', { name: '都要' }).click();
check('everyone can be shared again', (await shareButtons()).every(x => !x));
await sheet('分享').getByRole('button', { name: '关闭' }).click();
await sheet('分享').waitFor({ state: 'detached', timeout: 10000 });
await page.waitForTimeout(400);

// 3. Name hidden: over the reader's messages, in replies and in the title; remembered on this device.
await openShare();
await sheet('分享').getByRole('switch', { name: /^隐藏我的名字/ }).click();
text = await exportText();
check('hidden name is gone from the text', !text.includes(READER) && text.includes('■■：') && text.includes(`回答12：■■你好${run}`), text.slice(-160));
check('the rest of the text is kept', JSON.stringify(asked(text)) === JSON.stringify([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) && text.startsWith('Seraphina · '));
await openShare();
check('hide-name choice remembered', (await sheet('分享').getByRole('switch', { name: /^隐藏我的名字/ }).getAttribute('aria-checked')) === 'true');
const [image] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), sheet('分享').getByRole('button', { name: /^长图/ }).click()]);
const png = await readFile(await image.path());
check('long picture still made', png.subarray(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 1080);
await openShare();
const themedSwitch = sheet('分享').getByRole('switch', { name: /^长图用主题配色/ });
check('theme colours off at first', (await themedSwitch.getAttribute('aria-checked')) === 'false');
await themedSwitch.click();
const [themedImage] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), sheet('分享').getByRole('button', { name: /^长图/ }).click()]);
const themedPng = await readFile(await themedImage.path());
check('themed long picture made', themedPng.subarray(1, 4).toString() === 'PNG' && themedPng.readUInt32BE(16) === 1080 && !themedPng.equals(png));
await openShare();
check('theme colours choice remembered', (await sheet('分享').getByRole('switch', { name: /^长图用主题配色/ }).getAttribute('aria-checked')) === 'true');
await sheet('分享').getByRole('switch', { name: /^长图用主题配色/ }).click();
await page.getByRole('dialog').last().getByRole('button', { name: '关闭' }).click();

// 4. From a message: starts at the round holding it.
await page.locator('.tl-message[data-role="char"]').nth(5).locator('.tl-message-menu').click();
await sheet('消息操作').getByRole('button', { name: /^更多/ }).click();
await sheet('更多').getByRole('button', { name: /^从这条开始分享/ }).click();
await sheet('分享').getByRole('radio').first().waitFor({ timeout: 30000 });
const firstRadio = await sheet('分享').getByRole('radio').first().innerText();
const fromNote = await sheet('分享').locator('.tl-sheet-note').innerText();
check('from this message starts at its floor', /^从 #\d+ 到最后/.test(firstRadio) && fromNote.includes(`${firstRadio.match(/#\d+/)[0]} 到 #24`), `${firstRadio} / ${fromNote}`);
text = await exportText();
const fromRounds = asked(text);
check('from-this-message export runs to the end', fromRounds.at(-1) === 12 && fromRounds.length === 13 - fromRounds[0], JSON.stringify(fromRounds));

// 4b. A passage selected in a message: just those words. A phone cannot select text on the reading page itself (long
// press opens the message menu), so it comes from the "select text" sheet there.
await page.locator('.tl-messages').evaluate(el => { el.scrollTop = el.scrollHeight; });
await page.locator('.tl-message[data-role="char"]').last().locator('.tl-message-menu').click();
await sheet('消息操作').getByRole('button', { name: /^更多/ }).click();
await sheet('更多').getByRole('button', { name: /^选择文字/ }).click();
await sheet('选择文字').locator('.tl-select-text').waitFor({ timeout: 30000 });
check('the share button waits for a selection', await sheet('选择文字').getByRole('button', { name: '分享选中的这段' }).isDisabled());
await page.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector('.tl-select-text'), NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent.includes('回答12')) node = walker.nextNode();
    const range = document.createRange();
    const at = node.textContent.indexOf('回答12');
    range.setStart(node, at);
    range.setEnd(node, at + 4);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
});
await sheet('选择文字').getByRole('button', { name: '分享选中的这段' }).click();
await sheet('分享').getByText('分享选中的一段').waitFor({ timeout: 30000 });
check('the passage sheet says where it is from', (await sheet('分享').innerText()).includes('来自 #24 Seraphina：回答12'), await sheet('分享').innerText());
text = await exportText();
check('only the selected words shared', text.endsWith('Seraphina：\n回答12\n') && !text.includes('你好'), JSON.stringify(text));

// 5. Narrow phone: the picker fits.
await page.setViewportSize({ width: 320, height: 640 });
await openShare();
await sheet('分享').getByRole('radio', { name: /^自己选/ }).click();
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const selectBox = await sheet('分享').getByLabel('从哪一楼开始').boundingBox();
check('picker fits a 320px screen', overflow <= 0 && selectBox && selectBox.x >= 0 && selectBox.x + selectBox.width <= 320, `overflow ${overflow}, select ${JSON.stringify(selectBox)}`);
if (shot) await page.screenshot({ path: shot });
await page.getByRole('dialog').last().getByRole('button', { name: '关闭' }).click();

await page.request.post(`${base}/api/chats/delete`, { headers: { 'X-CSRF-Token': token }, data: { chatfile: `${FILE}.jsonl`, avatar_url: AVATAR } }).catch(() => { });
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(JSON.stringify(results, null, 1));
await browser.close();
process.exit(problems.length ? 1 : 0);
