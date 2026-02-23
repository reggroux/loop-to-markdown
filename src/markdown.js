/**
 * markdown.js — HTML → Markdown conversion tuned for Loop content.
 *
 * Uses Turndown + GFM plugin for tables, task lists, strikethrough.
 * Additional rules handle Loop-specific HTML patterns.
 */

import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

let _service = null;

function getService() {
  if (_service) return _service;

  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
    strongDelimiter: '**',
  });

  // Enable GFM: tables, task lists, strikethrough
  td.use(gfm);

  // ── Custom rules ───────────────────────────────────────────────────────────

  // Loop sometimes wraps page titles in a special element — skip it in body
  td.addRule('loop-page-title', {
    filter: (node) =>
      node.nodeName === 'H1' &&
      (node.getAttribute('data-testid') === 'page-title' ||
       node.className?.includes?.('PageTitle') ||
       node.className?.includes?.('pageTitle')),
    replacement: () => '', // omit — we add the title as YAML frontmatter
  });

  // Preserve Loop @mentions as plain text
  td.addRule('loop-mention', {
    filter: (node) =>
      node.nodeName === 'SPAN' &&
      (node.getAttribute('data-mention') ||
       node.className?.includes?.('mention')),
    replacement: (content) => `@${content.trim()}`,
  });

  // Loop task/checklist items
  td.addRule('loop-checklist', {
    filter: (node) =>
      node.nodeName === 'LI' &&
      (node.getAttribute('data-type') === 'taskItem' ||
       node.getAttribute('role') === 'checkbox' ||
       node.className?.includes?.('task') ||
       node.className?.includes?.('checklist')),
    replacement: (content, node) => {
      const checked =
        node.getAttribute('aria-checked') === 'true' ||
        node.getAttribute('data-checked') === 'true' ||
        node.querySelector('input[type="checkbox"][checked]') !== null;
      return `- [${checked ? 'x' : ' '}] ${content.trim()}\n`;
    },
  });

  // Collapse empty divs
  td.addRule('empty-divs', {
    filter: (node) =>
      node.nodeName === 'DIV' && node.textContent?.trim() === '',
    replacement: () => '',
  });

  // Remove script/style blocks
  td.remove(['script', 'style', 'noscript']);

  _service = td;
  return td;
}

/**
 * Convert HTML string to Markdown.
 * @param {string} html        - Raw HTML content from the Loop page
 * @param {string} [pageTitle] - Page title for YAML frontmatter
 * @param {string} [pageUrl]   - Original Loop URL for frontmatter
 * @returns {string}           - Markdown string
 */
export function htmlToMarkdown(html, pageTitle, pageUrl) {
  const td = getService();

  let md = '';

  // ── YAML frontmatter ────────────────────────────────────────────────────
  if (pageTitle || pageUrl) {
    md += '---\n';
    if (pageTitle) md += `title: "${escapeYaml(pageTitle)}"\n`;
    if (pageUrl) md += `source: "${pageUrl}"\n`;
    md += `exported: "${new Date().toISOString()}"\n`;
    md += '---\n\n';
  }

  // ── Convert ─────────────────────────────────────────────────────────────
  const body = td.turndown(html || '');

  // Clean up excessive blank lines (Turndown can leave many)
  const cleaned = body
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  md += cleaned;
  return md;
}

/**
 * Build a Markdown index file listing child pages.
 * Used for parent pages that have subpages (Obsidian folder note).
 */
export function buildIndexMarkdown(pageTitle, pageUrl, childTitles) {
  let md = '---\n';
  md += `title: "${escapeYaml(pageTitle)}"\n`;
  if (pageUrl) md += `source: "${pageUrl}"\n`;
  md += `exported: "${new Date().toISOString()}"\n`;
  md += '---\n\n';

  md += `# ${pageTitle}\n\n`;

  if (childTitles.length) {
    md += '## Sub-pages\n\n';
    for (const t of childTitles) {
      const slug = toSlug(t);
      md += `- [[${slug}|${t}]]\n`;
    }
    md += '\n';
  }

  return md;
}

/**
 * Very simple slug: lowercase, spaces to hyphens, strip specials.
 */
export function toSlug(title) {
  return (title || 'untitled')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function escapeYaml(str) {
  return (str || '').replace(/"/g, '\\"');
}
