# B4 模型资源与产品壳验收

- 日期：2026-07-31（报告时间为 UTC）
- 状态：B4 确定性联合验收完成；批准模型本机安装/调用实机验收完成；I4 干净机外网安装仍待执行
- 对应语义：SEM-F00、SEM-F05、SEM-F12、SEM-F14、SEM-F17、SEM-T02、SEM-T03、SEM-T04、SEM-T11

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
启动唯一、隔离 userData 的 Electron 进程；使用显式 fake-ASR 开发缝避免打开物理设备，但其余
`src/main.js`、四个 renderer、preload/IPC、SQLite utility process 与退出屏障均为
产品实现。脚本通过真实 DOM 操作完成听写首设、开始、定稿显示、停止、终态历史、
205 段详情的 5 页前后翻批、工具条打开模型资源页，并由应用自身正常退出，不按
`electron.exe` 名称杀进程。CI 同时严格校验产品旅程报告和隐私安全的 role exit evidence；
普通 `npm start` 仍使用默认 fail-open 模式，诊断写盘不可阻断字幕产品。
三项模型 ready 状态来自脚本在隔离 workDir 创建的最小开发文件 fixture，只用于
证明资源 UI/IPC 与应用组合接线，不加载张量、不冒充真实推理；真实模型调用由上一节
独立证据承担。该旅程及严格报告 verifier 已接入 Windows push/PR CI。

结果见 [product-shell-results.json](product-shell-results.json)：Electron 43.2.0，
四个可见 renderer，`crashEventCount=0`，历史到达第 201–205 条、前后翻批成功且
`historyMaxTimelineNodes=50`，模型资源三项开发 fixture ready，MVP UI 不再展示翻译
入口，未打开物理音源且未落音频；报告保持 `gateStatus=partial`，并明确保留
fake-ASR、开发 fixture、205 段非两小时 I3、非 I4 四项限制。

生命周期补丁后又通过 exact-child supervisor 重跑同一多窗口联动旅程。产品壳报告仍为
`pass / partial`，同时 role exit evidence 为 `clean-exit`：main 完整经历 ready、bootstrap、
quit-requested 与 will-quit，主进程状态码为 0，incident 为 0，未观察到 breakpoint。
supervisor 与 main 只交换固定枚举的生命周期、角色、退出原因和状态码分类；报告不保存
字幕正文、音频/PCM、本地路径、stack、dump 或 PID，也不上传外部服务。

这项受监督证据仍使用 fake ASR、开发模型 fixture，且没有打开物理音频。它只证明当前
main/preload/IPC/四个 renderer/SQLite/退出屏障的组合旅程能 clean exit，不能替代物理
loopback/mic、I3 或 I4。

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
`diagnostic-only`，不能冒充 I2 物理来源、I3 两小时/恢复或 I4 打包验收。

随后又重跑了最贴近历史截图场景的真实 I2 loopback→ASR→offline refine→退出。该轮
captured/sent/ingested 均为 128 帧，dropped、sequence gap 和 bad sample 均为 0；得到
1 final + 1 refined，双 CER 0 且 refined 含标点。Electron exact process 正常退出，没有
走强制终止。该报告仍是单轮开发态实机证据：它没有覆盖物理 mic、重复运行的延迟分位、
两小时 I3 或打包态 I4，也没有提供历史异常的 native stack。

## `0x80000003` 证据边界

两张用户截图的创建时间分别为 02:04:20 和 02:35:13，均早于生命周期修复提交
`64b3e55`（06:19:57），所以第二张不是修复后复现。旧 I2/结构诊断与截图时段重合，旧代码
又存在直接 `kill()`、不等待 exact child 退出的路径；这使 native teardown 竞态成为历史主
嫌疑，但当时没有 WER、dump 或 native stack，截图也无法区分 main、renderer、GPU、
realtime、refine 或 storage。相关性不能写成根因证明，不能声称已经修复一个尚未归因的
间歇性 native 异常，也不能宣称 `0x80000003` 已根治。

完整时间线、role evidence 的隐私白名单及再次观察到 breakpoint 后的受控取证条件见
[Electron `0x80000003` 调查记录](electron-breakpoint-investigation.md)。未经角色证据和 GPU A/B，
不永久禁用 GPU。

## 尚未关闭

- 物理 mic I2、两小时 I3、干净 Win11 公网下载/权限/安装 I4；
- 打包版 `tar`/native module/asar 路径和卸载清理；
- `0x80000003` 的 native stack 级根因；若隐私安全 role evidence 再次观察到 breakpoint，
  再在冻结输入、无物理音频的隔离环境中按 exact PID 获取一次受控 dump。
