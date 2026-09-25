# 云端实时识别接入建议

调研日期：2026-09-21。按用户本轮范围，仅研究阿里云及同类持续音频实时识别 API；内容精修不进入本轮交付。本文是研究建议，不登记新的产品决定，不表示实现或验收。未调用付费 API、未采集或上传现场音频。

## 建议

本轮补充 ISI/NLS 后，首接建议改为阿里云智能语音交互的 NLS 实时语音识别，内部 adapter 暂名 `NlsRealtimeProvider`；百炼作为第二种协议候选。先闭合一条 J20 用户旅程，再验证跨产品线扩展，不先铺开百炼三个模型。优先级由用户要求明确，J20 仍不应成为 Agent 的依赖。

NLS 的产品范围与当前连续音频字幕需求吻合，提供段身份、时间信息和独立的段结束/全流结束事件。它并非 Fun-ASR 的别名，也不是百炼 API Key 下换一个模型名。该优先级是工程范围建议，不是识别质量或速度排名；两条产品线仍须同语料实测。[NLS 官方协议](https://help.aliyun.com/zh/isi/developer-reference/websocket)。详见 [NLS 补充调研](nls-realtime-api-2026-09-21.md)及[其它协议比较](realtime-asr-api-protocols-2026-09-21.md)。

“同类 API 接入”建议定义为：提供统一的设置、会话生命周期、字幕事件及失败策略；每个不同协议由项目维护专用 adapter。不能承诺用户填写任意 URL、Key、model 就支持所有实时 ASR，也不能把 OpenAI-compatible 文本调用格式视为音频流兼容标准。

## 已存在的边界与实际缺口

依据 [CONTEXT](../../CONTEXT.md)、[SEM-F01/F03/F04/F12/F14/F21/F25](../semantic-contract.md)、[J16/J20 与测试分层](../testing-strategy.md)、[ADR 0005](../adr/0005-separate-recognition-and-agent-providers.md) 和[ADR 0017](../adr/0017-retire-confirmed-recognition-terms.md)：

- 识别 provider 与 Agent 模型 provider 独立。云端识别直接产生首次稳定转写，Agent 只消费已提交正文。
- 正常云端期间，本地核心字幕模型资源包保持就绪，本地识别链路不持续解码；故障后同一会话单向降级。
- 每次仍只有 mic 或 loopback 一个音频来源；策略、服务、模型和地域在开始时冻结。
- PCM 仅留在有界内存，临时字幕不落盘，首次稳定转写不可变。个人上下文不向 ASR 提供词表。

代码中已有可复用的音频采集、MessagePort 流控、会话游标、SQLite 和历史链路，但尚无完整云端接入：

| 证据 | 对方案的影响 |
|---|---|
| [recognizer-adapter.js](../../src/runtime/realtime-worker/recognizer-adapter.js) 使用同步 acceptFrame/poll/endSegment | 不适合直接实现异步网络流；保留为本地识别内部接口 |
| [worker-core.js](../../src/runtime/realtime-worker/worker-core.js) 由本地 VAD 开段并同步收束 | 云端分段与本地段未必一一对应，应在更高层统一结果 |
| [realtime-runtime-adapter.js](../../src/runtime/realtime-runtime-adapter.js) 组合采集、worker、停止与故障清理 | 可沿现有生命周期扩展，不能为切换服务反复重建用户会话 |
| [session-coordinator.js](../../src/main/session/session-coordinator.js) 保留 attempt/sourceSequences 并检验 revision | 可复用去重基础，但不足以自动处理云端迟到事件与降级边界 |
| [caption-event.js](../../src/contracts/caption-event.js) 已定义 session/source/segment/sequence/revision/t0/t1 | 各服务先规范化，renderer 和历史不解析厂商 JSON |
| [credential-vault.js](../../src/agent/model-access/credential-vault.js) 已使用 safeStorage | 可评估抽取独立凭据基础设施，不能让字幕启动依赖 Agent 模块或共享同一凭据槽 |

## 推荐结构

建议保留统一的流式识别接口，并按进程拆分音频缓冲与云端传输：音频采集 → realtime worker 的有界 PCM 缓冲/本地降级管线 → main 中的云端 adapter → 统一字幕事件 → SessionCoordinator → 显示 / SQLite / 字幕历史。

本轮按用户“凭据只在 main”的约束修订：AccessKey、Token 和鉴权 WebSocket 都由 main 持有，不把临时 Token 当作非敏感配置发给 worker。main 负责云端网络 I/O，不做本地推理；worker 保留有界 PCM 和本地识别，通过窄 MessagePort 向 main 交付云端发送帧。main 不再复制保存整段音频，只保留限界发送队列，设置 websocket bufferedAmount 与超时上限。

这意味着云端分支 PCM 会经过 main，与当前 runtime 文档 §5.1“PCM 不进入 main JS 事件循环”存在明确差异，实施前必须登记并验证主进程响应性；纯本地路径继续直达 worker。本研究不声称已同时满足这两个互相制约的边界。若以后决定保留 PCM 完全不经 main，则需另行授权会话级临时 Token 进入受控 utility，并修订“凭据只在 main”的表述；不能偷偷采用该替代方案，也不能假设 WebSocket 可直接转移到 utility。

main 的单一调度所有者串行处理云端结果与本地接管，worker 根据其明确的代次和音频边界执行降级。worker 自身崩溃仍遵循 SEM-F12 的释放与显式 Retry，不包装成无缝降级。

流式接口只需表达：打开并确认就绪、接收带帧序号/样本位置的 PCM、结束输入并等待尾部结果、有界取消、结果/故障通知及背压。暂停恢复属于产品生命周期，由调度层转换成服务支持的操作，不要求每家 API 都有 pause 命令。

厂商 adapter 负责鉴权协议、包编码、任务 ID、心跳、结果解析、服务时间转换及错误分类。调度层负责一次会话的权威归属、全局 sequence、首次稳定转写去重、PCM 留存上限与降级；厂商 adapter 不自行写库或切换到别家模型。

能力描述仅保留确实影响产品行为的字段：输入采样格式、临时字幕与段结束语义、时间戳精度、最大连接时长、结束输入行为、存活检测和接收节奏。先注册受控 adapter，不做运行时插件发现或通用协议编辑器。

## 最需要先解决的正确性问题

### NLS 首片调用方案

以下是实现建议，协议字段以 [NLS WebSocket 文档](https://help.aliyun.com/zh/isi/developer-reference/websocket)为准，未进行账号调用。

1. 用户先开通 ISI 并配置独立的 16 kHz 项目。main 的凭据服务取得临时 Token，缓存期限使用响应的 ExpireTime，临近到期提前刷新；并发获取合并为一个请求。长期密钥来自用户自己的受限 RAM 凭据，绝不把开发者账户密钥打包分发。产品 UI 不要求用户每次手动粘贴 Token；外部签发服务可后续按部署需要接入。
2. 新建 WSS 连接，生成任务级 task_id 和每条指令独立的 message_id。发送 namespace=SpeechTranscriber、name=StartTranscription 与 AppKey，等待 TranscriptionStarted 才开始送音频。准备期间不积压无限音频，握手失败也不上传。
3. 首片固定 16 kHz、单声道、PCM16；现有 Float32 输入转换成小端 PCM16。按实时节奏发送含静音的帧，建议先匹配既有 100 ms 帧，每帧 3200 字节；发送队列超限不得以数倍实时速率突发补发。开启中间结果和标点；ITN 作为明确冻结的转写格式偏好。首片关闭语义断句和语气词过滤，不传热词、自学习模型或个人上下文。
4. 按下表规范化结果。NLS time 是处理到的音频位置，不把它当成词级精确语音结束证据，也不能据此直接释放该位置之前所有尚未确认归属的 PCM；实际交接边界需结合段身份、词时间及受控语料验证。边界无法确定时显式处理缺口，不能把已处理进度当作已提交音频水位。

| NLS 事件 | 产品动作 |
|---|---|
| TranscriptionStarted | 该连接就绪，允许送帧 |
| SentenceBegin | 记录 index 与流内起点，建立字幕段关联；不生成空白 final |
| TranscriptionResultChanged | 用完整 result 替换当前 partial，不能按增量文本累加 |
| SentenceEnd | 非空 result 转成唯一首次稳定转写；begin_time/time 经连接时间映射形成段时间 |
| TranscriptionCompleted | 云任务收尾信号；等待已接受字幕持久化后才关闭产品会话 |
| TaskFailed / 意外关闭 | 映射固定错误类别，按 J20 降级或按生命周期处理；原始响应不写日志 |

5. 以连接代次、task_id、index 共同建立段身份，sequence/revision 由产品调度生成。区分 header.status、句子级 payload.status 与 WebSocket close code；同段重复结束结果只能接受一次，正文不一致的重复结果不能覆盖旧事实。
6. 暂停结束当前任务并收尾，恢复建立新任务；保持 sessionId、来源和已接受游标。开始新连接前核验 Token，不假设活动连接能热更新鉴权。关闭、退出、取消、超时和迟到回调使用同一收束路径。

词级结果可在有界内存参与边界核验，不因供应商支持就新增词级持久化或 UI。项目在控制台预设的热词也可能影响结果，资格用项目应明确配置；本产品不提供个人记忆到热词的入口。

### 云端分段与本地 VAD

建议云端分支连续发送包括静音在内的单路 PCM，由云端提供段边界。不能先按本地 VAD 裁成若干独立请求，否则会增加延迟，也可能改变供应商时间轴。纯本地路径继续使用既有两阶段识别。

这涉及现有 SEM-F01 的“Silero 确认前零字幕”要求：该表述目前没有按权威识别策略区分。实施前应登记云端分支由经过资格验证的服务语音边界控制字幕发布，并保留噪声/纯音负向测试；不能直接绕过现行要求。若仍要求云端结果受本地 Silero 确认门控，则必须明确门控如何关联云端段，并测量其延迟代价。本研究推荐前者，尚不代替语义裁决。

### 停止与暂停

NLS 停止时发送 StopTranscription，继续接收尾部 SentenceEnd，等待 TranscriptionCompleted；因此停止应先结束采集、发送剩余输入、等待尾部结果、提交已接受事实，再关闭会话。百炼 adapter 对应 finish-task/task-finished，共享层不能写死任一家事件名。[NLS 官方时序](https://help.aliyun.com/zh/isi/developer-reference/websocket)。

暂停建议排空并关闭当前云任务；恢复保持同一 sessionId，以新的连接代次继续。用音频样本位置建立连接时间与会话时间的分段映射，保留暂停形成的时间间隔。恢复云连接不等于故障后自动切回：已经本地降级的会话恢复后仍走本地。停止超时不能把最后一次 partial 当作 final；需在既有退出预算内排空或显式报告未提交尾部。

### 断网交接

不能仅靠“切换后忽略云消息”保证没有重复正文，因为旧云 final 可能已经提交，而本地又重放同一段音频。建议在唯一调度所有者中串行处理结果和切换：

1. 接受云端首次稳定转写时，同时记录其已覆盖样本边界；区分 coordinator 已接受与 SQLite 已提交，存储待提交不能触发重复识别。
2. 明确网络故障后封闭旧连接代次，后续旧结果全部拒绝。
3. 只把尚未成为首次稳定转写的音频交给本地，沿同会话游标继续；旧临时字幕清除或被明确替换，不能残留为已提交段。
4. 本地降级后不重连云端竞速、不自动切回，也不修改已提交事实。

这仍不证明逐字无缝：供应商时间戳不等于音素级精确分界，长时间无 final 也可能超过内存预算。需分别限定输入队列、WebSocket 发送缓冲、未提交音频留存时长与本地追赶积压；不能因队列达到上限就反复延长缓冲。超过上限建议显式报告未提交音频缺口并继续受控降级，或进入可恢复错误；具体产品取舍须先登记到 J20。普通响应慢不自动视为断连。

每次连接的服务时间都要映射回音频采集时间；不能使用消息到达时间作为发声时间，不能把多个连接各自从零开始的时间直接写入历史。

## 用户配置建议

设置页独立增加“语音识别”，提供“纯本地权威识别”和“云端主力识别与本地降级”。NLS 配置显示产品线、经验证的服务地域、AppKey 设置、项目模型说明与凭据就绪；百炼则显示 Workspace、模型及 API Key 设置，不能共用一个含糊的 Key/model 表单。连通性检查只证明实际检查过的环节，不宣称识别质量或性能达标。

识别配置允许独立保存并在开始前选中一份；会话冻结配置 revision、服务/地域、请求参数及不透明凭据/项目引用。NLS 的 AppKey 对应控制台项目模型，语言/方言模型不能通过请求动态切换；不同模型宜使用独立项目。用户填写的模型说明只是声明，不是服务端模型版本证明，外部控制台修改也不能由本地 revision 阻止。不得声称仅冻结 AppKey 就冻结了服务端权重。[项目配置](https://help.aliyun.com/zh/isi/getting-started/manage-projects)。首次启用明确披露所选音频来源会发往供应商；不能沿用仅授权 Agent 文本的披露，地域不从系统时区推断。

凭据采用 main-owned 安全存储与会话级授权，禁止进入普通配置、SQLite、日志、报告或字幕事件。用户输入凭据的专用表面仅短暂提交，不提供回读明文的接口。NLS 官方 WebSocket 文档示例在 query 传 Token，但官方 Go SDK 使用 X-NLS-Token header；本项目 Node/main 优先采用该 header 并补真实握手验证，不把 Token 拼入 URL。若特定兼容路径确实需要 query，须单独审查且不得自动回退；完整 URL、headers、请求对象和原始错误绝不进入诊断。长期 AccessKey 不进入语音 WebSocket 请求。端点由受控产品线/地域生成，拒绝重定向。源码证据及 Token 到期管理见 [NLS 调研](nls-realtime-api-2026-09-21.md)。

工具条区分当前确实正在使用的云端识别与本地降级状态；历史保留非敏感的服务身份和降级事实，正文读取/导出继续沿现有路径。若新增持久字段，必须新增迁移，不能修改历史 migration 或复用已退役的 recognition_* 表。

本轮不开发云端精修。建议首片云端策略与精修偏好的组合暂不开放，界面说明限制且不静默修改全局精修偏好；该限制必须在实施前登记。纯本地既有精修行为不因本研究改变。

## 实施顺序与验收建议

1. 先把本轮范围、云端分段规则、PCM 上限/缺口策略、暂停与停止语义、披露和精修组合限制登记到相关 SEM 行和既有 J20。同步修正 runtime 文档仍提确认关键词的历史文字；不新增同义旅程 ID。
2. 以 NlsRealtimeProvider 闭合 Token 获取、AppKey 项目配置、真实采集、云端 partial/final、停止收尾到 SQLite/字幕历史的完整产品路径，并同时实现本地降级。额外登记云端 PCM 经 main 的边界、发送背压、Token 过期及外部项目配置变化限制。协议探针仅作为内部前置，不当作产品交付。
3. 在同一 J20 中加入乱序、重复 final、迟到消息、连接失败、鉴权/限流、存活检测失败、发送积压、PCM 超限、暂停恢复、停止超时和存储故障。内部调度、coordinator、存储和本地识别使用真实实现，仅声卡、云网络/provider、系统权限/凭据边界可使用替身。
4. 再接百炼任务型 WebSocket adapter，先选 Fun-ASR 一个模型验证跨产品线接口，随后按各自参数与结果资格加入 Qwen-Audio Streaming、Paraformer；不假设仅换 model 字符串就全部兼容。腾讯/Azure 之后再按需要接。Qwen3-ASR-Realtime 的转写时间戳资格仍待解决。通义听悟作为会议产品另行评估，不进入当前字幕切片。增加 adapter 后复用同一 J20 矩阵，不复制字幕业务。
5. 定向验证后按公共契约/main/preload/存储影响扩大到相关 lane；PR 或阶段联合验收执行当前 revision 的完整三条 lane。真实云端、物理 mic/loopback、固定语料质量、冻结字幕可见延迟和长稳另走 I2/I3/I4，不能用网络替身宣称实机验收完成。

真实试用需同时观察首个临时字幕、首次稳定转写延迟、CER、中英混说、噪声误触发、停止尾部、断网交接缺口、内存峰值及计费用量。费用与质量比较在相同语料、地域和网络条件下进行；本次没有账号实测，故不提供编造的价格/速度排名。

## 本轮核验范围

已对照规范术语、相关语义及本地接入点；另查官方协议。仅新增研究文档，未改变产品代码、语义合同或验收状态。账号权限、地域模型供应、长稳表现及时间戳交接精度仍需针对最终选择核实。

数据留存已有实质边界：[百炼官方 FAQ“产品相关”第 7 项](https://help.aliyun.com/zh/model-studio/faq-about-alibaba-cloud-model-studio) 一方面说明调用数据不用于训练，另一方面明确会按相关要求存储调用数据。因此不能把本地 PCM 不落盘宣称为云端零留存；Fun-ASR 音频/正文的具体留存范围、期限与账号级约定仍须确认。实施规格应明确本地保证和供应商处理政策的边界，不擅自放宽 SEM-F14。

上述百炼政策不能直接推定为 ISI/NLS 的政策；NLS 留存须单独查证。[通义听悟官方流程](https://help.aliyun.com/zh/model-studio/tingwu-meeting-api-usage/)明确纪要分析需要额外主动调用，并非创建实时会议就自动生成；dataId 的 24 小时有效期也不应直接表述成所有场景的音频最长时长。听悟后续评估时需针对确切版本核对分析、转码、OSS 与恢复配置，关闭某些派生功能不构成云端零留存证明。
