# Live Subtitle + Agent

一个由两套能力协作组成的 Win11 桌面产品：**字幕系统**以互斥的 `loopback` 会议字幕或 `mic` 个人听写为输入，负责本地实时 ASR、字幕、自动保存和带时间戳历史；后置的 **Agent 系统**再消费已提交字幕，通过 Pi Agent Core 与第一方插件生成独立增强文本和会后结构化纪要。Agent 只生成内容，不执行外部操作；关闭或失败时，字幕系统仍独立完整工作。产品现在及未来都不保存原始音频。

当前已完成 **B1 应用骨架 + B2 实时链路 + B3 两遍精修/SQLite 历史 + B4 本地模型资源闭环 + 来源 XOR 联合门禁**：透明字幕条、工具栏、点击穿透、亚克力设置窗、单选监听模式、权威会话状态机、隐藏采集窗（回环/麦克风）、realtime worker，以及 Gate 0B 批准的 **160ms 真实模型 + silero VAD + 离线精修**。首次缺模型时可从设置的“模型资源”页一键下载固定三资源 bundle，支持断点续传、哈希/归档审查、原子安装；空闲应用安装后无需重启即可开始真字幕。字幕自动写入 SQLite，工具条可打开独立历史窗查看带时间戳正文并导出 txt/md/srt。确定性多模块 CI、270,938,600 字节批准模型真实安装/调用和四窗口 Electron 产品壳 smoke 已通过；物理 mic、两小时长稳、干净 Win11 公网/打包验收仍待闭环。Agent/翻译未实现，向量检索已后置。

针对用户看到的 `electron.exe / 0x80000003`，两张截图均早于生命周期修复提交 `64b3e55`；当前没有 dump 或 native stack，根因仍未获得调用栈级证明。修复后，批准模型活跃诊断三轮共送入并消费 303 帧，得到 3 条 final、3 条 refined、3 次 offline decode，六个 realtime/refine 子进程均优雅 `exitCode=0`、fatal 为 0；最贴近历史场景的真实 I2 loopback→ASR→offline refine→退出也 PASS：128 帧 captured/sent/ingested 一致，0 dropped/gap/bad sample，1 final + 1 refined、双 CER 0，Electron exact process 正常退出且未强制终止；受监督多窗口产品壳另为 clean exit、0 incident、未观察到 breakpoint。冻结语料诊断和 fake-ASR 产品壳仍只是 diagnostic/partial；真实 loopback 单轮也不替代物理 mic、长时 I3 或打包态 I4。详见 [Electron breakpoint 调查](docs/validation/electron-breakpoint-investigation.md)。

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

- **模型就位**（`LIVE_SUBTITLE_MODEL_DIR` 环境变量、`userData/models/x-asr-160ms/`，或仓库开发布局 `models/gate-0b/extracted/x-asr-160/`，见 `src/main/services/model-resolver.js`）→ 启动发布 `fast` profile，工具条开始录制即出**真字幕**。
- **模型缺失** → capabilities 保持不可用（fail closed），不伪造。

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

真实设备验收必须把两个来源分开运行；报告只保存结构化指标，不保存现场音频：

```powershell
.\scripts\run-electron-smoke.ps1 `
  -EntryPoint scripts\i2-live-caption-smoke.js `
  -EntryArguments @('--source', 'loopback', '--report', '.artifacts\i2-live\loopback.json')
.\scripts\run-electron-smoke.ps1 `
  -EntryPoint scripts\i2-live-caption-smoke.js `
  -EntryArguments @('--source', 'mic', '--listen-seconds', '12', '--report', '.artifacts\i2-live\mic.json')
```

本地 Electron smoke 必须经上述启动器隐藏启动、等待自然退出并保留 stdout/stderr；native
worker 先等待最多 30 秒优雅退出，超时后只终止并收殓该 exact child（最多再等 5 秒）。字幕
应用运行时以 45 秒作为优雅收束结束/升级触发线，ModelManager 的 5 秒收束与其并行；升级后仍
必须等待 exact child 收殓，所以 45 秒不是无视子进程状态的硬退出上限。不要用
`electron.exe --help` 探测运行时，也不要按进程名结束仍在验证中的 Electron。

`mic` 运行时终端只显示 `promptId`，请朗读 `scripts/gate-0b/corpus.json` 中对应 case 的冻结 reference；终端和报告都不回显现场转写正文。当前已留档的 loopback schema v2 实机证据包含真实 ASR/精修、字幕时序、CPU/工作集、PCM 队列与缺口指标；物理 mic 仍是 I2 完整验收的待办。

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

见 [PLAN.md](PLAN.md)（Rev.9）：来源互斥、默认 SQLite-only 生命周期、文本历史/导出、ModelManager 与真实产品壳旅程已通过对应门禁；当前按物理 mic I2 → I3 长稳 → I4 干净 Win11 公网/打包验收闭环字幕 MVP。之后才做 Pi Core/Electron 隔离探针、项目自有插件宿主、独立增强文本和会后结构化纪要；向量检索最后评估。任何能力都必须有跨模块用户旅程，不能只交单测。

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
