# D · Agent Loop 所有权与重试验证记录

状态：**实现完成·尚未验收**。关联 SEM-F28/F31/F33/F39/F40、SEM-T15，J22/J24/J30/J31；依赖 C 的单次 exchange。实现前已核对 CONTEXT 全文、ADR0009/0016/0021，并在语义表和旅程矩阵登记行为。

## 实施事实

- `@earendil-works/pi-agent-core` 精确锁定 **0.84.1**；pi-ai/pi-telemetry 以 overrides 固定同一版本，lockfile 保留来源与 integrity。真实核心先在 Node、Electron 主进程及 utility 进程验证请求前、工具前、轮次结束、取消、最大工具并发 1 和零隐式重试，再接入生产入口。MIT 通知随源码保留。
- 全部 21 个固定 recipe 与已接线输入计划节点共用执行宿主 Pi 低层 agentLoop；模型接入层只提供冻结绑定后的单次 exchange，旧 adapter.run/runWithBinding 已删除，模型测试保持单次 exchange。
- 每次实际请求先取得 SQLite 预留确认。未知/重复回执零外发且不自动重放；工具按 provider 顺序执行并保留 `(attempt, call_order)`。参数 JSON、授权或真实工具 Schema 拒绝均阻止后续执行和部分产物，参数拒绝保留原工具调用记录。
- 新 run 使用 `agent-retry@2`：有效 Retry-After 为最早重试时间，否则指数退避加抖动；等待可取消并受总期限限制。null/@1 保持原有延迟与最多五次单操作解释；跨 attempt 耗尽保护、旧绑定和导出保持原规则，未改 migration SQL/checksum。
- 请求、工具、提交边界继续核验取消、租约、来源及请求代次；未知 usage 保持未知。网络读取 TimeoutError 与 Loop 总期限耗尽分开解释，原有 run attempt 恢复保留。中间正文只在有界内存；没有现场音频产物。

钩子映射、全部生产调用者及 E 的稳定接口见 [D 设计](../../openspec/changes/archive/2026-10-11-centralize-agent-runtime-loop/design.md)。

## 实际命令与结果

| 命令 | 结果与范围 |
|---|---|
| `npm run test:focus -- test/integration/agent-redesign-s3-session-ingest-journey.test.js test/integration/session-experience-journey.test.js test/integration/session-question-window-journey.test.js test/integration/agent-loop-runtime-journey.test.js` | 返回 0，54/54；真实模型接入、Pi、scheduler/runner、受控工具与 SQLite 的摄取、问答、长输入、重试、取消、失败及恢复。 |
| `npm run test:focus -- test/runtime/formal-agent-run-runner.test.js test/runtime/agent-loop.test.js test/contracts/agent-loop-ownership.test.js` | 返回 0，42/42；全 recipe、依赖方向、Retry-After/抖动/旧政策、取消等待、非合作期限、输出与进度隐私。 |
| `npm test` | renderer 类型检查与构建返回 0；core **1213/1213**、integration **174/174**。evidence 初次为 247 项符合预期、1 项失败、1 项按设计跳过，整体退出 1；失败仅为新增 MIT `.txt` 通知不符合既有打包扩展名白名单。 |
| `npm run test:focus -- test/contracts/agent-loop-ownership.test.js test/validation/b5-packaging-contract.test.js` | MIT 通知改为既有白名单支持的 `PI-NOTICE.md`，同步合同路径；返回 0，19/19。没有放宽打包白名单。 |
| PowerShell `$env:TZ = 'UTC'; node scripts/i3-nonaudio-soak.js --report docs/validation/i3-nonaudio-results.json` | 返回 0；按当前产品摘要刷新报告，3600 段、4000 事件、虚拟两小时，严格保留 `gateStatus=partial`。 |
| `node scripts/verify-i3-nonaudio-report.js docs/validation/i3-nonaudio-results.json` | 返回 0；当前来源摘要与隐私约束符合预期。 |
| `node --test --experimental-test-isolation=none 'test/gate-0b/**/*.test.js' 'test/gate-0c/**/*.test.js' 'test/validation/**/*.test.js'` | 返回 0，**248 项符合预期、1 项按设计跳过、零失败**。跳过为未请求真实本地模型的 J20 native 资格。 |
| `npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-telemetry` | 返回 0；三个包均为 0.84.1，无第二份不同版本。 |
| `openspec validate centralize-agent-runtime-loop --strict --json` / `git diff --check` | 均返回 0。 |

最后一次 `npm test` 后仅调整许可证文件扩展名、对应合同路径与文档，并刷新非音频报告；生产 JavaScript 与 renderer 没有新改动。复用完整 core/integration 结果，重跑受影响合同和完整 evidence；不把原 `npm test` 退出 1 改写为退出 0。更早的旅程 fixture 缺少真实请求预留/冻结预算，以及网络 TimeoutError 被误作总期限耗尽的问题已由实现和真实旅程修正。

## 验证边界与交接

外部网络、系统凭据和 IPC 回执丢失使用受控边界；内部循环、模型接入、工具、调度及 SQLite 使用真实实现。Electron 资格与正式设置/Agent Bar/历史旅程已有确定性证据；这不提升公网 provider、Win11 系统凭据、物理音源、DWM、交互安装或干净机的实机/发布验收状态。非音频 I3 仍为预资格，不代替真实两小时音频实机运行。

E 复用 `modelAccess.bind`、内部不可变 `createLoopAdapter(binding)` 和 `AgentLoopExecutor.agentLoop`，保留 beforeRequest 持久确认、安全进度、用量回调、冻结重试政策与 AbortSignal。SQLite 继续拥有唯一持久账本和终态竞争，不建立第二套循环或恢复状态。D 任务勾选见 [tasks](../../openspec/changes/archive/2026-10-11-centralize-agent-runtime-loop/tasks.md)；未归档变更。
