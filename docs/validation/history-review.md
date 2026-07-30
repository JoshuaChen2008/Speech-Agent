# SQLite 历史复盘与安全导出验证

- 日期：2026-07-31
- 状态：确定性联合验收完成；205 段有界分页与受控真实 Electron DOM 已补证；系统对话框、I3/I4 尚未验收
- 语义：SEM-F02/F03/F04/F05/F07/F11/F14，SEM-T01/T02/T04/T05
- 旅程：J1/J2/J4/J12

## 用户结果

用户完成一次单路监听后，已定稿字幕自动保存在 SQLite；活动会话不会提前出现在历史。停止后可从工具条打开独立历史窗口，按倒序会话列表查看相对时间、墙钟时间和当前正文，并由主进程保存为 txt、md 或 srt。历史是文本复盘，不提供录音或音频回放。

ASR `refined` 是同一字幕段的更高修订正文，不是 Agent 的“增强文本”。翻译、LLM 增强文本、摘要和 Pi Agent Loop 均未进入本阶段。

## 真实模块与替身边界

联合旅程 `test/integration/history-review-journey.test.js` 使用：

```text
SessionCoordinator
  → SqliteSessionRecorder
  → StorageGateway
  → storage worker protocol
  → StorageWorkerService
  → SqliteSubtitleStore / real temporary SQLite file
  → HistoryService
  → txt / md / srt files
```

只替代三个不可确定或平台边界：

1. Electron utility process 由 service-backed host 代替，但请求仍经过生产协议、WorkerService 和真实 SQLite store。
2. 物理 mic/loopback 与 ASR 由 `FakeRuntimeAdapter` 注入契约合法的 CaptionEvent；真实 loopback ASR 另有 I2 证据，物理 mic 仍待补。
3. OS 保存对话框返回测试目录中的主进程选择路径；renderer 没有提供路径、SQL 或文件写能力。

## 覆盖结果

- mic 会话活动时历史为空；partial 不持久化，final 后的更高 refined 成为唯一当前正文。
- 正常 stop 后会话成为 `closed`，列表与详情携带 `startedAt/endedAt`。
- 停止后切到 loopback，配置、runtime、SQLite 与历史仍保持 XOR 和会话隔离。
- 终态列表按 `startedAt DESC, sessionId DESC` 稳定排序，并用 keyset cursor 分页。
- 205 段同时间戳/refined fixture 经完整 Coordinator→SQLite→HistoryService 链路分成 5 页；cursor 严格前进，拼接后无缺失/重复，并与私有全量 SQLite 投影逐项及 SHA-256 一致。
- renderer 页只含 6 个展示字段，完整 transcript 不跨 renderer IPC；txt/md/srt 仍各导出 205 条最新正文，不受 50 条 UI 页大小影响。
- txt/md/srt 从同一 SQLite 当前投影生成；保存回执不把 OS 路径返回 renderer。
- 详情、IPC、导出和临时目录均无译文、音频字段、音频路径或音频文件。
- 活动详情、未知格式、额外 SQL/目标路径载荷 fail closed；取消保存不写文件。

定向命令：

```text
node --test --experimental-test-isolation=none test/integration/history-review-journey.test.js test/main/history-service.test.js test/ui/history-ui.test.js test/main/ipc-access-policy.test.js
```

结果：32 tests passed，0 failed。

阶段提交前最新完整门禁 `npm run test:ci`：integration 14/14；完整回归 327/327，0 failed。

## 真实产品壳补证

2026-07-31 的 [`product-shell-results.json`](product-shell-results.json) 使用真实
`src/main.js`、四个 BrowserWindow/preload/IPC、SQLite utility process 与退出屏障，
在隔离 fresh userData 中完成听写首设、开始、final DOM、停止、打开终态历史和正常
退出；另预置 205 段终态 SQLite fixture，通过真实 main/preload/IPC/renderer 点击 5 页、
到达第 201–205 条并执行上一批/下一批往返。报告记录 `historyMaxTimelineNodes=50`、
四个 renderer 且 `crashEventCount=0`。该 smoke 使用显式 fake-ASR 且没有操作系统保存
对话框，也不是两小时墙钟/数千段 soak，所以不替代物理 mic、旧档迁移/重启、I3 或 I4。

## 尚未被本证据证明

- 系统保存弹窗、DWM 外观与真实辅助技术行为。
- 两小时数千段下的 DOM、SQLite WAL、内存和查询延迟（I3/J8）。
- 打包版 utility process、asar/NSIS 路径和干净 Win11 用户旅程（I4/J9）。
- 物理 mic 实机 ASR。以上边界未通过前，不得声称 I3/I4 或发布验收完成。
