// Adding your own font: a file uploaded to the account, a link to a font file, a link to a font stylesheet (with and
// without a readable name), refusing what is not a font, surviving a reload, following the account to another device,
// and deleting it again. Usage: node e2e-fonts.mjs <base> <handle> <password>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

const [base, handle, password] = process.argv.slice(2);
const appUrl = `${base}/scripts/extensions/third-party/emmalike/app/`;
const AVATAR = 'default_Seraphina.png';
const FILE = `fonts-${Date.now().toString(36)}`;
const FONT_PATH = '/webfonts/NotoSans/NotoSans-Regular.woff2';

const results = {};
const problems = [];
const check = (name, ok, detail = '') => { results[name] = ok ? 'PASS' : `FAIL ${detail}`; if (!ok) problems.push(name); };
process.on('uncaughtException', error => {
    console.log(`FAILURE ${String(error?.message ?? error).split('\n')[0]}`);
    console.log(JSON.stringify(results, null, 1));
    process.exit(2);
});

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const device = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const context = await browser.newContext(device);
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 200)));

const signIn = async p => {
    const { token } = await (await p.request.get(`${base}/csrf-token`)).json();
    if (!(await p.request.post(`${base}/api/users/login`, { headers: { 'X-CSRF-Token': token }, data: { handle, password } })).ok()) throw new Error('login failed');
    return token;
};
const token = await signIn(page);
const story = [{ user_name: 'unused', character_name: 'unused', chat_metadata: {} },
    { name: 'Seraphina', is_user: false, is_system: false, send_date: new Date().toISOString(), extra: {}, mes: 'Hamburgefonstiv 你好' }];
check('story fixture saved', (await page.request.post(`${base}/api/chats/save`, { headers: { 'X-CSRF-Token': token }, data: { ch_name: 'Seraphina', file_name: FILE, chat: story, avatar_url: AVATAR } })).ok());

const fontBytes = await (await page.request.get(`${base}${FONT_PATH}`)).body();
check('fixture font fetched', fontBytes.length > 1000, String(fontBytes.length));

// Font sites, stood in for here. One allows other sites to read its stylesheet; the other does not.
const SITE_CSS = '@font-face { font-family: "Site Font"; src: url("https://fonts.test/site.woff2") format("woff2"); }';
const allow = { 'Access-Control-Allow-Origin': '*' };
await context.route('https://fonts.test/**', route => {
    const url = route.request().url();
    if (url.endsWith('/open.css')) return route.fulfill({ status: 200, contentType: 'text/css', headers: allow, body: SITE_CSS });
    // Reading it from script fails the way a missing CORS header does (a fulfilled route would get the header added);
    // loading it as a stylesheet works.
    if (url.endsWith('/closed.css')) return route.request().resourceType() === 'fetch' ? route.abort() : route.fulfill({ status: 200, contentType: 'text/css', body: SITE_CSS.replace('Site Font', 'Closed Font') });
    if (url.endsWith('/site.woff2') || url.endsWith('/plain.ttf')) return route.fulfill({ status: 200, contentType: 'font/woff2', headers: allow, body: fontBytes });
    return route.fulfill({ status: 404, headers: allow, body: '' });
});

const chatUrl = `${appUrl}#${new URLSearchParams({ chat: AVATAR, file: FILE })}`;
const openChat = async p => {
    await p.goto(chatUrl);
    await p.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
};
const reading = p => p.getByRole('dialog', { name: '阅读设置' });
const openFonts = async p => {
    await p.getByRole('button', { name: '阅读设置' }).click();
    await reading(p).getByRole('button', { name: '更多排版' }).click();
    await reading(p).getByRole('radiogroup', { name: '字体' }).waitFor({ timeout: 30000 });
};
const closeSheet = p => reading(p).getByRole('button', { name: '关闭' }).click();
const fontVar = p => p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tl-font').trim());
const fontStyle = p => p.evaluate(() => document.getElementById('tl-font-css')?.textContent ?? '');
const chosen = async (p, name) => await reading(p).getByRole('radio', { name, exact: true }).getAttribute('aria-checked') === 'true';
const faceStatus = p => p.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter(f => f.family.includes('tl-font-')).map(f => f.status);
});
const accountFonts = async p => {
    const { token: t } = await (await p.request.get(`${base}/csrf-token`)).json();
    const data = await (await p.request.post(`${base}/api/settings/get`, { headers: { 'X-CSRF-Token': t }, data: {} })).json();
    return JSON.parse(data.settings).extension_settings?.tavernLite?.fonts ?? [];
};
const waitFor = async (what, timeout = 20000) => {
    const end = Date.now() + timeout;
    for (;;) {
        const value = await what();
        if (value || Date.now() > end) return value;
        await new Promise(r => setTimeout(r, 500));
    }
};

await openChat(page);
await openFonts(page);

// 1. What is not a font is refused before anything is uploaded.
const uploads = [];
page.on('request', r => { if (r.url().endsWith('/api/files/upload')) uploads.push(r.url()); });
const input = reading(page).getByLabel('选择字体文件');
await input.setInputFiles({ name: 'fake.ttf', mimeType: 'font/ttf', buffer: Buffer.from('this is not a font') });
await reading(page).getByRole('alert').waitFor({ timeout: 30000 });
check('a broken file is refused', (await reading(page).getByRole('alert').innerText()).includes('打不开') && uploads.length === 0, await reading(page).getByRole('alert').innerText());
await input.setInputFiles({ name: 'font.ttc', mimeType: 'font/collection', buffer: fontBytes });
await reading(page).getByText('只支持 ttf').waitFor({ timeout: 30000 });
check('another file type is refused', uploads.length === 0);

// 2. Uploading a file: stored in the account, in use at once.
await input.setInputFiles({ name: '我的字体.woff2', mimeType: 'font/woff2', buffer: fontBytes });
await reading(page).getByRole('radio', { name: '我的字体', exact: true }).waitFor({ timeout: 60000 });
check('the uploaded font is chosen', await chosen(page, '我的字体'));
check('the error went away', await reading(page).getByRole('alert').count() === 0);
check('the reading font is the uploaded one', /^"tl-font-[a-z0-9]+"/.test(await fontVar(page)), await fontVar(page));
const declared = await fontStyle(page);
const fileUrl = declared.match(/url\("([^"]+)"\)/)?.[1] ?? '';
check('it is stored in the account files', fileUrl.startsWith('/user/files/tavern-lite-font-') && fileUrl.endsWith('.woff2'), declared);
check('the browser loaded it', (await waitFor(async () => (await faceStatus(page)).includes('loaded'))) === true, JSON.stringify(await faceStatus(page)));
check('the message body uses it', (await page.locator('.tl-message-body').first().evaluate(el => getComputedStyle(el).fontFamily)).includes('tl-font-'));

// Adding the same bytes under another name reuses the existing resource, without another upload.
const uploadedOnce = uploads.length;
await input.setInputFiles({ name: '同一个字体.woff2', mimeType: 'font/woff2', buffer: fontBytes });
await reading(page).getByRole('button', { name: '上传字体文件', exact: true }).waitFor({ timeout: 30000 });
check('duplicate file is reused without uploading', uploads.length === uploadedOnce && await chosen(page, '我的字体')
    && await reading(page).getByRole('radio', { name: '同一个字体', exact: true }).count() === 0);

// 3. The added font is on the account, and survives a reload without a flash of the system font.
check('saved to the account', !!(await waitFor(async () => (await accountFonts(page)).some(f => f.url === fileUrl))));
await closeSheet(page);
await reading(page).waitFor({ state: 'detached', timeout: 10000 });
await page.waitForTimeout(500);
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!document.querySelector('style#tl-font-css'), null, { timeout: 30000 });
check('declared again after a reload', (await fontStyle(page)).includes(fileUrl));
await page.waitForFunction(() => !!document.querySelector('.tl-composer-input[data-synced="true"]'), null, { timeout: 240000 });
const booted = await context.newPage();
// With the code held back, what is on the page comes from index.html alone.
await booted.route('**/assets/*.js', () => new Promise(() => { }));
await booted.goto(appUrl, { waitUntil: 'commit' });
await booted.waitForFunction(() => !!document.getElementById('tl-font-css'), null, { timeout: 30000 });
check('the loading screen already has it', (await fontStyle(booted)).includes(fileUrl), await fontStyle(booted));
await booted.close();

// 4. A link to a font file.
await openFonts(page);
check('still chosen after the reload', await chosen(page, '我的字体'));
const addLink = async (link, family) => {
    if (!(await reading(page).getByLabel('字体网址').count())) await reading(page).getByRole('button', { name: '填字体网址' }).click();
    await reading(page).getByLabel('字体网址').fill(link);
    if (family) await reading(page).getByLabel('字体名').fill(family);
    await reading(page).getByRole('button', { name: '添加这个字体' }).click();
};
await addLink('https://fonts.test/plain.ttf');
await reading(page).getByRole('radio', { name: 'plain', exact: true }).waitFor({ timeout: 30000 });
check('a font file link is added and chosen', await chosen(page, 'plain') && (await fontStyle(page)).includes('src: url("https://fonts.test/plain.ttf")'), await fontStyle(page));

// 5. A broken link says so.
await addLink('https://fonts.test/missing.woff2');
await reading(page).getByText('加载不了').waitFor({ timeout: 30000 });
check('a dead font link is refused', await reading(page).getByRole('radio', { name: 'missing', exact: true }).count() === 0);

// 6. A font stylesheet, pasted the way font sites offer it.
await addLink(`@import url('https://fonts.test/open.css');`);
await reading(page).getByRole('radio', { name: 'Site Font', exact: true }).waitFor({ timeout: 30000 });
check('a stylesheet link is imported', (await fontStyle(page)) === '@import url("https://fonts.test/open.css");', await fontStyle(page));
check('its declared family is used', (await fontVar(page)).startsWith('"Site Font"'), await fontVar(page));
check('the imported face is available', !!(await waitFor(() => page.evaluate(() => [...document.fonts].some(f => f.family.includes('Site Font'))))));

// Adding the same URL again selects the same entry.
await addLink('https://fonts.test/open.css');
await reading(page).getByRole('button', { name: '填字体网址', exact: true }).waitFor({ timeout: 30000 });
await reading(page).getByLabel('字体网址').waitFor({ state: 'detached', timeout: 30000 });
check('duplicate CSS link is reused', await reading(page).getByRole('radio', { name: 'Site Font', exact: true }).count() === 1
    && await chosen(page, 'Site Font'));

// 7. A stylesheet that does not let other sites read it: the name is asked for.
await addLink('https://fonts.test/closed.css');
await reading(page).getByLabel('字体名').waitFor({ timeout: 30000 });
check('nothing was added before the name is known', await reading(page).getByRole('radio', { name: 'Closed Font', exact: true }).count() === 0);
await addLink('https://fonts.test/closed.css', 'Closed Font');
await reading(page).getByRole('radio', { name: 'Closed Font', exact: true }).waitFor({ timeout: 30000 });
check('with the name it is added', (await fontVar(page)).startsWith('"Closed Font"'), await fontVar(page));

// 8. Only the font in use is declared, and going back to a built-in one removes the declaration.
await reading(page).getByRole('radio', { name: '宋体', exact: true }).click();
check('a built-in font declares nothing', await fontStyle(page) === '', await fontStyle(page));
await reading(page).getByRole('radio', { name: '我的字体', exact: true }).click();
check('choosing again declares only that one', (await fontStyle(page)).includes(fileUrl) && !(await fontStyle(page)).includes('fonts.test'), await fontStyle(page));
check('no horizontal overflow on a phone', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
await page.waitForTimeout(800);
check('all fonts reached the account', !!(await waitFor(async () => (await accountFonts(page)).length === 4)));

// 9. Another device of the same account gets the list and the choice.
await closeSheet(page);
await page.waitForTimeout(1500);
const other = await browser.newContext(device);
const phone = await other.newPage();
await signIn(phone);
await other.route('https://fonts.test/**', route => route.fulfill({ status: 200, contentType: 'font/woff2', headers: allow, body: fontBytes }));
await openChat(phone);
await openFonts(phone);
check('the other device lists the fonts', await reading(phone).getByRole('radio', { name: 'Site Font', exact: true }).count() === 1);
check('and uses the same one', await chosen(phone, '我的字体') && (await fontVar(phone)).includes('tl-font-'), await fontVar(phone));
await other.close();

// 10. Deleting: asks once, removes the file, and falls back to the default.
await openFonts(page);
for (const name of ['Closed Font', 'Site Font', 'plain']) {
    await reading(page).getByRole('radio', { name, exact: true }).click();
    await reading(page).getByRole('button', { name: `删除字体「${name}」` }).click();
    await reading(page).getByRole('button', { name: `确定删除「${name}」` }).click();
    await reading(page).getByRole('radio', { name, exact: true }).waitFor({ state: 'detached', timeout: 10000 });
}
await reading(page).getByRole('radio', { name: '我的字体', exact: true }).click();
await reading(page).getByRole('button', { name: '删除字体「我的字体」' }).click();
await reading(page).getByRole('button', { name: '取消' }).click();
check('cancelling keeps it', await reading(page).getByRole('radio', { name: '我的字体', exact: true }).count() === 1);
await reading(page).getByRole('button', { name: '删除字体「我的字体」' }).click();
await reading(page).getByRole('button', { name: '确定删除「我的字体」' }).click();
await reading(page).getByRole('radio', { name: '我的字体', exact: true }).waitFor({ state: 'detached', timeout: 10000 });
check('after deleting the choice is the default', await chosen(page, '默认'));
check('and nothing is declared', await fontStyle(page) === '', await fontStyle(page));
check('the file is gone', !!(await waitFor(async () => (await page.request.get(`${base}${fileUrl}`)).status() === 404)));
check('the account list is empty', !!(await waitFor(async () => (await accountFonts(page)).length === 0)));
await closeSheet(page);

await page.request.post(`${base}/api/chats/delete`, { headers: { 'X-CSRF-Token': token }, data: { chatfile: `${FILE}.jsonl`, avatar_url: AVATAR } }).catch(() => { });
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(JSON.stringify(results, null, 1));
await browser.close();
console.log(problems.length ? `PROBLEMS ${problems.length}` : 'ALL PASS');
process.exit(problems.length ? 1 : 0);
