# I2 交互与恢复验收边界

此文同时记录验收协议、当前自动化边界与 2026-08-01 的实机执行结果。单项通过不等于 I2 整体关闭。报告不得保存 PCM、录音、设备明文标签、字幕正文或本地音频路径。

## 2026-08-01 实机执行结果

| 场景 | 结果 | 本地结构化证据 | 尚未覆盖的边界 |
| --- | --- | --- | --- |
| Gate 0C mic / loopback / VB-Cable 拓扑 | `pass` | `.artifacts/audio-acceptance-20260801/gate-0c-latency-fix-v1/report.json` | 只证明本机本轮拓扑、信号、连续性与内存内分析。 |
| loopback 五轮 | 结构、准确率、退出与 transport `5/5 pass`；冻结 P95 `1148ms` | `.artifacts/audio-acceptance-20260801/i2-loopback/loopback-series.json` | 高于冻结 `<1000ms` 线 `148ms`，所以性能门禁未过。 |
| mic 五轮 | 结构、准确率、退出与 transport `5/5 pass`；冻结 P95 `1099ms` | `.artifacts/audio-acceptance-20260801/i2-mic/mic-series.json` | 高于冻结 `<1000ms` 线 `99ms`；`physical-preferred` 仍只是标签启发式。 |
| 真实 pause/refine | `pass` | `.artifacts/audio-acceptance-20260801/i2-interaction-pause-loopback-v2/pause-refine-loopback.report.json` | 1 个 final 的 refine 在暂停期未发布，Resume 后发布；不替代设备/睡眠测试。 |
| exact realtime worker 硬终止 + Retry | `pass` | `.artifacts/audio-acceptance-20260801/i2-interaction-worker-loopback-v2/worker-crash-retry-loopback.report.json` | 同一 session/cursor、复用 runtime adapter、创建新 worker generation；不证明历史 `0x80000003` 根因。 |
| DWM 持续字幕拖动 | `inconclusive-manual-observation` | `.artifacts/audio-acceptance-20260801/i2-interaction-dwm-loopback/dwm-drag-loopback.progress.json` | 运行期间新增 1,580 个 captured/sent/acknowledged frame 且损失计数为零，但应用访问确认超时，未写操作者 completion，不能判通过。 |
| 实际设备移除、Windows 睡眠/唤醒 | 未执行 | 仅有下方确定性故障注入与单元回归 | 必须由操作者在实机会话中执行。 |

两份五轮 series 的 `result: pass` 只覆盖其 schema-v6 结构、准确率、自然退出和零丢失条件；冻结字幕可见延迟是额外发布门槛，不能因 series 的结构性 `pass` 被省略。以上 `.artifacts` 是当前工作机本地证据，不替代受跟踪的权威 bundle 或签名/远端证明。

## 已可离线自动回归

| 场景 | 当前自动化证据 | 关键断言 |
| --- | --- | --- |
| 暂停后的二遍精修 | `test/runtime/refinement-controller.test.js`、`J5/J6/J12` 集成旅程 | `paused` 时精修结果缓冲；`resumed` 回执先到，再按原顺序发出 refined；SQLite 只保留同一会话的高 revision 文本。 |
| realtime worker 异常与重试 | `J5/J6/J12`、`test/runtime/realtime-runtime-adapter.test.js` | 故障立即停止隐藏采集、拒绝迟到字幕、保留 session/cursor，显式 Retry 后新 worker 继续同一会话。 |
| 设备轨道结束 | `track-ended` 单元回归 | `AUDIO_TRACK_ENDED` 是可重试 audio fault；采集先收束，故障后不再接受字幕。 |
| 端口重建与掉帧上界 | `test/runtime/frame-flow.test.js` | 旧 credit 作废、在途丢失显式计数、FIFO 重授信；实机报告要求 `droppedFrames/lostInFlightFrames/sequenceGapCount` 均为 0。 |
| 系统休眠/唤醒 | `PowerSessionGuard` 与 runtime-adapter 单元回归 | `suspend` 立即产生 `SYSTEM_SUSPEND`、清理活跃 capture；`resume` 不自动重新获取麦克风或回环，必须显式 Retry。 |

安全的离线回归命令（不启动 Electron、不访问设备、不播放声音）：

```powershell
node --test --experimental-test-isolation=none `
  test/runtime/realtime-runtime-adapter.test.js `
  test/main/power-session-guard.test.js `
  test/runtime/refinement-controller.test.js `
  test/integration/caption-session-journey.test.js
```

## schema-v2 实机恢复报告登记

I2 interaction 报告将升级为兼容旧 v1 的 schema-v2，并增加
`device-removal-retry` 与 `sleep-wake-retry`。当前状态为已决定：要求已登记，runner 与 verifier
尚未实现，因此不能据此产生新的实机验收结论。

两个场景都只允许 runner 等待操作者动作。设备场景由操作者实际拔出或禁用当前端点，睡眠场景由
操作者实际触发 Windows 睡眠并唤醒；completion 只证明动作已经执行。报告只有同时观察到对应的
`AUDIO_TRACK_ENDED` 或 `SYSTEM_SUSPEND`、capture 已释放、没有自动重新采集、用户明确 Retry 后
恢复监听、再次出现字幕以及 SQLite、sequence、transport 边界后，才能得到该场景的通过结论。
completion 缺失必须失败，但 completion 单独存在也必须 fail closed。

schema-v2 继续执行 SEM-F14：只写指标、枚举和哈希，拒绝字幕正文、PCM、现场音频文件、设备名、
本地绝对路径、绝对单调时刻和时钟偏移。

## 可执行的实机交互 runner

`run-i2-interaction.ps1` 复用 I2 live-caption smoke 的真实 `BrowserWindow`
audio-host、realtime/refine worker 和 SQLite session recorder；它不是伪造
caption 或 transport 的模拟器。报告、DWM 进度和完成确认均必须写在
`.artifacts` 下，且 verifier 会拒绝 PCM、字幕正文、设备明文或本地音频路径。

音频授权恢复后，分别运行：

```powershell
.\scripts\run-i2-interaction.ps1 -Scenario pause-refine -Source loopback `
  -OutputDirectory .artifacts\audio-acceptance\i2-interaction-pause-loopback

.\scripts\run-i2-interaction.ps1 -Scenario worker-crash-retry -Source loopback `
  -OutputDirectory .artifacts\audio-acceptance\i2-interaction-worker-loopback
```

`worker-crash-retry` 会在已启动的真实模型会话内终止 exact realtime child，
等待 coordinator 进入可重试状态后显式 Retry；生产语义会复用同一 runtime adapter
以承接同一 session/cursor，但必须创建不同的 exact worker。报告标明跨 worker 世代，故不会
把前后计数伪装成可相减的同一条 transport。

`pause-refine` 使用已有的短受控 `zh-roadmap` 语料（约 3.9 秒），但不按任何
墙钟秒数暂停。它会先等待真实 realtime worker 产生首个 `final`，再等该段的
真实 offline-refine 请求在 worker 的 pending 计数中可见，随即发送 Pause。
仅此 acceptance composition 会将**已经真实完成解码**的 refine 回复延迟 1.2 秒，
以保证 pause 时回复仍在途；它不会生成、篡改或保存任何字幕正文。报告必须证明
pending 大于零、暂停期没有发布 refined，且 Resume 后才收到 refined。若任一事件
未在上限内发生，runner 只会失败，不会按固定延迟把场景误判为通过。

Overlay 拖动需要人工视觉判定，命令如下。runner 会先写入
`ready-for-dwm-drag` 进度文件并持续受控播放；实际拖过 caption 与 toolbar 后，
操作者才可以写入 completion 文件。没有该文件或超时只能得到
`inconclusive-manual-observation`，不能得到通过结论：

```powershell
.\scripts\run-i2-interaction.ps1 -Scenario dwm-drag -Source loopback `
  -OutputDirectory .artifacts\audio-acceptance\i2-interaction-dwm-loopback

node scripts/complete-i2-dwm-drag.js `
  --completion .artifacts\audio-acceptance\i2-interaction-dwm-loopback\dwm-drag-loopback.completion.json
```

这三个 runner 只验证 pause/refine、worker 硬崩溃+Retry 和实际可见的 DWM
拖动。它们明确不宣称发生过实际 OS 设备移除或 Windows 睡眠/唤醒；这两项仍必须
按下文步骤由操作者单独执行和记录。

## 必须由实机完成的部分

下列观察不能由模拟 `track-ended`、假 Electron 边界或静态代码替代，且执行前需要有效的音频/设备/睡眠授权：

1. 真实 pause/refine：播放受控语料，暂停于定稿/精修交界，确认恢复后出现对应 refined，且 transport 为零丢失。
2. Overlay 拖动：在真实音频会话持续显示字幕期间拖动字幕条和工具条，确认未闪烁、窗口位置正确、字幕连续；以运行结束的 transport 零丢失证明 PCM 链路未断帧。当前没有能替代人工视觉判定的无头断言。
3. 设备变更/移除：活动会话中实际拔出或禁用当前输入/回环设备，确认出现 `AUDIO_TRACK_ENDED`（或明确的采集失败）、capture 已停止；恢复设备后仅通过 Retry 重新开始，再以受控语料验证字幕连续。
4. Worker 硬崩溃：在真实模型会话中终止 exact realtime child，确认无后续字幕、会话进入可重试错误；Retry 后运行新 child，并以同一 session 的续增 sequence、SQLite 和零 transport 损失闭环。
5. 睡眠/唤醒：活动会话运行时由操作者触发一次 Windows 睡眠并唤醒；确认 `SYSTEM_SUSPEND`、不会自动重采集，设备恢复后点击 Retry 才重连。不得把 OS 休眠自动化成后台操作。

实时基线仍使用两个来源分开的 I2 series；该 series 只证明基础 ASR/延迟/transport，不取代上述交互步骤：

```powershell
.\scripts\run-i2-live-series.ps1 -Source loopback -RunCount 5 -OutputDirectory .artifacts\audio-acceptance\i2-loopback

.\scripts\run-i2-live-series.ps1 -Source mic -RunCount 5 -OutputDirectory .artifacts\audio-acceptance\i2-mic -PhysicalMicPreflight .artifacts\audio-acceptance\gate-0c\report.json
```

运行期 ASR、VAD、精修与 SQLite 链路均为本地实现；网络仅属于首次模型资源安装，不是活动音频会话的恢复依赖。因此“断网恢复”不能作为实时采集故障的替代测试，应在模型安装流程另行验证下载中断、校验失败与重新安装。
