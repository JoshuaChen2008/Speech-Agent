# 字幕窗恢复后按下事件丢失：诊断记录

关联要求：SEM-F20、SEM-F22、SEM-F24；关联旅程：J17、J19；真实窗口行为仍由 I2 `dwm-drag` 验证。本次只定位故障，未实施产品修复，不晋级联合验收、实机验收或发布验收状态。

## 复现与观察

用户最初报告打开设置后字幕窗无法拖动。在使用真实 Electron、真实产品 main/preload/renderer、独立临时 userData 的非音频诊断中，用户进一步确认以下路径可以复现：

1. 新启动后，解锁字幕卡可以手动拖动。
2. 最小化工具条，再恢复应用。
3. 再次手动拖动字幕卡，字幕窗不移动；反复尝试仍失败。

无需打开设置即可复现，因此设置页不是已证明的必要触发条件。没有开始字幕会话、访问用户历史、下载模型或采集音频。

失败时的观测组合：

| 观测项 | 结果 |
|---|---|
| 窗口交互代次的 phase | `resume` |
| 字幕窗 reload 挂起标记 | false |
| 字幕窗待确认计时器 | 无 |
| 字幕窗交互错误记录 | 无 |
| 主进程按系统指针计算的字幕卡命中 | 实心 |
| 最近一次成功返回的 `setIgnoreMouseEvents` 调用参数 | false |
| 字幕窗可见性 / 启用状态 / 可聚焦状态 | true / true / false |
| 原生窗口消息观察 | 失败点击触发 `WM_MOUSEACTIVATE` |
| `before-mouse-event` 和 renderer | 有 `mouseUp` / `pointerup`，没有对应 `mouseDown` / `pointerdown` |
| 拖动主进程入口 | 失败点击没有进入 `startDrag` |

上述穿透项是 API 调用意图与正常返回，**不是**读取 Win32 扩展样式或证明 Windows 实际完成了穿透切换。

因此，故障位于按下事件进入产品拖动处理器之前。它不能用“拖动 timer 没启动”“旧代次拒绝拖动”或“renderer 捕获失败”来解释这轮现场。

## 对照实验

| 对照 | 结果与边界 |
|---|---|
| 用 `webContents.sendInputEvent` 直接送入可信鼠标事件，并控制系统指针边界 | 设置打开前、打开后、关闭后均发生位移。该入口绕过 Windows 对窗口的原生命中/激活选择，不能排除用户报告。 |
| computer-use 自动拖动 | 有时按下与捕获成立但没有位移，另有命中到下层应用的工具报错；它不能代替用户慢拖的结果，也未用于判定根因。 |
| 仅把不可聚焦字幕窗恢复时的 `showInactive()` 替换成 `show()` | 用户确认恢复后仍拖不动，日志仍只有松开事件。未保留此改动。 |
| 保留原恢复路径，结算后调用 `caption.webContents.focus()` | 用户确认仍拖不动；捕获到上述 `WM_MOUSEACTIVATE` 与仅松开事件组合。未保留此改动。 |

临时诊断通过 `scripts/run-supervised-electron.js` 运行，实验代码未进入产品入口；诊断输出只记录固定事件名、角色、布尔值与错误码。临时脚本在诊断后删除。

## 源码对应与结论强度

仓库的字幕窗以 `focusable: false` 创建；恢复路径位于 [ApplicationWindowLifecycleController](../../src/main/application-window-lifecycle-controller.js)。命中与代次控制位于 [WindowInteractionGenerationController](../../src/main/window-interaction-generation-controller.js)。

当前依赖为 Electron 43.3.0。其 [DEPS](https://github.com/electron/electron/blob/v43.3.0/DEPS) 固定 Chromium 150.0.7871.212。Electron 的 [SetFocusable](https://github.com/electron/electron/blob/v43.3.0/shell/browser/native_window_views.cc) 同时修改 widget 可激活性与 Windows 不激活样式；该 Chromium 版本的 [HWNDMessageHandler::OnMouseActivate](https://github.com/chromium/chromium/blob/150.0.7871.212/ui/views/win/hwnd_message_handler.cc) 在存在 non-client view 且不能激活的分支返回 `MA_NOACTIVATEANDEAT`，即不激活并丢弃触发的鼠标消息。

**已观察到的事实**：恢复后的不可聚焦字幕窗收到原生激活消息，但按下事件没有到达产品，松开事件仍到达。

**最强解释**：当前 Electron/Chromium 的不可聚焦窗口激活处理在恢复后吞掉按下事件，与上述源码分支一致。未在原生调试器内读取该次消息的实际返回值，也未做 Electron 版本二分；不能把源码推断表述成已经测得返回值为 `MA_NOACTIVATEANDEAT`，或已经证明是特定版本回归。

修复需在原生窗口激活/输入边界闭合，并同时保持 SEM-F24 的字幕窗不可聚焦、唯一工具条任务栏入口及 J17 的边距/锁定穿透语义。单纯换显示 API、恢复 renderer 焦点或增加拖动重试均未得到有效修复证据。不能直接把字幕窗改成可聚焦，冒充满足原要求。

## 伴随问题

多次最小化期间出现 `toolbar-dock-correction-failed`。检查可见，生命周期控制器在恢复路径暂停工具条几何纠正，但最小化路径未作同样暂停；需要单独检验最小化原生几何是否被固定视口纠正器误当作漂移。恢复后的交互仍进入 `resume`，所以当前证据不足以把该错误认定为按下事件丢失的直接原因。

## 已执行检查与未验证范围

- 上一轮六个窗口相关文件的定向检查合计 81 项返回成功，覆盖 SEM-F22/F24、J17/J19 的确定性边界；不能证明真实 Windows 点击。
- `npm run verify:renderer` 返回 0。单次计时为 3854 ms，包含 TypeScript 检查、Vite 构建及 npm 进程开销。
- `npm start` 会先执行上述准备工作，足以解释用户观察到的约 3–4 秒开发启动等待的重要部分。没有测量完整 Electron 冷启动各阶段，不能将该数字写成应用启动总耗时。
- 首次沙箱内 Electron GPU 子进程启动失败；随后隔离诊断在沙箱外运行。沙箱失败不计作产品断言结果。
- 没有执行完整三条测试 lane、当前候选 I2 的 12 组合矩阵、真实音频或安装器资格。

下一次修复验证应复用“首次手动拖动 → 最小化 → 任务栏恢复 → 新按下拖动”的原生路径，同时覆盖设置前台往返、重复恢复、锁定穿透、透明边距与不抢焦点；直接注入 renderer 事件不能充当该故障的回归证明。
