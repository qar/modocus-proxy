# 更新与环境管理（staging / production）

本文是 **modocus-proxy** 的日常运维 runbook：改代码怎么发、两套环境怎么分、密钥与模型路由怎么管。

仓库：https://github.com/qar/modocus-proxy  
App 侧怎么连本服务：见 app 仓 `ios-sensors/docs/features/ai-proxy-env.md`。

---

## 1. 两套环境一览

| | **staging** | **production** |
|--|-------------|----------------|
| Worker 名 | `modocus-ai-proxy-staging` | `modocus-ai-proxy` |
| 对外 URL | `https://ai-staging.modocus.app` | `https://ai.modocus.app` |
| wrangler | `pnpm deploy:staging`（`--env staging`） | `pnpm deploy:prod`（默认 env） |
| `ENVIRONMENT` var | `staging` | `production` |
| API 鉴权 | Apple JWS **或** `DEV_BYPASS_TOKEN` | **仅** Apple JWS |
| 给谁用 | 本机 / USB preview / TestFlight dogfood | App Store 正式包 |
| 模型路由 KV 键 | `cfg:model_slots:staging` | `cfg:model_slots:production` |
| Dashboard | `https://ai-staging.modocus.app/dashboard` | `https://ai.modocus.app/dashboard` |

> 两环境可共用同一 Cloudflare KV namespace，但 **模型路由按环境写不同 key**，互不覆盖。  
> Usage 计数若共用 KV，dashboard 上的「今日请求」可能混看——以 `ENVIRONMENT` 与事件里的 auth 区分；需要严格隔离时可再拆 KV。

App 对应关系（摘要）：

| App `EXPO_PUBLIC_APP_ENV` | 应连的 proxy |
|--------------------------|--------------|
| `development` / `preview` | **staging** |
| `production` | **production** |

---

## 2. 标准更新流程（改代码后）

### 2.1 本地

```bash
cd /Users/qiaoanran/projects/modocus-proxy   # 或 clone 路径
git pull
pnpm install
pnpm test
pnpm typecheck
```

### 2.2 先发 staging（默认必做）

```bash
pnpm deploy:staging
curl -sS https://ai-staging.modocus.app/health | jq .
# 期望: "env":"staging"，upstream.openai / openrouter 与密钥一致
```

**冒烟（有 DEV_BYPASS 时）：**

```bash
curl -sS -X POST https://ai-staging.modocus.app/v1/chat/completions \
  -H "authorization: Bearer $DEV_BYPASS_TOKEN" \
  -H 'content-type: application/json' \
  -H 'X-Modocus-Scene: chat' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":32}'
```

- `401` → bypass 未配置或与 secret 不一致  
- `503` + `OPENAI_API_KEY not configured` → 路由到了 OpenAI 但 staging 没设 key  
- `200` → OK  

再用 **preview 包 / `pnpm device:preview`** 在真机走一遍对话。

### 2.3 再发 production（确认 staging 无问题后）

```bash
pnpm deploy:prod
curl -sS https://ai.modocus.app/health | jq .
# 期望: "env":"production"
```

生产 **不能** 用 DEV_BYPASS 测 API；用已订阅账号的 StoreKit JWS，或只看 `/health` + dashboard 流量。

### 2.4 提交与推送

```bash
git status
git add -A && git commit -m "…"
git push origin main
```

Cloudflare Worker 的发布 **不依赖** GitHub；`git push` 只是备份与协作。部署以本机 `wrangler`（已 `wrangler login`）为准。

---

## 3. 只改模型、不改代码

Dashboard → **Model routing** → 改各 slot 下拉或 Custom id → **Save routing**。

| 环境 | 地址 |
|------|------|
| staging | https://ai-staging.modocus.app/dashboard |
| production | https://ai.modocus.app/dashboard |

或 API：

```bash
# 读
curl -sS -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  https://ai-staging.modocus.app/dashboard/api/models | jq .

# 写（示例：日常用 4o-mini，强档 4o）
curl -sS -X PUT -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"slots":{
    "parse":"gpt-4o-mini",
    "chat":"gpt-4o-mini",
    "plan":"gpt-4o-mini",
    "estimate":"gpt-4o-mini",
    "insight":"gpt-4o-mini",
    "default":"gpt-4o-mini",
    "strong":"gpt-4o",
    "stt":"@cf/openai/whisper-large-v3-turbo"
  }}' \
  https://ai-staging.modocus.app/dashboard/api/models
```

- **无需 redeploy**；isolate 约 15s 内读到新 KV。  
- **staging / production 分开保存**，改 staging 不会动生产。  
- 选 OpenAI 模型前确认该环境已配置 `OPENAI_API_KEY`（`/health` 里 `upstream.openai: true`）。

---

## 4. Secrets 管理

在**对应环境**各写一次（不会进 git）：

```bash
# Dashboard（两环境都要）
printf '%s' "$(openssl rand -hex 24)" | npx wrangler secret put DASHBOARD_TOKEN
printf '%s' "$DASHBOARD_TOKEN" | npx wrangler secret put DASHBOARD_TOKEN --env staging

# Staging dogfood（仅 staging；production 即使误设也会被代码忽略）
printf '%s' "$DEV_BYPASS_TOKEN" | npx wrangler secret put DEV_BYPASS_TOKEN --env staging

# 第三方上游（按需，两环境分别设）
printf '%s' "$OPENAI_API_KEY" | npx wrangler secret put OPENAI_API_KEY
printf '%s' "$OPENAI_API_KEY" | npx wrangler secret put OPENAI_API_KEY --env staging

printf '%s' "$OPENROUTER_API_KEY" | npx wrangler secret put OPENROUTER_API_KEY
printf '%s' "$OPENROUTER_API_KEY" | npx wrangler secret put OPENROUTER_API_KEY --env staging
```

可选 vars（写在 `wrangler.toml` 或 dashboard，非 secret）：

- `OPENAI_BASE_URL`（默认 `https://api.openai.com/v1`）
- `OPENROUTER_BASE_URL`（默认 `https://openrouter.ai/api/v1`）
- `DAILY_LIMIT`（默认 80，按 subject / 日）

查看是否生效：

```bash
curl -sS https://ai-staging.modocus.app/health
# upstream.openai / openrouter / workersAi
```

---

## 5. 推荐发布策略

```
改代码 → test/typecheck → deploy staging → 真机 preview 验证
       →（可选）staging 调模型路由
       → deploy prod
       → git push
```

| 变更类型 | staging | production | 备注 |
|----------|---------|------------|------|
| 鉴权 / 路由逻辑 / 上游 | 必发 | staging 稳后再发 | 先 staging |
| 仅模型 slot 调整 | Dashboard | 确认成本后再改 prod Dashboard | 不 deploy |
| 新 secret | 先 staging | 再 prod | 改 secret 立即生效，不必 redeploy worker 代码 |
| 紧急 prod hotfix | 仍建议先 staging 冒烟 | 再 prod | 除非 staging 完全不可用 |

**不要**把 `DEV_BYPASS` 或 OpenAI key 写进 app 的 production 包；app 正式环境只用 StoreKit JWS。

---

## 6. 回滚

### Worker 代码

Cloudflare Dashboard → Workers → 选对应 worker → Deployments → 回滚到上一版本。  
或本地 `git checkout <good-sha> && pnpm deploy:staging|prod`。

### 模型路由

Dashboard 改回上一组模型并 Save；或 `PUT /dashboard/api/models` 写回已知好配置。  
（KV 无自动版本历史，重要变更前先 `GET` 存一份 JSON。）

---

## 7. 健康检查与常见问题

| 检查 | 命令 / 现象 |
|------|-------------|
| 存活 | `GET /health` → `ok: true` |
| 环境 | `env` 字段是 `staging` 还是 `production` |
| 上游密钥 | `upstream.openai` / `openrouter` |
| Dashboard | 浏览器打开 `/dashboard`，token 登录 |

| 症状 | 可能原因 |
|------|----------|
| App `401` / API key rejected | 生产包打到了 staging URL 却无 JWS；或 bypass 未进 bundle；或 production 误用 bypass |
| `503` upstream_not_configured | slot 指向 OpenAI/OpenRouter 但该环境没 secret |
| `429` usage_paused | 日限额；调 `DAILY_LIMIT` 或等 UTC 日切 |
| 改了模型不生效 | 等 ~15s；或改错了环境的 dashboard |
| workers.dev 超时、自定义域正常 | 本地网络拦 `*.workers.dev`，用 `ai-staging.modocus.app` / `ai.modocus.app` |

---

## 8. 与 App 仓的边界

| 仓 | 职责 |
|----|------|
| **modocus-proxy**（本仓） | Worker 代码、部署、密钥、模型路由、日限、JWS 校验 |
| **ios-sensors** | `EXPO_PUBLIC_AI_PROXY_URL`、场景 header、订阅 token、UI |

App **不包含** proxy 源码。改转发逻辑只动本仓；改「连哪台 proxy / dogfood」只动 app 的 env 与文档：  
`ios-sensors/docs/features/ai-proxy-env.md`。
