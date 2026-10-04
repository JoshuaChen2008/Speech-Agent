# 联合测试与 CI 策略

## 2026-10-04 main 同步回归（实现完成·尚未验收）

SEM-T03/T04、J9-CI/I3/J25/J28-FILES：规范检出的产品修订 `bc854c7` 完整 Core 为1188/1188；完整 Integration 为164/166，两项失败中正式 Electron 旅程隔离复测成立，个人记忆文件恢复断言重复失败；补跑完整 Evidence 为248项成立、1项明确跳过、0失败。I3 报告由原生成器重新绑定 LF 产品载荷，严格 verifier 返回0。实际命令、初次非零结果、检出字节变化与未验证范围见[同步回归记录](validation/main-sync-2026-10-04.md)。宣传素材未提交；本轮不提升产品联合验收或实机状态。

## 2026-10-04 字幕窗锁定快捷键旅程登记（实现完成·尚未验收）

| 既有旅程子边界 | 必须覆盖的可观察结果 | 状态 |
|---|---|---|
| J17-SHORTCUT（SEM-F22/F23、SEM-T04） | 真实设置录入→左右键预览→保存→受约束 preload/main→原子 ConfigStore→全局快捷键控制器→真实锁定广播→字幕提示与工具条按钮；旧配置默认、右 Alt、组合键、纯修饰键松开、长按去重、其它键抑制、AltGr、关闭保留键位、重新启用、恢复默认、设置/应用重开一致。仅替代操作系统按键/注册/权限边界；产品内部实现保持真实。覆盖 Esc、取消、失焦、换页、reload/关闭恢复，注册/读取/持久化失败、非法 IPC 和损坏配置明确降级。 | 实现完成·尚未验收 |

Windows 真实按键连续性、AltGr 布局、UIPI/活动桌面及 DWM 沿 J17/I2；本次不把确定性按键注入当作实机输入证据。影响公共合同与 main/preload，执行 renderer 检查、相关 core 与 integration；阶段联合验收仍需当前 revision 的完整三条 lane。

本次先登记语义与旅程，再实施。设计和官方来源见[设计记录](caption-lock-shortcut-design.md)与[调研](research/caption-unlock-shortcut.md)。当前命令与结果：

- `npm run build:native`、`npm run verify:renderer` 返回码均为 0；只读原生状态探针确认有界数组和左右修饰键别名排除。探针在受限沙箱内遇到活动桌面权限拒绝，沙箱外读取成立；这不证明任何真实按键触发或系统权限场景。
- `node --test --experimental-test-isolation=none "test/contracts/**/*.test.js" "test/main/**/*.test.js" "test/runtime/**/*.test.js" "test/storage/**/*.test.js" "test/ui/**/*.test.js"` 当前完整 Core 断言为 1188/1188、0 失败。首轮 1184/1187 的三项失败来自旧 preload 测试装载器未登记新增合同依赖，修订装载器后重新执行；未放宽产品 IPC 校验或断言。
- `npm run test:focus -- test/integration/caption-lock-shortcut-journey.test.js test/integration/window-interaction-journey.test.js test/integration/product-sqlite-lifecycle-journey.test.js` 为 8/8、0 失败。快捷键旅程使用真实 Electron 设置/字幕/工具条、preload/main、ConfigStore 和 SQLite；只有操作系统按键/注册/读取及文件写入权限边界受控。覆盖右 Alt 预览与保存、干净松开、左 Alt 排除、夹带其它键抑制、AltGr、Esc/导航/失焦/reload/关闭恢复、读取失败降级与重新设置、写失败保持旧键位、工具条锁定按钮和第二次启动关闭状态。第二次启动还覆盖注册失败保持关闭与恢复默认重新启用。
- 为解决截图捕获早于 compositor 重绘的问题，仅在可选截图分支等待动画收束后，单独再次执行快捷键旅程为 1/1、0 失败；生产设置页录入与关闭状态已作静态视觉检查。没有以截图替代物理按键证据。

未执行完整 Integration/Evidence lane 或交互安装；真实键盘布局、物理短按、管理员窗口、安全桌面、系统高对比/DPI 与 DWM 仍未验收。字母/数字在非标准布局下的物理 `code` 与系统虚拟键映射尚无实机证据；这项输入身份边界纳入 J17/I2，不将确定性美式布局注入提升为跨布局资格。

## 2026-10-04 提交前回归与夹具对齐（实现完成·尚未验收）

关联 SEM-F14/F23/F24/F38/F41/F43/F44、SEM-T03/T04/T05，以及 J9-CI/J12/J18/J19/J21/J28-FILES/J28-EXPORT/J28-MCP/J29/J30/J31、DB1/DB7/I3/B5。当前输入完整 Core 为1163/1163，Integration 为165/165；原生成器刷新 I3 绑定后，完整 Evidence 为248项成立、1项明确跳过、0失败。记忆文件保存/重启连续15轮、记忆专用 ASAR 1/1和默认几何产品壳 fresh/restart 自然退出绑定另有证据。夹具修正保留真实内部模块、持久化、来源、独占保存与失败断言；没有以过期界面名称或保存未收束时的直接文件读取冒充产品行为。实际命令、各次非零结果、根因、Luna复核及未验证范围见[提交整理记录](validation/commit-preparation-2026-10-04.md)，不提升产品联合验收或实机状态。

## 2026-10-03 字幕助手布局与控件旅程（已决定）

主题同步回归：通过真实设置 renderer 切换主题，助手在已有窗口中更新；自动主题依据 systemDark，独立于 Agent 设置 revision。

本次实现完成·尚未验收：`npm run verify:renderer` 成功；`node --test --test-reporter=spec test/ui/renderer-style-guard.test.js test/ui/agent-ui.test.js` 为 62/62；`node --test --test-reporter=spec test/integration/agent-layout-journey.test.js` 为 1/1，覆盖真实设置切换、两主题 × 四种尺寸/缩放组合、日期倒置禁用/有效日期恢复、空项目长提示与叉号关闭。初次沙箱内 GPU 子进程启动失败属于环境问题，随后沙箱外执行成功。Computer Use 6 张原图与各构建阶段见 [第二组截图记录](ui-actual/captures/2026-10-03-2/index.md)。没有执行完整三条 lane；未将局部结果提升为完整 J18/J22/J29、系统高对比或系统 DPI 实机验收。

| 旅程 | 路径与断言 | 范围 |
|---|---|---|
| J18，关联 J22/J29 | 正式助手窗口→展开跨会话分析→日期输入→范围问答；标签在输入框上方、日期框等宽、提问框满宽、提交位于下方右侧；长状态文字下关闭叉号保持尺寸和可点击；无范围禁用、日期倒置、空项目提示不破坏布局。 | 真实 renderer、preload、main；定向 UI 回归、生产构建和 Computer Use 实拍；覆盖深浅主题及窄布局。截图归档是设计评审参考，不替代完整 J18/J22/J29 或系统 DPI 实机门禁。 |

## 2026-10-03 个人记忆对外读取旅程（实现完成·尚未验收）

| 旅程 | 跨模块验证 | 当前证据 |
|---|---|---|
| J28-EXPORT | 正式设置选择/预览→preload/main→个人上下文→文件Worker/SQLite→复制/Markdown/JSON；覆盖候选/范围排除、旧预览、外部修订、撤销、取消、写失败与证据目录拒绝；零模型调用 | personal-memory-sharing-journey 与 production Electron journey；见[记录](validation/personal-memory-sharing-2026-10-03.md) |
| J28-MCP | 正式授权→真实HTTP initialize/initialized/tools→同一文件/SQLite读取；覆盖令牌/Origin/Host/未知工具/非法参数、超限、范围隔离、休眠、修订、停止与重启失效；故障后字幕会话写入独立 | 同上；真实外部MCP客户端、完整发布包另验 |

## 2026-10-02 Speech-Agent 界面用语旅程登记（实现完成·尚未验收）

| 既有旅程 | 本次回归范围 | 执行方式 | 状态 |
|---|---|---|---|
| J18 | Speech-Agent 标题、设置导航、可见文案与无障碍名称一致；保留技术配置词 | renderer 类型检查、构建、既有 UI 测试与样式守卫 | 实现完成·尚未验收 |
| J10/J15b/J15c | 字幕记录选择、原文/精修稿切换、精修缺失与故障提示；导出仍保留既有标记和版本隔离 | 既有 history UI、history-review 与 refinement-fallback 旅程 | 实现完成·尚未验收 |
| J20/J21/J25/J28-FILES/J29 | 识别方式、助手云端授权、模型设置、记忆确认/暂停/停止使用/删除、引用来源与失败反馈的名称更新；真实内部授权和持久化边界不变 | 既有 NLS settings、formal-settings、个人记忆与会话总结旅程；只更新文案断言和定位器 | 实现完成·尚未验收 |

对应 SEM-F11/F14/F23/F27/F30/F37/F38/F41/F42/T05。此轮是展示修订，不据此声明硬件、DWM 或完整产品联合验收；实际命令与未验证范围记录于 [界面用语记录](ui-copy-review.md)。

## 2026-10-02 用户掌控个人记忆旅程（实现完成·尚未验收）

依据 SEM-F41/F42、SEM-F14/F27/F32/F37/F38、ADR0025；要求与矩阵已先登记再实施。当前实现及三条 lane 结果见[交付记录](validation/personal-memory-files-2026-10-02.md)。固定100条带标签合成查询验证融合实现，不能替代人工独立标注、真实云端质量或实机证据。

| 旅程 | 真实产品路径与失败矩阵 | 验证边界 |
|---|---|---|
| J21/J28-FILES + DB1/DB7/J10 | 目录选择→迁移/确认→MD唯一正文→管理/概览/摄取/执行读取→SQLite重开；外部编辑差异确认、未知元数据保留、根内移动、重复ID、超限/损坏、目录失联、独占保存竞争、阶段中断恢复、忘记/删除/备份重现、来源撤销、治理携带及缺失来源 | 内部模块/真实临时文件/SQLite/Win32文件句柄；仅目录对话框、权限等系统边界替身；历史迁移checksum不变、运行不回读旧正文 |
| J22/J24-RETRIEVAL + DB7 | 已授权范围→中文短词/精确/向量→RRF→文件复核→有界输入；无授权/待确认/候选/忘记/删除不得外发；表征独立配置/凭据/披露，取消、超时、401/429、redirect、缺项/NaN/维度错配、迟到响应、模型切换、代际重建和索引丢失 | 真实接入层/个人上下文/索引/SQLite，网络provider边界替身；旧工具/recipe不升级，计数与全集不依赖top-k |
| J29/J30 + J12 | 总结参考四种开关组合、休眠/撤销→文件/表征/模型请求均不越权；目录失联、重建、非合作云端及原生模块缺失期间字幕开始停止→历史→权威原始转写导出 | 正式main/preload/renderer及真实存储路径；打包原生模块实际加载；无音频产物，证据只含指标/枚举/布尔/相对耗时/哈希 |
| J22-QUALITY | 100条人工标注题分别比较关键词、向量、RRF的Recall@10/Precision@10/nDCG@10/无答案误召回、耗时和索引成本 | 合成题集正文留在测试代码或临时目录，报告仅指标/哈希；真实云端与实机证据单列，缺失不得以替身质量替代 |

> 功能承诺、测试边界和完成状态词以 [`semantic-contract.md`](semantic-contract.md) 为准；
> 本文负责维护可执行的旅程 ID、运行环境与证据状态。

## 2026-10-01 后台 Agent 任务空队列休眠回归

| 旅程 | 用户路径与可观察结果 | 必须真实的边界与失败场景 | 当前证据 |
|---|---|---|---|
| J24（SEM-F28/F30、SEM-T04） | 开启 Agent 与个人记忆 → 后台 Agent 任务被唤醒 → 空队列休眠；等待超过原 1 秒重试间隔后仍零诊断、零重试 timer，空领取回执计数不增长。 | 真实 PersonalContextRuntime、ConfigStore、StorageGateway、StorageWorkerService 与 SQLite；入口覆盖空对象、两类单字段请求及未知字段、非法策略、混合字段拒绝，无模型调用。回归放在既有 `agent-redesign-s3-session-ingest-journey.test.js` 和 `storage-worker-service.test.js`。 | 实现完成·尚未验收；两项新增回归在修复前失败，修复后关联 focus 103/103，退出码 0。 |

本次验证命令：`npm run test:focus -- test/storage/storage-worker-service.test.js test/integration/agent-redesign-s3-session-ingest-journey.test.js test/runtime/formal-agent-job-scheduler.test.js test/main/personal-context-runtime.test.js test/storage/personal-context-store.test.js test/storage/storage-worker-host.test.js test/main/storage-gateway.test.js test/validation/personal-context-s1-privacy.test.js`。原空队列复现也返回零诊断、零重试 timer、一次空领取；临时数据库均已清理。未运行全量三条 lane、正式 Electron 或实机模型，此子边界不替代 J24 完整验收。

## 2026-09-29 Agent 模型设置与有界重试旅程增量（已决定）

J25 从首次四步向导改为日常默认模型选择与页内共用新增/编辑表单：验证空模板、三项预设与自定义六字段、同服务多模型、密钥 scope、部分保存回执、revision 冲突、目录失败手填、测试与保存分离、测试取消和配置变化后的旧测试结果失效。J18 增加搜索选择器的键盘、Esc、焦点、主题、高对比、reduced motion 与窄窗口验证。

J30/J31 用真实执行宿主、storage worker/SQLite、模型接入层、main/preload/renderer 证明同一 run 至多 5 个 attempt、同一操作跨重跑至多 5 次、执行前预留及重启不重置、第 5 次成功/失败、第 6 次零外发、非重试错误零额外执行、取消等待与迟到回写拒绝、原绑定不变、旧策略兼容。长输入还需证明分块与工具共享已有总预算，不能形成 5×5 放大；J12 覆盖失败或诊断不可用时字幕独立。仅 provider、网络、声卡、系统凭据等外部边界使用替身。定向证据不得冒充完整 J25/J30 联合验收。

2026-09-29 当前证据状态：实现完成·尚未验收。`npm run test:core`（含 renderer 类型检查与构建）为 1086/1086，正式 Electron J25 定向旅程为 2/2；受控网络同步异常的五次上限、重试等待快照的存储与契约、缺密钥聚焦均有定向验证。J30 真实 scheduler/runner/storage worker/SQLite 重启旅程定向 1/1，证明模型请求的确定性预算拒绝只结束 Agent 请求，不熔断共享 storage 队列，后续字幕会话可继续写入。此前同一工作树的 integration lane 为 71/72；唯一失败是 J18 的重复 Vite 开发态启动首轮 Electron 子进程退出，单独复跑时有 GPU 初始化错误。该失败未被记作产品断言通过，本次增量未重复运行完整 integration lane。完整 J30/J31 的五次上限、重启及本地等待反馈矩阵仍需联合验收。

## 2026-09-30 会话问答窗口内输入容量旅程（第一步，已决定）

对应 SEM-F16/F28/F31/F33/F40 与语义合同同日“会话问答窗口内输入容量”表。新增场景落在既有 lane，不新增旅程层级。

| 旅程子项 | 用户路径与必须验证的事实 | 真实内部边界 |
|---|---|---|
| J22-QA-WINDOW / J24 | Agent Bar 单会话问题→受理/意图收敛→新建 `qa.answer@2`→完整输入→回答/历史/导出。>15,000 字节但派生窗口内的中文及多段输入确实外发且完整覆盖；问题与首/中/尾来源保持，QaAnswerV1 及来源范围校验不变 | renderer/preload（适用 J30 正式 Electron 场景）、SessionSummaryRunService、IntentRouteOrchestrator、scheduler/runner、Personal Context、Model Access、Loop、生产 adapter、storage worker/SQLite；只在 provider/网络/系统边界使用替身 |
| J22-QA-SIZE / J30-DIAG | 动态 prompt 边界减一/等于/加一，小模型零容量，Unicode 与 JSON 转义；超界专用码、字节实际/上限、零问答生成模型请求、零结果且不重试；通用预算失败不出现“模型尚未调用”反馈 | 同一 runner/Loop/adapter；诊断 exact schema 与 UI，失败后字幕新会话与历史仍可写读 |
| J24-QA-BUDGET | 工具后续轮和重试每次复核系统/工具/消息增长与输入窗口、512 KiB HTTP 保护；输出额度受模型/累计余量约束，未知 usage 仍为 null；取消后不再外发、不提交迟到结果；60秒与累计预算不扩大 | 生产 adapter、Loop、请求预留与工具审计、真实 SQLite 终态 |
| J24-QA-COMPAT / DB1 | v20→v21 保留每个旧 checksum、旧问答 `@1` 的绑定/预算/15,000字节拒绝/导出字节；新运行 `@2` 的专用失败码在重开、历史和导出中一致；总结与其它 recipe 限制不变 | 真实追加迁移、模型绑定、运行/交互存储与 exporter |

当前状态：**实现完成·尚未验收**。本轮命令与范围：

- 修复前 `node --test test/integration/session-question-window-journey.test.js` 为0/2：窗口内中文输入被旧15,000字节预检以通用预算错误拒绝，超界反馈也不精确。修复后该文件为4/4，额外覆盖150段分页输入、明确交互记忆信号来源、取消/迟到结果、失败后字幕新会话、数据库重开与成功/失败/取消导出。
- `npm run test:core`（含 renderer 类型检查与构建）为1136/1136，含动态字节边界、序列化转义、工具后续轮、输出余额、未知usage、重试、v20→v21校验和/旧绑定/旧预算/旧导出字节、专用错误历史投影与UI字节诊断。
- `node --test --experimental-test-isolation=none --test-reporter=spec "test/integration/**/*.test.js"` 首轮88/90。正式 Electron J25 fixture 在一次脚本任务里设置受控输入后立即点击仍禁用的按钮，未产生受理回执；修订为等待 renderer 提交输入并启用按钮后点击，`node --test --test-reporter=spec test/integration/agent-redesign-j25-formal-settings-journey.test.js` 定向2/2。此修订不改变产品受理语义。
- `node --test --test-reporter=spec test/integration/renderer-development-entry-journey.test.js` 为0/1，既有 Vite 开发态首轮 Electron 启动仍以退出码1结束。完整 integration 未重跑、未记为联合验收；真实 provider、原46分钟会话、第二步长输入分块及四小时实机证据未验证。

## 2026-09-30 会话问答长输入旅程（第二步，已决定）

| 旅程/子项 | 必须覆盖的可观察结果 |
|---|---|
| J22-QA-LONG / J31 | 正式问题受理→qa.answer@3冻结绑定→真实分页/Unicode分块→同一Loop逐块回答→顺序归并→一个QaAnswerV1及来源引用→历史/新版导出；输入大于单请求窗口、四小时合成会话、多层归并、首/中/尾修订完整覆盖，问题传递至所有节点 |
| J24-QA-LONG / J30 | 中间输出无效或越权、最小模型窗口/整次容量超界、工具与累计预算、未知用量、网络重试及跨attempt累计；失败零部分回答，取消期间及迟到结果拒绝，不重置冻结模型身份 |
| J30-QA-RECOVERY / DB1 / J12 | 活动长问答停止→真实SQLite重开→提示未保存且无自动模型请求→固定原会话重新输入；成功/失败计划与用量回执重开一致、旧@1/@2绑定/预算/导出仍按原义，后续字幕会话独立工作；诊断/数据库不得保存问题或模型中间输出 |

内部使用真实SessionSummaryRunService、IntentRouteOrchestrator、scheduler/runner、Personal Context、planner、Loop、Model Access、生产adapter、StorageGateway/worker与SQLite；替身只位于provider/网络/系统边界。先建立超窗口回答红测，再实施。定向结果不代替当前revision全lane、正式Electron窗口矩阵或真实provider/实机证据。

2026-09-30 当前实施状态：**实现完成·尚未验收**。本轮证据与限制：

- 超窗口回归修复前被 `qa.answer@2` 输入预检拒绝；改为新 raw 单会话 `@3` 后，`test/integration/session-question-window-journey.test.js` 为20/20（含嵌套失败场景）。四小时合成输入完整覆盖，128段含超长 Unicode 单段及首/中/尾修订，经多层归并后只提交一个回答；缓存用量沿实际 provider 回执累计，SQLite 重开后导出编码一致。另覆盖无效/超大/越权中间回答、必要归并容量拒绝零外发、累计预算与共享工具预算、归并取消、实际检索的个人记忆引用、运行期间撤回及重启重新提交。正文和原问题仅出现在受控输入或明确交互结果，不进入计划、诊断或请求回执。
- 定向命令 `node --test --test-reporter=spec test/contracts/agent-run-ui-contract.test.js test/runtime/summary-input-plan.test.js test/integration/session-question-window-journey.test.js` 为34/34，含旧总结规划与新问答完整覆盖、取消及段数超界、新旧导出回执兼容。`npm run verify:renderer` 类型检查和生产构建返回码0。
- 扩大 core 命令 `node --test --experimental-test-isolation=none --test-reporter=spec "test/contracts/**/*.test.js" "test/main/**/*.test.js" "test/runtime/**/*.test.js" "test/storage/**/*.test.js" "test/ui/**/*.test.js"` 为1139/1140。唯一失败为既有模型设置共用表单场景的 alert 节点为空，`test/ui/agent-model-settings-ui.test.js` 单独复核为4/5；本步未改动该表单，不把该失败记为问答断言成立。
- 完整 integration 命令 `node --test --experimental-test-isolation=none --test-reporter=spec "test/integration/**/*.test.js"` 为105/106，含正式 Electron J25/J30 2/2。新问答版本要求的真实分页/计划及请求回执接线已同步到模型对比旅程，公开交互导出回执允许已登记 schema 1–4；剩余失败仍为 Vite 开发态首次 Electron 启动退出码1。
- evidence 命令 `node --test --experimental-test-isolation=none --test-reporter=spec "test/gate-0b/**/*.test.js" "test/gate-0c/**/*.test.js" "test/validation/**/*.test.js"` 为246/249（1项按设计跳过）。两项 I3 非音频报告 provenance 校验因共享工作树的 `sessionCoordinatorSha256` 与既有报告不一致；本步未改 coordinator，也未改写报告或将其计为资格成功。

上述合成 provider 旅程证明内部接线及确定性覆盖，不证明模型实际理解后文修订的质量。原46分钟及四小时真实会话、公网 provider 耗时、128 MiB 缓冲峰值和完整三条 lane 均未验收；新建 raw 问答使用新策略，旧失败运行与绑定不自动升级。

## 2026-10-01 提问优先个人记忆旅程增量（实现完成·尚未验收）

本表修订 J21/J22/J28/J29 的旧来源策略与实施顺序，依据 SEM-F26/F27/F30/F31/F32/F37/F38 的同日登记；旧总结局部证据保留。本轮提问/确认/关联/概览/总结实现完成·尚未验收。当前工作树 Core 1153/1153、Integration 119/119；刷新 UTC 的 I3 记录后，完整 Evidence 为 248 项成立、1 项明确跳过、0 项失败。实际命令、新增纵向旅程与实机边界见[验证记录](validation/personal-memory-optimization-2026-10-01.md)，不把这组确定性证据晋级为产品联合验收。

J18 的重复开发启动只校验正式 caption/toolbar renderer 初始化。2026-10-01 本机默认 GPU 子进程以 0xC0000135 退出；旅程沿用既有 Electron 确定性测试的 disable-gpu/in-process-gpu 参数。受限环境加载本机页面另返回 ERR_FAILED，沙箱外定向旅程与完整 Integration 成立。该结果不证明 GPU、DWM 或真实声卡行为（SEM-T03）。

| 旅程 | 必须覆盖的可观察结果 |
|---|---|
| J21/J22 | 正式提问中的本人项目/长期表达要求 → 结构化候选 → 查看来源 → 用户确认/修改 → 后续 resolve → SQLite 重开一致；知识问题、临时要求、引用、假设、代问、未采纳助手输出不归本人，失败/取消的提示仍按资格与清理边界摄取；重试、重复 digest/唤醒零新增独立证据，重复模式至少两次独立任务且仍是候选。旧 @1 绑定、输出合同和 migration checksum 保持。 |
| J21/J28 + DB7 | 已确认个人信息 → 合格终态会话 → 等值关联与双侧依据 → 修改/忘记/删除信息 → 旧关联不可读；无本人信息、无关/同名/角色不符/相似话题不建立明确本人归属，项目背景不变成用户决定或待办。冻结外条目、越界引用、旧 revision/已删来源拒绝整个提交；撤销竞态、迟到响应及 SQLite 重开不恢复旧关联，已确认旧条目保留。 |
| J28/J29 + J12 | 正式 settings/agent/history renderer → exact preload/main → 个人上下文 → SQLite：概览确定性分组、候选确认与正文/范围编辑；来源真实时间、跨年/时区、摘要与原文摘录分区、分页外精确定位；原提示已清理、旧记录缺摘要、已删/撤销、导航失败及重试；浏览不创建模型请求或记忆信号，返回原记忆位置。 |
| J28/J21/J24 | 多次有效来源 → 有界 context.synthesize → 来源/覆盖/输入身份 → 当前与上版；修改落到底层条目，重复唤醒/重启/旧模型响应幂等，每范围单运行与全局并发一，无变化零调用；超预算、模型失败、休眠新边界、忘记/删除立即失效与 suppression；显式旧会话预览零调用、提交/取消受控。 |
| J29，保留 J30/J31/J12 | 实际纳入输入的记忆及关联依据可展开；四种开关组合、休眠和撤销覆盖所有 provider payload；普通总结操作零写入、明确记住真实管理提交；取消/迟到、长输入覆盖、旧导出编码与下一字幕会话独立性保持。 |

内部产品模块使用真实实现，仅模型/网络/系统权限等不可确定边界使用替身。确定性旅程证明范围、归属合同、来源及生命周期；实际模型分类和关联质量单独核对。每片按 §2.1 定向验证；公共合同、共享存储或 main/preload 改动扩大相关 lane，阶段联合验收要求当前 revision 完整三条 lane。复制/Markdown/JSON 与只读 MCP 后续另行登记。

## 1. 完成口径

### 2026-10-01 总结检索优先问答旅程（已决定）

依据 SEM-F26/F28/F30/F31/F34/F38/F39/F40 与[规划](session-question-summary-first-plan.md)，实施前登记下列新增子边界。内部个人上下文、runner/Loop、main/preload/renderer、storage worker/SQLite、历史服务均使用真实实现，只替代 provider/网络/系统权限边界；登记不晋级已有状态。

| 既有旅程子边界 | 正常与失败出口 |
|---|---|
| J21-EXPERIENCE / J24 / DB7 | 长终态会话分段摄取→全部范围经历及逐项来源持久化→处理进度一致→重开/重复执行复用；前8项之后仍能分页读取。超长单段 Unicode 完整切分；第二范围失败/取消/失租不推进，已提交独立产物仍标明覆盖缺口；来源修改/删除和过期绑定拒绝。个人候选/关联/确认与休眠边界不变。 |
| J22-QA-RETRIEVAL / J24 / J31 | 正式问答→总结与原文共同召回→有界原文核对→带来源答案。重复提问不重新全场逐块生成；摘要遗漏、中文两字词、数字日期、标识符、否定与较晚修订仍能找到。无总结、空召回、容量不足、工具增长、取消/迟到、应用重启和用量未知明确治理。 |
| J22-QA-SCOPE / J24 / J31 | 日期/项目选择→冻结完整会话目录→局部变化联合检索或全局分页分批→实际覆盖与缺口。超过一页的会话不得遗漏；同名项目隔离；完整清单/计数不得仅用top-k；缺失总结、范围变化、source撤销和预算不足有明确结果。 |
| J29-QA-SOURCE / J10 | 正式结果逐结论来源→main/preload→历史精确分页定位及高亮→返回结果；日期/相对时间从原记录解析。已删/失效、旧结果无粒度、跳转失败和迟到读取不串会话，查看不调用模型或摄取。 |
| DB1 / J30 / J12 | 追加迁移保留全部旧checksum/recipe绑定/导出字节；索引重建、正文版本隔离及级联删除。Agent失败或取消后下一字幕会话、历史/导出独立；诊断与测试证据无正文/路径/现场音频。 |

局部回归按 §2.1 执行；阶段验收取得当前工作树三条 lane 及正式 renderer 旅程，真实 provider 内容质量与适用 Windows 实机边界另验。

2026-10-02 状态为**实现完成·尚未验收**，实施与证据见[交付记录](validation/session-question-summary-first-2026-10-02.md)。新增真实模块旅程位于 `session-experience-journey.test.js` 与 `personal-memory-question-journey.test.js`：范围产品/恢复、独立原文召回、52场日期目录、53项同名项目分页、正式日期/项目表面、迟到来源版本、候选并发和待办时效。正式Electron J25等既有旅程继续核验新默认问答；合成策略对照只度量来源可供性和请求字节，不作为真实模型质量评分。

单元测试通过只能证明局部逻辑成立，不能作为功能完成的依据。一个面向用户的功能只有同时满足以下条件，才可以在 PLAN/README 中标记完成：

### 正式 Agent MVP contract registration（2026-08-31）

S5-Integration 采用 main-owned `AgentRunService`。submit 的公开载荷只包含范围、用户 prompt 和 client idempotency key；main 通过真实 StorageGateway 冻结 transcriptVersion、inputWatermark、inputDigest 与 Personal Context revision。export 只接收 interaction ID，由 main 生成 canonical JSON。Agent run UI contract 的 response 必须在 IPC controller 返回前重新校验；changed 事件采用先订阅后读取和单调 revision。正式实施任务、J21/J22/J24/J26/J27 旅程和失败矩阵登记在 [`docs/formal-agent-mvp-todo.md`](formal-agent-mvp-todo.md)。

### S5 纵向子边界登记（2026-09-08）

`implement-agent-redesign-s5-minimal-chain` 先验证 J22/J24/J26 的真实终态会话请求链路：Agent Bar → main-owned service → Personal Context/Model Access/Agent Loop → storage worker/SQLite → Agent renderer/history/export。目标联合旅程使用真实内部模块，只替代 Agent 模型 provider、云网络、系统保存对话框等不可确定外部边界；当前已有的进程内 storage host 转发、手工 execution adapter 和局部 renderer facade 只能证明局部行为，不能作为 S5-Integration 的真实内部模块证据。该切片不替代完整 J21/J22/J24/J25/J26/J27 用户旅程，也不创建新的同义旅程 ID。

切片必须覆盖：终态/空正文资格、`summary.minutes` 与 `qa.answer`、模型优先加规则兜底、重复提交、取消与迟到结果、Schema/预算/provider 失败、renderer reload、storage replacement、字幕独立性、交互详情工具审计、成功/失败/取消 canonical JSON 导出、重复导出字节一致和 SEM-F14 隐私负扫描。应用重启后无法恢复提示的请求明确收束，不把不完整恢复投影为成功。

`getScopes` 也属于该子边界的 exact contract：请求只允许合同头、1–50 的 `limit` 与不透明 `cursor`；响应只允许合同头、`ok`、`error`、`scopes`、`next_cursor`、`default_scope` 和单调 `revision`，成功时 `error=null`。每个范围项的 `display_name` 必须是有界非空字符串，`started_at`/`ended_at` 必须是可空 RFC 3339 UTC 墙钟字符串，且 `terminal` 项的 `ended_at` 非空。测试必须覆盖最近终态默认范围、无可用范围的空状态、分页游标和禁止正文/路径/设备名/音频字段；该 scope projection 证据仍只能记为「实现完成·尚未验收」。

1. 相关模块各自的纯逻辑测试通过。
2. 至少一条跨模块用户旅程在 CI 中稳定复现并通过。
3. 涉及真实音频设备、模型性能、DWM/人工窗口交互或长时间运行时，有对应的 Windows 实机报告。
4. 失败路径证明会降级或 fail closed，不能只覆盖顺利路径。

测试替身只放在不可确定的外部边界，例如物理音频设备、云端识别 provider、Agent 模型 provider 和系统权限。`SessionCoordinator`、Caption reducer、存储、队列、契约校验等产品模块应在联合测试中使用真实实现。

## 2. 执行分层

2026-09-30 J31实施登记（已决定）：验证summary-long-input@1新运行与旧直接@2并存、v19→v20及旧checksum、真实分页→planner→Loop→SQLite的173,827字节纵向旅程；包括单块、多层归并、超长Unicode段、节点范围、取消/迟到、未知用量、跨attempt累计和重启计划digest一致、失败零纪要。适用J29记忆开关/撤销、J30状态/取消及J12下一字幕会话；内部模块真实、仅provider/网络/系统边界替身。正式Electron与实机证据另列，不以局部结果晋级。

### 2026-09-27 起会话总结运行与长输入旅程（P0/P1 局部实现证据）

2026-09-28 J30-STATE/CANCEL/DIAG、J12 失败收尾增量（已决定）：真实 storage worker/SQLite 与执行宿主用受控 provider 复现短会话模型错误、失败写入拒绝和失去执行者后的取消；断言重试/终态一致、取消在 5 秒内收束、迟到结果拒绝、诊断稳定错误码与隐私负扫描。另覆盖旧 `cancelling` 行、成功先提交、取消落库失败状态未知及字幕历史独立性。此登记不替代下表未满足的正式 Electron 与三条 lane 门禁。

2026-09-28 失败收尾修复局部证据（实现完成·尚未验收）：当前代码的相关 focus 85/85，覆盖真实 SQLite/执行宿主的模型服务失败→等待重试、重试耗尽→运行/交互/请求一致失败、凭据拒绝零重试、运行中及旧 `cancelling` 请求取消；正式 Electron J30-ELECTRON 定向 2/2，renderer 类型检查和生产构建成功。一次 `npm test` 的 core 1096/1096、integration 71/72；唯一失败为 J18 Vite 开发态首次启动退出码 1。单独 `npm run test:evidence` 246/249（1 项按设计跳过），两项 I3 非音频报告因工作树中既有 `StorageGateway` 改动导致 `storageGatewaySha256` 不匹配。全 lane、真实模型原始失败原因及实机范围未验收。

P0 与 P1 各子切片为**实现完成·尚未验收**；P1.5 的关联确定性旅程和 renderer 检查已运行，完整 Electron 联合旅程、公网模型与实机范围仍未验收。P2.1 版本化预算注册有局部实现证据，其余 P2 长输入任务仍为已决定待实施。以下记录子集证据，不沿用 J29 路由修复或旧 PluginHost 资格宣称 J30/J31 全面验收。数值唯一权威见[语义合同增量](semantic-contract.md#会话总结运行与长输入增量2026-09-27)，实施顺序见[任务表](../openspec/changes/fix-session-summary-lifecycle-and-long-input/tasks.md)。以下为 J30/J31 子项，不新增 test lane。

| 旅程/子项 | 用户路径与可观察结果 | 必须真实的内部边界与失败矩阵 | 当前证据 |
|---|---|---|---|
| J30-ELECTRON | 正式 Agent Bar 发起会话总结→运行反馈/取消/诊断/恢复→字幕历史继续可用 | Electron main/preload/renderer、正式IPC、scheduler/runner、Model Access、utility storage worker 与 SQLite 使用生产组合；只替代 provider/网络/声卡/系统权限/保存对话框。由生产 UI 触发，覆盖通知丢失与刷新、期限内取消和状态未确认、跨进程重启明确继续、诊断写失败、敏感标记及下一字幕会话 | 实现完成·尚未验收：`test/integration/agent-redesign-j25-formal-settings-journey.test.js` 2/2 现经正式 Electron Agent Bar 验证受控 provider 取消、5 秒期限、丢弃终态通知后的状态校准、诊断查询/导出及敏感标记负扫描；新增覆盖 Agent 窗口关闭不发送取消、挂起请求 IPC snapshot 未报告分块进展，以及独立进程重启后用户明确继续同一 request/run 且继续前零 provider 请求。相关 J30 服务旅程覆盖 SQLite 重启与明确继续，J12 子旅程覆盖诊断故障期间字幕独立性。仍缺取消落库失败 UI、诊断写失败时字幕连续旅程及完整三条 lane 验收。2026-09-29 轻量方案：本旅程需扩展窗口内直接总结场景（短会话与 173,827 字节合成会话生成→保存→重开、取消/失败零纪要、下一字幕会话独立），尚无实现证据 |
| J30-STATE | 提交→快速失败→通知丢失→详情校准→准确失败；刷新/恢复/重载一致 | main/service/runner/SQLite/renderer/preload；旧revision/目标迟到、读取故障、新鲜度、草稿保留 | P0 子集实现完成·尚未验收：S5 SQLite 终态通知和 J25 生产 renderer 容量失败；J30 全矩阵未验收 |
| J30-ACCEPT | 模型路由前可取消；明确总结零模型判定；未知回执同键不重复 | exact IPC、受理、真实路由器、SQLite；路由慢/取消/迟到/兜底、重复点击、删除旧键 | 受理接线子旅程实现完成·尚未验收：真实 SQLite/AgentRunService/ModelAccess/IntentRouteOrchestrator覆盖持久身份、preset零路由、question路由、同键回执丢失且资格/输入源不可用时重放、取消写失败重试；main IPC 与生产 preload 的边界测试、AgentView 组件回归验证精确合同、不确定回执锁定同一请求与会话、刷新期间保持作用域、终态解除锁定并保留会话显示、快照新鲜度。完整正式窗口旅程及 J30 全矩阵仍未验收 |
| J30-CANCEL | pending/running或旧快照终态取消→权威终态 | 真实事务竞争、service/scheduler/adapter/UI；provider不理abort、工具慢、成功/失败先提交、取消落库失败、登记期限 | P0 子集实现完成·尚未验收：AgentRunService 冲突回读、S5 真实 SQLite 终态竞争及 UI 详情读取失败；P1取消子切片实现完成·尚未验收：路由、模型、工具与输入读取取消、非合作 provider 期限及迟到结果拒绝；StorageGateway 到真实 SQLite 的 worker 旅程验证 128 段 keyset 页读取能接收不进入 storage 请求 FIFO 的取消控制消息且后续读取正常。取消落库失败 UI 全矩阵、完整 main 到权威终态期限旅程、真实模型/公网取消、正式窗口与实机范围仍未验收 |
| J30-PROGRESS | 真实阶段、等待、块数、attempt、实际记忆事实 | 真实阶段发射/快照/UI；无首响应、工具等待、退避、重跑进度重置、usage未知 | 进度子切片实现完成·尚未验收：provider 请求边界、受控工具结果、claim attempt 与实际记忆查询事实接入快照；去除未使用的无条件上下文解析；elapsed 与活动时间分离，终态前冻结耗时；P2 输入规划前块数保持 null |
| J30-RECOVERY | 长请求续租→失租/退出→重开→明确继续或已取消；关闭 Agent 窗口不取消任务 | 真实scheduler/lease/storage/main/renderer；恢复列表项重新呈现冻结会话范围；旧owner/attempt回写、固定提示版本重建、自由问题提示缺失后固定原会话范围并要求重新提交、新请求受理时同事务清除旧标记、明确继续复用同一run/绑定并递增attempt、取消事实先核对、剩余预算不因重启清零、scheduler拒绝领取待继续run | 重启恢复、租约与预算子切片实现完成·尚未验收：既有焦点验证覆盖真实 SQLite/storage worker/service/preload/IPC 的恢复投影、显式继续复用 target run、新问题成功受理时旧待重新提交标记同事务清除及同键回执重放；AgentView harness 覆盖显式继续/重新输入、问题重输期间锁定会话范围与关闭窗口不取消。新增真实 scheduler/runner/ModelAccess/StorageGateway/StorageWorkerService/SQLite 旅程覆盖请求外发前预留、运行中续租、停止后重开数据库、旧 attempt 写入拒绝、明确继续复用 run 并递增 attempt、租约崩溃预留保守计入及字幕会话仍可写；旧预算未知的迁移恢复失败关闭。正式 Electron 重启明确继续子旅程已覆盖，完整正式窗口矩阵与 J30 全矩阵仍未验证 |
| J30-DIAG | 活动/失败/取消→诊断→导出或取消保存 | 真实诊断服务/schema/main save adapter/滚动文件；不可写、容量/年龄清理、开始无结束事件、异常脱敏 | 记录与写入故障降级子切片实现完成·尚未验收：4.1/4.2 定向测试 82/82，`npm run test:core` 1076/1076。查询/导出子切片实现完成·尚未验收：4.3 定向 contract/main/runtime/UI/J30 旅程 73/73，`npm run verify:renderer` 返回码为 0；真实 SQLite 请求身份解析、分页、main-owned 保存对话框、原子导出及取消零写入均有覆盖。隐私及独立字幕子切片实现完成·尚未验收：4.4 定向测试 24/24，覆盖真实 runner provider 异常后的稳定失败、健康诊断查询/导出、隐私标记负扫描和字幕独立旅程。P1.5 关联 focus 149/149、`npm run test:core` 1081/1081、`npm run verify:renderer` 返回码为 0；诊断测试直接验证六个有效文件时分配新文件会淘汰最旧项，年龄/单文件大小/队列容量也有确定性断言。完整 Electron 窗口联测和 J30/J12 联合验收仍未验证 |
| J30-INDEPENDENCE | 总结等待/不合作取消/日志故障期间启动停止字幕→历史/导出 | 真实SessionCoordinator、recorder、storage worker、SQLite、history；只替代声卡/provider/网络/系统边界 | 4.4 子切片实现完成·尚未验收：诊断写入不可用且非合作 provider 保持未结算期间，真实 `SessionCoordinator`/`SqliteSessionRecorder`/`StorageGateway`/`StorageWorkerService`/SQLite 创建并停止字幕会话；真实 `HistoryService` 完成列表、分页和原文导出。受控 runtime/provider 与声卡边界替身；导出正文仅进入临时目录，递归检查列举的音频扩展名均未发现文件。完整 J12/J30 旅程仍待联合验收 |
| J31-SIZE | >15KB旧规模及4h/5h/6h输入→预检→执行或明确超界；旧版输入预检使用专用稳定错误码并证明零模型调用 | 真planner/能力绑定/runner/Loop/adapter/storage/export；原文/序列/段数各减一/等于/加一、能力不足、配置竞态、transport上限；v1与qa.answer@1旧限制不变；v2动态prompt≤256 KiB、完整HTTP request≤512 KiB、单Loop≤180秒、每attempt≤512次实际模型请求；v2总attempt≤2，工具记录每attempt≤12且旧attempt保留。2026-09-29 轻量方案：窗口内直接总结按语义合同 2026-09-29 小节的计数方式派生单请求输入窗口与 8,192 输出额度，窗口边界按本文件末尾 review 修订：86,914 字节在模型输入能力 95,106/95,105 token 下分别接受/拒绝；173,827 字节在当前无 tokenizer 策略下拒绝；新建运行以 `summary.minutes@2` 表达，专用 `AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED` 覆盖 @1 与 @2 的输入预检且保持零模型调用证明 | 旧版预检子集实现完成·尚未验收：1589 段合成 SQLite 样本得到专用错误；S5 证明总结模型调用数不增加，J25 证明 renderer 错误/恢复文案及零工具调用；长输入未实现。2026-09-29 容量登记已实施：定向 `npm run test:focus` 覆盖容量派生窗口边界（模型输入能力 95,106/95,105 token）、173,827 字节合成会话预检、新建 `summary.minutes@2` 冻结/绑定与 preset 直建路径 64/64 通过；S5 目标旅程及正式 Electron J30-ELECTRON 2/2 复跑通过（含超限专用错误码文案与零模型调用），runtime/contracts/storage 关联回归 58/58。未验证范围：完整三条 lane、真实 DeepSeek 公网与实机采集；定向结果不构成 J31-SIZE 完整联合验收 |
| J31-COVERAGE | 分页冻结raw→分块→完整范围证明 | 真适配器/SQLite/planner；Unicode/JSON转义/超长段/精修覆盖/分页删除变更、无缺口无重叠 | 已决定 |
| J31-MERGE | 多层归并→一份纪要→来源和语义核查 | 真Loop/归并/schema/提交；中段失败、输出超限、两个结果装不下、末段修订前段、否定/待办、零部分产物 | 已决定；质量和覆盖分别断言 |
| J31-BUDGET | 多节点/attempt共享预算→触线收束 | 真版本化预算/绑定；逐轴边界、usage缺失、旧attempt消耗、运行中改模型 | 已决定 |
| J31-RESOURCE | 上沿输入下UI/字幕响应、取消、释放缓冲 | 真分页/序列化/调度；缓冲峰值、取消耗时、main事件循环影响；文本容量不替代采集长稳 | 已决定 |
| J31-RECOVERY | 中断后同run/绑定新attempt整次重跑 | 真SQLite/计划digest/剩余预算；中间正文零持久、取消不复活、来源撤销、删除 | 已决定 |
| J31-COMPAT | 既有库升级→旧结果/绑定/导出→新v2总结 | 真追加迁移、v1/v2 validator/导出/原始历史；旧SQL/checksum及导出字节不变、删除级联、其它recipe预算不变；5.1验证 v1/v2 recipe 解析、十轴作用域、同一四字段 bind 输入及调用方预算字段拒绝；5.2验证 SQLite claim 保留冻结 recipeVersion、终态与导出按同版 validator 校验，renderer IPC 不接收 recipeVersion/预算且旧导出字节不变 | 5.1 实现完成·尚未验收：recipe contract、十轴策略快照、真实 SQLite bind 与 v2 ToolAudit 关联 focus 52/52；`npm run test:core` 1084/1084（含 renderer 类型检查与构建）。迁移、导出、旧库升级及完整 J31 尚未验证 |

2026-09-27 P1受理子切片：`formal_agent_requests` 的幂等受理、记忆参考偏好冻结、原始输入身份冻结、排队目标取消、会话删除收据、run 输入身份写屏障、无输入身份的 v15 活动行升级收束及 v14→v16 回滚/升级已有定向和 core 证据；服务层 J30-ACCEPT 真实 SQLite 旅程覆盖未知回执重放及取消写失败重试，状态为**实现完成·尚未验收**。完整 J30-ACCEPT 仍待 main/preload/renderer 接线和正式窗口旅程。

2026-09-28 J30-ACCEPT 接线子切片：新增版本化 exact 会话总结受理/查询/取消快照合同与 v1.0.0 fixture；main IPC、Agent-only policy、生产 preload 与 AgentView 使用同一合同，旧 Agent run IPC 保留。真实 SQLite/AgentRunService/ModelAccess/IntentRouteOrchestrator 受理旅程经注册 main IPC 与生产 preload VM；renderer 组件回归覆盖不确定回执同键重放、请求期间及列表刷新后保持会话范围、明确设置拒绝解除锁定、终态解除锁定并保留所选会话显示，以及新鲜快照读取失败时保留最近确认状态。`npm run test:focus -- test/contracts/session-summary-run-ui-contract.test.js test/main/session-summary-run-ipc.test.js test/main/session-summary-run-preload.test.js test/main/ipc-access-policy.test.js test/ui/agent-ui.test.js test/integration/session-summary-request-j30-accept-journey.test.js test/contracts/agent-run-ui-contract.test.js test/main/agent-run-ipc.test.js` 为 58/58，`npm run verify:renderer` 成功。该切片为**实现完成·尚未验收**；没有正式 Electron 窗口联测，J30 取消期限、真实运行进展、恢复、诊断及字幕独立旅程仍待后续任务验证。

容量样本使用固定种子合成文本，不复制用户会话。模型替身只证明编排/覆盖，不能用预设答案宣称真实模型内容质量。实机五小时采集、真实模型质量/公网取消、窗口操作、正式包和适用I2/I3/I4分别留证；确定性时间偏移不构成五小时长稳。新增测试仅落既有core/integration/evidence目录，按§2.1选择验证范围。

2026-09-27 P0 本地验证：`npm run test:core` 为 986 项通过；`node --test test/ui/agent-ui.test.js` 为 37 项通过；`npm run verify:renderer`、J25 Electron/SQLite 旅程及 S5 SQLite 旅程通过。`npm run test:integration` 中 67 项有 64 项通过、3 项因本机 Electron GPU 子进程不可用而失败；相关 J25、S5、J29 旅程通过，因此完整 integration lane 仍未验收。未验证范围还包括 P1 运行控制/诊断、P2 长输入、真实模型质量、公网取消和实机运行。

2026-09-27 P1受理服务切片验证：`npm run test:focus -- test/storage/session-summary-request-store.test.js test/storage/agent-execution-protocol.test.js test/integration/session-summary-request-j30-accept-journey.test.js test/runtime/intent-route-orchestrator.test.js test/contracts/session-summary-run-ui-contract.test.js` 为 35/35；`npm run test:core` 为 1008 项通过，包含 renderer 类型检查与构建。J30旅程使用真实 SQLite、存储 worker、StorageGateway、AgentRunService、ModelAccessRuntime 和 IntentRouteOrchestrator，仅替代 Agent 模型 provider 外部边界。尚未验证 main/preload/renderer 接线、完整 integration lane、真实模型、公网取消或实机运行。

2026-09-28 J30-PROGRESS 进度子切片验证：`npm run test:focus -- test/integration/session-summary-j29-memory-journey.test.js test/integration/session-summary-request-j30-accept-journey.test.js test/storage/session-summary-request-store.test.js test/runtime/session-summary-run-progress.test.js test/runtime/formal-agent-run-runner.test.js test/runtime/controlled-tool-audit.test.js test/runtime/intent-route-orchestrator.test.js test/main/model-access-vault-runtime.test.js test/ui/agent-ui.test.js` 为 117/117；`npm run test:core` 为 1023/1023，含 renderer 类型检查与生产构建。SQLite、存储 worker、StorageGateway、AgentRunService、ModelAccessRuntime、IntentRouteOrchestrator、runner 与 AgentView 使用真实实现，只替代 provider 外部边界；J29 真实 SQLite 旅程确认无无条件上下文预读，记忆状态只随 `search_context` 结果更新；阶段、取消与终态进度写入不把计时样本记作模型活动；取消中快照固定在首次取消的耗时，重复取消不会移动冻结值，关联运行终态后重放也只收束请求状态。J30-PROGRESS 仍为实现完成·尚未验收；正式窗口旅程、退避阶段、P1全矩阵、真实模型和实机运行未验证，P2分块计数仍未实现且快照保持 null。

2026-09-28 J30-CANCEL 取消子切片验证：当前 revision 的 `npm run test:focus -- test/runtime/session-summary-run-progress.test.js test/runtime/formal-agent-run-runner.test.js test/storage/storage-worker-host.test.js test/storage/storage-worker-service.test.js test/storage/personal-context-store.test.js test/integration/session-summary-input-cancel-journey.test.js` 为 71/71；相关 J29/J30/S3/S5 集成 focus 为 6/6，最终旅程命令 `npm run test:focus -- test/integration/session-summary-input-cancel-journey.test.js` 为 1/1；`npm run test:core` 为 1033/1033（含 renderer 类型检查与生产构建）。本轮最终改动前曾运行 `npm run test:integration`，为 66/70，4 项未通过；Electron/Windows 相关失败输出包含 OS 凭据解密错误 0x8009000B、GPU shared-context 创建失败及 abnormal exit，该结果不是当前 revision 的完整集成 lane 验证。取消旅程运行真实 StorageGateway、StorageWorkerHost、worker 入口、StorageWorkerService 与 SQLite；测试仅模拟 utilityProcess 边界。260 段输入按 128 段 keyset 页读取，取消返回 `AGENT_CANCELLED`，排队的下一条存储请求在 5 秒内完成且 worker 保持就绪；随后完整读取仍返回 260 段并匹配冻结 digest。另有受控 provider/网络边界覆盖非合作请求与迟到结果。J30-CANCEL 仍为实现完成·尚未验收；main 持久取消状态与活动读取同链期限、取消落库失败 UI 全矩阵、真实模型/公网取消、正式窗口与实机范围未验证。P2 字节预算、超长段 code point 范围读取、分块与完整输入内存约束仍待实现。

### 2026-09-13 两项功能的新增旅程矩阵（规划登记）

| 旅程 | 用户路径与可观察结果 | 内部真实模块与失败边界 | 当前证据 |
|---|---|---|---|
| J28 | SEM-F37：正式提问→个人记忆候选→确认→相关会话→后台摄取/双侧关联→个人记忆综合视图→“我的记忆”查看来源→明确纠正/忘记/删除→重建。显式日期范围历史整理后续单独实施。 | 真实 recorder、个人上下文模块、scheduler、Agent Loop、storage worker/SQLite、settings renderer/preload/main；只替代 provider/网络等外部边界。覆盖重复事件/重启/旧 revision、冲突/到期未确认、覆盖省略、预算、休眠新边界、旧来源 suppression、删除后当前及上版失效、模型失败不恢复受撤销正文、无变更零模型调用、字幕独立性。 | 实现完成·尚未验收；2026-10-01的J28增量包含真实Loop/调度器/SQLite、renderer/preload/main旅程与失败边界。见[验证记录](validation/personal-memory-optimization-2026-10-01.md)；真实 provider 内容质量与 DWM 窗口行为仍需实机报告。 |
| J29 | SEM-F38：工具条或字幕历史 → 明确会话与可见打开反馈 → 全局总结参考设置（首次缺失默认开启）→ 生成总结 → 结果/历史/导出；明确选定内容记住另行写入。 | 真实 toolbar/history/agent/settings renderer、preload、main 窗口、ConfigStore、AgentRunService、Personal Context、Loop、SQLite；只替代 provider/系统故障边界。覆盖窗口首开/重复点击/关闭重开/加载失败、监听中/空正文/缺模型、四种开关/重启/旧 revision、无记忆 payload 负证据、读取失败明确降级、summary.minutes 自动信号零写入、撤销与迟到输出、取消/重试、旧导出不变和失败后字幕新会话。 | 已决定；实现完成·尚未验收。新增 `session-summary-j29-memory-journey.test.js` 定向覆盖四种设置组合、真实 SQLite 冻结策略、provider 边界标记、引用计数与重启持久化；完整窗口/实机门禁仍待联合验收。2026-09-29 窗口内直接总结容量增量已决定（语义合同 2026-09-29 小节），对应生成场景待实施。 |

实现顺序与逐片验证见[任务清单](../openspec/changes/clarify-memory-and-session-summary/tasks.md)，需求见[共同提案](../openspec/changes/clarify-memory-and-session-summary/proposal.md)。纯文档只核对术语/语义/链接；实现用既有 core/integration/evidence 目录，不新增测试 lane。真实公网、Windows 窗口焦点与内容质量另留实机证据；不因 OpenSpec 文件齐备晋级门禁。

2026-09-27 SEM-F38/J29 回归登记（已决定）：使用“生成总结”按钮实际提示词覆盖总结与待办关键词冲突；renderer 点击请求校验真实规则分类，既有 J29 旅程接入真实意图路由器，使用与主进程相同的执行宿主入口导出，验证模型路由及路由输出失败后的规则兜底均生成 `summary.minutes` 终态结果、保持记忆政策与历史投影。单独信息提取与非会话范围继续由既有路由测试守护。真实公网与运行中应用重启后验证另验。

本增量状态：实现完成·尚未验收。红测先确认按钮原文被拒绝，接入执行宿主入口后再确认缺少导出导致模型路由退回规则；修复后以下命令返回 0：

- `npm run test:focus -- test/runtime/intent-router.test.js test/integration/session-summary-j29-memory-journey.test.js test/integration/agent-redesign-s3-route-journey.test.js test/ui/agent-ui.test.js`：33/33。
- `npm run test:focus -- test/runtime/intent-route-orchestrator.test.js test/runtime/formal-agent-run-runner.test.js test/runtime/formal-agent-job-scheduler.test.js test/main/agent-run-service.test.js`：42/42。
- `npm run typecheck:renderer`：返回码 0。未执行完整三条 lane、真实公网 provider 或运行中应用的实机验证，不提升完整 J29 验收状态。

### 2026-09-20 I2/I3 无人值守资格子边界

无人值守入口按 `环境预检 → 确定性非音频检查 → loopback I3 75 秒资格 → loopback I2 五轮序列` 串行运行，任一阶段只产生 `pass/blocked/failed/skipped`，失败后跳过依赖阶段并继续独立检查，不弹出补救交互、不自动下载资源或选择性重跑。I2/I3 音频 runner 必须从同一显式模型根取得临时字幕识别器、权威识别器、VAD 与精修模型资源并使用真实 `RealtimeRuntimeAdapter`；新 evidence 版本记录四项模型就绪哈希及临时字幕识别器的有界故障事实，strict verifier 继续读取历史版本，但无人值守入口只接受新版本。validation lane 覆盖缺模型、身份/哈希篡改、临时字幕识别器启动或运行故障、子进程非零退出、超时、报告缺失、重复输出、依赖跳过与 SEM-F14 隐私负扫描；真实运行仍只能提供资格证据，不替代 `mic`、设备/睡眠恢复、真人窗口矩阵、两小时 I3 或 I4。

> **2026-09-13 SEM-F23/J18 输入控件子边界（实现完成·尚未验收）**：正式 J25 设置旅程新增输入计算样式、首配向导、Tab 焦点、hover 几何、pending 与已配置凭据的非法连接失败恢复、专用颜色/滑块操作、主题及布局压力检查；真实首启选择解除遮罩后再操作表单。renderer 构建返回码 0，样式守卫与该旅程 focus 10/10，追加专用控件检查后正式旅程 1/1。高对比/reduced motion 为媒体模拟，1–2 倍为 renderer zoom，均不替代系统 DPI/人工观察或完整 J18/J25。早期发现的无凭据档案失败回执缺口已由 [`fix-model-config-failure-receipts`](../openspec/changes/fix-model-config-failure-receipts/) 修复并由正式 J25 旅程验证；其历史观察及其余未验证范围见 [输入框 change](../openspec/changes/fix-settings-input-styles/tasks.md)。

> **2026-09-16 SEM-F23/J18/J25 下拉选择列表增量（实现完成·尚未验收）**：`src/ui/shared/select.css` 是纳入 SEM-F23 的正式 renderer 与开发预览的唯一选择控件 owner，所有 HTML 入口在页面样式前加载它；样式守卫按 `src/**` 的 HTML/CSS/renderer 源码扫描，不按固定窗口名单。J25 真实设置旅程只把模型用途选择作为 J25 语义场景；个人记忆类型/范围只作为 J21/J22/J24 的视觉子场景。Agent 结果入口在对应生产 renderer 场景覆盖两个记忆选择框。展开、hover、滚动、选择后取消必须保持原值且零 change/IPC/交互记忆信号，明确点击“记住”才允许写入。真实 Electron 43.3.0 的生产设置窗旅程已实际打开 picker、发送方向键并以 Esc 取消，观察到 `opened=true`、原值保持且 `changeCount=0`；静态 guard 还覆盖四种主题/forced-colors/reduced-motion、长值、禁用/pending 和底部布局约束。只读取收起控件的 computed style 不构成 picker 证据；Windows 系统高对比、系统缩放和人工视觉观察仍未取得。若 Electron picker 能力不足，报告阻塞，不以自定义控件替换原生语义。

新增或保留测试必须能指出它独立阻止的用户风险、`SEM-*` 要求和 `J* / DB* / I*` 旅程位置。若一个低层测试与更高层真实内部模块旅程验证相同输入、相同失败和相同可观察结果，且不能更早定位一个独立不变量，应合并或删除，不以测试数量、行覆盖率或固定实现形状作为保留理由。

- core 只保留适合局部穷举的纯合同、不变量、canonicalization、状态转换和稳定错误映射；不得用源码正则、文档关键词、内部私有调用次序或大 snapshot 伪装产品行为。
- integration 优先用一条表驱动用户旅程覆盖同一边界的正常、缺失、重放和失败组合；不得为了每个枚举值重复搭建整套内部模块，也不得直接调用最终 writer 跳过产品路径。
- evidence 只验证报告、打包、来源绑定和分层结构；“文档中存在某字符串”不属于运行证据。语义追踪由 TODO、旅程矩阵和代码审阅维护；日常小改动不强制额外模型或子 Agent 审阅；每个大的改动在 commit 前必须由指定的 Luna subagent 复核语义不漂移和功能达标。
- Agent 重设计的阶段 A 只分配 S1–S6 测试责任，不允许一次铺开多条长期红测。每个已确认 seam 按一个 tracer bullet 的 red → green 闭合，相关定向回归返回 0 后进入下一条；完整 lane 留到下述扩大验证边界。
- 删除重复测试前记录仍覆盖该风险的旅程或严格 verifier；删除后运行这些保留测试和分层守卫。全量回归在 PR/合并、阶段联合验收执行，不要求每删一条测试就重跑三条 lane。

### 2.1 开发反馈与全量门禁（2026-09-08，SEM-T03/J9-CI）

| 改动边界 | 本地最小验证 | 扩大验证条件 |
|---|---|---|
| 纯文档、进度投影 | 对照语义合同、术语与相对链接；不启动 renderer、Electron 或全量测试 | 若同时修改测试脚本/CI，执行下面的 CI 行 |
| 文案、颜色、图标 | `npm run test:focus -- test/ui/renderer-style-guard.test.js`；涉及 TS/TSX 加类型检查 | 影响交互或布局时补对应 J15/J17/J18 旅程 |
| 单模块小功能或修复 | 指定受影响测试文件；用户能力增加一条既有真实跨模块旅程中的正常/失败场景 | 修改公共 contract、main/preload、共享存储或跨模块生命周期时，扩大到相关 lane |
| 测试脚本、CI、去重 | runner 的正常/失败/空选择测试、lane 守卫及保留的严格报告 verifier/相关旅程 | PR 保留完整三条 lane 和 Windows 资格链 |
| PR、合并或阶段联合验收 | 一次完整 `npm test`，可由当前 revision 的 CI 承担，本地不重复同一输入的成功运行 | 发布继续满足 B5、I2/I3/I4 等适用门禁 |

`test:focus` 只接受既有三个 lane 内明确存在的 `.test.js` 文件，重复文件去重；空参数、未知文件、目录、越界路径必须报错，不能悄悄运行全仓或返回成功。它不自动推导依赖、不做构建：选择测试时说明影响范围；需要生产 renderer 的旅程先执行 `npm run verify:renderer`。旧 Agent 隔离入口已经退役，不再有对应构建命令。不确定影响范围时扩大到相关 lane。

单独 `test:core/integration/evidence` 保持原有构建前置；`npm test` 统一准备 renderer 与隔离入口一次，再逐 lane 各运行一次。CI 在同一 checkout 内前置准备一次，使用已准备的测试与打包入口，不缓存跨 revision 的构建结果。`test:ci` 为 CI 专用入口，依赖此前准备成功。任一 lane 非零即停止，不把未执行 lane 记作成功。

CI 在 PR、`main` push、tag push 和手动触发时保留完整资格链；功能分支 push 不另跑一份与 PR 重复的全量任务。保持既有 job 名、取消过期运行、无 workflow 级 paths-ignore，避免 required check 长期 pending。此调整改变开发反馈频率，不降低 SEM-T01/T02 的用户旅程验收口径。

去重登记：移除 `acceptance-navigation.test.js` 的六条文档关键词/历史计数断言（文案投影改由审阅负责），以及 DB1/Gateway evidence 各一条读取 smoke 源码的正则测试。保留 `ci-qualification-index-contract.test.js` 的严格绑定/篡改拒绝、I2/I3/I4 verifier、`b4-model-product-evidence.test.js`、DB1/Gateway 的严格报告验证及 `refinement-fallback-journey.test.js`、`product-sqlite-lifecycle-journey.test.js` 的真实行为证据；CI 仍实际执行 DB1/Gateway smoke。删除不会替代或晋级任何 J/DB/I 旅程。

外部依据与取舍见 [测试反馈与 CI 实践](research/test-feedback-and-ci-practices.md)。

2026-09-08 本地定向记录：runner/分层守卫 7/7，保留的 DB1/Gateway、CI provenance、布局/B5/B4、I2/I3/I4 严格 verifier 与精修/SQLite 产品旅程 87/87，均返回 0；`npm run pretest` 的类型检查、生产 renderer 和隔离入口构建返回 0。本次未重跑完整三条 lane、Electron/NSIS 资格或远端 CI，状态为实现完成·尚未验收；不把这些定向结果投影为新的 J9-CI 资格。调用关系上本地全量 renderer 检查/构建从三次减为一次，CI 从六次减为一次；未测量远端墙钟收益。

### 2.2 执行分层表

| 层级 | 入口 | 环境 | 负责证明 |
|---|---|---|---|
| core 回归 | `npm run test:core` | 本机 / Windows hosted runner | contracts、main、runtime、storage、UI 的 validator、状态机、reducer、队列等局部不变量 |
| 确定性联合测试 | `npm run test:integration` | PR、main/tag push 与手动触发的 Windows CI | 多个真实产品模块围绕同一用户旅程协作，且不依赖声卡、网络或本机模型 |
| evidence 回归 | `npm run test:evidence` | 本机 / Windows hosted runner | Gate、严格报告 verifier、tracked evidence 与打包/测试分层结构契约；含约 7 秒的 I3 非音频预资格复跑 |
| Electron 产品壳联合旅程 | `scripts/product-shell-smoke.js` + verifiers | PR、main/tag push 与手动触发的 Windows CI | 首进程完成四 renderer、ModelManager、旧 JSONL→SQLite、205 段分页与三格式完整导出；packaged runner 再以同一 `userData`、fetch=0 第二进程验证 ready/历史/迁移幂等及新会话。fake-ASR 与受控小资源替代音频、真实张量和公网；两轮另记 exact-child exit evidence |
| 字幕布局资格 | `scripts/caption-layout-smoke.js` + `verify-caption-layout-report.js` | PR、main/tag push 与手动触发的 Windows CI 首个质量步骤，排在全部重步骤之前（由 `test/validation/caption-layout-evidence.test.js` 强制该顺序） | 最小 Electron 宿主只启字幕窗与真实 preload，注入超长 `partial`，在 24/30/38px × 中文/英文/中英混排/超长单词下验证四条布局不变量：无横向溢出、最新视觉行始终在视口内、最旧完整视觉行退出、顶部不出现半行。它不启动主进程组合根、模型与存储，因此不证明 config 广播接线（由产品壳旅程两条最小断言兜底）、真实 ASR，也不替代 DPI/主题/透明窗的人工视觉验收 |
| J17 窗口交互确定性联合旅程 | `npm run test:integration` + Electron 产品壳交互扩展 | PR、main/tag push 与手动触发的 Windows CI | 在操作系统指针/DWM 之外使用受控边界，但保留真实 main、四个 renderer、preload、IPC access policy 与 BrowserWindow：验证工具条真实轮廓上报和首帧/重载/非法或陈旧矩形回落、工具条进入/离开共用量化后的真实轮廓且轮廓外没有 6 DIP 隐形命中、工具条轮廓与拉伸带安全间隔、工具条附近真实拉伸带反复点击及相关轴 `1–3 DIP` 抖动不启动拉伸、达到 `4 DIP` 后仍可有意拉伸、主进程从字幕窗/工具条任一当前 `webContents` 收到主键结束输入都可终止活动 timer、旧手势结算的异步同代重命中到达下一次新手势期间不会静默取消新手势或遗留主进程 timer、工具条以 `useContentSize: true` 创建且所有移动帧显式保持 exact `600 × 72 DIP` 且创建参数不使用会放大 frameless 外框的 exact 最小/最大尺寸、程序化纠正同步读回目标值后再被旧原生提交覆盖时仍由 `250ms` 再确认恢复且新合法结算会取消旧目标、单目标四次/`1000ms` 仍不收敛时锁存目标、停止写入并固定降级，尾随原生双事件不得重启同目标、几何变化后的同代当前指针重命中、字幕卡逐像素命中、工具条轮廓接管后再判定拉伸、两列三行六点握把及既有 `24 × 30 DIP` 命中盒、握把主键按下立即开始且原地松开 bounds 不变、图标替换前后实际轮廓不变、设置与字幕历史焦点层级往返、共享 `48px` 标题栏结构，以及应用最小化时缺失 `pointerup/pointercancel/blur` 后的手势重置、当前窗口交互代次校验、renderer 命中结果、主进程原生穿透调用意图和恢复后新的拖动意图。该层不证明 Windows 实际应用原生穿透，也不冒充真人鼠标连续性、真实任务栏点击、真实 DWM z-order、系统 DPI 或异缩放双屏。 |
| J18 Fluent 2 桌面界面确定性联合旅程 | `npm run test:integration` + Electron 产品壳 UI 扩展 | PR、main/tag push 与手动触发的 Windows CI | 从 Vite 生产 bundle 加载四个真实 renderer，并保留真实 preload、IPC access policy、RuntimeSnapshot/CommandResult、字幕历史服务和 BrowserWindow；验证深色/浅色/自动主题下工具条固定表面、按钮、握把与 phase 色调计算值不变，`barColor` 只改变字幕背景，`toolbarOpacity` 只改变工具条表面，并覆盖系统高对比、键盘焦点、reduced motion、设置即时预览与失败回落、字幕历史版本/分页/导出、字幕高频局部更新、renderer reload，以及开发入口不能进入打包态。外部边界不冒充真实 DWM 材质、系统 DPI、异缩放或人工可读性；这些继续由 J15a/I2 实机观察。同一条旅程另有一个跑在 `npm run test:core` 的 renderer 样式守卫子边界，按目录扫描而不按窗口点名，详见 §3 同名小节。 |
| J19 Windows 任务栏与应用生命周期确定性联合旅程 | `npm run test:integration` + Electron 产品壳生命周期扩展 + exact-child supervisor | PR、main/tag push 与手动触发的 Windows CI | 保留真实 main、四个 renderer/preload、IPC access policy、BrowserWindow、SQLite utility 与退出屏障：验证工具条是持续主任务栏窗口，应用级最小化先结算活动手势再取样并隐藏字幕、最小化当时可见的辅助窗口，任务栏恢复在有界原生 bounds 结算内纠正晚到 `move` / `resize`，最后一次原生事件或实际纠正后安静 250ms、连续抖动最迟 1000ms 发起最终纠正；最终写入后再以不可延长的最多 250ms 只读确认原生提交，且只在稳定结算后发送 `resume`、保持会话/状态/bounds、活动手势被取消、窗口交互代次推进、renderer 在 `resume` 回调内按当前指针立即执行命中判定且不等待 rAF、同代确认或固定降级、过期意图不生效、恢复后产生新的拖动意图、关闭辅助窗口不退出、第二实例走同一恢复序列，以及工具条/主任务栏关闭后 exact child 自然退出且下一轮可重新启动。该层只证明受控 main/renderer/IPC 链路，不证明 Windows 实际应用原生穿透或真实鼠标拖动，也不冒充真人任务栏操作、图标渲染、DWM、系统 DPI 或安装器分组。 |
| J15a 非音频可见 DWM 观察 | `scripts/caption-visual-review.js` + observation/matrix strict verifiers | 交互式 Win11 实机；不启动采集/模型/网络 | 使用真实透明、可见字幕 BrowserWindow 和合成 CaptionEvent。单次 observation 必须记录实际系统 scale factor，不接受 browser zoom；完整 matrix 绑定同一源码与 `package-lock.json` digest，覆盖 100/125/150/200% × 深/浅/系统高对比 × 白底/深色/复杂背景 36 例，并至少一次异缩放双屏移动。每例由操作者明确确认可读、透明无黑底、最新行完整、顶部无半行、无横向移动/滚动条、bounds 不变；JSON 只写枚举、布尔、计数与哈希。单次 observation 固定为 `pass/partial`；最终 matrix verifier 必须重新读取全部 36 份 observation、逐份严格校验并核对文件 SHA 与组合摘要，不能只信任 matrix 内的汇总声明。只有完整且与原始 observation 闭合的 matrix 可标记该视觉子门禁实机验收完成 |
| 打包态确定性资格 | `package:smoke` / `package:release` + package/product/restart/exit/binding/NSIS verifiers | PR、main/tag push 与手动触发的 Windows CI | 正式 ASAR/NSIS allowlist、fuses、x64、native unpack；测试 package 双启动；同轮 run ID、四份报告 SHA 与 ASAR 实际运行时 `src/` 产品载荷 SHA 闭合，构建期 `.d.ts` 不计入本地或打包态身份；精确候选静默安装/卸载及无关 APPDATA 哨兵保留。只取得 B5 机械预资格，不证明正式应用 userData 或替代 I4 |
| I4 非音频发布子门禁 | `scripts/qualify-i4-nonaudio-nsis.ps1` + `verify-i4-nonaudio-nsis-report.js` | 无仓库/Node/旧数据的专用 Win11 标准用户快照 | 精确 NSIS 的交互安装、正式 release main、公网生产 bundle、断网复启、真实保存对话框、动态发现的正式 userData、卸载保留及离线重装；全程不发 capture。报告上限固定 `pass/partial`，当前入口为实现完成·尚未验收且尚无专用机报告 |
| CI 总门禁 | `npm test` / `npm run test:ci` + `scripts/write-ci-qualification-index.js` / strict verifier | `.github/workflows/ci.yml` | 锁文件安装后先显式安装 Electron runtime，并在全部 Electron、打包和回归步骤之前校验 `electron.exe` 与锁定版本；随后依次运行 core/integration/evidence，`test:ci` 与 `npm test` 共用逐 lane runner，复用同一 checkout 已准备的 bundle，不重复构建或 integration。全部资格步骤成功后生成最终 provenance 索引，绑定实际 checkout/触发 revision、run ID/attempt、workflow/job、lockfile/workflow 与 installer/布局/B5/NSIS 报告 SHA；索引只有从对应 GitHub run 下载时才带远端来源语境 |
| 模型/音频实机 smoke | `scripts/model-install-live-smoke.js`、`scripts/i2-live-caption-smoke.js`、`scripts/run-i2-live-series.ps1` + I2 child/exit/series 严格校验 | 有批准模型或可播放/采集音频的 Windows 机器 | 真实模型安装/调用；loopback/mic 分路 ASR、VAD、refine、匿名标签哈希、资源/传输指标和每来源固定 5 轮 P50/P95/min/max；每个 schema-v5 report 必须绑定外部 runner 观察到 exact child 自然 exit 0 的 schema-v1 sidecar，再进入 schema-v6 series；自动 mic fixture 先由 memory-only Gate 0C 预检并标记为 `physical-preferred-label-heuristic`，不作硬件证明 |
| I2 交互实机 smoke | `scripts/run-i2-interaction.ps1` + versioned strict verifier | 有真实设备控制权、可睡眠交互桌面与批准模型的 Windows 机器 | `dwm-drag` schema-v6 在兼容历史 schema-v3/schema-v4/schema-v5 的前提下，要求当前候选绑定的 100/125/150/200% × 深/浅/高对比 12 组合全部使用真实可见应用窗口，并逐组合确认既有字幕卡连续抓取、真实工具条轮廓排除、透明边距穿透、轮廓外拉伸带、未锁定握把不可见且原位置操作不改变 bounds/停靠、锁定握把、普通窗口焦点层级，以及新增的真实任务栏最小化/恢复、指针停在恢复后字幕卡位置且不移动时正确接收下一次按下、恢复后首次连续拖动和锁定字幕窗恢复后继续穿透，并新增：工具条上边轮廓、右边轮廓、上边相邻普通拖动区、右边相邻普通拖动区四个区域各至少 20 轮（总计至少 80 次）含非零轻微抖动的反复按下松开不触发拉伸，任一字幕拉伸、组合拖动、锁定工具条单独移动或重新停靠后当前指针在新几何下重新命中，以及最小化→恢复后第一次在工具条附近拖动不改变字幕窗宽高且不产生停靠漂移。v4 completion 新增 exact observation ID `application-taskbar-restore`、`caption-stationary-restore-hit`、`caption-post-restore-drag`、`locked-caption-post-restore-through`；strict checks 新增 exact `lifecycle` 对象 `{ taskbarRestoreObserved, stationaryPointerHitObserved, postRestoreCaptionDragObserved, lockedCaptionPassedThroughAfterRestore }`，四项必须为 `true`。v5 completion 在 v4 基础上新增 exact observation ID `toolbar-edge-repeat-stability`、`post-geometry-pointer-rehit`、`post-restore-toolbar-near-drag-stability`，以及 exact `stability` 对象 `{ toolbarEdgeRepeatStableObserved, postGeometryPointerRehitObserved, postRestoreToolbarNearDragStableObserved }`，三项必须为 `true`。v6 completion 把旧 `grip-unlocked` 替换为 `grip-unlocked-hidden`，并把 grip strict checks 改为 `{ unlockedGripHidden, unlockedGripDidNotStartDrag, lockedOnlyGripStartedDrag, lockedGripMovedToolbarOnly, lockedCaptionPassedThrough, lockedCaptionResizeDisabled }`。操作者 helper 必须为每个 exact observation ID 显示与之绑定的可读动作清单，尤其明确四区各 20 轮、总计至少 80 次的非零抖动与宽高/停靠不漂移、字幕拉伸/组合拖动/锁定工具条单独移动/重新停靠四类几何结算，以及恢复后静止指针第一次在工具条附近拖动；只显示 opaque ID 不足以形成 completion。当前候选 matrix 只接受 12 份 schema-v6 observation，逐份重读并校验报告 SHA、组合、源码/产品载荷绑定与闭合 observation ID；历史 schema-v3/schema-v4/schema-v5 只允许按自身产品载荷绑定读取，不得被当前候选载荷哈希误拒，也不得形成当前候选 v6 结论。completion 仍只证明操作者执行动作，不能绕过原始报告、strict checks 或 matrix 闭合。报告只保留布尔、计数、枚举与哈希，并负扫描字幕正文、本地绝对路径、设备名、指针坐标和绝对单调时刻。既有恢复场景继续覆盖 `device-removal-retry` / `sleep-wake-retry`：真实状态证明稳定故障码、capture 释放、无自动重采集、用户明确 Retry、同一会话恢复字幕以及 SQLite/sequence/transport 边界。 |
| I4 音频发布子门禁 | `qualify-i4-audio-child.ps1` + 两个 child strict verifier + strict summary | 与 I4 非音频报告相同的专用干净 Win11 标准用户快照 | `loopback` 与 `mic` 禁止并发，两个 child 均绑定同一 B5 installer、release layout 与 I4 非音频报告摘要；分别覆盖权限拒绝/批准、开始、暂停/恢复、停止、历史、导出、离线复启与隐私负扫描；strict summary 只有在非音频报告和两个 child 全部满足要求时才能形成完整 I4 结论。入口与无仓库/Node 移交包为实现完成·尚未验收，尚无专用机报告 |
| 原生退出诊断 | `scripts/native-model-activity-lifecycle-smoke.js`、`scripts/run-supervised-electron.js` | 有批准模型的 Windows 机器 / 产品壳 CI | 真实 online/refine 活跃工作后的 graceful/exact-child 退出，以及 main/renderer/audio-host/realtime/refine/storage/Chromium 角色级退出分类；只属 diagnostic/partial，不替代 I2/I3/I4 |
| soak / 发布验收 | `scripts/i3-nonaudio-soak.js` + 后续音频 I2/I3/I4 runner | CI 预资格 + 自托管 Windows 机器 | 先确定性验证 3,600 段资源/恢复/历史上界；再以两种真实单路模式验证拖动、设备变化、两小时墙钟、打包版和资源占用 |

> **J17/J19 本轮增量（2026-08-10）**：确定性层必须把 caption→toolbar、toolbar→caption 两个方向的跨原生窗口主键结束都走过真实主进程交互域，结束后不得人工补发发起 renderer 的 `pointercancel`，而要直接验证下一次 caption 卡片拖动、工具条握把拖动及按钮点击均首次生效且主进程 timer 为零；另覆盖未达到 `4 DIP` 的待定拉伸跨窗结束，以及 `setPointerCapture` 无抛错但 `hasPointerCapture` 返回 `false` 时本地状态和主进程 timer 均立即收敛、下一次同 ID 手势首次生效。跨窗代次重置故障注入须进入既有 caption 穿透、toolbar 实心降级，不得产生未登记同步 code。工具条轮廓由 quiet 扩张到 attention/通知并覆盖静止指针时，`ResizeObserver` 本地同步重命中必须先于延后的布局报告，接受报告随后触发 caption/toolbar 同代权威重命中；断言 toolbar 不依赖下一次 `mousemove` 即确认实心。首帧/reload/非法或陈旧报告的 `588 × 64 DIP` 回落必须用四边包含断言覆盖 window-local `16..584 DIP` 最大真实轮廓。产品壳恢复旅程要在 `resume` 前对真实辅助 BrowserWindow 注入一次晚到 `move`/`resize`，确认漂移注入发生在 `suspend`、真实 `move` 与 `resize` 各到达至少一次，且保存的四项 bounds 稳定后才出现该代次 `resume`；确定性时钟另覆盖最后一次原生事件或实际纠正后安静 `250ms`、连续事件最迟 `1000ms` 发起最终纠正、最终写入后最多 `250ms` 固定确认期、确认终点只读校验、纠正自身重开安静期、旧 timer/token 失效和失败只降级一次。工具条非用户 `resize` 另须验证内容视口立即恢复 `600 × 72 DIP`，系统指针与锁定握把起点须按 content 原点换算，并证明外框出现 `1 DIP` 缩放归一而内容视口 exact 时不会形成纠正写入风暴或新基线；未锁定时保持当前停靠关系，已锁定时把同时漂移的 `x/y/width/height` 恢复到最近一次合法结算，而不是采用 resize 后坐标，且最小化快照不得保存原生尺寸漂移；每次实际成功纠正须只触发一次工具条同代当前指针重命中，未变化为零次，回调失败不得把几何纠正误报为失败。同一目标且观测几何未变的尾随 `move+resize` 在故障前不得额外消耗写入额度，四次写入后这些尾事件仍必须保持四写/一次故障/零 timer；显式合法提交、真实目标变化或故障后不同的原生观测几何才可开启下一轮，并须再次受四写/`1000ms` 上限约束；最小化取样与切锁必须使用旧锁定状态的预期停靠位置而非瞬时 native read-back，并覆盖“活动未锁定组合拖动 → 瞬时工具条漂移 → 切锁”仍保留旧状态合法停靠位置。固定视口纠正故障只允许 `{ role: 'toolbar', code: 'toolbar-dock-correction-failed' }`，不得包含原始错误或几何。

> **J17 工具条握把可见性增量（2026-08-10）**：确定性层必须证明未锁定时握把不占布局、不进入工具条实际轮廓且不能在 renderer 或主进程开始工具条拖动；字幕窗与工具条组合仍可从字幕卡普通拖动区移动。锁定后握把才进入既有 `24 × 30 DIP` 命中盒并只移动工具条。锁定切换必须结束旧手势、刷新动态轮廓并按静止指针重命中；未锁定握把位置的操作不得产生 `resizeStart`、字幕窗宽高变化或停靠漂移。I2 `dwm-drag` 后续实机观察补充未锁定握把不可见与反复操作 bounds 稳定、锁定握把可移动工具条。该增量为实现完成·尚未验收：确定性 UI、主进程与联合旅程及 schema-v8 产品壳协议已覆盖；I2 `dwm-drag` schema-v6 实机报告尚未取得。

> **J19 辅助窗口缩放归一增量（2026-08-10）**：产品壳对真实辅助 BrowserWindow 注入的 `x/y/width/height` 漂移必须明显大于 `1 DIP`；结算后设置/字幕历史每项与保存值相差不超过 `1 DIP` 才可视为物理像素归一等价并允许 `resume`。确定性时钟必须证明该等价不再次 `setBounds`、不重置 quiet，下一次最小化从实际归一值取样且至少 20 轮恢复不累计。字幕窗外框、工具条内容视口、固定内容视口和停靠关系继续逐项 exact；工具条透明无框外框的 `1 DIP` 缩放归一只有在内容视口 exact 时可忽略，且不得保存；`1000ms` 上限后的最终纠正若写入 bounds，必须在固定且不可延长的最多 `250ms` 原生提交确认期终点只读复核；仍不等价时只触发一次 `post-restore-bounds-failed` 降级、清理全部 timer/监听并保持零 `resume`。

> **J19 最终确认竞态增量（2026-08-10）**：确定性时钟还必须在最终纠正后的固定确认期第 `249ms` 注入新的不等价几何及 `move` / `resize`，逐项断言整个确认期的写入计数不再增加、固定终点零 `resume`、只记录一次 `post-restore-bounds-failed` 并清理监听；不得用确认期内最后一次同步纠正后的短暂 exact 读回冒充原生提交完成。该组合测试必须接入真实工具条固定停靠纠正器，证明其独立监听器在确认期也被冻结，而不是只统计生命周期控制器自身的写入；随后必须从同一降级状态执行下一次 `restoreOrShow`，分别覆盖工具条与字幕窗/辅助窗失败观测，证明重试复用失败前保存的窗口集合和合法 bounds 而不是重新采样失败坐标，重新结算完成前零 `resume`，成功时只显式提交已经验证的工具条预期并重新启用有界纠正。另须分别在活动结算中和降级后关闭原本可见的设置/字幕历史，证明已销毁辅助窗从恢复集合移除且主交互仍可恢复；caption/toolbar 缺失不得套用该例外。

> **J17 隐藏窗口轮廓观察增量（2026-08-10）**：动态工具条轮廓必须分别证明 ResizeObserver 与 DOM MutationObserver 任一路径在无后续 `mousemove`、无 rAF 的情况下先完成 renderer 本地重命中；隐藏 Electron 窗口中 ResizeObserver 被延迟时，DOM 驱动扩张仍必须由 MutationObserver 让静止指针下的新轮廓实心，然后才允许延后布局报告和主进程双 renderer 重命中。另须覆盖 `inside → mouseleave → DOM/resize 轮廓变化`，证明离窗前旧坐标不会把已穿透 HWND 再次变实心。

J15a 可见 DWM 观察必须由操作者在已经切换到目标系统缩放、主题和真实桌面背景后运行。单例入口如下；runner 会打开真实透明字幕窗并等待第二个终端写入明确观察确认，全程只注入合成 `CaptionEvent`：

```powershell
npx electron scripts/caption-visual-review.js --work-dir .artifacts/j15a-visible/100-dark-white-document --report .artifacts/j15a-visible/100-dark-white-document/100-dark-white-document.observation.json --completion .artifacts/j15a-visible/100-dark-white-document/100-dark-white-document.completion.json --scale-percent 100 --theme dark --background white-document --timeout-seconds 900
```

runner 会在终端打印与本例精确匹配的相对路径 completion 命令。36 个唯一组合全部完成、且至少一例在启动时加入 `--cross-scale-move` 并实际跨过异缩放双屏后，才允许汇总并校验视觉子门禁：

```powershell
node scripts/summarize-caption-visual-review-matrix.js --observations .artifacts/j15a-visible --report .artifacts/j15a-visible/j15a.matrix.json
node scripts/verify-caption-visual-review-matrix.js --observations .artifacts/j15a-visible --report .artifacts/j15a-visible/j15a.matrix.json
```

不得预先创建 completion、复用已有 case 目录、用浏览器 zoom 模拟 DPI，或由自动化替操作者确认视觉结果。单例 `pass/partial` 不能代替完整 matrix，也不能代替 I4 或音频门禁。

Hosted CI 不声称验证真实 WASAPI/回环、物理麦克风、DWM 窗口行为、模型性能、交互安装/权限、SmartScreen 或干净机。此类证据必须由实机 lane 生成结构化报告；没有报告就是未验收，而不是跳过后视为通过。

> 2026-08-01 的 [ADR 0004](adr/0004-immutable-first-pass-and-optional-refinement.md) 重新定义了首次 `final`、可选精修与模型资源边界；旧候选中的 `final→refined` 覆盖、三资源原子 bundle 和单投影结论不再适用。2026-08-02，J15a/J15b/J15c 已完成对 J1/J2/J10/J14 的重新对齐并达到联合验收完成；DPI/主题/透明窗人工视觉、真实模型调用、延期音频门禁与 I4 专用干净机仍分别按实机门禁验收。

## 3. 用户旅程矩阵

| 本轮子边界 | 场景与证据 | 状态 |
|---|---|---|
| J17 工具条 reload 恢复诊断（2026-09-21，SEM-F22/F14/T03） | 保留真实 main、renderer、preload、IPC 和 BrowserWindow，覆盖 default、legacy-risk、current-risk 四窗配置。原 5 秒恢复等待结束后冻结诊断，最多额外等待 1 秒只读 renderer 快照；独立 `toolbar-reload-diagnostic.json` 不修改既有资格报告 schema。分别呈现初始化/上下文/rAF/补报/发送、main 到达/发送者校验/布局校验以及工具条布局代次是否匹配；覆盖证据缺失、128 条有界缓冲溢出、未知/敏感字段拒绝及诊断失败不掩盖旅程失败。定向分类测试不代替真实旅程。2026-09-25 当前候选 SHA `e4e0f26678910d75983bee8a3000b988ff24b30d8e2e0f4be70785a5da5214ac` 下，三种配置均通过真实 reload 旅程，`current-risk` 重复 3 次；每份诊断与产品载荷绑定且退出正常。旧候选的前置轮廓失败未在本轮复现，原远端 CI 超时根因仍未知。证据只适用于该候选和本地确定性环境，不提升 J17 实机 DWM/I2 状态。 | 实现完成·尚未验收 |

> **J17 解锁字幕卡逐像素命中增量（2026-08-10）**：确定性层必须覆盖 Electron 未向不可聚焦、已穿透字幕 renderer 转发进入移动的故障边界：没有 renderer `mouseThrough(false)` 意图时，主进程仍按当前窗口交互代次、字幕 bounds、`20 DIP` 透明外边距与工具条有效 overlap rect 把可见字幕卡预先变为原生实心命中，使后续字幕拖动意图可以移动字幕窗与停靠工具条；透明外边距、工具条轮廓、锁定态、活动手势、`suspend`、renderer reload、同步失败与过期代次必须继续 fail closed。局部矩阵还要证明 bounds、overlap、锁定状态或窗口交互代次改变会使缓存失效，同一命中状态不会重复写原生 API，停止控制器后不遗留 timer。确定性层只证明主进程命中计算、窗口交互代次约束、原生 API 调用意图和真实内部模块协作；不可聚焦透明 HWND 的真实主键、DWM、DPI 与异缩放仍由 I2 `dwm-drag` schema-v6 观察。该增量为实现完成·尚未验收：core 局部矩阵、SEM-T04 负向边界、J17 联合旅程与 I2 runner 接线契约已覆盖；尚无绑定当前候选的 I2 `dwm-drag` schema-v6 实机报告。

> **J17 全窗纯位移增量（2026-08-10）**：确定性联合旅程必须对字幕窗、工具条、设置窗与字幕历史分别模拟 Electron position-only 原生写入夹带陈旧 `width/height` 的边界；共享主进程拖动器每帧必须显式提交手势起点冻结的完整尺寸，普通拖动只改变 `x/y`，字幕窗与停靠工具条组合拖动也不得累计尺寸或停靠漂移。测试替身不得把 `setPosition()` 默认建模为必然保尺寸而掩盖 Win32 normal placement/DPI 回写；真实 DWM、系统缩放与异缩放双屏仍由 I2 `dwm-drag` schema-v6 观察。该增量为实现完成·尚未验收：J17 四角色联合旅程已注入 position-only 尺寸回写并证明普通拖动只改变 `x/y`、组合停靠不扩大；当前候选尚无 I2 `dwm-drag` schema-v6 实机报告。

> **J17/J19 混合缩放几何增量（2026-08-20）**：确定性层必须证明工具条所有原生几何写入只经停靠协调器，普通停靠、两类拖动、启动对齐与任务栏恢复不再形成第二写入者；受管恢复结算期间自主纠正为零，逐项覆盖 `250/1000/250ms` 边界、exact 成功采用新基线和失败保持 `suspend`。ConfigStore 组合必须覆盖无修订标记的精确 `1373 × 168 DIP` 一次性归一、其它旧尺寸保留、带 `windowGeometryRevision=1` 的同尺寸保留以及标记不进入 renderer 快照。J19 产品壳增加 `default`、`legacy-risk`、`current-risk` 三种仅由 runner 选择的配置组合；报告继续只写枚举、布尔、计数、相对时长与哈希，不写几何或路径。该增量为实现完成·尚未验收：定向 core/integration 与三种 schema-v8 产品壳配置已覆盖，I2 实机观察尚未取得。

> **J19 有界启动增量（2026-08-20）**：确定性层必须覆盖任一 renderer 不产生 `ready-to-show` 仍可按载入成功推进、双载入与 exact 几何就绪后才激活字幕交互、单项载入失败、`5s` 超时、几何失败、重试使旧尝试全部迟到回调失效、退出进入正常退出序列。失败期间字幕窗必须隐藏，工具条保持不透明、可交互且保留主任务栏入口。Electron 产品壳必须在上述三种配置组合中观察启动前 exact 工具条内容视口、首次拖动不漂移及自然退出。该增量为实现完成·尚未验收：控制器失败矩阵、main 接线约束和三种 schema-v8 产品壳配置已覆盖，真实任务栏入口仍待 I2 实机观察。

| ID | 用户场景与联合链路 | CI / 验收 | 当前状态 |
|---|---|---|---|
| J1 | 会议模式：点击运行 → 系统音频字幕 → partial/final/refined → 自动持久化 → 停止/重启 → 按时间戳查看历史 → 导出；Silero 确认前以独立 4 帧段前缓冲/12 帧 provisional stream 有界预热，确认前零字幕段/临时字幕/正文持久化，达到上限即丢弃并停止预热，后续新语音可恢复 | 字幕 MVP 每次 PR；WorkerCore/Silero 确定性负向矩阵覆盖冻结语料、997Hz 纯音、持续低能量噪声、确认前抑制与后续新语音恢复；真实音频另走 I2 smoke | SQLite 联合旅程已覆盖 loopback 单路终态会话、分页/详情/三格式导出；packaged 产品壳完成旧档迁移和二次进程历史恢复。2026-08-01 真实 loopback pause/refine 已通过，新的五轮结构/准确率/零损失 5/5；冻结 P95=1148ms 仍超线。4/12 有界 provisional 预热解耦及负向矩阵为实现完成·尚未验收，确认前零事件与既有 partial 不落盘旅程共同守住正文边界。revision `b96b8fe7db5ba4db3ac36c4ee85371a4381b521f` 上的新 `loopback` 五轮 strict series 为 5/5，首次稳定转写/精修稿、CER、自然退出、零损失与隐私边界闭合；冻结 P50/P95/min/max=1144/1242/1054/1242ms，仍未满足 `<1000ms`。逐轮模型音频需求为 712.625–776.562ms；仅在保持最慢轮已观察到的 437.438ms 采集/VAD 前置和 28ms 触发后组合时，模型音频需求必须低于 534.562ms，而 Gate 0B 同语料裸模型观测最大音频需求为 660ms。该比较不是物理下限证明；已决定基于当前观测停止本轮参数微调并重新开启 Gate 0B 实时模型替换评估。门槛、起点、Silero 与 4/12 边界不变，替代候选尚未选定。原生拖动/设备/睡眠未验，故整体仍为实现完成·尚未验收。 |
| J2 | 听写模式：点击运行 → 麦克风字幕 → partial/final/refined → 自动持久化 → 停止/重启 → 按时间戳查看历史 → 导出；与 J1 共享相同 4/12 有界 provisional 预热和确认前不可见/不可持久化边界 | 字幕 MVP / 发布阻断；真实麦克风另走 I2 smoke | SQLite 联合旅程覆盖 mic partial 排除、final→refined、停止、时间戳详情/导出及切换 loopback XOR；packaged fake-ASR 产品壳覆盖真实 UI/SQLite 双进程重启。受跟踪 fixture P95=1005ms；2026-08-01 新五轮 P95=1099ms，均未满足 `<1000ms`。`physical-preferred-label-heuristic` 不是硬件证明；4/12 有界 provisional 预热解耦及负向矩阵为实现完成·尚未验收，尚无优化后的五轮实机证据；设备/睡眠与原生拖动未关闭。 |
| J3 | Agent：已提交的 `loopback` 或 `mic` 单路会话停止 → 默认只创建个人上下文摄取工作且 Agent Bar 不自动呈现报告 → 用户从历史或 Agent Bar 明确请求纪要 → 字幕上下文适配器按完整水位读取 → 个人上下文模块解析来源 → 固定 `analysis` recipe 生成概要/结论/待办/风险 → 独立保存并在 Agent Bar/历史展示；历史列表只显示时间戳与提取后的关键信息，不创建已读/未读状态、角标或计数。另以默认关闭的报告自动呈现偏好覆盖“未来终态会话至多自动请求并非模态呈现一次” | 正式 Agent PR 阻断 + Agent 模型 provider 替身；`loopback`/`mic` fixture 分别运行；实网另验 | 已决定；旧 D4 自动纪要纵切不再代表本旅程。默认零纪要任务/零呈现、显式请求、无未读状态、偏好开启后的未来会话、非模态呈现与双来源组合尚无实现证据 |
| J4 | 来源互斥：设置/UI/runtime 均拒绝 `mic + loopback`；活动会话禁止直接换源；停止后以另一来源启动新会话且历史/Agent 产物不串会话 | 字幕 MVP 每次 PR；两种来源分别做 I2 smoke，不做双路 soak | 已覆盖 UI 结构、配置/迁移、Coordinator、adapter/audio host/worker 和停止换源后的两份隔离历史；SQLite/Agent 接入后沿用本旅程扩展 |
| J5 | pause/resume 时存在在途 refine 与后续 Agent 任务；恢复后不丢、不重发、不跨会话 | 字幕部分 I2；Agent 部分 A2 + 实机 smoke | Gateway 确定性组合和 2026-08-01 真实 loopback 都已覆盖在途 refine：暂停时 pending=1、暂停期 refined=0、Resume 后 refined=1，transport 零损失。Agent 后置部分仍待。 |
| J6 | realtime/refine/storage worker 崩溃、活动设备轨道结束或系统挂起后恢复；已定稿内容仍可显示、落盘、历史可见；设备/系统恢复后不自动重新采集，用户明确 Retry 才沿同一会话继续；Agent 可继续追赶 | CI 故障注入 + I2/I3 实机 smoke | 确定性故障注入、两来源 exact-exit bundle和 2026-08-01 真实 exact realtime worker 强制终止+Retry 均已通过；后者证明同一 session/cursor、复用 runtime adapter、创建新 worker generation，前后均有 final/refined 且损失为零。设备轨道结束与系统挂起已有局部回归；schema-v2 `device-removal-retry` / `sleep-wake-retry` runner、strict verifier 与 completion fail-closed 契约现为实现完成·尚未验收，尚无实际设备移除或系统睡眠报告。它不证明历史 `0x80000003` 根因；I3 长测和 Agent 仍待，完整 J6 为实现完成·尚未验收。 |
| J7 | Agent 超时、限流、断网、凭据失效或 Loop 失败；本地字幕、权威存储和历史必须继续 | A1/A2 PR 阻断 | 已决定；D4/D5 后端已覆盖 Agent 模型 provider 超时同 `runId` 重试、取消、无效结构化输出、插件超时/卸载、单项任务失败不阻塞其它任务且字幕事实不变；D6 以 production `StorageWorkerHost` 覆盖 storage exact-child replacement，D14 又覆盖 provider 结果后 Agent utility 异常退出、主凭据失效、同进程停止领取与新的 Electron main 恢复原 `runId`。上述子边界均为实现完成·尚未验收；正式 main/preload/renderer、真实 DeepSeek 限流/断网/凭据与完整 J7 组合仍无产品证据，不阻断字幕 MVP |
| J8 | 两小时字幕会话、数千段和历史滚动；CPU/内存/队列/SQLite WAL 有界 | I3 soak / 字幕发布门禁 | 非音频预资格已用 3,600 段/4,000 事件编码虚拟两小时，覆盖 72 页 DOM≤50、三格式导出、重开恢复与资源上界。75 秒真实资格 v5 取得恢复前/后/总计 14/17/31 个首次稳定转写、29 个精修稿，资源、SQLite、导出、transport、worker/storage 恢复全部严格通过。revision `efccfeda4cb66ff74da23c747f6c4af3495b9659` 的后续资格因 runner 未同时冻结精修偏好与运行时能力而形成 `fail/partial`，该报告不得进入合格证据。修复后 revision `82d56f64c80c74f30c1944665460f1316f1d7939` 的 75 秒 `loopback` 资格墙钟 75,540.785ms，恢复前/后/总计 14/17/31 个首次稳定转写、29 个精修稿，15/15 检查成立；严格报告 SHA-256=`0c219b9627618cdda12ad41ae77093fd5f7bcccbe30b042c1c9cad2958d702f4`，关闭双重冻结缺口。该 `pass/partial` 资格不改变 75 秒与 25/12/8 段门槛，也不能替代正式 7,200 秒、至少 3,000 个首次稳定转写和真人原生拖动；I3 整体保持实现完成·尚未验收。 |
| J9-CI | 打包态确定性资格：显式供给并前置校验锁定 Electron runtime；正式 ASAR/NSIS 内容，native utility 实际加载，受控首启/复启，exact-child 正常退出，同轮/载荷证据绑定，精确候选隔离安装/卸载；确定性模型解析测试使用工作区内受控模型就绪证明 fixture，I3 文本源码 provenance、全部产品文本 checkout，以及可下载 artifact strict reader 会复算的 caption layout runner/verifier 与索引复算的 `package-lock.json`/workflow 都固定 LF，但产品载荷、ASAR、installer 与报告仍按精确字节计算；最终 provenance 索引再绑定 exact checkout revision 与 GitHub run；I3 非音频 fixture 以独立 Node child 执行，并在该 child 加载 runner 与产品模块前固定 UTC；同 lane 其它测试与产品进程不改时区，产品导出继续使用 Windows 系统时区且实际字节 SHA 不做规范化；全程不需要 Agent | B5 每次 PR 的 Windows package lane | 当前确定性资格由 revision `bbfd7041e5963e51942392323735298a7b81cb30` / run `31191838016` 绑定，已达到联合验收完成；远端 installer SHA=`d77d16c0…060c`、产品载荷 SHA=`e95fd87f…a35a`，下载 artifact 不含 installer 字节。历史本地候选 `d862c5fc…0de10` / `a1f03ed6…9accc` 只绑定旧产品载荷，不得冒充当前候选。I4 必须另行取得并核验 bbfd/run 的精确 installer 字节；真实应用 `userData`、干净机与完整 I4 不提升，仍为实现完成·尚未验收。历史失败 run 与可移植性根因保留在 SEM-T03 及 B5 验收说明。 |
| J9-I4 | 精确 NSIS 在无仓库/Node/既有 userData/模型的 Win11 上交互安装；首次经公网下载核心字幕模型资源包；I4 非音频报告先证明供给、离线复启、历史/导出与数据保留；随后 `loopback`/`mic` 两个互斥音频 child 分别完成权限拒绝/批准、首次稳定转写、暂停/恢复、停止、SQLite 历史、导出、离线复启与隐私负扫描；严格 summary 绑定同一候选 | I4 干净 Win11 发布阻断 | 非音频专用机 runner/verifier、来源隔离的音频 child、strict summary 及只含精确安装器/B5/runner/verifier/fixture 的移交包入口现均为实现完成·尚未验收。音频 runner 由操作者明确确认 GUI 行为，harness 独立核对精确进程、安装文件、SQLite header/变化、三格式导出字节与 SHA、离线复启及零音频产物；`loopback` 必须先于 `mic`，任一单份报告都不能形成完整 I4 结论。当前尚无合格干净机三份 child 报告，完整 I4 为实现完成·尚未验收。 |
| J10 | 旧 JSONL → SQLite：中断后重跑不重复，保留每段最早有效 `final` 作为权威原始转写，遗留 `refined` 迁移为独立精修稿，原始版与精修版详情及 txt/md/srt 导出 digest 分别一致，切换后不双写；遗留 `translated` 只读保留并报告，不导入字幕事实 | B3.3 PR 阻断 + 迁移 fixture | DB2 内核和产品生命周期覆盖事务中断、坏行/截断尾、两版 digest、translated 隔离、stale recovery 与二次启动；packaged Electron 现又从真实 `userData/sessions` 导入旧档、保持源 SHA、不双写，第二进程验证幂等并保留历史/导出。J10 已达到联合验收完成；精确 release 干净机迁移仍作为 I4 发布复核 |
| J11 | final/refined → 可选 FTS/embedding：旧向量立即失效，重建结果一致；`sqlite-vec` 缺失时 history 继续 | X1 启用时才阻断对应 PR/打包验收 | Deferred；不阻断 B3.3、字幕 MVP 或 A2 |
| J12 | 隐私负证据：正常停止、崩溃恢复、诊断 smoke、迁移、模型安装和导出后，SQLite、应用数据目录、日志、测试产物与 Agent 上下文均不存在现场采集 PCM/WAV、录音片段或音频路径 | 字幕 MVP PR schema/文件检查 + J14 安装目录检查 + I2 diagnostic + I4 打包版数据目录检查；测试语料只跟踪 generator/reference，生成 WAV 被忽略 | schema/RPC/Gateway、默认产品与 packaged 双冷启动、迁移、历史导出、I3 非音频 3,600 段和批准大模型安装均无现场音频产物/字段/路径且不创建新 JSONL；I2 报告只绑定生成语料 digest。正式 release 的干净机数据目录仍归 I4 |
| J13 | 固定 recipe 权限：真实 Agent 执行宿主静态登记问答、分析、规划、文本转换与个人上下文摄取；每个 recipe 只获得声明的个人上下文范围、只读工具、模型预算和唯一结果提交类型。所有 recipe 都运行 Pi 的同一个有界 Agent Loop，差异只来自登记的轮次上限（1/3/6）与工具授权（空 / `search_context` / `search_context`+`read_sources`）；运行期不做形态判定。shell、进程、任意文件/网络/SQLite、外部写、递归委派和未登记工具全部被拒绝且不影响字幕 | 正式 Agent PR 阻断；Agent 模型 provider 契约替身 + 真实个人上下文模块/SQLite/执行宿主/Agent utility | 已决定；旧 PluginHost manifest、依赖和运行中卸载测试不再作为正式门禁。固定 recipe 闭集、按 recipe 登记的轮次上限与工具授权、turn/token/时间/工具预算和完整越权矩阵尚无实现证据 |
| J14 | 模型资源：缺少核心字幕模型资源包 → 用户在真实设置 renderer 打开资源管理并点击下载 → 受控中断后 Range 续传 → 固定 manifest 字节/SHA/归档/文件校验 → staging 原子安装/临时字幕识别器、权威识别器与 VAD 三项严格 ready marker → 空闲 runtime 发布字幕 capability → 工具条开始字幕 → 字幕窗显示定稿 → 暂停/恢复 → 停止并进入 SQLite 历史 | B4 每次 PR 使用真实 Electron settings DOM、受限 preload/IPC、真实 ModelManager/Windows tar/SQLite；仅 HTTP 内容、真实张量/ASR 和声卡使用受控替身。批准大模型另走实机 lane；公网/干净机归 I4 | 联合验收完成：真实 settings DOM 点击、preload/IPC、生产 ModelManager、loopback HTTP/Range、Windows tar、固定四资源 manifest、三项核心 marker、空闲热替换、工具条开始/暂停/恢复/停止、字幕 renderer、SQLite 终态历史与零现场音频均有证据；schema-v4 产品壳与 packaged 首启/复启进一步证明三项核心 ready、四项总资源、精修独立取消/继续。受控资源/fake ASR 不证明真实张量、物理来源或公网，后者仍归 I2/I4。 |
| J15a | 固定高度字幕流：长 `partial` 在用户设定的固定 bounds 内自然换行 → 满高后最旧完整视觉行退出、最新行留在底部 → 回改重排但不改识别文本、不触发分段/持久化/窗口 resize → `final` 到下一段 `partial` 逐行接续、停顿保留；一个段的最后一条视觉行退出后只回报会话/段身份并从 canonical 实时视图永久淘汰，迟到修订、故障回退、窗口放大与 reload 均不得复活 | 字幕 MVP PR 阻断；确定性层验证 reducer、renderer→main 淘汰水位、canonical replacement/reload 与 15 例真实 Chromium 几何。实机层使用可见非音频 DWM observation/matrix：实际 100/125/150/200% × 三主题 × 三背景 36 例和一次异缩放双屏移动；只注入合成 CaptionEvent，不需要真实音频 | `.caption-flow`、CSS 底部锚定 + 顶部裁剪、视口高度按整行取整、纯逻辑层、identity-only renderer→main 淘汰水位、canonical replacement/reload、迟到修订与故障回退不复活、15 例真实 Chromium 布局资格和产品壳断言已闭合，达到联合验收完成。可见非音频 DWM runner、单次 observation strict verifier、36 组合 matrix summarizer/verifier 与 fail-closed 契约测试为实现完成·尚未验收；尚无绑定当前候选的 36 例实机 matrix 报告，DPI、主题、透明窗与异缩放双屏移动尚未达到实机验收完成。 |
| J15b | 转写版本隔离：首次 `final` 落盘后不可变，精修稿独立保存；历史与 txt/md/srt 导出默认原始版并可明确切换回原始版；每次选择不同会话重置原始版，同一会话翻页保留当前选择；旧 JSONL 迁移后两版分别核对 digest | 字幕 MVP PR 阻断；存储/历史/导出/迁移使用确定性边界，不需要真实音频。真实 Electron 历史窗旅程必须覆盖：会话 A 默认原始版 → 明确切换精修版并翻页/导出 → 选择会话 B 后自动回到原始版并按原始版导出 | 已达到联合验收完成：首次 `final` 指针不变量、旧档 migration、205 段双版本 digest、会话作用域版本状态均有回归；真实 packaged Electron 完成会话 A 原始→精修、跨五页保持、精修导出，再切换会话 B 自动原始并按原始导出。 |
| J15c | 精修可选化：核心字幕 ready 只依赖 SEM-F21 的临时字幕识别器、权威识别器与 VAD；精修模型默认不下载。全局精修偏好不区分 `mic`/`loopback`，只在新会话开始时读取并冻结；关闭只影响未来会话，不删除旧稿。缺失时点开关保持关闭且 fetch=0；明确下载取得 ready 后仍需再次开启，下载可取消并保留合法 `.part`，应用不得自动续传。迟到精修只更新仍可见 final。worker 中途失败一经确认，所有仍可见 final 立即恢复首次稳定转写并在原 bounds 内重排，当前 `partial` 原样保留、已淘汰段不复活；本会话不重启/补跑，运行故障不修改全局偏好。正常停止后，工具条以不抢焦点的方式显示会话状态通知和“查看历史”；该通知只报告处理状态，不概括或改写字幕内容，保持到用户关闭或进入历史，开始下一会话时自动清除，应用重启不重放。详细结果跨重启持久化并写受约束的本地滚动 JSONL。故障与覆盖独立：`N<M` 不证明崩溃，`N=M` 不掩盖故障。历史按整场 `N/M` 处理完整、不完整、零精修与空会话；既有会话只标记运行状态未记录，不从覆盖推断故障。原始版始终不变，状态/颜色实时提醒后置且不阻断当前 MVP | 字幕 MVP PR 阻断；沿用 J14 的确定性模型边界。确定性旅程至少覆盖：核心三资源 ready/离线复启 → 缺精修模型点开关且 fetch=0/仍关闭 → 明确下载中取消并保留合法 `.part`、重启 fetch=0 → 明确“继续下载”才 Range 续传且 ready 后仍关闭 → 再次明确开启 → 分别以 `mic`/`loopback` 新会话证明同一全局偏好与会话内冻结 → 关闭偏好后旧稿仍可查看/导出、未来会话使用原始版 → 迟到精修只替换仍可见 final，不动 partial/已淘汰段/bounds → 强制 worker 失败，逐字段断言全部仍可见 final 立即恢复、当前 partial 不变、后续 final 为原始版、运行中无提示/变色/resize → 正常停止后在现有 bounds 内出现一次无 modal/无抢焦点的工具条会话状态通知和“查看历史”，关闭/进入历史可清除且未操作时持续存在 → 开始下一会话自动清除，应用重启不重放 → 重启后历史仍有稳定故障码及权威覆盖 → 逐一接受五个冻结故障码并拒绝其他值，模型 ready 缺失/损坏只回落偏好且不生成会话故障 → 运行故障不改变偏好且下一新会话最多尝试一次 → 分别构造 `N<M` 无故障与 `N=M` 有故障，前者不得伪报崩溃，后者必须显示“精修进程异常结束，但本次已生成 N/N 段精修稿” → 205 个 final/125 个精修稿跨五页保持同一 `N/M` → 核对 `[原始版回退]`、`refined-incomplete`、`M>0,N=0` 禁用与原始 digest → `M=0` 无故障时不显示 `0/0`、有故障时显示无已定稿字幕文案 → 旧 SQLite/JSONL 仅在精修详情显示“未记录精修运行状态” → 故障后异常退出并重启时会话为中断、不重放旧提示但历史结果仍在 → 日志负扫描正文/现场音频/路径/原始 Error/stack，并验证最多 5 文件、每文件 1 MiB、最长 7 天、无自动上传 → 启动时 ready 保留开启、缺失/损坏才关闭+通知+fetch=0、重新下载后仍关闭 → 活动会话拒绝精修模型下载；允许修改全局精修偏好，但本会话继续使用开始时冻结的值，修改只影响未来会话；真实模型调用另沿 I2/I4 | 既有精修范围与 SEM-F21 核心 ready 扩展的三项核心 marker、四项总资源确定性范围已达到联合验收完成：核心/精修分层、全局偏好与会话冻结、下载取消→合法 `.part`→复启 fetch=0→明确 Range 继续、故障恢复、会话结果、覆盖/故障独立、零/空/旧会话、异常退出、工具条会话状态通知、滚动日志及 schema-v4 产品壳与 packaged 首启/复启均有闭合证据；真实模型调用仍沿 J14/I2/I4，且不提升实机边界。 |
| J16 | 同源两阶段实时识别：用户选择一个 `mic` 或 `loopback` 来源开始会话 → 单份 PCM 经 VAD 后同时驱动双语 Zipformer 临时字幕识别器与 X-ASR 权威识别器 → 字幕窗先显示临时字幕 → 权威结果接管同段临时字幕 → 段结束只产生一个 X-ASR 首次稳定转写 → 停止后 SQLite、历史和导出只包含该首次稳定转写；缺失/损坏或 `DRAFT_RECOGNIZER_START_FAILED` 时启动 fail closed，运行中 `DRAFT_RECOGNIZER_FAILED` 时显式降级但会话继续，权威识别器故障仍进入 Retry | 字幕 MVP PR 阻断；真实 worker core、recognizer adapter、SessionCoordinator、caption reducer、SQLite/历史/导出协作。声卡与真实张量可使用受控边界；至少分别以 `mic`、`loopback` 验证来源互斥及同一帧扇出。报告及 SQLite/历史/导出必须验证零临时字幕正文；模型供应与设置 UI 沿 J14。Gate 0B 受控语料只验证模型选择与性能，不替代 I2/I4 | 联合验收完成：`mic`/`loopback` 纯合成跨模块旅程已覆盖单路同帧扇出、临时字幕、权威接管、唯一 `final`、SQLite/历史/导出零临时字幕正文、启动 fail closed、运行故障一次性显式降级与停止释放；schema-v4 packaged J14/B5 又闭合三项核心 marker 与四项总资源。真实张量、物理来源性能及 I2/I4 仍待实机验收。 |
| J17 | 窗口抓取与前台层级：用户在解锁字幕卡上从多个非工具条点位主键按住后立即连续拖动 → 原地按下/松开 bounds 不变 → 工具条在 quiet/attention/会话状态通知等宽度变化中只排除真实可见轮廓，并与 `8px` 拉伸带之间保持至少 `8 DIP` 普通拖动区间；用户在工具条上边、右边、相邻普通拖动区及靠近工具条的真实拉伸带反复原地点击或沿相关轴 `1–3 DIP` 轻微抖动时字幕窗宽高不变，真实拉伸只在相关轴达到 `4 DIP` 后启动；字幕窗或工具条任一窗口收到主指针结束都终止同代活动手势；字幕未锁定时握把不占布局且 renderer/main 都拒绝工具条拖动，组合只能从字幕卡普通拖动区移动；字幕锁定后两列三行六点握把才进入既有 `24 × 30 DIP` 命中盒并只移动工具条，图标替换不改变锁定态拖动时机、窗口 bounds 或实际轮廓 → `20 DIP` 透明外边距继续穿透、工具条轮廓先接管、轮廓外的 `8px` 内侧拉伸带再优先于普通拖动 → 锁定后字幕窗恒穿透；应用在任一窗口手势中最小化时取消旧手势并推进一次窗口交互代次，任务栏或第二实例恢复事务再推进一次，并在该恢复事务内以同一新代次执行 `suspend → resume` 与当前指针命中判定；下一次新的主键按下必须产生拖动意图且旧代次不得改变命中或 bounds；打开设置或字幕历史后，聚焦窗口临时压过字幕且其 `48px` 标题栏可拖、交互控件和正文不可拖，失焦后恢复普通层级；两窗在深色/浅色/高对比下共用中性标题栏层次 | 字幕 MVP PR 阻断；确定性层使用真实 main、四 renderer、preload、IPC access policy、BrowserWindow 和受控操作系统指针边界，覆盖至少 20 轮工具条上边/右边轮廓、相邻普通拖动区及靠近工具条的真实拉伸带按下松开；真实拉伸带覆盖相关轴 `1–3 DIP` 不发 `resizeStart`、`4 DIP` 才发起，以及字幕窗发起后由工具条收到结束仍清除主进程 timer；并覆盖手动拉伸或字幕卡组合拖动结束后的同代当前指针重命中、首帧/重载/非法或陈旧工具条矩形回落到最坏尺寸、有效同代矩形立即收缩、未锁定握把移出布局/轮廓/命中且 renderer/main 双重拒绝、锁定后六点握把的按下即拖/零位移/命中盒/轮廓不变、切锁结束旧手势并刷新动态轮廓、全部取消路径、缺失 `pointerup/pointercancel/blur` 时的生命周期手势重置、最小化与恢复各推进一次代次、恢复同代 `suspend → resume`、静止指针的 renderer 命中结果、旧 rAF/IPC 拒绝、锁定穿透及设置/字幕历史焦点往返。确定性层只断言原生穿透 API 的调用意图；真实任务栏恢复、Windows 原生穿透、恢复后首次鼠标拖动连续性、未锁定握把不可见且操作不改变字幕窗宽高/停靠、锁定握把可移动工具条、DWM z-order、100/125/150/200% DPI 和异缩放双屏另由 I2 `dwm-drag` schema-v6 可见实机观察。结构化报告不得包含字幕正文、本地绝对路径、设备名、指针坐标或绝对单调时刻。 | 既有 J17 旅程与最小化/恢复窗口交互代次、静止指针命中、过期意图拒绝及 reload/crash 降级已达到联合验收完成。本轮拉伸消歧、跨原生窗口手势收尾、固定工具条视口、动态轮廓重命中与有界原生几何纠正增量已经由确定性联合旅程及 schema-v7 产品壳覆盖，达到联合验收完成。工具条握把可见性增量为实现完成·尚未验收，确定性 UI/主进程/联合旅程与 schema-v8 产品壳协议已覆盖。I2 `dwm-drag` schema-v6 入口与 12 组合矩阵为实现完成·尚未验收，尚无当前候选实机证据。 |
| J18 | Fluent 2 桌面界面重构：应用从生产 Vite bundle 打开字幕窗、工具条、设置窗与字幕历史 → 四窗共享语义 token 与 Fluent System Icons → 深色、浅色与自动主题不改变工具条固定深色半透明表面、浅色普通按钮、六点握把和 phase 色调，字幕背景自定义色不进入工具条，工具条表面透明度仍可独立调整 → 用户通过键盘和指针操作现有信息架构 → 设置外观立即在本窗预览、命令 pending/失败/权威回落明确可见 → 字幕历史保持权威原始转写默认、同会话版本选择、分页和导出语义 → 临时字幕高频更新只修改必要节点且不改变 bounds/命中 → renderer reload 从权威快照恢复 2026-09-13 输入控件增量：设置页文本（含无 type）、密码、数字、URL、搜索、邮箱、select/textarea 的主题、间距、焦点、禁用/只读/已有失败及长值窄窗一致性，保持 color/range/开关专用语义。 | 字幕 MVP PR 阻断；确定性层使用 Vite 生产 bundle、真实 React 设置/历史 renderer、真实直接 DOM 字幕/工具条 renderer、preload、IPC access policy、RuntimeSnapshot/CommandResult、字幕历史服务和 BrowserWindow。至少覆盖四窗首帧无报错、深/浅/自动主题工具条计算样式恒等、字幕自定义色隔离、工具条透明度、系统高对比、键盘焦点、reduced motion、开发 URL fail closed、设置失败回落、历史读取失败重试及产品 bundle 身份。真实 Mica/DWM/DPI/异缩放由 J15a 与 I2 `dwm-drag` 补充，报告只保留枚举、布尔、计数、相对时长和哈希。SEM-F23 的静态视觉不变量另由 renderer 样式守卫子边界承担，它按目录扫描全部 renderer 样式，新增 renderer 目录出现即被覆盖。 复用正式 J25 设置旅程检查生产计算样式、Tab/pending/失败恢复；样式守卫仅证明静态边界，人工主题/缩放观察单列。见 [spec](../openspec/changes/fix-settings-input-styles/specs/settings-input-appearance/spec.md) 与 [TODO](../openspec/changes/fix-settings-input-styles/tasks.md)。 | 既有 J18 生产 renderer、共享 token/图标、设置/历史和 schema-v6 产品壳旅程已达到联合验收完成；本次工具条主题独立配色与外观配置隔离增量由 UI 定向测试及绑定当前产品载荷的 schema-v6 产品壳覆盖，已达到联合验收完成。真实 Mica 合成、DWM、DPI、异缩放与连续鼠标观测仍为实现完成·尚未验收，继续沿 J15a/I2。2026-08-31 新增的 renderer 样式守卫子边界与 `src/history/history.css` 调色板直引修正为实现完成·尚未验收。 2026-09-13 输入控件增量为已决定：仅规划，所有实现 TODO 未执行，不继承既有联合验收状态。 |
| J19 | Windows 任务栏与应用生命周期：普通 `npm start` 启动后，用户始终能从工具条对应的任务栏主入口找到应用 → 打开设置与字幕历史并在字幕窗或工具条手势尚未收到 `pointerup/pointercancel/blur` 时最小化主窗口，最小化事务推进一次窗口交互代次，字幕覆盖窗和两辅助窗口离开桌面、旧手势被取消但当前会话/状态/bounds 不变 → 从任务栏或第二实例恢复同一窗口集合，恢复事务再推进一次，并在该事务内以同一新代次执行 `suspend → resume` 与当前指针命中判定，`resume` 首次命中确认不等待 rAF，下一次新按下产生拖动意图且旧代次无效 → 单独关闭设置/字幕历史时应用和主任务栏入口继续 → 点击工具条“退出”或关闭任务栏主窗口后，SEM-F12 退出序列收束全部窗口、采集、worker 与 SQLite，exact-child supervisor 自然返回，随后可再次启动 | 字幕 MVP PR 阻断；确定性层使用真实 main、四 renderer/preload、IPC、BrowserWindow、产品生命周期与 exact-child supervisor，只替代真人任务栏点击/DWM。同步不变量单独断言 `resume` 首次命中确认不等待 rAF；局部失败矩阵注入最小化、恢复、同步确认超时、指针坐标不可用、原生穿透设置失败、renderer reload、过期窗口交互代次和退出异常，要求固定 `role/code`、穿透或显式实心命中降级、主入口可恢复或非零退出，绝不误报 clean exit。确定性产品壳只证明手势重置、代次时序与校验、renderer 命中结果、IPC 意图及主进程状态，不证明 Windows 实际应用原生穿透或真实鼠标拖动；新增实机结论全部由 I2 `dwm-drag` schema-v6 补充。 | 既有 schema-v6/schema-v7/schema-v8 产品壳、J17/J19 联合旅程及 exact-child 证据已覆盖窗口交互代次，达到联合验收完成。本轮 caption/toolbar `resume` 同步命中及恢复后静止指针直接按下的工具条附近首次拖动稳定性增量已由真实 renderer 联合旅程覆盖，达到联合验收完成；I2 `dwm-drag` schema-v6 为实现完成·尚未验收，当前候选实机证据尚未取得。 |
| J20 | 权威识别策略：用户在会话前独立选择纯本地权威识别或云端主力识别与本地降级 → 会话开始冻结策略 → 纯本地路径继续满足 J16；云端路径只运行云端权威流，本地核心资源有磁盘就绪证明但模型、VAD 和原生推理运行时不常驻 → 普通延迟波动不降级，明确断开、稳定错误或连接存活检测失败时才自动创建独立本地 worker 冷加载，再按提交切点把有界内存 PCM 交给本地链路并在同一会话内单向降级 → 停止后仍只有一个首次稳定转写事实 | 云识别阶段 PR 阻断；真实 capture、SessionCoordinator、provider adapter、本地 recognizer、SQLite 与历史协作，仅云网络/provider 使用契约替身。覆盖活动会话拒绝换策略、云端已有 final 与当前未定稿段、断网前后 sequence/session 连续、无自动切回、加载期间连续留存、30 秒接管期限、60 秒留存限界、停止/退出取消接管、迟到 configured 不复活及 PCM/正文隐私负扫描；真实 provider、公网和物理来源仍归 I2/I4 | 实现完成·尚未验收；**不阻断正式 Agent 首版**。原「确认关键词」半边已按 [ADR 0017](adr/0017-retire-confirmed-recognition-terms.md) 取消——个人上下文中的任何条目都不影响 ASR，`recognition_*` 四张 v3 表转为废案不写入。本行已退出 SEM-T15 门禁清单，云端资源与自动冷加载增量见 [实施记录](validation/cloud-fallback-memory-2026-09-30.md)；真实云端、物理来源与 I2/I3/I4 仍另验。 |
| J21 | 个人上下文摄取与管理：终态会话确定完整提交水位 → 默认只创建一个个人上下文摄取工作 → 真实个人上下文模块把固定快照分流为会话经历记录、个人记忆候选或丢弃并原子提交来源/revision/lifecycle；正式 Agent 交互只把提示、明确编辑、接受、拒绝、“记住”和“忘记”作为交互记忆信号再次摄取，普通点击、停留、滚动、浏览、调试聊天和未采纳模型输出保持零记录。会话候选只在会话/项目范围；mic/loopback均不证明本人身份。正式提问→候选→确认/纠正→已确认信息与后续会话等值关联→双侧来源撤销，详见2026-10-01增量。`resolve` 按选区/会话/日期/项目与预算返回个人上下文包，`manage` 覆盖查看、修改、删除、休眠与 suppression；关闭/重新开启个人记忆建立新边界且不补处理关闭期间来源 | 正式 Agent/记忆 PR 阻断；真实 storage worker、SQLite migration/job、个人上下文模块、Agent Bar/历史/设置 renderer，只在 Agent 模型 provider 外部 seam 使用契约替身。覆盖 provider 失败重试、重复唤醒/回复丢失幂等、来源删除/tombstone、输入版本变化、整场完整精修稿约束、冲突 revision、删除 suppression、被动行为/调试聊天/未采纳输出负矩阵、无说话人身份与旧全局候选复核、关闭休眠/重新开启保留、范围/候选/条目/字节预算与整条不截断。无图/向量依赖并执行隐私负扫描 | 实现完成·尚未验收；2026-10-01 提问候选→确认→关联→来源查看→纠正/忘记→SQLite 重开，包含真实 renderer/preload/main、个人上下文、Loop/调度器和存储，见[验证记录](validation/personal-memory-optimization-2026-10-01.md)。旧“三项自动任务”和 MemoryReader exact query 不再代表 J21；真实 provider 分类/关联质量与实机边界仍待验收。 |
| J22 | Agent Bar 与固定 recipe：用户选择范围并提交意图，执行宿主按模型优先加规则兜底两层机制收敛到已登记 recipe（两条路径与改选各自可观察），个人上下文模块冻结有界输入，模型接入层映射四用途并冻结模型运行绑定；所有 recipe 走同一个有界 Agent Loop，轮次上限与工具授权由登记表静态给出，运行期无形态判定、无升级理由。终态历史保留时间、范围/模型身份、`ModelUsageV1`、相对时长、最终结果和完整工具调用记录；提示在信号提取后清理，reasoning/provider 事件和工具外中间 assistant 文本零持久化。 | 正式 Agent UI/执行宿主 PR 阻断；真实 renderer、preload/exact IPC、个人上下文模块、模型接入层、执行宿主、job runner 与 SQLite，只替代外部 provider。覆盖范围、recipe Schema、三档轮次上限与工具授权（含工具授权为空的 recipe 必须留下空工具调用记录、轮次上限为 1 的 recipe 不得进入第二轮）、十轴预算、provider token 与用量未知两种情况、缓存事实、工具全序、多 attempt、取消、隐私负扫描、reload 与字幕系统独立边界；不出现费用或金额展示。 | 已决定；SEM-F29/J23 只保留历史资格，S3/S4 执行、存储与工具已有局部实现证据；S5 窗口/IPC 为占位接线，完整 Agent Bar 与交互旅程仍待汇合。 |
| J23 | 隔离 Agent 内核历史资格：旧开发应用曾以独立 userData、renderer/preload、Agent/storage utility、SQLite 与 Pi 验证受控工具事件、执行预览、取消、重试、恢复、幂等、调用级凭据和隐私边界。重设计只把这些结果作为迁移审计输入；旧调试聊天、PluginHost、专用子 Agent 与产品外壳均可删除，不能成为个人上下文或正式 Agent 交互来源 | 历史回归，不阻断新正式 Agent；若删除旧入口，只把仍由 J13/J21/J22/J24 需要的进程、凭据、恢复和负扫描场景迁到对应新旅程，不保留旧 UI 或插件测试来凑门禁 | 联合验收完成：J23-B01–B16 只在旧隔离范围内成立；不提升 J13/J21/J22/J24，也不限制新模块边界。 |
| J24 | 正式 Agent 正常使用边界组合：Agent 处理资格、默认零报告、报告自动呈现偏好、无未读状态、选区/会话/日期/项目范围、空/短/超上下文分别得到显式资格、完整生成或确定性分块；个人上下文摄取与用户请求任务冻结各自来源引用/水位/digest/记忆 revision/recipe/模型用途/模型运行绑定/预算并独立成败。重复停止、启动扫描、worker replacement、重复呈现、人工双击及 claim/结果/管理回复丢失保持幂等；设置与 claim 两种 FIFO 顺序都使用最新策略，replacement 未重放策略前不领取或解析个人上下文。退出、取消、provider 短暂/终态故障、个人记忆关闭/重开、会话 tombstone、本地资源让行、多会话排队、recipe 故障、Agent Bar/renderer reload 均从 SQLite 权威状态恢复或显式降级且不影响字幕系统。取消是协程式终态：请求取消后当前工具调用与模型请求在下一个可观察检查点收束，已发生的 attempt 与工具调用记录保留，交互标记取消终态理由并同样可导出，不留部分产物。范围解析以会话内粒度剔除未定稿内容并写入省略标记 `not_committed_tail`；只有 `session_not_terminal`、`no_committed_transcript` 或 `budget` 才整场排除。预算耗尽使用 `AGENT_BUDGET_EXCEEDED` | 正式 Agent PR 阻断；使用真实 storage worker、SQLite migration/job、个人上下文模块、Agent 执行宿主、Agent 模型接入层、job runner、正式 preload/exact IPC 与 Agent Bar/管理 renderer，只在外部 provider、云网络、系统凭据、声卡和系统权限使用受控替身。必须证明凭据不进入非 Agent 子进程/SQLite/日志/报告，exact provider origin 拒绝 redirect，任务领取携带当前固定 recipe 闭集；长输入覆盖全部来源且不提交部分结果，`refined` 只接受整场完整精修稿；对产物/job、会话经历记录、个人记忆 current revision、交互信号、工具调用记录和报告呈现 receipt 做错配注入，证明完整 tool args/result 只持久化于交互审计 SQLite 并经受限 UI 读取，且与执行输入/返回逐字段一致，重试后旧 attempt 记录仍完整可读，省略标记同时出现在结果的 `gaps`/`openQuestions` 与导出中，并对原始提示、reasoning、provider 事件、凭据、现场音频、音频路径和绝对路径执行 SEM-F14 隐私负扫描。不得用旧 `agent-mvp-todo.md` 矩阵、单一 DeepSeek 配置、文档关键词正则或重复低层测试冒充新旅程 | 已决定；旧 D3–D15 组合矩阵只作为任务恢复、凭据、utility 和幂等迁移素材。新个人上下文模块、固定 recipe、Agent Bar、最小交互历史、完整工具调用记录、默认零报告与可选自动呈现的完整 J24 尚无实现证据。 |
| J25 | OpenAI-compatible 配置与模型效率比较：设置只向用户展示模型配置档案及默认、信息提取、摘要与总结、分析与规划四用途。v6 持久化初始化只提供可修改、可删除的 DeepSeek 空 model provider 模板；首次向导额外展示 DeepSeek、OpenAI、通义千问（北京）三个未提交的只读预设草稿；用户明确提交 API base URL、model ID、六字段能力、用途和每档案独立凭据后，Agent 模型接入层按精确 `(profileId, modelId)` 冻结不可变模型运行绑定。同一来源可由用户主动以不同模型创建新 `runId`，历史比较模型身份、input/output token（`usageReporting=false` 或 provider 未返回时为用量未知，不估算、不显示数字）、可派生缓存命中率与相对时长，不计算或展示金额。九条 configure 命令全部使用统一 `expectedRevision`，失败零写入且只返回两个 `MODEL_CONFIG_*` 错误；用途回落显式、provider 失败不自动切换、删除/修改档案只影响未来 binding、旧 slot 缺失稳定收束为 `AGENT_PROVIDER_AUTH_FAILED`。remote pull 仅返回瞬时建议和六值状态，零写入、零 revision、零 changed；模板建议不能自动写 model。 2026-09-13 文案和信息顺序增量：展示别名映射、连接→密钥→模型确认→默认用途、新建/专用用途折叠及高级字段错误展开；默认配置充分不冒充网络或推理成功。 | 正式 Agent 模型接入层 PR 阻断；S2 Core 保留真实 v6、配置 store、每档案 vault、三接口、main exact IPC 与真实 preload facade，只在 provider/network/safeStorage 外部边界使用替身。覆盖模板空 model、至少两个用户档案/model、四用途、九命令、revision 冲突、session-only 重启、origin/redirect、鉴权隔离、不可变 binding、token/cache 归一化、reload、隐私负扫描和生产 fauxProvider 不可达；正式设置 renderer/preload → Agent Bar preload/main → SQLite/history renderer 的最小链路由 `test/integration/agent-redesign-j25-formal-settings-journey.test.js` 以受控 loopback provider 覆盖；真实公网 provider、系统凭据和正式模型比较实机证据仍待门禁。 同一正式设置旅程补首次空模板、自定义配置、同服务多模型、同服务商独立配置、建议六字段确认且零自动写入、默认/专用用途、目录失败手填、revision 冲突及 session_only 重启。保留真实设置→Agent Bar→SQLite/history。见 [spec](../openspec/changes/simplify-agent-model-settings/specs/agent-model-settings-guidance/spec.md) 与 [TODO](../openspec/changes/simplify-agent-model-settings/tasks.md)。 | 已决定；S2 Core 即使三条 lane 返回 0，状态最多为「实现完成·尚未验收」，不提升完整 J25。 2026-09-13 展示增量状态为实现完成·尚未验收：设置 renderer、三项版本化服务预设、独立模型测试和竞态/隐私边界已有定向证据；完整 J25、真实公网 provider、系统凭据、正式包和实机范围仍未形成新验收证据。2026-09-29 明确：模型能力配置不被运行期输出额度派生改写；81920 等大输出能力不得直接成为请求额度，单次请求按 8,192 目标与模型能力、剩余输出预算、上下文余量取小值。 |

> **J25 配置失败回执增量（2026-09-19）**：正式设置旅程还必须覆盖无凭据档案提交非法连接更新。存储拒绝时，真实 renderer→preload→main→ModelAccessRuntime→storage worker→SQLite 链路必须返回失败，配置 revision 与权威档案不变，编辑内容保留且不广播成功 changed；该场景不能由凭据为空推断配置已提交。

### 2026-09-16 J17/J19 原生按下连续性增量

依据诊断记录与 SEM-F22/F24 登记，J17/J19 增加一条真实 Windows 输入边界：字幕窗保持不可聚焦，任务栏恢复后的新客户端主键按下必须进入已有拖动链路。确定性层覆盖原生模块的生产 API 合同、精确 HWND 参数拒绝、返回值规范化、绑定句柄身份与启动失败的“重试 / 退出”旅程；真实 BrowserWindow subclass 的建立/销毁和 `WM_MOUSEACTIVATE` 返回值仍由 Windows 宿主探针与 I2 `dwm-drag` 观察，不能以 renderer 注入或 `hookWindowMessage` 的回调返回值证明修复。Windows CI 在原生构建后运行该宿主探针，并将 GPU 致命错误与探针失败分别阻断；探针使用单一 `--disable-gpu` 隔离驱动变量，不改变产品启动参数。I2 `dwm-drag` 继续负责真实恢复、连续鼠标、穿透、DPI 与异缩放；报告只保留枚举、布尔、计数和哈希，当前状态为实现完成·尚未验收。
| J26 | 正式 Agent 单交互导出：用户从终态交互明确导出，storage worker 从同一 SQLite 快照读取模型运行绑定、recipe/input/终态身份、`ModelUsageV1`、可空缓存命中率、相对时长、最终结果和全序工具调用，main 校验后写 canonical 版本化 JSON。取消终态同样可导出且不补造结果；取消或失败零部分文件，相同交互重导出字节与 SHA-256 相同。导出不计算或展示金额，也不含提示、reasoning、provider 原始事件、凭据、现场音频、音频路径、本地绝对路径或目标路径。 | 正式 Agent 导出 PR 阻断；真实 renderer、preload、保存对话框、storage worker/SQLite 与原子文件 adapter，只替代系统对话框/文件故障边界。覆盖终态/取消、多 attempt、tool 顺序与 digest、ModelUsageV1、确定性重导出、隐私负扫描和 price/cost/currency/pricing 字段拒绝。 | 实现完成·尚未验收；main-owned exporter 已从同一 StorageGateway 详情校验终态、digest、Schema、工具全序与隐私后写同目录 canonical JSON，定向 exporter/UI 回归与真实 SQLite J26 旅程已有；取消/写入失败和正式联合验收证据仍待阶段门禁。 |
| J27 | 旧 Agent 链路退役：现行产品只使用 `src/agent/**` formal Agent；旧四棵源码树、旧 storage store、隔离启动入口、专属脚本/测试均从产品与构建入口移除；现有 v1–v9 正式数据库先做一致性快照，v10 在单一外键事务中删除精确 15 个旧表及其索引/触发器；备份或迁移失败时保留已提交版本，字幕/历史/导出按版本提供降级，Agent 与会话删除 fail closed；成功后重启不重复备份。 | J27 退役 PR 阻断；真实 storage worker/SQLite、迁移备份/校验、personal-context/model/formal Agent 与删除服务门禁、产品入口 require 图、打包布局与旧路径负扫描。 | 实现完成·尚未验收：`test/storage/legacy-agent-retirement.test.js` 当前 24/24；`npm run test:core` 932/932，`npm run test:evidence` 229/229（I3 报告按 `TZ=UTC --segments 3600 --batch-size 100` 重建并通过 provenance/export 校验）；`npm run test:integration` 为 50/53，3 项失败分别是 `agent-bar-ipc-journey` 的 GPU/safeStorage 子进程退出、`renderer-development-entry-journey` 的开发启动退出码 1、`supervised-electron-exit` 的 GPU 导致 abnormal-exit；这些在观测到 GPU/utility 异常的当前 Windows Electron/加密执行环境边界中均未形成可采纳证据。renderer verify、smoke 打包与 smoke layout（453 ASAR 条目、5 个 native binary）返回 0；release 打包返回 0，但 release layout 的 Authenticode inspection 与 NSIS lifecycle 在本机未形成可采纳报告；packaged fresh/restart 同样未形成可采纳证据。 |

> **2026-09-13 J25 语义收敛补充**：为防自定义配置撞用预设策略，预设向导使用保留的 `preset.<presetId>` 配置标识，非登记服务/连接拒绝占用该标识；同 tuple 的普通配置保留 `openai-compatible@1`。正式凭据消费只在 vault 读取失败时映射认证失败，provider timeout/rate-limit/unavailable 等错误原样返回。独立模型测试的目录读取拒绝在取消已登记时优先收束为 `cancelled`。相关碰撞、错误透传和取消竞态定向测试已纳入 J25 证据；整体仍为「实现完成·尚未验收」。

### J18 的 renderer 样式守卫子边界（不是新旅程）

该子边界只登记 SEM-F23 视觉不变量的静态可执行边界，J18 编号、用户意图和完整验收口径保持上表不变。它跑在 `npm run test:core` 的 `test/ui` lane 内，按目录扫描 `src/**` 下的 renderer 样式与入口，不按窗口点名；新增 renderer 目录——包括未来正式 `agent` 窗口——出现即被覆盖，不依赖任何人记得改守卫名单。

| 观察面 | 正证据 | 负证据与状态上限 |
|---|---|---|
| 扫描范围本身 | 守卫先断言扫描结果非空且至少包含字幕窗、工具条、设置、字幕历史与共享 phase 样式，再逐条校验 | 扫描表达式写错导致零文件被检查时必须变红，不得空过 |
| renderer 入口 | 每个含样式的 renderer 目录必须有入口引用共享 token 文件 | 新增 renderer 不引用共享 token 文件时变红，而不是被名单遗漏 |
| 组件样式层 | 组件样式只消费语义 token，并各自带 `prefers-reduced-motion` 与 `forced-colors` 轮廓 | 字面色值、`--c-*` 调色板直引、组件内 `[data-theme]` 分支、渐变、玻璃体与常驻模糊表面一律变红 |
| 无限动效 | 无限循环动画只允许出现在守卫内硬编码的既有闭集（临时字幕光标、`starting`/`recovering` 转圈） | 新增任何无限循环动画默认变红；要放行必须先改语义行与本小节，再改守卫闭集 |
| 例外面 | 只有共享 token 文件本身持有调色板原始值与主题分支；构建产物 `src/renderer-dist/**` 与隔离 Agent 内核开发入口 `src/agent-mvp/**` 不在扫描范围 | 例外是硬编码闭集；扩大例外必须先改 SEM-F23，不得直接放宽守卫默认值 |
| 开发预览 | `src/ui/preview/**` 必须引用共享 token 与 phase 样式，且不得重新定义语义 token；其背景模拟色板是允许的例外 | 预览页不进入生产 bundle，不构成 J18/J22/J24 任何证据，也不表示正式 `agent` renderer 的前置 contract 已冻结 |
| Agent Bar 设计基准 | `agent-bar.html` 直接引用 `src/settings/settings.css`，并用设置页既有控件搭出全部状态 | 基准页重新定义 `.group` / `.row` / `.seg` / `.primary-btn` 等设置页控件时变红；抄一份控件样式等于放任设计基准与设置页各自漂移 |

即使该子边界全绿，它最多证明静态样式边界成立：不证明真实 Mica、系统 DPI、跨背景可读性，也不证明任何 renderer 已实现或已验收——这些继续由 J18 主旅程与 J15a/I2 承担。不新增 `J18a`、`J18-style` 等同义旅程 ID。

2026-08-31 的样式守卫子边界为「实现完成·尚未验收」。

### J21 的 S1 实现子边界（不是新旅程）

S1 只登记 J21 的前置实现子边界，J21 编号、用户意图和完整验收口径保持上表不变。该子边界使用真实 migration v5、storage worker、临时 SQLite、新 personal-context store、个人上下文模块三接口与新 `FormalAgentJobScheduler`；内部产品模块不得使用内存 repository 或 mock。

| 观察面 | S1 正证据 | S1 负证据与状态上限 |
|---|---|---|
| `ingest(source)` | 从真实持久化终态来源冻结 `sessionId + inputWatermark + transcriptVersion + digest`；非空来源原子建立至多一个 `context.ingest.session` 运行和一条不复制整场正文的有界会话经历记录；相同身份重放计数不增长 | 不从任意字幕正文自动臆测个人记忆；空正文、非终态、digest 错配或额外键失败零写入 |
| `resolve(request)` / `manage(command)` | 单会话与跨会话范围、水位级 `not_committed_tail`、精修覆盖不完整时回落权威原始转写、整条预算省略、revision 守卫；明确「记住」/修改可建立或修订个人记忆，删除回复丢失按同 key 重放原计数 | 不提供自由查询、模糊匹配、完整个人记忆表或 SQLite；普通点击、停留、滚动、浏览、调试聊天和未采纳模型输出零记录 |
| 调度与产品组合 | 用真实新 store 中受控存在的 `context.ingest.session` 运行验证 `start/wake/stop`、logical claim attempt、`wakeEpoch`、timer/generation 与错误隔离；字幕提交边界失败不改变停止回执、下一会话、退出或历史 | S2 尚无真实模型接入事实时，产品资格必须稳定为 `provider_not_configured`，自动路径零运行、零报告；不得向产品资格组合器注入假 `ready`，调度 fixture 不构成自动产品旅程 |
| IPC 与隐私 | `settings` / `history` 通过 exact IPC adapter 观察 overview 与 manage 结果；字幕 `open/append/close/history` 不加载新旧任一 Agent store | S1 不新增 `agent` 角色或 Agent Bar；凭据、现场音频、PCM/WAV、音频路径、本地绝对路径、设备名、正文和绝对单调时刻不进入证据 JSON |

S1 的 `manage` 子边界还必须覆盖三项已决定行为：设置或字幕历史只能用 exact 结构化字段建立明确内容个人记忆，任意自由文本命令类型、额外键或数据库形状零写入；“忘记”使单条个人记忆退出检索但保留条目、revision、来源引用与会话经历记录，只有后续用户明确“记住”或修改才可恢复；“删除”按 suppression → 物理移除事务收束，同一 deletion idempotency key 只重放首次计数。个人记忆中的“术语”只是个人上下文事实；按 ADR 0017，它在任何情况下都不影响识别 provider，也不存在转换入口。调度技术故障只验证受约束诊断、幂等重放与字幕系统不降级，不进入 renderer-facing fixture 或页面状态。

即使上述子边界三条 lane 全绿，S1 状态最多为「实现完成·尚未验收」：它不证明真实 `ready` 自动摄取、正式 Agent 交互信号、管理 UI 或完整 J21。S2 提供真实模型接入事实，S3/S5 提供正式交互与 renderer 后，再把这些子边界组合回同一个 J21；不新增 `J21a`、`J21-S1` 等同义旅程 ID。

2026-08-30 的 S1 子边界为「实现完成·尚未验收」：真实临时 SQLite 联合测试覆盖 personal-context store 初始化失败、事务回滚、重复终态通知、摄取回复丢失重放、scheduler observer 抛错及 `provider_not_configured`；每项都继续验证字幕提交与历史读取，自动路径保持零运行、零报告。`npm run test:core` 与 `npm run test:evidence` 返回 0；`npm run test:integration` 的 J21 S1 联合测试返回 0，但整条 lane 受 Windows Electron GPU 子进程 `exit_code=-1073741515` 影响而返回非零，相关旧隔离 Agent 旅程不构成 S1 产品断言。该证据不提升完整 J21，S2–S5 尚未开始。

### J25 的 S2 Core 子边界（不是新旅程）

S2 只登记 J25 在 renderer 汇合前的 Core 实现子边界。它使用真实 migration v6、模型配置存储、每档案 `safeStorage` 凭据槽、Agent 模型接入层三接口、main-owned exact IPC 与确定性协议替身；内部模型目录、用途映射、绑定和存储不得用内存 repository 或 mock 代替。

| 观察面 | S2 Core 正证据 | 延后到 S5-Integration 的证据 |
|---|---|---|
| 配置与凭据 | 多配置档案、每档案独立凭据槽、九命令 revision 守卫、删除档案原子清理、凭据存在性布尔与 scope 枚举；`safeStorage` 不可用时为 `session_only`，重启后回落 `absent` | 用户在真实设置 renderer 建档、改档、管理模型与凭据，并在 reload/restart 后观察权威投影 |
| 四个模型用途 | 默认、信息提取、摘要与总结、分析与规划分别解析；专用用途为空时显式回落默认 | 设置 renderer 以产品语言呈现四用途与回落，不暴露 recipe ID、adapter、factory 或 IPC channel |
| 运行绑定与比较 | 精确 `(profileId, modelId)`、配置 revision、六字段能力、十轴预算、providerKind 与凭据引用冻结；`ModelUsageV1` 只保留 token、用量来源与缓存命中事实 | 用户通过 Agent Bar 主动换模型生成兄弟交互，并在真实交互历史比较 input/output token、用量来源、缓存命中率与相对时长 |
| 外部与隐私边界 | exact HTTPS origin 拒绝 redirect；目录拉取失败零写入；生产构建不可达确定性替身；凭据负扫描 | 设置错误、目录建议、用途回落与下一动作在真实 renderer 可访问呈现 |

S2 的 fixture 只服务 UI/UX 设计预览和 renderer 局部回归，不进入 `.artifacts/`、`docs/validation/` 或 J25 证据。S5-Integration 尚未闭合真实设置 renderer 与交互比较路径前，S2 状态最多为「实现完成·尚未验收」。

2026-08-30 的 S2 Core 子边界为「实现完成·尚未验收」：真实临时 SQLite v5→v6、model-access store、每档案 vault、三接口、main exact IPC/preload 与 test-only `fauxProvider()` 已组成确定性证据；九命令、用途回落、不可变 binding、旧 slot 鉴权失败、origin/redirect、token/cache、reload、生产替身不可达及字幕独立路径均有回归。最终独立运行 `npm run test:core` 返回 0（694/694），`npm run test:evidence` 返回 0（233/233）；`npm run test:integration` 中 S2 两条联合测试返回 0，整条 lane 为 69/77，8 项失败均位于需启动 Electron/utility 子进程的既有旅程并伴随 Windows GPU `exit_code=-1073741515` 或子进程报告缺失。完整 `npm test` 因同一 integration 环境问题在 69/77 后停止，未在复合命令内再次进入 evidence。该记录不提升完整 J25，也不证明正式 settings renderer、真实公网模型能力或主动换模型后的历史比较。

2026-08-30 追加 S5-UX renderer 局部实现记录（不提升本行状态、不构成完整 J25）：`src/settings/agent-model-pane.tsx` 与 `src/settings/agent-model-view-model.ts` 把已冻结的 `agent-model-ui@1.0.0` exact contract 与既有 `src/preload/settings.js` facade（`getAgentModelCatalog`/`configureAgentModel`/`pullAgentModelCatalog`/`onAgentModelChanged`，均为既有 channel，未新增）接入正式 `src/settings/` renderer 的新增「Agent 模型配置档案」类别，覆盖先订阅再读取、`MODEL_ACCESS_UNAVAILABLE` 只读降级、空 model 模板建议与两个 token 上限未知、模板删除不重建、四用途 `direct/fallback_default/unconfigured` 与三值 readiness、三种凭据 scope 且提交后立即清空明文、`MODEL_CONFIG_INVALID`/`MODEL_CONFIG_REVISION_CONFLICT` 两个配置错误的输入保留与收敛、六值 remote pull 状态、删除档案/删除 model 的作用对象确认、隐私负扫描。新增 `test/ui/agent-model-settings-ui.test.js`（13 项）与 `test/ui/settings-react-ui.test.js` 的导航断言（1 项），载荷全部取自既有 `scenarios.json` 并先经真实 exact validator。`npm run typecheck:renderer`、`npm run build:renderer` 通过；`npm run test:core` 返回 0（708/708，含本轮新增 14 项）；`npm run test:evidence` 返回 0（233/233，同步重跑并提交 `docs/validation/i3-nonaudio-results.json` 因 `src/` 变化而漂移的 `productPayloadSha256`，其余 fixture/exports 字节不变）；`npm run test:integration` 为 76/77，唯一失败 `formal-agent-storage-utility-journey.test.js` 需要真实 Electron 子进程，与本轮改动无关，属既有沙箱执行环境问题。真实 `safeStorage`/SQLite 往返、Agent Bar、主动换模型后的历史比较仍留给 S5-Integration；S2 状态不因本记录变化。

### J22/J24 的 S3 Core 子边界（不是新旅程）

S3 只登记 J22/J24 在 Agent Bar renderer 汇合前的执行宿主 Core 实现子边界，J22/J24 编号、用户意图和完整验收口径保持上表不变。该子边界使用真实 migration v7、storage worker/SQLite、S1 的个人上下文模块与运行/租约/幂等机制、S2 的 Agent 模型接入层与不可变模型运行绑定、十一个 recipe 的静态登记表与 Agent 执行宿主；只在 Agent 模型 provider 外部边界使用确定性协议替身。正式 `agent` 角色、六个 `agent-run:*` 频道与 exact IPC 仍待其公开 contract、fixture 和窗口边界签发，不能计入本子边界。S3 先闭合统一执行路径、0 工具与 `search_context` 档，`read_sources` 和完整十轴工具预算执法留给 S4。

| 观察面 | S3 Core 正证据 | S3 Core 负证据与延后边界 |
|---|---|---|
| v7 与审计事实 | v1–v6 SQL/checksum 逐字节不变；v7 恰好新增三张 `STRICT` 表、一列删除计数和四条已登记分页/全序索引；交互冻结 recipe 版本、`max_turns`、`tool_grants_json`、`routing_mode`、可空 `usage_json` 与 canonical `comparison_group_id` | 不新增 `model_binding_id`、`execution_form`、`escalation_reason`、金额或正文副本；args/result 字节上限由 schema 直接拒绝，取消允许空结果且不补造 |
| recipe 与统一执行路径 | `src/agent/contracts/recipes.js` 唯一定义十一个 recipe；1/3/6 轮与工具授权逐项固定；全部运行经同一个有界 Agent Loop，`bind()` 只接收 `executionForm='agent_loop'`；`context.ingest.*` 的零模型确定性前段后进入同一循环 | 未登记 recipe、登记漂移、工具授权越界和第二轮越界 fail closed；不引入运行期形态判定、升级理由、动态插件、递归委派或第二条执行路径 |
| 意图收敛与取消 | `intent.route` 模型判定成功记 `model`；五类闭集条件分别触发规则兜底并记 `rules`；预置路径记 `preset`；规则全不匹配收敛到 `qa.answer`；改选按取消当前运行并新建 `runId` | 用户取消不触发兜底；取消后不再开始新 turn/模型请求/工具调用，迟到结果被拒且不改写已收束交互、运行、绑定或工具快照 |
| IPC、资格与恢复 | main 与执行宿主内部按九值固定顺序收束资格；同 `runId` 自动重试保留绑定、旧 attempt 工具记录和冻结输入 | `agent`/`history` 的六个正式频道、`agent` 角色、preload 与窗口尚未实现；renderer 不得推断资格或接触 SQLite/凭据/文件系统/网络。worker replacement、回复丢失或重复触发不复制交互、报告呈现回执、会话经历记录或个人记忆 |
| 用量、隐私与字幕独立 | provider 返回用量时保存 exact `ModelUsageV1`；provider 未返回或 `usageReporting=false` 时整体为 `null` 并投影「用量未知」；中间 assistant 文本零持久化，提示在交互记忆信号提取后只留 digest | 不估算 token，不保存或展示金额；fixture/证据负扫描凭据、现场音频、音频路径、本地绝对路径、提示正文、reasoning/provider 事件；任一 Agent 故障不阻塞字幕停止、退出、下一会话或历史 |

S3 fixture 只服务 UI/UX 设计预览和 renderer 局部回归，不进入 `.artifacts/`、`docs/validation/` 或 J22/J24 证据。S5-Integration 尚未闭合真实 Agent Bar renderer、preload、交互历史与单交互导出前，S3 状态最多为「实现完成·尚未验收」；不得因 Core 局部回归晋级完整 J22/J24，也不得新增 `J22-S3`、`J24-core` 等同义旅程 ID。

2026-08-31 本轮 S3 session ingest seam 与模型路由 Core 记录为「实现完成·尚未验收」：内部 personal-context execution adapter、storage worker prepare/read/commit 命令、终态 source 派生与 skeleton replay 已把 ready 资格下的终态通知接入现有 scheduler claim/lease/attempt/wake 生命周期；无资格时仍保持 `provider_not_configured` 与零自动写入。组合旅程使用真实 storage worker/SQLite、Agent 模型接入层 binding、run 与 interaction 持久化和统一 Agent Loop，只替代 Agent 模型 provider，证明模型路由终态后才建立独立绑定目标 run；迟到的 provider 成功在取消后会于 Schema 校验和持久化前被拒绝。与 S4 受控工具路径合并定向 runtime/storage/integration 测试返回 0（29/29），字幕提交、历史与退出边界继续使用真实 SQLite/Gateway。该记录不证明正式 Agent IPC、interaction ingest、Agent Bar 或完整 J22/J24。

### J22/J24 的 S4 Core 子边界（不是新旅程）

S4 只登记 J22/J24 在 Agent Loop、tool adapter 与 Agent Bar renderer 汇合前的受控只读工具与预算 Core 子边界。它复用 S3 已拥有的 `runId`、attempt、静态 recipe `maxTurns/toolGrants` 快照与 v7 `formal_agent_tool_calls` 审计槽位；本子边界不新建 migration、不复制 S3 执行路径，也不把 fixture 接入 IPC、preload 或正式 renderer。工具与预算的数值唯一来源是 `src/agent/contracts/budget-axes.js`，工具闭集只允许 `search_context` 与 `read_sources`。真实 adapter 只消费个人上下文模块在固定 recipe 运行开始时冻结的受限工具上下文投影；执行宿主不得取得 SQLite、文件系统、shell、任意网络或写端口。

| 观察面 | S4 Core 正证据 | S4 Core 负证据与延后边界 |
|---|---|---|
| 工具闭集与 exact Schema | 受控 adapter 与 exact validator 覆盖两个工具各自的参数、返回值、canonical JSON 字节上限、静态 `maxResultBytes` 与未知枚举拒绝；`search_context` 只作冻结个人上下文包内的别名等值匹配并显式返回未命中键，`read_sources` 只按已冻结 `SourceRefV1` 一一返回有界来源正文 | 不增加 shell、进程、任意文件、网络、SQLite 直连、外部写入、凭据、现场音频或音频路径能力；不实现任意搜索或第二套来源读取路径 |
| recipe 授权与范围 | validator 从静态 recipe 登记校验 `maxTurns/toolGrants`，未授权工具返回 `TOOL_NOT_AVAILABLE_FOR_RECIPE`；当前个人上下文包外的 memory/source 引用返回 `TOOL_SCOPE_DENIED` | 不让 S4 修改 recipe 登记、运行期重判授权、读取 SQLite 或替 S3 创建 interaction；空工具授权 recipe 继续留下零工具调用记录 |
| 十轴预算 | `deriveBudget()` / recipe 快照与十轴 observation 使用同一 `budget-axes.js` 定义；轮次、单次请求输入、累计 token、墙钟、调用数、单工具 timeout、并行度、累计结果与累计来源正文逐轴判断。provider usage 未返回时累计计费 input/output 两轴标为未评估，绝不估算；其余八轴继续执法。任一被评估轴到达限制时返回 `AGENT_BUDGET_EXCEEDED`，相关工具审计可为 `TOOL_BUDGET_EXCEEDED` 或 `TOOL_TIMEOUT` | 不把 `estimated` 填入 `ModelUsageV1`，不在 S4 生成产物、吞掉超限、改写绑定或让多个工具并行；真正的 Pi 停止、取消信号传播和 task terminalize 接线延后至 S3/S4 runtime 汇合 |
| 审计顺序、失败与 retry | 完整 trace 强制 `(attempt, call_order)` 严格递增、attempt 连续、同一 attempt 的 call_order 连续、总调用数有界；两次连续失败或同工具同类失败会封闭该 attempt。retry 仅通过新 attempt 表达，旧 attempt trace 保留。参数错误、范围拒绝、超预算、超时、取消和内部失败均只接受七值工具错误码 | 不改写 v7 行、不删除旧 attempt、不把工具码塞入任务错误码；storage 的幂等写入、结果落库和任务重试由 S3 runtime 后续以真实 store 验证 |
| renderer-facing preview fixture | 合成 preview fixture 仅公开工具名、相对时间、状态、七值错误、完整有界 audit 参数/返回值、来源引用和计数；默认折叠由 UI/UX 消费。fixture 标记 `preview_only=true`、`j22_evidence=false`、`j24_evidence=false`，并负扫描凭据、现场音频、音频路径、本地绝对路径、提示正文、内部思维过程、provider 原始事件、recipe ID、轮次上限和工具授权 | fixture 不进入 `.artifacts/`、`docs/validation/` 或任何联合证据；不新增 Agent IPC、preload、BrowserWindow、正式 renderer 或导出接口 |

即使上述纯 contract、fixture 与 core 回归全部为绿色，S4 状态最多为「实现完成·尚未验收」。只有 S5-Integration 将 S3 的统一 Agent Loop、真实个人上下文模块、v7 interaction store、S4 tool adapter/预算执法、正式 preload 与 Agent Bar 组成既有 J22/J24 后，才可按原旅程口径晋级；不得新增 `J22-S4`、`J24-tools` 或其它同义旅程 ID。

2026-08-31 的 S4 Core runtime 补充为「实现完成·尚未验收」：`ControlledToolRuntime` 只从私有冻结工具上下文投影提供 `search_context` 与 `read_sources`，拒绝范围外引用和取消后的读取；`ToolAuditRuntime` 从同一 contract 派生结果 digest、来源引用和计数，再经现有 v7 start/finish 命令写入 `(attempt, call_order)` 审计，并对单工具 timeout、在途取消与并行度上限 fail closed，迟到成功不再写入成功记录。`PersonalContextRuntime` 的默认 interaction adapter 同样委托这两个 gateway 命令，避免正式会话摄取路径静默失去工具审计。与 S3 执行宿主合并的定向 runtime/storage/integration 测试返回 0（29/29），组合旅程保留真实 storage worker/SQLite、模型运行 binding、interaction 与 v7 工具行，只替代 Agent 模型 provider。该补充仍未将完整十轴 Loop 观测、正式 IPC 或正式 renderer 接入，因此不构成完整 S4 或 J22/J24 联合验收。

### J21/J22/J24/J25/J26 的 S5 汇合边界

S3 的统一执行宿主 Core 子边界、S4 的 `read_sources` 与完整工具预算 Core 子边界、S5-Core 的窗口/IPC/导出与 S5-UX 的 renderer 必须在 S5-Integration 组合回既有旅程；不新增 `J22-ui`、`J24-agent-bar`、`J25-settings` 等同义旅程 ID。

| 交付来源 | 汇合前可证明 | 汇合时必须补齐 |
|---|---|---|
| S1/S2 | 个人上下文与模型接入 Core contract、exact IPC、脱敏 fixture | J21 管理 UI、J25 设置 UI 与真实 SQLite/`safeStorage` 往返 |
| S3/S4 | 统一 Agent Loop 路径、三档轮次上限与工具授权、取消终态、工具全序、预算和交互投影 fixture | J22/J24 的真实 Agent Bar → preload → Core 深模块 → SQLite → renderer 恢复 |
| S5-Core | `agent` BrowserWindow、sender policy、preload、保存对话框、canonical 导出 | 与 S5-UX 同一 renderer 组合，覆盖 reload、取消、失败、幂等和字幕系统独立边界 |
| S5-UX | 信息架构、状态矩阵、DOM/CSS/view-model、可访问性和 fixture preview | 移除预览 adapter；所有成功、失败与下一动作来自真实 snapshot/CommandResult |

> **2026-09-08 S5-UX renderer 局部记录（不提升 J22/J24 状态）**：正式 `src/agent` renderer 已从占位页收束为 exact `agent-run-ui@1.0.0` facade：先订阅 `agent-run:changed` 再读取终态会话范围/历史，资格快照决定提交可用性；纪要快捷操作与 QA 输入共享 `submit`，运行、取消、终态、结果栏目、来源引用和折叠工具调用记录均只由 CommandResult/detail 投影。`test/ui/agent-ui.test.js` 覆盖订阅顺序、空范围、无乐观成功、取消等待回执、changed 后活动详情刷新和隐私文案边界；窗口 close 与五窗交互角色也保持 least-privilege。该记录只证明 renderer 局部实现完成·尚未验收，不替代真实 preload/SQLite/Agent Loop 联合旅程；导出仍由 S5-Core 后续切片完成。

> **2026-09-08 S5-Core J26 局部记录（不提升正式 J26 状态）**：AgentInteractionExporter 由 main-owned AgentRunService 调用，只接收 interactionId，通过 StorageGateway.getAgentInteraction 构造并复核同一交互的终态、模型身份、recipe/input/result digest、ModelUsageV1、相对时长和 (attempt, call_order) 工具审计；canonical JSON 写入同目录临时文件并 flush/close 后原子替换，保存对话框取消不写入，失败/取消终态保持空结果。`test/main/agent-interaction-exporter.test.js`、`test/ui/agent-ui.test.js` 与 `test/integration/agent-redesign-s5-target-journey.test.js` 覆盖确定性重导出、隐私负扫描和真实 SQLite 读取；本记录仍为实现完成·尚未验收。

> **2026-09-09 S5 实现 revision `adcfa31` 集成证据（状态仍为实现完成·尚未验收）**：`test/integration/agent-bar-ipc-journey.test.js` 使用 production Vite renderer、真实 `preload/agent.js`/`preload/toolbar.js`/`preload/caption.js`、exact main IPC、`SessionCoordinator`、`StorageWorkerHost`/utility、SQLite、`HistoryService` 与文本导出，验证工具条 Agent 入口的打开/复用/聚焦/关闭、`provider_not_configured` 资格投影；该旅程在 provider 不可用检查前完成字幕启动/停止，随后验证 Agent 窗口关闭后已停止会话的历史和文本导出仍可读取，不把 provider 不可用与一条并发字幕故障旅程混为一谈。Electron/utility 子进程可运行环境下 `npm run test:integration` 返回码 0（82/82）；受限沙箱的 73/82 仅由 Electron GPU 启动边界导致，作为执行环境记录，不计作产品断言失败。
>
> 本地 `test/integration/agent-redesign-s5-target-journey.test.js` 保留真实 `StorageGateway`/SQLite、`ModelAccessRuntime`、user scheduler 与 Agent Loop，覆盖 `qa.answer`、`summary.minutes`、历史/详情、重复导出字节与 SHA-256、完整工具 args/results、取消和迟到 provider 结果拒绝；取消回执进入 `cancelling` 后由独立 recorder 关闭字幕并读取历史/文本导出，Schema 失败收束为 `failed` 后再由独立 recorder 关闭字幕并读取历史/文本导出，这些是 SQLite/local evidence，不是生产 `SessionCoordinator`/Agent Bar 失败保全旅程。该 deterministic provider 只属于局部证据。`test/integration/formal-agent-lifecycle-journey.test.js` 的真实 SQLite eligibility 旅程另验证 `agent_disabled` 策略下先关闭字幕、再读取历史与文本导出；真实 Electron Agent Bar 旅程验证 provider 不可用检查前的字幕启动/停止及随后已停止会话的历史/文本导出。worker replacement 仍由 `test/runtime/formal-agent-job-scheduler.test.js` 与既有 utility-process integration 证据负责，不归入本地 S5 目标旅程。包含这些旅程的 S5 受影响 focus 返回码为 0（30/30），`npm run test:core` 返回码 0（842/842），`npm run test:evidence` 返回码 0（229/229），`npm run verify:renderer` 返回码 0。tracked I3 非音频报告按 `TZ=UTC --segments 3600 --batch-size 100` 重建后通过 provenance/export 校验，仍保持 `result=pass`、`gateStatus=partial`，报告只含指标、布尔值和哈希。J21 生产后台摄取、完整 J25 设置/模型比较、J27 隔离入口 userData/SQLite 仍未形成完整产品旅程，当前证据不提升正式 J22/J24/J26 状态。

> **2026-09-09 J21/J25/J27 计划切片证据（状态均为实现完成·尚未验收）**：J21 的生产终态会话自动摄取与受治理交互信号已接入真实 `PersonalContextRuntime`/`StorageGateway`/`StorageWorkerService`/SQLite，由 `personal-context-runtime`、`agent-interaction-signal-service` 与 `personal-context-s1-journey` 覆盖自动路径、交互信号、冻结输入、失败隔离和字幕独立性；`agent-redesign-s3-session-ingest-journey` 保留为 J22/J24 的真实 SQLite 摄取、租约与 scheduler wake 子边界证据。J25 的正式 renderer 用量未知文案/`null` 用量边界由 settings/contract/UI 定向测试覆盖，`agent-redesign-j25-model-comparison-journey` 只宣称已知 provider 用量、缓存字段、完整冻结模型身份及 SQLite 历史比较，同模型重复运行不形成比较组；J27 的 `SubtitleApplicationRuntime` 正式数据库与真实 Electron 隔离入口使用互不相交的 `userData`/SQLite，require/打包排除守卫仍覆盖旧 Agent 树。当前 revision 的 `npm run test:core` 为 875/875，`npm run test:evidence` 为 229/229；J21/J25 定向 integration 通过，J27 定向 focus 在 Electron 子进程可运行环境下通过。完整 `npm run test:integration` 并行结果为 83/84，唯一失败为既有 Electron 边界矩阵超时，单文件重跑 6/6，因此不晋级任何正式 J 旅程或联合验收。真实公网 provider、系统凭据、正式设置→运行→历史入口、当前 revision 完整三条 lane、正式包与干净机证据仍是后续边界。I3 报告已按 `TZ=UTC --segments 3600 --batch-size 100` 重建，保持 `result=pass`、`gateStatus=partial`，只含指标、布尔值和哈希。

> **2026-09-10 J25 正式设置链路证据（状态仍为实现完成·尚未验收）**：新增 `test/integration/agent-redesign-j25-formal-settings-journey.test.js` 与受控 Electron fixture，使用真实生产 `src/main.js`、settings/Agent Bar renderer、`src/preload/settings.js`、`src/preload/agent.js`、main-owned Model Access/Agent Loop、StorageGateway/SQLite 和 history renderer；先在正式 settings 入口提交连接、model、用途与凭据，再从 Agent Bar exact preload 提交请求，重载正式 Agent Bar history renderer 读取同一 SQLite 终态交互。仅 provider 网络使用 loopback 控制 seam，报告只保留布尔值与计数，明确 `publicProvider=false`、`systemCredential=false`；这条证据不替代真实公网 provider、系统凭据或实机比较。

> **2026-09-10 `2cb663c` J21/J25 旅程证据（状态仍为实现完成·尚未验收）**：正式设置 fixture 已改为真实表单路径，提交 Agent 开关、连接、model 四组能力、凭据和默认用途，再从 Agent Bar exact preload/main 执行并在 history renderer 重载后读取同一 SQLite；同一旅程还验证个人记忆记住、忘记、删除、离开后重新挂载读取，以及 accept 信号和同一幂等键 replay。provider 只在 loopback 网络 seam 替代，报告只写计数、布尔值和固定标签。J21 的 `agent-redesign-s3-session-ingest-journey` 改用默认生产 personal-context execution adapter，真实穿过 `SqliteSessionRecorder` → `PersonalContextRuntime` → `ContextIngestSessionRunner` → `StorageGateway`/`StorageWorkerService`/SQLite；修复读取会话快照缺少 `sourceKind=session` 的 exact contract 缺口，并断言重复终态通知只形成一条运行、一条 active session episode，以及 raw/watermark/事件范围/digest 长度结构事实。受影响 focus 为 11/11，`npm run test:core` 为 880/880；按 `TZ=UTC --segments 3600 --batch-size 100` 重建 tracked I3 非音频报告后，`npm run test:evidence` 为 229/229，报告保持 `result=pass`、`gateStatus=partial`。受限环境下完整 `npm run test:integration` 为 75/85，10 项均为 Electron GPU/utility/renderer 启动或进程边界；J21/J25 单文件旅程通过。该记录不提升完整 J21/J25/J27 或正式 MVP 总门槛，也不替代公网 provider、系统凭据、干净机和实机证据。

> **2026-09-10 J27 打包基线（`cfdc5e4`，状态仍为实现完成·尚未验收）**：此前基线在 Electron/utility 可运行环境下执行 `npm run test:core` 880/880、`npm run test:integration` 85/85、`npm run test:evidence` 229/229；受限沙箱中的 GPU 启动异常单独归为执行环境边界。`npm run package:smoke` 后的 layout verifier 为 pass（smoke 439 个 ASAR 条目、5 个 native binary），packaged product-shell fresh/restart 两轮均为 `pass` 且 exact supervised exit 为 `clean-exit`；`npm run package:release` 生成 x64 NSIS，release layout verifier 为 pass（435 个 ASAR 条目、5 个 native binary、installer 存在但未签名）。指标与哈希已写入 [`docs/validation/j27-current-revision-results.json`](validation/j27-current-revision-results.json)。本轮 `2cb663c` 未重复打包，因此该证据仍不构成当前 revision 的干净机手动启动、真实公网 provider 或系统凭据边界验收，J27 与正式 MVP 总门槛保持未验收。

> **2026-09-11 J21/J22/J24/J26 行为修整场景登记（不改变旅程状态）**：正式 Agent Bar renderer 回归必须覆盖同一终态会话在首次读取、手动刷新与更高 `agent-run:changed` revision 后重新读取 Agent 处理资格，读取期间禁用提交，并拒绝旧范围/旧请求响应；范围目录与交互历史同时分页时各自完成、恢复 loading，全量刷新使两侧旧分页失效，追加范围按 `scope.kind + scope.reference`、追加历史按 `interaction_id` 去重。J21/J22/J24 的反馈场景覆盖同一交互刷新不清空编辑、跨交互草稿恢复、4096 字符与 20 条非空草稿上限、失败保留输入、同一轮双击单发送、未知回执后相同载荷复用幂等键、明确回执或载荷变化后换键，以及成功后再次主动提交使用新键。J24/J26 还覆盖取消、反馈、导出迟到回执不污染新选择，取消等待权威状态，导出取消零成功提示及固定中文错误/隐私文案。正式 Electron 旅程使用 production renderer/preload/main、个人上下文模块、Agent Loop、storage worker 与 SQLite，只控制外部 Agent 模型 provider，并通过正式 DOM 覆盖手动资格刷新、反馈提交和重新读取；报告只保留布尔值、计数和固定标签。上述均为本次实现与局部旅程目标，不推进完整三条 lane、正式包、干净机、真实公网 provider 或系统凭据验收。

> **2026-09-12 J21/J25 个人上下文控制旅程证据（状态仍为实现完成·尚未验收）**：正式 settings 旅程在个人记忆记住/忘记/删除后，通过 production renderer/preload/main、`PersonalContextController`、`ConfigStore`、`StorageGateway`/SQLite 验证个人记忆自动处理的休眠与重新开启；再以当前 revision 前一版请求验证 `AGENT_CONTEXT_REVISION_CONFLICT`，确认冲突不产生 SQLite/ConfigStore 写入。报告只保留休眠、重新开启和冲突布尔值，不写正文、凭据、设备名、绝对路径或音频。正式 Electron 旅程 1/1，受影响 focus 23/23，`npm run test:core` 895/895，`npm run test:evidence` 229/229；suppression 负矩阵、真实公网 provider、系统凭据、正式包、干净机与适用实机证据仍待门禁。

> **2026-09-12 J27 当前 revision 机械验证（状态仍为实现完成·尚未验收）**：`4fe62f7` 的 smoke 包 layout verifier 为 pass（439 个 ASAR 条目、5 个 native binary），release x64 NSIS 已生成；packaged product-shell 在 Electron GPU/utility 边界异常退出，未形成 fresh/restart 或 packaged run binding，故 release layout 不进入资格证据。当前三条 lane 为 core 895/895、integration 75/85（10 项 Electron GPU/utility/renderer 启动边界）、evidence 229/229。VMware inventory 有 2 个条目、当前无运行机，启动克隆需要外部加密口令。`j27-current-revision-results.json` 只记录计数、布尔值、固定阻断标签和哈希，不声称 userData/SQLite 隔离旅程、NSIS 安装、干净机、真实 provider 或系统凭据已验收。

设计稿、截图、fixture preview、Storybook 类预览、单独 renderer snapshot 或直接调用最终 exporter 均不构成确定性联合旅程。只有保留真实内部产品模块、仅替代已登记外部边界的 S5-Integration 结果才能晋级对应 J 旅程。

新增功能必须在本表增加或更新场景；模型设置向导、三家服务预设和独立模型测试归入 J25。J25 分为两段真实路径：配置/正式运行段继续贯穿 settings → preload/main → model-access → Agent Bar → SQLite/history；独立测试段同样使用真实 settings → preload/main → model-access，但断言不会调用 bind、不发 changed、不写配置/绑定/正式交互/个人上下文/历史/报告或响应正文，并覆盖 `success|invalid_request|revision_conflict|credential_unavailable|auth_failed|timeout|rate_limited|redirect_rejected|response_invalid|remote_unavailable|cancelled`。独立测试还必须覆盖 `cancelSavedModel`、窗口关闭/renderer 卸载、迟到 `testId` 丢弃、固定 `nextAction` 映射、revision 不一致时零网络请求，以及负扫描凭据、固定请求/响应正文、raw provider error、日志、IPC 调试输出和 `.artifacts`/`docs/validation`。v6 持久化初始化仍只创建 DeepSeek 空 model 模板；首次向导在 renderer 内额外展示 DeepSeek、OpenAI、通义千问（北京）三项未提交的只读预设草稿，不自动播种新模板。预设 `@1` identity/strategy 永久不可变，自定义模型固定为 `openai-compatible@1`；model row 与 formal binding 的策略元数据由追加 model-access migration 保存，既有 migration checksum 不改写。只有单元测试、没有对应用户旅程时，状态最多写“实现完成·尚未验收”。

> **2026-09-13 J25 模型设置增量证据（状态为实现完成·尚未验收）**：新增三项版本化预设 registry、策略元数据追加迁移、独立 agent-model-test-ui@1.0.0 contract/settings-only IPC/preload/runtime、正式调用鉴权失效和设置 renderer 首配四步 UI 旅程；定向 contract/main/runtime/storage/integration 与 settings renderer/style focus 已通过，完整 J25 settings → Agent Bar → SQLite/history、真实公网 provider、系统凭据、正式包和实机范围仍未形成新验收证据。独立测试覆盖固定策略字段、无配置写入、cancel/迟到 revision、formal/remote 鉴权失效边界和凭据/正文隐私负扫描；预设策略仅在精确 profile identity + canonical connection + model tuple 下生效，自定义 tuple 固定回落 openai-compatible@1。

> **2026-09-13 J25 竞态收敛补充（状态为实现完成·尚未验收）**：renderer 取消只发起取消并等待 main 的测试终态，provider 先到的 success/失败不会被取消回执覆盖；正式/目录鉴权失效清理同时校验旧 `credentialSlotId + profileRevision`，未知 `preset.*` 由存储边界拒绝。定向 UI/main/storage 负矩阵已登记，完整 J25 与真实 provider/实机范围仍待验证。

> **2026-08-29 Agent 设计替代说明**：下列 D9–D15 与旧 `agent-mvp-todo.md` 文字只保留为既有实现证据和迁移审计记录，不再定义正式 Agent 的产品行为或验收口径。可复用范围限于凭据隔离、utility 进程边界、租约/恢复、幂等提交和隐私负扫描；“三项自动任务”、动态插件宿主、`MemoryReader` exact query、调试聊天产品入口、完整提示/模型事件历史及 DeepSeek 专用产品配置均由 J13/J21/J22/J24/J25/J26 的新口径取代，后续实现不得依据下列历史文字恢复这些旧行为。2026-09-14 起，旧 Agent 源码树、专属测试/脚本与 15 个旧表由 ADR 0019 退役；退役备份/恢复/失败降级验证归入 J27 与 `retire-legacy-agent` change。

> **D9 / J24-B23/B26/B30 登记**：用一条确定性联合旅程把 main-only `AgentProviderConfigCatalog`、启动环境消费、公开状态投影、真实 `StorageWorkerService`/`FormalAgentStore` 与 SQLite 串联。表驱动覆盖缺失、空白、4096/4097 UTF-8 字节边界、Windows 大小写等价键及重复歧义键、配置表 unknown field/exact origin 漂移、删除早于配置校验、运行中注入不生效、子进程环境快照净化、调用副本在成功/异常后清零、鉴权失效后不可恢复，以及合法启动只冻结 `deepseek/deepseek-v4-flash` 并创建三项任务。该子边界不创建 `BrowserWindow` 或 Agent utility，不调用真实 DeepSeek，不得冒充完整 J24；相同输入分类合并进这一条旅程，不再新增逐字段单测。
> 当前 D9 子边界为实现完成·尚未验收：单条旅程进一步覆盖双并发凭据借用、借用中失效即时清零、配置表顶层/schema/provider 数量/预算漂移和 SQLite 凭据 canary 负扫描；定向 1/1（完整文件 13/13）、core 529/529、integration 65/65、evidence 226/226，I3 非音频报告保持 `partial`。这些计数不证明真实 child/Agent utility、stdout/stderr、正式 main/IPC 或 DeepSeek 公网。
> **D10 / J24-B03/B06/B10/B12/B23/B25/B30 登记**：把现有正式会后结构化纪要与三项后台 Agent 任务联合旅程改为统一经过真实 `AgentModelProviderRegistry → ModelGateway → Pi Agent Loop`，只在 Agent 模型 provider 外部边界注入确定性第一方适配器。旅程必须证明任务冻结身份只匹配 D9 `deepseek/deepseek-v4-flash` 快照，配置表预算与超时进入同一次绑定，只有项目自有 registry 实例可进入正式 Gateway，模型句柄拒绝 `apiKey`/credential/额外字段，同一受控取消信号覆盖模型打开与完整 Loop；凭据借用在顺利、408、模型打开阶段取消和无效输出后清零但保持可用，稳定鉴权失败则失效且不写产物。真实 storage worker、SQLite、PluginHost、job runner 与字幕事实均保留。已有相同风险场景直接升级内部路径，不复制成逐错误 registry 单测；另只保留一条鉴权失效联合场景。D10 不覆盖配置部署 B13，不创建 Agent utility，不调用公网，不接正式 main/preload/renderer，不能单独提升 J21/J24。
> 当前 D10 子边界为实现完成·尚未验收：三条升级后的正式联合旅程定向 13/13，core 529/529、integration 66/66、evidence 227/227；I3 非音频报告经安全生成器重建并保持 `result=pass`、`gateStatus=partial`。Luna/max 复核确认 exact 模型句柄、nominal registry、模型打开与 Loop 共用取消/超时信号及凭据失效边界；末轮指出公开绑定表旁路后已按要求私有化，并由定向 13/13 与最终 integration 66/66 复跑覆盖。该证据不包含真实 DeepSeek HTTP、正式 main/Agent utility、配置部署 B13、preload/renderer 或完整 J21/J24。
> **D11 / J24-B14/B23/B26/B30 登记**：用一条设置到任务对账的确定性联合旅程串联真实 `ConfigStore` v1→v2 migration、D9 `AgentProviderBootstrap` 非敏感公开事实、`StorageWorkerService`/`FormalAgentStore` 与 SQLite。旅程先从合法 v1 字幕配置迁移，证明字幕设置与单路来源选择保留而 Agent 设置采用首次默认值；再用 exact revision 更新开启 Agent 与个人记忆，证明旧终态会话为 `outside_automatic_window`、新终态会话为 `ready` 并创建三项同输入任务。随后覆盖陈旧 revision 零文件写入、关闭个人记忆只取消记忆任务、重新开启建立新个人记忆自动处理边界且不自动补处理关闭期间或更早会话，以及关闭 Agent 清空两个边界。通用配置 patch 和 Agent 设置请求必须分别拒绝 Agent 内部字段与 provider/URL/model/API key；代表性损坏 v2 组合只回落六个 Agent 字段，SQLite、配置文件与可扫描输出不得含凭据或 provider URL。相同边界合并进既有 config-store 测试与正式生命周期旅程，不新增逐字段迁移/验证单测。D11 不覆盖 J24-B13 provider 配置部署，不接正式 main/preload/renderer/Agent utility，也不调用真实 DeepSeek。
> 当前 D11 子边界为实现完成·尚未验收：ConfigStore 定向 9/9、正式生命周期文件 12/12、core 529/529、integration 65/65、evidence 227/227；I3 非音频报告经安全生成器重建并保持 `result=pass`、`gateStatus=partial`。integration 从 D10 的 66 条变为 65 条，是把两条重复边界场景合并为一条真实设置到任务旅程，不是能力覆盖减少。Luna/max 独立复核在补齐 v1→v2 持久写回与重启证据、三项任务共享同一 `InputReference` 断言并收紧 own-key 校验后确认 P1 无、P2 无；正式 main/preload/renderer/Agent utility、真实 DeepSeek HTTP 与完整 J24 仍未形成产品证据。
> **D12 / J24-B01/B04/B23/B25/B26/B30/B33 登记**：不新增一条与 D6 重复的 storage utility 测试，而把既有正式 utility-process 旅程升级为真实 `ConfigStore → FormalAgentRuntime → SessionCoordinator → MeetingStoppedPersistenceSink → SqliteSessionRecorder → StorageGateway → StorageWorkerHost/StorageWorkerService → SQLite`。音频入口继续使用无声卡的确定性 adapter，模型推理继续只替代 Agent 模型 provider；其余内部模块使用正式实现。旅程先在 Agent 总开关关闭时停止一条有已提交正文的单路会话并证明不建任务；再以 exact revision 开启 Agent、个人记忆与云端披露，先用非法本地模型就绪结果证明策略应用 fail closed、旧 ready/revision 清零和稳定诊断，再恢复当前策略。第二条会话取得持久 close 后立即强制收殓 exact storage child，并在通知恢复前开始第三条零正文会话；replacement 当前代次未确认任务策略时必须拒绝对账或领取，显式恢复先重放策略，再只为第二条会话创建共享同一冻结输入的三项任务。重复的同上下文 `MeetingStopped` 通知合并，第三条会话保持零任务。领取任务后再次强制收殓 exact child，第三代 storage worker 仍须策略先行，随后恢复同一 `runId`、三项任务独立提交且无重复领取。SQLite、配置文件和 stdio 继续执行字幕正文、路径、provider URL 与凭据负扫描。D12 不接正式 main/preload/renderer、Agent utility 或真实 DeepSeek HTTP；Agent job runner 仍直接使用 D6 replacement host，不能据此提升完整 J24。
> 当前 D12 子边界为实现完成·尚未验收：升级后的既有联合旅程定向 2/2，相关 `StorageGateway` 定向 14/14，core 529/529、integration 65/65、evidence 227/227；I3 非音频报告经安全生成器重建并保持 `result=pass`、`gateStatus=partial`。Luna/max 独立复核首轮发现 P1 1 项、P2 2 项；修复 readiness 清理、非法就绪结果收束、detached rejection、恢复上限与 storage worker 代次策略确认后，末轮 P1 无、P2 无。该批次没有新增同义测试；D12 本身未覆盖的 Agent job runner 完整 `StorageGateway` 路由已由 D13 另行闭合，正式 main/preload/renderer、Agent utility、真实 DeepSeek HTTP 与完整 J24 仍未形成产品证据。
> **D13 / J24-B05/B06/B07/B14/B25/B30 登记**：继续升级同一个 D6/D12 正式 utility-process 旅程，不新增 storage gateway 单测或第二条同义联合旅程。`AgentJobRunner`、`TranscriptReader`、`MemoryReader` 及两个 writer 全部接收真实 `StorageGateway`，父测试不得信任 scope 自报，必须由产品行为证明冻结字幕读取、个人记忆读取和两类提交确实跨越网关。旅程在恢复同一 `runId` 后，让确定性 Agent 模型 provider 已取得冻结输入时强制收殓当前 exact storage child；随后产物提交必须由网关等待旧 child 退出、创建 replacement 并以同一租约/提交身份重放，最终只有一个纪要产物。该 replacement 当前代次未确认任务策略时拒绝继续领取；显式恢复先重放策略，再运行个人记忆与增强文本任务，并通过正式 `MemoryReader → StorageGateway → storage utility/SQLite` 有界读回已提交候选。原有字幕事实、三项独立结果、同 `runId` 恢复及文件/SQLite/stdio 隐私负扫描继续保留。D13 不创建 Agent utility，不接正式 main/preload/renderer 或真实 DeepSeek HTTP，不能单独提升完整 J21/J24。
> 当前 D13 子边界为实现完成·尚未验收：升级后的既有联合旅程定向 2/2，相关 `StorageGateway` 定向 14/14，core 529/529、integration 65/65、evidence 227/227；I3 非音频报告经安全生成器重建并保持 `result=pass`、`gateStatus=partial`。Luna/max 独立复核在把 replacement 策略先行断言提升到真实 `AgentJobRunner.runNext` 入口并补齐 SEM-T15/J24-B05/B07 追踪后确认 P1 无、P2 无；仅保留 writer 提交前停止续租后，极慢 replacement 可能按 `AGENT_JOB_STATE_CONFLICT` fail closed 并等待显式恢复的 P3 风险。该批次未新增测试文件或同义测试；正式 main/preload/renderer、Agent utility、真实 DeepSeek HTTP 与完整 J21/J24 仍未形成产品证据。
> **D14 / J24-B05/B06/B23/B25/B26/B30 登记**：继续升级同一个 D6/D12/D13 正式 utility-process 旅程，不新增第二条同义联合旅程；B05 继承 D6 已有 claim/退出恢复边界，本批新增 provider 最终结果后退出覆盖 B06。真实 `AgentJobRunner` 留在 main 并继续使用 `StorageGateway`；main 侧正式 proxy 经 `TranscriptReader → StorageGateway` 读取冻结输入后，把 exact job、快照、受信任 provider 配置与单次凭据副本交给真实 Agent utility，utility 内必须运行正式 `AgentPluginHost → AgentModelProviderRegistry → ModelGateway → Pi Agent Loop`，且不得拥有 SQLite 或 storage 写端口。首个 utility generation 在确定性 Agent 模型 provider 已形成最终模型结果、尚未向 main 交付 `PluginResult` 时强制退出；父旅程必须捕获同一 child 和 provider-result 边界，证明该 run 进入 `retry_wait`、无产物、主凭据失效、同进程 fresh claim 返回空且不会用旧凭据自动 replacement。随后必须退出该 UI-free Electron main，由父测试以第二个动态启动凭据启动新的 Electron main；新进程重放任务策略并创建第二个 utility generation，恢复同一数据库内的原 `runId`。第二次启动保留 D13 的“utility 结果已返回、writer 提交前 storage child replacement”故障注入，最后三项任务仍独立且各自至多提交一次。父测试继续独立读取 SQLite，扫描两个动态凭据哨兵、字幕正文、provider URL、音频类、绝对路径与原始 Error/stack；报告只增加 generation/退出/失效等计数和布尔值。若独立复核发现 host 竞态或凭据生命周期缺口，只增加直接保护该进程边界的最小 runtime 回归，不复制完整联合旅程。D14 不接正式 preload/renderer 或真实 DeepSeek HTTP；两次真实 UI-free Electron main 启动证明 fresh startup 边界，但不证明带正式窗口的完整应用重启、完整 J21/J24 或实机验收。
> 当前 D14 子边界为实现完成·尚未验收：升级后的既有联合旅程定向 2/2，新增的 generation/凭据 fail-closed runtime 回归 2/2，core 531/531、integration 65/65、evidence 227/227；最终完整 `npm test` 为 823/823，此前短暂失败已由完整复跑收束。I3 非音频报告经 UTC 安全生成器重建，保持 `result=pass`、`gateStatus=partial`。Luna/max 登记复核为 P1 无、P2 无；实现复核首轮发现迟到成功竞态与环境污染未覆盖调用凭据清零的 P2 2 项，修复 generation 同步失效、pending 同步拒绝、迟到消息忽略、入口清零和 utility 异常退出后，末轮 P1 无、P2 无。确定性替身只位于 Agent 模型 provider 与故障注入外部边界，内部 main proxy、storage worker/SQLite、Agent 插件宿主、registry/Gateway/Pi、runner/readers/writers 均使用真实实现；正式 main/preload/renderer、真实 DeepSeek HTTP 与完整 J21/J24 仍未形成产品证据。
> **D15 / J24-B05/B16/B30 登记**：升级 D6/D12/D13/D14 的同一个 UI-free utility-process 联合旅程，不新增第二条同义联合旅程。main-owned `FormalAgentJobScheduler` 必须以真实 `AgentJobRunner → AgentUtilityPluginProxy → Agent utility → AgentPluginHost/registry/Gateway/Pi → StorageGateway/storage worker/SQLite` 运行，同一时刻至多一个逻辑领取；未知 claim 结果后的恢复必须复用同一个由 runner 拥有的冻结 attempt，已确定 receipt/空结果后才换新 key。旅程以 provider barrier 让一项 `deepseek/deepseek-v4-flash` 云端任务已进入真实 utility 内的 Agent 模型 provider 调用后，再由真实 `SessionCoordinator` 开始并停止一项新的无音频合成字幕会话；开始与停止均不得等待 provider barrier，释放 barrier 后原云端任务仍完成，三项任务继续共享冻结输入并独立、最多一次提交。父测试继续独立核对 SQLite 身份及文件/stdio/报告隐私，并把 scheduler observer、claim receipt 与异常诊断纳入正文、凭据、绝对路径和原始 Error/stack 负扫描。最小 runtime 回归只保护四项独立不变量：同一逻辑领取异常后复用 exact attempt、空扫描与 idle 交界唤醒不丢、retry timer 只由 generation 内最早到期值触发、`stop` 后 timer/wake 不再领取；不复制完整产品旅程。B18 多会话公平与 B25 设置/claim FIFO 继续沿既有 storage 证据，不由 D15 重复宣称；D15 不接真实 DeepSeek HTTP、正式 main/preload/renderer，也不实现或验收运行中本地任务的有界停止。

J15a 的容量保险回归必须填入超过 `KEEP_SEGMENTS` 的已定稿段，再向已移除旧段注入高于当前 source watermark 与原 revision 的迟到 `final`；live reducer、主进程 canonical fold 和同会话 reload 都必须保持该段墓碑化且视图一致。只用低 sequence 让 SessionCoordinator 在入口拒绝事件，不算覆盖这个失败路径。

J12 的证据隐私回归递归读取 `docs/validation/**/*.json` 的原始字节并严格解析：任何字幕正文键、可重建正文的 token 数组、音频文件名/扩展名、设备字段或本地位置字段都必须 fail closed。历史 Gate 0B 只保留数值和逐正文 SHA-256；被当前 Gate 0C schema-v2 取代的旧报告只保留退役哈希凭据。未来 Gate 0B 生成器另有 fail-closed 路径回归：正文中间件只允许进入固定且受忽略、拒绝 symlink/junction 的 `models/gate-0b/private/`，其他仓库位置全部拒绝；CLI 原始输出没有持久化选项；线程 sweep 普通输出及流式 benchmark 的文件/stdout 均只含 ID、指标与哈希。

## 4. 字幕、个人上下文与固定 recipe 联动的不变量

正式 Agent 实现个人上下文、增强文本、报告或交互导出前必须先冻结输入/输出契约，并让适用的 J3–J7/J13/J21/J22/J26 成为阻断测试。最低要求：

- 字幕上下文适配器与个人上下文模块默认只消费首次 `final` 形成的权威原始转写，不消费 `partial`；用户明确选择精修稿时，输入必须声明版本、水位和 digest。
- 同一 `segmentId` 的精修稿不得替换旧 `final`；重试或迟到结果不得制造第二份原始事实，也不得让同一段重复进入 Agent 输入。
- 每个个人上下文包和版本化产物都携带来源范围、水位、digest 与记忆 revision；跨会话请求还必须冻结精确来源集合，权威原文始终独立存在。
- `MeetingStopped` 默认只触发个人上下文摄取，停止会话不得创建纪要、增强文本或其它报告任务，也不得自动呈现报告。只有用户明确开启且默认关闭的报告自动呈现偏好，才允许从未来终态会话至多自动请求并非模态呈现一次纪要；报告历史只保留时间戳和提取后的关键信息，不维护未读状态、角标或计数。
- 增强文本只由用户在 Agent Bar 明确请求，并按冻结的完整水位整场生成；滚动逐段增强后置。
- Agent Bar 必须要求明确范围或给出可见默认范围；即时问答不自动成为报告，分析报告与规划建议必须显示来源范围和版本身份，规划不得执行外部写。
- 一个会话只有一个 `sourceId`；所有层都拒绝双路并发，来源切换必须先停止并创建新会话。
- pause/resume、worker replacement、重复 `MeetingStopped`、renderer reload 和重复呈现不得创建第二个个人上下文来源、同 `runId` 结果或报告呈现 receipt。
- Agent 系统关闭、超时或失败时，本地字幕、精修和会话存档继续工作；错误只影响 Agent 系统能力。
- 固定 recipe 不得获得 shell、进程、任意文件/网络/SQLite、外部服务写或递归委派能力；唯一受控写入由宿主把通过 Schema 与来源校验的结果提交到内部权威存储。
- 所有固定 recipe 运行都由同一个有界 Agent Loop 执行，不存在第二条执行路径、不存在运行期形态判定，也不存在 `escalation_reason`（[ADR 0016](adr/0016-unified-agent-execution-path.md)）。轮次上限与工具授权由 recipe 登记表静态给出并按 `recipeId + recipeVersion` 恒定：1 轮 0 工具（`intent.route`、`text.rewrite`、`text.translate`）；3 轮 `search_context`（`qa.answer`、`extract.items`、`summary.minutes`、`text.enhance`、`context.ingest.session`、`context.ingest.interaction`）；6 轮 `search_context`+`read_sources`（`report.analysis`、`plan.proposal`）。`supportsToolCalling` 只对工具授权非空的 recipe 是硬绑定条件。
- 意图收敛是模型优先加确定性规则兜底的两层机制（[ADR 0018](adr/0018-two-tier-intent-convergence.md)）。必须分别证明：`intent.route` 成功判定写 `routing_mode='model'`；资格不为 `ready`、五类任务错误码收束、以及返回闭集外 `recipeId` 三种情况各自回落规则并写 `routing_mode='rules'`；规则全部不匹配收敛到 `qa.answer`；用户取消不触发兜底；`context.ingest.*` 与自动纪要请求记 `preset` 且不创建 `intent.route` 运行。`intent.route` 的交互写入 SQLite 但不出现在交互历史与导出的列表投影中，删除用户交互时其配套 `intent.route` 交互一并级联删除。界面不暴露 recipe ID、confidence 或 `routing_mode`。
- 所有 recipe 运行都必须同时受十个预算轴约束：turn 上限（由 recipe 登记给出）、单次请求输入 token、按 attempt 求和的累计计费输入 token、按 attempt 求和的累计计费输出 token、wall-clock（用户主动请求取交互档、自动任务取后台档）、工具调用总数、单工具 timeout、并行度、累计工具结果字节，以及作为其子预算且必须严格更小的累计来源正文字节。token 只取 provider 返回的用量；缺失或 `usageReporting=false` 时 `ModelUsageV1` 为 `null`，累计计费输入与累计计费输出两轴当次不评估，其余八轴照常执法，运行仍由「轮次上限 × 单次请求输入预算」确定性地有界。任一被评估的轴耗尽以 `AGENT_BUDGET_EXCEEDED` 收束，不得静默截断，也不得为了凑满预算而估算 token。
- 工具错误码是独立于任务错误码的七值闭集（`TOOL_ARGS_INVALID`、`TOOL_SCOPE_DENIED`、`TOOL_NOT_AVAILABLE_FOR_RECIPE`、`TOOL_BUDGET_EXCEEDED`、`TOOL_TIMEOUT`、`TOOL_CANCELLED`、`TOOL_INTERNAL_FAILURE`）；同一 attempt 内连续两次工具失败必须终止该 attempt。
- 文本只有三层边界：个人上下文包与权威转写是唯一知识库，工具调用记录的 args/result 是有界审计证据，模型输出是生成物；不得用审计证据充当第二份可检索知识库，也不得让生成物冒充来源事实。
- 范围不可扩大：模型不得通过工具取得冻结个人上下文包范围之外的内容；工具只读、不产生交互记忆信号、不反向写入个人记忆；有界分页不等于截断，命中上界必须写入省略标记；后台摄取按其登记的工具授权使用 `search_context`，但同样不得越出冻结个人上下文包的范围；失败一律零部分产物。
- 范围解析以会话内粒度剔除未定稿内容，只有会话非终态、无已提交正文或触发预算时才整场排除；省略标记必须同时出现在结果的 `gaps`/`openQuestions` 与导出中。
- 取消是协程式终态：请求取消后在下一个可观察检查点收束，保留已发生 attempt 与工具调用记录，标明终态理由，不留部分产物。
- 正式 Agent 交互终态历史只保留时间戳、范围/模型身份、最终结果和按 `(attempt, call_order)` 全序的完整工具调用记录；重试建立新 attempt，旧 attempt 的记录一律保留，不得删除、覆盖或合并。原始提示在交互记忆信号提取后清理，模型在工具调用之外产生的中间 assistant 文本、内部思维过程、`reasoning`/`reasoning_content` 和 provider 模型事件流不得持久化，只在内存中作为本次运行上下文。工具接口预算内的完整参数/返回正文必须逐字段持久化到本地交互审计，默认折叠、可明确展开、随交互级联删除，且不得复制到日志、报告、个人记忆或测试证据 JSON。
- 每个终态正式 Agent 交互允许用户明确导出 canonical、带 schema 版本的 JSON；导出包含最终结果、recipe/input/终态身份、模型运行绑定、`ModelUsageV1`、可空缓存命中率、相对时长和完整工具调用记录，不受 UI 折叠状态影响。取消终态同样可导出且不补造结果；renderer 只提交交互 ID，main 保存对话框拥有目标路径；取消或失败零部分文件，相同内容重导出字节一致，且导出不包含任何金额字段。
- Agent 模型接入层首版只实现 OpenAI-compatible 生产 adapter，首次初始化提供 DeepSeek 空 model provider 模板并允许多个用户档案/model；通过精确 `(profileId, modelId)` 和四个模型用途建立不可变绑定，内部 recipe 映射不向普通用户暴露。自动重试不得换模，主动换模型创建新 `runId`；凭据按档案由 `safeStorage` 管理且不向 renderer 读回。模型比较只使用模型身份、input/output token、缓存命中率和相对时长；用量未知的交互只能按相对时长比较，不得用估算值补齐。
- 只有正式 Agent 交互中的提示、明确编辑、接受、拒绝、“记住”和“忘记”可以形成交互记忆信号；普通点击、停留、滚动、浏览、调试聊天和未采纳模型输出必须保持零记录。

## 5. SQLite、Agent 消费与后置索引测试边界

B3.3 开始，数据库联合测试必须使用临时目录中的真实 schema、真实事务、真实投影与真实 storage worker 接线；不允许用内存 Map 或 repository mock 替代 SQLite 后仍宣称数据旅程通过。

- 同一字幕事件重复提交必须返回幂等结果，`caption_events/segments` 的有效数量不变；个人上下文摄取与用户请求任务沿 ADR 0008 的可靠消费原则验证终态会话 durable reconciliation，不创建 `outbox_jobs`。
- 在字幕事务提交前注入失败时事件与投影都不可见；提交后 worker 崩溃时二者都可恢复。个人上下文摄取或用户请求任务创建失败不回滚字幕事实，恢复扫描从终态会话、正式交互信号及完整输入身份补建缺失工作。
- durable reconciliation 必须覆盖进程退出、重复扫描/领取、租约过期、迟到 refined、正文版本隔离和跨会话隔离；摄取工作使用确定性 dedupe key，用户请求使用 client idempotency key，报告呈现使用独立 receipt，任何去重失败都不得制造多个“当前”产物或重复弹出。
- X1 之前不安装或加载 `sqlite-vec`，也不以 J11 阻断 SQLite 历史。
- X1 启用后，refined 提交必须使旧 embedding 立即不可服务，且删除索引后可从 segments 重建。
- 迁移测试必须覆盖坏尾行、坏中间行报告、重复文件、同秒同名会话、中途退出重跑，以及遗留 `translated` 被报告但不进入字幕事实/原文 digest。

详细数据门禁 DB0–DB6 见 [`data-architecture.md`](data-architecture.md)，规范语义对应 SEM-F00、SEM-F07、SEM-F10、SEM-F11、SEM-F14–F19、SEM-T08–T12。

## 6. 当前 CI 基线

`.github/workflows/ci.yml` 使用 Windows runner，因为项目依赖 Windows x64 的 sherpa-onnx 预编译包。workflow 使用锁文件安装依赖，随后必须显式安装并校验锁定的 Electron runtime；只有 `electron.exe` 存在且版本匹配后，才执行隐藏字幕窗的真实 Chromium 布局资格，再以隐藏、无窗口 Electron main 执行 DB0 资格。随后通过生产 `StorageWorkerHost → utilityProcess → WorkerService → SqliteSubtitleStore` 跑 DB1 基座，并以 `SessionCoordinator → SqliteSessionRecorder → StorageGateway → StorageWorkerHost → utilityProcess → SQLite` 跑 loopback/mic、pause/refine、stop barrier、空闲退出和提交前/后故障重放并动态校验报告。接着启动真实 `src/main.js` 和四个 renderer，从隔离 userData 的资源 `missing` 状态经 settings DOM、受限 preload/IPC、生产 ModelManager、受控 HTTP Range 与固定 System32 tar 完成临时字幕识别器、权威识别器与 VAD 三项核心 marker 供给；精修资源保持独立、默认关闭且只由明确动作供给和启用。产品壳随后完成工具条开始→final DOM→暂停/恢复→停止→本次 SQLite 历史→205 段历史五页往返→资源页→正常退出并验证结构化报告。

同一 workflow 随后构建与正式包共享 ASAR/native/fuse 布局的 test package，从真实 packaged exe 连续跑首启与同 `userData` 复启；首轮覆盖核心/精修分层、会话冻结、故障回退/工具条会话状态通知、跨会话版本导出与迁移，第二轮不启下载服务且 fetch=0，并复读两组 ready、偏好、历史和故障事实。两轮 utility 都从 ASAR 加载 native/SQLite，supervisor 要求 packaged scope、clean exit、0 incident。runner 生成唯一 run ID，并把四份报告 SHA 与完整 `src/` 产品载荷 SHA 写入 binding；正式 release layout 必须与该载荷完全一致。最后生成精确正式 NSIS，验证 x64、168 个 ASAR 条目、114 文件产品载荷、29 个关键入口、负扫描、5 个 native 和 Authenticode 状态，再隔离安装/卸载并验证无关 APPDATA 哨兵不变；应用未启动且真实 userData 路径未观察。随后 `npm run test:ci` 只执行一次 core→integration→evidence（含 I3 非音频预资格），全部前置步骤成功后才写 CI provenance 索引；索引 fail closed 要求实际 checkout revision 等于触发 `GITHUB_SHA`、受跟踪工作树干净，并绑定 run ID/attempt、workflow/job、lockfile/workflow digest、installer 和关键资格报告 SHA。物理设备、真实模型性能、DWM/权限/交互安装、SmartScreen、真实两小时与 J9-I4 仍不得由 CI 冒充。

2026-08-03 revision `b96b8fe7db5ba4db3ac36c4ee85371a4381b521f` 的本地确定性基线为 core 414 tests=407 pass+7 expected skips、integration 27/27、evidence 184/184；总计 625 tests=618 pass+7 expected skips+0 fail；精确证据投影 revision `efccfeda4cb66ff74da23c747f6c4af3495b9659` 新增一项五轮 `loopback` 重建测试后为 626 tests=619 pass+7 expected skips+0 fail。I3 双重冻结修复 revision `82d56f64c80c74f30c1944665460f1316f1d7939` 加入 runner 契约后为 627 tests=620 pass+7 expected skips+0 fail；tracked 75 秒资格报告及导航契约更新后为 628 tests=621 pass+7 expected skips+0 fail。LF 修复 revision `f86ac1ef604dc7da0728c6eda44d59bbfd1e09bf` 加入 I3 live 全 provenance 输入契约后，本地基线为 core 414 tests=407 pass+7 expected skips、integration 27/27、evidence 188/188；总计 629 tests=622 pass+7 expected skips+0 fail；run `30787209338` 的完整 workflow、provenance 绑定与 artifact 下载复核均成立。本次 I2 模型替换决策新增逐轮算术与跨文档投影两项 evidence 契约后，本地基线为 core 414 tests=407 pass+7 expected skips、integration 27/27、evidence 190/190；总计 631 tests=624 pass+7 expected skips+0 fail；run `30790372286` 在精确 revision `5c6ce847fc07329802e3e98db9db70cc683f1f75` 上的原始日志精确记录：workflow 结论为 `success`；core 414 tests=407 pass+7 expected model/Silero-asset skips，integration 27/27，evidence 190/190；总计 631 tests=624 pass+7 expected skips+0 fail。7 项跳过不计作模型测试成立；同轮形成可下载 provenance artifact，下载复核闭合。另有同 revision 的 `caption-layout-report@v2` 真实 Chromium 布局资格 15/15 场景、16/16 不变量，包含 identity-only 视口淘汰回报、容量保险墓碑及迟到高版本 `final` 不复活，报告边界仍明确保持 `humanVisualReview=false`、`dpiMatrix=false`、`audioCapture=false`。可见 DWM 资格基础设施的 9 项契约测试、I2 schema-v2 恢复报告的 10 项契约测试和 I4 音频 child/strict summary/六项载荷移交包的 11 项契约测试均已计入 evidence；由于当前尚无 36 组合人工观察矩阵、实际设备移除/系统睡眠报告或 I4 专用干净机三份 child 报告，这些场景仍为实现完成·尚未验收。run `30784483976` 精确绑定 I3 修复代码候选 revision `82d56f64c80c74f30c1944665460f1316f1d7939`，全部 workflow steps、627 项回归、provenance 绑定与 artifact 上传返回 `success`；下载 artifact（ID `8844827701`，ZIP digest=`78227ef5…daca`）随后通过五个 strict readers、四份报告与 lockfile/workflow SHA、跨报告绑定及 41 文件/29 JSON 隐私负扫描，该精确 revision 的 J9-CI 已达到联合验收完成。下载包不含 installer 字节，同轮 workflow 已在索引生成前复核远端 installer SHA `bdac65ed…a7c4`。后续 run `30786324179` 精确绑定 revision `c36aefaee4778a1bf2dfe1ee005924a724f4be53`，但因 I3 live playback HTML 缺少 LF checkout 规则在 evidence lane fail closed，未形成新 provenance 索引。最新 J9-CI 精确候选、artifact 身份与边界见本节 J9-CI 行及 SEM-T03。Windows 系统 `tar.exe` 与 Electron child 在受限沙箱内可能被 `EPERM` 拒绝，相关 lane 必须在允许启动这些精确子进程的 Windows runner/本机运行；这属于执行环境前提，不能把沙箱失败计作产品断言通过或失败。

2026-08-07 对齐复核以 revision `a91a200cc2d3df5f73dcb7a0894a9758e532106a` 为代码与 evidence 基线：Gate 0B 三候选严格汇总及其失败路径回归把 evidence 增至 200 项；在允许启动 Windows `tar.exe` 与 Electron 子进程的本机环境中，core 414 tests=407 pass+7 expected skips、integration 27/27、evidence 200/200；总计 641 tests=634 pass+7 expected skips+0 fail。受限沙箱内只出现 3 项 `tar.exe EPERM`，按 SEM-T03 属执行环境前提。最近一次可下载 J9-CI 联合验收完成基线为 run `30792514100` / revision `2890dd9a5a224bca75cff2257cfd14013d74584d`：core 414 tests=407 pass+7 expected skips，integration 27/27，evidence 190/190；总计 631 tests=624 pass+7 expected skips+0 fail。artifact ID `8847650958`、GitHub ZIP digest `9e4b2d7b9975afc288c5a14728e0a8812ec00eea1f6a25f46080063c8beccafd`，下载侧五个 strict readers、四份报告与两个源码 digest、跨报告绑定及 41 文件/29 JSON 隐私负扫描闭合；索引绑定 installer SHA `25ff62a88efb8e8d021887df3a2685c72515baadca23f4810902f13d2ae19b76`，下载包不含 installer 字节。当前 revision 的 run `30801570384` 已通过 Electron、布局、存储、产品壳、packaged 与 NSIS 前置，但 evidence 200 tests=197 pass+3 fail，最终 provenance 索引按设计跳过；3 项失败均由 Gate 0B corpus binding 漂移触发，根因是 `scripts/gate-0b/corpus.json` 缺少 LF checkout 规则，hosted CRLF SHA `fdf4420a243cc6e0efe0074dbf5c60c97efc1d1284448b7bfce9c3d658e1fce9` 与登记的 LF SHA `7edd6dff286b84619a3b68f385ba04622103ffe17cc57dbe5e1f16521deb156d` 不同。因此当前 revision 的 J9-CI 为实现完成·尚未验收。产品载荷输入自 `2d3d6bdf5d745c15c239ef7503a0dfac211409a8` 起未变化，本机 B5 七份证据仍绑定当前产品载荷；这不改变 J15a 可见矩阵、I2、I3 或 J9-I4 的实机边界。

2026-08-07 当前确定性基线已前移到 revision `bbfd7041e5963e51942392323735298a7b81cb30` / run `31191838016`：core 422 tests=415 pass+7 expected model/Silero-asset skips、integration 29/29、evidence 204/204；总计 655 tests=648 pass+7 expected skips+0 fail。workflow 的布局、DB0/DB1/Gateway、schema-v4 四资源产品壳、packaged 首启/复启、exact NSIS、隔离安装卸载、回归、revision 绑定与 artifact 上传均有对应证据，该确定性范围达到联合验收完成。artifact ID=`8999273285`、GitHub ZIP digest=`5ce4070cee109df6d3d86b43b165b20a40636e8e3cd638fd9f28096da95855af`，索引绑定 installer SHA=`d77d16c00337696727e00ad41d3fc61e1eab85d99edc4527c7cf55b548e0060c`、产品载荷 SHA=`e95fd87f8af1e46e50745d8fb541d337bab783905202120df4d92e579beea35a`。7 项跳过不计作模型测试成立；本轮按项目负责人要求不执行采集、播放、WAV 推理或模型推理，因而不改变可见 DWM、I2、I3 或 J9-I4 的实机边界。

2026-08-08 J18 本地候选确定性基线为 core 455/455、integration 30/30、evidence 216/216，总计 701 tests=701 pass+0 fail；每条 lane 的前置均重新执行 TypeScript 检查与 Vite 生产构建。受跟踪 I3 非音频报告已按当前产品载荷重新生成，保持 3,600 段、4,000 事件、72 页、`result=pass` 与 `gateStatus=partial`。该本地计数用于 J18 联合证据核对，不是新的远端 J9-CI provenance，也不改变 J15a/I2/I3/I4 的实机边界。

2026-08-10 SEM-F29/J23 隔离入口本地确定性基线为 core 507/507、integration 39/39、evidence 227/227，总计 773 tests=773 pass+0 fail；integration 保留真实 Electron、React renderer、preload/exact IPC、两个 utility process、`AgentPluginHost`、任务调度、storage worker 与候选 SQLite，只在登记的外部边界使用确定性替身。Luna/max 独立复核为 P1 无、P2 无。该基线支持 J23-B01–B16 达到联合验收完成，不是远端 J9-CI provenance，也不改变正式 J21/J22/J24 或 I2/I3/I4 状态。

当前 J1/J2/J4/J5/J6/J12 的确定性基线位于 `test/integration/caption-session-journey.test.js`。它已使用生产 `SqliteSessionRecorder → StorageGateway → StorageWorkerService → SqliteSubtitleStore`，不再创建旧 JSONL 权威档；J1/J2 只在 ASR/设备边界注入合法 CaptionEvent。J4 构造真实 `RealtimeRuntimeAdapter → RealtimeWorkerHost + AudioHostController`，只替代 Electron utility/隐藏宿主/物理声卡；J5/J6 执行暂停/refined、worker 退出、retry/游标恢复和同会话 SQLite 持久化。J12 检查数据目录无音频文件。旧 JSONL 测试只保留迁移解析、投影和共享导出兼容性。

`test/integration/product-sqlite-lifecycle-journey.test.js` 是默认产品组合根的 DB2/J10/J12 旅程：真实 `SubtitleApplicationRuntime → JsonlSqliteMigrator → StorageGateway → WorkerService → SqliteSubtitleStore → SqliteSessionRecorder → SessionCoordinator` 围绕同一 userData 运行两次冷启动，仅用 service-backed host 替换 Electron 进程边界。它断言 crash 遗留 active 会话先收束、旧 JSONL 后迁移、mic/loopback 只单路运行、partial 不落盘、每段最早有效 `final` 作为权威原始转写且遗留 `refined` 作为独立精修稿并存、退出写 interrupted、第二次迁移幂等、没有新 JSONL 或音频文件。

`test/integration/history-review-journey.test.js` 是 J1/J2/J4/J12 及 J8 加速前置：真实 `SessionCoordinator → SqliteSessionRecorder → StorageGateway → WorkerService → SqliteSubtitleStore → HistoryService` 完成 mic/loopback、205 段 keyset 分页和完整导出。packaged 产品壳再覆盖真实 BrowserWindow/React DOM/IPC、旧档迁移、5 页往返与 renderer→preload→main 导出写入；保存路径选择仍用受控 `showSaveDialog` 替身。I3 非音频 runner 直接挂载真实 React 字幕历史 renderer 并遍历 72 页/3,600 段；人工系统保存对话框、真实两小时音频与 I4 留待实机。

`scripts/i3-nonaudio-soak.js` 是 I3 的确定性非音频预资格：默认 3,600 段、每 9 段一次 refined，共 4,000 事件，以 2 秒/段编码 7,200,000ms 虚拟时间。`FakeRuntimeAdapter` 只注入契约合法 CaptionEvent，存储使用同进程服务宿主；runner 批量穿过真实 Coordinator/Gateway/SQLite，重开数据库后用真实 HistoryService 和 React 字幕历史 renderer 翻 72 页、导出 TXT/MD/SRT，并报告 CPU、RSS/heap、队列、WAL 与查询 P95。严格 verifier 要求 `result=pass` 但 `gateStatus=partial`，并要求 mic/loopback/speaker/真实两小时/BrowserWindow 全为 false；因此它只关闭非音频资源与恢复风险，不关闭 I3 实机门禁。

`test/integration/model-install-caption-journey.test.js` 是 J14/J12 的模型闭环旅程：真实 `ModelManager → loopback HTTP → Windows System32 tar → SessionCoordinator → SqliteSessionRecorder → StorageGateway → WorkerService → SqliteSubtitleStore → HistoryService` 从保留 `.part` 续传，安装三项固定结构资源并空闲热启用；只有真实张量/ASR 和 Electron utility-process 被替代。随后执行 mic 单路 start/final/stop，断言活动替换拒绝、终态历史可见、状态不泄露 URL/hash/path 且模型/数据目录零音频。批准资源的真实大归档与调用由 `scripts/model-install-live-smoke.js` 留档；`scripts/product-shell-smoke.js` 则作为 Windows CI 与本机都可复跑的真实 Electron 壳层旅程，两者的边界见 [validation/b4-model-and-product-shell.md](validation/b4-model-and-product-shell.md)。

I2 实机入口 `scripts/i2-live-caption-smoke.js` 必须显式传入且只接受一个 `--source loopback` 或 `--source mic`，两次运行不得并发。schema-v5 child 包含实际播放起止、冻结语料估算语音起点、匿名输入/输出标签绑定、字幕到达时序、Electron CPU/工作集、audio-host 队列/丢帧、worker 缺口、CaptionEvent 边界丢弃计数，以及 exact accepted-partial 的跨时钟六段诊断，且不包含字幕正文、PCM、现场音频文件、音频路径、绝对单调时刻或时钟偏移。operator 朗读仍可用；自动 mic 模式读取同轮 Gate 0C memory-only 报告并绑定其精确 SHA，以唯一 label SHA 匹配输入并绑定输出标签。该 `physical-preferred-label-heuristic` fixture 只能防预检后静默换标签，不是硬件证明，也不能排除未知或伪造标签的虚拟设备。语料 WAV 由受跟踪的 generator/reference 本地生成且被忽略；child 同时绑定 WAV 与 reference digest。

`scripts/run-i2-live-series.ps1` 对每来源固定跑 5 轮。每轮先严格验证 schema-v5 child；外部 runner 随后只有在其启动的 exact Electron child 自然返回 exit code 0、且未由 runner 终止时，才用 `write-i2-exact-child-exit.js` 生成绑定该 report SHA 的 schema-v1 sidecar。`summarize-i2-live-series.js` 只接受恰好五组有序、唯一且来源/摘要匹配的 report+sidecar，并生成、自校验 schema-v6 确定性 summary。原始 UTF-8 JSON 在对象校验前即拒绝 BOM、非法编码、重复键（包括转义后等价键）、非有限数值和尾随输入；Gate、child、sidecar 与 summary 随后都走闭合字段验证。

I2 child 必须先解析受批准精修模型，再同时把会话配置的 `refinementEnabled` 与运行时能力的 `refinementAvailable` 冻结为 `true`；模型缺失必须 fail closed，不能用报告中的模型 ID 代替真实启用证据。固定尾静音窗口结束后，若首次稳定转写已出现但精修稿尚未出现，则最多额外等待固定 15,000ms 的真实 offline refine 回包；上限使用单调时钟，回包到达即继续 Stop。观察一旦超时必须冻结失败事实，随后 Stop 冲刷期间到达的迟到精修稿不能消除 `refined-caption-missing`。这个有界观察窗不参与冻结字幕可见延迟计算，也不得移动 `source t0 + 140ms`、首个已接受 partial 或 `<1000ms` 门槛。契约测试必须锁定双重冻结、模型缺失失败、单调 15,000ms 上限、早到立即继续，以及超时后 Stop 迟到精修稿仍保留失败枚举。

revision `b96b8fe7db5ba4db3ac36c4ee85371a4381b521f` 的受跟踪补充证据位于 [`validation/i2-live-b96b8fe-loopback/`](validation/i2-live-b96b8fe-loopback/)：恰好五组 schema-v5 child + schema-v1 exact-child exit sidecar，以及一份可由这些精确字节重建的 schema-v6 summary；summary SHA-256 为 `2a365e3c6a1075336b9c7df65ad5b3ca36094a991d5b68532d15e65556ab1b48`。该补充只证明同一精确 revision 的 `loopback` 精修组合、准确率、自然退出、零损失与报告隐私；冻结 P95=1242ms 仍超线，且没有同轮 `mic` 或交互恢复报告，因此不替代下方两来源权威 bundle，也不改变 I2 的实现完成·尚未验收状态。

同批五轮的逐轮 trace 与 Gate 0B 同语料裸模型结果已经触发模型替换决策：最慢 child 的 1242ms 可精确拆为 814/400/0/27/0/1ms；其 `audioNeededAfterCapturedOnsetMs=776.562`，扣除该模型音频时长与触发后 28ms 后，当前采集/VAD 前置观察值为 437.438ms。仅在保持该轮已观察组合时，要满足冻结 `<1000ms`，模型音频需求必须低于 534.562ms。Gate 0B 的 `zh-en-code-switch` 裸模型观测最大音频需求为 660ms、首个临时字幕 P95=697.4775ms。该比较不是物理下限证明；它只用于决定停止本轮参数微调并重新开启 Gate 0B，不把区段改作验收值，也不声称已经选定替代模型。新的候选必须先完成同一语料的模型门禁，再重跑 J1/J2 各五轮 I2。

本轮 Gate 0B 已登记但尚未批准的 `evaluation-only` 候选是官方 large bilingual Zipformer：资产 `sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2`，固定 URL 归属 `k2-fsa/sherpa-onnx` `asr-models`，字节数 `511274346`，本机下载 SHA-256=`27ffbd9ee24ad186d99acc2f6354d7992b27bcab490812510665fa8f9389c5f8`。候选门禁继续使用 `scripts/gate-0b/corpus.json` 的四条冻结语料：官方 CLI 给出选择级 RTF 与内容质量，内容质量相对当前生产受控基线要求 macro CER 不高于 `0`、英文 WER 不高于 `0`；Node N-API 对每例执行 5 轮、40ms 墙钟喂帧并记录首个临时字幕、处理 RTF、模型加载和正文 SHA。含正文中间件只允许位于受忽略的 `models/gate-0b/private/`。结果必须同时满足 CLI RTF `<0.60`、四例首个临时字幕 P95 `<1000ms`，并显式比较 `zh-en-code-switch` 的观测音频需求与条件性 `534.562ms` 工程筛选值；该筛选值不是冻结字幕可见延迟门槛。实时模型标点仍由用户明确启用的可选精修补齐，不作为本次替换门槛。候选进入生产选择前，`src/main/services/model-manifest.js`、J14 下载预算和 ready marker 均不得改变；若候选证据成立，后续另行登记并重跑 J14 首次供给/Range 续传/离线复启和两来源各五轮 I2。

large bilingual Zipformer 的最终 registry 绑定同机结果是：CLI max RTF=`0.17`、首个临时字幕 P95 最大值=`630.5279ms`、`zh-en-code-switch` 观测音频需求最大值=`300ms`，但 macro CER=`0.05998168498168498`、英文 WER=`0.1111111111111111`，所以保持 `evaluation-only`，不改变生产候选。第二个已登记但尚未批准的候选是官方 streaming Paraformer bilingual：资产 `sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2`，字节数 `1047319737`，SHA-256=`5462a1fce42693deae572af1e8c4687124b12aa85fe61ff4d3168bb5280e205f`；只解出 `encoder.int8.onnx`、`decoder.int8.onnx` 与 `tokens.txt`，不解出上游 WAV 或 fp32 文件。它沿用相同四条语料和全部门槛，并将归档相对当前生产实时模型的 `913421730` bytes 增量显式计入 J14 取舍；候选门禁成立也只表示可进入后续生产选择，不替代 J14 或两来源各五轮 I2。

bilingual Paraformer 的最终 registry 绑定同机结果是：CLI max RTF=`0.29`、首个临时字幕 P95 最大值=`588.0249ms`、混说观测音频需求最大值=`500ms`，但 macro CER=`0.024267399267399264`、英文 WER=`0.4444444444444444`，所以仍不进入生产选择。官方在线目录中最后一个覆盖中英且尚未实测的候选登记为 streaming Paraformer trilingual：资产 `sherpa-onnx-streaming-paraformer-trilingual-zh-cantonese-en.tar.bz2`，字节数 `1047671211`，SHA-256=`d479167d8752628d9032d29de1060493865389d1e295a1c2e8e011e7062f1932`，J14 归档增量 `913773204` bytes；它沿用完全相同的三文件 allowlist 和候选门禁。中文-only、英文-only 与 online CTC 中文模型不进入本轮冻结中英候选矩阵。

trilingual Paraformer 的同机结果是：CLI max RTF=`0.27`、首个临时字幕 P95 最大值=`575.8275ms`、混说观测音频需求最大值=`500ms`，但 macro CER=`0.21543040293040294`、英文 WER=`0.3333333333333333`。因此三个新登记候选均保持 `evaluation-only`，未选定替代实时模型；结合既有 small bilingual 质量失败与当前 `x-asr-160ms` 产品链路延迟未达线，本轮当前 sherpa-onnx runtime 可直接部署的官方在线中英候选矩阵已经逐项留证。严格汇总 `gate-0b-realtime-candidate-summary.json` 绑定 registry SHA-256=`d202c018aa295e5d1859765c1856dab7509280ad7dfcf96c601e1657b48bdcac`，自身 SHA-256=`682d71b5bb8ff7851ceec15e0673bf52943cc74ca9611f9617306d18c4c08a1f`；evidence lane 从三份内嵌脱敏评测重建 `no-eligible-candidate`、0 个 eligible ID、替代候选为 null、生产 manifest 未变，并 fail closed 拒绝错绑、未知字段、正文或指标漂移。生产 manifest/J14 不变，后续需要另行登记新模型或识别架构；不得改动 I2 的 `<1000ms`、`source t0 + 140ms` 或内容质量边界。

权威 bundle 是 [`validation/i2-live-v5/`](validation/i2-live-v5/) 中 SHA-256 为 `0f9f7668751c64fbce922883421ead41680226126800e0b7f6b3da81b39840ef`、runId 为 `gate-0c-2026-07-31T09-52-00-521Z`、执行时间为 `2026-07-31T09:52:13.999Z` 的精确 Gate 0C preflight，以及 loopback/mic 各 5 个 schema-v5 child、5 个 schema-v1 sidecar 和一份 schema-v6 series。CI 从 Gate、10 个 child 与 10 个 sidecar 重建两份 series，并要求与 tracked series byte-for-byte 相同。sidecar 防止“内部 report 已 pass、进程随后悬挂或超时”误绿；它不是签名、远端背书、硬件证明或 native 崩溃根因证明。托管 CI 只证明证据完整性，不重放或证明硬件。

schema-v5 child 把冻结字幕可见延迟与诊断分段明确分离。唯一验收值仍是受控播放 `source t0 + 140ms` 的冻结语音起点，到 `SessionCoordinator` 接受并通知观察者的同一个首个 partial。播放 renderer、audio-host renderer、realtime utility 与 main 之间先各用 7 个样本完成 NTP 式最小 RTT 单调时钟校准，再预留同一个未来 `source t0`，先 arm 捕获探针、再 schedule 播放；六段必须为非负整数并在每个 child 内精确求和到冻结值。纯测试覆盖任意远端时钟原点、错误 clock ID、过高 RTT、陈旧校准、因果倒置以及延迟 arm 必须先于 schedule 完成，组合测试覆盖 audio-host→worker→adapter→Coordinator 的 accepted-partial 绑定。captured-energy 探针从 `source t0 + 40ms` 的固定 guard 后观察，仍比冻结 onset 早 100ms；它不做语料归因，也不改验收值。本批 mic P95 为 -99ms，只说明 guard 后已有环境能量，不得用于改善验收值。

`scripts/native-model-activity-lifecycle-smoke.js` 是 SEM-F12 的真实模型活跃退出诊断：从已审计 bundle 加载 online ASR、silero VAD 与 offline refinement，用冻结语料只在内存中直送 PCM。2026-07-31 三轮报告累计 303 帧、3 final、3 refined、3 offline decode、6 个 exact-child `exitCode=0`、fatal 0。它不开 BrowserWindow 或物理 mic/loopback，不保存正文、PCM、音频引用或本地路径，`gateStatus` 固定为 `diagnostic-only`；因此不能替代 I2 声卡旅程、I3 两小时/恢复或 I4 干净机发布验收。

与该冻结输入诊断分开，受跟踪 I2 exit-bound bundle 已让 loopback/mic 各跑 5 轮 Electron audio-host→online ASR→offline refine→外部 exact-child 退出观察；其冻结 P50/P95/min/max 为 loopback=1133/1158/1092/1158ms、mic=875/1005/822/1005ms。2026-08-01 当前工作机又各跑五轮，结构/准确率/自然退出/零 transport 损失仍是 5/5，冻结 P95 为 loopback 1148ms、mic 1099ms。相同窗口的真实 pause/refine 与 exact worker 硬终止+Retry 已通过；DWM 虽持续新增 1,580 帧且零损失，但未取得操作者拖动 completion，设备移除与睡眠/唤醒也未执行。两批结果都没有关闭 `<1000ms` 性能线，I2 整体门禁仍未关闭。

普通 `npm start` 和产品壳旅程由 `scripts/run-supervised-electron.js` 监督唯一 exact child；main 只上报固定枚举的生命周期与角色级事件，报告不保存 PID、命令行、正文、音频、路径、stack 或 dump。一次性 Electron smoke 另由 `run-electron-smoke.ps1` 等待其启动的 exact process，默认 120 秒；超时即失败并只清理该 process object，不按名称枚举，也不把强杀冒充自然退出。I2 的 schema-v1 sidecar 把这种外部观察绑定到 exact schema-v5 report，但只证明该次 exact child exit 0 且未被 runner 终止。受监督多窗口产品壳已得到 clean exit、0 incident、未观察到 breakpoint，同时产品旅程报告仍是 `partial`：它使用 fake ASR、受控模型 fixture（无真实张量）且没有打开物理音频或访问真实公网。现场已捕获一条完成报告后出现的 `PostQueuedCompletionStatus: (6) 句柄无效。`；固定 Node/libuv 源码只证明它会走 `uv_fatal_error → DebugBreak → abort`，可以直接解释 `0x80000003` 的即时机制。因缺少 native stack，具体竞态、发送者和进程角色均未证；上游 IOCP/`uv_async_send` 修复只能视为相容线索，当前通过结果也不能升级为永久修复声明。完整边界见 [Electron breakpoint 调查记录](validation/electron-breakpoint-investigation.md)。

## J27 退役门禁修订（2026-09-14，已决定）

依据 ADR 0019，J27 从双入口隔离改为唯一现行实现、旧引用不可达、旧操作拒绝、验证备份及退役迁移、正式包不含旧链路。覆盖新库/旧版本/v9、非空循环外键、WAL 快照、权限/写入/验证/事务失败、重复启动和重试、字幕独立性、删除幂等与历史回执。最终三条 lane、renderer、smoke/release 与 packaged fresh/restart 必须针对交付版本；环境失败单列。未满足时为实现完成·尚未验收，不晋级实机或发布验收。两个独立 luna/max 只读审核分别核对执行与语义，修复由原审核者复核。旧 J27 隔离入口条款由此取代。
此前的 `docs/validation/j27-current-revision-results.json` 保留为 4fe62f7 历史基线；本轮交付计数与限制以同日退役切片记录为准，不把旧 revision 的打包哈希当作当前版本证据。

2026-09-19 当前退役切片记录：退役存储定向测试 24/24，`npm run test:core` 932/932、`npm run test:evidence` 229/229；`npm run test:integration` 为 50/53，3 项失败在已登记的 Windows Electron GPU/safeStorage/开发启动边界中未形成可采纳证据。`npm run verify:renderer`、smoke/release 打包返回 0，smoke layout 为 pass（453 个 ASAR 条目、5 个 native binary）；release layout 的 Authenticode inspection、NSIS lifecycle 以及 packaged fresh/restart 未形成可采纳证据。I3 非音频报告按 `TZ=UTC --segments 3600 --batch-size 100` 重建并通过 provenance/export 校验；该报告按 product payload、runner 与 verifier 哈希绑定，生成于提交前工作树，不声明绑定完整 Git revision。该记录保持「实现完成·尚未验收」，不把环境失败或确定性非音频预资格提升为实机/发布验收。

### 2026-09-21 J20 NLS 首期旅程登记（已决定）

2026-09-30 J20 云端资源与自动冷加载增量（SEM-F06/F12/F14/F17/F21，已决定）：真实 worker 配置云端分支时拒绝任何本地模型/VAD/native require，并且运行期云端故障才创建第二个本地 worker。跨真实 adapter/router/coordinator/worker/SQLite/历史/runtime-view 验证冷加载期间继续接收音频，已提交切点后有序消费、进度可重新读取、模型及端口就绪才改变实际 provider、迟到云端结果拒绝、下一云端会话不保留本地 worker。覆盖配置失败、30 秒接管期限、60 秒留存耗尽、缺失切点、本地端口失效、冷加载时停止/退出及迟到 configured；精确等待两进程退出，首次稳定转写不被重识别，进度不持久化。替身仅在 Electron 进程/端口、声卡和云网络边界；结构模式不证明真实 ASR。本次定向验证之外，I2/I3 另验证真实模型冷加载、追赶速度、两个来源及内存趋势。

凭据删除边界注入权限失败，断言保存返回清理未收束、Token 失效、新识别拒绝及重启恢复日志清理；损坏配置独立恢复则断言原文件保留并明确披露。

恢复负向矩阵：损坏 settings/凭据 journal 后应用配置服务可构造且显示 loadError，恢复前 freeze 拒绝、用户明确保存纯本地后恢复，原损坏文件保留；持久凭据转进程内凭据的提交删除与失败回滚；启动前零 PCM；鉴权/项目/签名时钟分类及 SentenceEnd.status=0；保存失败后凭据输入已清空的明确提示。

本登记更新既有 J20 的实施排期，仍不阻断 Agent，亦不恢复确认关键词。按 [ADR 0020](adr/0020-nls-realtime-recognition.md) 验证：设置上海单套 NLS 与音频上传披露 → main 安全凭据/CreateToken → 真实采集及有界 worker/main 音频传输 → NLS partial/唯一首次 final → 暂停收尾/恢复新任务或明确故障单向本地降级 → 停止排空 → SQLite、历史与导出。覆盖启动失败拒绝开始、Token 刷新竞态、重复/冲突/迟到结果、同会话时间映射、长静音、60 秒留存/2 秒待发超限停止、100ms 连续 PCM 在定时器迟到时不累积待发量、长阻塞后不无界突发追赶、交接范围缺失、Retry 无自动切回、存储故障、退出和隐私负扫描。配置、provider adapter、router、coordinator、worker 核心、reducer、SQLite、历史与 IPC 用真实实现；替身仅位于声卡、云网络/provider、系统权限等不可确定外部边界。本地 recognizer 的真实张量资格仍由 I2/I3/I4 提供，不得把无模型结构模式冒充降级识别资格。

关联 SEM-F01/F04/F06/F12/F14/F21/F25、DB1/J10/J12/J16；提交前当前 revision 的完整三条 lane，打包增加实际 NLS 依赖加载检查。公网 header 握手、项目效果、Token 跨期连接、mic/loopback 各五轮冻结字幕可见延迟、main 事件循环 P95 <50ms/P99 <100ms、两小时资源趋势与干净机仍另验，确定性层不晋级实机状态。

J20 协议子矩阵还须明确断言：TranscriptionStarted 前零 PCM、StopTranscription 一次且等待 TranscriptionCompleted、就绪/停止各 10 秒超时、partial 不升格、连接/task_id 代次隔离，以及 Token/AccessKey/AppKey/原始响应不进入日志或证据。NLS 云端路径的 mic/loopback 各五轮 I2 不得复用纯本地 series；注入断连/服务错误后必须另走真实本地 recognizer 接管，结构 fixture 只证明编排，不冒充真实识别。

2026-09-23 J20 实施更新：状态为**实现完成·尚未验收**；已有设置 renderer→preload→main 配置恢复、两来源独立云端暂停/恢复、停止持久化、断连接管、端口关闭、缺失持久化接口、采集缺口、存储失败及 Retry 的真实内部模块旅程。真实本地张量另有两切点诊断资格，不替代云端/物理来源验收。命令、计数、Luna/max 复核和边界见 [实施记录](validation/nls-implementation-2026-09-23.md)。

2026-09-27 J20 发送节拍增量（SEM-F12/F14）：累计单调时钟期限在重复 10ms 定时迟到下持续传输 450 个 100ms loopback 帧，保持云端识别 provider 活跃，并经 SQLite 写入与字幕历史读取观察到首次稳定转写；旧算法同一确定性用例触发 `RECOGNITION_BUFFER_LIMIT`。provider 回归另覆盖 350ms 单次调度停顿后按新期限继续发送；既有用例守住两秒待发硬上限及失败释放。三个受影响文件定向验证 27/27；真实计时合成负载运行 44.908s 后仍无故障、450 帧均已发送，待发峰值 100ms。状态为**实现完成·尚未验收**；这不替代真实 NLS、公网、物理来源或 I2/I3/I4。

2026-09-28 J30-RECOVERY 重启恢复子切片（SEM-F38/SEM-T04/J30-RECOVERY）：`npm run test:focus -- test/contracts/session-summary-run-ui-contract.test.js test/main/session-summary-run-ipc.test.js test/main/session-summary-run-preload.test.js test/ui/renderer-style-guard.test.js test/ui/agent-ui.test.js test/integration/session-summary-request-j30-accept-journey.test.js test/storage/agent-execution-store.test.js test/storage/session-summary-request-store.test.js test/storage/personal-context-store.test.js test/runtime/session-summary-run-progress.test.js` 为 116/116；`npm run verify:renderer`（renderer 类型检查及生产构建）通过；`git diff --check` 通过。真实 StorageWorkerService/SQLite 与 preload/IPC/service 确定性旅程覆盖固定提示恢复、明确继续领取同一 target run、回执丢失后的同键重放以及自由问题新受理与旧待重提标记同事务收束；AgentView harness 覆盖显式继续/重新输入、重新输入期间锁定会话范围与关闭窗口不取消。状态为**实现完成·尚未验收**；scheduler 全生命周期、跨重启剩余预算、正式 Electron 窗口和完整 J30 联合验收尚未验证。
2026-09-28 J30-RECOVERY 续租与预算子切片（SEM-F38/SEM-T04/DB1/J30-RECOVERY）：`npm run test:focus -- test/runtime/formal-agent-job-scheduler.test.js test/runtime/formal-agent-run-runner.test.js test/runtime/agent-loop.test.js test/main/model-access-vault-runtime.test.js test/main/storage-gateway.test.js test/storage/storage-worker-host.test.js test/storage/storage-worker-service.test.js test/storage/agent-execution-protocol.test.js test/storage/agent-execution-store.test.js test/storage/personal-context-store.test.js test/storage/model-access-schema.test.js test/storage/session-summary-request-store.test.js test/integration/session-summary-request-j30-accept-journey.test.js test/integration/session-summary-budget-recovery-journey.test.js` 为 177/177；`npm run test:core` 为 1061/1061（含 renderer 类型检查与生产构建）；`git diff --check` 通过。真实 scheduler/runner/SQLite 重启旅程证明活动中先续租并结算时长，模型请求先有持久预留，重开后未结算租约保守计入、旧 attempt 不能提交，用户明确继续复用同一 run/绑定且 attempt 递增；额外迁移回归覆盖 v16→v17 旧 checksum 保留及未知预算恢复失败关闭，续租与排队预留竞争时允许有效的同 attempt 旧租约凭据，字幕会话仍可独立写入。状态为**实现完成·尚未验收**；真实模型、公网、正式 Electron 窗口与完整 J30 联合验收尚未验证。

2026-09-28 P1.5 确定性复核（SEM-F38/F40/SEM-T04/J29/J30）：`npm run test:focus -- test/contracts/session-summary-run-ui-contract.test.js test/contracts/agent-run-diagnostics-contract.test.js test/main/session-summary-run-ipc.test.js test/main/session-summary-run-preload.test.js test/main/agent-run-service.test.js test/main/agent-run-diagnostics.test.js test/storage/session-summary-request-store.test.js test/runtime/session-summary-run-progress.test.js test/runtime/formal-agent-run-runner.test.js test/runtime/formal-agent-job-scheduler.test.js test/runtime/agent-loop.test.js test/integration/session-summary-j29-memory-journey.test.js test/integration/session-summary-request-j30-accept-journey.test.js test/integration/session-summary-input-cancel-journey.test.js test/integration/session-summary-budget-recovery-journey.test.js test/ui/agent-ui.test.js` 为 149/149；`npm run test:core` 为 1081/1081，含 renderer 类型检查与生产构建；显式 `npm run verify:renderer` 返回码为 0。真实 SQLite worker 取消旅程在首个 128 段 keyset 页后返回 `AGENT_CANCELLED`，并验证下一存储命令和另一工具上下文取消在 5 秒内收束；诊断测试直接创建 5 个有效文件并验证第六个文件分配淘汰最旧项，且覆盖每文件 1 MiB、7 天保留、256 条队列及单条≤2 KiB。网络/provider 只用受控替身；无真实公网调用、正式 Electron 窗口运行或五小时实机采集，因此不提升至联合验收完成。

2026-09-28 P1 正式 Electron 收尾旅程（SEM-F38/F40、SEM-T01/T02/T04、J30-ELECTRON/J12）：`npm run test:focus -- test/integration/agent-redesign-j25-formal-settings-journey.test.js` 与 `npm run test:focus -- test/integration/agent-bar-ipc-journey.test.js` 均为 1/1；正式 Agent Bar 路径验证受控 provider 取消在 5 秒内持久收束、丢弃终态通知后界面读回状态、诊断查询/导出及敏感标记负扫描，Agent 不存在时字幕旅程保持独立。`npm test` core 为 1084/1084；integration 为 70/71，唯一失败是当前宿主 Electron GPU 子进程退出码 `-1073741515` 导致 J18 Vite renderer 无法加载；`npm run test:evidence` 为 246/249，其中 2 项 I3 non-audio 报告因工作区既有 `StorageGateway` 改动导致 `storageGatewaySha256` stale，1 项按设计跳过。相关服务旅程另覆盖 SQLite restart/明确继续及字幕独立，但正式 Electron restart、取消落库失败 UI、诊断写失败期间的字幕旅程和全 lane 均未验收；P1 状态保持实现完成·尚未验收。

2026-09-28 P1 I3 证据更新（SEM-F14/SEM-T03/J9-CI）：在干净 managed worktree（提交 `2959732`）先运行 `npm run verify:renderer`，再执行 `TZ=UTC node scripts/i3-nonaudio-soak.js --segments 3600 --batch-size 100 --report docs/validation/i3-nonaudio-results.json` 重建绑定当前提交源码的非音频报告；严格 verifier 及 I3 定向旅程 3/3 通过，完整 `npm run test:evidence` 为 248/249（1 项按设计跳过、0 失败）。主工作区最终 `npm test` core 为 1084/1084，integration 为 70/71；J18 当前宿主 Electron renderer `ERR_FAILED` 仍阻塞完整 integration。此非音频预资格不代表真实音频或实机验收，P1 状态仍为实现完成·尚未验收。

2026-09-28 J30-ELECTRON 收尾增量（SEM-F38/F40、SEM-T01/T02/T04、J30-RECOVERY/J30-ELECTRON）：正式 Electron 定向旅程 2/2；生产 Agent Bar、main/preload/IPC、scheduler、runner、Model Access、storage worker 与 SQLite 覆盖正式取消期限、终态通知丢失后的状态校准、诊断查询/导出及隐私负扫描，并新增真实独立进程重启后明确继续同一 request/run，用户操作前没有 provider 请求；关闭 Agent 窗口不发送取消，挂起请求的 IPC snapshot 未报告分块进展。8.2 仍缺正式 UI 终态竞争、取消落库失败、失租屏障及自由问题重新提交覆盖；8.3 正式 Electron 受控麦克风启动返回 `ADAPTER_START_FAILED`，字幕独立性服务级旅程未替代此缺失矩阵。本次失败原型不计通过，J30/J12 联合验收与 P1 状态仍为实现完成·尚未验收。

2026-09-28 当前 revision 回归（SEM-T03/J9-CI/J30/J12）：`npm test` renderer 类型检查/生产构建通过，core 1084/1084，integration 71/72，唯一失败仍是 J18 Vite 开发态 Electron 首次启动退出码 1；当前宿主日志出现 GPU shared context 创建失败。单独 `npm run test:evidence` 为 246/249，2 项 I3 provenance 断言因 `productPayloadSha256` 与当前工作树内容不一致而失败，1 项按设计跳过。三条 lane 未全部通过，不提升至「联合验收完成」，P1 保持「实现完成·尚未验收」。

### 2026-09-29 容量 review 修订（已决定）

SEM-F39/F40、J31-SIZE：撤销字节÷2的窗口证明；以86,914/86,913字节验证95,106/95,105输入能力边界，173,827字节在当前无tokenizer策略下拒绝且零模型调用；小窗口零容量沿专用错误与字节指标收束。SEM-T04、J30-RECOVERY：断言失败也必须停止scheduler并清理诊断，注入失败应自然退出。此前64/64与Electron2/2仅为旧计数策略及既有旅程证据，不证明新增窗口成功链路。

修订实现完成·尚未验收：`npm run test:focus -- test/contracts/budget-axes-s3.test.js test/runtime/formal-agent-run-runner.test.js test/integration/session-summary-budget-recovery-journey.test.js test/integration/session-summary-j29-memory-journey.test.js test/integration/agent-redesign-s5-target-journey.test.js` 为32/32（先运行新增断言得到5项失败，再修复）。预算恢复旅程以内存副本在首次外发后注入断言失败，8秒上限内自然退出码1，无超时；此前同一探针超时。未验证本次revision完整三条lane、Electron、公网模型与实机；任务2–4继续待实施。

2026-09-29 窗口内直接总结请求合同与结果收束（SEM-F28/F33/F36/F38/F39/F40、SEM-T04/T10、J25/J29/J30/J31-SIZE；任务2–3，实现完成·尚未验收）：先红测后实现。请求合同侧新增 `src/agent/contracts/recipe-output-directives.js`（按 recipe/version 的单行 JSON 输出说明与经 exact validator 校验的示例，经 AgentLoopExecutor 传入 systemPrompt；intent.route 保留路由闭集，context.ingest 保留独立 evidence 结构），runner→Loop→Model Access→adapter 接通宿主内部 `requestCapacity`（仅 `summary.minutes@2` 携带，缺额 fail closed 为 `AGENT_REQUEST_INVALID`），adapter 每次外发前经 `deriveSummaryMinutesV2OutboundQuota` 派生输出额度与序列化输入窗口：81920/4096 能力分别请求 8192/4096，已知余额 4000 请求 4000，零余额零额外外发（`AGENT_BUDGET_EXCEEDED`），usage 缺失整体保持未知、不假定为零，工具消息增长超窗口在外发前拒绝且不谎称零模型调用，完整 HTTP ≤512 KiB 检查保留，JSON/thinking 策略仍由冻结 requestStrategy 决定，旧绑定 `max_tokens` 与绑定 JSON 逐字节不变。结果收束侧实施 finish_reason 闭集（length、content_filter、缺失/未知、stop 与 tool_calls 矛盾、tool_calls 为空、空白正文均 `AGENT_OUTPUT_INVALID` 且零工具副作用、零额外外发），受控网络 fixture 全部显式提供 finish_reason；runner 增加来源范围校验（summary/qa 的 transcript 引用必须落在冻结输入 `[fromEventOrder, throughEventOrder]` 与同一 sessionId/transcriptVersion 内），缺字段/额外字段/超长字段/越界来源一律 `AGENT_OUTPUT_INVALID` 非重试收束、零部分提交。实际命令与结果：`npm run test:focus -- test/contracts/agent-recipes-contract.test.js test/contracts/budget-axes-s3.test.js test/runtime/agent-loop.test.js test/runtime/formal-agent-run-runner.test.js test/main/model-access-vault-runtime.test.js test/runtime/intent-route-orchestrator.test.js test/runtime/intent-router.test.js` 为 109/109；`npm run test:focus -- test/integration/model-access-s2-core-journey.test.js test/integration/agent-redesign-s5-target-journey.test.js test/integration/session-summary-j29-memory-journey.test.js test/integration/session-summary-budget-recovery-journey.test.js test/integration/agent-redesign-s3-route-journey.test.js` 为 7/7；`npm run test:focus -- test/runtime/context-ingest-runner-s3.test.js test/runtime/session-summary-run-progress.test.js test/runtime/controlled-tool-audit.test.js test/runtime/formal-agent-job-scheduler.test.js` 为 39/39；`npm run test:core` 为 1112/1112（含 renderer 类型检查与生产构建）。预算恢复旅程新增场景用真实 runner/Loop/Model Access/storage worker/SQLite 证明：成功链路发出 systemPrompt JSON 指令、`max_tokens=4096` 与含 sessionId/inputDigest 的完整输入，且恰好提交一个纪要；已成功请求再取消返回原成功终态且纪要保留；取消先于提交时迟到成功零纪要、交互 `result_json` 为空。173,827 字节拒绝样本与 86,914/86,913 字节窗口边界证据保持不变。未验证范围：完整三条 lane、任务4 正式 Electron 旅程、真实 DeepSeek 公网与实机运行；本条不替代阶段联合验收。

2026-09-30 重试用量修复（SEM-F39/F40、SEM-T04、J31-SIZE/J30-RECOVERY；实现完成·尚未验收）：沿既有“失败请求缺用量则整体未知”语义，adapter 在请求失败后保持 usage 未知，后续重试成功不把部分用量标为完整用量。新增网络断开及 HTTP 503 后成功的回归；定向红测 `node --test --test-name-pattern="retry after missing request usage" test/main/model-access-vault-runtime.test.js` 修复前为 0/1，失败断言确认错误返回第二次请求用量。修复后 `npm run test:focus -- test/main/model-access-vault-runtime.test.js test/runtime/agent-loop.test.js test/integration/session-summary-budget-recovery-journey.test.js` 为 49/49，含既有真实 runner/Loop/Model Access/storage worker/SQLite 旅程。未重跑完整三条 lane、正式 Electron 或真实公网模型。

### 2026-09-30 会话结果导航与窗口回归登记

| gate | 场景 | 状态 |
|---|---|---|
| J29/J30 | 两会话不同纪要、无结果会话、切换后的迟到详情/历史拒绝、外部指定会话、总结/问答切换；正文不展开 sourceRefs，来源与运行详情保留；真实 service/storage 按 scope 分页隔离 | 实现完成·尚未验收 |
| J17 | 历史→Agent→历史聚焦往返、失焦降级、最小化后重新打开及应用恢复；不要求永久置顶 | 实现完成·尚未验收 |

2026-09-30 验证记录（SEM-F31/F38/F22、J29/J30/J17）：

- `npm run test:focus -- test/ui/agent-ui.test.js test/main/agent-window-route.test.js test/main/window-layer-controller.test.js test/main/application-window-lifecycle-controller.test.js test/contracts/agent-run-ui-contract.test.js test/storage/agent-execution-store.test.js test/main/agent-run-service.test.js test/ui/renderer-style-guard.test.js`：137/137。覆盖会话/功能切换、迟到历史与详情丢弃、空态、重复点击当前功能、草稿隔离、来源/运行信息折叠、scope 在 SQLite 分页前过滤，以及 Agent 聚焦/最小化恢复。
- `npm run verify:renderer`：返回码 0，类型检查与生产构建。`npm run test:focus -- test/integration/agent-redesign-s5-target-journey.test.js test/integration/agent-redesign-j25-formal-settings-journey.test.js` 初次扩大验证为 2/3：真实 service/worker/SQLite 的 S5 隔离旅程及 Electron 重启后显式恢复旅程成立；主流程旧夹具依赖全局历史。修正夹具为按会话与功能导航，并补齐受控 provider 的 finish_reason 后，`node --test --test-name-pattern="formal settings, Agent Bar" test/integration/agent-redesign-j25-formal-settings-journey.test.js` 为 1/1，覆盖生产 renderer/preload/main、问答反馈、总结取消/诊断和窗口关闭恢复。
- 扩大执行 `npm run test:core`：1118/1119；唯一失败为 `test/ui/agent-model-settings-ui.test.js` 的“共用表单展开未知能力并保留未保存草稿”，读取预期 alert 时为 null。单独执行 `node --test --test-name-pattern="共用表单展开未知能力" test/ui/agent-model-settings-ui.test.js` 同样为 0/1；本次未修改模型设置表单。该 core 计数早于最后的当前功能重复点击保护，后者已由上述 137/137 及 renderer 构建验证。
- 未验证：当前 revision 完整三条 lane、真实公网 provider、Windows DWM 点击置顶与遮挡实机行为。窗口替身断言仅证明原生调用意图，不提升实机验收状态。


### 2026-09-30 长输入执行验证（SEM-F39/F40，J31/J29/J30）

状态：**实现完成·尚未验收**。新raw总结已接通自动分块与连续归并；173,827字节合成来源经过真实SQLite、分页、规划器、Agent Loop及模型接入层，验证完整文本覆盖、一个纪要、中段失败零部分产物、未知usage、旧策略零请求拒绝和schema 3导出。v19→v20保留旧checksum、策略与attempt上限。外部provider受控，未验证公网质量或五小时实机。

实际验证：`node --test test/runtime/summary-input-plan.test.js test/runtime/formal-agent-run-runner.test.js test/runtime/agent-loop.test.js test/storage/session-summary-request-store.test.js test/storage/agent-execution-store.test.js test/main/agent-interaction-exporter.test.js test/main/model-access-vault-runtime.test.js test/integration/session-summary-budget-recovery-journey.test.js` 为128/128；`npm run test:integration` 为73/74，正式Electron总结/取消/恢复旅程在成功项内，J18 Vite开发态启动失败；`npm run test:evidence` 为246/249（2项I3 provenance与当前storageGateway哈希不一致，1项按设计跳过）。两条命令的renderer类型检查和生产构建返回码0。此前当前实现的`npm test`止于core 1121/1122，失败是模型设置UI的未知能力提示断言；定向重现该文件为4/5。`git diff --check`返回码0。三条lane尚未全部成功，不提升联合验收状态。

仍待验证：完整J31容量轴上下沿、128 MiB峰值、catalog/删除竞态、正式Electron长文本和跨块事实质量，以及真实五小时采集/公网模型。实现与任务边界见`openspec/changes/fix-session-summary-lifecycle-and-long-input/tasks.md`。

### 2026-09-30 J20 中断回归登记（已决定）

SEM-F12/F14/F21/F25：真实 provider/router/worker/coordinator/SQLite 旅程覆盖连续 180 秒发送回调周期迟到后仍监听、音频顺序与完整性、50 秒未定稿段单向本地交接及停止、静音不误降级；网络与时钟边界受控。保留两秒待发/六十秒留存失败、取消、暂停恢复与交接缺口测试。定向结果不替代真实 NLS、物理音源和两小时 I3。

### 2026-09-30 J20 云端长段连续性修订（已决定）

真实 provider/router/worker/coordinator/SQLite 验证连续180秒单一未定稿段仍使用NLS、停止接受唯一首次稳定转写、无降级；worker留存始终不超过60秒，断连时旧切点缺失显式失败。撤销50秒降级预期，保留发送积压、缺口和停止超时失败测试。真实公网识别效果及I3另验。

### 2026-10-04 生成记录与滚动条登记（已决定）

| 旅程 | 增量边界 | 状态 |
|---|---|---|
| J18/J29/J30 | 正式 Agent renderer 默认隐藏生成记录，右侧展开/关闭/Esc 焦点返回；窄宽窗口、125% 缩放保持两栏完整高度。生成记录空列表/读取失败仍可关闭；已有会话范围隔离与分页继续验证。 | 已决定 |
| J18 | 共享滚动条覆盖所有 renderer，生产布局旅程核对深浅主题计算样式及高对比回落；实机滚动条拖动、DPI 与可读性另验。 | 已决定 |

2026-10-04 定向验证（SEM-F23/F31/F38、SEM-T04、J18/J29/J30）：状态为**实现完成·尚未验收**。`npm run test:focus -- test/ui/agent-ui.test.js test/ui/renderer-style-guard.test.js` 为64/64，覆盖默认收起、展开、Esc/按钮收起、焦点返回、读取失败仍可收起及既有会话范围隔离。`npm run verify:renderer` 返回0。`npm run test:focus -- test/integration/agent-layout-journey.test.js` 在受限环境因Electron GPU子进程退出码-1073741515中止，不计产品断言结果；沙箱外同一隔离旅程为1/1，使用生产main/preload/renderer，验证深浅主题、520/720/1100宽度、125%缩放、右侧展开不压缩阅读高度及模拟高对比下滚动条回落。`git diff --check` 返回0。未运行完整三条lane、真实DPI/鼠标拖动及人工可读性验收，不提升J18/J29/J30整体状态。

### 2026-10-04 会话总结窗口反馈登记（已决定）

J29/J18、SEM-F38/F23、SEM-T04：覆盖 ready-to-show 与 did-finish-load 的两种顺序、关闭立即清除、旧窗口失败不污染新窗口、重复打开、等待后重试、失败后重开、工具条恢复既有精修通知。主进程控制事件序列回归只替代窗口边界；正式 Electron 旅程保留真实 main/preload/toolbar/agent 检查首开和关闭后的显示状态。状态为已决定，不把窗口已打开等同于会话总结已生成。

2026-10-04 窗口反馈定位与验证（SEM-F38/F23、SEM-T04、J29/J18）：**实现完成·尚未验收**。受控窗口事件序列先复现三项断言失败：ready-to-show先到导致opening不收束；closed未广播；旧窗口加载拒绝覆盖新窗口ready。排查还发现等待后重试未重建期限、失败未统一撤销等待，以及工具条旧IPC拒绝可能覆盖新状态。修复统一加载/重试等待、成功/失败/关闭收束与窗口/尝试身份校验；closed恢复原有字幕状态或精修通知。设置/字幕历史入口无独立“正在打开”反馈；所检查的历史读取/导出、助手设置保存与会话总结请求使用各自成功/失败收束，不将本次打开反馈修复冒充模型运行状态验收。

实际命令：`npm run test:focus -- test/main/agent-window-lifecycle.test.js test/main/agent-window-route.test.js test/main/renderer-entry.test.js test/ui/toolbar-notice-ui.test.js test/ui/history-ui.test.js test/ui/agent-ui.test.js` 为89/89；`npm run verify:renderer` 返回0；沙箱外 `npm run test:focus -- test/integration/agent-layout-journey.test.js test/integration/agent-bar-ipc-journey.test.js` 为2/2，保留真实main/preload/renderer/IPC及既有storage worker旅程，并验证工具条首次打开、关闭清除和关闭重开。`git diff --check` 返回0。未执行完整三条lane、真实模型、真实DWM/声卡及用户当前运行实例的重启后实机观察，不提升J29整体验收状态。
