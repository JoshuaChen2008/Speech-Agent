# ADR 0009：长会话由宿主确定性规划完整 Agent 输入

状态：已决定

正式 Agent 首版不得把超过单次模型上下文的终态会话静默截断，也不得让模型自行决定读取哪些字幕段。`AgentPluginHost` 之前增加宿主拥有的确定性输入规划：Agent 模型 provider registry 先把上下文窗口、固定提示和输出预留折算成保守的 `maxChunkInputBytes`，规划器再以 canonical JSON 的 UTF-8 字节数判定边界。它按 `event_order` 顺序优先在字幕段边界切分同一冻结输入快照，覆盖全部首次稳定转写；单个字幕段本身超过预算时，再按 Unicode code point 的确定性 `[fromCodePoint, throughCodePoint)` 范围切成仍绑定同一 `event_order` 的内存片段，不能切断 surrogate pair 或丢失字符。全部分块成功后才按有界确定性批次归并，并提交一个绑定原始 `sessionId + inputWatermark + transcriptVersion + inputDigest` 的产物；任一分块缺失、失败、归并失败、预算无法容纳两个受限中间结果或输入身份变化时不提交部分产物。

首版不持久化分块正文或模型中间输出。worker 中断后沿用同一 `runId` 从冻结输入重新执行，接受额外模型成本，以避免新增第二套可恢复正文、分块 schema 和部分产物权威。短会话仍走单次调用；零条首次稳定转写不跨越字幕提交边界，不调用 Agent 模型 provider。

选择该方案是因为“截断后给出看似完整的纪要”会破坏输入水位语义，而把分块选择交给 LLM 又无法确定性证明覆盖。代价是长会话的延迟和重试成本更高，必须由 J24 的长输入、崩溃恢复、取消与隐私组合旅程约束。

关联：SEM-F28、SEM-T15、J21、J24、ADR 0008。
