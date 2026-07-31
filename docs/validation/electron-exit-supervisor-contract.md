# Electron 退出证据 supervisor 契约

`npm start` 默认以 fail-open 模式启动 Electron。退出证据是诊断旁路，任何初始化、运行中或最终写盘失败都不能缩短 Electron 的自然生命周期。supervisor 最多输出一次固定且不含路径的 warning，不枚举进程，也不终止已启动的 child。

CI 可显式传入 `--strict-report`（程序接口为 `strictReport: true`）：

- 第一次 current 写入失败时，Electron 尚未 spawn，supervisor 可以直接拒绝启动；
- spawn 后发生的任意写入或清理失败只会被记为延迟失败；supervisor 必须等待 child 自然退出并完成 IPC 排空，之后才返回失败；
- strict 只改变 supervisor 的最终状态，不改变 child 生命周期。

## 三层文件语义

每次 supervisor 启动都会在 canonical 同目录生成只属于本次启动的随机 `.current` 文件。该地址和 canonical、last-abnormal 地址都不进入 evidence JSON，JSON schema 与隐私边界保持不变。所有单文件替换仍通过同目录临时文件、`fsync` 和 rename 原子完成。

- `last-exit-evidence.json`：canonical，只接受完成 bootstrap 的 `clean-exit`，或任意阶段的 `abnormal-exit`；
- 随机 `.current`：保存本次运行中的 `incomplete` 快照，最终收束后只清理本 supervisor 确切拥有的文件；
- `last-abnormal-exit-evidence.json`：只在最终结果为 `abnormal-exit` 时更新，后续 clean run 不会擦除它。

新启动不会用 `incomplete` 覆盖 canonical。未完成 bootstrap 的 clean secondary 也不晋升；pre-bootstrap abnormal 仍会同时晋升 canonical 和 last-abnormal。

## IPC 排空与 cleanup 边界

观察到 child `exit` 后，supervisor 继续接收 IPC，直到 IPC `disconnect`；若 disconnect 缺失，则最多等待 500 ms 后收束。disconnect 路径会再让出一个事件循环 turn，避免丢失已经排队的最后一条 lifecycle/incident。该等待有界且不执行强制退出。

正常收束时只删除本次随机 current。若 supervisor 自身被操作系统突然终止，遗留 current 可能保留；后续启动不会枚举或删除其他运行的 current，以免越权清理并发实例。

并发 supervisor 之间没有全局锁。它们拥有互不相同的 current；在符合晋升条件的 final 之间，最后完成原子 rename 的 writer 决定 canonical，last-abnormal 则只在 abnormal writers 之间遵循同一规则。这里的“最后”指完成写入顺序，不是启动时间。`incomplete` 和 clean secondary 永远不参与竞争。
