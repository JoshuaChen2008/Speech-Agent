# Gate 0C 系统音频采集验证

> 日期：2026-07-26
>
> 结论：**PASS。批准隐藏 audio host 拓扑；不需要启用工具条点击回退。**

> 历史证据说明：本页与 `gate-0c-results.json` 记录的是 2026-07-26 的一次性拓扑资格验证，当时为校验字节与多路独立性曾在忽略目录暂存短 WAV。2026-07-30 起的新隐私合同禁止任何现场音频落盘；当前 Gate 0C runner 已改为纯内存分析和结构化指标，不再复现旧 WAV 产物。历史记录保留是为了审计当时的批准依据，不代表当前诊断行为。

实测环境为 Windows 11 Home 23H2（10.0.22631）、Electron 43.2.0 / Chromium 150。独立播放器经 Windows 默认输出播放带淡入淡出的 997 Hz 挑战音；隐藏 host 通过 `getDisplayMedia` loopback 与物理优先麦克风采集，再由 AudioWorklet 从输入 48 kHz 流式降采样到 16 kHz mono。由于房间麦克风不保证能听到当前默认输出，另以已安装的 VB-Cable 把同一挑战音确定性送入第三条 audioinput 探针；生产麦克风仍是物理设备，虚拟线只用于验证采集/重采样链。完整结构化证据见 [`gate-0c-results.json`](gate-0c-results.json)，复现及校验命令见 [`scripts/gate-0c/README.md`](../../scripts/gate-0c/README.md)。

## 实测结果

| 项目 | 系统回环 | 物理麦克风 | 确定性 audioinput 探针 |
|---|---:|---:|---:|
| WAV | 16 kHz / mono / PCM16 | 16 kHz / mono / PCM16 | 16 kHz / mono / PCM16 |
| 时长 | 2.601 s | 2.601 s | 2.601 s |
| SHA256 | `367d4edc…76f1` | `0f4b6151…b434` | `64cb4db0…5a21` |
| Worklet 帧 | 27；gap 0；时间戳回退 0 | 27；gap 0；时间戳回退 0 | 27；gap 0；时间戳回退 0 |
| 采集时钟/墙钟 | 0.999914 | 1.000336 | 1.000567 |
| 997 Hz 观测 | 997 Hz；误差 0 Hz | 不作声学硬门槛 | 997 Hz；误差 0 Hz |
| 去 DC 后 AC RMS | -17.82 dBFS | -31.11 dBFS | -25.83 dBFS |
| 削波/越界/非有限值 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| 最大相邻跳变 | 0.230255 | 0.252350 | 0.047760 |
| 最大帧边界跳变 | 0.139709 | 0.130554 | 0.046478 |

三个 WAV 的哈希互不相同，排除了把同一缓冲区重复写成多路证据的假通过。原始 WAV 可能带入环境声音，仅保存在 `.artifacts/gate-0c/`，不提交；仓库只记录哈希、设备标签哈希、媒体设置和信号统计。

## 隐藏窗与用户手势

- host 使用专用非持久化 session、`show: false`、`backgroundThrottling: false`；在 ready、触发、三路首帧、对照和结束阶段都由主进程验证为不可见，缺少任何关键观测点都会判失败。
- `executeJavaScript(code, true)` 触发的真实 display request 记录到 `userGesture: true`、正确 host frame、`file://` origin、`videoRequested: true`、`audioRequested: true`。
- handler 从 `desktopCapturer.getSources({ types: ['screen'] })` 选屏幕源，返回 `audio: 'loopback'`；停止视频轨 100 ms 后，音频轨仍为 `live`。
- 同一轮末尾的无手势对照也在显式 handler 下成功，且 request 明确记录 `userGesture: false`。生产方案仍保留 `executeJavaScript(..., true)`，不依赖这一宽松行为。

## 计划修正与边界

Electron 43 的 display request 没有 `request.video` 字段；旧 PLAN 示例不可运行，已改为显式选择 `desktopCapturer` source。回环必须使用 `audio: 'loopback'`，没有使用会静音用户系统声的 `loopbackWithMute`。

物理麦克风验收严格要求 `physical-preferred` 端点，默认输入 fallback 不会被误算为物理设备；有效信号门槛使用去除 DC 后的 AC RMS，恒定卡死缓冲区不能通过。确定性探针同时要求 VB-Cable 输入和输出 sink 都被实际选中。

本 Gate 证明了当前开发机上的隐藏宿主、权限处理、真实麦克风/回环采集、确定性 audioinput 探针、Worklet 降采样、100 ms 分帧和短时音质。它不等同于打包签名版本、长时 soak、设备热插拔、睡眠恢复或 ASR worker 的验收；这些应在运行后端集成阶段继续验证。如果未来隐藏方案回归，工具条 fallback 必须由真实可信点击重新实测，并让工具条持有 stream/Worklet、只向后端传 PCM，不能假定 `MediaStreamTrack` 可跨 renderer 直接转移。
