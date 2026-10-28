// Renders src/public/icon.svg into the PNG icons the manifest and iOS use. Usage: node make-icons.mjs
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const dir = new URL('../../src/public/', import.meta.url);
const svg = await readFile(new URL('icon.svg', dir), 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage();
// Rounded for the plain icons; full bleed for "maskable" (the system cuts its own shape) and Apple (it rounds itself).
const shots = [
    ['icon-192.png', 192, true], ['icon-512.png', 512, true], ['icon-maskable-512.png', 512, false], ['apple-touch-icon.png', 180, false],
];
for (const [name, size, rounded] of shots) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;overflow:hidden;border-radius:${rounded ? size * 0.22 : 0}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body></html>`);
    await page.screenshot({ path: new URL(name, dir).pathname, omitBackground: true });
}
await browser.close();
console.log('icons written');
