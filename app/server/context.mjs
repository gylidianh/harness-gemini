/**
 * Context window accounting, compaction policy and summary prompts.
 *
 * Adapted from ZCode (Apache-2.0): `apps/zcode-cli/packages/core/src/compact/policy.ts`,
 * `manual.ts`, `prompt.ts` and `rounds.ts`, plus the usage panel described by
 * `packages/ui/src/chat-input-toolbar/contextUsage.tsx`. Changed portions are identified by
 * comments in the source; see THIRD-PARTY-NOTICES.md for provenance.
 *
 * Provider usage is the authoritative source for how full the context window is. While no
 * usage anchor exists — and for everything appended after the anchored request — a local
 * character estimate is used instead, with the same divisor ZCode uses. Every value this
 * module produces is therefore labelled `usage` or `estimated`; none of it is presented as a
 * tokenizer result.
 */
import { attachmentContextText } from './attachments.mjs';
import { contextText } from './media.mjs';
import { isObject } from './util.mjs';

/** ZCode keeps this as model capability metadata; Harness Gemini stores it per connection. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const MIN_CONTEXT_WINDOW = 2_000;
export const MAX_CONTEXT_WINDOW = 20_000_000;
export const ESTIMATED_TOKEN_CHAR_DIVISOR = 3;
// A normal request reserves its output side of the shared window; auto compaction may only
// claim the input side, so the threshold denominator removes this first.
export const DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 32_000;
export const PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 21_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const DEFAULT_PRESERVE_RECENT_TOKENS = 20_000;
export const CACHE_HIT_RATE_DISPLAY_THRESHOLD = 0.78;
export const CONTEXT_BREAKDOWN_SOURCES = ['system_prompt', 'system_tool_schemas', 'messages'];
/** The same per-tool record budget the conversation builder uses, so estimates match. */
export const TOOL_RECORD_CHAR_LIMIT = 12_000;
/** An absolute ceiling on what one request may carry, independent of configuration. */
export const MAX_CONTEXT_CHARS = 4_000_000;

export const AUTO_COMPACT_REASONS = Object.freeze([
  'disabled', 'not_enough_messages', 'circuit_breaker', 'below_threshold', 'above_threshold',
]);

function positiveInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/** Clamp any stored or requested capacity into the range this build can reason about. */
export function normalizeContextWindow(value) {
  const size = positiveInt(value);
  if (size === undefined || size < MIN_CONTEXT_WINDOW) return DEFAULT_CONTEXT_WINDOW;
  return Math.min(size, MAX_CONTEXT_WINDOW);
}

/** True for a value that may be stored as a context window; used by settings validation. */
export function isValidContextWindow(value) {
  return Number.isSafeInteger(value) && value >= MIN_CONTEXT_WINDOW && value <= MAX_CONTEXT_WINDOW;
}

/**
 * 1.2.6-cjk-estimate: Chinese, Japanese and Korean text is close to one token per character, so
 * dividing every character by three under-reported a Chinese conversation two to three times.
 * Those scripts now count one token per character (the same split metrics.mjs uses for output);
 * everything else keeps the original divisor.
 */
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
export function estimateTextTokens(text) {
  const value = String(text ?? '');
  if (!value.trim()) return 0;
  const cjk = value.match(CJK_PATTERN)?.length ?? 0;
  return Math.ceil(cjk + Math.max(0, value.length - cjk) / ESTIMATED_TOKEN_CHAR_DIVISOR);
}

export function estimateContextTokens(value) {
  return estimateTextTokens(contextText(value));
}

export function estimateMessageChars(value) {
  return contextText(value).length;
}

/**
 * The exact text one stored session message contributes to the next request. The conversation
 * builder and the token estimate both call this, so a displayed breakdown cannot drift from
 * what is actually sent.
 */
/**
 * The thinking a stored assistant turn carried, or an empty string. It is returned apart from
 * sessionMessageText so it can be replayed as `reasoning_content` instead of leaking into the
 * answer text the user reads.
 */
export function sessionMessageReasoning(message) {
  if (message?.role !== 'assistant') return '';
  const reasoning = typeof message?.reasoning === 'string' ? message.reasoning.trim() : '';
  return reasoning;
}

export function sessionMessageText(message, { inlined = null } = {}) {
  let text = contextText(message?.text);
  // A prompt skill travels ahead of the message it was sent with, exactly as it was first sent,
  // so a reopened conversation reads to the model the way the user wrote it.
  if (message?.role === 'user' && typeof message?.skill?.text === 'string' && message.skill.text.trim()) {
    text = text.trim() ? `${message.skill.text.trim()}\n\n${text}` : message.skill.text.trim();
  }
  // A user turn's attachments contribute their paths, so the model opens the file with its own
  // tools instead of guessing at contents. `inlined` names the images that also travelled as
  // image parts on this exact request.
  const attachments = attachmentContextText(message?.attachments, { inlined });
  if (message?.role === 'user' && attachments) text += `\n\n${attachments}`;
  const tools = message?.tools;
  if (message?.role === 'assistant' && Array.isArray(tools) && tools.length) {
    text += '\n\n此前工具执行记录：\n' + tools
      .map(tool => `${tool?.name ?? ''} (${tool?.status ?? ''}): ${contextText(tool?.output ?? '').slice(0, TOOL_RECORD_CHAR_LIMIT)}`)
      .join('\n');
  }
  return text;
}

/**
 * The text one entry contributes. Accepts both shapes this server handles: a stored session
 * message (text plus tool records) and an already built model message (content plus tool_calls).
 */
export function entryText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.filter(part => part?.type !== 'image_url').map(part => part?.text ?? JSON.stringify(part)).join('\n');
  if (message?.content !== undefined && message.content !== null) return JSON.stringify(message.content);
  return sessionMessageText(message);
}

/** Estimates text, reasoning and tool calls, plus a labelled 2,048-token reserve per image (1.2.9). */
export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const message of messages ?? []) {
    total += estimateContextTokens(entryText(message));
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length) total += estimateContextTokens(JSON.stringify(message.tool_calls));
    const reasoning = message?.reasoning_content ?? message?.reasoning;
    if (typeof reasoning === 'string') total += estimateContextTokens(reasoning);
    if (Array.isArray(message?.content)) total += message.content.filter(part => part?.type === 'image_url').length * 2048;
    if (message?.role) total += 4;
  }
  return total;
}

/**
 * The character size of a model request, measured the way the request builder's character budget
 * is. The 413 guard compares against that budget, so it must stay in characters rather than use
 * the script-aware token estimate.
 */
export function estimateMessagesChars(messages) {
  let total = 0;
  for (const message of messages ?? []) {
    total += contextText(entryText(message)).length;
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length) total += contextText(JSON.stringify(message.tool_calls)).length;
    const reasoning = message?.reasoning_content ?? message?.reasoning;
    if (typeof reasoning === 'string') total += contextText(reasoning).length;
    if (message?.role) total += 12;
  }
  return total;
}

export function getAutoCompactOutputReserveTokens(config = {}) {
  const maxOutputTokens = positiveInt(config.maxOutputTokens);
  // The legacy branch reserved a model's full output budget, which compacted far too early.
  return Math.min(maxOutputTokens ?? DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS,
    PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS, Math.floor(normalizeContextWindow(config.contextWindow) / 4));
}

export function getEffectiveContextWindowSize(config = {}) {
  const contextWindow = normalizeContextWindow(config.contextWindow);
  return Math.max(0, contextWindow - Math.min(getAutoCompactOutputReserveTokens(config), contextWindow));
}

export function getAutoCompactThreshold(config = {}) {
  const buffer = Math.min(positiveInt(config.bufferTokens) ?? AUTOCOMPACT_BUFFER_TOKENS,
    Math.floor(normalizeContextWindow(config.contextWindow) / 8));
  return Math.max(0, getEffectiveContextWindowSize(config) - buffer);
}

/** Secondary text-size ceiling only; requests must ALSO pass the CJK-aware token bound (1.2.9). */
export function getContextCharBudget(config = {}) {
  return Math.min(MAX_CONTEXT_CHARS, getAutoCompactThreshold(config) * ESTIMATED_TOKEN_CHAR_DIVISOR);
}

/** Splits a conversation at user turns, so a summary can keep whole exchanges together. */
export function groupConversationRounds(messages) {
  const rounds = [];
  let current = [];
  for (const message of messages ?? []) {
    if (message?.role === 'user' && current.length) { rounds.push(current); current = []; }
    current.push(message);
  }
  if (current.length) rounds.push(current);
  return rounds;
}

export function hasEnoughMessagesToCompact(messages) {
  const rounds = groupConversationRounds(messages);
  return rounds.length >= 2 && (messages ?? []).some(message => message?.role === 'assistant');
}

/**
 * Everything older than the most recent rounds is summarized; the recent rounds stay verbatim
 * so compaction cannot erase the work in progress. At least the first round is always
 * summarized, which is what keeps the operation from becoming a no-op.
 */
export function selectMessagesToSummarize(messages, { preserveRecentTokens = DEFAULT_PRESERVE_RECENT_TOKENS } = {}) {
  const rounds = groupConversationRounds(messages);
  const budget = positiveInt(preserveRecentTokens) ?? DEFAULT_PRESERVE_RECENT_TOKENS;
  let keptFrom = rounds.length;
  let kept = 0;
  for (let index = rounds.length - 1; index >= 1; index--) {
    const cost = rounds[index].reduce((sum, message) => sum + estimateContextTokens(entryText(message)), 0);
    if (kept + cost > budget) break;
    kept += cost;
    keptFrom = index;
  }
  // At least one round must be kept verbatim: replacing the entire conversation with a
  // summary would erase the work in progress instead of continuing it.
  const summarizeUpTo = Math.max(0, Math.min(keptFrom, rounds.length - 1));
  return {
    toSummarize: rounds.slice(0, summarizeUpTo).flat(),
    preserved: rounds.slice(summarizeUpTo).flat(),
    summarizedCount: rounds.slice(0, summarizeUpTo).reduce((sum, round) => sum + round.length, 0),
    summarizedRounds: summarizeUpTo,
    preservedRounds: rounds.length - summarizeUpTo,
  };
}

/** Usage total, mirroring ZCode's `getUsageTotalTokens` across the common provider shapes. */
export function usageTotalTokens(usage) {
  if (!isObject(usage)) return null;
  const bounded = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
  const total = bounded(usage.total_tokens) ?? bounded(usage.totalTokens);
  if (total !== null) return total;
  const input = bounded(usage.prompt_tokens) ?? bounded(usage.input_tokens);
  const output = bounded(usage.completion_tokens) ?? bounded(usage.output_tokens);
  if (input === null && output === null) return null;
  return (input ?? 0) + (output ?? 0);
}

/**
 * 1.2.6-prompt-anchor: the prompt side of a usage report. Raw Anthropic shapes are summed the same
 * way provider.mjs maps them, so a caller that passes an unmapped report is still counted whole.
 */
export function usagePromptTokens(usage) {
  if (!isObject(usage)) return null;
  const bounded = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
  const prompt = bounded(usage.prompt_tokens) ?? bounded(usage.promptTokens);
  if (prompt !== null) return prompt;
  const input = bounded(usage.input_tokens);
  if (input === null) return null;
  return input + (bounded(usage.cache_read_input_tokens) ?? 0) + (bounded(usage.cache_creation_input_tokens) ?? 0);
}

export function usageOutputTokens(usage) {
  if (!isObject(usage)) return null;
  const bounded = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
  return bounded(usage.completion_tokens) ?? bounded(usage.output_tokens) ?? bounded(usage.completionTokens);
}

/** Cache hit rate from an OpenAI-compatible usage report, or null when it cannot be derived. */
export function contextCacheHitRate(usage) {
  if (!isObject(usage)) return null;
  const prompt = usagePromptTokens(usage);
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens;
  if (!Number.isFinite(prompt) || prompt <= 0 || !Number.isFinite(cached) || cached < 0) return null;
  return Math.min(1, cached / prompt);
}

/** Accepts sections that already know their size (`chars`) or that carry `text` to measure. */
export function buildContextBreakdown(sections) {
  const charsBySource = new Map();
  for (const section of sections ?? []) {
    if (!CONTEXT_BREAKDOWN_SOURCES.includes(section?.source)) continue;
    const chars = Number.isFinite(section?.chars) ? Math.max(0, Math.floor(section.chars)) : estimateMessageChars(section?.text);
    if (chars <= 0) continue;
    charsBySource.set(section.source, (charsBySource.get(section.source) ?? 0) + chars);
  }
  const total = [...charsBySource.values()].reduce((sum, chars) => sum + chars, 0);
  if (total <= 0) return [];
  return [...charsBySource.entries()]
    .map(([source, chars]) => ({ source, chars, percent: chars / total }))
    .sort((left, right) => right.chars - left.chars || CONTEXT_BREAKDOWN_SOURCES.indexOf(left.source) - CONTEXT_BREAKDOWN_SOURCES.indexOf(right.source));
}

/**
 * Decides whether the next request must be compacted first. A circuit breaker stops a session
 * from retrying a broken summary forever; the caller then continues the turn uncompacted
 * rather than failing it.
 */
export function shouldAutoCompact({ messages, config = {}, consecutiveFailures = 0, tokenOverride, hasSummary = false } = {}) {
  const contextWindow = normalizeContextWindow(config.contextWindow);
  const threshold = getAutoCompactThreshold(config);
  const estimatedTokenCount = estimateMessagesTokens(messages);
  const providerTokens = positiveInt(tokenOverride?.tokenCount);
  const tokenCount = providerTokens ?? estimatedTokenCount;
  const common = {
    shouldCompact: false,
    tokenCount,
    tokenSource: providerTokens === undefined ? 'estimate' : 'provider_usage',
    estimatedTokenCount,
    threshold,
    contextWindow,
    effectiveContextWindow: getEffectiveContextWindowSize(config),
    reason: 'below_threshold',
  };
  if (config.enabled === false) return { ...common, reason: 'disabled' };
  if (!hasSummary && !hasEnoughMessagesToCompact(messages)) return { ...common, reason: 'not_enough_messages' };
  if (consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) return { ...common, reason: 'circuit_breaker' };
  if (tokenCount < threshold) return common;
  return { ...common, shouldCompact: true, reason: 'above_threshold' };
}

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use any tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const NO_TOOLS_TRAILER = '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.';

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like file names, full code snippets, function signatures and file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
   - Note any security-relevant instructions or constraints the user stated (for example sensitive files or data to avoid, operations that must not be performed, credential or secret handling rules). These MUST be preserved verbatim in the summary so they continue to apply after compaction.

2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent. Preserve any security-relevant instructions or constraints verbatim so they remain in effect after compaction.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. If your last task was concluded, then only list next steps if they are explicitly in line with the user's request.

Here is an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]
2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
3. Files and Code Sections:
   - [File Name 1]
     - [Summary of why this file is important]
     - [Important Code Snippet]
4. Errors and fixes:
   - [Detailed description of error 1]
     - [How you fixed the error]
5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting efforts]
6. All user messages:
   - [Detailed non tool use user message]
7. Pending Tasks:
   - [Task 1]
8. Current Work:
   [Precise description of current work]
9. Optional Next Step:
   [Optional Next step to take]
</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating your summary.`;

export function buildCompactPrompt(customInstructions) {
  const extra = typeof customInstructions === 'string' && customInstructions.trim()
    ? `\n\nAdditional Instructions:\n${customInstructions.trim()}`
    : '';
  return `${NO_TOOLS_PREAMBLE}${BASE_COMPACT_PROMPT}${extra}${NO_TOOLS_TRAILER}`;
}

/** The analysis block is the model's private scratch work and never reaches the next request. */
export function formatCompactSummary(text) {
  let formatted = typeof text === 'string' ? text.trim() : '';
  if (!formatted) return '';
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/, '');
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) formatted = formatted.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${(summaryMatch[1] || '').trim()}`);
  return formatted.replace(/\n{3,}/g, '\n\n').trim();
}

export function buildCompactSummaryMessage(summary, { suppressFollowup = true } = {}) {
  let message = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n' + summary;
  if (suppressFollowup) {
    message += '\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, and do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.';
  }
  return message;
}

/** The messages a summary request carries: the history to compress, then the prompt itself. */
export function buildCompactRequestMessages(messages, prompt, { charBudget = MAX_CONTEXT_CHARS, tokenBudget = Infinity, requireComplete = false } = {}) {
  const selected = [];
  const historyBudget = Math.max(0, Math.min(charBudget, MAX_CONTEXT_CHARS) - prompt.length - 12);
  if (typeof tokenBudget !== 'number' || Number.isNaN(tokenBudget) || tokenBudget < 0) throw new TypeError('Invalid compaction token budget.');
  const promptTokens = estimateMessagesTokens([{ role: 'user', content: prompt }]);
  const historyTokenBudget = tokenBudget - promptTokens;
  if (historyTokenBudget < 0) throw new Error('当前上下文窗口不足以容纳压缩指令，请增大上下文窗口。');
  if (!historyBudget) throw new Error('当前上下文窗口不足以容纳压缩指令，请增大上下文窗口。');
  if (requireComplete) {
    const history = (messages ?? []).map(message => ({
      role: message.role === 'assistant' ? 'assistant' : 'user', content: entryText(message),
    })).filter(message => message.content.trim());
    if (history.reduce((sum, message) => sum + message.content.length + 12, 0) > historyBudget || estimateMessagesTokens([...history, { role: 'user', content: prompt }]) > tokenBudget) {
      throw new Error('原有摘要和待压缩历史超出当前上下文窗口，已保留原记录；请增大上下文窗口后重试压缩。');
    }
    return [...history, { role: 'user', content: prompt }];
  }
  let used = 0;
  let usedTokens = 0;
  // 1.2.9: both complete and partial summary requests obey the same CJK-aware token bound.
  // Keep complete newest entries when possible; only the first retained entry may be sliced.
  for (let index = (messages ?? []).length - 1; index >= 0; index--) {
    const text = entryText(messages[index]);
    if (!text.trim()) continue;
    const role = messages[index].role === 'assistant' ? 'assistant' : 'user';
    const remaining = historyBudget - used - 12;
    const remainingTokens = historyTokenBudget - usedTokens;
    const cost = content => estimateMessagesTokens([{ role, content }]);
    if (remaining <= 0 || remainingTokens < 4 || ((text.length > remaining || cost(text) > remainingTokens) && selected.length)) break;
    let low = 0, high = Math.min(text.length, remaining);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (cost(text.slice(0, middle)) <= remainingTokens) low = middle;
      else high = middle - 1;
    }
    // Never split a UTF-16 surrogate pair at a budget boundary.
    if (low < text.length && /[\uD800-\uDBFF]/.test(text[low - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[low] ?? '')) low--;
    const content = text.slice(0, low);
    if (!content.trim()) break;
    used += content.length + 12;
    usedTokens += cost(content);
    selected.push({ role, content });
  }
  selected.reverse();
  selected.push({ role: 'user', content: prompt });
  return selected;
}

/**
 * Tracks how full the active context window is for one run.
 *
 * A provider usage report anchors the count for the exact request it belongs to. Anything the
 * conversation gained afterwards is added as a local estimate, so the number keeps moving
 * between model requests without ever inventing a precise-looking token count.
 */
export const CONTEXT_ACCOUNTING_VERSION = 2;

/**
 * 1.3.2-context-calibration: how far upstream counts differ from the local character estimate.
 * A ratio outside these bounds is treated as a broken report rather than a tokenizer.
 */
const CALIBRATION_MIN = 0.5;
const CALIBRATION_MAX = 4;
export function normalizeCalibration(value) {
  const prompt = Number(value?.prompt);
  const estimate = Number(value?.estimate);
  if (!Number.isSafeInteger(prompt) || !Number.isSafeInteger(estimate) || prompt <= 0 || estimate <= 0) return null;
  const ratio = prompt / estimate;
  if (!(ratio >= CALIBRATION_MIN && ratio <= CALIBRATION_MAX)) return null;
  return { prompt, estimate, ...(typeof value?.model === 'string' && value.model ? { model: value.model.slice(0, 200) } : {}) };
}

export class ContextUsageTracker {
  /**
   * 1.3.2-context-calibration: `calibration` is the last upstream count of this conversation
   * together with the local estimate of the same request. Every turn starts a new tracker, and
   * until the turn's first usage report arrives the readout used to be the raw character
   * estimate, which is usually lower than the real count; a turn stopped that early kept the
   * lower figure, so stopping made the context look smaller. The estimate is now scaled by the
   * ratio upstream last reported, and is still marked as an estimate.
   */
  constructor({ contextWindow, autoCompact = true, calibration = null, model = '' } = {}) {
    this.size = normalizeContextWindow(contextWindow);
    this.autoCompact = autoCompact !== false;
    /** Estimated tokens of the request most recently observed. */
    this.tokens = 0;
    this.sections = [];
    this.anchor = null;
    this.model = typeof model === 'string' ? model : '';
    const seed = normalizeCalibration(calibration);
    this.calibration = seed && (!seed.model || !this.model || seed.model === this.model) ? seed : null;
  }

  /** The local estimate scaled by the last upstream ratio, or the raw estimate without one. */
  calibrated(tokens) {
    if (!this.calibration || tokens <= 0) return tokens;
    return Math.round(tokens * this.calibration.prompt / this.calibration.estimate);
  }

  get threshold() { return getAutoCompactThreshold({ contextWindow: this.size }); }

  /**
   * The request about to be sent, together with the sections it was built from. Passing `tools`
   * lets the schemas be estimated from their real text; otherwise the schema section's
   * character count is used.
   */
  observe({ messages, sections, tools }) {
    let tokens = estimateMessagesTokens(messages);
    if (Array.isArray(tools) && tools.length) tokens += estimateContextTokens(JSON.stringify(tools));
    else {
      const toolChars = (sections ?? []).filter(section => section?.source === 'system_tool_schemas')
        .reduce((sum, section) => sum + (Number.isFinite(section.chars) ? Math.max(0, section.chars) : 0), 0);
      tokens += Math.ceil(toolChars / ESTIMATED_TOKEN_CHAR_DIVISOR);
    }
    this.tokens = tokens;
    // The history has moved on from the request the anchor describes.
    if (this.anchor) this.anchor.followed = true;
    if (Array.isArray(sections)) this.sections = sections;
    return this;
  }

  /**
   * Drops the provider anchor. Compaction replaces the history with a summary, so the previous
   * request's exact count no longer describes what will be sent next.
   */
  reset() {
    this.anchor = null;
    this.sections = [];
    this.tokens = 0;
    return this;
  }

  /**
   * Provider usage is authoritative for the request that just finished.
   *
   * 1.2.6-prompt-anchor: the anchor keeps the prompt and the output apart. Once the next request
   * is observed, its estimate already contains the reply that was just produced (answer text,
   * visible reasoning, tool calls), so only the prompt side is carried forward; adding the
   * provider's output count as well counted the same reply — and any hidden thinking that is
   * never sent back — twice.
   */
  recordUsage(usage) {
    let prompt = usagePromptTokens(usage);
    let output = usageOutputTokens(usage) ?? 0;
    if (prompt === null) {
      const total = usageTotalTokens(usage);
      if (total === null) return this;
      prompt = total; output = 0;
    }
    this.anchor = { prompt, output, estimate: this.tokens, followed: false, cacheHitRate: contextCacheHitRate(usage) };
    const calibration = normalizeCalibration({ prompt, estimate: this.tokens, model: this.model });
    if (calibration) this.calibration = calibration;
    return this;
  }

  snapshot() {
    const estimated = this.tokens;
    let used = this.calibrated(estimated);
    if (this.anchor) {
      used = this.anchor.followed
        ? this.anchor.prompt + Math.max(0, estimated - this.anchor.estimate)
        : this.anchor.prompt + this.anchor.output;
    }
    return {
      accounting: CONTEXT_ACCOUNTING_VERSION,
      used,
      size: this.size,
      percent: this.size > 0 ? Math.min(1, Math.max(0, used / this.size)) : 0,
      source: this.anchor ? 'usage' : 'estimated',
      threshold: this.threshold,
      autoCompact: this.autoCompact,
      cache: { hitRate: this.anchor?.cacheHitRate ?? null },
      breakdown: buildContextBreakdown(this.sections),
      ...(this.calibration ? { calibration: { ...this.calibration } } : {}),
    };
  }
}


// ---------------------------------------------------------------- 1.3.0 request fitting
/** The window reserve one image part costs in estimateMessagesTokens. */
export const IMAGE_TOKEN_RESERVE = 2048;
export const TRIMMED_TOOL_RESULT_PREFIX = '[为控制上下文大小，这条工具结果已从后续请求中省略';
const PDF_RECORD_TOOLS = new Set(['ext_read_pdf', 'record_pdf_pages']);

function withoutImageParts(messages) {
  return (messages ?? []).map(message => Array.isArray(message?.content)
    ? { ...message, content: message.content.filter(part => part?.type !== 'image_url') }
    : message);
}

/** A prefix that never ends in the first half of a UTF-16 surrogate pair. */
export function safePrefix(text, length) {
  const value = String(text ?? '');
  if (length >= value.length) return value;
  let end = Math.max(0, length);
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

/** Whether one request (messages plus tool schemas) passes both the character and token bounds. */
export function requestFits(messages, tools, config = {}) {
  const schema = tools?.length ? JSON.stringify(tools) : '';
  return estimateMessagesChars(withoutImageParts(messages)) + schema.length <= getContextCharBudget(config)
    && estimateMessagesTokens(messages) + estimateTextTokens(schema || '[]') <= getAutoCompactThreshold(config);
}

/**
 * How many tool images the next request can still carry. Images are reserved at 2,048 tokens each,
 * so the image cap has to follow the room the window leaves, not only a fixed count. Images in
 * messages the ledger does not manage (the user's own inline images) are already committed.
 */
export function requestImageRoom(messages, tools, config = {}, managed = new Set()) {
  let committed = 0;
  for (const message of messages ?? []) {
    if (!Array.isArray(message?.content) || managed.has(message)) continue;
    committed += message.content.filter(part => part?.type === 'image_url').length;
  }
  const used = estimateMessagesTokens(withoutImageParts(messages)) + estimateTextTokens(JSON.stringify(tools ?? [])) + committed * IMAGE_TOKEN_RESERVE;
  return Math.floor((getAutoCompactThreshold(config) - used) / IMAGE_TOKEN_RESERVE);
}

/**
 * A single long task (one user turn that keeps reading files, pages or web pages) cannot be helped
 * by compaction, which always keeps the current turn verbatim. Before such a request is refused,
 * older tool results of the turn are shortened to a short excerpt, oldest first: ordinary tools
 * first, PDF read/record results next, and the newest round's results only as a last resort.
 * tool_call_id pairing is untouched. Returns how many results were shortened.
 */
export function trimToolResults(messages, { start = 0, fits, excerpt = 600, latestExcerpt = 2_000 } = {}) {
  if (typeof fits !== 'function' || fits()) return 0;
  const names = new Map();
  let lastCalls = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) continue;
    lastCalls = index;
    for (const call of message.tool_calls) names.set(call?.id, String(call?.function?.name ?? ''));
  }
  const tiers = [[], [], [], []];
  for (let index = Math.max(0, start); index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== 'tool' || typeof message.content !== 'string' || message.content.startsWith(TRIMMED_TOOL_RESULT_PREFIX)) continue;
    const latest = index > lastCalls;
    if (message.content.length <= (latest ? latestExcerpt : excerpt) + 400) continue;
    const pdf = PDF_RECORD_TOOLS.has(names.get(message.tool_call_id));
    tiers[(latest ? 2 : 0) + (pdf ? 1 : 0)].push({ message, latest });
  }
  let trimmed = 0;
  for (const { message, latest } of tiers.flat()) {
    const original = message.content;
    message.content = latest
      ? TRIMMED_TOOL_RESULT_PREFIX + '（原长 ' + original.length + ' 个字符）；整体超出上下文窗口，只保留开头。需要其余内容时，请缩小范围或分段重新读取。开头摘录：]\n' + safePrefix(original, latestExcerpt)
      : TRIMMED_TOOL_RESULT_PREFIX + '（原长 ' + original.length + ' 个字符）。你当时看到的要点应已体现在之后的回复里；确实还需要完整内容时，请重新调用工具。开头摘录：]\n' + safePrefix(original, excerpt);
    trimmed += 1;
    if (fits()) break;
  }
  return trimmed;
}
