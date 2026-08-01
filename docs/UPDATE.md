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
| 上游 | `@cf/…` → Workers AI；`openai/…` `anthropic/…` → **AI Gateway** | 同左 |
| Gateway | var `AI_GATEWAY_ID`（默认 `modocus`） | 同左 |

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
  -H "X-Modocus-Operation-Id: smoke_$(date +%s)_0000000000" \
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
- 选 `openai/…` / Claude / Gemini 前确认 `AI_GATEWAY_ID` 已设且 CF 账户有 Gateway credits（`/health` → `aiGateway: true`）。

---

## 4. Secrets / Gateway / 账单

### 4.1 AI Gateway（第三方模型，统一 CF 账单）

第三方模型（`openai/gpt-4o-mini`、`anthropic/…`、`google/…`）走 **AI Gateway Unified Billing**，**不需要**各家 API key。

1. Cloudflare Dashboard → **AI → AI Gateway** → 创建 gateway，名称与 `AI_GATEWAY_ID` 一致（默认 **`modocus`**，见 `wrangler.toml`）。  
2. 同一页 **Unified Billing / Credits** → 充值 credits（有 credits 手续费；模型价按厂商 list price）。  
3. Worker 已带 `[ai] binding = "AI"`；部署后 `/health` 应含 `"aiGateway": true`。

```bash
# 改 gateway 名（可选）— 写在 wrangler.toml [vars] / [env.staging.vars]
# AI_GATEWAY_ID = "modocus"
```

| 模型 id | 上游 | 账单 |
|---------|------|------|
| `@cf/…` | Workers AI 直连 | CF **Neurons** |
| `openai/…` `anthropic/…` `google/…` | `env.AI.run(…, { gateway })` | CF **Unified Billing credits** |

### 4.2 Secrets

```bash
# Dashboard（两环境都要）
printf '%s' "$(openssl rand -hex 24)" | npx wrangler secret put DASHBOARD_TOKEN
printf '%s' "$DASHBOARD_TOKEN" | npx wrangler secret put DASHBOARD_TOKEN --env staging

# Staging dogfood（仅 staging）
printf '%s' "$DEV_BYPASS_TOKEN" | npx wrangler secret put DEV_BYPASS_TOKEN --env staging

# 匿名订阅主体哈希盐（两环境分别生成，至少 16 字符）
openssl rand -hex 32 | npx wrangler secret put SUBJECT_HASH_SALT
openssl rand -hex 32 | npx wrangler secret put SUBJECT_HASH_SALT --env staging
```

**一般不需要** `OPENAI_API_KEY` / `OPENROUTER_API_KEY`。  
仅当 `ALLOW_LEGACY_HTTP_UPSTREAM=true` 时才启用直连 HTTP（多账单逃生口）。

额度由 `USAGE_LEDGER` Durable Object 原子维护：每个 StoreKit 订阅周期
300 个唯一用户操作。同一 `X-Modocus-Operation-Id` 的工具轮次与重试不会重复扣次；
不支持通过环境变量增加隐藏的每日限额。

成本边界：客户端声明的 model 永远只用于识别 slot，不能绕过 Dashboard 的模型配置；
聊天 JSON 上限 160,000 字符，单次输出上限 4,096 tokens。两项均覆盖当前 App 的
最大会议整理与工具调用负载，属于单次请求技术边界，不改变 300 次公开额度。

```bash
curl -sS https://ai-staging.modocus.app/health | jq .upstream
# { "workersAi": true, "aiGateway": true, "gatewayId": "modocus", ... }
```

### 4.3 App Store Server Notifications V2

在 App Store Connect → App Information → App Store Server Notifications 配置：

| ASC 环境 | URL |
|----------|-----|
| Production | `https://ai.modocus.app/apple/notifications` |
| Sandbox | `https://ai-staging.modocus.app/apple/notifications` |

- 版本必须选 **Version 2**。
- 两个环境分别点 **Send Test Notification**，期望 HTTP 200。
- Endpoint 同时验证外层通知 JWS 与内层交易 JWS；错误 bundle、product 或 environment 不写状态。
- `REFUND` / `REVOKE` 记录退款交易；`REFUND_REVERSED` 只清除对应交易。新续订使用新的 transaction ID，不会被旧退款阻断。
- Durable Object 只保存加盐匿名主体和 transaction hash。额度周期切换只清用量键，不清退款状态。
- 通知处理返回非 2xx 时 Apple 会重试；连续失败先查 Worker deployment logs、`USAGE_LEDGER` binding 和 `SUBJECT_HASH_SALT`。

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
| `429` quota_exhausted | 当前订阅周期 300 次已用完；响应含 `periodEnd`，等待重置或改用 BYOK |
| `500` quota_unavailable | `USAGE_LEDGER` Durable Object 未绑定或暂时不可用；检查 Wrangler 绑定与迁移 |
| `403` server_configuration | production 缺少 `SUBJECT_HASH_SALT`；配置 secret 后重试 |
| `403` revoked | 当前 JWS 对应交易已由 Apple 通知撤销；退款反转或新续订后恢复 |
| Apple Test Notification 非 200 | 检查 URL 是否为 `/apple/notifications`、Version 2、环境与 bundle 白名单、DO binding |
| 改了模型不生效 | 等 ~15s；或改错了环境的 dashboard |
| workers.dev 超时、自定义域正常 | 本地网络拦 `*.workers.dev`，用 `ai-staging.modocus.app` / `ai.modocus.app` |

---

## 8. 与 App 仓的边界

| 仓 | 职责 |
|----|------|
| **modocus-proxy**（本仓） | Worker 代码、部署、密钥、模型路由、周期额度、JWS 校验、退款通知状态 |
| **ios-sensors** | `EXPO_PUBLIC_AI_PROXY_URL`、场景 header、订阅 token、UI |

App **不包含** proxy 源码。改转发逻辑只动本仓；改「连哪台 proxy / dogfood」只动 app 的 env 与文档：  
`ios-sensors/docs/features/ai-proxy-env.md`。
