/**
 * Harness Gemini UI - Main Application Shell & State Orchestrator
 * License: MIT
 */

import {
  React,
  createPortal,
  jsx,
  jsxs,
  Fragment,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Bot,
  Check,
  CircleAlert,
  Earth,
  FolderOpen,
  Image,
  ImagePlus,
  LoaderCircle,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from '../vendor/vendor-deps.js';
import { createComposerModePicker } from '../modules/composer-controls.js';
import {
  createHeaderModelSelector,
  connectionModelPatch as headerModelPatch,
} from '../modules/model-selector.js';
import {
  createSessionToolsUI,
  mergeSessionIntoList as hgMergeSession,
} from '../modules/session-tools.js';
import { createFileChangesUI } from '../modules/file-changes.js';
import { bindBranchHost } from '../modules/branch-ui.js';
import {
  api,
  basenameOrWorkspace,
  copyImageToClipboard,
  sortSessionList,
  streamTurn,
} from './api.js';
import { applySkin, normalizeSkinId, readSavedSkin, saveSkin } from './themes.js';
import { createCompletionNotifier } from './notifications.js';
import {
  GOAL_CONTINUE_PROMPT,
  MAX_RIGHT_PANEL_WIDTH,
  MIN_MAIN_CHAT_WIDTH,
  MIN_RIGHT_PANEL_WIDTH,
  PERMISSION_MODES,
  RIGHT_PANEL_WIDTH_KEY,
  STOP_ABORT_TIMEOUT_MS,
  WELCOME_SUGGESTIONS,
  WORKBENCH_MODES,
  buildSlashMenuOptions,
  computeDefaultRightPanelWidth,
  computeNextFollowing,
  createGoalRecoveryState,
  detectSlashTrigger,
  getActiveProfile,
  getConfiguredModes,
  getProfileModelForMode,
  getReasoningLevelMeta,
  getSessionTitle,
  hasInnerScrollable,
  isNearBottom,
  isProfileConfigured,
  makeOptimisticId,
  nextGoalRecoveryStep,
  normalizeReasoningEffort,
  normalizeSessionRecord,
  readSavedActiveSessionId,
  readSavedRightPanelWidth,
  replaceSlashTrigger,
  resolveAvailableMode,
  shouldAutoScroll,
  stripLeadingGoalCommand,
  stripLeadingSubagentCommand,
  wasRunInterrupted,
} from './model-utils.js';
import {
  ArtifactImageCard,
  MessageItem,
  ReplyActivity,
  ReplyImageViewer,
  ReplyWaitingButton,
  countRunningSubagents,
  extractSubagentEntries,
} from './markdown-and-tools.js';
import { SubagentsPanel, WorkspacePanel } from './workspace-and-agents.js';
import { BrowserPanel, useBrowserBridge } from './browser-panel.js';
import { SettingsDrawer } from './settings-drawer.js';
import {
  AttachmentDropVeil,
  CompletionPopupStack,
  ComposerAttachments,
  ContextMeter,
  GoalModeChip,
  PermissionModePicker,
  ReasoningEffortPicker,
  RunErrorBanner,
  SelectedSkillChip,
  SkillEditorModal,
  SkillSlashMenu,
  SubagentModeChip,
  TokenMetricsBar,
  useAttachmentDropZone,
} from './composer-widgets.js';

const ComposerModePicker = createComposerModePicker(React, createPortal);
const HeaderModelSelector = createHeaderModelSelector(React, api, createPortal);
const {
  ChatHeaderFindButton,
  ChatHeadingBadges,
  ChatFindBar,
  SidebarListHeader,
  SessionStatusBadges,
  SessionRowActions,
  SessionDeleteModal,
} = createSessionToolsUI(React, api);
const { FileChangesSection } = createFileChangesUI(React);

export function App() {
  const [replyActivityOpen, setReplyActivityOpen] = React.useState(() => {
    try {
      return localStorage.getItem('hg.task-float') !== 'min';
    } catch {
      return true;
    }
  });

  const [sessions, setSessions] = React.useState([]);
  const [sessionMap, setSessionMap] = React.useState({});
  const [activeSessionId, setActiveSessionId] = React.useState(readSavedActiveSessionId);
  const [settings, setSettings] = React.useState(null);
  const [skin, setSkin] = React.useState(readSavedSkin);
  const [serviceStatus, setServiceStatus] = React.useState(null);
  const [booting, setBooting] = React.useState(true);
  const [serviceError, setServiceError] = React.useState('');
  const [loadingSession, setLoadingSession] = React.useState(false);
  const [sessionLoadError, setSessionLoadError] = React.useState('');
  const [creatingSession, setCreatingSession] = React.useState(false);
  const [sidebarSearchQuery, setSidebarSearchQuery] = React.useState('');

  const [draftTexts, setDraftTexts] = React.useState({});
  const [draftAttachments, setDraftAttachments] = React.useState({});
  const [preferredMode, setPreferredMode] = React.useState('chat');
  const [runningMap, setRunningMap] = React.useState({});
  const [runErrors, setRunErrors] = React.useState({});
  const [approvals, setApprovals] = React.useState({});
  const [decisions, setDecisions] = React.useState({});
  const [approvingMap, setApprovingMap] = React.useState({});

  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [quickSavingKind, setQuickSavingKind] = React.useState('');
  const [sidebarOpen, setSidebarOpen] = React.useState(() => window.innerWidth > 760);
  const [rightPanelOpen, setRightPanelOpen] = React.useState(false);
  const [rightPanelOverlay, setRightPanelOverlay] = React.useState(false);
  const [rightSurface, setRightSurface] = React.useState('workspace');
  const [workspaceTab, setWorkspaceTab] = React.useState('artifacts');
  const [rightPanelWidth, setRightPanelWidth] = React.useState(readSavedRightPanelWidth);
  const [resizingPanel, setResizingPanel] = React.useState(false);
  const [panelAnimating, setPanelAnimating] = React.useState(() => window.innerWidth >= 1100);
  const [browserFocusTick, setBrowserFocusTick] = React.useState(0);

  const [previewArtifact, setPreviewArtifact] = React.useState(null);
  const [, setPreviewFlag] = React.useState(false);
  const [previewCopyState, setPreviewCopyState] = React.useState('idle');
  const [deleteTarget, setDeleteTarget] = React.useState(null);
  const [deletingBusy, setDeletingBusy] = React.useState(false);
  const [workspaceRevision, setWorkspaceRevision] = React.useState(0);
  const [toast, setToast] = React.useState(null);
  const [completionNotices, setCompletionNotices] = React.useState([]);

  const [atBottom, setAtBottom] = React.useState(true);
  const [runElapsedSec, setRunElapsedSec] = React.useState(0);
  const [sessionContexts, setSessionContexts] = React.useState({});
  const [skills, setSkills] = React.useState([]);
  const [selectedSkills, setSelectedSkills] = React.useState({});
  const [goalEnabledMap, setGoalEnabledMap] = React.useState({});
  const [subagentEnabledMap, setSubagentEnabledMap] = React.useState({});
  const [slashMenuState, setSlashMenuState] = React.useState(null);
  const [skillEditorDraft, setSkillEditorDraft] = React.useState(null);
  const [loadingContext, setLoadingContext] = React.useState(false);

  const [hgFindOpen, setHgFindOpen] = React.useState(false);
  const [hgFindTick, setHgFindTick] = React.useState(0);
  const [hgFindSeed, setHgFindSeed] = React.useState('');
  const [hgSearchIds, setHgSearchIds] = React.useState(null);

  const attachmentsRef = React.useRef(null);
  const dropZone = useAttachmentDropZone();
  const activeRunsRef = React.useRef(new Map());
  const activeSessionIdRef = React.useRef(activeSessionId);
  const sessionMapRef = React.useRef(sessionMap);
  const creatingRef = React.useRef(false);
  const quickSavingRef = React.useRef(false);
  const bootSeqRef = React.useRef(0);
  const sessionReqSeqRef = React.useRef(0);

  const textareaRef = React.useRef(null);
  const composerAreaRef = React.useRef(null);
  const searchInputRef = React.useRef(null);
  const chatScrollRef = React.useRef(null);
  const chatContentRef = React.useRef(null);
  const appShellRef = React.useRef(null);
  const rightPanelRef = React.useRef(null);
  const panelResizeRef = React.useRef(null);

  const followingRef = React.useRef(true);
  const scrollTrackRef = React.useRef({ top: 0, height: 0 });
  const lastUserScrollTsRef = React.useRef(0);
  const pointerDraggingScrollRef = React.useRef(false);
  const toastTimerRef = React.useRef(null);

  const settingsRef = React.useRef(settings);
  const approvingRef = React.useRef(approvingMap);
  const noticeTimersRef = React.useRef(new Map());
  const notifierRef = React.useRef(null);
  const purgedIdsRef = React.useRef(new Set());
  const goalStatesRef = React.useRef(new Map());
  const goalTimersRef = React.useRef(new Map());
  const goalEnabledRef = React.useRef(goalEnabledMap);
  const subagentEnabledRef = React.useRef(subagentEnabledMap);
  const submitTurnRef = React.useRef(null);
  const prevRightOpenRef = React.useRef(false);

  activeSessionIdRef.current = activeSessionId;
  sessionMapRef.current = sessionMap;
  settingsRef.current = settings;
  approvingRef.current = approvingMap;
  goalEnabledRef.current = goalEnabledMap;
  subagentEnabledRef.current = subagentEnabledMap;

  const closeReplyImage = React.useCallback(() => setPreviewArtifact(null), []);

  React.useEffect(() => {
    const onOpenActivity = () => setReplyActivityOpen(true);
    const onOpenAgents = () => {
      setRightSurface('workspace');
      setWorkspaceTab('agents');
      setRightPanelOpen(true);
    };
    window.addEventListener('reply-activity-open', onOpenActivity);
    window.addEventListener('reply-agents-open', onOpenAgents);
    return () => {
      window.removeEventListener('reply-activity-open', onOpenActivity);
      window.removeEventListener('reply-agents-open', onOpenAgents);
    };
  }, []);

  const toggleReplyActivity = React.useCallback(() => {
    setReplyActivityOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('hg.task-float', next ? 'open' : 'min');
      } catch {
        // Ignore storage error.
      }
      return next;
    });
  }, []);

  const showToast = React.useCallback((message, kind = 'success') => {
    clearTimeout(toastTimerRef.current);
    setToast({ message, kind });
    toastTimerRef.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const dismissCompletionNotice = React.useCallback((noticeId) => {
    clearTimeout(noticeTimersRef.current.get(noticeId));
    noticeTimersRef.current.delete(noticeId);
    setCompletionNotices((prev) => prev.filter((item) => item.id !== noticeId));
  }, []);

  const openSessionAndScroll = React.useCallback((targetSessionId) => {
    if (purgedIdsRef.current.has(targetSessionId)) return;
    setActiveSessionId(targetSessionId);
    if (window.innerWidth <= 760) setSidebarOpen(false);
    if (window.innerWidth < 1100) setRightPanelOpen(false);
    followingRef.current = true;
    setAtBottom(true);
    requestAnimationFrame(() => {
      const scrollEl = chatScrollRef.current;
      if (scrollEl) {
        scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'auto' });
      }
    });
  }, []);

  const enqueueCompletionNotice = React.useCallback(
    (notice) => {
      clearTimeout(noticeTimersRef.current.get(notice.id));
      setCompletionNotices((prev) =>
        [...prev.filter((item) => item.id !== notice.id), notice].slice(-3),
      );
      noticeTimersRef.current.set(
        notice.id,
        setTimeout(() => dismissCompletionNotice(notice.id), 10_000),
      );
    },
    [dismissCompletionNotice],
  );

  notifierRef.current ||= createCompletionNotifier({
    getSettings: () => settingsRef.current,
    showPopup: enqueueCompletionNotice,
    openSession: openSessionAndScroll,
  });

  React.useEffect(() => {
    const unsubscribeDesktop = window.harnessDesktop?.onOpenSession?.(openSessionAndScroll);
    return () => {
      if (typeof unsubscribeDesktop === 'function') unsubscribeDesktop();
      for (const timer of noticeTimersRef.current.values()) clearTimeout(timer);
      noticeTimersRef.current.clear();
      notifierRef.current?.dispose();
    };
  }, [openSessionAndScroll]);

  const closeSettings = React.useCallback(() => setSettingsOpen(false), []);
  const openSettings = React.useCallback(() => {
    if (!quickSavingRef.current && !creatingRef.current) {
      setSettingsOpen(true);
    }
  }, []);

  const revealBrowserPanel = React.useCallback(() => {
    setRightSurface('browser');
    setRightPanelOpen(true);
    if (window.innerWidth <= 760) setSidebarOpen(false);
  }, []);

  const { bridge: browserBridge, state: browserState } = useBrowserBridge(revealBrowserPanel);
  const browserBridgeRef = React.useRef(null);
  browserBridgeRef.current = browserBridge;

  const openAndFocusBrowser = () => {
    revealBrowserPanel();
    setBrowserFocusTick((prev) => prev + 1);
  };

  const handleServerBrowserCommand = React.useCallback(
    async ({ id, action, args }) => {
      const bridge = browserBridgeRef.current;
      const sendReply = (payload) => api.browserResult(id, payload).catch(() => {});
      revealBrowserPanel();

      try {
        if (!bridge) throw new Error('内置浏览器暂时不可用。');
        if (!['open', 'screenshot'].includes(action) && typeof bridge.readPage !== 'function') {
          throw new Error('当前环境无法读取内置浏览器的页面文字，请在桌面版中使用。');
        }
        if (action === 'snapshot') {
          if (typeof bridge.snapshot !== 'function') {
            throw new Error('当前环境无法读取内置浏览器的页面结构，请在桌面版中使用。');
          }
          const snap = await bridge.snapshot();
          if (snap.error) throw new Error(snap.error);
          return sendReply({
            ok: true,
            result: {
              ...(snap.extra || {}),
              url: snap.url,
              title: snap.title,
              viewport: snap.viewport,
              elements: snap.elements,
              truncated: snap.truncated,
            },
          });
        }
        if (action === 'act') {
          if (typeof bridge.act !== 'function') {
            throw new Error('当前环境无法操作内置浏览器的页面，请在桌面版中使用。');
          }
          const actRes = await bridge.act(args);
          if (!actRes.ok) throw new Error(actRes.error);
          return sendReply({
            ok: true,
            result: {
              ...actRes.result,
              ...(actRes.result.extra || {}),
              extra: undefined,
            },
          });
        }
        if (action === 'screenshot') {
          if (typeof bridge.screenshot !== 'function') {
            throw new Error('当前环境无法截屏内置浏览器，请在 Harness Gemini 桌面版中使用。');
          }
          const shotRes = await bridge.screenshot(args);
          if (!shotRes.ok) throw new Error(shotRes.error);
          return sendReply({ ok: true, result: shotRes.result });
        }
        if (action === 'read') {
          const page = await bridge.readPage(args?.timeoutMs ?? 20_000);
          if (page.error) throw new Error(page.error);
          return sendReply({
            ok: true,
            result: {
              url: page.url,
              title: page.title,
              text: page.text,
              links: page.links,
              truncated: page.truncated,
            },
          });
        }
        if (action !== 'open' && action !== 'navigate') {
          throw new Error('不支持的浏览器操作。');
        }
        const navState = args?.url ? await bridge.navigate(args.url) : await bridge.getState();
        if (navState?.error) throw new Error(navState.error);
        if (action === 'open') {
          const vis =
            typeof bridge.visibility === 'function'
              ? await bridge.visibility(4000).catch(() => null)
              : null;
          return sendReply({
            ok: true,
            result: {
              url: navState.url,
              title: navState.title,
              loading: navState.loading,
              ...(vis ? { visible: vis.visible, hiddenReason: vis.hiddenReason } : {}),
            },
          });
        }
        const page = await bridge.readPage(args?.timeoutMs ?? 45_000);
        if (page.error) throw new Error(page.error);
        return sendReply({
          ok: true,
          result: {
            url: page.url || navState.url,
            title: page.title || navState.title,
            text: page.text,
            links: page.links,
            truncated: page.truncated,
          },
        });
      } catch (err) {
        return sendReply({
          ok: false,
          error: err?.message || '内置浏览器未能完成此操作。',
        });
      }
    },
    [revealBrowserPanel],
  );

  React.useEffect(() => {
    const justOpened = rightPanelOpen && !prevRightOpenRef.current;
    prevRightOpenRef.current = rightPanelOpen;
    if (!justOpened) return;
    setPanelAnimating(true);
    const timer = setTimeout(() => setPanelAnimating(false), 300);
    return () => clearTimeout(timer);
  }, [rightPanelOpen]);

  React.useEffect(() => {
    const checkOverlay = () => {
      const sidebarCssWidth =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'),
        ) || 256;
      const occupiedSidebar = sidebarOpen ? sidebarCssWidth : 0;
      setRightPanelOverlay(
        rightPanelOpen &&
          window.innerWidth - occupiedSidebar - MIN_MAIN_CHAT_WIDTH < MIN_RIGHT_PANEL_WIDTH,
      );
    };
    checkOverlay();
    window.addEventListener('resize', checkOverlay);
    return () => window.removeEventListener('resize', checkOverlay);
  }, [rightPanelOpen, sidebarOpen]);

  const clampRightPanelWidth = React.useCallback((candidateWidth) => {
    const shell = appShellRef.current;
    const sidebarCssWidth =
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) ||
      256;
    const occupiedSidebar = shell?.classList.contains('sidebar-collapsed') ? 0 : sidebarCssWidth;
    const availableMax = shell?.classList.contains('panel-overlay')
      ? window.innerWidth - 48
      : window.innerWidth - occupiedSidebar - MIN_MAIN_CHAT_WIDTH;
    return Math.round(
      Math.min(
        Math.max(candidateWidth, MIN_RIGHT_PANEL_WIDTH),
        Math.min(Math.max(MIN_RIGHT_PANEL_WIDTH, availableMax), MAX_RIGHT_PANEL_WIDTH),
      ),
    );
  }, []);

  const persistRightPanelWidth = React.useCallback((width) => {
    try {
      localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(Math.round(width)));
    } catch {
      // Ignore storage error.
    }
  }, []);

  const handlePanelGripPointerDown = (ev) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();
    const currentWidth = rightPanelRef.current?.getBoundingClientRect().width || rightPanelWidth;
    panelResizeRef.current = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startWidth: currentWidth,
    };
    try {
      ev.currentTarget.setPointerCapture(ev.pointerId);
    } catch {
      // Ignore pointer capture failure.
    }
    setResizingPanel(true);
  };

  const handlePanelGripPointerMove = (ev) => {
    const session = panelResizeRef.current;
    if (session && session.pointerId === ev.pointerId) {
      ev.preventDefault();
      setRightPanelWidth(clampRightPanelWidth(session.startWidth + (session.startX - ev.clientX)));
    }
  };

  const handlePanelGripPointerEnd = (ev) => {
    if (
      panelResizeRef.current &&
      ev?.pointerId !== undefined &&
      ev.pointerId !== panelResizeRef.current.pointerId
    ) {
      return;
    }
    panelResizeRef.current = null;
    setResizingPanel(false);
    const measured = rightPanelRef.current?.getBoundingClientRect().width;
    if (measured > 0) {
      const rounded = Math.round(measured);
      setRightPanelWidth(rounded);
      persistRightPanelWidth(rounded);
    }
  };

  const handlePanelGripKeyDown = (ev) => {
    const step = ev.shiftKey ? 60 : 20;
    let target = null;
    if (ev.key === 'ArrowLeft') target = rightPanelWidth + step;
    else if (ev.key === 'ArrowRight') target = rightPanelWidth - step;
    else if (ev.key === 'Home') target = computeDefaultRightPanelWidth();
    if (target === null) return;

    ev.preventDefault();
    const clamped = clampRightPanelWidth(target);
    setRightPanelWidth(clamped);
    persistRightPanelWidth(clamped);
  };

  const applyLoadedSettings = React.useCallback((nextSettings) => {
    setPreferredMode((prevMode) => resolveAvailableMode(getActiveProfile(nextSettings), prevMode));
    setSettings(nextSettings);
    setSkin(normalizeSkinId(nextSettings?.skin));
  }, []);

  React.useEffect(() => {
    applySkin(skin);
    saveSkin(skin);
  }, [skin]);

  const handleSkinPreviewChange = React.useCallback((nextSkinId) => {
    setSkin(normalizeSkinId(nextSkinId));
  }, []);

  const updateSessionRecord = React.useCallback((targetId, updater) => {
    setSessionMap((prev) => {
      const base = prev[targetId] || { id: targetId, title: '新对话', messages: [] };
      return {
        ...prev,
        [targetId]: normalizeSessionRecord(updater(base)),
      };
    });
  }, []);

  const mergeLoadedSession = React.useCallback((sessionObj) => {
    if (!sessionObj?.id) return;
    const normalized = normalizeSessionRecord(sessionObj);
    setSessionMap((prev) => ({ ...prev, [normalized.id]: normalized }));
    setSessions((prevList) => hgMergeSession(normalized, prevList));
  }, []);

  const refreshSessionsList = React.useCallback(async () => {
    const res = await api.sessions();
    const list = Array.isArray(res) ? res : res.sessions || [];
    setSessions(sortSessionList(list));
    return list;
  }, []);

  bindBranchHost({
    openSession: openSessionAndScroll,
    refresh: refreshSessionsList,
    toast: showToast,
  });

  const bootstrapWorkbench = React.useCallback(async () => {
    const seq = ++bootSeqRef.current;
    setBooting(true);
    setServiceError('');

    const settled = await Promise.allSettled([
      api.status(),
      api.settings(),
      api.sessions(),
      api.skills(),
    ]);
    if (seq !== bootSeqRef.current) return;

    const firstRejected = settled.find((item) => item.status === 'rejected');
    const statusVal = settled[0].status === 'fulfilled' ? settled[0].value : null;
    if (statusVal) setServiceStatus(statusVal);

    if (settled[1].status === 'fulfilled') {
      applyLoadedSettings(settled[1].value);
    }

    if (settled[2].status === 'fulfilled') {
      const rawSessions = settled[2].value;
      const sorted = sortSessionList(
        Array.isArray(rawSessions) ? rawSessions : rawSessions.sessions || [],
      );
      setSessions(sorted);
      const initialId = activeSessionIdRef.current ?? statusVal?.lastSessionId;
      if (!initialId || !sorted.some((item) => item.id === initialId)) {
        setActiveSessionId(sorted[0]?.id || null);
      }
    }

    if (settled[3].status === 'fulfilled') {
      const rawSkills = settled[3].value;
      setSkills(Array.isArray(rawSkills) ? rawSkills : rawSkills?.skills || []);
    }

    if (firstRejected) {
      setServiceError(firstRejected.reason.message);
    }
    setBooting(false);
  }, [applyLoadedSettings]);

  React.useEffect(() => {
    bootstrapWorkbench();
    return () => {
      bootSeqRef.current += 1;
      clearTimeout(toastTimerRef.current);
    };
  }, [bootstrapWorkbench]);

  const fetchActiveSessionDetail = React.useCallback(
    async (targetId) => {
      if (!targetId) return;
      const seq = ++sessionReqSeqRef.current;
      setSessionLoadError('');
      setLoadingSession(!sessionMapRef.current[targetId]);
      try {
        const detail = await api.session(targetId);
        if (seq !== sessionReqSeqRef.current || activeSessionIdRef.current !== targetId) return;
        if (!activeRunsRef.current.has(targetId)) {
          mergeLoadedSession(detail);
        }
      } catch (err) {
        if (seq === sessionReqSeqRef.current && activeSessionIdRef.current === targetId) {
          setSessionLoadError(err.message);
        }
      } finally {
        if (seq === sessionReqSeqRef.current) {
          setLoadingSession(false);
        }
      }
    },
    [mergeLoadedSession],
  );

  React.useEffect(() => {
    if (!activeSessionId || runningMap[activeSessionId]) return;
    let active = true;
    setLoadingContext(true);
    api
      .sessionContext(activeSessionId)
      .then((ctxData) => {
        if (active) {
          setSessionContexts((prev) => ({ ...prev, [activeSessionId]: ctxData }));
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoadingContext(false);
      });
    return () => {
      active = false;
    };
  }, [activeSessionId, runningMap, workspaceRevision]);

  React.useEffect(() => {
    try {
      if (activeSessionId) {
        localStorage.setItem('harness.activeSession', activeSessionId);
      } else {
        localStorage.removeItem('harness.activeSession');
      }
    } catch {
      // Ignore storage error.
    }
    if (activeSessionId) {
      api.activateSession(activeSessionId).catch(() => {});
    }
    followingRef.current = true;
    setAtBottom(true);
    setSessionLoadError('');
    if (activeSessionId) {
      fetchActiveSessionDetail(activeSessionId);
    } else {
      sessionReqSeqRef.current += 1;
      setLoadingSession(false);
    }
  }, [activeSessionId, fetchActiveSessionDetail]);

  const currentSession = activeSessionId ? sessionMap[activeSessionId] : null;
  const activeRunState = activeSessionId ? runningMap[activeSessionId] : null;
  const activeRunEntry = activeRunState ? activeRunsRef.current.get(activeSessionId) : null;

  const sessionWorkspace = currentSession?.workspace || '';
  const effectiveWorkspace =
    sessionWorkspace || settings?.workspace || serviceStatus?.workspace || '';
  const hasAnyRunning = Object.keys(runningMap).length > 0;
  const profilesList = Array.isArray(settings?.profiles) ? settings.profiles : [];
  const currentProfile = getActiveProfile(settings);
  const configuredModeIds = getConfiguredModes(currentProfile);
  const availableWorkbenchModes = WORKBENCH_MODES.filter((m) => configuredModeIds.includes(m.id));
  const availableSuggestions = WELCOME_SUGGESTIONS.filter((s) =>
    configuredModeIds.includes(s.mode),
  );
  const resolvedMode = resolveAvailableMode(currentProfile, preferredMode);
  const hasImageMode = configuredModeIds.includes('image');
  const currentPermissionMode = PERMISSION_MODES.some((m) => m.id === settings?.approvalMode)
    ? settings.approvalMode
    : 'ask';
  const currentProtocol = currentProfile?.protocol || 'chat';
  const currentReasoningEffort = normalizeReasoningEffort(currentProfile?.reasoningEffort);

  const draftBucketKey = activeSessionId || 'new';
  const currentDraftText = draftTexts[draftBucketKey] || '';
  const currentSelectedSkill = selectedSkills[draftBucketKey] || null;
  const isGoalModeOn = Boolean(goalEnabledMap[draftBucketKey]);
  const isSubagentModeOn = Boolean(subagentEnabledMap[draftBucketKey]);
  const currentAttachments = draftAttachments[draftBucketKey] || [];
  const hasUploadingAttachment = currentAttachments.some((item) => item.status === 'uploading');
  const hasUnreadyAttachment =
    currentAttachments.length > 0 && currentAttachments.some((item) => item.status !== 'ready');

  const activeModeSpec = WORKBENCH_MODES.find((m) => m.id === resolvedMode);
  const isReadyToChat = isProfileConfigured(currentProfile) && Boolean(activeModeSpec);
  const configuredModelForMode = getProfileModelForMode(currentProfile, resolvedMode);
  const composerPlaceholder = booting
    ? '正在读取模型配置…'
    : activeModeSpec
      ? isReadyToChat
        ? activeModeSpec.placeholder
        : '先在设置中补全连接地址，即可开始…'
      : '先配置至少一个模型，即可开始…';

  const currentMessages = currentSession?.messages || [];
  const hgSessionTasks = Array.isArray(currentSession?.tasks)
    ? currentSession.tasks
    : [...currentMessages]
        .reverse()
        .find((m) => m.role === 'assistant' && Array.isArray(m.tasks) && m.tasks.length)?.tasks ||
      [];

  const latestAssistantMessage = React.useMemo(() => {
    if (activeRunState) {
      return currentMessages.find((m) => m.id === activeRunEntry?.assistantId) || null;
    }
    return [...currentMessages].reverse().find((m) => m.role === 'assistant') || null;
  }, [currentMessages, activeRunState, activeRunEntry?.assistantId]);

  const savedSessionContext = activeSessionId ? sessionContexts[activeSessionId] : null;
  const lastMessageWithContext = React.useMemo(
    () => [...currentMessages].reverse().find((m) => m.role === 'assistant' && m.context) || null,
    [currentMessages],
  );
  const displayContext = activeRunState
    ? latestAssistantMessage?.context ?? null
    : lastMessageWithContext?.context ?? savedSessionContext?.context ?? null;
  const isContextLive =
    Boolean(activeRunState) || Boolean(savedSessionContext?.live && !lastMessageWithContext);

  const activeSessionSummary = sessions.find((s) => s.id === activeSessionId);
  const headingTitle = getSessionTitle(currentSession || activeSessionSummary || {});

  const subagentEntries = React.useMemo(
    () => extractSubagentEntries(currentMessages),
    [currentMessages],
  );
  const runningSubagentCount = countRunningSubagents(subagentEntries);

  const sessionArtifacts = React.useMemo(() => {
    const seenUrls = new Set();
    return currentMessages
      .flatMap((m) => m.artifacts || [])
      .filter((art) => {
        if (!art.url || seenUrls.has(art.url)) return false;
        seenUrls.add(art.url);
        return true;
      });
  }, [currentMessages]);

  const filteredSessions = React.useMemo(() => {
    const query = sidebarSearchQuery.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter(
      (s) => getSessionTitle(s).toLowerCase().includes(query) || hgSearchIds?.has(s.id),
    );
  }, [sessions, sidebarSearchQuery, hgSearchIds]);

  const pendingApprovalsBySession = React.useMemo(() => {
    const counts = {};
    for (const [sid, sessionObj] of Object.entries(sessionMap)) {
      counts[sid] = runningMap[sid]
        ? (sessionObj.messages || [])
            .filter((m) => m.status === 'running')
            .flatMap((m) => m.tools || [])
            .filter((t) => t.status === 'pending' && t.approvalId && !decisions[t.approvalId])
            .length
        : 0;
    }
    return counts;
  }, [sessionMap, decisions, runningMap]);

  React.useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 190)}px`;
    }
  }, [currentDraftText]);

  React.useEffect(() => {
    const areaEl = composerAreaRef.current;
    if (!areaEl) return;
    const syncHeight = () => {
      areaEl.parentElement?.style.setProperty(
        '--composer-height',
        `${areaEl.getBoundingClientRect().height}px`,
      );
      const scrollEl = chatScrollRef.current;
      if (followingRef.current && !pointerDraggingScrollRef.current && scrollEl) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      }
    };
    const observer = new ResizeObserver(syncHeight);
    observer.observe(areaEl);
    syncHeight();
    return () => observer.disconnect();
  }, []);

  const updateFollowState = (shouldFollow) => {
    followingRef.current = Boolean(shouldFollow);
    setAtBottom(
      Boolean(chatScrollRef.current) &&
        isNearBottom(chatScrollRef.current) &&
        followingRef.current,
    );
  };

  const isUserSelectingChatText = () => {
    const scrollEl = chatScrollRef.current;
    if (!scrollEl || typeof window.getSelection !== 'function') return false;
    const sel = window.getSelection();
    const anchor = sel && !sel.isCollapsed ? sel.anchorNode : null;
    return Boolean(anchor && scrollEl.contains(anchor.nodeType === 1 ? anchor : anchor.parentNode));
  };

  const isScrollInteractionBusy = React.useCallback(
    () => Boolean(pointerDraggingScrollRef.current) || isUserSelectingChatText(),
    [],
  );

  const handleChatScroll = React.useCallback(() => {
    const scrollEl = chatScrollRef.current;
    if (!scrollEl) return;
    const prev = scrollTrackRef.current;
    const delta = scrollEl.scrollTop - prev.top;
    const height = scrollEl.scrollHeight;
    const shrunk = height < prev.height;
    const userInitiated =
      pointerDraggingScrollRef.current || Date.now() - lastUserScrollTsRef.current < 600;
    prev.top = scrollEl.scrollTop;
    prev.height = height;

    updateFollowState(
      computeNextFollowing({
        delta: shrunk || !userInitiated ? 0 : delta,
        atEnd: isNearBottom(scrollEl),
        following: followingRef.current,
      }),
    );
  }, []);

  React.useEffect(() => {
    const scrollEl = chatScrollRef.current;
    if (!scrollEl) return;

    const onWheel = (ev) => {
      if (hasInnerScrollable(ev.target, scrollEl)) return;
      lastUserScrollTsRef.current = Date.now();
      if (ev.deltaY < 0 && scrollEl.scrollTop > 1) {
        updateFollowState(false);
      }
    };
    const onPointerDown = () => {
      pointerDraggingScrollRef.current = true;
      lastUserScrollTsRef.current = Date.now();
    };
    const onPointerEnd = () => {
      pointerDraggingScrollRef.current = false;
    };
    const onTouchOrKey = () => {
      lastUserScrollTsRef.current = Date.now();
    };
    const onPointerMove = (ev) => {
      if (!ev.buttons) pointerDraggingScrollRef.current = false;
    };

    scrollEl.addEventListener('wheel', onWheel, { passive: true });
    scrollEl.addEventListener('pointerdown', onPointerDown, { passive: true });
    scrollEl.addEventListener('pointermove', onPointerMove, { passive: true });
    scrollEl.addEventListener('touchstart', onTouchOrKey, { passive: true });
    scrollEl.addEventListener('touchmove', onTouchOrKey, { passive: true });
    scrollEl.addEventListener('keydown', onTouchOrKey);
    window.addEventListener('pointerup', onPointerEnd, { passive: true });
    window.addEventListener('pointercancel', onPointerEnd, { passive: true });
    window.addEventListener('blur', onPointerEnd);

    return () => {
      scrollEl.removeEventListener('wheel', onWheel);
      scrollEl.removeEventListener('pointerdown', onPointerDown);
      scrollEl.removeEventListener('pointermove', onPointerMove);
      scrollEl.removeEventListener('touchstart', onTouchOrKey);
      scrollEl.removeEventListener('touchmove', onTouchOrKey);
      scrollEl.removeEventListener('keydown', onTouchOrKey);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      window.removeEventListener('blur', onPointerEnd);
    };
  }, [booting, loadingSession]);

  React.useEffect(() => {
    const contentEl = chatContentRef.current;
    const scrollEl = chatScrollRef.current;
    if (!contentEl) return;

    const onResize = () => {
      const scroller = chatScrollRef.current;
      if (
        currentMessages.length &&
        scroller &&
        shouldAutoScroll({ following: followingRef.current, busy: isScrollInteractionBusy() })
      ) {
        scroller.scrollTop = scroller.scrollHeight;
      }
      updateFollowState(followingRef.current);
    };

    const observer = new ResizeObserver(onResize);
    observer.observe(contentEl);
    if (scrollEl) observer.observe(scrollEl);
    onResize();
    return () => observer.disconnect();
  }, [activeSessionId, booting, loadingSession, currentMessages.length, isScrollInteractionBusy]);

  React.useEffect(() => {
    const scrollEl = chatScrollRef.current;
    if (followingRef.current && scrollEl && currentMessages.length && !isScrollInteractionBusy()) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
    updateFollowState(followingRef.current);
  }, [currentMessages, isScrollInteractionBusy]);

  React.useEffect(() => {
    if (!activeRunState) {
      setRunElapsedSec(0);
      return;
    }
    const tick = () => setRunElapsedSec(Math.floor((Date.now() - activeRunState.startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [activeRunState?.startedAt, activeSessionId]);

  React.useEffect(() => {
    const onGlobalKeyDown = (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === 'f') {
        ev.preventDefault();
        let selectedSeed = '';
        try {
          const selText = String(window.getSelection?.()?.toString?.() || '').trim();
          if (selText && selText.length <= 80 && !/[\r\n]/.test(selText)) {
            selectedSeed = selText;
          }
        } catch {
          // Ignore selection read error.
        }
        setHgFindSeed(selectedSeed);
        setHgFindOpen(true);
        setHgFindTick((prev) => prev + 1);
        return;
      }

      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        setSidebarOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }

      if ((ev.ctrlKey || ev.metaKey) && ev.key === ',') {
        ev.preventDefault();
        openSettings();
      }

      if (ev.key === 'Escape') {
        if (hgFindOpen && !previewArtifact && !deleteTarget) {
          ev.preventDefault();
          setHgFindOpen(false);
          return;
        }
        const targetNode = ev.target instanceof Element ? ev.target : document.activeElement;
        if (targetNode instanceof Element && targetNode.closest('.right-panel')) return;
        const activeEl = document.activeElement;
        if (activeEl instanceof Element && activeEl.closest('.right-panel')) return;

        setPreviewArtifact(null);
        if (!deletingBusy) setDeleteTarget(null);
        if (rightPanelOpen && !previewArtifact && !deleteTarget) {
          setRightPanelOpen(false);
        }
      }
    };

    window.addEventListener('keydown', onGlobalKeyDown);
    return () => window.removeEventListener('keydown', onGlobalKeyDown);
  }, [deletingBusy, openSettings, rightPanelOpen, previewArtifact, deleteTarget, hgFindOpen]);

  React.useEffect(() => {
    const query = sidebarSearchQuery.trim();
    if (!query) {
      setHgSearchIds(null);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      api
        .searchSessions(query)
        .then((res) => {
          if (active && Array.isArray(res?.results)) {
            setHgSearchIds(new Set(res.results.map((item) => item.sessionId)));
          }
        })
        .catch(() => {});
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [sidebarSearchQuery]);

  const selectSession = (sessionId) => {
    setActiveSessionId(sessionId);
    if (window.innerWidth <= 760) setSidebarOpen(false);
  };

  const handleCreateSession = async () => {
    if (creatingRef.current) return null;
    creatingRef.current = true;
    setCreatingSession(true);
    try {
      const created = await api.createSession();
      mergeLoadedSession(created);
      setActiveSessionId(created.id);
      activeSessionIdRef.current = created.id;
      setSidebarSearchQuery('');
      if (window.innerWidth <= 760) setSidebarOpen(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return created;
    } catch (err) {
      showToast(err.message, 'error');
      return null;
    } finally {
      setCreatingSession(false);
      creatingRef.current = false;
    }
  };

  const toggleGoalMode = React.useCallback(
    (bucketId) => {
      const key = bucketId ?? activeSessionIdRef.current ?? 'new';
      const nextEnabled = !goalEnabledRef.current[key];
      setGoalEnabledMap((prev) => ({ ...prev, [key]: nextEnabled }));
      goalEnabledRef.current = { ...goalEnabledRef.current, [key]: nextEnabled };

      if (nextEnabled) {
        goalStatesRef.current.set(key, createGoalRecoveryState());
      } else {
        goalStatesRef.current.delete(key);
        clearTimeout(goalTimersRef.current.get(key));
        goalTimersRef.current.delete(key);
      }
      showToast(
        nextEnabled ? '目标模式已开启：任务中断时自动继续' : '目标模式已关闭',
        'info',
      );
    },
    [showToast],
  );

  const toggleSubagentMode = React.useCallback(
    (bucketId) => {
      const key = bucketId ?? activeSessionIdRef.current ?? 'new';
      const nextEnabled = !subagentEnabledRef.current[key];
      setSubagentEnabledMap((prev) => ({ ...prev, [key]: nextEnabled }));
      subagentEnabledRef.current = { ...subagentEnabledRef.current, [key]: nextEnabled };
      showToast(
        nextEnabled ? '团队模式已开启：让队长用 team_run 组队' : '团队模式已关闭',
        'info',
      );
    },
    [showToast],
  );

  const handleSwitchMode = (nextMode) => {
    if (!configuredModeIds.includes(nextMode)) return false;
    setPreferredMode(nextMode);
    if (nextMode === 'image') {
      setRightSurface('workspace');
      setWorkspaceTab('artifacts');
    }
    if (nextMode === 'agent') {
      setRightSurface('workspace');
      setWorkspaceTab('workspace');
    }
    textareaRef.current?.focus();
    return true;
  };

  const ensureAssistantPlaceholder = (
    sessionObj,
    runEntry,
    assistantId = runEntry.assistantId,
  ) => {
    if (!assistantId || sessionObj.messages.some((m) => m.id === assistantId)) {
      return sessionObj;
    }
    return {
      ...sessionObj,
      messages: [
        ...sessionObj.messages,
        {
          id: assistantId,
          role: 'assistant',
          text: '',
          reasoning: '',
          createdAt: new Date().toISOString(),
          mode: runEntry.mode,
          status: 'running',
          tools: [],
          artifacts: [],
          tasks: [],
          compactions: [],
          context: null,
        },
      ],
    };
  };

  const updateAttachmentsForSession = React.useCallback((updater, targetBucket) => {
    setDraftAttachments((prev) => {
      const key = targetBucket ?? activeSessionIdRef.current ?? 'new';
      const existing = prev[key] || [];
      const next = typeof updater === 'function' ? updater(existing) : updater;
      return { ...prev, [key]: next };
    });
  }, []);

  const closeSlashMenu = React.useCallback(() => setSlashMenuState(null), []);

  const refreshSlashTriggerFromInput = React.useCallback((inputEl) => {
    if (!inputEl) {
      setSlashMenuState(null);
      return;
    }
    const trigger = detectSlashTrigger(inputEl.value, inputEl.selectionStart);
    setSlashMenuState(trigger ? { ...trigger, index: 0 } : null);
  }, []);

  const handleComposerTextChange = React.useCallback(
    (ev) => {
      const nextText = ev.target.value;
      setDraftTexts((prev) => ({ ...prev, [draftBucketKey]: nextText }));
      refreshSlashTriggerFromInput(ev.target);
    },
    [draftBucketKey, refreshSlashTriggerFromInput],
  );

  const handleSelectSlashOption = React.useCallback(
    (option) => {
      const inputEl = textareaRef.current;
      const trigger = inputEl
        ? detectSlashTrigger(inputEl.value, inputEl.selectionStart)
        : null;
      if (!trigger) {
        setSlashMenuState(null);
        return;
      }

      if (option.kind === 'command' && option.action === 'toggle-goal') {
        const replaced = replaceSlashTrigger(currentDraftText, trigger, '');
        setDraftTexts((prev) => ({ ...prev, [draftBucketKey]: replaced.text }));
        toggleGoalMode(draftBucketKey);
        setSlashMenuState(null);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(replaced.caret, replaced.caret);
          }
        });
        return;
      }

      if (option.kind === 'command' && option.action === 'toggle-subagent') {
        const replaced = replaceSlashTrigger(currentDraftText, trigger, '');
        setDraftTexts((prev) => ({ ...prev, [draftBucketKey]: replaced.text }));
        toggleSubagentMode(draftBucketKey);
        setSlashMenuState(null);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(replaced.caret, replaced.caret);
          }
        });
        return;
      }

      if (option.kind === 'command') {
        const replaced = replaceSlashTrigger(currentDraftText, trigger, option.insert);
        setDraftTexts((prev) => ({ ...prev, [draftBucketKey]: replaced.text }));
        setSlashMenuState(null);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(replaced.caret, replaced.caret);
          }
        });
        return;
      }

      const replaced = replaceSlashTrigger(currentDraftText, trigger, '');
      setDraftTexts((prev) => ({ ...prev, [draftBucketKey]: replaced.text }));
      setSelectedSkills((prev) => ({
        ...prev,
        [draftBucketKey]:
          option.kind === 'skill'
            ? { id: option.id, name: option.name, text: option.text }
            : null,
      }));
      setSlashMenuState(null);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(replaced.caret, replaced.caret);
        }
      });
    },
    [currentDraftText, draftBucketKey, toggleGoalMode, toggleSubagentMode],
  );

  const openSkillEditor = React.useCallback((skill) => {
    setSlashMenuState(null);
    setSkillEditorDraft(
      skill
        ? { id: skill.id, name: skill.name, text: skill.text, existing: true }
        : { id: '', name: '', text: '', existing: false },
    );
  }, []);

  const handleSaveSkill = React.useCallback(
    async (draftObj) => {
      const saved = draftObj.existing
        ? await api.updateSkill(draftObj.id, { name: draftObj.name, text: draftObj.text })
        : await api.createSkill({ name: draftObj.name, text: draftObj.text });

      setSkills((prev) =>
        draftObj.existing
          ? prev.map((item) => (item.id === saved.id ? saved : item))
          : [saved, ...prev],
      );
      setSelectedSkills((prev) =>
        Object.fromEntries(
          Object.entries(prev).map(([key, val]) => [
            key,
            val?.id === saved.id
              ? { id: saved.id, name: saved.name, text: saved.text }
              : val,
          ]),
        ),
      );
      setSkillEditorDraft(null);
      showToast(draftObj.existing ? '技能已更新' : '技能已添加');
    },
    [showToast],
  );

  const handleDeleteSkill = React.useCallback(
    async (skillId) => {
      await api.deleteSkill(skillId);
      setSkills((prev) => prev.filter((item) => item.id !== skillId));
      setSelectedSkills((prev) =>
        Object.fromEntries(
          Object.entries(prev).map(([key, val]) => [key, val?.id === skillId ? null : val]),
        ),
      );
      setSkillEditorDraft(null);
      showToast('技能已删除');
    },
    [showToast],
  );

  const evaluateGoalModeAfterRun = (sessionId, runEntry) => {
    if (!goalEnabledRef.current[sessionId]) return;
    const interrupted = wasRunInterrupted({
      hadError: runEntry.hadError,
      stopping: runEntry.stopping,
      deleted: runEntry.deleted || runEntry.deleting,
      userReceived: runEntry.userReceived,
    });
    const step = nextGoalRecoveryStep(goalStatesRef.current.get(sessionId), { interrupted });
    goalStatesRef.current.set(sessionId, step.state);

    if (step.action === 'idle') return;

    if (step.action === 'stop') {
      goalStatesRef.current.delete(sessionId);
      clearTimeout(goalTimersRef.current.get(sessionId));
      goalTimersRef.current.delete(sessionId);
      setGoalEnabledMap((prev) => ({ ...prev, [sessionId]: false }));
      goalEnabledRef.current = { ...goalEnabledRef.current, [sessionId]: false };
      showToast(`目标模式已停止：短时间内连续 ${step.failures} 次异常。`, 'error');
      return;
    }

    clearTimeout(goalTimersRef.current.get(sessionId));
    goalTimersRef.current.set(
      sessionId,
      setTimeout(() => {
        goalTimersRef.current.delete(sessionId);
        if (goalEnabledRef.current[sessionId] && !activeRunsRef.current.has(sessionId)) {
          submitTurnRef.current?.(null, {
            sessionId,
            mode: runEntry.mode,
            text: GOAL_CONTINUE_PROMPT,
          });
        }
      }, step.delay),
    );
    showToast(
      `任务中断，${Math.round(step.delay / 1000)} 秒后自动继续（第 ${step.resumes} 次）`,
      'info',
    );
  };

  const handleSubmitTurn = async (ev, autoResumeSpec = null) => {
    ev?.preventDefault();
    const isAutoResume = Boolean(autoResumeSpec);

    const strippedGoal = isAutoResume ? null : stripLeadingGoalCommand(currentDraftText);
    if (strippedGoal) {
      setDraftTexts((prev) => ({ ...prev, [draftBucketKey]: strippedGoal.rest }));
      if (!goalEnabledRef.current[draftBucketKey]) toggleGoalMode(draftBucketKey);
      if (!strippedGoal.rest) return;
    }

    const strippedSubagent = isAutoResume
      ? null
      : stripLeadingSubagentCommand(strippedGoal ? strippedGoal.rest : currentDraftText);
    if (strippedSubagent) {
      setDraftTexts((prev) => ({ ...prev, [draftBucketKey]: strippedSubagent.rest }));
      if (!subagentEnabledRef.current[draftBucketKey]) toggleSubagentMode(draftBucketKey);
      if (!strippedSubagent.rest) return;
    }

    const skillToSend = isAutoResume ? null : currentSelectedSkill;
    const textToSend = (
      isAutoResume
        ? autoResumeSpec.text
        : strippedSubagent
          ? strippedSubagent.rest
          : strippedGoal
            ? strippedGoal.rest
            : currentDraftText
    ).trim();
    const attachmentsToSend = isAutoResume ? [] : currentAttachments;

    if (
      (!textToSend && !attachmentsToSend.length) ||
      (!isAutoResume && activeRunState) ||
      creatingRef.current ||
      booting ||
      quickSavingRef.current
    ) {
      return;
    }

    if (!isReadyToChat) {
      if (!isAutoResume) {
        openSettings();
        showToast('先连接模型，就可以开始了', 'info');
      }
      return;
    }

    if (attachmentsToSend.some((att) => att.status !== 'ready')) {
      showToast('请等待附件上传完成，或移除上传失败的附件', 'info');
      return;
    }

    const readyAttachments = attachmentsToSend.map((att) => ({
      ref: att.ref,
      name: att.name,
      mime: att.mime,
      size: att.size,
      path: att.path,
    }));

    notifierRef.current.prepare();

    let targetSessionId = isAutoResume ? autoResumeSpec.sessionId : activeSessionId;
    if (!targetSessionId) {
      const created = await handleCreateSession();
      if (!created) return;
      targetSessionId = created.id;

      if (goalEnabledRef.current[draftBucketKey]) {
        goalStatesRef.current.set(targetSessionId, createGoalRecoveryState());
        setGoalEnabledMap((prev) => ({ ...prev, [targetSessionId]: true }));
        goalEnabledRef.current = { ...goalEnabledRef.current, [targetSessionId]: true };
      }
      if (subagentEnabledRef.current[draftBucketKey]) {
        setSubagentEnabledMap((prev) => ({ ...prev, [targetSessionId]: true }));
        subagentEnabledRef.current = { ...subagentEnabledRef.current, [targetSessionId]: true };
      }
    }

    if (!targetSessionId || activeRunsRef.current.has(targetSessionId)) return;

    const runMode = isAutoResume && autoResumeSpec.mode ? autoResumeSpec.mode : resolvedMode;
    const optimisticUserId = makeOptimisticId('user');
    const useSubagent = isAutoResume
      ? Boolean(subagentEnabledRef.current[targetSessionId])
      : Boolean(subagentEnabledRef.current[targetSessionId] || isSubagentModeOn);

    const runEntry = {
      sessionId: targetSessionId,
      mode: runMode,
      subagent: useSubagent,
      model: configuredModelForMode,
      profileId: settings?.activeProfileId,
      profileName: currentProfile?.name,
      approvalMode: currentPermissionMode,
      controller: new AbortController(),
      assistantId: null,
      notificationId: crypto.randomUUID(),
      userReceived: false,
      finished: false,
      stopping: false,
      deleted: false,
      hadError: false,
      optimisticId: optimisticUserId,
      startedAt: Date.now(),
    };

    activeRunsRef.current.set(targetSessionId, runEntry);
    setRunningMap((prev) => ({
      ...prev,
      [targetSessionId]: { startedAt: runEntry.startedAt, stopping: false },
    }));
    setRunErrors((prev) => ({ ...prev, [targetSessionId]: '' }));

    if (!isAutoResume) {
      setDraftTexts((prev) => ({ ...prev, [draftBucketKey]: '', [targetSessionId]: '' }));
      setDraftAttachments((prev) => ({ ...prev, [draftBucketKey]: [], [targetSessionId]: [] }));
      setSelectedSkills((prev) => ({ ...prev, [draftBucketKey]: null, [targetSessionId]: null }));
    }

    updateSessionRecord(targetSessionId, (sess) => ({
      ...sess,
      messages: [
        ...sess.messages,
        {
          id: optimisticUserId,
          role: 'user',
          text: textToSend,
          mode: runMode,
          status: 'done',
          createdAt: new Date().toISOString(),
          ...(readyAttachments.length ? { attachments: readyAttachments } : {}),
          ...(skillToSend ? { skill: skillToSend } : {}),
          ...(useSubagent ? { subagent: true } : {}),
        },
      ],
    }));

    if (!isAutoResume || activeSessionIdRef.current === targetSessionId) {
      followingRef.current = true;
      setAtBottom(true);
      if (runMode === 'image') {
        setRightSurface('workspace');
        setWorkspaceTab('artifacts');
        if (window.innerWidth >= 1100) setRightPanelOpen(true);
      }
    }

    const notifyRunError = () => {
      if (!isAutoResume) {
        notifierRef.current.notify(runEntry, {
          sessionId: targetSessionId,
          messageId: runEntry.assistantId || runEntry.notificationId,
          mode: runEntry.mode,
          status: 'error',
          title:
            sessionMapRef.current[targetSessionId]?.title ||
            textToSend.trim().replace(/\s+/g, ' ').slice(0, 48),
        });
      }
    };

    const handleStreamEvent = (eventType, payload) => {
      if (
        runEntry.finished ||
        runEntry.deleted ||
        activeRunsRef.current.get(targetSessionId) !== runEntry
      ) {
        return;
      }

      switch (eventType) {
        case 'user': {
          const serverMsg = payload.message || payload;
          runEntry.userReceived = true;
          updateSessionRecord(targetSessionId, (sess) => ({
            ...sess,
            messages: [
              ...sess.messages.filter(
                (m) => m.id !== optimisticUserId && m.id !== serverMsg.id,
              ),
              serverMsg,
            ],
          }));
          break;
        }
        case 'assistant_start':
          runEntry.assistantId = payload.id;
          updateSessionRecord(targetSessionId, (sess) =>
            ensureAssistantPlaceholder(sess, runEntry, payload.id),
          );
          break;
        case 'text_delta': {
          const msgId = payload.id || runEntry.assistantId;
          if (!msgId) break;
          runEntry.assistantId = msgId;
          updateSessionRecord(targetSessionId, (sess) => {
            const next = ensureAssistantPlaceholder(sess, runEntry, msgId);
            return {
              ...next,
              messages: next.messages.map((m) =>
                m.id === msgId
                  ? {
                      ...m,
                      text: `${m.text || ''}${payload.text || ''}`,
                      ...(m.noticeKind === 'busy' ? { notice: null, noticeKind: null } : {}),
                    }
                  : m,
              ),
            };
          });
          break;
        }
        case 'reasoning_delta': {
          const msgId = payload.id || runEntry.assistantId;
          if (!msgId) break;
          runEntry.assistantId = msgId;
          updateSessionRecord(targetSessionId, (sess) => {
            const next = ensureAssistantPlaceholder(sess, runEntry, msgId);
            return {
              ...next,
              messages: next.messages.map((m) =>
                m.id === msgId
                  ? {
                      ...m,
                      reasoning: `${m.reasoning || ''}${payload.text || ''}`,
                      ...(m.noticeKind === 'busy' ? { notice: null, noticeKind: null } : {}),
                    }
                  : m,
              ),
            };
          });
          break;
        }
        case 'notice': {
          const msgId = payload.id || runEntry.assistantId;
          if (!msgId) break;
          runEntry.assistantId = msgId;
          updateSessionRecord(targetSessionId, (sess) => {
            const next = ensureAssistantPlaceholder(sess, runEntry, msgId);
            return {
              ...next,
              messages: next.messages.map((m) =>
                m.id === msgId
                  ? { ...m, notice: payload.message || '', noticeKind: payload.kind || 'info' }
                  : m,
              ),
            };
          });
          break;
        }
        case 'retry': {
          const msgId = payload.id || runEntry.assistantId;
          if (!msgId) break;
          runEntry.assistantId = msgId;
          updateSessionRecord(targetSessionId, (sess) => {
            const next = ensureAssistantPlaceholder(sess, runEntry, msgId);
            return {
              ...next,
              messages: next.messages.map((m) =>
                m.id === msgId
                  ? {
                      ...m,
                      notice: payload.message || '正在重新连接…',
                      noticeKind: 'busy',
                    }
                  : m,
              ),
            };
          });
          break;
        }
        case 'metrics': {
          const msgId = payload.id || runEntry.assistantId;
          if (!msgId || !payload.metrics) break;
          runEntry.assistantId ||= msgId;
          updateSessionRecord(targetSessionId, (sess) => {
            const next = ensureAssistantPlaceholder(sess, runEntry, msgId);
            return {
              ...next,
              messages: next.messages.map((m) =>
                m.id === msgId
                  ? { ...m, metrics: { ...m.metrics, ...payload.metrics } }
                  : m,
              ),
            };
          });
          break;
        }
        case 'context': {
          const msgId = payload.id || runEntry.assistantId;
          if (!msgId || !payload.context) break;
          runEntry.assistantId ||= msgId;
          updateSessionRecord(targetSessionId, (sess) => {
            const next = ensureAssistantPlaceholder(sess, runEntry, msgId);
            return {
              ...next,
              messages: next.messages.map((m) =>
                m.id === msgId ? { ...m, context: payload.context } : m,
              ),
            };
          });
          break;
        }
        case 'compaction': {
          const msgId = payload.id || runEntry.assistantId;
          if (!msgId || !payload.compaction) break;
          runEntry.assistantId ||= msgId;
          updateSessionRecord(targetSessionId, (sess) => {
            const next = ensureAssistantPlaceholder(sess, runEntry, msgId);
            return {
              ...next,
              messages: next.messages.map((m) => {
                if (m.id !== msgId) return m;
                const list = m.compactions || [];
                return {
                  ...m,
                  compactions: list.some((c) => c.id === payload.compaction.id)
                    ? list.map((c) => (c.id === payload.compaction.id ? payload.compaction : c))
                    : [...list, payload.compaction],
                };
              }),
            };
          });
          break;
        }
        case 'tool':
          updateSessionRecord(targetSessionId, (sess) => {
            const next = ensureAssistantPlaceholder(sess, runEntry);
            return {
              ...next,
              messages: next.messages.map((m) => {
                if (m.id !== runEntry.assistantId) return m;
                const tools = m.tools || [];
                return {
                  ...m,
                  tools: tools.some((t) => t.id === payload.id)
                    ? tools.map((t) => (t.id === payload.id ? { ...t, ...payload } : t))
                    : [...tools, payload],
                };
              }),
            };
          });
          if (
            payload.status === 'done' &&
            /write|edit|command|shell|download/.test(payload.name || '')
          ) {
            setWorkspaceRevision((prev) => prev + 1);
          }
          break;
        case 'approval':
          setApprovals((prev) => ({
            ...prev,
            [payload.id]: { ...payload, sessionId: targetSessionId },
          }));
          break;
        case 'browser':
          handleServerBrowserCommand(payload);
          break;
        case 'question':
          updateSessionRecord(targetSessionId, (sess) => {
            const next = ensureAssistantPlaceholder(sess, runEntry);
            return {
              ...next,
              messages: next.messages.map((m) => {
                if (m.id !== runEntry.assistantId) return m;
                const questions = m.questions || [];
                return {
                  ...m,
                  questions: questions.some((q) => q.id === payload.id)
                    ? questions.map((q) => (q.id === payload.id ? { ...q, ...payload } : q))
                    : [...questions, payload],
                };
              }),
            };
          });
          break;
        case 'tasks':
          updateSessionRecord(targetSessionId, (sess) => {
            const next = ensureAssistantPlaceholder(sess, runEntry);
            return {
              ...next,
              tasks: payload.tasks,
              messages: next.messages.map((m) =>
                m.id === runEntry.assistantId ? { ...m, tasks: payload.tasks } : m,
              ),
            };
          });
          break;
        case 'artifact':
          updateSessionRecord(targetSessionId, (sess) => {
            const next = ensureAssistantPlaceholder(sess, runEntry);
            return {
              ...next,
              messages: next.messages.map((m) =>
                m.id === runEntry.assistantId
                  ? {
                      ...m,
                      artifacts: [
                        ...(m.artifacts || []).filter(
                          (art) => art.id !== payload.id && art.url !== payload.url,
                        ),
                        payload,
                      ],
                    }
                  : m,
              ),
            };
          });
          break;
        case 'done':
          runEntry.finished = true;
          if (payload.session) {
            mergeLoadedSession(payload.session);
          } else {
            updateSessionRecord(targetSessionId, (sess) => ({
              ...sess,
              messages: sess.messages.map((m) =>
                m.id === runEntry.assistantId
                  ? {
                      ...m,
                      status: runEntry.stopping
                        ? 'cancelled'
                        : runEntry.hadError
                          ? 'error'
                          : 'done',
                    }
                  : m,
              ),
            }));
          }
          setWorkspaceRevision((prev) => prev + 1);
          notifierRef.current.notify(runEntry, payload.completion);
          break;
        case 'error':
          runEntry.hadError = true;
          setRunErrors((prev) => ({
            ...prev,
            [targetSessionId]: payload.message || '这次请求未能完成，请检查连接后重试。',
          }));
          updateSessionRecord(targetSessionId, (sess) => ({
            ...sess,
            messages: sess.messages.map((m) =>
              m.id === (payload.id || runEntry.assistantId)
                ? { ...m, status: 'error', error: payload.message || m.error || '' }
                : m,
            ),
          }));
          notifyRunError();
          break;
      }
    };

    try {
      await streamTurn(
        targetSessionId,
        {
          text: textToSend,
          mode: runEntry.mode,
          ...(readyAttachments.length
            ? { attachments: readyAttachments.map((att) => att.ref) }
            : {}),
          ...(skillToSend ? { skill: skillToSend } : {}),
          ...(useSubagent ? { subagent: true } : {}),
        },
        {
          signal: runEntry.controller.signal,
          onEvent: handleStreamEvent,
        },
      );

      if (!runEntry.finished && !runEntry.hadError && !runEntry.stopping) {
        throw new Error('连接提前结束。已收到的内容会保留，你可以重新打开会话查看。');
      }
    } catch (err) {
      if (
        !runEntry.finished &&
        !runEntry.stopping &&
        !runEntry.deleted &&
        !runEntry.deleting
      ) {
        runEntry.hadError = true;
        setRunErrors((prev) => ({ ...prev, [targetSessionId]: err.message }));
        updateSessionRecord(targetSessionId, (sess) => ({
          ...sess,
          messages: sess.messages
            .filter((m) => runEntry.userReceived || m.id !== optimisticUserId)
            .map((m) =>
              m.id === runEntry.assistantId
                ? { ...m, status: 'error', error: m.error || err.message }
                : m,
            ),
        }));

        if (!runEntry.userReceived && !isAutoResume) {
          setDraftTexts((prev) => ({
            ...prev,
            [targetSessionId]: prev[targetSessionId] || currentDraftText,
          }));
          if (skillToSend) {
            setSelectedSkills((prev) => ({
              ...prev,
              [targetSessionId]: prev[targetSessionId] || skillToSend,
            }));
          }
          if (readyAttachments.length) {
            setDraftAttachments((prev) => ({
              ...prev,
              [targetSessionId]: prev[targetSessionId]?.length
                ? prev[targetSessionId]
                : readyAttachments.map((att, idx) => ({
                    ...att,
                    id: `attachment-restored-${idx}`,
                    status: 'ready',
                  })),
            }));
          }
        }
        notifyRunError();
      }
    } finally {
      clearTimeout(runEntry.stopTimer);
      if (!runEntry.finished && !runEntry.deleted) {
        try {
          const fresh = await api.session(targetSessionId);
          if (activeRunsRef.current.get(targetSessionId) === runEntry) {
            mergeLoadedSession(fresh);
          }
        } catch {
          // Ignore session resync failure.
        }
      }
      if (activeRunsRef.current.get(targetSessionId) === runEntry) {
        activeRunsRef.current.delete(targetSessionId);
        setRunningMap((prev) => {
          const next = { ...prev };
          delete next[targetSessionId];
          return next;
        });
      }
      if (!runEntry.deleted && !runEntry.deleting) {
        refreshSessionsList().catch(() => {});
      }
      evaluateGoalModeAfterRun(targetSessionId, runEntry);
    }
  };

  submitTurnRef.current = handleSubmitTurn;

  const handleStopActiveRun = async () => {
    const sid = activeSessionId;
    const runEntry = activeRunsRef.current.get(sid);
    if (!runEntry || runEntry.stopping) return;

    clearTimeout(goalTimersRef.current.get(sid));
    goalTimersRef.current.delete(sid);
    runEntry.stopping = true;
    setRunningMap((prev) => ({
      ...prev,
      [sid]: { ...prev[sid], stopping: true },
    }));
    runEntry.stopTimer = setTimeout(() => {
      if (!runEntry.finished) runEntry.controller.abort();
    }, STOP_ABORT_TIMEOUT_MS);

    try {
      await api.stop(sid);
    } catch (err) {
      showToast(`停止请求未完成：${err.message}`, 'error');
    }
  };

  const handleApproveTool = React.useCallback(
    async (approvalId, approved) => {
      if (approvingRef.current[approvalId]) return;
      setApprovingMap((prev) => ({ ...prev, [approvalId]: true }));
      try {
        await api.approve(approvalId, approved);
        setDecisions((prev) => ({
          ...prev,
          [approvalId]: approved ? 'approved' : 'denied',
        }));
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        setApprovingMap((prev) => ({ ...prev, [approvalId]: false }));
      }
    },
    [showToast],
  );

  const purgeRemovedSessionIds = (removedIds) => {
    const idSet = new Set(removedIds);
    for (const id of idSet) {
      purgedIdsRef.current.add(id);
      clearTimeout(goalTimersRef.current.get(id));
      goalTimersRef.current.delete(id);
      goalStatesRef.current.delete(id);
    }

    setCompletionNotices((prev) => prev.filter((item) => !idSet.has(item.sessionId)));
    const remainingSessions = sessions.filter((s) => !idSet.has(s.id));
    setSessions(remainingSessions);

    const stripFromMap = (prev) => {
      const next = { ...prev };
      for (const id of idSet) delete next[id];
      return next;
    };
    setSessionMap(stripFromMap);
    setDraftTexts(stripFromMap);
    setDraftAttachments(stripFromMap);
    setSessionContexts(stripFromMap);
    setGoalEnabledMap(stripFromMap);
    setSubagentEnabledMap(stripFromMap);

    if (activeSessionIdRef.current && idSet.has(activeSessionIdRef.current)) {
      setActiveSessionId(remainingSessions[0]?.id || null);
    }
  };

  const handleConfirmSingleDelete = async (explicitSession = deleteTarget) => {
    const target = explicitSession?.id ? explicitSession : deleteTarget;
    if (!target?.id || deletingBusy) return;
    if (target.locked) {
      showToast('此对话已锁定，请先解锁后再删除', 'error');
      setDeleteTarget(null);
      return;
    }

    const sid = target.id;
    const runEntry = activeRunsRef.current.get(sid);
    setDeletingBusy(true);

    try {
      if (runEntry) {
        runEntry.deleting = true;
        await api.stop(sid);
        runEntry.controller.abort();
      }
      const res = await api.deleteSession(sid);
      if (runEntry) {
        runEntry.deleting = false;
        runEntry.deleted = res?.recordDeleted === true;
      }
      if (res?.recordDeleted) {
        purgeRemovedSessionIds([sid]);
      }
      setDeleteTarget(null);
      await refreshSessionsList().catch(() => {});

      const statusText = res?.cleanupComplete
        ? '对话记录及关联数据已清理完成'
        : res?.recordDeleted
          ? '对话记录已删除，但关联清理未完成；可再次一键删除重试。'
          : '对话记录未删除，请重试。';
      const failureDetails = res?.failures?.length
        ? ` 详情：${res.failures
            .slice(0, 3)
            .map((f) => `${f.stage}: ${f.path || ''} ${f.message}`)
            .join('；')}`
        : '';
      showToast(statusText + failureDetails, res?.cleanupComplete ? 'info' : 'error');
    } catch (err) {
      if (runEntry) {
        runEntry.deleting = false;
        runEntry.deleted = false;
      }
      refreshSessionsList().catch(() => {});
      showToast(err.message, 'error');
    } finally {
      setDeletingBusy(false);
    }
  };

  const handleConfirmBulkDelete = async ({ includePinned = true } = {}) => {
    if (deletingBusy) return;
    const candidateIds = sessions
      .filter((s) => !s.locked && (includePinned || !s.pinned))
      .map((s) => s.id);

    setDeletingBusy(true);
    try {
      for (const sid of candidateIds) {
        const runEntry = activeRunsRef.current.get(sid);
        if (runEntry) {
          runEntry.deleting = true;
          try {
            await api.stop(sid);
          } catch {
            // Ignore stop error before bulk delete.
          }
          runEntry.controller.abort();
        }
      }

      const res = await api.bulkDeleteSessions({ includePinned });
      const deletedIds = Array.isArray(res?.deletedIds) ? res.deletedIds : [];
      for (const sid of candidateIds) {
        const runEntry = activeRunsRef.current.get(sid);
        if (runEntry) {
          runEntry.deleting = false;
          runEntry.deleted = deletedIds.includes(sid);
        }
      }

      purgeRemovedSessionIds(deletedIds);
      setDeleteTarget(null);
      await refreshSessionsList().catch(() => {});

      const summaryMsg =
        `已删除 ${res?.deletedCount ?? deletedIds.length} 个对话` +
        (res?.skippedLockedCount ? `（已保留 ${res.skippedLockedCount} 个锁定对话）` : '') +
        (res?.retriedCount ? `（重试清理 ${res.retriedCount} 个）` : '') +
        (res?.failedCount ? `；${res.failedCount} 个对话记录未删除，请重试` : '') +
        (res?.cleanupFailedCount
          ? `；${res.cleanupFailedCount} 个记录已删除但关联清理未完成，可再次一键删除重试`
          : '') +
        (res?.skippedRunningCount ? `；${res.skippedRunningCount} 个仍在运行，已保留` : '') +
        (res?.cleanupFailures?.length || res?.failures?.length
          ? ` 详情：${[...(res.cleanupFailures || []), ...(res.failures || [])]
              .slice(0, 3)
              .map((f) => `${f.id || ''} ${f.stage || 'record'}: ${f.path || ''} ${f.message}`)
              .join('；')}`
          : '');

      showToast(summaryMsg, res?.failedCount || res?.cleanupFailedCount ? 'error' : 'info');
    } catch (err) {
      for (const sid of candidateIds) {
        const runEntry = activeRunsRef.current.get(sid);
        if (runEntry) {
          runEntry.deleting = false;
          runEntry.deleted = false;
        }
      }
      refreshSessionsList().catch(() => {});
      showToast(err.message, 'error');
    } finally {
      setDeletingBusy(false);
    }
  };

  const handleTogglePinSession = async (sessionItem) => {
    if (!sessionItem?.id) return;
    const sid = sessionItem.id;
    const nextPinned = !sessionItem.pinned;
    const nextPinnedAt = nextPinned ? new Date().toISOString() : null;

    setSessions((prev) =>
      sortSessionList(
        prev.map((s) => (s.id === sid ? { ...s, pinned: nextPinned, pinnedAt: nextPinnedAt } : s)),
      ),
    );
    setSessionMap((prev) =>
      prev[sid]
        ? { ...prev, [sid]: { ...prev[sid], pinned: nextPinned, pinnedAt: nextPinnedAt } }
        : prev,
    );

    try {
      const updated = await api.updateSessionFlags(sid, { pinned: nextPinned });
      setSessions((prev) =>
        sortSessionList(
          prev.map((s) =>
            s.id === sid
              ? { ...s, pinned: Boolean(updated.pinned), pinnedAt: updated.pinnedAt ?? null }
              : s,
          ),
        ),
      );
      setSessionMap((prev) =>
        prev[sid]
          ? {
              ...prev,
              [sid]: {
                ...prev[sid],
                pinned: Boolean(updated.pinned),
                pinnedAt: updated.pinnedAt ?? null,
              },
            }
          : prev,
      );
      showToast(updated.pinned ? '对话已置顶' : '已取消置顶', 'info');
    } catch (err) {
      refreshSessionsList().catch(() => {});
      showToast(err.message, 'error');
    }
  };

  const handleToggleLockSession = async (sessionItem) => {
    if (!sessionItem?.id) return;
    const sid = sessionItem.id;
    const nextLocked = !sessionItem.locked;
    const nextLockedAt = nextLocked ? new Date().toISOString() : null;

    setSessions((prev) =>
      sortSessionList(
        prev.map((s) => (s.id === sid ? { ...s, locked: nextLocked, lockedAt: nextLockedAt } : s)),
      ),
    );
    setSessionMap((prev) =>
      prev[sid]
        ? { ...prev, [sid]: { ...prev[sid], locked: nextLocked, lockedAt: nextLockedAt } }
        : prev,
    );

    try {
      const updated = await api.updateSessionFlags(sid, { locked: nextLocked });
      setSessions((prev) =>
        sortSessionList(
          prev.map((s) =>
            s.id === sid
              ? { ...s, locked: Boolean(updated.locked), lockedAt: updated.lockedAt ?? null }
              : s,
          ),
        ),
      );
      setSessionMap((prev) =>
        prev[sid]
          ? {
              ...prev,
              [sid]: {
                ...prev[sid],
                locked: Boolean(updated.locked),
                lockedAt: updated.lockedAt ?? null,
              },
            }
          : prev,
      );
      showToast(updated.locked ? '对话已锁定，无法被删除' : '对话已解锁', 'info');
    } catch (err) {
      refreshSessionsList().catch(() => {});
      showToast(err.message, 'error');
    }
  };

  const handleDeleteRowClick = (sessionItem, ev) => {
    if (!sessionItem) return;
    if (sessionItem.locked) {
      showToast('此对话已锁定，请先点击锁图标解锁后再删除', 'error');
      return;
    }
    if (ev?.shiftKey) {
      handleConfirmSingleDelete(sessionItem);
      return;
    }
    setDeleteTarget(sessionItem);
  };

  const handleRequestBulkDelete = () => {
    setDeleteTarget({ mode: 'bulk' });
  };

  const handleSettingsSaved = React.useCallback(
    async (savedSettings) => {
      applyLoadedSettings(savedSettings);
      setWorkspaceRevision((prev) => prev + 1);
      try {
        setServiceStatus(await api.status());
      } catch {
        // Ignore status refresh failure.
      }
    },
    [applyLoadedSettings],
  );

  const saveQuickSettingsPatch = async (patch, kind) => {
    if (quickSavingRef.current || !settings) return false;
    quickSavingRef.current = true;
    setQuickSavingKind(kind);

    try {
      const savedRes = await api.saveSettings(patch);
      const nextSettings = Array.isArray(savedRes?.profiles) ? savedRes : await api.settings();
      applyLoadedSettings(nextSettings);

      if (kind === 'profile') {
        const chosenName =
          nextSettings.profiles?.find((p) => p.id === nextSettings.activeProfileId)?.name ||
          '所选连接';
        showToast(hasAnyRunning ? '连接已切换，从下一条消息生效' : `已切换到 ${chosenName}`);
      } else if (kind === 'model') {
        showToast(hasAnyRunning ? '模型已切换，从下一条消息生效' : '模型已切换');
      } else if (kind === 'permission') {
        const permLabel =
          PERMISSION_MODES.find((m) => m.id === nextSettings.approvalMode)?.label || '请求批准';
        showToast(hasAnyRunning ? '操作权限已切换，从下一条请求生效' : `已切换为${permLabel}`);
      }
      return true;
    } catch (err) {
      showToast(err.message, 'error');
      return false;
    } finally {
      quickSavingRef.current = false;
      setQuickSavingKind('');
    }
  };

  const handlePermissionChange = (nextMode) =>
    !PERMISSION_MODES.some((m) => m.id === nextMode) || nextMode === currentPermissionMode
      ? Promise.resolve(false)
      : saveQuickSettingsPatch({ approvalMode: nextMode }, 'permission');

  const handleReasoningEffortChange = async (nextEffort) => {
    const normalized = normalizeReasoningEffort(nextEffort);
    if (normalized === currentReasoningEffort) return false;
    const ok = await saveQuickSettingsPatch({ reasoningEffort: normalized }, 'reasoning');
    if (ok) {
      const label = normalized
        ? getReasoningLevelMeta(normalized)?.label || normalized
        : '模型默认';
      showToast(
        hasAnyRunning ? `推理等级已设为${label}，从下一条消息生效` : `推理等级已设为${label}`,
      );
    }
    return ok;
  };

  const openImagePreview = React.useCallback((artifact) => {
    setPreviewArtifact(artifact);
    setPreviewFlag(false);
    setPreviewCopyState('idle');
  }, []);

  const handleApplySuggestion = (suggestion) => {
    if (handleSwitchMode(suggestion.mode)) {
      setDraftTexts((prev) => ({ ...prev, [draftBucketKey]: suggestion.prompt }));
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  // Preserve preview copy helper in case external extensions invoke it.
  void copyImageToClipboard;
  void previewCopyState;

  return jsxs('div', {
    ref: appShellRef,
    'data-skin': skin,
    className: `app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'} ${rightPanelOpen ? 'has-right-panel' : ''} ${rightPanelOpen && rightSurface === 'browser' ? 'has-browser-panel' : ''} ${rightPanelOverlay ? 'panel-overlay' : ''} ${resizingPanel ? 'panel-resizing' : ''}`,
    style: { '--panel-user-width': `${rightPanelWidth}px` },
    children: [
      sidebarOpen &&
        jsxs(Fragment, {
          children: [
            jsx('button', {
              className: 'sidebar-mobile-shade',
              'aria-label': '关闭会话列表',
              onClick: () => setSidebarOpen(false),
            }),
            jsxs('aside', {
              className: 'sidebar',
              children: [
                jsxs('div', {
                  className: 'brand',
                  'aria-label': 'Harness Gemini',
                  children: [
                    jsx('span', { className: 'brand-wordmark', 'aria-hidden': 'true' }),
                    jsx('button', {
                      className: 'icon-button sidebar-collapse',
                      title: '收起侧栏',
                      'aria-label': '收起侧栏',
                      onClick: () => setSidebarOpen(false),
                      children: jsx(PanelLeftClose, { size: 16 }),
                    }),
                  ],
                }),
                jsxs('div', {
                  className: 'sidebar-controls',
                  children: [
                    jsxs('button', {
                      className: 'new-session-button',
                      onClick: handleCreateSession,
                      disabled: creatingSession || booting,
                      children: [
                        creatingSession
                          ? jsx(LoaderCircle, { size: 16, className: 'spin' })
                          : jsx(Plus, { size: 18 }),
                        jsx('span', { children: '新对话' }),
                        jsx('span', { className: 'new-session-symbol', children: '＋' }),
                      ],
                    }),
                    jsxs('div', {
                      className: 'session-search',
                      children: [
                        jsx(Search, { size: 14 }),
                        jsx('input', {
                          ref: searchInputRef,
                          placeholder: '搜索对话',
                          value: sidebarSearchQuery,
                          onChange: (ev) => setSidebarSearchQuery(ev.target.value),
                          'aria-label': '搜索对话',
                        }),
                        sidebarSearchQuery
                          ? jsx('button', {
                              className: 'icon-button tiny',
                              onClick: () => setSidebarSearchQuery(''),
                              'aria-label': '清除搜索',
                              children: jsx(X, { size: 12 }),
                            })
                          : jsx('kbd', { children: 'Ctrl K' }),
                      ],
                    }),
                  ],
                }),
                jsx(SidebarListHeader, {
                  searching: Boolean(sidebarSearchQuery),
                  filteredCount: filteredSessions.length,
                  totalCount: sessions.length,
                  unlockedCount: sessions.filter((s) => !s.locked).length,
                  disabled: booting || deletingBusy,
                  onRequestBulkDelete: handleRequestBulkDelete,
                }),
                jsx('nav', {
                  className: 'session-list',
                  'aria-label': '会话列表',
                  children: booting
                    ? jsxs('div', {
                        className: 'sidebar-loading',
                        children: [jsx(LoaderCircle, { size: 16, className: 'spin' }), '正在读取'],
                      })
                    : filteredSessions.length
                      ? filteredSessions.map((item) =>
                          jsxs(
                            'div',
                            {
                              className: `session-row ${item.id === activeSessionId ? 'active' : ''} ${item.pinned ? 'is-pinned' : ''} ${item.locked ? 'is-locked' : ''}`,
                              children: [
                                jsxs('button', {
                                  className: 'session-open',
                                  onClick: () => selectSession(item.id),
                                  title: getSessionTitle(item),
                                  children: [
                                    runningMap[item.id]
                                      ? jsx(LoaderCircle, {
                                          size: 15,
                                          className: 'spin session-running',
                                        })
                                      : jsx(MessageSquare, { size: 15 }),
                                    jsx('span', { children: getSessionTitle(item) }),
                                    (pendingApprovalsBySession[item.id] > 0 ||
                                      sessionMap[item.id]?.messages?.some(
                                        (m) =>
                                          m.status === 'running' &&
                                          m.questions?.some((q) => q.status === 'pending'),
                                      )) &&
                                      jsx('span', {
                                        className: 'session-pending reply-session-waiting',
                                        title: '等待你的确认或回答',
                                        children: '⚠',
                                      }),
                                    jsx(SessionStatusBadges, { session: item }),
                                  ],
                                }),
                                jsx(SessionRowActions, {
                                  session: item,
                                  title: getSessionTitle(item),
                                  onTogglePin: handleTogglePinSession,
                                  onToggleLock: handleToggleLockSession,
                                  onDeleteClick: handleDeleteRowClick,
                                }),
                              ],
                            },
                            item.id,
                          ),
                        )
                      : jsx('div', {
                          className: 'sidebar-empty',
                          children: sidebarSearchQuery
                            ? '没有找到匹配的对话'
                            : jsxs(Fragment, {
                                children: [
                                  '这里会收好你的每一次对话。',
                                  jsx('br', {}),
                                  '从上方的新对话开始吧。',
                                ],
                              }),
                        }),
                }),
                jsxs('div', {
                  className: 'sidebar-footer',
                  children: [
                    jsxs('button', {
                      className: 'workspace-shortcut',
                      onClick: () => {
                        setRightSurface('workspace');
                        setWorkspaceTab('workspace');
                        setRightPanelOpen(true);
                        if (window.innerWidth <= 760) setSidebarOpen(false);
                      },
                      title: effectiveWorkspace || '查看工作目录',
                      children: [
                        jsx('span', {
                          className: 'workspace-shortcut-icon',
                          children: jsx(FolderOpen, { size: 16 }),
                        }),
                        jsxs('span', {
                          children: [
                            jsx('strong', { children: basenameOrWorkspace(effectiveWorkspace) }),
                            jsx('small', {
                              children: sessionWorkspace ? '本会话工作目录' : '本地工作区',
                            }),
                          ],
                        }),
                        jsx(ArrowUpRight, { size: 14 }),
                      ],
                    }),
                    jsxs('div', {
                      className: 'sidebar-bottom',
                      children: [
                        jsxs('button', {
                          className: `browser-shortcut ${rightPanelOpen && rightSurface === 'browser' ? 'active' : ''}`,
                          onClick: openAndFocusBrowser,
                          'aria-label': '打开内置浏览器',
                          'aria-pressed': rightPanelOpen && rightSurface === 'browser',
                          children: [
                            jsx(Earth, { size: 16 }),
                            jsx('span', { children: '内置浏览器' }),
                          ],
                        }),
                        jsxs('button', {
                          className: `icon-button sidebar-settings ${isReadyToChat && !serviceError ? 'ready' : ''}`,
                          onClick: openSettings,
                          title: `设置 · ${serviceError ? '服务未连接' : isReadyToChat ? '连接已配置' : '等待配置'}`,
                          'aria-label': '打开设置',
                          children: [jsx(Settings2, { size: 16 }), jsx('i', {})],
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      jsxs('main', {
        className: 'main-panel',
        children: [
          jsxs('header', {
            className: 'chat-header',
            children: [
              jsxs('div', {
                className: 'chat-heading',
                children: [
                  !sidebarOpen &&
                    jsx('button', {
                      className: 'icon-button',
                      onClick: () => setSidebarOpen(true),
                      'aria-label': '打开会话列表',
                      title: '打开会话列表',
                      children: jsx(PanelLeftOpen, { size: 19 }),
                    }),
                  jsxs('div', {
                    children: [
                      jsxs('h1', {
                        children: [
                          headingTitle,
                          jsx(ChatHeadingBadges, {
                            session: activeSessionSummary || currentSession,
                          }),
                        ],
                      }),
                      activeRunState &&
                        jsxs('span', {
                          children: [
                            jsx('span', { className: 'status-pulse' }),
                            activeRunState.stopping
                              ? '正在停止'
                              : currentMessages.some(
                                    (m) =>
                                      m.status === 'running' &&
                                      m.questions?.some((q) => q.status === 'pending'),
                                  )
                                ? '等待你的回答'
                                : pendingApprovalsBySession[activeSessionId]
                                  ? '等待你的确认'
                                  : '正在进行',
                          ],
                        }),
                    ],
                  }),
                ],
              }),
              jsxs('div', {
                className: 'chat-header-actions',
                children: [
                  jsx(ReplyWaitingButton, {
                    sessions: Object.values(sessionMap),
                    approvals,
                    decisions,
                    currentId: activeSessionId,
                    onSelect: openSessionAndScroll,
                  }),
                  jsx('button', {
                    type: 'button',
                    className: `icon-button${hgSessionTasks.length ? '' : ' is-empty'}`,
                    disabled: !hgSessionTasks.length,
                    title: replyActivityOpen ? '最小化任务进度' : '展开任务进度',
                    'aria-label': replyActivityOpen ? '最小化任务进度' : '展开任务进度',
                    'aria-expanded': replyActivityOpen,
                    onClick: toggleReplyActivity,
                    children: jsx('span', { 'aria-hidden': 'true', children: '☷' }),
                  }),
                  jsx(ChatHeaderFindButton, {
                    open: hgFindOpen,
                    onToggle: () => setHgFindOpen((prev) => !prev),
                  }),
                  jsx('button', {
                    className: `icon-button ${rightPanelOpen ? 'selected' : ''}`,
                    title: rightPanelOpen ? '收起工作空间与浏览器' : '打开工作空间与浏览器',
                    'aria-label': rightPanelOpen ? '收起右侧面板' : '打开右侧面板',
                    onClick: () => setRightPanelOpen((prev) => !prev),
                    children: rightPanelOpen
                      ? jsx(PanelRightClose, { size: 18 })
                      : jsx(PanelRightOpen, { size: 18 }),
                  }),
                ],
              }),
            ],
          }),
          serviceError &&
            jsxs('div', {
              className: 'service-error',
              role: 'alert',
              children: [
                jsx(CircleAlert, { size: 16 }),
                jsx('span', { children: serviceError }),
                jsx('button', {
                  className: 'text-button',
                  onClick: bootstrapWorkbench,
                  children: '重新连接',
                }),
              ],
            }),
          jsx(ChatFindBar, {
            open: hgFindOpen,
            focusTick: hgFindTick,
            seedText: hgFindSeed,
            onClose: () => setHgFindOpen(false),
            activeSessionId,
            messages: currentMessages,
            scrollContainerRef: chatScrollRef,
            contentContainerRef: chatContentRef,
            onStopFollowing: () => updateFollowState(false),
            onSelectSession: (sid) => selectSession(sid),
          }),
          jsx('div', {
            className: 'chat-scroll',
            ref: chatScrollRef,
            onScroll: handleChatScroll,
            children: jsx('div', {
              className: `chat-content ${currentMessages.length ? 'has-messages' : 'is-empty'}`,
              ref: chatContentRef,
              children:
                booting || loadingSession
                  ? jsxs('div', {
                      className: 'main-loading',
                      children: [
                        jsx(LoaderCircle, { size: 25, className: 'spin' }),
                        jsx('span', {
                          children: booting ? '正在打开工作台' : '正在读取对话',
                        }),
                      ],
                    })
                  : sessionLoadError && !currentSession
                    ? jsxs('div', {
                        className: 'main-error',
                        children: [
                          jsx(CircleAlert, { size: 28 }),
                          jsx('h2', { children: '这段对话暂时无法打开' }),
                          jsx('p', { children: sessionLoadError }),
                          jsx('button', {
                            className: 'button button-quiet',
                            onClick: () => fetchActiveSessionDetail(activeSessionId),
                            children: '重新加载',
                          }),
                        ],
                      })
                    : currentMessages.length
                      ? jsxs(Fragment, {
                          children: [
                            jsxs('div', {
                              className: 'conversation-start',
                              children: [
                                jsx('span', {}),
                                new Date(
                                  currentSession?.createdAt || Date.now(),
                                ).toLocaleDateString('zh-CN', {
                                  month: 'long',
                                  day: 'numeric',
                                }),
                                jsx('span', {}),
                              ],
                            }),
                            currentMessages.map((msg) =>
                              jsx(
                                MessageItem,
                                {
                                  message: msg,
                                  sessionId: activeSessionId,
                                  isRunning: Boolean(
                                    activeRunState &&
                                      activeRunsRef.current.get(activeSessionId)?.assistantId ===
                                        msg.id,
                                  ),
                                  approvals,
                                  decisions,
                                  approving: approvingMap,
                                  onApprove: handleApproveTool,
                                  onPreview: openImagePreview,
                                  onToast: showToast,
                                },
                                msg.id,
                              ),
                            ),
                          ],
                        })
                      : jsxs('div', {
                          className: 'welcome',
                          children: [
                            jsxs('div', {
                              className: 'welcome-eyebrow',
                              children: [
                                jsx('span', { className: 'welcome-dot' }),
                                '你的本地 AI 工作台',
                              ],
                            }),
                            jsxs('h2', {
                              children: ['从一个想法开始', jsx('span', { children: '。' })],
                            }),
                            jsxs('p', {
                              children: [
                                availableWorkbenchModes.length
                                  ? `当前连接已开启${availableWorkbenchModes
                                      .map((m) => m.label)
                                      .join('、')}。`
                                  : '先配置至少一个模型，开启对应模式。',
                                jsx('br', { className: 'mobile-break' }),
                                '这里是你的创作空间。',
                              ],
                            }),
                            availableSuggestions.length > 0 &&
                              jsx('div', {
                                className: 'suggestion-grid',
                                style: { '--suggestion-count': availableSuggestions.length },
                                children: availableSuggestions.map((sug) =>
                                  jsxs(
                                    'button',
                                    {
                                      className: `suggestion-card suggestion-${sug.mode}`,
                                      onClick: () => handleApplySuggestion(sug),
                                      children: [
                                        jsx('span', {
                                          className: 'suggestion-icon',
                                          children: jsx(sug.Icon, { size: 19, strokeWidth: 1.6 }),
                                        }),
                                        jsx('strong', { children: sug.label }),
                                        jsx('span', { children: sug.description }),
                                        jsx(ArrowUpRight, {
                                          className: 'suggestion-arrow',
                                          size: 15,
                                        }),
                                      ],
                                    },
                                    sug.mode,
                                  ),
                                ),
                              }),
                            !isReadyToChat &&
                              jsxs('button', {
                                className: 'setup-prompt',
                                onClick: openSettings,
                                children: [
                                  jsx(Settings2, { size: 15 }),
                                  jsx('span', { children: '配置模型连接' }),
                                  jsx(ArrowUpRight, { size: 13 }),
                                ],
                              }),
                          ],
                        }),
            }),
          }),
          !atBottom &&
            currentMessages.length > 0 &&
            jsxs('button', {
              className: 'scroll-bottom',
              title: '回到最新消息',
              'aria-label': '回到最新消息',
              onClick: () => {
                followingRef.current = true;
                setAtBottom(true);
                chatScrollRef.current?.scrollTo({
                  top: chatScrollRef.current.scrollHeight,
                  behavior: 'smooth',
                });
              },
              children: [jsx(ArrowDown, { size: 16 }), '最新消息'],
            }),
          jsxs('div', {
            className: 'composer-area',
            ref: composerAreaRef,
            children: [
              activeSessionId &&
                runErrors[activeSessionId] &&
                jsx(RunErrorBanner, {
                  message: runErrors[activeSessionId],
                  onDismiss: () =>
                    setRunErrors((prev) => ({ ...prev, [activeSessionId]: '' })),
                }),
              activeRunState &&
                jsxs('div', {
                  className: 'run-progress',
                  children: [
                    jsxs('div', {
                      children: [
                        pendingApprovalsBySession[activeSessionId]
                          ? jsx(ShieldCheck, { size: 13 })
                          : jsx(LoaderCircle, { size: 13, className: 'spin' }),
                        jsx('span', {
                          children: activeRunState.stopping
                            ? '正在停止，保留已完成的内容'
                            : currentMessages.some(
                                  (m) =>
                                    m.status === 'running' &&
                                    m.questions?.some((q) => q.status === 'pending'),
                                )
                              ? '有问题等待你的回答'
                              : pendingApprovalsBySession[activeSessionId]
                                ? '有工具操作等待你的确认'
                                : activeRunsRef.current.get(activeSessionId)?.mode === 'image'
                                  ? '图片正在生成中'
                                  : '正在处理你的请求',
                        }),
                      ],
                    }),
                    jsx('span', {
                      children:
                        runElapsedSec < 60
                          ? `${runElapsedSec} 秒`
                          : `${Math.floor(runElapsedSec / 60)} 分 ${runElapsedSec % 60} 秒`,
                    }),
                  ],
                }),
              jsxs('form', {
                className: `composer ${activeRunState ? 'is-running' : ''}`,
                onSubmit: handleSubmitTurn,
                onDragEnter: dropZone.enter,
                onDragOver: dropZone.over,
                onDragLeave: dropZone.leave,
                onDrop: (ev) => {
                  dropZone.end();
                  attachmentsRef.current?.addFromDrop(ev);
                },
                onPaste: (ev) => {
                  attachmentsRef.current?.addFromPaste(ev);
                },
                children: [
                  slashMenuState &&
                    jsx(SkillSlashMenu, {
                      options: buildSlashMenuOptions(skills, slashMenuState.query),
                      query: slashMenuState.query,
                      index: slashMenuState.index,
                      onIndex: (idx) =>
                        setSlashMenuState((prev) => (prev ? { ...prev, index: idx } : prev)),
                      onSelect: handleSelectSlashOption,
                      onEdit: (skill) => openSkillEditor(skill),
                      onCreate: () => openSkillEditor(null),
                      onClose: closeSlashMenu,
                    }),
                  isGoalModeOn &&
                    jsx(GoalModeChip, {
                      running: Boolean(activeRunState),
                      onRemove: () => toggleGoalMode(draftBucketKey),
                    }),
                  isSubagentModeOn &&
                    jsx(SubagentModeChip, {
                      running: Boolean(activeRunState),
                      onRemove: () => toggleSubagentMode(draftBucketKey),
                    }),
                  currentSelectedSkill &&
                    jsx(SelectedSkillChip, {
                      skill: currentSelectedSkill,
                      onRemove: () =>
                        setSelectedSkills((prev) => ({ ...prev, [draftBucketKey]: null })),
                      onEdit: () => openSkillEditor({ ...currentSelectedSkill, existing: true }),
                    }),
                  jsx('textarea', {
                    ref: textareaRef,
                    'aria-label': '输入消息',
                    value: currentDraftText,
                    placeholder: composerPlaceholder,
                    rows: 2,
                    onChange: handleComposerTextChange,
                    onClick: (ev) => refreshSlashTriggerFromInput(ev.target),
                    onKeyUp: (ev) => {
                      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) {
                        refreshSlashTriggerFromInput(ev.target);
                      }
                    },
                    onBlur: () => setSlashMenuState(null),
                    onKeyDown: (ev) => {
                      if (ev.nativeEvent.isComposing || ev.keyCode === 229) return;
                      if (slashMenuState) {
                        const menuOptions = buildSlashMenuOptions(skills, slashMenuState.query);
                        const totalRows = menuOptions.length + 1;
                        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                          ev.preventDefault();
                          const dir = ev.key === 'ArrowDown' ? 1 : -1;
                          setSlashMenuState((prev) =>
                            prev
                              ? { ...prev, index: (prev.index + dir + totalRows) % totalRows }
                              : prev,
                          );
                          return;
                        }
                        if ((ev.key === 'Enter' || ev.key === 'Tab') && !ev.shiftKey) {
                          const chosen = menuOptions[slashMenuState.index];
                          if (chosen) {
                            ev.preventDefault();
                            handleSelectSlashOption(chosen);
                            return;
                          }
                          if (ev.key === 'Enter' && slashMenuState.index === menuOptions.length) {
                            ev.preventDefault();
                            openSkillEditor(null);
                            return;
                          }
                        }
                        if (ev.key === 'Escape') {
                          ev.preventDefault();
                          setSlashMenuState(null);
                          return;
                        }
                      }
                      if (ev.key === 'Enter' && !ev.shiftKey) {
                        ev.preventDefault();
                        if (!activeRunState) handleSubmitTurn();
                      }
                    },
                  }),
                  jsx(ComposerAttachments, {
                    ref: attachmentsRef,
                    sessionId: activeSessionId,
                    attachments: currentAttachments,
                    onChange: updateAttachmentsForSession,
                    onToast: showToast,
                    disabled:
                      Boolean(activeRunState) ||
                      creatingSession ||
                      booting ||
                      Boolean(quickSavingKind),
                    ensureSession: async () => (await handleCreateSession())?.id,
                    busy: Boolean(activeRunState) || creatingSession,
                  }),
                  jsxs('div', {
                    className: 'composer-toolbar',
                    children: [
                      jsx('button', {
                        type: 'button',
                        className: 'icon-button small composer-attach',
                        'aria-label': '添加附件',
                        title: currentAttachments.length
                          ? `添加附件（${currentAttachments.length} / 8）`
                          : '添加附件：可粘贴、拖入或选择文件',
                        disabled:
                          Boolean(activeRunState) ||
                          creatingSession ||
                          booting ||
                          Boolean(quickSavingKind) ||
                          currentAttachments.length >= 8,
                        onClick: () => attachmentsRef.current?.openPicker(),
                        children: hasUploadingAttachment
                          ? jsx(LoaderCircle, { size: 16, className: 'spin' })
                          : jsx(Plus, { size: 17 }),
                      }),
                      jsx(ComposerModePicker, {
                        modes: availableWorkbenchModes,
                        value: resolvedMode,
                        onChange: handleSwitchMode,
                        onSettings: openSettings,
                        disabled: booting || Boolean(quickSavingKind) || creatingSession,
                      }),
                      jsx(PermissionModePicker, {
                        value: currentPermissionMode,
                        onChange: handlePermissionChange,
                        busy: quickSavingKind === 'permission',
                        disabled:
                          booting || !settings || Boolean(quickSavingKind) || creatingSession,
                        hasRunning: hasAnyRunning,
                      }),
                      jsxs('div', {
                        className: 'composer-model-controls',
                        children: [
                          jsx(
                            HeaderModelSelector,
                            {
                              profile: currentProfile || {},
                              profiles: profilesList,
                              mode: resolvedMode,
                              value: configuredModelForMode,
                              runningModel: activeRunEntry?.model,
                              hasRunning: hasAnyRunning,
                              disabled:
                                booting ||
                                !settings ||
                                Boolean(quickSavingKind) ||
                                creatingSession ||
                                settingsOpen,
                              busy: quickSavingKind === 'model',
                              onChange: (model, profileId) =>
                                saveQuickSettingsPatch(
                                  headerModelPatch(resolvedMode, model, profileId),
                                  'model',
                                ),
                              onSettings: openSettings,
                            },
                            resolvedMode,
                          ),
                          jsx(ReasoningEffortPicker, {
                            model: configuredModelForMode,
                            mode: resolvedMode,
                            protocol: currentProtocol,
                            value: currentReasoningEffort,
                            onChange: handleReasoningEffortChange,
                            busy: quickSavingKind === 'reasoning',
                            disabled:
                              booting || !settings || Boolean(quickSavingKind) || creatingSession,
                            hasRunning: hasAnyRunning,
                          }),
                        ],
                      }),
                      jsx('div', {
                        className: 'composer-actions',
                        children: activeRunState
                          ? jsx('button', {
                              type: 'button',
                              className: 'stop-button',
                              onClick: handleStopActiveRun,
                              disabled: activeRunState.stopping,
                              'aria-label': '停止生成',
                              title: '停止生成',
                              children: activeRunState.stopping
                                ? jsx(LoaderCircle, { size: 15, className: 'spin' })
                                : jsx(Square, { size: 14, fill: 'currentColor' }),
                            })
                          : jsx('button', {
                              type: 'submit',
                              className: 'send-button',
                              disabled:
                                !isReadyToChat ||
                                (!currentDraftText.trim() &&
                                  !currentSelectedSkill &&
                                  !currentAttachments.length) ||
                                hasUnreadyAttachment ||
                                creatingSession ||
                                booting ||
                                Boolean(quickSavingKind),
                              title: isReadyToChat
                                ? hasUploadingAttachment
                                  ? '附件正在上传'
                                  : resolvedMode === 'image'
                                    ? '生成图片'
                                    : '发送消息'
                                : '先配置模型连接',
                              'aria-label': resolvedMode === 'image' ? '生成图片' : '发送消息',
                              children: creatingSession
                                ? jsx(LoaderCircle, { size: 18, className: 'spin' })
                                : jsx(ArrowUp, { size: 20 }),
                            }),
                      }),
                    ],
                  }),
                  dropZone.dragging && jsx(AttachmentDropVeil, {}),
                ],
              }),
              jsxs('div', {
                className: 'composer-bottom-bar',
                children: [
                  jsx(TokenMetricsBar, {
                    metrics: latestAssistantMessage?.metrics,
                    mode: latestAssistantMessage?.mode || activeRunEntry?.mode,
                    isRunning: Boolean(activeRunState),
                  }),
                  jsx(ContextMeter, {
                    context: displayContext,
                    mode: latestAssistantMessage?.mode || activeRunEntry?.mode,
                    running: Boolean(activeRunState),
                    live: isContextLive,
                    loading: loadingContext && !displayContext,
                    autoCompact: settings?.autoCompact !== false,
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      rightPanelOpen &&
        jsx('button', {
          className: 'right-mobile-shade',
          'aria-label': '关闭右侧面板',
          onClick: () => setRightPanelOpen(false),
        }),
      jsxs('aside', {
        ref: rightPanelRef,
        className: `right-panel ${rightSurface === 'browser' ? 'browser-open' : ''} ${rightPanelOpen && panelAnimating ? 'panel-anim' : ''}`,
        style: rightPanelOpen ? undefined : { display: 'none' },
        children: [
          jsx('div', {
            className: 'panel-resize-grip',
            role: 'separator',
            'aria-orientation': 'vertical',
            'aria-label': '调整面板宽度',
            title: '拖动调整宽度（左右方向键微调）',
            tabIndex: 0,
            'aria-valuenow': rightPanelWidth,
            'aria-valuemin': MIN_RIGHT_PANEL_WIDTH,
            onPointerDown: handlePanelGripPointerDown,
            onPointerMove: handlePanelGripPointerMove,
            onPointerUp: handlePanelGripPointerEnd,
            onPointerCancel: handlePanelGripPointerEnd,
            onLostPointerCapture: handlePanelGripPointerEnd,
            onKeyDown: handlePanelGripKeyDown,
          }),
          rightSurface !== 'browser' &&
            jsxs('div', {
              className: 'right-panel-header',
              children: [
                jsx('span', { id: 'workspace-panel-title', children: '工作空间' }),
                jsxs('div', {
                  className: 'chat-header-actions',
                  children: [
                    jsx('button', {
                      className: 'icon-button small',
                      title: '打开内置浏览器',
                      'aria-label': '切换到内置浏览器',
                      onClick: openAndFocusBrowser,
                      children: jsx(Earth, { size: 16 }),
                    }),
                    jsx('button', {
                      className: 'icon-button small',
                      title: '收起面板',
                      'aria-label': '收起面板',
                      onClick: () => setRightPanelOpen(false),
                      children: jsx(PanelRightClose, { size: 16 }),
                    }),
                  ],
                }),
              ],
            }),
          jsx('div', {
            style: {
              display: rightSurface === 'browser' ? 'flex' : 'none',
              flex: 1,
              minHeight: 0,
              minWidth: 0,
            },
            children: jsx(BrowserPanel, {
              bridge: browserBridge,
              state: browserState,
              focusRequest: browserFocusTick,
              blocked:
                !rightPanelOpen ||
                rightSurface !== 'browser' ||
                Boolean(settingsOpen || previewArtifact || deleteTarget),
              onClose: () => setRightPanelOpen(false),
              onWorkspace: () => {
                setRightSurface('workspace');
                setWorkspaceTab('workspace');
              },
            }),
          }),
          rightSurface !== 'browser' &&
            jsxs('div', {
              className: 'workspace-tab-panel',
              id: 'workspace-tab-panel',
              role: 'region',
              'aria-labelledby': 'workspace-panel-title',
              children: [
                jsxs('div', {
                  className: 'right-tabs',
                  children: [
                    jsxs('button', {
                      className: workspaceTab === 'artifacts' ? 'active' : '',
                      onClick: () => setWorkspaceTab('artifacts'),
                      children: [
                        jsx(Image, { size: 14 }),
                        '产物',
                        sessionArtifacts.length > 0 &&
                          jsx('span', { children: sessionArtifacts.length }),
                      ],
                    }),
                    jsxs('button', {
                      className: workspaceTab === 'agents' ? 'active' : '',
                      onClick: () => setWorkspaceTab('agents'),
                      children: [
                        jsx(Bot, { size: 14 }),
                        '子代理',
                        subagentEntries.length > 0 &&
                          jsx('span', {
                            className: runningSubagentCount > 0 ? 'live' : undefined,
                            children:
                              runningSubagentCount > 0
                                ? runningSubagentCount
                                : subagentEntries.length,
                          }),
                      ],
                    }),
                    jsxs('button', {
                      className: workspaceTab === 'workspace' ? 'active' : '',
                      onClick: () => setWorkspaceTab('workspace'),
                      children: [jsx(FolderOpen, { size: 14 }), '工作区'],
                    }),
                  ],
                }),
                workspaceTab === 'artifacts'
                  ? jsxs('div', {
                      className: 'artifacts-panel',
                      children: [
                        settings?.fileChangesEnabled !== false &&
                          jsx(FileChangesSection, {
                            sessionId: activeSessionId,
                            revision: workspaceRevision,
                            onToast: showToast,
                            enabled: settings?.fileChangesEnabled !== false,
                          }),
                        sessionArtifacts.length
                          ? jsxs(Fragment, {
                              children: [
                                jsxs('div', {
                                  className: 'artifacts-caption',
                                  children: [
                                    jsx('span', { children: '当前对话' }),
                                    jsxs('span', {
                                      children: [sessionArtifacts.length, ' 张图片'],
                                    }),
                                  ],
                                }),
                                jsx('div', {
                                  className: 'artifact-grid',
                                  children: sessionArtifacts.map((art) =>
                                    jsx(
                                      ArtifactImageCard,
                                      {
                                        artifact: art,
                                        onPreview: openImagePreview,
                                        compact: true,
                                      },
                                      art.id || art.url,
                                    ),
                                  ),
                                }),
                                jsxs('div', {
                                  className: 'artifacts-footnote',
                                  children: [
                                    jsx(Check, { size: 12 }),
                                    '已保存，重新打开对话仍可查看',
                                  ],
                                }),
                              ],
                            })
                          : jsxs('div', {
                              className: 'panel-empty artifacts-empty',
                              children: [
                                jsxs('div', {
                                  className: 'artifact-empty-art',
                                  children: [
                                    jsx('span', {}),
                                    jsx('span', {}),
                                    jsx(Image, { size: 28, strokeWidth: 1.3 }),
                                  ],
                                }),
                                jsx('strong', { children: '留一处给你的作品' }),
                                jsxs('p', {
                                  children: [
                                    '已保存的图片会收在这里。',
                                    jsx('br', {}),
                                    '随时放大查看，或下载保存。',
                                  ],
                                }),
                                hasImageMode &&
                                  jsxs('button', {
                                    className: 'button button-quiet small-button',
                                    onClick: () => handleSwitchMode('image'),
                                    children: [jsx(ImagePlus, { size: 14 }), '开始生图'],
                                  }),
                              ],
                            }),
                      ],
                    })
                  : workspaceTab === 'agents'
                    ? jsx(SubagentsPanel, {
                        entries: subagentEntries,
                        running: runningSubagentCount,
                      })
                    : jsx(WorkspacePanel, {
                        workspace: effectiveWorkspace,
                        sessionId: activeSessionId,
                        revision: workspaceRevision,
                        onToast: showToast,
                      }),
              ],
            }),
        ],
      }),
      settingsOpen &&
        jsx(SettingsDrawer, {
          settings,
          skin,
          onSkinChange: handleSkinPreviewChange,
          onSkinSaved: applyLoadedSettings,
          onClose: closeSettings,
          onSaved: handleSettingsSaved,
          onToast: showToast,
          hasRunning: hasAnyRunning,
        }),
      skillEditorDraft &&
        jsx(SkillEditorModal, {
          draft: skillEditorDraft,
          onSave: handleSaveSkill,
          onDelete: handleDeleteSkill,
          onClose: () => setSkillEditorDraft(null),
          onToast: showToast,
        }),
      jsx(ReplyActivity, {
        key: activeSessionId || 'empty',
        sessionId: activeSessionId,
        messages: currentMessages,
        tasks: hgSessionTasks,
        active: Boolean(activeRunState),
        expanded: replyActivityOpen,
        onToggle: toggleReplyActivity,
      }),
      previewArtifact &&
        jsx(ReplyImageViewer, {
          key: previewArtifact.url,
          artifact: {
            ...previewArtifact,
            sessionId: previewArtifact.sessionId || activeSessionId,
          },
          onClose: closeReplyImage,
          onToast: showToast,
        }),
      jsx(SessionDeleteModal, {
        target: deleteTarget,
        sessions,
        runningMap,
        busy: deletingBusy,
        onCancel: () => setDeleteTarget(null),
        onConfirmSingle: handleConfirmSingleDelete,
        onConfirmBulk: handleConfirmBulkDelete,
      }),
      toast &&
        jsxs('div', {
          className: `toast ${toast.kind}`,
          role: 'status',
          children: [
            toast.kind === 'error'
              ? jsx(CircleAlert, { size: 16 })
              : toast.kind === 'info'
                ? jsx(Sparkles, { size: 16 })
                : jsx(Check, { size: 16 }),
            jsx('span', { children: toast.message }),
            jsx('button', {
              className: 'icon-button tiny',
              'aria-label': '关闭提示',
              onClick: () => setToast(null),
              children: jsx(X, { size: 13 }),
            }),
          ],
        }),
      jsx(CompletionPopupStack, {
        notices: completionNotices,
        onDismiss: dismissCompletionNotice,
        onOpen: (notice) => {
          openSessionAndScroll(notice.sessionId);
          dismissCompletionNotice(notice.id);
        },
      }),
    ],
  });
}
