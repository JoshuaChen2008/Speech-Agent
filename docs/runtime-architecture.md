# Live Subtitle + Agent · 运行后端与契约

> 状态：Rev.4 · 2026-07-31
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

- 四个可见窗口（字幕、工具条、设置、历史）与隐藏 audio host 的创建、销毁和恢复。
- 字幕/工具条停靠、拖动、穿透、多显示器和 DPI。
- 分别追踪 visible windows 与 runtime windows；不使用 `BrowserWindow.getAllWindows().length` 判断是否应重建 UI。
- 工具条是带稳定标题和 AppUserModelID 的持续主任务栏窗口；字幕覆盖窗不占任务栏。主窗口原生事件、renderer 按钮与第二实例统一进入应用级最小化/恢复控制器，恢复最小化前的可见窗口集合、bounds 和焦点层级而不改变会话。
- 设置与字幕历史关闭只销毁对应辅助窗口；Windows 关闭主任务栏窗口或工具条“退出”统一请求应用退出屏障，屏障失败时保留可从任务栏恢复的主窗口。
- 关闭、睡眠唤醒和退出时协调 session flush 与 worker 清理。

产品的普通 `npm start` 由 exact-child supervisor 启动 Electron。主进程只向 supervisor
发送固定枚举的生命周期与角色级故障分类；supervisor 在 main 即使 native 退出后仍能
原子写完最后一次 evidence。该通道不接收或保存 PID、命令行、正文、音频/PCM、本地路径、
stack、dump 或任意 Error 文本，也不配置 WER/Crashpad 或外部上传。

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
- SEM-F21 同源两阶段识别：同一 `mic` 或 `loopback` 的 VAD 后样本在 worker 内扇出到临时字幕识别器与权威识别器；前者仅提供 `partial`，后者独占首次 `final`。权威识别器出现非空结果后永久接管当前段的后续 `partial`，两者不得建立第二次采集或改变来源互斥。
- v1 以 VAD speech-end 为主要分段依据，recognizer endpoint 只处理超长句兜底。
- 不加载 SenseVoice，不执行网络或 DOM 工作。
- B2.3 现状：`worker-core.js` 纯逻辑管线（帧→VAD→adapter→contract-valid 事件，段前缓冲防句首截断）；recognizer 经 `recognizer-adapter.js` 注册表解析（默认 `null`，只验证结构不产文本）；`realtime-worker.js` 沿用 B2.2 credit 协议；`worker-host.js` 在主进程边界做契约校验后路由 caption/stats/exit。
- 模型轨现状（2026-07-27，Gate 0B 改判后）：`sherpa-recognizer.js` 实现真实 adapter——OnlineRecognizer 按 modelDir+numThreads 模块级共享（encoder 只载入一次），stream per-segment，endSegment 喂 0.4s 静音尾 + `inputFinished` 冲刷 lookahead 后废弃 stream；configure 携带 recognizer 选项时先同步载入模型再回 `configured`（宿主 configure 超时对真实模型放宽到 30s），null profile 不 require 原生模块。主进程 `model-resolver.js` 解析已批准模型（env → userData → 仓库开发布局，四件套缺一即 null → fail closed）。
- VAD 现状（2026-08-03）：`silero-vad.js` 以 EnergyVad 同接口包装 sherpa 的 silero 检测器，经 worker configure 的 vad 选项注入（与 recognizer 同闸门：null profile 绝不携带，结构 worker 不加载任何原生模块）；`isDetected` 翻转映射 speech-start/end。起点滞后由固定四帧（4×100ms）段前缓冲补偿，段前缓冲的 voiced 判定用极低能量门限（0.004）且静音清空，防止上一句尾音串段；recognizer provisional stream 独立限于十二帧（12×100ms），Silero 在上限内确认时复用预热 stream，达到上限仍未确认时丢弃并停止预热，后续新候选可重新建立 stream，确认前不产生字幕段或临时字幕。Silero threshold `0.5`、minSpeechDuration `0.25`、minSilenceDuration `1.0` 与 I2 冻结起点不因该优化改变。模型供应链：`silero_vad.onnx`，643,854 bytes，SHA256 `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6`，来源 `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx`（忽略目录 `models/vad/`，不入库）。**收句静音 1.0s 是实测决定**：0.5s 切段时流式模型缺右上下文——丢字（「一下」→「一」）且短段几乎不出标点；1.0s 桥接词间停顿后整句成段、受控语料 CER 0（代价：定稿出现在停顿 1s 后，partial 不受影响）。边界披露：超过 1.0s 的句中停顿仍会切段，仍可能触发短段丢字模式；桥接证据来自词间停顿 0.7–0.9s 的 SAPI 受控语料，真实语音的停顿分布留待语料扩展复核（gate 记录中的既有义务）。997Hz 纯音拒识实测通过（能量占位会误报）。VAD 模型缺失时回退 `EnergyVad` 并在控制台警告——字幕仍真实，但分段降级（对音量敏感、纯音误报）。超长段仍由包装层强制收束兜底（30s）。

`refine-worker`（B3.2 已落地：`src/runtime/refine-worker/`）：

- 只加载改判批准的离线 X-ASR OfflineRecognizer（t=3，M3 同配置；SenseVoice 已被改判替换）。
- 纯文本服务：经主进程建立的 worker↔worker MessagePort 收 `{requestId, sampleCount, samples}`，同步解码后回 `{requestId, text}`——CaptionEvent 的组装与 sequence/revision 分配都留在 realtime worker（单一序号权威，精修晚到不会与实时流打架）。
- 有界队列在请求方（realtime worker）：在途精修 >3 即跳过（段保持 final），绝不反压实时。
- configure 失败或中途退出只降级精修、不故障字幕会话；realtime worker 发结构化故障，Coordinator 拒绝该世代的后续 `refined`，恢复仍可见首次稳定转写并让后续段继续走原始字幕。
- 暂停期到达的精修结果在 worker 内缓冲，resume ack 之后补发（paused 相位的 caption 会被 coordinator 拒收）。
- 停止路径的取舍（有意为之并披露）：end 收束的段不再发起精修（响应必然晚于收尾，保持 final 并计入 skipped）；更早的在途精修若在 end 处理后返回也被作废。会话最末的少量段可能只有第一遍定稿。
- 是否启动精修由“精修模型 ready + 会话开始时冻结的全局精修偏好”共同决定；活动会话内修改偏好只影响未来会话。worker 运行故障不改写全局偏好，本会话也不自动重启或补跑。

> J15c 故障边界已实现并达到确定性联合验收完成：中途失败不删除此前已持久化的精修稿，也不在同会话自动重启或补跑。故障确认时，caption 投影丢弃该 worker 世代的后续精修输入，把所有仍可见的已定稿段恢复为各自首次稳定转写并在相同固定视口内重新排版；当前 `partial` 原样保留，已淘汰段不复活，后续段继续显示首次稳定转写。MVP 运行中不提示、不变色、不 resize；正常停止后工具条在既有 bounds 内显示不抢焦点的会话状态通知和“查看历史”，通知只报告处理状态、不概括或改写字幕内容，关闭/进入历史/下一会话会清除，应用重启不重放。五值稳定故障事实在确认时独立持久化并与权威 `N/M` 一起复读，二者不能互相推断。结构化本地 JSONL 只含稳定错误码、阶段、会话内相对时点和无正文计数，按 5×1 MiB/7 天滚动且不自动上传。真实 packaged Electron 已覆盖故障静默期、main→IPC→toolbar 会话状态通知、历史跳转与重启不重放；真实模型故障仍归 I2/I4。

`transcript-store` 兼容工具（B3.1 遗留格式的只读边界）：

- 只从调用方提供的不可变 JSONL 字节快照解析旧事件，供一次性迁移与迁移摘要核对；生产 JSONL writer 已删除。
- 处理坏尾行，保留旧事件折叠与 txt/md/srt 兼容格式化；新会话只写 SQLite。
- 按 `segmentId + revision` 折叠，不覆盖历史文件中的旧事件。

`StorageGateway / storage-worker / HistoryService`（B3.3、J15b/J15c 文本结果已达到确定性联合验收完成；I3 非音频预资格通过，真实两小时声源与 I4 待验）：

- storage worker 是 SQLite 唯一所有者和写者；主进程与 renderer 不执行同步 SQL、不加载扩展。
- 在同一短事务中追加字幕 `final/refined` 事实并更新当前 segment 投影；提供只列终态会话的稳定 keyset 分页、按会话/时间戳读取详情和 txt/md/srt 当前正文导出。
- `starting` 必须先等 session open ACK 才启动采集；final/refined 先同步复制进 Gateway FIFO 再广播 UI；runtime flush 后必须等 caption/close ACK 才从 `stopping` 进入 idle。
- Gateway 每代只持有一个 utility process；exit、timeout 或坏响应使结果变为 unknown，旧 generation 精确终止并确认退出后，才以同一业务幂等载荷重放队首。业务冲突不靠重启掩盖，队列恢复耗尽则熔断并保留会话。
- Gateway 队列上限是触发停采集的高水位，不是丢字幕边界：越线的首条字幕写入受保护溢出槽，终态 close 另有独立的有界容量；Coordinator 只显示已被持久化边界接纳的事件，停釆集边界内迟到字幕先缓冲。若用户在 storage error 时选择 stop，必须先排空字幕 backlog、持久化边界缓冲，然后才能提交 close；`adapter.stop()` 返回是终止字幕 ingress 栅栏，该调用内冲刷出的 final/refined 仍接受，返回后的退役 generation 事件明确拒绝。全部 ACK 前禁止恢复采集或进入 idle。
- ADR 0008 已冻结 Agent 可靠消费为终态会话 durable reconciliation；它只从已提交字幕水位补建缺失任务，不向字幕事实事务加入 Agent outbox。
- FTS5 可按历史搜索需求后加；`sqlite-vec` 明确 Deferred，不进入 B3.3 schema 或加载路径。
- 默认组合根已以 SQLite 替代 JSONL 权威写入；冷启动先收束 stale-active、再迁移旧档，运行期不构造 JSONL writer。JSONL 只保留为旧数据导入、显式格式兼容和恢复格式，禁止长期双写。
- 历史 renderer 只得到白名单终态会话列表、固定上限的 keyset 详情页和格式选择能力；每次只持有当前 50 条并通过 cursor 栈前后翻页。详情/列表契约以有界元数据返回整个会话的 `segmentCount` 与 `refinedSegmentCount`：前者统计全部已持久化首次 `final`，后者统计已有独立精修稿，`partial` 不进入任一值。覆盖数由 storage/main 对权威行聚合，renderer 不从当前页估算。完整 transcript 只在 main/storage worker 内供导出与迁移；SQL、数据库路径、文件系统和导出目标路径均不跨 IPC。205 段确定性多模块旅程与真实 packaged Electron 均证明五页交互、DOM 上界 50、会话级版本选择和完整导出。两小时数千段资源稳定性 I3 与干净机 I4 仍须单独验收。
- 列表/详情返回有界的会话级精修结果：`refinementResultStatus` 只允许 `known/not_recorded`；`known` 携带会话冻结的 `refinementEnabled` 与可空、五值枚举的 `refinementFaultCode`。既有会话与旧 JSONL 导入使用 `not_recorded`，不从 `N/M` 推断故障。故障一经确认就持久化，关闭会话或最终覆盖达到 `N=M` 都不清除；`N<M` 也不自动生成故障。正常停止后的工具条会话状态通知和重启后的历史详情消费同一后端事实。

> J15b/J15c 历史导出边界已达到确定性联合验收完成：切换不同会话重置为原始版，同一会话翻页保留选择；`N = 0` 时禁用精修查看/导出，`0 < N < M` 时使用 `refined-incomplete`，txt/md 文件头写整场覆盖提示，txt/md 行首与 srt cue 正文统一使用 `[原始版回退]`，原始版导出名称和正文 digest 保持不变。真实 packaged Electron 已执行会话 A 精修版跨页/导出，再切换会话 B 自动回原始版/导出。
- schema、表义、迁移与 DB0–DB6 门禁见 [`data-architecture.md`](data-architecture.md)、[ADR 0001](adr/0001-sqlite-authoritative-event-store.md) 和 [ADR 0002](adr/0002-separate-subtitle-and-agent-systems.md)。

`ModelManager`：

- 内置不可由 renderer 修改的固定 manifest，并把资源分为核心实时 ASR+VAD 与独立可选精修两组；每个资源固定 HTTPS URL、字节数、SHA-256、安装目录和允许运行文件。
- 逐跳校验 HTTPS 下载主机，使用 `.part` + Range 续传并对完整字节流做 SHA-256；重定向、长度或摘要不符时 fail closed。
- 归档固定调用 Windows `System32\tar.exe`（不走可被抢占的 PATH），先审查全部路径和条目类型，只从通过审查的归档提取 `requiredFiles`，因此上游示例 WAV 和非运行材料不会进入 `userData`；随后在同卷 staging 校验普通文件并原子安装。
- 安装态由严格四字段 `.ready.json` 与期望文件共同证明；核心 ready 只依赖实时 ASR 与 VAD，精修 ready 独立发布。空闲 Coordinator 可在核心安装完成后原子替换运行时而无需重启。
- 提供核心下载、精修独立下载、取消与显式继续；取消保留合法 `.part`，初始化或网络恢复不自动续传。退出先 abort/kill 并等待，5 秒仍不收束则 fail closed 放行应用退出，下次初始化清理残留 staging，避免卡死 `before-quit`。
- UI 只得到结构化资源状态、字节进度和安全错误码，不得到 URL、SHA、模型路径、归档参数或底层 Error。

> 三资源原子 bundle 已被 J15c 实现替代。精修模型缺失时点开关保持关闭且 fetch=0；明确下载完成后仍关闭，用户再次明确开启才影响未来会话。活动会话中禁止模型安装，但允许修改全局偏好且不改变本会话冻结值。全局偏好跨重启前复核精修 ready，缺失/损坏时把持久与有效开关回落关闭并通知；重新下载后仍不自动开启。真实 packaged 双启动已验证核心/精修分离、下载中取消、连接关闭、合法 `.part` 保留、复启 fetch=0、明确 Range 继续、安装后仍关闭、再次开启以及会话冻结。

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

2026-07-31 的 I2 exit-bound bundle 以共享的未来播放 `source t0` 加冻结的 140ms 语料 onset offset，到 `SessionCoordinator` 接受并通知观察者的同一首个 partial，作为冻结字幕可见延迟。播放器、audio host 与 utility 先完成时钟校准，再先 arm 同一 `source t0`、后 schedule 播放，避免准备 IPC 偷吃 onset 预算；captured-energy 诊断另从 `source t0 + 40ms` 固定 guard 后观察，但不移动冻结起点。loopback 5 轮 P50/P95/min/max=1133/1158/1092/1158ms；`physical-preferred-label-heuristic` mic 声学 fixture=875/1005/822/1005ms；final-after-stimulus-end P95 分别 710/792ms。10 轮最大 final/refined CER 为 loopback 0/0、mic 0.035714/0，captured/sent/ingested 帧全等，12 项丢失峰值全为 0。两来源分别超过未改变的 `<1000ms` 线 158ms/5ms，因此 I2 integration 性能债与整体门禁未关闭。每个 schema-v5 child 还以 NTP 式最小 RTT 校准把同一 exact accepted partial 拆为六段非负整数诊断区间；P95 依次为 loopback=729/405/1/33/1/1ms、mic=557/500/1/28/1/1ms。该 trace 精确望远镜到冻结值，但不改变验收起点、终点或门槛。该 mic 分类只按标签启发式并绑定 SHA-256 为 `0f9f7668751c64fbce922883421ead41680226126800e0b7f6b3da81b39840ef`、runId 为 `gate-0c-2026-07-31T09-52-00-521Z`、执行时间为 `2026-07-31T09:52:13.999Z` 的精确 Gate 0C 预检及同一匿名标签，不能视为硬件证明或排除未知/伪造标签的虚拟设备。generator/reference 受跟踪，生成 WAV 被忽略；报告绑定两者摘要。完整 bundle 见 [`validation/i2-live-v5/`](validation/i2-live-v5/) 与 [`validation/i2-real-source-series.md`](validation/i2-real-source-series.md)。

2026-08-03 的 4×100ms / 12×100ms provisional 优化后，revision `b96b8fe7db5ba4db3ac36c4ee85371a4381b521f` 的五轮 `loopback` 仍为 P95=1242ms。逐轮 `audioNeededAfterCapturedOnsetMs` 为 712.625–776.562ms；仅在保持最慢轮已观察到的 437.438ms 采集/VAD 前置与 28ms 触发后组合时，模型必须在低于 534.562ms 的音频需求内产生首个临时字幕才可能达线。Gate 0B 同一 `zh-en-code-switch` 语料的当前模型裸测观测最大音频需求为 660ms、P95=697.4775ms。该比较不是物理下限证明，也不排除另行登记捕获拓扑改造；基于当前观测，已决定停止本轮 `x-asr-160ms` 参数微调并重新开启 Gate 0B 实时模型替换评估。尚未选定替代模型，也不改变冻结起点、门槛或报告口径。

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
- `asrPreferences`：产品级 profile、语言/分段偏好，以及只在新会话开始时冻结的权威识别策略、非敏感识别 provider ID 和确认关键词范围选择。
- `refinementPreferences`：一个不区分 `mic`/`loopback`、决定未来新会话是否启用精修的全局偏好；可持久化，但启动时必须以精修模型就绪证明校正。会话开始时复制到不可变的 session context；修改或关闭不能改变活动会话，也不能删除旧会话精修稿。运行中 worker 故障只写该会话的结果，不回写全局偏好；只有应用启动时发现模型缺失或损坏才把持久偏好与有效值一起明确回落为关闭。
- `aiPreferences`：Agent 总开关、`automaticProcessingSince`、个人记忆全局开关、`memoryProcessingSince`、目标语言和 Agent 模型 provider 非敏感信息；两个开关与各自时间边界由主进程 `ConfigStore` 原子持久化，不得复用或覆盖识别 provider 配置。
- `effectiveRuntimeConfig`：后端根据 Capabilities 校验后的实际值，只读发布给 UI。

外观 slider 可在 renderer 即时预览，但磁盘写入需防抖。所有持久化采用白名单、版本号、迁移和 staging/rename；禁止任意 `config:set(patch)` 直接 merge 未知字段。

## 8. 生命周期与恢复

- audio host 崩溃：关闭旧 port，RuntimeSnapshot → recovering，按上限重建；不能无提示无限重试权限请求。
- realtime worker 崩溃：停止送帧或进入有界暂存，清理旧 stream 后重新建 port。I2.1 落地：`RealtimeRuntimeAdapter` 把 worker 退出/track-ended/host-gone 经 adapter `onError` 上报，coordinator 进入可重试 error，retry 走 stop+start 重建全链路（fresh host+worker）。
- refine worker 崩溃：实时字幕继续；立即把仍可见的已定稿段恢复为首次稳定转写，当前 `partial` 不变；本会话不重启、不补跑，故障事实立即持久化，正常停止后通过工具条会话状态通知显式报告。模型仍 ready 且全局偏好仍开启时，只允许下一新会话重新尝试启动一次。若应用在正常停止前异常退出，重启后该会话进入中断状态，不重放旧的工具条会话状态通知；历史仍显示已持久化故障与最终可计算的覆盖。
- realtime/refine worker 的正常停止通过窄 `shutdown` 消息释放端口、timer、recognizer/VAD 引用，再由宿主等待该 exact child 的 `exit`。当前期限固定为 **30 秒 graceful window + 5 秒 exact-child force/reap window**；强制终止后仍必须等同一 child 的退出确认。无法确认退出时 adapter 永久失效且 Coordinator 不允许 replacement 开始，避免两代 sherpa/ONNX native runtime 重叠。
- 字幕应用运行时以 **45 秒**作为优雅收束结束/升级触发线，用于容纳 worker 的两阶段收束、字幕 flush 与 storage shutdown；ModelManager 的 **5 秒**收束与它并行。触线后进入 termination，但仍必须等待 exact child 收殓，因此 45 秒不是硬退出上限。迟到的原始 shutdown 会加入同一 termination promise，不得再次 flush/关闭或启动第二条退出路径。
- 所有 UtilityProcess 都必须注册 `error` listener；fatal 诊断只发布固定角色和类型，不保存 Electron/V8 report、location、本地路径、stack、字幕或 PCM。`serviceName` 用于主进程的角色级 `child-process-gone` 归因，不把原始 details 透给 renderer；可见 renderer 与隐藏 audio host 由各自 WebContents role 归因。
- 可见 renderer 重载：读取完整 snapshot 和当前 caption state，不依赖历史广播。
- 应用级最小化：立即收尾拖动/拉伸，隐藏字幕并最小化当时可见的设置/字幕历史；采集、会话、互斥音频来源、持久化和 RuntimeSnapshot 继续运行。任务栏恢复、辅助窗口恢复或第二实例只恢复原窗口集合与层级，不创建新会话。
- 系统睡眠/唤醒：挂起时发布 `SYSTEM_SUSPEND` 并释放 media tracks；唤醒后只校正单调时间基准并保留 session gap，不自动重新采集。用户明确 Retry 后才沿同一会话/cursor 重建 audio host、worker 与 media tracks。实际设备轨道结束同理发布 `AUDIO_TRACK_ENDED`、先释放 capture、等待设备恢复与明确 Retry。
- 退出：停止接收命令 → 停 tracks → 处理/放弃实时队列 → 提交/报告字幕事务 → 有界 checkpoint → graceful shutdown workers → 必要时只终止并收殓 exact child → 关闭窗口。Agent 未完成任务按 A1 的可靠消费协议保留，不能无限阻塞退出；禁止按进程名批量结束 Electron。
- 主任务栏窗口的原生关闭在退出屏障释放前始终 `preventDefault`；收束异常允许以同一主入口重试，不能先销毁入口再留下 taskbarless 后台进程。屏障确认完成后才允许 Electron 关闭窗口并让 exact-child supervisor 自然返回。

2026-07-31 的真实模型活跃诊断已用批准 bundle 连续三轮驱动 online stream、Silero VAD
和 offline refine，六个 realtime/refine 子进程均优雅 `exitCode=0`、fatal 0。随后 I2
exit-bound 权威 bundle 让 loopback/mic 各 5 轮完整通过采集、online ASR 与 offline refine：
10 轮均有 final/refined，loopback 最大 final/refined CER=0/0、mic=0.035714/0，所有 captured/sent/ingested 帧一致且 12 项丢失峰值全为 0。每个 schema-v5 child report 都有独立 schema-v1 sidecar，记录外部 runner 已观察到其 exact Electron child 返回 exit code 0 且 runner 未终止它；每来源的五组 report/sidecar 再被 schema-v6 series 严格绑定。这样可阻止应用内部先写 `pass`、随后悬挂或超时仍被计绿，但 sidecar 不是签名、远端背书、硬件证明或崩溃根因证明。

受监督多窗口产品壳也得到 clean exit、0 incident、未观察到 breakpoint。一次未纳入权威 bundle 的运行曾在报告 `pass` stdout 后悬挂；因此本批外部退出证明不等于悬挂已永久排除。`PostQueuedCompletionStatus(6)` 失败进入 Node/libuv `uv_fatal_error`、`DebugBreak` 的即时 `0x80000003` 机制已有闭环解释，但缺少 native stack，仍不能确定具体竞态、发送者或进程角色；相容的上游 IOCP/`uv_async_send` 修复也不是本次根因证明。冻结语料诊断、I2 exit-bound bundle 和 fake-ASR 产品壳只证明各自边界；它们不证明 loopback 性能门槛、拖动、真实 pause/refine、设备变化/睡眠/硬崩溃、两小时 I3、干净机 I4 或历史异常的具体根因。

## 9. 安全要求

- `contextIsolation: true`、`nodeIntegration: false` 和严格 CSP 保持不变。
- 每个 preload 只包装固定函数，不暴露通用 `send/invoke/on`。
- IPC 同时验证 sender 身份、payload schema 和当前状态。
- 导航和新窗口默认拒绝；本地 UI 不加载远程脚本。
- API Key 不进日志、错误消息、config、fixture 或 renderer。
- 现场采集 PCM 不进入数据库、文件、日志、诊断产物、导出或 Agent 上下文；smoke 只输出指标。
- 精修故障日志使用本地滚动 JSONL，最多 5 个文件、每个 1 MiB、最长保留 7 天，任一上限先到即清理；不自动上传。字段禁止字幕正文、现场音频、路径、原始 Error/stack。手动诊断导出入口后置，不阻断当前 MVP。
- 模型下载必须有固定 manifest/SHA256；归档先做路径/类型审查且只提取运行白名单，随后在 staging 验证期望文件并写严格 ready marker。
- 临时字幕识别器与权威识别器只共享同一份有界内存样本；临时字幕文本不得进入 SQLite、导出、报告或日志，段结束、故障和停止都必须释放两套 stream。

## 10. 后端验收顺序

每一步都必须同时具有局部测试和跨模块用户旅程；只有单元测试时只能标记“实现完成·尚未验收”。完整测试分层与场景矩阵见 [`testing-strategy.md`](testing-strategy.md)。

1. contract fixtures 和 reducer/state-machine 测试，并由联合 CI 验证同一事件在 coordinator、renderer 与存储之间一致。
2. 内存音频指标、时间戳和背压指标；禁止 dump 现场采集音频。
3. 完成 `loopback` 会议字幕与 `mic` 个人听写两种单路路径；配置、UI 和 runtime 都拒绝双路并发，停止后才允许换源。
4. SessionCoordinator 与可见 UI 接 fake/real CaptionEvent，同时验证 reload、自动存档、时间戳历史与导出。
5. 独立 refine worker 和事件式 JSONL 过渡基线，验证 pause/resume、迟到修订和进程故障。
6. B3.3 已在 DB0/DB1 基座上接入产品网关、迁移、默认 SQLite-only 生命周期与历史查询/导出；J1/J2/J10 及开发态/packaged 四窗口 Electron/SQLite 旅程已有证据，I3/I4 继续作为独立门禁。
7. B4/J15c ModelManager、资源页与空闲热启用已实现核心 ASR+VAD 和独立可选精修两组资源；全局偏好默认关闭、按会话冻结，缺失精修不阻止核心字幕。
8. B5 已从当前源码重建正式 x64 ASAR/NSIS，并把 package layout、native/SQLite utility、packaged 首启与同一 `userData` 离线复启、两次 exact-child clean exit、J15b 跨会话版本选择、J15c 故障回退/工具条会话状态通知、旧 JSONL 幂等迁移、三格式完整导出和隔离 NSIS 安装/卸载绑定到安装器 SHA `d862c5fc…0de10`。同一 run ID、四份报告 SHA 与 114 文件产品载荷 SHA `a1f03ed6…9accc` 由独立 binding 报告闭合并写入 release layout；卸载后与应用无关的隔离 APPDATA 哨兵仍存在且 SHA 不变。正式应用未在 NSIS 机械探针中启动，候选未签名，且 packaged 旅程是测试 variant，不冒充精确 NSIS 安装后的干净机 I4。
9. I3 非音频预资格已以 3,600 段/4,000 事件、虚拟两小时、SQLite 重开恢复、72 页有界 DOM 与三格式全量导出通过；真实两小时声源仍随音频测试延期。I4 非音频专用机 runner 已把同一精确安装器的公网首下、系统保存弹窗、正式 userData 卸载保留和离线重装写成严格 `pass/partial` 门禁，但尚无干净 Win11 报告；交互权限、真实来源与 I2 性能/交互/恢复缺口继续归音频测试。
10. 字幕 MVP 通过后做 A1：先登记并实现识别 provider 抽象、`AgentRuntime` + Pi Core 隔离探针、项目自有插件宿主、凭据与可靠消费；再以第一方插件实现独立增强文本、会后结构化纪要和个人记忆，并通过 J3–J7/J13/J20/J21。
11. 受控 Tool Calling 与默认隐藏的调试聊天在核心 job/产物/记忆链路之后接入，并通过 J22；它不能成为字幕或会后自动任务的前置条件。
12. 只有 X1 明确进入范围时才增加 FTS5/`sqlite-vec`，并执行 J11/DB4。

## 11. Provider、个人记忆与专用子 Agent 运行时（A1/A2 设计）

### 11.1 权威识别路由

```text
单路 AudioHost + 有界 PCM
└─ RecognitionSessionRouter（会话策略冻结）
   ├─ 纯本地权威识别
   │  └─ SEM-F21 本地两阶段链路
   └─ 云端主力识别与本地降级
      ├─ CloudRecognitionAdapter ──▶ partial / 唯一 first final
      └─ LocalRecognitionAdapter（ready，正常期间不解码）
         └─ 仅在明确故障后接收有界 PCM 并单向接管
```

- `RecognitionSessionRouter` 只消费会话开始时冻结的策略、provider 能力、确认关键词集合版本和本地模型就绪证明；renderer 不能直接选择 adapter 或传 provider URL。
- `RecognitionProviderRegistry` 只注册随产品发布的第一方适配器。所有适配器把流式结果归一为同一 Caption Event/会话身份语义，并以能力描述声明关键词、取消、连接存活检测和事件有序性；业务层不得按具体云服务名称分支。
- 云端适配器必须声明并通过流式 `partial`、权威 `final`、取消、连接存活检测和有序事件能力探针。关键词提示是可选 capability；不支持时仍可识别，但必须向设置与会话诊断暴露“确认关键词未应用”。
- 云端正常期间，本地两阶段识别链路不得持续解码。可以预载或保持资源句柄就绪，但不能用“兜底”名义继续消耗完整本地推理预算。
- 当前段的 PCM 环形缓冲只覆盖明确、固定的最大时长。明确断开、稳定 provider 错误或连接存活检测失败时，router 原子关闭云端 generation、冻结故障边界，再把该缓冲交给新的本地 generation；旧 generation 的迟到事件必须按 generation、sequence 和 segment 身份拒绝。
- 已经持久化的云端首次稳定转写不可重开或替换；当前尚未产生首次 `final` 的段可以由本地链路重新形成唯一 `final`。降级后同一会话不自动切回云端。
- 普通响应变慢、瞬时抖动或单次心跳延后只能形成指标，不能触发降级。连接存活阈值必须宽松、可测试，并与冻结字幕可见延迟指标分开。

### 11.2 Agent 模型 provider、处理资格与资源仲裁

- Agent 总开关首次默认关闭。用户开启时，主进程持久化新的 `automaticProcessingSince`；自动对账不得静默处理该时间边界之前结束的会话，更早会话只能由用户从历史明确请求。Agent 总开关与个人记忆每次从不生效转为同时生效时另存新的 `memoryProcessingSince`；自动记忆任务不得补处理该边界之前、尤其是个人记忆关闭期间的会话。
- `AgentEligibilityEvaluator` 只返回 `ready/no_committed_transcript/outside_automatic_window/agent_disabled/provider_not_configured/cloud_disclosure_required/credential_unavailable/local_model_not_ready/session_not_terminal`。判定固定遵循正式接口合同的顺序；`outside_automatic_window` 只适用于自动请求，用户请求忽略时间边界但不绕过其它条件。只有 `ready` 能创建或领取后台 Agent 任务；其余结果不调用 Agent 模型 provider，并向设置或历史提供稳定的下一动作。
- `ModelGateway` 冻结每个后台 Agent 任务的 Agent 模型 provider、模型、recipe 版本、超时、取消和用量边界；识别 provider 不经过该网关，也不与其共享配置。
- `AgentModelProviderRegistry` 与识别 registry 分离，只向 `ModelGateway` 暴露受控生成、结构化输出、用量、超时和取消能力。Stage 0 隔离 Agent 内核开发入口只接通 OpenAI-compatible 云端参考实现和确定性测试 Agent 模型 provider，本地 Agent 模型 provider 只冻结接口；正式 Agent 产品切片再补本地实现。新增 Agent 模型 provider 不得扩张插件工具权限。
- 本地 Agent 推理是字幕系统的低优先级工作：有活动字幕会话时不启动；若运行期间新会话开始，任务收到取消信号并保持可重试状态，待无活动会话时重新执行。
- 云端 Agent 请求可以在新字幕会话期间继续，因为它不持续占用本地模型推理资源；其 renderer 更新、SQLite 回写和日志仍必须有界，不能抢占字幕事件 FIFO 或长时间持有事务。
- Agent 模型 provider 不可用、凭据失效、限流、超时或 worker 退出只改变后台 Agent 任务与调试聊天的 Agent 能力状态。字幕会话、SQLite 字幕事实、历史和导出保持独立。

### 11.3 后台 Agent 任务与专用子 Agent

> 当前实现投影（2026-08-10）：D3 的正式 v3 migration、Agent 处理资格、自动对账与任务生命周期，以及 D4 的冻结输入读取、已装载任务闭集、正式纪要插件/宿主、确定性分块归并、`ModelGateway` + Pi Agent Loop、job runner 和原子产物提交，均为实现完成·尚未验收。D4 组合直接使用真实 `StorageWorkerService` + SQLite，尚未经过 `StorageWorkerHost` utility-process transport；`MeetingStopped`、preload/IPC、renderer、其余两项任务、资源仲裁与正式打包仍为已决定。

```text
终态会话 + 完整输入水位
└─ AgentEligibilityEvaluator（处理资格闭集）
   └─ ready + 自动处理时间边界内
      └─ AgentJobReconciler
         ├─ meeting-minutes job ──▶ 固定 recipe Agent Loop ──▶ agent_artifacts
         ├─ memory-extraction job ─▶ 固定 recipe Agent Loop ──▶ 记忆候选
         └─ enhanced-transcript job ▶ 固定 recipe Agent Loop ──▶ agent_artifacts

调试聊天
└─ 固定业务工具 ──▶ 执行预览/用户确认 ──▶ 同一 job registry
   └─ 一层专用子 Agent ──▶ Schema 候选 ──▶ Host 校验/提交
```

- 三项后台 Agent 任务逻辑独立，不串联结果；Agent 模型 provider 内部将多个请求做成本优化时也不得改变任务各自的输入、状态、重试和产物契约。
- `AgentJobReconciler` 只以 Agent 处理资格为 `ready`、处于 Agent 自动处理时间边界内的终态会话和缺失 dedupe key 为事实来源，负责停止后尽力建任务，并在启动、worker replacement 或 Agent 模型 provider 恢复时补建；记忆任务还必须处于个人记忆自动处理边界内。它不参与字幕事件事务。零条首次稳定转写返回 `no_committed_transcript`，不创建任务；精修覆盖不完整的混合显示正文不形成合法 `refined` Agent 输入。
- 三项任务冻结同一 `sessionId + inputWatermark + transcriptVersion + digest`。`AgentInputPlanner` 优先按字幕段边界确定性分块；超预算单段按 Unicode code point 范围完整分片，全部分块和归并成功后才允许提交，失败或恢复期间不暴露部分产物。
- 同一会话、同一任务类型同时只运行一个自动任务；全局并发再受 Agent 模型 provider 与本机资源预算限制。取消、超时和应用退出只终止当前 run，SQLite 中的待办仍可恢复。
- 调试聊天没有通用 `spawn_subagent`。工具名称直接表达业务意图；读取工具可直接运行，写入或产生云端费用的工具先返回执行预览，取得用户确认后才建 job。
- 用户从历史主动请求时仍必须是终态会话、当前输入身份且 Agent 处理资格为 `ready`；该路径可以处理自动时间边界之前的会话，但不能绕过总开关、Agent 模型 provider 配置、云端披露、凭据或本地模型就绪要求。
- 专用子 Agent 只接收固定任务说明、选中的 `sessionId + inputWatermark + transcriptVersion + digest`、所需范围内的个人记忆及 Agent 模型 provider 配置，不继承调试聊天历史，不得继续委派。
- 子 Agent 只返回结构化候选；`beforeToolCall` 等 Pi hook 可用于循环内阻断和观察，但最终的权限、并发、Schema 校验、写入与审计始终由 `AgentPluginHost` 执行。

### 11.4 隔离 Agent 内核开发入口（SEM-F29 / J23）

首个实现切片不接入上述 `MeetingStopped` 路径，而使用完全独立的开发应用：

```text
Agent MVP renderer
└─ Agent MVP preload / exact IPC
   └─ AgentRuntimeHost
      ├─ Agent utility process ──▶ Pi Agent Core / ModelGateway
      └─ Agent storage utility process ──▶ 隔离 SQLite
```

该入口不得导入 `src/main.js`、`SessionCoordinator`、audio host、实时/精修 worker 或正式 renderer access policy。它只共享可复用的 contract、SQLite 基础设施和视觉 token；独立 data root 中的合成终态会话必须由真实 storage worker 写入，不能用 renderer 内 fixture 假装已提交事实。Agent utility process 与 storage utility process 分开，插件拿不到 SQLite 句柄；凭据由 Agent 主进程在每个 run 创建时解密后只以内存参数交给 `ModelGateway`。

Agent MVP 全局只运行一个 Agent Loop，后台 Agent 任务 FIFO 排队。应用退出先停止接单，再有界取消当前 Loop、持久化任务状态、关闭 Agent utility process 和 storage utility process。正式字幕系统不观察该入口的启动、退出或故障。
