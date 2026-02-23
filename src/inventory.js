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
 * Strategy:
 * 1. Discover workspaces only from the CENTER gallery (main content). Never the left sidebar.
 * 2. For each workspace, open it (click its card or go to URL).
 * 3. Enumerate pages only from the EXPANDABLE sidebar (appears when workspace is selected).
 * 4. Expand carets in that sidebar to get sub-pages. Use selectors.js for fallbacks.
 */

import path from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { setTimeout } from 'node:timers/promises';
import {
  WORKSPACE_GALLERY_CONTAINER_SELECTORS,
  WORKSPACE_GALLERY_CARD_SELECTORS,
  PAGE_ITEM_SELECTORS,
  EXPAND_BUTTON_SELECTORS,
  EXPAND_INSIDE_TREEITEM_SELECTORS,
  EXPANDABLE_SIDEBAR_CONTAINER_SELECTORS,
  PAGE_TREE_SELECTORS,
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

  // Make sure we're on the Loop home (center gallery view)
  if (!(page.url().includes('loop.microsoft.com') || page.url().includes('loop.cloud.microsoft'))) {
    await page.goto(LOOP_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  }

  // Allow SPA to settle
  await setTimeout(3_000);

  // ── Step 1: Enumerate workspaces ──────────────────────────────────────────
  const workspaceData = await enumerateWorkspaces(page, verbose);
  log(`📦 Found ${workspaceData.length} workspace(s)`);

  // ── Step 2: For each workspace, enumerate its pages ───────────────────────
  for (const ws of workspaceData) {
    log(`\n📂 Workspace: "${ws.title}" — navigating…`);
    try {
      await navigateToWorkspace(page, ws);
      await setTimeout(2_500);
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

// ─── Workspace enumeration (center gallery only — never the left sidebar) ───────

async function enumerateWorkspaces(page, verbose) {
  // Only discover from the main content area (gallery of workspace cards).
  const galleryEl = await findFirst(page, WORKSPACE_GALLERY_CONTAINER_SELECTORS, 5000);

  let items = [];
  if (galleryEl) {
    items = await findAll(galleryEl, WORKSPACE_GALLERY_CARD_SELECTORS);
    if (verbose) log(`  [gallery] workspace cards in main content: ${items.length}`);
  }

  // If no gallery cards found, try API intercept (do not fall back to left sidebar).
  if (!items.length) {
    log('  ⚠️  No workspace cards in main content. Trying API intercept…');
    return await apiInterceptWorkspaces(page, verbose);
  }

  const workspaces = [];
  const seenTitles = new Set();
  for (const item of items) {
    const title = await elementLabel(item);
    const href = await safeAttr(item, 'href') || await linkHref(item);
    const id = await safeAttr(item, 'data-workspace-id') ||
               await safeAttr(item, 'data-id') ||
               slugifyTitle(title) + '_' + workspaces.length;

    if (!title || seenTitles.has(title)) continue;
    seenTitles.add(title);

    workspaces.push({
      id,
      title,
      url: href ? resolveUrl(href) : null,
      pages: [],
    });

    if (verbose) log(`  ws: "${title}" → ${href || '(no href)'}`);
  }

  return workspaces;
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
  await setTimeout(3_000);

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
      '   Please check selectors.js and update WORKSPACE_GALLERY_* selectors.\n' +
      '   You can also run with --verbose and inspect the logged selectors.\n'
    );
  }

  return workspaces;
}

// ─── Navigate to a workspace ──────────────────────────────────────────────────

async function navigateToWorkspace(page, ws) {
  if (ws.url) {
    await page.goto(ws.url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await setTimeout(2_500);
    return;
  }

  // Click the workspace card in the center gallery (not the left sidebar).
  const clicked = await clickGalleryWorkspaceCard(page, ws.title);
  if (!clicked) {
    throw new Error(`Could not open workspace "${ws.title}" — no URL and gallery card click failed`);
  }
  await setTimeout(2_500);
}

/** Click a workspace card in the main content gallery by title. */
async function clickGalleryWorkspaceCard(page, title) {
  const galleryEl = await findFirst(page, WORKSPACE_GALLERY_CONTAINER_SELECTORS, 3000);
  if (!galleryEl) return false;

  const cards = await findAll(galleryEl, WORKSPACE_GALLERY_CARD_SELECTORS);
  for (const card of cards) {
    try {
      const label = await elementLabel(card);
      if (label && (label === title || label.includes(title) || title.includes(label))) {
        await card.click({ timeout: 3000 });
        return true;
      }
    } catch { /* try next card */ }
  }
  return false;
}

// ─── Page enumeration (expandable sidebar only — not the left sidebar) ─────────

/**
 * Get the root element of the expandable sidebar that shows pages for the current
 * workspace. We must not use the left nav for the page tree.
 * @returns {Promise<import('playwright').ElementHandle|null>}
 */
async function getExpandableSidebarRoot(page) {
  return findFirst(page, EXPANDABLE_SIDEBAR_CONTAINER_SELECTORS, 3000);
}

/**
 * Walk the page tree in the expandable sidebar (the one that appears when a workspace is open).
 * Returns a flat list annotated with depth/parentId, plus a nested `children` field.
 */
async function enumeratePages(page, workspace, verbose) {
  const sidebarRoot = await getExpandableSidebarRoot(page);
  if (verbose && sidebarRoot) log('  [expandable sidebar] found; scoping page tree to it.');

  // Expand carets only in the expandable sidebar
  await expandAllNodes(page, verbose, sidebarRoot);

  // Scroll and expand until the tree is fully visible (within expandable sidebar)
  await fullyMaterializePageTree(page, verbose, sidebarRoot);

  // Collect page items only from the expandable sidebar
  const allItems = sidebarRoot
    ? await findAll(sidebarRoot, PAGE_ITEM_SELECTORS)
    : await findAll(page, PAGE_ITEM_SELECTORS);

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
          await setTimeout(1200);
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
 * Expand all collapsed tree nodes in the page tree (expandable sidebar only when root given).
 * Clicks expand/caret controls; repeats until no progress or max iterations.
 */
async function expandAllNodes(page, verbose, sidebarRoot = null) {
  const root = sidebarRoot || page;
  let iterations = 0;
  const maxIterations = 20;

  while (iterations < maxIterations) {
    // Find collapsed tree items within the expandable sidebar (or full page if no root)
    const collapsedTreeItems = await root.$$('[role="treeitem"][aria-expanded="false"]');

    if (!collapsedTreeItems.length) {
      // Fallback: expand buttons within the same scope
      const expandBtns = await findAll(root, [
        '[aria-expanded="false"]',
        ...EXPAND_BUTTON_SELECTORS,
      ]);
      const collapsed = [];
      for (const btn of expandBtns) {
        const expanded = await safeAttr(btn, 'aria-expanded');
        if (expanded === 'false') collapsed.push(btn);
      }
      if (!collapsed.length) break;
      if (verbose) log(`  [expand] iteration ${iterations + 1}: ${collapsed.length} expand button(s) (fallback)`);
      for (const btn of collapsed) {
        try {
          await btn.evaluate((el) => el.scrollIntoView({ block: 'nearest', behavior: 'auto' }));
          await setTimeout(150);
          await btn.click({ timeout: 1500 });
        } catch { /* ignore stale */ }
        await setTimeout(200);
      }
    } else {
      if (verbose) log(`  [expand] iteration ${iterations + 1}: ${collapsedTreeItems.length} collapsed tree item(s)`);

      for (const treeItem of collapsedTreeItems) {
        try {
          // Scroll the tree item into view so the expand control is visible (helps virtualized trees)
          await treeItem.evaluate((el) => el.scrollIntoView({ block: 'nearest', behavior: 'auto' }));
          await setTimeout(150);

          // Prefer clicking the expand/caret control *inside* the tree item
          let clicked = false;
          for (const sel of EXPAND_INSIDE_TREEITEM_SELECTORS) {
            try {
              const expandEl = await treeItem.$(sel);
              if (expandEl) {
                await expandEl.click({ timeout: 1200 });
                clicked = true;
                break;
              }
            } catch { /* try next selector */ }
          }

          // If no inner expand control worked, click the tree item row (many UIs expand on row click)
          if (!clicked) {
            await treeItem.click({ timeout: 1200, position: { x: 10, y: 15 } });
          }
        } catch { /* ignore stale or detached */ }
        await setTimeout(250);
      }
    }

    await setTimeout(800);
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

  await setTimeout(5_000);

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
 * Force the page tree in the expandable sidebar to fully render (scroll + expand).
 * Scrolls and expands only within the sidebar root when provided.
 */
async function fullyMaterializePageTree(page, verbose, sidebarRoot = null) {
  const root = sidebarRoot || page;
  const maxPasses = 12;
  let lastCount = -1;

  for (let pass = 1; pass <= maxPasses; pass++) {
    await expandAllNodes(page, verbose, sidebarRoot);

    const items = await (sidebarRoot ? findAll(sidebarRoot, PAGE_ITEM_SELECTORS) : findAll(page, PAGE_ITEM_SELECTORS));
    const count = items.length;
    if (verbose) log(`  [tree] pass ${pass}: visible page items=${count}`);

    if (count > 0 && count === lastCount) break;
    lastCount = count;

    // Scroll within the expandable sidebar to reveal more items
    if (sidebarRoot) {
      try {
        await sidebarRoot.evaluate((node) => {
          if (node && typeof node.scrollTop !== 'undefined') node.scrollTop = node.scrollHeight;
        });
      } catch { /* ignore */ }
      try {
        const tree = await sidebarRoot.$('[role="tree"]');
        if (tree) await tree.evaluate((n) => { n.scrollTop = n.scrollHeight; });
      } catch { /* ignore */ }
    }
    try {
      await page.mouse.wheel(0, 800);
    } catch {}

    await setTimeout(800);
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
