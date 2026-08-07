# SQLite 历史复盘与安全导出验证

- 日期：2026-07-31
- 状态：联合验收完成；205 段有界分页、三格式完整导出、旧档迁移/离线复启与 I3 非音频预资格已有证据；真实系统对话框、两小时声源与 I4 仍为实现完成·尚未验收
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
2. 本历史旅程中的 mic/loopback 与 ASR 由 `FakeRuntimeAdapter` 注入契约合法的 CaptionEvent；后续独立的退出绑定 I2 权威证据以两来源各 5 个 schema-v5 child、5 个 schema-v1 exact-child-exit sidecar 和 1 个 schema-v6 series 覆盖产品路径 ASR，其中 mic 是 `physical-preferred-label-heuristic` 声学 fixture，而非硬件证明。本旅程本身不冒充声卡验证。
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
退出；另预置 205 段终态 SQLite fixture 和一份只读旧 JSONL，通过真实
main/preload/IPC/renderer 点击 5 页、到达第 201–205 条并执行上一批/下一批往返，再点击
txt/md/srt 导出按钮并经主进程受控保存路径写出各 205 段。报告记录
`historyMaxTimelineNodes=50`、三条终态历史、旧档 SHA 不变、无 JSONL 双写、四个 renderer
且 `crashEventCount=0`。该 smoke 使用显式 fake-ASR，保存对话框返回值受控，也不是实际
两小时声源，所以不替代 I2、真实系统对话框、真实两小时 I3 或干净机 I4。

B5 已从 packaged test executable 对同一四窗口/分页/迁移/导出旅程进行重跑，并用相同
userData 完成不启动 fixture server、模型 fetch 为 0 的离线复启；三条历史、迁移幂等和
三份导出保留，新会话成为第四条历史。两次 ASAR storage utility 均完成 DB0 WAL、事务、
重开与 integrity 检查，两个 exact child 都以 0 正常退出。这关闭了打包布局与 SQLite
utility/重启可加载的确定性缺口，仍未操作真实系统保存对话框，也不是精确 NSIS 安装后
在干净 Win11 上的 I4 用户旅程。

I3 非音频预资格随后以 3,600 段/4,000 事件、虚拟两小时、SQLite 关闭重开、72 页、
DOM 最大 50 节点、WAL/内存/CPU/查询/队列上界和 txt/md/srt 各 3,600 段通过。它使用
真实 Coordinator→SQLite→HistoryService 与实际 `history.js` VM DOM，但没有
BrowserWindow、speaker、mic 或 loopback，不能替代真实两小时声源。

## 尚未被本证据证明

- 系统保存弹窗、DWM 外观与真实辅助技术行为。
- 真实两小时声源下的 DOM、SQLite WAL、内存和查询延迟（I3/J8）；对应非音频虚拟时钟
  预资格已通过。
- 精确 NSIS 安装后的系统保存对话框与干净 Win11 用户旅程（I4/J9-I4）。
- 该旅程不含真实音频采集/ASR；后续 I2 只补了 loopback 与 mic 标签启发式声学 fixture 的退出绑定重复运行证据。两来源冻结延迟 P95 分别超线 158ms/5ms，且 mic 结果不是硬件证明；真实 pause/refine、拖动、设备变化、睡眠/唤醒与硬崩溃也未验收。其余边界未通过前，不得声称 I2/I3/I4 或发布验收完成。
