# 2026-10-11 Agent 重构主 spec 同步与归档核对

状态：**实现完成·尚未验收**。本次处理 C/D/E 的 OpenSpec 变更生命周期与文档投影，关联 SEM-F14/F28/F31/F33/F38/F39/F40、SEM-T05/T15 及 J22/J24/J25/J29/J30/J31/J12。归档不提升能力验收状态；要求仍以 [语义合同](../semantic-contract.md) 为准。

## 主 spec 与归档记录

| 切片 | 任务勾选 | 主 spec | 归档实施记录 |
|---|---|---|---|
| C | 9/9 | [agent-provider-exchange](../../openspec/specs/agent-provider-exchange/spec.md) | [separate-agent-provider-protocol](../../openspec/changes/archive/2026-10-11-separate-agent-provider-protocol/tasks.md) |
| D | 10/10 | [agent-runtime-ownership](../../openspec/specs/agent-runtime-ownership/spec.md) | [centralize-agent-runtime-loop](../../openspec/changes/archive/2026-10-11-centralize-agent-runtime-loop/tasks.md) |
| E | 9/9 | [agent-operation-facade](../../openspec/specs/agent-operation-facade/spec.md) | [consolidate-agent-operations](../../openspec/changes/archive/2026-10-11-consolidate-agent-operations/tasks.md) |

归档前三个 `openspec status --change <change-name> --json` 均为 `schemaName=spec-driven`、`isComplete=true`，proposal/design/specs/tasks 均为 done；28 项任务全部勾选，无未勾选项。三份 delta 均为 ADDED Requirements：C 为 4 条要求/7 个场景，D 为 5 条要求/8 个场景，E 为 5 条要求/6 个场景；同步主 spec 保留全部 14 条要求/21 个场景。D 的首条要求将切片字母引用改为规范的“Agent 模型接入层的单次 exchange”，行为不变。

归档目录采用用户时区的本日日期 `2026-10-11`；完整目录移动保留 `.openspec.yaml`、proposal、design、delta specs 与 tasks。推进计划、运行架构及验证记录的相对链接同步到归档路径，归档内部跨切片链接和仓库文档链接同步到新目录深度。

## 当前职责与记录修正

- Agent 模型接入层封装冻结绑定与调用级凭据，provider adapter 只提供单次 exchange。C 的旧 adapter.run/runWithBinding 是历史实施基线，D 已删除其循环、工具与重试控制。
- Agent 执行宿主通过经资格验证的 Pi 0.84.1 运行唯一循环，工具串行，保持真实持久预留、冻结模型、预算与重试政策。
- 正式 main/preload/renderer 复用唯一 AgentOperationService，保留 SQLite 权威快照、原子终态、取消未知状态与用户明确继续。
- C 的“D 尚未实施”改为已核对的后续实施事实；历史接线段落明确标注时点。SEM-F39 主行同步正式长输入执行链的局部实现事实，完整矩阵与实机要求仍保留。

## 证据与实际命令

本次未修改 `src/`、`scripts/`、`test/`、`package.json` 或 `package-lock.json`。按 [E 验证记录](agent-operations-2026-10-09.md) 的方法，对 721 个文件的相对路径和原始字节摘要排序累积，得到源码指纹 `8dd4c91b0ee4969de99a8dd47aa863cac0ec083dafb247dfa204eb3192cf7a27`，与 2026-10-09 全量受测指纹一致。按 testing-strategy §2.1 复用该记录的 Core 1214/1214、Integration 174/174、Evidence 248 项符合预期及 1 项按设计跳过的证据，不把纯文档归档写成新的全量产品测试。

| 实际命令/核对 | 结果与范围 |
|---|---|
| `npm run test:focus -- test/main/provider-exchange.test.js test/main/model-access-vault-runtime.test.js test/main/model-test-runtime.test.js test/contracts/model-access-interface.test.js test/contracts/agent-loop-ownership.test.js test/integration/model-access-s2-core-journey.test.js` | 本会话收尾前的执行情况核对：返回 0，56/56、零失败；协议、凭据、模型测试、接口、唯一循环约束及真实 J25 旅程，外部网络/系统凭据受控。 |
| `openspec validate <change-name> --strict --json`，逐项 C/D/E | 返回 0，无 issues；归档前 delta 与规划 artifact 严格核对。 |
| `openspec validate <capability> --type spec --strict --json`，逐项三份主 spec | 返回 0，无 issues；14 条要求与 21 个场景同步后的结构核对。 |
| 归档文件集、任务勾选与主 spec 场景逐项对照 | `.openspec.yaml` 及原文件集保留，任务 9/9、10/10、9/9，所有 delta 要求/场景进入主 spec。 |
| 相对链接核对与 `git diff --check` | 返回 0；新增主 spec、三份归档及受影响的文档链接有效，无格式错误。 |

## 保留的后续边界

- [A](../../openspec/changes/restore-deepseek-session-summary/tasks.md) 仍为 9/10；[B](../../openspec/changes/fix-session-summary-lifecycle-and-long-input/tasks.md) 仍为 30/46，完整容量/资源、覆盖/归并、恢复/迁移故障与实机矩阵继续在其原任务追踪。本次不代其勾选或归档。
- 当前重构尚无本轮真实公网 DeepSeek/Qwen/generic 模型、真实 Win11 safeStorage、物理音源、DWM、B5/I4 或干净机证据。I3 仍为虚拟非音频预资格，不证明真实两小时音频稳定性。
- E 的前两轮全量均出现 J28-FILES 个人记忆文件恢复断言失败，最终全量取得预期结果；根因尚未确认，归档保留该记录，不能声称已修复。
- 完整 Agent Bar 产品链路、A/B 与完整 J31 仍未取得联合验收状态。2026-10-09 验证记录中的“未归档”是当日事实；本日仅归档上述三个实施 change，没有提交或推送工作区改动。
