# 当前 UI/UX 页面微调交接

> 快照日期：2026-08-09  
> 代码基线：交付时的当前工作树；提交号只能辅助定位，不能替代工作树内容核对  
> 目标：让后续视觉模型在不改产品语义、运行契约、窗口命中和数据边界的前提下，对当前页面做可验证的视觉与交互微调。

本文记录的是**当前代码形态**，不是新的产品语义权威。发生冲突时按以下顺序处理：

1. [`semantic-contract.md`](semantic-contract.md)
2. [`adr/`](adr/)
3. [`ui-design-brief.md`](ui-design-brief.md)、[`subtitle-window.md`](subtitle-window.md)、[`subtitle-flow-and-transcript-versions.md`](subtitle-flow-and-transcript-versions.md)
4. 本文
5. 当前 renderer 代码

Agent 系统仍是后置可选系统。当前生产页面首先服务可以独立运行的字幕系统；不要把字幕窗、设置或字幕历史改成 Agent 的附属界面。未来 Agent 页面另见 [`agent-ui-ux-handoff.md`](agent-ui-ux-handoff.md)，不得在本轮页面微调中提前伪造。

## 1. 给接手模型的一分钟简报

- 当前有四个生产 renderer：字幕窗、工具条、设置、字幕历史。
- 字幕窗和工具条使用 TypeScript + 直接 DOM；设置和字幕历史使用 React + TypeScript。
- 四窗由 Vite 多页面构建，共享 `src/ui/shared/tokens.css` 和 Fluent System Icons。
- 字幕窗与工具条是透明置顶覆盖窗；设置和字幕历史是带 Mica 基底的普通窗口。
- UI 只能展示后端已经给出的事实。按钮点击只是提交意图，不能先画成成功。
- 本轮默认只做信息层级、间距、排版、状态可读性、控件一致性和无障碍微调。
- 新按钮、新设置、新状态、新数据字段或窗口尺寸变化都不是“纯视觉”，必须先提出 contract request。
- 不要编辑 `src/renderer-dist/`；它是 `npm run build:renderer` 的生成结果。
- 不要手改 `src/ui/shared/fixtures.generated.js`；fixture 变化后运行 `npm run preview:fixtures`。

当前四窗生产界面与 Fluent 2 桌面壳的确定性范围对应 **SEM-F20、SEM-F22 与 J15a/J17/J18**。J17/J18 已达到联合验收完成；真实 Mica/DWM、系统 DPI、透明窗跨背景可读性和异缩放双屏观察仍是实现完成·尚未验收，不能用浏览器截图或普通 DOM 测试冒充实机验收。

## 2. 页面地图与窗口形态

| 表面 | 用户用途 | 技术形态 | 当前窗口几何 | 入口 |
|---|---|---|---|---|
| 字幕窗 | 显示临时字幕、首次稳定转写及当前明确允许显示的精修稿 | 直接 DOM，透明、无焦点、置顶 | 默认 `920 × 190 DIP`；可拉伸到 `480–1600 × 140–420`，再受工作区封顶；四周 `20 DIP` 透明外边距 | `src/caption/index.html`、`caption.ts`、`caption.css` |
| 工具条 | 发出开始、暂停、继续、停止、重试及窗口意图；显示权威运行状态 | 直接 DOM，透明、可聚焦、置顶 | BrowserWindow 固定 `600 × 72 DIP`；真实工具条按内容自适应并在窗内右对齐 | `src/toolbar/index.html`、`toolbar.ts`、`toolbar.css` |
| 设置 | 首次设置、外观、监听模式、识别档位、模型资源与精修偏好 | React 19 + TypeScript，Mica | 固定 `880 × 620 DIP`，当前不可拉伸 | `src/settings/settings.html`、`settings-view.tsx`、`settings.css` |
| 字幕历史 | 浏览终态会话、切换原始版/精修稿、分页和导出 | React 19 + TypeScript，Mica | 默认 `1060 × 720 DIP`；最小 `780 × 520`；可拉伸和最大化 | `src/history/index.html`、`history-view.tsx`、`history.css` |
| 状态预览 | 开发时浏览 RuntimeSnapshot fixture 和大致视觉包线 | 静态开发工具，不进入生产 bundle | 浏览器页面 | `src/ui/preview/` |

窗口职责不能通过 CSS 或 DOM 合并。字幕和工具条保持高频、轻量的直接 DOM；设置和字幕历史可以继续用 React 组织正常窗口的信息架构。

## 3. 共享视觉语言

### 3.1 视觉基线

- 参考 Fluent 2，但未引入 Fluent UI React 组件库。
- 字体栈以 `Segoe UI Variable` / `Segoe UI` 为首选，并为中文配置 `Microsoft YaHei UI` 等回退。
- 深色是 token 默认主题；`data-theme="light"` 覆盖浅色。`auto` 由配置与系统主题共同决定，组件 CSS 不自行侦测系统主题。
- 设置与字幕历史使用中性长期窗口表面；两窗共用 `48px` 标题栏、`--surface-window-titlebar` 与 `--border-window-titlebar`。
- 工具条的**配色**主题独立：浅色、深色、自动主题和字幕自定义背景色都不得翻转它的基础配色；系统高对比除外。
- 工具条**画不画表面**由锁定状态决定，与配色是两件正交的事：未锁定时嵌入字幕卡，不画底色、描边、阴影和分隔线，只轻微降透明度，图标靠光晕保持可读；锁定后脱离卡片独立浮动，才长出 `--surface-toolbar` 表面。hover、focus-within、拖动中和 `data-attention="on"` 时恒亮。
- 字幕卡背景可以跟随主题，也可以由用户的 `barColor` 覆盖；工具条背景不跟随 `barColor`。
- 字幕**文字**颜色是一根独立受控的轴，深色和浅色主题都不覆盖它：默认白 + 深色描边，唯一的覆盖来源是 `captionTextColor`。理由是字幕卡半透明浮在任意画面上，底下是视频、网页或桌面，与应用主题无关。

### 3.2 Token 使用规则

`src/ui/shared/tokens.css` 是生产 renderer 的视觉单一真相：

- `--c-*` 是调色板原始值，只能在 token 文件内部被语义层引用。
- 组件 CSS 只消费 `--surface-*`、`--text-*`、`--tone-*`、`--radius-*`、`--shadow-*`、`--dur-*` 等语义 token。
- 字幕运行时变量为 `--fs`、`--radius`、`--bar-alpha`、`--toolbar-alpha`、`--caption-text`。
- `--bar-bg` 与 `--caption-text` 留空时必须 `removeProperty`，不能写回默认值：内联样式会盖住 `[data-theme]` 分支，写回等于把该项永久钉死。
- `--margin` 与 `--tb-margin` 只是主进程布局常量的 CSS 镜像；只改 CSS 不会移动 BrowserWindow。
- 新增跨页面颜色、圆角、阴影或动效时，先判断是否应成为共享语义 token，不要在多个组件里复制硬编码值。
- 颜色永远是冗余通道。状态还必须通过图标形状、文案或 ARIA 表达。

当前主要字阶和形状：

| 用途 | 当前值 |
|---|---|
| 字幕字号 | 用户可选 `24 / 30 / 38px` |
| 字幕行高 | `1.35` |
| 标题 | `21px` |
| 正文 | `13.5px` |
| 标签 | `12.5px` |
| 提示 | `12px` |
| 微文案 | `11px` |
| 工具条/分组卡圆角 | `12px` |
| 普通控件圆角 | `8px` |
| 图标按钮圆角 | `7px` |
| 字幕卡圆角 | 用户可选 `6–16px` |

### 3.3 图标、焦点与动效

- 生产图标统一从 `src/ui/shared/fluent-icons.ts` 注册，来源为 `@fluentui/svg-icons`。
- 新图标应加入该注册表并提供明确可访问名称；不要在页面内手绘新的 SVG 风格。
- 普通交互元素共用 `:focus-visible` 基线。不能用 `outline: none` 消掉键盘焦点。
- `prefers-reduced-motion` 下，过渡接近零时长；临时字幕光标停止闪烁。
- 常驻置顶界面不做大面积持续 `backdrop-filter`，也不为稳态 `listening` 添加无限动画。
- 只允许 `starting` 与 `recovering` 图标旋转；它们是过渡态。

## 4. 逐页当前结构与不可破坏项

### 4.1 字幕窗

当前 DOM 骨架：

```text
.wrap
└─ .caption-card
   ├─ .tb-hole
   ├─ .captions
   │  └─ .caption-flow
   │     └─ .seg × N
   ├─ #liveRegion.sr-only
   └─ .lock-hint
```

当前表现：

- 字幕流固定高度、底部锚定，内容超过可见高度时从顶部淘汰最旧完整视觉行。
- `.seg.partial` 使用较弱颜色和闪烁光标；已定稿的旧段通过 `opacity: 0.62` 后退一层。
- 字幕正文为粗体，使用自然换行和 `word-break: break-word`，没有横向跑马、滚动条或自动增高。
- 高频 `partial` 更新只修改必要节点；辅助技术不会逐帧播报。首次稳定转写及允许播报的后续定稿文本通过独立 live region 通知。
- 锁定时卡片外观保持稳定，底部显示中性“已钉住”提示；主要锁定信号由工具条闭锁图标、颜色和 `aria-pressed` 共同承担。

必须保持的 SEM-F03/F04/F20 规则：

- `partial` 是当前字幕段的完整临时假设，不是新增字符流，也不进入字幕历史或导出。
- 内容换行、视觉行淘汰与窗口宽度都不能改变识别文本、触发分段或提前产生首次稳定转写。
- 当前 `partial` 始终优先。精修稿不能覆盖它，也不能使已淘汰段复活。
- 精修故障确认后，仍可见的已定稿段恢复为首次稳定转写，当前 `partial` 保持不变，窗口 bounds 保持不变；运行中不新增提示、徽标或颜色状态。
- 字幕内容更新不得调用窗口 resize。尺寸只能由用户从卡片内侧 `8px` 拉伸带手动改变。

命中与拖动：

- `20 DIP` 透明外边距始终穿透，不是隐藏抓取面。
- 解锁时，可见字幕卡除工具条真实轮廓和 `8px` 拉伸带外都是拖动面。
- 命中顺序固定为：透明外边距 → 工具条真实轮廓 → 拉伸带 → 字幕拖动区域。
- `.tb-hole` 的 `584 × 64` 只是在首帧、reload、布局未就绪或非法报告时的临时 fail-safe；有效同代矩形到达后必须立即收缩到工具条真实轮廓。

适合微调：字幕前景对比、字重、阴影、旧段弱化程度、卡片表面、锁定提示的层级，以及不改变行盒高度的细节。

不能仅靠 CSS 修改：字幕可见容量算法、段淘汰规则、`--visible-lines`、窗口尺寸、卡片外边距、拉伸带、工具条洞和命中顺序。

### 4.2 工具条

当前 DOM 骨架：

```text
#toolbar.bar.toolbar
├─ #grip.grip
├─ #status.status
├─ separator
├─ #commands.bar-group
├─ separator
└─ #windowControls.bar-group
```

运行状态统一由 `src/ui/shared/runtime-view.js` 把 `RuntimeSnapshot` 映射为视图模型；DOM 层不应再写 phase 分支。

| phase | 图标/文案 | tone | 展示密度 |
|---|---|---|---|
| `unavailable` | 不可用 | neutral | attention：图标 + 说明 |
| `idle` | 待命 | neutral | quiet：只显示图标 |
| `starting` | 启动中 | busy | quiet：旋转图标 |
| `listening` | 监听中 | live | quiet：只显示图标 |
| `paused` | 已暂停 | warn | quiet：只显示图标 |
| `stopping` | 结束中 | busy | quiet：只显示图标 |
| `recovering` | 恢复中 | warn | attention：旋转图标 + 说明 |
| `error` | 出错 | danger | attention：图标 + 说明 |

当前命令与窗口控件：

- 主命令按 capability 在“开始 / 暂停 / 继续”中选择；没有 capability 时展示对应禁用意图。
- 可能出现“停止”“重试”以及后端 `nextAction` 给出的“打开设置 / 管理模型 / 授予权限”。
- 窗口控件固定为：字幕历史、锁定/解锁、设置、最小化、退出。
- 只有锁定按钮使用 `aria-pressed`。主命令通过可访问名称表达意图，不叠加 toggle 语义。
- 禁用原因优先来自 `capabilities.limitations[].message`，其次来自 `lastError.message`；UI 不自行猜测。
- `nextAction` 是 `retry / open-settings / open-model-manager / request-permission` 四值闭集，UI 只翻译，不新增值。
- 精修故障会话正常停止后，工具条可在原有 bounds 内显示会话状态通知、“查看历史”和关闭；通知不弹窗、不抢焦点、不发声，也不概括字幕内容。

工具条真实外接轮廓随 quiet、attention 和会话状态通知变化。BrowserWindow 中多余的透明区域逐像素穿透；不要把固定 `600 × 72` 窗口当作真实工具条面积。

拖动只能从两列三行六点握把开始，命中盒保持 `24 × 30 DIP`。按钮、状态文字和控件间隙都不是隐藏拖动区域。解锁时握把移动字幕与工具条组合；锁定时只移动工具条。

适合微调：按钮间距、状态文字压缩策略、图标视觉重量、hover/active/focus、分隔层次、会话状态通知的单行排布。

不能仅靠 DOM/CSS 修改：命令集合、capability、禁用原因、`nextAction`、拖动入口、命中盒、真实轮廓上报或 BrowserWindow 尺寸。

### 4.3 设置

设置窗使用固定 `880 × 620` Mica 窗口，左侧导航宽 `176px`，正文区域独立滚动。顶部 `48px` 标题栏包含标题、全局状态和关闭按钮；只有非交互空白区域可拖动。

当 `onboardingCompleted !== true` 时，标题栏下方显示居中的首次设置引导面板，主设置布局隐藏：

- “会议字幕”选择 `loopback` 系统音频。
- “个人听写”选择 `mic` 麦克风音频。
- 两种预设互斥；选择前不会开始采集。

当前导航与控件：

| 导航 | 当前内容 | 事实来源/约束 |
|---|---|---|
| 显示与字幕 | 字号、主题、字幕背景不透明度、工具条背景不透明度、字幕背景颜色、字幕文字颜色、圆角 | 外观可即时预览，`120ms` 合并写入；失败后读取权威配置回落 |
| 音频源 | 系统音频 / 麦克风音频互斥选择 | 活动会话中禁用切换；SEM-F02 要求停止后新建会话 |
| 语音识别 | 极速 `160` / 均衡 `480` / 精准 `960` | 可选项由 `availableProfiles` 决定；当前是本地识别设置，不是 Agent 模型 provider |
| 模型资源 | 核心字幕模型资源包、三项资源明细、可选精修模型、下载/取消/继续、精修偏好 | 模型状态、字节数和 capability 来自 preload/主进程；renderer 不接收 URL、哈希或路径参数 |
| 关于 | 产品骨架版本和能力说明 | 只作说明，不承担诊断能力 |

模型资源页面必须继续区分：

- 核心字幕模型资源包：临时字幕识别器、权威识别器、语音活动检测。
- 精修模型资源：默认不下载，需用户明确下载；取消后只有明确“继续下载”才续传。
- 精修偏好：模型就绪后也不会自动开启；只影响未来新会话，不改变活动会话，也不删除旧会话精修稿。

页面的 pending、失败和生效值必须来自真实回执。外观控件可以先在本窗预览，但保存失败要恢复后端权威值；监听模式、模型安装和精修偏好不能做乐观成功更新。

适合微调：导航密度、标题层级、分组卡、表单对齐、进度与字节信息层级、长说明的可扫读性、首次设置卡片和响应式滚动体验。

不能直接添加：翻译开关、Agent 模型 provider、确认关键词、个人记忆、调试聊天、权限申请流程或任意模型 URL/文件选择器。这些都需要新的语义与旅程登记。

### 4.4 字幕历史

字幕历史是正常、可聚焦的 Mica 窗口。顶部 `48px` 标题栏包含标题、副说明、状态、刷新和关闭。正文采用左侧会话列表 + 右侧详情时间线：

- 左侧会话栏当前宽 `310px`，显示开始时间、来源、时长、终态和已定稿字幕数量。
- 会话列表使用 keyset 分页，每次最多 50 条，并提供“加载更多”。
- 右侧默认空态；选择会话后显示来源、终态、完整日期、时长、总数、精修结果、版本选择、导出和时间线。
- 详情每批最多 50 条，支持上一批、下一批和失败重试；长会话不会把完整正文一次交给 renderer。
- 时间线同时显示会话内相对时间和对应时钟时间；字幕正文允许选中文本。
- 导出格式为 TXT、Markdown、SRT，导出跟随当前会话明确选择的转写版本。

必须保持的 SEM-F04/F11 规则：

- 每次选择不同会话都重置为“原始版”；同一会话翻页保留当前版本选择。
- 只有存在至少一段精修稿时才能切换到“精修稿”。
- `0 < N < M` 时显示整场覆盖，缺失段统一标记 `[原始版回退]`；不能从当前 50 条页面估算。
- `M > 0, N = 0` 时显示“本会话未生成精修稿”，禁用精修查看和精修导出。
- `M = 0` 且无故障时不显示 `0/0` 或精修结果。
- 故障事实和覆盖度相互独立；`N < M` 不表示 worker 故障，`N = M` 也不能掩盖已经确认的故障。
- 字幕历史只包含文本，不提供音频播放，也不保存现场音频。

适合微调：列表选中层级、详情头部响应式布局、版本控件、导出按钮组、时间线密度、空态/读取/失败状态和长正文可读性。

不能直接改变：分页大小、历史终态过滤、原始版默认规则、精修覆盖文案语义、导出版本或格式、正文数据形状。

## 5. UI 的真实状态来源

| UI 需要的事实 | 唯一来源 | renderer 可以做什么 | renderer 不能做什么 |
|---|---|---|---|
| 会话 phase、来源和 capability | `RuntimeSnapshot` | 映射图标、文案、禁用态与 ARIA | 从 CSS、按钮状态或本地文件猜测运行状态 |
| 命令结果 | `CommandResult` | 显示 pending、失败、权威回落和下一步 | 点击后先画成成功 |
| 实时字幕 | `CaptionEvent` + canonical caption state | 折叠、渲染、换行、有限视觉淘汰 | 修改事件语义、保存 `partial`、复活已淘汰段 |
| 外观与监听偏好 | config bridge | 即时预览外观并提交白名单 patch | 自行读写配置文件或多传字段 |
| 模型资源 | model status bridge | 显示状态、进度、字节数和固定动作 | 接受 URL、哈希、路径、解压参数或探测模型目录 |
| 字幕历史 | history service | 有界分页、版本选择、导出意图 | 读取 SQLite、一次取得完整正文或自行计算整场覆盖 |

如果后端没有提供视觉方案需要的事实，交接结果必须列出 contract request。不要在 renderer 里造一个临时字段、硬编码“成功”，也不要直接接 Node/Electron API。

## 6. 文件改动路由

### 6.1 默认视觉范围

| 路径 | 适合的改动 |
|---|---|
| `src/ui/shared/tokens.css` | 共享语义 token、主题、高对比、焦点、动效基线 |
| `src/ui/shared/phases.css` | 工具条运行状态、按钮、握把、tone 的共享视觉 |
| `src/caption/index.html` / `caption.css` | 字幕语义结构、表面与排版视觉 |
| `src/toolbar/index.html` / `toolbar.css` | 工具条容器和窗口专属视觉 |
| `src/settings/settings.css` | 设置布局、组件和主题视觉 |
| `src/history/history.css` | 字幕历史布局、列表、详情和时间线视觉 |
| `src/ui/shared/fluent-icons.ts` | 生产 Fluent 图标注册 |

### 6.2 需要共同评审

- `src/caption/caption.ts`：DOM 更新、ARIA、布局量测与 renderer→main 淘汰水位。
- `src/ui/shared/caption-reducer.js`：同时被主进程 canonical 折叠复用；改动会影响实时状态语义。
- `src/toolbar/toolbar.ts`：用户意图、RuntimeSnapshot 渲染、工具条真实轮廓上报与会话状态通知。
- `src/settings/settings-view.tsx`：配置提交、监听模式、模型动作与精修偏好。
- `src/history/history-view.tsx`：历史分页、会话作用域版本状态和导出意图。
- `src/ui/shared/runtime-view.js`：八个 phase 到视图模型的单一映射。
- `src/main/window-layout-contract.js` 和 BrowserWindow 数值：任何窗口尺寸、边距、停靠或命中变化。

### 6.3 页面微调默认不进入

- `src/main.js`、`src/main/` 下的 IPC、状态机与服务。
- `src/preload/`。
- `src/contracts/`。
- `src/runtime/`、音频采集、识别和精修 worker。
- 存储 schema、SQLite 投影、模型清单与下载器。
- Electron 安全、打包和安装器配置。
- `src/renderer-dist/` 生成产物。

## 7. 已核对的微调候选与交接风险

这些是源码审阅发现的**候选**，不是自动授权的改动清单。接手模型应先复现视觉结果，再按任务范围处理。

1. `src/history/history-view.tsx` 已渲染 `.version-actions`，但 `history.css` 没有对应布局和按钮样式。原始版/精修稿控件可能与导出按钮缺少清晰层级，适合优先做视觉核对。
2. `history.css` 的 `.detail-refinement` 使用 `var(--fg-muted)`，当前 `tokens.css` 未定义该 token；该颜色声明会失效。应改用已有语义 token或在共享层新增定义，不能在组件里散落新硬编码色。
3. `src/ui/preview/` 的字幕卡仍使用 `previous/current/translation` 旧槽位示意和 `src/ui/shared/icons.js`；生产字幕已经使用单一 `.caption-flow`，生产图标使用 `fluent-icons.ts`。预览页可用于 RuntimeSnapshot 状态矩阵和大致主题浏览，不能作为当前字幕 DOM、行流或生产图标的权威参考。
4. `--fs-caption-ratio-prev` 与 `--line-gap` 当前只被开发预览使用，不参与生产字幕固定高度行流。不要为了让预览页好看而改变生产字幕容量假设。
5. `--state-recording`、`--state-recording-icon`、`--dur-pulse` 当前没有生产消费者，且注释仍使用“录制”措辞。后续界面文案应使用“监听中”等规范术语，不要把这些遗留 token 名扩散到新 UI。
6. `ui-design-brief.md §4.1` 仍有“录制状态”旧措辞；当前产品 phase 文案是“监听中”。页面微调应遵循 `CONTEXT.md`，不要沿用旧措辞。
7. 工具条的固定 BrowserWindow 很宽，但真实可见条较窄。浏览器里给 `.toolbar` 加 `width: 100%` 或让状态区不可压缩，会扩大字幕穿透洞并破坏 J17。
8. 设置窗固定高度，模型资源页内容最多。增加垂直留白时必须同时检查 `620px` 高度下的滚动、底部精修说明和键盘可达性。
9. 字幕历史在 `860px` 处切换响应式布局；任何详情头部微调都要同时检查默认 `1060px` 和最小 `780px` 宽度。
10. renderer 顶层常量不能命名为 `shell`；preload 已占用该全局名，同名声明会使 renderer 在解析阶段失败。

## 8. 推荐的微调工作流

1. 先读 `CONTEXT.md` 全文，确认本轮文案使用系统音频、麦克风音频、监听模式、临时字幕、首次稳定转写、精修稿、字幕历史等规范术语。
2. 明确本轮只改哪个页面、哪些状态和哪些视口；不要一次重画四窗。
3. 先用现有 fixture 和真实 renderer 复现问题，记录 before 状态。
4. 优先在页面 CSS 或共享语义 token 中实现；只有确有交互原因时才进入 TS/TSX。
5. 若需要新事实、命令、状态或尺寸，停止实现并写 contract request：需要什么、谁拥有、失败时怎样、哪些旅程验证。
6. 检查深色、浅色、自动主题、Windows 系统高对比、键盘焦点和 reduced motion。
7. 检查当前页面的空态、pending、成功回执后的权威值、可恢复失败、不可恢复失败和长文案。
8. 运行 renderer 构建、core 回归和适用的联合旅程。
9. 交付时列出文件、覆盖状态、验证结果、实机观察缺口和 contract requests。

## 9. 本地运行与验证

```powershell
npm run dev                 # Vite + 受监督 Electron，适合迭代 UI
npm run verify:renderer     # TypeScript + 生产 renderer bundle
npm run test:core           # contracts/main/runtime/storage/ui 局部不变量
npm run test:integration    # J15a/J17/J18 等跨模块确定性旅程
npm run test:evidence       # 严格报告和证据契约
npm test                    # 三条 lane 依次执行
```

开发预览页不进入生产 bundle。需要使用时，先生成受契约校验的 fixture，再在 Vite 开发服务中访问：

```powershell
npm run preview:fixtures
# npm run dev 运行期间访问 http://127.0.0.1:5173/ui/preview/index.html
```

预览页只辅助浏览状态矩阵；字幕固定高度行流必须以生产字幕窗、`caption-layout-smoke` 和 J15a 规则为准。

页面级最低检查表：

- 字幕：24/30/38px；中文、英文、中英混排、超长单词；长 `partial` 回改；固定 bounds；顶部无半行；最新行完整。
- 工具条：八个 phase；quiet/attention；会话状态通知；长禁用原因；锁定；键盘焦点；透明区域穿透。
- 设置：首次设置；五个导航；活动会话禁用换源；模型 missing/downloading/verifying/ready/error；保存失败回落；固定高度滚动。
- 字幕历史：空列表、读取失败、终态会话、原始版、完整/不完整/零精修、上一批/下一批、三种导出、`780px` 最小宽度。
- 全局：深色、浅色、自动主题、系统高对比、reduced motion、100% 与高 DPI 实机观察边界。

自动化不能替代真实 Mica、DWM z-order、透明窗跨背景可读性、真人鼠标连续拖动、系统 DPI 或异缩放双屏。这些仍按 J15a/I2 的实机路径记录，报告不得包含字幕正文、设备名、本地绝对路径或绝对单调时刻。

## 10. 接手模型交付格式

每次微调至少返回：

1. 修改的 UI 文件列表。
2. 修改目标和未进入的范围。
3. 覆盖的 RuntimeSnapshot、CaptionEvent、模型与历史状态。
4. 深色、浅色、高对比、键盘焦点、reduced motion 的检查结果。
5. 运行的 core / integration / evidence lane 与结果；不能用局部回归替代联合旅程或实机证据。
6. contract requests；没有时明确写“无”。
7. 仍属于实现完成·尚未验收的实机观察项。

如果改动窗口尺寸、工具条位置、标题栏高度、字幕外边距、拉伸带或握把命中盒，还必须给出新的 layout contract 数值、理由和 J17 影响，等待壳层共同评审。

## 11. 可直接复制给下一个模型的任务前缀

```text
你正在微调 Live Subtitle Agent 的现有 UI，不是在设计新产品能力。

先完整阅读 CONTEXT.md，再阅读：
- docs/current-ui-ux-handoff.md
- docs/ui-design-brief.md
- 与目标页面对应的源码

本轮目标：<填写页面、状态、视口和问题>
允许修改：<填写文件>
明确不改：main/preload/contracts/runtime/storage/model manifest/窗口语义

要求：
1. UI 只展示 RuntimeSnapshot、CommandResult、CaptionEvent、config/model/history contract 已提供的事实。
2. 不新增按钮、字段、状态、设置或窗口尺寸；若确有需要，只写 contract request，不伪造实现。
3. 共享值进入 tokens.css，生产图标使用 fluent-icons.ts，不编辑 renderer-dist。
4. 保留 SEM-F02/F03/F04/F11/F20/F22 与 J15a/J17/J18 的不变量。
5. 覆盖深色、浅色、高对比、键盘焦点和 reduced motion。
6. 交付文件列表、状态矩阵、验证命令、结果、实机缺口和 contract requests。
```
