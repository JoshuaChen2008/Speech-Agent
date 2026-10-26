# TMspeech2.0 与 Speech-Agent 前端形态调查

调查日期：2026-10-08（Asia/Singapore）。重点是用户指出的字幕窗与工具条拖动、拉伸流畅度差异。本笔记只记录源码事实与据此提出的性能解释，未进行同机实测，不作为联合验收或实机验收证据。

对用户描述的差异，静态证据最支持两个解释：TMspeech2.0 使用 Windows 的移动、拉伸处理，普通工具条与字幕共用一个窗口；当前项目使用主进程定时器采样光标，并协调两个透明窗口。驱动方式与窗口形态比框架名称更接近这次体验的原因。以下性能影响均为推断，不能据此给出实测帧率或确定根因。

TMspeech2.0 固定版本为 `06a1abc744f599dd39249724840ff88f6d81acc0`，来自调查时 `master`；其 Avalonia 11.0.9 依赖对应源码 commit 为 `a33b39e8e021e01290d8d714f51ae17752fb03fd`。应用实际运行版本若不同，应重新核验这些路径。

当前项目按调查时工作树读取，HEAD 为 `d06d139f66da67fda8ac280666bedc6f9b6ead9b`；已有其它未提交改动，不能把该 HEAD 当作整个工作树的输入身份。本轮没有修改已有产品文件。

当前仓库语义边界：SEM-F14/F20/F22、SEM-T03/T05；验证关联 J17 与 I2 `dwm-drag`。本次只写研究文档，没有改变产品要求、旅程登记或产品代码；任何后续窗口形态与交互调整仍须遵循 [语义合同](../semantic-contract.md) 和 [测试策略](../testing-strategy.md)。术语已对照 [CONTEXT.md](../../CONTEXT.md) 全文。

## 1. TMspeech2.0 的生产前端

生产桌面应用是 **.NET 6 + Avalonia 11.0.9 + ReactiveUI + FluentTheme**。GUI 项目引用 Avalonia、Avalonia.Themes.Fluent、Avalonia.ReactiveUI 与 ReactiveUI.Fody；桌面入口调用 `BuildAvaloniaApp().StartWithClassicDesktopLifetime(args)`。这不是仓库内 HTML 示例页面的运行壳。[GUI 依赖](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/TMSpeech.GUI.csproj#L1-L22)、[版本定义](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/Directory.Build.props#L1-L6)、[桌面入口](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech/Program.cs#L19-L34)、[全局主题](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/App.axaml#L8-L18)。

实际设置页面是 `ConfigWindow.axaml`：左侧七项导航，右侧按 `CurrentTab` 切换各页面的 `IsVisible`，背景为 AcrylicBlur 外壳加实色内容区；没有从 HTML demo 加载 WebView 的这条入口。[设置布局与页面切换](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Views/ConfigWindow.axaml#L10-L25)、[外壳及侧栏](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Views/ConfigWindow.axaml#L54-L163)、[可见性切换](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Views/ConfigWindow.axaml#L205-L211)。

根目录 `settings-ui-demo.html` 与 `settings-glass-ui-demo.html` 是设计参考；生产样式文件注释写明与 glass demo 的设计令牌和设计语言对应，不能直接拿 HTML demo 的浏览器表现当桌面应用性能证据。[生产样式说明](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Styles/Glass.axaml#L1-L3)、[令牌说明](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Styles/Tokens.axaml#L1-L4)。

## 2. 最有解释力的差异：窗口拖动与拉伸的驱动方式

TMspeech2.0 的字幕窗口无系统装饰、置顶、透明背景、允许拉伸。指针按下时按 `16` 像素逻辑边缘判定八个拉伸方向，直接调用 `BeginResizeDrag(WindowEdge, e)`；其它位置调用 `BeginMoveDrag(e)`。指针移动处理只设置相应鼠标光标，不按应用定时器轮询坐标、反复写窗口位置。[窗口参数](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Views/MainWindow.axaml#L9-L21)、[交互入口](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Views/MainWindow.axaml.cs#L98-L146)。

这两个方法确实进入平台窗口实现：Avalonia 11.0.9 的 `Window.BeginMoveDrag` 与 `Window.BeginResizeDrag` 转发给 `PlatformImpl`。对应 Win32 实现中，移动释放指针捕获后发送 `WM_SYSCOMMAND + SC_MOUSEMOVE`；标准拉伸分支将方向映射为 `HTLEFT/HTRIGHT/HTTOP/...`，通过 `DefWindowProc(WM_NCLBUTTONDOWN, hitTest)` 进入 Windows 的窗口操作处理。[Avalonia 转发](https://github.com/AvaloniaUI/Avalonia/blob/a33b39e8e021e01290d8d714f51ae17752fb03fd/src/Avalonia.Controls/Window.cs#L409-L418)、[Win32 方向映射](https://github.com/AvaloniaUI/Avalonia/blob/a33b39e8e021e01290d8d714f51ae17752fb03fd/src/Windows/Avalonia.Win32/WindowImpl.cs#L42-L53)、[Win32 移动与拉伸入口](https://github.com/AvaloniaUI/Avalonia/blob/a33b39e8e021e01290d8d714f51ae17752fb03fd/src/Windows/Avalonia.Win32/WindowImpl.cs#L695-L728)。

源码另有 `USE_MANAGED_DRAG` 编译条件分支；所读标准 Win32 项目与根构建属性未定义该符号。因此这里描述的是该依赖版本的标准 Win32 路径，不声称审计了用户电脑上的二进制。[Win32 项目](https://github.com/AvaloniaUI/Avalonia/blob/a33b39e8e021e01290d8d714f51ae17752fb03fd/src/Windows/Avalonia.Win32/Avalonia.Win32.csproj)、[构建属性](https://github.com/AvaloniaUI/Avalonia/blob/a33b39e8e021e01290d8d714f51ae17752fb03fd/Directory.Build.props)、[构建目标](https://github.com/AvaloniaUI/Avalonia/blob/a33b39e8e021e01290d8d714f51ae17752fb03fd/Directory.Build.targets)。

**推断：**如果另一个项目使用应用层定时器轮询指针，再逐步写 `setBounds`，则其交互要受应用事件循环调度、几何调用与绘制时序影响；TMspeech2.0 这条路径直接启动 Windows 移动或拉伸处理，减少了应用自己推进手势的工作。这比简单归因于框架名称更能解释拖动时的跟手差异。真实差距仍需同机记录帧间隔与窗口几何变化证实。

## 3. 第二个关键差异：普通工具条和字幕共用一个窗口

未锁定时，工具条 `Border#controls` 放在主窗口 `mainGrid` 的第一行，字幕 `CaptionView` 放在第二行，两者位于同一个顶层窗口中。普通字幕窗拖动和拉伸不需要额外同步第二个工具条窗口的坐标。工具条悬停显隐使用 `150 ms` 的 Opacity 过渡。[同窗布局](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Views/MainWindow.axaml#L41-L63)、[工具条与字幕](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Views/MainWindow.axaml#L91-L132)。

锁定后是另一种形态：整个字幕窗通过 `WS_EX_LAYERED | WS_EX_TRANSPARENT` 穿透，另外显示一个 `LockBarWindow` 提供可点击操作。控制条显示时等待布局，再单次定位到字幕窗右上角；控制条空白区域也直接 `BeginMoveDrag(e)`。所读代码没有持续位置联动的逐帧循环。字幕窗锁定时 `IsHitTestVisible` 为 false，此时不承担普通字幕窗拖动或拉伸。[原生穿透](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Views/MainWindow.axaml.cs#L65-L94)、[独立控制条单次定位](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Views/MainWindow.axaml.cs#L39-L58)、[控制条拖动](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Views/LockBarWindow.axaml.cs#L13-L28)、[字幕窗锁定命中](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Views/MainWindow.axaml#L19-L21)。

**推断：**相比在字幕窗每次移动或拉伸后再更新独立工具条窗口，同窗工具条天然与字幕共用一份几何变化结果，减少可见的两窗相对滞后。独立工具条仍有合理的产品用途，但它增加了停靠、穿透、命中和同步工作，不能把两种窗口形态当作等量工作直接比较。

## 4. 其它前端事实与解释边界

| 方面 | TMspeech2.0 的代码事实 | 对流畅度判断的意义 |
|---|---|---|
| 字幕渲染 | 一个 TextBlock 绑定一个当前 `Text`，文本换行、底部对齐、统一阴影。[CaptionView](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Controls/CaptionView.axaml#L15-L40) | 布局工作相对简单；不应等同于多段、版本隔离与逐行淘汰的产品能力。 |
| 字幕更新 | `JobManager.TextChanged → MainViewModel.Text → TextBlock`；该 Text 订阅未显式做 rAF、Sample、Throttle 或批量通知处理。[订阅](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/ViewModels/MainViewModel.cs#L307-L319)、[转发](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.Core/JobManager.cs#L158-L171) | 源码不支持“它一定有更高级的帧合并”这一结论；绑定框架内部行为和实际更新负载需要另外测量。 |
| 识别工作 | SherpaOnnx 解码在专门后台 Thread 中运行，模型配置 `NumThreads=1`，循环含 `Thread.Sleep(20)`；开始、暂停、停止命令通过 `Task.Run` 调 Core。[识别配置和循环](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/Plugins/TMSpeech.Recognizer.SherpaOnnx/SherpaOnnxRecognizer.cs#L102-L177)、[命令](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/ViewModels/MainViewModel.cs#L231-L255) | UI 不同步执行主要解码工作，但这不证明当前项目的 worker 隔离更差。 |
| 启动 | 主窗口建立之后通过 `Task.Run` 加载插件；开始命令等待插件任务。[后台插件加载](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/App.axaml.cs#L73-L79)、[加载任务](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/App.axaml.cs#L114-L140) | 可减少首窗等待；它与持续拖动手势不是同一个瓶颈。 |
| 设置切页 | 已声明各页按 IsVisible 显隐；标准控件和统一 Glass/Tokens 样式，导航 Background 120 ms、选中标记 Opacity 150 ms。[页面](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Views/ConfigWindow.axaml#L205-L211)、[导航过渡](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Styles/Glass.axaml#L123-L174) | 视觉连续感有明确实现；不能推断所有页面切换都有动画。 |
| 历史视图 | MainViewModel 中 ObservableCollection 追加结束文本；HistoryWindow 的 ScrollViewer 包含普通 ItemsControl，选择渲染遍历 ItemCount。[数据追加](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/ViewModels/MainViewModel.cs#L157-L157)、[结束文本订阅](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/ViewModels/MainViewModel.cs#L315-L319)、[列表](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Controls/HistoryView.axaml#L13-L36)、[选择遍历](https://github.com/JoshuaChen2008/TMspeech2.0/blob/06a1abc744f599dd39249724840ff88f6d81acc0/src/TMSpeech.GUI/Controls/HistoryView.axaml.cs#L106-L141) | 不能把少量文本时的顺滑推广为长会话列表性能结论；这里没有显式虚拟化或分页实现。 |

窗口操作走 Win32 消息，只说明窗口交互路径；它不把整个 Avalonia 前端变成系统原生控件，也不能证明其文本绘制、玻璃效果、内存占用和所有 UI 操作均优于 Electron。用户指出的拖动、拉伸最值得优先对照交互驱动与普通工具条窗口形态。

## 5. 当前 Speech-Agent 的对应实现

| 方面 | TMspeech2.0 | 当前 Speech-Agent | 判断 |
|---|---|---|---|
| 前端技术 | Avalonia 11.0.9、XAML、ReactiveUI | Electron 43.3.0、Vite；设置、历史与 Agent 使用 React，字幕和工具条使用直接 DOM 更新 | 技术栈差异属实，但框架名称不能单独证明窗口跟手差异。 |
| 普通拖动 | `BeginMoveDrag` 启动标准 Win32 移动处理 | renderer 发起意图，主进程递归 `setTimeout(16)` 采样系统光标并写 bounds | 定时器驱动会受主进程调度影响，是优先实测的因素。 |
| 拉伸 | `BeginResizeDrag` 启动标准 Win32 拉伸处理 | renderer 的 8px 拉伸带与 4 DIP 消歧之后，由主进程定时写 bounds | 手势起点也不同；4 DIP 只用于区分拉伸意图，不是持续拖动的定时延迟。 |
| 未锁定工具条 | 字幕窗中的普通控件 | 视觉上嵌入字幕卡，实际仍是独立透明 BrowserWindow | 每次移动或拉伸需要协调两个原生窗口的几何。 |
| 锁定工具条 | 独立 LockBarWindow，显示时单次定位，原生移动 | 独立 toolbar BrowserWindow，主进程定时器移动；此手势暂停自主几何纠正 | 该场景能单独比较移动驱动，而不混入字幕窗联动成本。 |

本地技术栈来源：[package.json](../../package.json)、[Vite 入口](../../vite.config.mts)、[设置入口](../../src/settings/entry.tsx)、[历史入口](../../src/history/entry.tsx)、[Agent 入口](../../src/agent/entry.tsx)、[字幕 renderer](../../src/caption/caption.ts)、[工具条 renderer](../../src/toolbar/toolbar.ts)。版本是源码声明，未核验用户当前运行的二进制。

### 5.1 递归定时器不等于稳定 60fps

`ManualWindowInteractionController` 第43行的默认间隔为16ms。`dragTick` 第134–164行读取 `screen.getCursorScreenPoint()`，只在坐标变化时写窗口；本次工作结束后才安排下一次 timer。`resizeTick` 第219–255行采用同样调度结构。主进程在第202–219行创建控制器，没有覆盖间隔。[控制器](../../src/main/manual-window-interaction-controller.js)、[组合根](../../src/main.js)。

**推断：**相邻采样之间还包括本次读写的执行耗时，以及其它主进程任务造成的等待；16ms 是请求延迟，不是显示器垂直同步承诺。Node 官方也明确说明定时器回调时机取决于事件循环工作，不保证在指定时刻精确触发。[Node Timers](https://nodejs.org/api/timers.html#scheduling-timers)。高刷新率显示器的刷新周期更短，这种采样驱动更容易暴露位置更新间隔；这里没有实测实际帧率。

拖动起止经过 renderer → preload → IPC → main。持续位置更新在 main 内轮询，并非每个移动帧都必须从 renderer 发送一条位置 IPC；不能把它误写成“逐帧 IPC 往返”。[preload bridge 第18–58行](../../src/preload/shared.js)、[主进程手势入口第1277–1298行](../../src/main.js)。

### 5.2 两个透明窗口需要持续协调

`createWindows` 第714、716行分别建立 caption 与 toolbar；共同配置是无边框、透明、`resizable: false`。普通字幕拖动先更新 caption，再更新 companion toolbar。控制器已缓存两窗相对偏移，避免在该分支直接逐次执行 `dock()`；它也会跳过没有位移的写入，这些既有优化应保留。[创建与绑定第706–732行](../../src/main.js)、[窗口配置第32–45行](../../src/main/application-window-lifecycle-controller.js)、[companion 与移动第115–162行](../../src/main/manual-window-interaction-controller.js)。

工具条移动进入 `writeBounds`。自主纠正没有暂停时，第310–313行转入 `commitBounds`；它读取预期几何、校验 content/outer bounds，并维护250ms再确认和1000ms上限，move/resize事件也会触发校验。这些逻辑服务固定工具条视口与原生漂移约束，不能直接删除。主进程第1280–1282行只对锁定态工具条拖动显式暂停自主纠正。[几何协调器第288–325行](../../src/main/toolbar-dock-invariant.js)、[主进程入口](../../src/main.js)。

**推断：**两窗的连续原生读写与独立合成可能增加工作和相对滞后；这不证明用户已经遇到停靠漂移，也不证明几何再确认实际消耗了多少CPU。原生命中控制器虽然也以16ms间隔运行，但活动拖动或拉伸期间会跳过命中计算；不能将它描述为手势期间每次都额外执行一次完整命中。[命中控制器第80–99行](../../src/main/caption-native-hit-controller.js)。

### 5.3 拉伸同时改变布局

`resizeTick` 第244–250行写 caption bounds 后调用 `dock()`，主进程第817–821行重新读取字幕 bounds 并提交工具条停靠。字幕 renderer 第547–549行的 `ResizeObserver` 调用 `applyViewport`，读取实际视口高度与字号、更新可见行数，再安排视觉淘汰检查；这些工作保持SEM-F20的固定高度字幕行流。[拉伸控制器](../../src/main/manual-window-interaction-controller.js)、[停靠](../../src/main.js)、[视口和淘汰第358–367、423–463、547–549行](../../src/caption/caption.ts)。

TMspeech2.0 当前显示是单个 TextBlock；本项目维护多个字幕段、当前临时字幕优先和整段离场后的永久淘汰。**推断：**拉伸工作并不等量，布局复杂度可能进一步影响体验，需要单独测量；不能为获得顺滑观感删除已有字幕语义。

本项目字幕使用增量DOM更新，稳定结构下只修改目标段；工具条轮廓也有缓存和rAF合并。现有原生扩展修正不可聚焦字幕窗的 `WM_MOUSEACTIVATE` 吞首次按下问题，没有承担原生移动或拉伸循环。因此，当前证据不支持把这次窗口交互差异归因于React重渲染，也不支持把已有native扩展称为原生拖动实现。[字幕更新第370–407行](../../src/caption/caption.ts)、[工具条缓存第424–445行](../../src/toolbar/toolbar.ts)、[原生扩展第49–81行](../../native/caption-input/caption_input_native.cc)。

## 6. 后续优化方向

1. 先记录同机、相同DPI与刷新率下，闲置和监听状态的字幕拖动、拉伸及锁定工具条单独拖动。把主进程事件循环延迟、相对几何更新间隔和相对帧时间分别记录，判断主要成本在定时器、窗口协调还是布局。报告只存允许的相对指标、计数、布尔与哈希，不保存指针坐标或字幕正文。
2. 在保留Electron的前提下，研究让移动、拉伸进入Windows原生手势处理的原型；重点核对不可聚焦字幕窗、锁定穿透、取消、DPI、工具条边缘与恢复后的首击。Electron提供 `app-region: drag`，但它会屏蔽该区域的指针事件，不能无条件替换当前字幕卡手势入口。[Electron 官方窗口交互](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)。
3. 比较未锁定时将工具条作为字幕窗内控件、锁定时再使用独立工具条的形态，以及保留两窗但精简活动手势中几何读回与再确认的方案。任何方案都要保留固定工具条视口、零位移、动态真实轮廓和窗口交互代次约束。
4. 若测量显示拉伸布局占比明显，再合并同一帧内可重复的视口测量和淘汰检查；不能截断识别假设、复活已淘汰段或把内容换行反向变成窗口resize。

这些是待评估建议。SEM-F22当前明确要求主进程手动bounds更新；转入原生手势或改变工具条窗口形态时，应先修订语义合同与J17/I2旅程登记，再实施。纯粹修改timer间隔也不能自动证明跟手体验改善，源码注释中的Windows定时器精度不是本轮实测证据。

## 7. 验证范围

已读固定 commit 的生产项目、窗口、ViewModel、字幕控件、样式、历史控件和 SherpaOnnx 识别器源码，并对照版本匹配的 Avalonia Win32 窗口实现；没有运行 TMspeech2.0、没有启动真实监听、没有生成现场音频、没有进行帧时间/CPU/GPU/内存基准，也没有宣称 J17 或 I2 的新验收结果。

当前项目读取了AGENTS.md与CONTEXT.md全文、相关SEM行、J17/I2与执行分层边界、字幕窗口及固定高度字幕流设计、窗口控制器、main/preload、字幕/工具条renderer和原生扩展。纯研究文档按仓库规则只核对术语、语义、源码行号及链接，不运行产品测试，也不据此提升任何能力验收状态。

进一步比较应使用同一电脑、同一缩放、同一显示器刷新率，分别观察闲置和监听状态下的普通字幕窗拖动、边角拉伸、锁定工具条单独拖动；记录相对几何更新间隔、主线程繁忙与停靠关系是否保持，不保留原始几何或指针坐标。任何报告继续遵循 SEM-F14，只存相对时长、计数、布尔与哈希等允许指标。
