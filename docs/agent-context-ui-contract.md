# S1 个人上下文 UI Contract

> 状态：已决定 · 2026-08-30  
> Contract ID：`speech-agent.personal-context.ui`  
> Contract version：`1.0.0`

本文是 S1 `settings` / `history` renderer-facing contract 的权威说明。可执行 exact validator 位于 `src/agent/contracts/agent-context-ui.js`；脱敏 preview fixture 位于 `src/agent/contracts/fixtures/agent-context-ui/v1.0.0/`。若本文与可执行 validator 不一致，发布前必须停止签发并修正二者；不得由 UI 选择性兼容。

语义仍以 `semantic-contract.md`、ADR 0013–0015、S1 OpenSpec 与 `testing-strategy.md` J21 为上位权威。本文只冻结已有 S1 语义的 UI projection、IPC 边界和版本规则，不定义 S2–S6。

## 1. 版本规则

`contract_id` 标识一条独立于项目版本、SQLite migration 和发布版本的 UI 合同线；`contract_version` 使用 `MAJOR.MINOR.PATCH` 十进制形式。`1.0.0` 与项目 v5/v6/v7 没有换算关系。

| 变更类别 | 版本动作 | 例子 |
|---|---|---|
| breaking | 升 MAJOR | 删除/改名字段；改变必需性或类型；收窄允许值；改变角色、频道、状态转换、错误、重试或隐私语义 |
| additive | 升 MINOR | 新增可选字段、命令、结果 variant、枚举值或 fixture 场景；exact consumer 仍须显式升级后才能接受 |
| metadata-only | 升 PATCH | 不改变机器载荷与用户可观察语义的注释、来源说明或等价勘误 |

冻结与发布规则：

1. UI 一旦开始消费某版本，该版本的 validator、字段、枚举、错误、权限和 fixture 文件即只读；禁止静默修改。
2. 新版本必须新建 validator 导出与 `vMAJOR.MINOR.PATCH/` fixture 目录，更新支持版本 allowlist、本文、OpenSpec design 和 AUI-CR 台账，并先通过同一负矩阵。
3. 每个 request、response、event 和 fixture envelope 都必须同时携带完全匹配的 `contract_id` 与 `contract_version`。不做版本猜测、向下兼容解析或最接近版本回落。
4. 旧版本只在 Core 支持 allowlist 中继续兼容。新版本签发不自动移除旧版本；所有 renderer 消费者迁移并有对应联合证据后，才可用 breaking 版本移除。
5. 当前 allowlist 恰好只有 `speech-agent.personal-context.ui@1.0.0`。

## 2. 所有权与边界

| 所有者 | 拥有 | 不拥有 |
|---|---|---|
| Core | 三个 IPC seam、角色权限、exact 校验、版本协商、revision、排序/分页、错误分类、幂等、隐私裁剪、存储与后台恢复 | renderer 的布局、视觉、文案层级、动效 |
| UI/UX | loading/pending/empty/ready/unavailable/conflict 的呈现、焦点与可访问性、何时按合同发起重试或 reload | SQLite、自由查询、错误字符串解释、scheduler 状态推断、乐观成功、额外字段兼容 |

本版本不实现 main handler、preload、SQLite 或 renderer。它只冻结 S5-Integration 将实现的边界。不得引用、包装或依赖 `src/agent-mvp/**`。

## 3. 公共 IPC seam

| seam | 形态 | 允许角色 | 用途 |
|---|---|---|---|
| `agent-context:get-overview` | invoke | `settings`, `history` | 读取计数、资格、个人记忆处理状态与权威 revision |
| `agent-context:manage` | invoke | `settings`, `history` | 有界查看和六种管理命令 |
| `agent-context:changed` | observer event | `settings`, `history` | 只通知更高权威 revision；接收方重新读取，不携带数据正文 |

`caption`、`toolbar` 和未知角色在进入个人上下文模块前拒绝。拒绝不得改变 projection、revision 或存储。

现有 preload global 不改名；S5-Integration 必须在两个 global 上映射同一组方法，不能让 renderer 直接取得 `ipcRenderer`：

| 角色 | global | 方法 | 精确映射 |
|---|---|---|---|
| `settings` | `window.shell` | `getAgentContextOverview(request)` | invoke `agent-context:get-overview`，入参/出参见 §4 |
| `settings` | `window.shell` | `manageAgentContext(request)` | invoke `agent-context:manage`，入参/出参见 §5–§6 |
| `settings` | `window.shell` | `onAgentContextChanged(callback)` | subscribe `agent-context:changed`；callback 只接收 `ChangedEvent`；返回 unsubscribe function |
| `history` | `window.historyApi` | 同上三个方法 | 同一频道与 exact payload；权限不扩大 |

角色由 main 根据 sender/window 身份判定，不作为 renderer 可填写字段进入生产 request。fixture 的 `caller_role` 只用于预览授权/拒绝场景。

### 3.1 公共 header

| 字段 | JSON 类型 | 必需 | 约束 |
|---|---|---|---|
| `contract_id` | string | 是 | 恰好 `speech-agent.personal-context.ui` |
| `contract_version` | string | 是 | 恰好 `1.0.0` |

所有对象均为 exact object：缺少必需字段、出现未知字段、类型错误或未登记枚举都拒绝，不忽略、不补默认值。

## 4. Overview projection

### 4.1 `GetOverviewRequest`

只有公共 header 两个字段。

### 4.2 `GetOverviewResponse`

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| 公共 header | string × 2 | 是 | 见 §3.1 |
| `ok` | boolean | 是 | 成功为 `true` |
| `snapshot` | `OverviewSnapshot \| null` | 是 | 成功时对象；失败时 `null` |
| `error` | `PublicError \| null` | 是 | 成功时 `null`；失败时对象 |

`OverviewSnapshot`：

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `counts.personal_memories` | integer | 是 | ≥ 0 |
| `counts.session_episodes` | integer | 是 | ≥ 0 |
| `eligibility` | enum | 是 | `ready`, `no_committed_transcript`, `outside_automatic_window`, `agent_disabled`, `provider_not_configured`, `cloud_disclosure_required`, `credential_unavailable`, `local_model_not_ready`, `session_not_terminal` |
| `memory_processing.state` | enum | 是 | `enabled` 或 `suspended` |
| `memory_processing.automatic_processing_boundary` | enum | 是 | `current_effective_cycle` 或 `not_established`；`suspended` 时必须为 `not_established` |
| `revision` | integer | 是 | ≥ 0，整个个人上下文公开 projection 的权威 revision |

`eligibility` 是用户可观察的处理资格，不是 scheduler 运行状态。`claim`、lease、`wakeEpoch`、timer、generation、attempt 和 `AGENT_SCHEDULER_FAILED` 不得映射到此对象。后台技术故障由诊断与幂等恢复处理；它本身不切换产品页面状态。

## 5. Manage request

`ManageRequest` 的公共字段：

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| 公共 header | string × 2 | 是 | 见 §3.1 |
| `request_id` | string | 是 | 1–128 字符；`[a-z0-9][a-z0-9._:-]*` |
| `command` | command union | 是 | `type` 决定 exact shape |

命令闭集：

| `type` | 必需输入 | 成功结果 |
|---|---|---|
| `view` | `resource`, `limit`, `cursor` | `memory_page` 或 `episode_page` |
| `remember` | `expected_revision`, `entry` | `memory_item(operation=remember)` |
| `update` | `expected_revision`, `item_id`, `item_revision`, `entry` | `memory_item(operation=update)` |
| `forget` | `expected_revision`, `item_id`, `item_revision` | `memory_item(operation=forget, lifecycle=forgotten)` |
| `delete` | `expected_revision`, `item_id`, `item_revision`, `deletion_idempotency_key` | `deletion` |
| `set_processing` | `expected_revision`, `state` | `processing` |

字段约束：

- `expected_revision` 为 ≥ 0 integer；所有写命令必需。`item_revision` 为 ≥ 1 integer。
- `view.resource` 只允许 `personal_memories` / `session_episodes`；`limit` 为 1..20；`cursor` 为 `null` 或 1..256 字符的 opaque token。renderer 不解释或构造 cursor。
- `set_processing.state` 只允许 `enabled` / `suspended`。
- `deletion_idempotency_key` 与 ID 使用同一受限字符集。删除结果未知时必须以同一 key 重放，不生成新 key。

### 5.1 `StructuredEntry`

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `display_text` | string | 是 | 非空，≤ 2048 UTF-8 bytes；可展示的个人记忆内容 |
| `kind` | enum | 是 | `decision`, `conclusion`, `todo`, `term`, `preference`, `project_fact`, `experience` |
| `scope.kind` | enum | 是 | `global`, `session`, `topic`, `project` |
| `scope.reference` | string \| null | 是 | `global` 必须为 `null`；其它范围为稳定 opaque ID |
| `semantic_key` | string | 是 | 非空，≤ 256 UTF-8 bytes；提交前已完成 NFKC + casefold |

这是受控个人记忆输入，不是自由文本命令，也不是数据库行。`kind=term` 仍只是一条个人记忆，不进入 J20 确认关键词集合，不改变识别 provider。

## 6. Manage response projection

`ManageResponse`：

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| 公共 header | string × 2 | 是 | 见 §3.1 |
| `ok` | boolean | 是 | 成功为 `true` |
| `revision` | integer \| null | 是 | 成功为新权威 revision；冲突为当前 revision；其它失败为 `null` |
| `result` | result union \| null | 是 | 成功时对象；失败时 `null` |
| `error` | `PublicError \| null` | 是 | 成功时 `null`；失败时对象 |

### 6.1 `MemoryItem`

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `memory_id` | string | 是 | opaque stable ID |
| `revision` | integer | 是 | ≥ 1，条目 revision |
| `display_text` | string | 是 | 非空，≤ 2048 UTF-8 bytes |
| `kind` | enum | 是 | §5.1 七值 |
| `origin` | enum | 是 | `explicit`, `inferred` |
| `lifecycle` | enum | 是 | `active`, `forgotten` |
| `scope.kind` | enum | 是 | §5.1 四值 |
| `scope.reference` | string \| null | 是 | global 为 `null` |
| `scope.label` | string | 是 | Core 生成的有界展示标签，≤ 256 UTF-8 bytes |
| `source_reference_count` | integer | 是 | ≥ 0；只给计数，不给来源正文 |
| `updated_at` | string | 是 | RFC 3339 UTC；fixture 只使用固定合成值 |

### 6.2 `SessionEpisode`

| 字段 | 类型 | 必需 | 约束 |
|---|---|---|---|
| `episode_id` | string | 是 | opaque stable ID |
| `source_kind` | enum | 是 | `session`, `interaction` |
| `scope` | `ScopeProjection` | 是 | 与 MemoryItem 相同三字段 |
| `occurred_from_offset_ms` | integer | 是 | ≥ 0，相对偏移 |
| `occurred_through_offset_ms` | integer | 是 | ≥ from，相对偏移 |
| `summary.title` | string | 是 | 非空，≤ 512 UTF-8 bytes |
| `summary.bullets` | string[] | 是 | 最多 8 条，每条 ≤ 1024 UTF-8 bytes |
| `omissions` | enum[] | 是 | 最多 2 个且不重复：`budget`, `not_committed_tail` |
| `source_reference_count` | integer | 是 | ≥ 1 |
| `lifecycle` | enum | 是 | 本版本只允许 `active` |
| `updated_at` | string | 是 | RFC 3339 UTC |

summary 是有界结构化轨迹，不得复制整场字幕正文或完整交互历史。

### 6.3 result union

- `memory_page` / `episode_page`：exact 字段为 `kind`, `items`, `has_more`, `next_cursor`；items ≤ 20；`has_more=true` 当且仅当 `next_cursor` 非空。排序由 Core 按既有稳定规则完成，renderer 不重排来改变事实优先级。
- `memory_item`：exact 字段为 `kind`, `operation`, `item`；operation 只允许 `remember`, `update`, `forget`。
- `deletion`：exact 字段为 `kind`, `operation=delete`, `replayed`, `deleted`；`deleted` 恰含非负整数 `items`, `revisions`, `evidence`，不回显被删正文。同一 idempotency key 重放返回首次计数且 `replayed=true`。
- `processing`：exact 字段为 `kind`, `operation=set_processing`, `memory_processing`。

## 7. Changed event、状态与转换

`ChangedEvent` 恰含公共 header 与 ≥ 0 的 `revision`。renderer 先订阅 changed，再读取 overview；只接受比本地已应用 revision 更高的事件。事件只触发 reload，不携带 snapshot 或变更正文。

UI 请求状态：

```text
initial ──invoke──> loading/pending ──ok──> empty|ready
                               ├──validation/permission──> failed (不重试)
                               ├──unavailable──> unavailable ──retry──> loading/pending
                               └──conflict/failure/not_found──> reload-required ──reload──> loading

ready|empty ──higher changed revision──> loading ──snapshot──> ready|empty
```

领域状态转换：

- `remember`：不存在或用户明确恢复的条目 → `active`；推进全局 revision。
- `update`：用户明确修订；可使 `forgotten` 条目恢复为 `active`；推进条目与全局 revision。
- `forget`：`active` → `forgotten`；保留条目、revision 历史、来源引用和会话经历记录；自动摄取不得静默恢复。
- `delete`：`active|forgotten` → 不再存在；先写不含正文的 suppression，再物理移除条目、revision 与 evidence。
- `set_processing`：`enabled ↔ suspended`。suspended 不批量改写既有条目；重新开启建立当前有效周期边界，不补处理休眠期间或更早会话。

本版本没有 cancel 命令。renderer 关闭确认层只取消尚未提交的本地意图；IPC 一旦发出不能宣称已取消，必须等待回执或按 changed/reload 收束。此限制不定义 S3/S4 的 Agent 运行取消语义。

## 8. 错误、重试与 reload

`PublicError` 恰含 `category`, `code`, `current_revision`, `next_action`, `retry_policy`：

| code | category | retry_policy | next_action | UI 行为 |
|---|---|---|---|---|
| `AGENT_CONTEXT_REQUEST_INVALID` | `validation` | `none` | `null` | 保留用户输入，不自动重试 |
| `AGENT_CONTEXT_PERMISSION_DENIED` | `permission` | `none` | `null` | 不暴露安全或 IPC 内部细节 |
| `AGENT_CONTEXT_REVISION_CONFLICT` | `conflict` | `reload` | `reload` | `current_revision` 必须是整数；零写入，保留编辑，reload 后由用户再次提交 |
| `AGENT_CONTEXT_NOT_FOUND` | `not_found` | `reload` | `reload` | reload 权威列表，不把缺失当成功 |
| `AGENT_CONTEXT_OPERATION_FAILED` | `failure` | `reload` | `reload` | 前台操作结果不确定；不宣称成功，先 reload |
| `AGENT_CONTEXT_UNAVAILABLE` | `unavailable` | `retry_same_request` | `retry` | 当前前台 seam 不可用；相同读取可重试 |

除 revision conflict 外 `current_revision=null`。错误对象不含 message、原始异常、stack、provider 文本或 scheduler 诊断。

重试规则：读取可用同一 request 重试；删除只用同一 `deletion_idempotency_key` 重放；其它写操作如果回执未知，先 reload，再基于新 revision 由用户决定是否重新提交。版本不匹配永不重试为其它版本，也不静默接受形状相似的载荷。

## 9. 隐私与 fail-closed

request、response、event、fixture、日志、普通报告和验证 JSON 都不得包含真实凭据、授权 header、现场音频、PCM、WAV、音频路径、本地绝对路径、设备名、字幕正文、绝对单调时刻、时钟偏移、原始异常/stack 或 scheduler 内部字段。production projection 只允许本合同列出的有界个人记忆展示内容与会话经历摘要，不得夹带原始字幕段。

fixture 的隐私扫描对敏感字段名和值 fail closed。任何 privacy 失败、未知字段、未知枚举或版本不匹配都使整个载荷无效；UI 不从部分字段继续渲染。

## 10. Fixture 矩阵

唯一位置：`src/agent/contracts/fixtures/agent-context-ui/v1.0.0/`。

| 场景 | fixture |
|---|---|
| empty | `overview-empty.json` |
| loading | `overview-loading.json` |
| ready overview | `overview-ready.json` |
| ready 个人记忆 | `manage-view-ready.json` |
| ready 会话经历记录 | `manage-view-episodes-ready.json` |
| processing | `manage-remember-processing.json` |
| suspended overview | `overview-suspended.json` |
| remember result | `manage-remember-result.json` |
| set processing result | `manage-set-processing-result.json` |
| validation error | `manage-validation-error.json` |
| revision conflict | `manage-revision-conflict.json` |
| permission failure | `manage-permission-failure.json` |
| unavailable | `overview-unavailable.json` |
| foreground operation failure | `manage-operation-failure.json` |
| forget result | `manage-forget-result.json` |
| delete result | `manage-delete-result.json` |
| changed/reload trigger | `changed-reload.json` |
| reload result | `overview-reload-result.json` |

每个 envelope 都带 header，并固定 `preview_only=true`、`j21_evidence=false`。envelope 只为 UI 预览补充 `scenario`、`caller_role` 和 pending 描述；其中嵌入的 request/response/event 使用生产 validator 校验。版本变化时创建新目录和新文件，不修改本目录既有 fixture。

验证命令：

```powershell
node --test test/contracts/agent-context-ui-contract.test.js
npm run test:core
```

fixture 预览不构成 J21 的正式验收证据。J21 仍需在 S5-Integration 通过真实 preload、exact IPC、个人上下文模块与 SQLite 的联合旅程收束。

## 11. 已知限制与语义缺口

- S1 没有真实 S2 模型接入层时，自动路径稳定为 `provider_not_configured`；fixture 中的 `ready` 仅覆盖 UI shape，不能伪造产品自动路径资格或 J21 证据。
- 本合同没有筛选、任意排序、自由查询、搜索、批量写、undo 或 cancel seam；UI 不得自行补出。
- scheduler 技术故障没有 UI 状态、错误码或提示文案；如果未来要求用户可观察的降级状态，属于新的用户可观察语义，必须先按 SEM-T06 登记并发布新 contract 版本。
- 真实 handler、preload、access policy、observer 隔离和 renderer 消费属于后续 S1 8.1–8.4 与 S5-Integration，不由这些 fixture 证明。
