/**
 * Operator dashboard — HTML + JSON.
 * Auth: DASHBOARD_TOKEN (Bearer, cookie, or ?token= once then Set-Cookie).
 */

import {
  catalogPayload,
  CHAT_SLOTS,
  loadModelConfig,
  saveModelConfig,
  type ModelSlot,
} from './models';
import {
  listSubjectUsage,
  loadEvents,
  loadHistory,
  roughCostHint,
  utcDay,
  type DayAgg,
} from './metrics';
import { upstreamCapabilities } from './upstream';

export type DashboardEnv = {
  DASHBOARD_TOKEN?: string;
  ENVIRONMENT?: string;
  DAILY_LIMIT?: string;
  USAGE?: KVNamespace;
  ALLOWED_BUNDLE_IDS?: string;
  ALLOWED_PRODUCT_IDS?: string;
  ALLOW_SANDBOX?: string;
  AI_GATEWAY_ID?: string;
  ALLOW_LEGACY_HTTP_UPSTREAM?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
};

const SLOT_LABELS: Record<ModelSlot, string> = {
  default: 'Default (fallback)',
  parse: 'Parse / extract / quickAdd',
  plan: 'Plan',
  estimate: 'Estimate',
  chat: 'Chat',
  insight: 'Insight',
  strong: 'Strong / escalate',
  stt: 'Speech-to-text',
};

const COOKIE = 'modocus_dash';
const DEFAULT_DAILY_LIMIT = 80;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length)
    return false;
  let out = 0;
  for (let i = 0; i < a.length; i++)
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function extractDashboardToken(req: Request): string | null {
  const url = new URL(req.url);
  const q = url.searchParams.get('token');
  if (q)
    return q;
  const h = req.headers.get('authorization');
  if (h) {
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    if (m)
      return m[1]!.trim();
  }
  const cookie = req.headers.get('cookie') ?? '';
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookie);
  if (m)
    return decodeURIComponent(m[1]!);
  return null;
}

export function isDashboardAuthorized(env: DashboardEnv, req: Request): boolean {
  const expected = env.DASHBOARD_TOKEN;
  if (!expected || expected.length < 16)
    return false;
  const got = extractDashboardToken(req);
  if (!got)
    return false;
  return timingSafeEqual(got, expected);
}

function html(body: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      ...headers,
    },
  });
}

function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

const shell = (title: string, inner: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
  :root {
    --bg: #0f1419;
    --panel: #1a2332;
    --border: #2d3a4d;
    --text: #e7ecf3;
    --muted: #8b9bb4;
    --accent: #5b9fd4;
    --ok: #3ecf8e;
    --warn: #e6b84d;
    --bad: #e85d5d;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    --sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    font-family: var(--sans);
    background: var(--bg); color: var(--text);
    line-height: 1.45;
  }
  h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 4px; }
  h2 { font-size: 0.95rem; font-weight: 600; margin: 0 0 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .sub { color: var(--muted); font-size: .9rem; margin-bottom: 24px; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); margin-bottom: 24px; }
  .card {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 12px; padding: 14px 16px;
  }
  .card .label { font-size: .75rem; color: var(--muted); margin-bottom: 6px; }
  .card .value { font-size: 1.5rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .card .hint { font-size: .75rem; color: var(--muted); margin-top: 4px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; font-size: .75rem; text-transform: uppercase; }
  td.mono, .mono { font-family: var(--mono); font-size: .8rem; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  a { color: var(--accent); }
  input[type=password], select, button {
    font: inherit; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--bg); color: var(--text);
  }
  select { width: 100%; max-width: 420px; padding: 8px 10px; }
  button { background: var(--accent); color: #0a0e14; border: none; font-weight: 600; cursor: pointer; }
  button.secondary { background: transparent; color: var(--text); border: 1px solid var(--border); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #243044; font-size: .75rem; color: var(--muted); }
  footer { margin-top: 32px; color: var(--muted); font-size: .8rem; }
  .bar-wrap { display: flex; flex-direction: column; gap: 6px; }
  .bar-row { display: grid; grid-template-columns: 100px 1fr 48px; gap: 8px; align-items: center; font-size: .8rem; }
  .bar { height: 8px; background: #243044; border-radius: 4px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: var(--accent); }
  .slot-grid { display: grid; gap: 12px; }
  .slot-row {
    display: grid; grid-template-columns: minmax(140px, 200px) 1fr;
    gap: 10px 16px; align-items: center;
  }
  @media (max-width: 640px) {
    .slot-row { grid-template-columns: 1fr; }
  }
  .slot-row label { font-size: .85rem; color: var(--muted); }
  .slot-row label strong { display: block; color: var(--text); font-weight: 600; margin-bottom: 2px; }
  .slot-controls { display: flex; flex-direction: column; gap: 6px; max-width: 480px; }
  .slot-controls input[type=text] {
    font: inherit; font-family: var(--mono); font-size: .8rem;
    padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--bg); color: var(--text); width: 100%;
  }
  .slot-controls input.hidden { display: none; }
  #model-save-status { font-size: .85rem; min-height: 1.2em; }
</style>
</head>
<body>
${inner}
</body>
</html>`;

function loginPage(error?: string): Response {
  return html(shell('Modocus AI Proxy — Login', `
  <h1>Modocus AI Proxy</h1>
  <p class="sub">Operator dashboard</p>
  <div class="panel" style="max-width:420px">
    <h2>Sign in</h2>
    ${error ? `<p class="bad">${error}</p>` : ''}
    <form method="GET" action="/dashboard" class="row">
      <input type="password" name="token" placeholder="DASHBOARD_TOKEN" required autofocus style="flex:1;min-width:180px"/>
      <button type="submit">Open</button>
    </form>
    <p class="sub" style="margin:12px 0 0">Token is stored in an httpOnly cookie for this host. Or use <span class="mono">Authorization: Bearer …</span> on <span class="mono">/dashboard/api</span>.</p>
  </div>
  `));
}

function disabledPage(): Response {
  return html(shell('Dashboard disabled', `
  <h1>Dashboard disabled</h1>
  <p class="sub">Set secret <span class="mono">DASHBOARD_TOKEN</span> (≥16 chars) then redeploy / put secret.</p>
  <pre class="panel mono">printf '%s' "$(openssl rand -hex 24)" | npx wrangler secret put DASHBOARD_TOKEN</pre>
  `), 503);
}

function fmtMs(agg: DayAgg): string {
  if (!agg.latencyMsCount)
    return '—';
  return `${Math.round(agg.latencyMsSum / agg.latencyMsCount)} ms`;
}

function statusClass(s: number): string {
  if (s >= 500)
    return 'bad';
  if (s === 429 || s >= 400)
    return 'warn';
  return 'ok';
}

export async function buildStatsPayload(env: DashboardEnv): Promise<Record<string, unknown>> {
  const day = utcDay();
  const dailyLimit = Number(env.DAILY_LIMIT ?? DEFAULT_DAILY_LIMIT) || DEFAULT_DAILY_LIMIT;
  const history = await loadHistory(env.USAGE, 7);
  const today = history[0] ?? (await loadHistory(env.USAGE, 1))[0];
  if (!today)
    throw new Error('metrics unavailable');
  const events = await loadEvents(env.USAGE);
  const subjects = await listSubjectUsage(env.USAGE, day, dailyLimit);
  const cost = roughCostHint(today);
  const routing = await loadModelConfig(env.USAGE, env.ENVIRONMENT);
  const catalog = catalogPayload(routing);
  const caps = upstreamCapabilities(env);

  return {
    generatedAt: new Date().toISOString(),
    environment: (env.ENVIRONMENT ?? 'production').toLowerCase(),
    upstream: caps,
    day,
    dailyLimitPerSubject: dailyLimit,
    today,
    history,
    subjects,
    events,
    costHint: cost,
    models: {
      // legacy keys (compat)
      defaultChat: catalog.slots.default,
      strongChat: catalog.slots.strong,
      fastChat: catalog.slots.parse,
      defaultStt: catalog.slots.stt,
      // full routing
      routing: catalog,
    },
    config: {
      allowedBundleIds: env.ALLOWED_BUNDLE_IDS ?? '(default)',
      allowedProductIds: env.ALLOWED_PRODUCT_IDS ?? '(default)',
      allowSandbox: env.ALLOW_SANDBOX !== 'false',
      kvBound: Boolean(env.USAGE),
      openaiBase: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      openrouterBase: env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    },
    links: {
      cfWorkersAiUsage: 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai',
      cfBilling: 'https://dash.cloudflare.com/?to=/:account/billing',
      cfBillableUsage: 'https://developers.cloudflare.com/billing/manage/billable-usage/',
    },
  };
}

function renderDashboard(data: Awaited<ReturnType<typeof buildStatsPayload>>): string {
  const today = data.today as DayAgg;
  const history = data.history as DayAgg[];
  const subjects = data.subjects as { subject: string; n: number; limit: number }[];
  const events = data.events as { ts: string; route: string; status: number; model?: string; auth?: string; subject?: string; ms?: number; note?: string }[];
  const cost = data.costHint as ReturnType<typeof roughCostHint>;
  const models = data.models as {
    defaultChat?: string;
    strongChat?: string;
    fastChat?: string;
    defaultStt?: string;
    routing?: {
      slots: Record<string, string>;
      updatedAt: string;
      chatOptions: { id: string; label: string; tier: string }[];
      sttOptions: { id: string; label: string; tier: string }[];
      defaults: Record<string, string>;
    };
  };
  const routing = models.routing;
  const maxReq = Math.max(1, ...history.map(h => h.requests));
  const upstream = (data.upstream ?? {}) as {
    workersAi?: boolean;
    aiGateway?: boolean;
    gatewayId?: string | null;
    legacyHttp?: boolean;
    openaiKey?: boolean;
    openrouterKey?: boolean;
    // legacy field names (older payloads)
    openai?: boolean;
    openrouter?: boolean;
  };

  const modelRows = Object.entries(today.byModel)
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `<tr><td class="mono">${escapeHtml(m)}</td><td>${n}</td></tr>`)
    .join('') || '<tr><td colspan="2" class="sub">No model traffic today</td></tr>';

  const subRows = subjects
    .map(s => `<tr><td class="mono">${escapeHtml(s.subject)}</td><td>${s.n} / ${s.limit}</td></tr>`)
    .join('') || '<tr><td colspan="2" class="sub">No subject counters today</td></tr>';

  const evRows = events.slice(0, 25).map(e => `
    <tr>
      <td class="mono">${escapeHtml(e.ts.slice(11, 19))}Z</td>
      <td>${escapeHtml(e.route)}</td>
      <td class="${statusClass(e.status)}">${e.status}</td>
      <td class="mono">${escapeHtml(e.model ?? '—')}</td>
      <td class="mono">${escapeHtml(e.subject ?? e.auth ?? '—')}</td>
      <td>${e.ms != null ? `${e.ms}ms` : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="sub">No events yet</td></tr>';

  const bars = history.slice().reverse().map(h => {
    const pct = Math.round((h.requests / maxReq) * 100);
    return `<div class="bar-row"><span class="mono">${h.day.slice(5)}</span><div class="bar"><i style="width:${pct}%"></i></div><span>${h.requests}</span></div>`;
  }).join('');

  type Opt = { id: string; label: string; tier: string; provider?: string };
  const chatOpts = (routing?.chatOptions ?? []) as Opt[];
  const sttOpts = (routing?.sttOptions ?? []) as Opt[];
  const slots = routing?.slots ?? {};

  const optionHtml = (opts: Opt[], selected: string, inCatalog: boolean) => {
    const optsHtml = opts.map(o =>
      `<option value="${escapeHtml(o.id)}" ${inCatalog && o.id === selected ? 'selected' : ''}>${escapeHtml(o.label)} · ${escapeHtml(o.provider ?? '?')} · ${escapeHtml(o.tier)}</option>`,
    ).join('');
    return `${optsHtml}<option value="__custom__" ${inCatalog ? '' : 'selected'}>Custom model id…</option>`;
  };

  const slotRows = [...CHAT_SLOTS, 'stt' as const].map((slot) => {
    const opts = slot === 'stt' ? sttOpts : chatOpts;
    const cur = slots[slot] ?? '';
    const inCatalog = opts.some(o => o.id === cur);
    return `
      <div class="slot-row">
        <label for="slot-${slot}">
          <strong>${escapeHtml(SLOT_LABELS[slot])}</strong>
          <span class="mono">${slot}</span>
        </label>
        <div class="slot-controls">
          <select name="${slot}" id="slot-${slot}" data-slot="${slot}" data-select>
            ${optionHtml(opts, cur, inCatalog)}
          </select>
          <input type="text" data-custom-for="${slot}"
            class="${inCatalog ? 'hidden' : ''}"
            placeholder="e.g. gpt-4o-mini or anthropic/claude-3.5-haiku"
            value="${inCatalog ? '' : escapeHtml(cur)}"
            autocomplete="off" spellcheck="false"/>
        </div>
      </div>`;
  }).join('');

  // Safe embed in <script type="application/json"> — escape only </script.
  const routingJson = JSON.stringify({
    slots,
    updatedAt: routing?.updatedAt ?? null,
    chatOptions: chatOpts,
    sttOptions: sttOpts,
    defaults: routing?.defaults ?? {},
  }).replace(/</g, '\\u003c');

  const pill = (ok: boolean | undefined, label: string) =>
    `<span class="pill ${ok ? 'ok' : 'warn'}">${label}: ${ok ? 'on' : 'off'}</span>`;

  return shell('Modocus AI Proxy', `
  <div class="row" style="justify-content:space-between;margin-bottom:8px">
    <div>
      <h1>Modocus AI Proxy</h1>
      <p class="sub">
        <span class="pill">${escapeHtml(String(data.environment))}</span>
        ${pill(upstream.workersAi, 'Workers AI')}
        ${pill(upstream.aiGateway ?? false, `AI Gateway${upstream.gatewayId ? `:${upstream.gatewayId}` : ''}`)}
        ${upstream.legacyHttp ? pill(true, 'legacy HTTP') : ''}
        <span class="pill">${escapeHtml(String(data.day))} UTC</span>
        ${data.config && (data.config as { kvBound?: boolean }).kvBound ? '<span class="pill ok">KV</span>' : '<span class="pill warn">mem-only</span>'}
      </p>
    </div>
    <div class="row">
      <a href="/dashboard/api">JSON API</a>
      <a href="/health">/health</a>
    </div>
  </div>

  <div class="grid">
    <div class="card"><div class="label">Requests today</div><div class="value">${today.requests}</div></div>
    <div class="card"><div class="label">Chat</div><div class="value">${today.chat}</div></div>
    <div class="card"><div class="label">STT</div><div class="value">${today.stt}</div></div>
    <div class="card"><div class="label">OK</div><div class="value ok">${today.ok}</div></div>
    <div class="card"><div class="label">Auth fail</div><div class="value ${today.authFail ? 'warn' : ''}">${today.authFail}</div></div>
    <div class="card"><div class="label">429 limited</div><div class="value ${today.rateLimited ? 'warn' : ''}">${today.rateLimited}</div></div>
    <div class="card"><div class="label">5xx</div><div class="value ${today.err5xx ? 'bad' : ''}">${today.err5xx}</div></div>
    <div class="card"><div class="label">Avg latency</div><div class="value" style="font-size:1.2rem">${fmtMs(today)}</div></div>
  </div>

  <div class="panel" id="model-routing-panel">
    <h2>Model routing (live)</h2>
    <p class="sub">
      Per-task model — <span class="mono">@cf/…</span> → Workers AI (Neurons);
      <span class="mono">openai/…</span> · <span class="mono">anthropic/…</span> · <span class="mono">google/…</span>
      → AI Gateway Unified Billing (same Cloudflare account). Saved to KV (no redeploy).
      App sends <span class="mono">X-Modocus-Scene</span>. Requires var <span class="mono">AI_GATEWAY_ID</span>
      + Gateway credits in the CF dashboard.
    </p>
    <form id="model-routing-form" class="slot-grid">
      ${slotRows}
      <div class="row" style="margin-top:8px">
        <button type="submit" id="model-save-btn">Save routing</button>
        <button type="button" class="secondary" id="model-reset-btn">Reset to defaults</button>
        <span id="model-save-status" class="sub"></span>
      </div>
    </form>
    <p class="sub" style="margin-top:12px">Last saved: <span class="mono" id="model-updated-at">${escapeHtml(routing?.updatedAt ?? 'defaults')}</span>
      · API: <span class="mono">GET/PUT /dashboard/api/models</span>
      ${!upstream.aiGateway ? ' · <span class="warn">AI_GATEWAY_ID missing — third-party models will 503</span>' : ''}
    </p>
  </div>

  <div class="panel">
    <h2>Cost hint (not a bill)</h2>
    <p>Est. Neurons today: <strong>${cost.estNeuronsLow.toLocaleString()} – ${cost.estNeuronsHigh.toLocaleString()}</strong>
       · rough USD <strong>$${cost.estUsdLow} – $${cost.estUsdHigh}</strong></p>
    <p class="sub">${escapeHtml(cost.note)}</p>
    <p class="sub">
      Official dollars:
      <a href="${(data.links as { cfWorkersAiUsage: string }).cfWorkersAiUsage}" target="_blank" rel="noopener">Workers AI Usage</a> ·
      <a href="${(data.links as { cfBilling: string }).cfBilling}" target="_blank" rel="noopener">Billing</a>
    </p>
  </div>

  <div class="panel">
    <h2>Last 7 days — requests</h2>
    <div class="bar-wrap">${bars}</div>
  </div>

  <div class="panel">
    <h2>Models today</h2>
    <table><thead><tr><th>Model</th><th>Count</th></tr></thead><tbody>${modelRows}</tbody></table>
  </div>

  <div class="panel">
    <h2>Subjects today (daily cap ${data.dailyLimitPerSubject})</h2>
    <table><thead><tr><th>Subject</th><th>Used</th></tr></thead><tbody>${subRows}</tbody></table>
  </div>

  <div class="panel">
    <h2>Recent events</h2>
    <table>
      <thead><tr><th>Time</th><th>Route</th><th>Status</th><th>Model</th><th>Who</th><th>ms</th></tr></thead>
      <tbody>${evRows}</tbody>
    </table>
    <p class="sub">Auth today — jws: ${today.byAuth.jws} · bypass: ${today.byAuth.bypass} · none: ${today.byAuth.none}</p>
  </div>

  <footer>
    Generated ${escapeHtml(String(data.generatedAt))} · no request bodies logged ·
    <a href="/dashboard?logout=1">Log out</a>
  </footer>
  <script type="application/json" id="routing-bootstrap">${routingJson}</script>
  <script>
(function () {
  var dirty = false;
  var form = document.getElementById('model-routing-form');
  var statusEl = document.getElementById('model-save-status');
  var updatedEl = document.getElementById('model-updated-at');
  var saveBtn = document.getElementById('model-save-btn');
  var resetBtn = document.getElementById('model-reset-btn');
  var boot = {};
  try {
    boot = JSON.parse(document.getElementById('routing-bootstrap').textContent || '{}');
  } catch (e) {}

  function syncCustomVisibility(sel) {
    var slot = sel.getAttribute('data-slot');
    var input = form.querySelector('input[data-custom-for="' + slot + '"]');
    if (!input) return;
    if (sel.value === '__custom__') {
      input.classList.remove('hidden');
      if (!input.value) input.focus();
    } else {
      input.classList.add('hidden');
    }
  }

  form.querySelectorAll('select[data-select]').forEach(function (sel) {
    sel.addEventListener('change', function () { syncCustomVisibility(sel); });
  });

  form.addEventListener('change', function () {
    dirty = true;
    statusEl.textContent = 'Unsaved changes';
    statusEl.className = 'warn';
  });
  form.addEventListener('input', function () {
    dirty = true;
    statusEl.textContent = 'Unsaved changes';
    statusEl.className = 'warn';
  });

  function collectSlots() {
    var out = {};
    form.querySelectorAll('select[data-slot]').forEach(function (sel) {
      var slot = sel.getAttribute('data-slot');
      if (sel.value === '__custom__') {
        var input = form.querySelector('input[data-custom-for="' + slot + '"]');
        out[slot] = (input && input.value || '').trim();
      } else {
        out[slot] = sel.value;
      }
    });
    return out;
  }

  function applySlots(slots) {
    if (!slots) return;
    Object.keys(slots).forEach(function (k) {
      var sel = form.querySelector('select[data-slot="' + k + '"]');
      var input = form.querySelector('input[data-custom-for="' + k + '"]');
      if (!sel) return;
      var val = slots[k];
      var hasOpt = false;
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === val) { hasOpt = true; break; }
      }
      if (hasOpt && val !== '__custom__') {
        sel.value = val;
        if (input) { input.value = ''; input.classList.add('hidden'); }
      } else {
        sel.value = '__custom__';
        if (input) { input.value = val; input.classList.remove('hidden'); }
      }
    });
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    statusEl.className = 'sub';
    fetch('/dashboard/api/models', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ slots: collectSlots() }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        saveBtn.disabled = false;
        if (!res.ok) {
          statusEl.textContent = (res.j && res.j.error && res.j.error.message) || 'Save failed';
          statusEl.className = 'bad';
          return;
        }
        dirty = false;
        statusEl.textContent = 'Saved';
        statusEl.className = 'ok';
        if (res.j && res.j.updatedAt) updatedEl.textContent = res.j.updatedAt;
        if (res.j && res.j.slots) applySlots(res.j.slots);
      })
      .catch(function (e) {
        saveBtn.disabled = false;
        statusEl.textContent = String(e && e.message || e);
        statusEl.className = 'bad';
      });
  });

  resetBtn.addEventListener('click', function () {
    if (!boot.defaults) return;
    applySlots(boot.defaults);
    dirty = true;
    statusEl.textContent = 'Reset to defaults (not saved yet)';
    statusEl.className = 'warn';
  });

  // Auto-refresh stats, but not while the form is dirty.
  setTimeout(function () {
    if (!dirty) location.reload();
  }, 60000);
})();
  </script>
  `);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Handle /dashboard and /dashboard/api
 */
export async function handleDashboard(req: Request, env: DashboardEnv): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (!env.DASHBOARD_TOKEN || env.DASHBOARD_TOKEN.length < 16)
    return disabledPage();

  // logout
  if (url.searchParams.get('logout') === '1') {
    return html(shell('Logged out', `<p>Logged out. <a href="/dashboard">Sign in</a></p>`), 200, {
      'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    });
  }

  // Login via ?token= → set cookie and redirect clean URL
  const qToken = url.searchParams.get('token');
  if (qToken && path === '/dashboard') {
    if (!timingSafeEqual(qToken, env.DASHBOARD_TOKEN))
      return loginPage('Invalid token');
    return new Response(null, {
      status: 302,
      headers: {
        location: '/dashboard',
        'set-cookie': `${COOKIE}=${encodeURIComponent(qToken)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`,
        'cache-control': 'no-store',
      },
    });
  }

  if (!isDashboardAuthorized(env, req)) {
    if (path.includes('/api'))
      return json({ error: { message: 'unauthorized', code: 'auth' } }, 401);
    return loginPage();
  }

  // GET /dashboard/api/models — current routing + catalog
  if (
    (req.method === 'GET' || req.method === 'HEAD')
    && (path.endsWith('/api/models') || path.endsWith('/dashboard/api/models'))
  ) {
    const routing = await loadModelConfig(env.USAGE, env.ENVIRONMENT);
    return json(catalogPayload(routing));
  }

  // PUT /dashboard/api/models — { slots: { parse: "@cf/...", ... } }
  if (
    req.method === 'PUT'
    && (path.endsWith('/api/models') || path.endsWith('/dashboard/api/models'))
  ) {
    if (!env.USAGE) {
      return json({
        error: {
          message: 'KV not bound — cannot persist model routing',
          code: 'no_kv',
        },
      }, 503);
    }
    let body: unknown;
    try {
      body = await req.json();
    }
    catch {
      return json({ error: { message: 'invalid_json', code: 'bad_request' } }, 400);
    }
    const slots = body != null && typeof body === 'object' && !Array.isArray(body)
      ? (body as { slots?: unknown }).slots ?? body
      : null;
    try {
      const saved = await saveModelConfig(
        env.USAGE,
        slots as Record<string, string>,
        env.ENVIRONMENT,
      );
      return json(catalogPayload(saved));
    }
    catch (e) {
      const msg = e instanceof Error ? e.message : 'save_failed';
      return json({ error: { message: msg, code: 'bad_request' } }, 400);
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (path.includes('/api'))
      return json({ error: { message: 'method_not_allowed', code: 'bad_request' } }, 405);
    return html(shell('Method not allowed', '<p>Method not allowed</p>'), 405);
  }

  const data = await buildStatsPayload(env);

  if (path.endsWith('/api') || path.endsWith('/api/stats'))
    return json(data);

  return html(renderDashboard(data));
}
