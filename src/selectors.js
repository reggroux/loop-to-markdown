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

// ─── Workspace list ──────────────────────────────────────────────────────────

export const WORKSPACE_LIST_SELECTORS = [
  '[data-testid="workspace-list"]',
  '[aria-label="Workspaces"]',
  'ul[class*="WorkspaceList"]',
  'ul[class*="workspaceList"]',
  'nav ul[role="list"]',
  '[class*="workspaceNav"]',
  // Generic: the left-sidebar list that contains workspace entries
  'aside ul',
  'nav ul',
];

export const WORKSPACE_ITEM_SELECTORS = [
  '[data-testid="workspace-item"]',
  '[role="treeitem"][aria-label]',
  'li[class*="Workspace"]',
  'li[class*="workspace"]',
  '[class*="workspaceItem"]',
  // Fluent TreeItem
  '[class*="fui-TreeItem"]',
  // Generic: list items in the sidebar
  'aside li',
];

// ─── Page / subpage tree ─────────────────────────────────────────────────────

export const PAGE_TREE_SELECTORS = [
  '[data-testid="page-tree"]',
  '[aria-label="Pages"]',
  'ul[class*="PageTree"]',
  'ul[class*="pageTree"]',
  '[class*="pageList"]',
  'ul[role="tree"]',
  // Fluent Tree
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
