# Live Subtitle + Agent

一个由两套能力协作组成的 Win11 桌面产品：**字幕系统**以互斥的 `loopback` 会议字幕或 `mic` 个人听写为输入，负责本地实时 ASR、字幕、自动保存和带时间戳历史；后置的 **Agent 系统**再消费已提交字幕，通过 Pi Agent Core 与第一方插件生成独立增强文本和会后结构化纪要。Agent 只生成内容，不执行外部操作；关闭或失败时，字幕系统仍独立完整工作。产品现在及未来都不保存原始音频。

当前已完成 **B1 应用骨架 + B2 实时链路 + B3 两遍精修/SQLite 历史 + B4 本地模型资源闭环 + B5 打包态确定性资格 + 来源 XOR 联合门禁**：透明字幕条、工具栏、点击穿透、亚克力设置窗、单选监听模式、权威会话状态机、隐藏采集窗（回环/麦克风）、realtime/refine/storage utility，以及 Gate 0B 批准的 **160ms 真实模型 + silero VAD + 离线精修**。首次缺模型时可从设置的“模型资源”页一键下载固定三资源 bundle，支持断点续传、哈希/归档审查、原子安装；空闲应用安装后无需重启即可开始真字幕。字幕自动写入 SQLite，工具条可打开独立历史窗查看带时间戳正文并导出 txt/md/srt。

B5 已生成 Windows x64 ASAR/NSIS，并从真实 packaged exe 复跑设置下载、热启用、字幕、暂停/恢复、停止、SQLite 历史、205 段分页、sherpa native utility 与 clean exit；精确 NSIS 的隔离安装/卸载也通过。当前 I2 权威 bundle 由 **schema-v5 child report + schema-v1 外部退出旁证 + schema-v6 series** 组成：loopback 与 `physical-preferred-label-heuristic` 声学 mic fixture 各有 5 份 report、5 份一一绑定的 exit sidecar 和 1 份 series，10 轮均由外部运行器观察到 exact child `exitCode=0` 且未触发运行器终止。10 轮都有 final/refined、帧全等、12 项丢失峰值全为 0；loopback 最大 final/refined CER 为 0/0，mic 为 0.035714/0。冻结字幕可见延迟 P50/P95/min/max：loopback 1133/1158/1092/1158ms，mic 875/1005/822/1005ms；两者 P95 分别高于未改变的 `<1000ms` 线 158ms 与 5ms，因此 I2 性能未关闭，交互/恢复场景也仍待。final-after-end P95 分别为 710/792ms；六段跨时钟诊断 P95 分别为 loopback 729/405/1/33/1/1ms、mic 557/500/1/28/1/1ms，它们不改变验收起点、终点或门槛。B5 exact installer/SHA 属于前一候选 `369055a`；本阶段已修改生产 audio-host/runtime，所以旧制品不代表新 HEAD，进入 I4 前必须重建、重取证并冻结新 SHA。测试 package 仍不能冒充 I4；I2 性能/交互/恢复、两小时长稳、干净 Win11 公网/权限/ready 后离线复启仍待。Agent/翻译未实现，向量检索已后置。

针对用户看到的 `electron.exe / 0x80000003`，当前没有 dump、发生时间或 native stack。现场 stderr 与固定 Node/libuv 源码只证明了 `PostQueuedCompletionStatus(6) → uv_fatal_error → DebugBreak` 能直接产生该异常的即时机制；具体关闭竞态、发送者和进程角色仍没有调用栈级证明。批准模型活跃诊断的六个 realtime/refine 子进程均优雅 `exitCode=0`、fatal 为 0；当前权威 I2 的 10 轮又分别绑定了外部观察的 exact child `exitCode=0`/无运行器终止旁证。另有一次未纳入权威 bundle 的运行，在报告 `pass` stdout 完成后悬挂，正是退出旁证要排除的误绿情形。sidecar 只证明本轮内部 `pass` 后没有悬挂到超时或被运行器终止，不是签名、远端执行、硬件身份、硬崩溃恢复或历史异常根因证明；开发态与打包态的 clean exit 也不能声明异常已永久修复。详见 [Electron breakpoint 调查](docs/validation/electron-breakpoint-investigation.md)、[I2 exit-bound bundle](docs/validation/i2-real-source-series.md)和 [B5 打包证据](docs/validation/b5-packaging.md)。

## 运行

仅支持 Windows x64：依赖 `sherpa-onnx-win-x64`（平台门控的 N-API 预编译包），其他平台 `npm install` 会以 EBADPLATFORM 失败。

```bash
npm install
npm start
```

`npm start` 通过 exact-child supervisor 启动 Electron，并原子覆盖一份仅供本机诊断的
`last-exit-evidence.json`。该报告只记录固定枚举的生命周期、进程角色、退出原因与状态码
分类；不保存字幕正文、音频/PCM、本地路径、stack、dump，也不上传外部服务。

Gate 0B 已于 2026-07-27 正式改判通过（批准 `x-asr-160ms` fast profile + 离线 X-ASR 精修；门槛重设理由与适用条件留档于 [docs/validation/gate-0b.md](docs/validation/gate-0b.md) 改判节），真实 recognizer 已接入 realtime worker：

- **模型就位**（产品默认只信任 ModelManager 在 `userData/models/` 写入的严格 ready marker）→ 启动发布 `fast` profile，工具条开始录制即出**真字幕**。
- **模型缺失** → capabilities 保持不可用（fail closed），不伪造。

仓库开发布局或 `LIVE_SUBTITLE_MODEL_DIR` 等显式路径不会再静默遮蔽“下载模型”入口。仅在开发者明确接受外部模型资源时启用：

```powershell
$env:LIVE_SUBTITLE_ALLOW_EXTERNAL_MODELS='1'
npm start
```

所有 `LIVE_SUBTITLE_*` 开发缝在 packaged 应用中强制失效，不能用环境变量绕过正式
ModelManager 的 userData ready marker。

开发 B1 状态流仍可显式启用 fake runtime 映射（不加载真实模型，且会绕过真实模型路径）：

```powershell
$env:LIVE_SUBTITLE_DEV_MODEL='x-asr-480ms'
npm start
```

测试按“局部回归 / 联合 CI / 实机验收”分层；单元测试通过不等于功能完成：

```powershell
npm run test:integration # 会议回环、麦克风用户旅程的跨模块一致性
npm run test:ci          # CI 门禁：联合旅程 + 完整回归
```

打包入口（内部候选尚未签名）：

```powershell
npm run package:smoke    # 与正式 ASAR/native 布局相同的测试 package
npm run package:release  # Windows x64 NSIS 候选
```

正式包只包含产品源码与生产依赖；模型不进入安装包。全新安装首次取得完整
270,938,600 字节三资源 bundle 需要网络，三项严格 ready marker 成立后才承诺断网且无
Agent 时字幕、SQLite 保存和历史继续可用。默认卸载移除程序、快捷方式和卸载登记，保留 userData 中的模型、
配置和字幕历史。证据边界见 [B5 打包态确定性资格](docs/validation/b5-packaging.md)。

I2 来源验收必须把两个来源分开运行；报告只保存结构化指标，不保存现场音频：

```powershell
.\scripts\run-electron-smoke.ps1 `
  -EntryPoint scripts\i2-live-caption-smoke.js `
  -EntryArguments @('--source', 'loopback', '--report', '.artifacts\i2-live\loopback.json')
.\scripts\run-electron-smoke.ps1 `
  -EntryPoint scripts\i2-live-caption-smoke.js `
  -EntryArguments @('--source', 'mic', '--listen-seconds', '12', '--report', '.artifacts\i2-live\mic.json')
```

自动 mic 声学 fixture 先运行 memory-only Gate 0C，再按匿名标签哈希要求唯一匹配同一输入；这能防止预检后静默换标签，但只是 `physical-preferred` 标签启发式，不是硬件证明，也不能排除未知或伪造标签的虚拟设备。当前权威分位证据固定为每个来源恰好 5 轮：

```powershell
.\scripts\run-i2-live-series.ps1 -Source loopback -RunCount 5 `
  -OutputDirectory .artifacts\i2-live-series
.\scripts\run-i2-live-series.ps1 -Source mic -RunCount 5 `
  -OutputDirectory .artifacts\i2-live-series `
  -PhysicalMicPreflight .artifacts\gate-0c\report.json
```

本地 Electron smoke 必须经上述启动器隐藏启动、等待自然退出并保留 stdout/stderr；只有外部运行器观察到 exact Electron child `exitCode=0` 且从未触发超时终止，series 才能生成并接受绑定 report SHA 的 schema-v1 exit sidecar。child report 即使写出 `pass`，缺少、错绑或重复旁证也必须 fail closed。native
worker 先等待最多 30 秒优雅退出，超时后只终止并收殓该 exact child（最多再等 5 秒）。字幕
应用运行时以 45 秒作为优雅收束结束/升级触发线，ModelManager 的 5 秒收束与其并行；升级后仍
必须等待 exact child 收殓，所以 45 秒不是无视子进程状态的硬退出上限。不要用
`electron.exe --help` 探测运行时，也不要按进程名结束仍在验证中的 Electron。

`mic` 的 operator 模式只显示 `promptId`，请朗读 `scripts/gate-0b/corpus.json` 中对应 case 的冻结 reference；自动 series 使用同轮 Gate 0C 的匿名输入/输出标签哈希和声学回放 fixture。两种模式的终端和报告都不回显转写正文。权威证据是 [`docs/validation/i2-live-v5/`](docs/validation/i2-live-v5/) 内精确 tracked Gate（SHA-256 `0f9f7668751c64fbce922883421ead41680226126800e0b7f6b3da81b39840ef`，runId `gate-0c-2026-07-31T09-52-00-521Z`，executedAt `2026-07-31T09:52:13.999Z`）、每来源恰好 5 个 schema-v5 child、5 个 schema-v1 exit sidecar 和 1 份 schema-v6 series。严格递归校验、runner 自校验与 CI byte-for-byte 重建共同防止证据漂移；这些本地 JSON 不是签名或远端证明。每个 child 还将同一 exact accepted partial 拆为六段只诊断区间，不改变冻结验收值。受控播放先校准三个远端时钟，再以同一未来 `source t0` 安排播放和探针；captured-energy 诊断另有公开的 40ms post-source guard，仅排除前置环境声/时钟不确定区，绝不移动冻结的 `source t0 + 140ms` 验收起点。语料 WAV 由受跟踪的 generator/reference 本地生成并被 Git 忽略；报告绑定生成 WAV 与 reference 的摘要。完整 I2 仍需关闭两来源性能并完成真实 pause/refine、拖动、设备变化、睡眠/唤醒和硬崩溃恢复。

字幕 MVP 与后续“字幕 → Agent”的联合验收见 [docs/testing-strategy.md](docs/testing-strategy.md)；功能含义、禁止误读与“完成”口径以 [docs/semantic-contract.md](docs/semantic-contract.md) 为准。

## 已实现（骨架）

- **双窗架构**：字幕窗 + 工具条窗两个独立透明窗（穿透是整窗属性，锁定态要「字幕穿透 + 工具条可控」只能拆窗）
- **默认嵌入**：工具条停靠在字幕卡右上角内部，跟随字幕窗移动，看上去是一体
- **锁定 🔒 脱离**：字幕卡钉桌面 + 鼠标穿透（黄边 + 「已钉住」提示）；工具条脱离停靠、独立浮动可拖可控
- **各自拖动**：未锁定拖任一部分移动整个单元；锁定后工具条可独立拖到全屏任意位置
- **自动变淡**：工具条不用时淡出（0.35），鼠标靠近 / 录制 / 锁定时提亮
- **完整运行态**：工具条由 `RuntimeSnapshot` 驱动，命令经 `CommandResult` 回执，覆盖启动、暂停、恢复、停止与重试
- **平滑拖动**：主进程轮询光标手动 `setBounds`（~120fps），不用 app-region
- **解锁两路**：工具条 🔒、`Ctrl+Alt+L` 全局快捷键（锁定态字幕卡不可点）
- **设置 ↔ 字幕条实时联动**：字号 / 不透明度 / 圆角 / 主题改动即时生效，持久化到 `userData/config.json`；翻译属于后置 Agent，MVP 不展示伪开关
- **设置窗**：独立第三窗，Win11 真·亚克力（`titleBarStyle:'hidden'` + `backgroundMaterial:'acrylic'`，`resizable:false` 防拖动误缩放）
- **模型资源页**：固定展示实时 ASR、离线精修和 VAD 的状态/进度，只提供下载或安全重试；renderer 不能提交 URL、hash、路径或解压参数
- **文本历史窗**：工具条“历史记录”打开独立可缩放窗口；只列出已结束/中断会话，显示相对时间与墙钟时间，读取 SQLite 当前正文投影并由主进程安全导出 txt/md/srt；没有录音或音频回放能力
- **主题**：跟随系统深浅色（`nativeTheme`）
- **Gate 0D 首启**：显式选择「会议字幕」或「个人听写」；选择前两路均关闭，一次会话只允许启用一路
- **最小权限桥接**：caption / toolbar / settings / history 使用独立 preload，主进程按窗口角色和 main frame 校验 IPC；history renderer 不能传 SQL、数据库路径或任意导出目标路径
- **B1 fake adapter**：字幕只接收 `SessionCoordinator` 发布的 `CaptionEvent`，renderer 不再自造假流

## 规划边界

- **字幕系统（MVP）**：`loopback`/`mic` 互斥采集、ASR、字幕显示、定稿/精修、SQLite 文本持久化、带时间戳历史、模型资源和离线可用性；永不保存原始音频。
- **Agent 系统（后置）**：只消费已提交字幕；已决定采用 `pi-agent-core + AgentPluginHost`，由只读字幕上下文插件、增强文本插件和会后纪要插件组成。只生成内容，不复用 coding-agent 的 TUI、shell/文件工具或会话存储。
- **可选检索（Deferred）**：FTS5 可按历史搜索需求增加；embedding/`sqlite-vec` 不阻断字幕 MVP 或首版 Agent。
- **视觉/UI**：字幕、工具条、设置/历史/首启的布局、样式、动效、文案和无障碍，可交给擅长视觉的模型独立设计。
- **Electron 壳层**：窗口、拖动、穿透、最小权限 preload、IPC 校验和会话状态机。
- **运行后端**：audio host、实时/精修 ASR workers、模型、会话、凭据和 AI provider。
- 三层只通过 `RuntimeSnapshot / CaptionEvent / CommandResult / Capabilities` 协作；UI 不读取模型、存储或密钥实现。
- Gate 0A 的 v1 字段、运行时校验器和模拟数据已固化在 [`src/contracts/`](src/contracts/README.md)，B1 UI 与 fake adapter 已按同一契约接线。

视觉模型的文件白名单、状态 fixtures 和交接要求见 [docs/ui-design-brief.md](docs/ui-design-brief.md)；后端职责、状态机和数据流见 [docs/runtime-architecture.md](docs/runtime-architecture.md)。统一领域术语见 [CONTEXT.md](CONTEXT.md)，SQLite 与 Agent 派生数据目标设计见 [docs/data-architecture.md](docs/data-architecture.md)、[ADR 0001](docs/adr/0001-sqlite-authoritative-event-store.md)、[ADR 0002](docs/adr/0002-separate-subtitle-and-agent-systems.md) 和 [ADR 0003](docs/adr/0003-project-owned-agent-plugin-host.md)。插件调研与取舍见 [docs/agent-plugin-architecture.md](docs/agent-plugin-architecture.md)。

## 结构

```
src/
  main.js              主进程组合根：四窗管理、IPC 校验、配置与会话协调
  config.js            配置存储入口；实现位于 main/services/config-store.js
  main/
    ipc/               通道名与按窗口角色访问策略
    session/           SessionCoordinator、状态机与 fake runtime adapter
  preload/             caption / toolbar / settings / history 四个最小权限桥
  ui/shared/
    tokens.css         四窗共享的 design token：色彩/字阶/形状/阴影/动效 + 主题切换
  contracts/           Gate 0A：v1 契约、运行时校验器与跨层 JSON fixtures
  caption/             字幕窗
    index.html · caption.css · caption.js     命中测试 + 拖动 + 锁定穿透 + CaptionEvent 渲染
  toolbar/             工具条窗
    index.html · toolbar.css · toolbar.js     命中测试 + 拖动 + 按钮 + 锁定/录制视觉
  settings/            设置窗
    settings.html · settings.css · settings.js  控件 ↔ 配置双向绑定
  history/             终态会话列表、带时间戳文本复盘与 txt/md/srt 导出 UI
```

## 下一步

见 [PLAN.md](PLAN.md)（Rev.13）：来源互斥、默认 SQLite-only 生命周期、文本历史/导出、ModelManager、真实产品壳、B5 打包态资格及 I2 schema-v6 退出绑定重复运行证据已通过各自门禁；但 I2 本身仍未关闭。当前按 I2 loopback 性能/两来源交互与恢复 → I3 长稳 → I4 精确 NSIS 的干净 Win11 发布验收闭环字幕 MVP。之后才做 Pi Core/Electron 隔离探针、项目自有插件宿主、独立增强文本和会后结构化纪要；向量检索最后评估。任何能力都必须有跨模块用户旅程，不能只交单测。

- 窗口壳和交互不变量：[docs/subtitle-window.md](docs/subtitle-window.md)
- 视觉/UI 模型交接：[docs/ui-design-brief.md](docs/ui-design-brief.md)
- 运行后端与契约：[docs/runtime-architecture.md](docs/runtime-architecture.md)
- 功能与验收语义表：[docs/semantic-contract.md](docs/semantic-contract.md)
- 本地数据架构：[docs/data-architecture.md](docs/data-architecture.md)

## 已知事项

- 亚克力设置窗依赖 Win11（Build 22000+）；旧系统会回退为普通窗口。
- `transparent` 窗口开 DevTools 时透明会临时失效，属 Electron 已知限制。
- 识别 profile 由 Capabilities/会话状态约束：本机模型就位才发布 `fast`，缺失即不可用，不伪装。VAD 已是 silero 真实人声检测（整句成段、纯音/噪声拒识）；silero 模型缺失时回退能量占位并在控制台警告（字幕仍真实，分段降级）。定稿出现在说话停顿约 1 秒后，这是实测定的收句参数（更短会丢字）。

## 关键技术决策

- **会话数据**：目标采用 SQLite 单一权威、append-only 字幕事件和 segments 投影；JSONL 在 B3.3 迁移后只作导入导出/恢复，禁止长期双写。Agent 派生数据不得覆盖字幕事实，`sqlite-vec` 已明确后置。
- **隐私边界**：PCM 只存在于有界实时/精修缓冲；SQLite、应用数据、日志、迁移与导出都不保存原始音频或音频路径。
- **设置窗拖动闪烁**：根因是 `-webkit-app-region: drag` 触发 Chromium 自定义拖动路径，与 DWM 亚克力重绘不同步。配置采用社区推荐的防闪配方（`transparent:false` + `backgroundColor:'#00000000'` + `titleBarStyle:'hidden'` + `backgroundMaterial:'acrylic'`），并把拖动改为**主进程手动 setBounds**，彻底绕开 app-region 拖动路径。
- **字幕条拖动**：透明窗口不能用原生框架，同样用主进程轮询全局光标手动移窗（~120fps），比 app-region 顺滑且不受 mousemove 断流影响。
- **命中测试**：rAF 节流 + 拖动期间暂停，避免每次 mousemove 都跑 `elementFromPoint` + IPC。
