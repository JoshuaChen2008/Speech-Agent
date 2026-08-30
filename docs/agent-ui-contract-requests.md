# 正式 Agent UI → Core contract request 台账

> 状态：已决定 · 2026-08-29
>
> 适用范围：正式 Agent 的设置、字幕历史与 Agent Bar。隔离 Agent 内核开发入口 `src/agent-mvp/**` 不使用本台账。
>
> 权威顺序：[`semantic-contract.md`](semantic-contract.md) → ADR 0013–0015 → [`agent-redesign-execution-plan.md`](agent-redesign-execution-plan.md) → [`testing-strategy.md`](testing-strategy.md) → 本台账。
>
> 本文件只协调 renderer 需要的事实与动作，不定义新的产品语义。新增功能或改变语义时先按 SEM-T06 更新语义合同和用户旅程，再在这里登记 exact contract。

## 1. 使用方式

UI/UX 模型只从冻结 snapshot、CommandResult、事件和 fixture 取得事实。需要 Core 尚未提供的事实或动作时，新增一条 `AUI-CR-*`；renderer 保持显式不可用或省略该入口，直到 Core 签发 contract 与 fixture。

处理流程：

1. UI/UX 写清用户意图、所需事实或动作、缺失时的 fail-closed 表现和受影响 SEM/J。
2. Core owner 判断它是既有语义的投影，还是语义变更。
3. 语义变更先更新 `semantic-contract.md` 与 `testing-strategy.md`；纯投影直接冻结 exact Schema、权限、错误和 revision 规则。
4. Core 提供脱敏 fixture 与负例；UI/UX 消费 fixture，不自行扩展字段。
5. S5-Integration 用真实 preload/exact IPC/SQLite 替换预览 adapter，并在对应 J 旅程中关闭请求。

请求处理值只用于本台账，不代表产品状态：

- `open`：等待 Core 判断。
- `accepted`：需求已决定，exact contract 或 fixture 尚未签发。
- `contract-ready`：exact contract、权限、错误和 fixture 已可消费。
- `consumed`：正式 renderer 已消费，仍等待或已经进入 S5-Integration。
- `rejected`：不符合权威语义；记录理由后停止实现。

## 2. 已决定的交接依赖

这些 seam 已由总体 SPEC 决定，不需要 UI/UX 重复申请；其 exact 字段仍由对应 Core 切片签发。

| Core 切片 | renderer 需要的公开投影/动作 | UI/UX 消费面 | 联合旅程 |
|---|---|---|---|
| S1 | personal-context overview；查看、修改、删除、休眠、记住、忘记；revision conflict；changed revision | 设置、字幕历史 | J21 |
| S2 | 多配置档案、模型清单、凭据存在性与 scope、四用途及回落、九命令结果、用户触发目录建议 | 设置 | J25 |
| S3 | 九值 Agent 处理资格、范围投影、submit/cancel、运行中/终态状态、最小交互历史、结果、`ModelUsageV1`（input/output token，用量来源恒为 `provider`；未返回时整体为 `null` 且界面显示「用量未知」）、可空缓存命中率、相对时长 | Agent Bar、字幕历史 | J22/J24/J25 |
| S4 | 预算耗尽、多 attempt、完整工具调用记录及七值工具错误；公开投影不含 recipe ID、轮次上限、工具授权或任一执行形态 | Agent Bar 交互详情 | J22/J24 |
| S5-Core | `agent` 窗口生命周期、正式 preload、changed 订阅、单交互导出结果与保存对话框取消/失败 | Agent Bar、字幕历史 | J21/J22/J24/J25/J26 |

每个切片的 fixture 必须使用合成身份与合成文本，只表达枚举、布尔、计数、相对时长、短 digest 和受控展示内容；不得含凭据、现场音频、音频路径、设备名、本地绝对路径、绝对单调时刻或时钟偏移，也不得含 price/cost/currency/pricing 或任何金额字段（SEM-F33、[ADR 0014](adr/0014-multi-profile-model-access-layer.md) 第 11 项）。

> **2026-08-30 执行路径修订对本台账的影响**：按 [ADR 0016](adr/0016-unified-agent-execution-path.md)，`single_shot` / `agent_loop` 二分、升级理由与运行期形态判定全部取消，UI 不再需要、也不得呈现执行形态或升级理由；所有 recipe 共用同一产品语言，轮次上限与工具授权是内部登记事实，不进入任何投影。按 [ADR 0017](adr/0017-retire-confirmed-recognition-terms.md)，确认关键词退出首版范围，设置界面不得出现任何把个人记忆转换成识别关键词的入口。fixture preview 不是 `.artifacts/` 或 `docs/validation/` 证据。

## 3. 请求模板

复制下面模板，并保持一条请求只解决一个用户意图：

```markdown
### AUI-CR-000 · 简短标题

- 处理值：open
- 提出面：settings / history / agent
- 用户意图：
- 需要的事实或动作：
- 缺失时的 fail-closed 表现：
- 受影响语义/旅程：SEM-__ / J__
- 建议的成功 fixture：
- 建议的失败 fixture：
- Core 判断：待填写
- exact contract：待填写
- S5-Integration 证据：待填写
```

## 4. 当前请求

下列请求由 2026-08-29 的 UX-1 交付（[`agent-ui-ux-handoff.md`](agent-ui-ux-handoff.md) §11，设置 · 个人上下文管理）提出。Core 已先以 `speech-agent.personal-context.ui@1.0.0` 签发基础 exact contract，并于 2026-08-31 由 `1.1.0` 取代当前 allowlist；请求保持 `contract-ready`，但仍未构成正式 renderer 消费或 J21 联合证据。

### AUI-CR-001 · 个人记忆条目的有界浏览投影

- 处理值：contract-ready
- 提出面：settings
- 用户意图：我想看看我现在有哪些个人记忆，并从列表里选一条来修改、停用或删除。
- 需要的事实或动作：`查看` 命令返回一页有界个人记忆条目，每条至少含稳定标识、范围类型（全局/会话/主题/项目）、条目类型（七值闭集）、来源（明确内容/自动推断）、生命周期、来源引用条数、更新时间、可展示正文，以及该条目当前 revision（供写动作携带 `expectedRevision`）；页级含固定排序与 `hasMore`。若允许按闭集维度筛选，需在载荷中冻结允许的枚举字段。
- 缺失时的 fail-closed 表现：个人记忆分区只显示通用不可用说明，不显示任何条目行，不提供修改/停用/删除动作。
- 受影响语义/旅程：SEM-F30 / SEM-T15 / J21
- 建议的成功 fixture：合成条目跨四种范围类型与多个条目类型；一页触达上界且 `hasMore=true`；一页为空。
- 建议的失败 fixture：载荷含额外键被拒；`settings` 之外角色被拒；返回值含未登记枚举值。
- Core 判断：既有 S1 语义的 projection 扩展；本版本冻结 `MemoryItem`、20 条上界、opaque cursor 与 Core-owned 稳定排序，不增加筛选或任意排序。
- exact contract：[`agent-context-ui-contract.md`](agent-context-ui-contract.md) §5–§6；`src/agent/contracts/agent-context-ui.js`；`manage-view-ready.json` / `overview-empty.json`。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J21 证据。

### AUI-CR-002 · 会话经历记录的有界浏览与省略标记投影

- 处理值：contract-ready
- 提出面：settings
- 用户意图：我想知道某段时间、某个会话或某个项目发生了什么，而不是只看一堆原子事实。
- 需要的事实或动作：`查看` 命令返回一页有界会话经历记录，每条至少含稳定标识、来源种类（会话 / 正式 Agent 交互）、来源范围标识、发生时间范围（相对偏移，不含绝对单调时刻）、有界结构化轨迹的可展示投影、来源引用条数、生命周期，以及是否存在省略标记（首个需要的值是未提交尾部 `not_committed_tail`）；页级含固定排序与 `hasMore`。
- 缺失时的 fail-closed 表现：会话经历记录分区只显示通用不可用说明；不用个人记忆条目冒充经历记录，也不由缺少字段推断"没有省略"。
- 受影响语义/旅程：SEM-F26 / SEM-F30 / J21
- 建议的成功 fixture：会话来源与交互来源各一条；一条带省略标记；一页触达上界；一页为空。
- 建议的失败 fixture：轨迹超出有界预算被拒；来源种类与来源标识不一致；返回值含未登记省略标记值。
- Core 判断：既有 SEM-F26/SEM-F30 的 projection 扩展；公开值只含相对偏移、有界 `title + bullets`、来源计数与 `budget` / `not_committed_tail`，不复制整场正文。
- exact contract：[`agent-context-ui-contract.md`](agent-context-ui-contract.md) §6.2–§6.3；`manage-view-episodes-ready.json`。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J21 证据。

### AUI-CR-003 · 个人记忆处理状态与自动处理边界的可读投影

- 处理值：contract-ready
- 提出面：settings
- 用户意图：我想知道现在还在不在处理个人记忆，以及重新开启后哪些会话会被处理、哪些不会。
- 需要的事实或动作：overview snapshot 含当前处理档位（处理中 / 休眠）的枚举，以及个人记忆自动处理边界的可展示投影，用于说明"休眠期间与更早的会话不会补处理"。`休眠` 命令的 CommandResult 需返回收束后的同一档位。边界只需相对表达，不需要绝对时刻。
- 缺失时的 fail-closed 表现：处理状态区只显示由 `休眠` 命令回执得到的当前档位，不显示任何边界说明，也不声明关闭期间会不会补处理。
- 受影响语义/旅程：SEM-F30 / SEM-F31 / J21
- 建议的成功 fixture：处理中；休眠；休眠后重新开启并携带新的边界投影。
- 建议的失败 fixture：切换命令 revision conflict 零写入；档位为未登记值。
- Core 判断：既有 SEM-F30/SEM-F31 projection；公开档位为 `enabled` / `suspended`，自动处理边界只用 `current_effective_cycle` / `not_established` 相对表达，不公开 scheduler 状态。
- exact contract：[`agent-context-ui-contract.md`](agent-context-ui-contract.md) §4、§5、§7；`overview-suspended.json` / `manage-set-processing-result.json`。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J21 证据。

### AUI-CR-004 · 「忘记」与「删除」的作用对象差异

- 处理值：contract-ready
- 提出面：settings
- 用户意图：界面给我两个动作时，我需要知道它们分别对我的数据做了什么不同的事。
- 需要的事实或动作：明确 `忘记` 与 `删除` 的作用对象差异。当前权威文档只把两者并列在 `manage` 闭集里，没有区分二者对正文保留、来源引用、生命周期、抑制事实与经历记录的影响。UI/UX 的读法是：`忘记` 使条目退出检索而不改写来源历史，`删除` 先写不含正文的抑制再物理移除条目、revision 与来源引用；这一读法需要 Core 确认或纠正。
- 缺失时的 fail-closed 表现：界面只保留一个已被明确定义的动作，另一个入口缺席；[`agent-ui-ux-handoff.md`](agent-ui-ux-handoff.md) §11.4 的两组候选文案不进入 renderer。不使用「清除记忆」这类同时覆盖两种语义的说法。
- 受影响语义/旅程：SEM-F30 / SEM-F14 / J21
- 建议的成功 fixture：忘记后条目仍可见且标注退出检索；删除后条目消失且不回显正文。
- 建议的失败 fixture：对同一条目先忘记再删除；对已删除条目再次忘记。
- Core 判断：已确认二者是独立动作，并按 SEM-T06 在 SEM-F30 与 J21 S1 子边界登记：`忘记` 退出检索但保留条目、revision、来源引用与会话经历记录，且自动摄取不得恢复；`删除` 先写不含正文的 suppression，再物理移除条目、revision 与 evidence。
- exact contract：[`agent-context-ui-contract.md`](agent-context-ui-contract.md) §5–§8；`manage-forget-result.json` / `manage-delete-result.json`。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J21 证据。

### AUI-CR-005 · 删除与忘记回执的作用对象计数

- 处理值：contract-ready
- 提出面：settings
- 用户意图：我删掉一条个人记忆后，想确认到底移除了什么，并且重复操作时不要让我以为又删了一遍。
- 需要的事实或动作：删除类 CommandResult 返回按作用对象分类的计数（条目、修改历史、来源引用等已登记类别），以及一个"本次为重放、计数与首次相同"的显式标志。计数只表达数量，不含被删除正文。
- 缺失时的 fail-closed 表现：回执只显示通用「已删除」，不报告任何计数，也不区分首次与重放；界面不从列表长度差推断删除了什么。
- 受影响语义/旅程：SEM-F14 / SEM-F30 / J21
- 建议的成功 fixture：首次删除返回各类计数；同一删除幂等键重放返回同一组计数并带重放标志。
- 建议的失败 fixture：删除命令 revision conflict 零写入；删除不存在的条目。
- Core 判断：删除回执返回 `items/revisions/evidence` 与 `replayed`；忘记不删除这些对象，因此不返回删除计数，而返回生命周期为 `forgotten` 且来源计数不变的 `MemoryItem`。二者不得共用成功形状。
- exact contract：[`agent-context-ui-contract.md`](agent-context-ui-contract.md) §6.3；`manage-delete-result.json` / `manage-forget-result.json`。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J21 证据。

### AUI-CR-006 · 设置内「记住」的结构化输入形式

- 处理值：contract-ready
- 提出面：settings
- 用户意图：我想在设置里直接记住一条长期上下文，而不必先跑一次 Agent 交互。
- 需要的事实或动作：`记住` 命令在 `settings` 角色下可接受的结构化输入形式。已知约束是 renderer 不得提交自由文本记忆行，且条目匹配只使用 NFKC + casefold 后全等的结构化键与已登记别名——因此需要 Core 说明用户在设置里通过哪些受控字段构造一条条目，以及这些字段的枚举与长度边界；或者裁定设置界面不承载 `记住`，该动作只从 Agent Bar 的结果上下文发起。
- 缺失时的 fail-closed 表现：设置界面不提供「记住」入口（入口缺席而非禁用按钮），也不提供任何自由文本记忆输入框。
- 受影响语义/旅程：SEM-F30 / SEM-F32 / J21
- 建议的成功 fixture：一条经受控字段构造的合成条目被接受。
- 建议的失败 fixture：自由文本命令类型被拒零写入；载荷含额外键被拒；同一结构化键与已有条目冲突。
- Core 判断：设置与字幕历史均可提供结构化 `记住`。当前输入恰含可展示内容、七值条目类型与四值范围；storage worker 按 AUI-CR-007 从正文派生规范化语义键，renderer 不提交该键。它不接受自由文本命令或数据库行，也不影响识别 provider——按 ADR 0017，产品不存在把个人记忆转换成识别关键词的入口。
- exact contract：[`agent-context-ui-contract.md`](agent-context-ui-contract.md) §5.1；`src/agent/contracts/agent-context-ui.js`；`v1.1.0/manage-remember-processing.json` / `manage-remember-result.json` / `manage-validation-error.json`。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J21 证据。

下列三条由 2026-08-30 的正式 renderer 消费（设置 · 个人上下文）提出。Core 已于 2026-08-31 签发 `speech-agent.personal-context.ui@1.1.0` 并全部推进到 `contract-ready`：AUI-CR-007 移除 renderer 提交的 `semantic_key`，AUI-CR-008 新增有界 automatic scope 目录，AUI-CR-009 补齐既有分页字段的 keyset 续读行为。fixture 仍是 preview-only，不构成 J21 联合证据。

### AUI-CR-007 · 结构化「记住」语义键的来源规则

- 处理值：contract-ready
- 提出面：settings
- 用户意图：我在设置里记住一条内容时，只想写下内容本身，不想再手填一个用来匹配条目的键。
- 需要的事实或动作：`StructuredEntry.semantic_key` 是必填字段，合同只约束它「非空、≤ 256 UTF-8 bytes、提交前已完成 NFKC + casefold」，没有规定它由谁产生。renderer 当前从可展示正文派生（NFKC + casefold + 首尾去空白 + 按码点边界截到 256 bytes 内），这会让匹配键随正文改写而改变，也让「已登记别名」无从表达。需要 Core 裁定三者之一：(a) 确认由 renderer 按上述规则派生，并冻结该规则；(b) 由 Core 在写入侧派生，renderer 提交的值仅作提示；(c) 语义键属于受控输入，需要单独的用户可见字段与其枚举/长度边界。
- 缺失时的 fail-closed 表现：设置界面不提供任何语义键输入或别名管理入口，也不宣称「同一条会被识别为同一条」；派生规则只在提交前生效，界面不回显该键。
- 受影响语义/旅程：SEM-F30 / SEM-F32 / J21
- 建议的成功 fixture：正文改写后语义键的期望取值（按裁定结果给出）；全角与合字正文各一条。
- 建议的失败 fixture：载荷携带 `semantic_key` 被拒零写入；与既有条目语义键全等时的收束形状。
- Core 判断：**采纳方案 (b)，由 Core 在写入侧派生。** 理由是 SEM-F30 已把「去重、冲突 revision、生命周期」划归个人上下文模块内部策略，匹配键属于该策略而不属于 renderer；方案 (a) 会让匹配键随正文改写而漂移，同一事实分裂成两条；方案 (c) 会把内部匹配机制暴露给普通用户。派生规则冻结在 storage worker：可展示正文 → NFKC → casefold → 折叠连续空白为单个 U+0020 → 首尾去空白 → 按 code point 边界截到 ≤256 UTF-8 字节且不切断 surrogate pair。`semantic_key` **从 renderer 提交载荷中移除**，界面不回显该键，也不提供别名管理入口（别名登记是模块内部事实）。正文改写走 `manage` 的修改命令并在同一事务内重算键，键改变时按既有冲突 revision 规则收束。
- exact contract：[`agent-context-ui-contract.md`](agent-context-ui-contract.md) §5.1；`src/agent/contracts/agent-context-ui.js` 的 `assertStructuredEntry()`；`src/runtime/storage-worker/personal-context-store.js` 的 `normalizeSemanticKey()` / `exactEntry()` / `manageUpdate()`；`v1.1.0/negative-semantic-key-request.json`；`test/{contracts,storage}/` 对应回归。`v1.0.0/` 保持只读历史 fixture。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；须含「正文改写后同一条目不分裂」的正证据。

### AUI-CR-008 · 非全局范围在设置里没有可选的范围标识

- 处理值：contract-ready
- 提出面：settings
- 用户意图：我想记住「只在这个项目里生效」的偏好，而不是所有场合都生效。
- 需要的事实或动作：`scope.kind` 是四值闭集（`global` / `session` / `topic` / `project`），非 `global` 时需要 `scope.reference`。但 overview snapshot 与 `view` 投影都不提供一份可选的范围标识清单：条目上的 `scope.reference` 只能读，无法据此为一条新条目挑选范围。需要 Core 提供「当前可作为范围标识的有界闭集投影」（稳定 opaque 标识 + 可展示名称），或裁定设置界面只承载 `global`。
- 缺失时的 fail-closed 表现：设置界面的「记住」只构造 `global`（`scope.reference` 为 `null`），并明说这条在所有场合生效；不提供范围选择控件，也不把已有条目的 `scope.reference` 回填给新条目。
- 受影响语义/旅程：SEM-F30 / SEM-F32 / J21
- 建议的成功 fixture：一页可选范围标识（会话/主题/项目各一），含稳定标识与可展示名称；清单为空。
- 建议的失败 fixture：`scope.reference` 指向不存在的标识被拒零写入；`global` 携带非 `null` reference 被拒。
- Core 判断：**提供有界范围目录投影，且保留全部四个范围入口。** overview snapshot 增加一份有界范围目录（稳定 opaque 标识 + 可展示名称 + `kind`），`view` 与「记住」据此挑选范围。范围**只由摄取自动形成**（`personal_context_scopes.origin='automatic'`），首版不新增「创建范围」命令——SEM-F26 已规定「模型可提出主题/项目范围；名称不稳定时保留会话范围，范围合并必须由用户确认」，即范围本就是自动形成加用户确认的对象，不是用户从零创建的对象。`topic` / `project` 入口保留：清单为空时显示明确的空状态说明（例如「还没有可选的项目范围」），**不隐藏入口、不放置无法选出结果的下拉框**。同一份投影同时服务 Agent Bar 的范围选择，使「项目」这一范围在 Agent Bar 与设置页取得同一事实来源。
- exact contract：[`agent-context-ui-contract.md`](agent-context-ui-contract.md) §4.2/§5.1；overview `scope_directory={items,has_more}`，items ≤50 且每项 exact `{scope_id,display_name,kind}`；只投影 automatic active 的 session/topic/project，global 为固定入口；`v1.1.0/overview-scope-directory.json` / `overview-scope-empty.json`。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；须含空清单与非空清单两条正证据。

### AUI-CR-009 · `view` 的分页续读当前无法推进

- 处理值：contract-ready
- 提出面：settings
- 用户意图：我的记录超过一页时，我想接着往下看，而不是只被告知「还有更多」。
- 需要的事实或动作：`view` 请求含 `cursor` 与 `limit`，响应含 `next_cursor` 与 `has_more`；但把 `next_cursor` 回传并不会推进 —— S1 控制器在 `src/agent/personal-context/controller.js` 里按固定上界取一页快照，`view` 不消费 `cursor` 也不消费 `limit`，因此续读请求返回同一页。需要 Core 让 `view` 真正消费 opaque cursor 与 limit，或裁定 1.0.0 的分页字段在 S1 只作前向兼容占位。
- 缺失时的 fail-closed 表现：`has_more=true` 时只显示「还有更多记录未载入。」，不提供载入更多入口，也不用 `next_cursor` 发起第二次读取；界面不声明列表已完整。
- 受影响语义/旅程：SEM-F30 / J21
- 建议的成功 fixture：第一页 `has_more=true` + 携带其 `next_cursor` 的第二页返回不同条目；末页 `has_more=false`。
- 建议的失败 fixture：伪造或过期 cursor 被拒；`limit` 越界被拒。
- Core 判断：**采纳方案 (a)，`view` 必须真正消费 cursor 与 limit。** 方案 (b) 会让个人记忆超过 20 条后其余条目永久不可见，与 SEM-F30 对 `manage` 「查看」的承诺直接冲突。这是一处 Core 缺陷而非 renderer 缺陷：`src/agent/personal-context/controller.js` 的 `view()` 既不消费 `command.cursor` 也不消费 `command.limit`，快照固定以 `limit: 20, cursor: null` 取一页，`next_cursor` 恒为 `offset_${n}`。修复范围是 storage worker 的排序键 + 控制器 + renderer「载入更多」三处。**游标改为 keyset 而非 offset**：按 `(updated_at DESC, 稳定 ID)` 复合排序，游标是对最后一行该复合键的不透明编码，续读条件为严格小于该键；v7 追加对应索引（见 [`data-architecture.md`](data-architecture.md) §5）。offset 游标在并发写入下会跳行或重复，明确禁用。
- exact contract：[`agent-context-ui-contract.md`](agent-context-ui-contract.md) §5/§6.3；`speech-agent.personal-context.ui@1.1.0` 继续使用 `cursor/limit/next_cursor/has_more` 字段，Core 按 `(updated_at DESC, stable ID DESC)` 严格小于 cursor 复合键续读，拒绝 offset/伪造/跨 resource cursor；`v1.1.0/manage-view-page-1.json` / `manage-view-page-2.json`；`test/{main,storage}/personal-context-*.test.js`。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；须含「第二页返回不同条目」与「并发插入不跳行不重复」两条正证据。

下列十条由 2026-08-31 的 UX-2 交付（[`agent-ui-ux-handoff.md`](agent-ui-ux-handoff.md) §13，Agent Bar：范围、资格、运行与最小交互历史）提出。S3 的 `agent-run:*` exact contract 与 fixture 尚未签发，全部处理值为 `open`；不为 S4 的工具调用记录/多 attempt/预算执法登记请求。

### AUI-CR-010 · 四类范围的可选项与冻结身份投影

- 处理值：open
- 提出面：agent
- 用户意图：我想在 Agent Bar 里选一个终态会话、一段日期范围或一个项目，而不是只能选当前选区。
- 需要的事实或动作：`终态会话` 需要一份有界可选清单（稳定标识 + 可展示标签 + 终态时间）；`日期范围` 需要边界的产品化表达方式（相对偏移或用户可选的起止，不含绝对单调时刻）；`项目` 复用 `AUI-CR-008` 已裁定的 `scope_directory` 投影（`kind='project'` 子集），不新造第二套项目目录。
- 缺失时的 fail-closed 表现：只保留已有明确来源的范围入口（如当前选区），其余范围类型显示空状态说明，不提供无法选出结果的下拉框。
- 受影响语义/旅程：SEM-F28 / SEM-F31 / J22 / J24
- 建议的成功 fixture：终态会话清单含多条与空清单各一；日期范围最小/最大边界各一；项目目录复用 `AUI-CR-008` 的非空与空清单。
- 建议的失败 fixture：范围标识指向不存在的会话/项目被拒；日期范围起止颠倒被拒。
- Core 判断：待填写
- exact contract：待填写
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J22/J24 证据。

### AUI-CR-011 ·「当前选区」的跨窗口身份传递

- 处理值：open
- 提出面：agent
- 用户意图：我在字幕历史里选中一段文字后打开 Agent Bar，希望它已经知道我选的是什么，而不用再选一次。
- 需要的事实或动作：字幕历史窗与 `agent` 窗口是两个独立 BrowserWindow；需要 Core 说明"当前选区"这一冻结身份如何从字幕历史传到 Agent Bar（例如由 main 持有最近一次选区身份并通过 IPC 投影给 `agent` 角色），以及选区身份的有效期与失效条件（例如选区来源会话被删除后如何降级）。
- 缺失时的 fail-closed 表现：「当前选区」入口在 Agent Bar 内显示为不可选并说明"请先在字幕历史选择内容"；不用当前会话范围默默替代选区语义。
- 受影响语义/旅程：SEM-F31 / J22 / J24
- 建议的成功 fixture：选区已建立并有效；选区来源会话被删除后的失效态。
- 建议的失败 fixture：选区身份格式非法被拒；跨会话的陈旧选区身份被拒。
- Core 判断：待填写
- exact contract：待填写
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J22/J24 证据。

### AUI-CR-012 · 九值资格的原因与下一动作闭集

- 处理值：open
- 提出面：agent
- 用户意图：资格不是 `ready` 时，我想知道原因，并且如果有能做的事（比如去设置里配置模型），界面能直接带我过去。
- 需要的事实或动作：九值资格中除 `ready` 外的每一值，是否附带一个"下一动作"投影（例如目标表面标识：设置 · Agent 模型配置档案 / 设置 · 个人上下文 / 云端披露确认弹层），以及该动作是否需要额外参数。`cloud_disclosure_required` 尤其需要说明确认动作的 exact 命令与去向。
- 缺失时的 fail-closed 表现：只显示只读原因说明文案，不提供任何"前往设置"之类的跳转按钮，不猜测该资格是否可重试。
- 受影响语义/旅程：SEM-F28 / J22 / J24
- 建议的成功 fixture：九值资格各一条，其中至少一条附带下一动作、至少一条不附带。
- 建议的失败 fixture：未登记资格值；下一动作目标表面为未知枚举。
- Core 判断：待填写
- exact contract：待填写
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J22/J24 证据。

### AUI-CR-013 · run 生命周期状态闭集与取消转换

- 处理值：open
- 提出面：agent
- 用户意图：我提交一个请求后，想清楚地看到它是在排队、在运行、在取消中还是已经取消/完成，不想被误导成"已取消"却其实还在处理。
- 需要的事实或动作：run 的生命周期状态闭集（例如 `pending`/`cancelling`/`cancelled`/`succeeded`/`failed`）与其间的可观察转换事件；"取消请求中"到"取消终态"之间是否有中间信号，还是只能等待下一次 `changed`。
- 缺失时的 fail-closed 表现：取消后持续显示"正在取消"直到收到权威终态 `changed`，不提前渲染"已取消"。
- 受影响语义/旅程：SEM-F28 / J22 / J24
- 建议的成功 fixture：pending → cancelling → cancelled 的完整序列；pending → succeeded；pending → failed。
- 建议的失败 fixture：取消已终态的 run 被拒；未知生命周期值。
- Core 判断：待填写
- exact contract：待填写
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J22/J24 证据。

### AUI-CR-014 · 结果头部最小身份投影

- 处理值：open
- 提出面：agent
- 用户意图：看到一个结果时，我想知道它是针对什么范围、用了什么模型、花了多久、用了多少 token（如果知道的话）。
- 需要的事实或动作：结果头部 exact 投影，至少含范围可读标签、模型运行身份的可展示形式（不含 adapter/API key/凭据槽）、相对时长、可空 `ModelUsageV1`（用量来源恒为 `provider`，未知时整体 `null`）、可空缓存命中率。
- 缺失时的 fail-closed 表现：只显示最终结果正文，不显示任何身份或用量行，不用占位符（如"—"或"0"）冒充已知值。
- 受影响语义/旅程：SEM-F31 / SEM-F33 / J22 / J24 / J25
- 建议的成功 fixture：用量已知；用量未知；缓存命中率已知；缓存命中率未知。
- 建议的失败 fixture：`usage_json` 含 `estimated` 来源被拒；含金额字段被拒。
- Core 判断：待填写
- exact contract：待填写
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J22/J24 证据。

### AUI-CR-015 · 意图收敛结果的产品语言标签与改选

- 处理值：open
- 提出面：agent
- 用户意图：我提交一句话后，想知道系统把它理解成了"问答"还是"分析报告"之类，如果理解错了想换一种方式处理。
- 需要的事实或动作：十项面向用户 recipe（`intent.route` 除外）到产品语言标签的映射投影；改选动作的 exact 命令（"取消当前运行 + 新建运行"如何在 IPC 层表达，是否需要用户显式选择新标签，还是重新走一次收敛）。
- 缺失时的 fail-closed 表现：不呈现收敛结果标签、不提供改选入口，只呈现最终结果正文。
- 受影响语义/旅程：SEM-F28 / J22 / J24
- 建议的成功 fixture：十项标签各一条；改选后产生新 `runId` 的前后两条结果。
- 建议的失败 fixture：`recipeId` 落在闭集外（含 `intent.route` 自身）被拒进入用户可见投影。
- Core 判断：待填写
- exact contract：待填写
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J22/J24 证据。

### AUI-CR-016 · Agent Bar 最近交互的有界投影与续读

- 处理值：open
- 提出面：agent / history
- 用户意图：我想在 Agent Bar 里看到最近几次交互，但不需要在这里看完整历史——完整历史我会去字幕历史查。
- 需要的事实或动作：Agent Bar 侧"最近交互"是否是 `agent-run:get-history` 的一个小 `limit` 调用，还是独立投影；与字幕历史里完整交互历史列表的关系（同一份 keyset 分页数据的不同 `limit`，还是两个独立读取路径）；`intent.route` 排除规则是否在两处一致。
- 缺失时的 fail-closed 表现：不显示最近交互区，提供"查看完整历史"入口指向字幕历史窗。
- 受影响语义/旅程：SEM-F31 / J22 / J24
- 建议的成功 fixture：Agent Bar 小页与字幕历史大页取自同一 keyset 序列的一致性验证。
- 建议的失败 fixture：Agent Bar 侧误把 `intent.route` 计入列表。
- Core 判断：待填写
- exact contract：待填写
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J22/J24 证据。

### AUI-CR-017 · 反馈动作的 exact 命令与幂等

- 处理值：open
- 提出面：agent
- 用户意图：我想对一个结果说"记住这条"或"这不对"，并且重复点击不会重复生效。
- 需要的事实或动作：编辑/接受/拒绝/记住/忘记五个反馈动作各自的 exact 命令载荷、CommandResult 形状、幂等键规则；"记住"是否复用 `AUI-CR-006` 已裁定的设置内结构化「记住」输入形式，还是 Agent Bar 场景有专属的结果绑定字段（例如绑定 `interactionId` 而非自由结构化条目）。
- 缺失时的 fail-closed 表现：反馈入口整体缺席，不提供任何本地"已采纳"视觉标记（不得在未收到 CommandResult 前用本地状态渲染"已记住"）。
- 受影响语义/旅程：SEM-F32 / SEM-F30 / J22 / J24
- 建议的成功 fixture：五个动作各自的 pending → 成功回执；同一动作重复提交的幂等收束。
- 建议的失败 fixture：对已终态交互重复编辑被拒；revision conflict 零写入。
- Core 判断：待填写
- exact contract：待填写
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J22/J24 证据。

### AUI-CR-018 · 报告自动呈现偏好的读写投影与呈现回执

- 处理值：open
- 提出面：agent / settings
- 用户意图：我想在设置里开启"自动生成会后纪要"，并且在 Agent Bar 或非模态表面看到它，不想每次停止都被打断，也不想错过。
- 需要的事实或动作：偏好本身的读写命令（大概率属于既有设置角色而非 `agent` 角色，需要 Core 确认承载表面）；「每个满足资格的终态会话至多呈现一次」在 renderer 侧如何观察到（例如 `formal_agent_report_presentations` 的 `presented_at` 投影，见 openspec S3 spec）；reload/重复停止/重复通知的幂等呈现规则。
- 缺失时的 fail-closed 表现：偏好开关缺席，Agent Bar 不自动呈现任何报告；用户只能从最近交互/字幕历史主动查看。
- 受影响语义/旅程：SEM-F28 / SEM-F31 / J22 / J24
- 建议的成功 fixture：偏好开启后首次终态会话的非模态呈现；reload 后不重复呈现同一 run。
- 建议的失败 fixture：偏好关闭时任何自动呈现请求被拒。
- Core 判断：待填写
- exact contract：待填写
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J22/J24 证据。

### AUI-CR-019 ·`agent-run:changed` 的 revision 语义与未知值降级

- 处理值：open
- 提出面：agent
- 用户意图：Agent Bar 重新打开或联网抖动之后，我希望看到的是权威最新状态，而不是一个损坏或过期的画面。
- 需要的事实或动作：`agent-run:changed` 的单调 revision 定义域（是否与 `agent-context:changed`/`agent-model:changed` 各自独立计数，还是共享）；`agent-run:get-eligibility`/`get-history`/`get-interaction` 在收到更高 revision 后各自的重读范围；未知 `terminal_reason`、未知 `routing_mode` 标签、未知 contract 版本时的降级粒度（整表面只读，还是可局部降级）。
- 缺失时的 fail-closed 表现：整个 Agent Bar 进入只读不可用 + 通用说明 + 重试，不部分渲染已知字段。
- 受影响语义/旅程：SEM-T15 / J22 / J24
- 建议的成功 fixture：先订阅后读取的正常序列；旧 revision 事件被丢弃。
- 建议的失败 fixture：未知 contract 版本；额外未登记字段。
- Core 判断：待填写
- exact contract：待填写
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J22/J24 证据。

### AUI-CR-020 · 工具调用审计与预算收束投影

- 处理值：contract-ready
- 提出面：agent / history
- 用户意图：我查看一条正式 Agent 交互时，想确认它是否使用了受控只读工具、每次调用的结果或失败原因，以及预算是否导致交互收束；默认不想被大段审计正文打断。
- 需要的事实或动作：签发 `speech-agent.agent-tool-trace.ui@1.0.0` 的只读 `ToolTraceSnapshotV1`。其公开顶层恰含 `status`、`budgetState`、`attemptCount` 与按 `(attempt, callOrder)` 全序的 `toolCalls`；每一调用恰含工具名、状态、七值工具错误码（可空）、相对开始/结束时长、已校验的有界 `args/result`、`sourceRefs` 与 `{resultBytes, sourceTextBytes, sourceReferenceCount}`。`budgetState` 只允许 `within_budget/exhausted`，用以显示预算收束，不公开任何上限数值。调用正文必须由 renderer 默认折叠，并只在用户明确展开后显示。S4 contract 不向 renderer 公开 recipe ID、recipe 版本、`maxTurns`、`toolGrants`、`single_shot`、`agent_loop`、`execution_form`、`escalation_reason`、提示正文、内部思维过程、provider 原始事件、凭据或本地路径。
- 缺失时的 fail-closed 表现：交互详情省略工具审计区域；不得依据结果正文、等待时间或 DOM 状态猜测是否调用工具、是否超预算或是否已重试。
- 受影响语义/旅程：SEM-F28 / SEM-F31 / SEM-F34 / SEM-T10 / J22 / J24
- 建议的成功 fixture：一条 `search_context` 成功调用；一条 `read_sources` 成功调用；预算耗尽；两个 attempt 均保留且第二个 attempt 重新从 `callOrder=1` 开始；取消终态。所有正文使用合成内容并标记 preview-only。
- 建议的失败 fixture：`TOOL_ARGS_INVALID`、`TOOL_SCOPE_DENIED`、`TOOL_NOT_AVAILABLE_FOR_RECIPE`、`TOOL_TIMEOUT`、未知工具名、未知状态或未知 contract 版本；后三类必须使整个详情只读不可用，不局部猜测渲染。
- Core 判断：S4 仅提供纯 validator 与 preview fixture；tool adapter、IPC、preload、正式 renderer、storage 读取和用户展开动作全部留在 S5-Integration。`TOOL_BUDGET_EXCEEDED` 或 `TOOL_TIMEOUT` 的 trace 可见，但其外层预算收束只投影为 `budgetState='exhausted'`，不把任务错误码混入工具错误码。
- exact contract：`src/agent/contracts/agent-tool-trace-ui.js`、`src/agent/contracts/controlled-tools.js` 与 `src/agent/contracts/fixtures/agent-tool-trace-ui/`；所有 fixture 固定 `preview_only=true`、`j22_evidence=false`、`j24_evidence=false`。
- S5-Integration 证据：待真实 Agent Bar → preload/exact IPC → S3/S4 Core → v7 interaction store → renderer reload 组成 J22/J24；fixture 不构成 J22/J24 证据。

## 5. 关闭检查

一条请求进入 `consumed` 或在 S5-Integration 中收束前，逐项核对：

- 字段和动作存在唯一 Core 定义点，renderer 没有同义枚举或错误判断。
- access policy、preload、payload exact 校验和 observer revision 已同步。
- 成功、缺失、revision conflict、取消、失败和 renderer reload 至少各有适用 fixture。
- UI 的下一动作来自 Core 投影，不从异常字符串、等待时长、DOM 顺序或 ID 猜测。
- fixture 不被计入 J21/J22/J24/J25/J26 证据。
- 对应确定性联合旅程使用真实内部模块，只替代已登记外部边界。
