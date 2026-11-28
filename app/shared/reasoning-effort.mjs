/**
 * Reasoning levels for chat and agent turns, ordered strictly from the least thinking to the most.
 *
 * The design follows ZCode's split between "the level the user chose" and "the fields that go on
 * the wire", extended with per-model capability profiles and graceful clamping/fallback patterns
 * used across modern open-source harnesses and gateways (Google AI Studio / Gemini 4, OpenAI
 * GPT-5.x, Anthropic Claude 4.7+, LiteLLM, Magpie, OpenRouter):
 *
 *  - Canonical 5-tier ladder: `minimal` < `low` < `medium` < `high` < `xhigh`.
 *  - Not every model supports every tier (e.g. Gemini 4 Carbon caps at `high`, Gemini 4 Neon &
 *    Hydrogen support `low..xhigh`, Gemini 3.5 Flash-Lite supports `minimal..high`).
 *  - The user's chosen level belongs to the connection profile and survives switching models.
 *    Per request, `resolveReasoningLevel` clamps an out-of-range tier to the nearest tier the target
 *    model actually supports (`xhigh` -> `high` on Carbon; `minimal` -> `low` on Neon/Hydrogen),
 *    while models without reasoning control receive no reasoning field at all.
 *  - Every helper returns an ordered list of wire spellings: the request layer sends the primary
 *    spelling first, tries alternate wire formats for the same level (such as Google's
 *    `extra_body.google.thinking_config.thinking_level` or OpenRouter's `reasoning.effort`), then
 *    steps down (`xhigh` -> `high` / `minimal` -> `low`) if a relay rejects the extreme tier, and
 *    finally drops the field altogether rather than failing the turn.
 */

/** Least thinking first. The order is part of the interface contract, not a detail. */
export const REASONING_LEVELS = [
  { id: 'minimal', label: '极低', description: '极少思考，延迟最低，适合轻量快速任务' },
  { id: 'low', label: '低', description: '轻度思考，回答较快，消耗 token 较少' },
  { id: 'medium', label: '中', description: '平衡思考深度与响应速度' },
  { id: 'high', label: '高', description: '深入思考，适合复杂推理与多步任务' },
  { id: 'xhigh', label: '超高', description: '极限深度推理，耗时与 token 消耗显著增加，适合最复杂的难题' },
];

const LEVEL_IDS = REASONING_LEVELS.map(level => level.id);
const LEVEL_SET = new Set(LEVEL_IDS);
const LEVEL_BY_ID = new Map(REASONING_LEVELS.map(level => [level.id, level]));

/** The levels in the order the interface must show them: minimal, low, medium, high, xhigh. */
export const REASONING_LEVEL_IDS = [...LEVEL_IDS];

export function isReasoningLevel(value) {
  return typeof value === 'string' && LEVEL_SET.has(value);
}

export function reasoningLevelMeta(value) {
  return isReasoningLevel(value) ? LEVEL_BY_ID.get(value) : null;
}

/**
 * The thinking budget one level means for protocols that take a token count (Gemini 2.5
 * `thinking_budget` and legacy Claude `thinking.budget_tokens`).
 * The numbers follow each vendor's documented ladder rather than an invented one.
 */
const BUDGET_BY_LEVEL = {
  minimal: 1_024,
  low: 1_024,
  medium: 8_192,
  high: 24_576,
  xhigh: 32_768,
};

export function reasoningBudget(level) {
  return isReasoningLevel(level) ? BUDGET_BY_LEVEL[level] : null;
}

const LEVELS_STANDARD = ['low', 'medium', 'high'];
const LEVELS_WITH_MINIMAL = ['minimal', 'low', 'medium', 'high'];
const LEVELS_WITH_XHIGH = ['low', 'medium', 'high', 'xhigh'];

/** Media / embedding / audio models never accept reasoning control even when sharing a family prefix. */
const NON_REASONING_MEDIA_MODEL = /(?:^|[/:_-])(?:image|imagen|veo|tts|audio|transcribe|whisper|embedding|embed|moderation|dall-e)(?:[^a-z0-9]|$)/i;

/**
 * Other reasoning model families matched by family and version rather than exact snapshot name.
 * Models genuinely without reasoning control — `gpt-4o`, `claude-3-5-sonnet`, `gemini-1.5-flash`,
 * `gemini-2.0-flash`, `qwen-plus`, `deepseek-v3`, `glm-4-flash`, `glm-4-air`, `glm-4-plus` —
 * still answer no.
 */
const OTHER_REASONING_MODELS = [
  // DeepSeek R1 / reasoner, and the v3.1+ / v4+ hybrid thinking lines (excluding plain deepseek-v3 / v3.0).
  /deepseek-(?:r\d+|reasoner|v3\.[1-9]\d*(?:[.\-]|$)|(?:v[4-9]|v\d{2,})(?:\.\d+)?(?:[.\-]|$))/i,
  // Qwen QwQ and Qwen3 and later.
  /(?:qwq|qwen[3-9])/i,
  // Zhipu GLM Z1 / Zero reasoning series, and GLM 4.5+ / 5+ (excluding plain glm-4 / 4-flash / 4-air / 4-plus).
  /glm-(?:z\d+|zero|4\.(?:[5-9]\d*|[1-9]\d+)|(?:[5-9]|\d{2,})(?:\.\d+)?)/i,
  // Moonshot Kimi thinking models.
  /kimi-[a-z0-9.-]*(?:k2|k3|think)/i,
  // A model that names its own thinking.
  /(?:reasoner|reasoning|thinking|-think)/i,
];

/** Claude models with extended thinking (3.7+, 4+, 5+ in either naming order). */
const CLAUDE_THINKING_MODELS = /claude-(?:[a-z]+-)?(?:3[.\-]7|[4-9])/i;

/** Claude models that support `xhigh` adaptive effort (4.7+ and 5+ in either naming order). */
const CLAUDE_XHIGH_MODELS = [
  /claude-(?:[a-z]+-)?(?:4[.\-](?:[7-9]|\d{2,})|[5-9])(?:[^0-9]|$)/i,
  /claude-(?:4[.\-](?:[7-9]|\d{2,})|[5-9])-(?:opus|sonnet|haiku)(?:[^a-z0-9]|$)/i,
];

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

/** Google Gemini model matchers (matching official Google AI Studio capability matrix). */
const GEMINI_ANY_MODEL = /gemini-/i;
const GEMINI_REASONING_MODEL = /gemini-(?:2\.5|[3-9]|\d{2,})(?:[^0-9]|$)/i;
const GEMINI_THINKING_LEVEL_MODEL = /gemini-(?:[3-9]|\d{2,})(?:[^0-9]|$)/i;
const GEMINI_25_MODEL = /gemini-2\.5(?:[^0-9]|$)/i;
const GEMINI_4_CARBON_MODEL = /gemini-4(?:\.\d+)?-carbon(?:[^a-z0-9]|$)/i;
const GEMINI_4_XHIGH_MODEL = /gemini-4(?:\.\d+)?-(?:neon|hydrogen)(?:[^a-z0-9]|$)/i;
const GEMINI_4_PLUS_FLASH_LITE_MODEL = /gemini-(?:[4-9]|\d{2,})(?:\.\d+)?-flash-lite(?:[^a-z0-9]|$)/i;
const GEMINI_4_PLUS_MODEL = /gemini-(?:[4-9]|\d{2,})(?:[.\-_]|$)/i;
const GEMINI_3_MINIMAL_MODEL = /gemini-3(?:\.\d+)?-flash-lite(?:[^a-z0-9]|$)|gemini-3(?:\.[0-7])?-flash(?:[^a-z0-9]|$)/i;

/** OpenAI reasoning models (o-series and GPT-5+ family). */
const OPENAI_REASONING_MODEL = /(?:^|[/:])(?:o[1-9]\d*|gpt-[5-9]\d*|gpt-\d{2,})(?:[.\-]|$)/i;
const OPENAI_XHIGH_MODEL = /(?:^|[/:])(?:gpt-5\.1-codex-max|gpt-5\.[2-9]\d*|gpt-[6-9]\d*|gpt-\d{2,})(?:[.\-]|$)/i;
const OPENAI_GPT5_MINIMAL_MODEL = /(?:^|[/:])gpt-5(?![.\d])(?!-pro(?:[.\-]|$))(?:[.\-]|$)/i;

/** xAI Grok reasoning models. */
const GROK_REASONING_MODEL = /grok-[3-9]/i;
const GROK_XHIGH_MODEL = /grok-(?:4\.[6-9]\d*|[5-9]\d*)(?:[^0-9]|$)/i;

/** Families whose OpenAI-compatible endpoint is known to read only `reasoning_effort` (plus Gemini native fallback). */
const CHAT_EFFORT_ONLY_MODELS = [
  OPENAI_REASONING_MODEL,
  GROK_REASONING_MODEL,
  GEMINI_REASONING_MODEL,
];

function normalizeModelName(model) {
  return typeof model === 'string' ? model.trim() : '';
}

function levelsFromIds(ids) {
  return ids.map(id => LEVEL_BY_ID.get(id)).filter(Boolean);
}

/** True when a Claude model on the Messages API still needs the legacy budget form. */
export function usesLegacyThinkingBudget(model) {
  const name = normalizeModelName(model);
  return Boolean(name) && CLAUDE_LEGACY_BUDGET_MODELS.some(pattern => pattern.test(name));
}

/** True when a Gemini model uses discrete `thinking_level` (Gemini 3+ / 4+). */
export function isGeminiThinkingLevelModel(model) {
  const name = normalizeModelName(model);
  return Boolean(name) && !NON_REASONING_MEDIA_MODEL.test(name) && GEMINI_THINKING_LEVEL_MODEL.test(name);
}

/** True when a Gemini model uses numeric `thinking_budget` (Gemini 2.5). */
export function isGemini25Model(model) {
  const name = normalizeModelName(model);
  return Boolean(name) && !NON_REASONING_MEDIA_MODEL.test(name) && GEMINI_25_MODEL.test(name);
}

/**
 * The reasoning level IDs this model and protocol accept, ordered lowest first.
 * An empty array means this model does not accept reasoning effort control.
 */
export function supportedReasoningLevelIds(model, protocol = 'chat') {
  const name = normalizeModelName(model);
  if (!name || NON_REASONING_MEDIA_MODEL.test(name)) return [];

  // Anthropic Claude family (both Messages API and OpenAI-compatible relays like OpenRouter/LiteLLM).
  if (/claude-/i.test(name)) {
    if (!CLAUDE_THINKING_MODELS.test(name)) return [];
    if (CLAUDE_XHIGH_MODELS.some(pattern => pattern.test(name))) return [...LEVELS_WITH_XHIGH];
    return [...LEVELS_STANDARD];
  }

  // Google Gemini family (matched before generic `thinking` rules so Carbon / 2.0 stay exact).
  if (GEMINI_ANY_MODEL.test(name)) {
    if (!GEMINI_REASONING_MODEL.test(name)) return [];
    if (GEMINI_4_CARBON_MODEL.test(name)) return [...LEVELS_STANDARD];
    if (GEMINI_4_XHIGH_MODEL.test(name)) return [...LEVELS_WITH_XHIGH];
    if (GEMINI_4_PLUS_FLASH_LITE_MODEL.test(name)) return [...LEVELS_WITH_MINIMAL];
    if (GEMINI_4_PLUS_MODEL.test(name)) return [...LEVELS_WITH_XHIGH];
    if (GEMINI_3_MINIMAL_MODEL.test(name)) return [...LEVELS_WITH_MINIMAL];
    return [...LEVELS_STANDARD];
  }

  // OpenAI o-series & GPT-5+ family.
  if (OPENAI_REASONING_MODEL.test(name)) {
    if (OPENAI_XHIGH_MODEL.test(name)) return [...LEVELS_WITH_XHIGH];
    if (OPENAI_GPT5_MINIMAL_MODEL.test(name)) return [...LEVELS_WITH_MINIMAL];
    return [...LEVELS_STANDARD];
  }

  // xAI Grok 3+ family.
  if (GROK_REASONING_MODEL.test(name)) {
    return GROK_XHIGH_MODEL.test(name) ? [...LEVELS_WITH_XHIGH] : [...LEVELS_STANDARD];
  }

  // Other reasoning families (DeepSeek, Qwen, GLM, Kimi, or models explicitly named thinking/reasoner).
  if (OTHER_REASONING_MODELS.some(pattern => pattern.test(name))) {
    return [...LEVELS_STANDARD];
  }

  return [];
}

/**
 * The reasoning levels this model and protocol accept, lowest first.
 * An empty array means the control must not be shown as active for this model.
 */
export function supportedReasoningLevels(model, protocol = 'chat') {
  return levelsFromIds(supportedReasoningLevelIds(model, protocol));
}

/** True when this model can be given a reasoning level on this protocol. */
export function supportsReasoningLevel(model, protocol = 'chat') {
  return supportedReasoningLevelIds(model, protocol).length > 0;
}

/** True when this specific model and protocol directly accept the given reasoning level. */
export function supportsExactReasoningLevel(level, model, protocol = 'chat') {
  return isReasoningLevel(level) && supportedReasoningLevelIds(model, protocol).includes(level);
}

/**
 * The level as the user chose it, independent of any model.
 *
 * Since 3.4.0 this is what is stored: the choice belongs to the connection, so it can be made
 * before a chat model is filled in and it survives switching models. Whether a given request
 * carries it — and whether an out-of-range tier clamps to the model's ceiling/floor — is decided
 * per request by `resolveReasoningLevel` / `reasoningRequestPlan`, against that request's model.
 */
export function storedReasoningLevel(value) {
  return isReasoningLevel(value) ? value : '';
}

/**
 * Resolves a connection's configured reasoning level against a concrete model and protocol.
 *
 * - If the model supports the exact requested level -> `{ effective: requested, clamped: false }`.
 * - If the model supports reasoning control but not this extreme tier (e.g. `xhigh` on
 *   `gemini-4-carbon`, or `minimal` on `gemini-4-neon`) -> clamps to the nearest supported tier
 *   (`xhigh` -> `high`, `minimal` -> `low`) and sets `clamped: true`.
 * - If the model does not support reasoning control -> `{ effective: '', supported: false }`.
 */
export function resolveReasoningLevel(value, model, protocol = 'chat') {
  const requested = storedReasoningLevel(value);
  const supportedIds = supportedReasoningLevelIds(model, protocol);
  if (!requested) {
    return {
      requested: '',
      effective: '',
      supported: supportedIds.length > 0,
      clamped: false,
      supportedIds,
    };
  }
  if (!supportedIds.length) {
    return {
      requested,
      effective: '',
      supported: false,
      clamped: false,
      supportedIds: [],
    };
  }
  if (supportedIds.includes(requested)) {
    return {
      requested,
      effective: requested,
      supported: true,
      clamped: false,
      supportedIds,
    };
  }
  const requestedIndex = LEVEL_IDS.indexOf(requested);
  let effective = supportedIds[0];
  let bestDistance = Infinity;
  for (const candidate of supportedIds) {
    const candidateIndex = LEVEL_IDS.indexOf(candidate);
    const distance = Math.abs(candidateIndex - requestedIndex);
    if (distance < bestDistance || (distance === bestDistance && candidateIndex < LEVEL_IDS.indexOf(effective))) {
      bestDistance = distance;
      effective = candidate;
    }
  }
  return {
    requested,
    effective,
    supported: true,
    clamped: true,
    supportedIds,
  };
}

/**
 * Returns the effective reasoning level for a model and protocol (clamped when the model supports
 * reasoning control with a narrower range, or '' when nothing should be sent).
 */
export function normalizeReasoningLevel(value, model, protocol = 'chat') {
  return resolveReasoningLevel(value, model, protocol).effective;
}

const anthropicAdaptive = level => ({ thinking: { type: 'adaptive' }, output_config: { effort: level } });
const anthropicBudget = level => ({ thinking: { type: 'enabled', budget_tokens: reasoningBudget(level) } });
const geminiThinkingLevelBody = level => ({ extra_body: { google: { thinking_config: { thinking_level: level } } } });
const geminiThinkingBudgetBody = level => ({ extra_body: { google: { thinking_config: { thinking_budget: reasoningBudget(level) } } } });

function stepDownLevel(level) {
  if (level === 'xhigh') return 'high';
  if (level === 'minimal') return 'low';
  return '';
}

/**
 * Full reasoning request plan for one model and protocol: resolved level metadata plus the ordered
 * list of wire variants to attempt. Each variant entry carries `{ body, level, downgraded, downgradedFrom? }`.
 *
 * - `anthropic`:
 *     - legacy Claude (3.7 / 4.0 / 4.1 / 4.5) -> budget, then adaptive.
 *     - modern Claude (4.6+ / 4.7+ / 5+) and other models over Anthropic-compatible endpoints ->
 *       adaptive, then budget; for `xhigh`/`minimal`, also step-down fallbacks (`high`/`low`)
 *       if the upstream endpoint rejects the extreme tier.
 * - `responses`:
 *     - nested `reasoning.effort`, with step-down fallback for `xhigh`/`minimal`.
 * - `chat`:
 *     - Gemini 3+ / 4+ -> `reasoning_effort`, then Google's OpenAI-compat
 *       `extra_body.google.thinking_config.thinking_level`, then (for `xhigh`/`minimal`)
 *       OpenRouter's `reasoning.effort`, then step-down (`high`/`low`) variants.
 *     - Gemini 2.5 -> `reasoning_effort`, then `extra_body.google.thinking_config.thinking_budget`.
 *     - OpenAI / Grok -> `reasoning_effort`, plus (for `xhigh`/`minimal`) `reasoning.effort` and
 *       step-down `reasoning_effort`.
 *     - Other reasoning families -> ZCode's mixed Chat Completions form, then `reasoning_effort`
 *       alone, plus step-down for `xhigh`/`minimal`.
 */
export function reasoningRequestPlan(level, model, protocol = 'chat') {
  const resolution = resolveReasoningLevel(level, model, protocol);
  const effective = resolution.effective;
  if (!effective) return { ...resolution, variants: [] };

  const fallback = stepDownLevel(effective);
  const name = normalizeModelName(model);
  const variants = [];
  const push = (body, variantLevel = effective, downgraded = false) => {
    variants.push({
      body,
      level: variantLevel,
      downgraded,
      ...(downgraded ? { downgradedFrom: effective } : {}),
    });
  };

  if (protocol === 'anthropic') {
    if (usesLegacyThinkingBudget(name)) {
      push(anthropicBudget(effective));
      push(anthropicAdaptive(effective));
    } else {
      push(anthropicAdaptive(effective));
      push(anthropicBudget(effective));
      if (fallback) {
        push(anthropicAdaptive(fallback), fallback, true);
        push(anthropicBudget(fallback), fallback, true);
      }
    }
    return { ...resolution, variants };
  }

  if (protocol === 'responses') {
    push({ reasoning: { effort: effective } });
    if (fallback) {
      push({ reasoning: { effort: fallback } }, fallback, true);
    }
    return { ...resolution, variants };
  }

  // protocol === 'chat'
  if (isGeminiThinkingLevelModel(name)) {
    push({ reasoning_effort: effective });
    push(geminiThinkingLevelBody(effective));
    if (fallback) {
      push({ reasoning: { effort: effective } });
      push({ reasoning_effort: fallback }, fallback, true);
      push(geminiThinkingLevelBody(fallback), fallback, true);
    }
    return { ...resolution, variants };
  }

  if (isGemini25Model(name)) {
    push({ reasoning_effort: effective });
    push(geminiThinkingBudgetBody(effective));
    return { ...resolution, variants };
  }

  if (CHAT_EFFORT_ONLY_MODELS.some(pattern => pattern.test(name))) {
    push({ reasoning_effort: effective });
    if (fallback) {
      push({ reasoning: { effort: effective } });
      push({ reasoning_effort: fallback }, fallback, true);
    }
    return { ...resolution, variants };
  }

  push({ thinking: { type: 'enabled' }, enable_thinking: true, reasoning_effort: effective, reasoning: { effort: effective } });
  push({ reasoning_effort: effective });
  if (fallback) {
    push({ reasoning: { effort: effective } });
    push({ reasoning_effort: fallback }, fallback, true);
  }
  return { ...resolution, variants };
}

/**
 * Every wire body spelling worth trying for one level, most likely first. An empty array means no
 * field may be sent at all. The request layer always ends with "no reasoning field" after these.
 */
export function reasoningRequestVariants(level, model, protocol = 'chat') {
  return reasoningRequestPlan(level, model, protocol).variants.map(entry => entry.body);
}

/** The fields one level adds to a request body: the first spelling, or `{}` when none applies. */
export function reasoningRequestBody(level, model, protocol = 'chat') {
  return reasoningRequestVariants(level, model, protocol)[0] ?? {};
}

/** Every top-level request field any spelling above may write; dropped together on a retry. */
export const REASONING_BODY_FIELDS = ['thinking', 'output_config', 'enable_thinking', 'reasoning_effort', 'reasoning', 'extra_body'];
