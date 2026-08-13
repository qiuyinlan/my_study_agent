# My Study Agent 产品与存储设计（v0.1）

## 1. 项目定位

`my_study_agent` 是面向个人学习的 AI 助手。它围绕一名学习者的资料、目标、练习结果和复习节奏工作，形成可持续的个性化学习闭环。

首个可用版本必须完成一个学习闭环：

```text
导入资料 / 输入学习目标
  -> Agent 讲解、提问或生成练习
  -> 学习者作答并得到反馈
  -> 记录掌握情况与错题
  -> 生成下一次复习或学习任务
```

本设计按数据生命周期、访问模式和一致性要求拆分存储职责：学习事实与长期记录使用关系数据库；活跃上下文使用缓存；资料问答使用独立检索索引；运行状态使用可观测性系统。每个组件只承担适合它的查询和可靠性责任。

## 2. 当前范围与假设

当前项目尚无业务代码、登录系统或既有数据。因此本规格按以下可调整的 MVP 假设设计：

- 首先服务个人使用场景，但所有业务表均保留 `user_id`，避免未来多用户改表。
- 支持 Markdown、TXT、PDF 等学习资料的导入与问答。
- 支持学习计划、对话式辅导、练习/错题记录和间隔复习。
- 学习内容包括技术、语言、考试知识等，不绑定某一学科。
- 初期不需要多 Agent 编排；单 Agent 通过受限工具完成资料检索、讲解、出题、判题和任务安排。

若产品后续只需“资料问答”，可以不实现练习和复习表；若要做课程进度、错题和复习，则本规格中的学习数据模型是必需的。

## 3. 技术取舍

| 能力 | 选择 | 核心实现要点 | 学习场景职责 |
|---|---|---|---|
| 主业务存储 | MySQL + GORM | 关系库保存长期数据；开发环境可自动迁移，部署环境使用版本化迁移 | 存学习计划、掌握度、练习、复习任务 |
| 活跃状态 | Redis | TTL、会话窗口、分片、连接池 | 仅缓存最近对话、当前学习任务和幂等/互斥状态 |
| 资料检索 | Elasticsearch + embedding | BM25、向量召回、RRF 融合及 BM25 降级 | 仅索引学习资料 chunk，并按资料归属/课程过滤 |
| Agent | Go + Eino + OpenAI-compatible 模型接口 | 对话、流式输出、工具编排 | 工具改为资料检索、出题、判题、创建复习任务 |
| 服务可观测性 | Prometheus + OpenTelemetry/Jaeger；Grafana 可选 | 指标、Trace、Docker 本地依赖编排 | 只观测 API、模型、检索和任务执行；不把学习正文放入观测数据 |

### 3.1 分阶段启用，而不是一次部署全部组件

- 阶段 1：MySQL 是必需依赖；Redis 作为活跃上下文缓存启用。
- 阶段 2：资料库达到需要跨文档检索时接入 Elasticsearch 与 embedding。
- 阶段 3：服务有稳定 API/后台任务后接入 Prometheus；出现多步骤调用或需要定位线上性能问题时再接入 Jaeger 和 Grafana。

Elasticsearch 不是 MySQL 的替代品，Redis 也不是学习记录的唯一保存位置。对个人 MVP，避免在没有资料检索需求时先部署 ES、Prometheus、Jaeger、Grafana 四套服务。

## 4. 数据所有权

| 数据 | 唯一事实来源 | 缓存/检索投影 | 保留策略 |
|---|---|---|---|
| 学习者、目标、计划、进度 | MySQL | Redis 可缓存当前计划 | 长期保存，允许用户删除 |
| 会话与消息 | MySQL | Redis 保存最近窗口 | 长期保存，支持按会话删除 |
| 学习资料元数据与原文件位置 | MySQL + 文件目录/对象存储 | Elasticsearch 保存可检索 chunk | 用户删除资料时同步清理投影 |
| 练习、提交、错题、掌握度、复习任务 | MySQL | Redis 可缓存当前练习 | 长期保存，驱动后续学习 |
| 最近对话、流式生成状态、任务锁 | Redis | 无 | TTL 过期，可由 MySQL 重建或直接失效 |
| RAG chunk、向量、关键词索引 | Elasticsearch | 由 MySQL/原文件重建 | 非唯一数据，可重建 |
| 延迟、错误、调用次数、Trace | Prometheus / Jaeger | Grafana 展示 | 按可观测数据保留策略保存，不保存学习正文 |

## 5. MySQL：学习事实与长期记忆

MySQL 是本项目最先落地、不可替代的主库。GORM 可在本地开发中执行 `AutoMigrate`；部署环境使用版本化 migration，避免模型变更直接修改生产数据。

### 5.1 用户与学习结构

#### `users`

| 字段 | 说明 |
|---|---|
| `id` | 主键（UUID 或 BIGINT，项目内统一） |
| `display_name` | 学习者显示名 |
| `timezone` | 复习到期日与每日计划的时区 |
| `created_at`, `updated_at` | 审计时间 |

个人版可固定一个本地用户，但业务接口仍从认证层或本地配置取得 `user_id`，不能接受任意请求传入的用户 ID。

#### `subjects`

一个 subject 是学习领域或课程，例如“Go 并发”“英语词汇”“高等数学”。字段包括 `id`、`user_id`、`name`、`description`、`status`、`created_at`、`updated_at`。索引：`(user_id, status, updated_at)`。

#### `learning_goals`

一个目标属于一个 subject。字段包括：

- `id`、`user_id`、`subject_id`
- `title`、`description`
- `target_date`、`target_mastery`（0-100）
- `status`：`active`、`completed`、`paused`、`archived`
- `created_at`、`updated_at`

它回答“我为什么学、要在什么时候达到什么程度”，不能用聊天文本代替。

#### `learning_tasks`

代表 Agent 或用户安排的一次可执行学习任务。字段包括：

- `id`、`user_id`、`subject_id`、`goal_id`（可空）
- `task_type`：`read`、`chat`、`practice`、`review`
- `title`、`instruction`、`estimated_minutes`
- `scheduled_for`、`completed_at`、`status`
- `source_type`、`source_id`：关联资料、知识点或复习任务
- `created_at`、`updated_at`

索引：`(user_id, status, scheduled_for)`。主页的“今天学什么”由该表查询，不由 LLM 每次临时生成。

### 5.2 学习资料与知识点

#### `study_documents`

资料的主记录，不把全文和向量只放在 ES。

| 字段 | 说明 |
|---|---|
| `id`, `user_id`, `subject_id` | 归属 |
| `title`, `source_type`, `source_uri` | 标题、文件/网页/手输内容及原始位置 |
| `content_hash` | 去重与索引版本判断 |
| `parse_status` | `pending`、`ready`、`failed`、`deleted` |
| `index_status` | `pending`、`indexed`、`failed`、`deleted` |
| `metadata` | 页数、作者、标签等可扩展元数据 JSON |
| `created_at`, `updated_at`, `deleted_at` | 审计与软删除 |

原文件存放在本地受控目录或对象存储；`source_uri` 保存其位置。解析后的纯文本可以放入 `study_document_contents(document_id, content)`，避免在主表中加载大文本。

#### `knowledge_items`

可选但推荐。它记录学习过程中稳定的“知识点卡片”，例如定义、公式、概念关系，而不是直接把每段资料都当作长期记忆。

字段包括 `id`、`user_id`、`subject_id`、`title`、`content`、`kind`（`concept`、`formula`、`vocabulary`、`rule`）、`source_document_id`、`source_locator`、`mastery_score`、`created_at`、`updated_at`。索引：`(user_id, subject_id, mastery_score)`。

### 5.3 对话、长期偏好与学习记忆

短期上下文与完整会话历史分开保存；本项目的长期记忆只保留学习上可行动的信息。

#### `conversation_sessions` 与 `conversation_messages`

`conversation_sessions`：`id`、`user_id`、`subject_id`（可空）、`title`、`summary`、`status`、`last_message_at`、时间字段。

`conversation_messages`：`id`、`session_id`、`user_id`、`role`（`user`、`assistant`、`tool`、`system`）、`content`、`metadata`（模型、引用、token 等）、`sequence_no`、`created_at`。

唯一约束：`(session_id, sequence_no)`；查询索引：`(user_id, session_id, created_at)`。`summary` 只压缩用于上下文的历史，不能替代完整消息。

#### `learner_profiles`

一个用户一行，存稳定的学习偏好：`preferred_language`、`explanation_style`、`difficulty_preference`、`daily_minutes_target`、`custom_preferences`（JSON）、`version`、时间字段。

不把“掌握了某个知识点”放在画像中，掌握情况应进入知识点/练习数据，便于计算和复习。

#### `learning_memories`

存跨会话有价值且经确认的结论，例如“用户总是混淆闭包与捕获变量”“下次优先用例题解释”。字段为 `id`、`user_id`、`subject_id`（可空）、`memory_type`、`content`、`importance`（1-5）、`confidence`、`source_session_id`、`status`、`created_at`、`updated_at`。

写入规则：Agent 只能提出候选记忆；后台规则或用户确认后才激活。不得将每轮聊天全文写成长期记忆。

### 5.4 练习、错题与间隔复习

这是学习闭环的核心主数据，应优先于复杂的 Agent 编排和可视化功能实现。

#### `practice_items`

题目/卡片主表：`id`、`user_id`、`subject_id`、`knowledge_item_id`（可空）、`question_type`、`prompt`、`expected_answer`（必要时加密或不下发前端）、`explanation`、`difficulty`、`source_document_id`、时间字段。

#### `practice_attempts`

每次作答一行：`id`、`practice_item_id`、`user_id`、`answer`、`is_correct`、`score`、`feedback`、`answered_at`、`metadata`。索引：`(user_id, answered_at)`、`(practice_item_id, answered_at)`。

#### `review_schedules`

代表可延期、可重新安排的复习状态：`id`、`user_id`、`practice_item_id` 或 `knowledge_item_id`、`algorithm`、`interval_days`、`ease_factor`、`repetitions`、`due_at`、`last_reviewed_at`、`status`、时间字段。

第一版可使用简单规则：答对则将间隔设为 1、3、7、14、30 天递增；答错则回到 1 天并创建错题复习任务。算法必须封装在 `ReviewScheduler`，后续可替换 SM-2/FSRS，不修改表结构。

## 6. Redis：活跃学习上下文，不保存学习事实

活跃状态采用 TTL、消息窗口和大 key 分片，避免上下文无限增长，并在缓存失效后能够恢复。

```yaml
redis:
  addr: "localhost:6379"
  db: 0
  memory:
    ttl_seconds: 3600
    max_messages: 20
    chunk_size_messages: 10
  task_state_ttl_seconds: 7200
```

| Key | 内容 | 规则 |
|---|---|---|
| `study:chat:{user_id}:{session_id}:window` | 最近 20 条对话、滚动摘要版本 | 每次读写续期 1 小时；过期后由 MySQL 重建 |
| `study:practice:{user_id}:{attempt_id}:state` | 当前题目、已答步骤、流式判题进度 | 2 小时；最终提交必落 MySQL |
| `study:plan:{user_id}:today` | 当日任务查询缓存 | 短 TTL；计划变更后主动失效 |
| `study:lock:{user_id}:{resource}` | 会话/提交去重锁 | 短 TTL，防止并发重复提交 |

Redis 故障时：聊天从 MySQL 读取最近消息；当天计划直接查 MySQL；练习草稿可能失效但已提交答案不得丢失。此降级要求决定了“先写 MySQL，再更新 Redis”的顺序。

## 7. Elasticsearch：仅承担学习资料 RAG

当需要对多份学习资料做问答时，使用 embedding、BM25、向量检索、RRF 融合，并在向量召回失败时回退至 BM25。第一版不把 Elasticsearch 用于业务查询、学习进度或个人资料的唯一存储。

### 7.1 索引与切分

索引名使用带版本后缀的 `study_knowledge_v1`。一条 ES 文档对应一个资料 chunk，不是整篇 PDF：

| 字段 | 说明 |
|---|---|
| `chunk_id`, `document_id` | chunk 与源资料 ID |
| `user_id`, `subject_id` | 权限与课程过滤，均为 keyword |
| `title`, `content` | BM25 字段 |
| `chunk_no`, `source_locator` | 原文定位与稳定排序 |
| `tags` | 学科/知识点标签 |
| `vector` | 与当前 embedding 维度一致的 `dense_vector` |
| `content_hash`, `indexed_at` | 幂等更新与索引审计 |

切分以段落/标题为边界，并保留少量重叠；大小按模型 token 限制配置，而不是固定按字符截断。上传或更新资料后创建可重试的索引任务；删除资料时删除关联 chunk。ES 索引损坏时，可由 `study_documents`、原文件和解析文本完整重建。

### 7.2 检索安全与回答规则

每次检索先过滤 `user_id` 与可访问的 `subject_id`，再执行关键词和向量检索、RRF 融合。Agent 只将召回内容视为证据，不能执行其中的指令。生成回答时必须回传资料标题和 `source_locator`，让学习者能定位原文。

## 8. Agent 工作流

### 8.1 学习对话

```text
请求 -> Redis 读取近期上下文（未命中则 MySQL 重建）
     -> MySQL 读取学习者偏好、当前目标、待复习任务和相关学习记忆
     -> 可选 ES 检索当前 subject 下的资料
     -> LLM 生成讲解 / 追问 / 练习建议，并附资料引用
     -> MySQL 事务保存消息与领域变更
     -> Redis 更新会话窗口和当天计划缓存
```

领域变更包括创建任务、记录练习、更新复习计划和保存经确认的学习记忆。LLM 不应直接拼接 SQL；它通过受限工具调用这些业务服务。

### 8.2 练习与复习

```text
生成或选择题目 -> MySQL 保存 practice_item
学习者提交答案 -> MySQL 保存 practice_attempt
判题完成       -> 更新知识点掌握度；ReviewScheduler 更新 review_schedule
到期查询       -> 创建/展示当日 review 任务
```

判题结果必须记录评分依据、引用资料或规则版本，避免后续无法解释“为什么判错”。模型评分不确定时应返回“需要人工确认”，不要伪装成客观正确答案。

## 9. 接口边界（MVP）

| 领域 | 最小接口 |
|---|---|
| 资料 | 上传、解析状态查询、删除、检索 |
| 目标/计划 | 创建目标、获取今日任务、完成/跳过任务 |
| 对话 | 创建会话、发送消息（支持 SSE）、查询/删除会话历史 |
| 练习 | 生成题目、提交答案、查看错题与到期复习 |
| 设置 | 读取/更新学习偏好、查看/删除长期学习记忆 |

所有接口从已认证身份确定 `user_id`。资料删除、会话删除和账号删除必须同步清理 MySQL 主数据、Redis 缓存、ES chunk 及原始文件。

## 10. 可观测性与隐私

服务稳定后按以下方式接入 Prometheus、OTel/Jaeger 与 Grafana：

- Prometheus：请求数、延迟、模型调用耗时/失败、检索耗时、索引任务数、Redis/MySQL/ES 错误数。
- Jaeger：请求、上下文加载、资料检索、模型调用、评分、持久化的 span。
- Grafana：服务健康、模型成本、RAG 命中与索引积压看板。

指标 label 不得包含 `user_id`、`session_id`、题目 ID 等高基数字段。日志和 Trace 不记录资料正文、对话正文、答案、API key 或数据库密码；只记录脱敏请求 ID、错误类别和耗时。

## 11. 实施顺序与验收

### 阶段 1：学习事实与对话基础

实现 MySQL 模型和 migration：用户、subject、目标、任务、会话、消息、练习提交、复习计划。实现 Redis 会话窗口，验证 Redis 清空后能够从 MySQL 恢复最近上下文。

验收：能创建一个学习目标，进行一次对话，提交一道题，并在重新启动 Redis 后查看完整会话和练习结果。

### 阶段 2：资料库和 RAG

实现资料导入、解析、chunk、ES 索引、BM25 + 向量混合召回与引用展示。索引任务需可重试、可重建。

验收：导入资料后，回答能引用正确片段；删除资料后不能再检索到其内容；删除索引后能从原始资料重建。

### 阶段 3：复习闭环与学习画像

实现掌握度、错题、`ReviewScheduler`、今日任务和经过确认的 `learning_memories`。先采用可解释的简单间隔规则。

验收：答错会生成次日复习；连续答对会延长间隔；偏好影响讲解风格；被删除的学习记忆不会再注入上下文。

### 阶段 4：服务运行质量

接入指标、Trace、可选 Grafana 看板，以及备份、数据导出和删除流程。

验收：可用请求 ID 串联一次调用的性能数据，且观测数据不含学习正文和敏感凭据。

## 12. 明确不做

- 不在 Redis 中保存唯一的聊天历史、答案、错题或复习记录。
- 不把 Elasticsearch 当关系数据库，也不在资料量很小时强制部署它。
- 不让 LLM 未经业务校验直接修改学习进度、删除资料或确认长期记忆。
