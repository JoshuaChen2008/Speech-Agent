# Live Subtitle + Agent · 运行后端与契约

> 状态：Rev.3 · 2026-07-30
> 目的：定义可独立运行的字幕系统、后置 Agent 系统及 Electron 壳层的责任；视觉/UI 只消费本文对外发布的契约。
> 功能与验收语义以 [`semantic-contract.md`](semantic-contract.md) 为准；目标数据层见
> [`data-architecture.md`](data-architecture.md)。

## 1. 架构目标

- 高频 PCM 不经过主进程。
- CPU 密集推理不在主进程或可见 renderer 中执行。
- 主进程拥有应用状态，但不成为音频、ASR 或 DOM 实现的一部分。
- 字幕、历史和导出使用同一份规范化 segment 状态；Agent 派生产物保留输入水位且不覆盖它。
- 字幕系统不等待网络、Agent Loop 或向量能力。
- worker、设备或网络失败不会伪装成“仍在录制”。
- 任何 renderer 只得到完成自身职责所需的最小权限。

## 2. 责任划分

### 2.1 Electron 壳层

`WindowManager`：

- 三个可见窗口与隐藏 audio host 的创建、销毁和恢复。
- 字幕/工具条停靠、拖动、穿透、多显示器和 DPI。
- 分别追踪 visible windows 与 runtime windows；不使用 `BrowserWindow.getAllWindows().length` 判断是否应重建 UI。
- 关闭、睡眠唤醒和退出时协调 session flush 与 worker 清理。

`IpcRouter`：

- 按窗口身份验证 sender。
- 对 Command 和 ConfigPatch 做 schema、范围和状态校验。
- 禁止 caption renderer 退出应用、修改运行配置或删除模型。
- 返回结构化 `CommandResult`，不使用 fire-and-forget 表达可能失败的操作。

`SessionCoordinator`：

- 维护权威会话状态机和递增 snapshot revision。
- 启停 audio host、realtime worker 和 refine worker。
- 归并 CaptionEvent，拒绝过期 sequence/revision。
- 在广播出口把已交付事件折叠为 canonical `CaptionState`（B2.0），供 caption renderer reload 水合；折叠与 renderer 共用同一份纯逻辑实现和窗口，视图一致由构造保证。pause/error/stop 保留，新会话第一条广播字幕才清空。
- 把 canonical events 交给持久化网关和可见 UI；Agent 只在字幕提交成功后异步消费，不由 coordinator 直连并等待。
- 监听 worker `exit`、track ended、权限错误和设备变化。

### 2.2 运行后端

`audio-host`（B2.1 已产品化到 `src/runtime/audio-host/`，MessagePort 直通待 B2.2）：

- 通过 Web Media API 获取麦克风和系统音频。
- AudioWorklet 重采样为 16kHz mono Float32。
- 每帧附带 `sessionId/sourceId/sequence/monotonicTimestamp/sampleCount`。
- 通过 transferable MessagePort 把 PCM 直接发送给 realtime worker。
- 汇报 source state、队列指标和 track ended，不负责 UI。
- B2.1 现状：非持久化 session、最小权限 handler、显式屏幕源 + `audio:'loopback'`、专用 preload、有界诊断采集；纯策略在 `policy.js`/`pcm-metrics.js` 有单测，实机验证走 `scripts/audio-host-smoke.js`。诊断 API 拒绝 `dumpDir`，产品 smoke 与当前 Gate 0C runner 只输出结构化指标，不保存现场音频。

`realtime-asr-worker`（B2.3 骨架已落地：`src/runtime/realtime-worker/`）：

- 每个 source 独立 OnlineRecognizer/VAD/stream。
- 维护有界 PCM 队列和分段 buffer。
- 产生 partial/final CaptionEvent。
- v1 以 VAD speech-end 为主要分段依据，recognizer endpoint 只处理超长句兜底。
- 不加载 SenseVoice，不执行网络或 DOM 工作。
- B2.3 现状：`worker-core.js` 纯逻辑管线（帧→VAD→adapter→contract-valid 事件，段前缓冲防句首截断）；recognizer 经 `recognizer-adapter.js` 注册表解析（默认 `null`，只验证结构不产文本）；`realtime-worker.js` 沿用 B2.2 credit 协议；`worker-host.js` 在主进程边界做契约校验后路由 caption/stats/exit。
- 模型轨现状（2026-07-27，Gate 0B 改判后）：`sherpa-recognizer.js` 实现真实 adapter——OnlineRecognizer 按 modelDir+numThreads 模块级共享（encoder 只载入一次），stream per-segment，endSegment 喂 0.4s 静音尾 + `inputFinished` 冲刷 lookahead 后废弃 stream；configure 携带 recognizer 选项时先同步载入模型再回 `configured`（宿主 configure 超时对真实模型放宽到 30s），null profile 不 require 原生模块。主进程 `model-resolver.js` 解析已批准模型（env → userData → 仓库开发布局，四件套缺一即 null → fail closed）。
- VAD 现状（2026-07-27）：`silero-vad.js` 以 EnergyVad 同接口包装 sherpa 的 silero 检测器，经 worker configure 的 vad 选项注入（与 recognizer 同闸门：null profile 绝不携带，结构 worker 不加载任何原生模块）；`isDetected` 翻转映射 speech-start/end，起点滞后由段前缓冲（silero 下放宽到 6 帧）补偿，段前缓冲的 voiced 判定用极低能量门限（0.004）且静音清空，防止上一句尾音串段。模型供应链：`silero_vad.onnx`，643,854 bytes，SHA256 `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6`，来源 `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx`（忽略目录 `models/vad/`，不入库）。**收句静音 1.0s 是实测决定**：0.5s 切段时流式模型缺右上下文——丢字（「一下」→「一」）且短段几乎不出标点；1.0s 桥接词间停顿后整句成段、受控语料 CER 0（代价：定稿出现在停顿 1s 后，partial 不受影响）。边界披露：超过 1.0s 的句中停顿仍会切段，仍可能触发短段丢字模式；桥接证据来自词间停顿 0.7–0.9s 的 SAPI 受控语料，真实语音的停顿分布留待语料扩展复核（gate 记录中的既有义务）。997Hz 纯音拒识实测通过（能量占位会误报）。VAD 模型缺失时回退 `EnergyVad` 并在控制台警告——字幕仍真实，但分段降级（对音量敏感、纯音误报）。超长段仍由包装层强制收束兜底（30s）。

`refine-worker`（B3.2 已落地：`src/runtime/refine-worker/`）：

- 只加载改判批准的离线 X-ASR OfflineRecognizer（t=3，M3 同配置；SenseVoice 已被改判替换）。
- 纯文本服务：经主进程建立的 worker↔worker MessagePort 收 `{requestId, sampleCount, samples}`，同步解码后回 `{requestId, text}`——CaptionEvent 的组装与 sequence/revision 分配都留在 realtime worker（单一序号权威，精修晚到不会与实时流打架）。
- 有界队列在请求方（realtime worker）：在途精修 >3 即跳过（段保持 final），绝不反压实时。
- configure 失败或中途退出只降级（console 告警 + 无 refined），不故障会话；实时字幕不受影响。
- 暂停期到达的精修结果在 worker 内缓冲，resume ack 之后补发（paused 相位的 caption 会被 coordinator 拒收）。
- 停止路径的取舍（有意为之并披露）：end 收束的段不再发起精修（响应必然晚于收尾，保持 final 并计入 skipped）；更早的在途精修若在 end 处理后返回也被作废。会话最末的少量段可能只有第一遍定稿。
- `canRefine` 是启动时判定（精修模型就位即为真）；精修 worker 中途降级不回写 capability——运行时能力观测是后续议题（见 handoff §12.4）。

`TranscriptStore`（B3.1 当前过渡实现）：

- 写 Windows-safe 文件名的 append-only JSONL 事件日志。
- 处理坏尾行、flush、session close 和导出。
- 按 `segmentId + revision` 折叠，不覆盖历史文件中的旧事件。

`StorageGateway / storage-worker`（B3.3 进行中：storage worker 的 DB0/DB1 基座已实现，产品网关与权威切换待完成）：

- storage worker 是 SQLite 唯一所有者和写者；主进程与 renderer 不执行同步 SQL、不加载扩展。
- 在同一短事务中追加字幕 `final/refined` 事实并更新当前 segment 投影；提供按会话和时间戳读取历史的异步 API。
- A1 再冻结 Agent 可靠消费采用事务 outbox 还是 durable cursor；两者都必须以已提交字幕水位为边界。
- FTS5 可按历史搜索需求后加；`sqlite-vec` 明确 Deferred，不进入 B3.3 schema 或加载路径。
- SQLite 迁移验收后替代 JSONL 权威写入；JSONL 只保留为旧数据导入、导出和恢复格式，禁止长期双写。
- schema、表义、迁移与 DB0–DB6 门禁见 [`data-architecture.md`](data-architecture.md)、[ADR 0001](adr/0001-sqlite-authoritative-event-store.md) 和 [ADR 0002](adr/0002-separate-subtitle-and-agent-systems.md)。

`ModelManager`：

- 维护模型 manifest、Capabilities、下载/暂停/续传/校验状态。
- 下载到 `.part`，解压到 staging，验证期望文件后原子安装。
- 拒绝删除活跃模型，清理失败 staging 和过期 part。
- 只向 UI 发布产品级 profile 和下载状态，不暴露模型路径。

`CredentialStore / AgentRuntime / AgentPluginHost`（A1 后置）：

- API Key 经 `safeStorage` 独立保存，永不进入 config、snapshot 或 renderer。
- 用本项目接口包住 Pi Agent Core 或替代实现；项目宿主管理第一方插件、权限、生命周期和故障隔离，不嵌入完整 coding-agent。
- 只读字幕上下文插件从提交边界按水位读取；增强文本和会后结构化纪要由独立内容插件生成并保存，不得启用 shell/进程/任意文件写或外部写操作。
- 有界执行、取消、超时、重试和错误分类；Agent 失败不改变本地 ASR、SQLite 字幕或历史状态。

## 3. 推荐目录方向

这是目标职责图，不要求一次性机械搬完：

```text
src/
  main/
    index.js
    windows/window-manager.js
    ipc/ipc-router.js
    session/session-coordinator.js
    services/config-store.js
    services/credential-store.js
    services/transcript-store.js       # B3.1 JSONL 过渡实现
    services/storage-gateway.js        # B3.3 主进程异步边界
    services/model-manager.js
    services/agent-runtime.js           # A1，Pi 低层 loop 的可替换适配边界
  preload/
    caption.js
    toolbar.js
    settings.js
    audio-host.js
  contracts/
    runtime-snapshot.js
    caption-event.js
    commands.js
    capabilities.js
    fixtures/
  runtime/
    audio-host/
    realtime-asr-worker.js
    refine-worker.js
    storage-worker/                    # SQLite 字幕事实/投影的单写者
    agent-worker/                      # A1，后置
  caption/               # 可见 UI
  toolbar/               # 可见 UI
  settings/              # 可见 UI
```

拆目录的顺序应跟着 B1–B5 工作流，不为了目录好看而提前大搬家。

## 4. 会话状态机

```text
unavailable ──资源就绪──▶ idle
idle ──start──▶ starting ──全部就绪──▶ listening
starting ──失败──▶ error
listening ──pause──▶ paused ──resume──▶ listening
listening/paused ──stop──▶ stopping ──flush 完成──▶ idle
listening ──可恢复故障──▶ recovering ──恢复成功──▶ listening
recovering ──超时/失败──▶ error
error ──retry/reset──▶ starting/idle
```

规则：

- start 只有在模型、恰好一个音频源和 worker 能力满足时才可接受。
- `starting/stopping/recovering` 拒绝冲突命令。
- pause 必须定义为暂停采集还是只暂停推理；v1 建议暂停向 recognizer 送帧并 flush 当前 segment，保留 session。
- stop 只有在 tracks 停止、队列处理/丢弃策略执行、所有字幕事务已提交或明确失败后才进入 idle；不等待 Agent 完成。
- 每次迁移发布完整 RuntimeSnapshot，而不是只广播一个布尔值。

## 5. 数据路径

### 5.1 高频路径

```text
audio-host AudioWorklet
  └─ PCM frame + source/seq/time
      └─ transferable MessagePort
          └─ realtime-asr-worker
```

主进程不复制 PCM（帧不进主进程 JS 事件循环）。每个 source 队列必须有最大毫秒数；超过阈值时按明确策略丢弃最旧帧或进入 error，不能无限积压。

B2.2 落地的流控协议（`src/runtime/audio-host/frame-flow.js` + `src/runtime/pcm-sink/pcm-sink.js`）：

- 生产端在所有 source 注册完毕后于端口上宣告 `{type:'ready', sessionId, sourceIds}`；消费端此刻才逐源授予初始 credit（更早授信会在 source 注册前到达而被丢弃——不能依赖端口队列时序）。同一端口世代内按 `session:source` 去重初始授信；新端口世代重新授信。
- 每发一帧消耗一个 credit；credit 用尽帧进入 `maxQueueMs` 限界队列，超预算丢最旧（保新弃旧，丢帧以 sequence 缺口对消费端可见）。
- 消费端回授消息为 `{type:'credits', sourceId, count, consumed}`：`count` 是新授信，`consumed` 是自上次以来实际消费的帧数（显式确认，供在途损失核算）。帧一经送达即视为消费——字段畸形的帧同样回授 credit（流控不能被坏帧饿死）；未知 `sourceId` 的帧不回授（配置失配应当以流控饥饿显性化）。
- 端口可中途替换（worker 重建，仅限采集已进入 capturing 阶段）：宿主关旧端口、作废旧 credit、把「已发送未确认」帧数计入 `lostInFlightFrames`（上界——发进死端口的帧不产生 sequence 缺口，只能在这里可观测），在新端口重发 ready；队列帧在新消费端授信后继续流动。
- 实测限制：renderer DOM MessagePort → MessagePortMain 桥丢弃带 ArrayBuffer transferable 的消息，帧用结构化克隆发送（≈6.4KB/帧，可忽略）。

必须记录：

- captured frames / samples
- consumed frames / samples
- queue duration
- dropped frames
- partial latency P50/P95
- end-to-end final latency P50/P95

### 5.2 低频控制与文本路径

```text
realtime/refine worker
  └─ CaptionEvent
      └─ SessionCoordinator
          ├─ reducer / revision check
          ├─ partial ───────────────▶ caption subscriber
          ├─ final/refined
          │   └─ StorageGateway ────▶ storage-worker / SQLite
          │                           ├─ segments ─▶ history / export
          │                           └─ committed boundary ─▶ AgentRuntime（后置）
          └─ snapshot subscribers
```

文本先走主进程以保持单一状态权威。只有性能 trace 证明该路径成为瓶颈时，才考虑 caption 直连 port。

## 6. 契约规则

- 所有消息带 `schemaVersion`。
- session、source、segment 标识不可复用。
- `sequence` 表示来源事件顺序，`revision` 表示同一 segment 内容版本。
- 时间轴使用从 session start 起算的单调时间；墙钟只存 session metadata。
- 未识别字段可以忽略，缺少必需字段必须拒绝并记录。
- renderer 不能收到原始 Error、Electron event、API Key、模型路径或 Node 对象。
- 初次订阅使用“先建立订阅，再请求完整快照”或原子 subscribe+snapshot，避免 get/on 竞态。caption renderer 的落地即 `onCaption`（缓冲）→ `getCaptionState()` 水合 → 重放缓冲事件。
- 同会话更换 adapter/worker 时，coordinator 通过 start context 的恢复游标 `resume: { attempt, sourceSequences }` 交接：replacement 必须以 `attempt` 为 segment id 命名空间生成新段，且各 source 的 sequence 严格大于游标值；不得清空去重 map 让旧事件重新混入。

## 7. 配置边界

配置分为：

- `appearancePreferences`：字号、主题、透明度、圆角、双语布局。
- `capturePreferences`：首选音频源和设备。
- `asrPreferences`：产品级 profile、语言/分段偏好。
- `aiPreferences`：是否启用、目标语言、provider 非敏感信息。
- `effectiveRuntimeConfig`：后端根据 Capabilities 校验后的实际值，只读发布给 UI。

外观 slider 可在 renderer 即时预览，但磁盘写入需防抖。所有持久化采用白名单、版本号、迁移和 staging/rename；禁止任意 `config:set(patch)` 直接 merge 未知字段。

## 8. 生命周期与恢复

- audio host 崩溃：关闭旧 port，RuntimeSnapshot → recovering，按上限重建；不能无提示无限重试权限请求。
- realtime worker 崩溃：停止送帧或进入有界暂存，清理旧 stream 后重新建 port。I2.1 落地：`RealtimeRuntimeAdapter` 把 worker 退出/track-ended/host-gone 经 adapter `onError` 上报，coordinator 进入可重试 error，retry 走 stop+start 重建全链路（fresh host+worker）。
- refine worker 崩溃：实时字幕继续；未完成 segment 标记 refinement unavailable，可稍后重试。
- 可见 renderer 重载：读取完整 snapshot 和当前 caption state，不依赖历史广播。
- 系统睡眠/唤醒：重建 media tracks，校正单调时间基准并记录 session gap。
- 退出：停止接收命令 → 停 tracks → 处理/放弃实时队列 → 提交/报告字幕事务 → 有界 checkpoint → kill workers → 关闭窗口。Agent 未完成任务按 A1 的可靠消费协议保留，不能无限阻塞退出。

## 9. 安全要求

- `contextIsolation: true`、`nodeIntegration: false` 和严格 CSP 保持不变。
- 每个 preload 只包装固定函数，不暴露通用 `send/invoke/on`。
- IPC 同时验证 sender 身份、payload schema 和当前状态。
- 导航和新窗口默认拒绝；本地 UI 不加载远程脚本。
- API Key 不进日志、错误消息、config、fixture 或 renderer。
- 现场采集 PCM 不进入数据库、文件、日志、诊断产物、导出或 Agent 上下文；smoke 只输出指标。
- 模型下载必须有固定 manifest/SHA256；解压到 staging 并验证期望文件。

## 10. 后端验收顺序

每一步都必须同时具有局部测试和跨模块用户旅程；只有单元测试时只能标记“实现完成 / 尚未验收”。完整测试分层与场景矩阵见 [`testing-strategy.md`](testing-strategy.md)。

1. contract fixtures 和 reducer/state-machine 测试，并由联合 CI 验证同一事件在 coordinator、renderer 与存储之间一致。
2. 内存音频指标、时间戳和背压指标；禁止 dump 现场采集音频。
3. 完成 `loopback` 会议字幕与 `mic` 个人听写两种单路路径；配置、UI 和 runtime 都拒绝双路并发，停止后才允许换源。
4. SessionCoordinator 与可见 UI 接 fake/real CaptionEvent，同时验证 reload、自动存档、时间戳历史与导出。
5. 独立 refine worker 和事件式 JSONL 过渡基线，验证 pause/resume、迟到修订和进程故障。
6. B3.3 在已通过 DB0/DB1 的 storage worker 与 SQLite 字幕事件/投影基座上，接入产品网关、迁移和历史查询，完成 J10；适用的 J1/J2 切到 SQLite 后端重跑。
7. ModelManager 与字幕 MVP 打包；完成两小时、设备/worker 故障、睡眠唤醒和干净机器验收。
8. 字幕 MVP 通过后做 A1：`AgentRuntime` + Pi Core 隔离探针 + 项目自有插件宿主 + 凭据/可靠消费；再以第一方插件实现独立增强文本和会后结构化纪要，并通过 J3–J7/J13。
9. 只有 X1 明确进入范围时才增加 FTS5/`sqlite-vec`，并执行 J11/DB4。
