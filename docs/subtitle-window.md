# 字幕与工具条窗口规范

> 状态：Rev.6 · 2026-08-09
> 本文只描述当前 Electron 窗口壳、交互不变量和视觉验收边界。具体视觉方案由 [ui-design-brief.md](ui-design-brief.md) 管理；运行状态和数据来自 [runtime-architecture.md](runtime-architecture.md)。

## 1. 当前结构

当前不是“一个大透明窗口内放字幕和工具条”，而是：

```text
可见窗口
├─ captionWin   透明、不可聚焦、常驻置顶
├─ toolbarWin   透明、可交互、常驻置顶、主任务栏窗口
├─ settingsWin  正常可聚焦、Win11 Mica 与不透明中性回落
└─ historyWin   正常可聚焦/缩放、终态文本复盘与导出

运行窗口
└─ audioHostWin 隐藏，只做采集和 AudioWorklet，不属于可见 UI
```

- 未锁定：工具条视觉上停靠在字幕卡右上角；拖字幕或工具条都会移动整个组合。
- 已锁定：字幕窗恒穿透；工具条脱离并保持可交互，可用于暂停或解锁。
- 解锁入口是工具条和 `Ctrl+Alt+L`，字幕窗内不再保留不可见 hotzone。
- 历史与导出使用独立 `historyWin`；模型资源和首启也不展开在字幕透明窗内。
- 工具条使用稳定的 `Live Subtitle` 标题和 Windows AppUserModelID，作为持续存在的主任务栏入口；不可聚焦字幕窗不单独占用任务栏。
- 工具条或任务栏最小化是应用级窗口动作：隐藏字幕，并最小化当时可见的设置/字幕历史；恢复时回到同一可见窗口集合、bounds 与前台层级，不改变当前会话或 RuntimeSnapshot。
- 设置与字幕历史的关闭仍是局部关闭；工具条“退出”或 Windows 关闭主任务栏窗口才进入应用退出屏障。

本文同时记录窗口交互要求、已达到联合验收完成的确定性范围与仍待 I2 实机验收的外部边界。凡代码现状与要求不同，均按 [SEM-F22](semantic-contract.md) 与 [J17](testing-strategy.md) 视为实现缺口，不得把当前行为反向写成要求。

## 2. 职责边界

视觉/UI 层负责：

- 字幕、工具条、设置和历史窗的 HTML/CSS。
- 运行状态的视觉表达、文案、键盘和无障碍。
- CaptionEvent reducer 到稳定 DOM 的映射。

Electron 壳层负责：

- BrowserWindow 尺寸、停靠、层级、穿透和拖动。
- 主进程手动 `setBounds` 拖动；不使用 `-webkit-app-region: drag`。
- layout contract 和按窗口 preload。

运行后端负责：

- RuntimeSnapshot、CaptionEvent、Capabilities 和 CommandResult。
- 音频、ASR、精修、模型、会话、AI 和错误恢复。

视觉模型不能为了适配设计而自行修改主进程窗口行为或伪造运行状态；需要新增能力时提交 contract request。

## 3. 当前窗口几何

当前实现值：

| 项 | 当前值 |
|---|---:|
| 字幕窗口总宽 | **可拉伸** 480–1600（再受屏幕工作区封顶），默认 920 |
| 字幕窗口总高 | **可拉伸** 140–420，默认 190 |
| 字幕窗口外边距 | 20 DIP |
| 字幕内容宽度 | 窗宽 − 40 |
| 工具条内容宽度 | 568 DIP（上界；条自适应） |
| 工具条窗口外边距 | 16 DIP |
| 工具条窗口总宽 | 600 DIP |
| 工具条窗口总高 | 72 DIP |
| 工具条停靠内缩 | 20 DIP |

工具条宽度的由来：窗口按**最坏情况**固定，条自适应收窄，窗内**右对齐**。

- **窗口宽 ≠ 遮挡宽。** 常态（idle / listening / paused / starting / stopping）加入最小化按钮后约 **319–351**，其余区域全透明且逐像素穿透。
- `error` 态会同时出现图标、说明文字、开始/停止/重试/下一步和窗口控制；内容盒上界仍固定为 568，状态区是唯一可压缩区域并先打省略号，握把、命令和历史/锁定/设置/最小化/退出不会换行或被裁掉。
- 右对齐是关键：`dock()` 按 `窗口右沿 − TB_MARGIN` 反推位置，右对齐后这个假设与实际渲染恒等，**条多宽都不影响停靠精度**，公式一行没改。
- `#toolbar.toolbar` 是 `flex-wrap: nowrap`、`.bar-group` 是 `flex: none`，挤压只落在状态文字上（打省略号），不会把「重试 / 下一步」这些出口压没，也不会换行成两层条。

窗口几何常量仍同时存在于 `src/main.js` 与 CSS 变量中，是已知的“双重真相”；工具条排除区已经按 [SEM-F22](semantic-contract.md) 使用实际 overlap rect，最坏尺寸只作为临时 fail-safe：

- 主进程拥有 BrowserWindow 外框和 overlap rect。
- UI 拥有卡片内部尺寸、间距和视觉 token。
- 若视觉模型改变工具条宽度、字幕高度或停靠位置，必须同时提交 layout contract 请求，不能只改 CSS。
- `.tb-hole` 由工具条 renderer 上报当前 `#toolbar.toolbar` 的真实外接矩形，并经 preload、IPC access policy 和主进程校验后换算为字幕卡局部的右侧锚定矩形。该矩形只在有界内存中服务布局，不持久化、不写日志或证据报告。
- 工具条 DOM 的子节点、文字、class 或 style 改变时，`MutationObserver` 必须在微任务中与 `ResizeObserver` 共用同一个“立即本地重命中、延后轮廓上报”入口。隐藏或后台窗口中的 ResizeObserver 可能被延迟，不能因此等待下一次鼠标移动才让扩张后的真实轮廓接管首击。`mouseleave` 会使上一次本地指针坐标失效；离窗后的轮廓变化不得用旧坐标重新占有 HWND。
- 窗口首帧、renderer reload、布局尚未就绪、矩形非法或 generation 陈旧时，字幕窗临时使用由 `20 DIP` 停靠内缩与 window-local `16..584 DIP` 最大真实轮廓推导的 `588 × 64` 最坏尺寸洞；它必须完整包含最大真实轮廓，收到同代有效矩形后立即收缩到真实轮廓。

## 4. BrowserWindow 不变量

字幕和工具条：

```js
{
  frame: false,
  transparent: true,
  backgroundColor: '#00000000',
  resizable: false,
  maximizable: false,
  alwaysOnTop: true,
  hasShadow: false,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    backgroundThrottling: false
  }
}
```

字幕窗额外使用 `focusable: false`、`minimizable: false`、`skipTaskbar: true`。工具条使用稳定标题、`minimizable: true`、`skipTaskbar: false`，并在真实轮廓内提供带可访问名称的 Fluent 最小化按钮。两个窗口使用 `setAlwaysOnTop(true, 'screen-saver')` 和全屏 workspace 可见配置。

工具条 BrowserWindow 以 `useContentSize: true` 创建，使构造参数的 `600 × 72 DIP` 在首个可见提交前就是内容视口；同时不声明 exact `minWidth/maxWidth/minHeight/maxHeight`：在 Win11 的 frameless/transparent 窗口上，这组原生约束会参与程序化平移的外框归一，可能把一次移动反向提交成新的宽高。`resizable: false` 只关闭用户原生拉伸入口；所有会移动工具条的手动拖动帧都必须显式提交 `600 × 72 DIP` 完整 content bounds，并与下文的主进程纠正器共同守住 exact 固定视口。字幕窗同样不得套用工具条固定尺寸，因为其宽高仍由产品自己的手动拉伸语义控制。

字幕窗、设置窗与字幕历史的手动拖动同样不得只调用 `BrowserWindow.setPosition()`。Win32 normal placement、无边框窗口组合或 DPI 归一可能在 position-only 写入中夹带陈旧宽高；因此手势开始时冻结各自完整外框尺寸，后续每个移动帧都以同一次 `setBounds({ x, y, width, height })` 提交新坐标与冻结尺寸。普通拖动只改变 `x/y`；字幕窗宽高只允许由独立的显式手动拉伸手势改变。

工具条原生内容 bounds 只有停靠协调器一个写入者。普通停靠、字幕窗组合拖动、锁定态握把拖动、启动 exact 对齐与任务栏恢复均提交到该协调器；恢复结算期间暂停其自主纠正，确认 exact 后才采用恢复基线。未标记旧配置中精确 `1373 × 168 DIP` 的字幕窗尺寸只归一一次为默认 `920 × 190 DIP`，内部修订标记不进入 renderer 配置。覆盖窗启动不再等待成对 `ready-to-show`：工具条先作为不透明可交互任务栏入口出现，双 renderer 载入与 exact 停靠在 `5s` 内闭合后才显示字幕窗；失败保留“重试 / 退出”。

字幕窗的 `resizable: false` 是原生命中不变量，不妨碍下文的主进程手动拉伸；创建后不得再调用 `setResizable(true)`。透明无边框字幕窗不能同时启用 Windows 原生拉伸边与产品自己的 `8px` 拉伸带。

主任务栏窗口的原生 `minimize` / `restore` 事件与 renderer 最小化按钮进入同一 `ApplicationWindowLifecycleController`。控制器只在有界内存中保存窗口角色、可见性、bounds、焦点引用与窗口交互代次，不保存字幕正文、设备名、路径或指针坐标。每次最小化事务先停止主进程拖动/拉伸并结算几何，再取样窗口状态、推进一次窗口交互代次，把字幕窗和工具条切到原生鼠标穿透并通知全部 renderer 静默取消本地手势；不能在活动手势结算之前把中间 bounds 保存为恢复基线。每次任务栏恢复或第二实例 `restoreOrShow` 事务再推进一次，并在该次恢复事务内依次发送同一新代次的 `suspend` 与 `resume`；恢复时若 Windows 改写了主窗口几何则主动恢复已保存 bounds。Windows 可能在原生 `restore` 事件之后再次提交主任务栏窗口 bounds，因此产品主进程必须在有界恢复结算内监听窗口集合的 `move` / `resize` 并纠正晚到漂移：最后一次原生几何事件或最后一次实际 `setBounds` 纠正后连续 **250ms** 无新变化才可收口，连续抖动时最迟 **1000ms** 发起最终纠正；安静期回调自身若实际执行了 `setBounds`，必须重新等待完整安静期，不能在同一回调发送 `resume`。若 `1000ms` 上限的最终纠正确实写入 bounds，必须继续保持 `suspend` 并进入固定、不可被后续事件延长的最多 **250ms** 原生提交确认期；确认期终点只能只读复核，不得再次写 bounds。只有该次结算与层级恢复完成后才发送 `resume`，不能在瞬时命中旧 bounds 时提前宣告恢复。随后再把当前系统光标换算成各窗口局部 DIP 坐标并要求 renderer 按当前指针重新执行命中判定。指针静止时也必须恢复正确命中。`did-finish-load` 重放当前窗口交互代次，过期代次的穿透、拖动或拉伸意图一律拒绝。若辅助窗口最小化失败，必须回滚已隐藏窗口并保留可访问的主任务栏入口；若恢复中途失败，主窗口先恢复并记录固定 `role/code`，允许用户重试或退出。

恢复等价只对辅助窗口开放：设置与字幕历史的 Win32 外框在非整数系统缩放下，`x/y/width/height` 每项与保存值相差不超过 `1 DIP` 可视为同一物理像素归一结果，不再反复 `setBounds` 或重置安静期；下一次最小化从该实际归一值重新取样，连续恢复不得累计漂移。字幕窗外框、工具条 `getContentBounds()`、`600 × 72 DIP` 固定内容视口和停靠位置仍逐项 exact；工具条透明无框外框因系统缩放多出的 `1 DIP` 只有在内容视口 exact 时才可忽略，并且不得保存为权威尺寸。`1000ms + 最多 250ms 原生提交确认` 只界定等待时间，不授权带错位恢复交互；确认期终点复读仍不等价时记录既有 `post-restore-bounds-failed`，保持窗口交互代次为 `suspend` 并走可达工具条降级。

最终纠正写入后的固定原生提交确认期整体只观察、不再纠正：期间到达的 `move` / `resize` 不得让生命周期控制器或工具条固定停靠纠正器等任一几何写入者再次调用 `setBounds` / `setContentBounds`。确认终点只复读；若第 `249ms` 仍出现不等价几何，第 `250ms` 必须降级而不是利用一次新的同步写入短暂命中 exact 后发送 `resume`。任一失败坐标都不得写成下一次恢复基线；待重试状态必须保留失败前的窗口集合、字幕窗/仍存在辅助窗 bounds 与工具条合法预期，下一次 `restoreOrShow` 复用该状态重新结算，成功后才清除。结算期间或降级后被用户关闭的设置/字幕历史从集合移除，不能阻止主入口恢复；字幕窗/工具条仍严格要求可用且等价。

生命周期同步使用仅由主进程发送的 `window:interaction-sync` 严格联合载荷：

```js
{ schemaVersion: 1, generation, phase: 'suspend' }
{ schemaVersion: 1, generation, phase: 'resume', pointer: { x, y } | null }
```

`suspend` 的 exact keyset 只能是 `schemaVersion/generation/phase`；`resume` 必须额外且只额外包含 `pointer`。`generation` 是正安全整数窗口交互代次。caption/toolbar 的 `pointer` 必须是 exact `{ x, y }` 且两项都是有限数值，可以位于窗口局部范围外；设置窗与字幕历史的 `pointer` 必须显式为 `null`，不能缺省。四个 preload 在转发回调前缓存该代次，并把既有 renderer 调用迁移为下列 exact 载荷：

```js
// window:mouse-through
{ schemaVersion: 1, generation, ignore: boolean }
// window:drag-start / window:drag-end / window:resize-end
{ schemaVersion: 1, generation }
// window:resize-start
{ schemaVersion: 1, generation, edge: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' }
```

主进程只接受当前代次。caption/toolbar 每次处理 `resume` 都必须把本地 `ignoring` 设为未知并强制发送一次同代 `window:mouse-through`，即使命中结果与上次相同；该消息同时作为命中同步确认。确认等待上限为 1000ms。迟到但仍属当前代次的合法确认可以结束降级；旧代次永不恢复。`did-finish-load` 在应用已最小化时重放 `suspend`，在可见且 bounds 已知时先设置原生鼠标穿透再重放 `resume`。

固定失败结果及优先级如下；上方失败先决定结果，后续超时不得覆盖它：

| 优先级 | `code` | 字幕窗 | 工具条 | 重试 |
|---:|---|---|---|---|
| 1 | `interaction-pass-through-failed` | 保持隐藏并拒绝当前代次交互 | 恢复主任务栏窗口并请求实心命中；若原生 setter 仍失败，任务栏入口继续作为重试入口 | 下一次恢复事务 |
| 2 | `interaction-pointer-unavailable` | 保持可见且原生鼠标穿透 | 整个工具条 BrowserWindow 实心命中 | `did-finish-load` 或下一次恢复事务 |
| 3 | `interaction-sync-timeout` | 保持可见且原生鼠标穿透 | 整个工具条 BrowserWindow 实心命中 | 迟到的当前代次合法确认、`did-finish-load` 或下一次恢复事务 |
| 4 | `stale-interaction-generation` | 不改变当前代次状态 | 不改变当前代次状态 | 只等待当前代次合法意图 |

失败记录只含固定 `role/code`。任何失败都必须停止旧 timer、旧 renderer 意图和旧 rAF；指针坐标、原始错误与 stack 不进入诊断或报告。

设置窗与字幕历史：

- `frame: false` / hidden title bar。
- 设置窗与字幕历史使用 `transparent: false` 与 `backgroundMaterial: 'mica'`；系统不支持、窗口失焦或系统高对比时由 renderer 的不透明中性表面保证可读。Mica 是长期窗口基底，不用于字幕窗或工具条透明覆盖层。确定性测试只证明配置与回落表面，真实 Mica 合成仍沿 J15a/I2 实机观察。
- 设置窗当前决定 `resizable: false`；若未来设置内容明显增长，再由 UI 与壳层共同评审是否允许缩放。
- 继续使用主进程手动拖动，保持 SEM-F22 的取消路径、焦点层级和窗口角色边界一致；材质替换不改成隐藏的整页抓取区。
- 两窗的顶部标题栏统一为 `48px`。只有标题栏的非交互区域可发出拖动意图，正文空白区不隐式拖动。
- 两窗获得焦点时临时执行 `setAlwaysOnTop(true, 'screen-saver')` 并 `moveTop()`，保证位于字幕和工具条之上；失焦时立即恢复普通层级。关闭、销毁与异常路径也必须恢复，不能形成永久置顶窗口。
- 设置与字幕历史标题栏均为 `48px`，并已接入上述焦点层级往返。
- 纯位移更新只在坐标实际变化时提交携带手势起点冻结宽高的完整 bounds；拖动 tick 不重复执行多窗 `moveTop()`，层级恢复只在拖动开始/结束、焦点或窗口拓扑变化时执行。

## 5. 拖动与穿透

### 5.0 手动拉伸

字幕窗可由用户拖边改变大小；工具条窗宽度由内容决定，设置窗是普通窗，均不参与。

- 透明无边框窗在 Windows 上没有可用的原生拉伸边。渲染层判定指针落在卡片内侧 **8px** 拉伸带后先进入待定拉伸；只有主键仍按住且沿该边相关轴累计达到 **4 DIP**，才发 `resizeStart(edge)`，主进程从届时的光标位置开始轮询并修改 bounds。未达到阈值的 `pointerup` / `pointercancel` 只清理 renderer 待定状态，不启动或结束主进程拉伸。
- 被拖的边跟着光标，对面那条边钉住；夹到上下限后要用**夹紧后的尺寸**反推原点，否则到限时窗口会漂移。
- 尺寸上下限见上表，写在 `main.js` 的 `CAP_LIMITS`，宽高上限还会再被当前屏幕工作区封顶。
- 拉伸过程中持续 `dock()`，工具条跟随。
- 锁定时禁止拉伸，`applyLock(true)` 会立刻收尾进行中的拉伸。
- 工具条实际轮廓先保持穿透；轮廓以外的卡片内侧 `8px` 拉伸带再优先于普通拖动。
- 工具条实际轮廓与字幕卡内侧 `8px` 拉伸带之间至少保留 `8 DIP` 普通拖动区间。工具条上边、右边轮廓、相邻普通拖动区以及靠近工具条的拉伸带在原地点击或相关轴不超过 `3 DIP` 的轻微抖动时都不得发起拉伸；反复点击不得累计改变字幕窗宽高，也不得让工具条随错误 bounds 向外漂移。`4 DIP` 只用于拉伸意图消歧，不适用于普通字幕卡拖动或工具条握把拖动。
- 工具条 BrowserWindow 的原生内容视口固定为 `600 × 72 DIP`，停靠与恢复使用 `getContentBounds()/setContentBounds()`；透明无框外框在非整数缩放下多出的 `1 DIP` 不能冒充内容扩张，也不能进入下一次权威基线。Windows 恢复或 DWM 重新组合若发出非用户 `resize`，主进程立即恢复固定内容宽高：未锁定时用字幕窗当前 bounds 重新求解停靠位置，已锁定时恢复最近一次合法握把/组合几何结算提交的权威 `x/y`，不能采用 resize 后的漂移坐标，也不能把用户单独移动后的工具条吸回字幕窗；原生尺寸舍入不得被下一次拖动或最小化事务继续保存、累计；最小化取样必须使用当前锁定状态重新求得的预期 content bounds；切换锁定则先结算旧状态下的活动手势、读取旧状态的预期 content bounds，再翻转并显式提交，不能采用瞬时原生读回。同步 `getContentBounds()` 暂时等于目标值后仍须保留可取消的 `250ms` 再确认，以拦截随后覆盖回来的旧 Win32 提交；新的合法握把/组合结算或锁定状态切换会替换旧确认目标。单个目标最多四次纠正写入、总确认窗口最长 `1000ms`；同一目标、同一 content/outer 观测几何的尾随原生双事件不额外消耗写入额度，只有再确认到期或观测几何确实改变才可发出下一次写入。仍不收敛就记录固定诊断，并锁存同一目标与当时观测到的 content/outer geometry。目标和观测几何都未变化的尾随原生 `move/resize` 不得重启写入；显式合法结算、锁定切换、恢复事务、预期停靠目标真正变化，或故障后原生事件确实带来不同观测几何时，才可开启一轮新的有界重试。纠正失败只记录 `{ role: 'toolbar', code: 'toolbar-dock-correction-failed' }`，保持主任务栏入口可达并在下一次带来不同观测几何的原生 `resize` 或恢复事务重试。
- 结束时把尺寸写回 `config.captionWidth / captionHeight` 并广播。

**字号不随窗口缩放。** 用户手动改变窗口后，新宽高决定一行能放下多少字和固定视口能容纳多少行；字幕内容本身绝不能自动 resize 窗口。可见行数由实际内容高度与字号计算，`config.maxLines` 不再作为 previous/current 各槽位的独立裁剪上限；满高后按 [固定高度字幕流设计](subtitle-flow-and-transcript-versions.md) 淘汰最旧视觉行。

### 5.1 手动拖动

renderer 在可拖区域发出 `dragStart(role)` 意图，主进程通过全局光标和固定宽高的 `setBounds` 更新位置。

拖动命中规则：

- 字幕窗解锁时，整张**可见字幕卡**都是抓取面，但卡片内侧 `8px` 拉伸带与工具条当前真实轮廓除外；命中顺序固定为透明外边距、工具条实际轮廓、`8px` 拉伸带、普通拖动区域。
- 字幕窗四周 `20 DIP` 透明外边距始终逐像素穿透，不是不可见抓取区。
- 主键按下后，只要系统光标产生位移就立即按普通桌面窗口逻辑跟随；不增加定时长按，也不增加 renderer 自定义移动阈值。按下再原地松开不得改变 bounds。
- 工具条的按钮、状态文字及控件间隙都属于工具条真实轮廓，不能把拖动意图传给字幕窗。未锁定、工具条嵌入字幕卡时，两列三行六点握把以 `display: none` 退出布局、真实轮廓与指针命中，组合只从字幕卡普通拖动区移动；锁定、工具条脱离字幕背景后，握把才进入既有 `24 × 30 DIP` 命中盒，作为工具条唯一拖动入口并且只移动工具条。renderer 与主进程都拒绝未锁定的工具条拖动意图，不能只依赖视觉隐藏。
- 设置与字幕历史只允许从各自 `48px` 标题栏的非交互区域开始拖动；标题栏内的按钮、链接、输入控件及正文区域均不得触发拖动。

必须覆盖：

- `pointerup`
- `pointercancel`
- `lostpointercapture`
- renderer blur/destroy
- 重复 dragStart
- 锁定状态变化
- 应用最小化/恢复与第二实例恢复

主进程在任何取消路径都要停止拖动 timer，不能只依赖 renderer 正常发出 dragEnd。
字幕窗与工具条是同一交互域内的两个重叠原生窗口。主进程必须在两者当前 `webContents` 上统一观察主键 `mouseUp`，以及活动手势期间不再带 `leftbuttondown` 的 `mouseMove`，并幂等停止该域内的拖动或拉伸 timer；不能要求结束输入必须回到手势发起窗口。发起窗口原有的 `dragEnd` / `resizeEnd` 仍保留，用于本窗正常收尾。该原生输入观察直接绑定当前窗口实例，不另建可能跨代迟到的 renderer IPC。

原生输入观察同时记录本次主键按下由哪个 overlay 接收。若 `mouseUp` 落到另一 overlay，即使字幕窗仍停留在尚未发出 `resizeStart` 的待定拉伸状态，主进程也必须停止 timer、推进窗口交互代次并立即完成 `suspend → resume`，由更高代次清理发起 renderer 的 pointer/capture/CSS 状态。renderer 收到同一鼠标主指针 ID 的下一次合法主键按下时，还要先收敛本窗可能遗留的旧手势再原子处理当前按下；不同 pointer ID 继续按多指针隔离拒绝，caption→toolbar 与 toolbar→caption 均不得让下一次鼠标拖动或按钮点击失效。真实主键输入调用 `setPointerCapture` 后，如果浏览器提供 `hasPointerCapture` 且立即确认未建立捕获，也必须按捕获抛错路径立即收敛；非可信 DOM 注入不作为原生捕获证明。
跨 overlay 的代次重置若不能成立，必须复用既有 fail-closed 路径让字幕窗保持穿透、工具条保持实心，等待 reload 或下一次恢复事务；不得新增 SEM-T04 四码闭集之外的窗口交互同步诊断。
最小化取消当前手势而不续接：renderer 必须清空活动 pointer ID、pointer capture、dragging/resizing、CSS 状态和待执行的命中 rAF，但不得在生命周期手势重置后补发旧窗口交互代次的 dragEnd/resizeEnd。恢复后只有下一次新的主键按下才能开始拖动。
timer 间隔是实现细节（当前 16ms，对齐一帧）；取消语义不依赖具体数值。

### 5.2 逐像素命中

- 透明区域默认穿透。
- 指针进入真实字幕卡或工具条时临时恢复交互。
- 字幕卡在工具条当前真实 overlap rect 内保持穿透，让上层 toolbarWin 接管事件；该 rect 是工具条 `#toolbar.toolbar` 的外接矩形，包含状态文字与控件间隙，不按 alpha 像素挖出碎片。工具条自身进入与离开都使用同一份按 `floor(left/top)`、`ceil(right/bottom)` 量化的真实矩形，不能在轮廓外保留额外迟滞或隐形实心命中带。
- 实际 rect 尚未到达、renderer reload 或报告非法/陈旧时只允许临时使用由当前停靠几何推导的 `588 × 64` 最坏尺寸回落；同代有效 rect 到达后立即替换，不能继续保留固定大洞。
- 拖动期间暂停 elementFromPoint 命中计算。
- mousemove 使用 requestAnimationFrame 节流。
- 不可聚焦字幕 BrowserWindow 已处于原生鼠标穿透时，Windows/Electron 不保证把指针重新进入卡片的移动稳定送达 renderer；因此 renderer 的 mousemove/rAF 只是一条命中同步路径，不能是唯一入口。主进程在当前窗口交互代次为 `resume`、字幕窗可见且没有活动手势时，以有界帧级轮询读取系统指针，使用同一 `20 DIP` 外边距、工具条有效 overlap rect 与字幕卡 bounds 计算原生命中，并且只在结果变化时调用穿透 API。`suspend`、reload、锁定或既有同步降级期间不得由该轮询把字幕窗恢复为实心；窗口几何、overlap、锁定状态或窗口交互代次变化后必须重新判定。该路径保持字幕窗 `focusable: false`，也不持久化或记录指针坐标。
- 锁定时 captionWin 恒穿透，renderer 不能把它重新变成实心。
- 最小化/恢复以独立于工具条布局代次的窗口交互代次同步。恢复前 captionWin/toolbarWin 先保持原生鼠标穿透，恢复后 renderer 使用同代局部 DIP 光标位置主动执行现有命中判定，并只允许同代 `mouseThrough` 改变原生命中；锁定字幕窗始终穿透，字幕窗内的工具条轮廓由字幕窗穿透后交给工具条自身按真实轮廓接管。旧代次与旧 rAF 不能覆盖新状态。
- `resume` 处理器必须在同一次回调内立即完成当前指针命中并发送同代确认，不能把首次确认排队到 rAF。主进程完成字幕窗拉伸、字幕与工具条组合拖动、锁定工具条单独移动、重新停靠或固定工具条视口成功纠正后，必须以同一窗口交互代次向所有 bounds 发生变化的 caption/toolbar renderer 重新投递当前局部 DIP 指针位置，让它们在下一次主键按下前恢复当前几何下的命中；固定视口没有实际变化时不得伪造结算。该刷新不得续接或取消已经结束的旧手势。如果异步到达的同代刷新与下一次新手势重叠，renderer 只能更新待结算指针并保持当前窗口实心，不能静默取消新手势；新手势结束后再按最新几何重命中。只有 `suspend`、更高代次或 reload 生命周期重置可以无通知清理 renderer 手势。
- 工具条 `ResizeObserver` 或 DOM 驱动变化的 `MutationObserver` 发现真实轮廓可能变化时，renderer 必须先用仍有效的最近本地指针同步更新原生命中，再把轮廓报告排到下一帧；主进程接受新的有效轮廓后再同时向 caption 与 toolbar 投递权威系统指针；工具条局部坐标必须减去 content 原点，不能使用透明外框原点。工具条从 quiet 轮廓扩张到 attention/通知轮廓并覆盖静止指针时，toolbar 必须先转为实心，随后 caption 才按报告让出该点；不能出现两窗都穿透、第一次按钮点击丢失的间隙，也不能因隐藏窗口延后 ResizeObserver 而丢失 DOM 扩张后的首击。若已经收到 `mouseleave`，旧局部坐标不可再用于该同步判定，工具条保持穿透直到新的本地移动或权威同代指针重命中。
- 指针坐标只在有界内存 IPC 中存在；固定诊断和所有证据报告不得包含坐标、绝对路径、设备名、字幕正文或绝对单调时刻。

## 6. 字幕渲染不变量

推荐保留稳定的视口和内容节点，而不是让每个语义段各自获得一份行数预算：

```html
<div class="captions" aria-live="polite">
  <div class="caption-flow"></div>
</div>
```

- `partial` 在状态层保留完整假设并允许回改；DOM 重新排版不得改写识别文本或触发 `final`。
- 文字按当前宽度自然换行；总高度满后裁掉最上方最旧的完整视觉行，最新行保持在底部，不出现横向跑马、可见滚动条或自动增高。
- `final → 下一段 partial` 不整窗清空，旧段随新行进入逐行淘汰；没有新文本时保留现有字幕。
- 首次 `final` 与可选精修稿是不同版本。会话启用精修时，迟到精修稿自动更新仍可见的已定稿段并允许重新换行；它不得修改当前 `partial`，已淘汰段也不得重新插入。
- 精修 worker 故障确认后，所有仍可见的已定稿段立即恢复为各自首次稳定转写，并在不改变窗口 bounds 的前提下重新排版；当前 `partial` 原样保留且仍具最高优先级，已淘汰段不重新插入，后续段继续使用首次稳定转写。
- translation 可晚到，但仍是独立派生文本，不能改变首次 `final` 的原始版本。
- 需要覆盖 24/30/38px、双语、长英文单词和中英混排。

视觉基线仍是“字幕优先可读、设置页承载品质感”。工具条作为跨背景悬浮控制面，固定使用主题独立的深色半透明表面与浅色普通控件；`barColor` 只作用字幕背景，`toolbarOpacity` 只作用工具条表面，Windows 系统高对比可以接管。其余颜色、圆角和材质由视觉模型根据 design brief 提案。

## 7. 运行状态表达

工具条和设置窗必须能表达：

| 状态 | 最低要求 |
|---|---|
| unavailable | 告知缺什么，并提供下一步 |
| idle | 可以开始 |
| starting | 显示等待，禁止重复开始 |
| listening | 明确正在监听哪些来源 |
| paused | 明确会话仍存在但当前不识别 |
| stopping | 禁止冲突操作，等待 flush |
| recovering | 显示正在恢复哪个组件 |
| error | 错误原因、重试/设置入口 |

精修 worker 故障不新增运行 phase。MVP 运行中按 §6 立即恢复所有仍可见 final，不在字幕窗、工具条或设置窗弹出提示，也不改变右上角颜色、正文容量、bounds 或高度。正常停止后，工具条在现有 bounds 内显示一条不抢焦点的会话状态通知和“查看历史”；它只报告处理状态，不是字幕内容摘要，也不概括或改写字幕内容，不得弹 modal、自动聚焦、发出声音或重新打开已淘汰字幕。通知保持到用户关闭或进入历史，开始下一会话时自动清除，应用重启不重放。详细结果持久化到历史，应用重启后仍可查看。若应用在正常停止前异常退出，重启后会话标为中断且不重放旧通知，历史仍显示故障和最终可计算覆盖。故障事实与 `N/M` 覆盖独立，即使 `N=M` 也必须诚实报告故障。未来若要用状态和颜色提醒，不阻断当前 MVP，但必须先补独立状态矩阵、非颜色冗余通道和后端 contract，不能由 renderer 根据缺少精修稿自行猜测。

不能只靠 `▷ / ⏸` 或红色表示全部状态。视觉模型可以重新设计图标和动效，但必须同步动态 `aria-label/aria-pressed`，并支持 `prefers-reduced-motion`。

## 8. 设置、历史和首启

建议设置窗导航最终包含：

```text
显示与字幕 / 音频源 / 语音识别 / 资源管理 / AI 与隐私 / 历史 / 关于
```

- 显示与字幕：只操作 appearancePreferences，可即时预览。
- 音频/ASR/资源/AI：根据 Capabilities 生成或禁用控件，等待 CommandResult。
- 历史：正常可聚焦，已支持终态会话选择、keyset 分页、带时间戳正文和 txt/md/srt 导出；搜索与两小时详情 DOM 回收后置到对应阶段。
- 首启：选择会议/个人听写预设，说明权限、模型下载和云端文本边界。
- 未实现功能在骨架阶段必须标注“演示模式”或禁用，不能让用户误以为已生效。
- 设置与字幕历史标题栏使用同一个主题感知的中性加深表面 token，并以 `1px` 底部分隔线与正文区分；它只表达窗口结构，不复用选中、警告、成功或运行 phase 颜色。
- 中性标题栏需覆盖深色、浅色与系统高对比；设置与字幕历史的组件 CSS 不得各自硬编码两套近似颜色。

## 9. 视觉与性能验收

- 深色、浅色、高对比度主题。
- 100%、125%、150%、200% DPI 和双屏不同缩放比例。
- 白底文档、深色视频、复杂桌面背景。
- 录制两小时后字幕和历史仍流畅。
- partial 高频更新不产生明显 layout thrash 或持续 DOM 分配。
- 无持续大面积 `backdrop-filter`；常驻透明窗动效遵守 reduced motion。
- 工具条在常态、锁定、监听和错误时均可发现、可键盘操作。
- 工具条持续提供 Windows 主任务栏入口；最小化/任务栏恢复保持当前会话、RuntimeSnapshot、窗口集合与 bounds，单独关闭设置/字幕历史不退出，关闭主窗口进入 SEM-F12 退出序列。
- 解锁字幕卡除 `8px` 拉伸带和工具条真实轮廓外可从连续点位立即拖动；透明外边距仍穿透，原地点击零位移，工具条只由明确握把拖动。
- 工具条 quiet / attention / 会话状态通知宽度变化、首帧、reload、非法与陈旧矩形回落均不产生断续抓取区。
- 设置与字幕历史聚焦时位于字幕和工具条之上，失焦后恢复普通层级；两窗的 `48px` 标题栏可拖且全部交互控件与正文不触发拖动。
- 开 DevTools 导致透明失效仍视为 Electron 调试限制，不当作产品 bug。

## 10. 当前状态与后续项

1. [SEM-F22](semantic-contract.md) 与 [J17](testing-strategy.md) 已以工具条实际 overlap rect 取代常态固定大洞；由当前停靠几何推导的 `588 × 64` 只保留为首帧、reload、非法或陈旧报告时的临时 fail-safe。
2. B1 已完成 pointercancel/lostpointercapture、blur/destroyed 与主进程拖动/缩放互斥清理。
3. B1 已把字幕接到稳定节点 + CaptionEvent reducer，并移除 renderer 假流。
4. B1 已把工具条升级为完整 RuntimeSnapshot + CommandResult。
5. B1 已让设置页识别 Capabilities；默认 Gate 0B profile 为空，开发 profile 只能由显式开关启用。
6. 视觉/UI 的 V1–V2 方案和状态矩阵已交付；历史窗口和模型资源页均已接真实主进程契约并通过开发态及 packaged 四窗口 Electron 旅程，205 段详情已验证五页往返且 DOM≤50。I3 非音频预资格又在 3,600 段/72 页下保持 DOM≤50；MVP 不展示翻译开关。J15a 可见非音频 DWM runner、单次/矩阵严格校验与 fail-closed 契约测试为实现完成·尚未验收；尚无 36 例实机 matrix 报告。物理音频、DPI/人工视觉、真实两小时声源与 I4 继续按发布门禁验收。
7. J17 的动态命中、握把、工具条边缘稳定性、几何变化后重命中、设置/字幕历史 `48px` 标题栏、共享主题 token 与焦点层级往返已达到联合验收完成；解锁字幕卡的主进程原生命中兜底为实现完成·尚未验收，确定性命中/代次/失败矩阵、跨模块拖动旅程与 I2 真实 HWND 入口接线已覆盖；I2 `dwm-drag` schema-v6 单组合报告、操作者 completion 与只接受当前 schema-v6 observation 的 12 组合严格矩阵为实现完成·尚未验收，历史 schema-v3/schema-v4/schema-v5 只允许读取，且尚未执行当前候选的 12 组合人工 DWM/DPI/异缩放观察。
8. 全窗纯位移修正为实现完成·尚未验收：字幕窗、工具条、设置窗与字幕历史的确定性联合旅程已证明每个拖动帧显式提交冻结宽高并拒绝 position-only 尺寸回写；真实 DWM、DPI 与异缩放仍沿 I2 `dwm-drag` schema-v6 观察。
