## 1. 负责人裁定、权威登记与实施基线

- [x] 1.1 登记项目负责人本轮决定：删除价格目录、单价覆盖、pricing revision、费用估算与金额展示；只保留 token/缓存命中事实；首次 v6 初始化只提供 DeepSeek OpenAI-compatible provider 模板，model ID、六字段能力、用途与凭据全部由用户确认，运行中不自动 fallback。
- [x] 1.2 在写测试或产品代码前，先更新 `docs/semantic-contract.md`、ADR 0014、`docs/testing-strategy.md` J25/S2 Core、`docs/data-architecture.md`、`docs/agent-redesign-execution-plan.md` 与 UI/UX handoff，使它们删除价格语义并登记 token/缓存合同、用户自定义 API base URL/model/能力和 DeepSeek provider 模板；不得只在 OpenSpec、代码或测试中暗定。
- [x] 1.3 把 2026-08-30 DeepSeek 官方文档快照登记为 `deepseek-openai-template@1` 依据：OpenAI base URL `https://api.deepseek.com`、Chat Completions `/chat/completions`、当前 `deepseek-v4-flash` 仅为瞬时 alias 建议、JSON/Tool Calls/streaming/usage 布尔建议为 true、两个 token 上限建议为 null；不得把官方缩写上限擅自换算成 exact integer，未来变化必须新发模板/建议版本。
- [x] 1.4 完整重读 `AGENTS.md` 与 `CONTEXT.md`，逐字核对更新后的 SEM-F00/F09/F15/F25/F28/F33/T15、J25 与 S5 汇合边界、S2 执行计划、ADR 0014、data-architecture v6/revision/delete 约束和 UI/UX handoff §3/§5.2/§6.2/§7。
- [x] 1.5 记录实施前 `git status --short`、当前 branch/HEAD、v1–v5 migration SQL/checksum、S1 状态与用户已有未提交文件；后续只显式暂存 S2 路径，不覆盖或顺带整理无关改动。
- [x] 1.6 运行实施前 `npm run test:core` 基线；若失败，区分产品断言与已登记 Windows Electron/沙箱环境问题，不把环境失败写成产品结论。

## 2. model-access 核心合同 tracer bullets

- [ ] 2.1 先写会红的 core 合同测试：ConfigStore exact patch 拒绝 profile/origin/model/credential/purpose 字段，model-access exact 命令拒绝 Agent 产品偏好字段，证明两个事实域不能双写。
- [ ] 2.2 最小实现 ConfigStore/model-access 字段所有权与 exact validator，使 2.1 转绿；不得修改 ConfigStore v2 六个 Agent 产品偏好语义。
- [ ] 2.3 定向回归 ConfigStore migration/更新与 S1 资格组合，确认 `agentSettingsRevision` 和 model `configurationRevision` 互不替代。
- [ ] 2.4 先写会红的公开 interface 测试，冻结且只冻结 `catalog()`、`configure(command)`、`bind(runRequest)`，并反证 renderer/recipe/utility 不能取得 store、vault、credential borrow 或动态 registry。
- [ ] 2.5 新建 `src/agent/model-access/` 的最小 facade 与私有 ports，使 2.4 转绿；不得建立第四个公开 model-access 方法。
- [ ] 2.6 定向回归 module graph/export surface，证明旧 `src/agent-provider/**`、Pi settings/home-dir 和动态 adapter registry 未被新 facade 导出或接回产品入口。
- [ ] 2.7 先写会红的闭集合同测试：九条 configure 命令、四个模型用途、六字段能力、两个 `MODEL_CONFIG_*` 错误、三值 credential scope、三值 assignment mode 与三值 readiness 恰好匹配 spec。
- [ ] 2.8 实现唯一合同常量、exact object validator 与 canonical enum，使 2.7 转绿；不得在 store/controller/IPC 重复写第二套字面量闭集。
- [ ] 2.9 定向回归未知值、额外键、缺键、非有限数、错误整数范围和内部字段泄漏矩阵，确认全部在进入 storage/vault 前 fail closed。

## 3. migration v6 与 schema 不变量 tracer bullets

- [ ] 3.1 先写会红的正式 v5→v6 升级测试：既有字幕/S1 事实不变、`user_version=6`、v1–v5 SQL/checksum 逐字节冻结、预期四表与索引存在。
- [ ] 3.2 只追加 migration v6，建立 `agent_model_profiles`、`agent_model_profile_models`、`agent_model_purpose_assignments`、`agent_model_run_bindings`，使 3.1 转绿；不得编辑 v1–v5 字节。
- [ ] 3.3 定向回归新库、v5 升级、重复打开、migration 中断与 checksum 漂移，确认失败保留原库并 fail closed。
- [ ] 3.4 先写会红的 schema 约束测试：`(profile_id, model_id)` 精确唯一、四个 purpose 行固定存在、四行 `configuration_revision` 相等、revision 非负单调、内部 template identity 与 adapter/API style 固定、六字段 capability exact，且 v6 零 price/cost/currency/pricing 字段。
- [ ] 3.5 补齐 v6 STRICT/CHECK/UNIQUE/外键与初始化数据，使 3.4 转绿；不使用无法追加的事后外键伪造不变量。
- [ ] 3.6 定向回归非法直接 SQL、重复 ID、purpose 缺行/多行、revision 分叉、unknown capability field 与错误 JSON 类型，确认数据库和领域层双重 fail closed。
- [ ] 3.7 先写会红的绑定不可变测试：`run_id` 指向真实 v5 `formal_agent_runs`、每 run 至多一行、UPDATE/replace/不同载荷重写拒绝、profile/model 删除不级联 binding。
- [ ] 3.8 增加不可变触发器与领域写前校验，使 3.7 转绿；只允许 owning formal run 的已登记删除生命周期移除 binding。
- [ ] 3.9 定向回归旧 binding 在 profile 更新、model 更新、档案删除、model 删除与应用重启后逐字段不变。
- [ ] 3.10 先写会红的 schema 隐私与字幕惰性测试：v6 表不含 credential/header/env/音频/路径/raw Error/正文列，字幕 `open/append/close/history` 不加载 model-access store 或 vault。
- [ ] 3.11 实现独立 model-access store factory 与惰性 `requireModelAccessStore()`，使 3.10 转绿；Agent 初始化失败不得成为字幕 storage worker ready 的前置。
- [ ] 3.12 定向回归字幕会话、历史和退出路径，确认 v6 migration/store/vault 故障只降低 Agent 系统能力。
- [ ] 3.13 先写会红的 DeepSeek provider 模板测试：首次 v6 初始化一次性播种 `deepseek-openai-template@1`、官方 origin 与 `/` base path、空 model、四用途未指派、credential absent、全部 readiness 为 `provider_not_configured`，零网络请求。
- [ ] 3.14 实现最小模板播种与内部 `template_id`，使 3.13 转绿；普通 `createProfile` 不得伪造模板 identity，模板不得自动写 model/能力/用途。
- [ ] 3.15 定向回归新库/v5 升级只播种一次、用户修改 base URL 保留、用户明确添加 `deepseek-v4-flash` 或未来 model、显式删除后重启不重建、运行失败不自动切换到 DeepSeek。

## 4. configuration revision 与九命令 storage tracer bullets

- [ ] 4.1 先写会红的统一 revision 测试：九命令都校验顶层 `expectedRevision`，成功恰好 `+1`，revision conflict 返回 `MODEL_CONFIG_REVISION_CONFLICT` 且 SQLite/vault/revision 零写入。
- [ ] 4.2 实现以四个常驻 purpose 行承载同一 `configurationRevision` 的原子读写，使 4.1 转绿；不得借用 ConfigStore revision 或最后一个 profile 行保存全局 revision。
- [ ] 4.3 定向回归空 catalog、删除最后档案、应用重启、并发两个命令和回复丢失重放，确认 revision 不丢失、不倒退且陈旧写入被拒绝。
- [ ] 4.4 先写会红的 `createProfile/updateProfile` 矩阵：exact schema、canonical connection、重复 profile ID、初始/推进 profile revision、catalog revision 不被连接更新误推进。
- [ ] 4.5 实现 profile 两命令最小事务，使 4.4 转绿；adapter/API style、providerKind 与 credential slot 不接受 renderer 指定。
- [ ] 4.6 定向回归两个相同 origin 档案仍获得独立 slot、不同 label/base path、失败零写入和立即影响未来 catalog/bind。
- [ ] 4.7 先写会红的 `addModel/updateModel/removeModel` 矩阵：精确二元组、六字段能力、profile/catalog/global revision 推进、失败零写入，并拒绝 price/cost/currency/pricing override 等额外字段。
- [ ] 4.8 实现 model 三命令与受影响 purpose 清空事务，使 4.7 转绿；远端 suggestion 不得绕过命令直接写 model 行。
- [ ] 4.9 定向回归重复/空 model ID、unknown capability、错误 token 上限、删除当前默认/专用目标及 catalog revision 只由用户 model 编辑推进。
- [ ] 4.10 先写会红的 `assignPurpose` 矩阵：四用途独立 target、target `null`、目标不存在、用途回落、只推进 global revision、不推进无关 profile/catalog revision。
- [ ] 4.11 实现 purpose 指派事务与 direct/fallback/unconfigured 解析，使 4.10 转绿。
- [ ] 4.12 定向回归仅摘要用途切换小模型、分析与规划保持原模型、专用清空回落默认、默认清空导致依赖用途 unconfigured。
- [ ] 4.13 先写会红的 `deleteProfile` storage 部分：live profile/models/purpose direct assignment 同事务删除，旧 binding 不删，失败回滚全部 live 事实。
- [ ] 4.14 实现 profile 删除的 SQLite 阶段并与 vault prepare/commit port 对接，使 4.13 转绿；DeepSeek provider 模板显式删除后不得在重启或 catalog 读取时静默重建。
- [ ] 4.15 定向回归删除有多个 model/四用途引用/既有 binding 的档案、同 profileId 后续重建及旧 slot identity 不复用。

## 5. 每档案 credential vault tracer bullets

- [ ] 5.1 先写会红的 vault 合同测试：一 profile 一 slot、同 origin 不共享、slot ID 不可预测且不复用、renderer 永不读回 credential/header/slot。
- [ ] 5.2 实现 main-owned vault 抽象、持久 `safeStorage` 密文与内存 `session_only` slot，使 5.1 转绿；SQLite 只保存非敏感 slot identity/公开状态。
- [ ] 5.3 定向回归多 profile 并发借用、一个 profile 清除不影响另一个、明文副本在成功/异常/取消/超时后尽力清零。
- [ ] 5.4 先写会红的 `setCredential` 跨介质事务：vault prepare、SQLite commit、vault commit 任一步失败都恢复旧凭据/配置/revision，成功不回显明文。
- [ ] 5.5 实现 vault prepare/commit/rollback/recover 与非敏感 journal，使 5.4 转绿。
- [ ] 5.6 定向回归每个故障注入点、回复丢失、进程退出后恢复与 journal 隐私负扫描，确认没有新旧凭据并存或 revision 假成功。
- [ ] 5.7 先写会红的 `clearCredential/deleteProfile` quarantine 事务：删除前槽不可借用、SQLite 失败可恢复、成功后擦除、旧 binding 仍只引用旧槽。
- [ ] 5.8 实现 clear/delete vault 协调，使 5.7 转绿；不得用“先删文件再写 SQLite”的不可恢复次序。
- [ ] 5.9 定向回归 clear/delete 的未知回复重放、同 ID 重建与旧 run 借用，确认旧槽不存在时稳定 `AGENT_PROVIDER_AUTH_FAILED` 且不重试。
- [ ] 5.10 先写会红的 `safeStorage` 不可用矩阵：`setCredential` 公开为 `session_only`、零落盘、当前进程可借用、重启后必为 `absent`。
- [ ] 5.11 实现 session-only 生命周期与启动重建逻辑，使 5.10 转绿；不得根据 SQLite 旧布尔伪造 present。
- [ ] 5.12 定向回归 persistent/session_only/absent 三态、加密从可用变不可用/反向变化、renderer reload 与重启后 next action。
- [ ] 5.13 先写会红的稳定鉴权失效矩阵：401/403 只失效对应 profile，推进 profile/global revision 并发布 changed；408/429/网络/5xx/取消/预算/Schema/worker 退出不失效。
- [ ] 5.14 实现 main-owned credential invalidation 内部转换，使 5.13 转绿；它不得扩张九命令闭集或返回 raw provider 错误。
- [ ] 5.15 定向回归两个档案故障隔离、活动 run 与未来 readiness、鉴权回复丢失幂等和凭据/stdio/日志/报告负扫描。

## 6. 连接安全、环境净化与远端目录 tracer bullets

- [ ] 6.1 先写会红的 `httpsOrigin/basePath` canonicalization 表：用户可定义 API base URL、合法 HTTPS origin、userinfo/path/query/fragment 拒绝、普通 base path 默认 `/v1`、DeepSeek 模板为 `/`、query/fragment/`..` 拒绝。
- [ ] 6.2 实现唯一 canonicalizer，使 6.1 转绿；store、catalog、bind 与 adapter 必须复用同一 canonical 结果而不重复解析规则。
- [ ] 6.3 定向回归 safe-join `/chat/completions`、Unicode/大小写 host、默认/显式 port、尾斜杠、percent encoding、IPv4/IPv6 与错误 URL，确认 renderer 不能提交 endpoint segment 且错误只映射为 `MODEL_CONFIG_INVALID`。
- [ ] 6.4 先写会红的 `providerKind` 推导测试：`localhost`、`127.0.0.0/8`、`::1` 为 local，其它为 cloud；profile label、model、端口与厂商名不能覆盖。
- [ ] 6.5 实现 loopback predicate 并在 bind 冻结 providerKind，使 6.4 转绿。
- [ ] 6.6 定向回归云端披露/readiness 组合只消费推导值，识别 provider 与字幕会话策略完全不变。
- [ ] 6.7 先写会红的环境净化测试：所有大小写等价 `DEEPSEEK_API_KEY` 无条件删除，child 环境从净化快照复制，运行中注入不影响后来 child/catalog/bind。
- [ ] 6.8 实现新 model-access composition 的净化快照并禁用 Pi `envApiKeyAuth()`/home-dir/argv 凭据发现，使 6.7 转绿。
- [ ] 6.9 定向回归多等价键、空值、启动后注入、utility/worker child 与日志/报告，确认环境只作为加固删除对象而非凭据来源。
- [ ] 6.10 先写会红的 `RemoteModelCatalogPullController` 测试：它不是 facade 第四接口，只接受 settings 用户动作、先校验 `expectedRevision`、拉取只返回瞬时建议、零写入/零 revision/零 changed。
- [ ] 6.11 实现 main-owned remote pull application adapter 与私有 credential borrow port，使 6.10 转绿；不得把 suggestions 保存进 catalog snapshot。
- [ ] 6.12 定向回归拉取成功后只有 `addModel/updateModel` 才推进 catalog revision，renderer reload 后瞬时 suggestions 消失。
- [ ] 6.13 先写会红的协议失败矩阵：任意 3xx 拒绝且不泄露 location、credential absent、超时/限流/断网/5xx、invalid schema、重复/空 ID、建议数/字节超界均零写入。
- [ ] 6.14 用 test-only `fauxProvider()` 实现最小 OpenAI-compatible models endpoint 协议，使 6.13 转绿；建议只含用户可编辑 model ID 与可空 capabilitySuggestion，未知字段保持 null。
- [ ] 6.15 定向回归 redirect 同 origin/跨 origin、凭据副本清零、外部失败不失效凭据的分类，以及本轮零真实公网/零真实推理。

## 7. catalog、readiness 与 token/缓存事实 tracer bullets

- [ ] 7.1 先写会红的 `catalog()` 纯读测试：多次读取结果稳定、不访问网络/remote pull、不解密 credential、不推进 revision、不写 vault/SQLite。
- [ ] 7.2 实现脱敏 catalog 聚合，使 7.1 转绿；公开字段只含 profile/model 编辑事实、能力、credential 布尔/scope、用途解析与 readiness。
- [ ] 7.3 定向回归公开投影负扫描，确认不含 adapter/API style 内部常量、factory、slot、密文/明文/header、vault journal、SQL identity、redirect/raw Error、recipe mapping 或预算来源。
- [ ] 7.4 先写会红的 readiness 表：四用途 × single-shot/agent-loop，覆盖 direct、fallback、missing default、missing model、credential absent、session_only、tool capability mismatch。
- [ ] 7.5 实现只基于已提交配置/能力/credential metadata 的派生 readiness，使 7.4 转绿；不得解密、网络探测或读 fixture。
- [ ] 7.6 定向回归 S1 `context.ingest.session` 资格组合：只消费 `information_extraction.singleShot` 非敏感事实，再叠加 ConfigStore/披露/会话边界；`fauxProvider()` 或 IPC 成功不得伪造 ready。
- [ ] 7.7 先写会红的 `ModelUsageV1` exact 合同：非负 input/output token、`provider/estimated` 用量来源、可空 cache-hit/cache-miss input token，并拒绝全部 price/cost/currency/pricing 字段。
- [ ] 7.8 实现唯一 token usage validator 与缓存命中率派生器，使 7.7 转绿；DeepSeek 映射 `prompt_cache_hit_tokens/prompt_cache_miss_tokens`，命中率不持久化且只在 hit+miss 等于 input token 时计算。
- [ ] 7.9 定向回归 provider cache hit/miss、任一 cache 字段缺失、estimated usage、input=0、负数/类型错误/hit+miss 不一致：两个缓存事实与命中率一律为 null 而不是 0%，且模型内容结果不因无效 cache metadata 被伪造为失败。

## 8. bind 与不可变模型运行绑定 tracer bullets

- [ ] 8.1 先写会红的 `runRequest` exact 合同：只允许 `runId/recipeId/recipeVersion/executionForm`，任何 purpose/profile/model/URL/header/budget/credential 字段返回 `AGENT_REQUEST_INVALID`。
- [ ] 8.2 实现 `bind(runRequest)` 输入 validator 与静态 recipe-to-purpose policy seam，使 8.1 转绿；renderer/provider 不得修改映射。
- [ ] 8.3 定向回归 unknown recipe/version/execution form、额外键与内部 policy 不进入 catalog/UI fixture。
- [ ] 8.4 先写会红的固定解析顺序测试：recipe → purpose → direct → fallback → profile/model → capability → budget → credential → atomic binding；任一步失败不进入下一步、不借 credential、不写 binding。
- [ ] 8.5 实现 bind resolver pipeline，使 8.4 转绿；失败分类按 `provider_not_configured`/`credential_unavailable` readiness 与绕过资格时 `AGENT_REQUEST_INVALID` 收束，永不使用 `AGENT_PROVIDER_UNAVAILABLE` 表示配置问题。
- [ ] 8.6 定向回归缺默认、删除 target、tool capability mismatch、connection invalid、credential absent 与 observer 抛错，确认零部分 binding。
- [ ] 8.7 先写会红的 v5 run + v6 binding 原子测试：验证一个已经存在的真实 `context.ingest.session` formal run、信息提取 single-shot mapping、recipe/version 匹配、同 run 至多一 binding；四字段 `runRequest` 不创建 run。
- [ ] 8.8 实现 storage transaction/command，使 8.7 转绿；不得由测试直接 INSERT binding 或跳过 model-access facade。
- [ ] 8.9 定向回归事务注入失败、storage worker replacement、回复丢失与重复 bind，确认同一 request 返回逐字段相同旧 binding。
- [ ] 8.10 先写会红的绑定快照测试：purpose/assignment mode、profile/revision、adapter/API style、origin/base path、model、六字段能力、providerKind、十轴 budget 与 slot ID 全部冻结，并反证 binding 零 price/cost/currency/pricing 字段。
- [ ] 8.11 从 `src/agent/contracts/budget-axes.js` 唯一定义点推导十轴并写 binding，使 8.10 转绿；`maxInputTokens/maxOutputTokens` 约束相应轴，调用方不能传预算。
- [ ] 8.12 定向回归用户随后修改用途/profile/model/能力/凭据，旧 binding 与自动重试保持不变；主动换模型只能新建 `runId`。
- [ ] 8.13 先写会红的删除/失效后旧 run 行为：旧绑定身份仍可读，旧 slot 不存在或稳定鉴权失效时 `AGENT_PROVIDER_AUTH_FAILED` 且不重试，不借新同名 profile 凭据。
- [ ] 8.14 实现 binding-to-vault 借用守卫，使 8.13 转绿。
- [ ] 8.15 定向回归档案删除、clear credential、同 profileId 重建、应用重启和档案故障隔离。
- [ ] 8.16 先写会红的 S2 分层测试：bind 后不得调用模型推理、创建 formal interaction/result、提交个人上下文模型产物或工具调用记录。
- [ ] 8.17 完成 S2 test harness，只观察真实 formal run/binding 与非敏感结果，使 8.16 转绿；S3/S4 runtime seam 保持未实现。
- [ ] 8.18 定向回归测试命名/追踪，确认该证据只登记 J25 S2 Core，不冒充 J21/J22/J24 或完整 J25。

## 9. exact IPC、changed/reload 与 UI/UX fixture tracer bullets

- [ ] 9.1 先写会红的 `agent-model-ui@1.0.0` exact validator：四频道 request/result/event、九命令、get-catalog `{ok,snapshot,error}` envelope、`MODEL_ACCESS_UNAVAILABLE`、catalog snapshot、remote suggestions 六值状态、两个配置错误结果、next action 与版本不匹配矩阵。
- [ ] 9.2 在 `src/agent/contracts/` 签发独立版本化 contract，使 9.1 转绿；已签发版本目录只读，breaking/additive/metadata-only 后续分别新建 major/minor/patch。
- [ ] 9.3 定向回归额外键、缺键、unknown enum、错误 revision、credential/header/slot/raw Error/正文/路径字段，确认 exact validator fail closed。
- [ ] 9.4 先写会红的 channel/access-policy 测试：`agent-model:get-catalog/configure/pull-remote-catalog/changed` 只允许 `settings`，其它角色在进入 controller 前拒绝。
- [ ] 9.5 扩展 channels、access policy、main-owned controller 与 settings preload exact facade，使 9.4 转绿；本轮不实现正式 settings renderer。
- [ ] 9.6 定向回归 sender replacement/reload、unknown role、旧 webContents、preload 不暴露内部 channel 名/store/vault/slot/factory。
- [ ] 9.7 先写会红的单调 revision/reload 测试：先订阅后读取、changed 只带 contract/revision、旧 event/snapshot 拒绝、配置发生在订阅与读取之间不丢失。
- [ ] 9.8 实现 configure/鉴权失效后的 changed 广播与 catalog 重读协议，使 9.7 转绿；pull success/failure 不发布 changed。
- [ ] 9.9 定向回归 observer 抛错、重复通知、迟到旧 snapshot、renderer reload/restart，确认权威 revision 最终收敛且字幕系统不受影响。
- [ ] 9.10 先写会红的 fixture 清单测试，覆盖 design.md UI/UX handoff 的 catalog、DeepSeek 空 model 模板/官方连接建议/当前 alias 建议/用户确认能力/删除不重建、credential、configure、remote catalog、bind/readiness、provider/estimated token、cache hit/cache unknown 与隐私场景。
- [ ] 9.11 生成与生产 validator 同源、带 `previewOnly=true` 的版本化 fixture，使 9.10 转绿；fixture 不得依赖正式 renderer 或真实公网。
- [ ] 9.12 定向回归 fixture 未进入 `.artifacts/`、`docs/validation/`、报告或 J25 计数，并验证未知 contract/value 的 renderer fail-closed 指南可执行。

## 10. fauxProvider 生产不可达与协议边界 tracer bullets

- [ ] 10.1 先写会红的 test-build 可达性测试：只有测试入口可构造唯一 `fauxProvider()`，生产 registry 没有 `registerAdapter()`、duck typing、插件 hook 或任意路径加载。
- [ ] 10.2 实现 test-only factory/build condition 与闭合生产 registry，使 10.1 转绿。
- [ ] 10.3 定向回归生产入口 module graph、package allowlist 与实际构建导出，证明 faux/test adapter 不可达；不得只以文档关键词或一条源码正则断言。
- [ ] 10.4 先写会红的 `fauxProvider()` 协议场景：models suggestions、redirect、401/403、408/429/网络/5xx、input/output usage、cached input token 合法/缺失/不一致、barrier 与凭据副本清零。
- [ ] 10.5 实现最小 deterministic protocol substitute，使 10.4 转绿；它只替代外部 Agent 模型 provider/网络，不替代内部 catalog/configure/bind/vault/storage/controller。
- [ ] 10.6 定向回归测试不能直接写 binding、提交最终产物、覆盖 readiness 或注册第二 adapter，并确认本轮没有真实公网模型调用。

## 11. J25 S2 Core 确定性联合子边界

- [ ] 11.1 先写会红的一条表驱动 J25 S2 Core 联合旅程：真实 v6/SQLite、model-access store、每档案 vault、catalog/configure/bind、main-owned controller/exact IPC 与唯一 `fauxProvider()` 外部边界。
- [ ] 11.2 用最小产品组合使 11.1 正常路径转绿：首次 DeepSeek 空 model 模板 → 用户明确添加当前偏好或未来 model 并确认能力/用途/凭据，再加第二档案与至少第二个 model，验证四用途独立绑定、仅摘要用途换小模型和信息提取 single-shot bind；模板本身不得伪造 ready。
- [ ] 11.3 在同一旅程加入并定向回归九命令 expectedRevision、重复 profile/model、用途回落、应用重启、session_only→absent 与 catalog/changed reload；不得拆成重复搭建内部模块的多条同义旅程。
- [ ] 11.4 先写会红的联合失败矩阵：配置/store/vault 初始化失败、任一事务回滚、revision conflict、credential absent/错误、exact origin/redirect、capability mismatch、remote pull failure、档案故障隔离。
- [ ] 11.5 以最小实现使 11.4 转绿，逐项证明失败零写入、配置问题不报 `AGENT_PROVIDER_UNAVAILABLE`、Agent 故障不改变字幕 open/append/close/history/下一会话/退出。
- [ ] 11.6 定向回归删除/修改 profile 只影响未来 bind、旧 binding identity 保留、旧 slot 缺失稳定鉴权失败不重试、同 `runId` 自动重试不切模型。
- [ ] 11.7 先写会红的 token/缓存 Core 子边界：`fauxProvider()` 分别返回 provider usage + cache hit、provider usage 无 cache、无 usage 需 estimated，以及不一致 cache metadata；全路径零金额字段。
- [ ] 11.8 实现并使 11.7 转绿；S2 不创建正式 interaction，只证明供 S3 持久化和 S5 展示使用的 exact token/cache 合同与派生规则。
- [ ] 11.9 定向回归同源比较所需的模型身份、input/output token、用量来源、缓存命中率输入与相对时长事实完整，但明确不创建兄弟交互、comparison group 或 history UI，把这些留给 S3/S5。
- [ ] 11.10 先写会红的联合隐私负扫描：SQLite、ConfigStore、vault metadata/journal、renderer payload、stdio、日志、普通报告与证据 JSON 不含 credential/header、正文、现场音频、PCM/WAV、音频路径、本地绝对路径、设备名、绝对单调时刻或时钟偏移。
- [ ] 11.11 修复全部泄漏面并使 11.10 转绿；凭据一致性证明只用布尔、scope、计数、枚举与 digest，不写明文 canary 到报告。
- [ ] 11.12 定向回归 fixture preview 不进入 J25 证据，正式 settings renderer/preload 用户往返与主动换模型后的 token/缓存效率比较仍明确延后 S5-Integration。

## 12. 三条 lane、审阅、状态与交接

- [ ] 12.1 运行全部受影响的定向 core/storage/runtime/main/integration/validation 测试；每个 tracer bullet 的红只存在于当前循环内，交接前不得留下长期红测。
- [ ] 12.2 运行 `npm run test:core`，记录实际返回码和失败分类；不把源码正则、snapshot 或 fixture preview 记为产品能力证据。
- [ ] 12.3 运行 `npm run test:integration`，确认 J25 S2 Core 使用真实内部模块、只替代 provider/network/safeStorage 不可确定边界；Windows Electron 环境问题与产品断言分开记录。
- [ ] 12.4 运行 `npm run test:evidence`，确认测试仍只位于既有 lane 目录、preview fixture 未进入证据、隐私负扫描和生产 fauxProvider 不可达检查成立。
- [ ] 12.5 运行完整 `npm test`，依次验证 core/integration/evidence；任一 lane 非零不得写“联合验收完成”。
- [ ] 12.6 使用 code review 复核：ConfigStore/模型接入事实隔离、用户自定义 API base URL/model/能力、DeepSeek 空 model 模板、三接口深度、九命令零写入、v1–v5 checksum、v6 删除/绑定、vault 恢复、exact origin/redirect、readiness 不伪造、token/缓存合同、全产品零金额字段、IPC 脱敏、旧 Agent 四树未接回。
- [ ] 12.7 按实际证据更新 `docs/agent-redesign-execution-plan.md` 与 `docs/testing-strategy.md` 的 S2 状态/计数；S5-Integration 前最多写「实现完成·尚未验收」，不得晋级完整 J25、真实公网或正式 settings renderer。
- [ ] 12.8 向 UI/UX 工作线签发 `agent-model-ui@1.0.0` contract、状态矩阵、fixture 清单、未知值 fail-closed 规则和 renderer 开始门槛；明确 fixture preview 不构成 J25 证据。
- [ ] 12.9 逐路径显式暂存 S2 实现/测试/文档，提交信息逐字对照 `CONTEXT.md` 并至少引用 SEM-F33 与 J25；禁止 `git add .` 和无修饰状态词。
- [ ] 12.10 提交后再次核对用户原有未提交/未跟踪文件、旧 Agent 隔离入口、字幕产品路径和 S1 事实均未被删除、覆盖或误纳入 S2 提交。
