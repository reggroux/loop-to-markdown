/**
 * assets.js — Download remote assets and rewrite URLs to relative local paths.
 *
 * Assets are stored under:
 *   <outputRoot>/<workspace>/<pagePath>/_assets/<filename>
 *
 * Images already embedded as data: URIs are written out as files too.
 */

import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';

let _fetch;
async function getFetch() {
  if (!_fetch) {
    const mod = await import('node-fetch');
    _fetch = mod.default;
  }
  return _fetch;
}

/**
 * Download a single asset URL into the assets dir.
 * Returns the local relative path (relative to the page's .md file), or null on failure.
 *
 * @param {string} assetUrl  - Remote URL (https://…) or data: URI
 * @param {string} assetsDir - Absolute path to the _assets directory for this page
 * @param {object} [context] - { cookies, headers } to authenticate requests
 * @returns {Promise<string|null>} - Relative path to saved file, e.g. "./_assets/image.png"
 */
export async function downloadAsset(assetUrl, assetsDir, context = {}) {
  mkdirSync(assetsDir, { recursive: true });

  try {
    // ── data: URI ────────────────────────────────────────────────────────────
    if (assetUrl.startsWith('data:')) {
      return saveDataUri(assetUrl, assetsDir);
    }

    // ── Remote URL ───────────────────────────────────────────────────────────
    const filename = await deriveFilename(assetUrl);
    const localPath = path.join(assetsDir, filename);
    const relativePath = `./_assets/${filename}`;

    // Skip if already downloaded
    if (existsSync(localPath)) return relativePath;

    const fetch = await getFetch();
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      ...(context.headers || {}),
    };
    if (context.cookies) {
      headers['Cookie'] = context.cookies;
    }

    const resp = await fetch(assetUrl, { headers, redirect: 'follow' });
    if (!resp.ok) {
      console.warn(`  [asset] HTTP ${resp.status} for ${assetUrl}`);
      return null;
    }

    await pipeline(resp.body, createWriteStream(localPath));
    return relativePath;
  } catch (err) {
    console.warn(`  [asset] Failed to download ${assetUrl}: ${err.message}`);
    return null;
  }
}

/**
 * Process HTML string: find all <img src="…">, download each asset,
 * rewrite src attributes to local relative paths.
 *
 * @param {string} html
 * @param {string} assetsDir
 * @param {object} context
 * @returns {Promise<{ html: string, downloaded: string[], failed: string[] }>}
 */
export async function rewriteImages(html, assetsDir, context = {}) {
  const imgRe = /<img([^>]*?)src="([^"]+)"([^>]*?)>/gi;
  const downloaded = [];
  const failed = [];
  const replacements = [];

  let match;
  while ((match = imgRe.exec(html)) !== null) {
    const [full, pre, src, post] = match;
    replacements.push({ full, pre, src, post });
  }

  let result = html;
  for (const { full, pre, src, post } of replacements) {
    const localPath = await downloadAsset(src, assetsDir, context);
    if (localPath) {
      result = result.replace(full, `<img${pre}src="${localPath}"${post}>`);
      downloaded.push(src);
    } else {
      failed.push(src);
    }
  }

  return { html: result, downloaded, failed };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function saveDataUri(dataUri, assetsDir) {
  // data:[<mediatype>][;base64],<data>
  const match = dataUri.match(/^data:([^;,]+)(?:;base64)?,(.+)$/s);
  if (!match) return null;

  const [, mimeType, data] = match;
  const ext = mimeToExt(mimeType) || 'bin';
  const hash = crypto.createHash('md5').update(data.slice(0, 64)).digest('hex').slice(0, 8);
  const filename = `asset_${hash}.${ext}`;
  const localPath = path.join(assetsDir, filename);

  if (!existsSync(localPath)) {
    const buf = Buffer.from(data, 'base64');
    await writeFile(localPath, buf);
  }

  return `./_assets/${filename}`;
}

async function deriveFilename(url) {
  try {
    const u = new URL(url);
    // Use pathname basename; strip query/hash
    let name = path.basename(u.pathname) || 'asset';
    // Remove special characters that are bad for filenames
    name = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    if (!name.includes('.')) {
      // Try to infer extension from content-type if possible
      name += '.bin';
    }
    // Add a short hash to avoid collisions when basenames are the same
    const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 6);
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    return `${base}_${hash}${ext}`;
  } catch {
    const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 10);
    return `asset_${hash}.bin`;
  }
}

function mimeToExt(mime) {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
  };
  return map[mime] || null;
}
