/**
 * Chat / STT handlers — Workers AI, AI Gateway (Unified Billing), or legacy HTTP.
 *
 * Privacy: never log bodies or transcripts.
 */

import {
  loadModelConfig,
  resolveChatModel,
  resolveSttModel,
  type ModelRoutingConfig,
} from './models';
import {
  gatewayId,
  proxyOpenAiCompatibleChat,
  proxyOpenAiTranscription,
  resolveUpstream,
  type UpstreamEnv,
} from './upstream';

/** Minimal Ai binding surface (avoids tight coupling to generated types). */
export type AiBinding = {
  run: (
    model: string,
    inputs: Record<string, unknown>,
    options?: {
      returnRawResponse?: boolean;
      gateway?: {
        id: string;
        skipCache?: boolean;
        cacheTtl?: number;
        collectLog?: boolean;
      };
    },
  ) => Promise<unknown>;
};

export type ProxyHandlerEnv = UpstreamEnv & {
  AI: AiBinding;
  USAGE?: KVNamespace;
  ENVIRONMENT?: string;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v != null && typeof v === 'object' && !Array.isArray(v))
    return v as Record<string, unknown>;
  return null;
}

function openaiError(status: number, message: string, code = 'upstream'): Response {
  return new Response(JSON.stringify({
    error: { message, code, type: 'workers_ai_error' },
  }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function openaiChatCompletion(model: string, content: string, toolCalls?: unknown[]): Response {
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: content || null,
  };
  if (toolCalls && toolCalls.length > 0)
    message.tool_calls = toolCalls;

  const body = {
    id: `chatcmpl_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Extract assistant text from heterogeneous Workers AI responses. */
function extractText(result: unknown): string {
  if (typeof result === 'string')
    return result;
  let r = asRecord(result);
  if (!r)
    return '';
  // CF REST envelope sometimes leaks through
  if (asRecord(r.result))
    r = asRecord(r.result)!;
  if (typeof r.response === 'string')
    return r.response;
  if (typeof r.result === 'string')
    return r.result;
  if (typeof r.text === 'string')
    return r.text;
  if (typeof r.output_text === 'string')
    return r.output_text;
  // OpenAI-ish nested
  const choices = r.choices;
  if (Array.isArray(choices) && choices[0]) {
    const c0 = asRecord(choices[0]);
    const msg = c0 ? asRecord(c0.message) : null;
    if (msg && typeof msg.content === 'string')
      return msg.content;
    if (c0 && typeof c0.text === 'string')
      return c0.text;
  }
  return '';
}

function extractToolCalls(result: unknown): unknown[] | undefined {
  const r = asRecord(result);
  if (!r)
    return undefined;
  if (Array.isArray(r.tool_calls))
    return r.tool_calls;
  const choices = r.choices;
  if (Array.isArray(choices) && choices[0]) {
    const c0 = asRecord(choices[0]);
    const msg = c0 ? asRecord(c0.message) : null;
    if (msg && Array.isArray(msg.tool_calls))
      return msg.tool_calls;
  }
  return undefined;
}

function sceneFromRequest(req: Request, body: Record<string, unknown>): string | null {
  const h = req.headers.get('x-modocus-scene') ?? req.headers.get('X-Modocus-Scene');
  if (h && h.trim())
    return h.trim();
  if (typeof body.modocus_scene === 'string' && body.modocus_scene.trim())
    return body.modocus_scene.trim();
  if (typeof body.purpose === 'string' && body.purpose.trim())
    return body.purpose.trim();
  return null;
}

function wantsJson(body: Record<string, unknown>): boolean {
  const rf = body.response_format;
  if (rf === 'json_object')
    return true;
  if (rf != null && typeof rf === 'object' && !Array.isArray(rf)) {
    const t = (rf as { type?: unknown }).type;
    return t === 'json_object' || t === 'json_schema';
  }
  return false;
}

function buildChatInputs(
  body: Record<string, unknown>,
  hasTools: boolean,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {
    messages: body.messages,
  };
  if (typeof body.max_tokens === 'number')
    inputs.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number')
    inputs.temperature = body.temperature;
  if (body.response_format != null)
    inputs.response_format = body.response_format;
  if (hasTools) {
    inputs.tools = body.tools;
    if (body.tool_choice != null)
      inputs.tool_choice = body.tool_choice;
  }
  return inputs;
}

async function runAiChat(
  ai: AiBinding,
  model: string,
  inputs: Record<string, unknown>,
  gw?: string | null,
): Promise<Response> {
  try {
    const result = gw
      ? await ai.run(model, inputs, { gateway: { id: gw } })
      : await ai.run(model, inputs);
    const text = extractText(result);
    const toolCalls = extractToolCalls(result);
    if (!text && !(toolCalls && toolCalls.length > 0))
      return openaiChatCompletion(model, text || '', toolCalls);
    return openaiChatCompletion(model, text, toolCalls);
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : 'ai_run_failed';
    const status = /not found|unknown model|does not exist|invalid model/i.test(msg)
      ? 400
      : /credit|billing|payment|unauthorized|forbidden/i.test(msg)
        ? 402
        : 502;
    return openaiError(status, msg, 'upstream');
  }
}

/**
 * POST /v1/chat/completions → Workers AI | AI Gateway | legacy HTTP.
 * Supports non-stream JSON; stream requests fall back to non-stream
 * (app client does not require SSE for core flows).
 */
export async function handleChatCompletions(
  ai: AiBinding,
  req: Request,
  config?: ModelRoutingConfig,
  kv?: KVNamespace,
  environment?: string,
  upstreamEnv?: UpstreamEnv,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  }
  catch {
    return openaiError(400, 'invalid_json', 'bad_request');
  }

  const env = upstreamEnv ?? {};
  const routing = config ?? await loadModelConfig(kv, environment);
  const scene = sceneFromRequest(req, body);
  // Do not forward operator/control fields to the model upstream.
  delete body.modocus_scene;
  delete body.purpose;

  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const model = resolveChatModel(body.model, routing, {
    scene,
    hasTools,
    wantsJson: wantsJson(body),
  });
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0)
    return openaiError(400, 'messages required', 'bad_request');

  const { provider, model: upstreamModel } = resolveUpstream(model, env);
  const inputs = buildChatInputs(body, hasTools);

  if (provider === 'openai' || provider === 'openrouter')
    return proxyOpenAiCompatibleChat(env, provider, upstreamModel, body);

  if (provider === 'ai-gateway') {
    const gw = gatewayId(env);
    if (!gw) {
      return openaiError(
        503,
        'AI_GATEWAY_ID not configured — set wrangler var to your gateway name (e.g. default) and load Unified Billing credits',
        'gateway_not_configured',
      );
    }
    return runAiChat(ai, upstreamModel, inputs, gw);
  }

  // Direct Workers AI only when AI_GATEWAY_ID is unset (resolveUpstream fallback).
  return runAiChat(ai, upstreamModel, inputs, null);
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * POST /v1/audio/transcriptions
 * Accepts app JSON: { model, input_audio: { data: base64, format }, language? }
 * Also accepts OpenAI multipart-ish JSON { file: base64 } as fallback.
 */
export async function handleTranscriptions(
  ai: AiBinding,
  req: Request,
  config?: ModelRoutingConfig,
  kv?: KVNamespace,
  environment?: string,
  upstreamEnv?: UpstreamEnv,
): Promise<Response> {
  const ct = (req.headers.get('content-type') ?? '').toLowerCase();

  let modelReq: unknown;
  let b64: string | null = null;
  let language: string | undefined;

  try {
    if (ct.includes('application/json')) {
      const body = (await req.json()) as Record<string, unknown>;
      modelReq = body.model;
      if (typeof body.language === 'string')
        language = body.language;
      const inputAudio = asRecord(body.input_audio);
      if (inputAudio && typeof inputAudio.data === 'string')
        b64 = inputAudio.data;
      else if (typeof body.file === 'string')
        b64 = body.file;
      else if (typeof body.audio === 'string')
        b64 = body.audio;
    }
    else if (ct.includes('multipart/form-data')) {
      const form = await req.formData();
      modelReq = form.get('model');
      const lang = form.get('language');
      if (typeof lang === 'string')
        language = lang;
      const file = form.get('file');
      if (file != null && typeof file === 'object' && 'arrayBuffer' in file) {
        const blob = file as Blob;
        const buf = new Uint8Array(await blob.arrayBuffer());
        // Convert to base64 for unified path
        let s = '';
        const chunk = 0x8000;
        for (let i = 0; i < buf.length; i += chunk)
          s += String.fromCharCode(...buf.subarray(i, i + chunk));
        b64 = btoa(s);
      }
    }
    else {
      return openaiError(415, 'unsupported content-type', 'bad_request');
    }
  }
  catch {
    return openaiError(400, 'invalid_body', 'bad_request');
  }

  if (!b64 || b64.length === 0)
    return openaiError(400, 'audio required', 'bad_request');

  const env = upstreamEnv ?? {};
  const routing = config ?? await loadModelConfig(kv, environment);
  const model = resolveSttModel(modelReq, routing);
  const bytes = base64ToBytes(b64);
  const { provider, model: upstreamModel } = resolveUpstream(model, env);
  const isCf = upstreamModel.startsWith('@cf/');

  // Third-party STT (non-@cf): legacy OpenAI multipart when key present.
  // @cf whisper goes through Workers AI (optionally via Gateway) below.
  if (!isCf && (provider === 'openai' || provider === 'ai-gateway')) {
    if (env.OPENAI_API_KEY?.trim() && (provider === 'openai' || upstreamModel.includes('whisper') || upstreamModel.startsWith('openai/'))) {
      const openaiModel = upstreamModel.startsWith('openai/')
        ? upstreamModel.slice('openai/'.length)
        : upstreamModel;
      return proxyOpenAiTranscription(env, openaiModel, bytes, {
        language,
        filename: 'audio.m4a',
      });
    }
    return openaiError(
      503,
      'third-party STT requires OPENAI_API_KEY (legacy) or use @cf whisper models',
      'upstream_not_configured',
    );
  }
  if (provider === 'openrouter') {
    return openaiError(400, 'stt_openrouter_unsupported', 'bad_request');
  }
  if (!isCf) {
    return openaiError(
      400,
      'stt_use_workers_ai_whisper',
      'bad_request',
    );
  }

  // Workers AI Whisper expects `audio` as number[] (byte values) for classic
  // models; large-v3-turbo also accepts base64 string in some versions — try
  // number[] first (documented for @cf/openai/whisper*).
  // When AI_GATEWAY_ID is set, resolveUpstream marks provider ai-gateway so we
  // pass gateway options (same as chat) for CF dashboard logs.
  const gw = provider === 'ai-gateway' ? gatewayId(env) : null;
  const runOpts = gw ? { gateway: { id: gw } } : undefined;
  const audioArr = Array.from(bytes);

  const inputs: Record<string, unknown> = {
    audio: audioArr,
  };
  if (language)
    inputs.language = language;

  try {
    const result = await ai.run(upstreamModel, inputs, runOpts);
    const text = extractText(result);
    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  catch (err) {
    // Retry with raw base64 if number[] rejected
    try {
      const result = await ai.run(upstreamModel, {
        audio: b64,
        ...(language ? { language } : {}),
      }, runOpts);
      const text = extractText(result);
      return new Response(JSON.stringify({ text }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    catch (err2) {
      const msg = err2 instanceof Error
        ? err2.message
        : err instanceof Error ? err.message : 'stt_failed';
      return openaiError(502, msg, 'upstream');
    }
  }
}
