## ADDED Requirements

### Requirement: Cloud latency evidence covers sustained visible text
系统 SHALL 以真实云端识别适配器、Coordinator 与字幕 renderer 测量首个 partial、持续文字更新、积压恢复、定稿和启动；不得以本地 I2 或 NLS 已处理音频水位替代持续显示证据。关联 SEM-F01/F04/F25、J20/I2。

#### Scenario: Speech continues after the first partial
- **WHEN** 受控语料已经出现首个 partial 并继续讲话
- **THEN** 测量继续覆盖冻结词/短语锚点、有效更新间隔、最长停滞与覆盖缺失，不因首字低于某阈值就结束观测

#### Scenario: Recognized text omits an anchor
- **WHEN** 供应商已处理音频时间前进但显示正文未出现受控锚点
- **THEN** 该锚点计为覆盖缺失而非快速成功，禁止从质量与延迟报告中静默删除

### Requirement: Transient backlog is recovered with bounded work
系统 SHALL 在经实测登记的吞吐范围内缩小暂时积压，避免恢复后继续等速保留欠账；有界恢复、顺序、2 秒待发上限和音频连续性同时成立。关联 SEM-F12/F14、J20。

#### Scenario: A short delivery stall ends
- **WHEN** 持续采集期间发生已登记的 100/300/600/1200ms 交付停顿，网络随后恢复，未超过硬上限
- **THEN** 后续待发时长回落至无停顿基线一个帧时长以内，恢复耗时按入选策略登记上界校验，不能仅在停止后排空

#### Scenario: Congestion persists
- **WHEN** socket 或上游持续无法消费导致音频硬上限突破
- **THEN** 使用稳定故障路径主动释放采集，不静默丢音频、不无限补发、不把错误解释成延迟优化

### Requirement: Cloud packetization preserves local recognition semantics
系统 SHALL 按冻结云端策略选择经过实测的帧时长，以样本和毫秒核对连续性、流控与内存；纯本地及云端降级后的本地 VAD/识别语义保持既有要求。关联 SEM-F01/F12、J16/J20。

#### Scenario: Cloud uses smaller frames and then falls back
- **WHEN** 云端小帧会话明确断连并按已提交样本边界接管
- **THEN** 本地入口获得连续且正确重组的输入，段前缓冲和 provisional 时长不因帧数变化缩短，已接受首次稳定转写不重复

### Requirement: Experiments isolate variables and preserve quality
候选筛选 SHALL 使用冻结语料、同机同项目、来源隔离的交错配对实验；生产默认只接受经过真实服务验证的发送、网关和请求配置。关联 SEM-T03/T06、J20/I2/I3。

#### Scenario: A candidate appears faster
- **WHEN** 候选缩短某一延迟指标但增加漏字、最长停滞或协议错误
- **THEN** 结果保留在候选比较中并拒绝直接推广，不因单项均值改善宣称体验改善

#### Scenario: A nearby gateway responds quickly to HTTPS
- **WHEN** 无鉴权 HTTPS 探测更快但未验证 NLS 会话
- **THEN** 仅记录网络线索，必须验证鉴权、实际识别、持续回传与质量后才改变默认网关

### Requirement: Historical recognition bindings remain readable
系统 SHALL 将旧绑定的合法形状与当前默认参数分离，新会话冻结实际请求及传输策略身份，旧会话在参数变更和回滚后仍能读取。关联 SEM-F21/T08、DB1/J10/J20。

#### Scenario: Default sentence silence changes
- **WHEN** 新会话采用经验证的新断句配置
- **THEN** 旧会话的 800ms 参数快照仍按旧规则读取，新请求与新冻结绑定一致，活动会话不被全局修改

### Requirement: Diagnostics retain no private payload
诊断 SHALL 仅持久化受控枚举、计数、相对指标和哈希，时间校准与正文比对限于有界内存；缺失测量不能用零填充。关联 SEM-F14、J12/J20。

#### Scenario: Clock calibration is invalid
- **WHEN** 进程时钟校准质量不足或因果顺序无法成立
- **THEN** 相应分段显式未知，禁止写入时钟偏移、绝对时刻或用钳零值伪造低延迟

### Requirement: Cloud experience qualification is independent from a single local threshold
云端优化 SHALL 以持续跟随、恢复、首字、定稿、质量与资源组成的实测结果选型；达到 800ms 或 1000ms 不构成停止优化或完整验收。实施前须同步现行语义合同及 ADR 的云端口径，纯本地冻结门槛和历史事实保持不变。关联 SEM-T01/T02/T06、J20/I2。

#### Scenario: First partial is fast but later text remains behind
- **WHEN** 首个 partial 满足旧阈值但连续讲话出现持续积压或漏字
- **THEN** 云端体验资格不成立，仍需持续测量与改进；不得引用首字指标宣称整场体验达标
