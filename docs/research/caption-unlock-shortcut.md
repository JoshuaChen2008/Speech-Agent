# 字幕窗锁定快捷键：交互与 Windows 边界调研

调研日期：2026-10-04。本文记录官方一手资料与本项目建议，不表示产品实现或验收；要求与验收口径仍由[语义合同 SEM-F22/F23/T05/T06](../semantic-contract.md)和[J17/J18 及测试分层 §2](../testing-strategy.md)定义。术语已对照 [CONTEXT.md](../../CONTEXT.md)。

现有行为是 `Ctrl+Alt+L` 按一次切换字幕窗锁定，主进程调用 `applyLock(!locked)`，并非按住临时解锁；见 [main](../../src/main.js) 与[字幕窗提示](../../src/caption/index.html)。本次建议保留切换行为，增加录入、保存、关闭和动态提示。

## 官方事实

| 事实 | 对本项目的意义 |
|---|---|
| VS Code 的快捷键编辑器提供修改、移除和恢复默认；Define Keybinding 控件监听按键并显示当前布局下识别出的组合，用户明确确认后提交。[VS Code](https://code.visualstudio.com/docs/configure/keybindings#keyboard-shortcuts-editor)、[按键录入](https://code.visualstudio.com/docs/configure/keybindings#keyboard-layouts) | 录入先形成草稿并显示识别结果，保存才改变正在使用的快捷键；保留取消和恢复默认。 |
| PowerToys 的 Type 对话框录入按键，接受后才将结果复制到编辑控件；正式编辑器分别维护草稿与实际规则，提供 OK、Cancel、Delete，校验冲突并显示局部错误。[PowerToys UI 开发文档](https://microsoft.github.io/PowerToys/modules/keyboardmanager/keyboardmanagerui/) | 不把任意输入字符串直接当快捷键保存；让错误在录入项附近可见。 |
| PowerToys 支持通过关闭 Keyboard Manager 停止触发，且其 UI 对通用 Ctrl 与左右 Ctrl 分开建模。官方提醒 AltGr 在 Windows 上表现为左 Ctrl 加右 Alt，可能与 Ctrl+Alt 产生问题。[开关与 AltGr](https://learn.microsoft.com/en-us/windows/powertoys/keyboard-manager#troubleshooting-keyboard-remapping-issues)、[左右键建模](https://microsoft.github.io/PowerToys/modules/keyboardmanager/keyboardmanagerui/#handling-common-modifiers-in-editkeyboardwindow) | 启用开关与已保存组合分别存储；右 Alt 必须单独建模并提示 AltGr/输入布局风险。 |
| Electron `globalShortcut` 在应用失焦时仍可触发；注册返回布尔，已被其它应用占用时失败；Electron 42 起提供 `setSuspended`，官方明确将快捷键重新录入列为使用场景。[globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut) | 保存需要核对注册回执；录入期间暂停本功能，避免旧组合触发。应用有其它全局快捷键时不要无意暂停全部功能。 |
| Electron accelerator 由多个 modifier 加一个 key code 构成，modifier 列表为通用 Ctrl、Alt、AltGr、Shift 等；文档没有左右 Alt 标识。[Accelerator](https://www.electronjs.org/docs/latest/api/accelerator) | **推论**：标准 accelerator 不能承担单独右 Alt 的精确身份承诺，需要 Windows 原生输入边界。 |
| Windows `GetAsyncKeyState` 支持 `VK_LMENU`/`VK_RMENU` 区分左右 Alt；高位表示当前是否按下，低位“最近按过”不可靠。活动桌面、UIPI 或前台线程访问权限不足时可能返回零。[GetAsyncKeyState](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getasynckeystate) | 原生状态轮询只读高位，自己维护按下/释放边沿；不能承诺登录、安全桌面或所有管理员窗口下都有同等行为。 |
| W3C 为左右键定义 `AltLeft`/`AltRight`、`ControlLeft`/`ControlRight` 等 `KeyboardEvent.code`；同一 `AltRight` 的 `key` 可能随布局成为 Alt 或 AltGraph。[KeyboardEvent code](https://www.w3.org/TR/uievents-code/#key-alphanumeric-functional) | 设置页录入身份应看 `code`，不要只看 `key === 'Alt'` 或 `altKey`；显示左右名称。 |
| Windows `RegisterHotKey` 的通用 modifier 表示任一侧；`MOD_NOREPEAT` 用于避免自动重复通知；F12 被调试器保留。[RegisterHotKey](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey)；PowerToys 明确列出 Win+L、Ctrl+Alt+Del 与通常无法接收的 Fn 等限制。[系统保留键](https://learn.microsoft.com/en-us/windows/powertoys/keyboard-manager) | “自由选择”应是实际支持按键中的自由选择；系统保留组合直接说明原因，不能显示为已经生效。 |

## 本项目实施建议

1. 在设置的字幕窗口交互区域增加“锁定快捷键”启用开关、当前组合、录入按钮和恢复默认；默认保留 `Ctrl+Alt+L`。说明“按一次切换锁定与解锁”。关闭后立即停止键位触发，保留用户组合；工具条锁定按钮始终可达。
2. 点击录入后显示“请按下快捷键”，显示识别出的左右键与组合；提供保存、取消和重新录入。录入期间暂停本功能；取消、失焦、窗口关闭、重载或异常后都必须收束录入并恢复原规则。释放录入的全部按键后才重新启用，避免保存动作顺带切换字幕锁定。
3. 支持单独右 Alt，并让单键与组合有明确匹配规则；按住不反复切换。**建议**单独 modifier 在一次干净的按下/释放后触发；若其间又按了其它键则不触发，减少把输入法或应用组合误判为单键。这个建议属于产品规则，需先登记，不能由实现暗自决定。
4. 通用组合可沿用 Electron 注册；需要左右精确身份或 modifier 单键时使用 Windows 原生边界。若选用轮询，仅保留有界内存按键状态，设置切换、禁用、录入与退出均清理；轮询无法证明“组合没有被其它应用使用”，界面不作此承诺。
5. 单独右 Alt 的提示应明确“部分布局会将右 Alt 用作 AltGr；可改用其它组合或关闭”。`AltRight` 与系统合成的左 Ctrl 是否共同出现必须走真实 Win11 布局观察；不要把 AltGr 的左 Ctrl 默认为用户另按了 Ctrl，也不要把 AltGr 冒称为通用 Alt。
6. 保存以实际注册或原生监听回执为准；失败保持原配置和原功能，并展示原因及继续编辑入口。字幕窗和工具条提示读取同一权威配置；关闭时删除快捷键文字，只保留“使用工具条解锁”等入口。

## 验证边界

J17/J18 增量应覆盖设置录入 → 真实 preload/IPC → 配置持久化 → 主进程输入边界 → 字幕锁定状态与动态提示；包括右 Alt/左 Alt 区分、按住只触发一次、关闭后零触发、取消/失焦无写入、录入不触发旧键、保存失败保留原规则、重启保留选择与关闭状态。操作系统键盘输入和注册冲突属于外部边界，产品内部模块保持真实实现。

真实左右键、AltGr、管理员窗口、安全桌面及鼠标穿透仍需 I2 相关 Win11 实机观察；定向合同或确定性联合测试不提升这些实机结论。
