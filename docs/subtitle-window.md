# 字幕与工具条窗口规范

> 状态：Rev.3 · 2026-07-25  
> 本文只描述当前 Electron 窗口壳、交互不变量和视觉验收边界。具体视觉方案由 [ui-design-brief.md](ui-design-brief.md) 管理；运行状态和数据来自 [runtime-architecture.md](runtime-architecture.md)。

## 1. 当前结构

当前不是“一个大透明窗口内放字幕和工具条”，而是：

```text
可见窗口
├─ captionWin   透明、不可聚焦、常驻置顶
├─ toolbarWin   透明、可交互、常驻置顶
└─ settingsWin  正常可聚焦、Win11 acrylic

运行窗口
└─ audioHostWin 隐藏，只做采集和 AudioWorklet，不属于 UI
```

- 未锁定：工具条视觉上停靠在字幕卡右上角；拖字幕或工具条都会移动整个组合。
- 已锁定：字幕窗恒穿透；工具条脱离并保持可交互，可用于暂停或解锁。
- 解锁入口是工具条和 `Ctrl+Alt+L`，字幕窗内不再保留不可见 hotzone。
- 历史、导出、模型资源和首启不展开在字幕透明窗内，使用设置窗或未来独立的正常窗口。

## 2. 职责边界

视觉/UI 层负责：

- 字幕、工具条和设置窗的 HTML/CSS。
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
| 字幕内容宽度 | 880 DIP |
| 字幕窗口外边距 | 20 DIP |
| 字幕窗口总宽 | 920 DIP |
| 字幕窗口总高 | 190 DIP |
| 工具条内容宽度 | 568 DIP（上界；条自适应） |
| 工具条窗口外边距 | 16 DIP |
| 工具条窗口总宽 | 600 DIP |
| 工具条窗口总高 | 72 DIP |
| 工具条停靠内缩 | 12 DIP |

工具条宽度的由来：窗口按**最坏情况**固定，条自适应收窄，窗内**右对齐**。

- **窗口宽 ≠ 遮挡宽。** 常态（idle / listening / paused / starting / stopping）条只有 **287–319**，其余区域全透明且逐像素穿透。
- 最坏是 `error` 态（图标 + 说明文字 + 开始/停止/重试/下一步），Electron @125% DPI 实测 544。说明文字有 160px 上限，故理论上界约 554，取 568 留 14 余量。
- 右对齐是关键：`dock()` 按 `窗口右沿 − TB_MARGIN` 反推位置，右对齐后这个假设与实际渲染恒等，**条多宽都不影响停靠精度**，公式一行没改。
- `.bar` 是 `flex-wrap: nowrap`、`.bar-group` 是 `flex: none`，挤压只落在状态文字上（打省略号），不会把「重试 / 下一步」这些出口压没，也不会换行成两层条。

这些值目前同时存在于 `src/main.js` 与 CSS 变量中，是待收敛的“双重真相”。B1/V2 应建立共享 layout contract：

- 主进程拥有 BrowserWindow 外框和 overlap rect。
- UI 拥有卡片内部尺寸、间距和视觉 token。
- 若视觉模型改变工具条宽度、字幕高度或停靠位置，必须同时提交 layout contract 请求，不能只改 CSS。
- 字幕窗收到实际 overlap rect 后，以 CSS 变量更新工具条穿透区域，逐步淘汰固定的 `250 × 56` 洞。

## 4. BrowserWindow 不变量

字幕和工具条：

```js
{
  frame: false,
  transparent: true,
  backgroundColor: '#00000000',
  resizable: false,
  maximizable: false,
  minimizable: false,
  skipTaskbar: true,
  alwaysOnTop: true,
  hasShadow: false,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    backgroundThrottling: false
  }
}
```

字幕窗额外 `focusable: false`。两个窗口使用 `setAlwaysOnTop(true, 'screen-saver')` 和全屏 workspace 可见配置。

设置窗：

- `frame: false` / hidden title bar。
- `transparent: false` 与 `backgroundMaterial: 'acrylic'`。
- 当前决定 `resizable: false`；若未来设置内容明显增长，再由 UI 与壳层共同评审是否允许缩放。
- 使用主进程手动拖动，避免 app-region 与 DWM acrylic 重绘不同步。

## 5. 拖动与穿透

### 5.1 手动拖动

renderer 在可拖区域发出 `dragStart(role)` 意图，主进程通过全局光标和固定宽高的 `setBounds` 更新位置。

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
- 字幕卡在工具条 overlap rect 内保持穿透，让上层 toolbarWin 接管事件。
- 拖动期间暂停 elementFromPoint 命中计算。
- mousemove 使用 requestAnimationFrame 节流。
- 锁定时 captionWin 恒穿透，renderer 不能把它重新变成实心。

## 6. 字幕渲染不变量

推荐固定槽位：

```html
<div class="captions">
  <p class="line previous"></p>
  <p class="line current" aria-live="polite"></p>
  <p class="line translation"></p>
</div>
```

- partial 只更新 `.current.textContent` 和状态 class。
- final/refined 根据 `segmentId + revision` 更新，禁止 `innerHTML = ''` 全量重建。
- translation 可晚到，不改变主字幕的 final 状态。
- 定义整个字幕卡的总行数/高度预算，不能让 previous/current 各自都使用同一个 maxLines 后叠成四行。
- 需要覆盖 24/30/38px、双语、长英文单词和中英混排。

视觉基线仍是“字幕优先可读、设置页承载品质感”，但具体颜色、圆角、材质和工具条外观不再在本文锁死，由视觉模型根据设计 brief 提案。

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

不能只靠 `▷ / ⏸` 或红色表示全部状态。视觉模型可以重新设计图标和动效，但必须同步动态 `aria-label/aria-pressed`，并支持 `prefers-reduced-motion`。

## 8. 设置、历史和首启

建议设置窗导航最终包含：

```text
显示与字幕 / 音频源 / 语音识别 / 资源管理 / AI 与隐私 / 历史 / 关于
```

- 显示与字幕：只操作 appearancePreferences，可即时预览。
- 音频/ASR/资源/AI：根据 Capabilities 生成或禁用控件，等待 CommandResult。
- 历史：正常可聚焦，支持选择、搜索、导出和长列表回收。
- 首启：选择会议/个人听写预设，说明权限、模型下载和云端文本边界。
- 未实现功能在骨架阶段必须标注“演示模式”或禁用，不能让用户误以为已生效。

## 9. 视觉与性能验收

- 深色、浅色、高对比度主题。
- 100%、125%、150%、200% DPI 和双屏不同缩放比例。
- 白底文档、深色视频、复杂桌面背景。
- 录制两小时后字幕和历史仍流畅。
- partial 高频更新不产生明显 layout thrash 或持续 DOM 分配。
- 无持续大面积 `backdrop-filter`；常驻透明窗动效遵守 reduced motion。
- 工具条在常态、锁定、监听和错误时均可发现、可键盘操作。
- 开 DevTools 导致透明失效仍视为 Electron 调试限制，不当作产品 bug。

## 10. 当前待办

1. 用 layout contract 消除 JS/CSS 尺寸双重真相。
2. 为拖动增加 pointercancel/lostpointercapture 和主进程兜底清理。
3. 把字幕改为稳定节点 + CaptionEvent reducer。
4. 工具条从布尔状态升级为完整 RuntimeSnapshot。
5. 设置页由静态控件改为 Capabilities 驱动。
6. 视觉模型基于 `ui-design-brief.md` 提交新版方案和状态矩阵。
