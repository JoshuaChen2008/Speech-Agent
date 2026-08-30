## 1. 权威登记与实施基线

- [ ] 1.1 完整重读 `AGENTS.md` 与 `CONTEXT.md`，逐字核对 SEM-F16/F28/F30-F35/T10/T15、2026-08-30 修订说明、ADR 0013-0018、J22/J24 S3 Core 子边界和本 change；记录术语缺口但不沿用冲突现状。
- [ ] 1.2 记录实施前 branch/HEAD、`git status --short`、用户已有未提交/未跟踪文件、S1/S2 状态、当前 core/integration/evidence 返回码；后续只显式暂存 S3 路径。
- [ ] 1.3 冻结并测试 v1-v6 migration SQL/checksum 基线，确认 S3 只能追加 v7，不能以格式化或重排改动旧字节。
- [ ] 1.4 核对 `docs/testing-strategy.md` 已包含 “J22/J24 的 S3 Core 子边界（不是新旅程）”，且 S5 汇合说明不再使用 S3 单轮/S4 Agent Loop 旧二分。
- [ ] 1.5 把 `analysis-report`、`planning-proposal`、可空 `usage_json`、十一 recipe、统一执行路径与两层意图收敛的所有实施引用对齐到 `agent-execution` spec；不得在代码或测试暗定新语义。
- [ ] 1.6 在写 v7 migration 前核对四条具名 `CREATE INDEX` 与 `docs/data-architecture.md` §5、执行计划、本 spec 和 schema test 完全一致；不得夹带未登记索引。
- [ ] 1.7 运行实施前 `npm run test:core` 并保存返回码/计数；失败时区分产品断言与依赖/沙箱前置，不把环境失败写成产品结论。
- [ ] 1.8 列出旧 `src/agent-provider/**`、`src/agent-runtime/**`、`src/agent-core/**`、`src/agent-mvp/**` 可迁移的可靠性不变量，明确它们不成为新 S3 import、注册表、配置或凭据入口。
- [ ] 1.9 为每个后续 seam 建立 red → green → 定向回归顺序；当前 seam 未恢复相关 lane 前不得铺开下一批长期红测。
- [ ] 1.10 确认新增测试只位于既有 contracts/main/runtime/storage/ui/integration/validation lane，不新建 test 顶级目录。

## 2. 十一 recipe 与共享输出合同 tracer bullets

- [x] 2.1 先写会红的 recipe 闭集测试，断言恰好十一项、首版 version `'1'`、ID 唯一且每项 exact 包含 input/model/turn/tool/schema/persistence/artifact/failure 字段。
- [x] 2.2 新建 `src/agent/contracts/recipes.js` 并导出冻结 lookup/validator，使 2.1 转绿；不得从旧 PluginHost manifest 构造登记。
- [x] 2.3 定向回归 unknown recipe/version、额外登记字段、重复 ID、运行期 mutation 与跨模块复制表，确认全部 fail closed。
- [x] 2.4 先写会红的三档测试：`intent.route/text.rewrite/text.translate` 为 1/0，六项 bounded recipe 为 3/`search_context`，两项分析规划为 6/双工具。
- [x] 2.5 实现静态 `maxTurns/toolGrants` 登记并使 2.4 转绿；冻结对象必须是 `recipeId+recipeVersion`，不能由输入范围或模型覆盖。
- [x] 2.6 定向回归工具授权数组顺序、冻结性、0 工具空记录与 1 轮不进第二轮。
- [x] 2.7 先写会红的共享 `SourceRefV1/MemoryRefV1/InteractionSignalRefV1` exact validator，覆盖 extra/missing/unknown enum/event order/digest/Unicode 边界。
- [x] 2.8 实现共享引用 validator 与 code point/UTF-8 边界工具，使 2.7 转绿；不得切断 surrogate pair 或把正文放入引用。
- [ ] 2.9 定向回归 source range 无序/重叠、非 canonical transcript version、重复 stable ID 与绝对路径/音频字段泄漏。
- [x] 2.10 先写会红的 `intent.route` Schema：结果恰好 `{recipeId,confidence}`、目标只在其它十项、confidence 为 0..1 finite。
- [x] 2.11 实现 `intent.route@1` output validator，使 2.10 转绿；拒绝解释、候选数组、自指与闭集外 recipe。
- [x] 2.12 先写会红的两个 `context.ingest.*` Schema，覆盖 experiences/candidates 数量、枚举、引用、可空 scope proposal，并反证 `semanticKey` 不可出现。
- [x] 2.13 实现两个 ingest output validator，使 2.12 转绿；模型输出 kind 必须与当前 personal-context 闭集一致。
- [x] 2.14 先写会红的 `qa.answer/extract.items/summary.minutes` exact Schema 与 code point/array 上限矩阵。
- [x] 2.15 实现三项 validator，使 2.14 转绿；minutes 缺栏目使用空数组，extract 不创建 artifact。
- [x] 2.16 先写会红的 `report.analysis/plan.proposal` Schema，覆盖 source/memory refs、gaps/openQuestions、连续 step 与 dependsOn 只向后引用既有较小 step。
- [x] 2.17 实现分析/规划 validator，使 2.16 转绿；禁止外部执行动作与工具正文复制。
- [x] 2.18 先写会红的 `text.enhance/rewrite/translate` Schema，覆盖段集合完整性、1 轮、BCP-47、basedOnRevision 与零来源改写。
- [x] 2.19 实现三项 validator，使 2.18 转绿；增强文本独立保存，rewrite/translate 只存 interaction result。
- [x] 2.20 定向回归全部十一 outputSchemaId 都可解析到唯一 validator，任何登记/validator 缺项使启动合同 fail closed。

## 3. migration v7 与 schema 不变量 tracer bullets

- [ ] 3.1 先写会红的 v6→v7 升级测试：既有字幕/S1/S2 事实逐字段不变、`user_version=7`、v1-v6 SQL/checksum 冻结、v7 只含已登记四组内容。
- [ ] 3.2 只追加 `FORMAL_AGENT_MIGRATIONS` v7 常量并使 3.1 转绿；不得编辑 v1-v6 字符串或 checksum。
- [ ] 3.3 定向回归新库、v6 升级、重复打开、migration 中断、checksum 漂移与 v7 事务回滚。
- [ ] 3.4 先写会红的 `formal_agent_interactions` 列/STRICT/主键/run UNIQUE/FK 测试，并反证无 `model_binding_id/execution_form/escalation_reason/provider/model/amount` 列。
- [ ] 3.5 实现 interaction 表最小 schema，使 3.4 转绿；模型事实只经相同 `run_id` 关联 v6 binding。
- [ ] 3.6 先写会红的 interaction CHECK 矩阵：max_turns 1/3/6、routing mode 三值、terminal reason 三值、失败/error、成功/result、用户/prompt digest、usage 可空。
- [ ] 3.7 补齐 interaction CHECK 并使 3.6 转绿；取消必须允许 null result 且不得要求伪对象。
- [ ] 3.8 定向回归非法直接 SQL、同 run 第二 interaction、不同 recipe 快照重放、usage unknown 与 terminal mismatch。
- [ ] 3.9 先写会红的 `formal_agent_tool_calls` 列/FK/UNIQUE/attempt/call_order/tool/status/error 闭集测试。
- [ ] 3.10 实现 tool calls STRICT 表并使 3.9 转绿；七值工具错误码不得复用十值任务错误码。
- [ ] 3.11 先写会红的 schema 字节测试，精确覆盖 args 8192/8193 与 result 65536/65537 UTF-8 字节。
- [ ] 3.12 增加 `length(CAST(... AS BLOB))` CHECK 并使 3.11 转绿；不得在 JavaScript 层静默截断绕过 schema。
- [ ] 3.13 定向回归多 attempt 全序、旧 attempt 保留、相对时间单调、工具外 assistant 文本无列可写。
- [ ] 3.14 先写会红的 `formal_agent_report_presentations` session PK、run UNIQUE/FK、可空 presented_at 与关闭偏好保留测试。
- [ ] 3.15 实现 presentation STRICT 表并使 3.14 转绿；自动请求 reply-loss 只能恢复同一行。
- [ ] 3.16 先写会红的 tombstone migration 测试，只新增 `deleted_report_presentation_count`，v5 interaction/tool/episode/evidence/orphan 列不得重复。
- [ ] 3.17 实现 tombstone ALTER 并使 3.16 转绿；默认/非负约束必须成立。
- [ ] 3.18 先写会红的四条已登记具名索引与 keyset query plan 测试。
- [ ] 3.19 实现四条具名索引并使 3.18 转绿；不触及四张废案 `recognition_*` 表。
- [ ] 3.20 定向回归 v7 schema 隐私负扫描，确认无凭据、提示正文、音频、路径、reasoning、绝对单调时刻或金额字段。

## 4. interaction/tool/presentation store 与协议 tracer bullets

- [ ] 4.1 先写会红的 interaction create/terminalize command exact 测试，调用方不能提交 binding identity、comparison digest、result digest 或非权威 usage。
- [ ] 4.2 实现 storage worker 内 interaction store/command，使 4.1 转绿；在事务内从 run/recipe/binding 复算权威快照。
- [ ] 4.3 定向回归成功/失败/取消、回复丢失重放、不同 payload 同 key、终态后改写与 observer 抛错。
- [ ] 4.4 先写会红的 tool call start/finish command 测试，验证授权、attempt/call_order、args/result digest、字节预算与状态错误绑定。
- [ ] 4.5 实现 tool audit writer 使 4.4 转绿；越权调用先记录受控失败且不得执行 adapter。
- [ ] 4.6 定向回归 start 后 worker 退出、finish 回复丢失、迟到 finish、同 order 不同 payload 与旧 attempt 可读。
- [ ] 4.7 先写会红的 presentation request/present command，覆盖 session PK、run UNIQUE、renderer reload 与重复通知。
- [ ] 4.8 实现 presentation writer/query 使 4.7 转绿；presented_at 只在真实非模态呈现回执后填充。
- [ ] 4.9 定向回归偏好关闭、重复停止、启动扫描、人工双击、reply loss 与关闭偏好不删除历史。
- [ ] 4.10 先写会红的 interaction keyset history query，按 `(terminal_at DESC,interaction_id)` 严格续读并排除 `intent.route`。
- [ ] 4.11 实现 opaque cursor 编解码与 limit clamp，使 4.10 转绿；拒绝 `offset_N`、额外键和伪造时间。
- [ ] 4.12 定向回归并发新插入、相同 terminal_at、分页边界、hasMore/nextCursor 等价与 route/target 删除关系。
- [ ] 4.13 先写会红的 get-interaction snapshot，按同一 SQLite 快照读取 binding、result 与 `(attempt,call_order)` 全序工具记录。
- [ ] 4.14 实现详情投影使 4.13 转绿；routing mode/confidence/prompt/内部 ID 不进入 renderer-facing 结果。
- [ ] 4.15 扩展 storage worker protocol/service/gateway exact 命令与稳定错误映射，禁止 renderer/recipe 直接取得 store 或 SQLite 句柄。
- [ ] 4.16 定向回归 storage child replacement、当前 generation 策略重放、Agent 业务拒绝不熔断字幕 FIFO。

## 5. bind 收窄、预算推导与统一 Loop tracer bullets

- [x] 5.1 先写会红的 model-access contract 测试，把 `EXECUTION_FORMS` 收窄为 `['agent_loop']` 并拒绝 `single_shot`。
- [x] 5.2 最小修改 `src/agent/contracts/model-access-core.js` 与 bind validator，使 5.1 转绿；v6 列仍保存常量 `'agent_loop'`。
- [x] 5.3 定向回归旧 S2 bind 测试/fixtures，把真实 `context.ingest.session` 请求改为统一路径且不修改 v6 migration 字节。
- [x] 5.4 先写会红的 `deriveBudget(capabilities,maxTurns,toolGrants,requestedBy)` exact 测试，第 1 轴来自 recipe 登记而非 execution form。
- [x] 5.5 修改 `budget-axes.js` 唯一定义点并使 5.4 转绿；其余九轴数值与来源保持既有合同。
- [ ] 5.6 定向回归 1/3/6 轮、interactive/automatic wall clock、max input/output 能力裁剪和 invalid grants。
- [x] 5.7 先写会红的 capability 守卫：0 工具 recipe 可绑定 `supportsToolCalling=false`，非空 grants 必须为 true。
- [x] 5.8 实现 bind/readiness 按 grants 校验并使 5.7 转绿；能力不足为配置问题而非 `AGENT_PROVIDER_UNAVAILABLE`。
- [ ] 5.9 先写会红的执行宿主单入口测试，十一 recipe 都调用同一 Pi `agentLoop()` adapter，生产无第二 executor。
- [ ] 5.10 实现 `src/agent/execution-host/` 统一 runner facade 与 Pi loop adapter，使 5.9 转绿。
- [ ] 5.11 先写会红的 `shouldStopAfterTurn` 矩阵，覆盖 1 轮绝不进第二轮、3/6 轮上限、自然早停与预算早停。
- [ ] 5.12 实现 deterministic stop config 并使 5.11 转绿；不得实现 `prepareNextTurn` 或模型驱动续轮。
- [ ] 5.13 定向回归生产 module graph 不可达旧 PluginHost、single-shot executor、`agentLoopContinue()`、递归委派或动态工具注册。
- [ ] 5.14 定向回归 Pi MIT 许可保留、utility 只取得调用级 binding/credential 副本且不取得 SQLite/配置文件路径。

## 6. 两层意图收敛 tracer bullets

- [ ] 6.1 先写会红的 `intent.route` 正常路径：真实 run/bind/loop/interaction 后创建目标 run，目标写 `routing_mode='model'`。
- [ ] 6.2 实现 route orchestrator 最小正常路径使 6.1 转绿；不得在 bind 前裸调用模型。
- [ ] 6.3 定向回归 route 默认用途与目标用途不同、两 run 独立 usage/binding、route 不进用户历史列表。
- [ ] 6.4 先写会红的五类兜底表：资格非 ready、`AGENT_PROVIDER_*`、output/budget、worker/internal、闭集外 recipe。
- [ ] 6.5 实现固定 fallback classifier 使 6.4 转绿；不得按异常字符串、等待时长或 confidence 主观判断。
- [ ] 6.6 先写会红的 deterministic rules 优先级表，输入只含冻结 scope kind 与受控关键词，全部不匹配为 `qa.answer`。
- [ ] 6.7 实现规则模块并使 6.6 转绿；输出只能是其它十项登记 ID。
- [ ] 6.8 定向回归规则路径目标 interaction 写 `rules`、收敛无失败态、provider 不可用时也有下一步。
- [ ] 6.9 先写会红的 route 用户取消场景，取消不触发规则且不创建目标 run。
- [ ] 6.10 实现取消短路使 6.9 转绿；低 confidence 合法结果继续采用 model。
- [ ] 6.11 先写会红的 preset 场景：两个 ingest 与自动 minutes 零 route run、目标写 `preset`。
- [ ] 6.12 实现 preset create path 并使 6.11 转绿；自动路径运行数不得增加。
- [ ] 6.13 先写会红的用户改选场景，原 run 请求取消并创建新 recipe/run/binding/version。
- [ ] 6.14 实现 reselect orchestration 使 6.13 转绿；禁止原地改 recipe 或产物类型。

## 7. 取消、迟到拒绝与恢复 tracer bullets

- [ ] 7.1 先写会红的运行状态机测试，成功/失败/取消是终态，取消 error null/result 可 null 且不可恢复。
- [ ] 7.2 实现 runtime/interaction terminal state transition 使 7.1 转绿；不得补造取消结果。
- [ ] 7.3 先写会红的模型请求取消 barrier，确认同一 signal 贯穿 credential borrow、provider request 与 Loop。
- [ ] 7.4 实现协程式 cancellation propagation 使 7.3 转绿；确认后不发下一 turn/request。
- [ ] 7.5 先写会红的工具取消 barrier，当前调用在检查点 `TOOL_CANCELLED`，不开始新工具。
- [ ] 7.6 实现 tool cancellation port 使 7.5 转绿；已发生记录保留。
- [ ] 7.7 先写会红的迟到结果矩阵：取消后 provider success/error/usage/tool finish、旧 utility/storage generation 都被拒绝。
- [ ] 7.8 在 writer 事务内复核 run/interaction/attempt/generation/tombstone，使 7.7 转绿。
- [ ] 7.9 定向回归迟到消息不改 result/digest/usage/duration/binding/presentation/personal-context，observer 只收受限诊断。
- [ ] 7.10 先写会红的整体重跑测试：可重试错误递增 attempt、同 run/binding/input/snapshot、旧 tool records 保留。
- [ ] 7.11 实现 retry/resume orchestration 使 7.10 转绿；不得保存 turn cursor、中间 assistant 文本或 continuation token。
- [ ] 7.12 定向回归配置变化不影响旧 run、主动换模型才新 run、已取消 run 重启扫描不领取。
- [ ] 7.13 复用 S1 logical claim key/receipt/lease/wakeEpoch/generation，写行为测试证明没有第二套任务或租约协议。
- [ ] 7.14 定向回归 claim/result reply loss、storage replacement 先重放策略、scheduler stop 终态与字幕停止不等待。

## 8. 两段式 personal-context 摄取 tracer bullets

- [ ] 8.1 先写会红的 `context.ingest.session` 两阶段测试：零模型前段建立 episode 骨架，后段才 bind/Loop，二者共享 run/attempt。
- [ ] 8.2 扩展 S1 session runner 使 8.1 转绿；不新建 run 表、租约协议或第二 episode。
- [ ] 8.3 定向回归 raw、整场 N=M refined、N!=M 回落 raw、partial/未定稿尾部排除与 input digest 复算。
- [ ] 8.4 先写会红的模型失败/重试/提交失败矩阵，骨架可重放、候选零部分写入。
- [ ] 8.5 实现 session candidate commit 使 8.4 转绿；相同 source identity/digest 重放计数不增长。
- [ ] 8.6 先写会红的 `context.ingest.interaction` 两阶段测试，只接受 terminal formal interaction 与六值信号。
- [ ] 8.7 实现 interaction episode skeleton/runner 使 8.6 转绿。
- [ ] 8.8 定向回归点击/停留/滚动/浏览/焦点/复制/调试聊天/内部工具/未采纳输出零信号零运行。
- [ ] 8.9 先写会红的 storage semantic key 派生测试，覆盖 NFKC/casefold/空白折叠/trim/<=256 UTF-8/code point 边界。
- [ ] 8.10 在 personal-context store 写入侧派生 key 并使 8.9 转绿；模型/recipe/renderer/preload 字段一律拒绝。
- [ ] 8.11 定向回归修改正文重算键、冲突 revision、被忘记条目自动不恢复、suppression 旧来源不重建。
- [ ] 8.12 先写会红的 preference/fact 分区与 `loopback` 范围策略，偏好只约束 Agent 产物且不当事实引用。
- [ ] 8.13 实现 candidate 过滤/分区并使 8.12 转绿；term/preference 零 recognition 表读写。
- [ ] 8.14 定向回归 ingest 故障不改变首次稳定转写、精修稿、字幕历史、会话停止或下一会话。

## 9. 用量、comparison group 与产物 registry tracer bullets

- [x] 9.1 先写会红的 `MODEL_USAGE_SOURCES` 合同，恰好 `['provider']` 并拒绝 estimated/amount/price/cost/currency/pricing。
- [x] 9.2 收窄 `model-access-core.js` usage validator 使 9.1 转绿；保持 normalize 缺失/usageReporting=false 返回 null。
- [ ] 9.3 定向回归 provider token、cache consistent/incomplete/inconsistent、input=0、负数/类型错误与 unknown UI 文案。
- [ ] 9.4 先写会红的 interaction usage store：合法 provider object 或 SQL NULL，unknown 时两条累计计费用量轴不评估。
- [ ] 9.5 实现 usage normalization/persistence 使 9.4 转绿；其它八轴继续执法且结果可成功。
- [x] 9.6 先写会红的 comparison digest vectors，RFC 8785 canonical `[recipeId,version,scopeDigest,inputDigest]` → lowercase SHA-256。
- [x] 9.7 实现权威 comparison digest 计算使 9.6 转绿；拒绝 renderer/provider 传入值。
- [ ] 9.8 定向回归同源换模型同组、不同 recipe/version/scope/input 分组、model/run/usage 不进 digest。
- [ ] 9.9 先写会红的 artifact registry，新增 `analysis-report/planning-proposal` 并冻结四项 recipe→artifact 映射。
- [ ] 9.10 实现 registry/writer 守卫使 9.9 转绿；extract 不新增类型且 `reference-output` 正式不可达。
- [ ] 9.11 定向回归 artifact 错配、Schema invalid、长输入归并失败与取消均零部分产物。
- [ ] 9.12 扫描 schema/contracts/fixtures/UI，确认无金额字段、估算 token 或 price catalog 回流。

## 10. 报告呈现、交互删除与会话 tombstone tracer bullets

- [ ] 10.1 先写会红的自动 minutes create journey：偏好关闭零 run/receipt，开启后只影响未来合格终态会话。
- [ ] 10.2 实现 presentation request 与 preset minutes composition 使 10.1 转绿。
- [ ] 10.3 定向回归重复停止/扫描/reload/notify/人工双击，session PK 保证至多一次请求与呈现。
- [ ] 10.4 先写会红的用户 interaction 删除事务，配套 route interaction/run/tool calls 同事务清理，已独立摄取个人记忆保留。
- [ ] 10.5 实现 interaction lifecycle delete 使 10.4 转绿；route 关联必须用权威关系而非 prompt 文本推断。
- [ ] 10.6 先写会红的会话删除全组合：formal runs/interactions/tools/presentation/episodes/evidence/orphans 与精确 tombstone 计数。
- [ ] 10.7 扩展会话删除 transaction 使 10.6 转绿；v7 只新增 presentation 计数列。
- [ ] 10.8 定向回归 deletion reply loss、同 key 同 digest、同 key 异 digest、删除后迟到 commit/scan 与其它会话不受影响。
- [ ] 10.9 先写会红的 tombstone/privacy 扫描，计数与标识外零正文/设备/路径/绝对单调时刻。
- [ ] 10.10 修复所有泄漏面并使 10.9 转绿；正文一致性只用 digest/boolean/count 证明。
- [ ] 10.11 定向回归 presentation run cascade、关闭偏好不删旧 receipt、取消 run 仍保持终态可追溯。
- [ ] 10.12 确认会话删除不读写四张废案 `recognition_*` 表且不改变 v3 checksum。

## 11. exact IPC、资格、preload 与 UI/UX fixture tracer bullets

- [ ] 11.1 先写会红的 Agent run UI contract/version 测试，冻结六频道、request/result/event、终态/资格/routing/usage/cache 枚举与 unknown fail closed。
- [ ] 11.2 在 `src/agent/contracts/` 签发版本化 exact contract 使 11.1 转绿；已签发版本目录只读。
- [ ] 11.3 定向回归 extra/missing/unknown version/错误 cursor/非法 limit/内部字段/路径/凭据/金额泄漏。
- [ ] 11.4 先写会红的 access policy 测试，`agent/history` 允许六频道，caption/toolbar/settings/unknown 在 controller 前拒绝。
- [ ] 11.5 扩展 channels/access policy/main controller 与 agent/history preload facade，使 11.4 转绿；renderer 不取得 channel 名、store 或 provider。
- [ ] 11.6 定向回归 webContents replacement、reload、旧 sender、changed unsubscribe 与 observer 抛错。
- [ ] 11.7 先写会红的九值资格表与固定顺序：terminal→transcript→automatic window→disabled→provider→cloud disclosure/credential→local readiness→ready。
- [ ] 11.8 实现 main-owned eligibility composer 使 11.7 转绿；用户请求只跳过 automatic window。
- [ ] 11.9 定向回归多条件同时失败、cloud/local 分支、fixture/IPC/provider 不可伪造 ready、route non-ready 进入 rules 但目标仍受资格。
- [ ] 11.10 先写会红的 changed/reload 协议：先订阅后读、只接受更大 revision、旧 snapshot 不覆盖新状态。
- [ ] 11.11 实现 interaction/presentation/cancel changed 广播与权威重读，使 11.10 转绿。
- [ ] 11.12 先写会红的 fixture 清单，覆盖四范围、九资格、model/rules/preset、五终态表面、1/3/6、工具折叠、usage/cache unknown、reload/unknown。
- [ ] 11.13 生成同源 validator、`previewOnly=true` 的脱敏 fixture 使 11.12 转绿；不得写 `.artifacts/` 或 `docs/validation/`。
- [ ] 11.14 定向回归 fixture 不含 prompt/assistant/reasoning/provider event/credential/audio/path/device/time offset/amount，且不计 J22/J24 证据。

## 12. J22/J24 S3 Core 确定性联合子边界

- [ ] 12.1 先写会红的一条表驱动 S3 Core 联合旅程，组合真实 v7/SQLite、personal-context、model-access、execution host、job runner、main exact IPC，只替代外部 provider。
- [ ] 12.2 用最小产品组合使正常路径转绿：范围冻结 → route model → 目标 recipe → bind → Loop → interaction/tool/presentation 读取。
- [ ] 12.3 在同一旅程加入 rules 五类兜底、preset 两类摄取/自动 minutes、规则全不匹配 qa、用户改选新 run。
- [ ] 12.4 在同一旅程逐项运行十一 recipe 的登记/Schema/persistence/artifact 表，证明 1 轮不进第二轮、0 工具记录为空。
- [ ] 12.5 先写会红的取消/迟到/重试/replacement/reply-loss 联合矩阵，内部模块保持真实。
- [ ] 12.6 最小实现使 12.5 转绿，逐项证明终态不可改写、同 run 绑定/输入不变、旧 attempt 工具记录保留。
- [ ] 12.7 先写会红的两段式摄取联合矩阵：session/interaction 骨架、模型失败重放、semantic key 派生、suppression/forget/term 不影响 ASR。
- [ ] 12.8 最小实现使 12.7 转绿；字幕提交与历史在每个故障注入点继续成立。
- [ ] 12.9 先写会红的 v7 删除/分页/presentation 联合矩阵，覆盖并发写入、reload、重复通知与 tombstone 迟到拒绝。
- [ ] 12.10 最小实现使 12.9 转绿，确认 keyset 不跳行/重复、presentation 至多一次、计数幂等。
- [ ] 12.11 先写会红的 provider usage/null/cache/comparison/artifact 联合矩阵，全产品零 estimated/金额。
- [ ] 12.12 最小实现使 12.11 转绿；usage unknown 不阻止结果成功且只比较有 provider 用量的 interaction。
- [ ] 12.13 先写会红的联合隐私负扫描：SQLite/IPC/fixture/stdio/log/report/evidence 零 prompt/assistant/reasoning/credential/audio/path/device/absolute monotonic/amount。
- [ ] 12.14 修复全部泄漏面并使 12.13 转绿；不得把正文 canary 写入证据 JSON 来证明零泄漏。
- [ ] 12.15 定向回归 Agent 故障不阻塞字幕 stop/exit/next session/history，renderer/recipe/utility 零 SQLite/credential/filesystem/network 直连。
- [ ] 12.16 明确记录 S4 延后 `read_sources` 真实执行与完整工具预算、S5-Integration 延后 Agent Bar renderer/导出；不得用 S3 fixture 冒充。

## 13. 三条 lane、审阅、状态与提交

- [ ] 13.1 运行全部受影响的定向 contracts/main/runtime/storage/ui/integration/validation 测试；交接前不得留下长期红测。
- [ ] 13.2 运行 `npm run test:core`，记录实际返回码、计数与失败分类；不得只写“测试通过”。
- [ ] 13.3 运行 `npm run test:integration`，确认新增 S3 联合测试本身返回 0；既有 Windows Electron GPU `exit_code=-1073741515` 与产品断言分开报告。
- [ ] 13.4 运行 `npm run test:evidence`，确认 preview fixture 不进入证据目录、测试 lane 合法、生产旧 Agent/测试 provider 边界与隐私负扫描成立。
- [ ] 13.5 运行完整 `npm test`；若 integration 环境失败使后续 lane 未执行，必须另行独立运行 evidence 并如实记录命令边界。
- [ ] 13.6 使用 code review 复核 v1-v6 checksum、v7 四组、索引裁定、十一 recipe、统一 Loop、bind 常量、五类 fallback、取消/迟到、两段式摄取、usage null、comparison digest、删除/分页/IPC/隐私。
- [ ] 13.7 复核所有需求/测试名/错误字段/报告文案与 `CONTEXT.md` 规范术语逐字对齐，不使用被禁说法或无修饰状态词。
- [ ] 13.8 按实际证据更新执行计划与 testing strategy 的 S3 实施记录；S5-Integration 前最多写「实现完成·尚未验收」，不得晋级完整 J22/J24。
- [ ] 13.9 向 UI/UX 工作线签发 Agent run contract、状态矩阵、fixture 清单、未知值 fail closed 与 renderer 开始门槛；明确 preview 不构成旅程证据。
- [ ] 13.10 逐路径显式暂存 S3 实现/测试/文档，禁止 `git add .`；提交信息至少引用 SEM-F16 与 J22/J24。
- [ ] 13.11 提交后再次核对用户原有未归属文件、旧 Agent 四树、字幕产品路径与 S1/S2 事实未被覆盖或误纳入提交。
- [ ] 13.12 输出实施回执，列出实际修改、定向测试、三条 lane、integration 环境差异、剩余 S4/S5 边界和精确 commit hash。
