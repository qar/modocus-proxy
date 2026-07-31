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
 * Upstream: Workers AI (env.AI) and/or OpenAI / OpenRouter HTTP (secrets).
 *
 * Privacy: never log request/response bodies or raw tokens.
 */

import { authenticateBearer } from './auth';
import { handleDashboard } from './dashboard';
import {
  memNoteSubject,
  recordMetric,
  utcDay,
} from './metrics';
import {
  loadModelConfig,
  resolveChatModel,
  resolveSttModel,
} from './models';
import { handleChatCompletions, handleTranscriptions, type AiBinding } from './workers-ai';
import { upstreamCapabilities } from './upstream';

export interface Env {
  AI: AiBinding;
  /** Staging only — ignored in production even if set. */
  DEV_BYPASS_TOKEN?: string;
  /** Operator dashboard shared secret (≥16 chars). */
  DASHBOARD_TOKEN?: string;
  /** OpenAI API key — enables gpt-4o-mini / gpt-4o / whisper-1 etc. */
  OPENAI_API_KEY?: string;
  /** Optional OpenAI-compatible base (default https://api.openai.com/v1). */
  OPENAI_BASE_URL?: string;
  /** OpenRouter API key — enables anthropic/…, google/…, etc. */
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
  USAGE?: KVNamespace;
  DAILY_LIMIT?: string;
  ENVIRONMENT?: string;
  ALLOWED_BUNDLE_IDS?: string;
  ALLOWED_PRODUCT_IDS?: string;
  ALLOW_SANDBOX?: string;
}

const DEFAULT_DAILY_LIMIT = 80;

const memCounters = new Map<string, { day: string; n: number }>();

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

async function bumpUsage(
  env: Env,
  subject: string,
): Promise<{ ok: boolean; n: number; limit: number }> {
  const limit = Number(env.DAILY_LIMIT ?? DEFAULT_DAILY_LIMIT) || DEFAULT_DAILY_LIMIT;
  const day = utcDay();
  const key = `u:${day}:${subject}`;

  if (env.USAGE) {
    const raw = await env.USAGE.get(key);
    const n = (raw ? Number(raw) : 0) + 1;
    if (n > limit)
      return { ok: false, n, limit };
    await env.USAGE.put(key, String(n), { expirationTtl: 60 * 60 * 48 });
    return { ok: true, n, limit };
  }

  const cur = memCounters.get(key);
  const n = (cur && cur.day === day ? cur.n : 0) + 1;
  memCounters.set(key, { day, n });
  memNoteSubject(day, subject, n);
  if (n > limit)
    return { ok: false, n, limit };
  return { ok: true, n, limit };
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
        upstream: {
          workersAi: caps.workersAi,
          openai: caps.openai,
          openrouter: caps.openrouter,
        },
        dashboard: Boolean(env.DASHBOARD_TOKEN && env.DASHBOARD_TOKEN.length >= 16),
      });
    }

    // Operator dashboard (separate auth) — GET UI/API + PUT model routing
    if (path === '/dashboard' || path.startsWith('/dashboard/')) {
      return handleDashboard(req, env);
    }

    if (!env.AI)
      return json({ error: { message: 'proxy_misconfigured', code: 'server' } }, 500);

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

    const usage = await bumpUsage(env, auth.subject);
    if (!usage.ok) {
      await recordMetric(env.USAGE, {
        route: 'other',
        status: 429,
        authKind: auth.kind === 'dev_bypass' ? 'dev_bypass' : 'jws',
        subject: auth.subject,
        note: 'usage_paused',
      });
      return json({
        error: {
          message: 'usage_paused',
          code: 'usage_paused',
          limit: usage.limit,
        },
      }, 429);
    }

    const authKind = auth.kind === 'dev_bypass' ? 'dev_bypass' as const : 'jws' as const;

    if (req.method === 'POST' && path === '/v1/chat/completions') {
      const model = await peekModel(req, 'chat', env.USAGE, env.ENVIRONMENT);
      const t0 = Date.now();
      const res = await handleChatCompletions(env.AI, req, undefined, env.USAGE, env.ENVIRONMENT, env);
      await recordMetric(env.USAGE, {
        route: 'chat',
        status: res.status,
        model,
        authKind,
        subject: auth.subject,
        ms: Date.now() - t0,
      });
      return res;
    }

    if (req.method === 'POST' && path === '/v1/audio/transcriptions') {
      const model = await peekModel(req, 'stt', env.USAGE, env.ENVIRONMENT);
      const t0 = Date.now();
      const res = await handleTranscriptions(env.AI, req, undefined, env.USAGE, env.ENVIRONMENT, env);
      await recordMetric(env.USAGE, {
        route: 'stt',
        status: res.status,
        model,
        authKind,
        subject: auth.subject,
        ms: Date.now() - t0,
      });
      return res;
    }

    return json({ error: { message: 'not_found', code: 'bad_response' } }, 404);
  },
};
