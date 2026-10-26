# 工作区检查与功能级 PR 草稿 · 2026-10-23

本文件用于评审当前工作区的拆分方案和 PR 正文，不代表已提交 GitHub PR。关联 SEM-F14/F22/F28/F31/F33/F38/F39/F40/F41、SEM-T01/T02/T03/T04/T05/T06/T08/T15，以及 J17/J19/J22/J24/J25/J28-FILES/J29/J30/J31、DB1/DB7/I3。

## 检查范围与基准

- 仓库：`JoshuaChen2008/Speech-Agent`；当前分支：`codex/ci-regression-and-agent-closeout`。
- `HEAD`、本地 `main`、本地远端跟踪引用 `origin/main` 均为 `d06d139f66da67fda8ac280666bedc6f9b6ead9b`。本轮没有 fetch，因此这是本地引用事实，不声称远端最新状态。
- `main..HEAD` 没有提交，`main...HEAD` 没有差异；待审内容来自未提交工作区。暂存区为空。
- 初始清单为 **159 个文件：88 个已跟踪修改、15 个已跟踪删除、56 个未跟踪文件**；tracked diff 为 103 个文件、3,597 行增加、3,687 行删除，这个行数不含未跟踪新文件。
- GitHub 只读查询：`gh pr list --repo JoshuaChen2008/Speech-Agent --head codex/ci-regression-and-agent-closeout --state all --json number,title,state,url,baseRefName,headRefName` 返回空数组。
- 代码审阅采用 `git diff HEAD --` 加未跟踪文件读取；不以空的分支三点差异代替工作区审阅。
- 本轮没有暂存、提交、切换分支、推送、创建 PR、启动真实云端资格脚本或操作既有产品数据。测试对合成检索报告的正常刷新另在验证节记录。
- 本轮新建的草稿及文件附表不计入上述 159 项初始快照。全部原始路径的归属见[文件附表](workspace-file-map-2026-10-23.md)。

## 拆分结论

建议形成 **六个功能 PR**。前两项可以独立落在基准提交上；Agent 执行基础包含 C/D/E 的原子迁移，其后叠加诊断、阅读呈现和新总结版本。这里的编号是本地提案编号，不是 GitHub PR 编号。

| 提案 | 功能边界 | 建议基础 | 拆分注意 |
|---|---|---|---|
| PR-01 | 工具条重载轮廓恢复 | `main` | 独立；共享文档只取 J17/J19 对应段落 |
| PR-02 | 个人记忆文件恢复与并行扫描 | `main` | 独立；不带 Agent 重试及新总结迁移 |
| PR-03 | Agent 单次交换、唯一 Loop 与统一操作服务 | `main` 或前两项之后 | C/D/E 一次迁移；保留最小校验错误合同依赖；纳入长 Retry-After 快照与基础退避诊断修复 |
| PR-04 | 模型结果拒绝的本地诊断 | PR-03 | 以已登记错误合同扩展观测；不带 v33/新纪要字段 |
| PR-05 | 总结、问答正文阅读及输出字段说明 | PR-03；建议 PR-04 之后 | 输出 Schema 容量仍按旧版本；不带新纪要话题结构 |
| PR-06 | 会话总结容量、三阶段质量与新预设 | PR-03/04/05 汇合后 | v33、`summary.minutes@3`、`deepseek-openai@2`、导出 schema 7 同时落地 |

当前仅验证原工作区的组合树，没有构造六个独立候选树。因此“可以独立拆分”是依赖分析结论，**每个拆分分支仍须执行其定向旅程；最终合入 revision 还须有完整三条 lane 或当前 CI 证据**。不能把整棵工作区的结果分别记成六个 PR 的独立结果。

`src/agent/agent-view.tsx`、`contracts/recipes.js`、`recipe-output-directives.js`、`pi-loop-runtime.js`、`formal-agent-run-runner.js`、`agent-operation-service.js`、`agent-interaction-reader.js`、`model-access/provider-exchange.js`、`agent-execution-store.js`、`docs/semantic-contract.md`、`docs/testing-strategy.md` 等存在交织修改。实际切分必须按变更段组织，不能把当前文件整体重复放入多个 PR。PR-03 中的新文件也可能含 PR-04/05/06 的后续能力，不能因为它是未跟踪文件就整体纳入基础迁移。

## PR-01 草稿：工具条重载轮廓恢复

**标题**：`fix: 工具条重载后在绘制帧暂停时恢复轮廓上报（SEM-F22/T04；J17/J19）`

**正文**：

工具条重载后，Chromium 可能暂停发送动画帧，原有轮廓上报一直等待 `requestAnimationFrame`，从而触发现有五秒恢复期限。为一次合并上报增加独立的 100ms timer，任一调度先执行后清理另一调度；待处理对象身份阻止旧回调结算新队列，强制补报不被去重吞掉，窗口卸载时取消所有待处理调度。

新增真实四窗旅程，在 Chromium 绘制调度边界暂停帧回调，验证生产 renderer/preload/main 在原期限内恢复有效轮廓并取得退出绑定证据。保留既有窗口接受规则与恢复期限。

- 文件：`src/toolbar/toolbar.ts`、`scripts/product-shell-smoke.js`、`test/ui/toolbar-notice-ui.test.js`、新增 `test/integration/toolbar-layout-recovery-journey.test.js`。
- 文档：SEM-F22/T03/T04 和 J17/J19 的 2026-10-21 登记；`ci-and-memory-recovery-2026-10-21.md` 只取工具条部分，或切为独立记录。
- 定向验证：先 `npm run verify:renderer`，再 `npm run test:focus -- test/ui/toolbar-notice-ui.test.js test/integration/toolbar-layout-recovery-journey.test.js`。
- 失败路径：绘制帧未到达、重复排队、迟到旧帧、强制补报和窗口卸载。
- 验收边界：确定性旅程不证明真实 DWM、系统 DPI、物理鼠标及混合缩放行为；状态按实际证据保持“实现完成·尚未验收”。

## PR-02 草稿：个人记忆文件恢复与并行扫描

**标题**：`fix: 保留个人记忆文件恢复期间的已确认内容（SEM-F41/T04；J28-FILES/DB7）`

**正文**：

个人记忆文件的阶段操作中断后，恢复流程持有 Win32 独占读句柄；并行扫描若再调用文件系统读取，会把自己持有的锁解释为外部文件损坏，使原已确认条目退出输入。记录句柄对应的相对文件身份，扫描同一文件时经已有句柄读取当前实际字节，再走原文件解析与治理核验。

真实文件 Worker、Win32 句柄与 SQLite 旅程固定恢复和扫描的交错顺序，验证尚未写入的目标内容不会取代已确认内容；写入后扫描能读到实际新字节，释放句柄后的外部修订仍进入待确认状态。

- 文件：`src/agent/personal-context/memory-file-worker.js` 与 `test/integration/personal-memory-file-journey.test.js`。
- 文档：SEM-F41/F14/T04、J28-FILES/DB7 的 2026-10-21 登记；共享恢复记录只带本功能部分。
- 定向验证：`npm run test:focus -- test/integration/personal-memory-file-journey.test.js`，在 Windows 环境执行；其它平台的 skip 不作为 Win32 句柄证据。
- 失败路径：外部竞争、未知或不完整字节、外部修订、撤销及迟到写入继续拒绝。
- 验收边界：本修复不涉及 schema 升级，不带 `personal-context-store.js` 的 Agent 重试修改；状态按本功能实际证据表述，不把一次回归推广为整个个人记忆能力验收。

## PR-03 草稿：Agent 执行基础的原子迁移

**标题**：`refactor: 统一 Agent 交换、循环与产品操作入口（SEM-F28/F31/F33/T15；J22/J24/J25/J30/J31）`

**正文**：

原模型 adapter、执行宿主和正式请求服务分担了循环、工具、重试及受理控制。将厂商协议收敛为一次 `exchange`：每次最多一次 HTTP 请求，按实际响应块执法字节上界，每次调用独立借用和释放凭据。执行宿主通过固定的 Pi 0.84.1 低层核心拥有唯一 Agent Loop，按顺序执行工具、执法冻结身份和持久请求预留，并统一版本化重试。

正式 main/preload/renderer 接入 `AgentOperationService`，复用持久受理、快照查询、取消和明确继续；SQLite 继续拥有任务事实，结果与终态同事务提交。旧门面仅作为已登记接口的适配边界，生产不保留第二条循环路径。C/D/E 的 active change、修订后的归档及三份主 spec 在同一 PR 中同步，状态保持“实现完成·尚未验收”。

- 核心文件：新增 `contracts/provider-exchange.js`、`contracts/retry-policy.js`、`model-access/provider-exchange.js`、`execution-host/pi-loop-runtime.js`、`formal-run/agent-operation-service.js`、`formal-run/agent-interaction-reader.js`；修改 adapter/runtime、Agent Loop、各 runner、存储预留、main/preload/renderer 接线。
- `output-validation.js` 的闭集错误构造被新 exchange/Pi 运行时直接引用，最小合同及相应测试必须随基础迁移落地。PR-04 再交付诊断记录、查询和导出的观测链；不得留下缺少模块的中间树。
- 依赖与打包：`package.json`、lockfile、`PI-NOTICE.md`、Pi Node/Electron 资格脚本和测试、`scripts/verify-package-layout.js` 一同纳入。允许低层 Pi 依赖，同时继续拒绝 `pi-coding-agent`。
- 版本边界：新运行冻结 `agent-retry@2`；有效 Retry-After 或有界指数退避加抖动，旧 `@1` 和无标识运行维持既有解释。每次真实外发先取得持久预留，未知回执零外发；工具和退避期间不持有凭据借用。
- 规格与记录：C/D/E 三份主 spec、三组 active 删除与 archive 新增；ADR 0009/0016、运行时架构的对应段落、推进计划及 C/D/E 验证记录；模型层重构可行性研究作为背景而非验收证据。
- 定向验证包括 provider-exchange、model-access、agent-loop、Pi qualification、formal-run、intent route、J25 正式 Electron、J30 请求控制和 J12 字幕独立旅程。涉及共享契约、存储和 main/preload，合入候选还需完整三条 lane。
- 失败路径：凭据撤销、流读取超限、协议矛盾、未授权工具、工具之间取消、失租、预留未知/重复回执、跨 attempt 耗尽、取消落库未知、重启后明确继续。2026-10-24 增量：合法长 Retry-After 的等待阶段落库、短等待字段清空、严格 backoff 次数合同及等待中取消，相关基础诊断 hunk 随 PR03。
- 未验证范围：本轮无真实公网 provider、系统凭据实机、物理采集、五小时输入或完整 J31 实机矩阵；不因归档而提升产品验收状态。

**拆分决策**：当前 C 旧门面已被 D 删除，E 以新宿主和统一操作服务为基础。把当前文件整体分别放进 C/D/E 三个平行 PR 会产生不可运行的中间树。若将来必须分三次合入，需要重建并单独验证每个历史迁移切片；本轮提议采用一份基础迁移 PR。

## PR-04 草稿：模型结果拒绝的本地诊断

**标题**：`feat: 为模型结果拒绝记录有界诊断原因（SEM-F40/F14/T04；J30-DIAG/J29）`

**正文**：

会话总结和问答的 `AGENT_OUTPUT_INVALID` 原先缺少可检查的拒绝原因。沿已有运行诊断增加 `output_rejected` 事件和闭集 `outputValidation`，区分 JSON、Schema、正文类型/长度/控制字符、来源与个人记忆引用、覆盖、输出尺寸及响应协议；只记录允许的原因、字段类别和可空 actual/limit 计数。

诊断写入、查询和导出沿现有本地有界链路；旧记录没有该字段时保留未知，不补造原因。结果仍按原严格校验拒绝、非重试收束，诊断故障不覆盖任务终态，也不保存模型正文、工具正文或原始异常。

- 文件变更段：`contracts/output-validation.js` 在 PR-03 的最小基础上扩展所需类别；`recipes.js`、`agent-run-diagnostics.js`、执行宿主（包括旧计划的 `summary-plan-executor.js` 拒绝分类）、`agent-operation-service.js`、`src/main/services/agent-run-diagnostics.js` 及 renderer 诊断事件显示。
- 测试：`test/contracts/agent-output-diagnostics.test.js`、`agent-run-diagnostics-contract.test.js`，以及 J30 真实拒绝→诊断→查询/导出和隐私负扫描。
- 规格：SEM-F40 的 2026-10-04 登记、J30-DIAG 相应行；历史诊断记录只解释当时证据。
- PR-06 才增加 v33 中的请求快照持久字段、阶段信息及新尺寸界面；PR-04 不提前依赖 v33 或 `SummaryMinutesV2`。
- 验收边界：诊断类别不构成历史根因证明；旧 `AGENT_OUTPUT_INVALID` 不能全部追认为正文换行或字段遗漏。

## PR-05 草稿：总结与问答正文阅读及字段说明

**标题**：`fix: 保留总结与问答正文排版并明确输出字段（SEM-F31/F38/T04；J22/J29/J18）`

**正文**：

既有正文校验会拒绝正常 LF/CR/TAB，旧展示还会把长正文挤成单段。为总结和问答正文允许正常排版字符，同时保留其它控制字符及来源身份的严格规则。使用共享 `ResultText` 组件呈现段落、清单、小标题、少量强调和行内代码；长正文只在完整句子边界分段，React 文本节点保证 HTML、链接、图片及代码围栏保持非执行文本。

补强模型输出说明：问答列出全部七个必填根字段、显式 `coverage:null`、完整逐结论结构，以及没有实际记忆检索时使用空引用数组。示例不授予来源身份；字段遗漏、非法引用及无效 JSON 仍拒绝，不自动补字段。查看旧结果不调用模型，不改写已保存正文和来源。

- 文件：新增 `src/agent/result-text.tsx`、`test/ui/agent-result-text.test.js`；`agent-view.tsx`、`agent.css`、`contracts/recipes.js`、`recipe-output-directives.js` 和相关真实内部模块旅程只取本功能段。`scripts/fixtures/agent-layout-app.js` 的2026-10-24增量修复等待尺寸提交的旅程前置条件，保留原主题/布局断言并增加重复切换；`formal-agent-j25-settings-journey.js` 的相邻缩放循环及后续布局前复位也等待目标视口提交。
- 文档：SEM-F31/F38 的 2026-10-05/06 登记，J22/J29/J18 对应行、`agent-reading-2026-10-05.md` 和 `session-ai-diagnosis-2026-10-05.md` 的历史证据。
- 定向验证：正文组件、`agent-ui`、recipe 合同和 `renderer-style-guard`；个人记忆问答、J29 记忆参考、总结预算恢复和会话窗口问答旅程；涉及生产 renderer 先统一构建。
- 失败路径：恶意 HTML/URL、未闭合格式、Unicode、无句末边界长句、非法记忆引用、缺失根字段、取消及零部分保存。
- 容量边界：本 PR 不带新纪要 topics、`summary.minutes@3`、新输出额度、v33 或导出 schema 7。新 Schema 的阅读呈现属于 PR-06。
- 验收边界：历史两轮合成真实模型运行只证明当时样本，无法证明当前完整组合树或所有模型都遵循说明；本轮无人工视觉实机证据。

## PR-06 草稿：会话总结容量与三阶段质量

**标题**：`feat: 扩展会话总结容量并按话题撰写和核对纪要（SEM-F28/F33/F38/F39/F40；J29/J30/J31）`

**正文**：

旧分块总结的 8 KiB 中间结果上限会拒绝合法但信息较丰富的结果。新建原文 `summary.minutes@3` 冻结 `summary-quality@1`，先组织话题、再撰写纪要、最后核对来源。整场冻结输入适配时优先完整读取；否则先证明分块和至少两项归并适配，再按连续来源顺序执行 2–4 项归并，只提交核对后的单份结果。

采用 `SummaryMinutesV2` 的话题和来源结构，界面按“主要内容 / 决定 / 待办 / 需要注意”展示。中间/最终结果上沿 128/256 KiB，首次调用前从九组已登记候选冻结实际额度；单请求、上下文、序列化、缓冲、阶段/节点/请求数及跨 attempt 用量各自执法，未知 usage 保持未知，不裁切或自动压缩重试。

新增经原确认流程选择的 `deepseek-openai@2` 预设，正式模型 ID `deepseek-flash`，thinking high，请求/响应各 4 MiB。思考协议内容仅在有界内存中按协议回传，结束和取消后释放。用户当前模型用途和旧策略不自动切换。

- 新文件：`contracts/summary-quality.js`、`summary-quality-plan.js`、`summary-quality-executor.js`、相应 contract/schema/真实旅程与合成 fixture。
- 共同变更：`budget-axes.js`、recipes/directives、provider/Pi runtime、formal runner、operation/reader、request/interaction UI 合同、AgentView、model presets/settings、存储预算/计划/执行/模型策略。
- SQLite：只追加 v33，保留 v1–v32 SQL/checksum；持久化政策、冻结额度、阶段、计数和允许的诊断字段，不新增中间正文事实。新模型策略表与绑定策略映射随本功能一起升级。
- 导出：追加 schema 7；旧 schema 1–6、绑定、recipe 和恢复解释保持。失败和取消零部分产物。
- 规格：CONTEXT 的 V2 术语、SEM 2026-10-11 增量、J29/J30/J31-QUALITY/SIZE/MERGE/BUDGET/COMPAT、ADR 0021 和相关 ADR/架构段落；中间输出容量研究作为背景。
- 验证：容量候选预检零调用、完整覆盖、奇数叶归并、共享请求和用量、阶段幂等、后段拒绝/取消/失租、明确继续、旧结果/导出兼容、v32→v33 重开及外键清理，另有生产 renderer 与正式 Electron 旅程。
- `scripts/qualify-session-summary-cloud.js` 是独立的明确外发入口，会读取选定产品数据并向云端调用；本轮只审阅，不运行。历史记录的真实会话结果不得替代本轮授权或当前 revision 证据。
- 验收边界：2026-10-11 文档记录该切片当时的“联合验收完成”，本次当前候选是否达到相同范围依照本轮结果另判断；新 `deepseek-openai@2` 真实云端思考仍无证据，完整 J31 实机矩阵、长期采集和发布验收仍保留。

## 暂缓或随最终候选重新生成的内容

| 内容 | 处置建议 | 理由 |
|---|---|---|
| `.gitignore` 新增 `/.archify/`、`/media/` | 暂缓；若需合入，单独整理本地开发产物规则 | 与六项产品行为没有必需依赖，不连带提交派生工程 |
| `docs/research/tmspeech-frontend-comparison.md` | 独立 docs PR 或继续留在工作区 | 是前端交互研究；没有随附窗口实现，不扩大 PR-01 |
| `docs/validation/i3-nonaudio-results.json` | 最终候选产品载荷确定后校验/生成一次，并随实际对应的候选提交 | 报告绑定产品载荷，不能作为六个拆分中间树通用证据 |
| `docs/validation/personal-memory-synthetic-retrieval-2026-10-02.json` | 正常测试生成记录；与运行命令/候选身份一并说明 | 含计时等运行指标，测试会刷新；不是 PR-02 的实现文件 |
| 全量历史记录的源码指纹和测试数 | 作为有日期的历史证据保留 | 721 文件旧指纹与当前源码/测试清单不同，不能直接复用为当前树全量结果 |

归档不能只提交 15 个 active 删除：三组 archive 新文件和三份主 spec 必须与相应迁移一起纳入。归档 tasks/spec 有修订，应审阅内容差异，而不只检查移动路径。

## Standards

**已证实硬违规 0 项；判断性建议 1 项（非阻塞）。** `test/contracts/agent-loop-ownership.test.js:24` 对 `toolExecution: 'sequential'` 的源码字面匹配会因等价引号或格式改写失败，而真实 Pi 资格和旅程已有串行工具行为证据。建议依照 `docs/testing-strategy.md:379` 对固定实现形状断言的边界，复核这条重复断言的必要性。依赖禁用检查有已登记任务支撑，不与该条一并删除。本轮未修改测试。

这是 Haiku subagent 的 Standards 重点静态检查结论，不是完整审计；需求缺口另见 Spec，不把两轴合并为单一评级。

## Spec

**2026-10-23 已确认 1 项 P2 需求缺口，归 PR-03；2026-10-24 修复及验证见下方增量记录。** 合法 `429 Retry-After: 2` 且剩余运行期限足够时，宿主实际等待可以超过 1000ms。语义合同 `docs/semantic-contract.md:59` 要求快照保留等待阶段与次数、清空短等待元数据；runner `src/agent/execution-host/formal-agent-run-runner.js:305` 按此产生 `retry:null`。但 `src/agent/formal-run/agent-operation-service.js:719` 以 `!event.retry` 拒绝整条事件，SQLite/重载快照仍停在旧阶段，backoff 诊断和次数也丢失。

此外，仅放行 null 不足以修复：同文件 `:782` 的 `{ ...event.retry }` 会将 null 变为 `{}`，随后 `src/runtime/storage-worker/agent-execution-store.js:756` 的 exact 校验仍拒绝。修复应同时接受合法 null 并原样传递；需要补一条贯穿真实宿主进度→操作服务→SQLite→重读快照的长 Retry-After 旅程，验证等待阶段和无短等待元数据。2026-10-23 轮次只检查和编写草稿，未修改产品实现；上述原始发现保留为修复前证据。

未发现足够证据将本次抽查提升为全仓正确性结论。复杂语义由 Sonnet subagent 核查，主代理对上述需求、runner、operation 和 storage 路径逐段复核。

## 本轮验证结果与范围

测试执行交给 Haiku subagent，完整命令为固定 UTC 环境的一次 `npm test`，包含生产 renderer 类型检查/构建及 core、integration、evidence 三条 lane。Node `v22.22.2`、npm `10.9.7`；23 个顶层依赖已安装，manifest/lock 版本差异为 0，两项产品 native addon 存在。

默认运行使用合成输入、受控 provider/本机 HTTP 和独立临时 userData；没有执行真实云端资格、真实音源采集或既有产品数据写入。测试会正常刷新合成检索 JSON，已在写入前备份原始字节；初始 SHA-256 为 `84d48666fa038da02257f47de8a7eb712b4395733ed5a109db5d2812ef59fd96`。不会回滚用户原有报告。

唯一一轮 `TZ=UTC npm test` 返回 **1**，总耗时 229.317 秒：

| 检查 | 本轮结果 | 耗时 |
|---|---|---|
| renderer 类型检查与生产构建 | 退出码 0，随后进入测试 lane | 含于总耗时 |
| Core | 1,226/1,226；失败 0，跳过 0 | 77.118 秒 |
| Integration | 197/198；失败 1，跳过 0 | 146.626 秒 |
| Evidence | 统一运行中未执行；独立补验 248 项符合预期、1 项按设计跳过、0 失败，退出码 0 | 独立测试 20.862 秒 |

唯一失败位于 `test/integration/agent-layout-journey.test.js:18`：`SEM-F23/J18/J22: production Agent date and question layouts remain aligned across themes and sizes`，Electron 子进程退出码 expected `0`、actual `1`。单文件定向复跑一次仍返回 1（0/1，测试耗时 3.459 秒），同一退出码断言复现。随后为提取错误信息，直接启动现有 `scripts/fixtures/agent-layout-app.js` 一次，同样退出 1，stderr 为 `Expected values to be strictly equal: false !== true`。fixture 的 catch 只打印 `error.message`，无法确定内部断言行；面板几何、倒置日期禁用和关闭按钮宽度均仅为候选。没有观察到 EPERM，**不能归因为环境问题**。没有重跑已成功 Core；首次失败继续保留，独立检查不能改写整轮退出码。

补充实际命令为 `TZ=UTC node --test --experimental-test-isolation=none test/integration/agent-layout-journey.test.js`，以及 `TZ=UTC node --test --experimental-test-isolation=none "test/gate-0b/**/*.test.js" "test/gate-0c/**/*.test.js" "test/validation/**/*.test.js"`。Evidence 的 1 项跳过源于未启用 `RUN_NLS_NATIVE_QUALIFICATION`，不计作原生资格实机证据。两项补验未新增 tracked 文件写回。

测试对 tracked 文件的写回只有合成检索报告一项：初始 SHA-256 `84d48666fa038da02257f47de8a7eb712b4395733ed5a109db5d2812ef59fd96`，测试后 SHA-256 为 `a631db5aa54b6dbc8c6d172a5b3f783ed42f755fa4b99e782c7f659b2bcb9430`。query=100、document=16、answerable=80、no-answer=20、provider-call=101，以及 fixture/policy/比较摘要均未变化，仅更新计时指标。没有刷新 I3 或云端历史报告。

2026-10-23 既有证据只读核对：`docs/validation` 下递归 75 份 JSON，解析失败 0；本轮字段和值负扫描没有发现正文、绝对路径、设备名、音频扩展名或绝对时钟等疑似项。这个结果是自动扫描的范围结论，不是对任意语义隐私问题的穷尽证明。9 份含产品载荷身份的 JSON 中，仅 I3 非音频报告匹配当前载荷，其余 8 份为历史载荷。当时 359 个文件的产品载荷 SHA-256 为 `a05c42a32be3fa5c15c5476543bf35d791b228447fa9a734fab23db9f8340d78`；I3 的 11 项来源摘要无差异，报告仍为 `partial`，不证明真实两小时音频。旧 721 文件源码/测试指纹不匹配当前 730 文件范围；2026-10-11 总结报告没有绑定当前产品载荷，均只按历史证据解释。

## 合入前仍需验证的事项

- 按附表与本节说明构造每个实际候选树，保证没有漏掉未跟踪模块、Pi 依赖、许可证或归档文件；逐个候选执行对应定向旅程。
- PR-03 长 Retry-After 快照/诊断修复与 Agent 布局旅程前置条件修复应纳入相应候选；2026-10-24 定向验证见下方记录，拆分后仍按实际候选验证。
- 确认基础迁移不提前引入新总结阶段/额度，确认 PR-04/05 不依赖尚未落地的 v33；新契约版本、schema 7 和三阶段能力在 PR-06 同时落地。
- 最终候选的完整 CI 或本地三条 lane、I3 产品载荷绑定按该候选重新核对。已知历史实机及公网缺口按原门禁保留。

2026-10-23 两轴汇总：Standards 已证实硬违规 0 项、判断性建议 1 项，主要建议是复核脆弱的源码字面断言；Spec 已确认 1 项，主要缺口是长 Retry-After 等待阶段与诊断丢失。另有独立执行门禁：Agent 布局旅程全量及定向均退出 1。此为修复前结论；2026-10-24修复、根因与实际证据见下方增量，不将旧退出码改写为成功。

执行分工：Git/证据盘点、规范检查、完整测试与定向复验使用 Haiku subagent；复杂需求路径核查使用 Sonnet subagent；主代理负责跨功能边界、依赖、草稿撰写和已确认需求问题的代码复核。

以上是本地 PR 请求草稿；没有已发布 PR，也没有把当前混合工作区整理成可直接推送的六条分支。

## 2026-10-24 两项修复增量（SEM-F23/F28/F38/F40；J18/J22/J30-PROGRESS/DIAG）

### 根因与修复

长 Retry-After 的缺陷类别是更新协议未保留“缺省 / 清空 / 新值”三者区别。`AgentOperationService.recordProgress` 现接受等待阶段合法的 `retry:null`，`persistProgress` 将 null 原样交给既有存储清空；短等待仍限制0–1000ms、请求次数2–5及既有错误闭集。数据结构仍为原 `retry` 更新字段，无新表、迁移或公开字段。

真实旅程又暴露诊断合同的相邻缺口：宿主已有无预算轴的 backoff 次数，但记录校验只接受容量预检。因此 `assertDiagnosticRecord` 追加严格的退避次数分支，要求 `backoff/retry_wait`、合法暂态错误、单位count、上限5与次数2–5；其它无轴指标仍拒绝。修复前跨模块回归在长等待快照处变红，修复快照后在次数断言得到空数组，再经合同红测确认拒绝原因。

布局缺陷类别是跨进程观察未等待状态提交。固定100ms后，native尺寸、renderer视口和zoom仍可能来自不同轮次。原旅程先定位到 `light/720/1.25: noPageOverflow`；只将100ms变为0ms的单变量探针确认：请求1100px时renderer仍报720px，随后展开生成记录前后读取高度相差121.16px。fixture现等待native尺寸与目标一致（原生整数换算容差2 DIP），并核对renderer视口与当前content尺寸/zoom一致（舍入容差1 CSS px），再执行原有全部布局断言；未改产品CSS、窗口尺寸政策或溢出标准。

### 同类模式搜索及处置

可复现检索使用仓库根的 ripgrep：

```bash
rg -n 'retry\s*!==\s*undefined|\.{3}\s*(event|input)\s*\.\s*retry|retry\s*:\s*null' src
```

- `agent-operation-service.js` 校验与拷贝为本次两处修复。
- `formal-agent-run-runner.js` 产生对象/null、`agent-execution-store.js` 明确区分缺省/null并exact校验、`session-summary-run-ui.js` 接受可空快照，均保留。
- `outputValidation` 的整体null不合法，只有actual/limit允许成对null；它的拷贝与拒绝不属于同类缺陷。

```bash
rg -n 'known metrics without an axis|record\.metrics\.actual !== null|backoff.*metrics' src
```

诊断合同是唯一无轴已知指标拒绝处，本次修复；renderer按实际diagnostic渲染计数，保留。`AgentRunDiagnostics.buildRecord` 复用同一合同，没有第二套放行逻辑。

```bash
rg -n 'await wait\(100\)|setZoomFactor\(' scripts/fixtures
```

`agent-layout-app.js` 的固定等待已替换。相邻 `formal-agent-j25-settings-journey.js` 的缩放循环也属于同类前置条件缺口：同次 DOM 相对几何不能证明 125%–200% 的目标缩放已提交。它现经既有有界 `waitFor` 核对视口与内容尺寸/目标缩放一致后再执行原断言；继续读取布局前的复位同样等待。`finally` 中的缩放复位仅清理外部边界状态，后面没有布局断言，保留同步调用。临时 `[DEBUG-layout-geometry]` 输出已删除。

### 红测与定向验证

所有简单检查和测试由Haiku subagent执行；Sonnet对本轮有限片段做静态复核，未发现新增阻断风险，不能替代运行证据。

- `TZ=UTC node --test --experimental-test-isolation=none test/integration/session-summary-budget-recovery-journey.test.js`：首次在原旅程首次外发前5秒等待处失败；原命令复跑触达新增长等待断言并退出1。快照修复后，失败后移至backoff次数为空数组。上述失败均保留，不记作环境问题或成功。
- `TZ=UTC node --test --experimental-test-isolation=none test/contracts/agent-run-diagnostics-contract.test.js`：新增合法backoff次数场景按预期在合同处变红，4/5，退出1。
- 修复后同次执行诊断合同、诊断服务及预算恢复旅程3文件：15/15，退出0，5.406秒。验证短等待→长等待的SQLite重读、清空短字段、次数2/3、取消终态/租约释放与零新外发。
- `session-summary-run-progress.test.js` 为11/11、`session-summary-request-store.test.js` 为19/19，均退出0；仍保留非法次数及旧短等待边界。
- `TZ=UTC node --test --experimental-test-isolation=none test/integration/agent-layout-journey.test.js`：修复后连续3次各1/1、退出0，7.710/6.145/7.778秒，包含深浅主题及重复尺寸切换；不替代Windows真实DPI、DWM或人工视觉验收。

### 修复后的完整确定性回归与证据身份

Haiku 在项目根目录执行以下命令，完整回归退出0，总墙钟270.562秒；renderer类型检查与Vite生产构建均执行。

```bash
env -u ELECTRON_RUN_AS_NODE TZ=UTC npm test
```

| lane | 总项数 | 成功项 | 失败项 | 跳过项 | 耗时 |
|---|---:|---:|---:|---:|---:|
| core | 1227 | 1227 | 0 | 0 | 79.132秒 |
| integration | 198 | 198 | 0 | 0 | 156.563秒 |
| evidence | 249 | 248 | 0 | 1 | 25.603秒 |
| 合计 | 1674 | 1673 | 0 | 1 | 270.562秒总墙钟 |

唯一跳过项为未请求的显式 NLS native 资格。该完整运行包含长等待及布局修复，对应后续 J25 相邻缩放等待补改前的工作树；J25 最终定向结果另记，不将两次运行合称最终工作树重新执行了完整三条 lane。

本次源码改变使既有 I3 的产品载荷摘要漂移；严格校验先按预期拒绝旧报告。备份原字节后，以原参数刷新一次，并严格校验：

```bash
env -u ELECTRON_RUN_AS_NODE TZ=UTC node scripts/i3-nonaudio-soak.js --segments 3600 --batch-size 100 --report docs/validation/i3-nonaudio-results.json
```

```bash
env -u ELECTRON_RUN_AS_NODE TZ=UTC node scripts/verify-i3-nonaudio-report.js docs/validation/i3-nonaudio-results.json
```

两条命令均退出0；结果为 `pass/partial`，3600段、4000个字幕事件、400个精修段，14项检查均为true。虚拟时长7200000ms，实际soak指标10.134秒。生产构建后的产品载荷及11个源码来源摘要仍匹配，`productPayloadSha256=95cabe17db139d1be299ce8935fd7de7a32e0c94074ae0a6a2e540afb22404d0`，I3报告文件SHA-256为 `9533674a99bf8ee7aa13fbbef99d1439bb09e75db0d50e9aaba5fbd39edc1145`。

合成检索报告仅正常刷新 `buildDurationMs` 与 `queryDurationMs.p50/p95/max` 四个计时字段，其余内容不变，`publicCloudValidated=false`；文件SHA-256由 `a631db5aa54b6dbc8c6d172a5b3f783ed42f755fa4b99e782c7f659b2bcb9430` 变为 `a1a52d76a93f81417a731bf4f2d17766d89b0944b3b989b89585b0bb86645187`。两份原字节备份位于忽略的 `.artifacts/agent-fixes-2026-10-24/`，不随PR提交。

J25 相邻缩放等待补改后，Haiku 执行以下定向命令为2/2，失败/跳过0，退出0，27.966秒；保留全部原控件、取消、诊断和重启断言。此后产品源码没有新增改动，无需重复已成功的完整回归。

```bash
env -u ELECTRON_RUN_AS_NODE TZ=UTC node --test --experimental-test-isolation=none test/integration/agent-redesign-j25-formal-settings-journey.test.js
```

当前状态为**实现完成·尚未验收**；没有真实公网 provider、现场音频、系统 DPI/DWM 人工观察或两小时实机稳定性证据，也没有暂存、提交、推送或创建 GitHub PR。六个拆分候选树仍须各自取得证据。
