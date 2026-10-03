# Agent 模型设置：Tau 与 CC Switch 参考调研

调研日期：2026-09-28。本文记录外部证据与本项目建议，不修改已决定语义，不表示产品实现或验收。用户明确指定的 Tau 是 `huggingface/tau`。

参考范围：API 设置的信息组织、模型选择、请求错误分类与重试反馈。未安装或启动外部应用，未使用真实密钥调用模型。主要依据固定提交源码，不能把源码阅读称为视觉或实机验收。

## 结论

建议以 Tau 的“连接服务、选择模型分工明确”为主，以 CC Switch 的共用编辑表单和高级项折叠为辅。不要继续叠加首次向导、完整服务列表、默认用途编辑三套表面。

错误处理借鉴 Tau 的 HTTP 分类、可见重试与可取消等待；不照搬服务端原始错误正文，也不引入自动更换 Agent 模型 provider。CC Switch 的代理故障转移与本项目不可变模型运行绑定不同。

## 固定来源

- Tau：[`huggingface/tau@15ca794ab3ae04f40fd8a260246be1bf435decbf`](https://github.com/huggingface/tau/tree/15ca794ab3ae04f40fd8a260246be1bf435decbf)。
- CC Switch：[`farion1231/cc-switch@846de29c13ac4d65f164db8c15dd5fd58e29f972`](https://github.com/farion1231/cc-switch/tree/846de29c13ac4d65f164db8c15dd5fd58e29f972)。逐项依据见[独立调研](cc-switch-api-settings-2026-09-28.md)。
- 本项目约束：[CONTEXT](../../CONTEXT.md)、[语义合同 SEM-F33/F36/F40](../semantic-contract.md)、[J25/J30 与测试分层 §2.1](../testing-strategy.md)。

## Tau 的设置交互

| 已核实事实 | 对本项目的启发 |
|---|---|
| 内置服务的 `LoginScreen` 只有一个掩码 API key 输入；选服务在前一个选择器，选模型在独立 `ModelPickerScreen`。[登录源码](https://github.com/huggingface/tau/blob/15ca794ab3ae04f40fd8a260246be1bf435decbf/src/tau_coding/tui/app.py#L3344) | 连接只在新增、换密钥或修复时编辑；日常主要选择模型。不要在每张模型卡片重复展示密钥输入。 |
| 模型选择器有搜索、紧凑列表、当前选择定位；先呈现缓存行，再触发刷新。[选择器源码](https://github.com/huggingface/tau/blob/15ca794ab3ae04f40fd8a260246be1bf435decbf/src/tau_coding/tui/app.py#L2944) | 一个模型选择控件同时支持搜索和当前选择。可先展示本地已保存目录；本项目保持远端目录由用户显式刷新，不照搬自动联网。 |
| 自定义服务并非极简三字段：包含内部名称、展示名、base URL、环境变量名、模型列表、默认模型、API key 共七个输入；校验失败更新当前提示并聚焦字段。[自定义表单](https://github.com/huggingface/tau/blob/15ca794ab3ae04f40fd8a260246be1bf435decbf/src/tau_coding/tui/app.py#L3200) | 借鉴局部校验与焦点，不照搬七字段。我们自动生成内部标识，不暴露环境变量名；默认模型从模型选择中确定，不要求另抄一遍。 |
| 自定义保存先写目录、再写凭据、再写偏好，外层捕获异常。该函数本身未形成跨文件原子事务。[保存路径](https://github.com/huggingface/tau/blob/15ca794ab3ae04f40fd8a260246be1bf435decbf/src/tau_coding/tui/app.py#L6795) | 单一表单不等于后端已有原子保存能力。不能把本项目九条配置命令组合后，笼统承诺失败零副作用；需要准确回执与继续编辑入口。 |
| 内置目录与用户目录分层，明确不读取项目级目录来覆盖模型服务连接。[目录说明](https://github.com/huggingface/tau/blob/15ca794ab3ae04f40fd8a260246be1bf435decbf/website/content/guides/providers-and-models.md#L512) | 内部用版本化预设减少手填；用户确认后才成为本项目配置事实。保持受信任连接边界。 |

这不是将 TUI 样式照搬成 Electron 页面；值得保留的是“每次只处理当前动作”。Tau 当前源码也包含 OAuth、多个账户、动态目录等较大范围，不能因项目定位轻量就把全套配置层引入。

## Tau 的故障处理

1. OpenAI-compatible adapter 在 HTTP 边界分类。`408/409/425/429` 与 `>=500` 视为暂时故障；`400/401/403/404/422` 不在该重试集合。是否重试另受 `max_retries` 限制。[分类源码](https://github.com/huggingface/tau/blob/15ca794ab3ae04f40fd8a260246be1bf435decbf/src/tau_ai/openai_compatible.py#L1382)、[次数判断](https://github.com/huggingface/tau/blob/15ca794ab3ae04f40fd8a260246be1bf435decbf/src/tau_ai/openai_compatible.py#L404)。
2. HTTP 错误事件保留状态、模型身份及解释。网络异常在尚未发出模型内容时可以重试；已有内容时不走这一网络重试分支，避免重复发出内容或工具调用。[请求处理](https://github.com/huggingface/tau/blob/15ca794ab3ae04f40fd8a260246be1bf435decbf/src/tau_ai/openai_compatible.py#L282)。
3. 重试事件提供下一次尝试、总次数、等待秒数和原因；等待从 0.25 秒按指数增长并受配置上限限制，等待期间每 0.05 秒检查取消。[retry.py](https://github.com/huggingface/tau/blob/15ca794ab3ae04f40fd8a260246be1bf435decbf/src/tau_ai/retry.py#L11)。
4. 不能照搬它的隐私处理。`http_errors.py` 会优先返回 provider 的 `error.message`，后备路径才截取原始 body 的前 1000 字符；JSON message 分支没有同样的截断。adapter 的错误/重试事件还直接携带 `body`。函数注释中的“secret-free”不是数据脱敏证明。[错误文本函数](https://github.com/huggingface/tau/blob/15ca794ab3ae04f40fd8a260246be1bf435decbf/src/tau_ai/http_errors.py#L13)、[事件数据](https://github.com/huggingface/tau/blob/15ca794ab3ae04f40fd8a260246be1bf435decbf/src/tau_ai/openai_compatible.py#L290)。

本地对下载的固定版本做了两个小探针：独立执行状态分类函数，确认上述状态集合；调用错误文本 helper，确认合成错误中的标记会原样进入结果。没有运行 Tau 的完整依赖、TUI 或网络旅程，探针不构成上游产品验收。

## 建议的本项目界面

日常主页面只呈现一个默认模型选择和当前事实：

```text
Agent 模型

默认模型    [DeepSeek · 当前模型名称 ▾]
连接状态    配置已保存 · 尚未测试

[测试模型]  [编辑连接]

▸ 按用途指定模型
▸ 管理模型服务
```

点击“新增服务”或“编辑连接”进入同一个表单：

```text
模型服务    [DeepSeek / OpenAI / 通义千问 / 自定义]
API 地址    [完整 API base URL]
API 密钥    [掩码输入，已有值只显示状态与更换动作]
模型        [选择或输入模型名称]

▸ 模型能力与高级设置

[保存]      [取消]
```

设计建议：

- 内置预设填入地址和能力草稿；用户仍明确确认六项能力。已知预设可以集中确认，未知值必须打开相应字段填写，不能隐藏必填缺口。
- 页面接收一个完整 API base URL，内部解析为既有受信任 HTTPS origin 与 base path，并沿用严格校验。这只是输入呈现建议，不放宽连接合同。
- “新增服务”的预设是表单选择项，不在配置列表里另外生成一张容易误认为已配置的空服务卡。当前空模板与预设隔离是已决定规则，如调整初始化或复用规则，必须先修订 SEM-F33/F36、J25，不能直接按 URL 合并有独立凭据的档案。
- 首个保存模型可让用户在同一表面勾选“设为默认”；明确保存配置与默认用途的各自结果，避免保存中断后只有半套配置却无恢复提示。
- “获取模型建议”放进模型选择控件，目录失败仍能手填；获取列表不等于模型协议测试。
- 高级设置只展示确实可编辑的模型能力。隐藏配置标识和“普通请求 / Agent Loop”等不帮助用户选择的内部信息。
- 保存不隐式联网；“测试模型”继续显式触发固定、无字幕和个人上下文的独立请求。测试结果绑定配置身份，编辑连接、模型或密钥后旧结果不能继续显示为当前结论。
- 正式运行失败后只显示一块主错误反馈，附“修改设置 / 重试 / 查看诊断”中适用的动作。运行细节与历史不重复铺设同一错误。

以上是建议，尚未登记为实施规格；尤其替换四步向导需要修订 SEM-F36，不能只靠 CSS 折叠绕过产品语义。

## 建议的错误与动作对应

| 已确认的失败事实 | 面向用户的反馈 | 执行建议 |
|---|---|---|
| 请求参数被拒绝（例如 400/422） | 请求参数与当前服务不兼容；检查模型能力或设置 | 相同请求不自动重试 |
| 鉴权/访问被拒绝（401/403） | 服务拒绝访问；检查 API 密钥及权限 | 不盲重试；不能仅凭状态断言密钥字符串错误 |
| 端点或资源不存在（404） | API 地址或模型未被服务识别 | 不盲重试；没有结构化证据时不武断断言是模型不存在 |
| 余额/配额不足 | 显示受控的账户或配额提示 | 仅在受支持 provider 的稳定状态或错误码确证时分类，不把所有限额问题混成等待重试 |
| 暂时限流（429） | 服务限流，显示下一次尝试和等待时间 | 在总预算内有限重试；配额耗尽等永久事实需另外识别 |
| 网络连接或超时 | 连接失败或响应超时 | 有限重试；取消可中断等待 |
| 服务端故障（5xx） | 服务端请求失败，给出受控状态 | 有限重试，不自动换模型 |
| 返回格式不符 | 模型响应格式不符合当前请求要求 | 不当作连接失败；保留明确稳定错误码 |

上述表是本项目建议，不是宣称 Tau 或 CC Switch 已逐项实现。

错误分类应在 adapter 内保留事实，主进程控制总尝试次数和预算，UI 只呈现受控结果。不要再增加一套独立自动重试，造成 adapter 与执行宿主重试次数相乘。独立模型测试按 SEM-F36 仍不自动重试。

新增 HTTP 状态、网络分类、受控 provider 错误码或 nextAction 必须先登记 SEM-F33/F36/F40 及 J25/J30；不直接把原始 body、Error、stack 放进诊断。对未知错误维持“请求失败，原因未分类”，比凭空断言“服务暂时不可用”准确。

## 后续实施验证边界

- J25：首次配置、编辑复用、默认用途、四用途继承、失败保留输入、目录失败手填、未知能力必须补齐、部分配置回执、旧测试结果失效。
- J30：400/404/422 不盲重试，429/网络/5xx 有界重试，等待中取消，终态与历史反馈一致，错误正文/凭据负扫描。
- J12：模型配置、测试及失败都不影响字幕系统独立运行。
- 在正式 main/preload/renderer、Agent 模型接入层及 SQLite 路径验证；替身限于 provider/网络/系统凭据等外部边界。视觉与真实公网调用需单独核查。

本轮只新增研究 Markdown，按 testing-strategy §2.1 核对术语、语义边界与链接，不运行产品测试或修改用户模型设置。
