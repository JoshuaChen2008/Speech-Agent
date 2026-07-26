# Live Subtitle Agent

Win11 实时字幕 Agent。当前已完成 **B1 应用骨架 + B2 实时链路主干**：透明字幕条、工具栏、点击穿透、亚克力设置窗、首启双预设、权威会话状态机、隐藏采集窗（回环/麦克风）、realtime worker，以及 Gate 0B 改判批准的 **160ms 真实模型**——本机模型就位时启动即可出真字幕。

## 运行

仅支持 Windows x64：依赖 `sherpa-onnx-win-x64`（平台门控的 N-API 预编译包），其他平台 `npm install` 会以 EBADPLATFORM 失败。

```bash
npm install
npm start
```

Gate 0B 已于 2026-07-27 正式改判通过（批准 `x-asr-160ms` fast profile + 离线 X-ASR 精修；门槛重设理由与适用条件留档于 [docs/validation/gate-0b.md](docs/validation/gate-0b.md) 改判节），真实 recognizer 已接入 realtime worker：

- **模型就位**（`LIVE_SUBTITLE_MODEL_DIR` 环境变量、`userData/models/x-asr-160ms/`，或仓库开发布局 `models/gate-0b/extracted/x-asr-160/`，见 `src/main/services/model-resolver.js`）→ 启动发布 `fast` profile，工具条开始录制即出**真字幕**。
- **模型缺失** → capabilities 保持不可用（fail closed），不伪造。

开发 B1 状态流仍可显式启用 fake runtime 映射（不加载真实模型，且会绕过真实模型路径）：

```powershell
$env:LIVE_SUBTITLE_DEV_MODEL='x-asr-480ms'
npm start
```

## 已实现（骨架）

- **双窗架构**：字幕窗 + 工具条窗两个独立透明窗（穿透是整窗属性，锁定态要「字幕穿透 + 工具条可控」只能拆窗）
- **默认嵌入**：工具条停靠在字幕卡右上角内部，跟随字幕窗移动，看上去是一体
- **锁定 🔒 脱离**：字幕卡钉桌面 + 鼠标穿透（黄边 + 「已钉住」提示）；工具条脱离停靠、独立浮动可拖可控
- **各自拖动**：未锁定拖任一部分移动整个单元；锁定后工具条可独立拖到全屏任意位置
- **自动变淡**：工具条不用时淡出（0.35），鼠标靠近 / 录制 / 锁定时提亮
- **完整运行态**：工具条由 `RuntimeSnapshot` 驱动，命令经 `CommandResult` 回执，覆盖启动、暂停、恢复、停止与重试
- **平滑拖动**：主进程轮询光标手动 `setBounds`（~120fps），不用 app-region
- **解锁两路**：工具条 🔒、`Ctrl+Alt+L` 全局快捷键（锁定态字幕卡不可点）
- **设置 ↔ 字幕条实时联动**：字号 / 不透明度 / 圆角 / 主题 / 双语 改动即时生效，持久化到 `userData/config.json`
- **设置窗**：独立第三窗，Win11 真·亚克力（`titleBarStyle:'hidden'` + `backgroundMaterial:'acrylic'`，`resizable:false` 防拖动误缩放）
- **主题**：跟随系统深浅色（`nativeTheme`）
- **Gate 0D 首启**：显式选择「会议字幕」或「个人听写」；选择前麦克风与系统音频均保持关闭
- **最小权限桥接**：caption / toolbar / settings 使用独立 preload，主进程按窗口角色和 main frame 校验 IPC
- **B1 fake adapter**：字幕只接收 `SessionCoordinator` 发布的 `CaptionEvent`，renderer 不再自造假流

## 规划边界

- **视觉/UI**：字幕、工具条、设置/历史/首启的布局、样式、动效、文案和无障碍，可交给擅长视觉的模型独立设计。
- **Electron 壳层**：窗口、拖动、穿透、最小权限 preload、IPC 校验和会话状态机。
- **运行后端**：audio host、实时/精修 ASR workers、模型、会话、凭据和 AI provider。
- 三层只通过 `RuntimeSnapshot / CaptionEvent / CommandResult / Capabilities` 协作；UI 不读取模型、存储或密钥实现。
- Gate 0A 的 v1 字段、运行时校验器和模拟数据已固化在 [`src/contracts/`](src/contracts/README.md)，B1 UI 与 fake adapter 已按同一契约接线。

视觉模型的文件白名单、状态 fixtures 和交接要求见 [docs/ui-design-brief.md](docs/ui-design-brief.md)；后端职责、状态机和数据流见 [docs/runtime-architecture.md](docs/runtime-architecture.md)。

## 结构

```
src/
  main.js              主进程组合根：三窗管理、IPC 校验、配置与会话协调
  config.js            配置存储入口；实现位于 main/services/config-store.js
  main/
    ipc/               通道名与按窗口角色访问策略
    session/           SessionCoordinator、状态机与 fake runtime adapter
  preload/             caption / toolbar / settings 三个最小权限桥
  ui/shared/
    tokens.css         三窗共享的 design token：色彩/字阶/形状/阴影/动效 + 主题切换
  contracts/           Gate 0A：v1 契约、运行时校验器与跨层 JSON fixtures
  caption/             字幕窗
    index.html · caption.css · caption.js     命中测试 + 拖动 + 锁定穿透 + CaptionEvent 渲染
  toolbar/             工具条窗
    index.html · toolbar.css · toolbar.js     命中测试 + 拖动 + 按钮 + 锁定/录制视觉
  settings/            设置窗
    settings.html · settings.css · settings.js  控件 ↔ 配置双向绑定
```

## 下一步

见 [PLAN.md](PLAN.md)（Rev.3）：Gate 0A/0B（改判）/0C/0D、B1、B2.0–B2.3 与真实模型接线已完成（实机 smoke：语料外放 → 回环 → 真字幕，CER 0.071）；接下来是 silero VAD 替换 EnergyVad 占位、B3 精修 worker 与历史 UI、I2 完整指标验收。

- 窗口壳和交互不变量：[docs/subtitle-window.md](docs/subtitle-window.md)
- 视觉/UI 模型交接：[docs/ui-design-brief.md](docs/ui-design-brief.md)
- 运行后端与契约：[docs/runtime-architecture.md](docs/runtime-architecture.md)

## 已知事项

- 亚克力设置窗依赖 Win11（Build 22000+）；旧系统会回退为普通窗口。
- `transparent` 窗口开 DevTools 时透明会临时失效，属 Electron 已知限制。
- 识别 profile 由 Capabilities/会话状态约束：本机模型就位才发布 `fast`，缺失即不可用，不伪装。当前 VAD 是能量阈值占位（EnergyVad）：分段粒度偏碎、固定阈值对系统音量敏感（音量过低可能漏出字），silero 替换在计划内。

## 关键技术决策

- **设置窗拖动闪烁**：根因是 `-webkit-app-region: drag` 触发 Chromium 自定义拖动路径，与 DWM 亚克力重绘不同步。配置采用社区推荐的防闪配方（`transparent:false` + `backgroundColor:'#00000000'` + `titleBarStyle:'hidden'` + `backgroundMaterial:'acrylic'`），并把拖动改为**主进程手动 setBounds**，彻底绕开 app-region 拖动路径。
- **字幕条拖动**：透明窗口不能用原生框架，同样用主进程轮询全局光标手动移窗（~120fps），比 app-region 顺滑且不受 mousemove 断流影响。
- **命中测试**：rAF 节流 + 拖动期间暂停，避免每次 mousemove 都跑 `elementFromPoint` + IPC。
