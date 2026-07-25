# Live Subtitle Agent · 视觉/UI 模型交接说明

> 状态：Rev.1 · 2026-07-25  
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
| `src/settings/settings.html` | 设置、历史、首启等正常窗口的信息架构 |
| `src/settings/settings.css` | 设置窗口、组件和主题 |
| 未来的 `src/ui/shared/` | design tokens、共享组件样式和纯展示 helpers |
| `docs/ui-design-brief.md` | 视觉规范和交接说明 |

### 2.2 需要共同评审

| 路径/内容 | 原因 |
|---|---|
| `src/caption/caption.js` | 只允许 caption reducer、DOM 渲染、ARIA 和纯展示逻辑；不接 sherpa 原始结果 |
| `src/toolbar/toolbar.js` | 只允许把用户意图交给 `toolbarApi`，并根据 RuntimeSnapshot 渲染 |
| `src/settings/settings.js` | 只允许表单/view-model 逻辑；运行配置必须等待 CommandResult |
| BrowserWindow 宽高、边距、工具条 overlap rect | 同时影响 CSS、窗口停靠和命中测试，必须更新共享 layout contract |
| 新的按钮、设置或状态 | 可能需要新增 Command、Capability 或错误类型，先提出 contract request |

### 2.3 视觉模型禁止修改

- `src/main.js` 及未来 `src/main/` 下的窗口、IPC、状态机和服务。
- `src/preload.js` 及未来按窗口拆分的 preload。
- `src/config.js`、凭据、JSONL、模型清单和下载器。
- `src/runtime/`、audio host 和 ASR/refine workers。
- `src/contracts/` 的字段含义、状态迁移和安全校验。
- Electron 打包、安全选项和 native module 配置。

如果视觉方案需要后端尚未提供的事实，必须在交接结果中列出“需要的 contract 变更”，不能在 renderer 内伪造成功状态或自行访问 Node/Electron API。

## 3. UI 唯一依赖的运行契约

字段名在 Gate 0A 固化；下列示例表达 UI 需要的信息，不代表 renderer 可以自行生成。

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
- 开始/暂停、锁定/解锁的 `aria-label`、`aria-pressed` 随状态更新。
- 支持键盘、`:focus-visible` 和 `prefers-reduced-motion`。
- 可以重新设计常态透明度，但关键操作在复杂背景上仍需可发现。

### 4.3 设置、历史和首启

- 外观偏好可以即时预览，延迟持久化。
- 音频、模型和 AI 属于运行配置，需展示 pending/失败/实际生效值。
- 不可用能力由 Capabilities 禁用并说明原因。
- 历史放在可聚焦的正常窗口内，支持滚动、选择、搜索和导出；不塞进穿透字幕窗。
- 首启提供「会议字幕 / 个人听写」预设，并明确麦克风、系统音频权限。
- 开启翻译/摘要前明确告知：定稿文本将发送到用户配置的云端服务。

## 5. 视觉自由与系统不变量

视觉模型可以自由决定：

- 色彩、字体、圆角、阴影、材质、间距和图标风格。
- 设置页信息架构和组件外观。
- 字幕层级、工具条密度、错误提示和下载进度的表现。
- 在不影响可读性与性能的前提下增加动效。

以下是不变量：

- 三个可见窗口与隐藏 audio host 的职责不能通过 CSS/DOM 合并。
- 字幕窗和工具条窗的点击穿透、停靠关系必须服从 layout contract。
- UI 不持有 API Key，不读写模型或会话文件，不直接发网络请求。
- UI 不出现 sherpa 文件名、ONNX 路径或 IPC channel；高级诊断页除外。
- UI 不把“麦克风 / 系统音频”包装成已完成真实 diarization。
- 视觉效果不得造成持续大面积 backdrop-filter、无限动画或高频 DOM 重建。

## 6. 每次视觉交接必须包含

1. 修改过的 UI 文件列表。
2. 覆盖的 RuntimeSnapshot/CaptionEvent fixtures 列表。
3. 状态矩阵截图或说明：idle、starting、listening、paused、recovering、error。
4. 深浅色、高对比度、键盘 focus、reduced motion 检查结果。
5. 需要壳层/后端新增的 contract requests；没有则明确写“无”。
6. 若改变窗口尺寸或工具条位置，给出新的 layout contract 数值和理由，等待壳层所有者确认后再合并。

## 7. 验收底线

- 视觉模型只看本文件和 contract fixtures，就能完成 UI，不必阅读 ASR 实现。
- 后端替换模型、provider 或存储实现时，UI 不需要改 DOM/CSS。
- renderer 重载后从完整快照恢复，不依赖“恰好收到过某个事件”。
- 未安装模型、权限拒绝、设备拔出、worker 恢复和 AI 断网都有明确界面。
- 任何“看起来已经成功”的视觉状态，都能追溯到后端 RuntimeSnapshot 或 CommandResult。
