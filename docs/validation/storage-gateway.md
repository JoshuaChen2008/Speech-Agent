# Storage Gateway 与会话持久化屏障

> 状态：**联合验收完成**；Gateway/Recorder/Coordinator 恢复组合与 SQLite-only 默认产品旅程已有确定性证据
> 日期：2026-07-31

## 结论

隐藏 Electron 43.2 组合从生产 `SessionCoordinator` 经过
`SqliteSessionRecorder → StorageGateway → StorageWorkerHost → utility process →
WorkerService → SqliteSubtitleStore` 写入真实文件 SQLite。loopback 与 mic 依次
运行；采集只在 session open ACK 后启动，final/refined 先进入 Gateway FIFO
再广播 UI，caption 与 close 全部 ACK 后才从 `stopping` 进入 idle。

结构化证据：[`storage-gateway-results.json`](storage-gateway-results.json)

组合旅程还验证了 pause/resume 不换会话、translated/partial 不进入字幕事实，
以及三类 storage generation 故障：空闲退出、caption COMMIT 前退出、COMMIT
后回复丢失。Gateway 都先确认旧 utility child 退出，再启动 fresh generation，
以原始克隆载荷和稳定幂等键重放队首；最终事实与投影各只有一份。

独立的确定性联合回归还把 Gateway 高水位压到 1：第二条已显示 refined 占用受保护
溢出槽后，Coordinator 立即停采集，边界内第三条 refined 保留到 retry；在三条事件获得
ACK 前不会恢复监听。另一条旅程在 backlog 未排空且存在停采集边界字幕时执行
stop：终态 close 不会提前入队，retry 必须先按序持久化全部三条字幕，再提交 close，
只有四个操作全部 ACK 后才进入 idle。Gateway 仍为 close 保留独立的有界容量，但不允许
容量保护破坏 caption-before-close 的业务顺序。旅程还在第三条字幕 flush 与 close 之间
注入退役 generation 的第四条事件，断言终止 ingress 栅栏明确拒绝，不会「接受后丢弃」。

## 范围边界

- 本阶段证明可切换的产品级组件与真实 worker 恢复，不把测试 fixture 当作产品
  可调用的故障命令。
- 默认 `main.js` 现通过 `SubtitleApplicationRuntime` 实例化 SQLite recorder/gateway；
  JSONL 只作为 DB2/J10 **确定性迁移覆盖**中的旧档输入，不再承担产品写入，也不存在双写双权威。
- 默认权威切换、历史 UI/导出、冷启动残留 active 会话与产品 `before-quit` 已由后续
  联合旅程覆盖；当前 B5 又在 ASAR 内以同一 userData 完成首启与离线复启，证明旧 JSONL
  只读迁移、SQLite-only 新会话、迁移幂等、205 段三格式导出与两次正常退出，J10 的
  确定性产品/打包门禁已关闭。I3 的 3,600 段非音频预资格已通过；真实两小时声源和
  精确 NSIS 的干净机 I4 仍待验收。
- 隔离 userData 与报告均无现场音频；结构化报告不含正文或绝对路径。
