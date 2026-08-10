# Agent UI/UX 交接：隔离内核现状与正式首版目标

> 当前隔离入口状态：实现完成·尚未验收（SEM-F29 / J23）
>
> 正式产品 UI 状态：已决定、尚未实现（SEM-F25–F28 / J20–J22）
>
> 核对日期：2026-08-09
>
> 面向对象：接手 Agent UI/UX 设计或 renderer 实现的模型
>
> 文档职责：说明当前真实界面、权威状态来源、已知缺口、允许改动范围和正式首版目标。本文不定义新的产品语义，也不作为实现或验收证据。
>
> 权威顺序：[`semantic-contract.md`](semantic-contract.md) > [ADR](adr/) > 架构文档 > 本交接 > 代码现状。术语以 [`CONTEXT.md`](../CONTEXT.md) 为准。

## 1. 先分清两个界面

仓库里同时存在两个不同层级，接手模型必须先声明自己处理哪一个：

| 层级 | 当前事实 | 可以做什么 | 绝不能宣称 |
|---|---|---|---|
| 隔离 Agent 内核开发入口 | `src/agent-mvp/` 已有可单独启动的 Electron + React 界面，只读无音频合成终态会话，生成 `reference-output` | 改善开发工具的信息层级、状态表达、响应式、可访问性与视觉一致性 | 不能称为正式 Agent 产品、会后结构化纪要、增强文本、个人记忆或正式调试聊天 |
| 正式 Agent 产品 UI | 信息架构与语义已由 SEM-F25–F28/J20–J22 冻结，尚未接入正式设置、字幕历史或字幕提交边界 | 产出设计稿、状态矩阵、组件差异和后端 contract request | 不能用前端 mock 或隔离入口数据宣称正式能力已实现 |

隔离入口不是正式产品页面的“早期皮肤”。它是验证 Agent 内核的开发应用，拥有独立生命周期、数据目录和候选 SQLite。正式 UI 可以复用交互经验与视觉 token，但不能直接继承开发入口的确定性测试 provider、合成 fixture 按钮、参考产物命名或候选数据。

字幕系统始终是可独立运行的核心系统。任何 Agent UI 改动都不得让开始监听、字幕显示、首次稳定转写持久化、字幕历史或原始版导出依赖 Agent 系统。

## 2. 当前隔离入口怎么运行

开发入口：

~~~powershell
npm run start:agent-mvp
~~~

该命令先执行 `build:agent-mvp`，再以 `src/agent-mvp/main.js` 启动独立 Electron 应用。

运行边界：

- 应用名为“Live Subtitle Agent MVP”。
- 默认窗口为 `1000 × 680`，最小 `820 × 560`。
- 使用独立 `userData`、`agent-mvp.sqlite`、设置文件、凭据文件和 `agent-diagnostics/`。
- 不导入 `src/main.js`、`SessionCoordinator`、audio host、实时识别 worker、精修 worker 或正式 renderer。
- 正式打包配置显式排除 `src/agent-core/`、`src/agent-mvp/` 和 Pi 开发依赖。
- `src/agent-mvp/renderer-dist/` 是构建产物，不要直接编辑。

切换到 OpenAI-compatible HTTPS 服务会把所选合成终态会话正文发送给用户配置的服务。设计核对优先使用“确定性测试 provider”；不要为了视觉检查提交真实凭据或真实会话正文。

## 3. 当前实现拓扑

~~~text
Agent MVP React renderer
└─ window.agentMvp（受限 preload）
   └─ main 进程 sender 校验 + exact payload IPC
      └─ AgentMvpRuntimeHost
         ├─ storage utility process
         │  └─ 真实 storage worker 基础设施
         │     └─ 独立 SQLite
         │        ├─ sessions / caption_events
         │        ├─ agent_jobs / agent_artifacts
         │        └─ agent_debug_threads / agent_debug_messages
         └─ Agent utility process
            └─ Pi Agent Core
               ├─ AgentPluginHost
               ├─ 固定 recipe：reference-output-v1
               ├─ 唯一工具：read_selected_transcript
               └─ ModelGateway
                  ├─ deterministic-test
                  └─ openai-compatible HTTPS
~~~

关键边界：

- renderer 不持有 Node、Electron、SQLite 或网络权限。
- 插件拿不到 SQLite 句柄；结构通过校验后由宿主提交。
- Agent utility process 与 storage utility process 分离。
- 聊天和任务只读取固定 `sessionId + inputWatermark + transcriptVersion + inputDigest`。
- 当前只读取 `original` 输入；没有正式精修稿选择 UI。
- 流式 Agent 事件通过 `onEvent` 投影到界面；助手正文只在本轮请求结束后进入消息列表，当前不是逐 token 消息渲染。
- 持久化聊天只保存最终用户/助手消息和工具预览、确认、结果；不保存内部思维过程或流式 delta。

## 4. 当前窗口与布局

### 4.1 实际结构

~~~text
┌──────────────────────────────────────────────────────────────────────┐
│ 48px 内容标题带：Live Subtitle Agent · 状态行（唯一 aria-live）     │
├──────────────────────────────────────────────────────────────────────┤
│ provider 工具条：类型 ▾ · 凭据状态 · 展开配置                        │
│ （展开后才出现 HTTPS 地址 / 模型 / 新凭据 / 云端披露 / 保存）        │
├────────────────┬────────────────────────────┬────────────────────────┤
│ 左 · 导航      │ 中 · 主视图槽位            │ 右 · 选中项详情        │
│ 终态会话       │ ┌ 对话 │ 运行 ┐（分段）   │ 会话 / 任务 / 产物     │
│ 合成 fixture   │ 对话视图：                 │ 三选一，随主视图里     │
│ 会话列表       │  消息 · 待确认预览（内联） │ 选中的东西切换         │
│                │  工具事件（折叠一行）      │ 任务详情内含取消动作   │
│                │  输入 / 预览参考产物 / 发送│                        │
│                │ 运行视图：任务列表 · 产物  │                        │
└────────────────┴────────────────────────────┴────────────────────────┘
~~~

布局规则只有一句话：**左 = 导航，中 = 主视图槽位，右 = 当前选中项的详情**。
中栏是槽位而不是「聊天区」——今天注册了「对话」和「运行」两个视图，将来加视图是往槽位里注册，不需要重排外壳。
两个视图始终挂载、只切显隐（与 `settings.css` 的 `.pane` / `.pane.active` 同一手法），因此非活动视图里的
`job-item` / `artifact-item` 仍留在 DOM 与自动化断言里。

当前 CSS 数值（2026-08-09 方向 A′ 改版后）：

| 区域 | 当前实现 |
|---|---|
| 应用栅格 | `48px auto auto auto minmax(0, 1fr)`（标题带 / provider 工具条 / 按需配置 / 错误条 / 工作区） |
| 主工作区 | `244px / minmax(320px, 1fr) / 272px`，grid area 命名为 `sessions / slot / detail` |
| 主视图槽位 | `.view` / `.view.active` 切显隐；分段控件为 `role=tablist`，视图为 `role=tabpanel` |
| 会话列表 | 左栏独立滚动 |
| 消息列表 | 对话视图 flex 剩余空间独立滚动，贴底时才跟随新消息与新预览 |
| 选中项详情 | 右栏整体滚动 |
| 断点 | `max-width: 1080px` 收窄三栏；`max-width: 960px` 时右栏改为跨列底部区域并保留自身滚动，**不隐藏任何一栏** |
| 主题 | renderer 依据 `prefers-color-scheme` 写入 `data-theme`，消费 `tokens.css` 的主题分支 |
| 高对比 | `forced-colors` 下补齐工具条、分组卡、控件、分段控件、消息气泡、预览卡、选中态与状态色 |
| reduced motion | 关闭 transition、scroll behavior 与按钮按压位移 |

主进程没有设置 frameless 或自定义 `titleBarStyle`。renderer 内的 `48px` 标题带只是内容区拖动带，不等同于正式设置/字幕历史的标题栏与窗口控制合同；交互控件一律放在标题带下方的工具条，不放进拖动区。

视觉语言与设置窗/字幕历史窗对齐的方式：复用同一批 `tokens.css` 语义 token，复用 `.titlebar` / `.panel-heading` / `.session-card[aria-current]` / `.seg` / `.primary-btn` / `.secondary-btn` / `.link-btn` 的同名同值写法。本轮没有新增或修改共享 token。

主按钮纪律：**同一时刻只允许一个 `.primary-btn` 可见**。有待确认预览时「确认执行」是主按钮，「发送」降级为 `.secondary-btn`。

### 4.2 当前组件清单

| 组件 | 事实来源 | 当前动作 |
|---|---|---|
| provider 工具条 | 设置文件 + 凭据仓状态 | 常显类型与凭据状态；展开后配置地址、模型、新凭据、云端披露并保存。切到云端 provider 时自动展开 |
| 错误条 | IPC 返回的稳定错误码 | `role=alert`；当前只本地化部分错误码 |
| 合成终态会话区 | 独立 SQLite 的 `sessions` | 添加系统音频或麦克风 fixture；选择一条终态会话（`aria-current`） |
| 主视图分段控件 | 本地 `view` 状态 | 在「对话」「运行」之间切换；运行标签在有活动任务时显示计数徽标 |
| 对话视图 | `agent_debug_threads/messages` | 发送提示词；显示最终用户/助手消息与持久工具消息 |
| 执行预览（内联） | 当前进程内 preview record + 持久 preview 消息 | 以卡片形式长在对话流末尾，就地显示固定 recipe、水位、digest、云端正文披露并确认或拒绝 |
| 受控工具事件 | 当前 renderer 内存 | 默认折成一行摘要，展开才看细节；最多保留最近 20 条、显示最近 6 条；重启后不恢复 |
| 运行视图 | `agent_jobs` + `agent_artifacts` | 任务与产物的列表，只给摘要；选中一条把详情交给右栏 |
| 选中项详情 | 随主视图选中项 | 会话身份 / 任务状态与取消动作 / 产物条目三选一；选中项从快照消失时 fail closed 回落到会话 |
| 顶栏状态行 | 本地 `busy` 与 `runtime.runningRunId` | 全窗唯一的 `role=status` `aria-live=polite`；只播报正在进行的动作，不产生新事实 |

## 5. 当前能力与明确缺口

### 5.1 已有实现

- OpenAI-compatible HTTPS Agent 模型 provider 配置。
- 仅供自动化和开发验证的确定性测试 provider。
- 云端正文披露确认。
- 凭据只提交主进程；renderer 只读取 `hasCredential` / `credentialPersisted`。
- `safeStorage` 可用时加密持久化；不可用时仅本次进程使用。
- 由真实 storage worker 写入的系统音频/麦克风无音频合成终态会话。
- 固定快照调试聊天、Pi Agent Loop 与受控读取工具事件。
- `reference-output-v1` 执行预览、确认/拒绝、后台任务与参考结构化产物。
- SQLite 任务状态、租约、重试、取消、产物和调试消息基础设施。
- 成功产物及聊天消息在应用重启后恢复。
- 正式安装包排除开发入口、Agent core 和 Pi 依赖。

### 5.2 尚未实现

- 正式字幕提交边界和 `MeetingStopped` 接线。
- 正式设置页中的识别 provider、Agent 模型 provider 与个人记忆配置。
- 正式字幕历史中的会后结构化纪要或增强文本。
- 个人记忆、记忆候选、确认关键词及其范围。
- 本地 Agent 模型 provider。
- 云端主力识别与本地降级。
- 三项并列的会后结构化纪要、个人记忆、增强文本后台 Agent 任务。
- 正式业务工具与有界个人记忆注入。
- 面向普通用户的 Agent 页面。
- 外部待办执行、任意 shell、任意文件、任意 SQL、任意网络或递归委派。

当前 `reference-output` 必须一直显示为“参考结构化产物”或“参考产物”。不得通过改文案把它包装成会后结构化纪要、增强文本或个人记忆。

## 6. renderer 只能相信的契约

权威 preload 是 `src/agent-mvp/preload.js`。接手模型不得在 renderer 里拼 IPC channel、读取文件或直接发网络请求。

| API | 用途 | UI 注意点 |
|---|---|---|
| `getState()` | 读取 runtime 与 provider 脱敏快照 | 初始骨架、空态和读取失败都要有表现 |
| `saveProvider(value)` | 保存 provider、模型、披露确认和可选新凭据 | payload 是 exactObject；既有凭据不会返回 |
| `createFixture(sourceId)` | 创建 `loopback` 或 `mic` 合成终态会话 | 只属开发入口；正式 UI 不出现 |
| `messages(sessionId)` | 读取所选会话的持久调试消息 | 只允许终态会话 |
| `chat(sessionId, prompt)` | 执行一次调试聊天 Agent Loop | 当前没有 renderer 可用的“停止本轮聊天”命令 |
| `preview(sessionId)` | 创建参考任务执行预览 | 预览消息持久化，但可确认的 preview record 当前只在内存 |
| `confirm(previewId, decision)` | 接受或拒绝预览 | decision 仅为 `accepted` / `rejected` |
| `cancel(runId)` | 请求取消后台任务 | 只影响 Agent 任务，不影响字幕系统 |
| `onState(callback)` | 接收 runtime 快照 | provider 配置变化不通过该事件广播完整 provider 快照 |
| `onEvent(callback)` | 接收投影后的 Agent 事件 | 不能把事件正文或内部推理持久化 |

当前 `getState()` 的 UI 相关形状：

~~~ts
{
  runtime: {
    sessions: Array<{ sessionId, sourceId, state, startedAt }>,
    jobs: Array<{ runId, state, errorCode, attemptCount, model }>,
    artifacts: Array<{ artifactId, runId, sessionId, type, content }>,
    runningRunId: string | null
  },
  provider: {
    provider,
    baseUrl,
    model,
    cloudDisclosureAccepted,
    hasCredential,
    credentialPersisted
  }
}
~~~

如果设计需要会话标题、完整来源说明、生成时间、任务进度、费用、token 用量、下一次重试时间、取消中状态、输入版本或更多可展示错误信息，先列 contract request；不要从 `runId`、等待时长、DOM 顺序或异常字符串推断。

## 7. 当前状态矩阵

### 7.1 Provider

| 状态 | 当前事实 | 设计要求 |
|---|---|---|
| 确定性测试 provider | 无需凭据；模型固定回落为 `fixture-model` | 明确标记“仅开发验证”，不要伪装成本地 Agent 模型 provider |
| OpenAI-compatible 未配置凭据 | 设置可能已保存，但下一次调用会返回鉴权失败 | 配置状态与调用状态分开表达 |
| OpenAI-compatible 已持久化凭据 | `hasCredential=true` 且 `credentialPersisted=true` | 不回显密钥，不提供“复制既有密钥” |
| 仅本次进程凭据 | `hasCredential=true` 且 `credentialPersisted=false` | 明确“关闭应用后需重新配置” |
| 地址/披露无效 | 保存被拒绝 | 保留编辑值并给出可行动错误；当前 public error 映射仍需后端 contract 修正 |
| provider 超时/限流/不可用 | 当前任务或聊天失败/稍后重试 | 不影响合成会话、已有消息与已有产物 |

### 7.2 会话与聊天

| 状态 | 当前表现 | 设计要求 |
|---|---|---|
| 无会话 | 左栏只有两个 fixture 动作；聊天输入禁用 | 空态要说明这是隔离入口，不暗示没有正式字幕历史 |
| 已选择终态会话 | 标题显示来源和短 `sessionId` | 选择状态不能只靠底色；增加可访问选择语义 |
| 无消息 | 显示“不进入个人记忆”说明 | 保留该边界文案 |
| 响应中 | 全局 `busy=chat`，发送按钮显示“响应中…” | 需要明确取消能力时先提 contract request；不能做假的停止按钮 |
| provider 故障 | 消息保留，顶部错误条显示错误码或短句 | 提供重试与回到 provider 配置的路径 |
| 切换会话 | 重新读取该会话线程 | 不得把上一会话的消息短暂归入新会话 |

### 7.3 执行预览与后台任务

| 后端值 | 推荐用户文案 | 必须保留的事实 |
|---|---|---|
| `queued` | 等待中 | run、模型与固定输入已经冻结 |
| `running` | 运行中 | 不展示虚构百分比 |
| `retry_wait` | 稍后重试 | 自动重试沿用同一 `runId` |
| `succeeded` | 已生成 | 只有产物持久化成功后才能显示 |
| `failed` | 失败 | 显示稳定错误说明，已有产物不受影响 |
| `cancelled` | 已取消 | 不把取消显示成 provider 故障 |

执行预览至少保留：

- 固定 recipe。
- 输入水位。
- input digest 的短显示。
- 是否会向云端发送正文。
- 确认与拒绝两个明确动作。

当前可确认 preview record 只在主进程内存中。应用重启后，历史 preview 消息仍可见，但旧预览不能继续确认。若要把“恢复待确认预览”纳入 UX，必须先补持久化与 IPC contract。

### 7.4 当前错误码覆盖

renderer 已本地化：

- `AGENT_PROVIDER_AUTH_FAILED`
- `AGENT_PROVIDER_TIMEOUT`
- `AGENT_PROVIDER_UNAVAILABLE`
- `AGENT_OUTPUT_INVALID`
- `AGENT_PERMISSION_DENIED`
- `AGENT_REQUEST_INVALID`

仍可能以原始 code 出现或被主进程折叠为 `AGENT_INTERNAL_FAILURE`：

- provider 地址无效
- provider 限流
- worker 退出
- job 不存在或状态冲突
- 输入快照改变
- 会话不存在或不是终态
- 用户取消
- 未分类内部故障

接手模型可以先设计统一错误组件和文案映射提案，但错误分类、`nextAction` 和是否可重试必须由后端返回，不得由 renderer 猜测。

## 8. 当前交互旅程

### 8.1 创建合成终态会话并调试聊天

1. 开发者启动隔离入口。
2. 保持确定性测试 provider，或配置 OpenAI-compatible HTTPS 服务并确认云端正文披露。
3. 点击“添加系统音频 fixture”或“添加麦克风 fixture”。
4. storage utility process 通过真实字幕存储基础设施写入无音频合成终态会话。
5. UI 选择该会话，读取或创建独立调试线程。
6. 用户发送提示词。
7. Pi Agent Loop 只允许调用 `read_selected_transcript` 一次。
8. UI 临时显示受控工具事件，并在请求结束后显示助手正文。

### 8.2 生成参考结构化产物

1. 用户选择一条合成终态会话。
2. 点击“预览参考产物”。
3. UI 显示固定 recipe、水位、digest 与云端正文披露。
4. 用户确认后创建一个 SQLite 后台 Agent 任务；拒绝则只记录决定。
5. 任务经固定 recipe Agent Loop 返回结构化候选。
6. 宿主通过 Schema 校验后写入 `agent_artifacts`。
7. UI 从权威 runtime 快照显示“已生成”和参考结构化产物。

### 8.3 重启恢复

当前已有旅程证明的是：

- 成功后的会话、聊天消息、任务与参考产物在同一独立 `userData` 重启后可读。
- 凭据是否在重启后存在取决于 `safeStorage` 是否可持久化。

尚未由完整 Electron 旅程证明的是：

- 任务运行中被中断后以同一 `runId` 恢复。
- renderer 中确认拒绝、任务取消和 provider 故障的完整状态往返。
- 408/429/5xx 自动重试与鉴权/Schema/权限不重试的同一跨模块矩阵。

## 9. 已知 UI/UX 缺口

以下是代码审计结果，不是新的产品语义。

2026-08-09 的视觉统一改版处理了其中一部分，逐条状态如下。

### P0 · 接手时优先处理

1. ~~**窄窗会丢失关键操作。**~~ 已处理：`960px` 以下右栏不再 `display:none`，改为跨列底部区域并保留自身滚动，执行预览、任务、产物与工具事件在 `820 × 560` 仍可达（DOM 未复制任何节点，仅栅格重排）。
2. ~~**状态仍大量暴露内部值。**~~ 已处理：会话状态、任务状态、消息 role、Agent 事件类型与错误码都过纯 UI 映射层；未知值一律 fail closed 为“未知状态（原值）”，不冒充成功。`data-state` 仍保留后端原值供自动化断言。
3. **聊天没有可用的停止动作。** 未处理，仍需 contract request。当前只在输入区写明“本轮请求结束后一次性写入；没有可用的停止命令”，不画假按钮。
4. **待确认预览不可跨重启继续。** 未改变事实。预览卡已明写“待确认预览只在本次进程内有效，应用重启后这条预览无法继续确认”。

### P1 · 视觉与交互一致性

1. ~~未定义 token fallback、硬编码深色分支与 `!important`。~~ 已处理：全部色值改为消费既有共享 token（`--fg` / `--surface-settings` / `--accent-*` / `--tone-*` / `--radius-*` / `--dur-*`），深色分支与 `!important` 已删除，未新增共享 token。
2. 主题仍只跟随系统：renderer 依据 `prefers-color-scheme` 写 `data-theme`，这样才能消费 `tokens.css` 的主题分支，但它不消费正式应用的 `config.theme`，只代表开发入口的系统主题行为。
3. 内容标题带与原生 BrowserWindow frame 并存，不能直接当作正式产品 `48px` 标题栏范本。
4. ~~`busy` 禁用规则不一致。~~ 已处理：preview 决定按钮与任务取消按钮统一按 `busy !== null` 禁用。
5. ~~消息追加后没有滚动策略。~~ 已处理：仅在用户本来贴着底部时跟随到底，向上翻阅时不抢滚动位置。
6. ~~会话列表未展示时间。~~ 已处理：会话卡改为「时间 / 来源 / 状态 · 短 ID」三层，与字幕历史的 `.session-card` 同结构同字阶。
7. ~~工具事件像完整审计记录。~~ 已处理：分节说明写明“仅本轮内存事件：最多保留 20 条、显示最近 6 条，重启后不恢复，不是完整审计记录”。

### P1 · 可访问性

1. ~~会话选择缺少选择语义。~~ 已处理：`role=list/listitem` + `aria-current`，选中态同时有边框与底色。
2. ~~没有克制的 `aria-live` 策略。~~ 已处理：全窗只有顶栏一处 `role=status` `aria-live=polite`，播报当前异步动作或后台任务运行中，不给每个面板各挂一个 live region。
3. ~~执行预览没有焦点移动与返回触发点。~~ 已处理：预览出现时焦点移入面板（`tabIndex=-1` + `aria-labelledby`），确认或拒绝后焦点交还“预览参考产物”按钮。
4. ~~高对比只覆盖选中会话。~~ 已处理：`forced-colors` 下补齐分组卡、控件、按钮、错误条、消息气泡、选中会话与状态色。
5. ~~右栏被隐藏后键盘用户失去关键内容。~~ 已随 P0-1 关闭。
6. ~~状态只靠颜色。~~ 已处理：任务状态是「形状标记 + 中文文案 + 色调」三通道，去掉颜色后仍可区分全部六种状态。

### 方向 A′ 改版额外关闭的（2026-08-09 第二轮）

第一轮只统一了视觉，信息架构问题仍在。第二轮按「左导航 / 中主视图槽位 / 右选中项详情」重排，实测对照：

| 指标（默认窗口 `1000 × 680`） | 改版前 | 改版后 |
|---|---|---|
| 同时可见的 `.primary-btn` | 3（保存 / 发送 / 确认执行） | **1**（有预览时是确认执行，发送自动降级） |
| 非导航动作按钮 | 分布在 4 个不相邻区域 | 6 个，集中在工具条与输入区 |
| 顶部 chrome 占窗口高度 | 182px · 27% | **101px · 15%** |
| 消息区可用高度 | 283px | **369px** |
| 右栏折叠线以下内容 | 66% | **0%**（窄窗 `820 × 560` 为 29%） |
| 预览触发点与确认按钮 | 跨栏，需视线跳到另一列 | 同栏同屏，卡片自动滚入视口并接管焦点 |

具体改动：provider 从常驻横幅压成 40px 工具条 + 按需配置；执行预览从右栏搬进对话流就地确认；
后台任务与产物搬进「运行」视图，行只给摘要，细节与取消动作交给右栏；工具事件折成一行摘要。

> 说明：预览触发点到确认按钮的**直线距离**从 304px 变成 362px，这个数字没有变好 ——
> 它现在主要由卡片内左对齐的按钮与输入区右对齐的按钮之间的**水平**偏移构成，垂直间距是 146px。
> 真正改变的是「不再跨栏、卡片完整可见、焦点被带过去」，不是这个欧氏距离。

### 第三轮：首帧缺失 bug、文案、可拖拽分栏与图标（2026-08-09）

**已修的渲染 bug（回归重点）。** 打开窗口后下半部分是空背景，点左栏才逐渐长出来。
两处成因都是「用栅格行去承载可选子元素」：

1. `.app-shell` 曾是 `grid-template-rows: 48px auto auto auto minmax(0,1fr)`，但 provider 设置区与错误条是**条件渲染**的。
   平时只有 3 个子元素，工作区落到第 3 行（`auto`），按内容高度收缩。已改为 flex 列 + `.workspace { flex: 1; min-height: 0 }`。
2. `.workspace` 只声明了 `grid-template-columns`，隐式行是 `auto`，三栏仍按内容收缩。已补 `grid-template-rows: minmax(0, 1fr)`。

真实 Electron 窗口实测（`1000 × 680`，内容区 643px）：修复前工作区高度 `287 → 345 → 379`（随数据到达增长，底部空 163px）；
修复后自 80ms 首帧起恒为 `552`，三栏恒为 `549`，不再变化。

> 教训写进规则：**外壳里凡是可选的子元素，一律不要用固定行数的 grid 承载。** 用 flex 列，或给每个子元素显式 `grid-row`。

**文案。** 面向操作的词全部改成日常说法：`Agent 模型 provider` → 「AI 模型」、`确定性测试 provider` → 「内置假模型（不联网，仅供测试）」、
`凭据` → 「密钥」、`终态会话` → 「会话」、`合成 fixture` → 「新建测试会话」、`执行预览` → 「开始前请确认」、
`受控工具事件` → 「AI 用了哪些工具」、`runId` → 「任务编号」、`inputWatermark` → 「读取范围：到第 N 条为止」、
`inputDigest` → 「内容指纹」。技术事实照旧显示，但每条配一句 `.fact-note` 解释它是什么。
⚠ `参考结构化产物` 按 §5.2 保持原样未改名。

**可拖拽分栏。** 四条 `role=separator`：会话列表宽、详情栏宽（宽窗）、详情栏高（窄窗）、输入框高。
指针拖动与方向键都可用，带 `aria-valuenow/min/max`，尺寸存在 renderer 本地 `localStorage`（键 `agent-mvp.layout.v1`），
不进任何契约或 SQLite。栏宽通过 `--w-left` / `--w-right` / `--h-detail` 传给 CSS，因此断点仍能决定用到哪几条，内联样式不会压掉媒体查询。

**图标与交互层次。** 新增 `renderer/icons.tsx`：16×16 网格、1.6 描边、`currentColor` 的功能性图标，
与设置窗 / 字幕历史窗的线性图标同族；只做功能识别，不画装饰性图形。
交互层次借用 Material 的 state layer 思路（hover 6% / pressed 10% / 选中用强调色洗层）统一到 `.ghost-btn`、卡片与分段控件，
但**配色与字体仍留在 Win11 一侧**，以免和设置窗、字幕历史窗割裂。若要整体转向 Material 配色与字阶，那是四个 renderer 的共同决定，需先改 `tokens.css`（§15.2）。

### 为后续视图预留的结构

接手模型如果要加新的主视图（例如个人记忆图），做法是往槽位里注册，不要在右栏加第五节：

- 在 `ViewId` 上加一个值，在分段控件里加一个 `role=tab`，在 `.view-body` 里加一个 `.view`。
- 右栏不需要改结构：给 `Selection` 加一种 `kind`，在详情区加一个分支。
- ⚠ 个人记忆本身按 `SEM-F29` 明确禁止接入本开发入口；记忆图属于正式产品，不要在这里试。
  另外 `SEM-F26` 首版禁止向量索引与图数据库，任何基于嵌入的点云视图都要先改语义合同。

### 本轮遗留的 contract request

纯 UI 改动无法解决、需要后端或窗口合同配合的只有三项：

1. **停止本轮调试聊天。** 需要 renderer 可见的 chat `runId` 与一个停止命令，同步 protocol、main access policy、preload 与测试。在此之前 UI 不提供停止按钮。
2. **恢复待确认预览。** 需要把可执行 preview record 持久化并补一条读取命令，UI 才能在重启后继续确认。
3. **窗口 `backgroundColor`。** `src/agent-mvp/main.js` 仍写死浅色 `#f3f3f3`，在深色系统主题下首帧会闪一次浅底。属 BrowserWindow 合同，不是 CSS 决策，需共同评审后再改。

除此之外本轮无新增字段、命令或错误码需求。

## 10. 视觉语言

隔离入口与正式 Agent UI 都应看起来属于当前 Win11 字幕产品：

- 字体沿用 `Segoe UI Variable`。
- 复用共享语义 token，不另建 Agent 专属渐变或玻璃卡片体系。
- 使用中性窗口表面、轻边框、小到中等圆角和克制阴影。
- 强调色只表达选择、焦点和明确主动作。
- 不使用机器人插画、装饰性 AI 图形、虚构指标卡、发光状态点、胶囊标签堆叠或大卡片套小卡片。
- 不用无限动画表示“智能”；运行中只需要局部、可停止且 reduced-motion 友好的反馈。
- 浅色、深色、Windows 系统高对比和 reduced motion 都要有明确方案。
- 所有状态遵循“文字/形状先于颜色”。

正式设置与字幕历史仍以这些文件为视觉基准：

- `src/settings/settings-view.tsx`
- `src/settings/settings.css`
- `src/history/history-view.tsx`
- `src/history/history.css`
- `src/ui/shared/tokens.css`

## 11. 正式首版信息架构

~~~text
设置
├─ 显示与字幕                         既有
├─ 音频源                             既有
├─ 语音识别
│  ├─ 权威识别策略                    新增
│  ├─ 识别 provider                   新增
│  ├─ provider 能力与核心资源就绪      新增
│  └─ 确认关键词                       新增轻量入口
├─ 模型资源                            既有
├─ Agent 与记忆                        新增
│  ├─ Agent 模型 provider
│  ├─ 云端正文发送说明
│  ├─ 个人记忆总开关
│  ├─ 三项后台 Agent 任务状态
│  └─ 调试聊天入口                     仅开发/验证开关可见
└─ 关于                                既有

字幕历史
└─ 所选终态会话
   ├─ 权威原始转写 / 精修稿             既有事实层
   ├─ 会后结构化纪要                    新增派生层
   └─ 增强文本                          后端闭环后再启用

正式调试聊天（默认隐藏的独立正常窗口）
├─ 已选择的终态会话
├─ 对话与受控工具事件
├─ 输入与停止
└─ 上下文、输入版本、水位与任务检查
~~~

识别 provider 和 Agent 模型 provider 必须在不同页面或明确分组中呈现。音频来源仍只是互斥的 `mic` 或 `loopback`；权威识别策略是另一根配置轴。

## 12. 正式页面设计约束

### 12.1 语音识别

权威识别策略只有两个互斥选项：

- 纯本地权威识别。
- 云端主力识别与本地降级。

UI 必须同时区分：

- 未来新会话将读取的设置。
- 当前活动会话已经冻结的运行快照。

活动会话期间可以允许用户预先修改未来设置，但必须紧邻控件写明“只影响未来新会话”。云端主力识别需要独立披露实时音频处理范围、本地核心字幕模型资源包仍须就绪、只在明确连接故障后单向降级、降级后不自动切回。普通延迟波动不是降级条件。

识别 provider 行需要显示配置状态、关键词能力和最近一次非侵入式连接检查。provider 不支持确认关键词时仍可选择，但必须明确显示能力缺失。

确认关键词只做轻量二级视图：

- 待确认候选。
- 少量全局确认关键词。
- 用户明确选择的主题/项目确认关键词。
- 当前 provider 是否支持关键词。
- “只对未来新会话生效”。

自动候选不能默认启用。写作、摘要或表达偏好不能进入确认关键词。

### 12.2 Agent 与记忆

Agent 模型 provider 与识别 provider 分离。页面至少显示：

- provider 类型、模型与脱敏配置状态。
- 本地任务在活动字幕会话期间让路的资源规则。
- 云端 provider 的终态会话正文发送说明。
- `safeStorage` 不可用时“凭据仅本次进程使用”。

首次选择云端 Agent 模型 provider 时必须明确披露：终态会话正文可能自动发送给该服务，用于会后结构化纪要、增强文本和个人记忆提取；派生结果与个人记忆仍保存在本机。用户确认后才允许将其用于未来后台 Agent 任务。

个人记忆总开关默认开启。说明必须区分：

- 每个终态会话接受筛选，不等于复制整场正文。
- 长期结构化记忆、会话经历记录和丢弃是三种结果。
- 自动推断先形成带来源的记忆候选。
- 关闭后既有条目休眠，不自动删除。
- 关闭后未来新会话不再读取由个人记忆产生的确认关键词。

首版不设计完整个人记忆浏览、编辑、图谱或语义搜索。

三项后台 Agent 任务必须独立显示：

- 会后结构化纪要。
- 个人记忆提取。
- 增强文本。

一项失败不得改变另外两项的状态。运行本地任务因字幕会话让路时，用“字幕会话优先，任务将在停止后继续”，不要显示成模型故障。

### 12.3 字幕历史中的会后结构化纪要

沿用“左侧会话列表 + 右侧详情”。右侧视图至少区分：

- 权威原始转写。
- 精修稿（存在时）。
- 会后结构化纪要。
- 增强文本（后端闭环后）。

默认仍进入权威原始转写。Agent 派生内容必须显示输入版本、水位、digest 短值、provider、模型、生成时间和产物版本，视觉层级不得暗示它比权威原始转写更权威。

会后结构化纪要固定栏目：

1. 概要。
2. 结论。
3. 待办。
4. 风险。

待办只是一段内容，不出现外部执行动作。重新生成前展示所选会话、输入版本、水位、provider、云端正文发送/费用影响和新版本说明；确认后创建新 `runId`，旧版本保留。

### 12.4 正式调试聊天

正式调试聊天默认隐藏，只允许选择用户明确选中的终态会话，不跟随活动会话。它需要持续显示：

- 会话非正文标识、来源与时间。
- 输入转写版本、水位和 digest 短值。
- Agent 模型 provider 与模型。
- 注入的个人记忆条目数量和上下文预算。

聊天记录独立保存在本地 SQLite，不自动进入个人记忆、确认关键词或会后结构化纪要输入。工具事件只显示名称、用途、目标会话、状态、耗时与结果摘要；不显示内部思维过程、隐藏提示词或模型草稿。

读取工具可以直接执行。会生成新产物或云端费用的请求工具必须先展示执行预览并由用户确认，再由 Agent 插件宿主创建固定 recipe、固定能力与固定预算的一层专用子 Agent。

## 13. 正式 UI 所需 contract request

以下是设计可依赖的逻辑信息，不代表具体 TypeScript 名称已经冻结：

| 快照/命令 | UI 最低需要 | 约束 |
|---|---|---|
| 识别设置快照 | 未来策略、活动会话冻结策略、provider、配置状态、关键词能力、核心资源就绪 | 不返回凭据；revision 单调 |
| 保存识别设置 | 策略/provider 与云端披露确认版本 | 不改写活动会话 |
| Agent 设置快照 | provider/模型、配置状态、个人记忆开关、披露确认版本、开发入口状态 | 与识别设置独立 |
| 保存 Agent 设置 | provider、记忆开关与披露确认 | renderer 不持有既有密钥 |
| 确认关键词分页 | 候选、已确认项、范围、来源摘要、启用状态、provider 能力 | 不返回整场正文 |
| 会话 Agent 详情 | 三个 job 的独立状态、artifact 版本、输入身份、provider/模型、稳定错误 | 权威原始转写接口保持独立 |
| 请求后台任务 | task type、终态会话、输入快照、执行预览确认 token | 自动重试沿用 run；主动请求创建新 run |
| 调试聊天快照 | thread、会话、消息、工具事件、上下文摘要、诊断标识 | 与个人记忆表分离 |
| 调试聊天命令 | 选择会话、发送、停止、确认/拒绝工具、清空 | 只允许固定工具；拒绝活动会话 |

所有失败都需要稳定错误码、可展示短句、可重试性和明确下一步。任何“已生成”状态必须来自持久化成功后的权威快照或命令回执。

## 14. 语义对齐结果

本次核对后的状态：

| 语义/旅程 | 对齐结论 |
|---|---|
| SEM-F00 | 正式字幕运行时仍与 Agent 独立；隔离入口不改变双系统边界 |
| SEM-F15/F16 | 固定工具、项目自有插件宿主与 `ModelGateway` 已有隔离切片；正式字幕上下文和业务插件尚未实现 |
| SEM-F25–F27 | 两套 provider、个人记忆与确认关键词均为已决定、尚未实现 |
| SEM-F28 | 隔离入口只提供单一参考任务与调试壳；三项正式后台 Agent 任务和正式调试聊天尚未实现 |
| SEM-F29 | 实现完成·尚未验收 |
| SEM-T10 | 参考插件顺利路径已有真实宿主/SQLite/UI 证据；完整失败矩阵与正式 J13 尚未闭合 |
| J20/J21/J22 | 已决定、尚未实现；J23 不得冒充这些旅程 |
| J23 | 实现完成·尚未验收；顺利路径与成功后重启已有联合旅程，完整中断/恢复与失败矩阵待补 |

因此，接手模型可以说“隔离 Agent 内核开发入口为实现完成·尚未验收”，不能说“Agent 系统联合验收完成”，也不能说会后结构化纪要、个人记忆、增强文本或正式调试聊天已经存在。

## 15. 文件所有权

### 15.1 可直接做视觉/UI 改动

| 路径 | 责任 |
|---|---|
| `src/agent-mvp/renderer/main.tsx` | 当前隔离入口结构、展示逻辑、ARIA 与纯 UI 状态映射 |
| `src/agent-mvp/renderer/icons.tsx` | 功能性图标集；只做功能识别，不加装饰性图形 |
| `src/agent-mvp/renderer/styles.css` | 布局、响应式、主题、focus、高对比与 reduced motion |
| `src/agent-mvp/renderer/index.html` | 文档语言、CSP、标题与根节点 |
| `docs/agent-ui-ux-handoff.md` | 本交接；语义改变仍须先改权威文档 |

### 15.2 需要共同评审

| 路径/改动 | 原因 |
|---|---|
| `src/ui/shared/tokens.css` | 四个正式 renderer 共用；新增或改 token 可能改变字幕系统 UI |
| 新增字段、命令、错误码或取消能力 | 必须同步 protocol、main access policy、preload、runtime 与测试 |
| 默认窗口宽高、最小尺寸、frame/titlebar | 属 BrowserWindow/layout contract，不是纯 CSS 决策 |
| provider 披露或凭据交互 | 涉及安全与持久化语义 |
| 正式设置/历史入口 | 必须先登记 SEM-F25–F28 与 J20–J22 的 exact contract |

### 15.3 不要直接修改

- `src/agent-mvp/preload.js`
- `src/agent-mvp/protocol.js`
- `src/agent-mvp/main.js`
- `src/agent-mvp/runtime-host.js`
- `src/agent-mvp/*-worker.js` / `*-service.js`
- `src/agent-core/`
- 正式字幕 runtime、存储 schema、模型与打包配置
- `src/agent-mvp/renderer-dist/`

若 UI 方案确实需要这些层的新事实或动作，先提交 contract request。新增能力或改变语义时，必须先更新 `semantic-contract.md` 和 `testing-strategy.md`，再动实现。

## 16. 接手模型的交付物

至少交付：

1. 明确选择“隔离入口改版”“正式首版设计”或两者，并保持两套页面命名和数据隔离。
2. 当前隔离入口的宽屏与 `820–900px` 窄窗方案，保证执行预览、任务、产物和工具事件始终可达。
3. Provider、空会话、已选会话、响应中、预览待确认、六种任务状态、provider 故障和重启恢复的状态矩阵。
4. 浅色、深色、Windows 系统高对比、键盘 focus 与 reduced motion 说明。
5. 共享 token 复用表、当前 fallback 清单和确需新增 token 的理由。
6. 错误码/任务状态的 UI view-model 映射；未知状态必须 fail closed。
7. 可访问性说明：选择语义、焦点路径、`aria-live`、预览焦点与窄窗可达性。
8. 后端 contract request 清单；没有则明确写“无”。
9. 若涉及正式首版，再提供设置、字幕历史、正式调试聊天与两类云端披露的设计稿。
10. 若改变窗口尺寸、frame、标题栏或断点，给出精确 layout contract 和原因。

不要把未接入能力画成看起来可以提交的按钮。尚无 contract 的入口要么不出现，要么明确标为设计占位且不能进入实现稿。

## 17. 验证入口

UI 改动至少执行：

~~~powershell
npm run build:agent-mvp
npm run test:core
npm run test:integration
~~~

本次 2026-08-09 对齐复核记录（隔离入口 renderer 的视觉统一 + 方向 A′ 结构改版）：

- Agent MVP 生产构建已生成。
- core lane：`501/501`。
- integration lane：`34/34`；包含 J23 的真实 React、preload、exact IPC、双 utility process、SQLite 与成功后重启旅程。两轮改版后的 DOM 都由这条真实 Electron 旅程实际驱动通过（fixture → 聊天 → 预览 → 确认 → 产物 → 重启恢复），消息、任务、产物与工具事件计数不变。
- ⚠ core/integration 的用例总数比本文件上一版记录的 `482` / `33` 多，是同一工作树里其他模块的并行改动带来的，不属于本次 Agent UI/UX 改动。
- evidence lane：`220/222`；两项 I3 非音频报告因当前产品载荷 SHA 与受跟踪报告不一致而 fail closed。已用 stash 复核：把本次 renderer 改动移除后这两项仍然失败，即该漂移先于本次改动存在，与 Agent UI/UX 无关；但它仍意味着当前工作树的完整 `npm test` 不能记为联合验收完成。
- 改动范围只有 `src/agent-mvp/renderer/{index.html,main.tsx,styles.css}`，未触碰 preload、protocol、main、runtime-host、worker、`src/agent-core/`、共享 `tokens.css`、窗口尺寸与打包配置。所有 `data-testid` 与 `role=alert` + `data-error-code` 断言点保持不变，且没有为响应式复制任何带 testid 的节点。

重点证据文件：

- `test/runtime/agent-core.test.js`
- `test/runtime/agent-mvp-services.test.js`
- `test/storage/agent-mvp-store.test.js`
- `test/integration/agent-core-journey.test.js`
- `test/integration/agent-mvp-electron-journey.test.js`
- `test/validation/b5-packaging-contract.test.js`

验收说明必须区分：

- 构建与局部回归。
- J23 确定性联合旅程。
- 正式 J21/J22 产品旅程。
- 真实 OpenAI-compatible 服务的网络/凭据边界。

局部回归不能把 J23 提升为联合验收完成，J23 也不能把 J21/J22 提升为实现完成·尚未验收。

## 18. 可直接交给下一模型的起始指令

> 先完整阅读 `CONTEXT.md`，再读 `docs/semantic-contract.md` 的 SEM-F00/F15/F16/F25–F29/T04/T05/T06/T10、`docs/testing-strategy.md` 的 J20–J23，以及本交接。先说明你处理隔离 Agent 内核开发入口还是正式产品 UI。若处理当前代码，只修改 renderer 与经批准的共享 token；任何新字段、命令、错误码、窗口合同或正式产品入口先列 contract request。参考产物必须保持 `reference-output` 语义，不得改名为会后结构化纪要、增强文本或个人记忆。设计需覆盖 `820–900px` 窄窗、浅色/深色/高对比、键盘、reduced motion、全部任务状态和失败路径，并保证字幕系统在 Agent 完全不存在时仍独立工作。
