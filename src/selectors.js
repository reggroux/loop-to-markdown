/**
 * selectors.js — Robust multi-strategy selectors for Microsoft Loop SPA
 *
 * Loop uses Fluent UI + proprietary React components whose CSS class names
 * are auto-generated and change between deployments.  We layer multiple
 * strategies so the scraper degrades gracefully rather than hard-failing.
 *
 * Exported constants are arrays ordered most-specific → least-specific.
 * Callers should try each selector in turn and use the first that matches.
 */

// ─── Workspace discovery: MAIN CONTENT (center gallery) only ───────────────────
// Discovery must never use the left sidebar. Workspaces are the cards in the
// middle of the screen when the "Workspaces" tab is selected.

/** Container for the workspace cards grid in the main content area. */
export const WORKSPACE_GALLERY_CONTAINER_SELECTORS = [
  '[data-testid="workspaces-grid"]',
  '[aria-label="Workspaces"]',
  'main [class*="grid"]',
  'main [class*="Gallery"]',
  'main [class*="gallery"]',
  '[role="main"] [class*="workspace"]',
  'main section',
  '[role="main"]',
  'main',
];

/** Individual workspace cards in the center gallery (one card = one workspace). */
export const WORKSPACE_GALLERY_CARD_SELECTORS = [
  '[data-testid="workspace-card"]',
  'a[href*="loop.microsoft.com"], a[href*="loop.cloud.microsoft"]',
  '[role="button"][class*="workspace"]',
  '[class*="WorkspaceCard"]',
  '[class*="workspaceCard"]',
  'main a[href*="loop"]',
  '[role="main"] a[href*="loop"]',
  'main [role="grid"] > *',
  'main [class*="card"]',
  // Fallback: clickable blocks in main that look like cards
  'main a',
];

// Legacy names kept for any external use; prefer gallery selectors above.
export const WORKSPACE_LIST_SELECTORS = WORKSPACE_GALLERY_CONTAINER_SELECTORS;
export const WORKSPACE_ITEM_SELECTORS = WORKSPACE_GALLERY_CARD_SELECTORS;

// ─── Page tree: EXPANDABLE sidebar only (not the left sidebar) ─────────────────
// When a workspace is open, a second sidebar expands with that workspace’s pages.
// We must use only this expandable sidebar for the page tree (not the left nav).

/** Container for the expandable sidebar that shows pages for the current workspace. */
export const EXPANDABLE_SIDEBAR_CONTAINER_SELECTORS = [
  '[data-testid="page-tree-container"]',
  '[aria-label="Pages"]',
  '[class*="PageTree"]',
  '[class*="pageTree"]',
  '[class*="pageList"]',
  // The expandable panel is often the second nav-like region (not the leftmost)
  'nav[role="navigation"] [role="tree"]',
  '[class*="sidebar"] [role="tree"]',
  '[class*="Sidebar"] [role="tree"]',
  'ul[role="tree"]',
  '[class*="fui-Tree"]',
];

/** Tree/list that holds page items inside the expandable sidebar. */
export const PAGE_TREE_SELECTORS = [
  '[data-testid="page-tree"]',
  '[aria-label="Pages"]',
  'ul[class*="PageTree"]',
  'ul[class*="pageTree"]',
  '[class*="pageList"]',
  'ul[role="tree"]',
  '[class*="fui-Tree"]',
];

export const PAGE_ITEM_SELECTORS = [
  '[data-testid="page-item"]',
  '[role="treeitem"]',
  'li[class*="Page"]',
  'li[class*="page"]',
  '[class*="pageItem"]',
  '[class*="fui-TreeItem"]',
];

// ─── Page title ──────────────────────────────────────────────────────────────

export const PAGE_TITLE_SELECTORS = [
  '[data-testid="page-title"]',
  '[aria-label="Page title"]',
  'h1[class*="PageTitle"]',
  'h1[class*="pageTitle"]',
  '.loop-page-title',
  // Collaborative editor title block (often a contenteditable)
  '[contenteditable="true"][class*="title"]',
  '[contenteditable="true"][placeholder*="title" i]',
  'h1',
];

// ─── Page content area ───────────────────────────────────────────────────────

export const PAGE_CONTENT_SELECTORS = [
  '[data-testid="page-content"]',
  '[aria-label="Page content"]',
  '[class*="PageContent"]',
  '[class*="pageContent"]',
  '.loop-canvas',
  '[class*="canvas"]',
  // Prosemirror / Fluid Framework editor root
  '.ProseMirror',
  '[class*="editor"]',
  // Generic content region
  'main',
  'article',
  '[role="main"]',
];

// ─── Subpage expansion / chevron ─────────────────────────────────────────────

export const EXPAND_BUTTON_SELECTORS = [
  '[aria-expanded][class*="expand"]',
  '[aria-label="Expand"]',
  'button[aria-expanded]',
  '[class*="chevron"]',
  '[class*="Chevron"]',
  '[class*="toggle"]',
  // Fluent
  '[class*="fui-TreeItemLayout__expandIcon"]',
];

/** Selectors for the expand/caret control *inside* a tree item (run within the tree item element). */
export const EXPAND_INSIDE_TREEITEM_SELECTORS = [
  'button[aria-expanded]',
  '[aria-expanded][class*="expand"]',
  '[class*="expandIcon"]',
  '[class*="expand-icon"]',
  '[class*="fui-TreeItemLayout__expandIcon"]',
  '[class*="chevron"]',
  '[class*="Chevron"]',
  'button', // fallback: first button in the row is often the expand
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Try a list of selectors on `page` and return the first element found.
 * @param {import('playwright').Page} page
 * @param {string[]} selectors
 * @param {number} timeout - ms to wait for each selector (short, we cascade)
 * @returns {Promise<import('playwright').ElementHandle|null>}
 */
export async function findFirst(page, selectors, timeout = 2000) {
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout, state: 'attached' });
      if (el) return el;
    } catch {
      // not found with this selector, try next
    }
  }
  return null;
}

/**
 * Try a list of selectors and return all matching elements from the first that yields results.
 * @param {import('playwright').Page|import('playwright').ElementHandle} root
 * @param {string[]} selectors
 * @returns {Promise<import('playwright').ElementHandle[]>}
 */
export async function findAll(root, selectors) {
  for (const sel of selectors) {
    try {
      const els = await root.$$(sel);
      if (els && els.length > 0) return els;
    } catch {
      // ignore
    }
  }
  return [];
}

/**
 * Extract visible text from an element, trying aria-label first, then innerText.
 */
export async function elementLabel(el) {
  try {
    const ariaLabel = await el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
  } catch { /* ignore */ }
  try {
    const text = await el.innerText();
    if (text && text.trim()) return text.trim().split('\n')[0];
  } catch { /* ignore */ }
  return null;
}

/**
 * Safely get an attribute from an element handle.
 */
export async function safeAttr(el, attr) {
  try { return await el.getAttribute(attr); } catch { return null; }
}
