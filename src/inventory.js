/**
 * inventory.js — Walk the Loop sidebar and build a tree of workspaces/pages.
 *
 * Returns a manifest object (also written to manifest.json) with shape:
 * {
 *   generatedAt: ISO string,
 *   workspaces: [
 *     {
 *       id, title, url,
 *       pages: [
 *         { id, title, url, depth, parentId, children: [...] }
 *       ]
 *     }
 *   ]
 * }
 *
 * Strategy for SPA navigation:
 * 1. Click each workspace to load its page tree.
 * 2. Walk the tree recursively, expanding collapsed nodes.
 * 3. Capture URL, title, depth, and parent for each page.
 * 4. Use multi-selector fallbacks throughout (see selectors.js).
 */

import path from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import {
  WORKSPACE_LIST_SELECTORS,
  WORKSPACE_ITEM_SELECTORS,
  PAGE_ITEM_SELECTORS,
  EXPAND_BUTTON_SELECTORS,
  findFirst,
  findAll,
  elementLabel,
  safeAttr,
} from './selectors.js';
import { LOOP_URL } from './browser.js';

// ─── Main inventory entry point ───────────────────────────────────────────────

/**
 * @param {import('playwright').Page} page  Already-authenticated Loop page.
 * @param {object} opts
 * @param {string} opts.outputDir           Where to write manifest.json
 * @param {boolean} [opts.verbose]
 * @returns {Promise<object>}               The manifest object
 */
export async function runInventory(page, { outputDir, verbose = false }) {
  log('🔍 Starting inventory pass…');

  // Make sure we're on the Loop home (workspace list)
  if (!(page.url().includes('loop.microsoft.com') || page.url().includes('loop.cloud.microsoft'))) {
    await page.goto(LOOP_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  }

  // Allow SPA to settle
  await page.waitForTimeout(3_000);

  // ── Step 1: Enumerate workspaces ──────────────────────────────────────────
  const workspaceData = await enumerateWorkspaces(page, verbose);
  log(`📦 Found ${workspaceData.length} workspace(s)`);

  // ── Step 2: For each workspace, enumerate its pages ───────────────────────
  for (const ws of workspaceData) {
    log(`\n📂 Workspace: "${ws.title}" — navigating…`);
    try {
      await navigateToWorkspace(page, ws);
      await page.waitForTimeout(2_500);
      ws.pages = await enumeratePages(page, ws, verbose);
      log(`   ↳ ${countPages(ws.pages)} page(s) found`);
    } catch (err) {
      console.warn(`   ⚠️  Failed to inventory workspace "${ws.title}": ${err.message}`);
      ws.pages = [];
      ws.error = err.message;
    }
  }

  // ── Step 3: Build manifest ────────────────────────────────────────────────
  const manifest = {
    generatedAt: new Date().toISOString(),
    loopUrl: LOOP_URL,
    totalWorkspaces: workspaceData.length,
    totalPages: workspaceData.reduce((n, ws) => n + countPages(ws.pages), 0),
    workspaces: workspaceData,
  };

  // Write manifest.json
  mkdirSync(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  log(`\n✅ Manifest written → ${manifestPath}`);

  return manifest;
}

// ─── Workspace enumeration ────────────────────────────────────────────────────

async function enumerateWorkspaces(page, verbose) {
  // Strategy A: look for workspace list container, then items inside
  const listEl = await findFirst(page, WORKSPACE_LIST_SELECTORS, 5000);

  let items = [];
  if (listEl) {
    items = await findAll(listEl, WORKSPACE_ITEM_SELECTORS);
    if (verbose) log(`  [selectors] workspace list found, ${items.length} item(s)`);
  }

  // Strategy B: fallback — scan the whole sidebar for clickable workspace entries
  if (!items.length) {
    log('  ⚠️  Workspace list not found via primary selectors, trying fallback…');
    items = await fallbackWorkspaceItems(page);
  }

  // Strategy C: try to read the workspace entries from the page's JS/network state
  if (!items.length) {
    log('  ⚠️  Fallback also found nothing. Trying URL/API intercept strategy…');
    return await apiInterceptWorkspaces(page, verbose);
  }

  const workspaces = [];
  for (const item of items) {
    const title = await elementLabel(item);
    const href = await safeAttr(item, 'href') || await linkHref(item);
    const id = await safeAttr(item, 'data-workspace-id') ||
               await safeAttr(item, 'data-id') ||
               slugifyTitle(title) + '_' + workspaces.length;

    if (!title) continue; // skip empty/invisible items

    workspaces.push({
      id,
      title,
      url: href ? resolveUrl(href) : null,
      element: null, // don't store handles — stale after nav
      pages: [],
    });

    if (verbose) log(`  ws: "${title}" → ${href || '(no href)'}`);
  }

  return workspaces;
}

async function fallbackWorkspaceItems(page) {
  // Try broad selectors for any clickable sidebar elements
  const candidates = [
    'aside [role="button"]',
    'aside a',
    'nav [role="button"]',
    'nav a[href*="loop"]',
    '[class*="sidebar"] li',
    '[class*="Sidebar"] li',
  ];
  return findAll(page, candidates);
}

/**
 * If DOM scraping fails, intercept the Loop API to get workspace list.
 * Loop makes calls to graph.microsoft.com or loop internal APIs.
 */
async function apiInterceptWorkspaces(page, verbose) {
  log('  🌐 Intercepting API responses for workspace data…');
  const captured = [];

  // Listen for XHR/fetch responses that might contain workspace info
  page.on('response', async (response) => {
    const url = response.url();
    if (
      (url.includes('workspaces') || url.includes('containers') || url.includes('drives')) &&
      response.headers()['content-type']?.includes('json')
    ) {
      try {
        const body = await response.json();
        if (verbose) log(`  [api] ${url} → ${JSON.stringify(body).slice(0, 120)}`);
        captured.push({ url, body });
      } catch { /* ignore */ }
    }
  });

  // Reload to trigger API calls
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForTimeout(3_000);

  // Parse captured responses
  const workspaces = [];
  for (const { url, body } of captured) {
    const items = body?.value || body?.workspaces || body?.items || [];
    for (const item of items) {
      const title = item.displayName || item.name || item.title || null;
      if (!title) continue;
      workspaces.push({
        id: item.id || item.driveId || slugifyTitle(title),
        title,
        url: item.webUrl || item.url || null,
        pages: [],
      });
    }
  }

  if (!workspaces.length) {
    // Last resort: manual instruction
    console.warn(
      '\n⚠️  Could not auto-discover workspaces. Loop may have changed its DOM/API.\n' +
      '   Please check selectors.js and update WORKSPACE_LIST_SELECTORS.\n' +
      '   You can also run with --verbose and inspect the logged selectors.\n'
    );
  }

  return workspaces;
}

// ─── Navigate to a workspace ──────────────────────────────────────────────────

async function navigateToWorkspace(page, ws) {
  if (ws.url) {
    await page.goto(ws.url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    return;
  }

  // Try clicking the workspace item in the sidebar by its title
  const clicked = await clickSidebarItem(page, ws.title);
  if (!clicked) {
    throw new Error(`Could not navigate to workspace "${ws.title}" — no URL and sidebar click failed`);
  }
  await page.waitForTimeout(2_000);
}

async function clickSidebarItem(page, title) {
  const escapedTitle = title.replace(/'/g, "\\'");
  const strategies = [
    // aria-label exact match
    `[aria-label="${title}"]`,
    // text content
    `text="${title}"`,
    // partial text
    `text*="${title.slice(0, 20)}"`,
  ];

  for (const sel of strategies) {
    try {
      await page.click(sel, { timeout: 3000 });
      return true;
    } catch { /* try next */ }
  }
  return false;
}

// ─── Page enumeration ─────────────────────────────────────────────────────────

/**
 * Walk the page tree in the currently-active workspace sidebar.
 * Returns a flat list annotated with depth/parentId, plus a nested `children` field.
 */
async function enumeratePages(page, workspace, verbose) {
  // Expand all collapsible nodes first (multiple passes)
  await expandAllNodes(page, verbose);

  // Loop virtualizes the page tree. Force-render by scrolling the tree container
  // and expanding as we go until the item count stops increasing.
  await fullyMaterializePageTree(page, verbose);

  // Now collect all page tree items
  const allItems = await findAll(page, PAGE_ITEM_SELECTORS);

  if (!allItems.length) {
    log('  ⚠️  No page items found. Trying API intercept for pages…');
    return await apiInterceptPages(page, workspace, verbose);
  }

  // Build page list from DOM items
  const pages = [];
  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];
    try {
      const title = await elementLabel(item);
      if (!title || title === workspace.title) continue; // skip workspace root

      const href = await linkHref(item);
      const depth = await getItemDepth(item);
      const id = await safeAttr(item, 'data-page-id') ||
                 await safeAttr(item, 'data-id') ||
                 slugifyTitle(title) + '_' + i;

      // Loop page tree items often don't expose an href. If we can't find one,
      // click the item and capture the current URL as the canonical page URL.
      let url = href ? resolveUrl(href) : null;
      if (!url) {
        try {
          await item.click({ timeout: 2500 });
          await page.waitForTimeout(1200);
          const current = page.url();
          if (current && (current.includes('loop.microsoft.com') || current.includes('loop.cloud.microsoft')) && !current.includes('/learn')) {
            url = current;
          }
        } catch { /* ignore */ }
      }

      pages.push({
        id,
        title,
        url,
        depth,
        parentId: null, // will be resolved below
        children: [],
      });

      if (verbose) log(`  page[${depth}] "${title}" → ${url || href || '?'}`);
    } catch (err) {
      if (verbose) log(`  [warn] item ${i}: ${err.message}`);
    }
  }

  // Resolve parent/child relationships by depth
  resolveParents(pages);

  return pages;
}

/**
 * Expand all collapsed tree nodes by clicking expand buttons repeatedly
 * until no more collapsed nodes exist (or a max iteration cap).
 */
async function expandAllNodes(page, verbose) {
  let iterations = 0;
  const maxIterations = 10;

  while (iterations < maxIterations) {
    const expandBtns = await findAll(page, [
      '[aria-expanded="false"]',
      ...EXPAND_BUTTON_SELECTORS,
    ]);

    // Filter to only actually-collapsed buttons
    const collapsed = [];
    for (const btn of expandBtns) {
      const expanded = await safeAttr(btn, 'aria-expanded');
      if (expanded === 'false') collapsed.push(btn);
    }

    if (!collapsed.length) break;
    if (verbose) log(`  [expand] iteration ${iterations + 1}: ${collapsed.length} node(s) to expand`);

    for (const btn of collapsed) {
      try { await btn.click({ timeout: 1500 }); } catch { /* ignore stale */ }
    }
    await page.waitForTimeout(1_000);
    iterations++;
  }
}

async function apiInterceptPages(page, workspace, verbose) {
  // Reload workspace page and capture page-list API responses
  if (workspace.url) {
    await page.goto(workspace.url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  }

  const captured = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (
      (url.includes('pages') || url.includes('items') || url.includes('children')) &&
      response.headers()['content-type']?.includes('json')
    ) {
      try {
        const body = await response.json();
        captured.push({ url, body });
      } catch { /* ignore */ }
    }
  });

  await page.waitForTimeout(5_000);

  const pages = [];
  for (const { body } of captured) {
    const items = body?.value || body?.pages || body?.children || [];
    for (const item of items) {
      const title = item.displayName || item.name || item.title || null;
      if (!title) continue;
      pages.push({
        id: item.id || slugifyTitle(title),
        title,
        url: item.webUrl || item.url || null,
        depth: 0,
        parentId: null,
        children: [],
      });
    }
  }

  return pages;
}

// ─── Tree helpers ─────────────────────────────────────────────────────────────

/**
 * Infer item depth from CSS indentation (padding-left) or aria-level.
 */
async function getItemDepth(el) {
  // Loop uses nested/virtualized Fluent Tree components. The element we select
  // might be an inner layout node that doesn't carry aria-level.
  //
  // Depth strategy:
  // 1) aria-level on self
  // 2) aria-level on closest ancestor treeitem
  // 3) DOM nesting: count ancestor role="group" containers
  // 4) fallback: indentation via padding/margin

  try {
    const ariaLevel = await el.getAttribute('aria-level');
    if (ariaLevel) return Math.max(0, parseInt(ariaLevel, 10) - 1);
  } catch { /* ignore */ }

  try {
    const computed = await el.evaluate((node) => {
      const treeItem = node.closest?.('[role="treeitem"]') || node;

      const levelAttr = treeItem?.getAttribute?.('aria-level');
      if (levelAttr) {
        const n = parseInt(levelAttr, 10);
        if (!Number.isNaN(n)) return { kind: 'aria-level', depth: Math.max(0, n - 1) };
      }

      // DOM-based depth: count role="group" ancestors (common pattern in trees)
      let depth = 0;
      let p = treeItem?.parentElement;
      while (p) {
        if (p.getAttribute?.('role') === 'group') depth++;
        p = p.parentElement;
      }
      if (depth > 0) return { kind: 'dom-group', depth };

      // Style-based fallback
      const style = window.getComputedStyle(treeItem);
      const pl = parseInt(style.paddingLeft || '0', 10) || 0;
      const ml = parseInt(style.marginLeft || '0', 10) || 0;
      const indent = Math.max(pl, ml);
      return { kind: 'indent', depth: Math.max(0, Math.round(indent / 20)) };
    });

    return computed?.depth ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Walk the flat page list and set parentId based on depth changes.
 */
function resolveParents(pages) {
  const stack = []; // stack of { depth, id }

  for (const page of pages) {
    // Pop stack until we find a shallower parent
    while (stack.length && stack[stack.length - 1].depth >= page.depth) {
      stack.pop();
    }

    if (stack.length) {
      page.parentId = stack[stack.length - 1].id;
      // Add to parent's children array
      const parent = pages.find((p) => p.id === page.parentId);
      if (parent) parent.children.push(page.id);
    }

    stack.push({ depth: page.depth, id: page.id });
  }
}

function countPages(pages) {
  if (!Array.isArray(pages)) return 0;
  return pages.length;
}

/**
 * Force Loop's virtualized tree to render by scrolling the likely tree container.
 * Re-expands collapsed nodes between scroll passes.
 */
async function fullyMaterializePageTree(page, verbose) {
  const maxPasses = 12;
  let lastCount = -1;

  for (let pass = 1; pass <= maxPasses; pass++) {
    // Expand anything currently visible
    await expandAllNodes(page, verbose);

    // Count visible tree items
    const items = await findAll(page, PAGE_ITEM_SELECTORS);
    const count = items.length;
    if (verbose) log(`  [tree] pass ${pass}: visible page items=${count}`);

    if (count > 0 && count === lastCount) {
      // No growth since last pass. Probably fully materialized.
      break;
    }
    lastCount = count;

    // Try to scroll the tree container; fall back to scrolling the sidebar/nav.
    const scrollSelectors = [
      '[role="tree"]',
      'nav[role="navigation"]',
      'aside',
      '[class*="sidebar"]',
      '[class*="Sidebar"]',
      'body',
    ];

    let scrolled = false;
    for (const sel of scrollSelectors) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        await el.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        scrolled = true;
        break;
      } catch { /* try next */ }
    }

    if (!scrolled) {
      try {
        await page.mouse.wheel(0, 2000);
      } catch {}
    }

    await page.waitForTimeout(800);
  }
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

async function linkHref(el) {
  // Try el itself, then find an <a> inside
  const href = await safeAttr(el, 'href');
  if (href) return href;
  try {
    const a = await el.$('a');
    if (a) return safeAttr(a, 'href');
  } catch { /* ignore */ }
  return null;
}

function resolveUrl(href) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  return new URL(href, LOOP_URL).href;
}

function slugifyTitle(title) {
  if (!title) return 'untitled';
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function log(...args) {
  console.log(...args);
}
