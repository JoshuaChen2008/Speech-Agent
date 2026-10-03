2026-09-29 轻量方案已决定；任务1–3为实现完成·尚未验收，任务4待实施。只修现有链路，逐项红测→实现→相关回归；文档校验不构成产品验收。

## 1. 容量与兼容

- [x] 1.1 核对 CONTEXT 和当前 diff，先在 SEM-F28/F33/F36/F38/F39/F40、J25/J29/J30/J31-SIZE 登记 256,000 token 上下文目标、8,192 token 输出目标、实际字节保护值及计数方式；随后统一新总结路径预算和各层输入限制。复用版本/冻结绑定，旧运行保持原解释；默认不新增表或迁移。用窗口边界及 173,827 字节规模合成会话验证完整输入预检，不扩大其它 recipe 输入预算。

## 2. 请求合同

- [x] 2.1 登记与红测：复核 SEM-F28/F33/F36/F38/F39/F40、J25/J29/J30/J31-SIZE；先补真实请求组装的失败断言：正文不含 JSON、81920 输出能力、剩余额度不足/为零、工具消息增长、旧绑定不变。具体边界见 design §2.1–2.3；新增语义先登记再实现。
- [x] 2.2 在 recipes 合同附近提供按 recipe/version 选择的静态 JSON 输出说明与合法示例，经 AgentLoopExecutor 传入 systemPrompt；复用 exact validator 验证示例，保留 intent.route 的路由约束、摄取的独立结构与工具授权，其它 recipe 不误用纪要结构。
- [x] 2.3 接通 runner → Loop → ModelAccessRuntime → adapter 的宿主内部请求额度，v2 缺额度 fail closed；每次外发（含重试/工具后续轮）按模型能力、已知剩余预算、上下文余量取小值，禁止改写 binding.capabilities；零输出余额在外发前拒绝。未知用量不假定为零，跨重启不凭空恢复余额。
- [x] 2.4 在生产 adapter 每次请求前检查完整 messages/工具声明/输出预留及 HTTP 字节上限，复用 budget-axes 计算；验证 JSON/thinking 策略仍由冻结 requestStrategy 决定。相关合同、Loop、接入层定向回归及 S5/J29/J30 服务旅程结果成立后，方可将任务2标记实现完成·尚未验收。

## 3. 结果收束

- [x] 3.1 先写 adapter 表驱动红测：stop+合法JSON、length+合法JSON、空白、非法JSON、未知/缺失结束原因、tool_calls 中间消息及结构矛盾；然后在解析/执行工具前实施 design §2.4 的结束原因闭集，拒绝路径零工具副作用。
- [x] 3.2 复用 runner 的 JSON解析、validateRecipeOutput 与来源范围校验；增加缺字段/额外字段/超长字段/越界来源用例。所有非法结果用 AGENT_OUTPUT_INVALID 非重试收束，禁止修补、截断或保存部分结果。
- [x] 3.3 用真实 runner/Loop/Model Access/storage worker/SQLite 扩展既有服务旅程：成功仅一个纪要；失败、取消、迟到成功均零纪要；取消先提交/成功先提交按事务事实分别断言。保留请求预留、原绑定、字幕独立与失败清理；仅网络/provider等外部边界使用替身。
- [x] 3.4 跑 design §验证命令并记录实际结果；错误诊断仅指标/稳定分类，usage未知保持null。第2–3步局部及服务旅程证据不替代任务4的Electron旅程、公网验证或阶段联合验收。

## 4. 正式旅程

- [ ] 4.1 运行受影响 focus 与 verify:renderer，扩展一条正式 Electron/SQLite 旅程覆盖短会话及窗口内合成会话生成→保存→重开，173,827字节样本明确拒绝、取消/失败零纪要和下一字幕会话（J25/J29/J30/J12）；只替代外部边界，复用既有恢复测试。真实 DeepSeek 单独留证，阶段联合验收由当前 revision 完整 CI 或本地三条 lane 承担；记录未验证范围，分块归并交给 B。

2026-09-29 review修订：任务1撤销字节÷2及173,827字节成功预检承诺，按SEM-F39/F40保守字节单位验证86,914字节边界；173,827字节明确拒绝。小窗口统一专用错误，J30失败清理停止scheduler。状态：实现完成·尚未验收；具体命令见testing-strategy末尾。
