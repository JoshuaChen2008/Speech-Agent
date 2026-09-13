## ADDED Requirements

### Requirement: Model settings explain user concepts without exposing internal machinery

界面 SHALL 按 design 的展示映射使用“Agent 模型”“服务配置”“API 密钥（API Key）”“模型名称（Model ID）”，先解释用途及字幕系统独立性，不展示 recipe、adapter、factory、凭据槽或 IPC 标识。关联 SEM-F00/F33/T05、J25。

#### Scenario: User opens model settings
- **WHEN** 用户进入 Agent 模型设置
- **THEN** 可以直接读到问答、摘要和分析用途以及实时字幕无需此配置的说明，看到一份服务配置可有多个模型的说明
- **AND** 页面显示名称与导航一致，配置标识仅在高级设置中出现；规范数据身份不变

### Requirement: Configuration follows connection credential model and purpose order

界面 SHALL 按连接、API 密钥、模型确认、测试（可跳过）与默认用途组织首次配置，保留独立命令回执；测试可跳过但默认用途必须明确设置。已有配置优先显示默认模型摘要和服务列表，新建表单及专用用途默认折叠。关联 SEM-F23/F33/J25。

#### Scenario: First initialization uses existing template
- **WHEN** 首次初始化后用户打开页面
- **THEN** DeepSeek 模板仍为空模型、空用途且无密钥，展示真实缺项；不暗示已接通服务，也不隐式写入建议

#### Scenario: User creates a custom service and assigns a model
- **WHEN** 用户主动添加服务连接、设置密钥、确认模型能力并指定默认模型
- **THEN** 每阶段按现有 expectedRevision 命令提交并等待权威回执；专用用途未配置时明确显示使用默认模型
- **AND** 同一服务可添加第二个模型而无需重设密钥，同一服务商可另建独立配置

#### Scenario: Advanced field is invalid
- **WHEN** 自动推导的配置标识非法或重复，或高级字段存在校验问题
- **THEN** 对应区域自动展开并显示修正说明，用户可通过键盘到达字段；折叠、取消本身不提交或发网

### Requirement: Model suggestions require explicit complete capability confirmation

界面 SHALL 只在主动获取时请求目录；建议只填草稿，模型标识和全部六项能力经用户明确确认后才能保存，不自动分配用途。关联 SEM-F33/J25。

#### Scenario: User applies a model suggestion
- **WHEN** 用户获取模型列表或使用既有模板建议
- **THEN** 页面展示填写结果及存在的来源日期，打开六字段能力确认区域；未知字段保持未知，缺少必需值不得提交
- **AND** 仅用户点击确认保存并取得成功回执后，模型才进入已保存列表

#### Scenario: Model does not report usage
- **WHEN** 用户将用量上报设为不支持
- **THEN** 页面说明交互将显示用量未知且不能参与用量比较，仍允许按既有能力规则保存及运行，不伪造 Token 数或金额

### Requirement: Failure and readiness messages reflect authoritative facts

界面 SHALL 保留三值 readiness、三种密钥 scope、六值 remote 和既有配置错误的语义，提供通俗说明，不把配置充分或目录成功展示为连接/推理成功。关联 SEM-F33/T04、J25。

#### Scenario: Remote catalog cannot be fetched
- **WHEN** 获取返回 remote_unavailable
- **THEN** 显示暂时无法获取列表并保留手动添加，不猜测具体网络原因，不写模型、revision 或 changed，不自动重试或切换服务

#### Scenario: Save conflicts after connection was saved
- **WHEN** 模型保存或用途分配遭遇 revision 冲突
- **THEN** 指明本次操作未保存并提供既有重新载入路径，不宣告整个配置成功，不删除此前已保存连接或重发旧命令

#### Scenario: Session-only credential is lost on restart
- **WHEN** 使用仅本次运行有效的密钥后重启应用
- **THEN** 权威 scope 为 absent 时明确提示重新设置 API 密钥，不能因缓存文案显示已设置；既有密钥始终不回显

#### Scenario: Default model and dedicated purposes are displayed
- **WHEN** 默认模型未配置或某用途已有专用模型
- **THEN** 未配置默认不会被“使用默认模型”掩盖，专用用途显示实际服务配置与模型身份，页面重排不改用途选择或既有模型运行绑定

### Requirement: First-run wizard and versioned service presets reduce technical setup

首次没有已保存模型时，界面 SHALL 提供连接、API 密钥、模型确认、测试（可跳过）与默认用途四步向导；测试可跳过但默认用途必须明确设置。预设 SHALL 仅来自版本化的 DeepSeek、OpenAI、通义千问（北京）登记项，且包含稳定 `presetId@version`、精确连接、模型名称、地域、六项能力、应用上限、固定请求策略、来源日期和官方帮助标识。第一步和第二步分别提交连接与 API 密钥；第二步提交后凭据可按 SEM-F33 保存，第三步模型确认前只禁止写入 model、能力和用途；预设/建议在提交前只存在于向导草稿。预设的一次确认 SHALL 允许用户保存完整能力；自定义模型仍要求用户明确确认全部六字段。关联 SEM-F23/F33/F36、J25。

#### Scenario: User chooses a service preset
- **WHEN** 用户选择 DeepSeek、OpenAI 或通义千问（北京）预设
- **THEN** 页面预填服务连接与一个登记模型，说明预设是产品维护的应用上限和来源日期
- **AND** 第三步模型确认前不写入 model、能力或用途；第二步已提交的凭据可保持已保存状态。通义千问预设明确为北京地域，不能暗示其它地域可复用
- **AND** 选择 DeepSeek 预设不会改写首次初始化的空 model 模板；只有用户分别提交连接、API 密钥和模型确认后才产生对应权威事实
- **AND** 向导使用的 `preset.<presetId>` 及整个 `preset.` 标识命名空间由存储边界保留；相同服务商、连接和 model 的自定义配置仍使用 `openai-compatible@1`

#### Scenario: User leaves a wizard midway
- **WHEN** 用户取消、关闭或返回而没有提交当前阶段
- **THEN** 已成功保存的阶段保留，未提交草稿清除；重新进入依据权威 catalog 恢复，不自动发网或重放旧命令

### Requirement: Model test is explicit, bounded, and separate from configuration

界面 SHALL 提供用户明确触发的独立模型测试。`agent-model-test-ui@1.0.0` 的 `testSavedModel` 精确接收 `{contractId,contractVersion,profileId,modelId,expectedRevision,testId}`，取消命令 `cancelSavedModel` 精确接收 `{contractId,contractVersion,testId}`；`testId` 为 renderer 生成的有界不透明标识，窗口关闭、renderer 卸载或取消命令都收束挂起请求为 `cancelled`，迟到结果丢弃。响应恰为 `{contractId,contractVersion,testId,ok,status,nextAction}`；`status` 闭集为 `success|invalid_request|revision_conflict|credential_unavailable|auth_failed|timeout|rate_limited|redirect_rejected|response_invalid|remote_unavailable|cancelled`，`nextAction` 闭集为 `none|reload|set_credential|edit_connection|check_model|retry`，映射固定为 `success→none`、`invalid_request/redirect_rejected→edit_connection`、`revision_conflict→reload`、`credential_unavailable/auth_failed→set_credential`、`response_invalid→check_model`、`timeout/rate_limited/remote_unavailable→retry`、`cancelled→none`。`expectedRevision` 比较 live catalog revision，不一致时不发网络请求。测试不属于 Agent 模型接入层三接口、九条配置命令，且不得调用 `bind()`；只使用已保存的精确服务配置、模型、版本化预设策略和凭据，通过 main-owned 接口执行一次有界无副作用请求，不修改配置、用途、绑定、正式交互、个人上下文、历史、报告或保存响应正文，也不发 `changed`。独立测试的 `auth_failed` 不清除凭据；正式调用/remote catalog 的 401/403 仍按 SEM-F33 失效对应凭据档案。关联 SEM-F33/F36、J25。

#### Scenario: User tests a saved model
- **WHEN** 用户点击测试模型
- **THEN** 页面显示进行中状态并发送固定无字幕测试请求；成功只报告本次收到有效响应，不表示所有模型能力或真实任务质量已验证
- **AND** 测试结果不保存响应正文、不创建正式 Agent 交互、不会自动切换模型或隐式修改配置
- **AND** 测试不发出 `agent-model:changed`，配置 revision、SQLite 行、绑定和凭据状态保持不变

#### Scenario: Test request is bounded or rejected
- **WHEN** 测试超时、被取消、配置 revision 变化、凭据无效、跳转被拒绝或响应不符合协议
- **THEN** 返回稳定的有界结果和下一步说明，保留已保存配置，不显示原始服务端错误正文

#### Scenario: Test cancellation and stale results are deterministic
- **WHEN** 用户关闭设置窗、renderer 卸载、主动取消，或取消与 provider 响应同时到达
- **THEN** 每个 `testId` 只收束一次；先到达的终态获胜，未知或已终态 `testId` 的取消按幂等规则返回 `cancelled`，迟到结果丢弃
- **AND** 请求发出前与 provider 返回后都比较 live catalog revision；后一次不一致时返回 `revision_conflict` 与 `reload`，不把旧配置的成功提交到页面；响应 `ok` 恰为 `status=success`，未知字段或映射被拒绝
- **AND** renderer 在收到取消回执后仍等待 main 返回该测试的终态，不得用取消回执覆盖先到达的 provider 结果；正式或目录鉴权失效清理同时匹配发起时的旧 credential slot 与 profile revision
