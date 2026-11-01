// Presentation defaults and limits adapted from ZCode's
// packages/shared/src/browser-use/command-metadata.ts (aac4755666d09fdcd70272fcf063c077a639015f).
// Modified for Harness Gemini's single browser and local profile storage.
// Licensed under Apache-2.0; see third-party/ZCode-LICENSE.txt and ZCode-NOTICE.md.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const BROWSER_VIEWPORT_LIMITS = Object.freeze({ minWidth: 320, maxWidth: 3840, minHeight: 320, maxHeight: 2160 });
export const BROWSER_ZOOM_OPTIONS = Object.freeze(['fit', '50', '75', '100', '125', '150', '200']);
export const defaultPresentation = () => ({ mode: 'normal', viewport: { width: 393, height: 852 }, zoom: 'fit' });

export function validLogicalViewport(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'height,width'
    && Number.isInteger(value.width) && value.width >= BROWSER_VIEWPORT_LIMITS.minWidth && value.width <= BROWSER_VIEWPORT_LIMITS.maxWidth
    && Number.isInteger(value.height) && value.height >= BROWSER_VIEWPORT_LIMITS.minHeight && value.height <= BROWSER_VIEWPORT_LIMITS.maxHeight;
}

export function normalizePresentation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'mode,viewport,zoom'
    || !['normal', 'responsive'].includes(value.mode) || !BROWSER_ZOOM_OPTIONS.includes(value.zoom)
    || !validLogicalViewport(value.viewport)) return null;
  return { mode: value.mode, viewport: { width: value.viewport.width, height: value.viewport.height }, zoom: value.zoom };
}

export function readPresentation(filename) {
  if (filename) {
    try { return normalizePresentation(JSON.parse(readFileSync(filename, 'utf8'))) ?? defaultPresentation(); }
    catch { /* A missing or invalid preference falls back without touching chat data. */ }
  }
  return defaultPresentation();
}

export function savePresentation(filename, presentation) {
  if (!filename) return;
  mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(presentation) + '\n', 'utf8');
  renameSync(temporary, filename);
}
