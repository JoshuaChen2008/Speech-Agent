# Electron `0x80000003` 调查记录

- 状态：即时触发机制已由现场 stderr 与固定版本源码闭环；具体发送者、进程角色和此次竞态根因仍无 native stack 证明
- 对应语义：SEM-F12、SEM-F14、SEM-T02、SEM-T03、SEM-T04、SEM-T14
- 证据日期：2026-07-31

## 当前结论

用户两次提供的窗口都显示 `electron.exe` 抛出 `0x80000003`（Windows `STATUS_BREAKPOINT`），异常地址相同。后续一次未纳入权威 bundle 的 loopback 诊断已完成 pass 报告、stdout、18 条 caption、final/refined 和 128/128 帧，随后 exact Electron main 没有自然退出；stderr 只有：

```text
PostQueuedCompletionStatus: (6) 句柄无效。
```

固定版本源码可以把这条 stderr 与截图闭成同一条即时错误路径：Electron 43.2.0 固定 Node 24.18.0，而该 Node 内含 libuv 1.52.1；Windows `uv_async_send()` 通过 `POST_COMPLETION_FOR_REQ` 调用 `PostQueuedCompletionStatus`。调用返回 false 时宏进入 `uv_fatal_error`，Windows 实现先写 stderr，再执行 `DebugBreak(); abort();`。因此现场文本可以直接解释 `0x80000003`，截图不是必须另找原因的第二个故障。

参考的一手源码：

- [Electron 43.2.0 DEPS](https://raw.githubusercontent.com/electron/electron/v43.2.0/DEPS)
- [Node 24.18.0 libuv async.c](https://raw.githubusercontent.com/nodejs/node/v24.18.0/deps/uv/src/win/async.c)
- [Node 24.18.0 libuv req-inl.h](https://raw.githubusercontent.com/nodejs/node/v24.18.0/deps/uv/src/win/req-inl.h)
- [Node 24.18.0 libuv error.c](https://raw.githubusercontent.com/nodejs/node/v24.18.0/deps/uv/src/win/error.c)

这仍未证明**是谁**在已关闭的 IOCP 上发送，也未证明**为什么**这个句柄在该时点失效。libuv 2026-05-29 合入的 Windows 修复 [ea493f / #5079](https://github.com/libuv/libuv/commit/ea493f19895bc0cc90b28b48a4e204bc139c48d3) 处理 `uv_async_send` 与 loop/IOCP 关闭的竞态，且不在当前 Node/libuv 版本中；它与“业务完成后、退出收束期、invalid handle”高度吻合，但没有现场 native stack，不能把高度吻合升级为本次已证实根因。也没有证据把 stdout/stderr 重定向、GPU、sherpa、renderer 或某个 utility 单独定罪。

## 当前代码与防悬挂边界

字幕资源先按产品生命周期收束：coordinator `stop` 等待采集与 realtime/refine 完成，child 的 schema-v5 成功报告通过严格验证并落盘，随后 `coordinator.dispose()` 完成，最后才调用 Electron `app.quit()`。内部 pass 报告本身不能证明此后的进程退出；因此权威 runner 只在它等待的 exact Electron child 以 0 退出、且没有 timeout 或 runner termination 后，才写入绑定 child 原始字节 SHA-256 的 schema-v1 `i2-exact-child-exit` sidecar。loopback/mic 各 5 个 child 与 5 个 sidecar 再进入 schema-v6 series。这关闭了“先写 pass、随后悬挂/超时仍假绿”的证据缺口；它只说明当前 10 个受控样本满足该退出结果，不证明竞态永久消失。

`scripts/run-electron-smoke.ps1` 现在默认只等待它启动的 exact process 120 秒。超时即判失败，并只对该 process object 调用清理；脚本不按名称枚举 `electron.exe`，不影响其他 Codex/Electron 进程，也不把强制清理写成自然退出成功。Windows PowerShell 5 在等待前显式取得 process handle，确保自然退出后仍可可靠读取 `ExitCode`。

产品运行时本身仍保持以下边界：

- realtime/refine/storage UtilityProcess 有 fatal listener、固定 service name、worker shutdown 协议与 exact-child exit 屏障；
- native worker 先给 30 秒 graceful window，超时后只终止并收殓 exact child，再给 5 秒 reap window；
- Coordinator 在旧 generation 未确认退出前拒绝启动 replacement；
- 字幕运行时 45 秒只是升级触发线，不是绕过 exact-child 收殓的硬退出上限；
- role evidence、I2 child、exact-child-exit sidecar 和退出诊断不保存 PID、命令行、正文、音频/PCM、本地路径、stack 或 dump；sidecar 只有固定 schema/kind/source/outcome 与 child 原始字节摘要。

批准模型活跃诊断三轮的 6 个 realtime/refine exact child 均优雅 `exitCode=0`、fatal 0。受监督开发态与 packaged 多窗口产品壳也有 clean exit、incident 0 的结构化证据。它们与退出绑定 I2 权威证据中的 10 份外部 sidecar 共同降低了稳定复现概率，但 sidecar 不是签名、远端证明、硬件证明或崩溃根因证明，也不能代替一次故障现场 native stack。

## 与 I2/B5 的边界

当前退出绑定 I2 权威证据覆盖 loopback/mic 各 5 轮真实 audio-host→online ASR→Silero→offline refine→Coordinator；每来源包含 5 个 schema-v5 child、5 个 schema-v1 exact-child-exit sidecar 和 1 个 schema-v6 series，并记录 exact accepted-partial 跨时钟六段诊断。10 轮均有 final/refined，loopback 最大 final/refined CER=0/0、mic=0.035714/0，帧全等且 12 项丢失峰值为 0。冻结字幕可见延迟 P95 为 1158/1005ms：两来源分别超 `<1000ms` 线 158ms/5ms，I2 整体仍未关闭。它不替代真实 pause/refine、拖动、设备变化、睡眠/唤醒、硬崩溃、I3 或 I4，也不把当前退出样本升级为 `0x80000003` 根因或永久修复证明。

B5 已证明过真实 Windows x64 ASAR、native unpack/实际加载、SQLite utility、四窗旅程和 NSIS 机械生命周期，但其 exact installer/SHA 属于前一候选 `369055a`。本阶段改动了生产 audio-host/runtime，旧制品不代表当前 HEAD；提交本阶段后必须重建 packaged qualification，进入 I4 前再冻结新的 installer SHA。

## 后续可证伪诊断

1. 同一 I2 命令分别用继承控制台的 exact-child supervisor 与文件重定向 runner 对照。两者都复现可排除“重定向是必要条件”；只在重定向下复现也只能说明它改变时序或概率，不能直接归因。
2. 若再次出现精确 stderr，只记录固定安全元数据：stderr 是否匹配、相对 pass stdout 的顺序、exact child 退出分类和固定进程角色；不得保存正文、设备名、路径或现场音频。
3. 只有在隔离的冻结输入诊断中、经用户批准，对 exact process 捕获一次 native stack，才可能区分 libuv sender 竞态与 Chromium service 自身关闭。dump 可能含进程内存，不能默认常开或进入普通 CI artifact。
4. 若未再次复现，只能保留“当前样本自然退出、具体根因未获 stack 级证明”，不能宣称永久修复。

## 明确未证明

- 没有定位出 invalid-handle 发送者或具体 Electron 进程角色；
- 没有证明 libuv #5079 就是此次根因，也没有证明重定向、GPU、sherpa 或 renderer 是根因；
- 没有完成真实硬崩溃后的 replacement、字幕恢复或两小时资源稳定性；
- 没有因为诊断改变“永不持久化现场音频”的产品语义。
