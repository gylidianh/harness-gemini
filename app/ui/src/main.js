/**
 * Harness Gemini UI - Application Entrypoint
 * License: MIT
 */

import { React, createRoot, jsx } from '../vendor/vendor-deps.js';
import { applySkin, readSavedSkin } from './themes.js';
import { App } from './app.js';

applySkin(readSavedSkin());

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root container element in index.html');
}

createRoot(container).render(
  jsx(React.StrictMode, {
    children: jsx(App, {}),
  }),
);
