# 2026-10-23 工作区文件归属附表

本附表用于编写本地 PR 草稿，仅记录文件候选归属与拆分约束。路径相对于仓库根目录。以 `git status --porcelain=v1 -uall -z` 读取初始工作区，排除 `docs/pr-drafts/**`；159 项逐一映射，无未分配项。本次生成附表未修改产品文件，未暂存或提交。

规范与旅程索引：SEM-F14/F28/F31/F33/F38/F39/F40/F41；SEM-T03/T04/T05/T06/T15；J9-CI、J17、J19、J22、J24、J25、J28-FILES、J29、J30、J31、DB7、I3、I4。索引仅指明各组涉及的要求与证据范围，不据此声明联合验收完成、实机验收完成或发布验收完成。

基准提交为 `d06d139f66da67fda8ac280666bedc6f9b6ead9b`，此前只读核对中 HEAD、main、origin/main 相同。本附表不 fetch，不据远端跟踪引用推断服务器最新状态。

| 草稿 | 功能范围 |
|---|---|
| PR01 | 工具条重载恢复 |
| PR02 | 个人记忆文件并行恢复 |
| PR03 | 统一 Agent 执行基础：provider 单次交换、Pi Loop、统一产品操作及 OpenSpec 归档/主规格同步 |
| PR04 | 输出校验诊断；v33 持久字段随 PR06 |
| PR05 | 会话总结/会话问答阅读呈现及输出字段说明 |
| PR06 | summary.minutes@3 质量与容量、DeepSeek@2、v33 |
| HOLD | 暂缓归属的独立资料或待绑定拆分后 revision 的聚合证据 |

文件计数：159 = 88 M（tracked 修改）+ 15 D（tracked 删除）+ 56 U（未跟踪）；暂存项 0；未分配项 0。表内每个路径仅出现一次，多 ID 表示该文件存在按 hunk 分配或有序堆叠的依赖，不能按整个文件直接切分；未跟踪的新文件也可能承载多组职责。归属只是草稿边界，不表示拆分后的各 PR 已独立运行验证。

`src/runtime/storage-worker/schema.js` 整文件单归 PR06，包含 SUMMARY_QUALITY_SQL、v33、版本号 33 及 output_validation 诊断持久字段。PR04 不提前加入这些持久字段。v32/PERSONAL_MEMORY_CLEANUP_SQL 是 HEAD 既有上下文，不是本轮新增。

三个 OpenSpec change 的 15 个删除项、15 个 archive 新文件与 3 份主规格单归 PR03；归档同时包含修订，不描述为纯移动。历史证据不替代拆分后 revision 的检查。

| 序号 | Git 状态 | 文件路径 | 候选草稿 | 拆分说明 |
|---:|:---:|---|---|---|
| 1 | M | `.gitignore` | HOLD | 暂缓独立归属，不随产品功能自动纳入。 |
| 2 | M | `CONTEXT.md` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 3 | M | `docs/adr/0009-deterministic-agent-input-planning.md` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 4 | M | `docs/adr/0016-unified-agent-execution-path.md` | PR03 / PR06 | hunk：统一执行路径与新版总结的架构说明。 |
| 5 | M | `docs/adr/0021-summary-lifecycle-and-long-input.md` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 6 | M | `docs/agent-refactor-roadmap.md` | PR03 | C/D/E 主规格与归档登记；其中个人记忆失败为历史限制，不能当作 PR02 当前修复证据。 |
| 7 | M | `docs/data-architecture.md` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 8 | U | `docs/research/agent-model-refactor-feasibility-2026-10-08.md` | PR03 | 模型重构背景研究，不替代实现或用户旅程证据。 |
| 9 | U | `docs/research/session-summary-intermediate-output-limits-2026-10-11.md` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 10 | U | `docs/research/tmspeech-frontend-comparison.md` | HOLD | 暂缓独立归属，不随产品功能自动纳入。 |
| 11 | M | `docs/runtime-architecture.md` | PR03 / PR04 / PR06 | hunk：执行职责、校验诊断与总结阶段；按依赖顺序同步。 |
| 12 | M | `docs/semantic-contract.md` | PR01 / PR02 / PR03 / PR04 / PR05 / PR06 | hunk：按功能登记章节分配，保留各自要求与旅程边界。 |
| 13 | M | `docs/testing-strategy.md` | PR01 / PR02 / PR03 / PR04 / PR05 / PR06 | hunk：按功能登记章节分配，保留各自要求与旅程边界。 |
| 14 | U | `docs/validation/agent-loop-runtime-2026-10-09.md` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 15 | U | `docs/validation/agent-operations-2026-10-09.md` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 16 | U | `docs/validation/agent-reading-2026-10-05.md` | PR05 | 会话总结/会话问答阅读呈现及输出字段说明。 |
| 17 | U | `docs/validation/agent-refactor-closeout-2026-10-11.md` | PR03 | 三个 OpenSpec change 的主规格同步与归档核对记录。 |
| 18 | U | `docs/validation/ci-and-memory-recovery-2026-10-21.md` | PR01 / PR02 | hunk：工具条重载恢复与个人记忆文件恢复的共同验证记录，按章节分配。 |
| 19 | M | `docs/validation/i3-nonaudio-results.json` | HOLD | 聚合证据，须绑定拆分后的实际 revision 与载荷，不能作为各 PR 的独立验收。 |
| 20 | M | `docs/validation/personal-memory-synthetic-retrieval-2026-10-02.json` | HOLD | 聚合证据，须绑定拆分后的实际 revision 与载荷，不能作为各 PR 的独立验收。 |
| 21 | U | `docs/validation/session-ai-diagnosis-2026-10-05.md` | PR04 / PR05 | 有日期的拒绝诊断及正文排版调查；关联阅读记录，不能推断当前全部历史失败根因。 |
| 22 | U | `docs/validation/session-summary-quality-2026-10-11.json` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 23 | U | `docs/validation/session-summary-quality-2026-10-11.md` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 24 | U | `openspec/changes/archive/2026-10-11-centralize-agent-runtime-loop/.openspec.yaml` | PR03 | 归档并修订；文件集合齐全，不是纯移动。 |
| 25 | U | `openspec/changes/archive/2026-10-11-centralize-agent-runtime-loop/design.md` | PR03 | 归档并修订；文件集合齐全，不是纯移动。 |
| 26 | U | `openspec/changes/archive/2026-10-11-centralize-agent-runtime-loop/proposal.md` | PR03 | 归档并修订；文件集合齐全，不是纯移动。 |
| 27 | U | `openspec/changes/archive/2026-10-11-centralize-agent-runtime-loop/specs/agent-runtime-ownership/spec.md` | PR03 | 归档并修订；文件集合齐全，不是纯移动。 |
| 28 | U | `openspec/changes/archive/2026-10-11-centralize-agent-runtime-loop/tasks.md` | PR03 | 归档并修订；文件集合齐全，不是纯移动。 |
| 29 | U | `openspec/changes/archive/2026-10-11-consolidate-agent-operations/.openspec.yaml` | PR03 | 归档并修订；文件集合齐全，不是纯移动。 |
| 30 | U | `openspec/changes/archive/2026-10-11-consolidate-agent-operations/design.md` | PR03 | 归档并修订；文件集合齐全，不是纯移动。 |
| 31 | U | `openspec/changes/archive/2026-10-11-consolidate-agent-operations/proposal.md` | PR03 | 归档并修订；文件集合齐全，不是纯移动。 |
| 32 | U | `openspec/changes/archive/2026-10-11-consolidate-agent-operations/specs/agent-operation-facade/spec.md` | PR03 | 归档并修订；文件集合齐全，不是纯移动。 |
| 33 | U | `openspec/changes/archive/2026-10-11-consolidate-agent-operations/tasks.md` | PR03 | 归档并修订；文件集合齐全，不是纯移动。 |
| 34 | U | `openspec/changes/archive/2026-10-11-separate-agent-provider-protocol/.openspec.yaml` | PR03 | 归档并修订；文件集合齐全，不是纯移动。 |
| 35 | U | `openspec/changes/archive/2026-10-11-separate-agent-provider-protocol/design.md` | PR03 | 归档并修订；文件集合齐全，不是纯移动。 |
| 36 | U | `openspec/changes/archive/2026-10-11-separate-agent-provider-protocol/proposal.md` | PR03 | 归档并修订；文件集合齐全，不是纯移动。 |
| 37 | U | `openspec/changes/archive/2026-10-11-separate-agent-provider-protocol/specs/agent-provider-exchange/spec.md` | PR03 | 归档并修订；文件集合齐全，不是纯移动。 |
| 38 | U | `openspec/changes/archive/2026-10-11-separate-agent-provider-protocol/tasks.md` | PR03 | 归档并修订；文件集合齐全，不是纯移动。 |
| 39 | D | `openspec/changes/centralize-agent-runtime-loop/.openspec.yaml` | PR03 | active change 删除项；与对应 archive 和主规格同批处理。 |
| 40 | D | `openspec/changes/centralize-agent-runtime-loop/design.md` | PR03 | active change 删除项；与对应 archive 和主规格同批处理。 |
| 41 | D | `openspec/changes/centralize-agent-runtime-loop/proposal.md` | PR03 | active change 删除项；与对应 archive 和主规格同批处理。 |
| 42 | D | `openspec/changes/centralize-agent-runtime-loop/specs/agent-runtime-ownership/spec.md` | PR03 | active change 删除项；与对应 archive 和主规格同批处理。 |
| 43 | D | `openspec/changes/centralize-agent-runtime-loop/tasks.md` | PR03 | active change 删除项；与对应 archive 和主规格同批处理。 |
| 44 | D | `openspec/changes/consolidate-agent-operations/.openspec.yaml` | PR03 | active change 删除项；与对应 archive 和主规格同批处理。 |
| 45 | D | `openspec/changes/consolidate-agent-operations/design.md` | PR03 | active change 删除项；与对应 archive 和主规格同批处理。 |
| 46 | D | `openspec/changes/consolidate-agent-operations/proposal.md` | PR03 | active change 删除项；与对应 archive 和主规格同批处理。 |
| 47 | D | `openspec/changes/consolidate-agent-operations/specs/agent-operation-facade/spec.md` | PR03 | active change 删除项；与对应 archive 和主规格同批处理。 |
| 48 | D | `openspec/changes/consolidate-agent-operations/tasks.md` | PR03 | active change 删除项；与对应 archive 和主规格同批处理。 |
| 49 | D | `openspec/changes/separate-agent-provider-protocol/.openspec.yaml` | PR03 | active change 删除项；与对应 archive 和主规格同批处理。 |
| 50 | D | `openspec/changes/separate-agent-provider-protocol/design.md` | PR03 | active change 删除项；与对应 archive 和主规格同批处理。 |
| 51 | D | `openspec/changes/separate-agent-provider-protocol/proposal.md` | PR03 | active change 删除项；与对应 archive 和主规格同批处理。 |
| 52 | D | `openspec/changes/separate-agent-provider-protocol/specs/agent-provider-exchange/spec.md` | PR03 | active change 删除项；与对应 archive 和主规格同批处理。 |
| 53 | D | `openspec/changes/separate-agent-provider-protocol/tasks.md` | PR03 | active change 删除项；与对应 archive 和主规格同批处理。 |
| 54 | U | `openspec/specs/agent-operation-facade/spec.md` | PR03 | 主规格 requirements 正文与对应归档 delta 一致，与归档同批处理。 |
| 55 | U | `openspec/specs/agent-provider-exchange/spec.md` | PR03 | 主规格 requirements 正文与对应归档 delta 一致，与归档同批处理。 |
| 56 | U | `openspec/specs/agent-runtime-ownership/spec.md` | PR03 | 主规格 requirements 正文与对应归档 delta 一致，与归档同批处理。 |
| 57 | M | `package-lock.json` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 58 | M | `package.json` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 59 | M | `scripts/fixtures/formal-agent-j25-settings-journey.js` | PR03 / PR05 / PR06 | hunk：设置旅程的执行基础、结果呈现与新版总结 fixture；2026-10-24 缩放提交等待归 PR05。 |
| 60 | U | `scripts/fixtures/pi-core-qualification.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 61 | M | `scripts/product-shell-smoke.js` | PR01 | 工具条重载恢复及相关旅程；smoke 载荷哈希证据随拆分后的 revision 核对。 |
| 62 | U | `scripts/qualify-session-summary-cloud.js` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 63 | M | `scripts/verify-package-layout.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 64 | M | `src/agent/agent-view.tsx` | PR03 / PR04 / PR05 / PR06 | hunk：运行接线、诊断反馈、阅读呈现与总结阶段展示。 |
| 65 | M | `src/agent/agent.css` | PR05 | 会话总结/会话问答阅读呈现及输出字段说明。 |
| 66 | M | `src/agent/contracts/agent-run-diagnostics.js` | PR03 / PR04 | PR03 保留合法 backoff 次数；PR04 扩展输出校验诊断。v33 持久字段随 PR06。 |
| 67 | M | `src/agent/contracts/agent-run-ui.js` | PR04 / PR06 | hunk：输出拒绝诊断字段；PR06 同步 1.2.0、总结处理模式及导出 schema 7，保留旧版本。 |
| 68 | M | `src/agent/contracts/budget-axes.js` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 69 | U | `src/agent/contracts/output-validation.js` | PR03 / PR04 / PR06 | PR03 先带 exchange/Pi 引用的最小错误合同；PR04 扩展诊断链；PR06 加新总结字段类别。 |
| 70 | U | `src/agent/contracts/provider-exchange.js` | PR03 / PR06 | PR03 单次交换合同与旧策略；PR06 才增加 deepseek-openai@2 思考协议与 4 MiB 限额。 |
| 71 | M | `src/agent/contracts/recipe-output-directives.js` | PR05 / PR06 | hunk：输出字段说明与新版总结输出指令。 |
| 72 | M | `src/agent/contracts/recipes.js` | PR04 / PR05 / PR06 | hunk：输出校验、字段语义与 SummaryMinutesV2/话题目录 schema。 |
| 73 | U | `src/agent/contracts/retry-policy.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 74 | M | `src/agent/contracts/session-summary-run-ui.js` | PR03 / PR04 / PR06 | hunk：统一执行、输出校验诊断与总结阶段/预算；新增文件也须按依赖原子迁移或堆叠。 |
| 75 | U | `src/agent/contracts/summary-quality.js` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 76 | U | `src/agent/execution-host/PI-NOTICE.md` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 77 | M | `src/agent/execution-host/agent-loop.js` | PR03 / PR04 / PR06 | hunk：统一执行、输出校验诊断与总结阶段/预算；新增文件也须按依赖原子迁移或堆叠。 |
| 78 | M | `src/agent/execution-host/context-ingest-session-runner.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 79 | M | `src/agent/execution-host/formal-agent-run-runner.js` | PR03 / PR04 / PR06 | hunk：统一执行、输出校验诊断与总结阶段/预算；新增文件也须按依赖原子迁移或堆叠。 |
| 80 | M | `src/agent/execution-host/intent-route-orchestrator.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 81 | U | `src/agent/execution-host/pi-loop-runtime.js` | PR03 / PR04 / PR06 | hunk：统一执行、输出校验诊断与总结阶段/预算；新增文件也须按依赖原子迁移或堆叠。 |
| 82 | M | `src/agent/execution-host/question-evidence-executor.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 83 | M | `src/agent/execution-host/session-experience-executor.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 84 | M | `src/agent/execution-host/summary-input-plan.js` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 85 | M | `src/agent/execution-host/summary-plan-executor.js` | PR04 | 当前差异仅传播旧计划执行的 JSON、来源和中间输出尺寸拒绝原因，限额与结果 Schema 未扩大。 |
| 86 | U | `src/agent/execution-host/summary-quality-executor.js` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 87 | U | `src/agent/execution-host/summary-quality-plan.js` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 88 | M | `src/agent/formal-run/agent-interaction-exporter.js` | PR03 / PR04 / PR06 | hunk：统一执行、输出校验诊断与总结阶段/预算；新增文件也须按依赖原子迁移或堆叠。 |
| 89 | U | `src/agent/formal-run/agent-interaction-reader.js` | PR03 / PR04 / PR06 | 先抽取旧读取路径；输出拒绝和新总结处理模式的投影按后续 PR 分段纳入。 |
| 90 | U | `src/agent/formal-run/agent-operation-service.js` | PR03 / PR04 / PR06 | hunk：统一执行、输出校验诊断与总结阶段/预算；新增文件也须按依赖原子迁移或堆叠。 |
| 91 | M | `src/agent/formal-run/agent-run-service.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 92 | M | `src/agent/formal-run/session-summary-run-service.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 93 | M | `src/agent/model-access/openai-compatible-adapter.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 94 | M | `src/agent/model-access/preset-registry.js` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 95 | U | `src/agent/model-access/provider-exchange.js` | PR03 / PR04 / PR06 | hunk：统一执行、输出校验诊断与总结阶段/预算；新增文件也须按依赖原子迁移或堆叠。 |
| 96 | M | `src/agent/model-access/runtime.js` | PR03 / PR06 | PR03 绑定后单次交换与模型测试；阶段容量与新版总结绑定支持随 PR06。 |
| 97 | M | `src/agent/personal-context/memory-file-worker.js` | PR02 | 个人记忆文件并行恢复及失败路径旅程。 |
| 98 | U | `src/agent/result-text.tsx` | PR05 | 会话总结/会话问答阅读呈现及输出字段说明。 |
| 99 | M | `src/main.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 100 | M | `src/main/services/agent-run-diagnostics.js` | PR04 | 输出校验诊断契约、运行态反馈及定向证据；v33 持久字段随 PR06。 |
| 101 | M | `src/preload/agent.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 102 | M | `src/runtime/storage-worker/agent-execution-store.js` | PR03 / PR04 / PR06 | hunk：执行事实与诊断/总结字段；依赖 v33 的持久化 hunk 随 PR06。 |
| 103 | M | `src/runtime/storage-worker/model-access-store.js` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 104 | M | `src/runtime/storage-worker/personal-context-store.js` | PR03 / PR06 | hunk：操作身份、重试/预算与总结输入政策；不要按整个文件直接分配。 |
| 105 | M | `src/runtime/storage-worker/personal-memory-overview-store.js` | PR03 | 当前差异仅将新 context.synthesize 运行冻结为 agent-retry@2，不改变个人记忆综合视图能力。 |
| 106 | M | `src/runtime/storage-worker/schema.js` | PR06 | 整文件单归 PR06：SUMMARY_QUALITY_SQL、v33、版本号 33 及 output_validation 持久字段；PR04 不提前持久化。v32/PERSONAL_MEMORY_CLEANUP_SQL 是 HEAD 既有上下文。 |
| 107 | M | `src/runtime/storage-worker/session-summary-budget.js` | PR03 / PR06 | hunk：操作身份、重试/预算与总结输入政策；不要按整个文件直接分配。 |
| 108 | M | `src/runtime/storage-worker/summary-input-plan-store.js` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 109 | M | `src/settings/agent-model-pane.tsx` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 110 | M | `src/toolbar/toolbar.ts` | PR01 | 工具条重载恢复及相关旅程；smoke 载荷哈希证据随拆分后的 revision 核对。 |
| 111 | U | `test/contracts/agent-loop-ownership.test.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 112 | M | `test/contracts/agent-model-presets-ui-contract.test.js` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 113 | U | `test/contracts/agent-output-diagnostics.test.js` | PR04 | 输出校验诊断契约、运行态反馈及定向证据；v33 持久字段随 PR06。 |
| 114 | M | `test/contracts/agent-recipes-contract.test.js` | PR03 / PR04 / PR05 / PR06 | hunk：recipe 执行约束、输出校验与输出 schema/版本。 |
| 115 | M | `test/contracts/agent-run-diagnostics-contract.test.js` | PR03 / PR04 | PR03 严格验证 backoff 次数；PR04 验证输出校验诊断。v33 持久字段随 PR06。 |
| 116 | M | `test/contracts/agent-run-eligibility-ui-contract.test.js` | PR06 | 当前差异只更新 1.2.0 版本断言，随新版本契约落地。 |
| 117 | M | `test/contracts/agent-run-ui-contract.test.js` | PR06 | 新增导出 schema 7 接受与 schema 8 拒绝，随版本化新纪要落地。 |
| 118 | M | `test/contracts/budget-axes-s3.test.js` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 119 | M | `test/contracts/model-access-interface.test.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 120 | U | `test/contracts/summary-quality-contract.test.js` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 121 | U | `test/integration/agent-loop-runtime-journey.test.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 122 | M | `test/integration/agent-redesign-j25-formal-settings-journey.test.js` | PR03 / PR05 / PR06 | hunk：设置旅程的执行基础、结果呈现与新版总结 fixture。 |
| 123 | M | `test/integration/agent-redesign-j25-model-comparison-journey.test.js` | PR03 / PR06 | hunk：provider 交换/执行基础与新版模型、总结阶段 fixture。 |
| 124 | M | `test/integration/agent-redesign-s3-route-journey.test.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 125 | M | `test/integration/agent-redesign-s3-session-ingest-journey.test.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 126 | M | `test/integration/agent-redesign-s5-target-journey.test.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 127 | M | `test/integration/helpers/context-storage-transport.js` | PR03 / PR06 | hunk：操作身份、重试/预算与总结输入政策；不要按整个文件直接分配。 |
| 128 | U | `test/integration/helpers/summary-quality-fixture.js` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 129 | M | `test/integration/model-access-s2-core-journey.test.js` | PR03 / PR06 | hunk：provider 交换/执行基础与新版模型、总结阶段 fixture。 |
| 130 | M | `test/integration/personal-memory-agent-retrieval-journey.test.js` | PR03 / PR06 | hunk：provider 交换/执行基础与新版模型、总结阶段 fixture。 |
| 131 | M | `test/integration/personal-memory-file-journey.test.js` | PR02 | 个人记忆文件并行恢复及失败路径旅程。 |
| 132 | M | `test/integration/personal-memory-question-journey.test.js` | PR03 / PR05 | provider exchange 迁移与问答正文排版/字段说明的真实保存重读旅程分段纳入。 |
| 133 | U | `test/integration/pi-core-electron-journey.test.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 134 | U | `test/integration/provider-network-fixture.js` | PR03 / PR04 / PR06 | hunk：统一执行、输出校验诊断与总结阶段/预算；新增文件也须按依赖原子迁移或堆叠。 |
| 135 | M | `test/integration/session-experience-journey.test.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 136 | M | `test/integration/session-question-window-journey.test.js` | PR03 / PR04 / PR05 | hunk：会话问答执行迁移、诊断与输出字段说明。 |
| 137 | M | `test/integration/session-summary-budget-recovery-journey.test.js` | PR03 / PR04 / PR06 | hunk：统一操作恢复、输出校验失败路径与新版总结预算/阶段。 |
| 138 | M | `test/integration/session-summary-j29-memory-journey.test.js` | PR03 / PR05 / PR06 | hunk：provider 交换、旧总结正文排版保存重读与新版总结阶段 fixture。 |
| 139 | U | `test/integration/session-summary-quality-journey.test.js` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 140 | M | `test/integration/session-summary-request-j30-accept-journey.test.js` | PR03 / PR04 / PR06 | hunk：统一操作恢复、输出校验失败路径与新版总结预算/阶段。 |
| 141 | U | `test/integration/toolbar-layout-recovery-journey.test.js` | PR01 | 工具条重载恢复及相关旅程；smoke 载荷哈希证据随拆分后的 revision 核对。 |
| 142 | M | `test/main/agent-run-service.test.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 143 | M | `test/main/model-access-vault-runtime.test.js` | PR03 / PR04 / PR06 | hunk：统一执行、输出校验诊断与总结阶段/预算；新增文件也须按依赖原子迁移或堆叠。 |
| 144 | M | `test/main/model-test-runtime.test.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 145 | U | `test/main/provider-exchange.test.js` | PR03 / PR04 / PR06 | hunk：统一执行、输出校验诊断与总结阶段/预算；新增文件也须按依赖原子迁移或堆叠。 |
| 146 | M | `test/runtime/agent-loop.test.js` | PR03 / PR04 / PR06 | hunk：统一执行、输出校验诊断与总结阶段/预算；新增文件也须按依赖原子迁移或堆叠。 |
| 147 | M | `test/runtime/context-ingest-runner-s3.test.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 148 | M | `test/runtime/formal-agent-run-runner.test.js` | PR03 / PR04 / PR06 | hunk：统一执行、输出校验诊断与总结阶段/预算；新增文件也须按依赖原子迁移或堆叠。 |
| 149 | M | `test/runtime/intent-route-orchestrator.test.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 150 | U | `test/runtime/pi-core-qualification.test.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 151 | M | `test/runtime/session-summary-run-progress.test.js` | PR03 / PR04 / PR06 | hunk：统一执行、输出校验诊断与总结阶段/预算；新增文件也须按依赖原子迁移或堆叠。 |
| 152 | M | `test/storage/agent-execution-store.test.js` | PR03 / PR04 / PR06 | hunk：执行事实与诊断/总结字段；依赖 v33 的持久化 hunk 随 PR06。 |
| 153 | M | `test/storage/model-access-schema.test.js` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 154 | M | `test/storage/personal-context-store.test.js` | PR03 | 统一 Agent 执行基础；依赖迁移须保持原子性或采用有序堆叠。 |
| 155 | U | `test/storage/summary-quality-schema.test.js` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 156 | M | `test/ui/agent-model-settings-ui.test.js` | PR06 | summary.minutes@3 质量与容量、DeepSeek@2 及相应设置、预算、旅程和证据。 |
| 157 | U | `test/ui/agent-result-text.test.js` | PR05 | 会话总结/会话问答阅读呈现及输出字段说明。 |
| 158 | M | `test/ui/agent-ui.test.js` | PR03 / PR04 / PR05 / PR06 | hunk：运行接线、诊断反馈、阅读呈现与总结阶段展示。 |
| 159 | M | `test/ui/toolbar-notice-ui.test.js` | PR01 | 工具条重载恢复及相关旅程；smoke 载荷哈希证据随拆分后的 revision 核对。 |

## 2026-10-24 修复增量

上表保留初始159项快照；本次额外修改既有 `scripts/fixtures/agent-layout-app.js`，归 PR05 的 Agent 展示旅程验证 hunk。它等待原生窗口尺寸及 renderer 视口/缩放提交，保留原布局断言与重复尺寸矩阵；不增加产品能力或修改窗口几何策略。当前路径总数应为162（初始159＋两份草稿＋此fixture），以最终状态检查为准。

PR03 同时包含 `agent-operation-service.js` 的 nullable retry 更新修复、`agent-run-diagnostics.js` 的严格 backoff 次数合同及对应合同/J30真实旅程；PR04 不应成为正常退避观测的前置条件。原有输出校验 hunk 仍属 PR04，v33 部分仍属 PR06。

既有修改路径 `formal-agent-j25-settings-journey.js` 的相邻缩放循环也补入视口提交等待，归 PR05 展示旅程验证；未增加净变动路径。完整 `npm test` 在该补改前退出0（core1227/1227、integration198/198、evidence248/249且仅1项显式资格跳过），补改后的J25定向2/2退出0；各拆分候选仍未单独构建或验证。I3报告已按最终产品源码刷新并与构建后的载荷一致，合成检索报告只刷新4个计时字段；两者仍属PR06的证据更新，不能照搬到各拆分分支。
