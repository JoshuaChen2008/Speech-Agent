# 正式 Agent UI/UX 交接

> 状态：已决定 · 2026-08-29
>
> 面向对象：负责正式 Agent 产品 UI/UX 设计或 renderer 实现的模型。
>
> 历史替代：本文整体替代 2026-08-09 的同名 handoff。旧版描述的是隔离 Agent 内核开发入口、旧三任务设计、调试聊天与单一 provider 方案，只保留在 Git 历史中，不再是可执行交接。
>
> 权威顺序：[`semantic-contract.md`](semantic-contract.md) → ADR 0013–0015 → [`agent-redesign-execution-plan.md`](agent-redesign-execution-plan.md) → [`testing-strategy.md`](testing-strategy.md) → 本文。
>
> 本文把已决定的产品语义转成设计任务、所有权和交付门，不重新定义 Agent 行为。

## 1. 接手时先选工作类型

每次接手先声明以下一种类型：

| 类型 | 本轮可以交付 | 本轮不构成 |
|---|---|---|
| `UX design` | 用户流程、信息架构、线框、状态矩阵、文案、可访问性说明、contract requests | renderer 实现或用户旅程证据 |
| `Renderer implementation` | 基于冻结 contract/fixture 的 DOM、CSS、view-model 和局部渲染回归 | main/preload/SQLite 实现或确定性联合旅程 |
| `S5 integration support` | 针对真实产品汇合暴露的 UI 缺口修正 | Core owner 的窗口、IPC、存储、导出与安全职责 |

作出类型声明后，按以下顺序读取：

1. `CONTEXT.md` 全文，统一使用 Agent Bar、正式 Agent 交互、个人上下文包、工具调用记录、模型运行绑定等规范术语。
2. `semantic-contract.md` 的 SEM-F00/F15/F26/F28/F30–F35/T15。
3. `testing-strategy.md` 的 J21/J22/J24/J25/J26 及其 S1/S2/S5 子边界说明。
4. `agent-redesign-execution-plan.md` 的 §1、§2.1–2.2、S1–S5 与 §5。
5. 本文；需要新事实或动作时再读 [`agent-ui-contract-requests.md`](agent-ui-contract-requests.md)。
6. 只有修改共享视觉语言、设置、历史或窗口布局时，才继续读 [`ui-design-brief.md`](ui-design-brief.md) 的相关章节。

读取到此即可开始正式 Agent UI 工作；不需要阅读音频、ASR、SQLite schema 或旧 Agent 实现。

## 2. 唯一目标：正式 Agent 产品 UI

正式产品由三个用户表面协作：

```text
设置
├─ 个人上下文管理
└─ Agent 模型配置档案与四个模型用途

Agent Bar（新 agent 窗口）
├─ 选择当前选区 / 终态会话 / 日期范围 / 项目
├─ 输入一次自然语言意图
├─ 查看资格、运行、取消和结果
└─ 对结果编辑 / 接受 / 拒绝 / 记住 / 忘记

字幕历史
├─ 正式 Agent 交互列表与终态详情
├─ 默认折叠的完整工具调用记录
└─ 单交互 JSON 导出
```

`src/agent-mvp/**` 是隔离 Agent 内核开发入口，只保留 J23 的历史资格和手动启动能力。正式 UI 使用新 `agent` 窗口、新 preload、新 IPC 与新 `src/agent/**` 深模块；设计与 renderer 实现都不复用、改造或包装 `src/agent-mvp/**`。

旧 handoff 中以下方向已经失效：

| 2026-08-09 旧方向 | 当前正式方向 |
|---|---|
| 三项会后自动任务 | 默认零报告；终态会话默认只做个人上下文摄取 |
| 调试聊天作为正式页面候选 | Agent Bar 是正式入口；调试聊天不进入正式导航 |
| 单一 DeepSeek/provider 配置 | 多个 OpenAI-compatible 模型配置档案，DeepSeek 只提供空 model provider 模板 |
| provider + model 的单选择 | 默认、信息提取、摘要与总结、分析与规划四个模型用途 |
| 旧 `agent_jobs/agent_artifacts/memory_*` | 新 `formal_agent_runs/formal_agent_interactions/personal_context_*` |
| 参考结构化产物 | 问答、分析报告、规划建议、增强文本等固定 recipe 结果 |
| 开发入口 renderer | 新的正式 `agent` renderer + 设置/历史扩展 |

## 3. 工作流：Core 与 UI/UX 两条线

UI/UX 可与 S1–S4 并行进行流程设计，但生产 renderer 只消费对应 Core 切片签发的 contract 与 fixture：

| Core 切片 | UI/UX 可并行设计 | 进入 renderer 实现的条件 |
|---|---|---|
| S1 个人上下文 | 查看、修改、删除、休眠、记住、忘记；会话经历记录与个人记忆分层 | overview/manage exact contract、revision 与 fixture 冻结 |
| S2 模型接入 | 配置档案、模型清单、凭据 scope、四用途与回落、目录建议 | catalog/configure/pull/changed contract 与 fixture 冻结 |
| S3 单轮运行 | 范围选择、资格、提交、pending、取消、结果、最小历史与反馈 | run snapshot/command/error/interaction fixture 冻结 |
| S4 Agent Loop | 工具记录、多个 attempt、预算耗尽、工具失败和取消终态 | tool trace、预算与执行形态 fixture 冻结 |
| S5-Core | 窗口、preload、IPC、导出 | Core owner 签发正式 API；UI 不修改这些层 |
| S5-Integration | 真实模块汇合 | 预览 adapter 被真实 preload 替换并进入 J21/J22/J24/J25/J26 |

fixture preview 只证明设计覆盖与渲染行为。它不证明模型、SQLite、preload、保存对话框或用户旅程成立，也不提升任何 J 旅程状态。

## 4. 文件所有权

### 4.1 UI/UX 默认拥有

正式 renderer 根在实现前由 Core owner登记；建议使用与 `settings/history` 并列、且不与深模块 `src/agent/**` 混淆的 `src/agent-window/**`。路径冻结后，UI/UX 可修改：

- 正式 `agent` renderer 的 HTML/TSX、CSS、纯 view-model、ARIA 与纯展示 helpers。
- `src/settings/` 中个人上下文与 Agent 模型配置档案的 view/样式。
- `src/history/` 中正式 Agent 交互历史、工具调用记录与导出提示的 view/样式。
- 与本轮设计直接相关的 fixture preview 页面。
- 本文中的设计交接结果和 [`agent-ui-contract-requests.md`](agent-ui-contract-requests.md) 新请求。

### 4.2 共同评审

- `src/ui/shared/tokens.css`：会影响字幕、工具条、设置、历史与正式 Agent 五个 renderer。
- renderer-facing view-model：Core 拥有事实与枚举，UI/UX 审查信息是否足够表达。
- BrowserWindow 尺寸、最小尺寸、标题栏和断点：Core 拥有窗口合同，UI/UX提供布局依据。
- 设置与历史的信息架构改动：不得遮蔽既有字幕、精修与模型资源路径。
- 新按钮、动作、错误或下一步：先登记 contract request。

### 4.3 Core 独占

- `src/agent/**` 的 personal-context、model-access、execution-host 与 contracts。
- `src/main.js`、`src/main/**`、窗口生命周期、角色、sender policy 与 IPC handler。
- `src/preload/**`、payload exact 校验、凭据、`safeStorage` 和网络调用。
- `src/runtime/**`、storage worker、SQLite、migration、调度、预算和导出 writer。
- Electron 打包、安全选项、旧四棵 Agent 树与 `src/agent-mvp/**`。

当设计依赖 Core 独占层尚未提供的事实时，保持入口显式不可用并登记请求；renderer 不建立临时 IPC、文件读取、网络、SQLite 或 Node/Electron 旁路。

## 5. 产品表面与状态要求

### 5.1 设置：个人上下文

必须区分两类事实：

- 会话经历记录：回答某段时间、会话或项目发生了什么。
- 个人记忆：带来源、revision 与生命周期的长期上下文。

用户动作闭集为查看、修改、删除、休眠、记住、忘记。写动作等待 CommandResult 后再呈现新状态；revision conflict 保留当前编辑并提供重新载入权威值的路径。删除与忘记必须表达动作对象，不能用一个含糊的“清除记忆”覆盖不同语义。

个人上下文界面不展示 SQLite、完整个人记忆表、自由查询、模糊搜索、模型内部置信推理或无来源用户画像。普通点击、停留、滚动、浏览、焦点和复制不出现“已学习”反馈。

### 5.2 设置：Agent 模型配置档案

一个配置档案是一个受信任连接、一份独立凭据和一组 model。设置界面使用产品语言展示：

- 配置档案与模型列表。
- 凭据存在性布尔与 Core 签发的 scope 枚举；至少覆盖 `safeStorage` 不可用时的 `session_only` 及重启后 `absent`。
- 默认、信息提取、摘要与总结、分析与规划四个模型用途。
- 专用用途是单独配置，还是明确回落到默认。
- 用户触发的远端目录建议及失败零写入结果。
- 首次初始化的 `deepseek-openai-template@1` 只展示官方 API base URL 和非权威能力建议；model ID、两个 exact token 上限、全部六字段确认、用途和凭据都必须由用户明确提交。显式删除模板后不出现自动重建提示。

界面不展示 recipe ID、adapter、factory、header、凭据槽 ID、金额字段或 IPC channel。既有凭据不回显；用户只能提交新凭据或清除凭据。能力不匹配呈现为配置问题，不包装成瞬时 provider 故障。

### 5.3 Agent Bar

Agent Bar 是紧凑的正式入口，不是通用聊天首页或任务面板。主流程固定为：

1. 选择当前选区、终态会话、日期范围或项目。
2. 查看 Core 返回的 Agent 处理资格；非 `ready` 时呈现对应原因与下一动作。
3. 输入一次自然语言意图并提交。
4. 运行中可请求取消；取消进入终态收束，不立即伪造“已取消”。
5. 呈现最终结果、范围和模型身份；需要时展示 input/output token、用量来源、缓存命中率与相对时长，不展示金额。
6. 用户可明确编辑、接受、拒绝、记住或忘记；这些动作等待回执。

普通单轮请求与 Agent Loop 使用同一产品语言。UI 可以展示“分析了多个来源”“使用了只读工具”与升级理由的产品投影，但不展示内部 recipe ID、轮次调试台、中间 assistant 文本、隐藏提示、reasoning 或内部思维过程。

### 5.4 交互历史、工具调用记录与导出

终态正式 Agent 交互历史只展示时间戳、范围与模型身份、最终结果和工具调用记录。工具调用记录按 `(attempt, call_order)` 全序，默认折叠，用户明确展开后显示 Core 已校验且受预算约束的完整结构化参数与结果；重试后的旧 attempt 继续可见。

即时问答进入最小历史，但不自动成为报告。用户主动请求的分析报告默认版本化保存。报告历史没有已读状态、标记、角标、红点或计数。

终态详情提供单交互 JSON 导出。动作旁直接提示“导出包含完整工具输入与结果”；不再增加模态确认。被取消且已经收束的交互同样允许导出，最终结果可以为空，已发生的工具记录保留。

### 5.5 报告自动呈现偏好

报告自动呈现偏好默认关闭。关闭时，终态会话不自动创建或呈现会后结构化纪要；开启只影响未来满足资格的终态会话，每个 run 至多非模态呈现一次。关闭偏好不删除旧报告。

呈现表面不使用系统通知、模态框、声音、抢焦点或未读标记。renderer reload、重复停止与重复通知只恢复同一权威 run，不生成第二份界面事实。

## 6. 必须覆盖的状态矩阵

### 6.1 Agent 处理资格

九值由 Core 按固定顺序计算，UI 只翻译原因与下一动作：

- `ready`
- `no_committed_transcript`
- `outside_automatic_window`
- `agent_disabled`
- `provider_not_configured`
- `cloud_disclosure_required`
- `credential_unavailable`
- `local_model_not_ready`
- `session_not_terminal`

未知值 fail closed：入口不可提交，保留范围和用户输入，并显示通用不可运行说明；不猜测可重试性。

### 6.2 配置与命令

- 初始读取、model-access unavailable、空档案、DeepSeek 空 model provider 模板、当前 alias 瞬时建议与两个 token 上限未知。
- 两个以上配置档案与不同用途绑定。
- 专用用途回落默认。
- 凭据不存在、`session_only` 及 Core 签发的持久作用域；重启后 `session_only` 明确回落 `absent`。
- pending、成功回执、revision conflict、输入无效，以及 `success/revision_conflict/invalid_request/credential_unavailable/redirect_rejected/remote_unavailable` 六值目录拉取结果。
- renderer reload 后由单调 revision 恢复。

### 6.3 正式 Agent 交互

- 空范围、有效范围、范围含省略标记。
- single-shot pending、终态成功、终态失败、取消请求中、取消终态。
- Agent Loop、多 attempt、工具成功、工具失败、预算耗尽。
- provider 超时/限流/断网、鉴权失败、worker 退出和输出 Schema 失败。
- 结果为空、用量来源为 provider 或 estimated、缓存命中已知或未知，且不存在金额字段。
- reload、重复通知和迟到结果。

### 6.4 历史与导出

- 零工具调用与多 attempt 工具调用。
- 工具记录折叠/展开不改变导出内容。
- 成功终态与取消终态。
- 保存对话框取消、目标存在、写入失败和确定性重导出。
- 交互被删除、交互不存在、非终态和 digest/Schema 校验失败。

每组同时覆盖深色、浅色、Windows 系统高对比、键盘 focus、屏幕阅读器名称与 reduced motion。状态含义使用文字和形状作为主通道，颜色作为冗余通道。

## 7. Contract 与 fixture 规则

Core contract 是 renderer 的唯一事实源：

- 初始加载采用“先订阅、再读取 snapshot、按 revision 拒绝旧值”的恢复方式。
- model catalog 读取使用 `{ok,snapshot,error}` envelope；`MODEL_ACCESS_UNAVAILABLE` 只表示 Core 初始化降级，不得伪装为空配置或 `provider_not_configured`。
- 用户动作先进入 pending；只有 CommandResult 或后续权威 snapshot 才能呈现成功。
- 错误码、可重试性、下一动作、范围、省略标记、模型身份和终态理由均由 Core 提供。
- renderer 不从等待时长、异常字符串、ID 格式、DOM 顺序或缺少字段推断状态。
- fixture 与生产 snapshot 使用同一个 exact validator；设计 fixture 只能填合成内容。

需要新事实或动作时，按 [`agent-ui-contract-requests.md`](agent-ui-contract-requests.md) 登记。若请求改变用户能力、默认值、状态闭集、数据保留或失败语义，先更新语义合同与旅程矩阵；UI/UX 模型不在 renderer 中试行新语义。

## 8. 视觉与交互基线

- 正式 Agent 与现有 Win11 字幕产品共享 `Segoe UI Variable`、语义 token 和 Fluent System Icons，不另建 Agent 专属发光、渐变或玻璃体系。
- 使用中性窗口表面、清晰层级、克制阴影和有限动效；持续运行不使用无限“智能”动画。
- Agent Bar 可聚焦、不穿透、非模态；窗口几何和前台层级由 Core 管理。
- 资格不足或能力缺失时给出明确原因与下一动作；没有下一动作时给出可理解的只读说明。
- 报告、个人记忆、会话经历记录、权威原始转写与精修稿保持可辨层级，不通过视觉暗示派生文本更权威。
- API key、受信任 origin 的内部校验细节、凭据槽、IPC channel、本地路径和 provider 原始事件不进入 UI。

## 9. 每次交付的检查条件

### UX design

- 标明覆盖的设置、Agent Bar 或历史表面。
- 给出端到端用户流程和第 6 节适用状态矩阵。
- 每个展示事实映射到已决定 Core seam或一个 `AUI-CR-*`。
- 给出深浅色、高对比、键盘、屏幕阅读器与 reduced motion 说明。
- 明确哪些画面是 fixture preview，不将其描述为产品实现证据。

### Renderer implementation

- 只修改获批 renderer、样式、纯 view-model 与 fixture preview 路径。
- 列出消费的 exact contract 与 fixture。
- 未知状态和缺失字段 fail closed；没有乐观成功状态。
- 不接 `src/agent-mvp/**`，不新增 IPC、文件、网络、SQLite 或 Electron 旁路。
- 局部构建与适用 core/integration lane 结果使用规范状态词报告；局部回归不提升 J 旅程。

### S5 integration support

- 预览 adapter 已由 Core owner 替换为真实 preload。
- UI 成功/失败/下一动作均可追溯到真实 snapshot 或 CommandResult。
- reload、取消、重复通知、迟到结果和隐私负路径可观察。
- J21/J22/J24/J25/J26 的证据由真实内部模块组成；fixture preview 不被计入。

## 10. 可直接交给下一模型的起始指令

> 你处理的是新的正式 Agent 产品 UI，不是 `src/agent-mvp/**` 隔离 Agent 内核开发入口。先按 `docs/agent-ui-ux-handoff.md` §1 读取所需材料，并声明本轮是 `UX design`、`Renderer implementation` 或 `S5 integration support`。只消费 Core 签发的 exact contract 与 fixture；缺少事实或动作时在 `docs/agent-ui-contract-requests.md` 登记一条请求。设计必须覆盖适用的资格、配置、运行、取消、失败、reload、历史与导出状态，以及深色、浅色、高对比、键盘和 reduced motion。任何设计预览都明确标记为 fixture preview，不把它称为 J21/J22/J24/J25/J26 证据。

## 11. UX-1 交付 · 设置：个人上下文管理（S1 / J21）

> 交付类型：`UX design` · 2026-08-29 · 覆盖表面只有 §5.1「设置：个人上下文」。
>
> 本节是流程、信息架构、状态矩阵、文案与可访问性说明，**不构成** renderer 实现、fixture preview 或任何 J 旅程证据；本轮未改动任何 `src/**` 文件，也未产生预览页面。J21 状态不因本节变化。
>
> 不覆盖：Agent 模型配置档案（S2）、Agent Bar（S3/S4）、交互历史与导出（S5）。

### 11.1 信息架构

设置窗新增一个类别，插在「模型资源」之后、「关于」之前，命名为「个人上下文」。既有「显示与字幕 / 音频源 / 语音识别 / 模型资源」四项的位置、路径与文案不变——新增类别不得遮蔽既有字幕、精修与模型资源入口（§4.2）。S2 的 Agent 模型配置档案是另一个并列类别，本轮不预留占位控件。

```text
设置 › 个人上下文
├─ 处理状态区
│  ├─ 个人记忆处理开关（休眠 / 处理中）
│  └─ 个人记忆自动处理边界说明（关闭不补处理、重新开启建立新边界）
├─ 事实分区切换（单选，二者不混列）
│  ├─ 会话经历记录 —— 某段时间、会话或项目发生了什么
│  └─ 个人记忆 —— 带来源引用、revision 与生命周期的长期上下文
├─ 会话经历记录列表 → 单条详情
│  └─ 来源范围（会话 / 正式 Agent 交互）· 发生时间范围 · 有界结构化轨迹 · 来源引用 · 省略标记
└─ 个人记忆列表 → 单条详情
   └─ 范围（全局 / 会话 / 主题 / 项目）· 类型（决定 / 结论 / 待办 / 术语 / 偏好 / 项目事实 / 经验）
   └─ 来源（明确内容 / 自动推断）· 生命周期 · 来源引用 · 更新时间
   └─ 动作：修改 · 忘记 · 删除
```

三条信息架构裁决：

1. **两类事实不合并成一个列表。** 会话经历记录按来源范围回答时间线，个人记忆只保留可跨任务复用的原子事实；用同一个分区切换在两者之间移动，任何一个列表里都不出现另一类行。
2. **没有搜索框。** 个人上下文只做 NFKC + casefold 后全等的结构化键与已登记别名匹配，界面不提供自由文本框、模糊搜索或排序自定义。`1.0.0` 的 `view` 也不提供筛选字段；UI 不得把本地筛选伪装成 Core 完整结果。
3. **S1 不展示置信与显著性档位。** S1 的个人记忆只能由用户经 `manage` 的「记住」/修改产生，档位对用户不携带可操作信息；展示它会落进 §5.1 禁止的「模型内部置信推理」。展示 `origin` 的明确/自动之分即可。

界面同样不展示：SQLite、完整个人记忆表、条目 ID 与 revision ID 原值、来源 digest、IPC channel、本地路径、无来源用户画像。

### 11.2 端到端流程

| # | 流程 | 步骤 |
|---|---|---|
| F0 | 载入与恢复 | 类别激活 → 先订阅 `agent-context:changed` → 再读 overview snapshot → 记住 revision。此后只接受更高 revision，较旧值直接丢弃。订阅失败或 snapshot 字段缺失 → 整个类别进入只读不可用，不猜测原因。 |
| F1 | 查看会话经历记录 | 选「会话经历记录」→ 有界列表按发生时间范围倒序 → 展开单条 → 有界结构化轨迹、来源引用与省略标记。列表与详情都不复制整场正文。 |
| F2 | 查看个人记忆 | 选「个人记忆」→ 有界列表 → 展开单条 → 正文、来源引用、范围、类型、来源、生命周期与三个动作。 |
| F3 | 修改 | 编辑正文 → 保存 → 控件进入 pending 且保留用户输入 → 只有 CommandResult 或后续更高 revision 的权威 snapshot 才呈现新值。revision conflict → 保留用户编辑、明示未写入、提供「重新载入权威值」。 |
| F4 | 忘记 | 明确点击 → 确认层说明作用对象（条目退出检索，条目/revision/来源引用与会话经历记录保留，自动摄取不得恢复）→ pending → 回执 → 列表按权威 snapshot 更新；只有用户后续明确记住或修改才可恢复。 |
| F5 | 删除 | 明确点击 → 确认层说明作用对象（正文、revision 与来源引用被移除；相同旧来源不再重新生成同一条目；新的会话来源仍可能重新提出）→ pending → 回执 → 条目从列表消失。 |
| F5r | 删除重放 | reload 后重复触发同一删除、或迟到回执抵达 → 呈现首次删除的同一组计数，不呈现第二次删除，不呈现被删除正文。 |
| F6 | 休眠与重新开启 | 切换开关 → 确认层说明关闭期间不摄取、`resolve` 返回带稳定原因的零条目休眠上下文包、既有条目不被批量改写、重新开启建立新的个人记忆自动处理边界且不补处理关闭期间或更早的会话 → pending → 回执。 |
| F7 | 记住 | 设置与字幕历史可提供「记住」入口；表单只提交已冻结的 `display_text`、七值 `kind`、四值 `scope` 与 NFKC + casefold `semantic_key`。不得提交自由文本命令、任意对象或数据库行。`kind=term` 仍不是 J20 确认关键词，不影响识别 provider。 |
| F8 | 会话删除级联 | 用户在字幕历史删除会话 → `agent-context:changed` 携带更高 revision → 本类别按新 snapshot 重取：该会话的经历记录消失，仅由该会话支持的条目退出检索。界面不自行推断级联结果。 |

流程不变量：写动作一律先 pending 再回执，没有乐观成功态；错误码、可重试性与下一动作全部取自 Core；界面不从等待时长、异常字符串、ID 形态、DOM 顺序或缺字段推断状态。

### 11.3 状态矩阵

**A 载入与恢复**

| 状态 | 表现 |
|---|---|
| 首次读取中 | 骨架占位 + 「正在读取个人上下文」，无动作控件可用 |
| 读取成功 | 列表可用；处理状态区显示当前档位 |
| 订阅成功但 snapshot 未到 | 保持读取中；不显示空状态 |
| 迟到的较旧 revision | 静默丢弃，界面不闪回 |
| renderer reload | 重走「订阅 → snapshot → revision」；不恢复任何本地缓存的成功态 |
| 订阅或读取失败 | 整个类别只读不可用 + 通用说明 + 「重试」；不猜测具体原因 |
| snapshot 含未知字段或枚举值 | `1.0.0` exact validator 拒绝整个载荷；本类别进入只读不可用并可重试，不从部分字段继续渲染 |

**B 列表内容**

| 状态 | 表现 |
|---|---|
| 会话经历记录为空 | 空状态说明「还没有会话经历记录」+ 形成条件说明 |
| 个人记忆为空 | 空状态说明「还没有个人记忆」+ 说明 S1 只有用户明确记住或修改才会形成 |
| 单条经历记录含省略标记 | 详情内显式标注 `not_committed_tail` 的产品说法（未提交尾部未纳入），不静默省略 |
| 列表触达上界 | 显示「还有更多」并提供继续读取，不伪造完整总数 |
| 条目已退出检索 | 生命周期以文字标注，条目仍可见，不改写来源历史 |

**C 写动作**

| 状态 | 表现 |
|---|---|
| pending | 触发控件禁用 + `aria-busy`，用户输入完整保留，其它行不禁用 |
| 成功回执 | 状态区一条 `role="status"` 文本 + 列表按权威 snapshot 更新 |
| revision conflict | 行内 `role="alert"`：当前值已在别处更新、本次未写入、保留你的编辑、可重新载入权威值 |
| 输入无效 | 行内说明具体字段问题，零写入，保留输入 |
| 载荷被拒（角色或额外键） | 通用「本次操作未被接受」+ 无敏感细节；不暴露 channel 或校验内部 |
| 回执迟到 | 只按 revision 收束，不出现两条成功提示 |

**D 删除与忘记**

| 状态 | 表现 |
|---|---|
| 确认层 | 必须写出作用对象；不使用「清除记忆」这类含糊说法 |
| 删除成功 | 回执按条目、revision 与来源引用报告计数 |
| 同一删除重放 | 呈现首次的同一组计数，不呈现第二次删除，不回显被删除正文 |
| 忘记成功 | 条目留在列表并标注已退出检索；条目 revision 推进，来源引用与经历记录不变；不显示删除计数 |
| 会话删除级联 | 只按新 snapshot 更新；不在本类别提供删除会话的入口 |

**E 处理状态与休眠**

| 状态 | 表现 |
|---|---|
| 处理中 | 说明终态会话会形成有界经历记录 |
| 休眠 | 说明不再摄取、Agent 取不到个人记忆、既有条目保留 |
| 切换 pending | 开关禁用 + `aria-busy`；不提前翻转视觉状态 |
| 重新开启后 | 说明新的自动处理边界已建立，关闭期间与更早的会话不会补处理 |
| 边界事实缺失 | exact validator 拒绝整个载荷，本类别进入只读不可用；不从当前档位推断边界时间 |

### 11.4 文案

规范术语固定为：个人上下文、会话经历记录、个人记忆、来源引用、生命周期、个人记忆自动处理边界。禁止「清除记忆」「AI 记忆」「学习了」「智能整理」这类说法。普通点击、停留、滚动、浏览、焦点与复制**不产生任何**「已学习」「已记录」反馈。

| 位置 | 文案 |
|---|---|
| 类别标题 | 个人上下文 |
| 类别副标题 | 管理会话经历记录与个人记忆；它们只在你明确操作时改变。 |
| 分区切换 | 会话经历记录 / 个人记忆 |
| 会话经历记录说明 | 按会话或正式 Agent 交互记录发生了什么，只保留有界轨迹与来源引用，不复制字幕正文。 |
| 个人记忆说明 | 可跨任务复用的原子事实，带来源引用、修改历史与生命周期。 |
| 经历记录空态 | 还没有会话经历记录。终态会话完成摄取后会在这里出现一条有界记录。 |
| 个人记忆空态 | 还没有个人记忆。只有你明确记住或修改的内容会成为个人记忆。 |
| 省略标记 | 本条未包含该会话尚未提交的尾部内容。 |
| 上界提示 | 还有更多记录未载入。 |
| 修改保存 | 保存修改 |
| 记住动作 | 记住这条个人记忆 |
| pending | 正在提交，请稍候。 |
| 成功 | 修改已保存。 |
| revision conflict | 这条个人记忆已在别处更新，本次修改未写入。你的编辑仍保留，可重新载入权威值后再提交。 |
| 重载动作 | 重新载入权威值 |
| 忘记动作 | 停用这条个人记忆 |
| 忘记确认 | 停用后这条个人记忆不再被检索，它的修改历史、来源引用和会话经历记录都保留。只有你以后明确记住或修改它才会恢复。 |
| 删除动作 | 删除这条个人记忆 |
| 删除确认 | 删除会移除这条个人记忆的正文、修改历史与来源引用。同一份旧来源不会再重新生成它；将来新的会话来源仍可能重新提出同样的内容。 |
| 删除重放 | 这条个人记忆已删除，本次没有产生新的删除。 |
| 处理开关标签 | 处理个人记忆 |
| 休眠说明 | 已休眠：不再摄取新的个人上下文，Agent 也取不到个人记忆；已有内容保留在这里。 |
| 重新开启说明 | 已重新开启：从现在起的终态会话会被摄取。休眠期间以及更早的会话不会补处理。 |
| 通用不可用 | 个人上下文暂时不可用。 |
| 未知值降级 | 这条记录包含当前版本无法解释的内容，暂不提供操作。 |

「停用这条个人记忆」与「删除这条个人记忆」是两个不同动作：前者保留事实链但退出检索，后者执行 suppression 后物理移除。文案与交互必须继续保持二者可区分，不使用「清除记忆」统称。

### 11.5 可访问性与视觉

跨全部五组状态一并成立：

- **主通道是文字与形状，颜色只作冗余通道。** 生命周期、来源（明确/自动）、休眠与省略标记都先有文字标签，再叠图标形状；把颜色全部去掉后所有状态仍可区分。不使用红点、角标、未读计数。
- **深色与浅色**在 `src/ui/shared/tokens.css` 的语义层切换，组件样式里不出现 `[data-theme]` 分支。不新建 Agent 专属发光、渐变或玻璃表面；标题栏沿用 `48px` 与 `--surface-window-titlebar` 加 `1px` 底部分隔线。
- **Windows 系统高对比**由 `forced-colors` 基线接管颜色；界面在颜色被接管后不丢失任何状态区分，因为区分不依赖颜色。
- **键盘 focus**：类别导航、分区切换、列表行、展开/折叠、三个动作与确认层全部可达；分区切换是 `radiogroup`，列表展开用 `aria-expanded`；确认层获得焦点并可 `Esc` 取消，关闭后焦点回到触发控件。禁用控件保留可及名称与禁用理由。
- **屏幕阅读器名称**：列表行的可及名称包含范围、类型与来源，不只读正文首行；pending 用 `aria-busy`；成功用 `role="status"` 的 `aria-live="polite"`；冲突与失败用 `role="alert"`。删除与忘记的可及名称写出作用对象，不是裸「删除」。
- **reduced motion**：只有 pending 存在过渡指示，且在 `prefers-reduced-motion` 下降级为静态文字；没有任何持续「智能」动画。
- **隐私**：API key、凭据槽、受信任 origin 校验细节、IPC channel、本地绝对路径、设备名、provider 原始事件、音频与音频路径都不进入本界面，也不进入其可及名称。

### 11.6 展示事实映射

| 展示事实 | 来源 |
|---|---|
| 区分会话经历记录与个人记忆两类事实 | 已决定 · 本文 §5.1；`data-architecture.md` 的 `personal_context_episodes` 与 `personal_context_items` |
| 动作闭集：查看、修改、删除、休眠、记住、忘记 | 已决定 · `agent-ui-contract-requests.md` §2 的 S1 行；S1 `personal-context-core` spec |
| 写动作携带 `expectedRevision`，冲突零写入且投影不变 | 已决定 · S1 spec |
| 按更高 revision 恢复、拒绝旧值 | 已决定 · seam 3 的 `agent-context:changed`；本文 §7 |
| 删除先写不含正文的抑制、再物理移除；同 key 重放只重放计数 | 已决定 · S1 spec；`personal_context_deletion_receipts` |
| 会话删除级联经历记录与来源引用 | 已决定 · S1 spec |
| 无自由查询、无模糊搜索（等值匹配） | 已决定 · S1 spec；`data-architecture.md` §160 |
| 范围四值、类型七值、来源明确/自动、生命周期 | 已决定 · `data-architecture.md` §5 |
| 休眠时 `resolve` 返回零条目休眠上下文包；重新开启不补处理 | 已决定 · `data-architecture.md` §161 |
| S1 至多形成一条有界经历记录；只有用户明确操作形成个人记忆 | 已决定 · S1 `design.md` 裁决 6 |
| 只允许 `settings` / `history` 角色与 exact 载荷 | 已决定 · S1 spec；seam 3 |
| `48px` 标题栏、`--surface-window-titlebar`、token 层主题切换 | 已决定 · `ui-design-brief.md` §2.3、§4.3 |
| 个人记忆列表的有界分页、Core-owned 稳定排序与「还有更多」 | 已决定 · `speech-agent.personal-context.ui@1.0.0`；`AUI-CR-001` contract-ready |
| 会话经历记录的有界列表、发生时间范围与省略标记投影 | 已决定 · `speech-agent.personal-context.ui@1.0.0`；`AUI-CR-002` contract-ready |
| 休眠档位与自动处理边界的可读状态 | 已决定 · `speech-agent.personal-context.ui@1.0.0`；`AUI-CR-003` contract-ready |
| 「忘记」与「删除」的作用对象差异及对应文案 | 已决定 · SEM-F30；`AUI-CR-004` contract-ready |
| 删除回执计数；忘记回执保留条目投影而不报告删除计数 | 已决定 · `speech-agent.personal-context.ui@1.0.0`；`AUI-CR-005` contract-ready |
| 设置内「记住」的结构化输入形式 | 已决定 · SEM-F30；`AUI-CR-006` contract-ready |

### 11.7 本轮不构成

- 不构成 renderer 实现：`speech-agent.personal-context.ui@1.0.0` 只签发 Core validator 与 preview-only fixture，未修改 `src/settings/**` renderer。
- 构成可供 UI/UX 消费的 fixture preview：唯一位置为 `src/agent/contracts/fixtures/agent-context-ui/v1.0.0/`；它不是产品数据或验收报告。
- 不构成 J21 证据，不提升任何用户旅程状态。
- `Renderer implementation` 的 contract 前置条件已经满足：`AUI-CR-001`–`AUI-CR-006` 均为 `contract-ready`，overview/manage/changed exact contract 与 fixture 已冻结；真实 preload/IPC/SQLite 汇合仍留给 S5-Integration。
