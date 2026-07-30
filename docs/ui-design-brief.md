# Live Subtitle Agent · 视觉/UI 模型交接说明

> 状态：Rev.3 · 2026-07-31
> 目的：让擅长视觉设计的模型可以独立改进界面，同时不接触音频、ASR、模型、存储和安全实现。

## 1. 核心原则

视觉模型拥有**表现方式**，运行后端拥有**事实和能力**。

- UI 决定一个状态看起来怎样、用户怎样发出意图。
- `SessionCoordinator` 决定当前真实状态是什么、命令是否成功。
- runtime 决定设备、模型和 provider 实际支持什么。
- UI 不通过读取文件、探测 sherpa 或拼 IPC 字符串来推断运行状态。

这不是限制视觉创意，而是保证任何视觉方案都可以在不理解 ASR 内部实现的情况下替换。

## 2. 文件所有权

### 2.1 视觉模型默认可修改

| 当前路径 | 责任 |
|---|---|
| `src/caption/index.html` | 字幕语义结构和固定渲染槽位 |
| `src/caption/caption.css` | 字幕排版、主题、透明度、状态样式和动效 |
| `src/toolbar/index.html` | 工具条控件结构、图标和可访问名称 |
| `src/toolbar/toolbar.css` | 工具条布局、视觉状态和动效 |
| `src/settings/settings.html` | 设置与首启正常窗口的信息架构 |
| `src/settings/settings.css` | 设置窗口、组件和主题 |
| `src/history/index.html` | 历史会话、正文时间线和导出控件的语义结构 |
| `src/history/history.css` | 历史窗口布局、主题、列表和时间线视觉 |
| `src/ui/shared/tokens.css` | design token 单一真相（见 §2.3）；未来的共享组件样式和纯展示 helpers 同放 `src/ui/shared/`。⚠ 例外：`caption-reducer.js` 见 §2.2 |
| `docs/ui-design-brief.md` | 视觉规范和交接说明 |

### 2.2 需要共同评审

| 路径/内容 | 原因 |
|---|---|
| `src/caption/caption.js` | 只允许 caption reducer、DOM 渲染、ARIA 和纯展示逻辑；不接 sherpa 原始结果 |
| `src/ui/shared/caption-reducer.js` | B2.0 起 `createState/applyEvent/KEEP_SEGMENTS` 被主进程 canonical CaptionState 折叠复用（单一折叠真相），窗口/修订/会话切换语义改动会静默改变壳层行为；`selectLines/computeLineBudget` 属视觉决策但同文件，一并共同评审 |
| `src/toolbar/toolbar.js` | 只允许把用户意图交给 `toolbarApi`，并根据 RuntimeSnapshot 渲染 |
| `src/settings/settings.js` | 只允许表单/view-model 逻辑；运行配置必须等待 CommandResult |
| `src/history/history.js` | 只允许历史列表/详情/导出交互和 DOM 渲染；终态过滤、投影和文件写由主进程/SQLite 决定 |
| BrowserWindow 宽高、边距、工具条 overlap rect | 同时影响 CSS、窗口停靠和命中测试，必须更新共享 layout contract |
| 新的按钮、设置或状态 | 可能需要新增 Command、Capability 或错误类型，先提出 contract request |

### 2.3 design token 层（V1 已落地）

`src/ui/shared/tokens.css` 是四个可见 renderer 的唯一视觉真相，由四份 HTML 在各自组件样式**之前**引入：

```html
<link rel="stylesheet" href="../ui/shared/tokens.css">
```

分层与约定：

- `§1 --c-*` 是调色板原始值，只允许被同文件的语义层引用，组件里不得出现。
- `§2–§7` 是语义层：字体字阶、表面与文字、状态色、形状、阴影、动效时长。组件只消费这一层。
- 主题在 token 层切换：`:root` 是深色默认，`:root[data-theme="light"]` 覆盖。**组件 CSS 里不应再出现 `[data-theme]` 分支**；工具条和设置窗已完全去除，字幕窗仅保留结构性规则。
- 需要在组件里再复合透明度的 token 保持 RGB 三元组（当前是 `--bar-bg` / `--toolbar-bg` / `--fg` / `--text-accent`），其余是可直接赋值的完整颜色。
- `§8` 是外观运行时变量 `--fs / --radius / --bar-alpha / --toolbar-alpha`，外加自定义底色时才写入的 `--bar-bg` / `--toolbar-bg`。统一由 `src/ui/shared/appearance.js` 的 `applyAppearance()` 以内联样式写到 `:root` —— 字幕窗和工具条窗共用同一份映射，避免「留空要回退到主题默认」这类细节在两边走岔。默认值与 `src/config.js` 的 `DEFAULTS` 对齐，只用于配置到达前的首帧。
- 行数不再走 CSS 变量：`config.maxLines` 现在是「当前句行数上限」，实际行数由整卡高度预算算出，逐槽位以 `--n` 写在元素自身上。见 `caption-reducer.js` 的 `computeLineBudget()`。
- `§9` 是 `main.js` 尺寸常量的**只读镜像**（`--margin` / `--tb-margin`）。改这里不会移动窗口；消除双重真相是 B1 待办，在那之前两处必须同步改。
- `§10/§11` 是 `:focus-visible` 与 `forced-colors` 基线，用零特异性 `:where()` 声明，组件可直接覆盖。

新增 phase 语义色、状态样式一律加在 token 层，不要散回三套组件 CSS。

### 2.4 运行状态表达（V2 已定稿）

决策集中在 `src/ui/shared/runtime-view.js`（`RuntimeSnapshot` → 纯视图模型），
视觉落在 `src/ui/shared/phases.css`，可在 `src/ui/preview/` 逐 fixture 核对。
**DOM 层不允许再出现按 phase 分支的逻辑** —— 一旦出现就说明决策漏在了渲染层。

| phase | 图标形状 | 文案 | tone | 主按钮 |
|---|---|---|---|---|
| `unavailable` | 斜杠圆 | 不可用 | neutral | 开始（禁用） |
| `idle` | 待机符 | 待命 | neutral | 开始 |
| `starting` | 缺口弧（顺时针转） | 启动中 | busy | 暂停（禁用） |
| `listening` | 声波五竖 | 监听中 | live | 暂停 |
| `paused` | 双竖条 | 已暂停 | warn | 继续 |
| `stopping` | 方框 | 结束中 | busy | 暂停（禁用） |
| `recovering` | 回转箭头（逆时针转） | 恢复中 | warn | 暂停（禁用） |
| `error` | 三角叹号 | 出错 | danger | 开始（禁用） |

**安静 / 需注意两档**（`status.emphasis`）：

- `quiet`（`idle` `starting` `listening` `paused` `stopping`）——工具条**只渲染图标**。形状加色调足够区分，条收窄到 287–319，尽量不遮字幕。
- `attention`（`unavailable` `recovering` `error`）——额外带出一行说明（`status.message`，取自 `limitations` / `lastError`）。这三个状态的信息量压不进一个图标：用户需要知道缺什么、在恢复什么、为什么失败。
- 两档的 `aria-label` 完全一致。图标是装饰性的，语义挂在 `.status` 的 `aria-label` 上，所以 `quiet` 下辅助技术读到的信息没有缩水。

**常态融入背景**：未锁定且未交互时工具条不画任何表面——没有底色、描边和阴影，只剩图标，靠 `--icon-halo` 保证在白底文档和深色视频上都可读。悬停、键盘聚焦、拖动中、锁定后、或处于 `attention` 时表面浮现。

规则：

- **形状 > 文案 > 颜色。** tone 只是冗余通道；把颜色全部去掉后，图标形状加文案仍能区分全部 8 个 phase。
- **锁定只由工具条锁图标表达**：图标形状在开锁/闭锁间切换 + 变色 + `aria-pressed`。字幕卡不再改描边，卡片底部的「已钉住」提示用中性色，只提供文案通道，不叠第二处配色。
- **主按钮由 capabilities 决定，不按 phase 硬编码**：依次取 `canPause / canResume / canStart` 第一个为真者；全假时按 phase 摆出对应意图的禁用态。
- **禁用理由和下一步只能取自后端**：`capabilities.limitations[].message` 优先，其次 `lastError.message`；两者都没有才退到泛化文案。`nextAction` 是 4 值闭集，UI 只做翻译不做决策。
- **状态区第二行必须说明作用对象**：`listening` 列出 active 来源，`recovering` 列出正在恢复的来源，满足「显示正在恢复哪个组件」。
- **动效只给过渡态**：仅 `starting` / `recovering` 转圈。`listening` 可能持续两小时，刻意不给图标无限动画。
- **`aria-pressed` 只给锁定按钮**。主按钮的可及名称在「开始 / 暂停 / 继续」间切换，再叠 pressed 语义会让屏幕阅读器读出两份互相矛盾的状态。这是对 §4.2 原文的修订。
- **说明条不放交互控件**：字幕窗 `focusable: false`，那里的按钮键盘够不到。可执行的下一步一律由工具条承载。

### 2.5 视觉模型禁止修改

- `src/main.js` 及未来 `src/main/` 下的窗口、IPC、状态机和服务。
- `src/preload.js` 及未来按窗口拆分的 preload。
- `src/config.js`、凭据、会话持久化/数据库、模型清单和下载器。
- `src/runtime/`、audio host 和 ASR/refine workers。
- `src/contracts/` 的字段含义、状态迁移和安全校验。
- Electron 打包、安全选项和 native module 配置。

如果视觉方案需要后端尚未提供的事实，必须在交接结果中列出“需要的 contract 变更”，不能在 renderer 内伪造成功状态或自行访问 Node/Electron API。

## 3. UI 唯一依赖的运行契约

字段名已在 Gate 0A 固化于 `src/contracts/`。**下面是节选示例，不是完整字段表**；权威形状以 `src/contracts/*.js` 的校验函数和 `src/contracts/fixtures/` 为准，本节仅说明 UI 依赖其中的哪些信息。

实际契约比下例丰富得多，UI 重度依赖的几个字段在示例里没体现：`sessionId`、`capabilities.limitations[]`（禁用理由与下一步的唯一来源）、`model.progress`、`lastError.recoverable`。

### 3.1 RuntimeSnapshot

```json
{
  "schemaVersion": 1,
  "revision": 42,
  "phase": "listening",
  "capabilities": {
    "canStart": true,
    "canPause": true,
    "canTranslate": false,
    "availableProfiles": ["fast", "balanced"]
  },
  "sources": [
    { "id": "mic", "label": "麦克风", "state": "active", "level": 0.31 },
    { "id": "loopback", "label": "系统音频", "state": "inactive", "level": 0 }
  ],
  "model": { "state": "ready", "profile": "balanced" },
  "lastError": null
}
```

UI 必须覆盖的 `phase`：

- `unavailable`
- `idle`
- `starting`
- `listening`
- `paused`
- `stopping`
- `recovering`
- `error`

### 3.2 CaptionEvent

```json
{
  "schemaVersion": 1,
  "sessionId": "session-01",
  "sourceId": "loopback",
  "segmentId": "segment-17",
  "sequence": 91,
  "revision": 2,
  "kind": "refined",
  "t0": 12.34,
  "t1": 15.02,
  "text": "我们下周 review 一下 roadmap。",
  "translation": null
}
```

UI 规则：

- 按 `sessionId + segmentId` 找到同一段。
- 只接受更大的 `sequence/revision`，旧事件不能覆盖新文本。
- `partial` 可以有光标或弱化样式；`final/refined` 不应继续显示“输入中”。
- `sourceId` 是音频来源，不是经过认证的真实说话人身份。
- 翻译可以晚到或失败；主字幕必须独立可用。

### 3.3 CommandResult

用户点击只是发出意图，例如 `start / pause / resume / stop / updatePreferences / installModel / enableTranslation`。UI 不能先假设成功。

```json
{
  "ok": false,
  "code": "MODEL_NOT_READY",
  "message": "需要先下载均衡模型",
  "nextAction": "open-model-manager"
}
```

视觉模型需要为 pending、成功、可恢复失败和不可恢复失败分别设计反馈。

## 4. 界面范围

### 4.1 字幕窗

目标是可读性，不是视觉表演。可自由调整字体、层级、背景和克制的动效，但必须满足：

- previous/current/translation 使用稳定节点，partial 更新不重建整棵 DOM。
- 定义**总行数预算**，而不是给每个段落各自分配 `maxLines`。
- 覆盖 24/30/38px、中文/英文/中英混排、超长单词和双语副行。
- 在浅色文档、深色视频和复杂桌面背景上均清晰。
- 锁定、穿透和录制状态不能只依赖颜色。

### 4.2 工具条

工具条发出意图并展示权威状态：

- `starting/stopping/recovering` 时禁止重复提交冲突命令。
- `error` 提供可执行的下一步，而不是只变红。
- 主按钮的可及名称随状态在「开始 / 暂停 / 继续」之间切换；`aria-pressed` 只给锁定按钮。修订理由见 §2.4。
- 支持键盘、`:focus-visible` 和 `prefers-reduced-motion`。
- 可以重新设计常态透明度，但关键操作在复杂背景上仍需可发现。

### 4.3 设置、历史和首启

- 外观偏好可以即时预览，延迟持久化。
- 音频和 ASR 模型属于字幕运行配置；AI 属于后置 Agent 配置。二者都需展示 pending/失败/实际生效值，但 Agent 不可用不得禁用字幕入口。
- 不可用能力由 Capabilities 禁用并说明原因。
- 字幕历史放在可聚焦的正常窗口内，MVP 支持会话列表、滚动、选择、时间戳和导出；搜索是可选能力，不塞进穿透字幕窗。
- 首启提供「会议字幕 / 个人听写」互斥预设，并明确麦克风、系统音频权限；活动会话不能同时开启两路或直接换源。
- Agent 上线后，开启上下文增强、翻译或摘要前明确告知：哪些定稿文本将发送到哪个用户配置的服务；原文与 Agent 派生文本分层展示。

## 5. 视觉自由与系统不变量

视觉模型可以自由决定：

- 色彩、字体、圆角、阴影、材质、间距和图标风格。
- 设置页信息架构和组件外观。
- 字幕层级、工具条密度、错误提示和下载进度的表现。
- 在不影响可读性与性能的前提下增加动效。

以下是不变量：

- 四个可见 renderer（字幕、工具条、设置、历史）与隐藏 audio host 的职责不能通过 CSS/DOM 合并。
- 字幕窗和工具条窗的点击穿透、停靠关系必须服从 layout contract。
- UI 不持有 API Key，不读写模型或会话文件，不直接发网络请求。
- UI 不出现 sherpa 文件名、ONNX 路径或 IPC channel；高级诊断页除外。
- UI 不把“麦克风 / 系统音频”包装成已完成真实 diarization。
- 视觉效果不得造成持续大面积 backdrop-filter、无限动画或高频 DOM 重建。

## 6. Contract request 状态

> 提出方：视觉/UI 层 · 2026-07-26 · 对应 V1–V3 已交付的部分
> 状态：B1 已关闭 A1–A3 以及 stop/retry；B3.3 已关闭 history；A4、资源管理与权限入口仍未实现。

### 6.1 A 类 · 阻塞型

| # | 需要 | B1 落地状态 | UI 结果 |
|---|---|---|---|
| **A1** | `onSnapshot(cb)` + `getSnapshot()`，推送 `RuntimeSnapshot` | **完成** | toolbar 订阅优先、再读取当前快照，并按 revision 拒绝旧值；已删除 `rec`/演示状态 |
| **A2** | `command(name)` → `Promise<CommandResult>`，覆盖 `start / pause / resume / stop / retry` | **完成** | 五种意图独立映射；pending、失败和恢复均消费真实回执，不做乐观更新 |
| **A3** | `onCaption(cb)`，推送 `CaptionEvent` | **完成** | caption 只消费 coordinator 事件；fake/未来 real adapter 共用同一入口。B2.0 追加 caption 独占的 `getCaptionState()`：reload 时先订阅（缓冲）、再水合、后重放，恢复与实时视图逐字段一致。⚠ `caption-reducer.js` 的 `createState/applyEvent/KEEP_SEGMENTS` 自 B2.0 起被主进程折叠复用，属 UI 与壳层共享的单一真相，改动需双侧评审 |

关于 A2 的两点：

- `resume ≠ start`。有真会话状态后，把两者压成同一个 toggle 会产生错误的状态迁移。
- UI **刻意不做乐观更新**（§8 要求任何"看起来已成功"都能追溯到后端）。所以在回执到位前，点击的表现是"看起来没反应"——这是设计使然，不是 bug。

**A4（半个请求）**：`onOverlap(cb)` 推送工具条实际停靠矩形（字幕窗 CSS px）。目前 `caption.css` 的 `.tb-hole` 硬编码 `584 × 64`，按最坏情况多盖。需要后端加一条只读通道，但驱动方是 UI。见 [subtitle-window.md §3](subtitle-window.md)。

### 6.2 B 类 · 已实现但没有对应能力的入口

> 本表「对应后端阶段」列里的 B1/B3/B4 指 PLAN §7.3 的后端阶段，不是请求编号。

未接入入口继续渲染成禁用态并说明原因，不做无声失败按钮；B1 的 stop/retry 已启用。

| 入口 | 需要 | 对应后端阶段 | 状态 |
|---|---|---|---|
| `stop` | stop 命令 | B1 | **完成** |
| `retry` | retry 命令 | B1 | **完成** |
| `history` | 可聚焦的历史窗 + 只读终态会话/时间戳正文/导出 contract；搜索可后加 | B3.3 | **实现完成/尚未实机验收** |
| `open-model-manager` | 资源管理页 | B4 | 未实现 |
| `request-permission` | 权限请求入口 | Gate 0C / B2 | 未实现 |

四个 `nextAction` 值里 `retry` 与 `open-settings` 已接通；`open-model-manager` 与 `request-permission` 等待后续阶段。

### 6.3 C 类 · UI 对后端的隐含期待

**这五条不满足时的症状是「东西不见了」而不是报错**，所以必须写下来。

| # | 期待 | 违反后的表现 |
|---|---|---|
| C1 | `capabilities.limitations[].message` 是可直接展示的完整句子 | UI 原样渲染、不做 code → 文案映射。只发 code 的话按钮会禁用但**说不出原因** |
| C2 | `nextAction` 保持 4 值闭集（`retry` / `open-settings` / `open-model-manager` / `request-permission`） | `runtime-view.js` 查表命不中返回 `null`，**按钮直接消失且不报错**。用户在错误态会失去唯一出口 |
| C3 | `lastError.message` 与 `limitations[].message` 写成短句 | 工具条内联说明有 **160px 上限**（约 12 个汉字），超出打省略号 |
| C4 | 同一 `segmentId` 的 `revision` 随文本单调递增 | reducer 按 `(revision, sequence)` 字典序判新，旧事件一律丢弃。**复用 revision 发不同文本，新文本会被静默丢掉** |
| C5 | `sources[].label` 是最终展示文案 | 直接进 UI。PLAN §5.2 提到用户可别名为「我 / 对方」，但目前没有别名配置键，label 完全由后端决定 |

### 6.4 后续顺序

字幕 MVP 当前先完成 B4 ModelManager 资源入口，再做真实 Electron/I3/I4 验收；A4 layout contract 可并行收口。Agent UI 等 A1/A2 契约冻结后再做，不在 renderer 内先行伪造能力。

## 7. 每次视觉交接必须包含

1. 修改过的 UI 文件列表。
2. 覆盖的 RuntimeSnapshot/CaptionEvent fixtures 列表。
3. 状态矩阵截图或说明：idle、starting、listening、paused、recovering、error。
4. 深浅色、高对比度、键盘 focus、reduced motion 检查结果。
5. 需要壳层/后端新增的 contract requests；没有则明确写“无”。当前未结的见 §6。
6. 若改变窗口尺寸或工具条位置，给出新的 layout contract 数值和理由，等待壳层所有者确认后再合并。

## 8. 验收底线

- 视觉模型只看本文件和 contract fixtures，就能完成 UI，不必阅读 ASR 实现。
- 后端替换模型、provider 或存储实现时，UI 不需要改 DOM/CSS。
- renderer 重载后从完整快照恢复，不依赖“恰好收到过某个事件”。
- 未安装模型、权限拒绝、设备拔出和 worker 恢复都有明确界面；Agent 上线后再增加 AI 断网/取消/失败界面，且不遮蔽字幕历史。
- 任何“看起来已经成功”的视觉状态，都能追溯到后端 RuntimeSnapshot 或 CommandResult。
