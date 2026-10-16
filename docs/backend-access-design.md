# 后端访问与测试兑换码设计

本文档定义测试阶段的 Cloudflare Workers + D1 后端方案。目标是让访客可以体验网站，同时由后端控制权限、兑换码有效期和 DeepSeek 用量。

## 1. 部署边界

```text
浏览器 / 未来的 APK
        |
        | HTTPS，只发送用户输入和必要的业务数据
        v
Cloudflare Worker
  - 校验登录身份和兑换码权限
  - 组装服务器端提示词
  - 调用 DeepSeek
  - 执行需要隐藏的工具
  - 记录 Token、费用和限额
        |
        +--> Cloudflare D1：用户、兑换码、权限、用量记录
        +--> DeepSeek API：服务器端 API Key
```

前端代码不能保密。浏览器收到的 HTML、CSS、JavaScript 都可以被查看。当前实现把 DeepSeek Key 放在 Worker Secret，浏览器通过 Worker 发起模型请求；但系统提示词、工具定义和工具实现仍在前端，且提示词与工具定义会随请求发送给模型。当前版本只隐藏站长的 DeepSeek Key，并把模型调用纳入登录、兑换权限和额度控制，不能声称已隐藏核心提示词或前端源码。

## 2. 兑换码规则

测试阶段只支持管理员手动生成和发放兑换码，不开放自助购买。

兑换码示例：`TEST-7K4P-9Q2M-X6RD`

每个兑换码包含：

- `code_hash`：兑换码的 SHA-256 哈希，不在数据库保存明文。
- `code_type`：`trial`、`internal` 或 `custom`。
- `expires_at`：兑换码最晚兑换时间；为空表示不限制兑换时间。
- `duration_days`：兑换成功后获得的有效天数，例如 60 天。
- `max_uses`：最多兑换人数，单人码为 1。
- `used_count`：已兑换次数。
- `request_limit`：每个绑定用户允许的总请求数。
- `daily_request_limit`：每个用户每天允许的请求数。
- `status`：`active`、`disabled`、`exhausted` 或 `expired`。
- `created_by`、`created_at`、`disabled_at`：审计信息。

兑换时必须在一个数据库事务中完成：检查状态、检查过期时间、检查剩余次数、写入用户权限并递增 `used_count`。这样同一个兑换码不能被并发请求重复使用。

兑换成功后，权限绑定到用户账号，而不是只绑定浏览器、设备或 APK。用户本地可以缓存展示状态，但本地状态不能作为权限依据。

## 3. 权限判断

每次打开应用时调用 `GET /api/session`，每次高级 AI 请求时再次校验权限。后端返回：

```json
{
  "authenticated": true,
  "entitled": true,
  "expiresAt": "2026-12-01T00:00:00.000Z",
  "features": { "ai": true, "sync": true },
  "remainingRequests": 87
}
```

后端必须拒绝以下情况：用户未登录、权限已过期、兑换码已撤销、总次数耗尽、日次数耗尽或单次输入过长。当前尚未实现全站预算上限。

旧版本客户端也必须经过这些接口才能调用高级能力，因此客户端不更新不能绕过过期时间和限额。

## 4. 数据表

### `users`

```sql
id TEXT PRIMARY KEY,
email TEXT UNIQUE,
role TEXT NOT NULL DEFAULT 'tester', -- tester | admin
status TEXT NOT NULL DEFAULT 'active',
created_at TEXT NOT NULL,
last_seen_at TEXT
```

### `redeem_codes`

```sql
id TEXT PRIMARY KEY,
code_hash TEXT NOT NULL UNIQUE,
code_type TEXT NOT NULL,
expires_at TEXT,
duration_days INTEGER NOT NULL,
max_uses INTEGER NOT NULL DEFAULT 1,
used_count INTEGER NOT NULL DEFAULT 0,
request_limit INTEGER NOT NULL,
daily_request_limit INTEGER NOT NULL,
status TEXT NOT NULL DEFAULT 'active',
created_by TEXT NOT NULL,
created_at TEXT NOT NULL,
disabled_at TEXT
```

### `memberships`

```sql
id TEXT PRIMARY KEY,
user_id TEXT NOT NULL,
code_id TEXT NOT NULL,
status TEXT NOT NULL DEFAULT 'active',
starts_at TEXT NOT NULL,
expires_at TEXT NOT NULL,
request_limit INTEGER NOT NULL,
used_requests INTEGER NOT NULL DEFAULT 0,
created_at TEXT NOT NULL,
UNIQUE(user_id, code_id)
```

### `usage_logs`

```sql
id TEXT PRIMARY KEY,
user_id TEXT NOT NULL,
request_id TEXT NOT NULL UNIQUE,
model TEXT NOT NULL,
prompt_tokens INTEGER NOT NULL DEFAULT 0,
completion_tokens INTEGER NOT NULL DEFAULT 0,
total_tokens INTEGER NOT NULL DEFAULT 0,
estimated_cost_usd REAL, -- 单价未配置或上游无 usage 时为 NULL
status TEXT NOT NULL,
created_at TEXT NOT NULL
```

### `app_settings`

```sql
key TEXT PRIMARY KEY,
value_json TEXT NOT NULL,
updated_at TEXT NOT NULL,
updated_by TEXT NOT NULL
```

用于保存全站每日预算、是否开放注册、当前版本和功能开关。真正的密钥不放 D1，放 Cloudflare Worker Secrets。

当前实现另有 `daily_usage`（用户每日请求计数）和 `model_pricing`（管理员配置的模型输入/输出单价）。

## 5. 管理员密钥和 Secrets

Cloudflare Worker Secrets 包含：

- `DEEPSEEK_API_KEY`：DeepSeek 服务端密钥。
- `ADMIN_API_TOKEN`：管理员接口令牌；只保存为 Worker Secret，不把令牌写入仓库。

设置方式使用 Wrangler：

```bash
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put ADMIN_API_TOKEN
npx wrangler secret put SESSION_SIGNING_SECRET
```

管理员接口使用 HTTPS 和管理员令牌。不要把 Cloudflare Global API Key、DeepSeek Key 或管理员令牌发给访客，也不要提交 `.env` 文件。管理员接口目前尚未加入独立速率限制和完整审计日志。

管理员接口建议：

- `POST /admin/codes`：创建兑换码。
- `GET /admin/codes`：查看兑换码状态和使用情况。
- `POST /admin/codes/:id/disable`：撤销兑换码。
- `GET /admin/users`：查看用户权限状态。
- `GET /admin/usage`：查看按用户和模型汇总的请求量、Token 和估算费用。
- `POST /admin/pricing`：配置模型每百万输入/输出 Token 的美元单价。
- `PATCH /admin/settings`：修改全站预算和功能开关。

管理后台网页可以后续再做。第一版使用受保护的管理接口即可。

## 6. DeepSeek 费用控制

配置 Worker 的前端会把模型请求经 Worker 转发。Worker 在请求前检查：

1. 用户权限是否有效。
2. 用户每日请求数和总请求数是否超限。
3. 单次输入长度和历史消息长度是否超限。
模型返回后记录 `prompt_tokens`、`completion_tokens` 和 `total_tokens`。管理员配置单价后计算估算费用；单价未配置时费用为 `NULL`，管理汇总会显示未计价请求数。缓存命中/未命中没有单独拆分价格，当前估算可能与 DeepSeek 账单略有差异。全站每日预算尚未实现。

建议初始限制：每个测试用户每天 30 次请求、总计 300 次请求、单次输入 8,000 字符。实际数值上线前根据模型价格调整。

## 7. 接口约束

### `POST /api/redeem`

请求：

```json
{ "code": "TEST-7K4P-9Q2M-X6RD" }
```

成功返回权限摘要，不返回 `code_hash` 或内部数据库字段。

### `POST /api/chat`

当前请求由前端提供 model、messages 和工具定义；Worker 只允许 `deepseek-chat`/`deepseek-reasoner`，校验登录、会员和额度，强制将最大输出限制在 2048 Token，并使用 Worker Secret 调用 DeepSeek。客户端提交的提示词和工具列表仍可被用户查看或自行构造，因此这不是隐藏提示词/工具逻辑的边界。要隐藏它们，必须把系统提示词和可信工具实现迁入 Worker，并移除客户端覆盖入口；涉及当前依赖浏览器 IndexedDB 的工具时还需要重新设计数据访问接口。

### 错误码

- `401`：未登录。
- `403`：没有有效体验权限、权限已过期或兑换码已撤销。
- `429`：超过用户或全站限额。
- `413`：输入过长。
- `503`：模型服务暂时不可用。

错误响应只返回用户需要知道的信息，不返回提示词、内部工具名、数据库 SQL 或服务器堆栈。

## 8. 迁移顺序

1. 保持仓库私有或使用单独的公开发布仓库；独立域名不会隐藏 GitHub 上的源码。
2. 用 Cloudflare Pages 部署前端，现有 IndexedDB 数据仍留在用户浏览器。
3. 创建 Worker 和 D1，完成兑换码、权限和管理员接口。
4. 将 DeepSeek 请求改为“浏览器 → Worker → DeepSeek”，不在访客浏览器保存站长的 DeepSeek Key。
5. 加入用量记录和用户限额；如需全站预算，还需继续实现。
6. 如需隐藏提示词/工具实现，再迁移到可信后端并重新设计本地数据工具边界。
7. 测试过期、撤销、并发兑换、超额和旧客户端请求后，再邀请外部测试用户。

## 9. 不采用的做法

- 不在前端、APK、GitHub Actions 日志或公开配置文件中放 DeepSeek Key。
- 不把兑换码明文存入数据库或日志。
- 不只在本地判断会员有效期。
- 当前模型接口仍接收前端提供的提示词和工具定义；不要把它视作隐藏业务逻辑的安全措施。
- 不把管理员接口暴露为无认证的公开 API。

## 10. 本地修改与上线边界

在本地修改项目文件，只会改变当前电脑上的工作区，不会自动影响已经部署的网站。只有发生以下任一情况，修改才可能上线：

1. 将修改提交并推送到已连接自动部署的 GitHub 分支。
2. 在 Cloudflare Pages 控制台手动触发部署。
3. 使用 Wrangler 或其他命令手动部署 Worker、Pages 静态文件或数据库迁移。
4. 直接修改线上 Cloudflare、D1、Supabase 或其他服务配置。

因此，设计和实现兑换码后端时可以先在本地或测试项目中开发，不会影响当前线上版本。上线前应使用单独的测试域名、测试 D1 数据库和测试 DeepSeek Key；确认兑换、过期、撤销、限额和费用记录都正确后，再部署到正式环境。

建议将环境明确分成：

- `local`：本机开发，不连接正式数据库。
- `staging`：测试域名、测试数据库、测试密钥，供内部验证。
- `production`：正式域名、正式数据库、正式密钥，只允许经过验证的部署进入。

不要在本地测试时直接执行生产数据库迁移，也不要把正式兑换码或正式 API Key 写入开发配置。

## 11. 参考成熟兑换页的取舍

`a8pi.com/redeem` 的公开页面展示了一个较成熟的兑换中心模式：用户登录后输入兑换码，兑换成功后刷新账户权益，并能查看兑换历史；管理员可以批量生成兑换码、按类型和状态筛选、批量修改有效期或状态、删除未使用码、导出代码，并查看使用者和使用时间。

这些交互值得借鉴，但不直接复制对方代码或资源。当前项目的测试阶段采用以下精简版本：

| 能力 | 参考网站的做法 | 本项目第一阶段 |
|---|---|---|
| 用户身份 | 登录账户后兑换 | 复用 Supabase Auth 用户 ID |
| 兑换结果 | 余额、并发、订阅、邀请等权益 | 测试会员有效期、总请求数、每日请求数 |
| 兑换历史 | 用户可分页查看 | 保存兑换时间、码类型、有效期和状态 |
| 管理生成 | 批量生成并复制/下载 | 先做管理员 API，后做管理页面 |
| 管理筛选 | 类型、状态、搜索、排序 | 类型、状态、用户和日期筛选 |
| 批量操作 | 禁用、改过期时间、改备注、导出 | 禁用、延长/缩短有效期、导出审计记录 |
| 余额系统 | 可充值并抵扣 | 暂不做余额，避免把测试系统变成支付系统 |
| 订阅分组 | 绑定套餐和渠道组 | 用 `code_type` 和 `features_json` 预留能力 |
| 安全 | 前端调用后端兑换接口 | Worker 校验 JWT、兑换事务、限额和预算 |

### 建议的兑换中心页面

正式给测试用户使用时，可以提供四个区域：

1. 当前体验权限：有效期、剩余总请求、今日剩余请求。
2. 兑换表单：输入兑换码、提交、成功或失败原因。
3. 最近兑换：兑换时间、类型、有效期、状态。
4. 使用说明：测试码规则、联系方式和隐私说明。

管理员页面可以再增加：

- 批量生成数量、有效期、总请求数和每日请求数。
- 复制或下载刚生成的明文兑换码；数据库只保存哈希。
- 按未使用、已使用、已过期、已禁用筛选。
- 查看兑换人、兑换时间、最后使用时间和消耗量。
- 一键禁用未使用码，支持批量操作。

### 为什么不完全照搬余额/订阅设计

参考网站面向 API 中转或订阅服务，余额、并发数、支付和套餐分组是核心业务。你的当前目标是邀请用户体验个人学习工具，最重要的是控制 DeepSeek 成本和测试期限。因此第一版只保留“账户 + 兑换码 + 权限 + 请求限额 + 用量记录”，后续确定要收费或提供不同套餐时，再增加余额或订阅表。

## 12. 结论

参考网站的产品形态比当前骨架完整，特别值得采用它的登录后兑换、兑换历史、批量生成、筛选、撤销和导出流程。当前项目的后端安全边界更重要：兑换码、权限、费用和 DeepSeek 调用必须由 Worker 决定，前端只负责展示和提交请求。

## 13. 当前实施状态

- Cloudflare Worker `my-study-agent-api` 已部署到 `https://my-study-agent-api.mystudyagent.workers.dev`。
- Cloudflare D1 数据库和当前表结构迁移已完成。
- `ADMIN_API_TOKEN` 已存为 Worker Secret；本地管理脚本在输入时不回显令牌。
- Worker 已切换到 production 身份模式，禁用了 `x-test-user-id` 回退。
- 本地前端兑换区已接入 Worker API 地址，但前端网页尚未部署。
- Worker 已增加 DeepSeek 代理、会员和每日/总请求限额、Token 用量记录、管理员用量汇总和单价配置接口。
- Worker 的 DeepSeek Secret 尚待设置；未设置时 `/api/chat` 会返回 `ai_not_configured`。
- D1 新增每日请求计数和模型单价表；未配置单价前费用显示未估算。
- 本地前端已切换到 Worker 代理模式，但尚未发布到 Cloudflare Pages。
- 已部署版本：`15b05486-07d6-46e2-96fb-fdbe2804065b`。部署命令成功；本机此前对 workers.dev 的公网探测受 DNS/网络问题影响，部署后仍应由用户浏览器验证健康检查、登录与兑换流程。
- 当前系统提示词和工具定义仍在浏览器中；想保护这些内容，需要后续把提示词和受信任的工具执行移到 Worker。现有业务工具读写本机 IndexedDB，不能仅靠代理就搬到后端。
