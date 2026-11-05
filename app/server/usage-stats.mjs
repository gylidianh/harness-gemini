// 1.4.6: Local token & turn usage observability and aggregation.
//
// Adapts ZCode's App Usage data model and snapshot builder:
// - apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts
// - apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts
// - packages/shared/src/usage-stats.ts
// Copyright 2026 Z.AI Co., Ltd, Apache License 2.0; see THIRD-PARTY-NOTICES.md.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { estimateOutputTokens } from './metrics.mjs';
import {
  estimateMessagesTokens,
  estimateTextTokens,
  usageOutputTokens,
  usagePromptTokens,
  usageTotalTokens,
} from './context.mjs';
import { HttpError, isObject } from './util.mjs';

export const APP_USAGE_RANGES = Object.freeze(['all', '7d', '30d']);
const APP_USAGE_RANGE_DAYS = Object.freeze({ '7d': 7, '30d': 30 });
const DAY_MS = 86_400_000;

function nonNegativeInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function nullableInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

/**
 * Computes the offset (in ms) of `timeZone` relative to UTC at `atMs` using Intl.
 * Mirrors ZCode's `resolveTzOffsetMs` in `usage-stats-builder.ts`.
 */
export function resolveTzOffsetMs(timeZone, atMs = Date.now()) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(atMs));
    const lookup = type => Number(parts.find(part => part.type === type)?.value);
    const asUtc = Date.UTC(
      lookup('year'),
      lookup('month') - 1,
      lookup('day'),
      lookup('hour'),
      lookup('minute'),
      lookup('second'),
    );
    const offset = asUtc - Math.trunc(atMs / 1000) * 1000;
    return Number.isFinite(offset) ? offset : 0;
  } catch {
    return 0;
  }
}

function dayIndexToDate(dayIndex) {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

function levelFor(tokens, max) {
  if (tokens <= 0 || max <= 0) return 0;
  const ratio = tokens / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

function inputSideTokensFromNormalizedUsage(inputTokens, cacheCreationTokens, cacheReadTokens) {
  const input = nonNegativeInt(inputTokens);
  if (input > 0) return input;
  return nonNegativeInt(cacheCreationTokens) + nonNegativeInt(cacheReadTokens);
}

/**
 * Extracts normalized token counts from a provider usage report, falling back to the project's
 * script-aware estimator when a relay omits `usage` (or omits one side of it).
 */
export function normalizeModelUsage({
  usage = null,
  messages = [],
  tools = [],
  text = '',
  reasoning = '',
  toolCalls = [],
  imageRequest = false,
} = {}) {
  const reportedInput = isObject(usage) ? usagePromptTokens(usage) : null;
  const reportedOutput = isObject(usage) ? usageOutputTokens(usage) : null;
  const providerTotal = isObject(usage) ? usageTotalTokens(usage) : null;

  const rawCacheRead = isObject(usage)
    ? (usage.prompt_tokens_details?.cached_tokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? usage.cache_read_input_tokens
      ?? usage.prompt_cache_hit_tokens
      ?? usage.cached_tokens)
    : null;
  const rawCacheCreate = isObject(usage)
    ? (usage.cache_creation_input_tokens
      ?? usage.prompt_tokens_details?.cache_creation_tokens
      ?? usage.input_tokens_details?.cache_creation_tokens)
    : null;
  const rawReasoning = isObject(usage)
    ? (usage.completion_tokens_details?.reasoning_tokens
      ?? usage.output_tokens_details?.reasoning_tokens
      ?? usage.reasoning_tokens)
    : null;

  const cacheReadTokens = nonNegativeInt(rawCacheRead);
  const cacheCreationTokens = nonNegativeInt(rawCacheCreate);

  let inputTokens;
  if (reportedInput !== null) {
    inputTokens = nonNegativeInt(reportedInput);
  } else {
    const msgTokens = Array.isArray(messages) ? estimateMessagesTokens(messages) : 0;
    const toolTokens = Array.isArray(tools) && tools.length ? estimateTextTokens(JSON.stringify(tools)) : 0;
    inputTokens = nonNegativeInt(msgTokens + toolTokens);
  }

  const toolText = Array.isArray(toolCalls) && toolCalls.length
    ? toolCalls.map(call => `${call?.function?.name ?? ''}\n${call?.function?.arguments ?? ''}`).join('\n')
    : '';

  let outputTokens;
  if (reportedOutput !== null && !imageRequest) {
    outputTokens = nonNegativeInt(reportedOutput);
  } else if (reportedOutput !== null && imageRequest) {
    outputTokens = nonNegativeInt(reportedOutput);
  } else if (imageRequest) {
    outputTokens = nonNegativeInt(estimateOutputTokens(text));
  } else {
    outputTokens = nonNegativeInt(estimateOutputTokens(`${reasoning ?? ''}\n${text ?? ''}\n${toolText}`));
  }

  const reasoningTokens = nullableInt(rawReasoning) !== null
    ? nonNegativeInt(rawReasoning)
    : (reasoning && !imageRequest ? nonNegativeInt(estimateOutputTokens(reasoning)) : 0);

  const inputSide = inputSideTokensFromNormalizedUsage(inputTokens, cacheCreationTokens, cacheReadTokens);
  const computedTotalTokens = inputSide + outputTokens;
  const usageSource = reportedInput !== null && reportedOutput !== null ? 'usage' : 'estimated';

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheCreationTokens,
    cacheReadTokens,
    providerTotalTokens: providerTotal,
    computedTotalTokens,
    usageSource,
  };
}

function resolveUsageStartDayIndex(result, opts, endDayIndex) {
  if (opts.range !== 'all') {
    return Math.floor((opts.since + opts.tzOffsetMs) / DAY_MS);
  }
  const dayIndexes = [
    ...result.days.map(day => day.dayIndex),
    ...result.dayModels.map(dayModel => dayModel.dayIndex),
  ];
  if (dayIndexes.length === 0) {
    return endDayIndex;
  }
  return Math.min(...dayIndexes);
}

/**
 * Pure snapshot builder adapted from ZCode's `buildAppUsageSnapshot` in `usage-stats-builder.ts`.
 */
export function buildAppUsageSnapshot(result, opts) {
  const { totals, turnTotals, toolTotals } = result;

  // `inputTokens` is already the total prompt input; cache fields are breakdown.
  const cacheDenom = totals.inputTokens > 0
    ? totals.inputTokens
    : totals.cacheCreationTokens + totals.cacheReadTokens;
  const cacheHitRate = cacheDenom > 0 ? Math.min(1, totals.cacheReadTokens / cacheDenom) : 0;
  const modelErrorRate = totals.modelRequestCount > 0 ? totals.modelErrorCount / totals.modelRequestCount : 0;
  const toolErrorRate = toolTotals.toolCallCount > 0 ? toolTotals.toolErrorCount / toolTotals.toolCallCount : 0;

  const dayTokenMap = new Map();
  for (const d of result.days) {
    dayTokenMap.set(d.dayIndex, {
      totalTokens: d.totalTokens,
      turnCount: d.turnCount,
      toolCallCount: d.toolCallCount,
    });
  }

  const endDayIndex = Math.floor((opts.until + opts.tzOffsetMs) / DAY_MS);
  const startDayIndex = resolveUsageStartDayIndex(result, opts, endDayIndex);

  let activeDays = 0;
  let currentStreakDays = 0;
  let longestStreakDays = 0;
  let runningStreakDays = 0;
  let streakBroken = false;
  for (let di = endDayIndex; di >= startDayIndex; di--) {
    const tokens = dayTokenMap.get(di)?.totalTokens ?? 0;
    if (tokens > 0) {
      activeDays++;
      runningStreakDays++;
      longestStreakDays = Math.max(longestStreakDays, runningStreakDays);
      if (!streakBroken) currentStreakDays++;
    } else if (!streakBroken) {
      streakBroken = true;
      runningStreakDays = 0;
    } else {
      runningStreakDays = 0;
    }
  }

  const maxTokens = result.days.reduce((m, d) => Math.max(m, d.totalTokens), 0);

  const weeks = [];
  let week = [];
  for (let di = startDayIndex; di <= endDayIndex; di++) {
    const day = dayTokenMap.get(di);
    week.push({
      date: dayIndexToDate(di),
      level: levelFor(day?.totalTokens ?? 0, maxTokens),
      totalTokens: day?.totalTokens ?? 0,
      turnCount: day?.turnCount ?? 0,
      toolCallCount: day?.toolCallCount ?? 0,
    });
    if (week.length === 7) {
      weeks.push({ weekIndex: weeks.length, days: week });
      week = [];
    }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push({ weekIndex: weeks.length, days: week });
  }

  const heatmap = {
    startDate: dayIndexToDate(startDayIndex),
    endDate: dayIndexToDate(endDayIndex),
    maxTokens,
    weeks,
  };

  const dailyMap = new Map();
  for (const dm of result.dayModels) {
    const inner = dailyMap.get(dm.dayIndex) ?? new Map();
    inner.set(dm.modelId, (inner.get(dm.modelId) ?? 0) + dm.totalTokens);
    dailyMap.set(dm.dayIndex, inner);
  }
  const dailyModelUsage = [];
  for (let di = startDayIndex; di <= endDayIndex; di++) {
    const inner = dailyMap.get(di);
    dailyModelUsage.push({
      date: dayIndexToDate(di),
      models: inner
        ? [...inner.entries()].map(([modelId, totalTokens]) => ({ modelId, totalTokens }))
        : [],
    });
  }

  const totalModelTokens = result.models.reduce((s, m) => s + m.totalTokens, 0);
  const models = result.models.map(m => ({
    modelId: m.modelId,
    totalTokens: m.totalTokens,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    requestCount: m.requestCount,
    share: totalModelTokens > 0 ? m.totalTokens / totalModelTokens : 0,
  }));
  const favoriteModel = models.length > 0
    ? { modelId: models[0].modelId, totalTokens: models[0].totalTokens, share: models[0].share }
    : null;

  const tools = result.tools.map(t => ({
    toolName: t.toolName,
    callCount: t.callCount,
    errorCount: t.errorCount,
    errorRate: t.callCount > 0 ? t.errorCount / t.callCount : 0,
    avgDurationMs: t.avgDurationMs,
  }));

  return {
    range: opts.range,
    generatedAt: opts.generatedAt,
    timeZone: opts.timeZone,
    source: 'agent-db',
    summary: {
      totalTokens: totals.totalTokens,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      reasoningTokens: totals.reasoningTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheHitRate,
      totalSessions: turnTotals.totalSessions,
      totalTurns: turnTotals.totalTurns,
      toolCallCount: toolTotals.toolCallCount,
      toolErrorRate,
      modelErrorRate,
      avgTimeToFirstTokenMs: totals.avgTimeToFirstTokenMs,
      avgTurnDurationMs: turnTotals.avgTurnDurationMs,
      activeDays,
      currentStreakDays,
      longestSessionMs: turnTotals.longestSessionMs,
      longestStreakDays,
      peakDayTokens: maxTokens,
      favoriteModel,
      modelRequestCount: totals.modelRequestCount,
      estimatedRequestCount: totals.estimatedRequestCount ?? 0,
      estimatedTokens: totals.estimatedTokens ?? 0,
    },
    heatmap,
    dailyModelUsage,
    models,
    tools,
  };
}

function monthKeyFor(timestampMs) {
  const d = new Date(Number.isFinite(timestampMs) ? timestampMs : Date.now());
  if (Number.isNaN(d.getTime())) return '1970-01';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Append-only monthly JSONL store under `<dataDir>/usage/YYYY-MM.jsonl`.
 * Keeps records in memory once loaded and tracks per-file size/mtime so both in-process appends
 * and externally seeded JSONL files stay in sync.
 */
export class UsageStatsStore {
  constructor({ dataDir, now = () => Date.now() }) {
    this.directory = path.join(dataDir, 'usage');
    this.now = now;
    this.files = new Map(); // filename -> { mtimeMs, size, records }
    this.queue = Promise.resolve();
  }

  #enqueue(task) {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  async #appendRecord(record) {
    const file = `${monthKeyFor(record.startedAt)}.jsonl`;
    const fullPath = path.join(this.directory, file);
    const line = `${JSON.stringify(record)}\n`;
    return this.#enqueue(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      await fs.appendFile(fullPath, line, 'utf8');
      const cached = this.files.get(file);
      if (cached) {
        try {
          const stat = await fs.stat(fullPath);
          cached.records.push(record);
          cached.mtimeMs = stat.mtimeMs;
          cached.size = stat.size;
        } catch {
          this.files.delete(file);
        }
      }
      return record;
    });
  }

  async recordModel(input = {}) {
    const startedAt = nonNegativeInt(input.startedAt ?? this.now());
    const completedAt = nonNegativeInt(input.completedAt ?? this.now());
    const durationMs = nonNegativeInt(input.durationMs ?? Math.max(0, completedAt - startedAt));
    const normalized = input.computedTotalTokens !== undefined
      ? {
          inputTokens: nonNegativeInt(input.inputTokens),
          outputTokens: nonNegativeInt(input.outputTokens),
          reasoningTokens: nonNegativeInt(input.reasoningTokens),
          cacheCreationTokens: nonNegativeInt(input.cacheCreationTokens ?? input.cacheCreationInputTokens),
          cacheReadTokens: nonNegativeInt(input.cacheReadTokens ?? input.cacheReadInputTokens),
          providerTotalTokens: nullableInt(input.providerTotalTokens),
          computedTotalTokens: nonNegativeInt(
            input.computedTotalTokens
              ?? inputSideTokensFromNormalizedUsage(
                input.inputTokens,
                input.cacheCreationTokens ?? input.cacheCreationInputTokens,
                input.cacheReadTokens ?? input.cacheReadInputTokens,
              ) + nonNegativeInt(input.outputTokens),
          ),
          usageSource: input.usageSource === 'estimated' ? 'estimated' : 'usage',
        }
      : normalizeModelUsage(input);

    const record = {
      kind: 'model',
      id: typeof input.id === 'string' && input.id ? input.id : randomUUID(),
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : null,
      turnId: typeof input.turnId === 'string' ? input.turnId : null,
      querySource: typeof input.querySource === 'string' ? input.querySource : 'main_turn',
      providerId: typeof input.providerId === 'string' ? input.providerId : null,
      providerName: typeof input.providerName === 'string' ? input.providerName : null,
      modelId: typeof input.modelId === 'string' && input.modelId.trim() ? input.modelId.trim() : null,
      mode: typeof input.mode === 'string' ? input.mode : null,
      status: ['completed', 'error', 'cancelled'].includes(input.status)
        ? input.status
        : input.status === 'done' ? 'completed' : 'completed',
      startedAt,
      completedAt,
      durationMs,
      timeToFirstTokenMs: nullableInt(input.timeToFirstTokenMs),
      finishReason: typeof input.finishReason === 'string' ? input.finishReason : null,
      toolCallCount: nonNegativeInt(input.toolCallCount),
      ...normalized,
    };
    return this.#appendRecord(record);
  }

  async recordTurn(input = {}) {
    const startedAt = nonNegativeInt(input.startedAt ?? this.now());
    const completedAt = nonNegativeInt(input.completedAt ?? this.now());
    const durationMs = nonNegativeInt(input.durationMs ?? Math.max(0, completedAt - startedAt));
    const status = input.status === 'done' || input.status === 'completed'
      ? 'completed'
      : input.status === 'cancelled' ? 'cancelled' : 'error';
    const record = {
      kind: 'turn',
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : null,
      turnId: typeof input.turnId === 'string' ? input.turnId : randomUUID(),
      mode: typeof input.mode === 'string' ? input.mode : null,
      status,
      startedAt,
      completedAt,
      durationMs,
      modelRequestCount: nonNegativeInt(input.modelRequestCount),
      toolCallCount: nonNegativeInt(input.toolCallCount),
      toolErrorCount: nonNegativeInt(input.toolErrorCount),
      inputTokens: nonNegativeInt(input.inputTokens),
      outputTokens: nonNegativeInt(input.outputTokens),
      reasoningTokens: nonNegativeInt(input.reasoningTokens),
      cacheCreationTokens: nonNegativeInt(input.cacheCreationTokens),
      cacheReadTokens: nonNegativeInt(input.cacheReadTokens),
      computedTotalTokens: nonNegativeInt(input.computedTotalTokens),
      tools: Array.isArray(input.tools)
        ? input.tools
            .filter(t => typeof t?.name === 'string' && t.name.trim())
            .map(t => ({
              name: t.name.trim(),
              status: t.status === 'error' ? 'error' : 'completed',
              durationMs: nullableInt(t.durationMs),
            }))
        : [],
    };
    return this.#appendRecord(record);
  }

  async #loadAllRecords() {
    await this.queue;
    let entries;
    try {
      entries = await fs.readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.files.clear();
        return [];
      }
      throw error;
    }
    const names = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map(entry => entry.name)
      .sort();
    const seen = new Set(names);
    for (const key of this.files.keys()) {
      if (!seen.has(key)) this.files.delete(key);
    }
    for (const name of names) {
      const fullPath = path.join(this.directory, name);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        this.files.delete(name);
        continue;
      }
      const cached = this.files.get(name);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
      const content = await fs.readFile(fullPath, 'utf8');
      const records = [];
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (isObject(parsed) && typeof parsed.kind === 'string') records.push(parsed);
        } catch {
          // Ignore malformed or truncated lines rather than breaking the whole dashboard.
        }
      }
      this.files.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, records });
    }
    const all = [];
    for (const name of names) {
      const bucket = this.files.get(name);
      if (bucket) all.push(...bucket.records);
    }
    return all;
  }

  /**
   * Aggregates records in `[since, until]` into the exact `AppUsageQueryResult` shape expected by
   * `buildAppUsageSnapshot`, matching ZCode's `queryAppUsage` in `repositories/usage.ts`.
   */
  async queryAppUsage({ since = 0, until = this.now(), tzOffsetMs = 0 } = {}) {
    const records = await this.#loadAllRecords();

    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let modelRequestCount = 0;
    let modelErrorCount = 0;
    let estimatedRequestCount = 0;
    let estimatedTokens = 0;
    let ttftSum = 0;
    let ttftCount = 0;

    // Keyed by `${sessionId ?? ''}:${turnId}` so repeated upserts of the same turn overwrite cleanly.
    const turnsByKey = new Map();
    const modelMap = new Map(); // modelId -> { modelId, totalTokens, inputTokens, outputTokens, requestCount }
    const dayMap = new Map(); // dayIndex -> { dayIndex, totalTokens, turnCount, toolCallCount }
    const dayModelMap = new Map(); // `${dayIndex}\0${modelId ?? ''}` -> { dayIndex, modelId, totalTokens }
    const toolMap = new Map(); // toolName -> { toolName, callCount, errorCount, durationSum, durationCount }

    const ensureDay = dayIndex => {
      let row = dayMap.get(dayIndex);
      if (!row) {
        row = { dayIndex, totalTokens: 0, turnCount: 0, toolCallCount: 0 };
        dayMap.set(dayIndex, row);
      }
      return row;
    };

    for (const record of records) {
      const startedAt = Number(record.startedAt ?? 0);
      if (!Number.isFinite(startedAt) || startedAt < since || startedAt > until) continue;

      if (record.kind === 'model') {
        const computed = nonNegativeInt(record.computedTotalTokens);
        const inp = nonNegativeInt(record.inputTokens);
        const out = nonNegativeInt(record.outputTokens);
        const reas = nonNegativeInt(record.reasoningTokens);
        const cCreate = nonNegativeInt(record.cacheCreationTokens);
        const cRead = nonNegativeInt(record.cacheReadTokens);

        totalTokens += computed;
        inputTokens += inp;
        outputTokens += out;
        reasoningTokens += reas;
        cacheCreationTokens += cCreate;
        cacheReadTokens += cRead;
        modelRequestCount += 1;
        if (record.status === 'error') modelErrorCount += 1;
        if (record.usageSource === 'estimated') {
          estimatedRequestCount += 1;
          estimatedTokens += computed;
        }
        if (typeof record.timeToFirstTokenMs === 'number' && Number.isFinite(record.timeToFirstTokenMs) && record.timeToFirstTokenMs >= 0) {
          ttftSum += record.timeToFirstTokenMs;
          ttftCount += 1;
        }

        const modelId = typeof record.modelId === 'string' && record.modelId.trim() ? record.modelId.trim() : null;
        const modelKey = modelId ?? '__unknown__';
        const existingModel = modelMap.get(modelKey) ?? {
          modelId,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          requestCount: 0,
        };
        existingModel.totalTokens += computed;
        existingModel.inputTokens += inp;
        existingModel.outputTokens += out;
        existingModel.requestCount += 1;
        modelMap.set(modelKey, existingModel);

        const dayIndex = Math.floor((startedAt + tzOffsetMs) / DAY_MS);
        const dayRow = ensureDay(dayIndex);
        dayRow.totalTokens += computed;

        const dmKey = `${dayIndex}\0${modelKey}`;
        const existingDm = dayModelMap.get(dmKey) ?? { dayIndex, modelId, totalTokens: 0 };
        existingDm.totalTokens += computed;
        dayModelMap.set(dmKey, existingDm);
      } else if (record.kind === 'turn') {
        const key = `${record.sessionId ?? ''}:${record.turnId ?? randomUUID()}`;
        turnsByKey.set(key, record);
      }
    }

    const sessionSet = new Set();
    const sessionDurations = new Map();
    let totalTurns = 0;
    let completedTurnDurationSum = 0;
    let completedTurnCount = 0;
    let toolCallCount = 0;
    let toolErrorCount = 0;

    for (const turn of turnsByKey.values()) {
      const startedAt = Number(turn.startedAt ?? 0);
      totalTurns += 1;
      if (turn.sessionId) sessionSet.add(turn.sessionId);
      const isCompleted = turn.status === 'completed' || turn.status === 'done';
      const durationMs = nonNegativeInt(turn.durationMs);
      if (isCompleted) {
        completedTurnDurationSum += durationMs;
        completedTurnCount += 1;
        const sid = turn.sessionId ?? turn.turnId ?? '__anon__';
        sessionDurations.set(sid, (sessionDurations.get(sid) ?? 0) + durationMs);
      }
      const turnToolCalls = nonNegativeInt(turn.toolCallCount);
      const turnToolErrors = nonNegativeInt(turn.toolErrorCount);
      toolCallCount += turnToolCalls;
      toolErrorCount += turnToolErrors;

      const dayIndex = Math.floor((startedAt + tzOffsetMs) / DAY_MS);
      const dayRow = ensureDay(dayIndex);
      dayRow.turnCount += 1;
      dayRow.toolCallCount += turnToolCalls;

      if (Array.isArray(turn.tools)) {
        for (const item of turn.tools) {
          if (!item?.name) continue;
          const entry = toolMap.get(item.name) ?? {
            toolName: item.name,
            callCount: 0,
            errorCount: 0,
            durationSum: 0,
            durationCount: 0,
          };
          entry.callCount += 1;
          if (item.status === 'error') entry.errorCount += 1;
          if (typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) && item.durationMs >= 0) {
            entry.durationSum += item.durationMs;
            entry.durationCount += 1;
          }
          toolMap.set(item.name, entry);
        }
      }
    }

    let longestSessionMs = 0;
    for (const sumMs of sessionDurations.values()) {
      if (sumMs > longestSessionMs) longestSessionMs = sumMs;
    }

    const models = [...modelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);
    const tools = [...toolMap.values()]
      .map(t => ({
        toolName: t.toolName,
        callCount: t.callCount,
        errorCount: t.errorCount,
        avgDurationMs: t.durationCount > 0 ? Math.round(t.durationSum / t.durationCount) : null,
      }))
      .sort((a, b) => b.callCount - a.callCount);
    const days = [...dayMap.values()].sort((a, b) => a.dayIndex - b.dayIndex);
    const dayModels = [...dayModelMap.values()].sort((a, b) => a.dayIndex - b.dayIndex);

    return {
      totals: {
        totalTokens,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cacheCreationTokens,
        cacheReadTokens,
        modelRequestCount,
        modelErrorCount,
        estimatedRequestCount,
        estimatedTokens,
        avgTimeToFirstTokenMs: ttftCount > 0 ? Math.round(ttftSum / ttftCount) : null,
      },
      turnTotals: {
        totalSessions: sessionSet.size,
        totalTurns,
        avgTurnDurationMs: completedTurnCount > 0 ? Math.round(completedTurnDurationSum / completedTurnCount) : null,
        longestSessionMs,
      },
      toolTotals: {
        toolCallCount,
        toolErrorCount,
      },
      models,
      tools,
      days,
      dayModels,
    };
  }

  async getSnapshot({ range = '7d', timeZone, now } = {}) {
    const cleanRange = typeof range === 'string' && range.trim() ? range.trim() : '7d';
    if (!APP_USAGE_RANGES.includes(cleanRange)) {
      throw new HttpError(400, '统计范围必须是 all、7d 或 30d。');
    }
    const resolvedTz = typeof timeZone === 'string' && timeZone.trim()
      ? timeZone.trim()
      : (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    const until = typeof now === 'number' && Number.isFinite(now) ? now : this.now();
    const tzOffsetMs = resolveTzOffsetMs(resolvedTz, until);
    const rangeDays = APP_USAGE_RANGE_DAYS[cleanRange] ?? 30;
    const since = cleanRange === 'all' ? 0 : until - rangeDays * DAY_MS;
    const queryResult = await this.queryAppUsage({ since, until, tzOffsetMs });
    return buildAppUsageSnapshot(queryResult, {
      range: cleanRange,
      timeZone: resolvedTz,
      tzOffsetMs,
      generatedAt: until,
      since,
      until,
    });
  }

  flush() {
    return this.queue;
  }
}
