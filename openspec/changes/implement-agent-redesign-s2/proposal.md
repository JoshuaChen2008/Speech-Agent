## Why

S1 已建立个人上下文与保守的 `provider_not_configured` 基线，但新的正式 Agent 仍缺少可配置、可冻结、可审计且不泄露凭据的 Agent 模型接入层。S2 需要把已决定的多档案、四个模型用途、按档案凭据与不可变模型运行绑定收敛为一份可实施合同，同时保持字幕系统和 ConfigStore 产品偏好完全独立。

## What Changes

- 定义 main-owned `catalog()`、`configure(command)`、`bind(runRequest)` 三接口；`catalog()` 纯读，`configure()` 只接受九条闭集命令，`bind()` 只在运行创建期冻结一次模型运行绑定。
- 规定 migration v6 的非敏感配置事实与不可变绑定事实：多配置档案、档案内模型、四个模型用途和运行绑定；删除或修改档案只影响未来绑定，既有绑定继续保留可复现模型身份。
- 规定每档案独立 `safeStorage` 凭据槽、`session_only` 降级、重启后 `absent`、稳定鉴权失败失效，以及凭据明文不得进入 SQLite、renderer、环境变量、日志或报告。
- 规定 OpenAI-compatible 连接规范：`https_origin` 与 `base_path` 分离、exact origin、redirect 拒绝、loopback 推导 `providerKind`、禁止环境凭据与 Pi `envApiKeyAuth()`。
- 规定六字段能力、用途回落默认、十轴预算绑定，以及同一 `runId` 自动重试不得切换绑定；删除价格目录、单价覆盖、pricing revision、费用估算与金额展示，只保留 input/output token、用量来源、provider 明确返回的 cache-hit/cache-miss input token 和可派生的缓存命中率。
- 提供首次初始化时的 DeepSeek OpenAI-compatible provider 模板：只预填用户可编辑的 API base URL 与官方文档来源的能力建议，不写入具体 model、不指派默认用途、不保存凭据。model ID、六字段能力确认、用途和凭据均由用户明确提交；当前官方别名 `deepseek-v4-flash` 只可作为目录建议，不成为 migration 或产品绑定。
- 冻结 `agent-model:get-catalog`、`agent-model:configure`、`agent-model:pull-remote-catalog`、`agent-model:changed` 的版本化 exact IPC 和脱敏 fixture；远端目录拉取是 main application adapter 的用户动作，不扩张模型接入层三个公开接口。
- 规定 S2 向 Agent 处理资格组合提供非敏感、可复算的 readiness 事实；配置不足时保持 `provider_not_configured`，不得用测试替身或一次 IPC 成功伪造 `ready`。
- 规定 `fauxProvider()` 只在测试构建可达，并以它验证 bind 后的连接、redirect、鉴权失效与目录建议协议；S2 不发起真实模型推理或真实公网调用。
- 以 tracer bullet 组织后续实施任务：每个 seam 先红测、最小实现、定向回归，再依次恢复 core、integration、evidence 三条 lane；J25 只登记 S2 Core 子边界，正式设置 renderer 与用户主动换模型后的 token/缓存效率比较延后到 S5-Integration。

## Capabilities

### New Capabilities

- `model-access`: 覆盖 S2 的 v6 模型配置事实、三接口、九命令、凭据生命周期、用户自定义 API base URL/model/能力、DeepSeek provider 模板、连接与目录安全、四用途解析、不可变模型运行绑定、token/缓存用量合同、readiness、exact IPC 与 UI/UX fixture。

### Modified Capabilities

无现存 OpenSpec capability 被修改。项目负责人已决定不计算价格金额、只保留 token 与缓存命中率，并把 DeepSeek 收紧为不含具体 model 的 provider 模板；model ID、API base URL、六字段能力、用途与凭据由用户定义。该决定与当前 SEM-F33/J25/ADR 0014/data architecture 中的价格和“预置档案含 model”语义存在差异，必须按 tasks.md 在实施前先同步权威文档。

## Impact

- 当前 change 只新增 `openspec/changes/implement-agent-redesign-s2/` 下的 proposal、design、delta spec 与 tasks，不修改 `src/**`、`test/**`、migration、main/preload 或 renderer 产品代码。
- 后续实施范围将涉及 `src/agent/model-access/`、v6 storage schema/store、main-owned 凭据 vault、Agent 模型接入 controller、版本化 contract/fixture，以及既有 `test/{contracts,main,runtime,storage,integration,validation}` lane。
- ConfigStore 继续只拥有 `agentEnabled`、`memoryEnabled`、自动处理边界、云端披露与 `agentSettingsRevision` 等产品偏好；配置档案、模型、凭据槽、用途指派、模型配置 revision、目录 revision 和模型运行绑定全部属于 Agent 模型接入层，禁止双写或互相代管。
- S2 不实现正式 settings renderer、S3 固定 recipe 运行时、S4 Agent Loop、S5 交互历史/导出，也不要求真实公网 Agent 模型调用。
