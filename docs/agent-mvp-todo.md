# 正式 Agent 首版 TODO 与组合验收矩阵

> 更新日期：2026-08-10
> 证据状态：SEM-F29/J23 隔离 Agent 内核开发入口为联合验收完成；D3 的正式 SQLite migration 与存储/生命周期子边界、D4 的会后结构化纪要后端纵切、D5 的增强文本与个人记忆 UI-free 后端纵切，以及 D6 的正式 storage utility transport 子边界均为实现完成·尚未验收；ADR 0011 的 DeepSeek 配置表、启动环境凭据、provider/model/预算冻结和降级为已决定；其余正式产品项保持已决定。

## 1. 使用方式与权威边界

本文是执行追踪表，不替代语义权威。冲突时仍按 `docs/semantic-contract.md` > ADR > 架构文档 > 本文 > 代码现状处理。

本目标中的“完整 MVP”解释为正式 Agent 首版，而不是隔离 Agent 内核开发入口。交付范围固定引用 SEM-F00/F09/F15/F16/F25–F28、SEM-T07/T10/T15、DB7、J3–J7/J12/J13/J20–J24；J23 是进入正式接线前的内核前置门禁。

不进入首版：任意外部操作、通用助手、递归委派、第三方插件市场、完整个人记忆管理、逐会话敏感排除、FTS5、embedding、图关系、会中滚动增强、真实 DeepSeek 公网/账户/配额/模型质量验收、本地 Agent 模型 provider、API key 持久化与 renderer 凭据输入。正式首版仍必须闭合 Agent 模型 provider registry、main-only 受信任配置表、启动环境凭据状态、冻结快照和显式降级。

## 2. 当前基线

| 范围 | 证据状态 | 当前证据与缺口 |
|---|---|---|
| Agent Core / Pi 适配 / `AgentPluginHost` / `ModelGateway` | 联合验收完成 | 参考插件、权限白名单、候选任务与产物已由 J23-B01–B16 跨模块旅程闭合；只属于 SEM-F29/J23 |
| 隔离 Agent 内核开发入口 | 联合验收完成 | 顺利路径、重启、取消竞态、应用中断、utility replacement、Agent 模型 provider/越权矩阵、幂等重放与严格隐私负扫描均已有真实 Electron 联合证据 |
| 正式 Agent SQLite 与存储/生命周期子边界 | 实现完成·尚未验收 | 正式 v3 migration、输入身份、Agent 处理资格、自动对账、策略线性化、领取/续租/转换/结果/删除幂等、跨表完整性与 tombstone 已由真实 storage worker + SQLite 子边界覆盖；不包含正式 PluginHost、job runner、preload/IPC 或 renderer |
| 会后结构化纪要后端纵切 | 实现完成·尚未验收 | 冻结输入读取、已装载任务闭集、确定性分块/归并、正式 `transcript-context` / `meeting-minutes`、`ModelGateway` + Pi Agent Loop、租约/重试/取消/插件卸载与 SQLite 原子提交已有组合证据；不包含 `MeetingStopped`、正式 preload/IPC、renderer、utility-process transport 或实机组合 |
| 增强文本与个人记忆后端纵切 | 实现完成·尚未验收 | 正式 `enhanced-transcript`、`memory-extraction`、任务内 `memory-consolidation`、writer 分流、三项同输入独立执行、记忆三级筛选/去重/冲突/suppression 与单条删除已有真实 storage worker/SQLite/PluginHost/job runner 组合证据；不包含 `MeetingStopped`、正式 utility-process transport、preload/IPC、renderer、记忆检索或确认关键词 |
| 正式 storage utility transport | 实现完成·尚未验收 | D6 使用 production `StorageWorkerHost` 跨越真实 Electron utility process：策略先行、claim 已提交后强制结束所捕获的 exact child 并等待同一退出结果、replacement 未重放策略前拒绝领取、租约到期后同一 `runId` 恢复，以及三项任务各自最多提交一次；父测试独立复算 SQLite 身份与隐私负扫描。不包含 Agent utility、`MeetingStopped`、正式 `StorageGateway` 接线、preload/IPC 或 renderer |
| 正式字幕提交边界接线 | 已决定 | 尚无 `MeetingStopped → AgentJobReconciler` 正式实现证据 |
| 正式三项后台 Agent 任务 | 已决定 | 三项任务共享同一冻结输入并独立执行的 UI-free 后端子边界为实现完成·尚未验收；正式触发、utility-process 运行时、用户读取/操作链路与完整 J21/J24 仍无产品证据 |
| 识别 provider、Agent 模型 provider、确认关键词、资源仲裁 | 已决定 | 识别 registry、云端识别、确认关键词与资源仲裁尚无实现证据；Agent 模型 provider 按 ADR 0011 使用 `deepseek/deepseek-v4-flash` main-only 配置表与 `DEEPSEEK_API_KEY` 启动环境凭据，真实 DeepSeek 公网及本地 Agent 模型 provider 后置 |
| 正式设置/历史/调试聊天 | 已决定 | UI/UX 由并行任务维护；正式 IPC、preload、storage 读取仍待接线 |
| 正式打包与发布 | 已决定 | 正式包当前按设计排除隔离入口和 Pi 开发依赖 |

## 3. 冲突区登记

以下路径在 2026-08-09 的工作树中已有并行任务改动，本目标暂不写入、不暂存、不提交：

| 冲突区 | 所属并行任务 | 本目标策略 |
|---|---|---|
| `src/caption/**`、`src/toolbar/**`、`src/history/history-view.tsx`、`src/settings/settings-view.tsx` | 字幕系统前台交互 | 避让；只在接口合同中提出未来接线，不改 renderer |
| `src/main.js`、`src/main/**`、`src/preload/**`、窗口交互相关测试与脚本 | 字幕系统后台交互和窗口生命周期 | 避让；正式 IPC 落地延后到并行改动提交后 |
| `src/agent-mvp/renderer/**`、`docs/agent-ui-ux-handoff.md` | Agent UI/UX 交接模型 | 避让；Stage 0 UI 不作为正式产品接口依据，其 provider key/safeStorage 表单也不得复制到 ADR 0011 的正式产品；独立复核发现 `succeeded → 已完成` 的状态词待该并行任务按语义合同对齐 |
| `docs/current-ui-ux-handoff.md`、`docs/ui-design-brief.md` | UI/UX 交接 | 只读参考，不纳入本目标提交 |

若后续 `docs/semantic-contract.md` 或 `docs/testing-strategy.md` 出现字幕任务的新未提交 hunk，本目标只暂存 Agent 专属 hunk；无法可靠分离时整文件让出并在此登记。

## 4. 里程碑 TODO

| ID | 交付项 | 必须落地的接口/事实 | 阻断证据 | 证据状态 |
|---|---|---|---|---|
| A0 | 闭合隔离入口 | 同 `runId` 中断恢复、renderer 拒绝/取消/Agent 模型 provider 故障、主动重新运行、越权与隐私矩阵 | SEM-F29 / J23 | 联合验收完成 |
| A1 | 冻结正式合同 | `InputReference`、任务/错误闭集、端口、IPC、产物 Schema、ADR 0009 | SEM-F15/F16/F28 / J13/J21/J22/J24 | 已决定 |
| A2 | 正式 SQLite migration | `agent_jobs`、`agent_artifacts`、个人记忆、调试聊天、识别配置与确认关键词表进入新 migration | DB7 / J20/J21/J22/J24 | 实现完成·尚未验收 |
| A3 | 字幕提交边界与对账 | 终态会话、完整输入身份、Agent 处理资格、Agent 与个人记忆自动处理边界、三项后台 Agent 任务幂等补建、删除不复活 | SEM-F00/F28 / J3–J7/J21/J24 | 已决定 |
| A4 | 正式任务运行时 | lease、重试、取消、同 `runId` 恢复、人工幂等键、资源仲裁、退出收束 | SEM-F09/F12/F28 / J7/J21/J24 | 已决定 |
| A5 | 会后结构化纪要 | `transcript-context`、`meeting-minutes`、固定四栏目、证据范围、空数组不臆造、版本化 UI | SEM-T07/T10 / J3–J7/J13/J21/J24 | 已决定 |
| A6 | 增强文本 | 独立派生版本、完整输入覆盖、明确重新生成、不覆盖权威原始转写 | SEM-F16/F28 / J13/J21/J24 | 已决定 |
| A7 | 个人记忆 | 提取/合并插件、三级筛选、范围/冲突/来源/suppression、有界检索、开关休眠 | SEM-F26/F27 / DB7/J21/J24 | 已决定 |
| A8 | 识别 provider、Agent 模型 provider 配置与确认关键词 | 识别 registry/云端识别参考实现；Agent `deepseek/deepseek-v4-flash` main-only 配置表、启动环境凭据、测试替身 registry、冻结预算与资格降级；确认关键词能力声明与下一会话冻结。真实 DeepSeek 公网及本地 Agent 模型 provider 后置 | SEM-F25/F27 / J20/J24 | 已决定 |
| A9 | 正式设置与历史接线 | 受限 preload/exact IPC、任务状态、产物版本、云端披露、provider 公共只读状态、可访问状态通知；不提供 API key renderer IPC | SEM-F14/F28 / J12/J21/J24 | 已决定 |
| A10 | 正式调试聊天 | 默认隐藏、选定终态会话、有界记忆、固定业务工具、执行预览/确认、记录不进记忆 | SEM-F15/F28/T10 / J13/J22/J24 | 已决定 |
| A11 | 打包与验收 | 正式 Agent 代码进入产品包，隔离入口继续排除；core/integration/evidence、package 与适用实机证据闭合 | SEM-T03/T12/T15 / J9/J13/J20–J24 | 已决定 |

## 5. 实施顺序

1. A0 先补齐 J23；这能固定内核错误和恢复语义，但不得提升正式 Agent 状态。
2. A1–A4 建立正式数据与生命周期骨架，且继续保证 Agent 完全不存在时字幕系统独立运行。
3. A5 先形成“终态会话 → 会后结构化纪要 → 历史查看”的最小纵向产品闭环。
4. A6–A8 补齐增强文本、个人记忆、识别 provider、Agent 模型 provider 配置/凭据/冻结/降级与确认关键词；真实 DeepSeek 公网和本地 Agent 模型 provider 留给后续接入。
5. A9–A10 与 UI/UX 并行任务的最终界面对接；发生冲突时继续避让 renderer，优先完成后端接口与测试 fixture。
6. A11 收齐 SEM-T15 的组合门禁，再判定联合、实机与发布验收状态。

## 6. J23 隔离入口阻断组合矩阵

J23 的确定性 Agent 模型 provider 方案与任务领取竞态 gate 只能由测试进程在启动前选择，renderer、preload 和产品 IPC 均不得读取或改变故障方案或调度 gate。除 Agent 模型 provider、系统凭据存储、确定性调度 gate 和应用/utility 强制中断外，场景必须保留真实 React renderer、preload、exact IPC、两个 Electron utility process、`AgentPluginHost`、任务调度、storage worker 与候选 SQLite。跨进程报告只允许稳定枚举、计数、布尔值和身份哈希。

| 场景 | 用户边界 | 必须观察到的结果 | 证据状态 |
|---|---|---|---|
| J23-B01 | 顺利执行调试聊天与参考任务，然后正常重启 | 固定读取工具只执行一次；聊天、任务和产物从 SQLite 恢复，不重复入队 | 联合验收完成 |
| J23-B02 | 用户在执行预览中选择拒绝 | 持久化拒绝确认，但不创建后台 Agent 任务、不调用 Agent 模型 provider、不写产物 | 联合验收完成 |
| J23-B03 | 用户取消尚未领取的后台 Agent 任务 | 任务进入 `cancelled`，`errorCode=null`，重启后不恢复，不写产物 | 联合验收完成 |
| J23-B04 | 用户在 claim 已提交但宿主尚未登记 `running` 的窗口取消，或取消已经调用 Agent 模型 provider 的 `running` 任务 | 前一竞态必须在调用 Agent 模型 provider 前收束；后一场景传播 AbortSignal，取消/租约校验拒绝迟到提交；两者最终均为 `cancelled` 且无产物 | 联合验收完成 |
| J23-B05 | Agent 模型 provider 返回 408 | 映射为 `AGENT_PROVIDER_TIMEOUT`，预算内沿用同一 `runId` 重试并只提交一个产物 | 联合验收完成 |
| J23-B06 | Agent 模型 provider 返回 429 | 映射为 `AGENT_PROVIDER_RATE_LIMITED`，预算内沿用同一 `runId` 重试并只提交一个产物 | 联合验收完成 |
| J23-B07 | Agent 模型 provider 返回网络错误或 5xx | 映射为 `AGENT_PROVIDER_UNAVAILABLE`，预算内沿用同一 `runId` 重试并只提交一个产物 | 联合验收完成 |
| J23-B08 | Agent 模型 provider 鉴权失败 | 第一次尝试后以 `AGENT_PROVIDER_AUTH_FAILED` 进入 `failed`，不自动重试、不写产物 | 联合验收完成 |
| J23-B09 | Agent 模型 provider 返回不符合固定 Schema 的输出 | 第一次尝试后以 `AGENT_OUTPUT_INVALID` 进入 `failed`，不自动重试、不写产物 | 联合验收完成 |
| J23-B10 | 模型经真实 Agent utility 请求未授权工具、递归委派或任意 shell/进程/文件/网络/SQL 能力 | 请求必须到达真实 Pi Tool Calling 与 `AgentPluginHost` 权限边界并 fail closed；任务以 `AGENT_PERMISSION_DENIED` 终止且字幕系统未启动 | 联合验收完成 |
| J23-B11 | 后台 Agent 任务领取后应用被强制中断并重新启动 | 只在租约过期后回收；沿用同一 `runId`，增加尝试次数并最多提交一个产物 | 联合验收完成 |
| J23-B12 | Agent utility 在任务执行中退出并由宿主替换 | 当前尝试映射为 `AGENT_WORKER_EXITED`；替换后的 utility 沿用同一 `runId` 恢复，不重启 storage utility | 联合验收完成 |
| J23-B13 | 用户明确再次生成同一输入；同一确认动作经 renderer/preload/exact IPC 被并发或顺序重复投递 | 新动作创建新 `runId` 和产物版本；同一 `clientIdempotencyKey + requestDigest` 只创建一项任务并返回同一 `runId` | 联合验收完成 |
| J23-B14 | SQLite 已提交后 renderer reload | renderer 经 preload/IPC 重读权威 snapshot；已有状态、消息和产物可见且不重新入队 | 联合验收完成 |
| J23-B15 | `safeStorage` 不可用后设置云端凭据，并重启开发入口 | 当前进程只显示会话凭据；凭据文件不存在，重启后凭据不可用 | 联合验收完成 |
| J23-B16 | strict reader 扫描运行 stdout/stderr、跨进程报告实际序列化内容、候选 SQLite 与受控数据文件，并对正式包执行布局负扫描 | 扫描器不得信任报告内自报布尔值；动态哨兵证明实际内容不含内部思维过程或受控凭据，并拒绝现场音频或音频路径、原始 Error/stack、本地绝对路径；报告不含合成字幕正文，正式包排除 Agent 开发入口、Pi 依赖与 renderer 产物 | 联合验收完成 |

## 7. J24 正常使用边界组合矩阵

所有 J24 场景使用真实 storage worker、SQLite migration、`AgentPluginHost`、job runner、正式 preload/IPC 和对应 renderer。只有 Agent 模型 provider、云网络、启动环境凭据、声卡与操作系统权限可以使用受控替身；不得用内存 repository、直接调用最终 writer 或 renderer 内 fixture 替代产品内部模块。测试必须说明独立用户风险与旅程位置；文档关键词正则、重复相同可观察结果的低层旅程或固定内部调用次序不构成产品证据，应合并或删除。

D3 先闭合 A2–A4 的正式存储与生命周期骨架，不触碰并行维护的 renderer。其阻断切片已登记为：DB7/ADR 0010 的 v2 → 正式 Agent v3 与交叉 catalog fail closed；J24-B01/B26 的资格优先级；J24-B04/B25 的三项任务同输入身份和重复对账幂等；J24-B05/B07/B08/B09/B11/B12/B13/B14/B18 的租约、回复重放、人工幂等、取消、错误分类、冻结 Agent 模型 provider 快照、个人记忆自动处理边界与多会话领取；J24-B21/B29/B30 的完整精修输入、陈旧输入与隐私负扫描。该切片在缺少正式 PluginHost、preload/IPC 和 renderer 前最多只能标为“实现完成·尚未验收”，不能提高 J24 状态。

D4 的 A5 UI-free 后端纵切现为实现完成·尚未验收：`agent.readInputSnapshot` 以完整 `InputReference` 复算并按所选 `event_order` 返回冻结字幕快照；`agent.claimNextJob.availableTaskKinds` 保证宿主只领取当前已装载能力；正式 `transcript-context` / `meeting-minutes` 经真实 `AgentPluginHost`、`ModelGateway`、Pi Agent Loop、确定性输入规划和 storage worker 原子提交运行，只在 Agent 模型 provider 边界使用契约替身。J24-B02/B03/B06/B10/B12/B19/B20/B21/B27/B28/B29 的后端子边界已覆盖短输入、完整精修稿、Unicode 长输入、保守归并预算、重试、取消、插件卸载、空栏目、身份臆造拒绝、陈旧输入与原子提交；仍不包含正式 `MeetingStopped`、preload/IPC、renderer、utility-process transport、`mic`/`loopback` 实机组合或其余两项后台 Agent 任务，不能提升完整 J3/J13/J21/J24。

D5 的 UI-free 后端纵切现为实现完成·尚未验收：正式 `enhanced-transcript`、`memory-extraction` 与任务内 `memory-consolidation` 插件、固定 recipe/模型操作闭集和 job runner writer 分流均纳入该后端纵切；组合使用真实 storage worker、SQLite、PluginHost、job runner、`ModelGateway` 与 Pi Agent Loop，只在 Agent 模型 provider 边界使用替身。J24-B19/B22/B25/B28/B31 已覆盖插件依赖或运行中卸载不误领/不迟交、重复来源与冲突 revision、明确内容优先、每个旧来源 digest suppression、幂等单条删除和回复重放、三项任务共享同一 `InputReference` 且独立成败、增强文本归并失败不留部分产物，以及明确决定保留、噪声/低价值候选与无身份显式/自动全局偏好丢弃。记忆仍只直接读取冻结字幕快照，不读取会后结构化纪要。D5 不包含正式 UI、`MeetingStopped`、utility-process transport、记忆检索或确认关键词，因此不提升完整 J21/J24。

D6 的 A4 正式 storage utility transport 子边界现为实现完成·尚未验收：测试进程只替代 Agent 模型 provider，内部保留 production `StorageWorkerHost`、Electron `utilityProcess`、`StorageWorkerService`、正式 SQLite migration、`AgentPluginHost`、`ModelGateway`、Pi Agent Loop 与 job runner。组合先用真实 utility 创建并关闭无音频合成终态会话，再对账三项任务；首项 claim 已提交但尚未调用 Agent 模型 provider 时，测试捕获该次真实 storage child、强制结束它并等待同一 child 的退出结果，随后确认 replacement 在重放当前策略前 fail closed，租约到期后沿用同一 `runId` 恢复，并证明重复对账不增加 job、两项产物与个人记忆只各提交一次。父测试不信任报告自报结论，而是独立只读检查 SQLite 状态、attempt、`runId`、输入 digest、产物/记忆计数和 schema，复算身份哈希，并扫描 stdout/stderr、报告与隔离数据文件中的动态凭据哨兵、正文、音频类、路径及原始 Error/stack。该子边界仍不接入 `src/main.js`/正式 `StorageGateway`、`MeetingStopped`、Agent utility、preload/IPC、renderer、活动字幕会话资源仲裁或正式包，也未在 transport 层注入提交成功但回复丢失后的 replacement，因此不能提升完整 J7/J21/J24。

| 场景 | 用户边界 | 必须观察到的结果 | 证据状态 |
|---|---|---|---|
| J24-B01 | 终态会话没有首次稳定转写 | 不创建三项后台 Agent 任务、不调用 Agent 模型 provider；历史明确显示没有可处理的已提交正文 | 已决定 |
| J24-B02 | 终态会话很短但至少有一段正文 | 不设任意时长门槛，仍按完整输入生成；无结论/待办/风险时返回空数组 | 已决定 |
| J24-B03 | 正文超过单次 Agent 模型 provider 上下文 | ADR 0009 的确定性分块覆盖全部字幕段；任一分块失败时不提交部分产物 | 已决定 |
| J24-B04 | `MeetingStopped`、启动扫描和 worker replacement 重复对账 | 每种自动任务只有一个 dedupe identity，不产生重复当前产物 | 已决定 |
| J24-B05 | job 领取已提交但 IPC 回复丢失，或领取后、Agent 模型 provider 调用前应用退出 | 同一 claim idempotency key 重放只返回原任务/租约或空结果，绝不误领下一项任务；租约过期后沿用同一 `runId` 恢复，字幕历史不受影响 | 已决定 |
| J24-B06 | Agent 模型 provider 已返回、产物提交前 worker 退出 | 不暴露未提交产物；恢复后同一 `runId` 重新执行并只提交一次 | 已决定 |
| J24-B07 | SQLite 已提交但 IPC 回复丢失或 renderer reload | UI 重读权威 snapshot，显示既有 job/产物，不重新入队 | 已决定 |
| J24-B08 | 用户双击“重新生成”或 IPC 重放 | 同一 client idempotency key 返回同一 job；新的明确动作才创建新 `runId` | 已决定 |
| J24-B09 | 用户取消 queued/retry_wait job | 立即进入 `cancelled`，重启和对账不恢复该人工 run | 已决定 |
| J24-B10 | 用户取消 running job，随后出现迟到 Agent 模型 provider 结果 | AbortSignal 生效；迟到结果因取消/租约校验被拒绝，不写产物 | 已决定 |
| J24-B11 | Agent 模型 provider 出现 408、429、网络或 5xx | 在固定预算内退避并沿用同一 `runId`；不形成重试风暴，不阻塞字幕 | 已决定 |
| J24-B12 | 凭据失效、输出 Schema 错误、越权或参数错误 | 直接 `failed`，不自动重试；显示稳定错误和下一动作 | 已决定 |
| J24-B13 | queued/running 期间部署新的 main-only provider 配置表或 recipe，并在稍后重启应用 | 既有 job 保持冻结 provider/model/recipe/预算；只有重启后新建 job 使用新配置，不在运行中读取文件或环境变量并静默切换 | 已决定 |
| J24-B14 | memory job queued/running 时关闭个人记忆，关闭期间另有会话进入终态，随后重新开启 | 只取消记忆任务并拒绝迟到提交；纪要、增强文本与字幕继续。重新开启写入新的个人记忆自动处理边界，不复活已取消任务，也不自动补处理关闭期间或更早会话；用户明确请求重新提取仍需当前开关与资格满足 | 已决定 |
| J24-B15 | 本地 Agent job 运行时开始新字幕会话 | 本地 job 有界停止并进入可重试状态；新字幕会话优先 | 已决定 |
| J24-B16 | 云端 Agent job 运行时开始新字幕会话 | 云端请求可继续，但 SQLite 回写和 UI 更新保持有界 | 已决定 |
| J24-B17 | 会话删除时存在 queued/running job、产物、聊天和记忆来源，删除回复丢失后请求重放 | 同一 storage worker 先写 tombstone 再受控清理；拒绝迟到提交、清理仅由该会话支撑的记忆，相同 deletion idempotency key 不影响其它会话，后续对账不复活 | 已决定 |
| J24-B18 | 多个终态会话连续到达 | FIFO 与并发预算确定，单个失败或限流不饿死其它会话 | 已决定 |
| J24-B19 | 插件超时、异常、卸载或请求未授权能力 | 当前未装载的任务不被领取；运行中的失败只隔离该插件/job；字幕、其它任务和历史保持不变 | 已决定 |
| J24-B20 | 纪要正文没有明确负责人或期限 | `owner/due` 为 `null`，不得根据音频来源或第一人称臆造身份 | 已决定 |
| J24-B21 | 用户在 job 运行后选择另一正文版本，或选择精修覆盖不完整的混合显示正文 | 原 job 继续绑定原 `InputReference`；重新生成以新输入身份创建新版本。`refined` 只接受整场 `N=M` 的完整精修稿，不完整混合显示正文在 Agent 模型 provider 调用前被拒绝，用户可改选权威原始转写 | 已决定 |
| J24-B22 | 个人记忆出现重复、冲突、用户删除后旧输入再次扫描 | 增加来源或 revision；明确内容优先；suppression 阻止旧来源重建 | 已决定 |
| J24-B23 | 首次启动没有 `DEEPSEEK_API_KEY`，key 为空白或超出 4096 个 UTF-8 字节，main-only provider 配置表/ConfigStore v2 Agent 字段损坏，运行中后来设置环境变量，或以完整启动环境重启 | key 缺失/不合法返回 `credential_unavailable`，配置表损坏返回 `provider_not_configured`，非法 Agent 设置 fail closed 为 Agent 关闭；均不创建/领取任务、不调用 Agent 模型 provider、不写产物，字幕系统继续。正式 main 在任何窗口或子进程创建前删除 key，所有子进程环境均无该变量；只有 Agent utility 当前调用收到私有副本。运行中注入仍保持降级，重启后合法配置、有效 key、云端披露、Agent 总开关、时间边界与终态已提交正文共同满足才可得到 `ready`；DeepSeek 云端分支不要求本地 Agent 模型就绪 | 已决定 |
| J24-B24 | 状态快速变化、键盘操作、失败后重试及 renderer 重载 | 权威状态可聚焦、可读且通过 live region 通知；不只靠颜色，不重复动作 | 已决定 |
| J24-B25 | 一条正常终态会话进入自动处理 | 三项后台 Agent 任务绑定同一输入身份并独立运行；一项失败不阻塞另外两项，各自只提交自己的产物或记忆结果 | 已决定 |
| J24-B26 | 自动请求早于自动处理时间边界，或 Agent 总开关关闭、Agent 模型 provider 未配置、云端披露未确认、凭据不可用、本地模型未就绪 | 按固定优先级返回 `outside_automatic_window` 或对应 Agent 处理资格，不创建/领取任务、不调用 Agent 模型 provider；用户明确请求可忽略时间边界但不能绕过其它条件 | 已决定 |
| J24-B27 | 输入恰好位于上下文预算、超过一单位，或单个字幕段本身超预算 | 预算边界可重复；超长单段按 Unicode code point 范围完整分片，不切 surrogate pair、不丢字符 | 已决定 |
| J24-B28 | 全部分块成功后归并失败，或归并期间 worker 退出 | 不提交部分产物；沿用同一 `runId` 从冻结输入重新执行，最终最多一个产物 | 已决定 |
| J24-B29 | 请求或提交使用陈旧 `inputWatermark/inputDigest/transcriptVersion` | storage worker 复算后在 Agent 模型 provider 调用前或 writer 提交前拒绝，不读取超前投影、不写产物 | 已决定 |
| J24-B30 | 任务、聊天、退出恢复和报告经过隐私负扫描 | SQLite/日志/报告不含现场音频、音频路径、凭据、本地绝对路径、原始 Error/stack；报告不含字幕正文 | 已决定 |
| J24-B31 | 个人记忆正常提取同时包含明确决定、噪声和无身份第一人称表达 | 明确决定可进入长期结构化记忆，噪声丢弃，无身份表达不得静默成为全局个人偏好 | 已决定 |
| J24-B32 | 调试聊天读取终态会话、显示工具事件、预览并确认固定任务后重启 | 聊天与任务从独立 SQLite 恢复，不进入个人记忆；拒绝确认时不创建任务 | 已决定 |
| J24-B33 | `mic` 与 `loopback` 单路会话分别组合精修、暂停/恢复、worker replacement、设备丢失、系统休眠/恢复与 Agent 模型 provider 失败 | 来源始终互斥；暂停/恢复与 worker replacement 不改变会话和输入身份，设备/休眠故障按 J6 明示重试或进入终态；会后结构化纪要和字幕历史只消费已提交正文且不重复，Agent 失败不改变字幕事实，符合 SEM-T07/J3–J7 | 已决定 |

## 8. 外部参考及采纳范围

- [Microsoft Teams Recap](https://support.microsoft.com/en-us/teams/meetings/recap-in-microsoft-teams)：AI recap 依赖已经转写的会后内容，并明确可能不准确。采纳“正文先于派生产物、用户能回看来源”的边界，不采纳其账号和录制体系。
- [Google Meet Take notes for me](https://support.google.com/meet/answer/14754931?hl=En)：明确处理会后生成、用户同意、连接问题、短会话和未生成结果。采纳显式云端披露、空/短会话与失败可见性；不照搬 15 分钟建议阈值。
- [Zoom Meeting Summary Templates](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0080366)：摘要依赖 transcript，用户可在会后查看和切换模板。采纳“输入存在性与版本化重新生成”，不进入首版自定义模板。
- [Azure Asynchronous Request-Reply](https://learn.microsoft.com/en-us/azure/architecture/patterns/asynchronous-request-reply)：异步操作公开持久状态、取消和幂等键。采纳 SQLite job 作为权威状态，不让一次 IPC 回复成为事实来源。
- [Azure Retry Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/retry)：只对短暂故障做有界重试，并区分不可重试错误。采纳单层重试、固定预算和稳定错误分类。
- [Stripe Idempotent Requests](https://docs.stripe.com/api/idempotent_requests)：连接失败后的重复请求由同一幂等键返回既有结果。采纳人工动作的 client idempotency key + request digest。
- [W3C ARIA19](https://www.w3.org/WAI/WCAG21/Techniques/aria/ARIA19)：动态错误通过 live region 通知辅助技术而不强制移动焦点。采纳 J24-B24；具体视觉样式由 UI/UX 交接任务决定。
- [Electron `utilityProcess`](https://www.electronjs.org/docs/latest/api/utility-process)：D6 采纳 `app.whenReady()` 后创建 utility、`serviceName` 角色标识、`postMessage`/`parentPort` 通信、`error` 后等待同一 child 的 `exit`，以及结束 exact child 后才允许 replacement；该 API 参考不替代 J24 产品旅程证据。
- [DeepSeek API Change Log](https://api-docs.deepseek.com/updates/) / [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)：官方当前登记 `deepseek-v4-flash` 与 OpenAI-compatible `https://api.deepseek.com`。首版只采纳 provider/model/base URL 默认值和可替换配置形状；不把可变价格、上下文窗口、输出上限、供应商可用性或模型质量写入产品语义。

## 9. 每批改动的验证与提交纪律

每个较大批次执行以下闭环：

- [ ] 重新读取 `CONTEXT.md`，逐项核对需求、测试名、报告字段与提交信息。
- [ ] 先更新适用 SEM 行和 J/DB/I 旅程，再修改实现。
- [ ] 避让第 3 节冲突区，只暂存本目标拥有的文件或可分离 hunk。
- [ ] 运行受影响的定向测试，再运行 `npm run test:core`、`npm run test:integration`、`npm run test:evidence`。
- [ ] 每条新增或保留测试能指出独立 `SEM-*`、`J* / DB* / I*` 风险；相同路径、相同失败、相同可观察结果的重复低层测试已合并或删除，且没有用源码/文档正则冒充产品旅程。
- [ ] 使用 `gpt-5.6-luna`、`max` 推理强度的独立审阅 Agent 复核语义、真实模块边界、失败路径与 CI 组合。
- [ ] 修复复核问题并复跑；结构化报告继续满足 SEM-F14。
- [ ] 只在当前工作区验证成立后提交本批文件，并在本表更新证据状态和提交 SHA。

## 10. 批次记录

| 批次 | 范围 | 独立审阅 Agent | 本地验证 | 提交 | 证据状态 |
|---|---|---|---|---|---|
| D1 | TODO、接口合同、ADR 0009、SEM-F28/SEM-T15、J24 与设计契约测试 | Luna/max：首轮提出 P1/P2；二轮 P1/P2 无剩余；末轮 P3 五项随后按建议对齐 | 设计合同 1/1；Agent 定向组合 18/18；core 504/504；integration 34/34；evidence 227/227 | `1007cc8` | 已决定 |
| D2 | SEM-F29/J23 隔离入口的取消竞态、错误分类、重试/中断恢复、utility replacement、六类越权、确认幂等与严格隐私矩阵 | Luna/max：首轮 3 项 P2、二轮 1 项 B16 P2，修复后最终复核 P1 无、P2 无；并行 UI 状态词登记为冲突区 P3 | core 507/507；integration 39/39；evidence 227/227 | `a68fcfd` | 联合验收完成 |
| D3 | 正式 v3 migration、Agent 处理资格与自动对账、任务生命周期/幂等结果、个人记忆来源完整性和会话 tombstone 删除子边界 | Luna/max：首轮指出 claim 策略、结果/删除、回复重放及跨表完整性等 P1/P2；修复后末轮补齐个人记忆复合来源与陈旧续租拒绝，最终复核 P1 无、P2 无 | 定向组合 53/53；core 514/514；integration 50/50；evidence 227/227 | `9d28f6b` | 实现完成·尚未验收 |
| D4 | 冻结输入读取、已装载任务领取闭集、正式纪要插件/宿主、确定性规划与归并、`ModelGateway` + Pi Loop、job runner 与原子产物提交后端纵切 | Luna/max：首轮指出运行中插件卸载、完整精修稿顺序两项 P1 与归并预算前置一项 P2；补齐 active abort/提交前重验、按所选事件顺序排序及零 provider 调用预检后，二次复核 P1 无、P2 无 | 定向组合 46/46；core 519/519；integration 56/56；evidence 227/227；I3 非音频报告由安全生成器重建且保持 `partial` | `daea3f6` | 实现完成·尚未验收 |
| D5 | 增强文本、记忆提取/任务内合并、writer 分流、三项同输入独立执行、正式 v4 suppression 身份与单条个人记忆删除 | Luna/max：首轮指出无身份显式全局偏好、缺少正式删除命令旅程与 storage owner 校验三项 P2/P3；补齐后第二轮复核 P1 无、P2 无，保留 utility-process/正式 UI 证据边界 P3 | 定向组合 57/57；core 523/523；integration 60/60；evidence 227/227；I3 非音频报告只再绑定安全哈希且保持 `partial` | `589c284` | 实现完成·尚未验收 |
| D6 | production `StorageWorkerHost` storage utility transport、策略先行、claim 后 exact-child 强制退出与同 `runId` 恢复、三项任务幂等提交 | Luna/max：首轮指出 exact-child 断言可能误报与隐私结论过度依赖自报两项 P2；补齐 captured child/exit 同一性和父测试独立 SQLite/文件负扫描后，最终复核 P1 无、P2 无；保留 transport 层提交回复丢失后的 replacement 场景 P3 | D6 定向 2/2；D3–D6 相关组合 62/62；core 523/523；integration 62/62；evidence 227/227 | `6765ce8` | 实现完成·尚未验收 |
| D7 | ADR 0011 的 DeepSeek main-only 配置表与启动环境凭据规则、ConfigStore v2 Agent 设置迁移合同、exact origin/凭据隔离、J24-B23 边界和 Agent 测试去重规则 | Luna/max：首轮指出凭据删除时序一项 P1，以及 ConfigStore 现状、旧 ADR、本项目术语和任意 HTTPS 地址四项 P2；改为早于所有窗口/子进程删除、main-only 配置表、直接改写旧 ADR、沿用 CONTEXT 术语并冻结 DeepSeek origin 后，二次复核 P1 无、P2 无；随后采纳“先无条件删除再校验”和 revision 原子更新两项 P3 | core 523/523；integration 62/62；evidence 226/226；删除 1 条只检查文档关键词的 Agent 设计正则测试 | `67d112c` | 已决定 |
