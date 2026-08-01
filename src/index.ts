/**
 * Cloudflare Worker — Modocus AI proxy.
 *
 * Routes:
 *   POST /v1/chat/completions
 *   POST /v1/audio/transcriptions
 *   GET  /health
 *   GET  /dashboard          (operator UI — DASHBOARD_TOKEN)
 *   GET  /dashboard/api      (JSON stats)
 *
 * Auth (API): production = Apple JWS; staging = JWS | DEV_BYPASS.
 * Upstream: Workers AI (`@cf/…`, Neurons) and AI Gateway third-party models
 * (Unified Billing on the same Cloudflare account). Optional legacy HTTP keys.
 *
 * Privacy: never log request/response bodies or raw tokens.
 */

import { authenticateBearer } from './auth';
import {
  handleAppStoreNotification,
  isTransactionRevoked,
} from './app-store-notifications';
import { handleDashboard } from './dashboard';
import {
  recordMetric,
} from './metrics';
import {
  loadModelConfig,
  resolveChatModel,
  resolveSttModel,
} from './models';
import { handleChatCompletions, handleTranscriptions, type AiBinding } from './workers-ai';
import { upstreamCapabilities } from './upstream';
import {
  DEFAULT_OPERATION_LIMIT,
  isValidOperationId,
  type ReserveOperationResult,
} from './usage-ledger';

export { UsageLedger } from './usage-ledger';

export interface Env {
  AI: AiBinding;
  /** Staging only — ignored in production even if set. */
  DEV_BYPASS_TOKEN?: string;
  /** Operator dashboard shared secret (≥16 chars). */
  DASHBOARD_TOKEN?: string;
  /**
   * AI Gateway name/id in this CF account (e.g. "default").
   * Required for non-@cf models (openai/…, anthropic/…, google/…).
   */
  AI_GATEWAY_ID?: string;
  /** Set "true" to allow direct OpenAI/OpenRouter HTTP (multi-bill fallback). */
  ALLOW_LEGACY_HTTP_UPSTREAM?: string;
  /** Legacy only — used when ALLOW_LEGACY_HTTP_UPSTREAM=true. */
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
  USAGE?: KVNamespace;
  USAGE_LEDGER?: DurableObjectNamespace;
  ENVIRONMENT?: string;
  ALLOWED_BUNDLE_IDS?: string;
  ALLOWED_PRODUCT_IDS?: string;
  ALLOW_SANDBOX?: string;
  SUBJECT_HASH_SALT?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

function extractBearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!h)
    return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() || null;
}

async function reserveOperationQuota(
  env: Env,
  subject: string,
  operationId: string,
  periodStartMs: number,
  periodEndMs: number,
): Promise<ReserveOperationResult | null> {
  if (!env.USAGE_LEDGER)
    return null;
  const id = env.USAGE_LEDGER.idFromName(subject);
  const stub = env.USAGE_LEDGER.get(id);
  const response = await stub.fetch('https://usage-ledger/reserve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId,
      periodStartMs,
      periodEndMs,
      limit: DEFAULT_OPERATION_LIMIT,
    }),
  });
  if (!response.ok)
    return null;
  return await response.json() as ReserveOperationResult;
}

function withQuotaHeaders(response: Response, quota: ReserveOperationResult): Response {
  const headers = new Headers(response.headers);
  headers.set('x-modocus-operations-used', String(quota.used));
  headers.set('x-modocus-operations-limit', String(quota.limit));
  headers.set('x-modocus-period-ends-at', new Date(quota.periodEndMs).toISOString());
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function shortHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

async function responseTokenUsage(response: Response): Promise<{
  inputTokens: number;
  outputTokens: number;
}> {
  if (!(response.headers.get('content-type') ?? '').includes('application/json'))
    return { inputTokens: 0, outputTokens: 0 };
  try {
    const body = await response.clone().json() as {
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        input_tokens?: unknown;
        output_tokens?: unknown;
      };
    };
    const input = body.usage?.prompt_tokens ?? body.usage?.input_tokens;
    const output = body.usage?.completion_tokens ?? body.usage?.output_tokens;
    return {
      inputTokens: typeof input === 'number' && Number.isFinite(input) && input >= 0 ? input : 0,
      outputTokens: typeof output === 'number' && Number.isFinite(output) && output >= 0 ? output : 0,
    };
  }
  catch {
    return { inputTokens: 0, outputTokens: 0 };
  }
}

function audioSecondsFromRequest(request: Request): number {
  const value = Number(request.headers.get('x-modocus-audio-seconds'));
  return Number.isFinite(value) && value >= 0 && value <= 21_600 ? value : 0;
}

async function peekModel(
  req: Request,
  kind: 'chat' | 'stt',
  kv?: KVNamespace,
  environment?: string,
): Promise<string | undefined> {
  try {
    const config = await loadModelConfig(kv, environment);
    if (kind === 'stt') {
      try {
        const body = await req.clone().json() as Record<string, unknown>;
        return resolveSttModel(body.model, config);
      }
      catch {
        return resolveSttModel(undefined, config);
      }
    }
    const body = await req.clone().json() as Record<string, unknown>;
    const scene
      = req.headers.get('x-modocus-scene')
        ?? req.headers.get('X-Modocus-Scene')
        ?? (typeof body.modocus_scene === 'string' ? body.modocus_scene : null)
        ?? (typeof body.purpose === 'string' ? body.purpose : null);
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const rf = body.response_format;
    const wantsJson = rf === 'json_object'
      || (rf != null && typeof rf === 'object' && !Array.isArray(rf)
        && ((rf as { type?: unknown }).type === 'json_object'
          || (rf as { type?: unknown }).type === 'json_schema'));
    return resolveChatModel(body.model, config, { scene, hasTools, wantsJson });
  }
  catch {
    return undefined;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && (path === '/health' || path === '/v1/health')) {
      const caps = upstreamCapabilities(env);
      return json({
        ok: true,
        env: (env.ENVIRONMENT ?? 'production').toLowerCase(),
        upstream: caps,
        operationQuota: {
          limit: DEFAULT_OPERATION_LIMIT,
          durableObjectBound: Boolean(env.USAGE_LEDGER),
        },
        dashboard: Boolean(env.DASHBOARD_TOKEN && env.DASHBOARD_TOKEN.length >= 16),
      });
    }

    if (req.method === 'POST' && path === '/apple/notifications')
      return handleAppStoreNotification(req, env);

    // Operator dashboard (separate auth) — GET UI/API + PUT model routing
    if (path === '/dashboard' || path.startsWith('/dashboard/')) {
      return handleDashboard(req, env);
    }

    if (!env.AI)
      return json({ error: { message: 'proxy_misconfigured', code: 'server' } }, 500);

    const route = req.method === 'POST' && path === '/v1/chat/completions'
      ? 'chat'
      : req.method === 'POST' && path === '/v1/audio/transcriptions'
        ? 'stt'
        : null;
    if (!route)
      return json({ error: { message: 'not_found', code: 'bad_response' } }, 404);

    const token = extractBearer(req);
    const auth = await authenticateBearer(env, token);
    if (!auth.ok) {
      // Do not recordMetric: public scanners flood 401s and each metric write
      // is multiple KV ops (free tier ~1k writes/day). Auth failures stay
      // response-only; dashboard tracks authenticated traffic only.
      return json({
        error: {
          message: auth.message,
          code: auth.code,
        },
      }, auth.status);
    }

    if (auth.kind === 'jws' && auth.transaction) {
      const revoked = await isTransactionRevoked(
        env,
        auth.subject,
        auth.transaction.transactionId,
      );
      if (revoked == null)
        return json({ error: { message: 'subscription_state_unavailable', code: 'server' } }, 500);
      if (revoked)
        return json({ error: { message: 'subscription_revoked', code: 'revoked' } }, 403);
    }

    const operationId = req.headers.get('x-modocus-operation-id');
    if (!isValidOperationId(operationId)) {
      return json({
        error: {
          message: 'operation_id_required',
          code: 'operation_id_required',
        },
      }, 400);
    }

    const usage = await reserveOperationQuota(
      env,
      auth.subject,
      operationId,
      auth.periodStartMs,
      auth.periodEndMs,
    );
    if (!usage) {
      return json({ error: { message: 'quota_unavailable', code: 'server' } }, 500);
    }
    const operationHash = await shortHash(operationId);
    const scene = req.headers.get('x-modocus-scene')?.trim() || route;
    if (!usage.allowed) {
      await recordMetric(env.USAGE, {
        route,
        status: 429,
        authKind: auth.kind === 'dev_bypass' ? 'dev_bypass' : 'jws',
        subject: auth.subject,
        operationHash,
        scene,
        countedOperation: false,
        quotaUsed: usage.used,
        quotaLimit: usage.limit,
        periodEndMs: usage.periodEndMs,
        note: 'quota_exhausted',
      }).catch(() => {});
      return withQuotaHeaders(json({
        error: {
          message: 'quota_exhausted',
          code: 'quota_exhausted',
          used: usage.used,
          limit: usage.limit,
          periodEnd: new Date(usage.periodEndMs).toISOString(),
        },
      }, 429), usage);
    }

    const authKind = auth.kind === 'dev_bypass' ? 'dev_bypass' as const : 'jws' as const;

    if (route === 'chat') {
      const model = await peekModel(req, 'chat', env.USAGE, env.ENVIRONMENT);
      const t0 = Date.now();
      const res = await handleChatCompletions(env.AI, req, undefined, env.USAGE, env.ENVIRONMENT, env);
      const tokens = await responseTokenUsage(res);
      await recordMetric(env.USAGE, {
        route: 'chat',
        status: res.status,
        model,
        authKind,
        subject: auth.subject,
        operationHash,
        scene,
        countedOperation: usage.counted,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        quotaUsed: usage.used,
        quotaLimit: usage.limit,
        periodEndMs: usage.periodEndMs,
        ms: Date.now() - t0,
      }).catch(() => {});
      return withQuotaHeaders(res, usage);
    }

    if (route === 'stt') {
      const model = await peekModel(req, 'stt', env.USAGE, env.ENVIRONMENT);
      const t0 = Date.now();
      const res = await handleTranscriptions(env.AI, req, undefined, env.USAGE, env.ENVIRONMENT, env);
      await recordMetric(env.USAGE, {
        route: 'stt',
        status: res.status,
        model,
        authKind,
        subject: auth.subject,
        operationHash,
        scene,
        countedOperation: usage.counted,
        audioSeconds: audioSecondsFromRequest(req),
        quotaUsed: usage.used,
        quotaLimit: usage.limit,
        periodEndMs: usage.periodEndMs,
        ms: Date.now() - t0,
      }).catch(() => {});
      return withQuotaHeaders(res, usage);
    }

    return json({ error: { message: 'not_found', code: 'bad_response' } }, 404);
  },
};
