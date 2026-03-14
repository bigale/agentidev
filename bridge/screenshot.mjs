import { chromium } from 'playwright';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const PROFILE = resolve(process.env.HOME, '.contextual-recall', 'browser-profile');

// Try to find CDP port from the browser profile
try {
  const portData = readFileSync(resolve(PROFILE, 'DevToolsActivePort'), 'utf-8');
  const port = portData.split('\n')[0].trim();
  console.log('Found CDP port:', port);
  
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  const contexts = browser.contexts();
  console.log('Contexts:', contexts.length);
  
  for (const ctx of contexts) {
    const pages = ctx.pages();
    for (const page of pages) {
      const url = page.url();
      console.log('Page:', url);
      if (url.includes('dashboard')) {
        await page.screenshot({ path: '/tmp/dashboard-screenshot.png', fullPage: true });
        console.log('Screenshot saved: /tmp/dashboard-screenshot.png');
      }
    }
  }
} catch (e) {
  console.error('Error:', e.message);
  
  // Fallback: try common port
  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const pages = browser.contexts()[0]?.pages() || [];
    for (const page of pages) {
      if (page.url().includes('dashboard')) {
        await page.screenshot({ path: '/tmp/dashboard-screenshot.png', fullPage: true });
        console.log('Screenshot saved via fallback');
      }
    }
  } catch (e2) {
    console.error('Fallback failed:', e2.message);
  }
}

process.exit(0);
