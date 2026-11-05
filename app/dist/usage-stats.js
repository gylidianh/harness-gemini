// 1.4.6: "用量统计" — local token & conversation usage dashboard in Settings.
//
// Adapts ZCode's App Usage settings panel and view models:
// - packages/ui/src/settings/usage-stats/AppUsagePanel.tsx
// - packages/ui/src/settings/usage-stats/UsageHeatmap.tsx
// - packages/ui/src/settings/usage-stats/UsageHeatmapCells.tsx
// - packages/ui/src/settings/usage-stats/AppUsageDailyModelTrendChart.tsx
// - packages/ui/src/settings/usage-stats/AppUsageModelUsagePieChart.tsx
// - packages/ui/src/settings/usage-stats/appUsageModelPieChartViewModel.ts
// - packages/ui/src/settings/usage-stats/appUsageChartPalette.ts
// - packages/ui/src/settings/usage-stats/usageStatsUiParts.tsx
// - packages/ui/src/lib/tokenNumberFormat.ts
// Copyright 2026 Z.AI Co., Ltd, Apache License 2.0; see THIRD-PARTY-NOTICES.md.

const LOCALE = 'zh-CN';
const HEATMAP_DISPLAY_WEEK_COUNT = 52;
const HEATMAP_DAYS_PER_WEEK = 7;
const HEATMAP_VISIBLE_MONTH_LABEL_COUNT = 12;
const DAY_MS = 86_400_000;
const TOKEN_ACTIVITY_MODES = ['daily', 'weekly', 'cumulative'];
const RANGE_OPTIONS = ['7d', '30d'];
const MAX_MODEL_PIE_SLICES = 6;

export const APP_USAGE_MODEL_CHART_COLORS = [
  'var(--hgus-chart-1)',
  'var(--hgus-chart-2)',
  'var(--hgus-chart-3)',
  'var(--hgus-chart-4)',
  'var(--hgus-chart-5)',
  'var(--hgus-chart-6)',
];

export function getAppUsageModelChartColor(index) {
  return APP_USAGE_MODEL_CHART_COLORS[index % APP_USAGE_MODEL_CHART_COLORS.length] || APP_USAGE_MODEL_CHART_COLORS[0];
}

export function formatCompactTokenNumber(locale, value, options = {}) {
  if (!Number.isFinite(value)) return '';
  const maximumFractionDigits = options.maximumFractionDigits ?? 1;
  const absValue = Math.abs(value);
  return new Intl.NumberFormat(locale || undefined, {
    notation: absValue >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

export function formatCompactNumber(locale, value) {
  if (!Number.isFinite(value)) return '--';
  return new Intl.NumberFormat(locale, {
    notation: value >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);
}

export function formatCompactTokenUsage(locale, value) {
  if (!Number.isFinite(value)) return '--';
  return formatCompactTokenNumber(locale, value);
}

export function formatSummaryCompactTokenUsage(locale, value) {
  const formatted = formatCompactTokenUsage(locale, value);
  return String(locale || '').startsWith('zh')
    ? formatted.replace(/(?<=\d)(?=[万亿])/u, ' ')
    : formatted;
}

export function formatPercent(locale, value) {
  if (!Number.isFinite(value)) return '0%';
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: value >= 0.1 ? 0 : 1,
  }).format(value);
}

export function formatDay(locale, dateKey) {
  if (!dateKey) return '--';
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return dateKey;
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export function formatFullDay(locale, dateKey) {
  if (!dateKey) return '--';
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return dateKey;
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

export function formatMonth(locale, dateKey) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return String(dateKey || '').slice(5, 7);
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'short',
  }).format(date);
}

export function formatAppUsageDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0 分钟';
  if (durationMs < 60_000) {
    return `${Math.max(1, Math.round(durationMs / 1000))} 秒`;
  }
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} 分钟`);
  return parts.join(' ');
}

function resolveModelLabel(modelId) {
  return (typeof modelId === 'string' && modelId.trim()) ? modelId.trim() : '未知模型';
}

// ── Heatmap view-model (adapted from ZCode UsageHeatmap.tsx) ──────────────

function dateKeyToUtcDayIndex(dateKey) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / DAY_MS);
}

function getUtcWeekday(dayIndex) {
  return new Date(dayIndex * DAY_MS).getUTCDay();
}

function utcDayIndexToDateKey(dayIndex) {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

function createEmptyHeatmapCell(date) {
  return { date, level: 0, totalTokens: 0, turnCount: 0, toolCallCount: 0 };
}

export function buildDisplayHeatmapWeeks(weeks = []) {
  const cells = weeks.flatMap(week => week?.days || []).filter(Boolean);
  const datedCells = cells
    .map(cell => ({ cell, dayIndex: dateKeyToUtcDayIndex(cell.date) }))
    .filter(entry => entry.dayIndex !== null);

  const todayDayIndex = Math.floor(Date.now() / DAY_MS);
  const endDayIndex = datedCells.length
    ? Math.max(...datedCells.map(entry => entry.dayIndex))
    : todayDayIndex;
  const cellsByDate = new Map(datedCells.map(({ cell }) => [cell.date, cell]));
  const endWeekStartDayIndex = endDayIndex - getUtcWeekday(endDayIndex);
  const startDayIndex = endWeekStartDayIndex - (HEATMAP_DISPLAY_WEEK_COUNT - 1) * HEATMAP_DAYS_PER_WEEK;

  return Array.from({ length: HEATMAP_DISPLAY_WEEK_COUNT }, (_, weekIndex) => ({
    weekIndex,
    days: Array.from({ length: HEATMAP_DAYS_PER_WEEK }, (_, dayOffset) => {
      const dayIndex = startDayIndex + weekIndex * HEATMAP_DAYS_PER_WEEK + dayOffset;
      const date = utcDayIndexToDateKey(dayIndex);
      return cellsByDate.get(date) ?? createEmptyHeatmapCell(date);
    }),
  }));
}

function levelForValue(value, max) {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
}

function filledRowsForValue(value, max) {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(HEATMAP_DAYS_PER_WEEK, Math.max(1, Math.ceil((value / max) * HEATMAP_DAYS_PER_WEEK)));
}

function resolveHeatmapColumnMonthDate(week) {
  const firstDayOfMonth = week.days.find(cell => cell?.date?.endsWith('-01'));
  return firstDayOfMonth?.date ?? week.days[0]?.date ?? week.days.find(Boolean)?.date ?? '';
}

function dailyCellTooltip(locale, cell) {
  return `${formatFullDay(locale, cell.date)}\n${formatCompactTokenUsage(locale, cell.totalTokens)} tokens · ${formatCompactNumber(locale, cell.turnCount)} 轮消息`;
}

function weeklyColumnTooltip(locale, date, totalTokens, turns) {
  return `${formatFullDay(locale, date)} 当周\n${formatCompactTokenUsage(locale, totalTokens)} tokens · ${formatCompactNumber(locale, turns)} 轮消息`;
}

function cumulativeColumnTooltip(locale, date, totalTokens, turns) {
  return `截至 ${formatFullDay(locale, date)} 当周累计\n${formatCompactTokenUsage(locale, totalTokens)} tokens · ${formatCompactNumber(locale, turns)} 轮消息`;
}

function buildHeatmapDisplayColumns(locale, weeks, mode) {
  if (mode === 'daily') {
    return weeks.map(week => ({
      key: `daily-${week.weekIndex}`,
      monthDate: resolveHeatmapColumnMonthDate(week),
      tooltipTitle: null,
      cells: week.days.map((cell, dayOffset) => {
        const displayCell = cell ?? createEmptyHeatmapCell(`empty-${week.weekIndex}-${dayOffset}`);
        return {
          key: `daily-${displayCell.date}`,
          level: displayCell.level,
          hasUsage: displayCell.totalTokens > 0,
          columnHover: false,
          tooltipTitle: dailyCellTooltip(locale, displayCell),
        };
      }),
    }));
  }

  const weeklyTotals = weeks.map(week => week.days.reduce((sum, cell) => sum + (cell?.totalTokens ?? 0), 0));
  const weeklyCounts = weeks.map(week => week.days.reduce((sum, cell) => sum + (cell?.turnCount ?? 0), 0));
  const values = mode === 'weekly'
    ? weeklyTotals
    : weeklyTotals.reduce((acc, total) => { acc.push((acc.at(-1) ?? 0) + total); return acc; }, []);
  const countValues = mode === 'weekly'
    ? weeklyCounts
    : weeklyCounts.reduce((acc, total) => { acc.push((acc.at(-1) ?? 0) + total); return acc; }, []);
  const maxValue = Math.max(0, ...values);

  return weeks.map((week, weekIndex) => {
    const value = values[weekIndex] ?? 0;
    const count = countValues[weekIndex] ?? 0;
    const level = levelForValue(value, maxValue);
    const filledRows = filledRowsForValue(value, maxValue);
    const weekEndDate = week.days[HEATMAP_DAYS_PER_WEEK - 1]?.date ?? week.days.findLast(Boolean)?.date ?? '';
    const tooltipTitle = mode === 'weekly'
      ? weeklyColumnTooltip(locale, weekEndDate, value, count)
      : cumulativeColumnTooltip(locale, weekEndDate, value, count);
    return {
      key: `${mode}-${week.weekIndex}`,
      monthDate: resolveHeatmapColumnMonthDate(week) || weekEndDate,
      tooltipTitle,
      cells: week.days.map((cell, dayOffset) => {
        const isFilled = dayOffset >= HEATMAP_DAYS_PER_WEEK - filledRows;
        return {
          key: `${mode}-${cell?.date ?? `${week.weekIndex}-${dayOffset}`}`,
          level: isFilled ? level : 0,
          hasUsage: isFilled && value > 0,
          columnHover: true,
          tooltipTitle,
        };
      }),
    };
  });
}

function buildHeatmapMonthLabels(locale, columns) {
  const labels = [];
  for (const column of columns) {
    const monthKey = column.monthDate.slice(0, 7);
    const lastLabel = labels.at(-1);
    if (lastLabel?.key === monthKey) {
      lastLabel.span += 1;
    } else {
      labels.push({
        key: monthKey,
        label: formatMonth(locale, column.monthDate),
        span: 1,
      });
    }
  }
  const hiddenLabelCount = Math.max(0, labels.length - HEATMAP_VISIBLE_MONTH_LABEL_COUNT);
  for (let index = 0; index < hiddenLabelCount; index += 1) {
    if (labels[index]) labels[index].label = '';
  }
  return labels;
}

// ── Trend & Pie view-models (adapted from ZCode) ──────────────────────────

function shouldShowDailyChartAxisLabel(index, total) {
  if (total <= 14) return true;
  const step = total > 45 ? 7 : 5;
  return index === 0 || index === total - 1 || index % step === 0;
}

export function buildAppUsageDailyModelChartViewModel(snapshot, locale = LOCALE) {
  const topModels = (snapshot?.models || []).slice(0, 6);
  const modelKeys = topModels.map((model, index) => ({
    modelId: model.modelId,
    key: `model${index}`,
    color: getAppUsageModelChartColor(index),
    label: resolveModelLabel(model.modelId),
  }));
  const modelKeyById = new Map(modelKeys.map(m => [m.modelId ?? '__unknown__', m.key]));

  const rows = new Map();
  for (const day of snapshot?.dailyModelUsage || []) {
    const label = formatDay(locale, day.date);
    const fullLabel = formatFullDay(locale, day.date);
    const row = rows.get(day.date) || (() => {
      const r = { date: day.date, label, tooltipLabel: fullLabel, total: 0 };
      for (const m of modelKeys) r[m.key] = 0;
      return r;
    })();
    for (const model of day.models || []) {
      const key = modelKeyById.get(model.modelId ?? '__unknown__');
      if (key) row[key] = Number(row[key] ?? 0) + model.totalTokens;
      row.total += model.totalTokens;
    }
    rows.set(day.date, row);
  }

  const chartData = [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => row);

  let maxTokens = 0;
  for (const row of chartData) {
    for (const model of modelKeys) {
      maxTokens = Math.max(maxTokens, Number(row[model.key] ?? 0));
    }
  }
  return { topModels, modelKeys, chartData, maxTokens };
}

export function buildAppUsageModelPieChartViewModel(snapshot) {
  const positiveModels = (snapshot?.models || []).filter(model => model.totalTokens > 0);
  const totalModelTokens = positiveModels.reduce((sum, model) => sum + model.totalTokens, 0);
  const shouldMergeOther = positiveModels.length > MAX_MODEL_PIE_SLICES;
  const modelSliceLimit = shouldMergeOther ? MAX_MODEL_PIE_SLICES - 1 : MAX_MODEL_PIE_SLICES;
  const modelSlices = positiveModels.slice(0, modelSliceLimit).map((model, index) => ({
    key: `model${index}`,
    label: resolveModelLabel(model.modelId),
    color: getAppUsageModelChartColor(index),
    totalTokens: model.totalTokens,
    inputTokens: model.inputTokens ?? 0,
    outputTokens: model.outputTokens ?? 0,
    requestCount: model.requestCount ?? 0,
    share: totalModelTokens > 0 ? model.totalTokens / totalModelTokens : 0,
  }));
  const otherModels = shouldMergeOther ? positiveModels.slice(modelSliceLimit) : [];
  const otherTotalTokens = otherModels.reduce((sum, model) => sum + model.totalTokens, 0);
  const otherSlice = otherTotalTokens > 0
    ? [{
        key: `model${modelSliceLimit}`,
        label: '其他模型',
        color: getAppUsageModelChartColor(modelSliceLimit),
        totalTokens: otherTotalTokens,
        inputTokens: otherModels.reduce((s, m) => s + (m.inputTokens ?? 0), 0),
        outputTokens: otherModels.reduce((s, m) => s + (m.outputTokens ?? 0), 0),
        requestCount: otherModels.reduce((s, m) => s + (m.requestCount ?? 0), 0),
        share: totalModelTokens > 0 ? otherTotalTokens / totalModelTokens : 0,
      }]
    : [];
  return {
    chartData: [...modelSlices, ...otherSlice],
    totalModelTokens,
  };
}

// ── SVG geometry helpers for smooth line & donut charts ───────────────────

function buildMonotonePath(points) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const dx = (p1.x - p0.x) / 2;
    d += ` C ${(p0.x + dx).toFixed(2)} ${p0.y.toFixed(2)}, ${(p1.x - dx).toFixed(2)} ${p1.y.toFixed(2)}, ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
  }
  return d;
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeDonutSector(cx, cy, outerR, innerR, startAngle, endAngle) {
  const span = Math.min(359.99, Math.max(0.01, endAngle - startAngle));
  const actualEnd = startAngle + span;
  const largeArc = span > 180 ? 1 : 0;
  const outerStart = polarToCartesian(cx, cy, outerR, startAngle);
  const outerEnd = polarToCartesian(cx, cy, outerR, actualEnd);
  const innerEnd = polarToCartesian(cx, cy, innerR, actualEnd);
  const innerStart = polarToCartesian(cx, cy, innerR, startAngle);
  return [
    `M ${outerStart.x.toFixed(2)} ${outerStart.y.toFixed(2)}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${outerEnd.x.toFixed(2)} ${outerEnd.y.toFixed(2)}`,
    `L ${innerEnd.x.toFixed(2)} ${innerEnd.y.toFixed(2)}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${innerStart.x.toFixed(2)} ${innerStart.y.toFixed(2)}`,
    'Z',
  ].join(' ');
}

async function fetchUsageSnapshot(range) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const url = `/api/usage/stats?range=${encodeURIComponent(range)}&timeZone=${encodeURIComponent(tz)}`;
  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new Error('无法读取用量统计，请稍后重试。');
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    throw new Error((body && (body.error || body.message)) || `读取用量统计失败（${response.status}）`);
  }
  return body;
}

export function createUsageStatsUI(React) {
  const h = React.createElement;

  function RefreshIcon() {
    return h('svg', {
      width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
    },
      h('path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }),
      h('path', { d: 'M21 3v5h-5' }),
      h('path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }),
      h('path', { d: 'M8 16H3v5' }),
    );
  }

  function UsageEmptyState({ title = '还没有可展示的数据', description = '当前区间暂无可展示的用量数据。' }) {
    return h('div', { className: 'hgus-empty' },
      h('div', { className: 'hgus-empty-title' }, title),
      h('div', { className: 'hgus-empty-desc' }, description),
    );
  }

  function SegmentedTabs({ value, options, onChange, ariaLabel }) {
    return h('div', { className: 'hgus-tabs', role: 'tablist', 'aria-label': ariaLabel },
      options.map(opt => h('button', {
        key: opt.value,
        type: 'button',
        role: 'tab',
        'aria-selected': value === opt.value,
        className: `hgus-tab${value === opt.value ? ' active' : ''}`,
        onClick: () => onChange(opt.value),
      }, opt.label)),
    );
  }

  function LifetimeSummaryStrip({ snapshot }) {
    const summary = snapshot?.summary;
    const items = [
      {
        label: '累计 Token 数',
        value: summary ? formatSummaryCompactTokenUsage(LOCALE, summary.totalTokens) : '--',
      },
      {
        label: '峰值 Token 数',
        value: summary ? formatSummaryCompactTokenUsage(LOCALE, summary.peakDayTokens) : '--',
      },
      {
        label: '最长聊天时长',
        value: summary ? formatAppUsageDuration(summary.longestSessionMs) : '--',
      },
      {
        label: '当前连续天数',
        value: summary ? `${formatCompactNumber(LOCALE, summary.currentStreakDays)} 天` : '--',
      },
      {
        label: '最长连续天数',
        value: summary ? `${formatCompactNumber(LOCALE, summary.longestStreakDays)} 天` : '--',
      },
    ];
    return h('section', { className: 'hgus-lifetime-strip', 'aria-label': '全部时间汇总' },
      items.map((item, index) => h(React.Fragment, { key: item.label },
        index > 0 && h('div', { className: 'hgus-lifetime-divider', 'aria-hidden': 'true' }),
        h('div', { className: 'hgus-lifetime-item' },
          h('div', { className: 'hgus-lifetime-value', title: String(item.value) }, item.value),
          h('div', { className: 'hgus-lifetime-label' }, item.label),
        ),
      )),
    );
  }

  function UsageHeatmap({ weeks }) {
    const [mode, setMode] = React.useState('daily');
    const [hoverTip, setHoverTip] = React.useState(null);
    const displayWeeks = React.useMemo(() => buildDisplayHeatmapWeeks(weeks), [weeks]);
    const displayColumns = React.useMemo(
      () => buildHeatmapDisplayColumns(LOCALE, displayWeeks, mode),
      [displayWeeks, mode],
    );
    const monthLabels = React.useMemo(
      () => buildHeatmapMonthLabels(LOCALE, displayColumns),
      [displayColumns],
    );
    const modeOptions = [
      { value: 'daily', label: '每日' },
      { value: 'weekly', label: '每周' },
      { value: 'cumulative', label: '累计' },
    ];

    return h('section', { className: 'hgus-card hgus-heatmap-card', 'aria-label': 'Token 活动' },
      h('div', { className: 'hgus-card-header' },
        h('h3', { className: 'hgus-card-title' }, 'Token 活动'),
        h('div', { className: 'hgus-heatmap-controls' },
          hoverTip && h('span', { className: 'hgus-heatmap-hover-readout', role: 'status' }, hoverTip.replace('\n', ' · ')),
          h(SegmentedTabs, {
            value: mode,
            options: modeOptions,
            onChange: setMode,
            ariaLabel: 'Token 活动展示方式',
          }),
        ),
      ),
      h('div', {
        className: 'hgus-heatmap-grid',
        onMouseLeave: () => setHoverTip(null),
      },
        displayColumns.map(column => h('div', {
          key: column.key,
          className: `hgus-heatmap-col${mode !== 'daily' ? ' is-column-mode' : ''}`,
          title: column.tooltipTitle || undefined,
          onMouseEnter: column.tooltipTitle ? () => setHoverTip(column.tooltipTitle) : undefined,
        },
          column.cells.map(cell => h('div', {
            key: cell.key,
            className: `hgus-heatmap-cell level-${cell.level}${cell.hasUsage ? ' has-usage' : ''}`,
            title: cell.tooltipTitle || undefined,
            onMouseEnter: cell.tooltipTitle ? () => setHoverTip(cell.tooltipTitle) : undefined,
          })),
        )),
      ),
      h('div', { className: 'hgus-heatmap-footer' },
        h('div', { className: 'hgus-heatmap-months' },
          monthLabels.map(label => h('div', {
            key: label.key,
            className: 'hgus-heatmap-month',
            style: { gridColumn: `span ${label.span}` },
          }, label.label)),
        ),
        h('div', { className: 'hgus-heatmap-legend', 'aria-hidden': 'true' },
          h('span', null, '较少'),
          [0, 1, 2, 3, 4].map(lv => h('i', { key: lv, className: `hgus-heatmap-cell level-${lv}` })),
          h('span', null, '较多'),
        ),
      ),
    );
  }

  function RangeDetailStrip({ snapshot }) {
    const s = snapshot?.summary;
    if (!s) return null;
    const uncachedInput = Math.max(0, (s.inputTokens || 0) - (s.cacheReadTokens || 0));
    const reqCount = s.modelRequestCount ?? (snapshot?.models || []).reduce((acc, m) => acc + (m.requestCount || 0), 0);
    const estCount = s.estimatedRequestCount ?? 0;
    const cards = [
      {
        label: '输入 Token',
        value: formatSummaryCompactTokenUsage(LOCALE, s.inputTokens || 0),
        sub: `未缓存 ${formatCompactTokenUsage(LOCALE, uncachedInput)} · 缓存读取 ${formatCompactTokenUsage(LOCALE, s.cacheReadTokens || 0)}`,
      },
      {
        label: '输出 Token',
        value: formatSummaryCompactTokenUsage(LOCALE, s.outputTokens || 0),
        sub: `思考推理 ${formatCompactTokenUsage(LOCALE, s.reasoningTokens || 0)}`,
      },
      {
        label: 'Cache 命中率',
        value: formatPercent(LOCALE, s.cacheHitRate || 0),
        sub: `活跃 ${formatCompactNumber(LOCALE, s.activeDays || 0)} 天 · ${formatCompactNumber(LOCALE, s.totalSessions || 0)} 个会话`,
      },
      {
        label: '请求与轮次',
        value: `${formatCompactNumber(LOCALE, reqCount)} 次`,
        sub: `${formatCompactNumber(LOCALE, s.totalTurns || 0)} 轮消息 · ${formatCompactNumber(LOCALE, s.toolCallCount || 0)} 次工具${estCount > 0 ? ` · 含估算 ${estCount} 次` : ''}`,
      },
    ];
    return h('section', { className: 'hgus-detail-grid', 'aria-label': '区间用量明细' },
      cards.map(card => h('div', { key: card.label, className: 'hgus-detail-card' },
        h('div', { className: 'hgus-detail-label' }, card.label),
        h('div', { className: 'hgus-detail-value' }, card.value),
        h('div', { className: 'hgus-detail-sub', title: card.sub }, card.sub),
      )),
    );
  }

  function DailyModelTrendChart({ snapshot }) {
    const [hoverIndex, setHoverIndex] = React.useState(null);
    const { topModels, modelKeys, chartData, maxTokens } = React.useMemo(
      () => buildAppUsageDailyModelChartViewModel(snapshot, LOCALE),
      [snapshot],
    );

    if (maxTokens <= 0 || !chartData.length) {
      return h('section', { className: 'hgus-card', 'aria-label': '每日 Token 趋势图' },
        h('h3', { className: 'hgus-card-title' }, '每日 Token 趋势图'),
        h(UsageEmptyState, null),
      );
    }

    const width = 720;
    const height = 228;
    const padLeft = 28;
    const padRight = 28;
    const padTop = 14;
    const padBottom = 32;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;
    const count = chartData.length;
    const xAt = idx => count <= 1 ? padLeft + plotW / 2 : padLeft + (idx / (count - 1)) * plotW;
    const yAt = val => padTop + plotH - Math.min(1, Math.max(0, val / maxTokens)) * plotH;

    const gridLevels = [0, 0.25, 0.5, 0.75, 1];
    const activeIdx = hoverIndex !== null && hoverIndex >= 0 && hoverIndex < count ? hoverIndex : null;
    const activeRow = activeIdx !== null ? chartData[activeIdx] : null;
    const activeModels = activeRow
      ? modelKeys
          .map(m => ({ ...m, value: Number(activeRow[m.key] ?? 0) }))
          .filter(m => m.value > 0)
      : [];

    return h('section', { className: 'hgus-card', 'aria-label': '每日 Token 趋势图' },
      h('h3', { className: 'hgus-card-title' }, '每日 Token 趋势图'),
      h('div', { className: 'hgus-trend-body' },
        h('div', { className: 'hgus-legend', role: 'list' },
          topModels.map((model, index) => h('div', {
            key: model.modelId ?? '__unknown__',
            className: 'hgus-legend-item',
            role: 'listitem',
          },
            h('span', { className: 'hgus-swatch', style: { backgroundColor: getAppUsageModelChartColor(index) } }),
            h('span', { className: 'hgus-legend-label', title: resolveModelLabel(model.modelId) }, resolveModelLabel(model.modelId)),
          )),
        ),
        h('div', {
          className: 'hgus-chart-stage',
          onMouseLeave: () => setHoverIndex(null),
        },
          h('svg', {
            viewBox: `0 0 ${width} ${height}`,
            className: 'hgus-trend-svg',
            role: 'img',
            'aria-label': '每日模型 Token 用量折线图',
          },
            gridLevels.map(level => {
              const y = padTop + plotH * (1 - level);
              return h('line', {
                key: level,
                x1: padLeft,
                y1: y,
                x2: width - padRight,
                y2: y,
                className: 'hgus-grid-line',
                strokeDasharray: '3 3',
              });
            }),
            activeIdx !== null && h('line', {
              x1: xAt(activeIdx),
              y1: padTop,
              x2: xAt(activeIdx),
              y2: padTop + plotH,
              className: 'hgus-hover-line',
            }),
            modelKeys.map(model => {
              const pts = chartData.map((row, idx) => ({
                x: xAt(idx),
                y: yAt(Number(row[model.key] ?? 0)),
                val: Number(row[model.key] ?? 0),
              }));
              return h('g', { key: model.key },
                h('path', {
                  d: buildMonotonePath(pts),
                  fill: 'none',
                  stroke: model.color,
                  strokeWidth: 2.2,
                  strokeLinecap: 'round',
                }),
                activeIdx !== null && pts[activeIdx] && pts[activeIdx].val > 0 && h('circle', {
                  cx: pts[activeIdx].x,
                  cy: pts[activeIdx].y,
                  r: 4.2,
                  fill: model.color,
                  stroke: 'var(--surface)',
                  strokeWidth: 1.8,
                }),
              );
            }),
            chartData.map((row, idx) => shouldShowDailyChartAxisLabel(idx, count) && h('text', {
              key: row.date,
              x: xAt(idx),
              y: height - 8,
              textAnchor: 'middle',
              className: 'hgus-axis-label',
            }, row.label)),
            chartData.map((row, idx) => {
              const slotW = count <= 1 ? plotW : plotW / (count - 1);
              const x = count <= 1 ? padLeft : Math.max(padLeft, xAt(idx) - slotW / 2);
              return h('rect', {
                key: `hit-${row.date}`,
                x,
                y: padTop,
                width: count <= 1 ? plotW : slotW,
                height: plotH + padBottom,
                fill: 'transparent',
                onMouseEnter: () => setHoverIndex(idx),
              });
            }),
          ),
          activeRow && activeModels.length > 0 && h('div', {
            className: `hgus-chart-tooltip${activeIdx > count * 0.6 ? ' align-left' : ''}`,
          },
            h('div', { className: 'hgus-tooltip-title' },
              `${activeRow.tooltipLabel} - ${formatCompactTokenUsage(LOCALE, activeRow.total)} tokens`,
            ),
            activeModels.map(item => h('div', { key: item.key, className: 'hgus-tooltip-row' },
              h('span', { className: 'hgus-tooltip-dot', style: { backgroundColor: item.color } }),
              h('span', { className: 'hgus-tooltip-name' }, item.label),
              h('span', { className: 'hgus-tooltip-val' }, `${formatCompactTokenUsage(LOCALE, item.value)} tokens`),
            )),
          ),
        ),
      ),
    );
  }

  function ModelUsagePieChart({ snapshot }) {
    const [hoverSliceKey, setHoverSliceKey] = React.useState(null);
    const { chartData, totalModelTokens } = React.useMemo(
      () => buildAppUsageModelPieChartViewModel(snapshot),
      [snapshot],
    );

    if (totalModelTokens <= 0 || !chartData.length) {
      return h('section', { className: 'hgus-card', 'aria-label': '模型用量' },
        h('h3', { className: 'hgus-card-title' }, '模型用量'),
        h(UsageEmptyState, null),
      );
    }

    const size = 220;
    const cx = size / 2;
    const cy = size / 2;
    const outerR = 92;
    const innerR = 60;
    const padAngle = chartData.length > 1 ? 2 : 0;
    let cursor = 0;
    const arcs = chartData.map(slice => {
      const sweep = Math.max(2, slice.share * 360);
      const start = cursor + padAngle / 2;
      const end = cursor + sweep - padAngle / 2;
      cursor += sweep;
      return {
        ...slice,
        path: describeDonutSector(cx, cy, outerR, innerR, start, Math.max(start + 0.5, end)),
      };
    });
    const activeSlice = arcs.find(s => s.key === hoverSliceKey) || null;

    return h('section', { className: 'hgus-card', 'aria-label': '模型用量' },
      h('h3', { className: 'hgus-card-title' }, '模型用量'),
      h('div', { className: 'hgus-pie-grid' },
        h('div', {
          className: 'hgus-donut-wrap',
          onMouseLeave: () => setHoverSliceKey(null),
        },
          h('svg', {
            viewBox: `0 0 ${size} ${size}`,
            className: 'hgus-donut-svg',
            role: 'img',
            'aria-label': '各模型 Token 占比环形图',
          },
            arcs.map(arc => h('path', {
              key: arc.key,
              d: arc.path,
              fill: arc.color,
              stroke: 'var(--surface)',
              strokeWidth: 2,
              className: `hgus-donut-slice${hoverSliceKey === arc.key ? ' is-hovered' : ''}`,
              onMouseEnter: () => setHoverSliceKey(arc.key),
            })),
          ),
          h('div', { className: 'hgus-donut-center' },
            h('div', { className: 'hgus-donut-total' },
              formatCompactTokenUsage(LOCALE, activeSlice ? activeSlice.totalTokens : totalModelTokens),
            ),
            h('div', { className: 'hgus-donut-unit' },
              activeSlice ? `${activeSlice.label} · ${formatPercent(LOCALE, activeSlice.share)}` : 'tokens',
            ),
          ),
        ),
        h('div', { className: 'hgus-model-list', role: 'list' },
          chartData.map(slice => h('div', {
            key: slice.key,
            className: `hgus-model-row${hoverSliceKey === slice.key ? ' is-hovered' : ''}`,
            role: 'listitem',
            onMouseEnter: () => setHoverSliceKey(slice.key),
            onMouseLeave: () => setHoverSliceKey(null),
          },
            h('span', { className: 'hgus-swatch', style: { backgroundColor: slice.color } }),
            h('span', { className: 'hgus-model-name', title: slice.label }, slice.label),
            h('span', { className: 'hgus-model-share' }, formatPercent(LOCALE, slice.share)),
            h('span', { className: 'hgus-model-tokens' },
              `${formatCompactTokenUsage(LOCALE, slice.totalTokens)} tokens`,
              slice.requestCount > 0 ? ` · 输入 ${formatCompactTokenUsage(LOCALE, slice.inputTokens)} / 输出 ${formatCompactTokenUsage(LOCALE, slice.outputTokens)} · ${formatCompactNumber(LOCALE, slice.requestCount)} 次` : '',
            ),
          )),
        ),
      ),
    );
  }

  function UsageStatsSettings() {
    const [range, setRange] = React.useState('7d');
    const [lifetime, setLifetime] = React.useState(null);
    const [state, setState] = React.useState({ snapshot: null, loading: true, error: '' });
    const reqVersion = React.useRef(0);

    const loadAll = React.useCallback(async (targetRange = range) => {
      const v = ++reqVersion.current;
      setState(curr => ({ ...curr, loading: true, error: '' }));
      try {
        const [rangeSnap, allSnap] = await Promise.all([
          fetchUsageSnapshot(targetRange),
          fetchUsageSnapshot('all'),
        ]);
        if (reqVersion.current !== v) return;
        setLifetime(allSnap);
        setState({ snapshot: rangeSnap, loading: false, error: '' });
      } catch (error) {
        if (reqVersion.current !== v) return;
        setState(curr => ({
          snapshot: curr.snapshot,
          loading: false,
          error: error?.message || '无法读取用量统计。',
        }));
      }
    }, [range]);

    React.useEffect(() => {
      void loadAll(range);
    }, [range, loadAll]);

    const rangeOptions = RANGE_OPTIONS.map(opt => ({
      value: opt,
      label: opt === '7d' ? '近 7 日' : '近 30 日',
    }));

    return h('div', { className: 'hgus-panel' },
      h(LifetimeSummaryStrip, { snapshot: lifetime }),
      lifetime?.heatmap?.weeks?.length
        ? h(UsageHeatmap, { weeks: lifetime.heatmap.weeks })
        : null,
      h('div', { className: 'hgus-range-bar' },
        h('div', { className: 'hgus-range-title' }, '时间范围'),
        h(SegmentedTabs, {
          value: range,
          options: rangeOptions,
          onChange: setRange,
          ariaLabel: '选择统计时间范围',
        }),
      ),
      state.error && h('div', { className: 'hgus-error', role: 'alert' }, state.error),
      state.loading && !state.snapshot
        ? h(UsageEmptyState, {
            title: '正在统计中',
            description: '正在读取本地应用会话历史，可能需要一点时间。',
          })
        : !state.snapshot
          ? h(UsageEmptyState, null)
          : h(React.Fragment, null,
              h(RangeDetailStrip, { snapshot: state.snapshot }),
              h(DailyModelTrendChart, { snapshot: state.snapshot }),
              h(ModelUsagePieChart, { snapshot: state.snapshot }),
            ),
      h('div', { className: 'hgus-footer-actions' },
        h('button', {
          type: 'button',
          className: 'button button-quiet small-button hgus-refresh-btn',
          disabled: state.loading,
          onClick: () => { void loadAll(range); },
        },
          h(RefreshIcon, null),
          state.loading ? '刷新中' : '刷新',
        ),
      ),
    );
  }

  return { UsageStatsSettings };
}
