# Live Subtitle Agent · Win11 实时字幕技术规划

> **Rev.3 · 2026-07-26**。初版调研 2026-07-23（版本号、模型名、体积经 GitHub Release API / npm registry / 下载解包核实）。
> 本次修订：把视觉/UI、Electron 壳层与运行后端拆成独立工作流；补充跨进程契约、会话状态机、双 worker、事件式 JSONL、权限边界和并行验收路线。视觉设计可交给擅长 UI 的模型独立完成，但不得越过运行契约。

---

## 0. 现状盘点

初版 PLAN 把 UI 排在 ASR 之后；目前 Gate 0A/0C/0D、视觉 V1–V2 和 B1 应用骨架已完成，真实音频/ASR 链路从 B2 开始。

| 已完成（骨架） | 未开始 |
|---|---|
| 三窗架构（字幕 / 工具条 / 设置）、停靠与脱离 | **音频链路**（0 行） |
| 锁定穿透、逐像素命中测试、主进程手动拖动 | **ASR worker**（0 行，`sherpa-onnx-node` 未安装） |
| 配置持久化（`userData/config.json`）+ 三窗实时联动 | 历史面板（`src/toolbar/toolbar.js` 的 `history` 分支仍是 TODO） |
| 亚克力设置窗（显示 / 音频源 / 语音识别 / 关于 四个 pane） | 模型下载与资源管理、AI 层、打包分发 |
| B1 `SessionCoordinator`、状态机、per-window preload 与 contract-valid fake adapter | B2 真实 audio host、ASR worker 与模型接入 |

**当前首要阻塞是 Gate 0B 尚无候选通过原门槛。** 默认 Capabilities 继续保持空 profile；B2 可以先围绕已通过的 Gate 0C 音频拓扑推进，但真实模型只有重新验证通过后才能进入默认路径。

### 0.1 三层职责与协作边界

本项目不按传统 Web 的“页面前端 / HTTP 后端”二分，而采用三层：

| 层 | 所有权 | 可以决定 | 不可以决定 |
|---|---|---|---|
| **视觉/UI 层** | 字幕窗、工具条、设置/历史/首启等可见 renderer | 布局、色彩、字体、动效、组件、文案、无障碍、状态的视觉表达 | 模型文件、IPC 通道、ASR 参数、API Key、存储格式、会话状态迁移 |
| **Electron 壳与应用层** | 主进程、窗口管理、按窗口拆分的 preload、`SessionCoordinator` | 窗口生命周期、系统权限、命令路由、权威运行状态、有效配置 | 音频解码、ASR 推理、视觉细节 |
| **运行后端层** | audio host、ASR workers、模型/会话/AI 服务 | 采集、重采样、推理、精修、持久化、模型资源、云端适配 | DOM、CSS、视觉组件和用户操作布局 |

三层只通过版本化契约协作：

- `RuntimeSnapshot`：当前会话状态、能力、音频源、模型状态和可展示错误。
- `CaptionEvent`：`sessionId / sourceId / segmentId / sequence / revision / kind / t0 / t1 / text / translation`。
- `CommandResult`：用户命令是否成功、失败原因和下一步动作。
- `Capabilities`：当前设备、模型和 provider 实际支持什么；UI 不自行猜测。

视觉模型的完整交接说明见 **[docs/ui-design-brief.md](docs/ui-design-brief.md)**；运行后端边界和协议见 **[docs/runtime-architecture.md](docs/runtime-architecture.md)**。视觉模型可以在约定的 UI 文件内大胆改设计，但不得修改 `main/preload/config/runtime/contracts`，也不得把模型实现细节重新写回 UI。

---

## 1. 结论速览

| 项 | 选型 | 状态 |
|---|---|---|
| ASR 引擎 | **sherpa-onnx v1.13.4**（2026-07-07） | 2026-07-25 复核：仍是 latest |
| 接入方式 | **`sherpa-onnx-node` 1.13.4** + `sherpa-onnx-win-x64` 1.13.4（N-API 预编译） | 复核一致，未安装 |
| 硬件后端 | **CPU**（不上 CUDA） | 定 |
| 一遍流式模型 | **x-asr-480ms-…-zh-en-punct-int8-2026-06-05** | **Gate 0B 未通过：首 partial P95 略高于 1s；尚未批准** |
| 二遍精修模型 | **sense-voice-zh-en-ja-ko-yue-int8-2025-09-09** | **Gate 0B 未通过：受控语料无净收益；尚未批准** |
| VAD | **silero_vad.onnx**（0.6 MB） | 定 |
| 外壳 | **Electron 43.2.0** | 复核：已是 latest，不动 |
| 构建工具链 | **不引入**（vanilla + JSDoc `@ts-check`） | 见 §6.1 |
| 模型解压 | **系统自带 `C:\Windows\System32\tar.exe`** | 已实测：bsdtar 3.7.7 带 bz2lib 1.0.8 |
| 转写存储 | **append-only JSONL 事件日志**（不上 sqlite） | 见 §6.4 |
| AI 接入 | **原生 fetch + 手写 SSE**（不引 SDK） | 见 §6.5 |
| 打包 | **electron-builder 26.15.3 + NSIS** | 见 §6.6 |

---

## 2. 版本与模型

### 2.1 sherpa-onnx 版本

**v1.13.4**（2026-07-07）。三条分发渠道版本一致：

- Release 二进制：`sherpa-onnx-v1.13.4-win-x64-shared-MD-Release.tar.bz2` — 20.0 MB，含在线/离线 WAV 测试 CLI，但**不含** `sherpa-onnx-microphone.exe`；Gate 0B 用 CLI 测 RTF、用同版本 Node N-API 测首 partial
- Node 绑定：`sherpa-onnx-node@1.13.4` + `sherpa-onnx-win-x64@1.13.4`
- C# 绑定（若走 WPF 路线）：NuGet `org.k2fsa.sherpa.onnx` 1.13.4

**不要装 CUDA 版**：`…-cuda-12.x-cudnn-9.x-win-x64-cuda.tar.bz2` 有 310.8 MB，还要求终端用户机器上有 CUDA 12.x + cuDNN 9.x。字幕场景单路音频，CPU 上 `numThreads: 3` 足够。

**onnxruntime 已打包在内，不要另外 `npm i onnxruntime-node`**，会冲突。

### 2.2 一遍流式模型 —— X-ASR

Release tag `asr-models` 下 2026-06-05 上传的一组：

```
sherpa-onnx-x-asr-{160,480,960,1920}ms-streaming-zipformer-transducer-zh-en[-punct][-int8]-2026-06-05
```

`480ms-punct-int8` 已下载解包核实（128 MB 压缩包）：

```
encoder.int8.onnx   155.3 MB
decoder.onnx         11.3 MB
joiner.int8.onnx      2.6 MB
tokens.txt / bpe.model / test_wavs/
README.md → 来源 https://github.com/Gilgamesh-J/X-ASR
```

标准 transducer 三件套布局，直接喂 `OnlineRecognizer.transducer` 配置。模型本体是 cache-aware streaming Zipformer2 transducer，约 0.16B 参数，5000 BPE 词表，中英 code-switch。官方给的量化后 RTF 在 M1 CPU 上约 0.06×。

**选它的三个理由：**

1. `-punct` 变体**推理直接吐标点**，省掉独立标点模型和一次额外推理 —— 字幕没标点非常难读
2. 160/480/960/1920ms 四档 chunk 延迟，当前骨架已画成「极速 / 均衡 / 精准」；Rev.3 起 UI 只保存产品级 profile，后端根据 Capabilities 映射到实际模型
3. 中英混说是会议场景刚需

| 档位 | 模型 | 用途 |
|---|---|---|
| 默认 | `x-asr-480ms-…-punct-int8-2026-06-05` | 128 MB，均衡 |
| 极速 | `x-asr-160ms-…-punct-int8-2026-06-05` | 同体积，延迟更低、抖动更大 |
| 精准 | `x-asr-960ms-…-punct-int8-2026-06-05` | 同体积，延迟高但更稳 |
| **低配回退** | `sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16` | 老牌小模型，文档齐全，弱机保底 |
| 纯中文场景 | `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30` | 只说中文时更准更轻 |

> **回退的连带代价**：`small-bilingual` 没有 160/480/960 三个变体。若退到它，后端 Capabilities 只发布实际可用的 profile，设置页自动灰显或隐藏不支持项；视觉模型无需知道模型文件名。

### 2.3 二遍精修模型

`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2` — 165.8 MB，非流式，中/英/日/韩/粤五语，带 ITN。

用途见 §5.3 两遍解码：流式模型负责「边说边出」，SenseVoice 在断句时对该段音频重解一次，把那一行**替换成定稿**。这是主流字幕软件的手感来源，也是历史面板要的东西 —— 时间线上每一条都应该是定稿文本。

### 2.4 VAD

`silero_vad.onnx` — 0.6 MB。两个作用：静音时不喂 recognizer（明显省 CPU）；给二遍解码提供干净的分段边界。

### 2.5 磁盘预算

```
Electron 运行时 + 应用       ~150 MB
sherpa-onnx native (win-x64)  ~ 20 MB
x-asr-480ms-punct-int8        ~170 MB (解包后)   ← 首启必下
sense-voice-int8              ~230 MB (解包后)   ← 可选增强，见 §8.2
silero_vad                    ~  1 MB
──────────────────────────────────
合计                          ~570 MB
```

模型**不打进安装包**，做成首次启动下载向导（见 §6.3）。

---

## 3. 外壳选型：Electron

对比过三条路，Electron 在三个硬需求上都是一行代码：

| 需求 | Electron | Tauri v2 | WPF/WinUI |
|---|---|---|---|
| 复用现有 HTML 设计稿 | ✅ 直接跑 | ✅ 直接跑 | ❌ 全部重画 |
| sherpa-onnx 接入 | ✅ 官方 N-API 预编译，`npm i` 完事 | ⚠️ 社区 `sherpa-rs`，要 MSVC 链接 C 库 | ✅ 官方 NuGet |
| **系统声回环** | ✅ `audio: 'loopback'`，一行 | ❌ 得自己写 Rust WASAPI loopback | ✅ NAudio |
| Win11 亚克力 | ✅ `backgroundMaterial: 'acrylic'` | ✅ window-vibrancy 插件 | ✅ 原生 |
| 体积 / 内存 | ❌ 最差 | ✅ 最好 | ✅ 好 |

系统声回环是会议字幕的命门（要听的是**对方**说话，不是自己的麦克风），Electron 在这一点省掉的工作量足以抵掉体积劣势。若后续特别在意体积，Tauri v2 + `sherpa-rs` 是可迁移备选，UI 层基本不动。

### 3.1 毛玻璃的取舍（已落地）

Chromium 的 `backdrop-filter` 只模糊「页面内部」在它后面的内容，**模糊不了窗口外的桌面**。Win11 上真正的桌面模糊只能由 DWM 提供（`backgroundMaterial: 'acrylic' | 'mica'`），而它与 `transparent: true` 互斥。

因此已决定：

- **字幕条 / 工具条** → `transparent: true` + `frame: false` + 纯色半透明（`rgba(14,32,44,.86)`）+ 10px 小圆角。无 `backdrop-filter`，常驻置顶大透明窗的 GPU 开销大幅下降。
- **设置窗** → 独立窗，`backgroundMaterial: 'acrylic'` + `transparent: false`，拿**真·亚克力**。「只有设置页需要美观」这个要求，正好和技术上唯一能做真毛玻璃的地方重合。
- 音量/声浪状态条已删除，录制状态靠 `▷ / ⏸` 图标本身切换表示。

> 当前窗口壳、拖动/穿透、字幕渲染不变量和设置页范围见 **[docs/subtitle-window.md](docs/subtitle-window.md)**；具体视觉取值由 UI 设计 brief 管理。

---

## 4. 进程、窗口与数据拓扑

```
┌─ 可见 UI renderer ───────────────────────────────────────────┐
│ 字幕窗 · 工具条窗 · 设置/历史/首启窗                          │
│ 只负责视觉、交互意图和 RuntimeSnapshot / CaptionEvent 渲染    │
└──────────────┬───────────────────────────────────────────────┘
               │ 按窗口最小权限 preload
               ▼
┌─ 主进程：Electron 壳 + Application ──────────────────────────┐
│ WindowManager · SessionCoordinator · IPC 校验 · 全局快捷键    │
│ Config/Credential/Transcript/Model/AI 服务（各自独立模块）     │
└───────┬─────────────────────┬─────────────────────┬─────────┘
        │                     │                     │
        ▼                     │                     ▼
┌───────────────────┐         │             ┌──────────────────┐
│ audio-host hidden │         │             │ refine-worker    │
│ Web Media API     │         │             │ SenseVoice       │
│ AudioWorklet 16k  │         │             │ 有界精修队列       │
└─────────┬─────────┘         │             └────────▲─────────┘
          │ PCM Float32Array  │ CaptionEvent                  │
          │ MessagePort       │ （小流量、版本化）               │
          ▼                   │                               │
┌────────────────────────┐    │                               │
│ realtime-asr-worker    │────┴───────────────────────────────┘
│ OnlineRecognizer ×2    │   final 触发精修；partial/final 先归并
│ VAD / 分段 / 背压       │
└────────────────────────┘
```

主进程是**组合根和状态权威**，不是音频中继或推理线程。服务拆成模块不等于每个服务都新开进程：只有同步 CPU 密集的 ASR/精修需要 utility process；配置、凭据和异步网络请求可以先作为主进程模块，未来有测量依据再迁移。

### 4.1 新增第 4 个窗：隐藏的音频宿主窗

目标目录 `src/runtime/audio-host/`，窗口使用 `show: false` + `backgroundThrottling: false`。专职 `getUserMedia` / `getDisplayMedia` + AudioWorklet 重采样。

**为什么不放字幕窗**：字幕窗是常驻置顶的合成热点且 `focusable: false`，把音频栈塞进去会让「采集失败」和「字幕闪烁」耦合成同一类故障；独立宿主窗崩了可以静默重启，字幕不受影响。

**Gate 0C 已验证**：主进程用 `hostWin.webContents.executeJavaScript(code, true)`（第二参 `userGesture = true`）触发时，隐藏窗的 display handler 实际收到 `request.userGesture: true`，并完成麦克风/回环双路 48k→16k Worklet 采集；见 `docs/validation/gate-0c.md`。当前批准隐藏 audio host。若未来打包版回归，工具条点击回退必须重新实测，并由工具条持有 stream/Worklet、向后端传 PCM；不能未经验证就假定 `MediaStreamTrack` 可跨 renderer 转移。

### 4.2 音频帧走 MessageChannelMain，绕开主进程

`new MessageChannelMain()` → 一端 `webContents.postMessage` 给音频宿主窗，另一端随 `utilityProcess.fork` 的 `postMessage` 转移给 realtime worker。

> **B2.2 实测修正**：renderer DOM MessagePort → MessagePortMain 桥会**静默丢弃**带 ArrayBuffer transferable 的消息（纯 JSON 的控制消息可达，带 `[samples.buffer]` 的帧全部丢失）。帧改为结构化克隆发送：1600×4B ≈ 6.4KB/帧、每路 10 帧/秒，拷贝成本可忽略；「PCM 不经过主进程 JS 事件循环」的关键不变量不受影响。

**为什么**：100ms 一帧、16k mono Float32 = 6.4 KB/帧/路，双路 128 KB/s 长流。让它穿过主进程等于把主进程变成音频中继 —— 而主进程正在以 **~120fps 轮询光标做拖动**（`src/main.js` 的 `dragTick`，8ms 定时器）。这两件事绝不能挤在同一个事件循环里。

只有 PCM 绕开主进程。`partial/final/refined/translated` 是低带宽文本事件，统一交给 `SessionCoordinator` 排序、持久化并广播，避免字幕窗、历史和导出各自维护一份不同的真相。若性能测量证明文本路由仍是瓶颈，再增加旁路，不提前优化。

### 4.3 实时识别与二遍精修拆成两个 utility process

`decode()` 是同步 CPU 密集调用，放主进程会卡住 IPC 和窗口动画；而在同一个 worker 里“异步”调用 OfflineRecognizer 也不会变成非阻塞，仍会暂停实时 partial。

- `realtime-asr-worker`：只做双路 OnlineRecognizer、VAD/分段和实时事件。
- `refine-worker`：只做 SenseVoice，按 `segmentId` 返回更高 `revision`；队列必须有上限，积压时允许降级或跳过，不能拖慢实时字幕。
- 主进程监听两个 worker 的 `exit`，将状态切到 `recovering/error`，并按策略重建 MessagePort。

### 4.4 `partial` 渲染改为不重建 DOM

`src/caption/caption.js` 的 `renderLines()` 每次 `captions.innerHTML = ''` 全量重建。假字幕 55ms 一次尚可，真 ASR 的 partial 更密集、文本更长。改成常驻的 previous/current/translation 节点，只改 `textContent`；由前端 reducer 丢弃旧 `sequence/revision`。

改动 10 分钟，但不改的话性能问题会伪装成「ASR 太慢」，白白浪费半天排查。

---

## 5. ASR 管线设计

### 5.1 音频采集

主进程一次性装好回环处理器：

```js
session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] })
  callback({ video: sources[0], audio: 'loopback' })
})
```

> Electron 43 的 `request` 只有 `frame / securityOrigin / videoRequested / audioRequested / userGesture` 等字段，**没有** `request.video`；视频源必须由 `desktopCapturer` 显式选择。

> Electron 43 复核：`audio` 接受 `'loopback'` 或 `'loopbackWithMute'`（均 Windows only）。**字幕场景必须用 `'loopback'`** —— `loopbackWithMute` 会把系统声静音，用户就听不见会议了。

音频宿主窗：

```js
// 系统声（对方）。注意：不请求 video 会失败，拿到后立刻丢掉 video track
const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
sys.getVideoTracks().forEach(t => t.stop())

// 麦克风（自己）。三个开关必须关，否则会削掉语音细节、拉低识别率
const mic = await navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
})
```

用 `AudioWorkletNode` 重采样到 **16000 Hz 单声道 Float32**，每 ~100ms 一帧 `postMessage` 到 port。不要用废弃的 `ScriptProcessorNode`。

### 5.2 音频源归因 —— 免费的双路方案

真做多说话人 diarization 要 speaker embedding + 在线聚类，误标率高、调参痛苦。

**v1 先做 100% 可判定的音频源归因：麦克风 / 系统音频。** 开两个 `OnlineRecognizer` 实例分别跑两路；UI 允许用户把来源别名设为「我 / 对方」，但数据层只保存 `sourceId`，不宣称完成了说话人分离。系统音频可能同时包含多名远端参会者、通知或媒体声，真 diarization 推到 v2 以后。

### 5.3 两遍解码（字幕手感的关键）

```
每 100ms:
  frame 带 sourceId / sequence / monotonicTimestamp
  vad.acceptWaveform(frame)                         // VAD 始终看见所有帧
  将 frame 写入有界环形缓冲，并记录队列时长 / 丢帧数

  if vad == speech:
      stream.acceptWaveform(16000, frame)
      while (recognizer.isReady(stream)) recognizer.decode(stream)
      partial = recognizer.getResult(stream).text
      → emit CaptionEvent(kind:'partial', revision:n, ...)
      同时把 frame 追加进 segBuffer

  if vad 从 speech → silence:
      → emit CaptionEvent(kind:'final', revision:n+1, ...)
      → 把 {segmentId, audio} 放入 refine-worker 有界队列
      refine-worker 返回:
      → emit CaptionEvent(kind:'refined', revision:n+2, ...)
      recognizer.reset(stream); segBuffer = []
```

v1 先由 **VAD 的 speech-end** 负责分段，recognizer endpoint 只作超长句兜底。不能一边“不向 recognizer 喂静音”，一边依赖它的 trailing-silence endpoint，否则可能永不断句。分段参数属于运行配置，由后端校验并返回 effective value；UI 只展示产品级选项。

### 5.4 翻译与摘要

不走本地模型 —— 本地 NMT 在 Win 上没有好的 onnx 方案，摘要本来就该用大模型。

- **ASR 永远本地离线**（隐私卖点，也是选 sherpa-onnx 的初衷）
- **翻译**：每条 committed segment 触发一次请求，以 `segmentId + revision + targetLanguage` 去重；使用保序的有界队列、取消和超时。不得把不同 segment 合并成一个“单飞”请求后再猜结果对应关系
- **摘要**：每 N 条 / 每 2 分钟滚动一次，只传定稿文本

---

## 6. 工程选型（初版未覆盖）

原则：**当前零业务依赖的状态是资产**，每加一个包都要能说清为什么不能不加。

### 6.1 构建工具链 —— 不引入

不上 Vite / TypeScript / 前端框架。UI 是纯 HTML + CSS + vanilla JS，加打包器只会让 preload 与 `utilityProcess` 入口的路径解析变复杂（打包后路径与开发期不一致是 Electron 最常见的翻车点）。

类型安全用 `// @ts-check` + JSDoc + `jsconfig.json`，只装 `typescript` 一个 devDep。所有跨边界对象都必须有共享类型和运行时校验：`RuntimeSnapshot / CaptionEvent / Command / CommandResult / Capabilities / ConfigPatch`。不只 worker 消息会静默失败，renderer ↔ preload ↔ main 的 IPC 同样会。

### 6.2 模型解压 —— 用系统自带 `tar.exe`

已在开发机实测：`C:\Windows\System32\tar.exe` 是 **bsdtar 3.7.7，含 bz2lib 1.0.8**，直接支持 `.tar.bz2`：

```js
execFile('C:\\Windows\\System32\\tar.exe', ['-xf', archive, '-C', destDir])
```

**不要装** `seek-bzip` / `decompress` / `node-7z`。纯 JS bz2 解 200MB 模型要几十秒且吃满一个核，而 Win10 1803+ / Win11 全都自带 bsdtar。（低版本兜底：下载前检测 `tar.exe` 是否存在，缺失则提示手动解压。）

### 6.3 模型下载器 —— Node 原生 fetch

Range 断点续传 + SHA256 校验 + 写 `.part`。解压到 staging 目录，核对期望文件和磁盘空间后再原子 `rename` 为 ready；不能直接解压到正在使用的模型目录。不引 `got` / `axios`。

- 落盘位置：`app.getPath('userData')/models/<model-id>/`
- 设置页新增「资源管理」pane：已下载模型列表、占用空间、下载/删除、进度条
- 校验失败必须能原地重来，不能只留一个半截文件
- 正在被 worker 使用的模型禁止删除；UI 只发送命令，ModelManager 决定能否执行

### 6.4 转写存储 —— JSONL，不上数据库

`userData/sessions/<windows-safe-time>_<session-id>.jsonl`，append-only。不能直接把 ISO8601 用作 Windows 文件名，因为其中的 `:` 非法。

JSONL 保存事件而不是一条“最终可变记录”：

```json
{"v":1,"event":"segment.final","sessionId":"...","segmentId":"...","sourceId":"mic","revision":1,"t0":12.34,"t1":15.02,"text":"..."}
{"v":1,"event":"segment.refined","sessionId":"...","segmentId":"...","revision":2,"text":"..."}
{"v":1,"event":"segment.translated","sessionId":"...","segmentId":"...","revision":3,"lang":"en","text":"..."}
```

读取和导出时按 `segmentId + revision` 折叠为当前状态。这样 refined/translation 可以晚到，崩溃前已经写入的 final 也不会丢。明确否掉 better-sqlite3：它是 native 模块、绑 Electron ABI，当前查询需求仍只有按会话顺序读。

历史面板超过 200 条要 DOM 回收或虚拟滚动 —— 两小时会议会有几千条。

### 6.5 AI 层 —— 手写 SSE，不引 SDK

v1 明确只承诺 **OpenAI-compatible chat completions**。使用 `fetch` + 独立的 provider adapter，不把“任意 Claude / 自建端点”统称为兼容；不同协议以后增加 adapter。SSE parser 必须覆盖跨 chunk Unicode、空行、错误帧、`[DONE]`、取消和超时。

**两个硬约束：**

1. **请求不能在渲染进程发** —— v1 由主进程内独立 `AiGateway` 模块负责；如果未来测得流解析影响主进程，再迁移到 utility process。key 永不进入可见 renderer
2. **API Key 用 `safeStorage.encryptString()` 写 `userData/creds.bin`** —— 绝不进 `config.json`，那个文件是明文且会被 `broadcastConfig()` 广播到所有窗口

### 6.6 打包 —— electron-builder 26.15.3 + NSIS

关键一行：

```json
"asarUnpack": ["**/node_modules/sherpa-onnx-win-x64/**"]
```

`.node` 在 asar 里 `dlopen` 不了，这是必踩的坑。模型不进安装包，装在 `userData/models/`。

### 6.7 测试 —— 自动化纯逻辑，手测窗口特性

暂不上 Playwright：透明 + `focusable: false` + 点击穿透的窗口自动化驱动成本高，这部分继续用手测矩阵覆盖置顶、穿透、DPI、多屏、锁定和拖动。

使用 `node:test` 自动覆盖：

- `scripts/asr-bench.js`：wav → worker → partial/final/RTF/端到端延迟。
- 会话状态机、命令合法性和 worker 崩溃恢复。
- IPC sender/payload 校验以及跨进程 contract fixtures。
- Caption reducer 对乱序 sequence/revision 的处理。
- 配置校验、迁移、写入防抖和坏文件恢复。
- JSONL 坏尾行恢复、事件折叠和 md/srt/txt 导出。
- 模型断点续传、SHA 失败、staging 安装和活跃模型保护。
- SSE parser、取消、超时、重试和有界队列。

---

## 7. 分轨并行路线图

不再把全部工作串成一个 Phase 0→7 队列。完成共享 Gate 0 后，视觉/UI 和运行后端用同一套 fixtures 并行开发，在 Integration Gate 汇合。

### 7.1 共享 Gate 0（执行中）

| Gate | 内容 | 验收标准 |
|---|---|---|
| **0A 契约（完成）** | 固化 `RuntimeSnapshot / CaptionEvent / CommandResult / Capabilities` v1 和样例 fixtures；见 `src/contracts/` | validator 测试覆盖 idle、启动、监听、暂停、恢复、错误、精修、翻译；UI 接线留给视觉工作流 |
| **0B 模型（实测完成，未通过）** | X-ASR 480/160、small-bilingual、SenseVoice 的 CLI + N-API 实测；见 `docs/validation/gate-0b.md` | 480ms 首字延迟失败；160ms RTF 失败；small-bilingual 质量/标点失败；SenseVoice 无精修净收益。**M2 复测（2026-07-26，`docs/validation/gate-0b-m2-sweep.md`）：两候选失败被证实为架构/算力性——480ms 首 partial 需 960–980ms 音频输入（线程无关），160ms RTF 最优 t=4 仍 0.47–0.50（t≥6 混合架构反噬）；调参路线封闭，残余选项待产品拍板。M3 精修评估（2026-07-27，`docs/validation/gate-0b-m3-refinement.md`）：离线 X-ASR int8 全面胜出 SenseVoice（CER 零退化、标点 F1 1.000、RTF 0.027），建议进入正式 re-judgment** |
| **0C 音频拓扑（完成）** | 隐藏 audio host 的麦克风/回环、用户手势、AudioWorklet 48k→16k 实测；见 `docs/validation/gate-0c.md` | 回环挑战音命中、物理麦克风非静音、确定性 audioinput 探针通过；三路 16k mono PCM16 无削波/帧缺口/大跳变，批准 hidden audio host |
| **0D 产品入口（完成）** | 首启提供「会议字幕 / 个人听写」双预设 | 2026-07-26 拍板：会议默认系统音频、听写默认麦克风；新安装在选择前两路都不暗中启用 |

Gate 0B 的固定复现入口：

```powershell
node scripts/gate-0b/run-cli-suite.js `
  --asset-root models/gate-0b `
  --raw-dir models/gate-0b/runs/cli-raw `
  --output docs/validation/gate-0b-cli-observations.json

node scripts/gate-0b/evaluate-transcripts.js `
  --corpus scripts/gate-0b/corpus.json `
  --observations docs/validation/gate-0b-cli-observations.json `
  --output docs/validation/gate-0b-controlled-metrics.json
```

模型任一指标不达标 → 换 `160ms` 或退到 `small-bilingual` 重跑；UI 只根据新的 Capabilities 改可用档位，不直接绑定模型名。

### 7.2 视觉/UI 工作流

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **V1 设计基础** | 设计 token、组件状态、排版和 fixtures 展示页 | 深浅色、高对比度、键盘 focus、reduced motion 均有定义 |
| **V2 核心字幕** | 稳定 DOM + caption reducer；工具条完整运行状态 | 38px、双语、长英文、错误和恢复状态不溢出；不靠颜色单独传达状态 |
| **V3 设置与历史** | capability-driven 设置；可聚焦的历史/导出界面 | 未实现/未安装能力不可误操作；两小时记录滚动不卡 |
| **V4 首启与云端 UX** | 场景预设、权限、模型下载、AI 隐私提示 | 用户始终知道当前在下载什么、监听什么、哪些文本会离开本机 |

视觉模型只提交视觉/UI 层文件；运行状态和样例数据来自 fixtures，禁止为了“让页面先跑”而在 renderer 内伪造后端成功状态。详细白名单见 `docs/ui-design-brief.md`。

### 7.3 运行后端工作流

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **B1 应用骨架（完成）** | `SessionCoordinator`、状态机、per-window preload、contract validation、fake adapter | renderer 重载后快照一致；越权 IPC 和非法配置被拒绝；自动测试与默认/dev Electron smoke 通过 |
| **B2.0 恢复缺口（完成）** | canonical `CaptionState`（与 renderer 共用同一折叠实现）、caption 角色独占 `getCaptionState()`、订阅-水合-重放 bootstrap、replacement adapter 恢复游标（`resume: {attempt, sourceSequences}`） | reload 水合与实时流逐字段一致（含双路交错与窗口外迟到修订的 property 回归）；replacement 后首条字幕被接受并到达订阅者；stop/新会话/dispose 保留与清空语义有回归覆盖 |
| **B2.1 audio host 产品化（完成）** | Gate 0C 拓扑提取到 `src/runtime/audio-host/`：非持久化 session、最小权限 handler、专用 preload、AudioWorklet 48k→16k 1600 samples/100ms、有界诊断采集与指标落盘（`scripts/audio-host-smoke.js`） | 纯逻辑（resampler/assembler/metrics/policy）自动测试；实机 smoke 静音与 997Hz 信号两种情形 PASS（宿主全程隐藏、userGesture、0 gap、时钟覆盖 1.0）；未接 SessionCoordinator |
| **B2.2 PCM 直通与背压（完成）** | `MessageChannelMain` 直通：host → port → `pcm-sink` utility process；credit 背压（ready 握手 + 窗口式授信）、`FrameFlow` 有界队列（maxQueueMs 丢旧保新）、低频指标控制通道、`replacePort` 中途换消费端 | 实机 smoke 三模式 PASS：normal 40/40/40 帧 0 丢 0 缺口；slow 队列峰值恰好压在预算上、29 丢帧且 sink 观察到对应缺口；crash-replace 消费端 exit(13) 后替换 sink 无缝续流。PCM 不经主进程 JS；帧用结构化克隆（transferable 被桥丢弃，见 §4.2 修正） |
| **B2.3 realtime worker 骨架（完成）** | `src/runtime/realtime-worker/`：per-source 管线（帧→VAD 分段→recognizer adapter→contract-valid partial/final）、可替换 adapter 注册表（默认 `null`——Gate 0B 未过绝不产文本）、EnergyVad 占位（silero 随模型轨替换）、utilityProcess 入口沿用 B2.2 credit 协议、main 侧 `RealtimeWorkerHost`（边界契约校验） | 纯逻辑单测覆盖 VAD/分段/双源/缺口指标/坏帧；worker 事件全量通过真实 `SessionCoordinator.acceptCaption` 门（集成测试）；实机 smoke 传输与零字幕不变量 PASS，VAD 实音分段因系统静音判 inconclusive（有声复跑即补） |
| **B2 实时链路** | audio host、MessagePort、双路 realtime worker、VAD/背压 | 真 partial/final 替掉假流；拖动不掉帧；队列深度和丢帧可观测。剩余：真实模型 adapter（模型轨）、audio host/worker 接入 SessionCoordinator（I2） |
| **B3 精修与会话** | refine worker、事件式 JSONL、恢复与导出 | 精修不阻塞实时流；坏尾行可恢复；SRT 时间轴稳定 |
| **B4 资源与 AI** | ModelManager、CredentialStore、AiGateway | 下载可续传/校验/原子安装；key 不进 renderer；AI 失败不影响本地字幕 |
| **B5 分发** | electron-builder、NSIS、首启资源检查 | 干净机器安装可用；native module 正确 unpack；模型缺失可恢复 |

> 视觉/UI 层已交付 V1–V2；B1 已关闭 [docs/ui-design-brief.md §6](docs/ui-design-brief.md) 的 A1–A3 和 stop/retry 请求。A4 layout contract、历史、资源管理和权限入口仍按后续阶段推进。
> C 类是 UI 对后端的持续契约约束，违反时的症状是「界面上东西不见了」而不是报错；B1 的 coordinator 与 fake adapter 已遵守这些约束。

### 7.4 Integration Gates

| Gate | 汇合内容 | 验收标准 |
|---|---|---|
| **I1 Contract（完成）** | UI fake adapter ↔ 后端 contract fixtures | coordinator、fake adapter、renderer reducer 和 IPC 共享 v1 validator；默认/dev smoke 均通过 |
| **I2 Live Caption** | 音频 → realtime ASR → SessionCoordinator → 字幕 UI | P50/P95 延迟、CPU、内存、队列深度达标。**I2.1 结构接线已完成（2026-07-27）**：`RealtimeRuntimeAdapter` 实现 B1 冻结接口组合 host/worker/port，coordinator 新增 adapter `onError` 故障入口（§12.4 关闭）；实机 smoke 全相位通过（含 worker 击杀→error→retry→listening 恢复），null recognizer 零字幕。完整 I2 PASS 仍以模型批准为前提 |
| **I3 Durable Session** | final/refined/translation → JSONL → 历史/导出 | 连续 2 小时不卡；崩溃恢复不丢已 final 的段落 |
| **I4 Packaged App** | 首启、下载、权限、ASR、AI、退出清理 | 在干净 Win11 机器完成完整用户旅程 |

---

## 8. 待拍板

### 8.1 主场景是「听会议」还是「记自己说话」？（已拍板）

旧骨架曾默认 `mic: true, loopback: false`，暗示麦克风优先；但产品也强调会议系统声。Gate 0D 已移除这个隐藏默认值，新安装和旧配置迁移都必须先完成显式选择。

**决定：首启提供「会议字幕」和「个人听写」两个预设。** 会议预设默认系统音频开启、麦克风关闭但可后续开启；个人听写默认只开麦克风。配置保存实际 `sourceId`，UI 别名可显示为「我 / 对方」。在用户完成选择前，`mic / loopback` 都为 false，不再用隐藏默认值替用户做产品决定。

Gate 0B 继续坚持原门槛。默认 `Capabilities.availableProfiles = []`；只有显式设置 `LIVE_SUBTITLE_DEV_MODEL=x-asr-480ms` 时，B1 fake adapter 才发布开发期 `balanced` profile。这个开关不改变 Gate 结论，也不得进入生产默认配置。

### 8.2 接受首启下载 ~400MB 吗？

**建议：接受，但分两步下。** 首启只拉 x-asr（~170MB）即可用；SenseVoice 二遍精修（~230MB）做成设置页里的可选增强。首次体验等待砍掉一半，精修从「入场门槛」变成「用着用着发现还能更准」。

若要求开箱即用 0 下载，就得砍到 `small-bilingual`（~50MB 级）并放弃二遍精修，准确率有肉眼可见的下降。

---

## 9. 风险登记

| 风险 | 影响 | 对策 |
|---|---|---|
| x-asr 模型无官方文档背书 | 配置字段可能与预期不符 | Gate 0B 实测，备选已列；UI 只读 Capabilities |
| 隐藏窗 `getDisplayMedia` 无用户手势 | 系统声采集起不来 | Gate 0C 验证；退路：工具条窗发起采集 |
| OfflineRecognizer 阻塞实时 worker | partial 停顿、音频队列增长 | realtime/refine 双 utility process；精修有界队列 |
| VAD 与 recognizer endpoint 规则冲突 | 静音后不定稿 | v1 由 VAD speech-end 主导，endpoint 只兜底 |
| PCM 消费低于实时速度 | 延迟无限增长、最终内存爆 | 有界环形缓冲、sequence、丢帧策略和队列指标 |
| 共享 preload / 未校验 IPC | renderer 越权退出、改配置或控制会话 | per-window API、sender/payload/state validation |
| 隐藏窗影响应用生命周期判断 | 可见窗消失但应用不退出，或无法重建 | WindowManager 分别追踪 visible/runtime windows，不依赖 `getAllWindows().length` |
| `.node` 打进 asar | 安装版启动即崩，开发期发现不了 | `asarUnpack`，B5/I4 在干净机器验 |
| 两小时会话 DOM 膨胀 | 历史面板卡死 | DOM 回收 / 虚拟滚动，V3/I3 验收 |
| refined/translation 与单记录 JSONL 冲突 | 更新丢失或导出状态错误 | append-only 事件日志，按 revision 折叠 |
| 翻译请求打爆 API | 账单与限流 | segment 去重、有界保序队列、取消和超时 |
| `transparent` 窗开 DevTools 透明失效 | 调试期误判 | Electron 已知限制，非 bug |

---

## 参考

- sherpa-onnx: https://github.com/k2-fsa/sherpa-onnx
- 文档站: https://k2-fsa.github.io/sherpa/onnx/
- Node 示例: https://github.com/k2-fsa/sherpa-onnx/tree/master/nodejs-examples
- X-ASR 上游: https://github.com/Gilgamesh-J/X-ASR
- Electron `setDisplayMediaRequestHandler`: https://www.electronjs.org/docs/latest/api/session
- Electron `utilityProcess`: https://www.electronjs.org/docs/latest/api/utility-process
- Electron `MessageChannelMain`: https://www.electronjs.org/docs/latest/api/message-channel-main
- Electron `safeStorage`: https://www.electronjs.org/docs/latest/api/safe-storage
- Electron BaseWindow 选项（backgroundMaterial）: https://www.electronjs.org/docs/latest/api/structures/base-window-options
- Electron 回环音频参考实现: https://github.com/alectrocute/electron-audio-loopback
- 字幕窗实现细节: [docs/subtitle-window.md](docs/subtitle-window.md)
- 视觉/UI 模型交接边界: [docs/ui-design-brief.md](docs/ui-design-brief.md)
- 运行后端与契约: [docs/runtime-architecture.md](docs/runtime-architecture.md)
