/**
 * Aggregate usage metrics in KV for the operator dashboard.
 * Privacy: never store request/response bodies, raw tokens, or full JWS.
 */

export type DayAgg = {
  day: string;
  requests: number;
  chat: number;
  stt: number;
  ok: number;
  authFail: number;
  rateLimited: number;
  err4xx: number;
  err5xx: number;
  byModel: Record<string, number>;
  byAuth: { jws: number; bypass: number; none: number };
  latencyMsSum: number;
  latencyMsCount: number;
};

export type MetricEvent = {
  ts: string;
  route: string;
  status: number;
  model?: string;
  auth?: string;
  /** Truncated subject id only (e.g. tx:abcd… / bypass:…). */
  subject?: string;
  ms?: number;
  note?: string;
};

export type SubjectUsage = {
  subject: string;
  n: number;
  limit: number;
};

const TTL_SEC = 60 * 60 * 24 * 14; // 14 days
const EVENTS_KEY = 'm:events';
const MAX_EVENTS = 40;

const memAgg = new Map<string, DayAgg>();
const memEvents: MetricEvent[] = [];
const memSubjects = new Map<string, number>();

export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function emptyAgg(day: string): DayAgg {
  return {
    day,
    requests: 0,
    chat: 0,
    stt: 0,
    ok: 0,
    authFail: 0,
    rateLimited: 0,
    err4xx: 0,
    err5xx: 0,
    byModel: {},
    byAuth: { jws: 0, bypass: 0, none: 0 },
    latencyMsSum: 0,
    latencyMsCount: 0,
  };
}

function aggKey(day: string): string {
  return `m:${day}:agg`;
}

export async function loadDayAgg(kv: KVNamespace | undefined, day: string): Promise<DayAgg> {
  if (!kv) {
    return memAgg.get(day) ?? emptyAgg(day);
  }
  const raw = await kv.get(aggKey(day));
  if (!raw)
    return emptyAgg(day);
  try {
    return { ...emptyAgg(day), ...(JSON.parse(raw) as DayAgg), day };
  }
  catch {
    return emptyAgg(day);
  }
}

async function saveDayAgg(kv: KVNamespace | undefined, agg: DayAgg): Promise<void> {
  if (!kv) {
    memAgg.set(agg.day, agg);
    return;
  }
  await kv.put(aggKey(agg.day), JSON.stringify(agg), { expirationTtl: TTL_SEC });
}

function shortSubject(subject: string | undefined): string | undefined {
  if (!subject)
    return undefined;
  if (subject.length <= 20)
    return subject;
  return `${subject.slice(0, 12)}…${subject.slice(-4)}`;
}

export type RecordMetricInput = {
  route: 'chat' | 'stt' | 'auth' | 'other' | 'dashboard';
  status: number;
  model?: string;
  authKind?: 'jws' | 'dev_bypass' | 'none';
  subject?: string;
  ms?: number;
  note?: string;
};

export async function recordMetric(
  kv: KVNamespace | undefined,
  input: RecordMetricInput,
): Promise<void> {
  const day = utcDay();
  const agg = await loadDayAgg(kv, day);

  if (input.route !== 'dashboard') {
    agg.requests += 1;
    if (input.route === 'chat')
      agg.chat += 1;
    if (input.route === 'stt')
      agg.stt += 1;

    if (input.status === 401 || input.status === 403)
      agg.authFail += 1;
    else if (input.status === 429)
      agg.rateLimited += 1;
    else if (input.status >= 500)
      agg.err5xx += 1;
    else if (input.status >= 400)
      agg.err4xx += 1;
    else if (input.status >= 200 && input.status < 300)
      agg.ok += 1;

    const ak = input.authKind === 'jws'
      ? 'jws'
      : input.authKind === 'dev_bypass'
        ? 'bypass'
        : 'none';
    agg.byAuth[ak] += 1;

    if (input.model) {
      const m = input.model.length > 64 ? `${input.model.slice(0, 61)}…` : input.model;
      agg.byModel[m] = (agg.byModel[m] ?? 0) + 1;
    }

    if (typeof input.ms === 'number' && Number.isFinite(input.ms)) {
      agg.latencyMsSum += input.ms;
      agg.latencyMsCount += 1;
    }
  }

  await saveDayAgg(kv, agg);

  // Recent event ring (skip pure dashboard page loads spam — keep API samples)
  if (input.route !== 'dashboard' || input.status >= 400) {
    const ev: MetricEvent = {
      ts: new Date().toISOString(),
      route: input.route,
      status: input.status,
      model: input.model,
      auth: input.authKind,
      subject: shortSubject(input.subject),
      ms: input.ms,
      note: input.note,
    };
    await pushEvent(kv, ev);
  }
}

async function pushEvent(kv: KVNamespace | undefined, ev: MetricEvent): Promise<void> {
  if (!kv) {
    memEvents.unshift(ev);
    if (memEvents.length > MAX_EVENTS)
      memEvents.length = MAX_EVENTS;
    return;
  }
  let list: MetricEvent[] = [];
  try {
    const raw = await kv.get(EVENTS_KEY);
    if (raw)
      list = JSON.parse(raw) as MetricEvent[];
  }
  catch { /* ignore */ }
  list.unshift(ev);
  if (list.length > MAX_EVENTS)
    list = list.slice(0, MAX_EVENTS);
  await kv.put(EVENTS_KEY, JSON.stringify(list), { expirationTtl: TTL_SEC });
}

export async function loadEvents(kv: KVNamespace | undefined): Promise<MetricEvent[]> {
  if (!kv)
    return [...memEvents];
  try {
    const raw = await kv.get(EVENTS_KEY);
    if (!raw)
      return [];
    return JSON.parse(raw) as MetricEvent[];
  }
  catch {
    return [];
  }
}

/** Per-subject daily counters written by bumpUsage (`u:day:subject`). */
export async function listSubjectUsage(
  kv: KVNamespace | undefined,
  day: string,
  limit: number,
): Promise<SubjectUsage[]> {
  const dailyLimit = limit;
  if (!kv) {
    const out: SubjectUsage[] = [];
    for (const [k, n] of memSubjects) {
      if (k.startsWith(`u:${day}:`))
        out.push({ subject: shortSubject(k.slice(`u:${day}:`.length)) ?? k, n, limit: dailyLimit });
    }
    return out.sort((a, b) => b.n - a.n).slice(0, 50);
  }

  const out: SubjectUsage[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: `u:${day}:`, cursor, limit: 100 });
    for (const key of page.keys) {
      const raw = await kv.get(key.name);
      const n = raw ? Number(raw) : 0;
      const subject = key.name.slice(`u:${day}:`.length);
      out.push({
        subject: shortSubject(subject) ?? subject,
        n: Number.isFinite(n) ? n : 0,
        limit: dailyLimit,
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return out.sort((a, b) => b.n - a.n).slice(0, 50);
}

/** Track subject counter in memory fallback (tests / no KV). */
export function memNoteSubject(day: string, subject: string, n: number): void {
  memSubjects.set(`u:${day}:${subject}`, n);
}

export async function loadHistory(
  kv: KVNamespace | undefined,
  days: number,
): Promise<DayAgg[]> {
  const out: DayAgg[] = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const d = utcDay(new Date(now - i * 86400000));
    out.push(await loadDayAgg(kv, d));
  }
  return out;
}

/**
 * Very rough $ estimate for Operators (not a bill).
 * Assumes ~avg Neurons per chat/stt — tune via env later if needed.
 * CF bills Workers AI in Neurons; exact $ is only in CF Billing.
 */
export function roughCostHint(agg: DayAgg): {
  note: string;
  estNeuronsLow: number;
  estNeuronsHigh: number;
  estUsdLow: number;
  estUsdHigh: number;
} {
  // Heuristic: short chat ~50–400 neurons; stt higher variance
  const chatLow = agg.chat * 40;
  const chatHigh = agg.chat * 400;
  const sttLow = agg.stt * 200;
  const sttHigh = agg.stt * 2000;
  const estNeuronsLow = chatLow + sttLow;
  const estNeuronsHigh = chatHigh + sttHigh;
  // $0.011 / 1k neurons
  const rate = 0.011 / 1000;
  return {
    note: 'Rough heuristic only — real $ is Cloudflare Billing → Workers AI (Neurons). Free tier ~10k Neurons/day.',
    estNeuronsLow,
    estNeuronsHigh,
    estUsdLow: Math.round(estNeuronsLow * rate * 10000) / 10000,
    estUsdHigh: Math.round(estNeuronsHigh * rate * 10000) / 10000,
  };
}
