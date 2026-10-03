# 云端资源与自动冷加载实施记录

日期：2026-09-30。状态：**实现完成·尚未验收**。
关联：SEM-F06/F12/F14/F17/F21、SEM-T03/T04/T06、J20、J16、ADR 0020。

云端正常期间的 worker 配置直接进入轻量音频分支，不构造 WorkerCore，不载入临时字幕识别器、权威识别器、VAD 或 sherpa/ONNX 原生运行时。磁盘模型就绪证明仍为开始前置条件。正常云端仅维护 PCM 转换、有界留存、credit 与受控云端端口；纯本地权威识别与精修不改变。

明确运行期云端故障后，原 worker 冻结已接受首次稳定转写后的样本切点，main 自动创建独立本地 worker 冷加载。采集端继续使用原端口，不替换端口或重新采集。新本地端口完成 ready/credit 握手后，才记录实际 provider=local 并开始按序处理留存音频。每次只发送一个获授信的本地帧，收到 consumed 确认后才从留存中释放；冷加载及追赶未消费样本共同受 60 秒限界，云端待发仍受 2 秒限界。接管期限为 30 秒，留存耗尽可以先触发错误，不能保证完整加载余量。

本地降级进度仅进入 RuntimeSnapshot，依次显示加载、处理留存音频和本地降级识别，可在界面重载后读取，不写 SQLite 或历史。停止/退出取消未就绪的接管并显式报告 RECOGNITION_FALLBACK_FAILED，保留已接受正文；停止命令进入错误时再次停止收束既有会话，应用退出路径自动执行这一收束。所有 native child 必须有 exact exit 确认，迟到 configured 不送帧。成功降级后保持本地到本会话停止，停止释放两个 worker；下一云端会话不保留本地模型。

## 确定性验证

`npm run verify:renderer`：类型检查与生产构建退出码 0。

下列相关定向检查为 211/211，退出码 0；覆盖真实内部模块、SQLite/历史、两来源、云端资源排除、冷加载期间持续留存、有序切点交接、加载失败/超时、缓冲限界、端口关闭、停止/退出和迟到配置。结构模式只证明编排，不证明 ASR：

```powershell
npm run test:focus -- test/contracts/contracts.test.js test/contracts/recognition-progress.test.js test/main/session-coordinator.test.js test/main/electron-exit-evidence.test.js test/main/model-main-wiring.test.js test/runtime/realtime-runtime-adapter.test.js test/runtime/realtime-worker.test.js test/runtime/cloud-worker-mode.test.js test/runtime/cloud-audio-buffer.test.js test/runtime/recognition-session-router.test.js test/runtime/utility-process-lifecycle.test.js test/runtime/nls-realtime-provider.test.js test/integration/nls-recognition-runtime-journey.test.js test/integration/nls-recognition-storage-journey.test.js test/integration/nls-settings-renderer-journey.test.js test/ui/toolbar-notice-ui.test.js test/ui/renderer-style-guard.test.js test/validation/nls-packaging-contract.test.js test/validation/electron-exit-evidence-report.test.js
```

末轮修正首次 loading 快照引发停止的 microtask 竞态，并补上跨 provider/会话的进度负向断言、旧 teardown 幂等和进度清除。受影响范围重新执行如下检查，为 80/80，退出码 0；最后的退出角色映射断言另定向复核：

```powershell
npm run test:focus -- test/contracts/recognition-progress.test.js test/main/session-coordinator.test.js test/runtime/realtime-runtime-adapter.test.js test/integration/nls-recognition-runtime-journey.test.js
npm run test:focus -- test/main/electron-exit-evidence.test.js
```

退出角色映射为 13/13，测试分层守卫 `npm run test:focus -- test/validation/test-lanes-contract.test.js` 为 4/4。受影响文件的 `git diff --check` 返回码 0；两份 r3 报告的 JSON 与正文/PCM/路径/设备/绝对单调时刻字段负扫描返回码 0。

## 真实模型与 Electron 诊断

新增隔离入口 `scripts/fixtures/cloud-fallback-native-app.js`，使用真实 Electron utilityProcess、MessagePort、双语 Zipformer、X-ASR 与 Silero，读取既有受控语料；云端和采集边界受控，无公网请求或现场音频采集。运行命令如下，报告参数须替换为当前仓库内 `.artifacts/` 的新绝对输出地址：

```powershell
node scripts/run-supervised-electron.js --strict-report --report .artifacts/cloud-native-exit-2026-09-30-r3.json --entry scripts/fixtures/cloud-fallback-native-app.js --entry-arg "--report=<仓库根>/.artifacts/cloud-native-2026-09-30-r3.json"
```

监督器退出码 0，`outcome=clean-exit`、incident 0、breakpoint false。两个切点均有真实本地首次稳定转写，106 输入帧与 106 本地消费帧一致，故障计数 0，相关四个 utility child 的退出码均为 0。结果仅保留指标和摘要：

| 切点样本 | 云端音频 worker 工作集 MiB | 本地 worker 工作集 MiB | 冷加载及端口握手 ms | 临时字幕数 / 首次稳定转写数 |
|---|---:|---:|---:|---:|
| 0 | 62.39 | 511.72 | 2737 | 20 / 1 |
| 800 | 62.48 | 513.47 | 2723 | 20 / 1 |

两个切点的首次稳定转写摘要一致。以上使用 Electron 的 workingSetSize，包含共享页；不是任务管理器的专用工作集，不能直接与最初截图的 464 MB 相减，也不能当作整应用内存降幅。冷加载成本仅代表这两轮受控诊断，不能推断所有设备或缓存状态。

第一次受限沙箱启动在 GPU 子进程加载阶段异常退出，未进入产品断言，记录不能计作产品失败或成功。第二次诊断的两个 native 切点成功，但隔离入口尚未接入监督器生命周期协议，监督器判为 incomplete；没有把它计作退出证据。补齐协议后的 r3 才得到同轮 clean-exit。

原始报告位于 `.artifacts/cloud-native-2026-09-30-r3.json`，退出证据位于 `.artifacts/cloud-native-exit-2026-09-30-r3.json`，均为 diagnostic-only。未重新运行完整三条 lane，不替代远端 CI provenance、打包、真实 NLS、物理 mic/loopback、冻结字幕可见延迟、两小时 I3 或干净机 I4。运行中的用户应用仍使用已加载的旧代码，需要正常重启后观察整应用内存与实际云端降级效果。
