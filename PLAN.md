# Live Subtitle Agent · Win11 实时字幕技术规划

> **Rev.15 · 2026-08-02**。初版调研 2026-07-23（版本号、模型名、体积经 GitHub Release API / npm registry / 下载解包核实）。
> 本次修订：J15a 固定高度逐行淘汰、J15b 不可变原始版/独立精修版和 J15c 精修可选化主体已达到确定性联合验收完成。当前源码已重建 B5：未签名 installer SHA-256 `4abc23bc4f0ab0307d551a5c59c834009d3d48953810f6c864c485db73db31de`；packaged test exe 首轮完成核心/精修分层、会话冻结、故障回退/工具条会话状态通知、跨会话版本导出和旧档迁移，第二进程在模型 fetch=0 下恢复两组 ready、偏好、历史和故障事实且不重放旧提示，两轮 clean exit。同一 run ID、四份报告 SHA 与 114 文件产品载荷 SHA `b6503ca2…a0bbd` 已绑定到正式 release layout。NSIS 机械探针只证明安装/卸载 exit 0、安装目录移除及无关 APPDATA 哨兵不变，不冒充正式应用 `userData` 保留。I3 非音频预资格覆盖 3,600 段/4,000 事件、虚拟两小时、72 页 DOM≤50、WAL/查询/CPU/内存/队列、三格式导出和重开恢复，但固定为 `pass/partial`，不冒充真实两小时音频 soak。I4 非音频专用机 runner、fixture、严格 verifier 与回归契约已完成；当前开发机不满足干净 profile 条件，故尚无执行报告，不能据此关闭 I4。
>
> 2026-08-01 音频窗口已执行：Gate 0C 通过；新的 loopback/mic 各五轮结构、准确率、自然退出和 transport 零丢失通过，但冻结 P95=1148/1099ms，仍超 `<1000ms` 线 148/99ms。真实 pause/refine 与 exact worker 硬终止+Retry 通过；DWM 持续字幕零丢失但缺操作者拖动 completion，只能判 inconclusive。I3 在 75 秒、故障前≥12/恢复后≥8/总计≥25 的不降线资格协议下，以 14/17/31 final 和 29 refined 严格通过；两小时验收仍待原生拖动后启动。设备移除、睡眠/唤醒和 I2 原生拖动仍待；干净 Win11 快照与代码签名按本轮内部 MVP 决定暂缓。`loopback`/`mic` 继续产品级 XOR，翻译/Agent 与向量继续后置。

> 2026-08-01 追加（B6 历史排期，已由下一条进度更新取代）：ADR 0004 的落地拆成 J15a（固定高度字幕流）、J15b（转写版本隔离）、J15c（精修可选化）三条旅程；当时只排入 J15a + J15b，所以该排期快照中的字幕 MVP 仍未齐。§8.2 的三资源原子 bundle 决定已被 ADR 0004 部分取代，见该节 superseded 提示。仓库根新增 [`AGENTS.md`](AGENTS.md) 作为改动前的文档路由表：全部文档读一遍约 11 万 token，路由表把单次改动的固定文档开销压到约 1.3 万，其中 `CONTEXT.md` 术语为每次必读、不可跳过。
>
> 2026-08-02 进度更新：上述排期快照已执行到 J15c。核心 ready 现只依赖实时 ASR+VAD，精修默认不下载；全局偏好按会话冻结，首次 `final` 与精修稿分版，下载取消→保留 `.part`→复启 fetch=0→明确继续 Range、故障回退、工具条会话状态通知、历史覆盖与本地日志均已进入真实 packaged 双启动旅程。J15a 又闭合了整段最后一条视觉行退出后的 identity-only renderer→main 回报与 canonical 永久淘汰，迟到修订、回退、窗口放大和 reload 均不得复活。DPI/主题/透明窗人工视觉、I4 专用干净机以及所有延期音频门禁仍未达到实机验收完成。
>
> 2026-08-03 远端状态纠偏：GitHub Actions run `30750568366` 在 revision `2242103eb917f2afbfe81c7c8df788852bb36ebc` 因 Electron runtime 未供给而止于首个字幕布局步骤。修复后的 run `30760407160` 精确绑定 revision `0d0cd9f91cfd5136bbd5d3fec44e636da04b4e21`，显式安装、`43.2.0` 前置版本校验、字幕布局与 DB0 均已执行，随后因 DB1 旧 fixture 未冻结精修偏好、仍按旧单投影读取精修稿而失败；该 smoke 已按不可变首次稳定转写/独立精修稿语义修正。相同 run 还证明点目录默认未被 upload-artifact 收集，当前 workflow 已显式包含 hidden files 并在无文件时 fail closed。上述修复为实现完成·尚未验收，仍需新 revision 的完整 workflow 与 provenance artifact。

---

## 0. 现状盘点

初版 PLAN 把 UI 排在 ASR 之后；目前 Gate 0A/0C/0D、视觉 V1–V2 和 B1 应用骨架已完成，真实音频/ASR 链路从 B2 开始。

| 已实现 / 已有确定性证据 | 尚未完成 |
|---|---|
| 四窗架构（字幕 / 工具条 / 设置 / 历史）、停靠与脱离；真实 Electron 产品壳旅程；mic 标签启发式声学 fixture 的真实 ASR 5 轮；真实 pause/refine | 透明窗人工视觉、原生拖动证明与真实两小时音频 soak |
| 锁定穿透、逐像素命中测试、主进程手动拖动 | 透明窗 DPI/人工视觉、设备变化与睡眠唤醒实机验收 |
| 配置持久化（`userData/config.json`）+ 四窗主题联动 | Agent 层（后置）；正式签名与外部发布身份按内部 MVP 决定暂缓 |
| 亚克力设置窗（含模型资源 pane）+ 单路模式 XOR 门禁/J4；schema-v6 两来源 I2 退出绑定五轮 P50/P95/资源/传输/跨时钟分段 bundle | loopback 性能与两来源 I2 交互/恢复场景 |
| B1 `SessionCoordinator`、状态机、per-window preload 与 contract-valid fake adapter | |
| Electron 生命周期：30s graceful + 5s exact-child reap、45s 字幕运行时升级触发线（ModelManager 5s 并行）；隐私安全 role evidence；真实 exact realtime worker 硬终止+Retry | `0x80000003` 的 native stack 级根因 |
| B2 audio host、PCM 直通/背压、realtime worker、**真实 160ms 模型 + silero VAD** | |
| B3 **二遍精修 refine worker** + SQLite-only/旧档迁移/历史导出；B4 资源闭环；当前 B5 ASAR/NSIS/native/packaged 双启动；I3 非音频 3,600 段预资格；I2 schema-v6 重复运行、pause/refine 与 worker crash/Retry 证据 | I2 延迟/原生拖动/设备与睡眠恢复、I3 资格及真实两小时音频；干净机 I4 本轮暂缓 |

**Gate 0B 已于 2026-07-27 正式改判通过**（批准 `x-asr-160ms` fast profile + 离线 X-ASR 精修，门槛重设留档于 `docs/validation/gate-0b.md` 改判节），**两遍链路已全部接通**。2026-07-31 的受跟踪 I2 权威 bundle 使用精确 Gate 0C（SHA-256 `0f9f7668751c64fbce922883421ead41680226126800e0b7f6b3da81b39840ef`），loopback/mic 各 5/5 结构通过、零 transport 损失且均绑定 exact-exit sidecar，冻结 P95=1158/1005ms。2026-08-01 当前机复跑 Gate 0C 和两来源各五轮，结构、准确率、自然退出、零损失仍通过，冻结 P95=1148/1099ms，仍未满足 `<1000ms`。相同实机窗口已让 loopback pause/refine 与 exact realtime worker 硬终止+Retry 通过；DWM 只取得持续 1,580 帧零损失，缺操作者 completion，设备移除与睡眠/唤醒也未执行。I3 75 秒资格 v5 取得故障前/恢复后/总计 14/17/31 final、29 refined 并严格通过，但两小时正式验收尚未启动。I2/I3 因此仍未关闭；Agent 在字幕闭环后启动，向量检索后置。

native 生命周期补丁后，真实模型活跃 smoke 连续三轮的六个 realtime/refine exact child 均优雅 `exitCode=0`、fatal 0；受跟踪 I2 的 10 轮又各自具备外部运行器生成并按 report SHA 绑定的 `exitCode=0`/无运行器终止旁证。2026-08-01 的真实 worker 强制终止场景进一步证明同一 session/cursor 在显式 Retry 后复用 runtime adapter 并创建新 worker generation，前后都有 final/refined 且损失计数为零。另一次非权威诊断在 pass 报告后悬挂并留下 `PostQueuedCompletionStatus: (6) 句柄无效。`；固定 libuv 源码只证明该失败路径会进入 `uv_fatal_error → DebugBreak`，没有 native stack 证明具体竞态、发送者或进程角色。一次性 runner 以 120 秒 exact-process timeout 防无限等待，超时只清理该 process object 并判失败；exit sidecar 与当前硬终止场景都不能证明历史异常根因已永久修复。完整 I2 仍需延迟、原生拖动、设备变化和睡眠/唤醒；I3 长测也未完成。role evidence 与报告不保存正文、音频/PCM、本地路径、绝对时钟、偏移、stack 或 dump。

> **B5 制品边界：**当前 exact installer SHA-256 已冻结为 `4abc23bc4f0ab0307d551a5c59c834009d3d48953810f6c864c485db73db31de`。它是未签名内部候选；本机 B5 已达到确定性联合验收完成，但不等于精确 release main 已在干净 Win11 上达到 I4 实机验收完成。

### 0.1 两套产品系统的边界

| 系统 | 独立承诺 | 输入 | 输出 | 失败边界 |
|---|---|---|---|---|
| **字幕系统（MVP）** | 点击运行后监听一个已选择来源，实时显示 ASR 字幕，自动保存定稿及时间戳，并可从历史查看复盘 | `mic` XOR `loopback` PCM | partial、final/refined、SQLite 字幕历史 | 首次供给完整模型需要网络；ready 后运行期不依赖网络、LLM、Agent Loop 或向量扩展；不保存原始音频 |
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
| 转写存储 | **SQLite 单一权威 + append-only 字幕事件 + segment 投影**；JSONL 仅作迁移解析/导出兼容 | 默认组合根、冷启动迁移、退出屏障、历史/导出、packaged 旧档 import/二次启动及 I3 非音频预资格已通过；真实两小时音频与干净机 I4 待完成，见 §6.4 / ADR 0001 |
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
- 设置页「模型资源」pane 固定展示实时 ASR、离线精修和 VAD 的状态、字节与总进度，只接受无参数下载/安全重试命令
- 校验失败必须能原地重来，不能只留一个半截文件
- 当前 MVP 不提供删除；renderer 不得提交 URL、hash、路径、资源 ID 或解压参数，Manager 只接受内置 manifest

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

历史详情已改为 SQLite keyset 分页，renderer 固定只持有当前 50 条并可前后翻批；真实 Electron 205 段旅程测得 DOM 上界 50。I3 非音频 runner 以 `FakeRuntimeAdapter` 注入契约合法事件，在同进程存储服务宿主上跑 `Coordinator→SQLite→HistoryService`，并在 VM DOM harness 中执行真实 `history.js`：3,600 段/4,000 事件、72 页 DOM 上界 50，重开后恢复 400 个 refined 投影，三格式各导出 3,600 段。CPU、RSS/heap、队列、WAL、查询与墙钟值由每轮报告动态记录；回归断言冻结资源上界与语义，不再把某次开发机快照硬编码为产品常量。该证据仍是虚拟两小时 `pass/partial`，没有创建 Electron `BrowserWindow`；真实两小时声源与长期 Electron 交互归 I3 音频实机验收。

### 6.5 Agent 层 —— Pi Agent Core + 项目自有插件宿主，后置实施

[earendil-works/pi](https://github.com/earendil-works/pi) 把低层 Agent runtime、统一 LLM provider 和编码 Agent UI/工具分包。已接受的选型是复用 `pi-agent-core`，不把完整 coding-agent CLI/扩展运行时嵌入 Electron；本项目在 core 外提供窄 `AgentPluginHost`，负责清单、静态注册、权限、生命周期、字幕水位、取消/重试、诊断和产物提交。

字幕系统本身不作为 Pi 插件；Agent 侧提供只读 `TranscriptContextPlugin`。`EnhancedTranscriptPlugin` 和 `MeetingMinutesPlugin` 是独立内容生成插件，只能经宿主的 `ModelGateway` 与 `ArtifactWriter` 工作。首版只加载随应用发布的受信任第一方插件，不做第三方安装、热重载或市场。

复用 Pi 前必须先做一个无 UI、无 shell/文件写工具的技术探针，验证包体、Electron utility process、取消、流式事件、provider 凭据注入和许可证归档。若探针不通过，保留 `AgentRuntime` 适配器并换实现，不影响字幕系统。

无论采用 Pi 还是自研，两个硬约束不变：

1. LLM 请求不能在可见 renderer 发起，API Key 永不进入 renderer。
2. API Key 用 Electron `safeStorage` 保护，绝不进入明文 `config.json`、字幕 SQLite、日志或模型上下文。

### 6.6 打包 —— electron-builder 26.15.3 + NSIS

正式候选固定 Windows x64、Electron `43.2.0`、sherpa wrapper/platform `1.13.4`，使用
单击式当前用户 NSIS、`asInvoker` 与 ASAR。`files` 是正向 allowlist：只包含
`package.json`、`src/**/*` 和生产依赖；工作区模型、测试、文档与产物绝不进入包。
模型安装在 `userData/models/`，SQLite 在 `userData/data/`。卸载默认保留 userData，
未来若增加“删除本地数据”必须是单独明确动作。

原生目录必须整体 unpack，而不是只挑 `.node`：

```json
"asarUnpack": ["node_modules/sherpa-onnx-win-x64/**/*"]
```

这样 `sherpa-onnx.node` 与 onnxruntime/sherpa 四个伴随 DLL 继续同目录。package verifier
不仅检查文件存在，还校验 ASAR `unpacked` 元数据；test package 再由 utility process 实际
`require('sherpa-onnx-node')`。正式包关闭 RunAsNode、NODE_OPTIONS 和 Node inspector，开启
embedded ASAR integrity 与 only-load-from-ASAR；`app.isPackaged` 时所有
`LIVE_SUBTITLE_*` 开发缝失效。

B5 与 I4 不再混写。B5 是可重复的打包态确定性资格；当前 test package 已用同一隔离
`userData` 连续启动两次，验证 ready 后 fetch=0 的复启、SQLite/旧档迁移/导出持久化；当前
NSIS uninstaller 也不触碰隔离 APPDATA 中与应用无关的哨兵；它未启动正式应用，不能证明真实 userData。I4 仍须用同 SHA 的精确 release main 在无仓库、
Node、既有 userData/模型的 Win11 上验公网、交互权限、真实音源及完整数据目录。
当前 B5 本机证据见 [`docs/validation/b5-packaging.md`](docs/validation/b5-packaging.md)。候选未签名，
仅作内部资格包。

### 6.7 测试 —— 单元、联合 CI 与实机验收分层

**项目级完成规则（2026-07-30 新增）：只有单元测试不能宣称功能完成。** 每项用户能力必须至少有一条跨模块用户旅程在 CI 中通过；涉及真实声卡、模型性能、透明窗口或长稳运行时，还必须补 Windows 实机 smoke/soak 证据。规范状态词、功能含义和禁止误读以 [`docs/semantic-contract.md`](docs/semantic-contract.md) 为准；详细分层、场景 ID 和摘要联动不变量见 [`docs/testing-strategy.md`](docs/testing-strategy.md)。

暂不上 Playwright：透明 + `focusable: false` + 点击穿透的窗口自动化驱动成本高，这部分继续用实机矩阵覆盖置顶、穿透、DPI、多屏、锁定和拖动。Hosted CI 使用确定性替身隔离声卡/公网，但 `SessionCoordinator`、Caption reducer、SQLite Gateway/Recorder、JSONL migration parser、队列和契约校验必须使用真实产品实现，不允许把整条链路全部 mock 掉。

自动化入口：

- `npm run test:integration`：每次 PR 必跑的跨模块用户旅程。
- `npm test`：完整回归集（也会发现 integration tests）。
- `npm run test:ci`：`npm test` 的 CI 别名，按 core → integration → evidence 只执行一遍，不重复联合旅程；由 Windows CI workflow 调用。
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
| **0C 音频拓扑（完成）** | 隐藏 audio host 的麦克风/回环、用户手势、AudioWorklet 48k→16k 实测；见 `docs/validation/gate-0c.md` | 回环挑战音命中、`physical-preferred` 标签启发式输入非静音、确定性 audioinput 探针通过；三路 16k mono PCM 无削波/帧缺口/大跳变，批准 hidden audio host；输入分类不构成硬件证明 |
| **0D 产品入口（完成）** | 首启提供「会议字幕 / 个人听写」双预设 | 2026-07-26 拍板：会议默认系统音频、听写默认麦克风；新安装在选择前两路都不暗中启用 |

Gate 0B 的固定复现入口：

```powershell
node scripts/gate-0b/run-cli-suite.js `
  --asset-root models/gate-0b `
  --private-transcript-output models/gate-0b/private/cli-observations.json `
  --output docs/validation/gate-0b-cli-observations.json

node scripts/gate-0b/evaluate-transcripts.js `
  --corpus scripts/gate-0b/corpus.json `
  --observations models/gate-0b/private/cli-observations.json `
  --output docs/validation/gate-0b-controlled-metrics.json
```

正文中间件只能写入受忽略的 `models/gate-0b/private/`；CLI 原始输出只在内存中解析并计算 SHA-256，不再提供任意目录落盘参数。

模型任一指标不达标 → 换 `160ms` 或退到 `small-bilingual` 重跑；UI 只根据新的 Capabilities 改可用档位，不直接绑定模型名。

### 7.2 视觉/UI 工作流

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **V1 设计基础** | 设计 token、组件状态、排版和 fixtures 展示页 | 深浅色、高对比度、键盘 focus、reduced motion 均有定义 |
| **V2 核心字幕** | 稳定 DOM + caption reducer；工具条完整运行状态 | 38px、长中英文原文、错误和恢复状态不溢出；不靠颜色单独传达状态。翻译 UI 后置到 Agent |
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
| **B3 精修与会话** | refine worker、事件式持久化、恢复与导出 | 精修不阻塞实时流；已提交 final 可恢复；SRT 时间轴稳定。B3.1 的 JSONL writer 完成迁移过渡职责后已从生产代码删除，只保留坏尾/坏中间行解析、revision 折叠与 txt/md/srt 兼容导出供旧档迁移。默认联合旅程已全部使用 `SqliteSessionRecorder → StorageGateway`。B3.2 refine worker、暂停缓冲、故障降级与真实模型 smoke 保持不变 |
| **B3.3 SQLite 字幕历史（非音频联合验收完成 / 音频 I3 与 I4 待验）** | storage worker、SQLite 字幕事件/segments、JSONL 迁移、终态历史列表/有界详情与 txt/md/srt 导出 UI | DB0/DB1、Gateway 恢复、DB2、两次冷启动、历史/导出均有确定性证据；packaged Electron 首轮真实迁移只读旧 JSONL 并完整导出 205 段，第二轮验证幂等、SQLite/history/导出保留。I3 非音频 3,600 段资源资格通过。人工系统保存对话框、真实两小时声源和干净机 I4 仍待 |
| **B4 字幕资源（确定性 UI 联合验收完成；真实模型调用有证据；I4 待验）** | 内置固定 manifest、ModelManager、断点下载、流式 SHA、固定 System32 tar、归档审查/白名单提取、staging 原子安装、严格 marker、资源页与空闲热启用 | 核心字幕资源已拆为实时 ASR+VAD 两个 marker，可选精修使用独立 marker。设置页提供核心下载、精修独立下载/取消/继续与全局偏好；缺失精修点开关 fetch=0、安装后仍关闭、再次明确开启才影响未来会话。局部失败矩阵、主进程 IPC、renderer、受控 J14 与 packaged 首启/复启均有证据；真实公网资源与干净机仍归 I4。 |
| **B5 字幕 MVP 分发（当前候选确定性联合验收完成；I4 待验）** | electron-builder 26.15.3、ASAR allowlist/fuses、native unpack、packaged 双启动、NSIS、CI provenance | 当前未签名 NSIS SHA=`4abc23bc…b31de`；168 个 ASAR 条目、114 文件产品载荷 SHA=`b6503ca2…a0bbd`、29 个关键入口、5 个 native、无模型/音频/开发树。test package 首轮覆盖核心安装、精修下载中取消/连接关闭/合法 `.part` 保留、会话冻结、跨会话版本导出、迁移与历史；复启先证明 fetch=0，再由明确继续触发精确 Range、安装后显式开启，并覆盖精修故障回退、工具条会话状态通知和历史复读。两轮 clean exit；七份报告以 run ID 和 SHA 闭合绑定到 release layout。NSIS 隔离安装卸载和无关 APPDATA 哨兵通过。最终 CI provenance writer/verifier 为实现完成·尚未验收：只在 `HEAD==GITHUB_SHA`、受跟踪工作树干净且全部前置门禁成功后，绑定 revision/run、lockfile/workflow、installer 与关键报告 SHA。run `30760407160` 已通过 Electron runtime、字幕布局与 DB0 前置门禁，但因 DB1 旧 fixture 与独立精修版本语义漂移而未进入 B5；当前修复仍待远端复验。正式应用 `userData` 保留及干净机 I4 尚未达到实机验收完成。 |
| **B6 固定高度字幕流与转写版本（确定性主链完成）** | J15a：字幕窗使用固定 bounds 的连续字幕流（CSS 底部锚定 + 顶部整行淘汰，容器高度取整到整行）；最后一条视觉行退出后，renderer 只回报 schema/会话/段身份，主进程从 canonical 实时视图永久淘汰该段，本会话迟到修订、故障回退、窗口放大和 reload 均不得复活。J15b：首次 `final` 与精修稿版本隔离，历史详情一次返回两版、导出按版本参数分别核对 digest；版本选择按当前会话作用，切换会话重置原始版。J15c：核心/精修资源拆分；全局精修偏好只影响未来新会话且不删除旧稿；下载支持明确取消/继续；迟到精修只更新仍可见 final；worker 故障确认时立即恢复所有仍可见 final、保持当前 partial 和固定 bounds，本会话不重启/补跑且不修改全局偏好；正常停止后工具条显示无抢焦点的会话状态通知并链接历史，该通知只报告处理状态、不概括或改写字幕内容，保持到关闭/进入历史并在新会话清除、重启不重放；独立五值故障事实和整场 `N/M` 跨重启保留，`N=M` 不掩盖故障；空会话、旧会话和异常退出分别保留明确语义；不完整回退统一标记 `[原始版回退]`；日志按 5×1 MiB/7 天本地滚动且不自动上传 | J15a/J15b/J15c 已达到确定性联合验收完成：固定整行视口、逐行淘汰、identity-only viewport eviction、canonical replacement/reload 与迟到修订/回退不复活有 reducer、IPC、真实 Chromium 和产品壳证据；首次 `final` 锚定、双版本 digest、会话作用域选择和真实 packaged 跨会话导出已完成；核心/精修分层、全局偏好与会话冻结、故障恢复、schema v2 会话结果、`N/M`、空/零/旧会话语义、工具条会话状态通知和滚动日志均有局部及跨模块证据。真实 packaged 双启动覆盖下载中取消、连接关闭、合法 `.part` 保留、复启 fetch=0、明确 Range 继续、故障静默期、main→IPC→toolbar 通知、历史复读与不重放。DPI/主题/透明窗人工视觉、I4 专用干净机与延期音频门禁尚未达到实机验收完成。CI 继续在失败时上传 `.artifacts` 报告与日志 |
| **A1 Agent 基础（后置）** | `AgentRuntime` 边界、Pi Core 探针、项目自有 `AgentPluginHost`、CredentialStore、ModelGateway、可靠消费水位 | 只静态注册受信任第一方插件；不启用 shell/进程/任意文件写/外部写；key 不进 renderer；Agent 关闭/崩溃不影响字幕；J7/J13 通过 |
| **A2 Agent 内容能力（后置）** | `TranscriptContextPlugin`、独立增强文本、会后结构化纪要 | 原文与派生文本不混淆；待办只生成内容；字幕→Agent 通过 J3–J7/J13 联合场景 |
| **X1 可选检索（Deferred）** | FTS5 按需增加；embedding/`sqlite-vec` 最后评估 | 不阻断 B3.3、B5 或 A2；若启用再执行 J11/DB4 |

> 视觉/UI 层已交付 V1–V2；B1 已关闭 [docs/ui-design-brief.md §6](docs/ui-design-brief.md) 的 A1–A3 和 stop/retry 请求。历史与资源管理入口已接产品 contract 并通过开发态/打包态 Electron 旅程；A4 实际 overlap rect 已降为 MVP 后交互质量项，当前最坏情况洞不阻断验收；长列表/无障碍的两小时稳定性按 I3 推进，精确 NSIS 的干净机发布旅程按 I4 推进。
> C 类是 UI 对后端的持续契约约束，违反时的症状是「界面上东西不见了」而不是报错；B1 的 coordinator 与 fake adapter 已遵守这些约束。

### 7.4 Integration Gates

| Gate | 汇合内容 | 验收标准 |
|---|---|---|
| **CI0 联合测试基线（持续维护）** | 用户旅程跨越真实产品模块，而非只验证单个函数/类 | Windows workflow 已落地；真实 Electron Gateway 组合覆盖 Coordinator→Recorder→utility process→SQLite、XOR、pause/refine、stop barrier 与故障重放；确定性默认产品/历史旅程覆盖 DB2、SQLite-only/stale-active/退出、205 段 keyset 详情与不截断三格式导出；开发态及 packaged 产品壳覆盖真实 main/preload/IPC/renderer 五页往返和 DOM≤50。J14/B5 从真实 settings DOM 点击覆盖 `preload/IPC→ModelManager→HTTP/tar→热启用→字幕→SQLite 历史`，B5 再覆盖 ASAR/native/NSIS；J11 后置 |
| **I1 Contract（完成）** | UI fake adapter ↔ 后端 contract fixtures | coordinator、fake adapter、renderer reducer 和 IPC 共享 v1 validator；默认/dev smoke 均通过 |
| **I2 Live Caption（重复运行、pause/refine、worker crash/Retry 已验；整体未关闭）** | 单路音频 → realtime ASR → SessionCoordinator → 字幕 UI | 受跟踪权威 bundle 的 loopback/mic 各五轮均有 schema-v5 child + exact-exit sidecar + schema-v6 series，冻结 P95=1158/1005ms。2026-08-01 本机复跑同样 5/5 结构/准确率/零损失通过，但冻结 P95=1148/1099ms；两来源仍高于 `<1000ms`。真实 loopback pause/refine 与 exact worker 强制终止+Retry 已通过；DWM 持续 1,580 帧零损失但无操作者 completion，实际设备移除和 Windows 睡眠/唤醒未执行。mic 仍只是 physical-preferred 标签启发式。完整 I2 尚缺延迟、原生拖动及设备/睡眠恢复。 |
| **I3 Durable Subtitle Session（非音频与真实资格完成 / 正式长测未跑）** | final/refined → SQLite 事件/投影 → 带时间戳历史/导出 | 3,600 段虚拟两小时已验证资源上界、72 页 DOM、完整导出和重开恢复；`gateStatus=partial`。75 秒真实 loopback 资格 v5 在 30 秒强退 worker 后恢复，取得 pre/post/total=14/17/31 final、29 refined，SQLite/导出/资源/transport/worker/storage 恢复全部严格通过且零捕获音频文件。仍需 7,200 秒/3,000 final 正式验收及运行期操作者原生拖动。 |
| **I4 Packaged Subtitle MVP（已决定）** | 精确 NSIS 的干净机首启、公网下载、权限、真实 ASR、持久化、历史、离线复启与卸载数据策略 | 非音频 runner/verifier 已能在无仓库/Node/既有 userData/模型的专用 Win11 标准用户中验证同一 installer SHA 的公网首下、断网历史/原生导出、正式 userData 保留及离线重装；该非音频子门禁为实现完成·尚未验收，尚无该环境的执行报告。来源分开的 `loopback`/`mic` 音频 child、strict summary 与移交包要求已决定但尚未实现；只有非音频报告和两个音频 child 全部绑定同一候选并通过严格 summary，才能达到发布验收完成。 |
| **I5 Agent System（后置）** | committed transcript → TranscriptContextPlugin → Pi Loop → 增强/纪要插件 → 独立产物 → 历史展示 | J3–J7/J13 通过；Agent 失败、取消和恢复不影响 I2–I4 |

---

## 8. 产品决策与剩余待确认项

### 8.1 主场景是「听会议」还是「记自己说话」？（已拍板）

旧骨架曾默认 `mic: true, loopback: false`，暗示麦克风优先；但产品也强调会议系统声。Gate 0D 已移除这个隐藏默认值，新安装和旧配置迁移都必须先完成显式选择。

**决定：首启提供「会议字幕」和「个人听写」两个互斥预设。** 会议预设只开系统音频；个人听写只开麦克风。一次会话始终只允许一个 `sourceId`，运行中不能开第二路或换源，停止后才能切换模式。在用户完成选择前，`mic / loopback` 都为 false，不再用隐藏默认值替用户做产品决定。

Gate 0B 原门槛于 2026-07-27 经正式改判重设（见 `docs/validation/gate-0b.md` 改判节）：批准机器基线上发布 `fast` profile（x-asr-160ms + 离线精修）。`LIVE_SUBTITLE_DEV_MODEL=x-asr-480ms` 仍是仅供 B1 fake adapter 的开发开关，不加载真实模型，也不得进入生产默认配置；真实 profile 的发布以模型文件实际就位 + 机器基线满足为条件。

### 8.2 接受首启下载约 270.9MB 的完整本地 bundle 吗？（旧决定 · 2026-08-01 已被 ADR 0004 部分取代）

> **Superseded 提示：**本节以下两段描述的是 ADR 0004 之前的旧候选。[ADR 0004](docs/adr/0004-immutable-first-pass-and-optional-refinement.md) 与 `SEM-F17` 已接受新的边界——**核心字幕 ready 只依赖实时 ASR 与 VAD；离线精修改为默认不下载、由未监听状态下明确用户动作按需安装的可选资源，缺失或失败只降级精修能力。**新的实现与验收按 J15c 执行，本轮不做。保留下文只为记录旧决定及其证据，**不得据此写测试，也不得再用"三项资源缺一不可"阻塞默认字幕**。

**决定：接受，且一次性安装完整三资源 bundle。** 当前固定 manifest 包含实时 X-ASR（133,898,007 字节）、离线 X-ASR 精修（136,396,739 字节）和 silero VAD（643,854 字节），合计 **270,938,600 字节**。设置页以一个下载/重试动作展示总进度和三项资源状态；只有三项均通过字节数、SHA-256、归档白名单与 ready marker 校验后，`ModelManager` 才能发布 `ready`，应用才会热启用真实字幕运行时。

离线精修**不是**当前产品里的可选增强，也不存在“只下实时 ASR 就允许开始”的降级承诺：缺任一资源时字幕 start 必须保持不可用。全新安装首次取得三资源 bundle 需要网络；只有完整 ready 后才承诺断网运行。若未来要改为分层下载或首启 0 下载，须先修改 `SEM-F17`、J14/J9-I4 旅程及相应 manifest/运行时原子性，而不能由 UI 单方面显示成可选项。

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
| `.node` 打进 asar 或伴随 DLL 不相邻 | 安装版启动即崩，开发期发现不了 | B5 已整目录 `asarUnpack`、结构检查并由 packaged utility 实际加载；I4 再在干净机复跑 |
| 两小时会话 DOM 膨胀 | 历史面板卡死 | 3,600 段非音频预资格已验证 72 页 DOM≤50、WAL/查询/CPU/内存/队列上界；真实两小时音频与 BrowserWindow 长期交互仍待 |
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
