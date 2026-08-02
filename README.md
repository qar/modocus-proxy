# Modocus AI Proxy

OpenAI-compatible edge proxy for built-in Modocus AI (iOS/Android app
**ios-sensors** / Modocus).

Standalone repo — kept out of the app monorepo so the client stays a pure
Expo/React Native project.

**Repo:** https://github.com/qar/modocus-proxy  

**Upstreams:** Workers AI (`@cf/…`, Neurons) + **AI Gateway** third-party
models (Unified Billing on the same Cloudflare account).

---

## Ops first

| 文档 | 内容 |
|------|------|
| **[docs/UPDATE.md](./docs/UPDATE.md)** | **staging / production 更新流程**、密钥、模型热更新、回滚、排障 |
| App 侧用法 | `ios-sensors/docs/features/ai-proxy-env.md` |

日常发版：

```bash
pnpm install && pnpm test && pnpm typecheck
pnpm deploy:staging    # → https://ai-staging.modocus.app
# 真机 preview 验证后再：
pnpm deploy:prod       # → https://ai.modocus.app
git push origin main
```

---

## Environments

| Env | Worker | Auth | URL |
|-----|--------|------|-----|
| **production** | `modocus-ai-proxy` | Apple JWS only | `https://ai.modocus.app` |
| **staging** | `modocus-ai-proxy-staging` | JWS or `DEV_BYPASS_TOKEN` | `https://ai-staging.modocus.app` |

App 映射：`development` / `preview` → staging；`production` → production。

---

## Model routing (per task type)

Proxy resolves a **slot** from the request, then looks up the operator-chosen
model for that slot (KV). User-facing slots default to `openai/gpt-4o-mini`;
structured parse, plan, and estimate helpers default to `openai/gpt-4.1-nano`.
Operators can change any slot on the dashboard.

### Upstreams

| Model id pattern | Upstream | Bill |
|------------------|----------|------|
| `@cf/…` | Direct Workers AI (`env.AI.run`); opt-in Gateway via `ROUTE_CF_VIA_GATEWAY=true` | CF **Neurons** |
| `openai/…`, `anthropic/…`, `google/…`, bare `gpt-4o-mini` | AI Gateway (`env.AI.run` + `gateway.id`) | CF **Unified Billing** credits |
| legacy HTTP | only if `ALLOW_LEGACY_HTTP_UPSTREAM=true` + provider keys | multi-bill |

Requires var **`AI_GATEWAY_ID`** for third-party models. Production uses
`modocus-prod`; staging uses `modocus-staging`. Both gateways share the account's
Unified Billing credits while keeping logs, limits, and provider configuration isolated.

`@cf` stays on direct Workers AI by default (avoids some accounts' Gateway payment errors on Neurons).  
**Privacy:** Gateway calls set `collectLog: false` by default so prompts/chat are **not** stored in
the AI Gateway dashboard. Cloudflare may still retain metadata-only billing records (model, tokens,
cost, status). Only set `GATEWAY_COLLECT_LOG=true` for short debug windows. Also turn
**Logs off** under Gateway → Settings, and delete any existing log entries that contain user text.  
Create the gateway and load credits: CF Dashboard → **AI → AI Gateway**.

Custom ids are allowed (safe charset). Dashboard dropdown lists common options
plus **Custom model id…**.

Client requests never select an upstream model directly: every request resolves
through the operator-controlled slot map, even if a modified client supplies a
different model id. Chat request JSON is capped at 160,000 characters and model
output at 4,096 tokens, which covers current app workflows while bounding abuse.

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

**Change models live (no redeploy):** Dashboard **Model routing** or
`GET|PUT /dashboard/api/models` — details in [docs/UPDATE.md](./docs/UPDATE.md).

Product notes (app repo):  
`ios-sensors/docs/proposals/ai-proxy-hybrid-routing.md`

---

## Secrets (checklist)

| Item | staging | production |
|------|---------|------------|
| `DASHBOARD_TOKEN` | ✅ | ✅ |
| `DEV_BYPASS_TOKEN` | ✅ dogfood | ❌ ignored even if set |
| `SUBJECT_HASH_SALT` | ✅ unique secret | ✅ unique secret |
| `AI_GATEWAY_ID` var | ✅ (`modocus-staging`) | ✅ (`modocus-prod`) |
| Gateway Unified Billing credits | if using third-party models | same |
| `OPENAI_API_KEY` / OpenRouter | only legacy HTTP mode | only legacy |

```bash
printf '%s' "$(openssl rand -hex 24)" | npx wrangler secret put DASHBOARD_TOKEN
printf '%s' "$DASHBOARD_TOKEN" | npx wrangler secret put DASHBOARD_TOKEN --env staging
printf '%s' "$DEV_BYPASS_TOKEN" | npx wrangler secret put DEV_BYPASS_TOKEN --env staging
openssl rand -hex 32 | npx wrangler secret put SUBJECT_HASH_SALT
openssl rand -hex 32 | npx wrangler secret put SUBJECT_HASH_SALT --env staging
```

---

## Smoke

```bash
curl -sS https://ai.modocus.app/health
curl -sS https://ai-staging.modocus.app/health
# {"ok":true,"env":"staging|production","upstream":{"workersAi":true,"openai":…,"openrouter":…}}

curl -sS -X POST https://ai-staging.modocus.app/v1/chat/completions \
  -H "authorization: Bearer $DEV_BYPASS_TOKEN" \
  -H 'content-type: application/json' \
  -H 'X-Modocus-Scene: chat' \
  -H "X-Modocus-Operation-Id: smoke_$(date +%s)_0000000000" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":32}'
```

### App Store Server Notifications V2

Configure these URLs in App Store Connect and select **Version 2**:

| ASC environment | URL |
|-----------------|-----|
| Production | `https://ai.modocus.app/apple/notifications` |
| Sandbox | `https://ai-staging.modocus.app/apple/notifications` |

The endpoint verifies both Apple's outer notification JWS and the nested transaction JWS. `REFUND` and `REVOKE` mark only that transaction as revoked; `REFUND_REVERSED` clears it. Stored state uses the salted anonymous subscription subject and a transaction hash, never a raw transaction ID. AI requests check this state before reserving quota.

Use **Send Test Notification** for both URLs after every auth or routing deployment. A valid `TEST` notification returns HTTP 200 with `{"ok":true,"test":true}`.

---

## Dashboard

| Env | URL |
|-----|-----|
| production | https://ai.modocus.app/dashboard |
| staging | https://ai-staging.modocus.app/dashboard |

- Token → httpOnly cookie；或 `Authorization: Bearer` on `/dashboard/api`
- Model routing: `GET|PUT /dashboard/api/models`
- Does **not** log request bodies
- Real $ → Cloudflare Billing → Workers AI (Neurons) + AI Gateway credits

---

## Scripts

```bash
pnpm dev              # wrangler dev
pnpm test
pnpm typecheck
pnpm deploy:staging
pnpm deploy:prod
```
