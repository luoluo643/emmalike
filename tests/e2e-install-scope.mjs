// Dedicated disposable instance ONLY. Requires its absolute host tests directory as second argument.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [base, rootArg] = process.argv.slice(2);
if (!base || !rootArg) throw new Error('Pass an isolated URL and its tests directory');
const root = path.resolve(rootArg), globalDir = path.join(root, 'extensions/emmalike');
const personal = path.join(root, 'data/default-user/extensions/emmalike');
const backup = path.join(root, 'install-scope-backup-' + Date.now());
assert.ok(globalDir.startsWith(root + path.sep) && personal.startsWith(root + path.sep) && backup.startsWith(root + path.sep));
await fs.access(path.join(root, 'installation.json'));
await assert.rejects(fs.access(personal));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const a = await browser.newContext(), b = await browser.newContext();
const aToken = (await (await a.request.get(base + '/csrf-token')).json()).token;
const post = (p, d) => a.request.post(base + p, { headers: { 'X-CSRF-Token': aToken }, data: d });
await post('/api/users/login', { handle: 'default-user', password: 'test1234' });
const user = 'install-b-' + Date.now().toString(36);
await post('/api/users/create', { handle: user, name: '安装测试B', password: 'test-b-password', admin: false });
const bToken = (await (await b.request.get(base + '/csrf-token')).json()).token;
await b.request.post(base + '/api/users/login', { headers: { 'X-CSRF-Token': bToken }, data: { handle: user, password: 'test-b-password' } });
const discover = async c => (await (await c.request.get(base + '/api/extensions/discover')).json()).find(x => x.name === 'third-party/emmalike');
const app = base + '/scripts/extensions/third-party/emmalike/app/';
const result = {};
let moved = false, copied = false;
try {
    result.globalA = await discover(a); result.globalB = await discover(b);
    assert.equal(result.globalA.type, 'global'); assert.equal(result.globalB.type, 'global');
    result.globalBUrl = (await b.request.get(app)).status(); assert.equal(result.globalBUrl, 200);
    const page = await b.newPage(); await page.goto(app + '#me'); await page.getByRole('button', { name: /^我的摘录/ }).waitFor();
    result.newAccountGlobalEntry = true; await page.close();
    await fs.mkdir(path.dirname(personal), { recursive: true });
    await fs.cp(globalDir, personal, { recursive: true }); copied = true;
    await fs.rename(globalDir, backup); moved = true;
    result.personalA = await discover(a); result.personalB = await discover(b) || null;
    assert.equal(result.personalA.type, 'local'); assert.equal(result.personalB, null);
    result.personalAUrl = (await a.request.get(app)).status(); result.personalBUrl = (await b.request.get(app)).status();
    assert.equal(result.personalAUrl, 200);
    const own = await a.newPage(); await own.goto(app + '#me'); await own.getByRole('button', { name: /^我的摘录/ }).waitFor();
    result.personalAEntry = true;
    console.log(JSON.stringify(result, null, 2));
    console.log('PASS 全局安装新账号可发现并打开；个人安装只在A发现，B需要安装；URL状态单独记录，不据此推导安全隔离');
} finally {
    if (moved) await fs.rename(backup, globalDir);
    if (copied) await fs.rm(personal, { recursive: true, force: true });
    await browser.close();
}
