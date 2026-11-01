/**
 * Reasoning levels for chat, ordered strictly from the least thinking to the most.
 *
 * The design follows ZCode's split between "the level the user chose" and "the fields that go on
 * the wire": a level is translated by a rule matched on protocol + model name, and a model no
 * dedicated rule knows falls back to a per-protocol default. Because vendors keep changing the
 * accepted spelling (Claude moved from `thinking.enabled + budget_tokens` to
 * `thinking.adaptive + output_config.effort`), every helper here returns an ordered list of
 * spellings: the request layer sends the first, and when the upstream refuses the reasoning field
 * it tries the next one before finally dropping the field altogether.
 */

/** Least thinking first. The order is part of the interface contract, not a detail. */
export const REASONING_LEVELS = [
  { id: 'low', label: '低', description: '思考最少，回答最快，消耗 token 最少' },
  { id: 'medium', label: '中', description: '平衡思考深度与响应速度' },
  { id: 'high', label: '高', description: '思考最深入，适合复杂推理与多步任务' },
];

const LEVEL_IDS = REASONING_LEVELS.map(level => level.id);
const LEVEL_SET = new Set(LEVEL_IDS);

/** The levels in the order the interface must show them: low, then medium, then high. */
export const REASONING_LEVEL_IDS = [...LEVEL_IDS];

export function isReasoningLevel(value) {
  return typeof value === 'string' && LEVEL_SET.has(value);
}

/**
 * The thinking budget one level means for protocols that take a token count.
 * The numbers follow each vendor's own documented ladder rather than an invented one.
 */
const BUDGET_BY_LEVEL = { low: 1_024, medium: 8_192, high: 24_576 };

export function reasoningBudget(level) {
  return isReasoningLevel(level) ? BUDGET_BY_LEVEL[level] : null;
}

/**
 * Models that accept an effort/level setting, matched by family and version rather than by an
 * exact name, so a dated snapshot (`o3-mini-2025-01-31`), a gateway prefix (`openai/o3-mini`) and
 * a family's own naming order (`claude-opus-4-8`) all match. Models genuinely without reasoning
 * control — `gpt-4o`, `claude-3-5-sonnet`, `gemini-1.5-flash`, `qwen-plus` — still answer no.
 */
const CHAT_REASONING_MODELS = [
  // OpenAI o-series, and the gpt-5 line and everything after it.
  /(?:^|\/)(?:o[1-9]\d*|gpt-[5-9]\d*|gpt-\d{2,})(?:[.\-]|$)/i,
  // DeepSeek R1, and the v3.1 / v4 lines that followed it.
  /deepseek-(?:r\d|v[3-9](?:\.\d+)?(?:[.\-]|$))/i,
  // Qwen QwQ and Qwen3 and later.
  /(?:qwq|qwen[3-9])/i,
  // Zhipu GLM 4.5 and later.
  /glm-[4-9](?:\.\d+)?/i,
  // Moonshot Kimi thinking models.
  /kimi-[a-z0-9.-]*(?:k2|k3|think)/i,
  // xAI Grok 3 and later.
  /grok-[3-9]/i,
  // Google Gemini 2.5 and later.
  /gemini-(?:2\.5|[3-9])/i,
  // Claude with extended thinking, in either naming order (claude-4-sonnet, claude-opus-4-8).
  /claude-(?:[a-z]+-)?(?:3[.\-]7|[4-9])/i,
  // A model that names its own thinking.
  /(?:reasoning|thinking|-think)/i,
];

/** Claude models with extended thinking on the Messages API. */
const CLAUDE_THINKING_MODELS = /claude-(?:[a-z]+-)?(?:3[.\-]7|[4-9])/i;

/**
 * Claude models known to take only the legacy manual form, `thinking.enabled + budget_tokens`.
 * Everything newer — and every model on the Messages API no rule knows — takes the adaptive form,
 * which is what ZCode's Anthropic fallback map sends too. Covered here: 3.7, the 4 / 4.0 / 4.1
 * line and the 4.5 line, in both naming orders (claude-sonnet-4-5, claude-4-sonnet, claude-3-7-sonnet).
 */
const CLAUDE_LEGACY_BUDGET_MODELS = [
  /claude-(?:[a-z]+-)?3[.\-]7(?![0-9])/i,
  /claude-(?:opus|sonnet|haiku)-4(?:[.\-](?:0|1|5)(?![0-9])|[.\-]\d{8}|(?![.\-]?[0-9]))/i,
  /claude-4(?:[.\-](?:0|1|5))?-(?:opus|sonnet|haiku)/i,
];

/** Families whose OpenAI-compatible endpoint is known to read only `reasoning_effort`. */
const CHAT_EFFORT_ONLY_MODELS = [
  /(?:^|\/)(?:o[1-9]\d*|gpt-[5-9]\d*|gpt-\d{2,})(?:[.\-]|$)/i,
  /grok-[3-9]/i,
  /gemini-(?:2\.5|[3-9])/i,
];

function normalizeModelName(model) {
  return typeof model === 'string' ? model.trim() : '';
}

/** True when a Claude model on the Messages API still needs the legacy budget form. */
export function usesLegacyThinkingBudget(model) {
  const name = normalizeModelName(model);
  return Boolean(name) && CLAUDE_LEGACY_BUDGET_MODELS.some(pattern => pattern.test(name));
}

/**
 * The reasoning levels this model and protocol accept, lowest first.
 * An empty array means the control must not be shown at all for this model.
 */
export function supportedReasoningLevels(model, protocol = 'chat') {
  const name = normalizeModelName(model);
  if (!name) return [];
  if (protocol === 'anthropic') {
    // Claude 3.5 and older have no thinking; other vendors' reasoning models are also served over
    // Anthropic-compatible endpoints (GLM, Kimi, DeepSeek, MiniMax...) and take the adaptive form.
    if (/claude-/i.test(name)) return CLAUDE_THINKING_MODELS.test(name) ? [...REASONING_LEVELS] : [];
  }
  return CHAT_REASONING_MODELS.some(pattern => pattern.test(name)) ? [...REASONING_LEVELS] : [];
}

/** True when this model can be given a reasoning level on this protocol. */
export function supportsReasoningLevel(model, protocol = 'chat') {
  return supportedReasoningLevels(model, protocol).length > 0;
}

/**
 * The level as the user chose it, independent of any model.
 *
 * Since 3.4.0 this is what is stored: the choice belongs to the connection, so it can be made
 * before a chat model is filled in and it survives switching models. Whether a given request
 * carries it is decided per request by `reasoningRequestVariants`, against that request's model.
 */
export function storedReasoningLevel(value) {
  return isReasoningLevel(value) ? value : '';
}

/**
 * Keep a configured level only while the model still accepts it.
 * Returns '' when nothing should be sent, which is also the answer for a stale saved value
 * whose model has since been changed to one without reasoning control.
 */
export function normalizeReasoningLevel(value, model, protocol = 'chat') {
  if (!isReasoningLevel(value)) return '';
  return supportsReasoningLevel(model, protocol) ? value : '';
}

const anthropicAdaptive = level => ({ thinking: { type: 'adaptive' }, output_config: { effort: level } });
const anthropicBudget = level => ({ thinking: { type: 'enabled', budget_tokens: reasoningBudget(level) } });

/**
 * Every spelling worth trying for one level, most likely first. An empty array means no field
 * may be sent at all. The request layer always ends with "no reasoning field" after these.
 *
 * - `anthropic`: legacy Claude → budget, then adaptive; everything else → adaptive, then budget.
 * - `chat`: OpenAI / Grok / Gemini → `reasoning_effort` only. Every other family gets ZCode's
 *   mixed Chat Completions fallback (`thinking.type`, `enable_thinking`, `reasoning_effort`,
 *   `reasoning.effort` together), then `reasoning_effort` alone for a gateway that is strict
 *   about unknown fields.
 * - `responses`: a nested `reasoning` object.
 */
export function reasoningRequestVariants(level, model, protocol = 'chat') {
  const clean = normalizeReasoningLevel(level, model, protocol);
  if (!clean) return [];
  if (protocol === 'anthropic') {
    return usesLegacyThinkingBudget(model)
      ? [anthropicBudget(clean), anthropicAdaptive(clean)]
      : [anthropicAdaptive(clean), anthropicBudget(clean)];
  }
  if (protocol === 'responses') return [{ reasoning: { effort: clean } }];
  const name = normalizeModelName(model);
  if (CHAT_EFFORT_ONLY_MODELS.some(pattern => pattern.test(name))) return [{ reasoning_effort: clean }];
  return [
    { thinking: { type: 'enabled' }, enable_thinking: true, reasoning_effort: clean, reasoning: { effort: clean } },
    { reasoning_effort: clean },
  ];
}

/** The fields one level adds to a request body: the first spelling, or `{}` when none applies. */
export function reasoningRequestBody(level, model, protocol = 'chat') {
  return reasoningRequestVariants(level, model, protocol)[0] ?? {};
}

/** Every top-level request field any spelling above may write; dropped together on a retry. */
export const REASONING_BODY_FIELDS = ['thinking', 'output_config', 'enable_thinking', 'reasoning_effort', 'reasoning'];
