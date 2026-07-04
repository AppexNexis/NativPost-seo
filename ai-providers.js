// ─────────────────────────────────────────────────────────────────────────────
// NativPost AI Provider Abstraction Layer
// ─────────────────────────────────────────────────────────────────────────────
// Provider-agnostic interface supporting Claude (primary), DeepSeek (secondary),
// and OpenAI (final fallback).  Add new providers by registering them in
// PROVIDERS below and adding them to the FALLBACK_CHAIN array.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');

// ── Configuration ──────────────────────────────────────────────────────────

/** Ordered fallback chain: first available provider with a key is tried first. */
const FALLBACK_CHAIN = ['claude', 'deepseek', 'openai'];

const PROVIDERS = {
  claude: {
    name: 'Claude (Anthropic)',
    keyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    defaultModel: 'claude-opus-4-5',
    endpoint: 'https://api.anthropic.com/v1/messages',
    headers(key) {
      return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
    },
    formatRequest(prompt, opts) {
      return {
        model: opts.model,
        max_tokens: opts.maxTokens || 12000,
        messages: [{ role: 'user', content: prompt }]
      };
    },
    parseResponse(data) {
      return data?.content?.[0]?.text || '';
    },
    formatExtendRequest(prompt, opts) {
      return {
        model: opts.model,
        max_tokens: opts.maxTokens || 8000,
        messages: [{ role: 'user', content: prompt }]
      };
    },
    parseExtendResponse(data) {
      return data?.content?.[0]?.text || '';
    },
    // Health-check: list models to verify the key is valid
    async healthCheck(key) {
      await axios.get('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        timeout: 15000
      });
    },
    healthCheckLabel: 'Anthropic Claude API connected. Check console.anthropic.com/settings/billing for usage.',
  },

  deepseek: {
    name: 'DeepSeek',
    keyEnv: 'DEEPSEEK_API_KEY',
    modelEnv: 'DEEPSEEK_MODEL',
    defaultModel: 'deepseek-v4-flash',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    headers(key) {
      return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    },
    // DeepSeek uses OpenAI-compatible chat completions format
    formatRequest(prompt, opts) {
      return {
        model: opts.model,
        max_tokens: opts.maxTokens || 12000,
        messages: [{ role: 'user', content: prompt }]
      };
    },
    parseResponse(data) {
      return data?.choices?.[0]?.message?.content || '';
    },
    formatExtendRequest(prompt, opts) {
      return {
        model: opts.model,
        max_tokens: opts.maxTokens || 8000,
        messages: [{ role: 'user', content: prompt }]
      };
    },
    parseExtendResponse(data) {
      return data?.choices?.[0]?.message?.content || '';
    },
    async healthCheck(key) {
      // DeepSeek has no free list-models endpoint; a minimal chat completion with
      // max_tokens=1 verifies the key without consuming meaningful quota.
      await axios.post(
        'https://api.deepseek.com/v1/chat/completions',
        { model: 'deepseek-v4-flash', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
        { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 15000 }
      );
    },
    healthCheckLabel: 'DeepSeek API connected. Check platform.deepseek.com/usage for billing.',
  },

  openai: {
    name: 'OpenAI (GPT)',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-4.1',
    endpoint: 'https://api.openai.com/v1/responses',
    headers(key) {
      return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    },
    // OpenAI uses the Responses API (not chat completions)
    formatRequest(prompt, opts) {
      return {
        model: opts.model,
        input: prompt,
        max_output_tokens: opts.maxTokens || 12000
      };
    },
    parseResponse(data) {
      let text = data?.output_text || '';
      if (!text && Array.isArray(data?.output)) {
        text = data.output.flatMap(o => (o.content || []).map(c => c.text || '')).join('\n');
      }
      return text;
    },
    formatExtendRequest(prompt, opts) {
      return {
        model: opts.model,
        input: prompt,
        max_output_tokens: opts.maxTokens || 8000
      };
    },
    parseExtendResponse(data) {
      let text = data?.output_text || '';
      if (!text && Array.isArray(data?.output)) {
        text = data.output.flatMap(o => (o.content || []).map(c => c.text || '')).join('\n');
      }
      return text;
    },
    async healthCheck(key) {
      await axios.get('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` }, timeout: 15000
      });
    },
    healthCheckLabel: 'OpenAI does not expose a prepaid credit balance via API. Check platform.openai.com/usage.',
  },
};

// ── Call log (in-memory ring buffer for monitoring) ──────────────────────

const MAX_LOG_ENTRIES = 2000;
const _callLog = [];

/**
 * Append a structured entry to the in-memory call log.
 * Exposed so the dashboard route can surface recent provider activity.
 */
function logCall(entry) {
  _callLog.push({ t: Date.now(), ...entry });
  if (_callLog.length > MAX_LOG_ENTRIES) {
    _callLog.splice(0, _callLog.length - MAX_LOG_ENTRIES);
  }
}

/** Return a copy of recent call-log entries (newest last). */
function getCallLog() {
  return _callLog.slice();
}

// ── Core: callAI ──────────────────────────────────────────────────────────

/**
 * Call an AI provider with automatic fallback through the configured chain.
 *
 * @param {string} prompt          - The prompt text.
 * @param {object} [opts]          - Options.
 * @param {number} [opts.timeout]  - Per-provider request timeout in ms (default 180000).
 * @param {number} [opts.maxTokens]- Max output tokens (default 12000).
 * @param {string[]} [opts.chain]  - Override fallback chain (default FALLBACK_CHAIN).
 * @param {boolean} [opts.throwOnAllFail] - If true, throw when EVERY provider in the
 *   chain fails instead of returning null (default false).
 *
 * @returns {Promise<{provider:string, model:string, text:string, duration:number, raw:object}|null>}
 */
async function callAI(prompt, opts = {}) {
  const chain = opts.chain || FALLBACK_CHAIN;
  const errors = [];

  for (const providerName of chain) {
    const provider = PROVIDERS[providerName];
    if (!provider) {
      errors.push({ provider: providerName, reason: 'Unknown provider' });
      continue;
    }

    const apiKey = process.env[provider.keyEnv];
    if (!apiKey) {
      logCall({ provider: providerName, status: 'skipped', reason: `No ${provider.keyEnv} set` });
      continue;
    }

    const model = process.env[provider.modelEnv] || provider.defaultModel;
    const startTime = Date.now();

    try {
      const requestBody = provider.formatRequest(prompt, { ...opts, model });
      const response = await axios.post(provider.endpoint, requestBody, {
        headers: provider.headers(apiKey),
        timeout: opts.timeout || 180000,
      });

      const duration = Date.now() - startTime;
      const text = provider.parseResponse(response.data);

      if (!text) {
        logCall({ provider: providerName, model, status: 'empty', duration });
        console.warn(`[AI] ${providerName} returned empty response — falling back`);
        continue;
      }

      logCall({
        provider: providerName,
        model,
        status: 'success',
        duration,
        tokenUsage: response.data?.usage || null,
      });

      return { provider: providerName, model, text, duration, raw: response.data };
    } catch (err) {
      const duration = Date.now() - startTime;
      const errorEntry = {
        provider: providerName,
        model: process.env[provider.modelEnv] || provider.defaultModel,
        status: 'error',
        duration,
        error: err.message,
        statusCode: err.response?.status,
        errorBody: err.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : null,
      };
      errors.push(errorEntry);
      logCall(errorEntry);
      console.error(`[AI] ${providerName} failed (${err.message}) — trying next provider`);
    }
  }

  if (opts.throwOnAllFail) {
    const summary = errors.map(e => `${e.provider}: ${e.error}`).join('; ');
    throw new Error(`All AI providers failed: ${summary}`);
  }

  return null;
}

/**
 * Call an AI provider for a body-extension request (shorter timeout, smaller
 * token limit).  Uses the same provider chain as callAI.
 */
async function callAIExtend(prompt, opts = {}) {
  return callAI(prompt, { ...opts, maxTokens: opts.maxTokens || 8000, timeout: opts.timeout || 120000 });
}

// ── Provider health checks (for API-balance monitoring) ──────────────────

/**
 * Verify connectivity for every enabled provider.  Returns a map of
 * provider-name → { status: 'ok'|'error', label, error? }.
 */
async function checkAllProviders() {
  const results = {};
  for (const pName of Object.keys(PROVIDERS)) {
    const provider = PROVIDERS[pName];
    const apiKey = process.env[provider.keyEnv];
    if (!apiKey) {
      results[pName] = { status: 'skipped', label: `${provider.name} — no API key configured` };
      continue;
    }
    try {
      await provider.healthCheck(apiKey);
      results[pName] = { status: 'ok', label: provider.healthCheckLabel };
    } catch (err) {
      results[pName] = {
        status: 'error',
        label: `${provider.name} connection failed`,
        error: err.message,
      };
    }
  }
  return results;
}

// ── Convenience helpers ──────────────────────────────────────────────────

/** True when at least one provider API key is present. */
function hasAI() {
  return Object.keys(PROVIDERS).some(pName => !!process.env[PROVIDERS[pName].keyEnv]);
}

/** Return a map of provider-name → boolean (key is configured). */
function providerKeyStatus() {
  const out = {};
  for (const [pName, p] of Object.entries(PROVIDERS)) {
    out[pName] = !!process.env[p.keyEnv];
  }
  return out;
}

// ── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  FALLBACK_CHAIN,
  PROVIDERS,
  callAI,
  callAIExtend,
  checkAllProviders,
  getCallLog,
  hasAI,
  providerKeyStatus,
  logCall,
};
