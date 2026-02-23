/**
 * inspector.js — DOM diagnostics tool to help tune selectors.js.
 *
 * Run via: node src/cli.js inspect [--url <loop-page-url>]
 *
 * Prints:
 *  - Which selectors from selectors.js matched / didn't match
 *  - The top-level class names and roles in the page
 *  - Sidebar tree structure
 *  - Network requests that look like Loop API calls
 */

import { setTimeout } from 'node:timers/promises';
import {
  WORKSPACE_LIST_SELECTORS,
  WORKSPACE_ITEM_SELECTORS,
  PAGE_ITEM_SELECTORS,
  PAGE_CONTENT_SELECTORS,
  PAGE_TITLE_SELECTORS,
} from './selectors.js';

export async function runInspector(page) {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Loop DOM Inspector — checking selectors');
  console.log(`  URL: ${page.url()}`);
  console.log('═══════════════════════════════════════════════════\n');

  // ── Selector hit-testing ─────────────────────────────────────────────────
  const groups = {
    'WORKSPACE_LIST_SELECTORS': WORKSPACE_LIST_SELECTORS,
    'WORKSPACE_ITEM_SELECTORS': WORKSPACE_ITEM_SELECTORS,
    'PAGE_ITEM_SELECTORS': PAGE_ITEM_SELECTORS,
    'PAGE_CONTENT_SELECTORS': PAGE_CONTENT_SELECTORS,
    'PAGE_TITLE_SELECTORS': PAGE_TITLE_SELECTORS,
  };

  for (const [groupName, selectors] of Object.entries(groups)) {
    console.log(`\n▶ ${groupName}`);
    for (const sel of selectors) {
      try {
        const count = await page.$$eval(sel, (els) => els.length);
        const status = count > 0 ? `✅ ${count} match(es)` : '❌ 0 matches';
        console.log(`  ${status.padEnd(20)} ${sel}`);
        if (count > 0 && count <= 5) {
          // Print text snippets for small result sets
          const texts = await page.$$eval(sel, (els) =>
            els.map((el) => (el.textContent || el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 60))
          );
          texts.forEach((t) => { if (t) console.log(`    → "${t}"`); });
        }
      } catch (err) {
        console.log(`  ⚠️  ERROR                ${sel} — ${err.message}`);
      }
    }
  }

  // ── Top-level roles ──────────────────────────────────────────────────────
  console.log('\n▶ Elements with [role] attributes (top 20):');
  try {
    const roles = await page.$$eval('[role]', (els) =>
      els.slice(0, 20).map((el) => ({
        role: el.getAttribute('role'),
        tag: el.tagName,
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 50),
        cls: el.className?.toString().slice(0, 60) || '',
      }))
    );
    for (const r of roles) {
      console.log(`  [${r.role}] <${r.tag.toLowerCase()}> ${r.label ? '"' + r.label + '"' : ''}`);
      if (r.cls) console.log(`    class: ${r.cls}`);
    }
  } catch (err) {
    console.warn('  Could not enumerate roles:', err.message);
  }

  // ── Aside / nav structure ────────────────────────────────────────────────
  console.log('\n▶ Sidebar structure (aside/nav children, depth 2):');
  try {
    const sidebarInfo = await page.evaluate(() => {
      const root = document.querySelector('aside') || document.querySelector('nav');
      if (!root) return 'No aside or nav found';
      function describe(el, depth) {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || '';
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40);
        const cls = (el.className || '').toString().slice(0, 50);
        let out = '  '.repeat(depth) + `<${tag}${role ? ' role="' + role + '"' : ''}> ${label ? '"' + label + '"' : ''} [${cls}]\n`;
        if (depth < 2) {
          for (const child of el.children) {
            out += describe(child, depth + 1);
          }
        }
        return out;
      }
      return describe(root, 0).slice(0, 3000);
    });
    console.log(sidebarInfo);
  } catch (err) {
    console.warn('  Could not inspect sidebar:', err.message);
  }

  // ── Page title ───────────────────────────────────────────────────────────
  console.log('\n▶ Page title check:');
  try {
    const title = await page.title();
    console.log(`  document.title = "${title}"`);
    const h1 = await page.$eval('h1', (el) => el.textContent.trim()).catch(() => null);
    if (h1) console.log(`  <h1> = "${h1}"`);
  } catch { /* ignore */ }

  // ── Network API calls ────────────────────────────────────────────────────
  console.log('\n▶ Monitoring network for 5s (Loop/Graph API calls)…');
  const apiCalls = [];
  const onResponse = (response) => {
    const url = response.url();
    if (
      url.includes('graph.microsoft.com') ||
      url.includes('loop.microsoft.com') ||
      url.includes('sharepoint.com')
    ) {
      apiCalls.push(`${response.status()} ${url.slice(0, 120)}`);
    }
  };
  page.on('response', onResponse);
  await page.reload({ waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
  await setTimeout(3000);
  page.off('response', onResponse);

  console.log(`  Captured ${apiCalls.length} API response(s):`);
  apiCalls.slice(0, 30).forEach((c) => console.log(`  ${c}`));

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Inspection complete. Use the above to update selectors.js.');
  console.log('═══════════════════════════════════════════════════\n');
}
