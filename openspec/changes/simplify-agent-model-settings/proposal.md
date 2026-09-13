## Why

当前模型设置直接展示“配置档案”“凭据”“model”等内部表述，并将连接、模型能力、新建表单与四用途同时展开，用户难以判断先做什么。需要用清晰的字段说明和逐步呈现组织既有模型配置能力。

状态：已决定；本次执行范围扩展为首次配置向导、版本化服务预设和显式模型测试。关联 SEM-F00/F23/F33/F36/T04/T05/T06、J25，视觉回归关联 J18。

## What Changes

- 页面以“Agent 模型”命名，说明用途与字幕系统独立性；将展示名称明确映射到规范术语。
- 按服务连接、API 密钥、模型确认、测试与默认用途组织首次配置；测试是可跳过的独立验证步骤，但默认用途必须明确设置。
- 收起新建表单与高级标识；已有配置优先展示默认模型摘要和服务列表。
- 六项模型能力在自定义模型时显式确认；产品维护的服务预设允许用户一次确认，详情仍可展开查看。
- 首次配置提供 DeepSeek、OpenAI、通义千问（北京）三个服务预设；现有 DeepSeek 空模型模板仍保持兼容，自定义 OpenAI-compatible 档案仍可用。
- 提供用户明确触发的独立模型测试；测试不创建正式 Agent 交互、不保存正文、不修改配置。
- 与 [输入框样式规划](../fix-settings-input-styles/proposal.md) 分开实现与验收。

## Capabilities

### New Capabilities

- `agent-model-settings-guidance`: 登记既有 Agent 模型配置档案的展示文案、信息顺序及失败场景，细化 SEM-F33/J25。

### Modified Capabilities

`agent-model-settings-guidance` 扩展现有 SEM-F33/J25 展示语义，新增预设目录、向导状态和设置层独立模型测试的边界；模型运行绑定、凭据槽和正式 Agent 任务的既有语义保持不变。独立测试通过 `agent-model-test-ui@1.0.0` 的 `testSavedModel` 设置 IPC，不属于 Agent 模型接入层的三接口、九条配置命令或 `bind()`。

## Impact

后续涉及 `src/settings/agent-model-pane.tsx`、`agent-model-view-model.ts`、设置导航、版本化预设 registry、设置层 test IPC/preload、模型接入策略元数据的增量 migration 和正式 J25 旅程断言。预设是随应用版本发布的只读代码数据；策略元数据通过追加 model-access migration 保存，既有 v1-v8 migration checksum 不改写。凭据机制、模型运行绑定和 recipe 闭集保持原语义。
