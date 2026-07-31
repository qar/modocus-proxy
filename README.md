# Modocus AI Proxy

OpenAI-compatible edge proxy for built-in Modocus AI (iOS/Android app
**ios-sensors** / Modocus).

Standalone repo — kept out of the app monorepo so the client stays a pure
Expo/React Native project.

**Repo:** https://github.com/qar/modocus-proxy  

**Upstreams:** Cloudflare Workers AI (`env.AI`), optional OpenAI / OpenRouter
HTTP (secrets).

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
printf '%s' "$OPENROUTER_API_KEY" | npx wrangler secret put OPENROUTER_API_KEY --env staging
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

**Change models live (no redeploy):** Dashboard **Model routing** or
`GET|PUT /dashboard/api/models` — details in [docs/UPDATE.md](./docs/UPDATE.md).

Product notes (app repo):  
`ios-sensors/docs/proposals/ai-proxy-hybrid-routing.md`

---

## Secrets (checklist)

| Secret | staging | production |
|--------|---------|------------|
| `DASHBOARD_TOKEN` | ✅ | ✅ |
| `DEV_BYPASS_TOKEN` | ✅ dogfood | ❌ ignored even if set |
| `OPENAI_API_KEY` | optional | optional |
| `OPENROUTER_API_KEY` | optional | optional |

```bash
printf '%s' "$(openssl rand -hex 24)" | npx wrangler secret put DASHBOARD_TOKEN
printf '%s' "$DASHBOARD_TOKEN" | npx wrangler secret put DASHBOARD_TOKEN --env staging
printf '%s' "$DEV_BYPASS_TOKEN" | npx wrangler secret put DEV_BYPASS_TOKEN --env staging
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
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":32}'
```

---

## Dashboard

| Env | URL |
|-----|-----|
| production | https://ai.modocus.app/dashboard |
| staging | https://ai-staging.modocus.app/dashboard |

- Token → httpOnly cookie；或 `Authorization: Bearer` on `/dashboard/api`
- Model routing: `GET|PUT /dashboard/api/models`
- Does **not** log request bodies
- Real $ → Cloudflare Billing → Workers AI / your OpenAI·OpenRouter bills

---

## Scripts

```bash
pnpm dev              # wrangler dev
pnpm test
pnpm typecheck
pnpm deploy:staging
pnpm deploy:prod
```
