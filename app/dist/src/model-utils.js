/**
 * Harness Gemini UI - Model Profiles, Reasoning, Permissions, Context Metrics,
 * Slash Skills, Goal Recovery State Machine & Scroll/Layout Helpers
 * License: MIT
 */

import {
  CodeXml,
  ImagePlus,
  MessageSquare,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from '../vendor/vendor-deps.js';
import { advancedDefaultsForProfile, advancedIsDirty } from '../advanced-settings.js';
import { normalizeSkinId } from './themes.js';

/* -------------------------------------------------------------------------- */
/* Modes & Connection Profiles                                                */
/* -------------------------------------------------------------------------- */

export const MODE_MODEL_KEYS = {
  chat: 'chatModel',
  agent: 'agentModel',
  image: 'imageModel',
};

export const MODE_IDS = ['chat', 'agent', 'image'];

export function getProfileModelForMode(profile, mode) {
  const key = MODE_MODEL_KEYS[mode];
  const raw = key ? profile?.[key] : '';
  return typeof raw === 'string' ? raw.trim() : '';
}

export function getConfiguredModes(profile) {
  return MODE_IDS.filter((mode) => getProfileModelForMode(profile, mode));
}

export function resolveAvailableMode(profile, preferredMode) {
  const available = getConfiguredModes(profile);
  return available.includes(preferredMode) ? preferredMode : available[0] || '';
}

export function getActiveProfile(settings) {
  if (Array.isArray(settings?.profiles) && settings.profiles.length) {
    return settings.profiles.find((p) => p.id === settings.activeProfileId) || null;
  }
  return settings || null;
}

export function isProfileConfigured(profile) {
  return Boolean(
    typeof profile?.baseUrl === 'string' &&
      profile.baseUrl.trim() &&
      getConfiguredModes(profile).length,
  );
}

/* -------------------------------------------------------------------------- */
/* Reasoning Effort & Capability Detection                                    */
/* -------------------------------------------------------------------------- */

export const REASONING_LEVELS = [
  {
    id: 'low',
    label: '低',
    description: '思考最少，回答最快，消耗 token 最少',
  },
  {
    id: 'medium',
    label: '中',
    description: '平衡思考深度与响应速度',
  },
  {
    id: 'high',
    label: '高',
    description: '思考最深入，适合复杂推理与多步任务',
  },
];

const REASONING_LEVEL_SET = new Set(REASONING_LEVELS.map((item) => item.id));

const REASONING_MODEL_PATTERNS = [
  /(?:^|[/:])(?:o[1-9]\d*|gpt-[5-9]\d*|gpt-\d{2,})(?:[.\-]|$)/i,
  /deepseek-(?:r\d+|reasoner|v3\.[1-9]\d*(?:[.\-]|$)|(?:v[4-9]|v\d{2,})(?:\.\d+)?(?:[.\-]|$))/i,
  /(?:qwq|qwen[3-9])/i,
  /glm-(?:z\d+|zero|4\.(?:[5-9]\d*|[1-9]\d+)|(?:[5-9]|\d{2,})(?:\.\d+)?)/i,
  /kimi-[a-z0-9.-]*(?:k2|k3|think)/i,
  /grok-[3-9]/i,
  /gemini-(?:2\.5|[3-9])/i,
  /claude-(?:[a-z]+-)?(?:3[.\-]7|[4-9])/i,
  /(?:reasoner|reasoning|thinking|-think)/i,
];

const CLAUDE_THINKING_PATTERN = /claude-(?:[a-z]+-)?(?:3[.\-]7|[4-9])/i;

export function isValidReasoningEffort(value) {
  return typeof value === 'string' && REASONING_LEVEL_SET.has(value);
}

export function getSupportedReasoningLevels(model, protocol = 'chat') {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  if (!trimmed) return [];
  if (protocol === 'anthropic' && /claude-/i.test(trimmed)) {
    return CLAUDE_THINKING_PATTERN.test(trimmed) ? [...REASONING_LEVELS] : [];
  }
  return REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(trimmed))
    ? [...REASONING_LEVELS]
    : [];
}

export function supportsReasoningEffort(model, protocol = 'chat') {
  return getSupportedReasoningLevels(model, protocol).length > 0;
}

export function normalizeReasoningEffort(value) {
  return isValidReasoningEffort(value) ? value : '';
}

/* -------------------------------------------------------------------------- */
/* Settings Drafts, Context Window & Protocols                                */
/* -------------------------------------------------------------------------- */

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const MIN_CONTEXT_WINDOW = 2_000;
export const MAX_CONTEXT_WINDOW = 20_000_000;
export const CONTEXT_WINDOW_PRESETS = [32_000, 64_000, 128_000, 200_000, 256_000, 1_000_000];

export const API_PROTOCOLS = [
  { id: 'anthropic', label: 'Anthropic Messages', path: '/v1/messages' },
  { id: 'chat', label: 'Chat Completions', path: '/chat/completions' },
  { id: 'responses', label: 'Responses', path: '/responses' },
];

export function normalizeProfileDraft(profile) {
  return {
    id: profile.id,
    name: profile.name || '默认连接',
    protocol: profile.protocol || 'chat',
    baseUrl: profile.baseUrl || '',
    chatModel: profile.chatModel || '',
    agentModel: profile.agentModel || '',
    imageModel: profile.imageModel || '',
    contextWindow: Number.isSafeInteger(profile.contextWindow)
      ? profile.contextWindow
      : DEFAULT_CONTEXT_WINDOW,
    reasoningEffort: profile.reasoningEffort || '',
    ...advancedDefaultsForProfile(profile),
    apiKeySet: Boolean(profile.apiKeySet),
    apiKey: typeof profile.apiKey === 'string' ? profile.apiKey : '',
  };
}

export function createSettingsDraft(settings) {
  const profiles = settings?.profiles?.length
    ? settings.profiles.map(normalizeProfileDraft)
    : [
        normalizeProfileDraft({
          ...settings,
          id: settings?.activeProfileId || crypto.randomUUID(),
          name: '默认连接',
        }),
      ];
  const activeProfileId = profiles.some((p) => p.id === settings?.activeProfileId)
    ? settings.activeProfileId
    : profiles[0].id;
  const maxToolRounds = settings?.maxToolRounds ?? 0;

  return {
    profiles,
    activeProfileId,
    selectedId: activeProfileId,
    workspace: settings?.workspace || '',
    maxToolRounds,
    limitedToolRounds: maxToolRounds === 0 ? '12' : String(maxToolRounds),
    completionSound: settings?.completionSound ?? true,
    completionNotification: settings?.completionNotification ?? true,
    autoCompact: settings?.autoCompact ?? true,
    fileChangesEnabled: settings?.fileChangesEnabled ?? true,
    globalProxyUrl: settings?.globalProxyUrl || '',
    skin: normalizeSkinId(settings?.skin),
  };
}

export function isProfileDirty(draft, saved) {
  if (!saved) return true;
  if (draft.apiKey.trim() !== (saved.apiKey || '').trim()) return true;
  const fields = [
    'name',
    'protocol',
    'baseUrl',
    'chatModel',
    'agentModel',
    'imageModel',
    'contextWindow',
    'reasoningEffort',
  ];
  return fields.some((field) => draft[field] !== saved[field]) || advancedIsDirty(draft, saved);
}

export function isValidHttpBaseUrl(value) {
  try {
    const parsed = new URL(value.trim());
    return (
      ['http:', 'https:'].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Permission Modes                                                           */
/* -------------------------------------------------------------------------- */

export const PERMISSION_MODES = [
  {
    id: 'ask',
    label: '请求批准',
    Icon: ShieldCheck,
    description: '自动读取工作区。写入、命令、外部路径，以及搜索网页、读取网页和下载文件都需批准。',
  },
  {
    id: 'smart',
    label: '帮我批准',
    Icon: Shield,
    description:
      '额外允许搜索和读取公开网页，以及在工作区新建、下载新文件。覆盖文件、命令及外部路径仍需批准。',
  },
  {
    id: 'full',
    label: '完全访问权限',
    Icon: ShieldAlert,
    description:
      '自动读写文件、运行命令并联网。网页搜索、读取和下载工具仅支持公开 HTTP(S) 地址，仍有时间和大小限额。',
  },
];

/* -------------------------------------------------------------------------- */
/* Token Rate & Context Window Meter Formatting                               */
/* -------------------------------------------------------------------------- */

export const TOKEN_METRICS_NOTE =
  '输出 token / 模型请求耗时，包含首字等待，不含工具执行及审批等待；≈ 为估算。';

export function describeTokenMetrics(metrics, mode) {
  const isEstimated = metrics?.source === 'estimated';
  const hasOutput =
    (metrics?.source === 'usage' || isEstimated) &&
    Number.isFinite(metrics?.outputTokens) &&
    metrics.outputTokens > 0;
  const showSpeed =
    mode !== 'image' &&
    hasOutput &&
    Number.isFinite(metrics?.tokensPerSecond) &&
    metrics.tokensPerSecond >= 0;

  const speed = showSpeed
    ? (isEstimated ? '≈ ' : '') +
      new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(metrics.tokensPerSecond)
    : '—';

  const hasElapsed = Number.isFinite(metrics?.elapsedMs) && metrics.elapsedMs >= 0;
  let elapsed = '—';
  if (hasElapsed) {
    const sec = metrics.elapsedMs / 1000;
    elapsed =
      sec < 60
        ? `${sec.toFixed(1)}秒`
        : `${Math.floor(sec / 60)}分 ${Math.floor(sec % 60)}秒`;
  }

  const tooltipParts = [TOKEN_METRICS_NOTE];
  if (mode === 'image') {
    tooltipParts.push('图片生成不显示 token 速度。');
  } else if (hasOutput) {
    tooltipParts.push(
      `输出：${isEstimated ? '≈ ' : ''}${Math.round(metrics.outputTokens).toLocaleString('en-US')} token。`,
    );
  }
  if (Number.isFinite(metrics?.requests) && metrics.requests > 0) {
    tooltipParts.push(`模型请求：${Math.floor(metrics.requests)} 次。`);
  }

  return {
    speed,
    elapsed,
    estimated: showSpeed && isEstimated,
    tooltip: tooltipParts.join(' '),
  };
}

export function formatCompactNumber(value, locale = 'zh-CN', { maximumFractionDigits = 1 } = {}) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale, {
    notation: Math.abs(value) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

export function formatContextUsagePair(context, locale = 'zh-CN') {
  const used = formatCompactNumber(context?.used ?? 0, locale, { maximumFractionDigits: 1 });
  const size = formatCompactNumber(context?.size ?? 0, locale, { maximumFractionDigits: 0 });
  return `${used} / ${size}`;
}

export function formatPercentRatio(value, locale = 'zh-CN') {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(Math.min(Math.max(value, 0), 1));
}

export function formatCacheHitRate(value, locale = 'zh-CN', minThreshold = 0.78) {
  if (!Number.isFinite(value) || value < minThreshold) return null;
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(Math.min(Math.max(value, 0), 1));
}

export const CONTEXT_SOURCE_LABELS = {
  system_prompt: '系统提示词',
  system_tool_schemas: '工具说明',
  messages: '对话消息',
};

const CONTEXT_SOURCE_ORDER = ['messages', 'system_prompt', 'system_tool_schemas'];

export function computeContextSegments(context) {
  const breakdown = Array.isArray(context?.breakdown) ? context.breakdown : [];
  const totalChars = breakdown.reduce(
    (sum, entry) => sum + (Number.isFinite(entry?.chars) && entry.chars > 0 ? entry.chars : 0),
    0,
  );
  if (totalChars <= 0) return [];

  return breakdown
    .filter(
      (entry) =>
        CONTEXT_SOURCE_LABELS[entry?.source] &&
        Number.isFinite(entry.chars) &&
        entry.chars > 0,
    )
    .map((entry) => ({
      source: entry.source,
      label: CONTEXT_SOURCE_LABELS[entry.source],
      percent: entry.chars / totalChars,
    }))
    .sort(
      (a, b) =>
        b.percent - a.percent ||
        CONTEXT_SOURCE_ORDER.indexOf(a.source) - CONTEXT_SOURCE_ORDER.indexOf(b.source),
    )
    .map((entry, idx) => ({ ...entry, tone: idx }));
}

export function buildContextSummary(
  context,
  { live = false, running = false, autoCompact = true, locale = 'zh-CN' } = {},
) {
  const hasContext =
    Number.isFinite(context?.used) && Number.isFinite(context?.size) && context.size > 0;
  const estimated = context?.source === 'estimated';
  const percent = hasContext ? Math.min(Math.max(context.used / context.size, 0), 1) : 0;
  const nearLimit = hasContext && percent >= 0.85;
  const notes = [];

  if (hasContext) {
    notes.push(
      `当前上下文占用 ${formatContextUsagePair(context, locale)} token（${formatPercentRatio(percent, locale)}）。`,
    );
    notes.push(
      estimated ? '该数值由本地字符估算得出，尚未收到上游用量回执。' : '该数值来自上游返回的用量。',
    );
    if (!live) {
      notes.push('这是上次保存时的记录，发送新消息后更新。');
    }
    if (autoCompact && hasContext) {
      notes.push(`达到 ${formatCompactNumber(context.threshold ?? 0, locale)} token 时自动压缩较早的历史。`);
    }
    if (!autoCompact) {
      notes.push('自动压缩已关闭；可手动发送 /compact 压缩。');
    }
  } else {
    notes.push('这次对话还没有可统计的上下文占用。');
  }

  const cacheLabel = formatCacheHitRate(context?.cache?.hitRate, locale);
  return {
    hasContext,
    percent,
    nearLimit,
    estimated,
    segments: computeContextSegments(context),
    summary: hasContext ? formatContextUsagePair(context, locale) : '—',
    percentLabel: hasContext ? formatPercentRatio(percent, locale) : '—',
    cacheLabel,
    ring: hasContext && (live || running),
    tooltip: notes.join(' '),
  };
}

/* -------------------------------------------------------------------------- */
/* Slash Commands & Reusable Prompt Skills                                    */
/* -------------------------------------------------------------------------- */

export const MAX_SKILL_TEXT_LENGTH = 200_000;

export const BUILTIN_SLASH_COMMANDS = [
  {
    id: 'goal',
    name: 'goal',
    label: '/goal',
    description:
      '目标模式：任务中断时自动发送「继续」，直到完成；短时间内连续异常会停下。可与任意技能同时使用。',
    action: 'toggle-goal',
  },
  {
    id: 'subagent',
    name: 'team',
    aliases: ['团队', '组建团队', 'team', 'subagent'],
    label: '/team',
    description:
      '团队模式：把任务拆成互不依赖、但需要互相交接和共享进度的几部分，用 team_run 组建一个小团队（每名成员一项工作、共用一块任务看板、成员之间可以留言）；队长同时做自己那部分，再用 team_wait 收结论。可与目标模式和任意技能同时使用。',
    action: 'toggle-subagent',
  },
  {
    id: 'compact',
    name: 'compact',
    label: '/compact',
    description: '压缩对话：较早的消息换成摘要，最近的消息保持原样',
    insert: '/compact',
  },
];

export function detectSlashTrigger(value, cursor) {
  const text = typeof value === 'string' ? value : '';
  const caret = Number.isInteger(cursor)
    ? Math.min(Math.max(cursor, 0), text.length)
    : text.length;
  const slashIndex = text.lastIndexOf('/', caret - 1);
  if (slashIndex < 0) return null;
  const query = text.slice(slashIndex + 1, caret);
  if (/[\s/\\]/.test(query)) return null;
  const charBefore = slashIndex > 0 ? text[slashIndex - 1] : '';
  if (charBefore && !/\s/.test(charBefore)) return null;
  return { start: slashIndex, end: caret, query };
}

export function replaceSlashTrigger(value, range, replacement) {
  const text = typeof value === 'string' ? value : '';
  const start = Number.isInteger(range?.start) ? range.start : text.length;
  const end = Number.isInteger(range?.end) ? range.end : text.length;
  return {
    text: text.slice(0, start) + replacement + text.slice(end),
    caret: start + String(replacement).length,
  };
}

export function filterSlashCommands(query) {
  const normalized = String(query ?? '').trim().toLowerCase();
  return BUILTIN_SLASH_COMMANDS.filter(
    (cmd) =>
      !normalized ||
      String(cmd.name).toLowerCase().startsWith(normalized) ||
      (cmd.aliases ?? []).some((alias) => String(alias).toLowerCase().startsWith(normalized)),
  );
}

export function filterPromptSkills(skills, query) {
  const normalized = String(query ?? '').trim().toLowerCase();
  const list = Array.isArray(skills) ? skills : [];
  if (!normalized) return [...list];
  return list.filter((skill) => String(skill?.name ?? '').toLowerCase().includes(normalized));
}

export function buildSlashMenuOptions(skills, query) {
  return [
    ...filterSlashCommands(query).map((cmd) => ({
      kind: 'command',
      id: cmd.id,
      label: cmd.label,
      description: cmd.description,
      insert: cmd.insert,
      action: cmd.action ?? null,
    })),
    ...filterPromptSkills(skills, query).map((skill) => ({
      kind: 'skill',
      id: skill.id,
      label: skill.name,
      description: skill.text,
      name: skill.name,
      text: skill.text,
    })),
  ];
}

export function validateSkillDraft({ name, text } = {}) {
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const rawText = typeof text === 'string' ? text : '';
  if (!trimmedName) return '请填写技能名称。';
  if (/[\r\n]/.test(trimmedName)) return '技能名称不能包含换行。';
  if (trimmedName.length > 40) return '技能名称不能超过 40 个字符。';
  if (!rawText.trim()) return '请填写技能说明，也就是要重复使用的提示词。';
  if (rawText.length > MAX_SKILL_TEXT_LENGTH) {
    return `技能说明不能超过 ${MAX_SKILL_TEXT_LENGTH.toLocaleString('en-US')} 个字符。`;
  }
  if (rawText.includes('\0')) return '技能说明不能包含空字符。';
  return '';
}

export function formatSkillLength(charCount) {
  const count = Number(charCount) || 0;
  return count < 1000
    ? `${count} 字`
    : `${(count / 1000).toFixed(+(count < 10000))} 千字`;
}

/* -------------------------------------------------------------------------- */
/* Goal Mode Auto-Resume State Machine                                        */
/* -------------------------------------------------------------------------- */

export const GOAL_CONTINUE_PROMPT = '继续';
export const GOAL_FAILURE_WINDOW_MS = 300_000;
export const GOAL_BACKOFF_DELAYS = [1500, 4000, 8000];

export function createGoalRecoveryState() {
  return { failures: [], resumes: 0 };
}

export function wasRunInterrupted({
  hadError = false,
  stopping = false,
  deleted = false,
  userReceived = false,
} = {}) {
  return Boolean(hadError) && !stopping && !deleted && Boolean(userReceived);
}

export function nextGoalRecoveryStep(
  prevState,
  { interrupted, now = Date.now() } = {},
) {
  const current =
    prevState && Array.isArray(prevState.failures) ? prevState : createGoalRecoveryState();
  if (!interrupted) {
    return {
      action: 'idle',
      state: createGoalRecoveryState(),
      resumes: current.resumes,
    };
  }

  const recentFailures = [
    ...current.failures.filter((ts) => now - ts <= GOAL_FAILURE_WINDOW_MS),
    now,
  ];
  if (recentFailures.length >= 3) {
    return {
      action: 'stop',
      state: { failures: recentFailures, resumes: current.resumes },
      failures: recentFailures.length,
      reason: 'burst',
    };
  }

  const delay = GOAL_BACKOFF_DELAYS[Math.min(recentFailures.length, GOAL_BACKOFF_DELAYS.length) - 1];
  return {
    action: 'continue',
    state: { failures: recentFailures, resumes: current.resumes + 1 },
    failures: recentFailures.length,
    resumes: current.resumes + 1,
    delay,
  };
}

export function stripLeadingGoalCommand(value) {
  const text = typeof value === 'string' ? value : '';
  const match = /^\s*\/goal(?=$|[\s,，、/])/i.exec(text);
  if (!match) return null;
  return { rest: text.slice(match[0].length).replace(/^[\s,，、/]+/, '') };
}

export function stripLeadingSubagentCommand(value) {
  const text = typeof value === 'string' ? value : '';
  const teamCmd = BUILTIN_SLASH_COMMANDS.find((cmd) => cmd.action === 'toggle-subagent');
  const names = teamCmd ? [teamCmd.name, ...(teamCmd.aliases || [])] : ['subagent'];
  const regex = new RegExp(`^\\s*\\/(?:${names.join('|')})(?=$|[\\s,，、/])`, 'i');
  const match = regex.exec(text);
  if (!match) return null;
  return { rest: text.slice(match[0].length).replace(/^[\s,，、/]+/, '') };
}

/* -------------------------------------------------------------------------- */
/* Scroll Following, Mode Metadata & Layout Persistence                       */
/* -------------------------------------------------------------------------- */

export function hasInnerScrollable(target, stopContainer) {
  let node = target && target.nodeType === 1 ? target : null;
  while (node && node !== stopContainer) {
    const overflowY = getComputedStyle(node).overflowY;
    if (
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      node.scrollHeight - node.clientHeight > 1
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

export function distanceFromBottom(scrollEl) {
  return scrollEl ? scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight : Infinity;
}

export function isNearBottom(scrollEl, threshold = 96) {
  return distanceFromBottom(scrollEl) <= threshold;
}

export function computeNextFollowing({ delta = 0, atEnd, following }) {
  if (delta < -2) return false;
  if (atEnd) return true;
  return following;
}

export function shouldAutoScroll({ following, busy = false }) {
  return Boolean(following) && !busy;
}

export const COMPOSER_PLACEHOLDERS = {
  chat: '输入 / 使用技能，或直接提问、查网页、读资料…',
  agent: '输入 / 使用技能，也可以让我修改项目、下载文件、执行命令…',
  image: '输入 / 使用技能，或描述你脑海中的画面：细节、风格、光线…',
};

export const RIGHT_PANEL_WIDTH_KEY = 'harness.panelWidth.v1';
export const MIN_RIGHT_PANEL_WIDTH = 300;
export const MAX_RIGHT_PANEL_WIDTH = 1200;
export const MIN_MAIN_CHAT_WIDTH = 540;
export const STOP_ABORT_TIMEOUT_MS = 10_000;

export const WORKBENCH_MODES = [
  {
    id: 'chat',
    label: '聊天',
    Icon: MessageSquare,
    placeholder: COMPOSER_PLACEHOLDERS.chat,
    description: '提问、搜索网页和读取资料，使用只读工具。输入 / 即可使用技能。',
  },
  {
    id: 'agent',
    label: '编程',
    Icon: CodeXml,
    placeholder: COMPOSER_PLACEHOLDERS.agent,
    description: '查看和修改项目、下载文件、执行命令，完成编程任务。输入 / 即可使用技能。',
  },
  {
    id: 'image',
    label: '生图',
    Icon: ImagePlus,
    placeholder: COMPOSER_PLACEHOLDERS.image,
    description: '使用此连接独立配置的生图模型生成图片。输入 / 即可使用技能。',
  },
];

export const WELCOME_SUGGESTIONS = [
  {
    mode: 'chat',
    Icon: Sparkles,
    label: '把想法理清楚',
    description: '问问题、查网页、读资料',
    prompt: '帮我梳理一个新项目的思路。先问我几个关键问题，再一起制定计划。',
  },
  {
    mode: 'agent',
    Icon: CodeXml,
    label: '一起写点代码',
    description: '改文件、下载资料、执行命令',
    prompt: '先查看当前工作目录，再简要介绍这个项目的结构和可以改进的地方。',
  },
  {
    mode: 'image',
    Icon: ImagePlus,
    label: '让画面发生',
    description: '把文字变成一张真实图片',
    prompt: '一盏暖光台灯，雨夜窗边的安静书桌，桌上放着一本翻开的书，电影感摄影，温暖而宁静。',
  },
];

export function readSavedActiveSessionId() {
  try {
    return localStorage.getItem('harness.activeSession') || null;
  } catch {
    return null;
  }
}

export function normalizeSessionRecord(session) {
  return { ...session, messages: session.messages || [] };
}

export function getSessionTitle(session) {
  return session.title?.trim() || '新对话';
}

export function makeOptimisticId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function computeDefaultRightPanelWidth() {
  return Math.round(Math.max(360, Math.min(window.innerWidth * 0.34, 600)));
}

export function readSavedRightPanelWidth() {
  try {
    const saved = Number(localStorage.getItem(RIGHT_PANEL_WIDTH_KEY));
    if (
      Number.isFinite(saved) &&
      saved >= MIN_RIGHT_PANEL_WIDTH &&
      saved <= MAX_RIGHT_PANEL_WIDTH
    ) {
      return Math.round(saved);
    }
  } catch {
    // Ignore storage read failures.
  }
  return computeDefaultRightPanelWidth();
}
