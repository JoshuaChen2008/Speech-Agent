# Live Subtitle Agent · 运行后端与契约

> 状态：Rev.1 · 2026-07-25  
> 目的：定义 Electron 壳层、音频/ASR runtime、存储和 AI 的责任；视觉/UI 只消费本文对外发布的契约。

## 1. 架构目标

- 高频 PCM 不经过主进程。
- CPU 密集推理不在主进程或可见 renderer 中执行。
- 主进程拥有应用状态，但不成为音频、ASR 或 DOM 实现的一部分。
- 字幕、历史、导出和翻译使用同一份规范化 segment 状态。
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
- 把 canonical events 交给 TranscriptStore、AiGateway 和可见 UI。
- 监听 worker `exit`、track ended、权限错误和设备变化。

### 2.2 运行后端

`audio-host`：

- 通过 Web Media API 获取麦克风和系统音频。
- AudioWorklet 重采样为 16kHz mono Float32。
- 每帧附带 `sessionId/sourceId/sequence/monotonicTimestamp/sampleCount`。
- 通过 transferable MessagePort 把 PCM 直接发送给 realtime worker。
- 汇报 source state、队列指标和 track ended，不负责 UI。

`realtime-asr-worker`：

- 每个 source 独立 OnlineRecognizer/VAD/stream。
- 维护有界 PCM 队列和分段 buffer。
- 产生 partial/final CaptionEvent。
- v1 以 VAD speech-end 为主要分段依据，recognizer endpoint 只处理超长句兜底。
- 不加载 SenseVoice，不执行网络或 DOM 工作。

`refine-worker`：

- 只加载 SenseVoice OfflineRecognizer。
- 输入 `{sessionId, segmentId, sourceId, audio, baseRevision}`。
- 返回 refined CaptionEvent；必须比 baseRevision 大。
- 队列有最大长度、最大等待时间和降级策略，不能反压实时 worker。

`TranscriptStore`：

- 写 Windows-safe 文件名的 append-only JSONL 事件日志。
- 处理坏尾行、flush、session close 和导出。
- 按 `segmentId + revision` 折叠，不覆盖历史文件中的旧事件。

`ModelManager`：

- 维护模型 manifest、Capabilities、下载/暂停/续传/校验状态。
- 下载到 `.part`，解压到 staging，验证期望文件后原子安装。
- 拒绝删除活跃模型，清理失败 staging 和过期 part。
- 只向 UI 发布产品级 profile 和下载状态，不暴露模型路径。

`CredentialStore / AiGateway`：

- API Key 经 `safeStorage` 独立保存，永不进入 config、snapshot 或 renderer。
- v1 只承诺 OpenAI-compatible chat completions adapter。
- 翻译按 `segmentId + revision + targetLanguage` 去重和保序。
- 有界队列、取消、超时、重试和错误分类；AI 失败不改变本地 ASR 状态。

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
    services/transcript-store.js
    services/model-manager.js
    services/ai-gateway.js
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

- start 只有在模型、至少一个音频源和 worker 能力满足时才可接受。
- `starting/stopping/recovering` 拒绝冲突命令。
- pause 必须定义为暂停采集还是只暂停推理；v1 建议暂停向 recognizer 送帧并 flush 当前 segment，保留 session。
- stop 只有在 tracks 停止、队列处理/丢弃策略执行、JSONL flush 后才进入 idle。
- 每次迁移发布完整 RuntimeSnapshot，而不是只广播一个布尔值。

## 5. 数据路径

### 5.1 高频路径

```text
audio-host AudioWorklet
  └─ PCM frame + source/seq/time
      └─ transferable MessagePort
          └─ realtime-asr-worker
```

主进程不复制 PCM。每个 source 队列必须有最大毫秒数；超过阈值时按明确策略丢弃最旧帧或进入 error，不能无限积压。

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
          ├─ TranscriptStore
          ├─ AiGateway
          └─ caption/history/settings subscribers
```

文本先走主进程以保持单一状态权威。只有性能 trace 证明该路径成为瓶颈时，才考虑 caption 直连 port。

## 6. 契约规则

- 所有消息带 `schemaVersion`。
- session、source、segment 标识不可复用。
- `sequence` 表示来源事件顺序，`revision` 表示同一 segment 内容版本。
- 时间轴使用从 session start 起算的单调时间；墙钟只存 session metadata。
- 未识别字段可以忽略，缺少必需字段必须拒绝并记录。
- renderer 不能收到原始 Error、Electron event、API Key、模型路径或 Node 对象。
- 初次订阅使用“先建立订阅，再请求完整快照”或原子 subscribe+snapshot，避免 get/on 竞态。

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
- realtime worker 崩溃：停止送帧或进入有界暂存，清理旧 stream 后重新建 port。
- refine worker 崩溃：实时字幕继续；未完成 segment 标记 refinement unavailable，可稍后重试。
- 可见 renderer 重载：读取完整 snapshot 和当前 caption state，不依赖历史广播。
- 系统睡眠/唤醒：重建 media tracks，校正单调时间基准并记录 session gap。
- 退出：停止接收命令 → 停 tracks → 处理/放弃队列 → flush JSONL → kill workers → 关闭窗口。

## 9. 安全要求

- `contextIsolation: true`、`nodeIntegration: false` 和严格 CSP 保持不变。
- 每个 preload 只包装固定函数，不暴露通用 `send/invoke/on`。
- IPC 同时验证 sender 身份、payload schema 和当前状态。
- 导航和新窗口默认拒绝；本地 UI 不加载远程脚本。
- API Key 不进日志、错误消息、config、fixture 或 renderer。
- 模型下载必须有固定 manifest/SHA256；解压到 staging 并验证期望文件。

## 10. 后端验收顺序

1. contract fixtures 和 reducer/state-machine 测试。
2. audio dump、时间戳和背压指标。
3. 单路 realtime ASR，再开双路。
4. SessionCoordinator 与可见 UI 接 fake/real CaptionEvent。
5. 独立 refine worker 和事件式 JSONL。
6. ModelManager、AiGateway、首启和打包。
7. 两小时、设备拔插、worker crash、睡眠唤醒和干净机器验收。
