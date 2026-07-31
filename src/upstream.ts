/**
 * Resolve which upstream serves a model id, and call OpenAI-compatible HTTP APIs.
 *
 * Privacy: never log request/response bodies or API keys.
 */

export type UpstreamProvider = 'workers-ai' | 'openai' | 'openrouter';

export type UpstreamEnv = {
  OPENAI_API_KEY?: string;
  /** Override OpenAI base (default https://api.openai.com/v1). No trailing slash. */
  OPENAI_BASE_URL?: string;
  OPENROUTER_API_KEY?: string;
  /** Override OpenRouter base (default https://openrouter.ai/api/v1). */
  OPENROUTER_BASE_URL?: string;
};

export type ResolvedUpstream = {
  provider: UpstreamProvider;
  /** Model id sent to that upstream (may differ from operator-facing id). */
  model: string;
};

/** Friendly aliases operators might type. */
const MODEL_ALIASES: Record<string, string> = {
  'chatgpt-4o-mini': 'gpt-4o-mini',
  'chatgpt-4o': 'gpt-4o',
  'openai/chatgpt-4o-mini': 'gpt-4o-mini',
  'openai/chatgpt-4o': 'gpt-4o',
};

/**
 * Decide provider + upstream model id from an operator/client model string.
 *
 * - `@cf/...` → Workers AI binding
 * - `openai/gpt-4o-mini` or bare `gpt-4o-mini` → OpenAI
 * - `openrouter/…` or other `provider/model` → OpenRouter
 */
export function resolveUpstream(modelId: string): ResolvedUpstream {
  let m = modelId.trim();
  const aliased = MODEL_ALIASES[m] ?? MODEL_ALIASES[m.toLowerCase()];
  if (aliased)
    m = aliased;

  if (m.startsWith('@cf/'))
    return { provider: 'workers-ai', model: m };

  if (m.startsWith('openrouter/'))
    return { provider: 'openrouter', model: m.slice('openrouter/'.length) };

  // openai/gpt-4o-mini → OpenAI API model gpt-4o-mini
  if (m.startsWith('openai/'))
    return { provider: 'openai', model: m.slice('openai/'.length) };

  // Bare OpenAI-family ids
  if (/^(gpt-|o[0-9]|chatgpt-|text-embedding|whisper|tts-)/i.test(m))
    return { provider: 'openai', model: m };

  // org/model (anthropic/…, google/…, meta-llama/…) → OpenRouter
  if (m.includes('/') && !m.startsWith('@'))
    return { provider: 'openrouter', model: m };

  // Unknown bare id: try OpenAI (operator can use custom base URL)
  return { provider: 'openai', model: m };
}

function openaiError(status: number, message: string, code = 'upstream'): Response {
  return new Response(JSON.stringify({
    error: { message, code, type: 'upstream_error' },
  }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function baseUrl(env: UpstreamEnv, provider: 'openai' | 'openrouter'): string {
  if (provider === 'openai') {
    const u = (env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
    return u || 'https://api.openai.com/v1';
  }
  const u = (env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').trim().replace(/\/+$/, '');
  return u || 'https://openrouter.ai/api/v1';
}

function authHeaders(env: UpstreamEnv, provider: 'openai' | 'openrouter'): HeadersInit | null {
  if (provider === 'openai') {
    const key = env.OPENAI_API_KEY?.trim();
    if (!key)
      return null;
    return {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    };
  }
  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key)
    return null;
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://modocus.app/',
    'X-Title': 'modocus-ai-proxy',
  };
}

/**
 * Forward chat completion to OpenAI or OpenRouter. Response is already
 * OpenAI-shaped — pass through status + body (no logging).
 */
export async function proxyOpenAiCompatibleChat(
  env: UpstreamEnv,
  provider: 'openai' | 'openrouter',
  model: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const headers = authHeaders(env, provider);
  if (!headers) {
    const need = provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY';
    return openaiError(503, `${need} not configured`, 'upstream_not_configured');
  }

  const upstreamBody: Record<string, unknown> = {
    model,
    messages: body.messages,
    stream: false,
  };
  if (typeof body.max_tokens === 'number')
    upstreamBody.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number')
    upstreamBody.temperature = body.temperature;
  if (body.response_format != null)
    upstreamBody.response_format = body.response_format;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    upstreamBody.tools = body.tools;
    if (body.tool_choice != null)
      upstreamBody.tool_choice = body.tool_choice;
  }

  try {
    const res = await fetch(`${baseUrl(env, provider)}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
    });
    const text = await res.text();
    // Strip hop-by-hop; never forward set-cookie from upstream.
    return new Response(text, {
      status: res.status,
      headers: {
        'content-type': res.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      },
    });
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : 'upstream_fetch_failed';
    return openaiError(502, msg, 'upstream');
  }
}

/**
 * OpenAI Whisper (multipart). Used when stt slot is whisper-1 / gpt-4o-transcribe.
 */
export async function proxyOpenAiTranscription(
  env: UpstreamEnv,
  model: string,
  audioBytes: Uint8Array,
  opts: { language?: string; filename?: string },
): Promise<Response> {
  const key = env.OPENAI_API_KEY?.trim();
  if (!key)
    return openaiError(503, 'OPENAI_API_KEY not configured', 'upstream_not_configured');

  const form = new FormData();
  const name = opts.filename ?? 'audio.m4a';
  // Copy into a plain ArrayBuffer-backed Uint8Array for Blob compatibility.
  const copy = new Uint8Array(audioBytes.byteLength);
  copy.set(audioBytes);
  form.append('file', new Blob([copy], { type: 'application/octet-stream' }), name);
  form.append('model', model);
  if (opts.language)
    form.append('language', opts.language);

  try {
    const res = await fetch(`${baseUrl(env, 'openai')}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    const text = await res.text();
    // Normalize to { text } when OpenAI returns JSON with text field already.
    if (res.ok) {
      try {
        const j = JSON.parse(text) as { text?: string };
        if (typeof j.text === 'string') {
          return new Response(JSON.stringify({ text: j.text }), {
            status: 200,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
          });
        }
      }
      catch { /* fall through */ }
    }
    return new Response(text, {
      status: res.status,
      headers: {
        'content-type': res.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      },
    });
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : 'upstream_fetch_failed';
    return openaiError(502, msg, 'upstream');
  }
}

export function upstreamCapabilities(env: UpstreamEnv): {
  workersAi: boolean;
  openai: boolean;
  openrouter: boolean;
} {
  return {
    workersAi: true,
    openai: Boolean(env.OPENAI_API_KEY?.trim()),
    openrouter: Boolean(env.OPENROUTER_API_KEY?.trim()),
  };
}
