# Gate 0C 系统音频采集验证

> 初次拓扑判定：2026-07-26
>
> 当前精确预检：2026-07-31
>
> 结论：**PASS。批准隐藏 audio host 拓扑；不需要启用工具条点击回退。**

## 当前权威预检

退出绑定 I2 权威证据所绑定的精确 Gate 0C 报告是 [`i2-live-v5/gate-0c-preflight.json`](i2-live-v5/gate-0c-preflight.json)，SHA-256 为 `0f9f7668751c64fbce922883421ead41680226126800e0b7f6b3da81b39840ef`，run ID 为 `gate-0c-2026-07-31T09-52-00-521Z`，执行时间为 `2026-07-31T09:52:13.999Z`。该轮在内存中分别验证：

- hidden audio host 的 `getDisplayMedia` loopback、真实 `userGesture` 记录和 AudioWorklet 48 kHz→16 kHz mono 分帧；
- 以标签启发式选出的 `physical-preferred` mic 输入有非 DC 信号，并通过匿名 label SHA-256 供同轮 I2 fixture 绑定；
- `physical-speaker-preferred` 输出可用于 mic 声学回放；
- VB-Cable 输入/输出组成的独立确定性 audioinput 探针；
- 三路序列/时间戳连续、信号/削波/越界检查，以及 `rawAudioPersisted=false`。

这里的规范称呼是 **physical-preferred label-heuristic acoustic fixture**。`physical-preferred` 是已知标签规则的分类，不是硬件证明；它不能排除未知虚拟端点或伪造标签的虚拟设备。精确 Gate SHA 与匿名输入/输出标签哈希可以防止 I2 在预检后静默改用另一个标签，但不能把启发式升级为硬件 attestation。

## 隐私与历史证据

当前 Gate 0C runner 从不保存捕获音频。每路样本只在有界内存中分析后释放；runner 仅写结构化报告、进度日志和隔离的 Electron user-data 目录。I2 使用的语音 WAV 由受跟踪的 generator/reference 本地生成并被 Git 忽略；I2 child 报告绑定生成 WAV 与 reference digest，不提交 WAV。

2026-07-26 的 [`gate-0c-results.json`](gate-0c-results.json) 是历史拓扑资格记录。当时为核对多路独立性曾在忽略目录暂存短音频并只提交摘要；这些旧产物不是当前产品或 runner 的允许输出，也不能作为新的测试模板。2026-07-30 起，“永不持久化现场音频”是冻结语义。

## 隐藏窗与用户手势

- host 使用专用非持久化 session、`show: false`、`backgroundThrottling: false`；在 ready、触发、三路首帧、对照和结束阶段都由主进程验证为不可见，缺少任何关键观测点都会判失败。
- `executeJavaScript(code, true)` 触发的 display request 必须记录 `userGesture: true`、正确 host frame、`file://` origin、audio/video request。
- handler 从 `desktopCapturer` 选屏幕源并返回 `audio: 'loopback'`；停止视频轨后音频轨仍须为 `live`。不能改用会静音用户系统声的 `loopbackWithMute`。
- 无手势调用只作对照。生产拓扑仍保留 `executeJavaScript(..., true)`，不依赖更宽松的偶然行为。

## 证明边界

本 Gate 证明当前开发机上 hidden host、权限处理、loopback、标签启发式 mic fixture、确定性 audioinput 探针、Worklet 降采样和短时分帧满足报告门禁。它不证明 mic 硬件身份，也不等同于签名打包版、长时 soak、拖动、真实 pause/refine、设备热插拔、睡眠/唤醒、硬崩溃恢复、ASR 性能、I3 或 I4。若隐藏方案回归，工具条 fallback 必须由真实可信点击重新实测，并由工具条持有 stream/Worklet、只向后端传 PCM；不能假定 `MediaStreamTrack` 可跨 renderer 直接转移。
