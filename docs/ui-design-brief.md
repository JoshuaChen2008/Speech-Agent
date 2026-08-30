# Live Subtitle Agent · 视觉/UI 模型交接说明

> 正式 Agent UI/UX 的独立交接见 [`agent-ui-ux-handoff.md`](agent-ui-ux-handoff.md)，UI → Core 缺口登记见 [`agent-ui-contract-requests.md`](agent-ui-contract-requests.md)。当前 handoff 已整体替代 2026-08-09 的旧 Agent 设计；隔离 Agent 内核开发入口 `src/agent-mvp/**` 不再作为正式 UI 模板。两份文档都不形成第二份产品语义权威，冲突时仍以 `semantic-contract.md` 为准。

> 状态：Rev.11 · 2026-08-31
> 目的：让擅长视觉设计的模型可以独立改进界面，同时不接触音频、ASR、模型、存储和安全实现。

## 1. 核心原则

视觉模型拥有**表现方式**，运行后端拥有**事实和能力**。

- UI 决定一个状态看起来怎样、用户怎样发出意图。
- `SessionCoordinator` 决定当前真实状态是什么、命令是否成功。
- runtime 决定设备、模型和 provider 实际支持什么。
- UI 不通过读取文件、探测 sherpa 或拼 IPC 字符串来推断运行状态。

这不是限制视觉创意，而是保证任何视觉方案都可以在不理解 ASR 内部实现的情况下替换。

本轮界面重构以 [Fluent 2](https://fluent2.microsoft.design/) 为视觉与交互参考，但不引入 Fluent UI React 组件库：

- 字幕窗与工具条保持 TypeScript 直接 DOM，避免让临时字幕高频更新进入通用组件树。
- 设置窗与字幕历史使用 React + TypeScript 组织既有信息架构，不新增后端能力。
- 现有字幕、工具条、设置、历史四窗由 Vite 多页面构建；S5 新增正式 `agent` 窗口后形成五个可见 renderer，共享本仓库的语义 token 和官方 Fluent System Icons SVG。
- Fluent 2 的原则与图标服务于本项目语义；组件库默认状态、文案或布局不得覆盖 RuntimeSnapshot、CommandResult、字幕版本与窗口命中合同。

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
| 未来正式 `agent` renderer 的 HTML/TSX | Agent Bar 语义结构、范围选择、结果与交互历史展示；实际根路径先由 Core owner 在 S5 登记 |
| 未来正式 `agent` renderer 的 CSS | Agent Bar 布局、主题、状态与可访问性；不得复用 `src/agent-mvp/**` |
| `src/ui/shared/tokens.css` | design token 单一真相（见 §2.3）；未来的共享组件样式和纯展示 helpers 同放 `src/ui/shared/`。⚠ 例外：`caption-reducer.js` 见 §2.2 |
| `docs/ui-design-brief.md` | 视觉规范和交接说明 |

### 2.2 需要共同评审

| 路径/内容 | 原因 |
|---|---|
| `src/caption/caption.ts` | 只允许 caption reducer、DOM 渲染、ARIA 和纯展示逻辑；不接 sherpa 原始结果 |
| `src/ui/shared/caption-reducer.js` | B2.0 起 `createState/applyEvent/KEEP_SEGMENTS` 被主进程 canonical CaptionState 折叠复用（单一折叠真相），窗口/修订/会话切换语义改动会静默改变壳层行为；`selectFlow/countVisibleLines/evictCaptionPrefix` 属视觉决策但同文件，一并共同评审 |
| `src/toolbar/toolbar.ts` | 只允许把用户意图交给 `toolbarApi`，并根据 RuntimeSnapshot 渲染 |
| `src/settings/settings.js` | 只允许表单/view-model 逻辑；运行配置必须等待 CommandResult |
| `src/history/history.js` | 只允许历史列表/详情/导出交互和 DOM 渲染；终态过滤、投影和文件写由主进程/SQLite 决定 |
| 未来正式 `agent` renderer 的 view-model/adapter | Core 拥有资格、错误、终态与下一动作；UI/UX 只把冻结 snapshot/CommandResult 转成展示，不新增同义状态 |
| BrowserWindow 宽高、边距、工具条 overlap rect | 同时影响 CSS、窗口停靠和命中测试，必须更新共享 layout contract |
| 新的按钮、设置或状态 | 可能需要新增 Command、Capability 或错误类型，先提出 contract request |

### 2.3 design token 层（V1 已落地）

`src/ui/shared/tokens.css` 是现有四个、S5 后五个可见 renderer 的唯一视觉真相，由各 renderer 在自身组件样式**之前**引入：

```html
<link rel="stylesheet" href="../ui/shared/tokens.css">
```

分层与约定：

- `§1 --c-*` 是调色板原始值，只允许被同文件的语义层引用，组件里不得出现。
- `§2–§7` 是语义层：字体字阶、表面与文字、状态色、形状、阴影、动效时长。组件只消费这一层。
- 主题在 token 层切换：`:root` 是深色默认，`:root[data-theme="light"]` 覆盖。**组件 CSS 里不应再出现 `[data-theme]` 分支**；工具条和设置窗已完全去除，字幕窗仅保留结构性规则。
- 需要在组件里再复合透明度的 token 保持 RGB 三元组（当前是 `--bar-bg` / `--toolbar-bg` / `--fg` / `--text-accent`），其余是可直接赋值的完整颜色。
- `§8` 是外观运行时变量 `--fs / --radius / --bar-alpha / --toolbar-alpha`；自定义字幕背景色只写入 `--bar-bg`，不得再覆盖工具条底色。`src/ui/shared/appearance.js` 的 `applyAppearance()` 仍由字幕窗和工具条窗共用，但 `barColor` 只作用字幕卡，`toolbarOpacity` 只作用固定工具条表面。默认值与 `src/config.js` 的 `DEFAULTS` 对齐，只用于配置到达前的首帧。
- 字幕采用固定高度的单一 `.caption-flow`：内容按当前宽度自然换行，满高后淘汰最旧完整视觉行并保持最新行可见；当某段最后一行退出后，renderer 只回报会话/段身份，canonical 在本会话永久淘汰该段，迟到修订、回退和 reload 均不得复活。`selectFlow/countVisibleLines/evictCaptionPrefix` 是当前实现，不能退回逐槽位裁切。
- `§9` 是 `main.js` 尺寸常量的**只读镜像**（`--margin` / `--tb-margin`）。改这里不会移动窗口；消除双重真相是 B1 待办，在那之前两处必须同步改。
- `§10/§11` 是 `:focus-visible` 与 `forced-colors` 基线，用零特异性 `:where()` 声明，组件可直接覆盖。
- 设置与字幕历史必须新增并共用一个主题感知的中性标题栏表面语义 token（计划名 `--surface-window-titlebar`），同时共用 `1px` 底部分隔线 token。它只表达窗口结构层次，不得复用 phase、选中、警告或成功颜色；深色、浅色与系统高对比覆盖都在 token 层定义。

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

**稳定悬浮配色与状态化表面**：工具条始终使用同一套主题独立配色；深色、浅色与自动主题不得翻转它的按钮或 phase 色调。未锁定嵌入字幕卡时不画独立表面，也不显示两列三行六点握把；锁定脱离字幕背景后才显示深色半透明表面和握把。`toolbarOpacity` 只调整锁定态表面透明度；即使用户明确调到全透明，浅色图标仍以固定深色光晕维持跨背景可见性。Windows 系统高对比仍可接管颜色。

规则：

- **形状 > 文案 > 颜色。** tone 只是冗余通道；把颜色全部去掉后，图标形状加文案仍能区分全部 8 个 phase。
- **锁定只由工具条锁图标表达**：图标形状在开锁/闭锁间切换 + 变色 + `aria-pressed`。字幕卡不再改描边，卡片底部的「已钉住」提示用中性色，只提供文案通道，不叠第二处配色。
- **主按钮由 capabilities 决定，不按 phase 硬编码**：依次取 `canPause / canResume / canStart` 第一个为真者；全假时按 phase 摆出对应意图的禁用态。
- **禁用理由和下一步只能取自后端**：`capabilities.limitations[].message` 优先，其次 `lastError.message`；两者都没有才退到泛化文案。`nextAction` 是 4 值闭集，UI 只做翻译不做决策。
- **状态区第二行必须说明作用对象**：`listening` 列出 active 来源，`recovering` 列出正在恢复的来源，满足「显示正在恢复哪个组件」。
- **动效只给过渡态**：仅 `starting` / `recovering` 转圈。`listening` 可能持续两小时，刻意不给图标无限动画。
- **`aria-pressed` 只给锁定按钮**。主按钮的可及名称在「开始 / 暂停 / 继续」间切换，再叠 pressed 语义会让屏幕阅读器读出两份互相矛盾的状态。这是对 §4.2 原文的修订。
- **说明条不放交互控件**：字幕窗 `focusable: false`，那里的按钮键盘够不到。可执行的下一步一律由工具条承载。

精修 worker 故障不进入上述 8 个主 phase。当前 MVP 运行中不显示精修故障提示：所有仍可见的已定稿段立即恢复各自首次稳定转写并在原固定视口内重新排版，当前 `partial` 原样保留且仍优先，已淘汰段不复活；工具条、设置窗和字幕窗都不因该故障变色、增高或增加徽标。正常停止后，工具条在既有 bounds 内显示一条不抢焦点的会话状态通知，例如“精修异常，已精修 73/100 段”，并提供“查看历史”。它只报告运行结果，不是字幕内容摘要、系统通知或弹窗，也不概括或改写字幕内容，不能抢焦点、改变窗口几何或发出声音；通知保持到用户关闭或进入历史，开始下一会话时自动清除，应用重启不重放。详细故障事实与整场覆盖由后端持久化，重启后仍从历史可见；若应用在正常停止前异常退出，重启后会话标为中断且不重放旧通知。覆盖与故障独立：`N<M` 不足以证明故障；即使 `N=M`，也必须显示“精修进程异常结束，但本次已生成 N/N 段精修稿”。历史回退行统一显示 `[原始版回退]`；视觉层不得用当前分页或缺少 `refinedText` 伪造结果。用户期望的状态/颜色提醒属于后续设计且不阻断当前 MVP；届时必须补状态矩阵、形状/文案等非颜色冗余通道和 contract request，不能由 renderer 自行推断。

### 2.5 视觉模型禁止修改

- `src/main.js` 及未来 `src/main/` 下的窗口、IPC、状态机和服务。
- `src/preload.js` 及未来按窗口拆分的 preload。
- `src/config.js`、凭据、会话持久化/数据库、模型清单和下载器。
- `src/runtime/`、audio host 和 ASR/refine workers。
- `src/contracts/` 的字段含义、状态迁移和安全校验。
- Electron 打包、安全选项和 native module 配置。

如果视觉方案需要后端尚未提供的事实，必须在交接结果中列出“需要的 contract 变更”，不能在 renderer 内伪造成功状态或自行访问 Node/Electron API。

### 2.6 视觉不变量与禁止项（守卫可执行）

§2.3 的规则以前只是散文，实际已经漏过：`src/history/history.css` 曾有五处直接引用 `--c-accent` 调色板原始值，三条 lane 全绿也没有发现。现在这一节的每一行都对应 `test/ui/renderer-style-guard.test.js` 的一条断言，属 SEM-F23 与 J18 的 renderer 样式守卫子边界。

守卫**按目录扫描而不是按窗口点名**：`src/**` 下任何 renderer 样式一出现就被覆盖，未来正式 `agent` 窗口不需要有人记得把它加进名单。

| 禁止项 | 为什么 | 例外 |
|---|---|---|
| 字面色值（`#hex`、`rgb(255, …)`、`white`/`black` 等具名色） | 组件一旦自带色值，主题切换和高对比接管就会漏掉它 | 只有 `tokens.css` 的 §1 调色板 |
| 直接引用 `--c-*` | 调色板是原始值层，组件绕过语义层等于把一个未命名的视觉决策焊死在组件里 | 只有 `tokens.css` 的语义层 |
| 组件 CSS 里的 `[data-theme]` 分支 | 主题必须在 token 层切换，否则每加一个主题都要改所有组件 | 无 |
| 渐变（`linear/radial/conic-gradient`） | Fluent 2 桌面壳不用渐变；它也是「AI 味界面」最常见的第一个入口 | 无。开发预览页的背景模拟色板不在扫描范围 |
| `backdrop-filter` | 常驻置顶窗上的大面积模糊是性能与可读性双输，SEM-F23 已明确禁止 | 无 |
| 新增无限循环动画 | 常驻窗不做无限装饰动画 | 守卫内的已登记闭集：临时字幕光标、`starting`/`recovering` 转圈。新增一条必须先改 SEM-F23 与测试策略同名小节 |
| renderer 目录缺 `prefers-reduced-motion` / `forced-colors` 轮廓 | 两条系统偏好是无障碍底线 | 无 |
| renderer 目录没有入口引用 `tokens.css` | 不引用就等于另立一份视觉真相 | 共享层 `src/ui/shared/` 自身 |

扫描范围之外的树是硬编码闭集：构建产物 `src/renderer-dist/**` 与隔离 Agent 内核开发入口 `src/agent-mvp/**`。**扩大例外必须先改 `semantic-contract.md` 的 SEM-F23，不得直接放宽守卫默认值。** 守卫还先断言扫描结果非空且至少包含现有四窗与 `phases.css`，避免扫描表达式写错时空过。

守卫只是静态样式边界：全绿不表示任何 renderer 已实现或已验收，真实 Mica、系统 DPI 与跨背景可读性仍然只能由 J15a/I2 的实机观察给出。

### 2.7 Agent Bar 视觉设计基准页

`src/ui/preview/agent-bar.html` 把 [`agent-ui-ux-handoff.md`](agent-ui-ux-handoff.md) §13.3 的状态矩阵与 §13.4 的文案渲染成可以直接看的画面，供 `UX-3` 接手模型对照风格，不必从七百行散文里复现视觉。

- 它是**设计基准**，不是实现：数据是手写设计取值，不经任何 exact validator，不进入生产 bundle，**不构成 J22/J24 证据**，也不表示 `AUI-CR-010`–`019` 已签发。
- 它只消费 `tokens.css` 的语义层，页面自身的排版变量一律 `--ab-` 前缀；守卫会拒绝预览页重新定义任何共享语义 token。
- **控件外观与设置页同源**：页面直接 `<link>` 引用 `src/settings/settings.css`，全部状态由设置页既有控件搭出 —— `.group` / `.row` / `.label` / `.hint` / `.seg[role=radiogroup]` / `.primary-btn` / `.secondary-btn` / `.link-btn` / `.resource-list` / `.resource-row` / `.model-error` / `.note`。守卫会拒绝基准页重新定义这些类，所以两边不可能各自漂移。参照实现是设置页 · Agent 模型配置档案（`src/settings/agent-model-pane.tsx`）。
- 基准页只补一处设置页确实没有的东西：可读长正文 `.agent-result-body`（设置页只有 `.label` / `.hint` / `.note` 三档）。新增第二处之前先问它是否该进设置页。
- ⚠ 已知缺口：这套控件目前住在 `settings.css` 里，是 renderer 局部层。正式 `agent` 窗口落地时不能引用另一个 renderer 的样式表，届时需要把控件层抽到 `src/ui/shared/`，而不是把 `settings.css` 复制进 `src/agent-window/**`。该抽取尚未登记，属 UX-3 前的待决项。
- 页面带一个「去掉颜色」开关，用来当场核对 §2.4 的那条规则：把颜色全部去掉后，状态仍须靠文字与形状区分。
- 正式 renderer 落地时，这一页不迁移、不复用为模板；它和 `src/agent-mvp/**` 一样不是正式 UI 模板。

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
  "model": { "state": "ready", "profile": "fast" },
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
  "message": "需要下载完整本地字幕资源",
  "nextAction": "open-model-manager"
}
```

视觉模型需要为 pending、成功、可恢复失败和不可恢复失败分别设计反馈。

## 4. 界面范围

### 4.1 字幕窗

目标是可读性，不是视觉表演。可自由调整字体、层级、背景和克制的动效，但必须满足：

- 使用稳定的字幕视口/内容节点，`partial` 高频更新不重建整棵 DOM。
- 定义一个固定高度的**总视觉容量**；自然换行，溢出时从顶部逐行淘汰，不横向移动、不自动改变窗口 bounds。
- 当前 `partial` 优先；布局不修改识别文本或分段。精修开启时只更新仍可见旧段，不能复活已淘汰段或覆盖首次 `final`。精修 worker 故障确认后，所有仍可见的已定稿段立即恢复各自首次稳定转写并重新换行；当前 `partial` 不变，已淘汰段不复活，后续段继续使用首次稳定转写。运行中不增加提示或改变窗口几何，停止后再报告。
- 覆盖 24/30/38px、中文/英文/中英混排、超长单词和双语副行。
- 在浅色文档、深色视频和复杂桌面背景上均清晰。
- 锁定、穿透和录制状态不能只依赖颜色。
- 解锁时，除卡片内侧 `8px` 拉伸带和工具条当前真实轮廓外，整张可见字幕卡都是连续抓取面；四周 `20 DIP` 透明外边距仍穿透，不能做成不可见抓取区。
- 主键按下后随系统光标位移立即拖动，不增加定时长按或 renderer 自定义移动阈值；原地按下再松开不改变窗口 bounds。

### 4.2 工具条

工具条发出意图并展示权威状态：

- `starting/stopping/recovering` 时禁止重复提交冲突命令。
- `error` 提供可执行的下一步，而不是只变红。
- 主按钮的可及名称随状态在「开始 / 暂停 / 继续」之间切换；`aria-pressed` 只给锁定按钮。修订理由见 §2.4。
- 工具条会话状态通知不打开 modal、不抢焦点、不扩张工具条 bounds，也不发出声音；它只报告处理状态，不概括或改写字幕内容。“查看历史”和关闭都是工具条内可聚焦的明确动作，详细内容由历史窗承载。通知保持到用户关闭或进入历史，开始下一会话时自动清除，应用重启不重放。
- 支持键盘、`:focus-visible` 和 `prefers-reduced-motion`。
- 常态使用主题独立的深色半透明表面与浅色普通控件；设置页“字幕背景颜色”不得染色工具条，工具条透明度仍可独立调整。
- 整个工具条真实外接轮廓（含状态文字和控件间隙）都从字幕抓取面排除；锁定后脱离字幕背景的工具条只允许从明确可见的握把开始拖动，按钮、状态文字和空隙不承担隐藏拖动语义。
- 握把使用 Fluent System Icons 的两列三行六点图形，锁定态保持既有 `24 × 30 DIP` 命中盒；未锁定时以 `display: none` 退出布局、外接轮廓和命中，图形替换不得改变拖动时机或窗口 bounds。

### 4.3 设置、历史和首启

- 外观偏好可以即时预览，延迟持久化。
- 音频和 ASR 模型属于字幕运行配置；AI 属于后置 Agent 配置。核心字幕资源只包含实时 ASR 与 VAD；精修模型是默认不下载的独立可选资源。设置页必须分开表达核心 ready、精修模型缺失/下载/校验/ready，以及一个不区分 `mic`/`loopback`、只影响未来新会话的全局精修偏好。精修下载可取消并保留合法 `.part`，但只有明确点击“继续下载”才恢复网络；模型 ready 后仍需再次明确开启。关闭偏好不删除模型或旧会话精修稿。当前三资源原子 bundle 是 J15c 之前的旧候选，不得继续作为目标 UI 语义。字幕资源与 Agent 配置都需展示 pending/失败/实际生效值，但 Agent 不可用不得禁用字幕入口。
- 不可用能力由 Capabilities 禁用并说明原因。
- 字幕历史放在可聚焦的正常窗口内，MVP 支持会话列表、滚动、选择、时间戳和导出；搜索是可选能力，不塞进穿透字幕窗。
- 设置与字幕历史统一使用 `48px` 顶部标题栏。只有标题栏的非交互区域可拖动；标题栏内按钮、链接、输入控件和正文空白区均不得成为隐藏抓取面。
- 两窗标题栏共用 `--surface-window-titlebar` 与 `1px` 底部分隔线，颜色比正文表面略深但保持中性、随主题切换；不得用强调色或状态色制造“当前选中/警告”的错误含义。
- 设置或字幕历史获得焦点时，窗口壳临时把该窗提升到字幕/工具条之上；失焦后立即恢复普通层级。视觉层不得用遮罩、隐藏字幕或自动搬移窗口伪造该结果。
- 历史精修详情按整场 `N/M` 与独立故障事实展示。`M > 0, N = 0` 禁用精修查看/导出；`M = 0` 且无故障时不显示 `0/0` 或精修结果，有故障时显示“精修进程异常结束；本会话未产生可精修的已定稿字幕”。旧会话的“未记录精修运行状态”只放在精修详情，不进入普通历史列表。
- 首启提供「会议字幕 / 个人听写」互斥预设，并明确麦克风、系统音频权限；活动会话不能同时开启两路或直接换源。
- Agent 上线后，开启上下文增强、翻译或摘要前明确告知：哪些定稿文本将发送到哪个用户配置的服务；原文与 Agent 派生文本分层展示。

## 5. 视觉自由与系统不变量

视觉模型可以自由决定：

- 色彩、字体、圆角、阴影、材质、间距和图标风格。
- 设置页信息架构和组件外观。
- 字幕层级、工具条密度、错误提示和下载进度的表现。
- 在不影响可读性与性能的前提下增加动效。

以下是不变量：

- 五个可见 renderer（字幕、工具条、设置、历史、正式 `agent`）与隐藏 audio host 的职责不能通过 CSS/DOM 合并；正式 `agent` renderer 不与隔离 `agent-mvp` 合并。
- 字幕窗和工具条窗的点击穿透、停靠关系必须服从 layout contract。
- 字幕命中必须使用工具条当前真实外接矩形；由当前停靠几何推导的 `588 × 64` 只允许在首帧、renderer reload、布局未就绪、非法或陈旧矩形时临时 fail-safe，收到同代有效矩形后立即收缩。
- 命中顺序固定为透明外边距、工具条实际轮廓、`8px` 拉伸带、字幕拖动区域；锁定时字幕窗恒穿透且工具条只有现有明确握把可拖。
- 工具条基础配色独立于普通主题和字幕自定义背景色；只有 Windows 系统高对比可以接管，`toolbarOpacity` 只影响工具条表面透明度。
- 设置与字幕历史正文不能做整页拖动；两窗必须共享 `48px` 标题栏结构和中性标题栏 token，并由主进程负责聚焦提升、失焦恢复。
- UI 不持有 API Key，不读写模型或会话文件，不直接发网络请求。
- UI 不出现 sherpa 文件名、ONNX 路径或 IPC channel；高级诊断页除外。
- UI 不把“麦克风 / 系统音频”包装成已完成真实 diarization。
- 视觉效果不得造成持续大面积 backdrop-filter、无限动画或高频 DOM 重建。

## 6. Contract request 状态

> 提出方：视觉/UI 层 · 2026-08-08 · 对应 V1–V3 与 SEM-F22/J17
> 状态：既有 A1–A3、stop/retry、history 与资源管理证据保持不变；A4 实际 overlap rect 与 A5 正常窗口焦点层级已随 J17 达到联合验收完成。权限入口仍随音频门禁延期。

### 6.1 A 类 · 阻塞型

| # | 需要 | B1 落地状态 | UI 结果 |
|---|---|---|---|
| **A1** | `onSnapshot(cb)` + `getSnapshot()`，推送 `RuntimeSnapshot` | **完成** | toolbar 订阅优先、再读取当前快照，并按 revision 拒绝旧值；已删除 `rec`/演示状态 |
| **A2** | `command(name)` → `Promise<CommandResult>`，覆盖 `start / pause / resume / stop / retry` | **完成** | 五种意图独立映射；pending、失败和恢复均消费真实回执，不做乐观更新 |
| **A3** | `onCaption(cb)`，推送 `CaptionEvent` | **完成** | caption 只消费 coordinator 事件；fake/未来 real adapter 共用同一入口。B2.0 追加 caption 独占的 `getCaptionState()`：reload 时先订阅（缓冲）、再水合、后重放，恢复与实时视图逐字段一致。⚠ `caption-reducer.js` 的 `createState/applyEvent/KEEP_SEGMENTS` 自 B2.0 起被主进程折叠复用，属 UI 与壳层共享的单一真相，改动需双侧评审 |

关于 A2 的两点：

- `resume ≠ start`。有真会话状态后，把两者压成同一个 toggle 会产生错误的状态迁移。
- UI **刻意不做乐观成功更新**（§8 要求任何“看起来已成功”都能追溯到后端）。用户发出意图后必须立即显示按下或 pending/忙碌反馈并阻止冲突提交；只有回执到位后才能呈现成功状态，失败则显示权威原因并恢复权威值。

**A4（SEM-F22 / J17 必需）**：工具条 renderer 把当前 `#toolbar.toolbar` 外接矩形连同主进程签发的 renderer generation 送入受约束 IPC；主进程严格校验、换算为字幕卡局部的右侧锚定矩形，再由 `onOverlap(cb)` 推送给字幕窗。`caption.css` 的 `.tb-hole` 只在首帧、reload、布局未就绪、非法或陈旧矩形时使用由当前停靠几何推导的 `588 × 64` 最坏尺寸回落；同代有效矩形到达后立即收缩。矩形只服务有界内存布局，不写日志、数据库、导出或证据报告。该范围已随 J17 达到联合验收完成，见 [subtitle-window.md §3](subtitle-window.md)。

**A5（SEM-F22 / J17 必需）**：主进程统一管理设置与字幕历史的焦点层级。任一窗口获得焦点时临时进入与字幕/工具条相同的 `screen-saver` 层并 `moveTop()`，失焦、关闭、销毁或异常清理时恢复普通层级；两窗都不得永久置顶。renderer 仅负责 `48px` 标题栏的拖动意图、交互控件排除和共享中性 token，不得直接调用 Electron 层级 API。

### 6.2 B 类 · 已实现但没有对应能力的入口

> 本表「对应后端阶段」列里的 B1/B3/B4 指 PLAN §7.3 的后端阶段，不是请求编号。

未接入入口继续渲染成禁用态并说明原因，不做无声失败按钮；B1 的 stop/retry 已启用。

| 入口 | 需要 | 对应后端阶段 | 状态 |
|---|---|---|---|
| `stop` | stop 命令 | B1 | **完成** |
| `retry` | retry 命令 | B1 | **完成** |
| `history` | 可聚焦的历史窗 + 只读终态会话/时间戳正文/导出 contract；搜索可后加 | B3.3 | **联合验收完成/开发态与 packaged Electron 205 段五页、三格式完整导出及离线复启已验；I3 非音频 3,600 段仍保持 DOM≤50。真实系统对话框、两小时声源与 I4 待验** |
| `open-model-manager` | 资源管理页：核心实时 ASR+VAD 与可选精修资源分层；只接受固定动作，不接受 URL/hash/path 参数；精修支持明确下载、取消、继续，安装完成不自动开启 | B4 / J15c | 核心/可选拆分、下载/取消/继续、独立 ready 与热启用已达到确定性联合验收完成；真实 packaged Electron 覆盖下载中取消、连接关闭、合法 `.part` 保留、复启 fetch=0 与明确 Range 继续。I4 干净机公网下载待验收 |
| `refinement-preference` | 一个全局精修偏好；新会话开始时冻结，关闭只影响未来会话且不删除旧稿；ready 校验失败时回落关闭 | J15c | 配置、Capability、设置控件、会话冻结和跨重启复核已达到确定性联合验收完成；活动会话可以修改未来偏好，但当前会话保持冻结值 |
| `refinement-session-result` | 精修 worker 故障后立即把所有仍可见 final 恢复为原始版且不动当前 partial；独立持久化冻结启用值、五值故障码与整场覆盖；正常停止后工具条显示不抢焦点的会话状态通知和“查看历史”，异常退出则只在中断会话历史中保留结果；`N=M` 不掩盖故障，旧会话不得从覆盖反推运行状态 | J15c | 结果 contract、schema v2 migration、滚动结构化日志、caption/toolbar/history UI 与真实 packaged main→IPC→renderer 旅程已达到确定性联合验收完成。状态/颜色实时提醒后置且不阻断当前 MVP |
| `request-permission` | 权限请求入口 | Gate 0C / B2 | 未实现 |

四个 `nextAction` 值里 `retry`、`open-settings` 与 `open-model-manager` 已接通；只有 `request-permission` 仍等待后续阶段。

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

字幕 MVP 的现有四窗口产品壳与 Agent 重设计保持独立。正式 Agent UI 可按 [`agent-ui-ux-handoff.md`](agent-ui-ux-handoff.md) 的 `UX-1/UX-2` 与 S1–S4 并行设计；生产 renderer 只在对应 Core contract 与 fixture 冻结后进入 `UX-3`，并在 S5-Integration 通过真实 preload/exact IPC/SQLite 汇合。缺少的事实和动作进入 [`agent-ui-contract-requests.md`](agent-ui-contract-requests.md)，renderer 不先行伪造能力。设计稿、截图和 fixture preview 不构成 J21/J22/J24/J25/J26 证据。

## 7. 每次视觉交接必须包含

1. 修改过的 UI 文件列表。
2. 覆盖的 RuntimeSnapshot/CaptionEvent fixtures 列表。
3. 状态矩阵截图或说明：idle、starting、listening、paused、recovering、error。
4. 深浅色、高对比度、键盘 focus、reduced motion 检查结果。
5. 需要壳层/后端新增的 contract requests；没有则明确写“无”。当前未结的见 §6。
6. 若改变窗口尺寸或工具条位置，给出新的 layout contract 数值和理由，等待壳层所有者确认后再合并。
7. 若范围包含正式 Agent，声明本轮是 `UX design`、`Renderer implementation` 或 `S5 integration support`，并列出消费的 contract/fixture 或 `AUI-CR-*`。

## 8. 验收底线

- 字幕 UI 模型只看本文件和既有 contract fixtures 即可工作；正式 Agent UI 模型再读取当前 [`agent-ui-ux-handoff.md`](agent-ui-ux-handoff.md)，不必阅读 ASR 或旧 Agent 实现。
- 后端替换模型、provider 或存储实现时，UI 不需要改 DOM/CSS。
- renderer 重载后从完整快照恢复，不依赖“恰好收到过某个事件”。
- 未安装模型和 worker 恢复已有明确界面；权限拒绝、设备拔出需在 I4 前随权限入口补成明确界面。正式 Agent 按 handoff 第 6 节覆盖断网、取消、失败与 reload，且不遮蔽字幕历史。
- 任何“看起来已经成功”的视觉状态，都能追溯到后端 RuntimeSnapshot 或 CommandResult。
