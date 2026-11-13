/** Re-render checked-in icon PNGs from the source SVG. Requires Playwright Chromium. */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const browser = await chromium.launch({ ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const svg = await readFile('extension/icons/logo.svg', 'utf8');
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`);
    await page.screenshot({ path: `extension/icons/icon-${size}.png`, omitBackground: true });
  }
  console.log('Rendered 16/32/48/128px extension icons from logo.svg');
} finally { await browser.close(); }
