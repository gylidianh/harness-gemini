# Third-party notices

## undici

Harness Gemini uses `undici` directly for the HTTP agent that carries model requests.

- Project: [undici](https://github.com/nodejs/undici)
- License: MIT
- Why it is a direct dependency: Node's built-in `fetch` applies its own 300-second
  `bodyTimeout`, measured between two body chunks. A Claude reply that spends longer than that
  thinking before its first visible token is killed by the runtime itself, which is reported to the
  user only as `terminated`. The agent configured in `server/http-agent.mjs` disables that hidden
  watchdog so this application's own, longer and explainable timeouts decide instead.

## ZCode browser interface and viewport behavior

Harness Gemini includes browser-specific adaptations from ZCode.

- Project: [ZCode](https://github.com/zai-org/ZCode)
- Source revision: [`aac4755666d09fdcd70272fcf063c077a639015f`](https://github.com/zai-org/ZCode/tree/aac4755666d09fdcd70272fcf063c077a639015f)
- Copyright: Copyright 2026 Z.AI Co., Ltd
- License: Apache License, Version 2.0. The complete upstream license is included in [third-party/ZCode-LICENSE.txt](third-party/ZCode-LICENSE.txt).
- The upstream notice is preserved in full in [third-party/ZCode-NOTICE.md](third-party/ZCode-NOTICE.md). It describes the upstream ZCode project; Harness Gemini's available features are documented in its own README and usage guides.

The following source files adapt ZCode's browser interface and viewport behavior to Harness Gemini's React interface, styling, and Electron IPC integration. Upstream paths refer to the pinned revision above. Changed portions are identified by attribution comments in the source.

| Harness Gemini file | Adapted ZCode source |
| --- | --- |
| `src/BrowserPanel.jsx` | `packages/ui/src/EmbeddedBrowserPaneParts.tsx`; `packages/ui/src/browser-use/BrowserViewportToolbar.tsx`; `packages/ui/src/browser-use/ResponsiveBrowserViewport.tsx`; `packages/ui/src/browser-use/ResponsiveBrowserResizeHandles.tsx` |
| `src/browserViewport.js` | `packages/ui/src/browser-use/browserViewportZoom.ts`; `packages/ui/src/browser-use/ResponsiveBrowserViewport.tsx`; `packages/shared/src/browser-use/command-metadata.ts` |
| `src/browser.css` | Layout measurements from the UI components listed above, plus the `theme-zai-dark` colors in `packages/ui/src/styles.css` |
| `desktop/browser.mjs` | Viewport behavior from `packages/ui/src/browser-use/browserViewportZoom.ts`, `packages/ui/src/browser-use/ResponsiveBrowserViewport.tsx`, and `packages/desktop/src/main/browserView/browserGuestManager.ts`; adapted to a clipped native WebContentsView and Harness Gemini's IPC |
| `desktop/browser-presentation.mjs` | `packages/shared/src/browser-use/command-metadata.ts`; adapted defaults, viewport limits, and preview zoom choices for local desktop preference storage |

Harness Gemini's supporting integration is in `desktop/main.mjs` and `desktop/preload.cjs`. The development preview controller in `src/browserPreview.js`, per-tab address-draft support in `src/browserTabs.js`, and shared URL validation in `shared/browser-navigation.mjs` are Harness Gemini support code. The webpage tab strip was implemented independently for Harness Gemini.

## ZCode context accounting, compaction policy, and usage panel

Harness Gemini's context-window accounting and conversation compaction are adaptations from the same ZCode revision, project, and license recorded above. Upstream paths refer to the pinned revision.

| Harness Gemini file | Adapted ZCode source |
| --- | --- |
| `server/context.mjs` | `apps/zcode-cli/packages/core/src/compact/policy.ts`; `apps/zcode-cli/packages/core/src/compact/manual.ts`; `apps/zcode-cli/packages/core/src/compact/prompt.ts`; `apps/zcode-cli/packages/core/src/compact/rounds.ts`; the usage panel described by `packages/ui/src/chat-input-toolbar/contextUsage.tsx` |
| `src/contextUsage.js` | `packages/ui/src/chat-input-toolbar/contextUsage.tsx`; `packages/ui/src/lib/tokenNumberFormat.ts` |

The upstream thresholds, the output-token reserve, the consecutive-failure circuit breaker, the summary prompt, and the compacted-context message ordering are reused; the surrounding run lifecycle, storage of the compaction boundary, streaming events, and React presentation are Harness Gemini's own. `src/ContextMeter.jsx` is Harness Gemini support code written against the upstream panel's described behaviour. Provider usage is treated as authoritative and any locally derived figure is labelled an estimate rather than a tokenizer result.

The original license and attribution continue to apply to the adapted portions. These notices are included with the source and in the packaged desktop application.

## ZCode composer attachments and desktop input context menu

Harness Gemini's composer attachments and its native right-click editing menu are adaptations from the same ZCode revision, project, and license recorded above. Upstream paths refer to the pinned revision.

| Harness Gemini file | Adapted ZCode source |
| --- | --- |
| `server/attachments.mjs` | `packages/ui/src/lib/chatAttachments.ts` (file families, `MAX_CHAT_ATTACHMENTS`, the 20 MiB attachment and 15 MiB inline image ceilings, the long-paste threshold, the path-reference model for non-image files); `packages/ui/src/v4/composer/attachmentUpload.ts` (local path means no upload, inline bytes become an artifact); `apps/zcode-cli/packages/core/src/runtime/helpers/attachment-pdf.ts` and `attachment-image.ts` (PDF and image admission, MIME validation and the derived cache); `docs/ui/chat-file-attachments.md` (the "text or attachments" admission rule, the upload status gates, and the rule that a spreadsheet paste is treated as text) |
| `desktop/context-menu.mjs` | `docs/ui/chat-input-native-context-menu-i18n.md` (Electron's `context-menu` event, every item keeping its `role`, labels supplied per locale, enabled state taken from `editFlags`); the menu message ids in `packages/shared/src/desktopMenu.ts` |
| `src/attachments.js`, `src/ComposerAttachments.jsx`, `src/attachments.css` | The composer attachment surface described by the same ZCode sources: chip states, per-file progress, retry and removal, and a single drop surface on the conversation pane |

The upload transport, the storage layout, the streaming events and the React presentation are Harness Gemini's own: files are written into the sending session's own working directory instead of a protocol upload transaction, and only references are stored on the message.

## ZCode per-turn file changes and line statistics

Harness Gemini 1.4.5 adapts ZCode's per-turn file-change model and change summary, from the same
ZCode project, copyright holder and license recorded above (Copyright 2026 Z.AI Co., Ltd, Apache
License 2.0; see [third-party/ZCode-LICENSE.txt](third-party/ZCode-LICENSE.txt) and
[third-party/ZCode-NOTICE.md](third-party/ZCode-NOTICE.md)).

| Harness Gemini file | Adapted ZCode source |
| --- | --- |
| `server/file-changes.mjs` | `computeLineChangeStat` from `packages/shared/src/lineChangeStat.ts`; the per-turn record shape (`ZCodePersistedFileChange`, `ZCodeTurnFileState`) from `packages/shared/src/zcode-task-types-core.ts`; turn aggregation from `packages/ui/src/lib/taskChangeSummary.ts` |
| `dist/file-changes.js`, `dist/file-changes.css` | Layout of `packages/ui/src/MessageChangeSummaryPanel.tsx` (collapsible per-turn card, `+added -removed`, revert action, per-file review rows), re-implemented with React.createElement and Harness Gemini theme variables |

Snapshot storage, conflict detection, revert/re-apply and the HTTP interface are Harness Gemini code.

## ZCode app usage statistics, activity heatmap, and model usage charts

Harness Gemini 1.4.6 adapts ZCode's local application token usage statistics, 52-week activity
heatmap, daily model trend chart, and model share donut chart, from the same ZCode project,
copyright holder and license recorded above (Copyright 2026 Z.AI Co., Ltd, Apache License 2.0;
see [third-party/ZCode-LICENSE.txt](third-party/ZCode-LICENSE.txt) and
[third-party/ZCode-NOTICE.md](third-party/ZCode-NOTICE.md)).

| Harness Gemini file | Adapted ZCode source |
| --- | --- |
| `server/usage-stats.mjs` | `queryAppUsage` and normalized token accounting from `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts`; `buildAppUsageSnapshot` and `resolveTzOffsetMs` from `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts`; `AppUsageSnapshot` schema from `packages/shared/src/usage-stats.ts` |
| `dist/usage-stats.js`, `dist/usage-stats.css` | `AppUsagePanel.tsx`, `UsageHeatmap.tsx`, `UsageHeatmapCells.tsx`, `AppUsageDailyModelTrendChart.tsx`, `AppUsageModelUsagePieChart.tsx`, `appUsageModelPieChartViewModel.ts`, `appUsageChartPalette.ts`, `usageStatsUiParts.tsx`, and `tokenNumberFormat.ts` under `packages/ui/src/settings/usage-stats/` and `packages/ui/src/lib/`, re-implemented with SVG, `React.createElement`, and Harness Gemini theme variables |

Monthly JSONL storage, fallback estimation for gateways that omit usage reports, and the Express HTTP endpoint are Harness Gemini code.
