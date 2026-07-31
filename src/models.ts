/**
 * Model catalog, per-task slots, and resolution.
 *
 * Operators pick a model per slot on the dashboard (Workers AI `@cf/…`,
 * OpenAI `gpt-4o-mini`, OpenRouter `anthropic/…`, or any safe custom id).
 * Config is stored in KV and takes effect without redeploy.
 *
 * Upstream dispatch: see `upstream.ts` (`resolveUpstream`).
 *
 * Request scene (priority):
 *   1. Header `X-Modocus-Scene`
 *   2. Body `modocus_scene` (stripped before upstream)
 *   3. Client model slug → slot heuristic
 *   4. Request shape (tools / json_object)
 *   5. Slot `default`
 */

/** KV key prefix for operator-edited slot → model map (suffix = environment). */
export const MODEL_CONFIG_KV_PREFIX = 'cfg:model_slots';

/** Default key (production). Prefer {@link modelConfigKvKey}. */
export const MODEL_CONFIG_KV_KEY = `${MODEL_CONFIG_KV_PREFIX}:production`;

/** Isolate staging/prod when they share one KV namespace. */
export function modelConfigKvKey(environment?: string): string {
  const e = (environment ?? 'production').trim().toLowerCase();
  if (e === 'staging' || e === 'development' || e === 'preview')
    return `${MODEL_CONFIG_KV_PREFIX}:${e === 'preview' ? 'staging' : e}`;
  return MODEL_CONFIG_KV_KEY;
}

/** Chat / text task slots (one dropdown each on the dashboard). */
export const CHAT_SLOTS = [
  'default',
  'parse',
  'plan',
  'estimate',
  'chat',
  'insight',
  'strong',
] as const;

export type ChatSlot = (typeof CHAT_SLOTS)[number];

/** STT is a separate slot (different catalog). */
export const STT_SLOT = 'stt' as const;
export type ModelSlot = ChatSlot | typeof STT_SLOT;

export type ModelProviderHint = 'workers-ai' | 'openai' | 'openrouter';

export type ModelOption = {
  id: string;
  label: string;
  /** Short cost/quality hint for the UI. */
  tier: 'fast' | 'standard' | 'strong' | 'stt';
  /** Which upstream will serve this id (for dashboard labels). */
  provider: ModelProviderHint;
};

/**
 * Curated catalog for dashboard dropdowns. Custom ids outside this list are
 * also allowed when they pass {@link isSafeModelId}.
 */
export const CHAT_MODEL_OPTIONS: readonly ModelOption[] = [
  // ── OpenAI (needs OPENAI_API_KEY) ───────────────────────────────────────
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', tier: 'fast', provider: 'openai' },
  { id: 'gpt-4o', label: 'GPT-4o', tier: 'strong', provider: 'openai' },
  { id: 'gpt-4.1-nano', label: 'GPT-4.1 nano', tier: 'fast', provider: 'openai' },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', tier: 'fast', provider: 'openai' },
  { id: 'gpt-4.1', label: 'GPT-4.1', tier: 'strong', provider: 'openai' },
  { id: 'o4-mini', label: 'o4-mini', tier: 'standard', provider: 'openai' },
  // OpenRouter-style openai/ slugs (still go to OpenAI API when key set)
  { id: 'openai/gpt-4o-mini', label: 'openai/gpt-4o-mini', tier: 'fast', provider: 'openai' },
  { id: 'openai/gpt-4o', label: 'openai/gpt-4o', tier: 'strong', provider: 'openai' },
  // ── Workers AI (env.AI binding) ─────────────────────────────────────────
  { id: '@cf/openai/gpt-oss-120b', label: 'CF gpt-oss-120b', tier: 'strong', provider: 'workers-ai' },
  { id: '@cf/openai/gpt-oss-20b', label: 'CF gpt-oss-20b', tier: 'standard', provider: 'workers-ai' },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'CF Llama 3.3 70B', tier: 'strong', provider: 'workers-ai' },
  { id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', label: 'CF Llama 3.1 8B fast', tier: 'fast', provider: 'workers-ai' },
  { id: '@cf/meta/llama-3.1-8b-instruct', label: 'CF Llama 3.1 8B', tier: 'fast', provider: 'workers-ai' },
  { id: '@cf/meta/llama-3.2-3b-instruct', label: 'CF Llama 3.2 3B', tier: 'fast', provider: 'workers-ai' },
  { id: '@cf/meta/llama-3.2-1b-instruct', label: 'CF Llama 3.2 1B', tier: 'fast', provider: 'workers-ai' },
  { id: '@cf/qwen/qwen3-30b-a3b-fp8', label: 'CF Qwen3 30B-A3B', tier: 'standard', provider: 'workers-ai' },
  { id: '@cf/google/gemma-3-12b-it', label: 'CF Gemma 3 12B', tier: 'standard', provider: 'workers-ai' },
  // ── OpenRouter examples (needs OPENROUTER_API_KEY) ──────────────────────
  { id: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku', tier: 'fast', provider: 'openrouter' },
  { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4', tier: 'strong', provider: 'openrouter' },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'fast', provider: 'openrouter' },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'strong', provider: 'openrouter' },
] as const;

export const STT_MODEL_OPTIONS: readonly ModelOption[] = [
  { id: '@cf/openai/whisper-large-v3-turbo', label: 'CF Whisper large-v3-turbo', tier: 'stt', provider: 'workers-ai' },
  { id: '@cf/openai/whisper-large-v3', label: 'CF Whisper large-v3', tier: 'stt', provider: 'workers-ai' },
  { id: '@cf/openai/whisper', label: 'CF Whisper base', tier: 'stt', provider: 'workers-ai' },
  { id: 'whisper-1', label: 'OpenAI whisper-1', tier: 'stt', provider: 'openai' },
  { id: 'gpt-4o-mini-transcribe', label: 'OpenAI gpt-4o-mini-transcribe', tier: 'stt', provider: 'openai' },
  { id: 'gpt-4o-transcribe', label: 'OpenAI gpt-4o-transcribe', tier: 'stt', provider: 'openai' },
] as const;

/**
 * Safe model id for operator config / custom entry.
 * Allows `@cf/…`, `gpt-4o-mini`, `openai/gpt-4o-mini`, `anthropic/claude-…`.
 */
const SAFE_MODEL_ID_RE = /^(?:@cf\/[a-zA-Z0-9][\w./+-]{0,120}|[a-zA-Z0-9][\w./:+-]{0,120})$/;

export function isSafeModelId(id: string): boolean {
  const t = id.trim();
  if (!t || t.length > 128)
    return false;
  if (t.includes('..') || t.includes('//') || /\s/.test(t))
    return false;
  return SAFE_MODEL_ID_RE.test(t);
}

/** Built-in defaults (used when KV empty / invalid). */
export const DEFAULT_SLOT_MODELS: Readonly<Record<ModelSlot, string>> = {
  default: '@cf/openai/gpt-oss-120b',
  parse: '@cf/openai/gpt-oss-120b',
  plan: '@cf/openai/gpt-oss-120b',
  estimate: '@cf/openai/gpt-oss-120b',
  chat: '@cf/openai/gpt-oss-120b',
  insight: '@cf/openai/gpt-oss-120b',
  strong: '@cf/openai/gpt-oss-120b',
  stt: '@cf/openai/whisper-large-v3-turbo',
};

/** @deprecated Prefer slot map; kept for dashboard / tests compat. */
export const STRONG_CHAT_MODEL = DEFAULT_SLOT_MODELS.strong;
export const DEFAULT_CHAT_MODEL = DEFAULT_SLOT_MODELS.default;
export const FAST_CHAT_MODEL = DEFAULT_SLOT_MODELS.parse;
export const DEFAULT_STT_MODEL = DEFAULT_SLOT_MODELS.stt;

export type ModelRoutingConfig = {
  version: 1;
  updatedAt: string;
  /** Slot → model id (any safe id: @cf/…, gpt-4o-mini, openrouter slug, …). */
  slots: Partial<Record<ModelSlot, string>>;
};

export type ResolveContext = {
  /** Explicit scene from header / body. */
  scene?: string | null;
  /** Client `model` field (OpenRouter-style slug or @cf id). */
  requestedModel?: unknown;
  /** True when body.tools is a non-empty array. */
  hasTools?: boolean;
  /** True when response_format requests JSON. */
  wantsJson?: boolean;
};

const CHAT_OPTION_IDS = new Set(CHAT_MODEL_OPTIONS.map(o => o.id));
const STT_OPTION_IDS = new Set(STT_MODEL_OPTIONS.map(o => o.id));

/** Client slug → preferred slot (before operator map). */
const SLUG_TO_SLOT: Record<string, ChatSlot> = {
  'openai/gpt-4.1-nano': 'parse',
  'gpt-4.1-nano': 'parse',
  'openai/gpt-4o-mini': 'chat',
  'gpt-4o-mini': 'chat',
  'openai/gpt-4.1-mini': 'chat',
  'gpt-4.1-mini': 'chat',
  'openai/gpt-4o': 'strong',
  'gpt-4o': 'strong',
  'openai/gpt-4.1': 'strong',
  'gpt-4.1': 'strong',
  // Former Workers AI weak paths → parse/fast slot (operator can still pick strong)
  '@cf/meta/llama-3.1-8b-instruct': 'parse',
  '@cf/meta/llama-3.1-8b-instruct-fp8-fast': 'parse',
  '@cf/meta/llama-3.2-3b-instruct': 'parse',
  '@cf/meta/llama-3.2-1b-instruct': 'parse',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': 'strong',
};

const SCENE_ALIASES: Record<string, ModelSlot> = {
  default: 'default',
  parse: 'parse',
  extract: 'parse',
  quickadd: 'parse',
  meeting: 'parse',
  ping: 'parse',
  plan: 'plan',
  estimate: 'estimate',
  chat: 'chat',
  insight: 'insight',
  strong: 'strong',
  escalate: 'strong',
  stt: 'stt',
  voice: 'stt',
  transcription: 'stt',
  whisper: 'stt',
};

function isChatSlot(s: string): s is ChatSlot {
  return (CHAT_SLOTS as readonly string[]).includes(s);
}

export function normalizeScene(raw: unknown): ModelSlot | null {
  if (typeof raw !== 'string')
    return null;
  const key = raw.trim().toLowerCase().replace(/[\s_]+/g, '');
  if (!key)
    return null;
  return SCENE_ALIASES[key] ?? (isChatSlot(key) ? key : null);
}

/** Catalog entry or any safe custom id (OpenAI / OpenRouter / @cf). */
export function isAllowedChatModel(id: string): boolean {
  const t = id.trim();
  if (!t)
    return false;
  if (CHAT_OPTION_IDS.has(t) || t === DEFAULT_CHAT_MODEL)
    return true;
  return isSafeModelId(t);
}

export function isAllowedSttModel(id: string): boolean {
  const t = id.trim();
  if (!t)
    return false;
  if (STT_OPTION_IDS.has(t) || t === DEFAULT_STT_MODEL)
    return true;
  return isSafeModelId(t);
}

export function defaultRoutingConfig(): ModelRoutingConfig {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    slots: { ...DEFAULT_SLOT_MODELS },
  };
}

/** Merge partial slots with defaults; drop unknown keys / empty values. */
export function normalizeRoutingConfig(
  input: unknown,
  updatedAt = new Date().toISOString(),
): ModelRoutingConfig {
  const base = defaultRoutingConfig();
  base.updatedAt = updatedAt;
  if (input == null || typeof input !== 'object')
    return base;
  const raw = input as { slots?: unknown; updatedAt?: unknown };
  const slotsIn = raw.slots != null && typeof raw.slots === 'object'
    ? raw.slots as Record<string, unknown>
    : input as Record<string, unknown>;

  const slots: Partial<Record<ModelSlot, string>> = { ...DEFAULT_SLOT_MODELS };
  for (const slot of [...CHAT_SLOTS, STT_SLOT]) {
    const v = slotsIn[slot];
    if (typeof v !== 'string' || !v.trim())
      continue;
    const id = v.trim();
    if (slot === 'stt') {
      if (isAllowedSttModel(id))
        slots.stt = id;
      continue;
    }
    if (isAllowedChatModel(id))
      slots[slot] = id;
  }
  base.slots = slots;
  if (typeof raw.updatedAt === 'string' && raw.updatedAt)
    base.updatedAt = raw.updatedAt;
  return base;
}

/**
 * Validate operator PATCH/PUT body `{ slots: { parse: "...", ... } }`.
 * Returns error message or null if ok.
 */
export function validateSlotPatch(slots: unknown): string | null {
  if (slots == null || typeof slots !== 'object' || Array.isArray(slots))
    return 'slots must be an object';
  const o = slots as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0)
    return 'slots is empty';
  for (const [k, v] of Object.entries(o)) {
    if (k !== 'stt' && !isChatSlot(k))
      return `unknown slot: ${k}`;
    if (typeof v !== 'string' || !v.trim())
      return `slot ${k}: model id required`;
    const id = v.trim();
    if (k === 'stt') {
      if (!isAllowedSttModel(id))
        return `slot stt: invalid model id: ${id}`;
    }
    else if (!isAllowedChatModel(id)) {
      return `slot ${k}: invalid model id: ${id}`;
    }
  }
  return null;
}

/** Pick which slot a chat request should use. */
export function resolveChatSlot(ctx: ResolveContext): ChatSlot {
  const fromScene = normalizeScene(ctx.scene);
  if (fromScene === 'stt')
    return 'default';
  if (fromScene && isChatSlot(fromScene))
    return fromScene;

  if (typeof ctx.requestedModel === 'string' && ctx.requestedModel.trim()) {
    const m = ctx.requestedModel.trim();
    const bySlug = SLUG_TO_SLOT[m] ?? SLUG_TO_SLOT[m.toLowerCase()];
    if (bySlug)
      return bySlug;
  }

  // Shape heuristics (secondary)
  if (ctx.wantsJson && !ctx.hasTools)
    return 'parse';
  if (ctx.hasTools)
    return 'chat';

  return 'default';
}

export function modelForSlot(
  config: ModelRoutingConfig,
  slot: ModelSlot,
): string {
  const hit = config.slots[slot];
  if (typeof hit === 'string' && hit.trim())
    return hit.trim();
  return DEFAULT_SLOT_MODELS[slot];
}

/**
 * Resolve the model id for a chat completion (any upstream).
 * Explicit client `@cf/…` or other safe ids without a scene still pass through
 * for ops/debug; with a scene, the operator slot map wins.
 */
export function resolveChatModel(
  requested: unknown,
  config: ModelRoutingConfig = defaultRoutingConfig(),
  ctx: Omit<ResolveContext, 'requestedModel'> = {},
): string {
  const slot = resolveChatSlot({ ...ctx, requestedModel: requested });

  // Pass-through debug ids when no scene routing applies.
  if (typeof requested === 'string' && requested.trim() && !ctx.scene) {
    const m = requested.trim();
    const inSlugTable = m in SLUG_TO_SLOT || m.toLowerCase() in SLUG_TO_SLOT;
    if (!inSlugTable && isSafeModelId(m) && !CHAT_OPTION_IDS.has(m)) {
      // Unknown custom / @cf id without scene → honor client (ops/debug).
      if (m.startsWith('@cf/') || m.includes('/'))
        return m;
    }
  }

  return modelForSlot(config, slot);
}

export function resolveSttModel(
  requested: unknown,
  config: ModelRoutingConfig = defaultRoutingConfig(),
): string {
  if (typeof requested === 'string' && requested.trim()) {
    const m = requested.trim();
    // Legacy OpenAI STT slugs → stt slot
    if (
      m === 'openai/whisper-1'
      || m === 'whisper-1'
      || m === 'openai/gpt-4o-transcribe'
    ) {
      return modelForSlot(config, 'stt');
    }
    if (m.startsWith('@cf/') && !STT_OPTION_IDS.has(m) && m !== DEFAULT_STT_MODEL)
      return m;
  }
  return modelForSlot(config, 'stt');
}

// ── KV load / save with short in-isolate cache ─────────────────────────────

type CacheEntry = { at: number; key: string; config: ModelRoutingConfig };
let memCache: CacheEntry | null = null;
const CACHE_TTL_MS = 15_000;

export function clearModelConfigCache(): void {
  memCache = null;
}

export async function loadModelConfig(
  kv: KVNamespace | undefined,
  environment?: string,
): Promise<ModelRoutingConfig> {
  const key = modelConfigKvKey(environment);
  const now = Date.now();
  if (memCache && memCache.key === key && now - memCache.at < CACHE_TTL_MS)
    return memCache.config;

  if (!kv) {
    const cfg = defaultRoutingConfig();
    memCache = { at: now, key, config: cfg };
    return cfg;
  }

  try {
    const raw = await kv.get(key, 'json');
    const cfg = normalizeRoutingConfig(raw);
    memCache = { at: now, key, config: cfg };
    return cfg;
  }
  catch {
    const cfg = defaultRoutingConfig();
    memCache = { at: now, key, config: cfg };
    return cfg;
  }
}

export async function saveModelConfig(
  kv: KVNamespace | undefined,
  slotsPatch: Record<string, string>,
  environment?: string,
): Promise<ModelRoutingConfig> {
  const err = validateSlotPatch(slotsPatch);
  if (err)
    throw new Error(err);

  const key = modelConfigKvKey(environment);
  const current = await loadModelConfig(kv, environment);
  const mergedSlots: Partial<Record<ModelSlot, string>> = {
    ...DEFAULT_SLOT_MODELS,
    ...current.slots,
  };
  for (const [k, v] of Object.entries(slotsPatch)) {
    if (k === 'stt' || isChatSlot(k))
      mergedSlots[k as ModelSlot] = v.trim();
  }

  const next: ModelRoutingConfig = {
    version: 1,
    updatedAt: new Date().toISOString(),
    slots: mergedSlots,
  };

  if (kv)
    await kv.put(key, JSON.stringify(next));

  memCache = { at: Date.now(), key, config: next };
  return next;
}

/** Payload fragment for dashboard / API. */
export function catalogPayload(config: ModelRoutingConfig) {
  return {
    slots: { ...DEFAULT_SLOT_MODELS, ...config.slots },
    updatedAt: config.updatedAt,
    chatOptions: CHAT_MODEL_OPTIONS,
    sttOptions: STT_MODEL_OPTIONS,
    chatSlots: CHAT_SLOTS,
    defaults: DEFAULT_SLOT_MODELS,
    /** Operators may type any safe id (OpenAI / OpenRouter / @cf), not only catalog. */
    allowCustomModelIds: true,
  };
}
