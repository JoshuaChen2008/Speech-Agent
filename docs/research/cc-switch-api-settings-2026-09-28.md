# CC Switch 模型设置与故障处理参考

日期：2026-09-28。范围：第一方源码静态调查；没有运行 CC Switch 窗口、使用凭据或发送真实模型请求。本文是设计参考，不是本仓库要求变更或验收证据。

固定来源：`farion1231/cc-switch`，调查时 `main` 为 [`846de29c13ac4d65f164db8c15dd5fd58e29f972`](https://github.com/farion1231/cc-switch/commit/846de29c13ac4d65f164db8c15dd5fd58e29f972)。链接全部固定到该提交，避免后续版本漂移。

## 1. 可以吸收的设置方式

| 源码事实 | 对本项目的建议（推论） | 来源 |
|---|---|---|
| `ProviderForm` 以 `initialData` 区分新建与编辑；预设选择器只在新建时展示，后续共用表单。 | 首次配置和以后编辑共用一套表单。预设是填入草稿的方法，不再同时展示第二套向导与完整配置编辑器。 | [ProviderForm.tsx:2089–2110](https://github.com/farion1231/cc-switch/blob/846de29c13ac4d65f164db8c15dd5fd58e29f972/src/components/providers/forms/ProviderForm.tsx#L2089-L2110) |
| API 密钥输入默认 password，有按需显示按钮和关闭自动填充；相关位置可提供获取密钥链接。 | 输入新密钥时借鉴掩码与就近帮助。已保存密钥仍遵守本仓库只读 present/scope 的边界，不引入明文回显。 | [ApiKeyInput.tsx](https://github.com/farion1231/cc-switch/blob/846de29c13ac4d65f164db8c15dd5fd58e29f972/src/components/providers/forms/ApiKeyInput.tsx)、[ApiKeySection.tsx](https://github.com/farion1231/cc-switch/blob/846de29c13ac4d65f164db8c15dd5fd58e29f972/src/components/providers/forms/shared/ApiKeySection.tsx) |
| Claude 表单把密钥和 Base URL 放在主流程，模型映射、上游格式等放入高级折叠区；已有高级值时会自动展开，用户仍能手动折叠。 | 主区保留服务、API 地址、密钥、模型名称；已知预设的六字段能力通过一次确认提交，自定义模型的未确认/错误字段必须展开。不要把本项目必选模型藏起来。 | [ClaudeFormFields.tsx:233–256](https://github.com/farion1231/cc-switch/blob/846de29c13ac4d65f164db8c15dd5fd58e29f972/src/components/providers/forms/ClaudeFormFields.tsx#L233-L256)、[主区与折叠区](https://github.com/farion1231/cc-switch/blob/846de29c13ac4d65f164db8c15dd5fd58e29f972/src/components/providers/forms/ClaudeFormFields.tsx#L688-L810) |
| 基础表单还有图标、颜色、备注、网站地址；密钥帮助区还可展示推广信息。 | 这些不帮助用户生成会话总结，不移植到首次配置主流程。CC Switch 的全部表单不是简洁模板。 | [BasicFormFields.tsx](https://github.com/farion1231/cc-switch/blob/846de29c13ac4d65f164db8c15dd5fd58e29f972/src/components/providers/forms/BasicFormFields.tsx)、[ApiKeySection.tsx](https://github.com/farion1231/cc-switch/blob/846de29c13ac4d65f164db8c15dd5fd58e29f972/src/components/providers/forms/shared/ApiKeySection.tsx) |

## 2. 检查与失败处理的关键区别

### 当前连通性检查不是模型推理测试

该提交中的 `stream_check.rs` 名称仍含 stream，但实现是 GET `base_url`，仅读响应头，不发送真实模型请求、不读响应正文。任意 HTTP 响应（包括 401/403/404/429/500/503）均说明网络可达，不能证明密钥或模型正确。结果保留 `httpStatus`、响应耗时、检查时间和重试次数；UI 分为连通正常、连通但较慢、无法连通。探测不会重置故障转移熔断器。[服务实现与单元断言](https://github.com/farion1231/cc-switch/blob/846de29c13ac4d65f164db8c15dd5fd58e29f972/src-tauri/src/services/stream_check.rs)、[UI hook](https://github.com/farion1231/cc-switch/blob/846de29c13ac4d65f164db8c15dd5fd58e29f972/src/hooks/useStreamCheck.ts)

默认每次 8 秒，最多重试 1 次，仅消息匹配 timeout/abort/timed out 时重试；DNS 或连接拒绝不会立即重复。超过 6000 ms 被标为较慢。这是可达性探测的参数，不能直接充当模型生成超时和重试策略。[配置、循环与分类](https://github.com/farion1231/cc-switch/blob/846de29c13ac4d65f164db8c15dd5fd58e29f972/src-tauri/src/services/stream_check.rs#L44-L124)、[分类辅助函数](https://github.com/farion1231/cc-switch/blob/846de29c13ac4d65f164db8c15dd5fd58e29f972/src-tauri/src/services/stream_check.rs#L275-L299)

**推论：** 本项目无需再添加并列的“测速 / 连通性 / 模型测试”三个按钮。保留一次明确的模型测试，并清楚区分“配置已保存”和“本次模型请求成功”。网络诊断放失败详情，不能给收到 401 的请求显示模型验证成功。

### 真正的代理失败处理依赖多供应商故障转移

真实转发路径使用 `forwarder.rs::categorize_proxy_error`：400/405/406/413/414/415/422/501 归为不可重试；其余上游状态，包括 401/403/404/429，被允许尝试另一供应商，因为其密钥、配额或模型映射可能不同。官方 Codex 路由是所有失败均不可故障转移的特例。这里的 retry 经常意味着换供应商，不等于同一绑定原样重复请求。[实际分类入口](https://github.com/farion1231/cc-switch/blob/846de29c13ac4d65f164db8c15dd5fd58e29f972/src-tauri/src/proxy/forwarder.rs#L2777-L2822)

`proxy/error.rs` 还存在一个标注 `allow(dead_code)` 的 `categorize_error`，将所有 4xx 判为不可重试；不能仅凭该函数解释主转发行为。[该辅助函数](https://github.com/farion1231/cc-switch/blob/846de29c13ac4d65f164db8c15dd5fd58e29f972/src-tauri/src/proxy/error.rs#L184-L213)

转发循环区分可重试错误与不可重试/客户端中断；后两者不污染熔断器健康度。单供应商失败与多供应商切换的日志也分开，避免没有替代供应商时仍声称“继续尝试下一个”。[健康度分支](https://github.com/farion1231/cc-switch/blob/846de29c13ac4d65f164db8c15dd5fd58e29f972/src-tauri/src/proxy/forwarder.rs#L1052-L1109)、[单/多供应商反馈](https://github.com/farion1231/cc-switch/blob/846de29c13ac4d65f164db8c15dd5fd58e29f972/src-tauri/src/proxy/forwarder.rs#L2846-L2888)

**推论：** 应学习“错误类型决定下一步”和“反馈反映真实动作”。本项目不复制故障转移队列、熔断配置页、协议整流器或自动换模型：SEM-F33 的模型运行绑定在一次运行中固定。

## 3. 本仓库落实边界

依据 [SEM-F33/F36](../semantic-contract.md)、[CONTEXT.md](../../CONTEXT.md) 与 [J25/J30](../testing-strategy.md)，建议先形成以下设计增量，再实施：

- 一个新增/编辑服务配置表单；空模板与已有配置明确区分，保留同服务多模型能力。
- 默认模型只出现一个主选择位置；信息提取、摘要与总结、分析与规划的专用选择折叠。
- 单次模型测试使用已保存配置，不隐式提交、不自动重试；测试结果不替代六字段能力确认。
- 正式运行的鉴权、地址/模型/参数、限流、超时、服务端故障按受控类别提示下一步；显示经过筛选的 HTTP 状态和稳定错误码，不透传原始服务端错误。
- “重新测试”“修改 API 密钥”“修改地址或模型”出现在失败旁；只有能从受控分类证明的原因才写具体原因。
- 保持诊断无正文、无凭据和原始 Error；不从 CC Switch 复制自由文本错误显示/日志策略。

本次只新增调研文档，没有改动语义合同、旅程矩阵、产品代码或用户配置。尚未验证外部项目运行时 UI，也没有验证本项目完整 J25/J30。后续若采纳，应先登记 SEM-F33/F36/F40 和对应旅程增量，覆盖配置编辑保留、测试与保存分离、失败分类、终态重试反馈及旧模型运行绑定不变。
