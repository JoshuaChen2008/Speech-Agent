## Why

用户在同一个 NLS 项目上观察到当前开发版持续落后，而参考程序跟随更快。已复现发送器在停顿后永久保留积压；原有首个 partial 的单一阈值也不足以衡量持续跟随体验。需要先建立云端完整测量，再压缩可避免的客户端延迟，不能达到 800ms 或 1000ms 就停止优化。

## What Changes

- 先补云端路径的受控基线与相对分段诊断，区分首字、持续文字更新、积压恢复、停顿定稿、启动；同机同项目比较当前版、候选与参考程序。
- 优先实验真实采集驱动的发送、有界追平及 100/40/20ms 云端分帧；吞吐保护与体验目标分开，2 秒安全上限不能当作正常排队预算。
- 再分别实验上海/就近网关、800/500/300ms 断句与标点开关。每次只改变一个变量，以持续显示收益、准确性、抖动和资源成本选择参数。
- 仅在分段证据指向 main 阻塞或 Chromium 采集时，进入识别网络执行位置或 WASAPI 采集的后续架构实验。
- 拟为云端建立独立体验验收与持续优化口径，替代照搬首个 partial `<1000ms` 的单一云端结论；保留同一起点的原始测量与历史证据，不改变纯本地冻结门槛。正式语义同步必须先于代码实施。
- 请求参数与传输策略按会话冻结且可追溯，旧识别会话快照继续可读；不通过修改公共常量使历史配置失效。

## Capabilities

### New Capabilities

- `nls-streaming-latency`: 云端识别的持续字幕体验测量、有界发送恢复、实验资格与历史兼容约束。

### Modified Capabilities

无已有 OpenSpec 主规范可复用；要求仍以 SEM-F01/F04/F06/F12/F14/F21/F25、SEM-T06、J20 和 ADR 0020 为权威，本 change 记录拟议增量。

## Impact

主要涉及 `src/runtime/recognition/*`、`audio-host/{host,frame-assembler,frame-flow}`、realtime worker 的云端传输与本地接管、识别配置/契约、Coordinator/字幕 renderer 的诊断观察及 I2 运行器。参数版本化可能涉及 recognition session 存储读取，必须先走存储路由；不预设新增数据库迁移。

本轮只生成调查与规划，未修改生产代码或现行语义合同。已有复现见 [诊断记录](../../../docs/validation/nls-latency-investigation-2026-09-27.md)，新增取证见 [research.md](research.md)，分阶段设计见 [design.md](design.md)。实现阶段不得使用未验证参数替换正式默认值。
