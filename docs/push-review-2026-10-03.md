# GitHub 推送范围预览 · 2026-10-03

本轮按用户要求先盘点提交与拟推送范围。以下保留 2026-10-03 的盘点快照，不提升任何产品能力的验收状态。

2026-10-04 更新：用户已授权本地提交，并指定 GPT-6.1 Sol / high 子 agent 负责提交，主 agent 负责审查和异常处理。当前验证为 Core 1163/1163、Integration 165/165、Evidence 248 项成立/1 项明确跳过/0 失败；保存竞态连续 15 轮成立，打包记忆旅程及默认产品壳 fresh/restart 自然退出绑定成立。异常根因、实际命令、打包摘要与未验证范围见[提交整理记录](validation/commit-preparation-2026-10-04.md)。

实际新增提交按共享代码依赖组合为三组：实现与对应语义/旅程/验证记录；四项未来规划；界面实拍、研究与推送盘点。下文七个主题仍用于理解内容，不表示七条独立提交。原有 23 条提交不改写；实际新增哈希在提交后另行展示。push 仍须用户过目最终范围后执行。

暂存核对补记：首次把未跟踪规划文件纳入 `git diff --cached --check` 后，10 份文档暴露末尾多余空行。主 agent 已仅修剪这些末尾空行，保留全部正文、规划任务和状态；提交子 agent 重暂存后继续严格核对。先前的工作树 `git diff --check` 只覆盖已跟踪内容，不能替代这项暂存检查。

目标仓库：[JoshuaChen2008/Speech-Agent](https://github.com/JoshuaChen2008/Speech-Agent)。拟推送分支：`codex/agent-progress` → `origin/codex/agent-progress`。

口径依据：[规范术语](../CONTEXT.md)、[语义合同](semantic-contract.md)（SEM-F14、SEM-T01/T02/T03/T04/T05/T06）、[验证分层](testing-strategy.md#21-开发反馈与全量门禁2026-09-08sem-t03j9-ci)（J9-CI、J12、J18、J20、J28、J29/J30/J31、DB1/DB7）。

## 1. 当前提交与分支

当前 HEAD：`a591d4f`；远端同名分支：`b49a940`。当前分支领先 23 条、落后 0 条，允许按现有历史正常向前推送。

| 本地分支 | HEAD | 相对跟踪分支 | 尚未出现在任何 origin 分支的提交 | 当前 HEAD 未包含的提交 |
|---|---|---|---:|---:|
| `codex/agent-progress`（当前） | `a591d4f` | 领先 23 / 落后 0 | 23 | 0 |
| `codex/agent-redesign-plan` | `1b0ca11` | 领先 45 / 落后 0 | 0 | 0 |
| `codex/b1-application-skeleton` | `1f39338` | 领先 79 / 落后 0 | 0 | 0 |
| `claude/priceless-davinci-45903b` | `d8e9a6f` | 无跟踪分支 | 0 | 0 |
| `feat/ui-design-system` | `7a902c5` | 无跟踪分支 | 0 | 0 |
| `master` | `7a902c5` | 无跟踪分支 | 0 | 0 |

全仓去重后只有 23 条本地提交未出现在 origin；45 与 79 是相对较旧跟踪分支的计数，不能相加。全部本地分支历史都已包含在当前 HEAD 中。当前 HEAD 共有 315 条祖先提交，相对 `origin/main`（`fecb4c4`）多 216 条；216 包含已在其它远端分支存在的历史，不是本次新增提交数。

### 已提交、尚未推送的 23 条记录

按历史顺序列出原提交标题，保留审计事实；标题中的 evidence 或 acceptance 不替代语义合同的验收口径。

| # | 提交 | 日期 | 原提交标题 |
|---:|---|---|---|
| 1 | `ba95c03` | 2026-09-23 | feat(asr): add NLS realtime recognition and local fallback |
| 2 | `33ed93f` | 2026-09-25 | test(window): add bounded toolbar reload diagnostics |
| 3 | `a6da544` | 2026-09-25 | docs(agent): sync redesign progress evidence |
| 4 | `c2bae9a` | 2026-09-25 | docs(research): record cloud realtime ASR options |
| 5 | `120430c` | 2026-09-26 | docs(validation): record CI reload and B5 evidence limits (SEM-F22/J17) |
| 6 | `dbf3128` | 2026-09-27 | fix: reconcile session summary terminal feedback |
| 7 | `ba65f95` | 2026-09-27 | 修复 NLS PCM 发送节拍累积（SEM-F12/J20） |
| 8 | `8ad2dc7` | 2026-09-27 | feat(agent): persist session summary request acceptance |
| 9 | `1054b10` | 2026-09-27 | feat(agent): bind summary acceptance to frozen inputs (SEM-F38/J30-ACCEPT) |
| 10 | `779ec10` | 2026-09-28 | feat(agent): wire versioned summary requests (SEM-F38/J30-ACCEPT) |
| 11 | `cc6a718` | 2026-09-28 | feat(agent): wire session summary progress (SEM-F38/J30-PROGRESS) |
| 12 | `e69cf1b` | 2026-09-28 | fix: propagate session summary cancellation through storage reads |
| 13 | `d88e58b` | 2026-09-28 | fix: fence session summary lease writes |
| 14 | `00ddf7b` | 2026-09-28 | fix: resume interrupted session summaries |
| 15 | `dedfe27` | 2026-09-28 | feat(agent): persist summary execution budgets |
| 16 | `b91a8db` | 2026-09-28 | feat(agent): add local summary diagnostics |
| 17 | `efffb2e` | 2026-09-28 | feat(agent): add summary diagnostic query and export |
| 18 | `19060d0` | 2026-09-28 | test(agent): verify diagnostic privacy and subtitle independence |
| 19 | `43415e6` | 2026-09-28 | test(agent): close diagnostics retention boundary |
| 20 | `41501aa` | 2026-09-28 | feat(agent): register versioned summary budget policy |
| 21 | `2959732` | 2026-09-28 | test(agent): close out P1 Electron acceptance evidence |
| 22 | `ebe5fb7` | 2026-09-28 | test(validation): refresh I3 prequalification evidence |
| 23 | `a591d4f` | 2026-09-28 | test(agent): extend P1 Electron journey evidence |

这 23 条提交的差异覆盖 167 个文件，增加 17,760 行、删除 1,017 行。

## 2. 未提交工作区

以下统计在新增本文之前取得：154 个已跟踪文件在 Git 状态中有变更，174 个未跟踪文件，暂存区 0 个文件。内容 diff 为 153 个文件、增加 6,562 行、删除 2,084 行；`formal-agent-job-scheduler.js` 在状态中显示修改，但规范化后的内容 diff 为空，整理时核对该差异。行数不包含未跟踪文件。

| 范围 | 文件数（已跟踪变更 + 未跟踪） | 主要内容 |
|---|---:|---|
| `src/` | 108 | Agent 执行、模型接入、个人上下文、存储、主进程/preload、识别及各 renderer |
| `test/` | 76 | 合同 11、main 14、runtime 10、storage 6、UI 9、integration 24（含辅助代码）、validation 2 |
| `docs/` | 76 | 语义/旅程、架构/ADR、研究、指南、验证与界面实拍 |
| `openspec/` | 45 | 既有变更修订与七个新增方案目录 |
| `scripts/` | 11 | 原生构建、诊断、Electron 旅程及打包检查 |
| `native/` | 2 | 个人记忆文件 Win32 原生模块源码与 binding.gyp |
| 根目录及本地附件 | 10 | 配置、依赖、规范文档，以及下述三个排除项 |

### 拟整理为新增提交的七个实现主题

这些是提交分组建议，尚未形成新增提交哈希。共享 `main`、存储 schema、recipe 和预算合同须按依赖组合；每组携带对应语义登记、旅程及验证记录。

| 分组 | 拟提交内容 | 主要约束 / 验证位置 |
|---|---|---|
| 1. 会话总结与长输入 | 分块计划、分页来源、节点执行和归并；取消/终态/预算恢复；模型输出合同、请求容量、失败重试未知用量与版本化导出 | SEM-F28/F31/F33/F38/F39/F40；J29/J30/J31、DB1 |
| 2. 提问优先个人记忆 | 提问摘要、候选筛选/综合、个人记忆综合视图、来源查看与治理；总结参考偏好及普通总结零自动写入 | SEM-F26/F30/F31/F32/F37/F38；J21/J28/J29、DB7/J12 |
| 3. 总结检索优先问答 | 会话经历分段整理、总结与原文共同检索、日期/项目范围、逐结论依据与历史精确来源跳转 | SEM-F28/F30/F31/F33/F39/F40；J22/J24/J29/J31、DB1/DB7/J10 |
| 4. 个人记忆文件与索引 | Markdown 正文权威、Win32 独占写入、迁移/修订/恢复/治理携带；独立表征配置、关键词/向量统一检索；YAML 依赖及原生模块打包 | SEM-F41/F42；J28-FILES/J24-RETRIEVAL/J29/J30、DB7/J12、B5 |
| 5. 个人记忆内容导出与只读 MCP | 明确选择/预览/复制/Markdown 或 JSON 导出；默认关闭的本机只读 MCP、精确授权及修订失效 | SEM-F43/F44；J28-EXPORT/J28-MCP/J21/J12、DB7 |
| 6. NLS 与本地降级 | 发送节拍、中断和云端长段连续性修复；云端轻量 worker、故障后本地模型冷加载、单向降级进度、停止/退出收束及诊断脚本 | SEM-F06/F12/F14/F17/F21/F25；J20/J16、ADR0020 |
| 7. 界面与窗口 | Speech-Agent 展示名称及规范文案；字幕助手日期/提问布局、关闭按钮和主题同步；设置/历史来源组件、窗口打开/返回与层级；实拍档案和用语评审 | SEM-F11/F14/F22/F23/F28/F38、SEM-T05；J10/J17/J18/J22/J29 |

`package-lock.json` 与 `package.json` 一起提交；原生模块提交源码与构建/实际加载检查，二进制仍按现有忽略规则处理。界面档案包含 29 张实际窗口原图与 1 张浏览预览图，采集记录说明独立应用数据目录、未启动字幕会话或模型请求；用于设计评审，不替代旅程验收。归档前仍逐项核对图片内容。

### 规划文档另列

下表是 OpenSpec checkbox 的事实计数，不代表功能或验收状态。四项没有勾选任务的方案作为已决定的规划文档纳入范围，不在本次整理中扩展为新实现。

| change | 已勾选任务 | 未勾选任务 | 整理时的处理 |
|---|---:|---:|---|
| `add-personal-memory-sharing` | 6 | 0 | 携带实现与验证记录；状态仍为实现完成·尚未验收 |
| `implement-summary-first-session-question` | 16 | 0 | 携带实现与验证记录；状态仍为实现完成·尚未验收 |
| `restore-deepseek-session-summary` | 9 | 1 | 保留开放任务与未验证范围 |
| `clarify-memory-and-session-summary` | 36 | 3 | 保留历史批量整理、实机及提交前复核缺口 |
| `fix-session-summary-lifecycle-and-long-input` | 30 | 16 | 保留容量、资源、正式 Electron 矩阵及实机缺口 |
| `centralize-agent-runtime-loop` | 0 | 8 | 仅规划 |
| `consolidate-agent-operations` | 0 | 9 | 仅规划 |
| `separate-agent-provider-protocol` | 0 | 8 | 仅规划 |
| `reduce-nls-streaming-latency` | 0 | 26 | 仅规划；已有节拍/连续性修复不能冒充整个方案实施 |

## 3. 排除项与提交前核对

- 根目录 `*_session-*_original.md`：用户字幕原文导出，保留本地，排除提交。
- `.codex-remote-attachments/`：本地参考图片，排除提交。
- `.zcodeignore`：本地工具配置，默认排除提交。
- 现有忽略规则继续排除 `node_modules/`、模型、`.artifacts/`、renderer/build/out 产物、原生二进制与日志。

本轮没有修改上述排除项，也没有改写已有提交。实际暂存时使用明确文件清单，并在 `.gitignore` 登记必要的本地文件排除规则。

本轮静态核对：`git diff --check` 返回码 0；未发现被现有忽略规则命中却仍受跟踪的文件。当前变更的四份 validation JSON 均能解析，初步字段/路径筛查没有命中；当前候选文本文件及 23 条未推送提交的历史 patch 未命中私钥、常见 API 密钥和 GitHub Token 模式。模式筛查不能替代严格报告 verifier、文件内容及图片审阅。

## 4. 已有测试异常记录与后续处理

本轮仅盘点与静态检查，未重新运行 renderer 构建或测试 lane。下表来自仓库已有验证记录，不能投影为当前最终修订的执行结果。

| 异常 | 已有证据与处理事实 | 当前整理需要做的事 |
|---|---|---|
| J18 Electron 开发入口 `ERR_FAILED` / GPU 启动异常 | 2026-10-02 总结检索记录中的完整 integration 为 148/148，并记录受限沙箱外同一开发入口成立；较后的记忆文件记录为 159/160，唯一失败仍为 localhost Vite renderer `ERR_FAILED` | 复现当前环境，核对服务生命周期与子进程日志；环境限制须用适当权限重验，内部断言失败须修代码；不跳过测试或降低断言 |
| I3 报告源码/产品载荷哈希过期、UTC 基线不一致 | 既有记录使用原 `i3-nonaudio-soak.js` 在 UTC 下重新生成后，evidence 为 248 项成立、1 项按设计跳过、0 失败 | 最终代码冻结后用原生成器重建必要的报告，执行 strict verifier；不手改哈希，不把非音频预资格晋级为实机证据 |
| 模型设置未知能力校验提示被展开事件清除 | 总结检索交付记录已修复并增加展开后的断言，相关文件 5/5，随后纳入 1156/1156 Core | 在本次全量中确认该修复仍成立 |
| 重试后只报告成功请求用量 | 2026-09-30 旅程记录已先复现失败，再修复失败请求用量缺失时整体保持未知；定向 49/49 | 保留回归，并在本次模型接入/预算测试中核对 |
| NLS 周期迟到及长段中断 | 已有诊断分别复现发送积压和旧 50 秒长段策略造成的降级；后续修订保留 2 秒待发/60 秒留存硬限，云端长段连续性以后续记录为准 | 执行当前 J20 真实内部模块旅程；公网、物理音源、延迟及两小时 I3 保持实机边界 |

记录入口：[个人记忆文件](validation/personal-memory-files-2026-10-02.md)、[总结检索优先问答](validation/session-question-summary-first-2026-10-02.md)、[提问优先个人记忆](validation/personal-memory-optimization-2026-10-01.md)、[个人记忆对外读取](validation/personal-memory-sharing-2026-10-03.md)、[NLS 中断](validation/nls-interruption-investigation-2026-09-30.md)、[云端资源与自动冷加载](validation/cloud-fallback-memory-2026-09-30.md)、[测试策略](testing-strategy.md)。

较后的个人记忆对外读取记录只覆盖 renderer 构建和相关 29 项定向断言（后补 sharing 4 项、样式守卫 10 项）；没有给出该修改后的完整三条 lane。因此，不能以 2026-10-02 较早的全量结果直接批准当前 push。

## 5. 实际 push 前的执行顺序

1. 根据本清单核对文件内容与排除项；检查术语、语义登记、OpenSpec 和文档链接，保留未验收/未实施事实。
2. 在当前最终代码上运行一次完整 `npm test`（统一 renderer 类型检查/生产构建，依次 core、integration、evidence）。若前一 lane 非零使后续未运行，修复并补足后续检查，不记作成功。
3. 对异常自主定位、修复并记录触发条件、根因、实际命令、结果及未验证范围。只在外部边界受到限制时改变执行环境，不以替换内部产品模块、跳过断言或修改要求消除失败。必要的 I3 报告由原生成器重建。
4. 因涉及新 Win32 原生模块与 package allowlist，核对原生构建/实际加载、smoke 包布局与相关打包旅程；安装器、真实公网、物理采集、DWM、长稳及干净机仍按各自证据要求处理。
5. 根据依赖形成新增提交。按 `testing-strategy.md` §2 和既有任务要求，大改动 commit 前由指定 Luna 子 Agent 复核语义与功能；复核发现的问题与修复一并登记。保留已有 23 条提交的历史。
6. 向用户展示实际新增提交哈希、最终 diff/排除清单、完整验证及异常处理记录。用户过目确认后，向 `origin/codex/agent-progress` 执行正常 push，并核验远端 HEAD。

当前 `.github/workflows/ci.yml` 只在 PR、main/tag push 与手动触发运行完整 CI；推送该功能分支本身不自动触发全量。因此本次最终修订的本地验证记录需要明确留存。

## 6. 文件清单快照

下列清单按本轮实际 Git 状态生成，供逐项过目。新增本文另列入文档提交；以下快照未包含本文自身。

纳入盘点的已跟踪状态条目 154 个、拟纳入的未跟踪文件 171 个；另有 3 个排除项已在 §3 说明。标记 M 表示已跟踪变更，? 表示未跟踪文件；状态显示 M 但内容无差异的调度器文件按 §2 核对。

### 根目录（7）

```text
M .gitignore
M AGENTS.md
M CONTEXT.md
M electron-builder.config.cjs
M package-lock.json
M package.json
M README.md
```

### docs（76）

```text
M docs/adr/0016-unified-agent-execution-path.md
M docs/adr/0018-two-tier-intent-convergence.md
M docs/adr/0020-nls-realtime-recognition.md
M docs/adr/0021-summary-lifecycle-and-long-input.md
? docs/adr/0022-windowed-session-question-input.md
? docs/adr/0023-chunked-session-question-input.md
? docs/adr/0024-summary-first-session-question.md
? docs/adr/0025-user-controlled-personal-memory.md
? docs/agent-refactor-roadmap.md
M docs/agent-ui-ux-handoff.md
M docs/data-architecture.md
? docs/personal-memory-guide.md
? docs/personal-memory-question-first-plan.md
? docs/research/agent-model-settings-reference-2026-09-28.md
? docs/research/cc-switch-api-settings-2026-09-28.md
? docs/research/personal-memory-experience-proposal-2026-09-30.md
? docs/research/personal-memory-file-ownership-hybrid-retrieval-2026-10-02.md
? docs/research/personal-memory-markdown-storage-2026-10-02.md
? docs/research/personal-memory-portability-2026-09-30.md
? docs/research/session-question-summary-retrieval-2026-10-01.md
M docs/runtime-architecture.md
M docs/semantic-contract.md
? docs/session-question-summary-first-plan.md
M docs/testing-strategy.md
? docs/ui-actual/captures/2026-10-03-2/01-agent-initial-dark.jpg
? docs/ui-actual/captures/2026-10-03-2/02-agent-range-qa-dark.jpg
? docs/ui-actual/captures/2026-10-03-2/03-agent-cross-session-dark.jpg
? docs/ui-actual/captures/2026-10-03-2/04-agent-project-empty-dark.jpg
? docs/ui-actual/captures/2026-10-03-2/05-agent-cross-session-light.jpg
? docs/ui-actual/captures/2026-10-03-2/06-agent-narrow-light.jpg
? docs/ui-actual/captures/2026-10-03-2/index.html
? docs/ui-actual/captures/2026-10-03-2/index.md
? docs/ui-actual/captures/2026-10-03/01-onboarding.jpg
? docs/ui-actual/captures/2026-10-03/02-settings-display.jpg
? docs/ui-actual/captures/2026-10-03/03-settings-audio.jpg
? docs/ui-actual/captures/2026-10-03/04-settings-recognition-top.jpg
? docs/ui-actual/captures/2026-10-03/05-settings-recognition-bottom.jpg
? docs/ui-actual/captures/2026-10-03/06-settings-resources-bottom.jpg
? docs/ui-actual/captures/2026-10-03/07-settings-resources-top.jpg
? docs/ui-actual/captures/2026-10-03/08-settings-memory-top.jpg
? docs/ui-actual/captures/2026-10-03/09-settings-memory-overview.jpg
? docs/ui-actual/captures/2026-10-03/10-settings-personal-memory.jpg
? docs/ui-actual/captures/2026-10-03/11-settings-session-points.jpg
? docs/ui-actual/captures/2026-10-03/12-settings-assistant-model-top.jpg
? docs/ui-actual/captures/2026-10-03/13-settings-assistant-model-bottom.jpg
? docs/ui-actual/captures/2026-10-03/14-settings-model-services.jpg
? docs/ui-actual/captures/2026-10-03/15-settings-new-model-service.jpg
? docs/ui-actual/captures/2026-10-03/16-settings-about.jpg
? docs/ui-actual/captures/2026-10-03/17-toolbar.jpg
? docs/ui-actual/captures/2026-10-03/18-caption-idle.jpg
? docs/ui-actual/captures/2026-10-03/19-history-empty.jpg
? docs/ui-actual/captures/2026-10-03/20-agent-initial.jpg
? docs/ui-actual/captures/2026-10-03/21-agent-range-qa.jpg
? docs/ui-actual/captures/2026-10-03/22-agent-cross-session.jpg
? docs/ui-actual/captures/2026-10-03/23-agent-project-empty.jpg
? docs/ui-actual/captures/2026-10-03/index.html
? docs/ui-actual/captures/2026-10-03/index.md
? docs/ui-actual/gallery-preview.jpg
? docs/ui-actual/index.html
? docs/ui-actual/README.md
? docs/ui-copy-review.md
? docs/ui-reviews/2026-10-03-session-summary-readonly-review.md
? docs/user-controlled-personal-memory-proposal.md
? docs/validation/cloud-fallback-memory-2026-09-30.md
M docs/validation/i3-nonaudio-results.json
? docs/validation/nls-interruption-investigation-2026-09-30.md
? docs/validation/nls-latency-investigation-2026-09-27.md
? docs/validation/personal-memory-files-2026-10-02.md
? docs/validation/personal-memory-optimization-2026-10-01.md
? docs/validation/personal-memory-sharing-2026-10-03.md
? docs/validation/personal-memory-synthetic-retrieval-2026-10-02.json
M docs/validation/README.md
? docs/validation/session-question-summary-first-2026-10-02.json
? docs/validation/session-question-summary-first-2026-10-02.md
M docs/validation/toolbar-reload-diagnostic-2026-09-21.md
? docs/validation/toolbar-reload-investigation-2026-09-26.json
```

### native（2）

```text
? native/memory-file/binding.gyp
? native/memory-file/memory_file_native.cc
```

### openspec（45）

```text
? openspec/changes/add-personal-memory-sharing/.openspec.yaml
? openspec/changes/add-personal-memory-sharing/design.md
? openspec/changes/add-personal-memory-sharing/proposal.md
? openspec/changes/add-personal-memory-sharing/specs/personal-memory-sharing/spec.md
? openspec/changes/add-personal-memory-sharing/tasks.md
? openspec/changes/centralize-agent-runtime-loop/.openspec.yaml
? openspec/changes/centralize-agent-runtime-loop/design.md
? openspec/changes/centralize-agent-runtime-loop/proposal.md
? openspec/changes/centralize-agent-runtime-loop/specs/agent-runtime-ownership/spec.md
? openspec/changes/centralize-agent-runtime-loop/tasks.md
M openspec/changes/clarify-memory-and-session-summary/design.md
M openspec/changes/clarify-memory-and-session-summary/proposal.md
M openspec/changes/clarify-memory-and-session-summary/specs/personal-memory-overview/spec.md
M openspec/changes/clarify-memory-and-session-summary/specs/session-summary-experience/spec.md
M openspec/changes/clarify-memory-and-session-summary/tasks.md
? openspec/changes/consolidate-agent-operations/.openspec.yaml
? openspec/changes/consolidate-agent-operations/design.md
? openspec/changes/consolidate-agent-operations/proposal.md
? openspec/changes/consolidate-agent-operations/specs/agent-operation-facade/spec.md
? openspec/changes/consolidate-agent-operations/tasks.md
M openspec/changes/fix-session-summary-lifecycle-and-long-input/design.md
M openspec/changes/fix-session-summary-lifecycle-and-long-input/proposal.md
M openspec/changes/fix-session-summary-lifecycle-and-long-input/specs/session-summary-long-input/spec.md
M openspec/changes/fix-session-summary-lifecycle-and-long-input/tasks.md
? openspec/changes/implement-summary-first-session-question/.openspec.yaml
? openspec/changes/implement-summary-first-session-question/design.md
? openspec/changes/implement-summary-first-session-question/proposal.md
? openspec/changes/implement-summary-first-session-question/specs/summary-first-question/spec.md
? openspec/changes/implement-summary-first-session-question/tasks.md
? openspec/changes/reduce-nls-streaming-latency/.openspec.yaml
? openspec/changes/reduce-nls-streaming-latency/design.md
? openspec/changes/reduce-nls-streaming-latency/proposal.md
? openspec/changes/reduce-nls-streaming-latency/research.md
? openspec/changes/reduce-nls-streaming-latency/specs/nls-streaming-latency/spec.md
? openspec/changes/reduce-nls-streaming-latency/tasks.md
? openspec/changes/restore-deepseek-session-summary/.openspec.yaml
? openspec/changes/restore-deepseek-session-summary/design.md
? openspec/changes/restore-deepseek-session-summary/proposal.md
? openspec/changes/restore-deepseek-session-summary/specs/deepseek-summary-recovery/spec.md
? openspec/changes/restore-deepseek-session-summary/tasks.md
? openspec/changes/separate-agent-provider-protocol/.openspec.yaml
? openspec/changes/separate-agent-provider-protocol/design.md
? openspec/changes/separate-agent-provider-protocol/proposal.md
? openspec/changes/separate-agent-provider-protocol/specs/agent-provider-exchange/spec.md
? openspec/changes/separate-agent-provider-protocol/tasks.md
```

### scripts（11）

```text
? scripts/build-memory-file-native.js
? scripts/diagnose-nls-interruption.js
? scripts/diagnose-nls-pacing.js
? scripts/fixtures/agent-layout-app.js
? scripts/fixtures/cloud-fallback-native-app.js
M scripts/fixtures/formal-agent-j25-settings-journey.js
? scripts/fixtures/personal-memory-electron-journey.js
? scripts/fixtures/personal-memory-package.config.cjs
M scripts/fixtures/renderer-development-entry-app.js
M scripts/packaged-native-load-probe.js
M scripts/verify-package-layout.js
```

### src（108）

```text
M src/agent/agent-view.tsx
M src/agent/agent.css
M src/agent/contracts/agent-context-ui.js
M src/agent/contracts/agent-run-diagnostics.js
M src/agent/contracts/agent-run-ui.js
M src/agent/contracts/budget-axes.js
? src/agent/contracts/personal-memory-file-ui.js
? src/agent/contracts/personal-memory-sharing.js
? src/agent/contracts/recipe-output-directives.js
M src/agent/contracts/recipes.js
M src/agent/contracts/session-summary-run-ui.js
M src/agent/execution-host/agent-loop.js
M src/agent/execution-host/context-ingest-session-runner.js
M src/agent/execution-host/formal-agent-job-scheduler.js
M src/agent/execution-host/formal-agent-run-runner.js
M src/agent/execution-host/index.js
M src/agent/execution-host/intent-route-orchestrator.js
M src/agent/execution-host/intent-router.js
? src/agent/execution-host/question-evidence-executor.js
? src/agent/execution-host/session-experience-executor.js
? src/agent/execution-host/summary-input-plan.js
? src/agent/execution-host/summary-input-source.js
? src/agent/execution-host/summary-plan-executor.js
M src/agent/formal-run/agent-interaction-exporter.js
M src/agent/formal-run/agent-run-service.js
M src/agent/formal-run/session-summary-run-service.js
M src/agent/index.html
M src/agent/model-access/connection.js
? src/agent/model-access/embedding-access.js
M src/agent/model-access/index.js
M src/agent/model-access/openai-compatible-adapter.js
M src/agent/model-access/runtime.js
M src/agent/personal-context/controller.js
M src/agent/personal-context/index.js
? src/agent/personal-context/memory-file-client.js
? src/agent/personal-context/memory-file-format.js
? src/agent/personal-context/memory-file-runtime.js
? src/agent/personal-context/memory-file-worker.js
? src/agent/personal-context/memory-mcp-server.js
? src/agent/personal-context/memory-sharing.js
? src/agent/personal-context/question-memory-source.js
M src/agent/personal-context/runtime.js
M src/caption/index.html
M src/contracts/recognition.js
M src/contracts/runtime-snapshot.js
M src/history/history-view.tsx
M src/history/history.css
M src/history/index.html
M src/main.js
M src/main/application-window-lifecycle-controller.js
M src/main/ipc/access-policy.js
M src/main/ipc/channels.js
? src/main/ipc/context-source-ipc.js
? src/main/ipc/personal-memory-file-ipc.js
M src/main/services/electron-exit-evidence.js
M src/main/services/refinement-notice.js
M src/main/services/storage-gateway.js
M src/main/session/fake-runtime-adapter.js
M src/main/session/session-coordinator.js
M src/main/window-layer-controller.js
M src/preload/agent.js
? src/preload/context-source.js
M src/preload/history.js
M src/preload/settings.js
M src/runtime/realtime-runtime-adapter.js
M src/runtime/realtime-worker/realtime-worker.js
M src/runtime/realtime-worker/worker-host.js
M src/runtime/recognition/cloud-audio-buffer.js
? src/runtime/recognition/local-audio-sink.js
M src/runtime/recognition/nls-realtime-provider.js
M src/runtime/recognition/recognition-runtime-adapter.js
M src/runtime/storage-worker/agent-execution-store.js
? src/runtime/storage-worker/candidate-batch-schema.js
M src/runtime/storage-worker/personal-context-store.js
? src/runtime/storage-worker/personal-memory-file-content.js
? src/runtime/storage-worker/personal-memory-file-schema.js
? src/runtime/storage-worker/personal-memory-file-store.js
? src/runtime/storage-worker/personal-memory-index-store.js
? src/runtime/storage-worker/personal-memory-overview-store.js
? src/runtime/storage-worker/personal-memory-portability.js
? src/runtime/storage-worker/personal-memory-sharing-store.js
M src/runtime/storage-worker/protocol.js
? src/runtime/storage-worker/question-retrieval-schema.js
? src/runtime/storage-worker/question-retrieval-store.js
? src/runtime/storage-worker/question-scope-schema.js
? src/runtime/storage-worker/question-scope-store.js
M src/runtime/storage-worker/schema.js
? src/runtime/storage-worker/session-experience-schema.js
? src/runtime/storage-worker/session-experience-store.js
M src/runtime/storage-worker/session-summary-budget.js
? src/runtime/storage-worker/summary-input-plan-store.js
M src/runtime/storage-worker/worker-host.js
M src/runtime/storage-worker/worker-service.js
M src/settings/agent-context-pane.tsx
M src/settings/agent-model-pane.tsx
M src/settings/agent-model-view-model.ts
M src/settings/agent-settings-pane.tsx
? src/settings/personal-memory-file-pane.tsx
? src/settings/personal-memory-sharing-pane.tsx
M src/settings/recognition-settings-pane.tsx
M src/settings/settings-view.tsx
M src/settings/settings.css
M src/settings/settings.html
M src/toolbar/index.html
M src/toolbar/toolbar.ts
M src/ui/preview/index.html
? src/ui/shared/memory-sources.tsx
M src/ui/shared/runtime-view.js
```

### test（76）

```text
M test/contracts/agent-context-ui-contract.test.js
M test/contracts/agent-recipes-contract.test.js
M test/contracts/agent-run-diagnostics-contract.test.js
M test/contracts/agent-run-eligibility-ui-contract.test.js
M test/contracts/agent-run-ui-contract.test.js
M test/contracts/budget-axes-s3.test.js
? test/contracts/personal-memory-file-format.test.js
? test/contracts/personal-memory-ingest-v2.test.js
? test/contracts/personal-memory-overview-contract.test.js
? test/contracts/recognition-progress.test.js
M test/contracts/session-summary-run-ui-contract.test.js
? test/integration/agent-layout-journey.test.js
M test/integration/agent-redesign-j25-formal-settings-journey.test.js
M test/integration/agent-redesign-j25-model-comparison-journey.test.js
M test/integration/agent-redesign-s3-session-ingest-journey.test.js
M test/integration/agent-redesign-s5-target-journey.test.js
? test/integration/helpers/context-storage-transport.js
? test/integration/helpers/formal-agent-surface.js
? test/integration/helpers/personal-memory-file-fixture.js
M test/integration/history-review-journey.test.js
M test/integration/nls-recognition-runtime-journey.test.js
M test/integration/nls-settings-renderer-journey.test.js
? test/integration/personal-memory-agent-retrieval-journey.test.js
? test/integration/personal-memory-electron-journey.test.js
? test/integration/personal-memory-failure-journey.test.js
? test/integration/personal-memory-file-journey.test.js
? test/integration/personal-memory-question-journey.test.js
? test/integration/personal-memory-retrieval-quality.test.js
? test/integration/personal-memory-sharing-journey.test.js
M test/integration/renderer-development-entry-journey.test.js
? test/integration/session-experience-journey.test.js
? test/integration/session-question-window-journey.test.js
M test/integration/session-summary-budget-recovery-journey.test.js
M test/integration/session-summary-j29-memory-journey.test.js
M test/integration/session-summary-request-j30-accept-journey.test.js
M test/main/agent-run-service.test.js
M test/main/agent-window-route.test.js
M test/main/application-window-lifecycle-controller.test.js
M test/main/electron-exit-evidence.test.js
M test/main/ipc-access-policy.test.js
M test/main/model-access-vault-runtime.test.js
M test/main/nls-settings-ipc.test.js
M test/main/personal-context-preload.test.js
M test/main/personal-context-runtime.test.js
? test/main/personal-memory-file-ipc.test.js
M test/main/refinement-notice.test.js
M test/main/session-summary-run-preload.test.js
M test/main/window-layer-controller.test.js
M test/main/window-layout-contract.test.js
M test/runtime/agent-loop.test.js
M test/runtime/cloud-audio-buffer.test.js
? test/runtime/cloud-worker-mode.test.js
M test/runtime/formal-agent-run-runner.test.js
M test/runtime/intent-route-orchestrator.test.js
M test/runtime/intent-router.test.js
M test/runtime/nls-realtime-provider.test.js
? test/runtime/personal-memory-file-native.test.js
? test/runtime/question-memory-source.test.js
? test/runtime/summary-input-plan.test.js
M test/storage/agent-execution-store.test.js
M test/storage/personal-context-store.test.js
? test/storage/personal-memory-file-migration.test.js
? test/storage/personal-memory-overview-store.test.js
M test/storage/session-summary-request-store.test.js
M test/storage/storage-worker-service.test.js
M test/ui/agent-context-settings-ui.test.js
M test/ui/agent-model-settings-ui.test.js
M test/ui/agent-settings-ui.test.js
M test/ui/agent-ui.test.js
M test/ui/fluent-experience-ui.test.js
M test/ui/history-ui.test.js
M test/ui/model-resources-ui.test.js
M test/ui/settings-react-ui.test.js
M test/ui/toolbar-notice-ui.test.js
M test/validation/b5-packaging-contract.test.js
M test/validation/nls-packaging-contract.test.js
```
