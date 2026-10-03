# Agent 分阶段推进计划

2026-09-29：A 的轻量修订已决定，其余切片保持原规划。此文件组织切片与依赖，不定义高于 semantic-contract.md 的要求，不构成实现或验收证据。本轮只写规划，既有在途工作不回滚、不勾选、不改写。

## 推进顺序

| 顺序 | OpenSpec | 用户收益与范围 | 出口 |
|---|---|---|---|
| A | [restore-deepseek-session-summary](../openspec/changes/restore-deepseek-session-summary/proposal.md) | 当前架构内修正 JSON/结果校验，以 256,000 token 上下文目标直接总结窗口内完整会话 | 短会话及 173,827 字节规模合成会话生成、保存、重开、取消及下一字幕会话；正式 Electron 和真实 DeepSeek 分别留证，SEM-F33/F38/F40、J25/J29/J30/J12 |
| B | [fix-session-summary-lifecycle-and-long-input](../openspec/changes/fix-session-summary-lifecycle-and-long-input/tasks.md) 的 P2 | 接通超出单次窗口的完整输入规划、分块归并、覆盖与恢复 | J31-SIZE/COVERAGE/MERGE/BUDGET/RESOURCE/RECOVERY/COMPAT，加适用 J29/J30/J12 |
| C | [separate-agent-provider-protocol](../openspec/changes/separate-agent-provider-protocol/proposal.md) | 提取厂商协议的一次模型交换，复用 A 的 JSON 适配 | 单次交换统一合同、错误/用量/工具声明；既有总结旅程不退化 |
| D | [centralize-agent-runtime-loop](../openspec/changes/centralize-agent-runtime-loop/proposal.md) | runtime 统一循环、工具、预算、重试和取消 | 唯一生产循环，全部 recipe 与长输入节点复用，跨 attempt 预算不重置 |
| E | [consolidate-agent-operations](../openspec/changes/consolidate-agent-operations/proposal.md) | UI 通过稳定操作与权威快照使用 Agent | 正式受理、查询、取消、继续、导出/诊断及跨进程恢复旅程 |

优先 A → B，先恢复产品路径，再执行 C → D → E。C 的设计可独立评审；在 B 尚未取得验收证据时，不把架构重构作为推迟当前故障修复的前置条件。三个层是职责分工，不是多 Agent，也不意味着三个进程。

## 容量决策必须分单位

- A 的应用上下文目标为 256,000 token，受模型实际能力限制，包含指令、完整输入、工具消息和输出预留。百万/256k 指 token 窗口，撤销此前误写的 1 MiB 响应扩容要求。
- 单次输出目标 8,192 token，受模型输出能力、剩余输出预算及上下文余量限制。模型配置不被改写，响应和纪要正文容量不随窗口自动扩大。
- A 对齐新总结路径中的 15KB、16KiB、120,000 token 等旧限制；计数方式、实际字节保护值和版本解释先登记 SEM/J，再实现。窗口内完整输入直接交给既有 Loop，超限明确拒绝；不截断，不提前实现分块调度。
- B 继续拥有完整长输入分块与归并，原文 4 MiB/canonical 序列 8 MiB 的既有目标保留。此前由单位误解引出的单次 prompt 1 MiB/HTTP 8 MiB 候选不作为本轮要求；B 实施时与 A 实际登记的容量策略对齐。
- 旧 binding、旧 policy 和旧导出按原版本解释；新容量作用于新运行。优先复用现有版本机制，不预设专用策略表或数据库迁移。

## 与在途变更的分工

B 继续拥有 P2 分页、规划、归并、覆盖、累计预算和恢复；A 不复制这些任务，不把 v2 的部分代码当作已验收长输入。B 的原文/序列容量目标保留。A 先核对新运行的版本选择与窗口内输入限制；B 再接通完整分块路径，不能仅切换到已有 v2 名称就宣称长输入达标。

本轮没有改写 B 的既有 proposal/design/spec/tasks。实施 B 前须把 A 实际登记的窗口与输出策略纳入其规划，检查所有受影响 artifacts，并同步 SEM-F39 与 J31；未登记不得只改常量。原 P1 尚缺的正式取消/恢复/字幕独立旅程仍保留，A 的局部验证不能替它勾选。

clarify-memory-and-session-summary 仍拥有记忆偏好与单会话产品语义，simplify-agent-model-settings 仍拥有设置流程；C/E 只重用接口，不改变这些在途目标。S3 的个人上下文和摄取任务保持独立，受影响回归必须覆盖。

## 目标职责

操作层组合正式 Agent 交互、个人上下文、模型运行绑定和 SQLite；Agent 执行宿主 runtime 执行 recipe 与唯一 Agent Loop；Agent 模型接入层中的 provider adapter 处理单次厂商协议。凭据不进入 runtime/renderer，runtime 不依赖 Electron 或 SQLite 实现。UI 消费运行快照与受控事件，SQLite 仍是任务权威。

参考 [tau 架构](https://twotimespi.dev/internals/architecture/) 的单向依赖和事件合同，不迁入 Python、coding tools、动态插件或 JSONL 历史。参考 [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 的 JSON 与结束原因协议；实施时重新核对当前官方能力。2026-09-29 本机已证明请求缺少 JSON 指令，但没有取得真实服务端拒绝正文的受控分类，根因结论仍需 A 的对比验证。

## 验收纪律

每片先对照 CONTEXT，再登记相关 SEM 和 J 行，再写回归与代码。定向测试遵循 testing-strategy §2.1；阶段联合验收由当前 revision 完整 CI 或本地三条 lane 承担。仅替换 provider/网络/声卡/系统权限等外部边界，内部产品模块使用真实实现。

A 复用既有测试，少量边界回归加一条正式旅程，覆盖窗口内完整会话：点击生成 → 取得合法四栏结果 → SQLite 保存 → 关闭重开仍存在；取消/失败零部分结果；字幕系统继续独立运行。实机验证缺失就保留“实现完成·尚未验收”，不以连接测试成功代替。

实施起点是 A 的 tasks.md。A 不依赖 C/D/E。A 纳入旧 173,827 字节规模输入的适配回归；超出有效窗口的会话明确拒绝，由 B 的分块归并继续承接。
