# B4 模型资源与产品壳验收

- 日期：2026-07-31（报告时间为 UTC）
- 状态：B4 确定性联合验收完成；批准模型本机安装/调用实机验收完成；I4 干净机外网安装仍待执行
- 对应语义：SEM-F00、SEM-F05、SEM-F14、SEM-F17、SEM-T02、SEM-T03、SEM-T04、SEM-T11

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

`scripts/product-shell-smoke.js` 由 `scripts/run-electron-smoke.ps1` 启动唯一、隔离
userData 的 Electron 进程；使用显式 fake-ASR 开发缝避免打开物理设备，但其余
`src/main.js`、四个 renderer、preload/IPC、SQLite utility process 与退出屏障均为
产品实现。脚本通过真实 DOM 操作完成听写首设、开始、定稿显示、停止、终态历史、
工具条打开模型资源页，并由应用自身正常退出，不按 `electron.exe` 名称杀进程。
三项模型 ready 状态来自脚本在隔离 workDir 创建的最小开发文件 fixture，只用于
证明资源 UI/IPC 与应用组合接线，不加载张量、不冒充真实推理；真实模型调用由上一节
独立证据承担。该旅程及严格报告 verifier 已接入 Windows push/PR CI。

结果见 [product-shell-results.json](product-shell-results.json)：Electron 43.2.0，
四个可见 renderer，`crashEventCount=0`，模型资源三项开发 fixture ready，MVP UI
不再展示翻译入口，未打开物理音源且未落音频；报告保持 `gateStatus=partial` 和
fake-ASR/开发 fixture/非 I4 三项限制。

用户截图中的 `electron.exe 0x80000003` 本次无法复现，也没有既有 WER/事件日志能
把它归因到本项目。因此这里只能证明这次受控产品旅程无 renderer/child crash，
不能声称已经修复一个尚未归因的间歇性 native 异常。主进程已补
`render-process-gone`、`child-process-gone`、`unresponsive` 和主文档加载失败的
角色级、无正文诊断，若再现可区分窗口/子进程。

## 原生模型进程生命周期诊断

针对截图暴露出的 native 风险，代码审计另外发现三项可独立修复的生命周期缺口：
realtime/refine/storage UtilityProcess 没有全部接住 Electron 的 fatal `error`；
realtime/refine 的退出路径在 `kill()` 后没有等待同一子进程的真实 `exit`；旧 worker
尚未确认退出时，Coordinator 仍可能建立 replacement。现已补齐固定 `serviceName`、
无路径/正文的 fatal 观测、worker 内部 `shutdown` 协议、强制终止后的 exact-exit
屏障，以及 replacement 前的旧世代 retirement gate。audio host IPC 清理也改为只
移除本实例注册的 listener，避免不同世代互相清监听。

`scripts/native-model-lifecycle-smoke.js` 随后从已经通过 manifest/ready marker 审计的
隔离安装目录解析三项资源；每轮并发加载 realtime ASR + silero VAD 与 offline
refinement，并连接精修 MessagePort，但不创建 BrowserWindow、音频采集或 PCM port。
三轮共 6 个真实 UtilityProcess 均在默认产品 deadline 内优雅 `exitCode=0`，两类
worker 都在退出前响应 stats，fatal 与异常 child 事件均为 0。结构化结果见
[native-model-lifecycle-results.json](native-model-lifecycle-results.json)，严格 verifier
拒绝路径、字幕、音频引用和发布门禁越权。

生命周期补丁后，完整产品壳又连续执行 3 次，均为四 renderer、0 crash event 并正常
自退出；全量 CI 为 13/13 组合旅程、302/302 测试通过。这些证据降低了“批准模型包或
当前 ABI 一加载就必崩”的可能性，也证明本次收束逻辑没有破坏产品旅程；它们仍不能
证明截图中的 `0x80000003` 根因已经定位或修复。该弹窗若再现，需要同一时刻的新角色
日志或 dump，且未经 GPU A/B 证据不永久禁用 GPU。

## 尚未关闭

- 物理 mic I2、两小时 I3、干净 Win11 公网下载/权限/安装 I4；
- 打包版 `tar`/native module/asar 路径和卸载清理；
- 用户截图异常若再次出现，仍需同一时间点的角色日志或 dump；未经 A/B 证据不
  永久禁用 GPU。
