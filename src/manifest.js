/**
 * manifest.js — Load, validate, and print summary of manifest.json.
 *
 * The manifest is the single source of truth produced by the inventory pass.
 * The export pass reads it (no need to re-crawl the sidebar).
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * Load manifest from disk.
 * @param {string} outputDir  - Dir containing manifest.json
 * @returns {object}          - Parsed manifest
 */
export function loadManifest(outputDir) {
  const manifestPath = path.join(outputDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `manifest.json not found at ${manifestPath}.\n` +
      `Run "loop-export inventory" first to generate it.`
    );
  }
  const raw = readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Print a human-readable summary of the manifest to stdout.
 */
export function printManifestSummary(manifest) {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║            Loop Export — Inventory Summary       ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Generated : ${pad(manifest.generatedAt?.slice(0, 19).replace('T', ' ') || 'unknown', 34)} ║`);
  console.log(`║  Workspaces: ${pad(String(manifest.totalWorkspaces || 0), 34)} ║`);
  console.log(`║  Pages     : ${pad(String(manifest.totalPages || 0), 34)} ║`);
  console.log('╠══════════════════════════════════════════════════╣');

  for (const ws of manifest.workspaces || []) {
    const pageCount = (ws.pages || []).length;
    console.log(`║  📂 ${pad(truncate(ws.title, 30), 44)} ║`);
    printPageTree(ws.pages || [], 1, 44);
  }

  console.log('╚══════════════════════════════════════════════════╝\n');
}

function printPageTree(pages, depth, width) {
  for (const p of pages) {
    const indent = '  '.repeat(depth);
    const icon = (p.children && p.children.length) ? '📁' : '📄';
    const line = `║  ${indent}${icon} ${truncate(p.title, width - depth * 2 - 6)}`;
    console.log(line.padEnd(width + 1) + ' ║');
    if (p.children && p.children.length) {
      // children are IDs here; for display we'd need to look them up
      // just show count
      const childLine = `║  ${indent}  └─ (${p.children.length} sub-page(s))`;
      console.log(childLine.padEnd(width + 1) + ' ║');
    }
  }
}

function pad(str, len) {
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

/**
 * Validate manifest has the expected structure.
 * Throws on fatal issues; warns on minor ones.
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Invalid manifest: not an object');
  }
  if (!Array.isArray(manifest.workspaces)) {
    throw new Error('Invalid manifest: missing workspaces array');
  }
  if (manifest.workspaces.length === 0) {
    console.warn('⚠️  Manifest contains 0 workspaces — nothing to export.');
    console.warn('   This usually means the inventory pass could not read the Loop sidebar.');
    console.warn('   Check the browser output and update selectors.js if needed.');
  }
  const pagesWithoutUrl = (manifest.workspaces || [])
    .flatMap((ws) => ws.pages || [])
    .filter((p) => !p.url);

  if (pagesWithoutUrl.length > 0) {
    console.warn(
      `⚠️  ${pagesWithoutUrl.length} page(s) have no URL — they will be skipped during export.`
    );
  }
}
