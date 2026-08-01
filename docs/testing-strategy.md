# 联合测试与 CI 策略

> 功能承诺、测试边界和完成状态词以 [`semantic-contract.md`](semantic-contract.md) 为准；
> 本文负责维护可执行的旅程 ID、运行环境与证据状态。

## 1. 完成口径

单元测试通过只能证明局部逻辑成立，不能作为功能完成的依据。一个面向用户的功能只有同时满足以下条件，才可以在 PLAN/README 中标记完成：

1. 相关模块各自的纯逻辑测试通过。
2. 至少一条跨模块用户旅程在 CI 中稳定复现并通过。
3. 涉及真实音频设备、模型性能、DWM/人工窗口交互或长时间运行时，有对应的 Windows 实机报告。
4. 失败路径证明会降级或 fail closed，不能只覆盖顺利路径。

测试替身只放在不可确定的外部边界，例如物理音频设备、云端 AI provider 和系统权限。`SessionCoordinator`、Caption reducer、存储、队列、契约校验等产品模块应在联合测试中使用真实实现。

## 2. 执行分层

| 层级 | 入口 | 环境 | 负责证明 |
|---|---|---|---|
| core 回归 | `npm run test:core` | 本机 / Windows hosted runner | contracts、main、runtime、storage、UI 的 validator、状态机、reducer、队列等局部不变量 |
| 确定性联合测试 | `npm run test:integration` | 每次 push / PR 的 Windows CI | 多个真实产品模块围绕同一用户旅程协作，且不依赖声卡、网络或本机模型 |
| evidence 回归 | `npm run test:evidence` | 本机 / Windows hosted runner | Gate、严格报告 verifier、tracked evidence 与打包/测试分层结构契约；含约 7 秒的 I3 非音频预资格复跑 |
| Electron 产品壳联合旅程 | `scripts/product-shell-smoke.js` + verifiers | 每次 push / PR 的 Windows CI | 首进程完成四 renderer、ModelManager、旧 JSONL→SQLite、205 段分页与三格式完整导出；packaged runner 再以同一 `userData`、fetch=0 第二进程验证 ready/历史/迁移幂等及新会话。fake-ASR 与受控小资源替代音频、真实张量和公网；两轮另记 exact-child exit evidence |
| 字幕布局资格 | `scripts/caption-layout-smoke.js` + `verify-caption-layout-report.js` | 每次 push / PR 的 Windows CI 首个质量步骤，排在全部重步骤之前（由 `test/validation/caption-layout-evidence.test.js` 强制该顺序） | 最小 Electron 宿主只启字幕窗与真实 preload，注入超长 `partial`，在 24/30/38px × 中文/英文/中英混排/超长单词下验证四条布局不变量：无横向溢出、最新视觉行始终在视口内、最旧完整视觉行退出、顶部不出现半行。它不启动主进程组合根、模型与存储，因此不证明 config 广播接线（由产品壳旅程两条最小断言兜底）、真实 ASR，也不替代 DPI/主题/透明窗的人工视觉验收 |
| 打包态确定性资格 | `package:smoke` / `package:release` + package/product/restart/exit/binding/NSIS verifiers | 每次 push / PR 的 Windows CI | 正式 ASAR/NSIS allowlist、fuses、x64、native unpack；测试 package 双启动；同轮 run ID、四份报告 SHA 与完整产品载荷 SHA 闭合；精确候选静默安装/卸载及无关 APPDATA 哨兵保留。只取得 B5 机械预资格，不证明正式应用 userData 或替代 I4 |
| I4 非音频发布子门禁 | `scripts/qualify-i4-nonaudio-nsis.ps1` + `verify-i4-nonaudio-nsis-report.js` | 无仓库/Node/旧数据的专用 Win11 标准用户快照 | 精确 NSIS 的交互安装、正式 release main、公网生产 bundle、断网复启、真实保存对话框、动态发现的正式 userData、卸载保留及离线重装；全程不发 capture。报告上限固定 `pass/partial`，当前入口已完成但尚无专用机报告 |
| CI 总门禁 | `npm test` / `npm run test:ci` | `.github/workflows/ci.yml` | 依次运行 core/integration/evidence；`test:ci` 只调用一次 `npm test`，不重复 integration |
| 模型/音频实机 smoke | `scripts/model-install-live-smoke.js`、`scripts/i2-live-caption-smoke.js`、`scripts/run-i2-live-series.ps1` + I2 child/exit/series 严格校验 | 有批准模型或可播放/采集音频的 Windows 机器 | 真实模型安装/调用；loopback/mic 分路 ASR、VAD、refine、匿名标签哈希、资源/传输指标和每来源固定 5 轮 P50/P95/min/max；每个 schema-v5 report 必须绑定外部 runner 观察到 exact child 自然 exit 0 的 schema-v1 sidecar，再进入 schema-v6 series；自动 mic fixture 先由 memory-only Gate 0C 预检并标记为 `physical-preferred-label-heuristic`，不作硬件证明 |
| 原生退出诊断 | `scripts/native-model-activity-lifecycle-smoke.js`、`scripts/run-supervised-electron.js` | 有批准模型的 Windows 机器 / 产品壳 CI | 真实 online/refine 活跃工作后的 graceful/exact-child 退出，以及 main/renderer/audio-host/realtime/refine/storage/Chromium 角色级退出分类；只属 diagnostic/partial，不替代 I2/I3/I4 |
| soak / 发布验收 | `scripts/i3-nonaudio-soak.js` + 后续音频 I2/I3/I4 runner | CI 预资格 + 自托管 Windows 机器 | 先确定性验证 3,600 段资源/恢复/历史上界；再以两种真实单路模式验证拖动、设备变化、两小时墙钟、打包版和资源占用 |

Hosted CI 不声称验证真实 WASAPI/回环、物理麦克风、DWM 窗口行为、模型性能、交互安装/权限、SmartScreen 或干净机。此类证据必须由实机 lane 生成结构化报告；没有报告就是未验收，而不是跳过后视为通过。

> 2026-08-01 的 [ADR 0004](adr/0004-immutable-first-pass-and-optional-refinement.md) 已重新定义首次 `final`、可选精修与模型资源边界。下表中既有 `final→refined`、三资源 bundle 和单投影“已通过”状态只描述旧候选；J1/J2/J10/J14 的相关部分必须由新增 J15a/J15b/J15c 重新对齐后才能用于新方案验收。这三条按 2026-08-01 的排期决定拆分执行：本轮实现 J15a 与 J15b，J15c 单独一轮，因此本轮结束后字幕 MVP 仍未齐。

## 3. 用户旅程矩阵

| ID | 用户场景与联合链路 | CI / 验收 | 当前状态 |
|---|---|---|---|
| J1 | 会议模式：点击运行 → 系统音频字幕 → partial/final/refined → 自动持久化 → 停止/重启 → 按时间戳查看历史 → 导出 | 字幕 MVP 每次 PR；真实音频另走 I2 smoke | SQLite 联合旅程已覆盖 loopback 单路终态会话、分页/详情/三格式导出；packaged 产品壳完成旧档迁移和二次进程历史恢复。2026-08-01 真实 loopback pause/refine 已通过，新的五轮结构/准确率/零损失 5/5；冻结 P95=1148ms 仍超线，原生拖动/设备/睡眠未验，故不宣称发布验收完成。 |
| J2 | 听写模式：点击运行 → 麦克风字幕 → partial/final/refined → 自动持久化 → 停止/重启 → 按时间戳查看历史 → 导出 | 字幕 MVP / 发布阻断；真实麦克风另走 I2 smoke | SQLite 联合旅程覆盖 mic partial 排除、final→refined、停止、时间戳详情/导出及切换 loopback XOR；packaged fake-ASR 产品壳覆盖真实 UI/SQLite 双进程重启。受跟踪 fixture P95=1005ms；2026-08-01 新五轮 P95=1099ms，均未满足 `<1000ms`。`physical-preferred-label-heuristic` 不是硬件证明；设备/睡眠与原生拖动未关闭。 |
| J3 | Agent：已提交的单路会话停止 → 字幕上下文插件按完整水位读取 → Pi Agent Loop → 纪要插件生成概要/结论/待办/风险 → 独立保存并在历史展示 | A2 PR 阻断 + AI provider 替身；`loopback`/`mic` fixture 分别运行；实网仅手动验收 | Agent 未实现；不阻断字幕 MVP |
| J4 | 来源互斥：设置/UI/runtime 均拒绝 `mic + loopback`；活动会话禁止直接换源；停止后以另一来源启动新会话且历史/Agent 产物不串会话 | 字幕 MVP 每次 PR；两种来源分别做 I2 smoke，不做双路 soak | 已覆盖 UI 结构、配置/迁移、Coordinator、adapter/audio host/worker 和停止换源后的两份隔离历史；SQLite/Agent 接入后沿用本旅程扩展 |
| J5 | pause/resume 时存在在途 refine 与后续 Agent 任务；恢复后不丢、不重发、不跨会话 | 字幕部分 I2；Agent 部分 A2 + 实机 smoke | Gateway 确定性组合和 2026-08-01 真实 loopback 都已覆盖在途 refine：暂停时 pending=1、暂停期 refined=0、Resume 后 refined=1，transport 零损失。Agent 后置部分仍待。 |
| J6 | realtime/refine/storage worker 崩溃后恢复；已定稿内容仍可显示、落盘、历史可见；Agent 可继续追赶 | CI 故障注入 + I2/I3 实机 smoke | 确定性故障注入、两来源 exact-exit bundle和 2026-08-01 真实 exact realtime worker 强制终止+Retry 均已通过；后者证明同一 session/cursor、复用 runtime adapter、创建新 worker generation，前后均有 final/refined 且损失为零。它不证明历史 `0x80000003` 根因；I3 长测和 Agent 仍待，完整 J6 未关闭。 |
| J7 | Agent 超时、限流、断网、凭据失效或 Loop 失败；本地字幕、权威存储和历史必须继续 | A1/A2 PR 阻断 | 未实现；不阻断字幕 MVP |
| J8 | 两小时字幕会话、数千段和历史滚动；CPU/内存/队列/SQLite WAL 有界 | I3 soak / 字幕发布门禁 | 非音频预资格已用 3,600 段/4,000 事件编码虚拟两小时，覆盖 72 页 DOM≤50、三格式导出、重开恢复与资源上界。75 秒真实资格 v5 取得 pre/post/total=14/17/31 final、29 refined，资源、SQLite、导出、transport、worker/storage 恢复全部严格通过。正式 7,200 秒/3,000 final 与原生拖动未执行，I3 整体未关闭。 |
| J9-CI | 打包态确定性资格：正式 ASAR/NSIS 内容，native utility 实际加载，受控首启/复启，exact-child 正常退出，同轮/载荷证据绑定，精确候选隔离安装/卸载；全程不需要 Agent | B5 每次 PR 的 Windows package lane | 当前本机通过：166 个 ASAR 条目、112 文件产品载荷 SHA=`503a40df…b93d`、29 个入口、5 个 native、负扫描；packaged 首进程完成模型/字幕/迁移/205 段导出，第二进程 fetch=0 恢复并写第 4 会话，两轮 clean exit；七份报告以 run ID 和 SHA 闭合，SHA=`4a1deb35…2449dd` 的 unsigned NSIS 安装/卸载及无关 APPDATA 哨兵保留通过。正式应用 userData 未由此验证；workflow 已接线且不冒充 J9-I4 |
| J9-I4 | 精确 NSIS 在无仓库/Node/既有 userData/模型的 Win11 上交互安装；首次经公网下载完整 bundle，真实单路音源完成真字幕/暂停恢复/停止/SQLite 历史；断网复启后继续工作；再验证权限与卸载数据策略 | I4 干净 Win11 发布阻断 | 非音频专用机 runner/verifier 已完成，能严格收集正式 release main 的公网首下、断网历史/系统导出和真实 userData 卸载/重装证据，但当前尚无合格干净机报告；权限、真实声源/ASR 和交互恢复仍属音频门禁。完整 I4 未关闭 |
| J10 | 旧 JSONL → SQLite：中断后重跑不重复，`final/refined` 事件、原文当前投影及 txt/md/srt 原文导出 digest 一致，切换后不双写；遗留 `translated` 只读保留并报告，不导入字幕事实 | B3.3 PR 阻断 + 迁移 fixture | DB2 内核和产品生命周期覆盖事务中断、坏行/截断尾、digest、translated 隔离、stale recovery 与二次启动；packaged Electron 现又从真实 `userData/sessions` 导入旧档、保持源 SHA、不双写，第二进程验证幂等并保留历史/导出。J10 确定性联合门禁完成；精确 release 干净机迁移仍作为 I4 发布复核 |
| J11 | final/refined → 可选 FTS/embedding：旧向量立即失效，重建结果一致；`sqlite-vec` 缺失时 history 继续 | X1 启用时才阻断对应 PR/打包验收 | Deferred；不阻断 B3.3、字幕 MVP 或 A2 |
| J12 | 隐私负证据：正常停止、崩溃恢复、诊断 smoke、迁移、模型安装和导出后，SQLite、应用数据目录、日志、测试产物与 Agent 上下文均不存在现场采集 PCM/WAV、录音片段或音频路径 | 字幕 MVP PR schema/文件检查 + J14 安装目录检查 + I2 diagnostic + I4 打包版数据目录检查；测试语料只跟踪 generator/reference，生成 WAV 被忽略 | schema/RPC/Gateway、默认产品与 packaged 双冷启动、迁移、历史导出、I3 非音频 3,600 段和批准大模型安装均无现场音频产物/字段/路径且不创建新 JSONL；I2 报告只绑定生成语料 digest。正式 release 的干净机数据目录仍归 I4 |
| J13 | 内容型插件权限：真实 PluginHost 装载字幕上下文/增强文本/纪要插件；只允许读已提交正文、调用 ModelGateway、写 `agent_artifacts`；外部操作请求被拒绝且不影响字幕 | A1/A2 PR 阻断；契约 provider 替身 + 真实 SQLite/宿主 | 宿主与插件未实现 |
| J14 | 模型资源：缺模型 → 用户在真实设置 renderer 打开资源管理并点击下载 → 受控中断后 Range 续传 → 固定 manifest 字节/SHA/归档/文件校验 → staging 原子安装/ready marker → 空闲 runtime 发布字幕 capability → 工具条开始字幕 → 字幕窗显示定稿 → 暂停/恢复 → 停止并进入 SQLite 历史 | B4 每次 PR 使用真实 Electron settings DOM、受限 preload/IPC、真实 ModelManager/Windows tar/SQLite；仅 HTTP 内容、真实张量/ASR 和声卡使用受控替身。批准大模型另走实机 lane；公网/干净机归 I4 | UI 联合旅程已通过：真实 settings DOM 点击、preload/IPC、生产 ModelManager、loopback HTTP/Range、Windows tar、三资源 marker、空闲热替换、工具条开始/暂停/恢复/停止、字幕 renderer、本次 SQLite 终态历史与零音频；局部矩阵覆盖坏 hash/size、越权 URL/path、traversal/link、活动拒绝及退出续传。批准 270,938,600 字节 bundle 已真实安装并被在线 ASR、离线精修、VAD 调用。受控资源/fake ASR 不证明真实张量、物理声卡或公网；I4 公网干净机仍待补。 |
| J15a | 固定高度字幕流：长 `partial` 在用户设定的固定 bounds 内自然换行 → 满高后最旧完整视觉行退出、最新行留在底部 → 回改重排但不改识别文本、不触发分段/持久化/窗口 resize → `final` 到下一段 `partial` 逐行接续、停顿保留 | 字幕 MVP PR 阻断；证据分两层：纯逻辑层验证进入字幕流的段落与顺序、当前 `partial` 最高显示优先级、全程无 resize 调用；`scripts/caption-layout-smoke.js` 在最小 Electron 宿主中以真实 Chromium 布局验证 24/30/38px × 中文/英文/混排/长单词的四条不变量。不需要真实音频 | 实现完成 / 尚未验收。`line-clamp` 与三槽位行预算已由单一 `.caption-flow`、CSS 底部锚定 + 顶部裁剪、视口高度按整行取整取代；纯逻辑层 6 条与 15 例真实 Chromium 布局资格（24/30/38px × 中文/英文/混排/长单词 + 回改/跨段/停顿）已通过并接入 CI 首步。仍缺：产品壳的 config 广播兜底断言；人工视觉、DPI 矩阵与透明窗仍归实机门禁，故 J15a 未关闭。 |
| J15b | 转写版本隔离：首次 `final` 落盘后不可变，精修稿独立保存；历史与 txt/md/srt 导出默认原始版并可明确切换回原始版；旧 JSONL 迁移后两版分别核对 digest | 字幕 MVP PR 阻断；存储/历史/导出/迁移使用确定性边界，不需要真实音频 | 实现完成 / 尚未验收。原始版经 `segments.first_event_order` 指针从 append-only 事件表读回，`text` 恒为首次 final、`refinedText` 独立并存，零表结构变更与零迁移；该指针不变量已被乱序到达、同段多个 final 与旧档迁移三类测试锁死。历史默认原始版并可切换，导出带 version 参数、未知值 fail closed，205 段旅程已分别核对两版 digest；旧 JSONL 迁移改取每段最早的有效 final 参与原文 digest。仍缺：真实 Electron 历史窗里的切换动作旅程（当前只有 VM DOM 源码契约），故 J15b 未关闭。 |
| J15c | 精修可选化：核心字幕 ready 只依赖实时 ASR 与 VAD；精修模型默认不下载，仅由未监听状态下的明确用户动作按需安装，策略按会话冻结；精修缺失或失败只降级精修能力，不阻止实时字幕、首次 `final`、历史与导出 | 字幕 MVP PR 阻断；沿用 J14 的确定性模型边界；真实模型调用另沿 I2/I4 | 设计已冻结（ADR 0004 + SEM-F17/T11），**本轮不实现**。当前 ModelManager、ready marker 与设置页仍把实时 ASR、离线精修、VAD 当作三项原子 bundle，也没有精修策略开关。 |

新增功能必须在本表增加或更新场景；只有单元测试、没有对应用户旅程时，状态最多写“实现完成 / 尚未验收”。

## 4. 字幕与 Agent 插件联动的不变量

A2 实现增强文本或纪要前必须先冻结输入/输出契约，并让适用的 J3–J7/J13 成为阻断测试。最低要求：

- 字幕上下文插件和内容插件默认只消费首次 `final` 形成的权威原始转写，不消费 `partial`；若用户明确选择精修稿，输入必须声明版本、水位和 digest。
- 同一 `segmentId` 的精修稿不得替换旧 `final`；重试或迟到结果不得制造第二份原始事实，也不得让同一段重复进入 Agent 输入。
- 增强文本/纪要携带 `sessionId` 和输入水位（至少能定位到 source/segment/revision），可以判断它覆盖到哪里；权威原文始终独立存在。
- A2 首版增强文本只在会后或用户主动请求时按完整水位整场生成；滚动逐段增强后置。
- 一个会话只有一个 `sourceId`；所有层都拒绝双路并发，模式切换必须先停止并创建新会话。
- pause/resume、worker replacement 和 renderer reload 不得创建第二条摘要会话。
- AI 关闭、超时或失败时，本地字幕、精修和会话存档继续工作；错误只影响 AI capability。
- 新会话不得读取上一会话尚未完成的请求或摘要结果。
- 内容插件不得获得 shell、进程、任意文件写、任意网络或外部服务写能力；唯一受控写入是内部 `agent_artifacts`。
- 会后纪要由确定性的 `MeetingStopped` 应用事件触发；不能依赖 LLM 自主判断是否执行总结。

## 5. SQLite、Agent 消费与后置索引测试边界

B3.3 开始，数据库联合测试必须使用临时目录中的真实 schema、真实事务、真实投影与真实 storage worker 接线；不允许用内存 Map 或 repository mock 替代 SQLite 后仍宣称数据旅程通过。

- 同一字幕事件重复提交必须返回幂等结果，`caption_events/segments` 的有效数量不变；Agent `outbox_jobs` 或 durable cursor 只有 A1 选型后才加入对应门禁。
- 在字幕事务提交前注入失败时事件与投影都不可见；提交后 worker 崩溃时二者都可恢复。Agent job 的第三方原子/可靠边界后置到 A1。
- A1 选择 outbox 或 durable cursor 后，必须覆盖进程退出、重复领取、迟到 refined 和跨会话隔离；Agent 去重失败不得制造多个“当前”产物。
- X1 之前不安装或加载 `sqlite-vec`，也不以 J11 阻断 SQLite 历史。
- X1 启用后，refined 提交必须使旧 embedding 立即不可服务，且删除索引后可从 segments 重建。
- 迁移测试必须覆盖坏尾行、坏中间行报告、重复文件、同秒同名会话、中途退出重跑，以及遗留 `translated` 被报告但不进入字幕事实/原文 digest。

详细数据门禁 DB0–DB6 见 [`data-architecture.md`](data-architecture.md)，规范语义对应 SEM-F00、SEM-F07、SEM-F10、SEM-F11、SEM-F14–F19、SEM-T08–T12。

## 6. 当前 CI 基线

`.github/workflows/ci.yml` 使用 Windows runner，因为项目依赖 Windows x64 的 sherpa-onnx 预编译包。workflow 使用锁文件安装依赖，先以隐藏、无窗口 Electron main 执行 DB0 资格，再通过生产 `StorageWorkerHost → utilityProcess → WorkerService → SqliteSubtitleStore` 跑 DB1 基座；随后以 `SessionCoordinator → SqliteSessionRecorder → StorageGateway → StorageWorkerHost → utilityProcess → SQLite` 跑 loopback/mic、pause/refine、stop barrier、空闲退出和提交前/后故障重放并动态校验报告。接着启动真实 `src/main.js` 和四个 renderer，从隔离 userData 的模型 `missing` 状态在 settings DOM 点击下载，经受限 preload/IPC、生产 ModelManager、受控 HTTP Range、固定 System32 tar、三 marker 与空闲热启用，再完成工具条开始→final DOM→暂停/恢复→停止→本次 SQLite 历史→205 段历史五页往返→资源页→正常退出并验证结构化报告。

同一 workflow 随后构建与正式包共享 ASAR/native/fuse 布局的 test package，从真实 packaged exe 连续跑首启与同 `userData` 复启；首轮迁移/导出，第二轮不启下载服务且 fetch=0。两轮 utility 都从 ASAR 加载 native/SQLite，supervisor 要求 packaged scope、clean exit、0 incident。runner 生成唯一 run ID，并把四份报告 SHA 与完整 `src/` 产品载荷 SHA 写入 binding；正式 release layout 必须与该载荷完全一致。最后生成精确正式 NSIS，验证 x64、166 个 ASAR 条目、112 文件产品载荷、29 个关键入口、负扫描、5 个 native 和 Authenticode 状态，再隔离安装/卸载并验证无关 APPDATA 哨兵不变；应用未启动且真实 userData 路径未观察。随后 `npm run test:ci` 只执行一次 core→integration→evidence（含 I3 非音频预资格）。物理设备、真实模型性能、DWM/权限/交互安装、SmartScreen、真实两小时与 J9-I4 仍不得由 CI 冒充。

2026-08-01 当前工作树在 I3 资格协议更新后为 core 358/358、integration 25/25、evidence 120/120，共 503/503；Windows 系统 `tar.exe` 与 Electron child 在受限沙箱内可能被 `EPERM` 拒绝，相关 lane 必须在允许启动这些精确子进程的 Windows runner/本机运行；这属于执行环境前提，不能把沙箱失败计作产品断言通过或失败。

当前 J1/J2/J4/J5/J6/J12 的确定性基线位于 `test/integration/caption-session-journey.test.js`。它已使用生产 `SqliteSessionRecorder → StorageGateway → StorageWorkerService → SqliteSubtitleStore`，不再创建旧 JSONL 权威档；J1/J2 只在 ASR/设备边界注入合法 CaptionEvent。J4 构造真实 `RealtimeRuntimeAdapter → RealtimeWorkerHost + AudioHostController`，只替代 Electron utility/隐藏宿主/物理声卡；J5/J6 执行暂停/refined、worker 退出、retry/游标恢复和同会话 SQLite 持久化。J12 检查数据目录无音频文件。旧 JSONL 测试只保留迁移解析、投影和共享导出兼容性。

`test/integration/product-sqlite-lifecycle-journey.test.js` 是默认产品组合根的 DB2/J10/J12 旅程：真实 `SubtitleApplicationRuntime → JsonlSqliteMigrator → StorageGateway → WorkerService → SqliteSubtitleStore → SqliteSessionRecorder → SessionCoordinator` 围绕同一 userData 运行两次冷启动，仅用 service-backed host 替换 Electron 进程边界。它断言 crash 遗留 active 会话先收束、旧 JSONL 后迁移、mic/loopback 只单路运行、partial 不落盘、refined 成为唯一投影、退出写 interrupted、第二次迁移幂等、没有新 JSONL 或音频文件。

`test/integration/history-review-journey.test.js` 是 J1/J2/J4/J12 及 J8 加速前置：真实 `SessionCoordinator → SqliteSessionRecorder → StorageGateway → WorkerService → SqliteSubtitleStore → HistoryService` 完成 mic/loopback、205 段 keyset 分页和完整导出。packaged 产品壳再覆盖真实 BrowserWindow/DOM/IPC、旧档迁移、5 页往返与 renderer→preload→main 导出写入；保存路径选择仍用受控 `showSaveDialog` 替身。I3 非音频 runner 直接执行真实 `history.js` VM DOM harness 的 72 页/3,600 段；人工系统保存对话框、真实两小时音频与 I4 留待实机。

`scripts/i3-nonaudio-soak.js` 是 I3 的确定性非音频预资格：默认 3,600 段、每 9 段一次 refined，共 4,000 事件，以 2 秒/段编码 7,200,000ms 虚拟时间。`FakeRuntimeAdapter` 只注入契约合法 CaptionEvent，存储使用同进程服务宿主；runner 批量穿过真实 Coordinator/Gateway/SQLite，重开数据库后用真实 HistoryService 和 `history.js` VM DOM harness 翻 72 页、导出 TXT/MD/SRT，并报告 CPU、RSS/heap、队列、WAL 与查询 P95。严格 verifier 要求 `result=pass` 但 `gateStatus=partial`，并要求 mic/loopback/speaker/真实两小时/BrowserWindow 全为 false；因此它只关闭非音频资源与恢复风险，不关闭 I3 实机门禁。

`test/integration/model-install-caption-journey.test.js` 是 J14/J12 的模型闭环旅程：真实 `ModelManager → loopback HTTP → Windows System32 tar → SessionCoordinator → SqliteSessionRecorder → StorageGateway → WorkerService → SqliteSubtitleStore → HistoryService` 从保留 `.part` 续传，安装三项固定结构资源并空闲热启用；只有真实张量/ASR 和 Electron utility-process 被替代。随后执行 mic 单路 start/final/stop，断言活动替换拒绝、终态历史可见、状态不泄露 URL/hash/path 且模型/数据目录零音频。批准资源的真实大归档与调用由 `scripts/model-install-live-smoke.js` 留档；`scripts/product-shell-smoke.js` 则作为 Windows CI 与本机都可复跑的真实 Electron 壳层旅程，两者的边界见 [validation/b4-model-and-product-shell.md](validation/b4-model-and-product-shell.md)。

I2 实机入口 `scripts/i2-live-caption-smoke.js` 必须显式传入且只接受一个 `--source loopback` 或 `--source mic`，两次运行不得并发。schema-v5 child 包含实际播放起止、冻结语料估算语音起点、匿名输入/输出标签绑定、字幕到达时序、Electron CPU/工作集、audio-host 队列/丢帧、worker 缺口、CaptionEvent 边界丢弃计数，以及 exact accepted-partial 的跨时钟六段诊断，且不包含字幕正文、PCM、现场音频文件、音频路径、绝对单调时刻或时钟偏移。operator 朗读仍可用；自动 mic 模式读取同轮 Gate 0C memory-only 报告并绑定其精确 SHA，以唯一 label SHA 匹配输入并绑定输出标签。该 `physical-preferred-label-heuristic` fixture 只能防预检后静默换标签，不是硬件证明，也不能排除未知或伪造标签的虚拟设备。语料 WAV 由受跟踪的 generator/reference 本地生成且被忽略；child 同时绑定 WAV 与 reference digest。

`scripts/run-i2-live-series.ps1` 对每来源固定跑 5 轮。每轮先严格验证 schema-v5 child；外部 runner 随后只有在其启动的 exact Electron child 自然返回 exit code 0、且未由 runner 终止时，才用 `write-i2-exact-child-exit.js` 生成绑定该 report SHA 的 schema-v1 sidecar。`summarize-i2-live-series.js` 只接受恰好五组有序、唯一且来源/摘要匹配的 report+sidecar，并生成、自校验 schema-v6 确定性 summary。原始 UTF-8 JSON 在对象校验前即拒绝 BOM、非法编码、重复键（包括转义后等价键）、非有限数值和尾随输入；Gate、child、sidecar 与 summary 随后都走闭合字段验证。

权威 bundle 是 [`validation/i2-live-v5/`](validation/i2-live-v5/) 中 SHA-256 为 `0f9f7668751c64fbce922883421ead41680226126800e0b7f6b3da81b39840ef`、runId 为 `gate-0c-2026-07-31T09-52-00-521Z`、执行时间为 `2026-07-31T09:52:13.999Z` 的精确 Gate 0C preflight，以及 loopback/mic 各 5 个 schema-v5 child、5 个 schema-v1 sidecar 和一份 schema-v6 series。CI 从 Gate、10 个 child 与 10 个 sidecar 重建两份 series，并要求与 tracked series byte-for-byte 相同。sidecar 防止“内部 report 已 pass、进程随后悬挂或超时”误绿；它不是签名、远端背书、硬件证明或 native 崩溃根因证明。托管 CI 只证明证据完整性，不重放或证明硬件。

schema-v5 child 把冻结字幕可见延迟与诊断分段明确分离。唯一验收值仍是受控播放 `source t0 + 140ms` 的冻结语音起点，到 `SessionCoordinator` 接受并通知观察者的同一个首个 partial。播放 renderer、audio-host renderer、realtime utility 与 main 之间先各用 7 个样本完成 NTP 式最小 RTT 单调时钟校准，再预留同一个未来 `source t0`，先 arm 捕获探针、再 schedule 播放；六段必须为非负整数并在每个 child 内精确求和到冻结值。纯测试覆盖任意远端时钟原点、错误 clock ID、过高 RTT、陈旧校准、因果倒置以及延迟 arm 必须先于 schedule 完成，组合测试覆盖 audio-host→worker→adapter→Coordinator 的 accepted-partial 绑定。captured-energy 探针从 `source t0 + 40ms` 的固定 guard 后观察，仍比冻结 onset 早 100ms；它不做语料归因，也不改验收值。本批 mic P95 为 -99ms，只说明 guard 后已有环境能量，不得用于改善验收值。

`scripts/native-model-activity-lifecycle-smoke.js` 是 SEM-F12 的真实模型活跃退出诊断：从已审计 bundle 加载 online ASR、silero VAD 与 offline refinement，用冻结语料只在内存中直送 PCM。2026-07-31 三轮报告累计 303 帧、3 final、3 refined、3 offline decode、6 个 exact-child `exitCode=0`、fatal 0。它不开 BrowserWindow 或物理 mic/loopback，不保存正文、PCM、音频引用或本地路径，`gateStatus` 固定为 `diagnostic-only`；因此不能替代 I2 声卡旅程、I3 两小时/恢复或 I4 干净机发布验收。

与该冻结输入诊断分开，受跟踪 I2 exit-bound bundle 已让 loopback/mic 各跑 5 轮 Electron audio-host→online ASR→offline refine→外部 exact-child 退出观察；其冻结 P50/P95/min/max 为 loopback=1133/1158/1092/1158ms、mic=875/1005/822/1005ms。2026-08-01 当前工作机又各跑五轮，结构/准确率/自然退出/零 transport 损失仍是 5/5，冻结 P95 为 loopback 1148ms、mic 1099ms。相同窗口的真实 pause/refine 与 exact worker 硬终止+Retry 已通过；DWM 虽持续新增 1,580 帧且零损失，但未取得操作者拖动 completion，设备移除与睡眠/唤醒也未执行。两批结果都没有关闭 `<1000ms` 性能线，I2 整体门禁仍未关闭。

普通 `npm start` 和产品壳旅程由 `scripts/run-supervised-electron.js` 监督唯一 exact child；main 只上报固定枚举的生命周期与角色级事件，报告不保存 PID、命令行、正文、音频、路径、stack 或 dump。一次性 Electron smoke 另由 `run-electron-smoke.ps1` 等待其启动的 exact process，默认 120 秒；超时即失败并只清理该 process object，不按名称枚举，也不把强杀冒充自然退出。I2 的 schema-v1 sidecar 把这种外部观察绑定到 exact schema-v5 report，但只证明该次 exact child exit 0 且未被 runner 终止。受监督多窗口产品壳已得到 clean exit、0 incident、未观察到 breakpoint，同时产品旅程报告仍是 `partial`：它使用 fake ASR、受控模型 fixture（无真实张量）且没有打开物理音频或访问真实公网。现场已捕获一条完成报告后出现的 `PostQueuedCompletionStatus: (6) 句柄无效。`；固定 Node/libuv 源码只证明它会走 `uv_fatal_error → DebugBreak → abort`，可以直接解释 `0x80000003` 的即时机制。因缺少 native stack，具体竞态、发送者和进程角色均未证；上游 IOCP/`uv_async_send` 修复只能视为相容线索，当前通过结果也不能升级为永久修复声明。完整边界见 [Electron breakpoint 调查记录](validation/electron-breakpoint-investigation.md)。
