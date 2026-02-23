#!/usr/bin/env node
/**
 * cli.js — Main entry point for loop-export.
 *
 * Usage:
 *   node src/cli.js inventory [options]
 *   node src/cli.js export    [options]
 */

import { Command } from 'commander';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(ROOT, 'output');

const program = new Command();

program
  .name('loop-export')
  .description('Inventory and export Microsoft Loop workspaces/pages to Markdown')
  .version('0.1.0');

// ─── inventory ────────────────────────────────────────────────────────────────

program
  .command('inventory')
  .description('Crawl Loop sidebar and produce manifest.json (no files exported)')
  .option('-o, --output <dir>', 'Output directory for manifest.json', DEFAULT_OUTPUT)
  .option('--force-login', 'Ignore saved auth state and log in fresh', false)
  .option('--headless', 'Run browser in headless mode (not recommended — login needs UI)', false)
  .option('-v, --verbose', 'Verbose logging', false)
  .action(async (opts) => {
    console.log(chalk.cyan.bold('\n🔄 Loop Export — Inventory Pass\n'));

    const { launchBrowser, closeBrowser } = await import('./browser.js');
    const { runInventory } = await import('./inventory.js');
    const { printManifestSummary, validateManifest } = await import('./manifest.js');

    let browser, context, page;
    try {
      ({ browser, context, page } = await launchBrowser({
        forceLogin: opts.forceLogin,
        headless: opts.headless,
      }));

      const manifest = await runInventory(page, {
        outputDir: opts.output,
        verbose: opts.verbose,
      });

      validateManifest(manifest);
      printManifestSummary(manifest);

      console.log(chalk.green.bold('✅ Inventory complete!'));
      console.log(`   Manifest: ${chalk.underline(path.join(opts.output, 'manifest.json'))}`);
      console.log(`\n   Next step: ${chalk.yellow('node src/cli.js export')}\n`);
    } catch (err) {
      console.error(chalk.red.bold('\n❌ Inventory failed:'), err.message);
      if (opts.verbose) console.error(err.stack);
      process.exit(1);
    } finally {
      if (browser) await closeBrowser({ browser });
    }
  });

// ─── export ───────────────────────────────────────────────────────────────────

program
  .command('export')
  .description('Export all pages from manifest.json to Markdown + assets')
  .option('-o, --output <dir>', 'Output directory (same as inventory output)', DEFAULT_OUTPUT)
  .option('--force-login', 'Ignore saved auth state and log in fresh', false)
  .option('--headless', 'Run browser in headless mode', false)
  .option('-v, --verbose', 'Verbose logging', false)
  .option('--workspace <name>', 'Only export pages from workspaces matching this name/substring')
  .option('--page <name>', 'Only export pages matching this title substring')
  .option(
    '--from-manifest <file>',
    'Path to a specific manifest.json (default: <output>/manifest.json)'
  )
  .action(async (opts) => {
    console.log(chalk.cyan.bold('\n🚀 Loop Export — Export Pass\n'));

    const { launchBrowser, closeBrowser } = await import('./browser.js');
    const { runExport } = await import('./exporter.js');
    const { loadManifest, validateManifest, printManifestSummary } = await import('./manifest.js');

    // Load manifest
    const manifestDir = opts.fromManifest
      ? path.dirname(opts.fromManifest)
      : opts.output;

    let manifest;
    try {
      manifest = loadManifest(manifestDir);
    } catch (err) {
      console.error(chalk.red('❌ ' + err.message));
      process.exit(1);
    }

    validateManifest(manifest);
    printManifestSummary(manifest);

    let browser, context, page;
    try {
      ({ browser, context, page } = await launchBrowser({
        forceLogin: opts.forceLogin,
        headless: opts.headless,
      }));

      const audit = await runExport(page, context, manifest, opts.output, {
        verbose: opts.verbose,
        workspaceFilter: opts.workspace || null,
        pageFilter: opts.page || null,
      });

      const success = audit.totalFailed === 0;
      if (success) {
        console.log(chalk.green.bold('\n✅ Export complete — all pages exported successfully!'));
      } else {
        console.log(
          chalk.yellow.bold(`\n⚠️  Export done with ${audit.totalFailed} failure(s).`) +
          ` See audit-report.json for details.`
        );
      }
      console.log(`   Output: ${chalk.underline(opts.output)}\n`);
    } catch (err) {
      console.error(chalk.red.bold('\n❌ Export failed:'), err.message);
      if (opts.verbose) console.error(err.stack);
      process.exit(1);
    } finally {
      if (browser) await closeBrowser({ browser });
    }
  });

// ─── auth ─────────────────────────────────────────────────────────────────────

program
  .command('auth')
  .description('Launch browser for interactive login/re-authentication only')
  .action(async () => {
    console.log(chalk.cyan.bold('\n🔐 Loop Export — Authentication\n'));
    const { launchBrowser, closeBrowser, AUTH_STATE_PATH } = await import('./browser.js');
    let browser;
    try {
      ({ browser } = await launchBrowser({ forceLogin: true }));
      console.log(chalk.green(`\n✅ Auth state saved → ${AUTH_STATE_PATH}`));
    } catch (err) {
      console.error(chalk.red('❌ Auth failed:'), err.message);
      process.exit(1);
    } finally {
      if (browser) await closeBrowser({ browser });
    }
  });

// ─── inspect ─────────────────────────────────────────────────────────────────

program
  .command('inspect')
  .description('Open Loop in a headed browser and print DOM diagnostics to help tune selectors')
  .option('--url <url>', 'Loop URL to inspect', 'https://loop.microsoft.com/')
  .action(async (opts) => {
    console.log(chalk.cyan.bold('\n🔬 Loop Export — Inspector\n'));
    const { launchBrowser, closeBrowser } = await import('./browser.js');
    const { runInspector } = await import('./inspector.js');
    let browser, page;
    try {
      ({ browser, page } = await launchBrowser({ forceLogin: false }));
      if (opts.url !== 'https://loop.microsoft.com/') {
        await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 60_000 });
      }
      await runInspector(page);
    } catch (err) {
      console.error(chalk.red('❌ Inspector failed:'), err.message);
    } finally {
      if (browser) await closeBrowser({ browser });
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red('Fatal:'), err.message);
  process.exit(1);
});
