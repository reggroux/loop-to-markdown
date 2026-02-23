/**
 * browser.js — Playwright browser lifecycle + auth helpers
 *
 * Strategy:
 *  1. On first run, launch headed Chromium and let the user log in interactively.
 *  2. Save storage state (cookies + localStorage) to auth-state.json.
 *  3. On subsequent runs, restore the saved state and skip login.
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const AUTH_STATE_PATH = path.join(ROOT, 'auth-state.json');
// NOTE: Loop currently redirects many users to loop.cloud.microsoft.
// Use the cloud domain as the entrypoint to reduce redirect weirdness.
export const LOOP_URL = 'https://loop.cloud.microsoft/';

/**
 * Launch Chromium and return { browser, context, page }.
 * If forceLogin=true or no auth-state exists, start fresh and
 * wait for the user to complete interactive login (MFA, etc.).
 */
export async function launchBrowser({ forceLogin = false, headless = false } = {}) {
  const hasState = existsSync(AUTH_STATE_PATH);

  const launchOptions = {
    headless,
    slowMo: headless ? 0 : 50,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  };

  const browser = await chromium.launch(launchOptions);

  // macOS visibility: Playwright sometimes launches Chromium without surfacing it.
  // Attempt to activate the app so the login window is visible.
  if (!headless) {
    try {
      const { execSync } = await import('child_process');
      execSync('osascript -e \'tell application "Google Chrome for Testing" to activate\'', { stdio: 'ignore' });
    } catch {}
  }

  let context;
  if (!forceLogin && hasState) {
    console.log('🔑 Restoring saved auth state from auth-state.json');
    context = await browser.newContext({
      storageState: AUTH_STATE_PATH,
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
  } else {
    console.log('🌐 Launching fresh browser — please log in interactively');
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
  }

  const page = await context.newPage();

  // Navigate to Loop
  await page.goto(LOOP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Bring the window to the front (best-effort). On macOS this usually makes the
  // Playwright-launched Chromium visible immediately.
  try { await page.bringToFront(); } catch {}

  // Helpful debugging on first runs
  if (!headless) {
    try {
      console.log(`ℹ️  Browser launched. Current URL: ${page.url()}`);
    } catch {}
  }

  // If we need login, wait until the user has finished (URL changes away from login)
  if (!hasState || forceLogin) {
    console.log('⏳ Waiting for you to complete login… (the browser will proceed automatically once you are in)');
    await waitForLoopReady(page);
    // Persist auth
    await context.storageState({ path: AUTH_STATE_PATH });
    console.log('✅ Auth state saved to auth-state.json');
  } else {
    // With restored state, still wait for Loop to be ready
    const ready = await waitForLoopReady(page, 30_000).catch(() => false);
    if (!ready) {
      // Session may have expired — prompt re-login
      console.warn('⚠️  Saved session appears expired. Retrying with fresh login…');
      await context.close();
      await browser.close();
      return launchBrowser({ forceLogin: true, headless });
    }
  }

  return { browser, context, page };
}

/**
 * Wait until the Loop SPA has loaded its main UI shell.
 * Tries multiple signals so we survive future DOM changes.
 */
export async function waitForLoopReady(page, timeout = 120_000) {
  // Loop is ready when one of these selectors appears
  const signals = [
    // Common Loop app shell signals (subject to change)
    '[data-app-id="loop"]',
    '[aria-label="Loop"]',
    'nav[role="navigation"]',
    '.loop-canvas',
    '[class*="WorkspaceList"]',
    '[class*="workspaceList"]',
    '[class*="sidebar"]',
    'div[data-testid="workspace-list"]',

    // Generic app signals (helps when Loop changes DOM/classnames)
    'button[aria-label*="New" i]',
    'a[href*="loop.microsoft.com"]',
    '[role="tree"]',
    '[role="treeitem"]',
  ];

  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const url = page.url();
    // If we're still on Microsoft login pages, keep waiting
    if (url.includes('login.microsoftonline') || url.includes('login.live.com')) {
      await setTimeout(2000);
      continue;
    }

    // Check for any of our SPA signals
    for (const sel of signals) {
      try {
        const el = await page.$(sel);
        if (el) {
          console.log(`✅ Loop ready — matched selector: ${sel}`);
          // Extra settle time for SPA hydration
          await setTimeout(2000);
          return true;
        }
      } catch {
        // ignore
      }
    }

    // Also consider: we are on loop.* and we have a non-empty title that isn't obviously auth
    const title = await page.title().catch(() => '');
    const t = (title || '').toLowerCase();
    const looksLikeAuth = t.includes('sign') || t.includes('login') || t.includes('account') || t.includes('microsoft');
    if ((url.includes('loop.microsoft.com') || url.includes('loop.cloud.microsoft')) && title && !looksLikeAuth) {
      console.log(`✅ Loop ready (heuristic) — URL=${url}, title="${title}"`);
      await setTimeout(2000);
      return true;
    }

    await setTimeout(1_500);
  }

  throw new Error(`Loop did not become ready within ${timeout}ms. Last URL: ${page.url()}`);
}

/**
 * Gracefully close browser/context.
 */
export async function closeBrowser({ browser }) {
  try { await browser.close(); } catch { /* ignore */ }
}
