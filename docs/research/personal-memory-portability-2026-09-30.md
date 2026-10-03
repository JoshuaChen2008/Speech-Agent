# 个人记忆查看、编辑与跨 Agent 携带参考

检索日期：2026-09-30。范围：公开第一方产品文档与协议；没有登录产品账户验证界面。本文是研究参考，下面的建议未经批准，不新增语义要求，也不构成实现或验收证据。

建议首版让用户在“我的记忆”直接管理条目，再把用户选定的个人记忆复制或导出为 Markdown/JSON，交给本项目之外的 Agent。项目内 Agent 继续通过个人上下文模块读取有界个人上下文包。跨产品接收文本、写入对方长期记忆和持续同步是三种不同能力，不能合并承诺。

## 1. 官方材料确认的边界

| 对象 | 官方事实 | 对本项目的启示（推论） |
|---|---|---|
| ChatGPT 网页端 | 当前设置入口是 Settings → Personalization → Memory。新版 memory summary 是高层视图，可能省略可引用细节和来源；支持文本框或选中文本纠正。legacy Saved memories 是独立条目列表，条目独立于聊天历史。具体控件受账户、地区和平台影响。[Memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt) | “记忆概览”与直接管理个人记忆条目应同时有明确边界；概览不能冒充完整个人记忆表。 |
| Claude 网页端/桌面端 | 当前 Settings → Memory 的 Topics 支持逐项查看、编辑、删除，也可在聊天里要求记住、改变或忘记。每个 project 有独立记忆空间和 project summary；Settings → Capabilities 的 summary 属 legacy。[Claude chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context) | 借鉴条目管理与明确范围，不能把所有会话推断都默认升级为全局事实。 |
| Claude Code | `CLAUDE.md` 是用户编写的持续指引；auto memory 是 Claude 写的学习记录。auto memory 是本机 Markdown，可用 `/memory` 查看、编辑、删除；启动时只载入 `MEMORY.md` 前 200 行或 25 KB，主题文件按需读取。[Claude Code memory](https://code.claude.com/docs/en/memory) | Markdown 适合人工审阅和携带。文件可读不意味着每条内容都该成为指令，也不证明网页端与编码 Agent 共用存储。 |
| Claude API memory tool | 模型请求操作，由应用执行；存储由应用拥有，可以映射到数据库。官方接口同时包含读取与写入命令，并建议限制单次读取大小。[Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) | 可以借鉴“应用拥有存储、按需取上下文”；本项目的用户控制与确认规则不适合直接映射为模型可任意写入的文件操作。 |
| MCP resources | 资源以 URI 标识上下文，设计为应用控制；宿主决定怎样选择和加入模型上下文，协议不强制固定交互方式。[Resources，2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/resources) | 后续可暴露用户授权范围内的只读投影；资源被读取不等于写入接收方的长期记忆。 |
| MCP tools | 工具设计为模型可发现并调用的功能，也可以查询数据库；工具可返回资源链接。[Tools，2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) | 有界搜索适合只读工具，明确选定内容适合资源。选择取决于目标宿主实际支持，不能假定所有 Agent 都自动消费资源。 |

OpenAI 的 2026-06-04 产品材料把记忆更新的目标解释为新鲜度、连续性与相关性，并把 memory summary 用于查看要点、增补或纠正信息；这支持“可纠正综合视图”的方向，不证明概览是完整导出。[Dreaming: Better memory for a more helpful ChatGPT](https://openai.com/index/chatgpt-memory-dreaming/)

ChatGPT 的 Don't mention this again 降低后续提及，不删除原始来源；Delete and turn off memory 删除概览中显示的记忆并关闭 Memory，不删除过去聊天。这些控制不能等同于来源删除或完整导出。[Memory summary 控制](https://help.openai.com/en/articles/8590148-memory-in-chatgpt#memory-summary)

Claude 明确提供 Settings → Memory → Start import：用户粘贴其他服务输出的文本，Claude 再提取条目；该导入是实验功能，官方不保证完整吸收。官方也说明可通过聊天输出记忆后自行保存文本/Markdown。因此导出应便于人审阅，不承诺接收方无损保留或自动同步。[Import and export your memory from Claude](https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude)

资料缺口：Claude 的导出章节仍指向 Settings → Capabilities，与其新体验的 Topics 入口存在文案差异；本笔记只确认上述文本携带流程，不据此设计固定的跨产品按钮链路。[导入/导出页](https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude)、[当前记忆控制页](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)

## 2. 首版建议：直接管理与明确导出

本仓库已有“个人上下文模块”的 `manage` 查看/修改/删除控制，以及“记忆候选”“个人记忆综合视图”的规范定义。建议以条目作为用户直接编辑的对象，概览显示来源、覆盖和更新时间；会话经历记录保留“发生了什么”的职责。跨 Agent 携带是待登记建议，不能反过来改变这些定义。[CONTEXT.md](../../CONTEXT.md)、[SEM-F27/F30/F37](../semantic-contract.md)、[J21/J28](../testing-strategy.md)

| 方式 | 建议范围与操作 | 能证明什么 |
|---|---|---|
| 复制或 Markdown 导出 | 用户选择条目/项目范围，先看到将带出的全文，再复制或保存；面向人工粘贴、明确附加文件。对 Codex、Claude 等外部 Agent，先作为本次任务的上下文交付。 | 选定内容已交给接收方；是否保存为对方记忆须由用户在对方产品核对。 |
| JSON 导出 | 保存同一组选定条目的结构化快照，便于用户备份或未来受控适配。建议元数据包括格式版本、导出时间、条目身份/revision、种类、范围、确认依据、来源引用和 digest；具体 Schema 待批准后登记。 | 可保留本项目的结构和来源身份；不代表 ChatGPT、Claude 或 Codex 支持该 JSON 导入。 |
| 后续只读 MCP | 用户明确授权一个范围；读取经个人上下文模块解析的投影，按条目/字节预算限制；只读搜索工具可按需返回条目或资源链接。写入仍留在本项目的 `manage`/`ingest`。 | 能取得授权范围内的当前投影；不能撤回客户端已缓存、复制或写入其他产品的内容。 |

数据与指令需要分开：事实类个人记忆作为带来源的背景，偏好作为明确范围内的产出约束；来源正文中出现的命令不自动成为新的授权。不要把整份个人记忆自动写入 `AGENTS.md`、`CLAUDE.md` 或对方 custom instructions。用户明确选定的偏好才适合转换为对方指引，而且仍受接收方的指令优先级和权限约束。[SEM-F27/F30](../semantic-contract.md)、[ChatGPT custom instructions 与 memory 的区别](https://help.openai.com/en/articles/8590148-memory-in-chatgpt#faq)、[Claude Code 的指引与 auto memory 区分](https://code.claude.com/docs/en/memory#claudemd-vs-auto-memory)

确认与候选需要分开：建议默认携带用户明确确认或人工修正的条目；如用户选中记忆候选，明显标注“未确认”和来源，不由导出动作把它变为用户事实。来源引用保留可追溯身份，不附整场权威原始转写；digest 证明内容一致性，不证明事实正确。外部 Agent 没有取得原始来源时，不能声称已核验该来源。[SEM-F27/F30](../semantic-contract.md)、[记忆候选定义](../../CONTEXT.md)

输入需要有界：导出预览显示选定范围、数量和省略情况，按整条记忆选择；超出接收方窗口时拆分或让用户缩小范围，不能静默截断后声称已带出全部。项目内 Agent 仍使用 `resolve` 的范围、预算和省略标记；外部 Agent 的上下文窗口和工具预算需要独立核对。[SEM-F30、J21/J24](../semantic-contract.md)、[J21/J24](../testing-strategy.md)

删除需要明确副本边界：ChatGPT 删除聊天不自动删除独立 saved memory；当前 Claude 删除来源聊天也不自动删除已产生的条目，需分别管理。[ChatGPT 删除说明](https://help.openai.com/en/articles/8590148-memory-in-chatgpt#delete-remembered-information)、[Claude 数据保留说明](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)

推论：本项目删除/忘记后，新的导出和 MCP 读取应立即排除受撤销内容；已经导出的文件、粘贴的聊天和对方记忆是独立副本，需要用户在目标位置删除或更新。导出时间与 revision 用来识别陈旧副本，不能承诺自动撤回。MCP 的 `readOnlyHint` 也只是提示，只读保证应由服务端权限和实现约束执行。[MCP 官方工具注解说明](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)

## 3. 与会话总结保持独立

“会话总结”是会后结构化纪要的 UI 别名。读取个人记忆受冻结的会话总结记忆参考偏好约束；生成、编辑、接受或拒绝纪要不自动变为个人记忆。需要保留独立的“记住”动作，让用户选择具体内容并形成交互记忆信号；导出个人记忆不能顺带输出整场字幕或工具调用记录。[CONTEXT.md](../../CONTEXT.md)、[SEM-F38](../semantic-contract.md)、[J29](../testing-strategy.md)

本文仅核对公开来源、规范术语与链接；未修改语义合同、旅程矩阵或产品代码。若采纳跨 Agent 导出/MCP 建议，应按 SEM-T06 先登记要求及真实用户旅程，再实施；现有 J21/J28/J29 不能替代新的跨 Agent 证据。[SEM-T05/T06](../semantic-contract.md)、[testing-strategy](../testing-strategy.md)
