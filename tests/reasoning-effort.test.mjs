import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import {
  REASONING_LEVELS,
  REASONING_LEVEL_IDS,
  isReasoningLevel,
  reasoningBudget,
  supportedReasoningLevelIds,
  supportedReasoningLevels,
  supportsReasoningLevel,
  supportsExactReasoningLevel,
  resolveReasoningLevel,
  normalizeReasoningLevel,
  reasoningRequestPlan,
  reasoningRequestVariants,
  reasoningRequestBody,
} from '../app/shared/reasoning-effort.mjs';
import { completion, ANTHROPIC_MAX_TOKENS, ANTHROPIC_XHIGH_MAX_TOKENS } from '../app/server/provider.mjs';
import { Store } from '../app/server/store.mjs';

async function startMockServer(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    await handler(req, res, body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('canonical 5-tier reasoning ladder and budgets', () => {
  assert.deepEqual(REASONING_LEVEL_IDS, ['minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(REASONING_LEVELS.length, 5);
  for (const id of REASONING_LEVEL_IDS) {
    assert.equal(isReasoningLevel(id), true);
    assert.ok(Number.isInteger(reasoningBudget(id)) && reasoningBudget(id) >= 1_024);
  }
  assert.equal(isReasoningLevel('ultra'), false);
  assert.equal(isReasoningLevel(''), false);
  assert.ok(reasoningBudget('xhigh') > reasoningBudget('high'));
});

test('Google AI Studio Gemini 4 & 3.5 model capability matrix', () => {
  // Exact table from Google AI Studio choosing-a-model docs
  assert.deepEqual(supportedReasoningLevelIds('gemini-4-carbon'), ['low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('google/gemini-4-carbon-preview'), ['low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('gemini-4-neon'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(supportedReasoningLevelIds('models/gemini-4-neon-001'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(supportedReasoningLevelIds('gemini-4-hydrogen'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(supportedReasoningLevelIds('vertex/gemini-4-hydrogen-preview'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(supportedReasoningLevelIds('gemini-3.5-flash-lite'), ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('gemini-3.1-flash-lite-preview'), ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('gemini-3-flash-preview'), ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('gemini-3.8-flash'), ['low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('gemini-3-pro-preview'), ['low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('gemini-2.5-pro'), ['low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('gemini-2.5-flash'), ['low', 'medium', 'high']);

  // Non-reasoning / media Gemini models
  assert.deepEqual(supportedReasoningLevelIds('gemini-2.0-flash'), []);
  assert.deepEqual(supportedReasoningLevelIds('gemini-2.0-flash-thinking-exp'), []);
  assert.deepEqual(supportedReasoningLevelIds('gemini-1.5-pro'), []);
  assert.deepEqual(supportedReasoningLevelIds('gemini-3-pro-image-preview'), []);
  assert.deepEqual(supportedReasoningLevelIds('gemini-2.5-flash-image'), []);

  assert.equal(supportsExactReasoningLevel('xhigh', 'gemini-4-neon'), true);
  assert.equal(supportsExactReasoningLevel('xhigh', 'gemini-4-hydrogen'), true);
  assert.equal(supportsExactReasoningLevel('xhigh', 'gemini-4-carbon'), false);
  assert.equal(supportsExactReasoningLevel('minimal', 'gemini-4-neon'), false);
  assert.equal(supportsExactReasoningLevel('minimal', 'gemini-3.5-flash-lite'), true);
  assert.equal(supportsExactReasoningLevel('xhigh', 'gemini-3.5-flash-lite'), false);
});

test('OpenAI, Anthropic, Grok and other reasoning families capability matrix', () => {
  assert.deepEqual(supportedReasoningLevelIds('gpt-5'), ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('openai/gpt-5-mini-2025-08-07'), ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('gpt-5.1'), ['low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('gpt-5.1-codex-max'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(supportedReasoningLevelIds('gpt-5.2'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(supportedReasoningLevelIds('gpt-5.4'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(supportedReasoningLevelIds('o3'), ['low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('o4-mini'), ['low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('gpt-4o'), []);

  assert.deepEqual(supportedReasoningLevelIds('claude-opus-4-7', 'anthropic'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(supportedReasoningLevelIds('claude-sonnet-4-7', 'anthropic'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(supportedReasoningLevelIds('claude-4-7-opus', 'anthropic'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(supportedReasoningLevelIds('claude-sonnet-5', 'anthropic'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(supportedReasoningLevelIds('claude-opus-4-6', 'anthropic'), ['low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('claude-sonnet-4-5', 'anthropic'), ['low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('claude-3-7-sonnet', 'anthropic'), ['low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('claude-3-5-sonnet', 'anthropic'), []);

  assert.deepEqual(supportedReasoningLevelIds('grok-4'), ['low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('grok-4.6'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(supportedReasoningLevelIds('deepseek-r1'), ['low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('deepseek-v3'), []);
  assert.deepEqual(supportedReasoningLevelIds('qwen3-235b'), ['low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('glm-4.5'), ['low', 'medium', 'high']);
  assert.deepEqual(supportedReasoningLevelIds('glm-4-flash'), []);
});

test('resolveReasoningLevel clamps unsupported extreme tiers transparently', () => {
  const carbonXhigh = resolveReasoningLevel('xhigh', 'gemini-4-carbon', 'chat');
  assert.deepEqual(carbonXhigh, {
    requested: 'xhigh',
    effective: 'high',
    supported: true,
    clamped: true,
    supportedIds: ['low', 'medium', 'high'],
  });
  assert.equal(normalizeReasoningLevel('xhigh', 'gemini-4-carbon', 'chat'), 'high');

  const neonMinimal = resolveReasoningLevel('minimal', 'gemini-4-neon', 'chat');
  assert.deepEqual(neonMinimal, {
    requested: 'minimal',
    effective: 'low',
    supported: true,
    clamped: true,
    supportedIds: ['low', 'medium', 'high', 'xhigh'],
  });

  const neonXhigh = resolveReasoningLevel('xhigh', 'gemini-4-neon', 'chat');
  assert.equal(neonXhigh.effective, 'xhigh');
  assert.equal(neonXhigh.clamped, false);

  const flashLiteXhigh = resolveReasoningLevel('xhigh', 'gemini-3.5-flash-lite', 'chat');
  assert.equal(flashLiteXhigh.effective, 'high');
  assert.equal(flashLiteXhigh.clamped, true);

  const opus46Xhigh = resolveReasoningLevel('xhigh', 'claude-opus-4-6', 'anthropic');
  assert.equal(opus46Xhigh.effective, 'high');
  assert.equal(opus46Xhigh.clamped, true);

  const plainGpt4o = resolveReasoningLevel('xhigh', 'gpt-4o', 'chat');
  assert.equal(plainGpt4o.effective, '');
  assert.equal(plainGpt4o.supported, false);
  assert.equal(plainGpt4o.clamped, false);
});

test('reasoningRequestPlan produces ordered wire variants with native fallbacks', () => {
  const neonChat = reasoningRequestVariants('xhigh', 'gemini-4-neon', 'chat');
  assert.deepEqual(neonChat[0], { reasoning_effort: 'xhigh' });
  assert.deepEqual(neonChat[1], { extra_body: { google: { thinking_config: { thinking_level: 'xhigh' } } } });
  assert.deepEqual(neonChat[2], { reasoning: { effort: 'xhigh' } });
  assert.deepEqual(neonChat[3], { reasoning_effort: 'high' });
  assert.deepEqual(neonChat[4], { extra_body: { google: { thinking_config: { thinking_level: 'high' } } } });

  // Gemini 4 Carbon clamps xhigh -> high before hitting wire
  const carbonChat = reasoningRequestVariants('xhigh', 'gemini-4-carbon', 'chat');
  assert.deepEqual(carbonChat[0], { reasoning_effort: 'high' });
  assert.deepEqual(carbonChat[1], { extra_body: { google: { thinking_config: { thinking_level: 'high' } } } });
  assert.equal(carbonChat.length, 2);

  // Gemini 2.5 uses thinking_budget (never thinking_level)
  const g25 = reasoningRequestVariants('xhigh', 'gemini-2.5-pro', 'chat');
  assert.deepEqual(g25[0], { reasoning_effort: 'high' });
  assert.deepEqual(g25[1], { extra_body: { google: { thinking_config: { thinking_budget: 24_576 } } } });

  // Claude 4.7 Anthropic adaptive xhigh
  const claude47 = reasoningRequestPlan('xhigh', 'claude-opus-4-7', 'anthropic');
  assert.deepEqual(claude47.variants[0].body, { thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } });
  assert.equal(claude47.variants[0].downgraded, false);
  assert.deepEqual(claude47.variants[2].body, { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
  assert.equal(claude47.variants[2].downgraded, true);
  assert.equal(claude47.variants[2].downgradedFrom, 'xhigh');

  // OpenAI Responses xhigh
  const gpt54 = reasoningRequestBody('xhigh', 'gpt-5.4', 'responses');
  assert.deepEqual(gpt54, { reasoning: { effort: 'xhigh' } });
});

test('UI model-utils.js maintains exact parity with shared/reasoning-effort.mjs', async () => {
  const uiSource = await readFile(new URL('../app/ui/src/model-utils.js', import.meta.url), 'utf8');
  const distSource = await readFile(new URL('../app/dist/src/model-utils.js', import.meta.url), 'utf8');
  assert.equal(uiSource.includes("id: 'xhigh'"), true);
  assert.equal(uiSource.includes("id: 'minimal'"), true);
  assert.equal(distSource.includes("id: 'xhigh'"), true);
  assert.equal(distSource.includes("id: 'minimal'"), true);

  // Evaluate the pure reasoning-effort section of model-utils.js in isolation to verify 100% parity.
  const startMarker = 'export const REASONING_LEVELS =';
  const endMarker = '/* -------------------------------------------------------------------------- */\n/* Settings Drafts';
  const start = uiSource.indexOf(startMarker);
  const end = uiSource.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, 'reasoning section bounds found in model-utils.js');
  const pureCode = uiSource
    .slice(start, end)
    .replace(/\bexport\s+/g, '')
    + '\nreturn { REASONING_LEVELS, getSupportedReasoningLevelIds, resolveReasoningEffort, supportsReasoningEffort };';
  const uiHelpers = new Function(pureCode)();

  assert.deepEqual(uiHelpers.REASONING_LEVELS, REASONING_LEVELS);
  const sampleModels = [
    'gemini-4-carbon',
    'gemini-4-neon',
    'gemini-4-hydrogen',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3-flash-preview',
    'gemini-3.8-flash',
    'gemini-3-pro-preview',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-3-pro-image',
    'gpt-5',
    'gpt-5.1',
    'gpt-5.1-codex-max',
    'gpt-5.2',
    'gpt-5.4',
    'o3',
    'gpt-4o',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-5',
    'claude-3-7-sonnet',
    'claude-3-5-sonnet',
    'grok-4',
    'grok-4.6',
    'deepseek-r1',
    'deepseek-v3',
    'qwen3-32b',
    'glm-4.5',
    'kimi-k2-thinking',
  ];
  for (const protocol of ['chat', 'anthropic', 'responses']) {
    for (const model of sampleModels) {
      assert.deepEqual(
        uiHelpers.getSupportedReasoningLevelIds(model, protocol),
        supportedReasoningLevelIds(model, protocol),
        `supportedIds mismatch for ${protocol}/${model}`,
      );
      assert.equal(
        uiHelpers.supportsReasoningEffort(model, protocol),
        supportsReasoningLevel(model, protocol),
        `supports mismatch for ${protocol}/${model}`,
      );
      for (const level of ['', ...REASONING_LEVEL_IDS]) {
        assert.deepEqual(
          uiHelpers.resolveReasoningEffort(level, model, protocol),
          resolveReasoningLevel(level, model, protocol),
          `resolve mismatch for ${protocol}/${model}/${level}`,
        );
      }
    }
  }
});

test('Store accepts minimal and xhigh and rejects unknown levels with updated error message', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hg-reasoning-store-'));
  try {
    const store = await new Store({
      dataDir: path.join(dir, 'data'),
      defaultWorkspace: path.join(dir, 'ws'),
    }).init();

    await store.updateSettings({ reasoningEffort: 'xhigh' });
    assert.equal(store.settings.reasoningEffort, 'xhigh');

    await store.updateSettings({ reasoningEffort: 'minimal' });
    assert.equal(store.settings.reasoningEffort, 'minimal');

    await assert.rejects(
      () => store.updateSettings({ reasoningEffort: 'ultra' }),
      err => err?.status === 400 && /minimal、low、medium、high 或 xhigh/.test(err.message),
    );

    // Reload from disk to verify persistence of xhigh
    await store.updateSettings({ reasoningEffort: 'xhigh' });
    const reloaded = await new Store({
      dataDir: path.join(dir, 'data'),
      defaultWorkspace: path.join(dir, 'ws'),
    }).init();
    assert.equal(reloaded.settings.reasoningEffort, 'xhigh');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider chatCompletion sends xhigh to Gemini 4 Neon and clamps xhigh to high on Carbon', async () => {
  const seen = [];
  const mock = await startMockServer(async (req, res, body) => {
    seen.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }));
  });
  try {
    const notices = [];
    await completion({
      settings: { protocol: 'chat', baseUrl: mock.baseUrl, apiKey: 'test-key', reasoningEffort: 'xhigh' },
      model: 'gemini-4-neon',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      onNotice: info => notices.push(info.message),
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].reasoning_effort, 'xhigh');
    assert.equal(notices.length, 0);

    await completion({
      settings: { protocol: 'chat', baseUrl: mock.baseUrl, apiKey: 'test-key', reasoningEffort: 'xhigh' },
      model: 'gemini-4-carbon',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      onNotice: info => notices.push(info.message),
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[1].reasoning_effort, 'high');
    assert.equal(notices.length, 0);
  } finally {
    await mock.close();
  }
});

test('provider chatCompletion falls back to Google extra_body thinking_level xhigh when reasoning_effort xhigh is rejected', async () => {
  const seen = [];
  const mock = await startMockServer(async (req, res, body) => {
    seen.push(body);
    if (body.reasoning_effort === 'xhigh') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "Invalid value: 'xhigh'. Supported values are: 'low', 'medium', and 'high'." } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'xhigh-via-extra-body' }, finish_reason: 'stop' }],
    }));
  });
  try {
    const notices = [];
    let output = '';
    await completion({
      settings: { protocol: 'chat', baseUrl: mock.baseUrl, apiKey: 'test-key', reasoningEffort: 'xhigh' },
      model: 'gemini-4-hydrogen',
      messages: [{ role: 'user', content: 'solve' }],
      stream: false,
      onText: t => { output += t; },
      onNotice: info => notices.push(info.message),
    });
    assert.equal(output, 'xhigh-via-extra-body');
    assert.equal(seen.length, 2);
    assert.equal(seen[0].reasoning_effort, 'xhigh');
    assert.equal('reasoning_effort' in seen[1], false);
    assert.deepEqual(seen[1].extra_body, { google: { thinking_config: { thinking_level: 'xhigh' } } });
    // Succeeded at xhigh via native fallback -> no downgrade notice!
    assert.equal(notices.length, 0);
  } finally {
    await mock.close();
  }
});

test('provider chatCompletion steps down xhigh -> high with notice when relay rejects all xhigh spellings', async () => {
  const seen = [];
  const mock = await startMockServer(async (req, res, body) => {
    seen.push(body);
    if (body.reasoning_effort === 'xhigh') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "Invalid value: 'xhigh'. Expected 'low' | 'medium' | 'high'." } }));
      return;
    }
    if (body.extra_body) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unknown field: extra_body is not allowed' } }));
      return;
    }
    if (body.reasoning) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unrecognized field: reasoning' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok-at-high' }, finish_reason: 'stop' }],
    }));
  });
  try {
    const notices = [];
    let output = '';
    await completion({
      settings: { protocol: 'chat', baseUrl: mock.baseUrl, apiKey: 'test-key', reasoningEffort: 'xhigh' },
      model: 'gemini-4-neon',
      messages: [{ role: 'user', content: 'solve' }],
      stream: false,
      onText: t => { output += t; },
      onNotice: info => notices.push(info.message),
    });
    assert.equal(output, 'ok-at-high');
    assert.equal(seen.length, 4);
    assert.equal(seen[3].reasoning_effort, 'high');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /超高（xhigh）/);
    assert.match(notices[0], /高（high）/);
  } finally {
    await mock.close();
  }
});

test('provider chatCompletion preserves Gemini 4 extra_content.google.thought_signature on tool_calls', async () => {
  const mock = await startMockServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_gemini_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
            extra_content: { google: { thought_signature: 'AY89_TEST_SIGNATURE_XYZ' } },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const result = await completion({
      settings: { protocol: 'chat', baseUrl: mock.baseUrl, apiKey: 'test-key', reasoningEffort: 'xhigh' },
      model: 'gemini-4-neon',
      messages: [{ role: 'user', content: 'read a.txt' }],
      stream: true,
    });
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].id, 'call_gemini_1');
    assert.deepEqual(result.toolCalls[0].extra_content, {
      google: { thought_signature: 'AY89_TEST_SIGNATURE_XYZ' },
    });
  } finally {
    await mock.close();
  }
});

test('provider anthropicCompletion sends 64K max_tokens for xhigh and handles effort rejection + max_tokens step-down', async () => {
  const seen = [];
  const mock = await startMockServer(async (req, res, body) => {
    seen.push(body);
    // Reject 64K max_tokens without naming a limit -> should step down to 32K (not 8K!)
    if (body.max_tokens > ANTHROPIC_MAX_TOKENS && body.output_config?.effort === 'xhigh') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'max_tokens is too large' } }));
      return;
    }
    // Reject xhigh effort (like a lagging gateway) and legacy budget_tokens -> should fall back to adaptive high
    if (body.output_config?.effort === 'xhigh') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "This model does not support effort level 'xhigh'" } }));
      return;
    }
    if (body.thinking?.type === 'enabled') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'budget_tokens is deprecated; requires adaptive thinking' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      content: [{ type: 'text', text: 'claude-ok' }],
      stop_reason: 'end_turn',
    }));
  });
  try {
    const notices = [];
    let output = '';
    await completion({
      settings: { protocol: 'anthropic', baseUrl: mock.baseUrl, apiKey: 'test-key', reasoningEffort: 'xhigh' },
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'analyze' }],
      stream: false,
      onText: t => { output += t; },
      onNotice: info => notices.push(info.message),
    });
    assert.equal(output, 'claude-ok');
    assert.equal(seen[0].max_tokens, ANTHROPIC_XHIGH_MAX_TOKENS);
    assert.deepEqual(seen[0].output_config, { effort: 'xhigh' });
    // Second request stepped max_tokens down to 32K while still trying xhigh
    assert.equal(seen[1].max_tokens, ANTHROPIC_MAX_TOKENS);
    assert.deepEqual(seen[1].output_config, { effort: 'xhigh' });
    // Final succeeded request used adaptive high at 32K
    const last = seen.at(-1);
    assert.deepEqual(last.thinking, { type: 'adaptive' });
    assert.deepEqual(last.output_config, { effort: 'high' });
    assert.equal(last.max_tokens, ANTHROPIC_MAX_TOKENS);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /超高（xhigh）/);
  } finally {
    await mock.close();
  }
});

test('provider responsesCompletion sends xhigh and falls back to high with notice if rejected', async () => {
  const seen = [];
  const mock = await startMockServer(async (req, res, body) => {
    seen.push(body);
    if (body.reasoning?.effort === 'xhigh') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "Unsupported value: 'xhigh' is not supported for reasoning.effort" } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'responses-ok' }] }],
    }));
  });
  try {
    const notices = [];
    let output = '';
    await completion({
      settings: { protocol: 'responses', baseUrl: mock.baseUrl, apiKey: 'test-key', reasoningEffort: 'xhigh' },
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'solve' }],
      stream: false,
      onText: t => { output += t; },
      onNotice: info => notices.push(info.message),
    });
    assert.equal(output, 'responses-ok');
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0].reasoning, { effort: 'xhigh' });
    assert.deepEqual(seen[1].reasoning, { effort: 'high' });
    assert.equal(notices.length, 1);
    assert.match(notices[0], /超高（xhigh）/);
  } finally {
    await mock.close();
  }
});
