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
| 工具条停靠内缩 | 12 DIP |

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
- 窗口首帧、renderer reload、布局尚未就绪、矩形非法或 generation 陈旧时，字幕窗临时使用 `584 × 64` 最坏尺寸洞；收到同代有效矩形后必须立即收缩到真实轮廓。

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

主任务栏窗口的原生 `minimize` / `restore` 事件与 renderer 最小化按钮进入同一 `ApplicationWindowLifecycleController`。控制器只在有界内存中保存窗口角色、可见性、bounds 与焦点引用，不保存字幕正文、设备名或路径；最小化前先收尾进行中的拖动/拉伸，恢复时若 Windows 改写了主窗口几何则主动恢复已保存 bounds。若辅助窗口最小化失败，必须回滚已隐藏窗口并保留可访问的主任务栏入口；若恢复中途失败，主窗口先恢复并记录固定 `role/code`，允许用户重试或退出。

设置窗与字幕历史：

- `frame: false` / hidden title bar。
- 设置窗与字幕历史使用 `transparent: false` 与 `backgroundMaterial: 'mica'`；系统不支持、窗口失焦或系统高对比时由 renderer 的不透明中性表面保证可读。Mica 是长期窗口基底，不用于字幕窗或工具条透明覆盖层。确定性测试只证明配置与回落表面，真实 Mica 合成仍沿 J15a/I2 实机观察。
- 设置窗当前决定 `resizable: false`；若未来设置内容明显增长，再由 UI 与壳层共同评审是否允许缩放。
- 继续使用主进程手动拖动，保持 SEM-F22 的取消路径、焦点层级和窗口角色边界一致；材质替换不改成隐藏的整页抓取区。
- 两窗的顶部标题栏统一为 `48px`。只有标题栏的非交互区域可发出拖动意图，正文空白区不隐式拖动。
- 两窗获得焦点时临时执行 `setAlwaysOnTop(true, 'screen-saver')` 并 `moveTop()`，保证位于字幕和工具条之上；失焦时立即恢复普通层级。关闭、销毁与异常路径也必须恢复，不能形成永久置顶窗口。
- 设置与字幕历史标题栏均为 `48px`，并已接入上述焦点层级往返。
- 纯位移更新只在坐标实际变化时调用窗口移动 API；拖动 tick 不重复执行多窗 `moveTop()`，层级恢复只在拖动开始/结束、焦点或窗口拓扑变化时执行。

## 5. 拖动与穿透

### 5.0 手动拉伸

字幕窗可由用户拖边改变大小；工具条窗宽度由内容决定，设置窗是普通窗，均不参与。

- 透明无边框窗在 Windows 上没有可用的原生拉伸边，所以走和拖动完全一样的路子：渲染层判定指针落在卡片内侧 **8px** 拉伸带上，发 `resizeStart(edge)`，主进程轮询光标改 bounds。
- 被拖的边跟着光标，对面那条边钉住；夹到上下限后要用**夹紧后的尺寸**反推原点，否则到限时窗口会漂移。
- 尺寸上下限见上表，写在 `main.js` 的 `CAP_LIMITS`，宽高上限还会再被当前屏幕工作区封顶。
- 拉伸过程中持续 `dock()`，工具条跟随。
- 锁定时禁止拉伸，`applyLock(true)` 会立刻收尾进行中的拉伸。
- 工具条实际轮廓先保持穿透；轮廓以外的卡片内侧 `8px` 拉伸带再优先于普通拖动。
- 结束时把尺寸写回 `config.captionWidth / captionHeight` 并广播。

**字号不随窗口缩放。** 用户手动改变窗口后，新宽高决定一行能放下多少字和固定视口能容纳多少行；字幕内容本身绝不能自动 resize 窗口。可见行数由实际内容高度与字号计算，`config.maxLines` 不再作为 previous/current 各槽位的独立裁剪上限；满高后按 [固定高度字幕流设计](subtitle-flow-and-transcript-versions.md) 淘汰最旧视觉行。

### 5.1 手动拖动

renderer 在可拖区域发出 `dragStart(role)` 意图，主进程通过全局光标和固定宽高的 `setBounds` 更新位置。

拖动命中规则：

- 字幕窗解锁时，整张**可见字幕卡**都是抓取面，但卡片内侧 `8px` 拉伸带与工具条当前真实轮廓除外；命中顺序固定为透明外边距、工具条实际轮廓、`8px` 拉伸带、普通拖动区域。
- 字幕窗四周 `20 DIP` 透明外边距始终逐像素穿透，不是不可见抓取区。
- 主键按下后，只要系统光标产生位移就立即按普通桌面窗口逻辑跟随；不增加定时长按，也不增加 renderer 自定义移动阈值。按下再原地松开不得改变 bounds。
- 工具条的按钮、状态文字及控件间隙都属于工具条真实轮廓，不能把拖动意图传给字幕窗。工具条自身只有两列三行六点的明确可见握把可开始拖动，图标位于既有 `24 × 30 DIP` 命中盒内：解锁时握把移动字幕与工具条组合，锁定时握把只移动工具条。
- 设置与字幕历史只允许从各自 `48px` 标题栏的非交互区域开始拖动；标题栏内的按钮、链接、输入控件及正文区域均不得触发拖动。

必须覆盖：

- `pointerup`
- `pointercancel`
- `lostpointercapture`
- renderer blur/destroy
- 重复 dragStart
- 锁定状态变化

主进程在任何取消路径都要停止 8ms timer，不能只依赖 renderer 正常发出 dragEnd。

### 5.2 逐像素命中

- 透明区域默认穿透。
- 指针进入真实字幕卡或工具条时临时恢复交互。
- 字幕卡在工具条当前真实 overlap rect 内保持穿透，让上层 toolbarWin 接管事件；该 rect 是工具条 `#toolbar.toolbar` 的外接矩形，包含状态文字与控件间隙，不按 alpha 像素挖出碎片。
- 实际 rect 尚未到达、renderer reload 或报告非法/陈旧时只允许临时使用 `584 × 64` 最坏尺寸回落；同代有效 rect 到达后立即替换，不能继续保留固定大洞。
- 拖动期间暂停 elementFromPoint 命中计算。
- mousemove 使用 requestAnimationFrame 节流。
- 锁定时 captionWin 恒穿透，renderer 不能把它重新变成实心。

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

1. [SEM-F22](semantic-contract.md) 与 [J17](testing-strategy.md) 已以工具条实际 overlap rect 取代常态固定大洞；`584 × 64` 只保留为首帧、reload、非法或陈旧报告时的临时 fail-safe。
2. B1 已完成 pointercancel/lostpointercapture、blur/destroyed 与主进程拖动/缩放互斥清理。
3. B1 已把字幕接到稳定节点 + CaptionEvent reducer，并移除 renderer 假流。
4. B1 已把工具条升级为完整 RuntimeSnapshot + CommandResult。
5. B1 已让设置页识别 Capabilities；默认 Gate 0B profile 为空，开发 profile 只能由显式开关启用。
6. 视觉/UI 的 V1–V2 方案和状态矩阵已交付；历史窗口和模型资源页均已接真实主进程契约并通过开发态及 packaged 四窗口 Electron 旅程，205 段详情已验证五页往返且 DOM≤50。I3 非音频预资格又在 3,600 段/72 页下保持 DOM≤50；MVP 不展示翻译开关。J15a 可见非音频 DWM runner、单次/矩阵严格校验与 fail-closed 契约测试为实现完成·尚未验收；尚无 36 例实机 matrix 报告。物理音频、DPI/人工视觉、真实两小时声源与 I4 继续按发布门禁验收。
7. J17 的动态命中、握把、设置/字幕历史 `48px` 标题栏、共享主题 token 与焦点层级往返已达到联合验收完成；I2 `dwm-drag` v3 单组合报告、操作者 completion 与 12 组合严格矩阵为实现完成·尚未验收，尚未执行当前候选的 12 组合人工 DWM/DPI/异缩放观察。
