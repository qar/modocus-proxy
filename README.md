# Modocus AI Proxy

OpenAI-compatible edge proxy for built-in Modocus AI (iOS/Android app
`ios-sensors` / Modocus).

Standalone repo — kept out of the app monorepo so the client stays a pure
Expo/React Native project.

**Upstreams:** Cloudflare Workers AI (`env.AI`), optional OpenAI / OpenRouter
HTTP (secrets).

## Environments

| Env | Worker | Auth | URL |
|-----|--------|------|-----|
| **production** | `modocus-ai-proxy` | Apple JWS only | `https://ai.modocus.app` |
| **staging** | `modocus-ai-proxy-staging` | JWS or `DEV_BYPASS_TOKEN` | `*.workers.dev` |

## Model routing (per task type)

Proxy resolves a **slot** from the request, then looks up the operator-chosen
model for that slot (KV). Defaults are all `@cf/openai/gpt-oss-120b` until you
change them on the dashboard.

### Upstreams

| Model id pattern | Upstream | Secret |
|------------------|----------|--------|
| `@cf/…` | Workers AI binding | (none) |
| `gpt-4o-mini`, `gpt-4o`, `openai/gpt-4o-mini`, `chatgpt-4o-mini`… | OpenAI | `OPENAI_API_KEY` |
| `anthropic/…`, `google/…`, other `org/model` | OpenRouter | `OPENROUTER_API_KEY` |

Custom ids are allowed (safe charset). Dashboard dropdown lists common options
plus **Custom model id…**.

```bash
# enable OpenAI (prod + staging)
printf '%s' "$OPENAI_API_KEY" | npx wrangler secret put OPENAI_API_KEY
printf '%s' "$OPENAI_API_KEY" | npx wrangler secret put OPENAI_API_KEY --env staging

# optional OpenRouter
printf '%s' "$OPENROUTER_API_KEY" | npx wrangler secret put OPENROUTER_API_KEY
```

### Slots

| Slot | Typical app traffic | Scene header |
|------|---------------------|--------------|
| `parse` | quickAdd, meeting extract, ping | `X-Modocus-Scene: parse` |
| `plan` | task plan | `plan` |
| `estimate` | duration estimate | `estimate` |
| `chat` | assistant chat + tools | `chat` |
| `insight` | weekly insight | `insight` |
| `strong` | escalate / flagship slug | `strong` |
| `default` | fallback | — |
| `stt` | cloud transcription | `stt` / path `/audio/transcriptions` |

**Resolution order (chat):**

1. Header `X-Modocus-Scene` (or body `modocus_scene` / `purpose`)
2. Client model slug heuristic (`gpt-4.1-nano` → parse, `gpt-4o-mini` → chat, `gpt-4o` → strong)
3. Shape: `response_format=json` → parse; non-empty `tools` → chat
4. Slot `default`

**Change models live (no redeploy):**

1. Open `https://ai.modocus.app/dashboard` (or staging) with `DASHBOARD_TOKEN`
2. Panel **Model routing** — dropdown or custom id per slot
3. **Save routing** → `PUT /dashboard/api/models` → KV (~15s)

```bash
# read
curl -sS -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  https://ai.modocus.app/dashboard/api/models

# use OpenAI mini for parse/chat, CF 120b for strong
curl -sS -X PUT -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"slots":{"parse":"gpt-4o-mini","chat":"gpt-4o-mini","strong":"gpt-4o","default":"gpt-4o-mini"}}' \
  https://ai.modocus.app/dashboard/api/models
```

Product notes (live in the app repo):  
`ios-sensors/docs/proposals/ai-proxy-hybrid-routing.md`

## Deploy

```bash
cd /Users/qiaoanran/projects/modocus-proxy   # or clone path
pnpm install
pnpm deploy:prod       # production → ai.modocus.app
pnpm deploy:staging    # staging    → ai-staging.modocus.app

# staging dogfood only:
printf '%s' "$DEV_BYPASS_TOKEN" | npx wrangler secret put DEV_BYPASS_TOKEN --env staging
```

App points at this proxy via `EXPO_PUBLIC_AI_PROXY_URL` (see app
`load-app-env.cjs` / `.env.development` | `.env.preview` | `.env.production`):

| App env file | Proxy URL |
|--------------|-----------|
| `.env.development` / `.env.preview` | `https://ai-staging.modocus.app/v1` |
| `.env.production` | `https://ai.modocus.app/v1` |
| `.env.local` (app, gitignored) | secrets e.g. `EXPO_PUBLIC_AI_DEV_BYPASS` |

## Smoke

```bash
curl -sS https://ai.modocus.app/health
# {"ok":true,"env":"production","upstream":{"workersAi":true,"openai":true,"openrouter":false},...}

# staging + bypass
curl -sS -X POST https://modocus-ai-proxy-staging..../v1/chat/completions \
  -H "authorization: Bearer $DEV_BYPASS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":32}'
```

## Auth / limits

See previous hardening: production JWS only; daily cap per `originalTransactionId`.


## Dashboard

Operator UI (usage counters, rough cost hint, recent events):

```
https://ai.modocus.app/dashboard
```

```bash
# set once (production + staging)
printf '%s' "$(openssl rand -hex 24)" | npx wrangler secret put DASHBOARD_TOKEN
printf '%s' "$DASHBOARD_TOKEN" | npx wrangler secret put DASHBOARD_TOKEN --env staging
```

- Open `/dashboard`, paste token (stored in httpOnly cookie)
- JSON: `GET /dashboard/api` with `Authorization: Bearer <DASHBOARD_TOKEN>`
- Model routing: `GET|PUT /dashboard/api/models` (same auth)
- Does **not** log request bodies; subject ids are truncated
- **Real $** still comes from Cloudflare Billing → Workers AI (Neurons). Dashboard cost is a rough heuristic only.
