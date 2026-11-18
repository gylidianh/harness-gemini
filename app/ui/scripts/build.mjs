#!/usr/bin/env node
/**
 * Harness Gemini UI - Zero-Dependency Modular Build Script
 * License: MIT
 *
 * Pure Node.js (>= 22) build script using only built-in modules (`node:fs`, `node:path`, `node:url`).
 * Assembles the readable open-source frontend (`src152/ui/`) into `src152/dist/`:
 *  - `ui/index.html`             -> `dist/index.html`
 *  - `ui/vendor/*.js`            -> `dist/vendor/*.js`
 *  - `ui/src/*.js`               -> `dist/src/*.js` (rewriting `../modules/xxx.js` -> `../xxx.js`
 *                                   so root modules share a single browser ESM instance)
 *  - `ui/modules/*.js`           -> `dist/*.js` (preserves `/team-panel.js`, `/conversation-map.js`,
 *                                   and sibling relative imports like `./branch-ui.js`)
 *  - `ui/styles/*.css`           -> `dist/styles/*.css`
 *  - `ui/styles/modules/*.css`   -> `dist/*.css`
 *  - Preserves `dist/assets/` (KaTeX fonts + `brand-wordmark-CIbor7UQ.png`) and `dist/provider-brands/`,
 *    while removing legacy minified black-box bundles (`index-BWW8q4t7.js`, `index-BbYfWXft.css`).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(__filename);
const uiDir = path.resolve(scriptsDir, '..');
const src152Dir = path.resolve(uiDir, '..');
const defaultDistDir = path.join(src152Dir, 'dist');

const LEGACY_BLACKBOX_ASSETS = [
  'index-BWW8q4t7.js',
  'index-BbYfWXft.css',
];

function parseCliArgs(argv) {
  let outDir = defaultDistDir;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out-dir' && argv[i + 1]) {
      outDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i].startsWith('--out-dir=')) {
      outDir = path.resolve(argv[i].slice('--out-dir='.length));
    }
  }
  return { outDir };
}

async function exists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyDirectoryFiles(srcDir, destDir, filterFn = () => true) {
  if (!(await exists(srcDir))) return [];
  await fsp.mkdir(destDir, { recursive: true });
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const copied = [];

  for (const entry of entries) {
    if (!entry.isFile() || !filterFn(entry.name)) continue;
    const srcFile = path.join(srcDir, entry.name);
    const destFile = path.join(destDir, entry.name);
    await fsp.copyFile(srcFile, destFile);
    copied.push(entry.name);
  }
  return copied;
}

async function copyDirectoryRecursive(srcDir, destDir, skipFileNames = new Set()) {
  if (!(await exists(srcDir))) return 0;
  await fsp.mkdir(destDir, { recursive: true });
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    if (skipFileNames.has(entry.name)) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      count += await copyDirectoryRecursive(srcPath, destPath, skipFileNames);
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, destPath);
      count += 1;
    }
  }
  return count;
}

function rewriteSrcModuleImports(sourceText) {
  // In `src152/ui/src/*.js`, extension factories are imported from `../modules/<name>.js`
  // so IDE navigation inside `ui/` resolves directly to `ui/modules/<name>.js`.
  // In `dist/`, extension modules live at root (`dist/<name>.js`), so `dist/src/*.js`
  // imports `../<name>.js` to guarantee a single ESM module instance across the app.
  return sourceText.replace(
    /(\bfrom\s+['"])\.\.\/modules\/([^'"]+['"])/g,
    '$1../$2',
  );
}

async function build() {
  const startedAt = Date.now();
  const { outDir } = parseCliArgs(process.argv.slice(2));

  const indexSrc = path.join(uiDir, 'index.html');
  if (!fs.existsSync(indexSrc)) {
    throw new Error(`Missing UI entry HTML: ${indexSrc}`);
  }

  await fsp.mkdir(outDir, { recursive: true });

  // If building into a clean custom outDir (e.g. dry-run or CI staging), seed static assets
  // (KaTeX fonts, brand wordmark, provider-brands SVGs) from ui/assets or default dist/.
  const isCustomOutDir = path.resolve(outDir) !== path.resolve(defaultDistDir);
  const legacySkipSet = new Set(LEGACY_BLACKBOX_ASSETS);

  const uiAssetsDir = path.join(uiDir, 'assets');
  const distAssetsDir = path.join(outDir, 'assets');
  if (await exists(uiAssetsDir)) {
    await copyDirectoryRecursive(uiAssetsDir, distAssetsDir, legacySkipSet);
  } else if (isCustomOutDir && (await exists(path.join(defaultDistDir, 'assets')))) {
    await copyDirectoryRecursive(path.join(defaultDistDir, 'assets'), distAssetsDir, legacySkipSet);
  }

  const uiBrandsDir = path.join(uiDir, 'provider-brands');
  const distBrandsDir = path.join(outDir, 'provider-brands');
  if (await exists(uiBrandsDir)) {
    await copyDirectoryRecursive(uiBrandsDir, distBrandsDir);
  } else if (isCustomOutDir && (await exists(path.join(defaultDistDir, 'provider-brands')))) {
    await copyDirectoryRecursive(path.join(defaultDistDir, 'provider-brands'), distBrandsDir);
  }

  // Remove legacy black-box minified JS/CSS bundles if still present in target assets/
  const removedLegacy = [];
  for (const legacyFile of LEGACY_BLACKBOX_ASSETS) {
    const legacyPath = path.join(distAssetsDir, legacyFile);
    if (await exists(legacyPath)) {
      await fsp.rm(legacyPath, { force: true });
      removedLegacy.push(legacyFile);
    }
  }

  // 1. Copy clean open-source index.html
  await fsp.copyFile(indexSrc, path.join(outDir, 'index.html'));

  // 2. Copy vendor ESM bundle(s) -> dist/vendor/
  const vendorFiles = await copyDirectoryFiles(
    path.join(uiDir, 'vendor'),
    path.join(outDir, 'vendor'),
    (name) => name.endsWith('.js') || name.endsWith('.mjs'),
  );

  // 3. Copy 19 extension modules -> dist/*.js (root compatibility)
  const moduleFiles = await copyDirectoryFiles(
    path.join(uiDir, 'modules'),
    outDir,
    (name) => name.endsWith('.js') || name.endsWith('.mjs'),
  );

  // 4. Copy & rewrite core React source modules -> dist/src/*.js
  const uiSrcDir = path.join(uiDir, 'src');
  const outSrcDir = path.join(outDir, 'src');
  await fsp.mkdir(outSrcDir, { recursive: true });
  const srcEntries = (await fsp.readdir(uiSrcDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && (e.name.endsWith('.js') || e.name.endsWith('.mjs')))
    .sort((a, b) => a.name.localeCompare(b.name));

  const srcFiles = [];
  for (const entry of srcEntries) {
    const raw = await fsp.readFile(path.join(uiSrcDir, entry.name), 'utf8');
    const transformed = rewriteSrcModuleImports(raw);
    await fsp.writeFile(path.join(outSrcDir, entry.name), transformed, 'utf8');
    srcFiles.push(entry.name);
  }

  // 5. Copy core layered stylesheets -> dist/styles/*.css
  const coreStyleFiles = await copyDirectoryFiles(
    path.join(uiDir, 'styles'),
    path.join(outDir, 'styles'),
    (name) => name.endsWith('.css'),
  );

  // 6. Copy 16 extension panel stylesheets -> dist/*.css (root compatibility)
  const moduleStyleFiles = await copyDirectoryFiles(
    path.join(uiDir, 'styles', 'modules'),
    outDir,
    (name) => name.endsWith('.css'),
  );

  // Count preserved static font/image assets
  let preservedAssetCount = 0;
  if (await exists(distAssetsDir)) {
    const assetEntries = await fsp.readdir(distAssetsDir, { withFileTypes: true });
    preservedAssetCount = assetEntries.filter((e) => e.isFile()).length;
  }

  const elapsedMs = Date.now() - startedAt;
  console.log('[build:ui] Open-source UI build completed successfully:');
  console.log(`  Output directory     : ${outDir}`);
  console.log(`  Core React modules   : ${srcFiles.length} (${srcFiles.join(', ')})`);
  console.log(`  Vendor ESM bundles   : ${vendorFiles.length} (${vendorFiles.join(', ')})`);
  console.log(`  Extension JS modules : ${moduleFiles.length} -> dist/*.js`);
  console.log(`  Core CSS layers      : ${coreStyleFiles.length} -> dist/styles/*.css`);
  console.log(`  Extension CSS files  : ${moduleStyleFiles.length} -> dist/*.css`);
  console.log(`  Preserved assets     : ${preservedAssetCount} static font/image files in dist/assets/`);
  if (removedLegacy.length > 0) {
    console.log(`  Removed legacy black-box bundles: ${removedLegacy.join(', ')}`);
  }
  console.log(`  Duration             : ${elapsedMs}ms`);
}

build().catch((err) => {
  console.error('[build:ui] Build failed:', err);
  process.exitCode = 1;
});
