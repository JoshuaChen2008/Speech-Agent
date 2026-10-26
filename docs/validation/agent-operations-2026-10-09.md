# 2026-10-09 Agent 产品操作收敛验证记录

状态：**实现完成·尚未验收**。对应 E `consolidate-agent-operations`，关联 SEM-F31/F33/F38/F40、SEM-F14、SEM-T01/T02/T03/T04/T05，以及 J22/J25/J26/J29/J30/J12、J9-CI/I3。实施前已在语义合同与旅程矩阵登记。

## 受测输入与实现边界

本轮在既有工作区继续实施 E，未提交或归档变更。工作区已有 A/B/C/D 与其它界面改动，保留这些在途内容；下述全量结果属于整个当前工作区，不能只归因于 E。

受测 Git 基点为 `d06d139f66da67fda8ac280666bedc6f9b6ead9b`。最终 `src/`、`scripts/`、`test/`、`package.json` 和 `package-lock.json` 共 721 个文件：以仓库相对路径排序，对每个文件的原始字节求 SHA-256，再以 `path + LF + fileSha256 + LF` 累积，得到源码指纹 `8dd4c91b0ee4969de99a8dd47aa863cac0ec083dafb247dfa204eb3192cf7a27`。后续仅同步文档与任务状态，不改变该受测源码。

- 正式 main 只构造 `AgentOperationService`。它持有请求受理、冻结输入/记忆政策、调度、取消、明确继续、运行进度和诊断操作；范围、资格及历史投影由 `AgentInteractionReader` 复用。两个旧 service 模块只保留仍有调用者的兼容导出，没有第二份产品操作实现。
- main/preload/renderer 迁移到同一操作服务，会话总结与会话问答使用 `operations.submit/getSnapshot/cancel/resume`；日期/项目问答及旧交互合同保留原版本解释。现有 IPC exact 校验、窗口 access policy、模型配置、个人上下文和正式 Agent 交互导出边界保持原合同。
- 同键重放先查询已持久受理，复用原请求身份及冻结来源，不重新读取资格或来源。预设总结固定路由，自由问题保留受限路由；持久受理回执先于目标调度。
- 取消先核验持久 request/generation。旧代次不 abort 当前控制器或发出 scheduler 信号；合法取消先发信号再请求持久取消，落库未知返回 `verify_state`。结果及成功终态仍在原 SQLite 事务中提交，迟到响应不改变持久终态。
- 重开 Agent Bar 会从持久快照恢复正在运行的请求、状态卡片和轮询，并阻止重复提交；旧 generation/revision 通知被丢弃。关闭窗口不隐式取消。重启后的预设总结等待用户明确继续，沿用同一 run、模型绑定和剩余预算创建新 attempt；自由问题只允许重新输入，原提示不落盘。
- D 的唯一 Pi 循环、C 的逐 exchange 凭据借用与清零、原 schema migration SQL/checksum 和旧导出编码均未改写。诊断故障不改变 Agent 产物终态。

调用者清单与保留差异见 [E 设计](../../openspec/changes/archive/2026-10-11-consolidate-agent-operations/design.md)，职责见 [运行架构](../runtime-architecture.md)。

## 用户旅程与失败证据

| 边界 | 本轮证据 |
|---|---|
| J30-ACCEPT | J30 直接组合真实 `AgentOperationService`、模型接入层、路由、Pi、SQLite 与生产 preload；同键重放、受理回执丢失、输入身份冲突及模型外发前持久身份成立。正式 Electron 在实际受理提交后丢弃一次 IPC 回执，界面显示未知并同键重放，只有一个目标模型请求。 |
| J30-CANCEL/STATE | 新回归先复现旧 generation 取消会 abort 当前运行，修正后拒绝且零取消信号。正式 Electron 用隔离 SQLite 故障触发器拒绝取消写入，观察“取消状态尚未确认”，恢复写入后明确核对终态；网络迟到结果不能覆盖取消事实。 |
| J30-STATE | 正式 Electron 丢弃状态通知、关闭/重开窗口，重新读取同一请求并恢复状态卡片与提交保护；UI 回归验证轮询及旧 generation/revision 丢弃。新增重开回归最初 56/57，修复后 57/57。 |
| J30-RECOVERY | 正式 Electron 两阶段重启，继续前零模型请求；点击继续后同一总结 run 新 attempt 收束。并行失去自由问题提示的请求拒绝 resume，界面保留空输入，用户重新输入后新建请求并保存结果。 |
| J12/J30-INDEPENDENCE/DIAG | Agent 缺席、非合作网络等待、取消及诊断写入失败期间，从字幕提交边界开始使用真实 recorder/gateway/SQLite/history 开启、持久化、关闭下一会话并读取字幕历史；文本导出及诊断隐私负扫描保留。此增量不证明物理采集、真实 ASR 或声卡行为。 |
| J26/J29/J31 | 完整 Integration 同时执行旧交互导出、总结记忆政策、保存/重读、长输入覆盖与累计预算/恢复回归；没有据此提升 B 的完整资源与实机矩阵。 |

正式 Electron 的 renderer、preload、main、调度、模型接入层、执行宿主及 storage utility/SQLite 使用生产实现。新增替身仅用于网络、系统保存对话框和受控 IPC/存储写故障边界。J30 的另一条旅程以同步 IPC 运输连接真实 SQLite service；独立性增量的起点与范围按上表明确限定，不将提交边界证据解释为完整音频旅程。

诊断与证据不写入字幕/提示/工具正文、凭据、原始 provider 事件、现场音频、本地绝对路径、设备名、时钟偏移或绝对单调时刻；正式 Agent 交互导出仍经独立的用户明确保存流程。

## 实际命令与结果

| 命令 | 结果及适用范围 |
|---|---|
| `npm run verify:renderer` | 返回 0；类型检查与生产 renderer 构建。 |
| `npm run test:focus -- test/ui/agent-ui.test.js` | 最终 57/57；包含运行中请求重开、轮询和旧通知拒绝。 |
| `npm run test:focus -- test/integration/agent-redesign-j25-formal-settings-journey.test.js` | 最终 2/2；正式请求控制旅程与应用重启/显式继续/自由问题重输。 |
| `npm run test:focus -- test/integration/agent-redesign-j25-formal-settings-journey.test.js test/integration/personal-memory-file-journey.test.js` | 8/8；用于核对既有文件恢复失败的执行边界。 |
| 前两轮 `npm test` | 各为 Core 1213/1213、Integration 173/174，返回 1；Evidence 因 Integration 非零未执行。两次均是 J28-FILES 尚未写入阶段操作恢复后的个人记忆数量断言 `0 !== 1`，没有改写为成功。 |
| 最终当前源码 `npm test` | **返回 0**；Core **1214/1214**、Integration **174/174**、Evidence **248 项符合预期、1 项按设计跳过、0 失败**。三条 lane 在同一次调用中执行；唯一跳过项为未明确请求的原生本地降级资格。 |
| `$env:TZ = 'UTC'; node scripts/i3-nonaudio-soak.js --report docs/validation/i3-nonaudio-results.json` | 返回 0；以原生成器刷新当前产品载荷绑定，3600 段、4000 事件、虚拟两小时。 |
| `node scripts/verify-i3-nonaudio-report.js docs/validation/i3-nonaudio-results.json` | 返回 0；`gateStatus=partial`、`realTwoHourAudioSoak=false`，没有降低 verifier 或扩大证据口径。 |
| `openspec validate consolidate-agent-operations --strict --json`、`git diff --check` | 返回 0；artifact 与改动格式核对。 |

最终 Core/Integration/Evidence 分别耗时约 49.6 / 95.1 / 18.9 秒。完整测试同时刷新既有合成检索报告的计时值，保留该自动生成差异。I3 的最终产品载荷摘要为 `7c149019cae3d9ce90ce36bfe6066df65a16ed567f8e03114789952599000b1c`。

J28-FILES 的同一断言在 [2026-10-04 同步记录](main-sync-2026-10-04.md) 已有重复失败。此次没有修改个人记忆文件产品实现或放宽恢复断言，仅在失败时补充文件状态、操作阶段、快照及索引计数。局部复测与最后全量均取得预期结果；间歇失败的根因尚未确认，不据此声称已修复。

## 未验证范围与后续边界

- 本轮没有真实公网 DeepSeek/Qwen/generic 模型、真实 Win11 safeStorage、物理麦克风/系统音频、DWM、交互安装、B5/I4 或干净机证据；正式 Electron 受控网络旅程不替代这些实机范围。
- I3 仍是虚拟非音频预资格，不能证明真实两小时音频稳定性。A 尚为 9/10，B 尚为 30/46；本轮不替其它 change 勾选未验证任务，也不提升完整 J31 或 Agent Bar 产品链路的联合验收状态。
- E 的 9 项实施/验证记录任务已逐项核对；状态保持实现完成·尚未验收。变更未归档，未提交，未推送。
