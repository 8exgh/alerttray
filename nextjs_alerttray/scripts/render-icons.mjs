// Renders the PWA / home-screen icons in public/icons from inline SVG.
// Run: node scripts/render-icons.mjs   (needs @playwright/test's Chromium)
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// Bell + tray, drawn on a 512 grid. `scale` shrinks it into the maskable safe zone.
const bell = (fill, scale = 1) => `
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)" fill="${fill}">
    <path d="M256 96c-13 0-24 11-24 24v10c-58 11-98 60-98 120v62l-30 40c-6 8 0 20 10 20h284c10 0 16-12 10-20l-30-40v-62c0-60-40-109-98-120v-10c0-13-11-24-24-24z"/>
    <path d="M212 388h88c0 24-20 44-44 44s-44-20-44-44z"/>
  </g>`;

const icons = [
  { file: 'icon-192.png', size: 192, svg: `<rect width="512" height="512" fill="#4f46e5"/>${bell('#fff', 0.92)}` },
  { file: 'icon-512.png', size: 512, svg: `<rect width="512" height="512" fill="#4f46e5"/>${bell('#fff', 0.92)}` },
  { file: 'maskable-512.png', size: 512, svg: `<rect width="512" height="512" fill="#4f46e5"/>${bell('#fff', 0.7)}` },
  { file: 'apple-touch-icon.png', size: 180, svg: `<rect width="512" height="512" fill="#4f46e5"/>${bell('#fff', 0.85)}` },
  { file: 'badge-96.png', size: 96, svg: bell('#fff', 1.1), transparent: true }
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const icon of icons) {
  await page.setViewportSize({ width: icon.size, height: icon.size });
  await page.setContent(`<html><body style="margin:0;background:transparent">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${icon.size}" height="${icon.size}">${icon.svg}</svg>
  </body></html>`);
  await page.screenshot({ path: path.join(out, icon.file), omitBackground: !!icon.transparent });
  console.log('wrote', icon.file);
}
await browser.close();
