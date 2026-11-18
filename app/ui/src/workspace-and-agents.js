/**
 * Harness Gemini UI - Workspace File Browser, Native Open Chooser & Subagents Panel
 * License: MIT
 */

import {
  React,
  jsx,
  jsxs,
  Fragment,
  AppWindow,
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FileCodeCorner,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  ImageOff,
  Link2,
  LoaderCircle,
  RefreshCw,
} from '../vendor/vendor-deps.js';
import {
  api,
  basenameOrWorkspace,
  formatBytes,
  normalizeWorkspaceFileInfo,
} from './api.js';
import { SubagentCard } from './markdown-and-tools.js';

export const NATIVE_OPEN_OPTIONS = [
  {
    id: 'default',
    label: '默认应用打开',
    description: '使用系统为此文件设置的应用',
    Icon: ExternalLink,
    busy: '正在请求默认应用打开…',
    done: '已请求用默认应用打开文件。',
  },
  {
    id: 'choose',
    label: '选择其他应用',
    description: '在工作台中选择打开此文件的应用',
    Icon: AppWindow,
  },
  {
    id: 'reveal',
    label: '在文件夹中显示',
    description: '在系统文件管理器中定位文件',
    Icon: FolderOpen,
    busy: '正在定位文件…',
    done: '已请求在文件夹中显示文件。',
  },
];

function WorkspaceFilePreview({ info, sessionId, onToast }) {
  const [reloadKey, setReloadKey] = React.useState(0);
  const [textState, setTextState] = React.useState({
    loading: true,
    content: '',
    error: '',
    truncated: false,
  });
  const [imageState, setImageState] = React.useState({
    loaded: false,
    failed: false,
    dimensions: '',
  });

  React.useEffect(() => {
    if (info.kind !== 'text') return;
    const controller = new AbortController();
    let active = true;
    setTextState({ loading: true, content: '', error: '', truncated: false });

    api
      .file(info.path, { signal: controller.signal, sessionId })
      .then((res) => {
        if (!active) return;
        if (typeof res?.content !== 'string') {
          throw new Error('这个文件未返回可预览的文本。');
        }
        setTextState({
          loading: false,
          content: res.content,
          error: '',
          truncated: res.truncated === true,
        });
      })
      .catch((err) => {
        if (active && err.name !== 'AbortError') {
          setTextState({
            loading: false,
            content: '',
            error: err.message,
            truncated: false,
          });
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [info.path, info.kind, reloadKey, sessionId]);

  const handleReload = () => {
    setImageState({ loaded: false, failed: false, dimensions: '' });
    setReloadKey((prev) => prev + 1);
  };

  return jsxs('div', {
    className: 'workspace-preview',
    children: [
      jsxs('div', {
        className: 'workspace-preview-toolbar',
        children: [
          jsx('span', { children: info.kind === 'image' ? '图片预览' : '文本预览' }),
          info.kind === 'image' &&
            imageState.dimensions &&
            jsx('span', { children: imageState.dimensions }),
          info.kind === 'text' &&
            !textState.loading &&
            !textState.error &&
            jsx('button', {
              type: 'button',
              className: 'icon-button small',
              title: '复制文件内容',
              'aria-label': '复制文件内容',
              onClick: async () => {
                try {
                  await navigator.clipboard.writeText(textState.content);
                  onToast?.('文件内容已复制');
                } catch {
                  onToast?.('复制失败，请手动选中文本复制', 'error');
                }
              },
              children: jsx(Copy, { size: 14 }),
            }),
        ],
      }),
      info.kind === 'image'
        ? jsx('div', {
            className: 'workspace-image-scroll',
            children: imageState.failed
              ? jsxs('div', {
                  className: 'workspace-preview-error',
                  role: 'alert',
                  children: [
                    jsx(ImageOff, { size: 23 }),
                    jsx('p', { children: '图片暂时无法加载。' }),
                    jsxs('button', {
                      type: 'button',
                      className: 'text-button',
                      onClick: handleReload,
                      children: [jsx(RefreshCw, { size: 13 }), '重新加载'],
                    }),
                  ],
                })
              : jsxs('div', {
                  className: `workspace-image-stage${imageState.loaded ? ' loaded' : ''}`,
                  children: [
                    !imageState.loaded &&
                      jsxs('div', {
                        className: 'workspace-image-loading',
                        role: 'status',
                        children: [
                          jsx(LoaderCircle, { size: 23, className: 'spin' }),
                          jsx('span', { children: '正在载入图片' }),
                        ],
                      }),
                    jsx(
                      'img',
                      {
                        src: info.previewUrl,
                        alt: info.name,
                        decoding: 'async',
                        referrerPolicy: 'no-referrer',
                        onLoad: (ev) =>
                          setImageState({
                            loaded: true,
                            failed: false,
                            dimensions: `${ev.currentTarget.naturalWidth} × ${ev.currentTarget.naturalHeight}`,
                          }),
                        onError: () =>
                          setImageState({ loaded: false, failed: true, dimensions: '' }),
                      },
                      `${info.path}:${reloadKey}`,
                    ),
                  ],
                }),
          })
        : textState.loading
          ? jsxs('div', {
              className: 'panel-loading',
              role: 'status',
              children: [
                jsx(LoaderCircle, { size: 21, className: 'spin' }),
                jsx('span', { children: '正在读取文本' }),
              ],
            })
          : textState.error
            ? jsxs('div', {
                className: 'panel-error',
                role: 'alert',
                children: [
                  jsx('span', { children: textState.error }),
                  jsx('button', {
                    type: 'button',
                    className: 'text-button',
                    onClick: handleReload,
                    children: '重新读取',
                  }),
                ],
              })
            : jsxs(Fragment, {
                children: [
                  jsx('pre', {
                    className: 'file-content',
                    children: textState.content || '（空文件）',
                  }),
                  textState.truncated &&
                    jsx('div', {
                      className: 'file-truncation',
                      children: '文件较长，此处显示部分内容',
                    }),
                ],
              }),
    ],
  });
}

function WorkspaceFileChooser({ entry, sessionId, onBack, onToast }) {
  const [fileInfo, setFileInfo] = React.useState(null);
  const [loadingInfo, setLoadingInfo] = React.useState(true);
  const [infoError, setInfoError] = React.useState('');
  const [infoReloadKey, setInfoReloadKey] = React.useState(0);
  const [screen, setScreen] = React.useState('actions');
  const [appsState, setAppsState] = React.useState({
    path: '',
    loading: true,
    items: [],
    error: '',
    unsupported: false,
  });
  const [appsReloadKey, setAppsReloadKey] = React.useState(0);
  const [busyAction, setBusyAction] = React.useState(null);
  const [actionError, setActionError] = React.useState(null);
  const [actionNotice, setActionNotice] = React.useState('');

  const sectionRef = React.useRef(null);
  const previewBtnRef = React.useRef(null);
  const chooseBtnRef = React.useRef(null);
  const mountedRef = React.useRef(true);
  const busyRef = React.useRef(false);

  React.useEffect(() => {
    mountedRef.current = true;
    sectionRef.current?.focus();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadingInfo(true);
    setInfoError('');
    setFileInfo(null);

    api
      .fileInfo(entry.path, { signal: controller.signal, sessionId })
      .then((res) => {
        if (active) setFileInfo(normalizeWorkspaceFileInfo(res));
      })
      .catch((err) => {
        if (active && err.name !== 'AbortError') setInfoError(err.message);
      })
      .finally(() => {
        if (active) setLoadingInfo(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [entry.path, infoReloadKey, sessionId]);

  React.useEffect(() => {
    if (screen !== 'applications' || !fileInfo?.path) return;
    const controller = new AbortController();
    let active = true;
    const targetPath = fileInfo.path;
    setAppsState({
      path: targetPath,
      loading: true,
      items: [],
      error: '',
      unsupported: false,
    });

    api
      .fileApplications(targetPath, { signal: controller.signal, sessionId })
      .then((res) => {
        if (!active) return;
        if (res?.path !== targetPath || !Array.isArray(res.applications)) {
          throw new Error('暂时无法读取可用应用，请重试。');
        }
        const seen = new Set();
        const items = res.applications
          .filter((app) => {
            if (
              typeof app?.id !== 'string' ||
              !app.id.trim() ||
              typeof app.name !== 'string' ||
              !app.name.trim() ||
              seen.has(app.id)
            ) {
              return false;
            }
            seen.add(app.id);
            return true;
          })
          .map((app) => ({
            id: app.id,
            name: app.name.trim(),
            recommended: app.recommended === true,
          }));
        setAppsState({
          path: targetPath,
          loading: false,
          items,
          error: '',
          unsupported: false,
        });
      })
      .catch((err) => {
        if (!active || err.name === 'AbortError') return;
        setAppsState({
          path: targetPath,
          loading: false,
          items: [],
          error: err.message,
          unsupported: err.status === 501,
        });
        if (err.status === 501) {
          setFileInfo((prev) =>
            prev
              ? { ...prev, actions: { ...prev.actions, choose: false } }
              : prev,
          );
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [screen, fileInfo?.path, appsReloadKey, sessionId]);

  const handleStepBack = () => {
    if (busyRef.current) return;
    if (screen !== 'actions') {
      const prevScreen = screen;
      setScreen('actions');
      setActionError(null);
      setActionNotice('');
      const focusTarget = prevScreen === 'preview' ? previewBtnRef : chooseBtnRef;
      requestAnimationFrame(() => {
        if (focusTarget.current && !focusTarget.current.disabled) {
          focusTarget.current.focus();
        } else {
          sectionRef.current?.focus();
        }
      });
    } else {
      onBack();
    }
  };

  const openApplicationList = () => {
    if (busyRef.current || !fileInfo?.actions.choose) return;
    setAppsState({
      path: fileInfo.path,
      loading: true,
      items: [],
      error: '',
      unsupported: false,
    });
    setActionError(null);
    setActionNotice('');
    setScreen('applications');
    sectionRef.current?.focus();
  };

  const refreshApplicationList = () => {
    if (busyRef.current || !fileInfo?.actions.choose) return;
    setActionError(null);
    setActionNotice('');
    setAppsState((prev) => ({ ...prev, loading: true, items: [], error: '' }));
    setAppsReloadKey((prev) => prev + 1);
  };

  const invokeOpenAction = async (action, applicationId) => {
    const matchedApp =
      action === 'application' && appsState.items.find((app) => app.id === applicationId);
    const allowed =
      action === 'application'
        ? fileInfo?.actions.choose &&
          appsState.path === fileInfo.path &&
          !appsState.loading &&
          matchedApp
        : (action === 'default' || action === 'reveal') && fileInfo?.actions[action];
    if (busyRef.current || !allowed) return;

    const currentTask = {
      action,
      applicationId: matchedApp?.id,
      applicationName: matchedApp?.name,
    };
    busyRef.current = true;
    setBusyAction(currentTask);
    setActionError(null);
    setActionNotice('');

    try {
      const result = await api.openFile(fileInfo.path, action, matchedApp?.id, sessionId);
      if (!mountedRef.current) return;
      if (result?.status === 'cancelled') {
        setActionNotice('已取消操作，可以重新选择打开方式。');
      } else if (result?.status === 'done') {
        setActionNotice(
          matchedApp
            ? `已请求用 ${matchedApp.name} 打开文件。`
            : NATIVE_OPEN_OPTIONS.find((opt) => opt.id === action)?.done || '操作已完成。',
        );
      } else {
        throw new Error('系统未返回明确结果，请重试。');
      }
    } catch (err) {
      if (mountedRef.current) {
        setActionError({
          ...currentTask,
          message: err.message,
          unsupported: err.status === 501,
        });
        if (err.status === 501) {
          const actionKey = action === 'application' ? 'choose' : action;
          setFileInfo((prev) =>
            prev ? { ...prev, actions: { ...prev.actions, [actionKey]: false } } : prev,
          );
        }
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const fileName = fileInfo?.name || entry.name || basenameOrWorkspace(entry.path);
  const FileTypeIcon =
    fileInfo?.kind === 'image' ? FileImage : fileInfo?.kind === 'text' ? FileText : File;
  const busyMessage =
    busyAction?.action === 'application'
      ? `正在用 ${busyAction.applicationName} 打开文件…`
      : NATIVE_OPEN_OPTIONS.find((opt) => opt.id === busyAction?.action)?.busy;
  const backLabel = screen === 'actions' ? '返回目录' : '返回打开方式';

  return jsxs('section', {
    className: 'workspace-file-view workspace-file-chooser',
    ref: sectionRef,
    tabIndex: -1,
    'aria-label':
      screen === 'preview'
        ? '文件预览'
        : screen === 'applications'
          ? '选择应用打开文件'
          : '选择文件打开方式',
    onKeyDown: (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        handleStepBack();
      }
    },
    children: [
      jsxs('div', {
        className: 'workspace-file-header',
        children: [
          jsx('button', {
            type: 'button',
            className: 'icon-button small',
            disabled: Boolean(busyAction),
            'aria-label': backLabel,
            title: backLabel,
            onClick: handleStepBack,
            children: jsx(ArrowLeft, { size: 16 }),
          }),
          jsx('span', { title: fileName, children: fileName }),
        ],
      }),
      jsx('div', {
        className: 'file-path-label',
        title: fileInfo?.path || entry.path,
        children: fileInfo?.path || entry.path,
      }),
      loadingInfo
        ? jsxs('div', {
            className: 'panel-loading',
            role: 'status',
            children: [
              jsx(LoaderCircle, { size: 21, className: 'spin' }),
              jsx('span', { children: '正在读取文件信息' }),
            ],
          })
        : infoError
          ? jsxs('div', {
              className: 'panel-error',
              role: 'alert',
              children: [
                jsx('span', { children: infoError }),
                jsx('button', {
                  type: 'button',
                  className: 'text-button',
                  onClick: () => setInfoReloadKey((prev) => prev + 1),
                  children: '重新读取',
                }),
              ],
            })
          : fileInfo &&
            (screen === 'preview'
              ? jsx(WorkspaceFilePreview, { info: fileInfo, sessionId, onToast })
              : jsxs('div', {
                  className: 'workspace-file-actions-scroll',
                  children: [
                    screen === 'applications'
                      ? jsxs(Fragment, {
                          children: [
                            jsxs('div', {
                              className: 'workspace-file-summary',
                              children: [
                                jsx('span', {
                                  className: 'workspace-file-type-icon',
                                  children: jsx(AppWindow, { size: 21 }),
                                }),
                                jsxs('div', {
                                  children: [
                                    jsx('strong', { children: '选择应用' }),
                                    jsx('span', { children: '点选应用，即可打开此文件' }),
                                  ],
                                }),
                              ],
                            }),
                            appsState.loading
                              ? jsxs('div', {
                                  className: 'workspace-applications-state',
                                  role: 'status',
                                  children: [
                                    jsx(LoaderCircle, { size: 21, className: 'spin' }),
                                    jsx('span', { children: '正在查找可用应用…' }),
                                  ],
                                })
                              : appsState.error
                                ? jsx('div', {
                                    className: 'workspace-file-action-error',
                                    role: 'alert',
                                    children: jsx('p', { children: appsState.error }),
                                  })
                                : appsState.items.length
                                  ? jsx('div', {
                                      className: 'workspace-file-actions',
                                      role: 'group',
                                      'aria-label': '可用应用',
                                      children: appsState.items.map((app) =>
                                        jsxs(
                                          'button',
                                          {
                                            type: 'button',
                                            className:
                                              'workspace-file-action workspace-application-row',
                                            disabled:
                                              !fileInfo.actions.choose || Boolean(busyAction),
                                            title: `使用 ${app.name} 打开`,
                                            'aria-label': `使用 ${app.name} 打开`,
                                            onClick: () => invokeOpenAction('application', app.id),
                                            children: [
                                              busyAction?.applicationId === app.id
                                                ? jsx(LoaderCircle, { size: 18, className: 'spin' })
                                                : jsx(AppWindow, { size: 18 }),
                                              jsxs('span', {
                                                children: [
                                                  jsx('strong', { children: app.name }),
                                                  app.recommended &&
                                                    jsx('small', {
                                                      className:
                                                        'workspace-application-recommended',
                                                      children: '推荐',
                                                    }),
                                                ],
                                              }),
                                              jsx(ChevronRight, { size: 13 }),
                                            ],
                                          },
                                          app.id,
                                        ),
                                      ),
                                    })
                                  : jsxs('div', {
                                      className: 'workspace-applications-state',
                                      role: 'status',
                                      children: [
                                        jsx(AppWindow, { size: 23 }),
                                        jsx('strong', { children: '没有找到可用应用' }),
                                        jsx('span', {
                                          children: '可以返回打开方式，尝试用默认应用打开。',
                                        }),
                                      ],
                                    }),
                            !appsState.loading &&
                              !appsState.unsupported &&
                              fileInfo.actions.choose &&
                              jsxs('button', {
                                type: 'button',
                                className: 'text-button workspace-applications-refresh',
                                disabled: Boolean(busyAction),
                                onClick: refreshApplicationList,
                                children: [
                                  jsx(RefreshCw, { size: 12 }),
                                  appsState.error ? '重新查找应用' : '刷新应用列表',
                                ],
                              }),
                          ],
                        })
                      : jsxs(Fragment, {
                          children: [
                            jsxs('div', {
                              className: 'workspace-file-summary',
                              children: [
                                jsx('span', {
                                  className: 'workspace-file-type-icon',
                                  children: jsx(FileTypeIcon, { size: 21 }),
                                }),
                                jsxs('div', {
                                  children: [
                                    jsx('strong', { children: '选择打开方式' }),
                                    jsxs('span', {
                                      children: [
                                        fileInfo.kind === 'image'
                                          ? '图片'
                                          : fileInfo.kind === 'text'
                                            ? '文本文件'
                                            : '文件',
                                        ' · ',
                                        fileInfo.size === null
                                          ? '大小未知'
                                          : formatBytes(fileInfo.size),
                                      ],
                                    }),
                                  ],
                                }),
                              ],
                            }),
                            jsxs('div', {
                              className: 'workspace-file-actions',
                              role: 'group',
                              'aria-label': '文件打开选项',
                              children: [
                                jsxs('button', {
                                  type: 'button',
                                  className: 'workspace-file-action',
                                  ref: previewBtnRef,
                                  disabled: !fileInfo.canPreview || Boolean(busyAction),
                                  onClick: () => {
                                    if (fileInfo.canPreview) {
                                      setScreen('preview');
                                      sectionRef.current?.focus();
                                    }
                                  },
                                  children: [
                                    fileInfo.kind === 'image'
                                      ? jsx(FileImage, { size: 18 })
                                      : jsx(FileText, { size: 18 }),
                                    jsxs('span', {
                                      children: [
                                        jsx('strong', { children: '工作台预览' }),
                                        jsx('small', {
                                          children: fileInfo.canPreview
                                            ? fileInfo.kind === 'image'
                                              ? '直接在这里查看图片'
                                              : '直接在这里阅读文本'
                                            : '此文件类型暂不支持工作台预览',
                                        }),
                                      ],
                                    }),
                                    jsx(ChevronRight, { size: 13 }),
                                  ],
                                }),
                                NATIVE_OPEN_OPTIONS.map(({ id, label, description, Icon }) =>
                                  jsxs(
                                    'button',
                                    {
                                      type: 'button',
                                      className: 'workspace-file-action',
                                      ref: id === 'choose' ? chooseBtnRef : undefined,
                                      disabled: !fileInfo.actions[id] || Boolean(busyAction),
                                      onClick: () =>
                                        id === 'choose' ? openApplicationList() : invokeOpenAction(id),
                                      children: [
                                        busyAction?.action === id
                                          ? jsx(LoaderCircle, { size: 18, className: 'spin' })
                                          : jsx(Icon, { size: 18 }),
                                        jsxs('span', {
                                          children: [
                                            jsx('strong', { children: label }),
                                            jsx('small', {
                                              children: fileInfo.actions[id]
                                                ? description
                                                : '当前系统暂不支持',
                                            }),
                                          ],
                                        }),
                                        jsx(ChevronRight, { size: 13 }),
                                      ],
                                    },
                                    id,
                                  ),
                                ),
                              ],
                            }),
                          ],
                        }),
                    busyMessage &&
                      jsxs('div', {
                        className: 'workspace-file-notice',
                        role: 'status',
                        children: [
                          jsx(LoaderCircle, { size: 13, className: 'spin' }),
                          jsx('span', { children: busyMessage }),
                        ],
                      }),
                    actionNotice &&
                      jsxs('div', {
                        className: 'workspace-file-notice',
                        role: 'status',
                        children: [
                          jsx(Check, { size: 13 }),
                          jsx('span', { children: actionNotice }),
                        ],
                      }),
                    actionError &&
                      jsxs('div', {
                        className: 'workspace-file-action-error',
                        role: 'alert',
                        children: [
                          jsx('p', { children: actionError.message }),
                          !actionError.unsupported &&
                            jsxs('button', {
                              type: 'button',
                              className: 'text-button',
                              disabled: Boolean(busyAction),
                              onClick: () =>
                                invokeOpenAction(actionError.action, actionError.applicationId),
                              children: [jsx(RefreshCw, { size: 12 }), '重试此操作'],
                            }),
                        ],
                      }),
                    jsx('button', {
                      type: 'button',
                      className: 'text-button workspace-file-cancel',
                      disabled: Boolean(busyAction),
                      onClick: screen === 'applications' ? handleStepBack : onBack,
                      children: screen === 'applications' ? '返回打开方式' : '取消',
                    }),
                  ],
                })),
    ],
  });
}

function WorkspaceEntryIcon({ entry }) {
  if (entry.type === 'symlink') return jsx(Link2, { size: 16 });
  if (entry.type === 'directory' || entry.type === 'dir') {
    return jsx(Folder, { size: 16, className: 'folder-color' });
  }
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(entry.name)) {
    return jsx(FileImage, { size: 16 });
  }
  if (/\.(js|jsx|ts|tsx|json|py|html|css|go|rs|md|yaml|yml|toml)$/i.test(entry.name)) {
    return jsx(FileCodeCorner, { size: 16 });
  }
  return jsx(File, { size: 16 });
}

export function WorkspacePanel({ workspace, sessionId, revision, onToast }) {
  const [listing, setListing] = React.useState(null);
  const [currentPath, setCurrentPath] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [selectedFile, setSelectedFile] = React.useState(null);

  const reqIdRef = React.useRef(0);
  const rowRefs = React.useRef(new Map());
  const lastFocusedPathRef = React.useRef('');
  const latestPathRef = React.useRef('');
  const prevWorkspaceRef = React.useRef(Symbol('initial-workspace'));

  const loadDirectory = React.useCallback(
    async (relPath = '') => {
      const requestId = ++reqIdRef.current;
      latestPathRef.current = relPath;
      setCurrentPath(relPath);
      setLoading(true);
      setError('');

      try {
        const res = await api.workspace(relPath, { sessionId });
        if (requestId !== reqIdRef.current) return;
        setListing(res);
      } catch (err) {
        if (requestId === reqIdRef.current) {
          setError(err.message);
        }
      } finally {
        if (requestId === reqIdRef.current) {
          setLoading(false);
        }
      }
    },
    [sessionId],
  );

  React.useEffect(() => {
    if (prevWorkspaceRef.current === workspace) {
      loadDirectory(latestPathRef.current);
    } else {
      prevWorkspaceRef.current = workspace;
      setListing(null);
      setSelectedFile(null);
      lastFocusedPathRef.current = '';
      loadDirectory('');
    }
  }, [workspace, revision, loadDirectory]);

  React.useEffect(
    () => () => {
      reqIdRef.current += 1;
    },
    [],
  );

  const handleSelectFile = (entry) => {
    if (entry.type === 'symlink') return;
    lastFocusedPathRef.current = entry.path;
    setSelectedFile({ entry, workspace });
  };

  const handleCloseChooser = () => {
    setSelectedFile(null);
    requestAnimationFrame(() => rowRefs.current.get(lastFocusedPathRef.current)?.focus());
  };

  const handleNavigateUp = () => {
    const normalizedPath = (listing?.path || currentPath).replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedRoot = listing?.root?.replace(/\\/g, '/').replace(/\/$/, '');
    if (!normalizedPath || normalizedPath === normalizedRoot) return;
    const slashIdx = normalizedPath.lastIndexOf('/');
    const parent = slashIdx < 0 ? '' : normalizedPath.slice(0, slashIdx);
    loadDirectory(parent === normalizedRoot ? '' : parent);
  };

  const isAtRoot =
    !currentPath ||
    listing?.path === '.' ||
    listing?.path?.replace(/\\/g, '/') === listing?.root?.replace(/\\/g, '/');

  const displayPath =
    !listing?.path || listing.path === '.' ? listing?.root || workspace : listing.path;

  const sortedEntries = [...(listing?.entries || [])].sort((a, b) => {
    const aIsDir = ['directory', 'dir'].includes(a.type);
    const bIsDir = ['directory', 'dir'].includes(b.type);
    if (aIsDir === bIsDir) return a.name.localeCompare(b.name, 'zh-CN');
    return aIsDir ? -1 : 1;
  });

  if (selectedFile && selectedFile.workspace === workspace) {
    return jsx(
      WorkspaceFileChooser,
      {
        entry: selectedFile.entry,
        sessionId,
        onBack: handleCloseChooser,
        onToast,
      },
      selectedFile.entry.path,
    );
  }

  return jsxs('div', {
    className: 'workspace-panel',
    children: [
      jsxs('div', {
        className: 'workspace-location',
        children: [
          jsxs('div', {
            children: [
              jsx(FolderOpen, { size: 16 }),
              jsx('span', { title: displayPath, children: basenameOrWorkspace(displayPath) }),
            ],
          }),
          jsxs('div', {
            children: [
              !isAtRoot &&
                jsx('button', {
                  className: 'icon-button small',
                  onClick: handleNavigateUp,
                  'aria-label': '上一级目录',
                  title: '上一级目录',
                  children: jsx(ArrowLeft, { size: 14 }),
                }),
              jsx('button', {
                className: 'icon-button small',
                onClick: () => loadDirectory(currentPath),
                disabled: loading,
                'aria-label': '刷新目录',
                title: '刷新目录',
                children: jsx(RefreshCw, { size: 14, className: loading ? 'spin' : '' }),
              }),
            ],
          }),
        ],
      }),
      jsx('div', {
        className: 'workspace-root-path',
        title: displayPath,
        children: displayPath || '尚未设置工作目录',
      }),
      loading && !listing
        ? jsxs('div', {
            className: 'panel-loading',
            children: [
              jsx(LoaderCircle, { size: 20, className: 'spin' }),
              jsx('span', { children: '正在读取工作区' }),
            ],
          })
        : error
          ? jsxs('div', {
              className: 'panel-error',
              children: [
                jsx('span', { children: error }),
                jsx('button', {
                  className: 'text-button',
                  onClick: () => loadDirectory(currentPath),
                  children: '重新加载',
                }),
              ],
            })
          : sortedEntries.length
            ? jsx('div', {
                className: `file-list ${loading ? 'refreshing' : ''}`,
                children: sortedEntries.map((entry) =>
                  jsxs(
                    'button',
                    {
                      type: 'button',
                      ref: (node) => {
                        if (node) rowRefs.current.set(entry.path, node);
                        else rowRefs.current.delete(entry.path);
                      },
                      className: 'file-entry',
                      disabled: entry.type === 'symlink',
                      title:
                        entry.type === 'symlink'
                          ? `${entry.path}（符号链接暂不支持打开）`
                          : entry.path,
                      onClick: () =>
                        ['directory', 'dir'].includes(entry.type)
                          ? loadDirectory(entry.path)
                          : handleSelectFile(entry),
                      children: [
                        jsx(WorkspaceEntryIcon, { entry }),
                        jsx('span', { className: 'file-entry-name', children: entry.name }),
                        ['directory', 'dir'].includes(entry.type)
                          ? jsx(ChevronRight, { size: 13 })
                          : jsx('span', {
                              className: 'file-entry-size',
                              children:
                                entry.type === 'symlink' ? '链接' : formatBytes(entry.size),
                            }),
                      ],
                    },
                    entry.path,
                  ),
                ),
              })
            : jsxs('div', {
                className: 'panel-empty',
                children: [
                  jsx(FolderOpen, { size: 27 }),
                  jsx('strong', { children: '目录还是空的' }),
                  jsxs('p', {
                    children: [
                      '放入文件后，刷新即可查看。',
                      jsx('br', {}),
                      '这里展示当前工作目录的内容。',
                    ],
                  }),
                ],
              }),
      jsxs('div', {
        className: 'workspace-bottom',
        children: [
          jsx('span', {
            children: listing?.truncated
              ? `仅显示前 ${sortedEntries.length} 个项目`
              : `${sortedEntries.length} 个项目`,
          }),
          jsx('span', { children: '本机文件' }),
        ],
      }),
    ],
  });
}

export function SubagentsPanel({ entries = [], running = 0 }) {
  if (!entries.length) {
    return jsxs('div', {
      className: 'panel-empty subagents-empty',
      children: [
        jsxs('div', {
          className: 'subagent-empty-art',
          children: [
            jsx('span', {}),
            jsx('span', {}),
            jsx(Bot, { size: 26, strokeWidth: 1.3 }),
          ],
        }),
        jsx('strong', { children: '还没有子代理在替你工作' }),
        jsxs('p', {
          children: [
            '打开输入框的「团队」开关，或输入 /team，让队长把活拆给成员；',
            jsx('br', {}),
            '单个子代理的进度也会显示在这里。',
            jsx('br', {}),
            '它做的事和结论会收在这里。',
          ],
        }),
      ],
    });
  }

  return jsxs('div', {
    className: 'subagents-panel',
    children: [
      jsxs('div', {
        className: 'subagents-caption',
        children: [
          jsx('span', { children: '当前对话' }),
          jsx('span', {
            children:
              running > 0
                ? jsxs(Fragment, {
                    children: [
                      jsx(LoaderCircle, { size: 11, className: 'spin' }),
                      running,
                      ' 个进行中',
                    ],
                  })
                : `${entries.length} 个已记录`,
          }),
        ],
      }),
      jsx('div', {
        className: 'subagent-list',
        children: entries.map((entry) =>
          jsx(SubagentCard, { subagent: entry.subagent, entry }, entry.id),
        ),
      }),
      jsx('div', {
        className: 'subagents-footnote',
        children: '子代理的速度与耗时单独计算，同时计入底部主对话的 tokens/s。',
      }),
    ],
  });
}
