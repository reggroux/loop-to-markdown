/**
 * exporter.js — Navigate to each page discovered by inventory and export to Markdown.
 *
 * Output structure (Obsidian-friendly):
 *
 *   <outputRoot>/
 *     <workspace-slug>/
 *       top-level-page.md
 *       parent-page/
 *         index.md          ← parent page content
 *         child-page-1.md
 *         child-page-2.md
 *         child-page-2/
 *           index.md
 *           grandchild.md
 *       _assets/            ← workspace-level shared assets (if any)
 *
 * Each page with children becomes a folder with:
 *   - index.md  = the parent's own content
 *   - siblings  = each child's .md file
 */

import path from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import {
  PAGE_CONTENT_SELECTORS,
  PAGE_TITLE_SELECTORS,
  findFirst,
} from './selectors.js';
import { rewriteImages } from './assets.js';
import { htmlToMarkdown, toSlug } from './markdown.js';

// ─── Main exporter entry point ────────────────────────────────────────────────

/**
 * @param {import('playwright').Page} page      - Authenticated browser page
 * @param {import('playwright').BrowserContext} context - For cookie extraction
 * @param {object} manifest                     - From inventory.js
 * @param {string} outputRoot                   - Root directory to write exports
 * @param {object} [opts]
 * @param {boolean} [opts.verbose]
 * @param {string|null} [opts.workspaceFilter]  - Only export this workspace (by title/slug)
 * @param {string|null} [opts.pageFilter]       - Only export pages matching this title substring
 * @returns {Promise<object>}                   - Audit report { exported, failed, skipped }
 */
export async function runExport(page, context, manifest, outputRoot, opts = {}) {
  const { verbose = false, workspaceFilter = null, pageFilter = null } = opts;

  const audit = {
    startedAt: new Date().toISOString(),
    exported: [],
    failed: [],
    skipped: [],
  };

  // Extract cookies for authenticated asset downloads
  const cookies = await context.cookies();
  const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const assetContext = { cookies: cookieString };

  for (const workspace of manifest.workspaces) {
    if (workspaceFilter && !matchFilter(workspace.title, workspaceFilter)) {
      audit.skipped.push({ type: 'workspace', title: workspace.title });
      continue;
    }

    const wsSlug = toSlug(workspace.title);
    const wsDir = path.join(outputRoot, wsSlug);
    mkdirSync(wsDir, { recursive: true });

    console.log(`\n📂 Exporting workspace: "${workspace.title}"`);

    await exportPageList(
      page,
      workspace.pages,
      wsDir,
      assetContext,
      audit,
      { verbose, pageFilter, depth: 0 }
    );
  }

  // Write audit report
  audit.finishedAt = new Date().toISOString();
  audit.totalExported = audit.exported.length;
  audit.totalFailed = audit.failed.length;
  audit.totalSkipped = audit.skipped.length;

  const auditPath = path.join(outputRoot, 'audit-report.json');
  writeFileSync(auditPath, JSON.stringify(audit, null, 2), 'utf8');
  console.log(`\n📊 Audit report → ${auditPath}`);
  console.log(`   ✅ Exported: ${audit.totalExported}`);
  console.log(`   ❌ Failed:   ${audit.totalFailed}`);
  console.log(`   ⏭️  Skipped:  ${audit.totalSkipped}`);

  return audit;
}

// ─── Recursive page exporter ──────────────────────────────────────────────────

/**
 * Export a flat list of pages (all siblings at the same parent level).
 * Recurses for pages that have children.
 */
async function exportPageList(page, pages, dirPath, assetContext, audit, opts) {
  const { verbose, pageFilter, depth } = opts;
  if (!Array.isArray(pages)) return;

  // Separate top-level pages (no children) from those with children
  for (const pageEntry of pages) {
    if (pageFilter && !matchFilter(pageEntry.title, pageFilter)) {
      audit.skipped.push({ type: 'page', title: pageEntry.title });
      continue;
    }

    const slug = toSlug(pageEntry.title);
    const hasChildren = Array.isArray(pageEntry.childPages) && pageEntry.childPages.length > 0;

    if (hasChildren) {
      // Create a sub-folder; the page's own content goes in index.md
      const subDir = path.join(dirPath, slug);
      mkdirSync(subDir, { recursive: true });
      const assetsDir = path.join(subDir, '_assets');

      await exportSinglePage(page, pageEntry, subDir, 'index.md', assetsDir, assetContext, audit, verbose);

      // Recurse into children
      await exportPageList(page, pageEntry.childPages, subDir, assetContext, audit, {
        ...opts,
        depth: depth + 1,
      });
    } else {
      // Leaf page — write <slug>.md in current dir
      const assetsDir = path.join(dirPath, '_assets');
      await exportSinglePage(page, pageEntry, dirPath, `${slug}.md`, assetsDir, assetContext, audit, verbose);
    }
  }
}

/**
 * Navigate to a single page and export its content.
 */
async function exportSinglePage(page, pageEntry, dir, filename, assetsDir, assetContext, audit, verbose) {
  const fullPath = path.join(dir, filename);
  console.log(`  📄 "${pageEntry.title}" → ${path.relative(process.cwd(), fullPath)}`);

  if (!pageEntry.url) {
    audit.failed.push({ title: pageEntry.title, reason: 'No URL in manifest' });
    console.warn(`     ⚠️  Skipped — no URL`);
    return;
  }

  try {
    // Navigate to the page
    // Loop is a heavy SPA and often never reaches true "networkidle".
    // Prefer domcontentloaded and then wait for the page shell/content.
    await page.goto(pageEntry.url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await page.waitForTimeout(2_000);

    // Extract page title from DOM (may be more accurate than sidebar label)
    const titleEl = await findFirst(page, PAGE_TITLE_SELECTORS, 3000);
    const domTitle = titleEl ? (await titleEl.innerText().catch(() => null))?.trim() : null;
    const finalTitle = domTitle || pageEntry.title;

    // Extract page content HTML
    const contentEl = await findFirst(page, PAGE_CONTENT_SELECTORS, 5000);
    let html = '';
    if (contentEl) {
      html = await contentEl.innerHTML().catch(() => '');
    } else {
      // Fallback: grab <main> or <body>
      html = await page.$eval('main, [role="main"], body', (el) => el.innerHTML).catch(() => '');
      if (verbose) console.log(`     ⚠️  Content area not found via primary selectors, used fallback`);
    }

    // Download images and rewrite paths
    const { html: rewrittenHtml, downloaded, failed: failedAssets } = await rewriteImages(html, assetsDir, assetContext);
    if (verbose && downloaded.length) {
      console.log(`     🖼  Downloaded ${downloaded.length} asset(s)`);
    }
    if (failedAssets.length) {
      console.warn(`     ⚠️  ${failedAssets.length} asset(s) failed to download`);
    }

    // Convert to Markdown
    const markdown = htmlToMarkdown(rewrittenHtml, finalTitle, pageEntry.url);

    // Write file
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, markdown, 'utf8');

    audit.exported.push({
      title: finalTitle,
      url: pageEntry.url,
      file: fullPath,
      assetsDownloaded: downloaded.length,
      assetsFailed: failedAssets.length,
    });
  } catch (err) {
    console.error(`     ❌ Failed: ${err.message}`);
    audit.failed.push({
      title: pageEntry.title,
      url: pageEntry.url,
      reason: err.message,
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function matchFilter(title, filter) {
  return title.toLowerCase().includes(filter.toLowerCase());
}
