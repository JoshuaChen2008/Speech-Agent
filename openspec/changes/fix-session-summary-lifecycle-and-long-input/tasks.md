状态：**已决定**。未勾选事项仍待实施；勾选代表对应实现和所列局部验证已有证据，不自动提升联合/实机验收状态。

| 阶段 | 依赖 | 交付物 | 验证出口 |
|---|---|---|---|
| P0 状态与错误 | §1 | 快速失败不留running、取消终态回显、旧容量预检 | J30-STATE/CANCEL、J31-SIZE局部 |
| P1 运行控制与诊断 | P0 | 受理身份、阶段、全链取消/期限、无正文诊断 | J30全矩阵 |
| P2 长会话 | P1 + v2合同/迁移 | 输入计划、完整归并、兼容与恢复 | J31全矩阵 + J29/J24/J26回归 |

要求见本目录三份spec；数值只引用 [语义合同](../../../docs/semantic-contract.md#会话总结运行与长输入增量2026-09-27)。本次规划不启动真实模型请求、不复制用户会话到测试fixture。

## 1. 实施前核对与红测

- [x] 1.1 读取CONTEXT、SEM-F28/F31/F33/F38/F39/F40、ADR0009/0016/0021及J29/J30/J31，核对工作树与在途任务，保留已有路由修复及他人改动。
- [x] 1.2 在integration目录建立真实service→runner→SQLite→renderer快速失败旅程，确认当前终态通知缺失的红测（J30-STATE）。
- [x] 1.3 加入真实SQLite终态取消竞争：failed/succeeded先提交、cancel先登记、重复取消、存储失败，确认STATE_CONFLICT泛化红测（J30-CANCEL）。
- [x] 1.4 用合成文本复现超过旧15,000字节/1,589段规模的失败，覆盖runner和adapter上限；证据仅记指标（J31-SIZE/J12）。

## 2. P0 终态和容量反馈

- [x] 2.1 main组合根统一接通成功/失败/取消提交后的changed，不能依赖可能失败的onSettled副作用；覆盖通知丢失（SEM-F38/J30-STATE）。
- [x] 2.2 AgentRunService.cancel终态冲突回读并返回原终态及错误；不改写历史、不等待生成Promise（J30-CANCEL）。
- [x] 2.3 renderer活动详情单在途校准、恢复/重载/刷新重读、generation/revision/目标校验及新鲜度提示；保留草稿、终态停止轮询（J30-STATE）。
- [x] 2.4 分离提交中与运行中busy，修正0ms、记忆空记录及失败原因文案；生成期间阻止重复工作（J29/J30-PROGRESS）。
- [x] 2.5 先按现行策略预检输入并解释限制，已知超限零总结模型请求；此片不称长输入已支持（J31-SIZE）。
- [x] 2.6 运行受影响focus和生产renderer Electron旅程，记录P0证据与未验证范围。

## 3. P1 受理与运行控制

- [x] 3.1 定义版本化exact受理/查询/取消/快照合同及fixture，列明字段/错误与旧调用兼容，同步policy/preload/main/renderer（J30-ACCEPT）。
- [x] 3.2 追加受理元数据与revision/generation迁移，保持旧SQL/checksum；实现幂等受理、删除级联和旧键不复活；v16冻结原始输入版本、水位与digest，供未知回执重放使用（J30-ACCEPT/DB1）。
- [x] 3.3 模型前返回持久身份；summary动作用preset，question保留真实路由器；取消阻止兜底/目标创建，未知回执同键收敛；覆盖取消写失败的重试路径（J30-ACCEPT/CANCEL）。
- [x] 3.4 快照连接真实阶段事件，区分elapsed/activity、attempt/块计数及尚未读取记忆；不把心跳当进展（J30-PROGRESS）。
- [x] 3.5 取消贯穿路由/分页/模型/工具，增加非合作provider期限及迟到回写屏障，覆盖永不settle、迟到reject、结果提交竞态（J30-CANCEL）。实现完成·尚未验收：路由、模型、工具、输入读取和期限屏障已有覆盖；StorageGateway 信号贯穿 128 段 keyset 页读取，worker 入口收到独立取消控制消息后中断当前读取，真实 SQLite/worker 入口合成旅程验证后续存储命令仍可执行。字节上限、长段 code point 范围读取与完整 J30-CANCEL 联合验收仍待 P2/阶段验收。
- [x] 3.6 实现续租/失租停止、owner/attempt写屏障、控制优先与有界退出；验证旧代次不得提交、跨重启剩余预算不清零（J30-RECOVERY）。实现完成·尚未验收：追加 v17 预算账本，迁移时把无法可靠核算的既有活动总结标为 unknown 并在恢复时失败关闭；新领取持久化 attempt/time/request 预算，调度器按 monotonic elapsed 续租结算，崩溃恢复保守计入未结算租约，请求预留落库后才允许 provider 外发。真实 scheduler/runner/ModelAccess/StorageGateway/StorageWorkerService/SQLite 旅程验证续租→停止→同库重开→明确继续复用 run 和 binding、attempt 递增、旧 attempt 写入拒绝与字幕会话独立写入；v16→v17 迁移回归验证旧 checksum 保留。定向 177/177；正式 Electron 窗口、真实模型/公网和完整 J30-RECOVERY 联合验收仍待验证。
- [x] 3.7 重启后明确继续总结：固定提示按版本重建，自由问题提示缺失要求重新提交；关闭窗口与取消分别处理（J30-RECOVERY）。实现完成·尚未验收：恢复列表显式提供继续/重新输入；固定总结按提示版本恢复到同一 target run，冻结来源复核后经 request revision CAS 继续；丢失问题重新输入期间锁定原会话范围，新请求成功受理时在同一 SQLite 事务清除旧待重新提交标记并保留旧失败事实；关闭 Agent 窗不触发取消。真实 storage worker/SQLite/preload/IPC/service 确定性旅程和 AgentView harness 已验证，完整 scheduler 生命周期与 J30 联合验收仍待后续任务。

## 4. P1 本地诊断

- [x] 4.1 实现exact无正文诊断schema及记录服务，覆盖受理/计划/请求开始结束/工具/退避/取消/终态/恢复；预算失败带实际值和限值（SEM-F40/J30-DIAG）。实现完成·尚未验收：请求/运行 ID 只写 digest，模型绑定与计划只写 digest，v1 15 KB 兼容预检以 bytes 指标记录且不伪造十轴 budgetAxis；事件通过真实 runner 与 SQLite/服务旅程验证，诊断字段和写入 schema 有 contract/main 测试。查询/导出在4.3实现；敏感标记负扫描与字幕独立旅程已有4.4子切片证据；P1.5 关联证据见4.5，完整 Electron 联合旅程仍待阶段验收。
- [x] 4.2 实现滚动数量/大小/年龄上限及写失败的可见降级、有界内存；不阻塞任务终态或字幕（J30-DIAG）。实现完成·尚未验收：本地最多 5 个文件、每个 1 MiB、按创建时间优先保留 7 天，队列最多 256 条且单条≤2 KiB；写入故障经真实 SQLite/service/preload 旅程下发不可用状态，活动及恢复请求显示降级标记，请求仍可收束且字幕会话可重新开始/结束。文件数直接淘汰边界由P1.5新增旅程验证，完整 Electron 联合旅程仍待阶段验收。
- [x] 4.3 main-owned诊断查询/保存对话框/原子导出支持活动和终态；取消零写入，区别于正文结果导出（J30-DIAG/J26）。实现完成·尚未验收：renderer只提交已持久化request_id与分页参数，main从SQLite读取requestDigest后查询；响应最多100条、按sequence倒序；导出只包含精确诊断schema，经main-owned保存对话框和同目录原子写入；取消不写目标文件且不显示成功状态。真实SQLite/preload/IPC/UI旅程覆盖保存、取消、写失败可用性及字幕状态隔离，定向测试73/73，renderer 类型检查与生产构建返回码为0；4.4敏感标记负扫描与J12字幕独立旅程子切片已有证据，P1.5 关联验证见4.5，完整 Electron 联合旅程仍待阶段验收。
- [x] 4.4 敏感标记覆盖字幕/提示/工具/provider/异常，扫描诊断和证据；日志故障/取消不合作provider期间完成新字幕会话及历史导出旅程（J12/J30-INDEPENDENCE）。实现完成·尚未验收：真实 FormalAgentRunRunner 在受控网络边界 provider 异常后以稳定错误码收束，健康诊断查询/导出不含异常消息、stack 或 provider字段标记；诊断合同拒绝提示、字幕、工具参数/结果、provider事件/响应和异常字段，Agent Loop仅向观察者发布受限进度与工具元数据；J30 SQLite/preload 旅程扫描诊断 JSONL、main-owned 诊断导出与 validation JSON 中的隐私标记，并在诊断写入降级、非合作 provider 未结算及取消后，通过真实 SessionCoordinator/recorder/storage worker/HistoryService 新建、停止、分页并导出字幕，确认临时目录未发现列举的音频扩展名文件。定向测试24/24；完整J30/J12仍待阶段联合验收。
- [x] 4.5 执行P1完整确定性旅程，记录阶段/取消期限/诊断容量证据及公网边界。实现完成·尚未验收：关联 focus 149/149，`npm run test:core` 1081/1081，`npm run verify:renderer` 返回码为0；J29/J30 覆盖受理、阶段、恢复、诊断与字幕独立性。真实 SQLite worker 取消旅程在首个 128 段 keyset 页后收束为 `AGENT_CANCELLED`，下一存储命令及工具上下文取消均在 5 秒内完成；诊断测试创建 5 个有效文件并验证第六个文件分配会淘汰最旧项，且覆盖单个 1 MiB、7 天保留、256 条队列及单条≤2 KiB。只使用受控 provider/网络边界；公网模型、正式 Electron 窗口及五小时实机采集仍未验证，故不提升 J30/J12 联合验收状态。

## 5. P2 预算与存储

- [x] 5.1 登记summary.minutes@2策略和十轴作用域，v1/v2并存；bind四字段不扩充，调用者不能指定预算（SEM-F39/J31-COMPAT）。实现完成·尚未验收：冻结recipe目录保留summary.minutes@1并注册@2；模型接入层按run中的recipe版本派生精确十轴预算，@1与其它recipe仍用原策略；真实SQLite bind拒绝调用方预算字段，v2预算经ToolAudit策略校验。相关focus 52/52，`npm run test:core` 1084/1084（含renderer类型检查与生产构建）；P2剩余执行链、迁移、长输入和完整J31仍未验收。
- [ ] 5.2 盘点runner/Loop/runtime/adapter/HTTP/tool/IPC/SQLite/export限制与version=1硬编码，统一政策并覆盖非总结recipe不变（J31-SIZE/COMPAT）。
- [ ] 5.3 追加计划/策略摘要和累计时长/调用数迁移，不存中间正文；版本按最新schema顺延，验证既有库升级及失败回滚（DB1/J31-COMPAT）。
- [ ] 5.4 增加冻结raw keyset分页和超长段code point范围读取，验证first_event_order、身份变化与删除拒绝（J31-COVERAGE）。
- [ ] 5.5 实现catalog预检→bind→复核，覆盖能力不足、配置竞态、计数边界和精确/保守输入估算，拒绝零总结请求（J31-SIZE）。

## 6. P2 分块归并与恢复

- [ ] 6.1 实现确定性Agent输入计划/planDigest和无遗漏无重复覆盖证明；envelope、JSON转义、记忆/工具和输出预留计入预算（J31-COVERAGE）。
- [ ] 6.2 定义中间结果exact Schema/来源/字节上限，按连续顺序固定扇入归并，覆盖单块及装不下两个结果的拒绝（J31-MERGE）。
- [ ] 6.3 每节点调用同一AgentLoopExecutor及冻结绑定，共享实际请求/工具/usage/时限计数，未知usage不补造（J31-BUDGET）。
- [ ] 6.4 分批分页/序列化/规划让出执行，统计正文缓冲峰值并及时释放；验证最大输入下取消及字幕调度（J31-RESOURCE）。
- [ ] 6.5 全部节点结束后复核覆盖/输入/记忆撤销/Schema并原子发布一个结果；中段失败、超限和迟到结果均零部分产物（J31-MERGE）。
- [ ] 6.6 同run/绑定新attempt整次重建计划并核对digest，重启不存中间结果、不复活取消、预算不重置（J31-RECOVERY）。
- [ ] 6.7 新导出携带策略/覆盖/预算身份，旧编码器字节稳定；删除会话/交互清理新增映射（J31-COMPAT/J26/J12）。

## 7. 确定性矩阵与实机交接

- [ ] 7.1 生成4h/5h/6h合成会话，覆盖稀疏长时/密集短段、多语言、超长单段、首中尾事实；fixture时间偏移不替代真实五小时（J31-COVERAGE）。
- [ ] 7.2 文本/序列/段数/节点/请求/工具/内存/期限逐轴减一、等于、加一；容量内且计划适配的上沿样本必须产出（J31-SIZE/BUDGET/RESOURCE）。
- [ ] 7.3 真实main/preload/renderer/service/planner/Loop/storage联合覆盖通知丢失、取消、重启、迁移、下一字幕会话；仅替代provider/网络/声卡/系统外部边界（J30/J31）。
- [ ] 7.4 验证跨块修订/否定/重复事项/末段撤销/待办和来源；记忆开关四组合/撤销及summary自动信号零写入（J31-MERGE/J29）。
- [ ] 7.5 执行受影响focus、verify:renderer及相关lane；PR/阶段联合验收由当前revision完整三条lane承担，记录命令与未验证范围。
- [ ] 7.6 已授权真实模型验证五小时来源规模输入的质量/耗时/真实网络取消；独立记录五小时实际字幕采集资源趋势、退出及历史，无音频落盘，不替代原I2/I3/I4门禁（J31实机）。
- [ ] 7.7 更新语义表/旅程证据列及runtime/data说明、在途change交接链接；未验部分保持实现完成·尚未验收，不把文档校验算产品证据。

## 8. P1 确定性联合验收收尾

- [x] 8.1 建立 J30-ELECTRON 正式 Agent Bar 旅程，复用生产 Electron/main/preload/renderer/IPC、scheduler/runner/Model Access、utility storage worker 与 SQLite；只替代登记的外部不确定边界，报告仅含指标/布尔结果/稳定错误码/哈希（SEM-F38/F40、SEM-T01/T02/T04、J30-ELECTRON）。`agent-redesign-j25-formal-settings-journey.test.js` 已沿生产入口验证正式 UI 取消、5 秒期限、通知丢失后状态校准、诊断查询/导出与隐私负扫描；1/1。其余矩阵仍由 8.2–8.4 跟踪。
- [ ] 8.2 在同一真实旅程覆盖通知丢失后的校准、取消与终态竞争、取消落库失败 UI、无虚假进展、关闭窗口不取消、失租屏障、进程重启后明确继续/自由问题重输、诊断导出和敏感标记负扫描（J30-STATE/ACCEPT/CANCEL/PROGRESS/RECOVERY/DIAG）。
- [ ] 8.3 在非合作 provider 与诊断写失败期间，通过正式产品入口开始/停止下一字幕会话，验证SQLite、HistoryService与文本导出；外部取消从main受理到持久终态须≤5秒，音频替身不得产出或保存现场音频（SEM-F38/F40、SEM-F14、J12/J30-INDEPENDENCE）。
- [ ] 8.4 修复或明确定位当前 revision 的 integration/evidence 阻塞；重建 I3 非音频证据并通过严格 verifier/隐私检查，执行受影响focus、renderer验证和最终完整 `npm test`；只有三条 lane 全部成功时记录 P1 确定性联合验收证据（SEM-T03/J9-CI、J30/J12）。本轮已定位但未解除：开发态 Vite Electron 旅程在当前宿主因 GPU 子进程退出（`-1073741515`）未加载页面；I3 strict reader 因工作区既有 `StorageGateway` 改动与跟踪报告 `storageGatewaySha256` 不一致而 fail closed。不得单独刷新该报告后把与之绑定的既有代码改动留在提交之外。
- [ ] 8.5 同步语义合同、旅程矩阵、ADR/实施状态和本任务证据；仅在 J30-ELECTRON、适用 J29/J12 回归及完整三条 lane 都通过后，将 P1 标为「联合验收完成」，P2 保持未实施/未验收，change 保持开放（SEM-F38/F40、J30/J12/J24/J26）。
