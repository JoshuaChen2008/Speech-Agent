# 功能与验收语义合同

> 状态：Accepted · 2026-07-31
>
> 目的：冻结“项目承诺了什么、没有承诺什么、需要什么证据才能称为完成”。

## 1. 文档职责与冲突处理

| 文档 | 唯一职责 |
|---|---|
| [`CONTEXT.md`](../CONTEXT.md) | 规范术语及其精确定义 |
| **本文** | 功能要求、测试边界与完成口径 |
| [`adr/`](adr/) | 已接受架构决策及其替代关系 |
| [`data-architecture.md`](data-architecture.md) | SQLite 字幕事实、Agent 派生产物与后置索引的实现约束 |
| [`testing-strategy.md`](testing-strategy.md) | 测试层级、旅程 ID、执行环境和当前证据 |
| [`../PLAN.md`](../PLAN.md) | 排期、阶段和实时状态，不重新定义语义 |

如果代码或状态文档与本文冲突，先把差异记录为实现缺口；不能悄悄用现状改写要求。若要改变本文，必须同时说明受影响的旅程、验收门禁和迁移方式；涉及难以回退的架构选择时新增或 supersede ADR。

## 2. 规范语义表

下表中的“必须”是验收要求。“当前状态”只陈述截至 2026-07-31 的证据，不能用来降低要求。

| ID | 主题 | 冻结语义与必须行为 | 明确不表示 / 禁止理解 | 必需证据 | 当前状态 |
|---|---|---|---|---|---|
| **SEM-F00** | 双系统边界 | 产品由可独立交付的字幕系统与可选 Agent 系统协作组成。字幕系统负责采集、ASR、显示、持久化和历史；Agent 系统只能从字幕提交边界消费已落盘正文并生成派生产物。 | Agent 不得成为开始监听、显示字幕、保存历史或查看原文的前置依赖；两套系统不表示两个安装包；“插件化”不得反转依赖。 | 字幕 MVP 的 J1/J2/J10 在 AI 完全关闭时通过；Agent 故障走 J7。 | 边界已决定；现有运行时尚未实现 Agent 系统。 |
| **SEM-F01** | 系统音频监听 | “监听系统音频”指 Windows `loopback` 来源进入 VAD/ASR，产生带 `sourceId=loopback` 的字幕并进入同一会话后续能力。 | 不叫“本地声音”；不保证识别出具体远端说话人；确定性 CI 不证明真实声卡。 | J1 + I2 loopback smoke；涉及摘要时再加 J3。 | 2026-07-31 schema v2 实机 smoke 已验证 loopback→真实 ASR→精修，CER 0，captured/sent/ingested 帧数一致且零丢失/零缺口；J1 确定性链路已覆盖。 |
| **SEM-F02** | 互斥监听模式与来源归因 | 每个会话必须且只能选择 `loopback` 或 `mic`。`loopback` 是会议字幕主模式，`mic` 保留为单路个人听写；活动会话中不得并发两路或直接换源，停止后才能以另一来源开始新会话。 | 不提供 `mic + loopback` 双路产品模式；`mic=我`、`loopback=对方` 也不是身份承诺；当前不包含 diarization。 | J1/J2/J4；两种来源分别做 I2 实机 smoke，不再要求双路 soak。 | 产品各层和 J4 均执行 XOR；I2 runner 已支持 `--source loopback|mic` 分开运行，loopback 实机通过，物理 mic 实机证据仍待补。 |
| **SEM-F03** | 临时字幕 | partial 只用于低延迟 UI；不能写入权威会话、摘要、FTS 或向量索引，也不能在 reload 后伪装成已定稿历史。 | partial 出现在界面不等于会话已持久化。 | reducer/存储局部测试 + J1/J2。 | 已覆盖。 |
| **SEM-F04** | 一遍定稿与精修 | final 是可恢复的一遍定稿；同段更高有效 refined 成为当前正文。重复、乱序或迟到事件不得回滚正文或产生第二段。 | `final` 不表示永不变化；refined 不表示新增段落；不得原地抹除旧事实。 | revision 局部回归 + J1/J2/J5/J6。 | 核心链路、Gateway 恢复组合、默认产品 SQLite-only 旅程及历史复盘联合旅程均覆盖 final→refined 单投影；受控真实 Electron 产品壳已验证 final DOM→停止→终态历史，真实 refine 仍由 I2 loopback 证据承担，I3/I4 待补。 |
| **SEM-F05** | 翻译 | 翻译属于 Agent 系统派生能力，必须绑定 `segmentId` 和 `basedOnRevision`；过期翻译不得覆盖新正文对应的译文，翻译失败不影响原文。B3.1 遗留 JSONL 中的 `translated` 记录只读保留，B3.3 不把它导入字幕 `caption_events`，未来由 Agent 迁移进入独立派生表。 | 翻译不是字幕 MVP，也不是正文修订；测试中注入 translated 事件不等于真实 AI 翻译已实现；不得为了旧格式逐字节一致而把译文混入新的字幕事实或原文导出。 | 契约/折叠测试；B3.3 的 DB2/J10 校验原文投影；真实 Agent 能力加入 J5/J7。 | 迁移内核和默认产品冷启动联合 CI 已确认遗留 translated 只计数且旧 JSONL 不改写，不进入 SQLite 字幕事实、当前原文或 txt/md/srt digest；Agent 生成与派生表迁移未实现。 |
| **SEM-F06** | 会话隔离 | 字幕、翻译、增强文本、摘要和可选索引结果都必须携带并校验 `sessionId`；新会话不得消费上一会话的迟到结果。 | renderer reload、pause/resume 或 worker replacement 不创建新会话。 | 状态机测试 + J5/J6；跨会话故障注入。 | 字幕核心状态已有回归；Agent 派生物尚未覆盖。 |
| **SEM-F07** | 权威持久化 | 字幕系统的目标唯一权威存储是 SQLite：不可变字幕事件是事实，segments 是可重建当前投影。B3.3 验收前，现有 JSONL 只是已实现过渡基线；迁移后只作导入导出/恢复。 | 不允许 SQLite/JSONL 长期双写；Agent 产物、向量、UI 状态或单个可变 transcript 行都不是字幕事实来源。 | DB0–DB2 + J1/J2 在 SQLite 后端重跑 + J10。 | 默认 `main.js` 已一次性切换到 `StorageGateway → SqliteSessionRecorder`；确定性产品与历史复盘联合 CI 已验证两次冷启动、迁移幂等、XOR 会话、终态列表/详情/导出和退出屏障。受控真实 Electron 已验证 fresh userData 启动、SQLite 会话、历史窗口和正常退出；Electron 内旧 JSONL import/重启、I3 与打包态 DB0/I4 仍待。 |
| **SEM-F08** | 字幕与会后结构化纪要 | 摘要属于 Agent 系统。首版在会话停止后，只消费该会话越过字幕提交边界的 final/refined 当前正文，并生成概要、结论、待办、风险；结果携带 `sessionId`、完整输入水位和 digest。 | 不消费 partial；首版不承诺会中滚动摘要；待办只是内容，不自动执行；不能因重试重复计入同一段。 | Agent 阶段的 J3/J5/J6/J7/J13 全部阻断；长稳另验。 | 语义已决定，尚未实现；不阻断字幕 MVP。 |
| **SEM-F09** | AI 故障降级 | AI 关闭、超时、限流、断网、凭据失效或 worker 崩溃时，本地采集、字幕、精修、持久化和导出继续；错误只降低 AI capability。 | 不允许把 AI 故障升级为会话停止；不允许静默丢任务后仍显示“已完成”。 | J6/J7 + 重启重放测试。 | 规则已冻结，AI 层未实现。 |
| **SEM-F10** | 可选语义检索 | `sqlite-vec` 是后期附加能力，只能索引当前正文；结果必须匹配正文 revision、内容哈希、模型和维度。扩展不可用时字幕历史必须完整可用。 | 向量不属于字幕 MVP，不是 SQLite 选型或 Agent 摘要上线的前置；删除索引不能删除字幕。 | 后期启用时执行 DB4 + J11 + 打包版门禁。 | 已后置，近期略去实现。 |
| **SEM-F11** | 带时间戳的字幕历史 | 字幕 MVP 必须自动保存已定稿正文；活动会话只在实时字幕窗显示，正常结束或被中断后才进入历史列表，并能按会话查看稳定时间线。renderer 只按 `(t0Ms, firstEventOrder)` keyset 读取有界详情页且只保留当前页；完整 transcript 只留在 main/storage 边界供导出与迁移，txt/md/srt 不得因 UI 页大小而截断。Agent 派生物存在时必须与原文分层展示。 | 能写 JSONL、能导出文件或只在当前字幕窗看到文字，都不等于历史查看已完成；把完整 transcript 暴露给 renderer、把“每页 50 条”误作导出上限也不合格；“回放”只表示文本复盘，不表示音频播放。 | J1/J2；迁移后 J10；确定性长详情前置 + 两小时 J8。 | 会话列表、终态过滤、带相对/墙钟时间的历史窗口及 SQLite 当前投影 txt/md/srt 导出已实现。205 段（含同时间戳跨页与 refined）的真实多模块旅程已证明 5 页无缺失/重复且三格式仍完整；真实 Electron main/preload/IPC/renderer 已点击 5 页、往返上一批/下一批并证明时间线 DOM 上界 50。该加速证据不等于两小时/数千段资源稳定性；系统保存对话框、J8/I3 与 I4 仍待。 |
| **SEM-F12** | 暂停、恢复与崩溃 | pause/resume 保留同一会话；迟到结果按 revision/watermark 处理。ASR 或 storage worker 重启后，已提交字幕事实可恢复；Agent 待办后续必须可幂等重放。运行 worker 故障后即使用户不点重试/停止，也必须主动释放采集资源。native worker 正常收束先给 30 秒 graceful window；超时后只能终止并等待该 exact child，reap window 为 5 秒。字幕应用运行时以 45 秒作为优雅收束结束/升级触发线，ModelManager 的 5 秒收束与其并行；升级后仍须等待 exact child 收殓，因此 45 秒不是硬退出上限。 | 不允许为了恢复接受跨会话事件；不允许在 error 状态继续占用 mic/loopback；旧 native worker 未确认退出前不得启动 replacement generation；不得按进程名批量终止 Electron；不得用“硬总上限”绕过 exact-child exit 确认；Agent 恢复不得反向阻塞字幕恢复。诊断通过不等于根因定位、硬崩溃恢复、物理音频、I3 或 I4 验收。 | J5/J6 + DB1 + I2 故障 smoke；真实模型活跃生命周期诊断；受监督产品壳 role evidence。 | realtime/refine/storage UtilityProcess 已接 fatal `error`、角色标签和 exact-child exit 屏障；Coordinator 在旧世代 retirement 完成前禁止启动 replacement generation。批准模型活跃诊断三轮共 303 帧、3 final、3 refined、3 offline decode，6 个 worker 均优雅 exit 0、fatal 0；修复后真实 I2 loopback 单轮 128 帧 captured/sent/ingested 一致、0 dropped/gap/bad sample、1 final + 1 refined、双 CER 0，exact process 正常退出且无强制终止；受监督多窗口产品壳为 clean exit、0 incident、未观察到 breakpoint。role evidence 只保存固定枚举，不保存正文、音频/PCM、本地路径、stack 或 dump。两张 `0x80000003` 截图均早于 `64b3e55`，但没有 native stack，根因未获调用栈级证明；产品壳使用 fake ASR/无物理音频，诊断证据不冒充物理来源、I3/I4，硬崩溃恢复、物理 mic、I3、I4 与 Agent 仍待补。 |
| **SEM-F13** | 独立增强文本 | LLM 修饰结果必须作为 `enhanced_transcript` 独立保存，声明 `sessionId`、输入水位、input digest、provider/model；权威转写始终可单独查看和导出。A2 首版只做会后或用户主动触发的整场增强。 | 增强文本不是 refined，不得覆盖、删除或伪装成 ASR 正文；失败不得改变字幕；按 committed segment 滚动增强不进入首版。 | J3/J5/J7 + artifact schema/版本测试。 | 保存和首版触发语义已决定，尚未实现。 |
| **SEM-F14** | 永不保存原始音频 | 原始 PCM、录音片段或可回放音频文件只允许在有界内存缓冲中服务实时 ASR/精修，使用后释放；产品、诊断和 smoke 现在及未来都不持久化现场采集音频。模型归档即使附带上游示例音频，产品安装也只能提取 manifest 白名单运行文件。 | 不允许在 SQLite BLOB、应用数据目录、日志、导出、崩溃恢复文件、测试产物、模型目录或 Agent 上下文中保存现场音频；不预留“以后打开录音”的隐藏路径。仓库可保留来源明确的静态合成测试语料。 | J12 + 存储/schema/诊断接口审查 + J14 安装目录检查 + I4 打包版数据目录检查。 | diagnostic、schema/RPC、Gateway、默认产品生命周期、历史复盘/三格式导出、模型 fixture 联合旅程与批准大模型真实安装均验证无音频产物、字段或路径且无 JSONL 双写；真实安装曾发现并修复上游示例 WAV 被整包解出的缺口。I4 打包版应用目录仍待补，DB6 总门禁未完成。 |
| **SEM-F15** | 内容型 Agent 边界 | Agent 首版只允许读取已提交文本、调用受控 ModelGateway、生成内容并写入内部 `agent_artifacts`。 | 禁止 shell、进程启动、任意文件写、任意网络请求和外部服务写操作；会议待办不能自动执行。 | J7/J13 + 插件能力清单审计。 | 语义已决定，Agent 尚未实现。 |
| **SEM-F16** | 可插拔 Agent 能力 | Pi 低层 Agent 核心外必须有项目自有插件宿主；字幕通过只读字幕上下文插件接入，增强文本和会后纪要分别作为内容产物插件。字幕系统本身仍独立运行。 | 不直接嵌入完整 coding-agent 扩展运行时；不让 Pi 插件拥有音频采集、ASR、字幕会话或字幕数据库写权。 | A1 探针 + J3/J7/J13；插件卸载/失败时字幕 J1 仍成立。 | 宿主边界已由 ADR 0003 接受；Pi/PluginHost 尚未实现或安装。 |
| **SEM-F17** | 本地模型资源闭环 | 字幕模型只能由主进程依据内置、版本化且审计过的 manifest 下载：固定 HTTPS 来源、字节数、SHA-256、归档根、期望文件和上游出处；支持 `.part` 续传，经 staging 校验后同卷原子安装并写 ready marker。完整字幕 bundle 就绪后，当前空闲应用无需手工改路径即可发布真实 ASR capability。 | renderer 不能提供 URL、哈希、模型/数据库路径、解压参数或任意文件写；“文件存在”“下载到 100%”“开发仓库有模型”都不等于安装完成；模型下载不是 Agent/翻译能力。 | J14 + I4；真实批准模型调用证据沿用/扩展 I2。 | B4 实现完成并通过确定性联合旅程：资源页点击边界、Range 续传、三资源校验/白名单解包/marker、resolver、空闲热启用、字幕→SQLite 历史均已覆盖；批准 270,938,600 字节 bundle 已在隔离 userData 真实安装并被在线 ASR、离线精修和 VAD 调用。干净机公网 I4 尚未验收，故不是发布验收完成。 |
| **SEM-T01** | 单元测试边界 | 单元测试只证明局部不变量，不能单独证明用户能力完成。 | “测试数很多”“覆盖率高”都不能替代用户旅程。 | 至少一条登记的确定性联合旅程。 | 规则已生效。 |
| **SEM-T02** | 联合测试边界 | 联合测试必须让多个真实产品模块围绕同一用户结果协作；只在声卡、网络、系统权限、云 provider 等不可确定外部边界使用契约替身。 | 全链路 mock、直接调用最终 exporter、只断言某函数被调用都不算联合旅程。 | CI 测试列出真实模块、替身边界和用户可观察结果。 | J1/J2 已按此执行。 |
| **SEM-T03** | 托管 CI 边界 | Windows hosted CI 证明确定性接线、回归和故障注入，不声称证明真实 WASAPI、物理麦克风、DWM、模型性能或两小时稳定性。 | CI 绿色不等于实机验收完成。 | 对应 I2/I3/I4 结构化实机报告。 | 规则已生效；I2 runner 输出来源、字幕到达时序、Electron CPU/工作集、PCM 队列/缺口和 worker 指标；loopback 报告已留档，mic/I3/I4 仍待验收。 |
| **SEM-T04** | 失败路径 | 每项用户能力至少覆盖一个关键失败或降级路径；核心能力必须 fail closed 或显式降级。 | 只覆盖 happy path 不得标记验收完成。 | 场景矩阵中的故障旅程或实机故障注入。 | SQLite 事实、Gateway 队列、DB2 第二文件中断、产品启动迁移失败清理和退出超时强制终止已有回归；历史层覆盖活动会话拒绝、越权载荷拒绝和取消导出不写文件；模型层覆盖坏 hash/size、越权 host/path、归档 traversal/link、活动会话拒绝替换，以及 fetch/tar 无视 abort 时的有界退出、合法 `.part` 保留与下次启动清 staging。Agent 失败路径待实现，向量已后置。 |
| **SEM-T05** | 完成状态词 | 只允许“已决定”“实现完成/尚未验收”“联合验收完成”“实机验收完成”“发布验收完成”。无修饰的“完成”必须能指向所需最高门禁。 | 不允许用“已接通”“可用”“测试通过”替代明确状态。 | PLAN/README 状态与测试报告链接一致。 | 从本次文档起执行。 |
| **SEM-T06** | 场景登记 | 新功能或语义变化必须先在本表和 `testing-strategy.md` 增加/更新旅程，再实现；修复不能只新增孤立单测。 | 未登记的隐藏验收口径、开发完成后再补需求均不接受。 | PR 同时引用 SEM ID 与 J/I/DB gate。 | 规则已生效。 |
| **SEM-T07** | Agent 纪要完成门禁 | 字幕→会后纪要必须分别从 `loopback` 与 `mic` 单路会话验证，并覆盖 refine、暂停恢复/崩溃、AI 失败和来源互斥；不测试或支持双路并发。 | 只用一段固定文本调用 LLM 的测试不能称纪要功能完成；纪要未完成不影响字幕 MVP 验收。 | J3–J7/J13 + 适用实机证据。 | 未实现；Agent 阶段阻断。 |
| **SEM-T08** | 数据迁移门禁 | JSONL→SQLite 必须可中断、可重跑、可核对；文件 SHA 与解析必须使用同一不可变字节快照；由 `final/refined` 折叠的**原文当前投影**及其 txt/md/srt 原文导出 digest 一致后才能切换权威后端。SQLite 不能无损表达的旧时间值必须 fail closed，不得先取整再用取整值建立期望 digest。遗留 `translated` 记录保持原 JSONL 只读且计入迁移报告，但不进入字幕事实或原文 digest；未来 Agent 迁移另设门禁。 | “能打开数据库”“导入条数相同”或包含旧译文的旧版双语导出逐字节一致，都不足以证明新的字幕事实迁移正确；禁止长期双写兜底。 | DB2 + J10。 | DB2 内核及默认产品组合的确定性联合 CI 已覆盖同字节快照、原子/幂等/中断、四类原文 digest、translated 隔离，以及冷启动迁移→SQLite-only 新会话→退出→二次启动重跑不重复；受控真实 Electron fresh SQLite 生命周期已通过，但 Electron 内旧档 import/二次启动和打包态仍待，故完整 J10 发布门禁尚未宣称通过。 |
| **SEM-T09** | 向量门禁（后置） | 只有未来启用 `sqlite-vec` 时，才必须通过开发版/打包版加载、旧向量失效、索引重建、扩展缺失降级和不同模型维度隔离。 | 本门禁不得阻断 SQLite 历史、字幕 MVP 或首版 Agent 摘要。 | DB4 + J11 + 对应打包版验收。 | Deferred；近期不执行。 |
| **SEM-T10** | 插件联合门禁 | 每个 Agent 插件必须在真实插件宿主、字幕提交边界、SQLite 产物存储和 UI 读取链路中测试；同时覆盖插件超时/异常/重复触发/卸载及越权请求。 | 直接调用插件函数、mock 掉宿主和数据库或只验证 prompt 文本，不等于插件能力完成。 | J3/J7/J13；A1/A2 PR 阻断。 | 规则已冻结，宿主尚未实现。 |
| **SEM-T11** | 模型供应链门禁 | 确定性 CI 必须用受控 HTTP 边界让真实 ModelManager 经中断续传、字节/SHA 校验、归档路径/类型审查、白名单提取、staging、原子安装、resolver 与 runtime capability 协作；另以已批准真实大模型证明安装产物可被 sherpa 调用。 | 全 mock 下载、直接复制已解压目录、只测 resolver、只看到进度 100% 或只跑仓库内模型都不能称模型安装闭环。 | J14；真实模型调用 I2/I4。 | J14 确定性多模块 CI 已通过；批准大模型本机安装/在线 ASR/离线精修/VAD 调用报告已留档，官方 Release API 的三项 uploaded/size 与 manifest 一致。真实公网完整下载与干净机打包态仍归 I4，尚未宣称发布验收完成。 |

## 3. 变更维护规则

1. 需求、实现或测试 PR 必须引用至少一个 `SEM-*`；没有适用项时先新增语义行。
2. 改“冻结语义”时必须更新对应 J/DB/I gate；只改“当前状态”不改变要求。
3. 旅程通过后在测试策略和 PLAN 更新证据，但不得删除失败路径或缩小边界来制造通过。
4. “当前状态”至少在阶段验收、存储后端切换、摘要上线和发布前复核一次。
5. 模糊词按 [`CONTEXT.md`](../CONTEXT.md) 替换；特别禁止用“本地声音”“最终字幕”“单测通过所以完成”。
