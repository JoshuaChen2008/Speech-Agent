# Live Subtitle

面向 Windows 11 的本地实时字幕应用。它可以监听系统音频，或使用麦克风进行个人听写，在桌面上持续显示字幕，并把首次稳定转写自动保存到本地历史。

当前版本专注于把字幕 MVP 做成一套可以独立工作的产品：音频采集、实时 ASR、字幕显示、SQLite 历史和导出都不依赖云端服务，也不依赖 Agent。摘要、增强文本和其他 Agent 能力属于后置的可选系统，尚未实现。

## 你可以用它做什么

- 为会议、视频或其他 Windows 播放内容显示系统音频字幕。
- 使用麦克风进行单路个人听写。
- 在固定高度的字幕窗中连续阅读：文本自然换行，空间写满后从顶部逐行淘汰，最新内容始终留在视野内，窗口不会因字幕增长而改变大小。
- 暂停、恢复和停止当前会话；锁定字幕窗后保持鼠标穿透，同时继续使用独立工具条。
- 调整字号、不透明度、圆角和主题，设置会即时反映到字幕窗。
- 在本地历史中按时间查看已经结束或中断的会话，并导出 `txt`、`md` 或 `srt`。
- 按需安装精修模型，为未来新会话生成独立精修稿；原始版始终保留，并可随时切换回来。

每个会话只能选择一种音频来源：

- `loopback`：监听 Windows 当前播放的系统音频，适合会议和媒体字幕。
- `mic`：监听所选麦克风，适合个人听写。

活动会话中不能直接切换来源。需要先停止，再以另一来源建立新会话。

## 字幕和精修如何工作

说话过程中不断变化的是临时字幕，只用于实时显示，不会写入历史。一个字幕段关闭后产生的第一次稳定结果称为首次稳定转写，它是不可变的原始版，也是历史和导出的默认文本。

精修默认关闭，并且不属于核心字幕模型资源包。使用精修需要两个明确动作：

1. 在没有活动会话时单独下载精修模型。
2. 模型就绪后再开启全局精修偏好。

这个偏好只影响以后新建的会话，会话开始后便固定下来。精修稿会作为独立版本保存，不会覆盖首次稳定转写。若精修 worker 在会话中故障，实时字幕会继续使用原始版；会话正常停止后，工具条用会话状态通知说明处理结果，并提供历史入口。

## 隐私与本地数据

Live Subtitle 的数据边界是设计的一部分：

- 现场 PCM、录音片段和可回放音频永不持久化，只能短暂存在于有界内存缓冲中。
- 临时字幕不进入 SQLite、历史、导出或诊断报告。
- 首次稳定转写自动写入本地 SQLite；精修稿作为独立版本保存。
- 诊断日志和验证报告不保存字幕正文、音频文件名、设备名或本地绝对路径，也不会自动上传。
- 默认卸载只移除程序，保留 `userData` 中的模型、配置和字幕历史。当前 MVP 尚未提供用户数据清除入口。

## 当前状态

> 进度复核基线（2026-08-07）：revision `bbfd7041e5963e51942392323735298a7b81cb30` 的远端 Windows CI run `31191838016` 已达到联合验收完成。core 422 tests=415 pass+7 expected model/Silero-asset skips、integration 29/29、evidence 204/204；总计 655 tests=648 pass+7 expected skips+0 fail。布局、DB0/DB1/Gateway、schema-v4 四资源产品壳、packaged 首启/复启、exact NSIS、隔离安装卸载、revision 绑定与 artifact 上传均有对应证据；artifact ID `8999273285`、GitHub ZIP digest `5ce4070cee109df6d3d86b43b165b20a40636e8e3cd638fd9f28096da95855af`、installer SHA `d77d16c00337696727e00ad41d3fc61e1eab85d99edc4527c7cf55b548e0060c`、产品载荷 SHA `e95fd87f8af1e46e50745d8fb541d337bab783905202120df4d92e579beea35a`。7 项跳过不计作模型测试成立。

| 范围 | 状态 | 说明 |
|---|---|---|
| 固定高度字幕流、版本隔离、可选精修及历史 | 联合验收完成 | 本地确定性范围已有跨模块用户旅程和打包态证据。 |
| 非音频回归与同源两阶段实时识别 | 联合验收完成 | run `31191838016` 为 core 422 tests=415 pass+7 expected skips、integration 29/29、evidence 204/204；总计 655 tests=648 pass+7 expected skips+0 fail。J16 分别以 `mic`/`loopback` 证明单来源同帧扇出、临时字幕、权威接管、唯一首次稳定转写、失败边界与零临时字幕持久化。 |
| 远端 Windows CI 资格 | 联合验收完成 | run `31191838016` 精确绑定 revision `bbfd7041…cb30`；core 422 tests=415 pass+7 expected skips、integration 29/29、evidence 204/204，总计 655 tests=648 pass+7 expected skips+0 fail。schema-v4 产品壳与 packaged 首启/复启证明三项核心 marker、四项总资源和独立精修资源，并包含 exact NSIS 与隔离安装卸载证据。artifact ID `8999273285`、ZIP digest `5ce4070c…55af`、installer SHA `d77d16c0…060c`、产品载荷 SHA `e95fd87f…a35a`。该资格不关闭真实张量、物理来源、DWM、两小时或干净机门禁。 |
| 36 组合 DWM、主题、透明窗和异缩放双屏观察 | 实现完成·尚未验收 | runner 和严格 verifier 已就位，仍需可见实机矩阵。 |
| 真实 `loopback` / `mic` 性能与两小时稳定性 | 实现完成·尚未验收 | revision `b96b8fe7…521f` 的 `loopback` 五轮结构/精修/自然退出/零损失证据闭合，但冻结 P95=1242ms，仍高于 `<1000 ms`，六段 trace 已重新开启 Gate 0B realtime 模型替换评估；该历史 Gate 0B summary 中三个新登记的官方在线中英候选均满足裸模型 RTF/首个临时字幕边界，但都未保住内容质量，因此保持 `evaluation-only`、尚未选定替代模型，当时的生产 manifest 未变。revision `82d56f64…7939` 的 75 秒 I3 `loopback` 资格取得 31 个首次稳定转写、29 个精修稿与 15/15 成立检查，但它是 `pass/partial`，不替代真人原生拖动、7,200 秒/3,000 段或物理麦克风五轮。详情见[验收导航](docs/validation/README.md)。 |
| I4 非音频干净 Windows 子门禁 | 实现完成·尚未验收 | runner/verifier 已实现；需要无仓库、无 Node、无既有数据的标准用户机器复核真实 `userData` 与安装生命周期。 |
| 完整 I4 干净机发布验收 | 实现完成·尚未验收 | `loopback`/`mic` 来源隔离 child、strict summary 与不含仓库/Node 的移交包入口已实现；尚无专用干净 Win11 三份 child 报告，SmartScreen 与真实来源旅程仍归此门禁。 |
| Agent 系统 | 已决定 | 摘要、增强文本和 Agent Loop 后置，不阻断字幕 MVP。 |
| 代码签名 | 已决定 | 内部 MVP 阶段暂缓，当前安装器不是公开签名版本。 |

本轮按项目负责人要求取消声音测试，未执行采集、播放、WAV 推理或模型推理；因此 I2、I3 音频实机范围与完整 I4 保持实现完成·尚未验收，不以本轮 CI 结果替代。

这里的“联合验收完成”只描述已经取得确定性证据的范围，不代表真实声卡、物理麦克风、DWM 行为或干净机发布验收完成。
各门禁入口、环境、发声边界、证据位置和下一动作见[字幕 MVP 验收导航](docs/validation/README.md)。

## 运行项目

### 环境要求

- Windows 11 x64
- Node.js 与 npm
- 首次安装核心字幕模型资源包时可访问网络

项目依赖 Windows x64 的 sherpa-onnx 预编译包，其他平台执行 `npm install` 会因平台不匹配而失败。

### 开发运行

```powershell
npm install
npm start
```

`npm start` 会通过受监督入口启动 Electron。应用首次使用时：

1. 选择会议字幕（`loopback`）或个人听写（`mic`）。
2. 在设置中的模型资源页安装核心字幕模型资源包。
3. 等待实时 ASR 与 VAD 都显示就绪。
4. 回到工具条开始新会话。

核心资源就绪后，实时字幕、SQLite 保存和历史查看可以在断网且 Agent 不存在的情况下继续工作。

### 无模型的界面开发

如果只需要调试窗口、状态流和交互，可以显式启用开发用 fake runtime：

```powershell
$env:LIVE_SUBTITLE_DEV_MODEL='x-asr-480ms'
npm start
```

该模式不会证明真实 ASR、模型供给或实机音频能力，打包应用也不会接受这些开发环境变量。

## 测试

```powershell
npm run test:core         # 契约、主进程、运行时、存储和 UI
npm run test:integration  # 跨模块确定性用户旅程
npm run test:evidence     # Gate、资格 verifier 和结构化证据
npm test                  # 依次运行以上三个 lane
```

这些自动化测试不会打开真实音频设备，也不能替代物理音源、DWM、交互安装或干净机证据。Windows 的 `tar.exe` 和 Electron 子进程在受限沙箱内可能因 `EPERM` 被拒绝；这属于执行环境问题，需要在允许启动相应子进程的 Windows 环境中复核。

## 构建 Windows 安装器

```powershell
npm run package:smoke    # 生成用于打包态资格的目录包
npm run package:release  # 生成 Windows x64 NSIS 安装器
```

安装器输出到 `.artifacts/release-package/`。模型不会打进安装包，而是在首次使用时由应用按固定清单下载、校验并写入严格就绪标记。当前生成物尚未签名，只适合作为内部 MVP 候选。

## 当前不包含的能力

- 会后结构化纪要、增强文本、语义检索和其他 Agent 能力。
- 翻译、说话人分离，以及同时采集 `mic` 与 `loopback`。
- 现场音频保存或播放。
- 对用户数据执行恢复出厂式清除。
- 已签名的公开安装包和正式发布渠道。

## 架构边界

字幕系统从音频来源开始，经有界内存采集、VAD 和实时 ASR 形成字幕事件；主进程负责会话状态与故障边界，renderer 只负责显示，首次稳定转写经 storage utility 写入 SQLite，再由历史窗口分页读取和导出。可选精修只能产生独立精修稿，不能拥有或改写原始字幕事实。

未来的 Agent 系统只会消费越过字幕提交边界的已提交文本。即使 Agent 没有安装、断网或运行失败，字幕系统仍必须独立工作。

## 参与开发

改动前请先阅读 [AGENTS.md](AGENTS.md) 和完整的 [CONTEXT.md](CONTEXT.md)。功能含义与验收边界以 [语义合同](docs/semantic-contract.md) 为准，测试分层和用户旅程以 [测试策略](docs/testing-strategy.md) 为准。

## License

MIT
