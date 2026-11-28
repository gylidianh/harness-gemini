/**
 * Harness Gemini UI - Composer Controls, Permission/Reasoning Menus, Token & Context Meters,
 * Attachment Uploader, Slash Skill Menu/Editor & Completion Popups
 * License: MIT
 */

import {
  React,
  createPortal,
  jsx,
  jsxs,
  Fragment,
  ArrowUpRight,
  Brain,
  Cable,
  Check,
  ChevronDown,
  CircleAlert,
  CornerDownLeft,
  FileArchive,
  FileCodeCorner,
  FileImage,
  FileSpreadsheet,
  FileText,
  Gauge,
  LoaderCircle,
  Paperclip,
  Pencil,
  Plus,
  ShieldAlert,
  Target,
  Trash,
  Users,
  WandSparkles,
  X,
  Zap,
} from '../vendor/vendor-deps.js';
import {
  usePermissionMenuPosition,
  useReasoningMenuPosition,
} from '../modules/composer-controls.js';
import {
  api,
  attachmentPreviewUrl,
  classifyAttachmentKind,
  createPastedTextFile,
  fileToDataUrl,
  formatBytes,
  validateAttachmentFile,
} from './api.js';
import {
  MAX_SKILL_TEXT_LENGTH,
  PERMISSION_MODES,
  REASONING_LEVELS,
  buildContextSummary,
  describeTokenMetrics,
  formatCompactNumber,
  formatSkillLength,
  getReasoningLevelMeta,
  getSupportedReasoningLevels,
  isProfileConfigured,
  normalizeReasoningEffort,
  resolveReasoningEffort,
  validateSkillDraft,
} from './model-utils.js';

const EXPIRED_AUTH_RE =
  /\bno\s+snlm0e\b|\bnot[\s_-]+(?:signed|logged)[\s_-]+in\b|\b(?:cookies?|login|session)(?:[\s_-]+(?:has|have|is|are))?[\s_-]+expired\b|\bexpired[\s_-]+(?:cookies?|login|session)\b|(?:cookies?|登录|登陆)(?:状态)?(?:已)?(?:失效|过期)|未登录|未登陆/i;

export function RunErrorBanner({ message, onDismiss }) {
  const isExpiredLogin = EXPIRED_AUTH_RE.test(message);

  return jsxs('div', {
    className: 'run-error',
    role: 'alert',
    children: [
      jsx(CircleAlert, { size: 16 }),
      isExpiredLogin
        ? jsxs('div', {
            className: 'run-error-body',
            children: [
              jsx('span', {
                children: '模型服务的登录已失效，请在服务后台更新登录状态后重试。',
              }),
              jsxs(
                'details',
                {
                  className: 'run-error-details',
                  children: [
                    jsx('summary', { children: '查看错误详情' }),
                    jsx('pre', { children: message }),
                  ],
                },
                message,
              ),
            ],
          })
        : jsx('span', { children: message }),
      jsx('button', {
        className: 'icon-button small',
        onClick: onDismiss,
        'aria-label': '关闭错误提示',
        children: jsx(X, { size: 14 }),
      }),
    ],
  });
}

export function ProfileQuickControl({
  profiles = [],
  activeProfileId,
  onChange,
  busy = false,
  disabled = false,
  hasRunning = false,
}) {
  const activeProfile = profiles.find((p) => p.id === activeProfileId);

  return jsx('div', {
    className: 'profile-quick-control',
    children: jsxs('div', {
      className: 'profile-quick-select',
      title:
        (activeProfile?.name || '模型连接') + (hasRunning ? ' · 切换从下一条消息生效' : ''),
      children: [
        jsx(Cable, { size: 13 }),
        jsxs('select', {
          'aria-label': '切换模型连接',
          value: activeProfile?.id || '',
          disabled: disabled || busy || !profiles.length,
          onChange: (ev) => onChange(ev.target.value),
          children: [
            !profiles.length && jsx('option', { value: '', children: '添加模型连接' }),
            profiles.map((p) =>
              jsxs(
                'option',
                {
                  value: p.id,
                  children: [p.name, isProfileConfigured(p) ? '' : ' · 待配置'],
                },
                p.id,
              ),
            ),
          ],
        }),
        busy ? jsx(LoaderCircle, { size: 12, className: 'spin' }) : jsx(ChevronDown, { size: 12 }),
      ],
    }),
  });
}

export function PermissionModePicker({
  value = 'ask',
  onChange,
  busy = false,
  disabled = false,
  hasRunning = false,
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const containerRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const dialogRef = React.useRef(null);
  const cancelBtnRef = React.useRef(null);

  const menuId = React.useId();
  const dialogTitleId = React.useId();

  const currentMode =
    PERMISSION_MODES.find((item) => item.id === value) || PERMISSION_MODES[0];
  const CurrentIcon = currentMode.Icon;

  usePermissionMenuPosition(React, menuOpen, triggerRef, containerRef, menuRef);

  React.useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (ev) => {
      if (!containerRef.current?.contains(ev.target)) setMenuOpen(false);
    };
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape') {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    (
      menuRef.current?.querySelector('[aria-checked="true"]') ||
      menuRef.current?.querySelector('button')
    )?.focus();

    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  React.useEffect(() => {
    if (!confirmOpen) return;
    cancelBtnRef.current?.focus();
    return () => triggerRef.current?.focus();
  }, [confirmOpen]);

  const handleSelectMode = async (modeId) => {
    setMenuOpen(false);
    if (modeId === currentMode.id || busy || disabled) return;
    if (modeId === 'full') {
      setConfirmOpen(true);
    } else {
      await onChange(modeId);
    }
  };

  return jsxs(Fragment, {
    children: [
      jsxs('div', {
        className: 'permission-control',
        ref: containerRef,
        children: [
          jsxs('button', {
            type: 'button',
            ref: triggerRef,
            className: `permission-trigger permission-${currentMode.id}`,
            disabled: disabled || busy,
            onClick: () => setMenuOpen((prev) => !prev),
            'aria-label': `操作权限：${currentMode.label}`,
            'aria-haspopup': 'menu',
            'aria-expanded': menuOpen,
            'aria-controls': menuId,
            title:
              currentMode.description + (hasRunning ? ' 切换从下一条请求生效。' : ''),
            children: [
              busy
                ? jsx(LoaderCircle, { size: 13, className: 'spin' })
                : jsx(CurrentIcon, { size: 13 }),
              jsx('span', { children: currentMode.label }),
              jsx(ChevronDown, { size: 12 }),
            ],
          }),
          menuOpen &&
            jsxs('div', {
              className: 'permission-menu',
              ref: menuRef,
              id: menuId,
              role: 'menu',
              'aria-label': '选择操作权限',
              onKeyDown: (ev) => {
                const items = Array.from(
                  menuRef.current?.querySelectorAll('[role="menuitemradio"]') || [],
                );
                if (!items.length) return;
                const cur = items.indexOf(document.activeElement);
                if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) {
                  ev.preventDefault();
                  const nextIdx =
                    ev.key === 'Home'
                      ? 0
                      : ev.key === 'End'
                        ? items.length - 1
                        : (cur + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                  items[nextIdx].focus();
                }
                if (ev.key === 'Tab') setMenuOpen(false);
              },
              children: [
                jsxs('div', {
                  className: 'permission-menu-caption',
                  children: [
                    '操作权限',
                    hasRunning && jsx('span', { children: '下条请求生效' }),
                  ],
                }),
                PERMISSION_MODES.map((item) =>
                  jsxs(
                    'button',
                    {
                      type: 'button',
                      role: 'menuitemradio',
                      'aria-checked': currentMode.id === item.id,
                      className: `permission-option${currentMode.id === item.id ? ' selected' : ''}${item.id === 'full' ? ' full' : ''}`,
                      onClick: () => handleSelectMode(item.id),
                      disabled: disabled || busy,
                      children: [
                        jsx(item.Icon, { size: 16 }),
                        jsxs('span', {
                          children: [
                            jsx('strong', { children: item.label }),
                            jsx('small', { children: item.description }),
                          ],
                        }),
                        jsx('span', {
                          className: 'permission-check',
                          children: currentMode.id === item.id && jsx(Check, { size: 14 }),
                        }),
                      ],
                    },
                    item.id,
                  ),
                ),
              ],
            }),
        ],
      }),
      confirmOpen &&
        createPortal(
          jsx('div', {
            className: 'modal-backdrop confirm-backdrop permission-confirm-backdrop',
            onMouseDown: (ev) => {
              if (ev.target === ev.currentTarget && !busy) setConfirmOpen(false);
            },
            children: jsxs('section', {
              className: 'confirm-dialog full-access-dialog',
              ref: dialogRef,
              role: 'alertdialog',
              'aria-modal': 'true',
              'aria-labelledby': dialogTitleId,
              onKeyDown: (ev) => {
                if (ev.key === 'Escape') {
                  ev.stopPropagation();
                  if (!busy) setConfirmOpen(false);
                }
                if (ev.key !== 'Tab') return;
                const focusable = Array.from(
                  dialogRef.current?.querySelectorAll('button:not(:disabled)') || [],
                );
                if (!focusable.length) {
                  ev.preventDefault();
                  return;
                }
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (ev.shiftKey && document.activeElement === first) {
                  ev.preventDefault();
                  last.focus();
                } else if (!ev.shiftKey && document.activeElement === last) {
                  ev.preventDefault();
                  first.focus();
                }
              },
              children: [
                jsx('span', {
                  className: 'confirm-icon',
                  children: jsx(ShieldAlert, { size: 23 }),
                }),
                jsx('h2', { id: dialogTitleId, children: '启用完全访问权限？' }),
                jsx('p', {
                  children:
                    '模型可自动读取、修改任意位置的文件，运行命令（包括联网），搜索和读取公开网页，并下载文件，不再逐项请求批准。',
                }),
                jsx('div', {
                  className: 'full-access-limit',
                  children:
                    '网页搜索、读取和下载工具仅支持公开 HTTP(S) 地址，仍有时间和大小限额。命令仍受运行时间和输出大小限制。你可以随时切回其他权限。',
                }),
                hasRunning &&
                  jsx('div', {
                    className: 'full-access-next',
                    children: '新权限从下一条请求开始生效。',
                  }),
                jsxs('div', {
                  className: 'full-access-actions',
                  children: [
                    jsx('button', {
                      type: 'button',
                      ref: cancelBtnRef,
                      className: 'button button-quiet',
                      disabled: busy,
                      onClick: () => setConfirmOpen(false),
                      children: '保持当前权限',
                    }),
                    jsxs('button', {
                      type: 'button',
                      className: 'button button-danger',
                      disabled: busy,
                      onClick: async () => {
                        if (await onChange('full')) setConfirmOpen(false);
                      },
                      children: [
                        busy
                          ? jsx(LoaderCircle, { size: 14, className: 'spin' })
                          : jsx(ShieldAlert, { size: 14 }),
                        '启用完全访问',
                      ],
                    }),
                  ],
                }),
              ],
            }),
          }),
          document.body,
        ),
    ],
  });
}

export function ReasoningEffortPicker({
  model = '',
  mode = 'chat',
  protocol = 'chat',
  value = '',
  onChange,
  busy = false,
  disabled = false,
  hasRunning = false,
}) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const menuId = React.useId();

  const normalizedValue = normalizeReasoningEffort(value);
  const trimmedModel = String(model || '').trim();
  const supportedLevels =
    mode === 'image' ? [] : getSupportedReasoningLevels(trimmedModel, protocol);
  const supportedIds = new Set(supportedLevels.map((item) => item.id));
  const isModelSupported =
    mode !== 'image' && Boolean(trimmedModel) && supportedLevels.length > 0;
  const resolution =
    mode === 'image'
      ? { requested: normalizedValue, effective: '', supported: false, clamped: false, supportedIds: [] }
      : resolveReasoningEffort(normalizedValue, trimmedModel, protocol);
  const activeMeta = getReasoningLevelMeta(normalizedValue);
  const effectiveMeta = getReasoningLevelMeta(resolution.effective);
  const activeLabel = activeMeta?.label || '';
  const isClamped =
    isModelSupported && Boolean(normalizedValue) && resolution.clamped && Boolean(effectiveMeta);

  const inactiveReason =
    !normalizedValue || isModelSupported
      ? ''
      : mode === 'image'
        ? '生图请求不发送推理参数'
        : trimmedModel
          ? `当前模型「${trimmedModel}」不支持，暂不发送`
          : '当前模式未配置模型，配置后生效';

  const clampedReason = isClamped
    ? `当前模型「${trimmedModel}」不支持${activeLabel}（${normalizedValue}），实际按${effectiveMeta.label}（${resolution.effective}）发送`
    : '';

  useReasoningMenuPosition(React, open, triggerRef, containerRef, menuRef);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (ev) => {
      if (!containerRef.current?.contains(ev.target)) setOpen(false);
    };
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    (
      menuRef.current?.querySelector('[aria-checked="true"]:not(:disabled)') ||
      menuRef.current?.querySelector('[role="menuitemradio"]:not(:disabled)')
    )?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleChoose = (nextId) => {
    setOpen(false);
    if (nextId !== normalizedValue && !busy && !disabled) {
      onChange(nextId);
    }
  };

  const handleMenuKeyDown = (ev) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll('[role="menuitemradio"]:not(:disabled)') || [],
    );
    if (!items.length) return;
    const cur = items.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) {
      ev.preventDefault();
      const nextIdx =
        ev.key === 'Home'
          ? 0
          : ev.key === 'End'
            ? items.length - 1
            : (cur + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[nextIdx].focus();
    }
    if (ev.key === 'Tab') setOpen(false);
  };

  const fullTriggerLabel = !activeLabel
    ? '思考·默认'
    : isClamped
      ? `思考·${activeLabel}→${effectiveMeta.label}`
      : `思考·${activeLabel}`;
  const compactTriggerLabel = !activeLabel
    ? '默认'
    : isClamped
      ? `${activeLabel}→${effectiveMeta.label}`
      : activeLabel;

  const titleTooltip =
    [
      activeLabel
        ? `当前推理等级：${activeLabel}（${normalizedValue}）`
        : '当前使用模型默认推理等级',
      clampedReason || inactiveReason,
      hasRunning ? '切换从下一条消息生效' : '',
    ]
      .filter(Boolean)
      .join('。') + '。';

  const supportedSummary = supportedLevels
    .map((item) => `${item.label}（${item.id}）`)
    .join('、');

  return jsxs('div', {
    className: 'reasoning-control',
    ref: containerRef,
    children: [
      jsxs('button', {
        type: 'button',
        ref: triggerRef,
        className: `reasoning-trigger${normalizedValue ? ' active' : ''}${inactiveReason ? ' inactive' : ''}${isClamped ? ' clamped' : ''}`,
        disabled: disabled || busy,
        onClick: () => setOpen((prev) => !prev),
        'aria-label': `推理等级：${activeLabel ? `${activeLabel}（${normalizedValue}）` : '模型默认'}${clampedReason || inactiveReason ? `，${clampedReason || inactiveReason}` : ''}`,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': menuId,
        title: titleTooltip,
        children: [
          busy
            ? jsx(LoaderCircle, { size: 13, className: 'spin' })
            : jsx(Brain, { size: 13 }),
          jsx('span', {
            className: 'reasoning-label-full',
            children: fullTriggerLabel,
          }),
          jsx('span', {
            className: 'reasoning-label-compact',
            children: compactTriggerLabel,
          }),
          jsx(ChevronDown, { size: 12 }),
        ],
      }),
      open &&
        jsxs('div', {
          className: 'reasoning-menu',
          ref: menuRef,
          id: menuId,
          role: 'menu',
          'aria-label': '选择推理等级',
          onKeyDown: handleMenuKeyDown,
          children: [
            jsxs('div', {
              className: 'reasoning-menu-caption',
              children: [
                '推理等级（由低到高）',
                hasRunning && jsx('span', { children: '下条消息生效' }),
              ],
            }),
            !isModelSupported &&
              jsx('div', {
                className: 'reasoning-menu-note',
                children:
                  mode === 'image'
                    ? '生图请求不发送推理参数；这里的选择用于聊天和编程。'
                    : trimmedModel
                      ? `当前模型「${trimmedModel}」不被识别为支持推理等级，向它发送的请求不带此参数；切换到支持的模型后自动生效。`
                      : '当前模式还没有配置模型。可以先选好等级，配置支持推理的模型后自动生效。',
              }),
            isClamped &&
              jsx('div', {
                className: 'reasoning-menu-note',
                children: `当前模型「${trimmedModel}」不支持「${activeLabel}（${normalizedValue}）」，发送请求时将自动按「${effectiveMeta.label}（${resolution.effective}）」发送；切回支持该档位的模型后自动恢复。`,
              }),
            isModelSupported &&
              !isClamped &&
              supportedLevels.length < REASONING_LEVELS.length &&
              jsx('div', {
                className: 'reasoning-menu-note',
                children: `当前模型「${trimmedModel}」支持：${supportedSummary}。`,
              }),
            jsxs('button', {
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': !normalizedValue,
              className: `reasoning-option${normalizedValue ? '' : ' selected'}`,
              onClick: () => handleChoose(''),
              disabled: disabled || busy,
              children: [
                jsxs('span', {
                  children: [
                    jsx('strong', { children: '模型默认' }),
                    jsx('small', { children: '不发送推理参数，由服务端决定' }),
                  ],
                }),
                jsx('span', {
                  className: 'reasoning-check',
                  children: !normalizedValue && jsx(Check, { size: 14 }),
                }),
              ],
            }),
            REASONING_LEVELS.map((lvl) => {
              const levelSupported = !isModelSupported || supportedIds.has(lvl.id);
              const isSelected = normalizedValue === lvl.id;
              return jsxs(
                'button',
                {
                  type: 'button',
                  role: 'menuitemradio',
                  'aria-checked': isSelected,
                  className: `reasoning-option${isSelected ? ' selected' : ''}${levelSupported ? '' : ' unsupported'}`,
                  onClick: () => handleChoose(lvl.id),
                  disabled: disabled || busy || !levelSupported,
                  title: levelSupported
                    ? lvl.description
                    : `当前模型「${trimmedModel}」不支持 ${lvl.label}（${lvl.id}）`,
                  children: [
                    jsxs('span', {
                      children: [
                        jsxs('strong', {
                          children: [
                            lvl.label,
                            jsx('em', { children: lvl.id }),
                            !levelSupported &&
                              jsx('span', {
                                className: 'reasoning-unsupported-badge',
                                children: '此模型不支持',
                              }),
                          ],
                        }),
                        jsx('small', { children: lvl.description }),
                      ],
                    }),
                    jsx('span', {
                      className: 'reasoning-check',
                      children: isSelected && jsx(Check, { size: 14 }),
                    }),
                  ],
                },
                lvl.id,
              );
            }),
          ],
        }),
    ],
  });
}

export function TokenMetricsBar({ metrics, mode, isRunning = false }) {
  const info = describeTokenMetrics(metrics, mode);

  return jsxs('div', {
    className: `token-metrics${isRunning ? ' is-live' : ''}`,
    title: info.tooltip,
    tabIndex: 0,
    'aria-label': `${info.speed} tokens/s，模型请求耗时 ${info.elapsed}。${info.tooltip}`,
    children: [
      jsxs('span', {
        className: 'metric-speed',
        children: [
          jsx(Gauge, { size: 12 }),
          jsx('strong', { children: info.speed }),
          jsx('span', { children: 'tokens/s' }),
        ],
      }),
      jsxs('span', {
        className: 'metric-duration',
        children: [
          jsx('span', { children: '耗时' }),
          jsx('strong', { children: info.elapsed }),
        ],
      }),
    ],
  });
}

function ContextRingSvg({ percent, active }) {
  const circumference = 2 * Math.PI * 6;
  return jsxs('svg', {
    className: 'context-ring',
    viewBox: '0 0 16 16',
    'aria-hidden': 'true',
    focusable: 'false',
    children: [
      jsx('circle', {
        className: 'context-ring-track',
        cx: '8',
        cy: '8',
        r: 6,
        fill: 'none',
        strokeWidth: '2.6',
      }),
      active &&
        jsx('circle', {
          className: 'context-ring-value',
          cx: '8',
          cy: '8',
          r: 6,
          fill: 'none',
          strokeWidth: '2.6',
          strokeLinecap: 'round',
          strokeDasharray: `${circumference} ${circumference}`,
          strokeDashoffset: circumference * (1 - Math.min(Math.max(percent, 0), 1)),
        }),
    ],
  });
}

function ContextUsageBar({ segments, percent }) {
  if (segments.length) {
    return jsx('div', {
      className: 'context-bar',
      role: 'presentation',
      children: segments.map((seg) =>
        jsx(
          'span',
          {
            className: `context-bar-segment tone-${Math.min(seg.tone, 2)}`,
            style: { width: `${seg.percent * percent * 100}%` },
          },
          seg.source,
        ),
      ),
    });
  }
  return jsx('div', {
    className: 'context-bar',
    role: 'presentation',
    children: jsx('span', {
      className: 'context-bar-fill',
      style: { width: `${percent * 100}%` },
    }),
  });
}

export function ContextMeter({
  context,
  mode,
  running = false,
  live = false,
  loading = false,
  autoCompact = true,
  locale = 'zh-CN',
}) {
  const [open, setOpen] = React.useState(false);
  const meterRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const panelId = React.useId();

  const summary = buildContextSummary(context, {
    live,
    running,
    autoCompact,
    locale,
  });
  const hideForImage = mode === 'image' && !summary.hasContext;

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (ev) => {
      if (!meterRef.current?.contains(ev.target) && !panelRef.current?.contains(ev.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (hideForImage) return null;

  const triggerRect = open ? triggerRef.current?.getBoundingClientRect() : null;
  const popoverStyle = triggerRect
    ? {
        left: Math.min(
          Math.max(8, triggerRect.left + triggerRect.width / 2 - 130),
          Math.max(8, window.innerWidth - 268),
        ),
        bottom: Math.max(8, window.innerHeight - triggerRect.top + 8),
      }
    : undefined;

  return jsxs(Fragment, {
    children: [
      jsx('div', {
        className: `context-meter${running || live ? ' is-live' : ''}${summary.nearLimit ? ' is-near-limit' : ''}`,
        ref: meterRef,
        children: jsxs('button', {
          type: 'button',
          ref: triggerRef,
          className: 'context-trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-controls': panelId,
          onClick: () => setOpen((prev) => !prev),
          title: summary.tooltip,
          'aria-label': summary.hasContext
            ? `上下文占用 ${summary.summary} token，${summary.percentLabel}。${summary.tooltip}`
            : '上下文占用：暂无数据',
          children: [
            loading
              ? jsx(LoaderCircle, { size: 13, className: 'spin' })
              : jsx(ContextRingSvg, { percent: summary.percent, active: summary.ring }),
            jsx('span', { className: 'context-label', children: '上下文' }),
            jsx('strong', { children: summary.hasContext ? summary.percentLabel : '—' }),
            summary.estimated &&
              summary.hasContext &&
              jsx('span', {
                className: 'context-approx',
                title: '本地估算',
                children: '≈',
              }),
          ],
        }),
      }),
      open &&
        triggerRect &&
        createPortal(
          jsxs('div', {
            className: 'context-panel',
            id: panelId,
            ref: panelRef,
            role: 'dialog',
            'aria-label': '上下文占用',
            style: popoverStyle,
            children: [
              jsxs('div', {
                className: 'context-panel-head',
                children: [
                  jsx('span', { children: '上下文占用' }),
                  jsx('span', {
                    className: 'context-panel-value',
                    children: summary.hasContext ? summary.summary : '暂无数据',
                  }),
                ],
              }),
              summary.hasContext
                ? jsxs(Fragment, {
                    children: [
                      jsx(ContextUsageBar, {
                        segments: summary.segments,
                        percent: summary.percent,
                      }),
                      jsxs('div', {
                        className: 'context-panel-caption',
                        children: [
                          jsxs('span', {
                            children: [
                              summary.estimated ? '本地估算' : '上游用量',
                              !live && ' · 上次记录',
                            ],
                          }),
                          jsx('span', { children: summary.percentLabel }),
                        ],
                      }),
                      summary.segments.length > 0 &&
                        jsx('div', {
                          className: 'context-breakdown',
                          children: summary.segments.map((seg) =>
                            jsxs(
                              'div',
                              {
                                className: 'context-breakdown-row',
                                children: [
                                  jsx('i', {
                                    className: `tone-${Math.min(seg.tone, 2)}`,
                                    'aria-hidden': 'true',
                                  }),
                                  jsx('span', { children: seg.label }),
                                  jsx('strong', {
                                    children: new Intl.NumberFormat(locale, {
                                      style: 'percent',
                                      maximumFractionDigits: 1,
                                    }).format(seg.percent),
                                  }),
                                ],
                              },
                              seg.source,
                            ),
                          ),
                        }),
                      jsxs('div', {
                        className: 'context-panel-foot',
                        children: [
                          summary.cacheLabel &&
                            jsxs('div', {
                              children: [
                                jsx('span', { children: '缓存命中' }),
                                jsx('strong', { children: summary.cacheLabel }),
                              ],
                            }),
                          jsxs('div', {
                            children: [
                              jsx('span', { children: '自动压缩' }),
                              jsx('strong', {
                                children: autoCompact
                                  ? `达 ${formatCompactNumber(context?.threshold ?? 0, locale)} 时`
                                  : '已关闭',
                              }),
                            ],
                          }),
                        ],
                      }),
                      jsxs('p', {
                        className: 'context-panel-note',
                        children: [
                          summary.estimated
                            ? '数值由本地字符估算，收到上游用量回执后会更精确。'
                            : '数值来自上游返回的用量。',
                          !live && '这是上次保存时的记录。',
                        ],
                      }),
                      jsx('p', {
                        className: 'context-panel-note',
                        children: '发送 /compact 可立即压缩较早的历史。',
                      }),
                    ],
                  })
                : jsx('p', {
                    className: 'context-panel-note',
                    children: '发送一条消息后，这里会显示上下文的占用情况。',
                  }),
            ],
          }),
          document.body,
        ),
    ],
  });
}

export function CompletionPopupStack({ notices, onOpen, onDismiss }) {
  if (!notices.length) return null;

  return jsx('div', {
    className: 'completion-stack',
    children: notices.map((notice) =>
      jsxs(
        'section',
        {
          className: `completion-popup ${notice.status}`,
          role: 'status',
          'aria-label': '任务结束提醒',
          children: [
            jsx('span', {
              className: 'completion-popup-icon',
              children:
                notice.status === 'error'
                  ? jsx(CircleAlert, { size: 19 })
                  : jsx(Check, { size: 19 }),
            }),
            jsxs('div', {
              className: 'completion-popup-content',
              children: [
                jsx('strong', { children: notice.label }),
                jsx('span', { title: notice.title, children: notice.title }),
                jsxs('button', {
                  type: 'button',
                  className: 'text-button completion-open',
                  onClick: () => onOpen(notice),
                  children: [
                    notice.status === 'error' ? '查看详情' : '查看结果',
                    jsx(ArrowUpRight, { size: 13 }),
                  ],
                }),
              ],
            }),
            jsx('button', {
              type: 'button',
              className: 'icon-button small',
              'aria-label': '关闭任务提醒',
              onClick: () => onDismiss(notice.id),
              children: jsx(X, { size: 15 }),
            }),
          ],
        },
        notice.id,
      ),
    ),
  });
}

function AttachmentThumbIcon({ kind }) {
  const IconComp =
    kind === 'image'
      ? FileImage
      : kind === 'sheet'
        ? FileSpreadsheet
        : kind === 'archive'
          ? FileArchive
          : kind === 'text'
            ? FileText
            : FileCodeCorner;
  return jsx(IconComp, { size: 15 });
}

function ComposerAttachmentChip({ attachment, sessionId, onRemove, onRetry, disabled }) {
  const kind = classifyAttachmentKind(attachment);
  const thumbUrl =
    kind === 'image' && attachment.status === 'ready'
      ? attachmentPreviewUrl(attachment, sessionId)
      : '';
  const statusLabel =
    attachment.status === 'uploading'
      ? '正在上传'
      : attachment.status === 'failed'
        ? attachment.error || '上传失败'
        : `已就绪${attachment.size ? ` · ${formatBytes(attachment.size)}` : ''}`;

  return jsxs('li', {
    className: `attachment-chip kind-${kind} status-${attachment.status}`,
    children: [
      jsxs('span', {
        className: 'attachment-thumb',
        'aria-hidden': 'true',
        children: [
          thumbUrl
            ? jsx('img', {
                src: thumbUrl,
                alt: '',
                decoding: 'async',
                referrerPolicy: 'no-referrer',
              })
            : jsx(AttachmentThumbIcon, { kind }),
          attachment.status === 'uploading' &&
            jsx('span', {
              className: 'attachment-progress',
              children: jsx(LoaderCircle, { size: 13, className: 'spin' }),
            }),
        ],
      }),
      jsxs('span', {
        className: 'attachment-meta',
        children: [
          jsx('span', {
            className: 'attachment-name',
            title: attachment.name,
            children: attachment.name,
          }),
          jsx('span', {
            className: 'attachment-size',
            role: 'status',
            children: statusLabel,
          }),
        ],
      }),
      attachment.status === 'failed' &&
        jsx('button', {
          type: 'button',
          className: 'text-button attachment-retry',
          disabled,
          onClick: () => onRetry(attachment),
          children: '重试',
        }),
      jsx('button', {
        type: 'button',
        className: 'icon-button tiny attachment-remove',
        disabled,
        'aria-label': `移除附件 ${attachment.name}`,
        title: '移除附件',
        onClick: () => onRemove(attachment),
        children: jsx(X, { size: 13 }),
      }),
    ],
  });
}

export const ComposerAttachments = React.forwardRef(function ComposerAttachments(
  { sessionId, attachments, onChange, onToast, disabled, ensureSession, busy },
  ref,
) {
  const fileInputRef = React.useRef(null);
  const seqRef = React.useRef(0);

  const patchAttachment = React.useCallback(
    (targetSessionId, attachmentId, patch) =>
      onChange(
        (list) => list.map((item) => (item.id === attachmentId ? { ...item, ...patch } : item)),
        targetSessionId,
      ),
    [onChange],
  );

  const uploadSingle = React.useCallback(
    async (item, targetSessionId) => {
      try {
        const uploaded = await api.uploadAttachment(targetSessionId, {
          name: item.name,
          mime: item.mime,
          data: await fileToDataUrl(item.file),
        });
        patchAttachment(targetSessionId, item.id, {
          status: 'ready',
          ref: uploaded.ref,
          path: uploaded.path,
          name: uploaded.name,
          mime: uploaded.mime,
          size: uploaded.size,
        });
      } catch (err) {
        patchAttachment(targetSessionId, item.id, {
          status: 'failed',
          error: err.message || '上传失败',
        });
      }
    },
    [patchAttachment],
  );

  const addFiles = React.useCallback(
    async (rawFiles) => {
      const files = [...rawFiles];
      if (!files.length) return;
      let targetSessionId = sessionId;
      if (!targetSessionId) {
        targetSessionId = await ensureSession();
        if (!targetSessionId) return;
      }

      const remainingSlots = 8 - attachments.length;
      if (remainingSlots <= 0) {
        onToast?.('一条消息最多 8 个附件', 'error');
        return;
      }
      if (files.length > remainingSlots) {
        onToast?.('一条消息最多 8 个附件，已忽略其余文件', 'error');
      }

      const pendingItems = [];
      for (const file of files.slice(0, remainingSlots)) {
        const validationError = validateAttachmentFile(file);
        if (validationError) {
          onToast?.(validationError, 'error');
        } else {
          seqRef.current += 1;
          pendingItems.push({
            id: `attachment-${seqRef.current}-${Date.now()}`,
            name: file.name,
            mime: String(file.type || '').split(';')[0].trim().toLowerCase(),
            size: file.size,
            status: 'uploading',
            file,
          });
        }
      }

      if (pendingItems.length) {
        onChange((prev) => [...prev, ...pendingItems], targetSessionId);
        for (const item of pendingItems) {
          await uploadSingle(item, targetSessionId);
        }
      }
    },
    [attachments.length, ensureSession, onChange, onToast, sessionId, uploadSingle],
  );

  const addFromPaste = React.useCallback(
    (ev) => {
      if (disabled) return false;
      const pastedFiles = [...(ev.clipboardData?.items ?? [])]
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (pastedFiles.length) {
        ev.preventDefault();
        addFiles(pastedFiles);
        return true;
      }
      const pastedText = ev.clipboardData?.getData('text/plain') ?? '';
      if (pastedText.length >= 15360) {
        ev.preventDefault();
        addFiles([createPastedTextFile(pastedText)]);
        return true;
      }
      return false;
    },
    [addFiles, disabled],
  );

  const addFromDrop = React.useCallback(
    (ev) => {
      if (disabled) return false;
      const droppedFiles = [...(ev.dataTransfer?.files ?? [])];
      if (!droppedFiles.length) return false;
      ev.preventDefault();
      addFiles(droppedFiles);
      return true;
    },
    [addFiles, disabled],
  );

  const openPicker = React.useCallback(() => {
    if (!disabled && !busy) {
      fileInputRef.current?.click();
    }
  }, [busy, disabled]);

  React.useImperativeHandle(
    ref,
    () => ({
      addFiles,
      addFromPaste,
      addFromDrop,
      openPicker,
    }),
    [addFiles, addFromDrop, addFromPaste, openPicker],
  );

  const handleRetry = (item) => {
    if (item.file) {
      patchAttachment(sessionId, item.id, { status: 'uploading', error: '' });
      uploadSingle(item, sessionId);
    } else {
      patchAttachment(sessionId, item.id, {
        status: 'failed',
        error: '请移除后重新添加这个文件',
      });
    }
  };

  return jsxs('div', {
    className: 'composer-attachments',
    children: [
      attachments.length > 0 &&
        jsx('ul', {
          className: 'attachment-list',
          'aria-label': '待发送附件',
          children: attachments.map((item) =>
            jsx(
              ComposerAttachmentChip,
              {
                attachment: item,
                sessionId,
                onRemove: (target) =>
                  onChange((list) => list.filter((entry) => entry.id !== target.id)),
                onRetry: handleRetry,
                disabled,
              },
              item.id,
            ),
          ),
        }),
      jsx('input', {
        ref: fileInputRef,
        className: 'attachment-input',
        type: 'file',
        multiple: true,
        tabIndex: -1,
        'aria-hidden': 'true',
        onChange: (ev) => {
          const picked = [...(ev.target.files ?? [])];
          ev.target.value = '';
          addFiles(picked);
        },
      }),
    ],
  });
});

export function AttachmentDropVeil() {
  return jsxs('div', {
    className: 'attachment-drop-veil',
    role: 'presentation',
    children: [jsx(Paperclip, { size: 18 }), jsx('span', { children: '松开即可添加文件' })],
  });
}

export function useAttachmentDropZone() {
  const depthRef = React.useRef(0);
  const [dragging, setDragging] = React.useState(false);

  return {
    dragging,
    enter(ev) {
      if ([...(ev.dataTransfer?.types ?? [])].includes('Files')) {
        ev.preventDefault();
        depthRef.current += 1;
        setDragging(true);
      }
    },
    over(ev) {
      if ([...(ev.dataTransfer?.types ?? [])].includes('Files')) {
        ev.preventDefault();
      }
    },
    leave() {
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (!depthRef.current) setDragging(false);
    },
    end() {
      depthRef.current = 0;
      setDragging(false);
    },
  };
}

export function SkillSlashMenu({
  options = [],
  query = '',
  index = 0,
  onIndex,
  onSelect,
  onEdit,
  onCreate,
  onClose,
}) {
  const menuRef = React.useRef(null);
  const listboxId = React.useId();

  React.useEffect(() => {
    menuRef.current?.querySelector('.skill-option.active')?.scrollIntoView({ block: 'nearest' });
  }, [index, query]);

  const addIndex = options.length;

  return jsxs('div', {
    className: 'skill-menu',
    ref: menuRef,
    role: 'listbox',
    'aria-label': '提示词技能',
    id: listboxId,
    onMouseDown: (ev) => ev.preventDefault(),
    children: [
      jsxs('div', {
        className: 'skill-menu-caption',
        children: [
          jsx('span', { children: '提示词技能' }),
          query
            ? jsxs('span', { className: 'skill-menu-query', children: ['/', query] })
            : jsx('span', { children: '输入名称筛选' }),
        ],
      }),
      jsxs('div', {
        className: 'skill-menu-list',
        children: [
          options.map((opt, idx) =>
            jsxs(
              'div',
              {
                className: `skill-option ${opt.kind === 'command' ? 'is-command' : ''} ${idx === index ? 'active' : ''}`,
                role: 'option',
                'aria-selected': idx === index,
                onMouseEnter: () => onIndex?.(idx),
                children: [
                  jsxs('button', {
                    type: 'button',
                    className: 'skill-option-main',
                    onClick: () => onSelect(opt),
                    title: opt.description,
                    children: [
                      opt.kind === 'command'
                        ? opt.action === 'toggle-goal'
                          ? jsx(Target, { size: 15 })
                          : opt.action === 'toggle-subagent'
                            ? jsx(Users, { size: 15 })
                            : jsx(CornerDownLeft, { size: 15 })
                        : jsx(Zap, { size: 15 }),
                      jsxs('span', {
                        className: 'skill-option-text',
                        children: [
                          jsx('strong', { children: opt.label }),
                          jsx('small', { children: opt.description }),
                        ],
                      }),
                    ],
                  }),
                  opt.kind === 'skill' &&
                    jsx('button', {
                      type: 'button',
                      className: 'icon-button tiny skill-option-edit',
                      'aria-label': `修改技能 ${opt.name}`,
                      title: '修改技能',
                      onClick: () =>
                        onEdit({ id: opt.id, name: opt.name, text: opt.text }),
                      children: jsx(Pencil, { size: 13 }),
                    }),
                ],
              },
              `${opt.kind}-${opt.id}`,
            ),
          ),
          !options.length &&
            jsxs('div', {
              className: 'skill-menu-empty',
              children: [
                jsx(CircleAlert, { size: 14 }),
                jsx('span', {
                  children: query ? `没有名称包含“${query}”的技能` : '还没有技能，先添加一个吧',
                }),
              ],
            }),
        ],
      }),
      jsxs('button', {
        type: 'button',
        className: `skill-option skill-add ${index === addIndex ? 'active' : ''}`,
        onMouseEnter: () => onIndex?.(addIndex),
        onClick: onCreate,
        children: [
          jsx(Plus, { size: 15 }),
          jsxs('span', {
            className: 'skill-option-text',
            children: [
              jsx('strong', { children: '添加技能' }),
              jsx('small', { children: '保存一段要反复使用的提示词' }),
            ],
          }),
        ],
      }),
      jsxs('div', {
        className: 'skill-menu-foot',
        children: [
          jsxs('span', {
            children: [jsx('kbd', { children: '↑' }), jsx('kbd', { children: '↓' }), ' 选择'],
          }),
          jsxs('span', { children: [jsx('kbd', { children: 'Enter' }), ' 确认'] }),
          jsxs('span', { children: [jsx('kbd', { children: 'Esc' }), ' 关闭'] }),
          jsx('button', {
            type: 'button',
            className: 'icon-button tiny',
            'aria-label': '关闭技能菜单',
            title: '关闭',
            onClick: onClose,
            children: jsx(X, { size: 12 }),
          }),
        ],
      }),
    ],
  });
}

export function SelectedSkillChip({ skill, onRemove, onEdit }) {
  return jsxs('div', {
    className: 'skill-chip',
    children: [
      jsx(Zap, { size: 13 }),
      jsx('button', {
        type: 'button',
        className: 'skill-chip-name',
        title: skill.text,
        onClick: onEdit,
        children: skill.name,
      }),
      jsx('span', {
        className: 'skill-chip-size',
        children: formatSkillLength((skill.text || '').length),
      }),
      jsx('button', {
        type: 'button',
        className: 'icon-button tiny skill-chip-remove',
        'aria-label': `移除技能 ${skill.name}`,
        title: '移除技能',
        onClick: onRemove,
        children: jsx(X, { size: 12 }),
      }),
    ],
  });
}

export function GoalModeChip({ running = false, onRemove }) {
  return jsxs('div', {
    className: `skill-chip goal-chip ${running ? 'is-live' : ''}`,
    children: [
      jsx(Target, { size: 13 }),
      jsx('span', { className: 'goal-chip-name', children: '目标模式' }),
      jsx('span', {
        className: 'skill-chip-size',
        children: running ? '中断自动继续' : '中断时自动继续',
      }),
      jsx('button', {
        type: 'button',
        className: 'icon-button tiny skill-chip-remove',
        'aria-label': '关闭目标模式',
        title: '关闭目标模式',
        onClick: onRemove,
        children: jsx(X, { size: 12 }),
      }),
    ],
  });
}

export function SubagentModeChip({ running = false, onRemove }) {
  return jsxs('div', {
    className: `skill-chip subagent-chip ${running ? 'is-live' : ''}`,
    children: [
      jsx(Users, { size: 13 }),
      jsx('span', { className: 'subagent-chip-name', children: '团队' }),
      jsx('span', {
        className: 'skill-chip-size',
        children: running ? '成员并行中' : '多个成员并行',
      }),
      jsx('button', {
        type: 'button',
        className: 'icon-button tiny skill-chip-remove',
        'aria-label': '关闭团队模式',
        title: '关闭团队模式',
        onClick: onRemove,
        children: jsx(X, { size: 12 }),
      }),
    ],
  });
}

export function SkillEditorModal({ draft, onSave, onDelete, onClose, onToast }) {
  const [name, setName] = React.useState(draft?.name ?? '');
  const [text, setText] = React.useState(draft?.text ?? '');
  const [busyMode, setBusyMode] = React.useState('');
  const [error, setError] = React.useState('');
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const dialogRef = React.useRef(null);
  const nameInputRef = React.useRef(null);
  const titleId = React.useId();

  const isExisting = Boolean(draft?.existing);
  const validationError = validateSkillDraft({ name, text });

  React.useEffect(() => {
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, []);

  const handleSave = async () => {
    if (busyMode) return;
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusyMode('save');
    setError('');
    try {
      await onSave({
        id: draft?.id ?? '',
        name: name.trim(),
        text,
        existing: isExisting,
      });
    } catch (err) {
      const msg = err.message || '保存失败，请重试。';
      setError(msg);
      onToast?.(msg, 'error');
    } finally {
      setBusyMode('');
    }
  };

  return createPortal(
    jsx('div', {
      className: 'modal-backdrop skill-editor-backdrop',
      onMouseDown: (ev) => {
        if (ev.target === ev.currentTarget && !busyMode) onClose();
      },
      children: jsxs('section', {
        className: 'skill-editor',
        ref: dialogRef,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
        onKeyDown: (ev) => {
          if (ev.key === 'Escape' && !busyMode) {
            ev.stopPropagation();
            onClose();
            return;
          }
          if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
            ev.preventDefault();
            handleSave();
            return;
          }
          if (ev.key !== 'Tab') return;
          const focusable = Array.from(
            dialogRef.current?.querySelectorAll(
              'button:not(:disabled), input:not(:disabled), textarea:not(:disabled)',
            ) || [],
          );
          if (!focusable.length) {
            ev.preventDefault();
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (ev.shiftKey && document.activeElement === first) {
            ev.preventDefault();
            last.focus();
          } else if (!ev.shiftKey && document.activeElement === last) {
            ev.preventDefault();
            first.focus();
          }
        },
        children: [
          jsxs('header', {
            className: 'skill-editor-head',
            children: [
              jsx('span', {
                className: 'skill-editor-icon',
                children: jsx(WandSparkles, { size: 18 }),
              }),
              jsxs('div', {
                children: [
                  jsx('h2', { id: titleId, children: isExisting ? '修改技能' : '添加技能' }),
                  jsx('p', {
                    children: '借助技能，您可以便捷地重复使用提示，轻松完成重复性任务',
                  }),
                ],
              }),
              jsx('button', {
                type: 'button',
                className: 'icon-button',
                disabled: Boolean(busyMode),
                onClick: onClose,
                'aria-label': '关闭',
                title: '关闭',
                children: jsx(X, { size: 18 }),
              }),
            ],
          }),
          jsxs('form', {
            className: 'skill-editor-body',
            onSubmit: (ev) => {
              ev.preventDefault();
              handleSave();
            },
            children: [
              jsxs('label', {
                className: 'skill-field',
                children: [
                  jsx('span', { children: '名称' }),
                  jsxs('div', {
                    className: 'skill-name-field',
                    children: [
                      jsx(Zap, { size: 15 }),
                      jsx('input', {
                        ref: nameInputRef,
                        value: name,
                        maxLength: 40,
                        disabled: Boolean(busyMode),
                        spellCheck: 'false',
                        placeholder: '例如：解码',
                        onChange: (ev) => {
                          setName(ev.target.value);
                          setError('');
                        },
                      }),
                    ],
                  }),
                ],
              }),
              jsxs('label', {
                className: 'skill-field',
                children: [
                  jsx('span', { children: '说明' }),
                  jsx('textarea', {
                    value: text,
                    disabled: Boolean(busyMode),
                    spellCheck: 'false',
                    rows: 10,
                    placeholder:
                      '写下要重复使用的提示词，例如：这是个 VPN 订阅链接，被加密了，现在想让你解码',
                    onChange: (ev) => {
                      setText(ev.target.value);
                      setError('');
                    },
                  }),
                ],
              }),
              jsxs('div', {
                className: 'skill-editor-meta',
                children: [
                  jsx('span', { children: '字数无上限' }),
                  jsxs('span', {
                    children: [
                      formatSkillLength(text.length),
                      text.length > MAX_SKILL_TEXT_LENGTH
                        ? ` / 上限 ${formatSkillLength(MAX_SKILL_TEXT_LENGTH)}`
                        : '',
                    ],
                  }),
                  jsx('span', { children: 'Ctrl + Enter 保存' }),
                ],
              }),
              error && jsx('p', { className: 'field-error', role: 'alert', children: error }),
              confirmDelete &&
                jsxs('div', {
                  className: 'skill-delete-notice',
                  role: 'alert',
                  children: [
                    jsxs('p', {
                      children: ['删除“', draft.name || name, '”？已发送的消息不会受影响。'],
                    }),
                    jsxs('div', {
                      children: [
                        jsx('button', {
                          type: 'button',
                          className: 'text-button',
                          disabled: Boolean(busyMode),
                          onClick: () => setConfirmDelete(false),
                          children: '保留技能',
                        }),
                        jsxs('button', {
                          type: 'button',
                          className: 'button button-danger small-button',
                          disabled: Boolean(busyMode),
                          onClick: async () => {
                            if (busyMode) return;
                            setBusyMode('delete');
                            try {
                              await onDelete(draft.id);
                            } catch (err) {
                              setError(err.message || '删除失败，请重试。');
                            } finally {
                              setBusyMode('');
                            }
                          },
                          children: [
                            busyMode === 'delete'
                              ? jsx(LoaderCircle, { size: 13, className: 'spin' })
                              : jsx(Trash, { size: 13 }),
                            '确认删除',
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
            ],
          }),
          jsxs('footer', {
            className: 'skill-editor-foot',
            children: [
              isExisting
                ? jsxs('button', {
                    type: 'button',
                    className: 'button skill-delete-button',
                    disabled: Boolean(busyMode),
                    onClick: () => setConfirmDelete(true),
                    children: [jsx(Trash, { size: 14 }), '删除'],
                  })
                : jsx('span', {}),
              jsxs('div', {
                children: [
                  jsx('button', {
                    type: 'button',
                    className: 'button button-quiet',
                    disabled: Boolean(busyMode),
                    onClick: onClose,
                    children: '取消',
                  }),
                  jsxs('button', {
                    type: 'button',
                    className: 'button button-primary',
                    disabled: Boolean(busyMode) || Boolean(validationError),
                    title: validationError || '保存技能',
                    onClick: handleSave,
                    children: [
                      busyMode === 'save'
                        ? jsx(LoaderCircle, { size: 14, className: 'spin' })
                        : null,
                      '保存',
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    }),
    document.body,
  );
}
