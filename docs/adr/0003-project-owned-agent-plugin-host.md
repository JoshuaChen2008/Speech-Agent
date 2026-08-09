# ADR 0003：Pi 核心外置于项目自有 Agent 插件宿主

- 状态：已决定
- 日期：2026-07-30
- 决策者：项目负责人
- 依赖：ADR 0002 字幕系统与 Agent 系统分离

## 背景

产品希望以 [earendil-works/pi](https://github.com/earendil-works/pi) 的 Pi Agent Loop 为底层，并把语音上下文、增强文本、总结及未来办公能力做成可插拔模块。Pi 同时提供低层 `pi-agent-core` 和面向编码 CLI 的 `pi-coding-agent` 扩展运行时；后者带 TUI、项目目录、编码工具、JSONL 会话、动态扩展加载及完整系统权限，这些默认假设与本项目的 Electron UI、SQLite 字幕权威、内容型 Agent 和字幕独立生命周期不一致。

## 决策

只接入 `@earendil-works/pi-agent-core`，在其外建立本项目拥有的窄 `AgentPluginHost`：

1. 字幕系统继续独立拥有音频采集、ASR、会话和 SQLite 字幕事实，不作为 Pi 插件加载。
2. Agent 侧安装只读的 `TranscriptContextPlugin`，按 `sessionId + inputWatermark + transcriptVersion + digest` 读取已提交正文；它是字幕系统的适配器，不是字幕系统本身。
3. `EnhancedTranscriptPlugin` 与 `MeetingMinutesPlugin` 作为内容产物生成插件，`MemoryExtractionPlugin` 与 `MemoryConsolidationPlugin` 作为个人记忆能力；输出只能经宿主提供的 writer 写入对应 Agent 派生表，不能修改字幕事实。
4. 插件只能获得显式端口：`TranscriptReader`、`MemoryReader`、`ModelGateway`、`ArtifactWriter`、`MemoryCandidateSink`、`JobController`、`Clock`、`Logger` 与 `AbortSignal`。每个插件只取得 manifest 声明且 recipe 批准的子集；首版不给 shell、进程、任意文件写、任意网络请求、直接 SQLite 或外部服务写权限。
5. 首版只静态注册随应用发布、受信任的第一方插件。动态安装、热重载、第三方市场与独立扩展进程后置。
6. 应用事件确定何时运行能力。首版结构化纪要、个人记忆和增强文本在 `MeetingStopped` 后成为彼此独立的后台 Agent 任务；三者读取同一固定输入快照，不把“是否执行”交给 LLM 自主决定，并分别可取消、可恢复、可幂等重试。按 committed segment 滚动增强后置。
7. 调试聊天只能调用固定业务工具。写操作先由宿主给出执行预览并取得用户确认，再创建一层、固定 recipe、固定能力和预算的专用子 Agent；不存在任意 `spawn_subagent`、递归委派或子 Agent 直接写库。
8. Pi Agent Core 的工具事件、参数校验和调用钩子只用于循环内执行与观察；工具权限、输入快照、并发、持久化和产物提交仍由 `AgentPluginHost` 判定。

推荐专业名称为 **Microkernel / Plugin Architecture（微内核/插件架构）**，跨字幕边界使用 **Ports and Adapters（端口与适配器）**，持久化联动使用 **Event-driven integration（事件驱动集成）**，权限采用 **Capability-based design（基于能力的设计）**。

## 取舍

- 相比直接嵌入 `pi-coding-agent`，需要自行实现较小的清单、注册、生命周期、诊断和错误隔离层；换来正确的 Electron/SQLite 生命周期、较小依赖面和内容型权限边界。
- 相比让整个字幕系统成为 Pi 插件，少了“所有能力都在一个插件框架里”的表面一致性；换来 Agent 崩溃、重载或切换会话时字幕仍持续工作的核心承诺。
- 相比一开始支持第三方动态插件，扩展自由度较低；换来 MVP 可测试、可打包和可审计。未来需要生态时，再借鉴 VS Code 的 manifest、activation events、extension host 与 workspace trust。
- 不采用 ElizaOS 或 Semantic Kernel 替换 Pi；只借用前者的 provider/action/evaluator/service 分类和后者的函数语义元数据，避免引入第二套 Agent runtime。

## 待探针

- 当前 Pi 包为 ESM 且声明 Node `>=22.19.0`；本仓库入口仍是 CommonJS。A1 必须验证 Electron 43 utility process 的动态导入、运行时版本、取消、流式事件和打包路径。
- 冻结 `AgentPluginManifest` 的 `apiVersion/kind/requires/permissions/activationEvents/contributes/failurePolicy/timeoutMs`。
- ADR 0008 已冻结终态会话 durable reconciliation；A1/J23 仍须验证幂等键、租约恢复和 Agent job 失败不回滚字幕提交。

本 ADR 的接受冻结了 Agent 宿主边界与首版触发语义；Pi 依赖安装、兼容探针和插件运行时实现仍按 A1 排期执行，不进入字幕 MVP 当前改动。
