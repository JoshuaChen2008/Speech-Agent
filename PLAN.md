# Live Subtitle Agent · Win11 实时字幕技术规划

> **Rev.7 · 2026-07-31**。初版调研 2026-07-23（版本号、模型名、体积经 GitHub Release API / npm registry / 下载解包核实）。
> 本次修订：SQLite 历史列表、带时间戳文本复盘与安全 txt/md/srt 导出进入实现完成/尚未实机验收；ModelManager 成为下一主线。`loopback`/`mic` 继续产品级互斥，Agent 与向量继续后置。

---

## 0. 现状盘点

初版 PLAN 把 UI 排在 ASR 之后；目前 Gate 0A/0C/0D、视觉 V1–V2 和 B1 应用骨架已完成，真实音频/ASR 链路从 B2 开始。

| 已实现 / 已有确定性证据 | 尚未完成 |
|---|---|
| 四窗架构（字幕 / 工具条 / 设置 / 历史）、停靠与脱离 | 历史窗口真实 Electron 交互与 I3 长稳 |
| 锁定穿透、逐像素命中测试、主进程手动拖动 | 模型下载/校验/原子安装与资源管理 |
| 配置持久化（`userData/config.json`）+ 四窗主题联动 | Agent 层（后置）、打包分发 |
| 亚克力设置窗（显示 / 音频源 / 语音识别 / 关于 四个 pane）+ 单路模式 XOR 门禁/J4 | I2 完整指标 |
| B1 `SessionCoordinator`、状态机、per-window preload 与 contract-valid fake adapter | |
| B2 audio host、PCM 直通/背压、realtime worker、**真实 160ms 模型 + silero VAD** | |
| B3 **二遍精修 refine worker**（final→refined 自动变准补标点）+ JSONL 旧档迁移；B3.3 DB0/DB1、Gateway 恢复、默认 SQLite-only 生命周期、历史查询/导出 UI 与联合旅程 | 真实产品 Electron 迁移/历史/退出验收、I3 与打包态 DB0 |

**Gate 0B 已于 2026-07-27 正式改判通过**（批准 `x-asr-160ms` fast profile + 离线 X-ASR 精修，门槛重设留档于 `docs/validation/gate-0b.md` 改判节），**两遍链路已全部接通**：真实 160ms 模型 + silero VAD + 离线精修 worker。2026-07-31 的 I2 schema v2 loopback 实机报告再次得到 final/refined CER 0，并记录 captured/sent/ingested 帧数一致且零丢失/零缺口、CPU/工作集和字幕到达时序；runner 已支持 `loopback`/`mic` 分开执行，物理 mic 证据仍待补。来源 XOR 由 J4 验证；J5/J6 已增加暂停/精修/worker 故障后同会话继续文本持久化的确定性联合旅程。SQLite 的 `node:sqlite` 已通过 Electron 43 utility process 开发态 DB0；默认组合根已切换为 SQLite-only，历史窗口也已接入同一投影，并由新联合旅程覆盖活动会话排除、mic final→refined、停止复盘、loopback XOR、分页和三格式导出。真实 BrowserWindow 交互、产品迁移/退出 smoke、I3 及 ASAR/NSIS 资格仍待完成。当前主线转入 ModelManager，随后做真实产品 smoke 和干净 Win11 分发；Agent 系统在字幕闭环后启动，向量检索后置。

### 0.1 两套产品系统的边界

| 系统 | 独立承诺 | 输入 | 输出 | 失败边界 |
|---|---|---|---|---|
| **字幕系统（MVP）** | 点击运行后监听一个已选择来源，实时显示 ASR 字幕，自动保存定稿及时间戳，并可从历史查看复盘 | `mic` XOR `loopback` PCM | partial、final/refined、SQLite 字幕历史 | 不依赖网络、LLM、Agent Loop 或向量扩展；不保存原始音频 |
| **Agent 系统（后置）** | 基于已提交字幕运行上下文增强和会后结构化纪要插件 | 字幕提交边界之后的当前正文与水位 | 独立增强文本、概要/结论/待办/风险 | 只生成内容；超时、断网、模型或插件失败不得停止字幕或损伤原文 |

两套系统在同一桌面产品内协作，不等于必须拆成两个安装包。唯一允许的主依赖方向是“Agent 系统消费字幕系统已提交事实”；字幕系统不得反向等待 Agent。历史只做带时间戳的文本复盘，产品现在及未来都不保存原始音频。

### 0.2 三层技术职责与协作边界

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
| 接入方式 | **`sherpa-onnx-node` 1.13.4** + `sherpa-onnx-win-x64` 1.13.4（N-API 预编译） | 已安装为依赖（2026-07-27） |
| 硬件后端 | **CPU**（不上 CUDA） | 定 |
| 一遍流式模型 | **x-asr-160ms-…-zh-en-punct-int8-2026-06-05**（fast，numThreads=4） | **2026-07-27 改判批准**（重设 RTF 门槛留档；480ms 首 partial 架构性超线已封闭） |
| 二遍精修模型 | **x-asr-zipformer-…-zh-en-punct-int8-2026-06-03**（离线同家族） | **2026-07-27 改判批准**（替换 SenseVoice：CER 零退化、标点 F1 1.0、RTF 0.027） |
| VAD | **silero_vad.onnx**（0.6 MB） | 定 |
| 外壳 | **Electron 43.2.0** | 复核：已是 latest，不动 |
| 构建工具链 | **不引入**（vanilla + JSDoc `@ts-check`） | 见 §6.1 |
| 模型解压 | **系统自带 `C:\Windows\System32\tar.exe`** | 已实测：bsdtar 3.7.7 带 bz2lib 1.0.8 |
| 转写存储 | **SQLite 单一权威 + append-only 字幕事件 + segment 投影**；JSONL 仅作迁移/导出/恢复 | 默认组合根、冷启动迁移、退出屏障、历史列表/详情/导出已实现并通过确定性联合 CI；真实 Electron/I3/I4 仍待完成，见 §6.4 / ADR 0001 |
| Agent runtime | **Pi Agent Core + 本项目 AgentPluginHost/存储适配** | 后置；A1 先做 ESM/Electron/打包隔离探针，见 §6.5 |
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

**Gate 0C 已验证**：主进程用 `hostWin.webContents.executeJavaScript(code, true)`（第二参 `userGesture = true`）触发时，隐藏窗的 display handler 实际收到 `request.userGesture: true`，并分别验证麦克风/回环 48k→16k Worklet 采集路径；见 `docs/validation/gate-0c.md`。产品运行时只允许选择其中一路。当前批准隐藏 audio host；新隐私语义要求后续 diagnostic/smoke 只保留内存指标，不再 dump 现场 WAV。若未来打包版回归，工具条点击回退必须重新实测，并由工具条持有 stream/Worklet、向后端传 PCM；不能未经验证就假定 `MediaStreamTrack` 可跨 renderer 转移。

> **实现状态（2026-07-30）**：上述隐私修正已完成。产品 diagnostic 明确拒绝 `dumpDir`，产品 smoke 与当前 Gate 0C runner 只做内存分析并写结构化指标，不生成现场 WAV。

### 4.2 音频帧走 MessageChannelMain，绕开主进程

`new MessageChannelMain()` → 一端 `webContents.postMessage` 给音频宿主窗，另一端随 `utilityProcess.fork` 的 `postMessage` 转移给 realtime worker。

> **B2.2 实测修正**：renderer DOM MessagePort → MessagePortMain 桥会**静默丢弃**带 ArrayBuffer transferable 的消息（纯 JSON 的控制消息可达，带 `[samples.buffer]` 的帧全部丢失）。帧改为结构化克隆发送：1600×4B ≈ 6.4KB/帧、每路 10 帧/秒，拷贝成本可忽略；「PCM 不经过主进程 JS 事件循环」的关键不变量不受影响。

**为什么**：100ms 一帧、16k mono Float32 = 6.4 KB/帧，单路约 64 KB/s 长流。让它穿过主进程等于把主进程变成音频中继 —— 而主进程正在以 **~120fps 轮询光标做拖动**（`src/main.js` 的 `dragTick`，8ms 定时器）。这两件事绝不能挤在同一个事件循环里。

只有 PCM 绕开主进程。字幕系统的 `partial/final/refined` 是低带宽文本事件，统一交给 `SessionCoordinator` 排序并广播；`final/refined` 再进入字幕持久化，避免字幕窗、历史和导出各自维护一份不同的真相。Agent 的 translated/enhanced/summary 在提交边界后生成并独立保存。若性能测量证明文本路由仍是瓶颈，再增加旁路，不提前优化。

### 4.3 实时识别与二遍精修拆成两个 utility process

`decode()` 是同步 CPU 密集调用，放主进程会卡住 IPC 和窗口动画；而在同一个 worker 里“异步”调用 OfflineRecognizer 也不会变成非阻塞，仍会暂停实时 partial。

- `realtime-asr-worker`：只为当前选定的单路来源运行 OnlineRecognizer、VAD/分段和实时事件；底层保留 `sourceId` 隔离能力。
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

### 5.2 互斥监听模式与音频源归因

真做多说话人 diarization 要 speaker embedding + 在线聚类，误标率高、调参痛苦。

**v1 先做 100% 可判定的音频源归因：麦克风或系统音频。** UI、配置验证和 runtime 必须共同执行 XOR：一次会话只启动当前选中来源对应的 recognizer，运行中不能直接换源；停止后才能以另一来源创建新会话。数据层保存 `sourceId`，但不宣称完成了说话人分离。系统音频可能同时包含多名远端参会者、通知或媒体声，真 diarization 推到 v2 以后。

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

### 5.4 Agent 系统：上下文增强、翻译与摘要（字幕 MVP 后）

- **ASR 永远本地离线**，字幕显示、保存和历史查看不依赖 Agent。
- Agent 只消费字幕提交边界后的当前正文；`partial` 不进入 Agent 上下文。
- **上下文增强文本**独立保存并声明输入水位、digest 和模型，永不覆盖原始权威转写；A2 首版只做会后或用户主动触发的整场增强，滚动逐段增强后置。
- **翻译**：每条 committed segment 触发一次请求，以 `segmentId + revision + targetLanguage` 去重；使用保序的有界队列、取消和超时。
- **摘要**：首版只做会后结构化纪要，栏目为概要、结论、待办、风险；会中滚动摘要后置，待办只生成文字。
- Pi 的低层 Agent Loop 承载“LLM → 内容型工具 → 观察 → 继续/结束”；项目自有 `AgentPluginHost` 管理字幕上下文、增强文本和纪要插件。编码 Agent 自带的 shell/read/write 工具、TUI 和 JSONL 会话不进入产品。

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

### 6.4 转写存储 —— SQLite 单一权威，保留事件语义

**2026-07-30 新决定正式替代 Rev.3 的“JSONL，不上数据库”。** B3.1 的 JSONL 已实现且继续作为迁移前基线；B3.3 验收通过后，`userData/data/speech-agent.sqlite3` 成为唯一权威写入，JSONL 只用于旧数据导入、显式导出和灾难恢复，不长期双写。

字幕存储仍然保存事件而不是一条“最终可变记录”：

- `caption_events` append-only 保存字幕系统的 `final/refined`；partial 只服务实时 UI。Agent 的 translated/enhanced/summary 使用独立派生表或事件类型，不伪装成 ASR 事实。
- `segments` 按 `segmentId + revision` 形成当前正文投影，字幕历史和导出共用它；Agent 通过已提交事件/水位读取。
- 字幕事实写入与 segment 投影更新必须在同一 SQLite 事务中完成；Agent 阶段再冻结可靠派发的 outbox/inbox 细节。
- storage worker 是唯一 SQLite 所有者，避免同步 SQL/扩展加载阻塞 Electron 主进程的窗口与拖动事件循环。
- 原始音频永不持久化：不写 BLOB、不写库外录音文件、不保存音频路径或恢复材料；有界 PCM 缓冲只服务实时 ASR/精修并及时释放。
- FTS5 可在需要历史搜索时独立增加；`sqlite-vec` 和 embedding schema 明确后置，均不得成为 SQLite 历史上线前置。

驱动在 Electron 43 utility process 中通过 DB0 驱动/WAL/打包探针后再冻结；SQLite 的数据语义不依赖某个 Node binding。完整 schema、迁移、降级和门禁见 [`docs/data-architecture.md`](docs/data-architecture.md)；SQLite 权威与双系统边界分别见 [ADR 0001](docs/adr/0001-sqlite-authoritative-event-store.md) / [ADR 0002](docs/adr/0002-separate-subtitle-and-agent-systems.md)。

历史面板超过 200 条要 DOM 回收或虚拟滚动 —— 两小时会议会有几千条。

### 6.5 Agent 层 —— Pi Agent Core + 项目自有插件宿主，后置实施

[earendil-works/pi](https://github.com/earendil-works/pi) 把低层 Agent runtime、统一 LLM provider 和编码 Agent UI/工具分包。已接受的选型是复用 `pi-agent-core`，不把完整 coding-agent CLI/扩展运行时嵌入 Electron；本项目在 core 外提供窄 `AgentPluginHost`，负责清单、静态注册、权限、生命周期、字幕水位、取消/重试、诊断和产物提交。

字幕系统本身不作为 Pi 插件；Agent 侧提供只读 `TranscriptContextPlugin`。`EnhancedTranscriptPlugin` 和 `MeetingMinutesPlugin` 是独立内容生成插件，只能经宿主的 `ModelGateway` 与 `ArtifactWriter` 工作。首版只加载随应用发布的受信任第一方插件，不做第三方安装、热重载或市场。

复用 Pi 前必须先做一个无 UI、无 shell/文件写工具的技术探针，验证包体、Electron utility process、取消、流式事件、provider 凭据注入和许可证归档。若探针不通过，保留 `AgentRuntime` 适配器并换实现，不影响字幕系统。

无论采用 Pi 还是自研，两个硬约束不变：

1. LLM 请求不能在可见 renderer 发起，API Key 永不进入 renderer。
2. API Key 用 Electron `safeStorage` 保护，绝不进入明文 `config.json`、字幕 SQLite、日志或模型上下文。

### 6.6 打包 —— electron-builder 26.15.3 + NSIS

关键一行：

```json
"asarUnpack": ["**/node_modules/sherpa-onnx-win-x64/**"]
```

`.node` 在 asar 里 `dlopen` 不了，这是必踩的坑。模型不进安装包，装在 `userData/models/`。

### 6.7 测试 —— 单元、联合 CI 与实机验收分层

**项目级完成规则（2026-07-30 新增）：只有单元测试不能宣称功能完成。** 每项用户能力必须至少有一条跨模块用户旅程在 CI 中通过；涉及真实声卡、模型性能、透明窗口或长稳运行时，还必须补 Windows 实机 smoke/soak 证据。规范状态词、功能含义和禁止误读以 [`docs/semantic-contract.md`](docs/semantic-contract.md) 为准；详细分层、场景 ID 和摘要联动不变量见 [`docs/testing-strategy.md`](docs/testing-strategy.md)。

暂不上 Playwright：透明 + `focusable: false` + 点击穿透的窗口自动化驱动成本高，这部分继续用实机矩阵覆盖置顶、穿透、DPI、多屏、锁定和拖动。Hosted CI 使用确定性替身隔离声卡/网络，但 `SessionCoordinator`、Caption reducer、TranscriptStore、队列和契约校验必须使用真实产品实现，不允许把整条链路全部 mock 掉。

自动化入口：

- `npm run test:integration`：每次 PR 必跑的跨模块用户旅程。
- `npm test`：完整回归集（也会发现 integration tests）。
- `npm run test:ci`：先显式运行联合旅程，再跑完整回归；由 Windows CI workflow 调用。
- `scripts/*-smoke.js`：真实 Electron/音频/模型进程边界，需有能力的 Windows 实机运行。

使用 `node:test` 自动覆盖：

- `scripts/asr-bench.js`：wav → worker → partial/final/RTF/端到端延迟。
- 会话状态机、命令合法性和 worker 崩溃恢复。
- IPC sender/payload 校验以及跨进程 contract fixtures。
- Caption reducer 对乱序 sequence/revision 的处理。
- 配置校验、迁移、写入防抖和坏文件恢复。
- JSONL 过渡格式的坏尾行恢复、事件折叠和 md/srt/txt 导出；B3.3 增加 SQLite 原子性、幂等迁移与历史查询；Agent 可靠消费在 A1 测，FTS/向量只在 X1 启用后测试。
- 模型断点续传、SHA 失败、staging 安装和活跃模型保护。
- SSE parser、取消、超时、重试和有界队列。

---

## 7. 双系统分阶段路线图

先完成可独立验收的字幕系统；其内部的视觉/UI 与运行后端仍用同一套 fixtures 并行开发并在 Integration Gate 汇合。字幕 MVP 验收后再启动 Agent 系统，避免在 JSONL 过渡存储或不稳定字幕契约上构建 LLM 功能。

### 7.1 共享 Gate 0（执行中）

| Gate | 内容 | 验收标准 |
|---|---|---|
| **0A 契约（完成）** | 固化 `RuntimeSnapshot / CaptionEvent / CommandResult / Capabilities` v1 和样例 fixtures；见 `src/contracts/` | validator 测试覆盖 idle、启动、监听、暂停、恢复、错误、精修、翻译；UI 接线留给视觉工作流 |
| **0B 模型（2026-07-27 改判通过）** | X-ASR 480/160、small-bilingual、SenseVoice 的 CLI + N-API 实测；见 `docs/validation/gate-0b.md` | 原门槛下四候选全败（判定历史保留）。M2 复测证实两候选失败为架构/算力性、调参封闭；M3 评估给出全面胜出的精修替换。**2026-07-27 产品负责人正式改判：RTF 门槛在写明机器基线与理由后重设为 <0.60，批准 `x-asr-160ms`（fast，t=4，改判日全语料补测首 partial 0.70–0.86s、zh-date-itn 一句骑线 1000.3ms 如实留档为边缘案例）+ 离线 X-ASR 精修（CER 零退化、标点 F1 1.0）。判定与 tracked 证据（`gate-0b-m2-sweep.json`/`gate-0b-m3-evaluation.json`）由测试强制一致；弱机/打包版须 B5/I4 复测后发布** |
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
| **V3 字幕历史（MVP）** | capability-driven 设置；可聚焦的会话列表、带时间戳正文与导出界面 | 停止/重启后仍可查看；两小时记录滚动不卡；不把文本历史误称为音频回放 |
| **V4 资源与首启（MVP）** | 场景预设、权限和 ASR 模型下载 | 用户始终知道当前在下载什么、监听什么；缺模型可恢复 |
| **V5 Agent UX（后置）** | 原文/增强文本、摘要、AI 隐私与失败状态 | 用户知道哪些文本会离开本机；Agent 失败不遮蔽原文历史 |

视觉模型只提交视觉/UI 层文件；运行状态和样例数据来自 fixtures，禁止为了“让页面先跑”而在 renderer 内伪造后端成功状态。详细白名单见 `docs/ui-design-brief.md`。

### 7.3 运行后端工作流

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **B1 应用骨架（完成）** | `SessionCoordinator`、状态机、per-window preload、contract validation、fake adapter | renderer 重载后快照一致；越权 IPC 和非法配置被拒绝；自动测试与默认/dev Electron smoke 通过 |
| **B2.0 恢复缺口（完成）** | canonical `CaptionState`（与 renderer 共用同一折叠实现）、caption 角色独占 `getCaptionState()`、订阅-水合-重放 bootstrap、replacement adapter 恢复游标（`resume: {attempt, sourceSequences}`） | reload 水合与实时流逐字段一致；现存双源交错 property fixture 只作底层隔离防御，不是产品能力；replacement 后首条字幕被接受并到达订阅者；stop/新会话/dispose 保留与清空语义有回归覆盖 |
| **B2.1 audio host 产品化（完成）** | Gate 0C 拓扑提取到 `src/runtime/audio-host/`：非持久化 session、最小权限 handler、专用 preload、AudioWorklet 48k→16k 1600 samples/100ms、有界诊断采集与指标落盘（`scripts/audio-host-smoke.js`） | 纯逻辑（resampler/assembler/metrics/policy）自动测试；实机 smoke 静音与 997Hz 信号两种情形 PASS（宿主全程隐藏、userGesture、0 gap、时钟覆盖 1.0）；未接 SessionCoordinator |
| **B2.2 PCM 直通与背压（完成）** | `MessageChannelMain` 直通：host → port → `pcm-sink` utility process；credit 背压（ready 握手 + 窗口式授信）、`FrameFlow` 有界队列（maxQueueMs 丢旧保新）、低频指标控制通道、`replacePort` 中途换消费端 | 实机 smoke 三模式 PASS：normal 40/40/40 帧 0 丢 0 缺口；slow 队列峰值恰好压在预算上、29 丢帧且 sink 观察到对应缺口；crash-replace 消费端 exit(13) 后替换 sink 无缝续流。PCM 不经主进程 JS；帧用结构化克隆（transferable 被桥丢弃，见 §4.2 修正） |
| **B2.3 realtime worker 骨架（完成）** | `src/runtime/realtime-worker/`：per-source 管线（帧→VAD 分段→recognizer adapter→contract-valid partial/final）、可替换 adapter 注册表（默认 `null`——Gate 0B 未过绝不产文本）、EnergyVad 占位（silero 随模型轨替换）、utilityProcess 入口沿用 B2.2 credit 协议、main 侧 `RealtimeWorkerHost`（边界契约校验） | 纯逻辑单测覆盖 VAD/分段/source 隔离/缺口指标/坏帧；多 source fixture 只是底层防御，产品会话仅启用一路；worker 事件全量通过真实 `SessionCoordinator.acceptCaption` 门（集成测试）；实机 smoke 传输与零字幕不变量 PASS，VAD 实音分段因系统静音判 inconclusive（有声复跑即补） |
| **B2 实时链路** | audio host、MessagePort、互斥单路 realtime worker、VAD/背压 | 真 partial/final 替掉假流；拖动不掉帧；队列深度和丢帧可观测。**模型轨已落地（2026-07-27）**：`sherpa-recognizer.js`（共享 OnlineRecognizer、per-segment stream、0.4s 尾静音冲刷）经 configure 注册；`model-resolver.js` 解析本机模型（env/userData/仓库布局，缺失 fail closed）；组合根默认接真实链路。**silero VAD 已替换 EnergyVad（2026-07-27）**：`silero-vad.js` 包装为同接口经 vadFactory 注入，997Hz 纯音拒识实测通过（能量占位做不到）；收句静音实测定为 1.0s——0.5s 切段时流式模型缺右上下文丢字（「一下」→「一」）且几乎不出标点，1.0s 下整句成段 CER 0。VAD 模型缺失时回退 EnergyVad 并警告。实机 smoke `i2-live-caption-smoke.js` PASS（silero：1 条整句定稿、CER 0；对比 energy：4 条碎片、CER 0.071）。**XOR 门禁与 J4 已完成（2026-07-30）**。剩余：两种来源分别 smoke、拖动/掉帧指标 |
| **B3 精修与会话** | refine worker、事件式持久化、恢复与导出 | 精修不阻塞实时流；已提交一遍定稿可恢复；SRT 时间轴稳定。**B3.1 已落地（2026-07-27，过渡实现）**：append-only JSONL 事件档（Windows-safe 文件名、排他创建防混档）、坏尾行/坏中间行区分恢复、按 revision 折叠、txt/md/srt 导出（毫秒进位正确、换行注入压平），main 接线为会话自动开/封档。**B3.2 refine worker 已落地（2026-07-27）**：独立 utility process 载离线 X-ASR（t=3，M3 同配置）；realtime worker 是 CaptionEvent 唯一序号权威——段定稿后整段音频经 worker↔worker MessagePort 直达 refine，纯文本结果回来后由 realtime worker 以 base+1 revision 发 refined；请求方有界队列（积压 3 即跳过，绝不反压实时）；精修配置失败/中途退出只降级告警不故障会话；暂停期精修缓冲、resume ack 后补发；停止路径 end 收束的段不发起精修（保持 final，计 skipped）。实机 smoke：final 无标点 → refined 全标点，双 CER 0。B3.3 的确定性实现见下一行，实机/发布门禁仍独立验收 |
| **B3.3 SQLite 字幕历史（实现完成/尚未实机验收）** | storage worker、SQLite 字幕事件/segments、JSONL 迁移、终态历史列表/详情与 txt/md/srt 导出 UI | DB0/DB1、Gateway 恢复与 DB2 迁移内核已通过；默认 `main.js` 以单实例锁和 `SubtitleApplicationRuntime` 切到 SQLite-only，按 stale-active→迁移→recorder 启动，并以有界 `before-quit` 收束。产品生命周期旅程覆盖两次冷启动/迁移；历史复盘旅程再覆盖 active 排除、mic partial/final/refined/stop、loopback XOR、倒序 keyset 分页、带时间戳详情、三格式主进程安全导出和无音频。真实 Electron 历史窗口、产品迁移/退出、I3 与打包态仍待验收 |
| **B4 字幕资源** | ModelManager、断点下载、校验、原子安装与删除保护 | 下载可续传/校验/原子安装；活跃模型不可删除；模型缺失可恢复 |
| **B5 字幕 MVP 分发** | electron-builder、NSIS、首启资源检查 | 干净 Win11 机器完成“安装→模型就绪→运行→真字幕→自动保存→历史查看” |
| **A1 Agent 基础（后置）** | `AgentRuntime` 边界、Pi Core 探针、项目自有 `AgentPluginHost`、CredentialStore、ModelGateway、可靠消费水位 | 只静态注册受信任第一方插件；不启用 shell/进程/任意文件写/外部写；key 不进 renderer；Agent 关闭/崩溃不影响字幕；J7/J13 通过 |
| **A2 Agent 内容能力（后置）** | `TranscriptContextPlugin`、独立增强文本、会后结构化纪要 | 原文与派生文本不混淆；待办只生成内容；字幕→Agent 通过 J3–J7/J13 联合场景 |
| **X1 可选检索（Deferred）** | FTS5 按需增加；embedding/`sqlite-vec` 最后评估 | 不阻断 B3.3、B5 或 A2；若启用再执行 J11/DB4 |

> 视觉/UI 层已交付 V1–V2；B1 已关闭 [docs/ui-design-brief.md §6](docs/ui-design-brief.md) 的 A1–A3 和 stop/retry 请求。A4 layout contract、历史、资源管理和权限入口仍按后续阶段推进。
> C 类是 UI 对后端的持续契约约束，违反时的症状是「界面上东西不见了」而不是报错；B1 的 coordinator 与 fake adapter 已遵守这些约束。

### 7.4 Integration Gates

| Gate | 汇合内容 | 验收标准 |
|---|---|---|
| **CI0 联合测试基线（进行中）** | 用户旅程跨越真实产品模块，而非只验证单个函数/类 | Windows workflow 已落地；真实 Electron Gateway 组合覆盖 Coordinator→Recorder→utility process→SQLite、XOR、pause/refine、stop barrier 与故障重放；确定性默认产品旅程覆盖 DB2、SQLite-only/stale-active/退出，历史复盘旅程覆盖终态查询与三格式安全导出。B3.3 仍须完成真实产品 UI smoke；J11 后置 |
| **I1 Contract（完成）** | UI fake adapter ↔ 后端 contract fixtures | coordinator、fake adapter、renderer reducer 和 IPC 共享 v1 validator；默认/dev smoke 均通过 |
| **I2 Live Caption** | 单路音频 → realtime ASR → SessionCoordinator → 字幕 UI | P50/P95 延迟、CPU、内存、队列深度达标，并完成 J4/J5/J6 联合场景。**I2.1 结构接线已完成（2026-07-27）**：`RealtimeRuntimeAdapter` 实现 B1 冻结接口组合 host/worker/port，coordinator 新增 adapter `onError` 故障入口；实机结构 smoke 覆盖 worker 击杀→error→retry→pause/resume→stop。**I2.2 真字幕已通**：2026-07-31 schema v2 loopback 实机 PASS——真实 160ms 模型 + silero + 离线精修得到 final/refined CER 0；captured/sent/ingested 帧数一致，零丢帧、零 sequence gap、零坏类型，并记录 CPU/工作集与字幕到达时序（`docs/validation/i2-loopback-results.json`）。runner 支持 `--source loopback|mic` 分开执行。**J4/XOR 与 J5/J6 确定性故障旅程已覆盖**。完整 I2 实机验收仍需物理 mic 报告、重复运行形成延迟 P50/P95 门槛、拖动不掉帧、设备变化/睡眠唤醒验证 |
| **I3 Durable Subtitle Session** | final/refined → SQLite 事件/投影 → 带时间戳历史/导出 | 连续 2 小时不卡；崩溃恢复不丢已一遍定稿的段落；JSONL 迁移通过 J10 |
| **I4 Packaged Subtitle MVP** | 首启、下载、权限、ASR、持久化、历史与退出清理 | 在干净 Win11 机器完成字幕系统完整用户旅程，断网且无 Agent 时仍成立 |
| **I5 Agent System（后置）** | committed transcript → TranscriptContextPlugin → Pi Loop → 增强/纪要插件 → 独立产物 → 历史展示 | J3–J7/J13 通过；Agent 失败、取消和恢复不影响 I2–I4 |

---

## 8. 产品决策与剩余待确认项

### 8.1 主场景是「听会议」还是「记自己说话」？（已拍板）

旧骨架曾默认 `mic: true, loopback: false`，暗示麦克风优先；但产品也强调会议系统声。Gate 0D 已移除这个隐藏默认值，新安装和旧配置迁移都必须先完成显式选择。

**决定：首启提供「会议字幕」和「个人听写」两个互斥预设。** 会议预设只开系统音频；个人听写只开麦克风。一次会话始终只允许一个 `sourceId`，运行中不能开第二路或换源，停止后才能切换模式。在用户完成选择前，`mic / loopback` 都为 false，不再用隐藏默认值替用户做产品决定。

Gate 0B 原门槛于 2026-07-27 经正式改判重设（见 `docs/validation/gate-0b.md` 改判节）：批准机器基线上发布 `fast` profile（x-asr-160ms + 离线精修）。`LIVE_SUBTITLE_DEV_MODEL=x-asr-480ms` 仍是仅供 B1 fake adapter 的开发开关，不加载真实模型，也不得进入生产默认配置；真实 profile 的发布以模型文件实际就位 + 机器基线满足为条件。

### 8.2 接受首启下载 ~400MB 吗？

**建议：接受，但分两步下。** 首启只拉 x-asr（~170MB）即可用；SenseVoice 二遍精修（~230MB）做成设置页里的可选增强。首次体验等待砍掉一半，精修从「入场门槛」变成「用着用着发现还能更准」。

若要求开箱即用 0 下载，就得砍到 `small-bilingual`（~50MB 级）并放弃二遍精修，准确率有肉眼可见的下降。

### 8.3 字幕 MVP 中“系统音频”具体是哪一路？（已拍板）

**决定：**“监听系统音频”固定指 `loopback`，是会议字幕主场景；保留 `mic` 单路个人听写。两者绝不同时运行，配置、UI、runtime 和 CI 都执行 XOR。

### 8.4 “记录回放”是文本复盘还是原始音频播放？（已拍板）

**决定：**只做带时间戳的文本复盘。产品现在及未来都不保存原始音频，不设计录音文件、音频路径、磁盘配额或文本↔音频 seek。

### 8.5 LLM“修饰”是否允许替换权威转写？（已拍板）

**决定：**原始 ASR/离线精修继续作为权威转写；LLM 结果保存为独立“增强文本”，声明输入水位、digest 和模型，永不覆盖原文。

### 8.6 Pi 复用到哪一层？（ADR 0003 已接受）

**决定：**以官方 Pi Agent Core/Loop 为底层，通过本项目 `AgentRuntime` 与 `AgentPluginHost` 适配；不引入完整 coding-agent CLI、TUI、shell/read/write 默认工具和它自己的会话权威。字幕系统保持独立，Pi 侧只装只读字幕上下文插件；增强文本与纪要是内容插件。具体取舍见 [ADR 0003](docs/adr/0003-project-owned-agent-plugin-host.md) 和 [调研说明](docs/agent-plugin-architecture.md)。

### 8.7 飞书式摘要的首个形态是什么？（已拍板）

**决定：**首个 Agent 验收目标是会后结构化纪要，固定栏目为概要、结论、待办、风险；会中滚动摘要后置。Agent 只生成内容，不自动执行任何外部待办。

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
| refined/translation 与可变单记录冲突 | 更新丢失、摘要重复或导出状态错误 | SQLite append-only 事件 + segments 投影，按 revision 折叠；旧事实不覆盖 |
| SQLite 与 JSONL 长期双写 | 两份权威数据漂移，故障后无法判定以谁为准 | J10 核对后一次性切换；JSONL 降为只读迁移/导出/恢复格式 |
| `sqlite-vec` 版本/打包加载失败（后期） | 可选语义搜索崩溃或返回过期向量 | X1 前不引入；启用时固定版本与可信路径并执行 DB4/J11；失败降级到普通历史 |
| 翻译请求打爆 API | 账单与限流 | segment 去重、有界保序队列、取消和超时 |
| 直接嵌入 Pi coding-agent 扩展运行时 | 引入 TUI/项目/JSONL 会话与完整系统权限，反转字幕生命周期 | 只用 Pi Core；项目自有 capability-based PluginHost；先做 ESM/Electron 探针 |
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
- Pi Agent Harness: https://github.com/earendil-works/pi
- Agent 插件架构调研: [docs/agent-plugin-architecture.md](docs/agent-plugin-architecture.md)
- 字幕窗实现细节: [docs/subtitle-window.md](docs/subtitle-window.md)
- 视觉/UI 模型交接边界: [docs/ui-design-brief.md](docs/ui-design-brief.md)
- 运行后端与契约: [docs/runtime-architecture.md](docs/runtime-architecture.md)
