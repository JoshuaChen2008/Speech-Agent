# ADR 0020：NLS 云端主力识别与本地降级

- 状态：已决定
- 日期：2026-09-21
- 关联：SEM-F01/F04/F06/F12/F14/F21/F25、SEM-T06、J20、DB1/J10、I2/I3/I4
- 局部修订：ADR 0005 的识别路由；ADR 0017 中 J20 的排期后置，不恢复确认关键词。

## 决策

1. 首期只有上海 NLS、一套项目配置。默认纯本地权威识别，百炼和通义听悟后置。Agent 不拥有此能力，也不是其前置。核心字幕模型资源包必须就绪；正常云端期间本地识别器只预载、不解码。
2. 云端采用服务分段，持续发送含静音的 16 kHz 单声道 PCM16；本地 Silero 门控只约束纯本地和本地降级。请求固定 100ms 分片、中间结果及标点开启、ITN/语气词过滤/语义断句关闭、断句静音 800ms。云端会话及其本地降级不精修，界面在开始前说明且不修改全局精修偏好。
3. main 持有 AccessKey、Token 和鉴权 WebSocket；worker 持有音频缓冲、格式转换与本地识别。云端 PCM 通过有界 MessagePort 经 main 转发，这是对“PCM 不经 main”的显式例外；纯本地路径不变。凭据仅专用输入时短暂经 renderer 提交，不可回读，不进入普通配置、SQLite、日志或报告。safeStorage 缺失只允许本次应用进程内使用。
4. Token 使用 CreateToken 返回的 ExpireTime，提前五分钟刷新，同代请求合并，旧凭据代次不能覆盖新代次。新连接前验证有效期，健康连接不因刷新主动断开。上海端点受控，X-NLS-Token header 鉴权，拒绝重定向，不自动回退 query token。AppKey 和本地 revision 只冻结项目选择及参数，不证明云端模型权重不可变。
5. StartTranscription 后等待 TranscriptionStarted 才采集/送帧。启动失败拒绝开始，不自动本地降级。正常运行明确断连、稳定服务错误或存活检测失败后封闭旧代次，按最后已接受 SentenceEnd.time 的样本映射单向本地接管；该时间不是音素级准确边界，明确提示切点附近可能漏字或重复。已接受但尚未落盘的 final 也不可重识别。不得用文本相似度删除或改写原始事实。
6. worker 音频留存最多 60 秒；main、端口在途及 WebSocket 待发音频合计最多 2 秒。长静音/无文字不是故障；滚动留存不能覆盖已知未定稿段，迟到结果指向已淘汰范围、交接范围缺失、传输丢帧或硬上限突破时，主动释放采集并进入可重试错误，不能带缺口静默继续。本地追赶分批让出事件循环且仍有界。
7. 云端暂停停止采集、排空音频、停止任务并提交已接受正文；恢复新连接/task_id，同 session/source/cursor，保留暂停间隔。停止仅发送一次 StopTranscription，等待尾部 SentenceEnd 与 TranscriptionCompleted 后再提交终态。就绪和停止等待各 10 秒且纳入既有迁移/退出预算；超时保留已接受正文并显式错误，partial 永不升格为 final。降级后的暂停恢复和 Retry 均保持本地，下一新会话才重新尝试云端。
8. 配置仅无活动会话时修改。独立音频上传披露不复用 Agent 文本披露；本地不保存现场音频不代表供应商零留存。工具条与历史显示识别策略、实际 provider、降级和收尾错误。新增追加迁移保存非敏感会话快照及故障，不复用退役 recognition_* 表，不修改历史 SQL/checksum。

## 验证

J20 复用真实配置、provider adapter、router、coordinator、worker 核心、reducer、SQLite、历史与 IPC；仅不可确定外部边界使用替身。覆盖鉴权/刷新竞态、重复/冲突/迟到结果、时间映射、启动拒绝、暂停恢复、断网交接、静音、缓冲超限、存储故障、Retry、退出及隐私负扫描。保留 J16/J15c 和 Agent 关闭下的字幕旅程。

真实 NLS header 握手、项目效果、Token 跨期连接与物理来源走 I2/I3/I4。冻结字幕可见延迟仍为各来源五轮 P95 <1000ms；新增 main 事件循环延迟 P95 <50ms、P99 <100ms，验证有界队列及两小时内存趋势。确定性证据不替代实机证据。本次登记不表示实现或验收。

## 协议和验收补充（登记核查后）

上海网关固定 `wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1`，Token 签发为 HTTPS `nls-meta.cn-shanghai.aliyuncs.com`、API `2019-02-28`、CreateToken POST。AppKey 是项目选择；AccessKey ID/Secret 是 RAM 鉴权凭据；请求禁止 model。Token 的 ExpireTime 是 Unix 秒，Token 只在 main 内存缓存；签发请求超时 5 秒，暂时网络故障最多重试一次，鉴权与系统时间错误不重试。safeStorage 缺失明确显示“仅本次应用进程使用”。

NLS 云端主力路径的 mic 与 loopback 各自五轮 I2，不能复用纯本地 series；注入断连/服务错误后必须另验证真实本地 recognizer 接管。结构 fixture 只证明编排，不证明 ASR。真实 header、项目效果、Token 跨期连接分别取得证据；真实张量、物理来源、两小时 I3 与干净机 I4 缺项时保持实现完成·尚未验收。
