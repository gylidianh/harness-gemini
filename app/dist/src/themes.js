/**
 * Harness Gemini UI - Built-in Theme Skins & Persistence
 * License: MIT
 */

export const SKIN_STORAGE_KEY = 'harness.skin.v1';
export const DEFAULT_SKIN_ID = 'classic';

export const SKINS = [
  {
    id: 'classic',
    name: 'Gemini 白',
    tone: '浅色 · 原版',
    description: '1.8.0 的白色工作台，明亮清爽，保持原样。',
    swatches: ['#ffffff', '#e8eaed', '#1a73e8'],
    themeColor: '#ffffff',
    colorScheme: 'light',
  },
  {
    id: 'gemini-dark',
    name: 'Gemini 暗',
    tone: '深色 · 蓝紫渐变',
    description: '模仿 Gemini 网页版深色主题：墨黑背景、蓝紫渐变强调色。',
    swatches: ['#1b1c1d', '#282a2c', '#8ab4f8'],
    themeColor: '#131314',
    colorScheme: 'dark',
  },
  {
    id: 'claude',
    name: 'Claude 橘',
    tone: '浅色 · 暖橘',
    description: '奶油侧栏配骨白纸面，陶土棕实心按钮与衬线标题。',
    swatches: ['#e9e2d2', '#f6f7f1', '#8a472d'],
    themeColor: '#f6f7f1',
    colorScheme: 'light',
  },
  {
    id: 'luxe-noir',
    name: '鎏金黑',
    tone: '深色 · 香槟金',
    description: '曜石黑底配香槟金细边框，金色渐变按钮与衬线标题。',
    swatches: ['#0e0d0b', '#1c1a15', '#d4af6a'],
    themeColor: '#0e0d0b',
    colorScheme: 'dark',
  },
  {
    id: 'luxe-ivory',
    name: '象牙金',
    tone: '浅色 · 古铜金',
    description: '象牙白纸面与暖米色侧栏，古铜金强调色与衬线标题。',
    swatches: ['#fbf8f1', '#f2eadb', '#a8782f'],
    themeColor: '#fbf8f1',
    colorScheme: 'light',
  },
];

export function isValidSkinId(skinId) {
  return SKINS.some((skin) => skin.id === skinId);
}

export function normalizeSkinId(skinId) {
  return isValidSkinId(skinId) ? skinId : DEFAULT_SKIN_ID;
}

export function getSkinMeta(skinId) {
  const normalized = normalizeSkinId(skinId);
  return SKINS.find((skin) => skin.id === normalized);
}

export function readSavedSkin() {
  try {
    return normalizeSkinId(localStorage.getItem(SKIN_STORAGE_KEY) || DEFAULT_SKIN_ID);
  } catch {
    return DEFAULT_SKIN_ID;
  }
}

export function saveSkin(skinId) {
  try {
    localStorage.setItem(SKIN_STORAGE_KEY, normalizeSkinId(skinId));
  } catch {
    // Ignore storage quota or private mode errors.
  }
}

export function applySkin(skinId) {
  const skin = getSkinMeta(skinId);
  const root = document.documentElement;
  root.dataset.skin = skin.id;
  root.style.colorScheme = skin.colorScheme;
  root.style.backgroundColor = skin.themeColor;
  if (document.body) {
    document.body.style.backgroundColor = skin.themeColor;
  }
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute('content', skin.themeColor);
  }
  return skin.id;
}
