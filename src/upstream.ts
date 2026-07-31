/**
 * Upstream resolution and optional legacy HTTP providers.
 *
 * Primary paths (Cloudflare bill):
 *   - `@cf/…`     → direct Workers AI binding (Neurons) by default.
 *                   Opt-in via `ROUTE_CF_VIA_GATEWAY=true` to hop AI Gateway
 *                   (logs); some accounts hit Workers AI "2021: Payment error"
 *                   when @cf is forced through Gateway — keep default direct.
 *   - third-party → AI Gateway via `env.AI.run(model, inputs, { gateway })`
 *                   (Unified Billing credits on the same CF account)
 *
 * Legacy optional (separate bills — only if keys set AND gateway unavailable
 * for that call, or model prefix forces http):
 *   - `http:openai/…` / bare with ALLOW_LEGACY_HTTP_UPSTREAM
 *   - `openrouter/…` with OPENROUTER_API_KEY
 *
 * Privacy: never log request/response bodies or API keys.
 */

export type UpstreamProvider
  = | 'workers-ai'
    | 'ai-gateway'
    | 'openai'
    | 'openrouter';

export type UpstreamEnv = {
  /** AI Gateway id/name in the same CF account (e.g. "default" or "modocus"). */
  AI_GATEWAY_ID?: string;
  /**
   * When "true" and `AI_GATEWAY_ID` is set, also send `@cf/…` through AI Gateway
   * for unified logs. Default off (direct Workers AI) — safer for Neurons billing.
   */
  ROUTE_CF_VIA_GATEWAY?: string;
  /**
   * When "true", AI Gateway stores full request/response bodies in CF logs.
   * Default off — personal todo/chat content must not land in the dashboard.
   */
  GATEWAY_COLLECT_LOG?: string;
  /**
   * When "true", allow direct OpenAI/OpenRouter HTTP if keys are present
   * (multi-bill fallback). Default off — third-party goes through AI Gateway.
   */
  ALLOW_LEGACY_HTTP_UPSTREAM?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
};

export type ResolvedUpstream = {
  provider: UpstreamProvider;
  /** Model id sent to that upstream (may differ from operator-facing id). */
  model: string;
};

/** Friendly aliases operators might type. */
const MODEL_ALIASES: Record<string, string> = {
  'chatgpt-4o-mini': 'openai/gpt-4o-mini',
  'chatgpt-4o': 'openai/gpt-4o',
  'openai/chatgpt-4o-mini': 'openai/gpt-4o-mini',
  'openai/chatgpt-4o': 'openai/gpt-4o',
};

function legacyHttpAllowed(env?: UpstreamEnv): boolean {
  return (env?.ALLOW_LEGACY_HTTP_UPSTREAM ?? '').trim().toLowerCase() === 'true';
}

/**
 * Normalize bare OpenAI-family ids to `openai/…` (AI Gateway catalog form).
 */
export function normalizeGatewayModelId(modelId: string): string {
  let m = modelId.trim();
  const aliased = MODEL_ALIASES[m] ?? MODEL_ALIASES[m.toLowerCase()];
  if (aliased)
    m = aliased;

  if (m.startsWith('@cf/') || m.includes('/'))
    return m;

  // Bare OpenAI-family → openai/<id>
  if (/^(gpt-|o[0-9]|chatgpt-|text-embedding|whisper|tts-)/i.test(m))
    return `openai/${m}`;

  return m;
}

function cfViaGateway(env?: UpstreamEnv): boolean {
  return (env?.ROUTE_CF_VIA_GATEWAY ?? '').trim().toLowerCase() === 'true'
    && Boolean(gatewayId(env ?? {}));
}

/**
 * Decide provider + upstream model id.
 *
 * Without env: pure routing rules (`@cf` → workers-ai; others → ai-gateway).
 * With env: `@cf` stays workers-ai unless `ROUTE_CF_VIA_GATEWAY=true` + gateway id.
 * With env: may fall back to legacy HTTP when explicitly allowed + keyed.
 */
export function resolveUpstream(modelId: string, env?: UpstreamEnv): ResolvedUpstream {
  let m = modelId.trim();
  const aliased = MODEL_ALIASES[m] ?? MODEL_ALIASES[m.toLowerCase()];
  if (aliased)
    m = aliased;

  // Explicit force legacy HTTP prefixes (ops escape hatch)
  if (m.startsWith('http:openai/'))
    return { provider: 'openai', model: m.slice('http:openai/'.length) };
  if (m.startsWith('http:openrouter/'))
    return { provider: 'openrouter', model: m.slice('http:openrouter/'.length) };

  // Workers AI models: direct Neurons by default (avoids Gateway payment quirks).
  if (m.startsWith('@cf/')) {
    if (cfViaGateway(env))
      return { provider: 'ai-gateway', model: m };
    return { provider: 'workers-ai', model: m };
  }

  // openrouter/… → legacy OpenRouter only when allowed + key; else strip prefix → gateway
  if (m.startsWith('openrouter/')) {
    const rest = m.slice('openrouter/'.length);
    if (legacyHttpAllowed(env) && env?.OPENROUTER_API_KEY?.trim())
      return { provider: 'openrouter', model: rest };
    return { provider: 'ai-gateway', model: rest.includes('/') ? rest : `openrouter/${rest}` };
  }

  const gatewayModel = normalizeGatewayModelId(m);

  // Legacy direct OpenAI when allowed and no gateway id configured
  if (legacyHttpAllowed(env) && !env?.AI_GATEWAY_ID?.trim()) {
    if (gatewayModel.startsWith('openai/'))
      return { provider: 'openai', model: gatewayModel.slice('openai/'.length) };
    if (env?.OPENROUTER_API_KEY?.trim() && gatewayModel.includes('/'))
      return { provider: 'openrouter', model: gatewayModel };
  }

  // Default: third-party / provider models → AI Gateway (Unified Billing)
  if (!gatewayModel.startsWith('@cf/'))
    return { provider: 'ai-gateway', model: gatewayModel };

  if (cfViaGateway(env))
    return { provider: 'ai-gateway', model: gatewayModel };
  return { provider: 'workers-ai', model: gatewayModel };
}

export function gatewayId(env: UpstreamEnv): string | null {
  const id = env.AI_GATEWAY_ID?.trim();
  return id && id.length > 0 ? id : null;
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
 * Forward chat completion to OpenAI or OpenRouter (legacy multi-bill path).
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
 * OpenAI Whisper (multipart) — legacy path only.
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
  aiGateway: boolean;
  gatewayId: string | null;
  /** Legacy multi-bill HTTP (off by default). */
  legacyHttp: boolean;
  openaiKey: boolean;
  openrouterKey: boolean;
} {
  return {
    workersAi: true,
    aiGateway: Boolean(gatewayId(env)),
    gatewayId: gatewayId(env),
    legacyHttp: legacyHttpAllowed(env),
    openaiKey: Boolean(env.OPENAI_API_KEY?.trim()),
    openrouterKey: Boolean(env.OPENROUTER_API_KEY?.trim()),
  };
}
