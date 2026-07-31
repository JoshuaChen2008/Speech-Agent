# Live Subtitle Agent · Claude 全量交接

> **历史快照，不再作为当前计划或状态来源。** 本文保留 2026-07-26 交接上下文；
> 当前状态以 [`../PLAN.md`](../PLAN.md) 为准，功能与测试语义以
> [`semantic-contract.md`](semantic-contract.md) 为准，SQLite 目标设计见
> [`data-architecture.md`](data-architecture.md)。本文后续出现的 Gate 0B、B2/B3、
> JSONL 或“未实现”描述均只代表交接当日，不得覆盖上述规范文档。

> **当前检查点（2026-07-31）：** B3.3 SQLite、B4 模型资源和 B5 资格方法已有证据；
> I2 权威证据已升级为 `docs/validation/i2-live-v5/` 内精确 Gate，以及 loopback/mic 每来源
> 5 个 schema-v5 child、5 个 schema-v1 exact-child-exit sidecar 和 1 个 schema-v6 series。
> 外部 runner 只在 exact child 以 0 退出且没有 timeout/runner termination 后写 sidecar，避免
> 内部 pass 报告后悬挂或超时误绿。10 轮均 final/refined，loopback 最大 final/refined CER=0/0、
> mic=0.035714/0，帧全等且 12 项丢失峰值全为 0；冻结字幕可见延迟 loopback/mic P95=1158/1005ms。
> 两来源仍高于未改变的 `<1000ms` 线 158ms/5ms，I2 整体未关闭。
> 每个 child 的六段 exact accepted-partial trace 与 40ms post-source captured-energy guard 只作诊断，不改写该验收结论。mic 仅为 `physical-preferred-label-heuristic` 声学 fixture，不是硬件证明；sidecar 也不是签名、远端证明、硬件证明或崩溃根因证明。I2 的两来源性能、
> 拖动、真实 pause/refine、设备变化、睡眠/唤醒和硬崩溃仍未关闭；I3/I4 也待验。
> B5 exact installer/SHA 属于前一候选 `369055a`，生产 audio-host/runtime 已变化，进入 I4
> 前必须从新 HEAD 重建、重取证并冻结新 SHA。权威 10 轮均有外部退出 sidecar；另一次未纳入 bundle 的运行
> 在报告 `pass` stdout 后悬挂。`PostQueuedCompletionStatus(6)` 到 libuv fatal、`DebugBreak` 的机制已有闭环解释，但无 native stack，具体关闭竞态、发送者与进程角色仍未证明。翻译、Agent 与向量继续后置。

> 交接日期：2026-07-26（Asia/Singapore）
>
> 仓库：本文所在 repository root
>
> 交接基线：`codex/b1-application-skeleton@339d334bcbbb665350708fc497429e79378a5c6d`
>
> 交接对象：Claude
>
> 当前结论：Gate 0A/0C/0D 与视觉 V1–V2 已完成；B1 骨架和 I1 现有契约集成已提交，但有两个 B2.0 恢复缺口必须先关闭；Gate 0B 实测完成但未通过。

## 1. Claude 先做什么

不要从 `master` 开始。`master` 停在 `7a902c5`，缺少 Gate 0D 和整个 B1。

```powershell
# 在当前 repository root 执行
git switch codex/b1-application-skeleton
git status --short
git log -10 --oneline --decorate
npm test
```

交接审计时：

- 当前分支为 `codex/b1-application-skeleton`。
- HEAD 为 `339d334`。
- 原工作树完全干净；本交接文件是审计后新增的唯一预期改动。
- 没有配置 Git remote，不能假定可以 push。
- `npm test` 为 **57/57 PASS**。
- Node `v22.22.2`、npm `10.9.7`、Electron `43.2.0`、Git `2.53.0.windows.1`。

开始修改前依次阅读：

1. 本文。
2. [`PLAN.md`](../PLAN.md)——当前路线图和 Gate 判定。
3. [`src/contracts/README.md`](../src/contracts/README.md)——冻结的 v1 契约。
4. [`docs/runtime-architecture.md`](runtime-architecture.md)——运行后端边界。
5. [`docs/ui-design-brief.md`](ui-design-brief.md)——UI 所有权、状态规则和未结 contract requests。
6. [`docs/subtitle-window.md`](subtitle-window.md)——窗口、停靠、穿透和尺寸不变量。

权威性从高到低：运行时 validator/测试 > 结构化 Gate 结果 JSON > Gate 报告 > PLAN/README 中的摘要。文档示例若与 validator 不一致，以 validator 为准。

## 2. 用户目标与工作规则

产品目标是 Win11 上的本地实时字幕 Agent：同时支持系统音频（远端会议声音）和麦克风（自己说话），本地 ASR，后续可选云端翻译/摘要。

用户已经明确的协作规则：

- UI 设计此前交给另一模型，现已作为四个提交进入当前历史；不要无理由推翻现有视觉方案。
- 视觉、Electron 壳和运行后端必须通过冻结契约协作，renderer 不得猜测或伪造后端成功状态。
- 每完成一个大的功能，先让独立 subagent/reviewer 只读审查；解决问题、重跑验证后再提交。
- 每个大功能单独提交，不夹带其他范围。
- 不提交模型、原始音频、设备标签、机器路径、API Key 或用户私密内容。
- 不得为了赶进度静默放宽 Gate 0B 门槛。

## 3. 当前提交拓扑

```text
339d334  feat(app): wire B1 runtime through window APIs       ← 当前 HEAD
23588dd  feat(runtime): add session coordinator skeleton
7e98dbe  feat(config): lock Gate 0D presets
7a902c5  docs(ui): record the open contract requests          ← master
af6109f  feat(caption): make the caption window resizable
2b6303f  feat(ui): slim the toolbar down and make appearance configurable
2c17319  feat(ui): add shared design layer and snapshot-driven windows
3370a81  test(audio): validate Gate 0C capture topology
c462708  test(asr): record Gate 0B model validation
1520d85  feat(contracts): freeze Gate 0A runtime v1
f6eaa6d  chore: establish project baseline
```

不要再次 cherry-pick UI 提交；它们已经是当前 HEAD 的祖先。

## 4. 进度总表

| 工作项 | 状态 | 结论 |
|---|---|---|
| Gate 0A 契约 | 完成 / PASS | 四类 v1 契约、validators、fixtures 已冻结 |
| Gate 0B 模型 | 改判通过 / PASS | 已批准 `x-asr-160ms` fast profile 与离线 X-ASR 精修；原失败门槛和改判理由均保留审计 |
| Gate 0C 音频拓扑 | 完成 / PASS | 批准当前开发机上的 hidden audio host 拓扑 |
| Gate 0D 产品入口 | 完成 | 首启双预设；选择前两路音频均关闭 |
| 视觉 V1–V2 | 完成 | token、状态矩阵、稳定字幕 DOM、caption reducer、工具条和预览页 |
| B1 应用骨架 | 已提交 / 恢复缺口已关闭 | ConfigStore、SessionCoordinator、fake adapter、per-window preload、IPC 已接线；caption bootstrap 与 replacement cursor 已由 B2.0 关闭 |
| I1 Contract | 验收完成 | UI/adapter/coordinator/IPC 共用 v1 契约；renderer reload 的 caption state 已形成订阅/水合/重放闭环 |
| B2/I2 实时链路 | 实现完成 / I2 未关闭 | hidden audio host、PCM 直通、realtime/refine worker、silero VAD 与真实 ASR 已产品化；退出绑定权威证据以两来源各 5 个 schema-v5 child + 5 个 schema-v1 exit sidecar + 1 个 schema-v6 series 证明准确性、零丢失与 exact-child exit 0。冻结字幕可见 P95=1158/1005ms；两来源超线 158ms/5ms。六段 trace 与 40ms captured-energy guard 只诊断，mic fixture 与 sidecar 都不构成更强证明；交互/恢复待补 |
| B3 精修/会话 | 实现完成 / I3 待验 | SQLite-only 产品网关、迁移、两遍精修、历史查询与 txt/md/srt 导出已接线；两小时/数千段与真实恢复仍归 I3 |
| B4 资源 | 联合验收完成 / I4 待验 | ModelManager、固定资源下载/校验/原子安装、设置页和空闲热启用已接线；干净机公网首次供给与 ready 后离线复启归 I4 |
| B5 分发 | 资格方法通过 / 当前 HEAD 待重建 | 前一候选 `369055a` 的 ASAR/NSIS/native/packaged journey/隔离安装卸载已取证；生产 runtime 已变化，进入 I4 前须重建并冻结新 SHA |

## 5. Gate 0A：冻结的 v1 契约

- 提交：`1520d85`
- 目录：[`src/contracts/`](../src/contracts/)
- 专项测试：[`test/contracts/contracts.test.js`](../test/contracts/contracts.test.js)

四类对象：

- `RuntimeSnapshot`：`schemaVersion / revision / sessionId / phase / capabilities / sources / model / lastError`
- `CaptionEvent`：`schemaVersion / sessionId / sourceId / segmentId / sequence / revision / kind / t0 / t1 / text / translation`
- `CommandResult`：`schemaVersion / ok / code / message / recoverable / nextAction`
- `Capabilities`：七个 `can*`、`availableProfiles / availableSourceIds / translationTargets / limitations`

Fixtures 覆盖：

- runtime：`unavailable / idle / starting / listening / paused / resumed / stopping / recovering / error`
- caption：`partial / final / refined / translated`
- commands：成功、模型未就绪、命令忙、翻译不可用
- capabilities：完整演示、fallback profile、完全不可用

不可破坏的语义：

- snapshot 是完整事实，不是 delta；消费者拒绝旧 `revision`。
- pause/resume 保持同一 `sessionId`。
- `sequence` 在 session/source 内单调；`revision` 在 segment 内单调。
- translated 必须引用它所基于的原文 revision。
- 未知字段有意忽略以支持前向兼容；缺少/写错必需字段必须拒绝。
- fixtures 递归冻结。
- `full` Capabilities fixture 只是 UI 演示，**不代表真实模型已批准**。
- 单条 validator 会检查对象形状及对象内部的 phase/capability/source/model/timestamp/translation 等局部语义不变量；跨事件历史顺序由 `SessionCoordinator` 保证。

复现：

```powershell
node --test --experimental-test-isolation=none test/contracts/contracts.test.js
```

## 6. Gate 0B：模型实测已完成，但 Gate 未通过

> 状态更新（M4，2026-07-27）：产品负责人正式改判——RTF 门槛在写明机器基线与理由后重设为 `<0.60`，批准 `x-asr-160ms`（fast profile，numThreads=4）与离线 X-ASR 精修（替换 SenseVoice）。`gate-0b-results.json` 现为 `approvedProfiles: ["fast"]`、`approvedRefinement: true`，判定与 tracked 证据（`gate-0b-m2-sweep.json` / `gate-0b-m3-evaluation.json`）由 `test/gate-0b/metrics.test.js` 强制一致。原判定、原门槛与下文描述作为历史保留；弱机/打包版仍需 B5/I4 复测后才发布 profile。

- 提交：`c462708`
- 报告：[`docs/validation/gate-0b.md`](validation/gate-0b.md)
- 结构化结果：[`docs/validation/gate-0b-results.json`](validation/gate-0b-results.json)
- 完整复现说明：[`scripts/gate-0b/README.md`](../scripts/gate-0b/README.md)

原判定硬结论（历史，已被上方 M4 改判取代）：

```text
approvedProfiles: []
approvedRefinement: false
```

| 候选 | 实测 | 失败原因 |
|---|---|---|
| X-ASR 480ms punct int8 | RTF 0.18–0.26；中文/code-switch 首 partial P95 1012–1034ms | 超过冻结的 `<1000ms`，不能把 21–34ms 四舍五入掉 |
| X-ASR 160ms punct int8 | 首 partial P95 约 700ms；RTF 0.44–0.65 | 未满足 RTF `<0.35` |
| small-bilingual int8 | RTF/延迟通过 | code-switch 内容严重缺失且无标点 |
| SenseVoice int8 | 聚合 RTF 0.070 | macro CER 退化、标点 F1 下降、无净精修收益 |

生产默认必须保持 `Capabilities.availableProfiles = []`。B1 只有以下显式开发开关可以暴露 fake runtime 的 `balanced` profile：

```powershell
$env:LIVE_SUBTITLE_DEV_MODEL='x-asr-480ms'
npm start
```

该开关不加载真实模型、不改变 Gate 结论，也不得进入生产默认配置。

CLI 与受控指标复现入口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/gate-0b/generate-corpus.ps1

node scripts/gate-0b/run-cli-suite.js `
  --asset-root models/gate-0b `
  --raw-dir models/gate-0b/runs/cli-raw `
  --output docs/validation/gate-0b-cli-observations.json

node scripts/gate-0b/evaluate-transcripts.js `
  --corpus scripts/gate-0b/corpus.json `
  --observations docs/validation/gate-0b-cli-observations.json `
  --output docs/validation/gate-0b-controlled-metrics.json
```

N-API 延迟复测如需临时依赖：

```powershell
npm install --no-save --package-lock=false `
  sherpa-onnx-node@1.13.4 `
  sherpa-onnx-win-x64@1.13.4
```

首 partial/processing RTF 由同版本 N-API 的流式 benchmark 复现；每个 case 重复传入 `--wav` 或分别运行：

```powershell
node scripts/gate-0b/streaming-bench.js `
  --model-dir models/gate-0b/extracted/x-asr/<model-directory> `
  --wav models/gate-0b/corpus/zh-en-code-switch.wav `
  --runs 5 `
  --chunk-ms 40 `
  --output models/gate-0b/runs/streaming.json
```

边缘 code-switch case 还以 `--chunk-ms 20` 重跑。旧 Zipformer archive 若 metadata 识别为 `zipformer`，追加 `--model-type zipformer`。官方 CLI RTF 仍是 Gate 选择级 RTF 的来源；N-API benchmark 负责首 partial 和 production binding 可加载性，不代表 Electron worker 集成。

注意：

- `models/gate-0b/` 在当前机器存在且被忽略，包含模型、WAV 和原始日志。
- 当前语料主要是 Windows SAPI，不等于多人、远场、噪声会议集。
- Gate 0B 只验证 CLI/N-API 模型表现，不代表 Electron worker、VAD、背压或真实音频链路通过。
- SenseVoice 当前候选必须替换；新候选需用同一基准给出正向 CER/WER delta。
- `gate-0b-results.json` 是受测试约束的判定摘要，目前没有单一脚本可完整重新生成它。

## 7. Gate 0C：系统音频拓扑通过

- 初次拓扑提交：`3370a81`
- 当前说明：[`docs/validation/gate-0c.md`](validation/gate-0c.md)
- I2 绑定的精确预检：[`docs/validation/i2-live-v5/gate-0c-preflight.json`](validation/i2-live-v5/gate-0c-preflight.json)，SHA-256 `0f9f7668751c64fbce922883421ead41680226126800e0b7f6b3da81b39840ef`，run ID `gate-0c-2026-07-31T09-52-00-521Z`，执行时间 `2026-07-31T09:52:13.999Z`

批准项：

- Windows 11 23H2 / Electron 43.2.0 上批准 `hidden-audio-host`。
- hidden host 使用专用非持久化 session、`show:false`、`backgroundThrottling:false`。
- 主进程用 `executeJavaScript(code, true)` 触发，display handler 实际记录 `userGesture:true`。
- 用 `desktopCapturer.getSources()` 选择屏幕 source，回环使用 `audio:'loopback'`。
- AudioWorklet 把原生 48k 流式降采样为 16kHz mono，输出 1600 samples/100ms 帧。
- 系统回环、标签启发式 `physical-preferred` mic candidate、`physical-speaker-preferred` 输出和 VB-Cable 确定性 audioinput 探针通过。
- 三路无 sequence gap、时间戳回退、削波、溢出和大跳变；`rawAudioPersisted=false`。
- 当前 runner 只作内存分析。旧 2026-07-26 evidence 曾暂存短音频，只保留作历史审计，不能作为当前模板。
- I2 语音 WAV 由受跟踪 generator/reference 本地生成并被 Git 忽略；报告绑定 WAV/reference digest。

不要误读 Gate 0C：

- 它仍是 [`scripts/gate-0c/`](../scripts/gate-0c/) 下的独立 spike，不是产品 B2。
- `physical-preferred` 只是标签分类，不是硬件证明，也不能排除未知或伪造标签的虚拟设备；精确 Gate SHA 与匿名 label hash 只防预检后静默换标签。
- 尚未验证签名打包版、长时 soak、拖动、真实 pause/refine、热插拔、睡眠/唤醒、硬崩溃和 I2 性能门槛（当前 loopback/mic P95 分别超线 158ms/5ms）。
- 不能把 `loopback` 改成会静音用户输出的 `loopbackWithMute`。
- Electron 43 request 没有 `request.video`；必须显式选择 desktop source。
- 工具条 trusted-click fallback 没有测试。若未来 hidden host 回归，必须重新实测；工具条应持有 stream/Worklet 并只传 PCM，不能假定 `MediaStreamTrack` 可跨 renderer 转移。

## 8. Gate 0D：首启双预设

提交：`7e98dbe`

当前产品决定：

- 新安装和旧配置迁移后，在用户选择前：`mic=false`、`loopback=false`。
- 「会议字幕」：`loopback=true`、`mic=false`。
- 「个人听写」：`mic=true`、`loopback=false`。
- 用户之后可以在 idle 状态修改来源。
- 任何旧版、损坏或内部不一致的 onboarding 配置均 fail closed，要求重新选择。

配置实现：[`src/main/services/config-store.js`](../src/main/services/config-store.js)

`ConfigStore` 当前保存：schema/onboarding、字号、字幕/工具条透明度、自定义底色、圆角、字幕窗宽高、主题、双语、行数、mic/loopback 和 latency。它使用白名单校验、迁移和临时文件 + rename 原子替换。

不要只在设置页加字段。新增配置项必须同步：

1. `DEFAULT_CONFIG`
2. 字段校验和 migration
3. 只有确需 renderer 写入的非敏感字段才加入 `RENDERER_CONFIG_KEYS`；main-owned/敏感字段必须明确排除
4. 判断它是否属于 active session 禁止变更的 capture 配置
5. 为允许与拒绝路径补 tests

当前还有一处 effective-config 缺口：`latency` 是持久化 UI 配置，但 B1 adapter 的 profile 实际直接取 `LIVE_SUBTITLE_DEV_MODEL` override。B2 必须由后端发布校验后的 `effectiveRuntimeConfig`，不能让 UI latency 和实际模型各自解释、看起来已生效却彼此无关。

## 9. UI 现状：V1–V2 已提交

UI 提交：`2c17319`、`2b6303f`、`af6109f`、`7a902c5`。

已完成：

- [`src/ui/shared/tokens.css`](../src/ui/shared/tokens.css) 是三窗 design token 单一真相。
- [`src/ui/shared/runtime-view.js`](../src/ui/shared/runtime-view.js) 将 `RuntimeSnapshot` 映射为 8 个 phase 的纯视图模型。
- [`src/ui/shared/caption-reducer.js`](../src/ui/shared/caption-reducer.js) 负责 CaptionEvent 去旧和全卡行数预算。
- caption 使用 previous/current/translation 稳定 DOM，不再每个 partial 全量重建。
- toolbar 覆盖 unavailable/idle/starting/listening/paused/stopping/recovering/error；主动作由 capabilities 决定。
- toolbar 在常态缩窄并融入背景，attention 状态才展示说明和出口。
- caption 窗可拖边缩放到 480–1600 × 140–420 DIP，并持久化尺寸。
- 深浅色、forced-colors、`:focus-visible`、reduced motion 均有基线。
- fixture 预览在 [`src/ui/preview/`](../src/ui/preview/)。

[`src/ui/shared/fixtures.generated.js`](../src/ui/shared/fixtures.generated.js) 是生成物，不要手改。契约 fixture 改动后运行：

```powershell
npm run preview:fixtures
```

共同评审文件：

- `src/caption/caption.js`：只消费 `CaptionEvent`，不能直接接 sherpa 原始对象。
- `src/toolbar/toolbar.js`：只发用户意图，必须等待 `CommandResult`，不能乐观更新。
- `src/settings/settings.js`：按 `Capabilities` 显示实际能力，配置更新必须等待主进程回执。

## 10. B1 应用骨架

提交：`23588dd`、`339d334`

### 10.1 组合根与最小权限 IPC

[`src/main.js`](../src/main.js) 当前负责：

- caption / toolbar / settings 三窗创建、停靠、拖动、缩放、锁定和穿透。
- ConfigStore、SessionCoordinator 和 FakeRuntimeAdapter 组合。
- 按窗口 role、WebContents 和 main frame 检查 IPC sender。
- 拒绝导航和新窗口。
- 把 snapshot 广播给 toolbar/settings，把 CaptionEvent 广播给 caption。

共享 `src/preload.js` 已删除，当前为：

- [`src/preload/caption.js`](../src/preload/caption.js)
- [`src/preload/toolbar.js`](../src/preload/toolbar.js)
- [`src/preload/settings.js`](../src/preload/settings.js)
- [`src/preload/shared.js`](../src/preload/shared.js)

通道名集中在 [`src/main/ipc/channels.js`](../src/main/ipc/channels.js)，角色授权矩阵在 [`src/main/ipc/access-policy.js`](../src/main/ipc/access-policy.js)。renderer 不得拼接任意 channel 或得到通用 `send/invoke/on`。

关键授权：

- 只有 toolbar 能发 runtime command 和切换锁定。
- 只有 settings 能更新配置或选择 preset。
- caption 无 runtime command/config write 权限；可以读取配置与锁定状态、订阅相应广播、接收 CaptionEvent，并使用自身窗口操作。
- runtime snapshot 读取/订阅给 toolbar/settings。
- 所有 inbound IPC 同时检查窗口 role 和 main frame。

### 10.2 SessionCoordinator

实现：[`src/main/session/session-coordinator.js`](../src/main/session/session-coordinator.js)

公开行为：

- `getSnapshot()` / `onSnapshot(listener)`
- `onCaption(listener)`
- `updateConfiguration(configuration)`
- `command('start'|'pause'|'resume'|'stop'|'retry')`
- `dispose()`

当前保障：

- 权威 phase 和递增 snapshot revision。
- start/pause/resume/stop/retry 的合法状态与 `CommandResult`。
- onboarding、来源和 Gate 0B 能力共同决定 Capabilities。
- 冲突命令返回 `COMMAND_BUSY`。
- adapter transition 默认 5 秒 timeout；超时/失败进入结构化 error。
- Abort、dispose、迟到完成、adapter quarantine 与 replacement adapter 防竞态。
- start resolve 前到达的 captions 先缓冲，进入 listening 后再发布。
- 校验 session/source/sequence/segment/revision，拒绝旧或串线事件。
- listener 抛错不阻断其他 listener 或状态迁移。
- active session 中拒绝修改 capture 配置。

### 10.3 FakeRuntimeAdapter

实现：[`src/main/session/fake-runtime-adapter.js`](../src/main/session/fake-runtime-adapter.js)

- B1-only，不是 ASR。
- 只有显式 dev model override 时 coordinator 才允许 start。
- 以打字机方式生成 contract-valid partial/final/translated。
- pause 会把正在生成的 partial flush 为 final。
- stop/dispose 清理 timer。
- 只使用 `sourceIds[0]`，不能模拟 mic/loopback 双路并发。
- 不生成 refined。
- 为展示 reducer 会生成 translated，但 coordinator 当前仍发布 `canTranslate=false`；这不是翻译能力已实现。
- B2 的真实 runtime adapter 应遵守同一生命周期和 CaptionEvent 输出接口。

## 11. 当前验证

交接时重新运行：

```powershell
npm test
```

结果：**57 tests，57 pass，0 fail**。

按区域：

- 10 项 contract/fixture
- 10 项 Gate 0B metrics/evidence
- 7 项 Gate 0C resampler/WAV/evidence
- 7 项 Gate 0D/ConfigStore/runtime option
- 3 项 IPC access policy
- 20 项 SessionCoordinator/fake adapter lifecycle

当前自动测试尚未覆盖：caption bootstrap/reload、replacement adapter 恢复后的首条字幕、caption reducer/runtime-view 的独立单测、DOM/ARIA、真实 Electron IPC sender/main-frame、preload 暴露面、BrowserWindow 生命周期，以及可复现的 Electron smoke 脚本。PLAN 记录的 default/dev smoke 是人工验证，不是仓库内可重跑的自动证据。

> 状态更新（B2.0）：恢复算法层——水合+重放收敛、replacement adapter 首条字幕、迟到修订的窗口一致性、pending flush/丢弃与 pause/error/stop 保留语义——已由 `test/main/caption-recovery.test.js`、`test/ui/caption-reducer.test.js`、`test/contracts/caption-state.test.js` 覆盖。`src/caption/caption.js` 的订阅→水合接线本身仍无 DOM/Electron harness（订阅先于 getCaptionState 的顺序约束只由注释和人工 smoke 保护），DOM/ARIA、真实 Electron IPC sender、preload 暴露面与自动 smoke 亦未覆盖。

常用命令：

```powershell
# 默认：Gate 0B fail closed，应用处于 unavailable
npm start

# 仅测试 B1 状态流；仍然是 fake adapter
$env:LIVE_SUBTITLE_DEV_MODEL='x-asr-480ms'
npm start

# I2.1 结构模式：真实采集窗 + realtime worker（null recognizer，零字幕）
# 状态机/背压/恢复全真；仍需 DEV_MODEL 才能 start，Gate 0B 姿态不变
$env:LIVE_SUBTITLE_DEV_MODEL='x-asr-480ms'
$env:LIVE_SUBTITLE_DEV_RUNTIME='structural'
npm start

# 重新生成 UI fixture bundle
npm run preview:fixtures
```

不要仅因为 dev smoke 能出现字幕就宣称 ASR 可用；这些字幕来自 fake adapter。

## 12. 明确未完成与已知缺口

### 12.1 B2 还不存在（B2.1 已部分关闭）

> 状态更新（模型轨，2026-07-27）：`sherpa-onnx-node`/`sherpa-onnx-win-x64` 已装为依赖；`src/runtime/realtime-worker/sherpa-recognizer.js` 实现真实 recognizer adapter 并经 worker configure 注册（共享 OnlineRecognizer、per-segment stream、0.4s 尾静音冲刷）；`src/main/services/model-resolver.js` 解析本机模型（缺失 fail closed）；`src/main.js` 组合根默认接真实链路（模型就位 → 发布 fast profile → 真字幕）。实机 smoke `scripts/i2-live-caption-smoke.js` PASS：语料外放 → 回环 → 6 partial + 4 final，拼接 CER 0.071。下文「recognizer adapter 只有 null」等描述作为交接时历史保留。
>
> 状态更新（VAD 轨，2026-07-27）：silero VAD 已替换 EnergyVad 占位——`silero-vad.js` 同接口包装、经 configure 的 vad 选项注入，997Hz 纯音拒识实测通过；收句静音实测定为 1.0s（0.5s 切段时流式模型缺右上下文丢字且不出标点，1.0s 下整句成段 CER 0）；VAD 模型缺失回退 EnergyVad 并警告。silero 后的 smoke：1 条整句定稿、CER 0（energy 对比：4 条碎片、CER 0.071）。EnergyVad 保留用于结构测试与降级路径。
>
> 状态更新（B3.2 refine worker，2026-07-27）：二遍精修已落地——`src/runtime/refine-worker/`（独立 utility process 载离线 X-ASR，纯文本服务）；realtime worker 保持 CaptionEvent 唯一序号权威（段定稿→整段音频经 worker↔worker 端口→文本回来→base+1 revision 发 refined）；请求方有界队列（>3 跳过）、配置失败/退出只降级、暂停缓冲 resume 后补发；coordinator 依 `runtimeOptions.refinementAvailable` 发布 canRefine。实机 smoke：final 无标点 → refined 全标点、双 CER 0。

> 状态更新（B2.1）：`src/runtime/audio-host/` 已存在——Gate 0C 拓扑的产品化控制器、专用 preload/非持久化 session、AudioWorklet 48k→16k、有界诊断采集与指标（`scripts/audio-host-smoke.js` 实机 PASS：静音与 997Hz 信号两种情形，宿主全程隐藏、0 gap）。
>
> 状态更新（B2.2）：`MessageChannelMain` PCM 直通已落地——host → port → `pcm-sink` utility process，credit 背压（ready 握手）、`FrameFlow` 有界队列与丢帧/缺口指标、`replacePort` 中途换消费端（`scripts/pcm-transport-smoke.js` 三模式实机 PASS）。帧用结构化克隆：renderer→MessagePortMain 桥会丢弃带 ArrayBuffer transferable 的消息（PLAN §4.2 修正）。以下仍成立：

> 状态更新（B2.3）：realtime worker 骨架已落地（`src/runtime/realtime-worker/`）——per-source VAD 分段、可替换 recognizer adapter（默认 `null`，不产文本）、B2.2 credit 协议接线、`RealtimeWorkerHost` 主进程宿主；worker 事件经真实 `SessionCoordinator.acceptCaption` 门的集成测试通过。

- recognizer adapter 只有 `null`：没有真实模型、没有 silero VAD（EnergyVad 是占位），模型轨通过基准后经 `registerRecognizerAdapter` 注册。
- audio host / realtime worker 尚未接入 SessionCoordinator（I2 接线）。
- `sherpa-onnx-node` 未作为项目依赖安装。
- Gate 0C spike 的 PASS 不能替代 I2 Live Caption。

### 12.2 Caption renderer reload 恢复不完整（已于 B2.0 关闭）

> 状态更新：coordinator 现在在广播出口折叠 canonical `CaptionState`，caption 角色独占 `runtime:get-caption-state`；renderer 采用订阅-水合-重放 bootstrap。见 `src/contracts/caption-state.js` 与 `test/main/caption-recovery.test.js`。以下为交接时的原始描述。

toolbar/settings 可以重新读取完整 RuntimeSnapshot；caption 当前只有 `onCaption(cb)`，没有 `getCaptionState()` 或原子 subscribe+current-state。renderer 在会话中途重载时，可能在下一条事件到来前为空，也无法恢复已经定稿但不再更新的段落。

B2/I2 必须增加 canonical caption state 读取或原子订阅快照，不能依赖“刚好又广播一次”。

### 12.3 Adapter replacement 后 Caption 游标会失配（已于 B2.0 关闭）

> 状态更新：start context 现携带恢复游标 `resume: { attempt, sourceSequences }`；replacement adapter 以 attempt 为 segment 命名空间、sequence 从游标续增，回归测试覆盖 pause/start 两类超时后的字幕续流。
>
> I2.1 追加：本症状曾经由 fault-retry 新路径短暂回归——同 adapter（attempt 不变）每次 start fork 全新 worker，本地 ordinal 命名会跨代冲突。关闭方式：worker 的 segmentId 改用【开段时的续增 sequence】构造（`seg[-a{attempt}]-{sourceId}-{seq}`），跨代天然唯一；回归测试断言 gen2 事件全被接受且 gen1 定稿段不可回改。以下为交接时的原始描述。

当前 timeout/retry 路径可以隔离旧 adapter 并创建 replacement adapter，但恢复同一 `sessionId` 时存在字幕游标缺口：

- coordinator 保留旧 `sourceSequences / segmentRevisions / segmentSources`。
- 新 `FakeRuntimeAdapter` 从 `sequence=1`、`segment-0` 重新开始。
- replacement runtime 可以回到 `listening`，但后续 CaptionEvent 会因旧 sequence/revision 被静默拒绝。
- 现有测试验证了 replacement runtime 状态，没有验证 replacement 之后还能持续收到字幕。

B2 前必须补回归测试，并明确 recovery cursor contract：保持同一 session 时，要么把 source/segment 游标传给 replacement adapter，要么由 coordinator 统一分配 canonical sequence/segment id；不能简单清空去重 map 后让旧事件重新混入。

### 12.4 运行时故障与可观测性仍不完整（onError 已于 I2.1 关闭）

> 状态更新（I2.1，2026-07-27）：adapter 接口新增可选 `onError`——coordinator 在 listening/paused 时接受 adapter 自报故障进入可重试 error（busy 迁移与已隔离 adapter 的迟到故障被忽略，字段白名单清洗）。`RealtimeRuntimeAdapter` 把 worker 退出 / track-ended / host-gone 映射为结构化故障；实机 smoke 验证了 worker 击杀 → error → retry → listening 的完整恢复。worker 边界的非法 caption 丢弃已计数（`droppedCaptionCount`）。coordinator `acceptCaption` 的 malformed/stale 静默丢弃仍无计数/日志（下一条仍有效）。

- ~~当前 adapter 只有命令方法和 `onCaption`，没有正式的 `onError/onExit/onHealth`。B2 worker 在会话进行中自行崩溃时，尚无主动让 coordinator 进入 recovering/error 的入口。~~（已关闭，见上）
- malformed/stale CaptionEvent 当前只返回 `false` 并静默丢弃，没有拒绝原因日志、计数或指标；B2 排查 sequence/revision 问题会很困难。
- （B3.2 追加）`canRefine` 是启动时判定：精修模型就位即发布为真，refine worker 中途退出只降级（console 告警 + 无 refined 事件），capability 不回写。运行时能力观测（capability 随 worker 健康态更新）是后续议题。
- toolbar 对失败 `CommandResult` 当前主要显示 `message`；如果失败没有同步带来新 snapshot，其中的 `code/recoverable/nextAction` 可能没有形成可执行出口。
- fake adapter 会发 translated，而 capability 仍是 false；它只用于 reducer 展示，测试和文档必须避免把它写成真实翻译能力。

### 12.5 A4 layout contract 未关闭

`caption.css` 的 `.tb-hole` 仍硬编码约 `584 × 64px`；主进程工具条窗口和停靠尺寸由 `src/main.js` 决定。目标是增加主进程只读 `onOverlap(cb)`，下发字幕窗 CSS px 的实际 overlap rect。

窗口几何仍是双重真相：`src/main.js` 拥有 `MARGIN/TB_MARGIN/INSET/CAP_*/TB_*`，CSS token 只镜像部分数值。改工具条尺寸、margin 或停靠位置时必须同时由 UI 和 shell 评审。

### 12.6 已画出或计划中的未完成入口

- toolbar 已有禁用的 history 按钮，但没有可聚焦历史窗、JSONL 读取、搜索或 export UI。
- `open-model-manager` / `request-permission` 是 RuntimeSnapshot nextAction 可表达的入口；toolbar 当前会把未支持 action 显示为禁用，实际页面/流程不存在。
- settings 有 latency/profile 展示，但没有真正的 model install/select 资源管理能力。
- bilingual toggle 是本地显示偏好，当前始终可用；它不是翻译 capability，也不表示云端翻译已接入。
- summary/provider/凭据配置 UI 尚不存在。

对已经渲染但未支持的入口继续显示禁用态和明确原因；尚不存在的 UI 跟随后端阶段设计，不要先造假成功路径。

### 12.7 UI 对后端的静默约束

- `nextAction` 保持四值闭集：`retry / open-settings / open-model-manager / request-permission`。
- `limitations[].message` 必须是可直接显示的完整句子。
- `lastError.message` 和 limitation 文案应短；工具条内联区约 160px。
- 契约和 Coordinator 要求同一 `segmentId` 的 revision 严格递增，Coordinator 会拒绝旧/相等 revision。caption reducer 仅作防御性兼容：相同 revision 但更大 sequence 仍可更新；真实后端不得依赖这个宽松行为，否则事件可能在到达 renderer 前已被 Coordinator 丢弃。
- `sources[].label` 会原样进入 UI；它表示音频来源，不是真实 diarization 身份。

### 12.8 尚待产品拍板

- 是否接受首启累计约 400MB 模型下载。当前建议：先下载约 170MB realtime 模型，约 230MB refinement 做可选增强。
- Gate 0B 下一候选/优化方案尚未确定。
- 会议预设当前只开系统音频；是否在首启同时询问“也录自己的麦克风”可在后续 UX 决定，但不能重新引入隐藏默认值。

## 13. 推荐 Claude 的下一阶段：B2

建议拆成可独立评审和提交的步骤：

### B2.0 先关闭 B1 恢复缺口

- 定义主进程权威、可校验的 canonical CaptionState；明确 stop/new session/paused/error 时字幕保留或清空语义。
- coordinator 保存当前 session 的有序 segment state，而不只 fan-out 广播。
- 增加 caption-only 的 `getCaptionState()` 或原子 subscribe+state，覆盖 listening/paused/error mid-session reload、late translation、双 source 和 bootstrap 期间新事件。
- 为 timeout/retry replacement adapter 定义 sequence/segment cursor handoff，保证恢复后字幕继续流动。
- 补端到端回归测试：reload 后恢复当前字幕；replacement adapter 后首个新 CaptionEvent 被接受并到达 subscriber；stop/new session 正确清理；caption 角色独占读取权限。
- 不要用“重发一条假事件”掩盖状态恢复问题。

### B2.1 产品化 audio host

- 从 Gate 0C 提取经过验证的 hidden host 拓扑到 `src/runtime/audio-host/`。
- 新增专用 audio-host preload 和非持久化 session。
- 保留严格 origin/frame/WebContents 权限边界。
- 获取 loopback 必须请求 video 后立即停止 video track；确保 audio track 仍 live。
- 麦克风关闭 echo cancellation/noise suppression/auto gain。
- AudioWorklet 输出 16k mono Float32、1600 samples/100ms，附 source/session/sequence/monotonic timestamp。
- 先实现可验证的 PCM dump 和指标，不要一上来把音频、模型、VAD、存储一起耦合。

### B2.2 PCM 直通与背压

- 主进程创建 `MessageChannelMain`，一端给 audio host，一端转移给 utility process。
- PCM 不经过主进程复制/转发；主进程只收低频控制和指标。
- 每个 source 有明确的最大队列毫秒数、丢帧策略、sequence gap 和 dropped-frame 指标。
- 测试消费慢于实时、worker crash、port replacement、track ended、pause/stop/dispose。

### B2.3 realtime worker 骨架

- 每个 `sourceId` 独立 stream/VAD/recognizer 状态。
- 在 Gate 0B 没有批准模型时，worker 可以完成 frame/VAD/queue 结构测试，但不能发布生产可用 profile。
- 模型适配器必须可以替换，不能把 renderer 或 SessionCoordinator 绑死到 sherpa 文件名。
- 真正 partial/final 继续走 `SessionCoordinator.acceptCaption()` 路径。

### B2.4 模型验证并行轨

> 状态更新（M2，2026-07-26）：本地两候选的参数扫描完成（`docs/validation/gate-0b-m2-sweep.md`），失败被证实为架构/算力性不可达（480ms 首 partial 的 980ms 音频下限；160ms RTF 最优 0.47），调参路线诚实封闭。残余选项（有意识重设门槛 / nemotron-3.5 453MB 实测 / 等上游）待产品拍板。精修候选切换到离线 X-ASR int8（131MB，M3）。

- 优先查找/优化能真正过原门槛的候选。
- 继续使用同一 corpus、RTF、first-partial、内容和标点标准全量复测。
- 不准用 dev override 代替模型批准。
- 替换 SenseVoice 后扩展多人、远场、噪声和真实口音语料。

### B2.5 I2 验收

只有以下闭环和性能/交互/恢复门禁全部成立才能标记 I2 PASS；当前由 schema-v5 child、schema-v1 exact-child-exit sidecar 与 schema-v6 series 组成的退出绑定重复运行证据不等于整体关闭：

```text
真实 mic/loopback
  → AudioWorklet 16k frames
  → MessagePort
  → realtime worker/VAD/recognizer
  → contract-valid partial/final
  → SessionCoordinator
  → caption renderer
```

至少报告 P50/P95 延迟、RTF、CPU、内存、queue duration、dropped frames，并验证拖动/缩放不掉帧。

## 14. 安全、隐私与仓库卫生

必须保持：

- `contextIsolation:true`、`nodeIntegration:false`；preload 只暴露固定函数。
- IPC 验证 sender role、main frame、payload 和当前状态。
- UI 不读模型路径、会话文件、API Key，不直接调用网络或 Node。
- API Key 后续必须经 `safeStorage`，永不进入 config/snapshot/renderer/log。
- 模型下载必须固定 manifest/SHA256，`.part` + staging + 验证 + 原子安装。
- 测试语料只跟踪 generator/reference；生成 WAV 必须位于被忽略目录且不得提交。现场采集的 ASR 原始音频不得持久化，即使目录已被忽略也不例外。
- `models/`、`.artifacts/`、`node_modules/`、`.claude/settings.local.json` 已在 `.gitignore`。

2026-07-26 隐私决策前的 Gate 0C 报告曾用忽略目录中的短音频核对多路独立性；该行为只属历史审计，不是当前产品或 runner 的允许输出。当前 diagnostic、smoke 与 Gate 0C runner 均只生成内存指标和结构化报告，不创建现场音频。Gate 0B/I2 的语音 WAV 也不是受跟踪资产：它由受跟踪 generator/reference 本地生成并被忽略，报告只绑定生成 WAV 与 reference digest。

## 15. 每个大功能的交付清单

Claude 完成一个大功能时必须：

1. 明确本次修改范围和不修改范围。
2. 保持工作树中其他人的改动不被覆盖。
3. 添加自动测试和必要的实机证据。
4. 运行相关专项测试与完整 `npm test`。
5. 让独立 subagent/reviewer 对最终 diff 做只读审查。
6. 修复 reviewer 指出的 blocker 后重新验证；修改了实质逻辑则重新复审。
7. 对 tracked diff 跑 `git diff --check`；新 untracked 文件要用 `git diff --no-index --check -- NUL <file>` 或等价检查，确认没有 whitespace 问题和敏感信息泄露。
8. 只暂存本功能文件，检查 `git diff --cached --name-only`，再跑 `git diff --cached --check`。
9. 更新 PLAN/README/相关设计文档中的状态与限制，不把 spike 写成产品 PASS。
10. 单独 commit；不要把 unrelated 文件顺手带入。

## 16. 最容易犯的错误

- 从 `master` 开始，丢掉 Gate 0D/B1。
- 看到 UI full fixture 就发布真实 profile。
- 用 `LIVE_SUBTITLE_DEV_MODEL` 宣称模型过 Gate。
- 把 Gate 0C spike 当成已经接入产品。
- 让高频 PCM 经过主进程。
- 把 realtime 与 offline refinement 放进同一个同步 worker。
- 依赖 recognizer trailing-silence endpoint，却停止给它静音帧。
- renderer 先更新视觉状态，再等 CommandResult。
- 复用 segment revision，导致 UI 静默丢字幕。
- 只改 CSS 尺寸，不更新 BrowserWindow/停靠/命中 contract。
- 把系统音频 source 当成真实说话人 diarization。
- 提交 `models/`、`.artifacts/`、API Key 或本机绝对路径。

如果下一条任务没有另行指定，默认先完成 **B2.0 关闭 B1 恢复缺口**；复审通过后再进入 B2.1 hidden audio host 产品化。
