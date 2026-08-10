# 窗口拖动、穿透与前台层级执行计划

> 状态：联合验收完成 · 2026-08-08
> 权威要求：[SEM-F22](semantic-contract.md)
> 用户旅程：[J17](testing-strategy.md) + I2 `dwm-drag`
> 本文记录已执行的实施顺序与验收边界；J17 已闭合，I2 `dwm-drag` 仍待当前候选的 12 组合人工实机报告。

> 2026-08-10 增量说明：本文下方出现的 `584 × 64` 是 2026-08-08 历史实施快照，不再定义当前回落几何。当前 `20 DIP` 停靠内缩下的权威 fail-safe 已由 SEM-F22 修正为 `588 × 64 DIP`，以完整包含 window-local `16..584 DIP` 最大真实轮廓。

> 2026-08-10 工具条握把修正：本文下方“未锁定握把可见并移动组合”的历史实施记录不再定义当前行为。未锁定时握把必须退出布局、真实轮廓与命中，组合只从字幕卡普通拖动区移动；锁定且工具条脱离字幕背景后才显示握把并只移动工具条。当前产品壳为 schema-v8，I2 `dwm-drag` 为 schema-v6，旧 schema 继续只按历史语义读取。

## 1. 目标结果

后续实施必须同时取得以下用户可观察结果：

1. 字幕窗解锁时，除工具条当前真实轮廓和卡片内侧 `8px` 拉伸带外，整张可见字幕卡都能以主键按住后立即拖动；原地按下再松开不改变 bounds。
2. 字幕窗四周 `20 DIP` 透明外边距继续逐像素穿透；工具条轮廓随 quiet、attention、会话状态通知及 reload 动态变化，不再留下常态固定大洞。
3. 工具条嵌入字幕卡且字幕未锁定时不显示握把，字幕卡普通拖动区移动字幕与工具条组合；锁定时字幕窗恒穿透，工具条脱离字幕背景并显示握把，握把只移动工具条。
4. 设置与字幕历史只从各自 `48px` 标题栏的非交互区域拖动；正文空白区和全部交互控件不触发拖动。
5. 设置或字幕历史获得焦点时临时位于字幕与工具条之上，失焦后立即恢复普通层级。
6. 设置与字幕历史标题栏共用主题感知的中性加深表面 token 与 `1px` 底部分隔线，且不借用状态色表达结构。

## 2. 明确不做

- 不把设置或字幕历史正文变成整页隐藏抓取区。
- 不增加定时长按、renderer 自定义移动阈值或点击后跳动。
- 不使用 `-webkit-app-region: drag` 替换现有主进程手动 bounds 更新。
- 不把设置或字幕历史永久置顶，也不通过隐藏字幕、降低字幕层级或自动搬移正常窗口规避遮挡。
- 不按工具条 alpha 像素挖出碎片命中区；“真实轮廓”统一指现有 `#toolbar.toolbar` 外接矩形，包含状态文字与控件间隙。
- 不持久化工具条矩形，不把矩形、桌面坐标、窗口绝对位置或本地绝对路径写入日志、数据库、导出和证据报告。
- 不改字幕排版、CaptionEvent、SQLite、音频采集、识别器或精修语义。

## 3. 现状基线与缺口

| 位置 | 实施前事实 | SEM-F22 目标 |
|---|---|---|
| `src/caption/caption.css` / `caption.js` | `.tb-hole` 固定 `584 × 64`，命中只区分固定洞、字幕卡和 `8px` 拉伸带 | 首帧/失效时才用最坏尺寸回落；同代有效矩形到达后立即使用真实工具条轮廓 |
| `src/toolbar/toolbar.js` | `.act` 之外的整个工具条都能开始拖动；现有 `.grip` 在解锁时隐藏 | 锁定态复用现有握把并只移动工具条；未锁定握把退出布局/轮廓/命中，组合由字幕卡普通拖动区移动；状态文字和控件间隙不承担隐藏拖动 |
| `src/settings/settings.css` | 标题栏 `44px`，正文高度和首启 inset 也按 `44px` 计算 | 标题栏、布局高度和首启 inset 全部统一到 `48px` |
| `src/history/history.css` | 标题栏已是 `48px`，但没有与设置共用专门的标题栏表面 token | 两窗消费同一中性标题栏 token 与分隔线 token |
| `src/settings/settings.js` / `src/history/history.js` | 拖动排除只检查 `button` | 排除按钮、链接、输入、选择、文本域、可编辑节点及显式 `data-no-drag` 节点 |
| `src/main.js` | 字幕/工具条固定在 `screen-saver` 层；设置/字幕历史保持普通层级；`dock()` 会再次 `moveTop()` 工具条 | 以统一层级协调器管理焦点窗口；任何工具条重排后仍保证当前聚焦正常窗口位于最上层 |
| IPC / preload | 没有工具条轮廓 generation、严格矩形上报或字幕轮廓订阅 | 新增最小、按窗口角色授权、exact-shape 校验的布局通道，并用卡片局部 `top/right/width/height` 保持右侧锚定 |
| 测试 / 实机证据 | 实施前尚无 J17 证据；既有 I2 `dwm-drag` 仅为 schema-v1 场景 | 先取得确定性联合旅程，再取得真实 DWM 与 DPI/异缩放观察 |

## 4. 实施阶段

### 阶段 A：先写会红的契约与旅程

在改产品代码前，先在工作区编写并确认以下断言能够捕获现有缺口，且只放入既有测试 lane；随后在对应功能阶段实现至绿，红测不单独提交：

- `test/main/window-layout-contract.test.js`
  - exact-shape 接受有限、非负、位于 `600 × 72 DIP` 工具条内容区内的同代矩形。
  - 拒绝缺字段、多字段、`NaN`、无穷、负尺寸、越界和陈旧 generation。
  - 工具条 CSS 矩形换算为卡片局部的右侧锚定矩形，使用向外取整并裁到字幕卡；非法输入返回 `584 × 64` fail-safe，不返回半合法结果。
- `test/ui/window-drag-ui.test.js`
  - 字幕命中矩阵覆盖透明外边距、可见卡片、四边/四角 `8px` 拉伸带、真实工具条轮廓及轮廓相邻像素；重叠点必须由工具条轮廓先接管。
  - 工具条只有握把发出 `dragStart`；按钮、状态文字和间隙均不发出。
  - 设置与字幕历史只从标题栏非交互区域发出 `dragStart`，并覆盖全部交互选择器与取消路径。
- `test/main/window-layer-controller.test.js`
  - 聚焦时先进入 `screen-saver` 层再 `moveTop()`；失焦、关闭、销毁恢复普通层级。
  - 设置与字幕历史焦点切换不留下两个永久置顶窗口。
  - `dock()` 或工具条再次 `moveTop()` 后，当前聚焦正常窗口仍回到最上层。
- `test/main/ipc-access-policy.test.js`
  - 只有工具条角色可上报工具条矩形，只有字幕角色可订阅换算后的 overlap；子 frame、错误角色和未知 channel 必须 fail closed。
- `test/integration/window-interaction-journey.test.js`
  - 使用真实窗口交互模块、renderer 脚本与 preload；只把操作系统光标/DWM 作为受控外部边界。
  - 串起首帧 fail-safe → 有效矩形收缩 → 状态宽度变化 → reload generation 失效 → 新矩形恢复 → 字幕拖动/拉伸/原地点击 → 未锁定握把隐藏并拒绝 → 锁定握把只移动工具条 → 设置/字幕历史焦点往返。

本阶段结束时状态仍为已决定；红测只证明缺口被准确捕获，不得写成实现状态。

### 阶段 B：建立工具条轮廓 layout contract

新增两个可独立测试的壳层模块：

- `src/main/window-layout-contract.js`：矩形 exact-shape 校验、generation 校验、向外取整、坐标换算、字幕卡裁切和最坏尺寸回落。
- `src/main/window-layer-controller.js`：见阶段 D，先保留接口，不在此阶段混入视觉逻辑。

IPC 流程固定为：

```text
toolbar renderer
  └─ ResizeObserver 读取 #toolbar.toolbar 外接矩形
       └─ toolbar preload 上报 { generation, rect: { x, y, width, height } }
            └─ main 校验发送者、generation 与工具条内容边界
                 └─ 换算为字幕卡局部 { top, right, width, height } 并向外取整
                      └─ caption preload 只订阅已校验 overlap
                           └─ caption renderer 更新命中几何并重算最后指针位置
```

具体约束：

1. 新增固定通道 `toolbar-layout:get-context`、`toolbar-layout:report-rect` 与 `caption-layout:toolbar-overlap`；payload 分别固定为 `{ generation }`、`{ generation, rect: { x, y, width, height } }` 与 `{ generation, source, rect: { top, right, width, height } }`。
2. 主进程持有正整数 generation；toolbar 主 frame 非同文档导航/reload 或 renderer 异常退出时递增，并立刻让字幕窗进入 `584 × 64` fail-safe。
3. toolbar renderer 在脚本就绪后主动读取当前 generation，不能依赖可能早于订阅发生的一次性推送。
4. `ResizeObserver` 监听现有 `#toolbar.toolbar`；首个有效布局和后续尺寸变化都在 `requestAnimationFrame` 中去重上报。
5. 主进程只接受当前 toolbar 主 frame、当前 generation、有限数值、正尺寸且完全位于 `600 × 72` 工具条内容区的 exact-shape 矩形。
6. toolbar 与 caption WebContents 固定 zoom factor 为 `1`；CSS px 直接对应 Electron DIP。主进程按 `top = INSET - TB_MARGIN + floor(y)`、`right = INSET + (TB_W - TB_MARGIN - ceil(x + width))` 建立字幕卡局部右侧锚点；越过卡片上沿或右沿的部分收缩到边界，宽度超出当前字幕卡时由 renderer 按卡片宽度裁切。
7. 矩形非法、空交集、renderer reload、销毁或 generation 不匹配时立即回落；同代有效值到达后立即收缩。
8. preload API 不暴露任意 channel 字符串；`src/main/ipc/channels.js` 和 `access-policy.js` 使用专用 channel 与角色白名单。
9. 轮廓只驻留内存；诊断只允许固定错误码和计数，不记录矩形、路径或 renderer 原始异常文本。

预计修改：`src/main.js`、`src/main/ipc/{channels,access-policy}.js`、`src/preload/{toolbar,caption}.js`、`src/toolbar/toolbar.js`、`src/caption/{caption.js,caption.css}`。

### 阶段 C：统一抓取与命中优先级

1. 字幕 renderer 先处理透明外边距与动态 overlap，再调用 `edgeAt()`；只有不在工具条轮廓和 `8px` 拉伸带内时，字幕卡才发出 `dragStart('caption')`。
2. `20 DIP` 外边距继续由逐像素命中返回穿透，不在 document/body 上绑定拖动。
3. 主进程沿用当前 8ms 全局光标轮询。`startDrag` 记录起点但不主动改变 bounds；光标坐标不变时 `setBounds` 的目标必须与起始 bounds 相同。
4. 不增加计时器式长按或 renderer 位移阈值；第一份不同的系统光标坐标立即进入普通窗口跟随。
5. 复用现有 `.grip` 作为锁定态中性点阵握把，交互目标至少 `24 × 30 CSS px`；保持非按钮、不可聚焦和 `aria-hidden`。未锁定时用 `display: none` 退出布局与命中，renderer/main 双重拒绝工具条拖动；锁定时才由握把监听 `pointerdown` 并只移动 toolbarWin。
6. 字幕、工具条、设置与字幕历史都覆盖 `pointerup`、`pointercancel`、`lostpointercapture`、blur/destroy、重复开始；锁定变化继续强制结束字幕拖动与拉伸。

预计修改：`src/caption/{caption.js,caption.css}`、`src/toolbar/{index.html,toolbar.js,toolbar.css}`，以及固定采用的 `src/ui/shared/manual-window-drag.js`。

### 阶段 D：建立焦点层级协调器

`src/main/window-layer-controller.js` 接收 BrowserWindow 依赖并维护至多一个 `activeForegroundWindow`：

1. 设置或字幕历史 `focus`：若前一个正常窗口仍被提升，先恢复它；再对当前窗口执行 `setAlwaysOnTop(true, 'screen-saver')` 和 `moveTop()`。
2. 当前窗口 `blur`：若仍是 active，立刻 `setAlwaysOnTop(false)` 并清空引用。
3. `closed`、webContents destroyed、应用退出：幂等清理，不对已销毁窗口调用 Electron API。
4. `dock()`、字幕/工具条 ready-to-show 及任何未来 overlay 重排统一调用 `restoreWindowStack()`：先保证工具条在字幕之上，再把当前聚焦正常窗口移到最上层。
5. 新建设置/字幕历史在 `ready-to-show` 后明确 `show()` 与 `focus()`；复用现有窗口时保持 restore → show → focus 顺序。
6. 聚焦提升失败时只记录固定 role/code，窗口继续以普通层级显示；失焦恢复不得因前一次失败而跳过。

预计修改：`src/main.js` 与新增 `src/main/window-layer-controller.js`。renderer 不获得 `setAlwaysOnTop` 或 `moveTop` 能力。

### 阶段 E：统一正常窗口标题栏

1. 在 `src/ui/shared/tokens.css` 增加：
   - `--surface-window-titlebar`
   - `--border-window-titlebar`
2. 深色、浅色与 `forced-colors` 都在 token 层给值；组件 CSS 不新增主题分支。
3. 设置标题栏从 `44px` 改为 `48px`，同步 `.layout` 高度与 onboarding inset；字幕历史继续保持 `48px`。
4. 设置与字幕历史标题栏都消费共享表面与分隔线；状态文案仍使用既有状态语义色，不反向染色标题栏。
5. 标题栏 pointerdown 通过 `composedPath()` 统一排除 `button, a[href], input, select, textarea, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="textbox"], [tabindex]:not([tabindex="-1"]), [data-no-drag]`；正文不绑定拖动。
6. 深色、浅色和系统高对比下核对结构分层、关闭按钮 hover、focus-visible 与文字对比，不用强调色制造结构差异。

预计修改：`src/ui/shared/tokens.css`、`src/settings/{settings.css,settings.js}`、`src/history/{history.css,history.js}`；如采用共享 helper，则由两份 HTML 在各自 renderer 脚本之前加载。

### 阶段 F：闭合 J17 确定性联合旅程

除阶段 A 的测试外，扩展真实 Electron 产品壳旅程，使用生产 `src/main.js`、四个 renderer、各自 preload、IPC access policy 与 BrowserWindow：

- 在 `scripts/product-shell-smoke.js` 内存中断言实际矩形换算、动态收缩、reload generation、工具条/拉伸/抓取命中顺序、握把以及焦点层级往返。
- product-shell 报告最初升级到 schema v5；当前 schema-v8 另要求未锁定握把隐藏且 renderer/main 拒绝意图，同时继续兼容读取 v5-v7 历史报告。`scripts/verify-product-shell-report.js` 只接受相应布尔结果、计数与源码哈希，报告不得写矩形、桌面坐标、窗口位置、字幕正文、本地绝对路径、设备名或绝对单调时刻。
- 失败用例至少包含非法矩形、陈旧 generation、renderer reload、拖动中 blur、设置→字幕历史快速换焦和失焦恢复。
- 产品壳旅程不声称证明真人鼠标连续性、真实 DWM z-order、系统 DPI 或异缩放双屏。

命令顺序：

```powershell
npm run test:core
npm run test:integration
npm run test:evidence
npm test
```

四条命令与 J17 产品壳断言成立后，该能力才可从实现完成·尚未验收晋级为联合验收完成。

### 阶段 G：执行 I2 `dwm-drag` 实机观察

升级既有 I2 `dwm-drag` 场景，不新增重复场景 ID，涉及：

- `scripts/i2-interaction-protocol.js`
- `scripts/i2-live-interaction.js`
- `scripts/run-i2-interaction.ps1`
- `scripts/verify-i2-interaction-report.js`
- `test/validation/i2-interaction-report.test.js`

实机操作者逐项确认：

1. 从字幕卡左、中、右及多行正文空白点位按住后立即连续跟手；原地按下/松开零位移。
2. quiet、attention、会话状态通知三种工具条宽度下，真实轮廓内不拖字幕，轮廓相邻字幕卡区域可拖。
3. `20 DIP` 透明外边距点击到桌面；工具条轮廓外的 `8px` 四边/四角拉伸优先于普通拖动。
4. 解锁时握把不可见且反复操作原位置不改变字幕窗 bounds/停靠，字幕卡普通拖动区仍移动组合；锁定时握把可见并只移动工具条，字幕窗保持穿透。
5. 设置与字幕历史各自聚焦时压过字幕/工具条，失焦后恢复普通层级；标题栏可拖，正文与控件不可拖。
6. 覆盖 100/125/150/200% 系统缩放，并至少一次跨异缩放双屏移动后重复关键命中。
7. 深色、浅色、系统高对比下标题栏与正文有结构区分，且不被误读为运行状态。

`dwm-drag` 最初升级到 schema v3；当前 schema-v6 继续兼容读取 v3-v5 历史报告，并把未锁定握把观察改为“不可见且不开始拖动”。DWM harness 必须复用生产窗口交互控制器、preload 和页面资源，不复制简化版拖动实现。报告只增加闭集场景枚举、布尔、非负计数与哈希，不得包含工具条矩形、屏幕坐标、窗口绝对位置、字幕正文、本地绝对路径、设备名、绝对单调时刻或时钟偏移。严格 verifier 必须拒绝未知字段、漏项、重复组合、越界计数和只声明 completion 而未逐项确认的报告。

只有 J17 已达到联合验收完成，且当前候选绑定的 I2 `dwm-drag` 严格报告成立后，窗口交互能力才可标记为实机验收完成。

## 5. 验收矩阵

| 场景 | 确定性断言 | I2 可见断言 |
|---|---|---|
| 字幕卡普通区域 | 发出 caption drag，首个系统光标位移即更新组合 bounds | 连续跟手、无断点 |
| 原地按下/松开 | 起止 bounds 完全一致 | 窗口不跳动 |
| `20 DIP` 外边距 | captionWin 维持 ignore mouse | 桌面收到点击 |
| 工具条轮廓外的 `8px` 拉伸带 | 只发 resize，不发 drag | 四边/四角优先于普通拖动且到限不漂移 |
| 工具条真实轮廓 | 字幕 overlap 穿透；状态文字/间隙不发 drag | quiet/attention/通知宽度均不拖字幕 |
| 工具条握把 | 未锁定移出布局并由 renderer/main 拒绝；锁定只移动工具条 | 未锁定不可见且原位置操作不改变 bounds/停靠；锁定可发现并只移动工具条 |
| 首帧/reload/非法矩形 | 使用 `584 × 64` fail-safe；陈旧 generation 被拒绝 | reload 期间没有工具条点击被字幕吞掉 |
| 同代有效矩形 | fail-safe 立即收缩为真实轮廓 | 常态字幕卡不再出现固定大块断续抓取区 |
| 设置/字幕历史标题栏 | 非交互区域发 drag，全部交互控件不发 | `48px` 抓取稳定，正文不误拖 |
| 正常窗口聚焦/失焦 | 同层提升并置顶；失焦恢复；重排后层级不倒置 | 聚焦窗不再被字幕遮挡，失焦后不永久置顶 |
| 标题栏主题 | 两窗读取同一 token；forced-colors 有覆盖 | 深/浅/高对比结构一致且无状态误读 |

## 6. 风险与回退

| 风险 | 预防 | 运行时回退 |
|---|---|---|
| toolbar reload 上报旧矩形 | 主进程 generation + sender 主 frame 校验 | 立即使用 `584 × 64` fail-safe，等待同代有效值 |
| DPI 换算产生 1px 缝隙 | CSS px/DIP 契约、四边向外取整、实机多缩放观察 | 宁可临时扩大 1px，不允许字幕吞掉工具条点击 |
| `dock()` 把工具条重新抬到聚焦设置之上 | 所有 z-order 入口统一走 `restoreWindowStack()` | 再次把当前 active 正常窗口 `moveTop()` |
| 快速换焦造成两个正常窗口置顶 | 单一 `activeForegroundWindow`、幂等 demote/promote | 恢复旧窗口普通层级后再提升新窗口 |
| 交互控件被误判为抓取面 | 共享交互选择器 + composed path 测试 | 控件优先，不发 drag |
| 动态矩形通道被滥用 | exact-shape、角色白名单、有限范围、无任意 channel | 非法输入 fail closed 并回落最坏尺寸 |
| 握把太难发现或命中 | 可见形状、至少 `24 × 24 CSS px`、复杂背景核对 | 不恢复整条工具条隐藏拖动 |

若新实现导致工具条点击被字幕吞掉，只允许临时回到 `584 × 64` fail-safe；不得以撤销 generation 校验、放宽 IPC、永久固定大洞或把正常窗口永久置顶作为回退方案。

## 7. 状态晋级与提交边界

产品实现已按五个独立提交落地：

1. `docs: 登记字幕窗与窗口拖动用户旅程`
2. `feat: 同步工具条实际轮廓`
3. `feat: 统一字幕窗与工具条拖动命中`
4. `feat: 统一设置窗与字幕历史标题栏拖动`
5. `test: 建立窗口交互联合验收与实机矩阵`

每个阶段由主 agent 实现并运行对应测试，只暂存该阶段文件或代码块，不使用无范围的 `git add .`。提交前必须启动独立验证 subagent；验证者完整复读 `CONTEXT.md`、相关 SEM/J 行和暂存差异，运行该阶段正常测试，核对失败/取消路径、报告约束、测试名与预备提交信息，并只给出“允许提交”或“拒绝提交”。验证者不修改、暂存或提交。任何“拒绝提交”都必须修正并重新执行完整验证，取得“允许提交”后才可创建该阶段提交。五个提交结束后再由独立 subagent 运行 `npm test` 与跨提交语义核对；如需修正，仍按同一门禁创建范围明确的修正提交。

状态只能按下列顺序记录：

- 初始文档登记：已决定。
- 产品代码具备目标行为，但 J17 尚未闭合：实现完成·尚未验收。
- J17 确定性联合旅程与产品壳证据闭合：联合验收完成。
- 当前候选的 I2 `dwm-drag` 严格实机报告闭合：实机验收完成。
- 只有后续发布候选同时满足既有 I4/打包门禁，才可使用发布验收完成。

任何单元测试、离屏 DOM、模拟坐标或操作者 completion 字段都不能跳过上述顺序。

当前状态为联合验收完成。I2 schema-v3 单组合报告、操作者 completion 与严格 12 组合矩阵已经建立，但尚无当前候选绑定的人工 DWM、100/125/150/200% DPI、深色/浅色/高对比及异缩放双屏报告，因此不得记录为实机验收完成。

## 8. 设计依据

- Electron 的自定义拖动区域会吞掉其中的指针事件，交互控件必须显式排除；本项目继续采用更可控的主进程手动拖动：[Custom Window Interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)。
- Windows App SDK 建议把可发现的拖动区域放在窗口顶部，并为交互式标题栏预留 `48px` 高度；这支持设置/字幕历史采用标题栏抓取，而不是正文整页抓取：[Title bar customization](https://learn.microsoft.com/en-us/windows/apps/develop/title-bar?tabs=winui3)。
- Electron 提供 `setAlwaysOnTop` 与 `moveTop`，适合实现只在聚焦期间提升、失焦恢复的层级策略：[BaseWindow API](https://www.electronjs.org/docs/latest/api/base-window)。
- W3C 的 Pointer Cancellation 原则要求按下本身不立即触发不可逆动作；本计划把拖动限定为按住后的实际位移，原地释放保持 bounds 不变：[Understanding Pointer Cancellation](https://www.w3.org/WAI/WCAG22/Understanding/pointer-cancellation)。
- “安全三角形”主要解决级联菜单的指针轨迹容错，不适用于桌面窗口抓取，因此本计划不引入三角形命中区或延迟。
