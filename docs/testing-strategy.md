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
| 单模块回归 | `npm test` | 本机 / Windows hosted runner | validator、状态机、reducer、队列、存储等局部不变量 |
| 确定性联合测试 | `npm run test:integration` | 每次 push / PR 的 Windows CI | 多个真实产品模块围绕同一用户旅程协作，且不依赖声卡、网络或本机模型 |
| Electron 产品壳联合旅程 | `scripts/product-shell-smoke.js` + `verify-product-shell-report.js` | 每次 push / PR 的 Windows CI | 四个真实 renderer、preload/IPC、SQLite utility process、工具条导航、205 段历史的 5 页 DOM 交互与正常退出；显式 fake-ASR/开发模型文件替代外部设备和真实推理。由 exact-child supervisor 另记 role exit evidence |
| CI 总门禁 | `npm run test:ci` | `.github/workflows/ci.yml` | 联合旅程先通过，再执行完整回归集 |
| 模型/音频实机 smoke | `scripts/model-install-live-smoke.js`、`scripts/i2-live-caption-smoke.js` | 有批准模型或可播放/采集音频的 Windows 机器 | 真实模型安装/调用、loopback/mic、ASR、VAD、refine、资源指标和进程边界 |
| 原生退出诊断 | `scripts/native-model-activity-lifecycle-smoke.js`、`scripts/run-supervised-electron.js` | 有批准模型的 Windows 机器 / 产品壳 CI | 真实 online/refine 活跃工作后的 graceful/exact-child 退出，以及 main/renderer/audio-host/realtime/refine/storage/Chromium 角色级退出分类；只属 diagnostic/partial，不替代 I2/I3/I4 |
| soak / 发布验收 | 后续 I2/I3/I4 runner | 自托管 Windows 机器 | 两种单路模式分别验证、拖动、设备变化、两小时会话、打包版和资源占用 |

Hosted CI 不声称验证真实 WASAPI/回环、物理麦克风、DWM 窗口行为或模型性能。此类证据必须由实机 lane 生成结构化报告；没有报告就是未验收，而不是跳过后视为通过。

## 3. 用户旅程矩阵

| ID | 用户场景与联合链路 | CI / 验收 | 当前状态 |
|---|---|---|---|
| J1 | 会议模式：点击运行 → 系统音频字幕 → partial/final/refined → 自动持久化 → 停止/重启 → 按时间戳查看历史 → 导出 | 字幕 MVP 每次 PR；真实音频另走 I2 smoke；B3.3 后必须改跑 SQLite | 默认产品与历史复盘联合旅程已覆盖 loopback 单路终态会话、倒序列表/分页、详情隔离和 txt/md/srt 导出；真实 loopback I2 已有 final/refined。产品壳 smoke 已验证四窗口/IPC/SQLite/退出但使用 fake-ASR 听写模式，不能替代 loopback 物理旅程或完整产品重启，故尚未宣称发布验收完成 |
| J2 | 听写模式：点击运行 → 麦克风字幕 → partial/final/refined → 自动持久化 → 停止/重启 → 按时间戳查看历史 → 导出 | 字幕 MVP / 发布阻断；真实麦克风另走 I2 smoke | 历史复盘联合旅程已覆盖 mic 单路 start、partial 排除、final→refined 当前投影、正常停止、带双时间戳详情和三格式导出，随后切换 loopback 仍保持 XOR/会话隔离。真实 Electron 产品壳已用显式 fake-ASR 完成听写首设→开始→定稿 DOM→停止→终态历史，无 child/renderer crash；物理 mic I2 仍待补 |
| J3 | Agent：已提交的单路会话停止 → 字幕上下文插件按完整水位读取 → Pi Agent Loop → 纪要插件生成概要/结论/待办/风险 → 独立保存并在历史展示 | A2 PR 阻断 + AI provider 替身；`loopback`/`mic` fixture 分别运行；实网仅手动验收 | Agent 未实现；不阻断字幕 MVP |
| J4 | 来源互斥：设置/UI/runtime 均拒绝 `mic + loopback`；活动会话禁止直接换源；停止后以另一来源启动新会话且历史/Agent 产物不串会话 | 字幕 MVP 每次 PR；两种来源分别做 I2 smoke，不做双路 soak | 已覆盖 UI 结构、配置/迁移、Coordinator、adapter/audio host/worker 和停止换源后的两份隔离历史；SQLite/Agent 接入后沿用本旅程扩展 |
| J5 | pause/resume 时存在在途 refine 与后续 Agent 任务；恢复后不丢、不重发、不跨会话 | 字幕部分 I2；Agent 部分 A2 + 实机 smoke | Gateway 真实组合已覆盖 pause/resume→同会话 refined→SQLite；真实 refine 暂停、物理来源和 Agent 后置部分仍待补 |
| J6 | realtime/refine/storage worker 崩溃后恢复；已定稿内容仍可显示、落盘、历史可见；Agent 可继续追赶 | CI 故障注入 + I2/I3 实机 smoke | realtime/Gateway 恢复与字幕/close ACK 压力旅程已通过；UtilityProcess fatal error 由固定角色诊断消费，worker 按 30 秒 graceful + 5 秒 exact-child reap 收束，字幕运行时 45 秒触发升级且 ModelManager 5 秒并行；升级后仍等待 exact child，无法收殓旧代时 Coordinator 禁止启动 replacement generation。批准模型活跃诊断三轮共处理 303 帧、3 final、3 refined、3 offline decode，6 个 worker 全部优雅 exit 0、fatal 0；修复后真实 I2 loopback 单轮又以 128 帧、0 dropped/gap/bad sample、1 final + 1 refined、双 CER 0 完成正常 exact-process 退出，无强制终止；受监督多窗口产品壳 clean exit、0 incident、无 breakpoint。两张截图都早于 `64b3e55`，但没有 native stack，根因仍未获调用栈级证明；真实硬崩溃→重启恢复、I3 与 Agent 仍待补，完整 J6 未通过。 |
| J7 | Agent 超时、限流、断网、凭据失效或 Loop 失败；本地字幕、权威存储和历史必须继续 | A1/A2 PR 阻断 | 未实现；不阻断字幕 MVP |
| J8 | 两小时字幕会话、数千段和历史滚动；CPU/内存/队列/SQLite WAL 有界 | I3 soak / 字幕发布门禁 | 加速结构前置已覆盖：205 段同时间戳/refined 经真实 Coordinator→SQLite→HistoryService 分 5 页无缺失重复，完整导出不截断；真实 Electron 点击 5 页且 DOM≤50。尚未覆盖 2 小时墙钟、数千段、资源/WAL/P95、硬崩溃恢复，故 J8/I3 未通过 |
| J9 | 打包版首启、模型下载、权限、真字幕、自动保存、历史查看和退出清理；全程不需要 Agent | I4 干净 Win11 | 未覆盖 |
| J10 | 旧 JSONL → SQLite：中断后重跑不重复，`final/refined` 事件、原文当前投影及 txt/md/srt 原文导出 digest 一致，切换后不双写；遗留 `translated` 只读保留并报告，不导入字幕事实 | B3.3 PR 阻断 + 迁移 fixture | DB2 内核旅程覆盖逐文件事务、故障重跑、同字节 SHA/解析、亚毫秒 fail-closed、坏行/截断尾、缺失 close、四类原文 digest 和 translated 隔离；新增产品生命周期旅程再覆盖 stale-active→冷启动迁移→SQLite-only mic/loopback→退出→二次启动幂等。两者使用真实文件 SQLite，只替代 Electron utility-process 边界；真实产品 Electron 启动和打包态仍待验收，完整 J10 未通过 |
| J11 | final/refined → 可选 FTS/embedding：旧向量立即失效，重建结果一致；`sqlite-vec` 缺失时 history 继续 | X1 启用时才阻断对应 PR/打包验收 | Deferred；不阻断 B3.3、字幕 MVP 或 A2 |
| J12 | 隐私负证据：正常停止、崩溃恢复、诊断 smoke、迁移、模型安装和导出后，SQLite、应用数据目录、日志、测试产物与 Agent 上下文均不存在现场采集 PCM/WAV、录音片段或音频路径 | 字幕 MVP PR schema/文件检查 + J14 安装目录检查 + I2 diagnostic + I4 打包版数据目录检查；测试只可读取来源明确的静态合成语料 | diagnostic、schema/RPC、Gateway、默认产品两次冷启动/迁移/XOR 会话/退出、历史 txt/md/srt 导出、模型联合旅程及批准大模型真实安装均无音频产物、字段或路径且不创建新 JSONL；真实大归档验收发现并修复“整包解出上游示例 WAV”，现只提取 requiredFiles。I4 打包版仍待补 |
| J13 | 内容型插件权限：真实 PluginHost 装载字幕上下文/增强文本/纪要插件；只允许读已提交正文、调用 ModelGateway、写 `agent_artifacts`；外部操作请求被拒绝且不影响字幕 | A1/A2 PR 阻断；契约 provider 替身 + 真实 SQLite/宿主 | 宿主与插件未实现 |
| J14 | 模型资源：缺模型 → 用户打开资源管理并点击下载 → 受控中断后 Range 续传 → 固定 manifest 字节/SHA/归档/文件校验 → staging 原子安装/ready marker → resolver 命中 → 空闲 runtime 发布真实 ASR capability → 开始字幕并进入 SQLite 历史 | B4 每次 PR 使用受控 HTTP/小型模型结构；批准大模型另走实机 lane；公网/干净机归 I4 | 确定性联合旅程已通过：真实 ModelManager、loopback HTTP/Range、Windows tar、三资源 marker、空闲热替换、mic XOR final→SQLite 终态历史与零音频；局部矩阵覆盖坏 hash/size、越权 URL/path、traversal/link、活动拒绝及退出续传。批准 270,938,600 字节 bundle 已真实安装并被在线 ASR、离线精修、VAD 调用；I4 公网干净机仍待补 |

新增功能必须在本表增加或更新场景；只有单元测试、没有对应用户旅程时，状态最多写“实现完成 / 尚未验收”。

## 4. 字幕与 Agent 插件联动的不变量

A2 实现增强文本或纪要前必须先冻结输入/输出契约，并让适用的 J3–J7/J13 成为阻断测试。最低要求：

- 字幕上下文插件和内容插件只消费 `final/refined` 形成的当前定稿文本，不消费 `partial`。
- 同一 `segmentId` 的 refined 应替换旧 final；重试或迟到事件不得重复进入 Agent 输入。
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

详细数据门禁 DB0–DB6 见 [`data-architecture.md`](data-architecture.md)，规范语义对应 SEM-F00、SEM-F07、SEM-F10、SEM-F11、SEM-F14–F17、SEM-T08–T11。

## 6. 当前 CI 基线

`.github/workflows/ci.yml` 使用 Windows runner，因为项目依赖 Windows x64 的 sherpa-onnx 预编译包。workflow 使用锁文件安装依赖，先以隐藏、无窗口 Electron main 执行 DB0 资格，再通过生产 `StorageWorkerHost → utilityProcess → WorkerService → SqliteSubtitleStore` 跑 DB1 基座；随后以 `SessionCoordinator → SqliteSessionRecorder → StorageGateway → StorageWorkerHost → utilityProcess → SQLite` 跑 loopback/mic、pause/refine、stop barrier、空闲退出和提交前/后故障重放并动态校验报告。接着启动真实 `src/main.js` 和四个 renderer，以显式 fake-ASR/隔离开发模型文件完成首设→开始→final DOM→停止→205 段历史五页往返→资源页→正常退出并验证结构化报告，最后运行确定性用户旅程和完整回归。默认组合根的冷启动顺序、迁移、SQLite-only 写入、stale-active 与退出屏障、终态列表/有界详情/安全全量导出，以及模型 Range 下载→固定 System32 tar→热启用→字幕→历史，均由真实产品模块和真实文件 SQLite 旅程验证。权限仅为只读仓库内容，并对同一分支的新运行取消旧运行。物理设备、真实模型性能、DWM 人工交互、打包态和 I3/I4 仍不得由确定性 CI 冒充。

当前 J1/J2/J4/J5/J6/J12 的确定性基线位于 `test/integration/caption-session-journey.test.js`。它使用生产的会话协调器、配置存储、字幕 reducer、会话存档接线与导出逻辑；J1/J2 只在 ASR/设备边界注入契约合法的 CaptionEvent。J4 进一步构造真实 `RealtimeRuntimeAdapter → RealtimeWorkerHost + AudioHostController` 组合，只模拟 Electron utility process、隐藏宿主 renderer 与物理声卡边界；旅程先跑 loopback 会话、活动期拒绝切换、停止后再跑 mic 新会话，并断言两次单路选择分别到达 worker configure 与 audio-host capture、PCM 端口完成接线、两份历史不串源。J5/J6 在同一生产组合边界中执行暂停/恢复、迟到 refined、worker 退出、error/retry、新 worker 游标恢复和同一会话继续持久化。J12 同时检查持久化目录没有音频扩展名文件。现存 translated fixture 只证明向后兼容的折叠契约，不属于字幕 MVP 成功条件，也不证明 Agent 已实现。

`test/integration/product-sqlite-lifecycle-journey.test.js` 是默认产品组合根的 DB2/J10/J12 旅程：真实 `SubtitleApplicationRuntime → JsonlSqliteMigrator → StorageGateway → WorkerService → SqliteSubtitleStore → SqliteSessionRecorder → SessionCoordinator` 围绕同一 userData 运行两次冷启动，仅用 service-backed host 替换 Electron 进程边界。它断言 crash 遗留 active 会话先收束、旧 JSONL 后迁移、mic/loopback 只单路运行、partial 不落盘、refined 成为唯一投影、退出写 interrupted、第二次迁移幂等、没有新 JSONL 或音频文件。

`test/integration/history-review-journey.test.js` 是 J1/J2/J4/J12 及 J8 加速前置的历史复盘旅程：真实 `SessionCoordinator → SqliteSessionRecorder → StorageGateway → WorkerService → SqliteSubtitleStore → HistoryService` 先完成 mic 的 partial/final/refined/stop，再切换为 loopback 会话；第二条旅程注入 205 个不同 segment、同时间戳分组和跨页 refined，以 50 条 keyset 页拼接并与私有全量 SQLite 投影逐项及 SHA-256 对齐。只有 Electron utility-process、物理采集/ASR 和系统保存对话框被替代；活动会话排除、无缺失/重复分页、txt/md/srt 205 条完整写出、路径不回传 renderer 以及零音频产物均在用户结果中断言。真实 BrowserWindow/DOM/IPC 另由产品壳 CI 点击 5 页、往返并测得 DOM≤50；系统保存对话框及真正两小时 I3/I4 仍留待验收。

`test/integration/model-install-caption-journey.test.js` 是 J14/J12 的模型闭环旅程：真实 `ModelManager → loopback HTTP → Windows System32 tar → SessionCoordinator → SqliteSessionRecorder → StorageGateway → WorkerService → SqliteSubtitleStore → HistoryService` 从保留 `.part` 续传，安装三项固定结构资源并空闲热启用；只有真实张量/ASR 和 Electron utility-process 被替代。随后执行 mic 单路 start/final/stop，断言活动替换拒绝、终态历史可见、状态不泄露 URL/hash/path 且模型/数据目录零音频。批准资源的真实大归档与调用由 `scripts/model-install-live-smoke.js` 留档；`scripts/product-shell-smoke.js` 则作为 Windows CI 与本机都可复跑的真实 Electron 壳层旅程，两者的边界见 [validation/b4-model-and-product-shell.md](validation/b4-model-and-product-shell.md)。

I2 实机入口 `scripts/i2-live-caption-smoke.js` 必须显式传入且只接受一个 `--source loopback` 或 `--source mic`，两次运行不得并发。schema v2 报告由 runner 原样生成，包含字幕到达时序、Electron CPU/工作集、audio-host 队列/丢帧、worker 缺口与 CaptionEvent 边界丢弃计数，且不包含字幕正文、PCM、现场音频文件或音频路径。当前受控 loopback 证据见 `docs/validation/i2-loopback-results.json`；物理 mic 报告仍是 I2 关闭条件。

`scripts/native-model-activity-lifecycle-smoke.js` 是 SEM-F12 的真实模型活跃退出诊断：从已审计 bundle 加载 online ASR、silero VAD 与 offline refinement，用冻结语料只在内存中直送 PCM。2026-07-31 三轮报告累计 303 帧、3 final、3 refined、3 offline decode、6 个 exact-child `exitCode=0`、fatal 0。它不开 BrowserWindow 或物理 mic/loopback，不保存正文、PCM、音频引用或本地路径，`gateStatus` 固定为 `diagnostic-only`；因此不能替代 I2 声卡旅程、I3 两小时/恢复或 I4 打包验收。

与该冻结输入诊断分开，修复后还重跑了真实 I2 loopback→ASR→offline refine→退出：128 帧 captured/sent/ingested 一致，dropped、sequence gap 与 bad sample 均为 0，得到 1 final + 1 refined（双 CER 0，refined 含标点），Electron exact process 正常退出且没有强制终止。这是当前最接近两张截图运行态的 post-fix 证据，但仍只是单轮 loopback；它不替代物理 mic、重复运行的延迟分位、拖动/设备变化、I3 或 I4。

普通 `npm start` 和产品壳旅程由 `scripts/run-supervised-electron.js` 监督唯一 exact child；main 只上报固定枚举的生命周期与角色级事件，报告不保存 PID、命令行、正文、音频、路径、stack 或 dump。受监督多窗口产品壳已得到 clean exit、0 incident、未观察到 breakpoint，同时产品旅程报告仍是 `partial`：它使用 fake ASR、开发模型 fixture 且没有打开物理音频。两张 `0x80000003` 截图均发生在 `64b3e55` 之前；没有 native stack，时间相关性不能升级为根因证明。完整边界见 [Electron breakpoint 调查记录](validation/electron-breakpoint-investigation.md)。
