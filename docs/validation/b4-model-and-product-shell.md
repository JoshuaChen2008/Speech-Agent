# B4 模型资源与产品壳验收

- 日期：2026-07-31（报告时间为 UTC）
- 状态：B4 资源实现、设置页点击下载的确定性 Electron 联合旅程与批准模型本机安装/调用均已有证据；B5 打包态资格已由独立证据关闭，I4 干净机外网安装仍待执行
- 对应语义：SEM-F00、SEM-F05、SEM-F12、SEM-F14、SEM-F17、SEM-F18、SEM-F19、SEM-T02、SEM-T03、SEM-T04、SEM-T11、SEM-T12

## 确定性联合旅程

`test/integration/model-install-caption-journey.test.js` 在 Windows 使用真实
`ModelManager → system tar → ready marker → SessionCoordinator →
SqliteSessionRecorder → StorageGateway → WorkerService →
SqliteSubtitleStore → HistoryService`。只有外网、真实模型张量、声卡/ASR
边界使用小型 fixture 或 adapter。旅程从保留的 `.part` 继续一次合法 Range 206，
完成三个固定资源的字节/SHA/归档审查和原子安装，再从不可用状态空闲热启用，
执行 mic XOR 的 start → final → stop，并确认活动会话不进入历史、终态正文进入
SQLite 历史且目录没有音频文件。活动期 runtime replacement 必须返回
`SESSION_ACTIVE`。

这里的起点是 `ModelManager`，**不是** settings renderer 的下载按钮；它证明受控
J14 后端链路，而不单独证明用户点击资源页下载动作已经穿过 preload/IPC。

定向结果：1/1 通过。ModelManager 局部故障矩阵另覆盖越权 URL/路径、坏
hash/size、归档 traversal/link、幂等、并发安装、退出中断/清 staging 和安全状态。

## 批准大模型安装与调用

`scripts/model-install-live-smoke.js` 使用生产 manifest 和本仓库先前取得的三份
哈希相同批准 release asset，通过本机 loopback HTTP 走真实流式下载；实时模型
预置 1 MiB `.part`，最终确认 Range 续传。之后由 Windows bsdtar 真实列举、
类型审查并只提取 manifest 白名单文件，写入严格 marker，再由生产 resolver
从隔离 userData 解析。

最终报告见 [model-install-results.json](model-install-results.json)：

- 总计 270,938,600 字节、三资源均为 `ready`；
- 在线 recognizer 成功载入，观察到 partial 且 final 非空；
- 离线精修 recognizer 成功载入且结果非空；
- silero VAD 成功载入并观察到 speech-start；
- 报告不保存字幕正文、本地路径或音频。

第一次真实归档运行发现上游 archive 自带示例 WAV；旧实现会把非运行文件也解到
应用数据目录。实现因此改为“先审查整包，再只提取 requiredFiles”，最终重跑确认
隔离 userData 没有任何音频扩展名文件。这是 J12 的真实缺口修复，不把上游示例
WAV 误称为现场录音，但产品仍统一禁止落音频文件。

2026-07-31 另通过 sherpa-onnx 官方 GitHub Release API 核对三项 asset 的状态均为
`uploaded`，远端 size 分别为 133,898,007、136,396,739 和 643,854，与 manifest
一致。该元数据核对不替代 I4 干净机经真实公网完整下载。

## 真实 Electron 产品壳

`scripts/product-shell-smoke.js` 由 `scripts/run-supervised-electron.js --strict-report`
启动唯一、隔离 userData 的 Electron 进程；只在 HTTP 内容、真实张量/ASR 和物理声卡边界
使用受控 fixture，但 `src/main.js`、四个 renderer、preload/IPC、生产 `ModelManager`、
Windows tar、SQLite utility process 与退出屏障均为产品实现。脚本通过真实 DOM 操作完成
听写首设、资源页点击下载、开始、定稿显示、暂停/恢复、停止、终态历史、只读旧 JSONL
冷启动迁移、205 段详情的 5 页前后翻批、经真实 renderer/preload/IPC/main 保存三格式完整导出、
工具条再次打开模型资源页，并由应用自身正常退出，不按
`electron.exe` 名称杀进程。CI 同时严格校验产品旅程报告和隐私安全的 role exit evidence；
普通 `npm start` 默认只认 userData 内严格 marker，不再被仓库模型悄悄遮蔽下载入口；
外部模型路径必须显式打开开发开关。

结果见 [product-shell-results.json](product-shell-results.json)：Electron 43.2.0，
四个可见 renderer，`crashEventCount=0`；模型从 `missing` 经 `downloading`、`verifying`
到 `ready`，观察到断点 Range、3 个 marker 与空闲热启用；旧档、205 段记录和本次会话共
3 条终态历史，旧 JSONL SHA 不变且没有第二个 JSONL。历史到达第 201–205 条、前后翻批成功，
`historyMaxTimelineNodes=50`；受控保存路径下 txt/md/srt 各含完整 205 段。MVP UI 不展示翻译
入口，未打开物理音源且未落音频；报告保持 `gateStatus=partial`，并明确保留
fake-ASR、受控模型 fixture 无真实张量、205 段非两小时 I3、非 I4 四项限制。

生命周期补丁后又通过 exact-child supervisor 重跑同一多窗口联动旅程。另用完全相同的
userData 离线复启，未启动 fixture server、模型 fetch 尝试为 0，三个 ready marker、三条既有
历史、迁移幂等性和三份导出均保留；新会话停止后成为第四条历史。产品壳报告仍为
`pass / partial`，同时 role exit evidence 为 `clean-exit`：main 完整经历 ready、bootstrap、
quit-requested 与 will-quit，主进程状态码为 0，incident 为 0，未观察到 breakpoint。
supervisor 与 main 只交换固定枚举的生命周期、角色、退出原因和状态码分类；报告不保存
字幕正文、音频/PCM、本地路径、stack、dump 或 PID，也不上传外部服务。

这项受监督证据仍使用 fake ASR、受控模型 fixture，且没有打开物理音频。它只证明当前
main/preload/IPC/四个 renderer/ModelManager/SQLite/退出屏障的组合旅程能 clean exit，
不能替代真实张量、物理 loopback/mic、I3 或 I4。

## 设置页点击安装 → 热启用 → 字幕历史（通过）

本轮从模型 `missing` 的隔离 userData 启动真实 `src/main.js`，在 settings renderer 点击
`#modelInstallButton`，并依次验证：

1. `src/settings/settings.js` 调用仅暴露无参数安装能力的 settings preload；
2. main IPC 将请求交给生产 `ModelManager`，完成 Range/字节/SHA/归档白名单/staging/marker；
3. 空闲 `SessionCoordinator` 经 `activateApprovedRuntime` 转为可开始；
4. 工具条开始一次单路会话，字幕事件进入 renderer，停止后写入 SQLite，并可在历史中读取。

为保持 CI 确定性，该旅程只在外网、模型张量和物理声卡边界使用受控小资源与
fake-ASR adapter；其余 renderer、preload、IPC、`ModelManager`、热替换、Coordinator、
StorageGateway、SQLite 与 HistoryService 均为产品实现。该旅程通过后也只能证明
UI/安装/持久化接线，**不能**证明真实张量推理、真实 GitHub 公网下载、物理 mic/loopback、
两小时 I3、B5 打包布局或干净机 I4。真实模型调用仍由上文 `model-install-live-smoke.js` 的独立证据承担；B5 由下节的独立打包证据承担。

## B5 打包态补证

B5 使用与正式包相同的 ASAR、native unpack 与 Electron fuse 布局，从真实 packaged
test executable 重跑核心 ASR+VAD 两 marker 安装、精修独立 `.part` Range 继续与一 marker、
显式偏好、会话冻结、故障回退/工具条会话状态通知、旧 JSONL 迁移、SQLite 历史、会话 A 精修版跨页/导出
再切换会话 B 自动原始版/导出，并从同一 `userData` 做第二次完全离线启动；另在两次 packaged utility 中实际加载 sherpa addon/DLL，
并对 ASAR 中的 storage utility 执行完整 DB0 资格检查。独立 exact-child 证据为
`clean-exit`、incident `0`、未观察到 breakpoint。正式 x64 ASAR/NSIS 也已通过内容负扫描、
精确 SHA `4abc23bc…b31de` 绑定与隔离安装/卸载机械资格；同一 run ID、四份报告 SHA 与
114 文件产品载荷 SHA `b6503ca2…a0bbd` 另由 B5 binding 报告闭合，卸载后隔离 APPDATA 中
与应用无关的固定哨兵 SHA 不变；正式应用未启动，因此不证明真实 userData。该候选未签名，打包旅程是明示的测试
variant，不是从精确 NSIS 安装后启动；所以只关闭 B5，不关闭 I4。完整证据见
[B5 打包态确定性资格](b5-packaging.md)。

## 原生模型进程生命周期诊断

针对截图暴露出的 native 风险，代码审计发现并修复了可独立成立的生命周期缺口：
realtime/refine/storage UtilityProcess 接住 fatal `error` 并发布固定角色；worker 先走
窄 `shutdown`，最多等待 30 秒 graceful，超时后只终止并收殓该 exact child（最多再等
5 秒）。字幕运行时在 45 秒触发升级，ModelManager 的 5 秒收束与它并行；升级后仍须等待
exact child，所以 45 秒不是硬退出上限。旧 generation 未确认退出时 Coordinator 禁止启动
replacement generation。退出路径不按 `electron.exe` 名称批量杀进程。

`scripts/native-model-activity-lifecycle-smoke.js` 从经过 manifest/ready marker 审计的批准
bundle 解析 online ASR、silero VAD 与 offline refinement。每轮以冻结语料在内存中直送
PCM，真正驱动 online stream、final、精修 MessagePort 和 offline decode，再并发收束一对
realtime/refine UtilityProcess。三轮累计送入并消费 **303 帧**，得到 **3 final、3 refined、
3 次 offline decode**；六个 exact child 全部优雅 `exitCode=0`，fatal 为 0。严格报告不保存
正文、PCM、音频引用或本地路径。

该活跃诊断比“只加载模型后退出”多覆盖了真实推理与精修工作态，但仍不开 BrowserWindow，
也不打开物理 mic/loopback；输入是仓库冻结语料而不是现场采集。因此其 `gateStatus` 固定为
`diagnostic-only`，不能冒充 I2 物理来源、I3 两小时/恢复或 I4 干净机验收。

随后又重跑了最贴近历史截图场景的真实 I2 loopback→ASR→offline refine→退出。该轮
captured/sent/ingested 均为 128 帧，dropped、sequence gap 和 bad sample 均为 0；得到
1 final + 1 refined，双 CER 0 且 refined 含标点。Electron exact process 正常退出，没有
走强制终止。该报告仍是单轮开发态实机证据：它没有覆盖物理 mic、重复运行的延迟分位、
两小时 I3 或干净机 I4，也没有提供历史异常的 native stack。

## `0x80000003` 证据边界

用户截图只证明 `electron.exe` 曾出现 `0x80000003`；临时文件元数据不能证明异常实际
发生时间，截图也无法区分 main、renderer、GPU、realtime、refine 或 storage。代码审计
另行发现并修复了 exact-child 收束缺陷，但没有证据能把该缺陷归因为截图中的异常。
当前受控旅程未观察到 breakpoint 也不能倒推出历史根因，更不能声称已经修复或根治一个
尚未归因的间歇性 native 异常。

完整时间线、role evidence 的隐私白名单及再次观察到 breakpoint 后的受控取证条件见
[Electron `0x80000003` 调查记录](electron-breakpoint-investigation.md)。未经角色证据和 GPU A/B，
不永久禁用 GPU。

## 尚未关闭

- 物理来源 I2、真实两小时声源 I3、干净 Win11 公网下载/权限/安装 I4；3,600 段虚拟两小时、
  SQLite 重开、WAL/资源/分页/DOM 与全量导出的 I3 非音频预资格已通过；
- 精确 NSIS 安装后的完整应用旅程、应用实际产生 userData 后的重装复用与 SmartScreen；
  代码签名按当前 MVP 决策暂缓，不阻断内部候选，但对外分发前仍需单独决策；
- `0x80000003` 的 native stack 级根因；若隐私安全 role evidence 再次观察到 breakpoint，
  再在冻结输入、无物理音频的隔离环境中按 exact PID 获取一次受控 dump。
