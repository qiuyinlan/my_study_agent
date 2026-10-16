# Worker 后端第一阶段

这是第一阶段后端，提供健康检查、用户权限查询、兑换码兑换和管理员兑换码管理接口。测试 API 已部署为 `https://my-study-agent-api.mystudyagent.workers.dev`，但尚未接入 DeepSeek 代理。

## 本地准备

在 `worker/` 目录执行：

```bash
npm install -D wrangler
npx wrangler d1 create my-study-agent
```

把命令返回的 `database_id` 填入 `wrangler.toml`，再初始化本地数据库：

```bash
npx wrangler d1 execute my-study-agent --local --file=./schema.sql
npx wrangler dev
```

健康检查地址：`http://127.0.0.1:8787/api/health`

## 部署前要求

Worker 会通过 Supabase 的 `/auth/v1/user` 接口验证前端的 Bearer access token，并使用 Supabase user ID 绑定兑换权限。当前 `x-test-user-id` 仅用于本地骨架测试，不能用于公开部署。

本地开发时可在 `wrangler.toml` 的 `SUPABASE_ANON_KEY` 填入 Supabase publishable/anon key；正式环境建议使用 Wrangler secret 保存该值，并删除测试身份回退逻辑。

正式环境需要另外执行：

```bash
npx wrangler d1 execute my-study-agent --remote --file=./migrations/0002_membership_daily_limit.sql
npx wrangler secret put ADMIN_API_TOKEN
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put SESSION_SIGNING_SECRET
```

不要把真实密钥写入文件、GitHub 或聊天消息。

管理员令牌不直接存入 D1，而是作为 Cloudflare Worker Secret 保存；请求管理接口时使用 `x-admin-token` 请求头。不要把令牌写入代码、GitHub 或聊天消息。

接口：

- `GET /api/session`：返回当前用户的体验权限和剩余额度。
- `POST /api/redeem`：登录用户兑换测试码。
- `POST /admin/codes`：批量生成兑换码，明文只在响应中返回一次。
- `GET /admin/codes`：查看兑换码状态和用量，不返回明文。
- `POST /admin/codes/:id/disable`：禁用兑换码。

本地交互式管理命令会隐藏管理员令牌输入，不要把令牌放在命令参数中：

```bash
node admin.mjs create 10 60 300 30
node admin.mjs list
node admin.mjs disable <code-id>
```

`create` 的参数依次为数量、兑换后有效天数、总请求额度、每日请求额度。明文兑换码只在创建响应中返回一次，管理者应立即保存并安全地发给测试者。
