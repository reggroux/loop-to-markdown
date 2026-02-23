# loop-export

> Inventory and export **Microsoft Loop** workspaces & pages to **Markdown + assets**,  
> with an [Obsidian](https://obsidian.md)-friendly folder structure.

---

## Features

- 🔍 **Inventory pass** — crawl the Loop sidebar, build `manifest.json` (no files written)
- 📤 **Export pass** — navigate each page, extract content, download images, write `.md` files
- 🔐 **Interactive login** — opens a headed Chromium window; you log in manually (MFA-compatible)
- 💾 **Auth persistence** — saves your session to `auth-state.json` so you only log in once
- 🗂 **Obsidian structure** — pages with sub-pages become folders with `index.md`
- 🖼 **Asset download** — images are saved to `_assets/` and paths are rewritten
- 📊 **Audit report** — `audit-report.json` lists exported/failed/skipped pages
- 🔬 **Inspector tool** — diagnose selector issues when Loop changes its DOM

---

## Prerequisites

- **Node.js ≥ 18** (`node --version`)
- **npm** or equivalent

---

## Installation

```bash
cd /Users/robertgroux/github/loop-export
npm install
npx playwright install chromium   # download Chromium browser
```

---

## Quick Start

### Step 1 — Inventory (no export)

Crawls the Loop sidebar and produces `output/manifest.json`.  
A headed browser window will open — **log in with your Microsoft account** (MFA is fine).

```bash
node src/cli.js inventory
```

Review the summary printed to the console, then inspect `output/manifest.json`.

### Step 2 — Export

Reads the manifest and exports every page to Markdown.

```bash
node src/cli.js export
```

Files land in `output/<workspace-name>/<page-name>.md`.

---

## CLI Reference

### `inventory`

```
node src/cli.js inventory [options]

Options:
  -o, --output <dir>    Output directory for manifest.json  [default: ./output]
  --force-login         Force fresh login (ignore saved auth-state.json)
  --headless            Run browser headless (not recommended — login needs UI)
  -v, --verbose         Verbose logging (useful for debugging selectors)
```

### `export`

```
node src/cli.js export [options]

Options:
  -o, --output <dir>        Output directory                     [default: ./output]
  --from-manifest <file>    Path to a specific manifest.json
  --workspace <name>        Only export workspace(s) matching this name substring
  --page <name>             Only export page(s) matching this title substring
  --force-login             Force fresh login
  --headless                Run headless
  -v, --verbose             Verbose logging
```

**Examples:**

```bash
# Export only one workspace
node src/cli.js export --workspace "My Team"

# Export only pages matching "Design"
node src/cli.js export --page "Design"

# Verbose export with fresh login
node src/cli.js export --force-login --verbose
```

### `auth`

Re-authenticate without running inventory or export:

```bash
node src/cli.js auth
```

### `inspect`

Diagnose selector issues — prints which selectors matched the current DOM,
sidebar structure, and captured API calls:

```bash
node src/cli.js inspect
node src/cli.js inspect --url "https://loop.microsoft.com/#your-workspace-url"
```

---

## Output Structure

```
output/
  manifest.json               # Inventory: all workspaces + pages + URLs
  audit-report.json           # Export: per-page success/failure log

  <workspace-slug>/
    top-level-page.md         # Leaf page

    parent-page/              # Page with sub-pages becomes a folder
      index.md                # Parent page content
      child-page-1.md
      child-page-2.md
      child-page-2/
        index.md
        grandchild.md
      _assets/
        image_abc123.png
        ...

    _assets/                  # Workspace-level assets
```

### Markdown format

Each `.md` file has YAML frontmatter:

```markdown
---
title: "My Page Title"
source: "https://loop.microsoft.com/..."
exported: "2024-05-01T12:00:00.000Z"
---

# My Page Title

Content here…
```

---

## Auth State

After first login, credentials are saved to `auth-state.json` (gitignored).  
Delete it to force a fresh login on the next run, or use `--force-login`.

---

## Troubleshooting

### "0 workspaces found" or empty manifest

Loop's DOM changes between deployments. Run the inspector to see what's present:

```bash
node src/cli.js inspect --verbose
```

Then update `src/selectors.js` with the new selectors.

### Session expired

```bash
node src/cli.js auth      # re-authenticate
node src/cli.js inventory # re-run inventory
```

### Images not downloading

Some Loop images require authenticated requests. The exporter passes your session
cookies to the asset downloader — if downloads still fail, check `audit-report.json`
for the failing URLs and try opening them in the browser.

### Playwright not found

```bash
npm install
npx playwright install chromium
```

---

## Architecture

```
src/
  cli.js          Main CLI entry point (Commander.js)
  browser.js      Playwright launch + auth persistence
  selectors.js    Multi-strategy CSS selectors for Loop SPA
  inventory.js    Sidebar crawler → manifest.json
  exporter.js     Page navigator + Markdown writer
  assets.js       Image downloader + path rewriter
  markdown.js     HTML → Markdown (Turndown + GFM)
  manifest.js     Manifest load/validate/summarize
  inspector.js    DOM diagnostics for selector tuning
```

---

## License

MIT
