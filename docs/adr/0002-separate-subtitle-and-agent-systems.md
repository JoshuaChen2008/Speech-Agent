# ADR 0002：字幕系统与 Agent 系统分离

- 状态：已决定
- 日期：2026-07-30
- 决策者：项目负责人
- 局部替代：ADR 0001 中把 `translated`、摘要/embedding outbox 与索引绑定到字幕事实事务和 B3.3 的部分
- 局部修订：[ADR 0004](0004-immutable-first-pass-and-optional-refinement.md) 将精修移出权威原始转写；字幕系统仍可提供该本地可选派生能力，但不能用它覆盖首次 `final`。

产品由可独立交付的字幕系统与后置 Agent 系统组成。字幕系统独占音频采集、实时 ASR、`final/refined` 权威事实、SQLite 持久化和带时间戳历史；Agent 系统只从字幕提交边界按水位消费已提交正文，并把上下文增强、翻译、摘要及办公结果保存为独立派生产物。选择这个单向依赖，是为了让断网、LLM、Agent Loop 或工具故障永远不阻塞字幕，同时保留原始转写作为可审计证据。

Agent runtime 通过本项目的可替换 `AgentRuntime` 边界接入；复用 Pi 低层 Agent Core/Loop 的方向已确认，但必须先通过 A1 兼容探针，coding-agent 的默认 shell/文件工具和会话存储不成为产品权威。可靠消费由 ADR 0008 冻结为终态会话 durable reconciliation，不把 Agent outbox 写入字幕事实事务。FTS5 按历史搜索需求另行增加，embedding/`sqlite-vec` 明确 Deferred，不阻断 SQLite 历史、字幕 MVP 或首版会后结构化纪要。

补充确认的产品边界如下：

- 一次字幕会话只能选择 `loopback` 或 `mic`，两种监听模式互斥；主场景为 `loopback` 会议字幕，保留 `mic` 单路个人听写。
- 产品现在及未来都不保存原始音频，“历史/回放”只指带时间戳的文本复盘。
- LLM 增强文本独立保存并声明输入版本，永不覆盖权威转写。
- 摘要首版只做会后结构化纪要：概要、结论、待办、风险；会中滚动摘要后置。
- Agent 首版只生成内容并写入受控的内部派生产物存储，不自动执行外部操作。

Agent 插件化的具体宿主边界由 [ADR 0003](0003-project-owned-agent-plugin-host.md) 记录；它不能反转本 ADR 规定的单向依赖。
