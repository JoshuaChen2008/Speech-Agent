# 云端识别 provider 与音频模型接入调研

> 后续修订：用户已把本轮范围限定为持续音频实时识别，排除内容精修；补充 ISI/NLS 后首接建议改为 NLS，再接百炼验证不同协议。以下初轮比较保留为调研记录，当前排序和实现范围以[修订接入建议](cloud-realtime-asr-integration-plan-2026-09-21.md)与 [NLS 调研](nls-realtime-api-2026-09-21.md)为准。

调研日期：2026-09-21。本文是研究建议，不是新增能力的决定或实现证据；未调用付费 API、未上传现场音频、未改变语义合同或旅程状态。

## 结论与现有边界

建议先评估阿里云 **Fun-ASR-Realtime 与 Qwen-ASR-Realtime**，选择一个取得实测证据后接入 J20 的“云端主力识别与本地降级”。两者都有连续音频输入和识别事件接口。小米 MiMo 与 MiniMax 也已公开 ASR API，但本次核实的接口都是一次提交音频、随后输出文本；`stream=true` 只证明文本流式返回，不能当作持续音频输入证据。后两者适合后续评估有界分段识别或可选精修，而不是直接接替低延迟临时字幕。

用户所说“本地 LLM 增加云端 API”需要区分两种职责：

| 用户目的 | 本仓库接入边界 | 不能混用的内容 |
|---|---|---|
| 把正在采集的音频转成字幕，包括使用音频大模型做 ASR | 字幕系统的识别 provider；冻结权威识别策略 | 不进入 Agent 模型配置档案、Agent Loop 或个人上下文 |
| 对已提交字幕做总结、问答或增强文本 | Agent 模型接入层、模型用途和模型运行绑定 | 不接收现场 PCM，不产生或覆盖首次稳定转写 |

依据：[CONTEXT](../../CONTEXT.md)、[SEM-F01/F02/F03/F04/F14/F25/F33](../semantic-contract.md)、[J16/J20/J25 与测试分层 §2](../testing-strategy.md)。截至本调研日（2026-09-21），J20 为“已决定；整条后置，尚无实现证据”，退出正式 Agent 首版门禁；本研究不自动把它重新纳入实施。2026-09-23 起，NLS 首期为“实现完成·尚未验收”，实施范围与证据见[NLS 实施记录](../validation/nls-implementation-2026-09-23.md)。旧确认关键词功能已由 [ADR 0017](../adr/0017-retire-confirmed-recognition-terms.md) 取消，个人上下文中的条目不得影响 ASR。`runtime-architecture.md` §11.1 仍有旧关键词文字，这是文档缺口，不能沿用为新需求。

若需求只是给总结或问答增加普通云端文本 LLM，现行 Agent 模型接入层已经有 OpenAI-compatible 多配置档案、模型目录与用途选择机制，应沿 SEM-F33/J25 扩展或配置，而非另建一套云端设置。某家厂商的文本接口兼容，并不证明它的音频输入、ASR 事件和取消行为兼容；ASR 模型不得填进文本用途槽位后假定能转写。

## 官方能力核验

以下“支持”只表示文档提供该接口，不表示本项目已接入、账号已开通或性能已达标。模型别名、地域、配额会变化；实施时应冻结具体模型身份并重新核对账号。

| 厂商 / 模型 | 音频输入与文本输出 | 对实时字幕的判断 |
|---|---|---|
| 阿里云 `fun-asr-realtime` | WebSocket 连续二进制音频；返回中间识别与段结束结果 | 第一批候选；有字幕段身份及时间信息，利于适配现有事件 |
| 阿里云 `qwen3-asr-flash-realtime` | WebSocket 音频块输入；识别文本事件与独立终结事件 | 第一批音频模型候选；需按其 `text + stash` 语义重建整段临时字幕 |
| 阿里云 `qwen-audio-3.0-asr-flash-streaming` | 当前官方接口已纳入与 Fun-ASR 相同的任务型 WebSocket 家族 | 可作为后续同协议候选，不能仅靠改模型名跳过资格验证 |
| 阿里云 `paraformer-realtime-v2` | WebSocket 音频输入；中间/结束识别结果 | 可作对照；官方识别总览将其列为较早代模型并建议考虑 Fun-ASR/Qwen-ASR |
| 小米 `mimo-v2.5-asr` | Chat Completions 单条 Base64 音频输入；可 SSE 输出文本 | 有公开 ASR；本次未取得持续音频输入接口证据 |
| MiniMax `asr-1.0` | multipart 音频上传；可 SSE 输出文本 | 有公开 ASR；官方调试台明确区分它与麦克风实时识别 |
| 阿里云 `qwen3-omni-flash-realtime` | 实时多模态理解及文本/音频回复，可另启输入音频转录 | 对话回复不等于转录；纯字幕优先直接使用 ASR 接口 |

依据：[阿里云识别模型总览](https://help.aliyun.com/zh/model-studio/asr-model)、[Fun-ASR WebSocket](https://help.aliyun.com/zh/model-studio/fun-asr-realtime-websocket-api)、[Qwen-ASR WebSocket](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-interaction-process)、[小米 ASR API](https://mimo.mi.com/docs/zh-CN/api/audio/Speech-Recognition)、[MiniMax ASR API](https://platform.minimax.cn/docs/api-reference/speech-to-text)、[MiniMax 官方调试台](https://solutions.minimax.cn/debug/asr)、[Qwen Omni 模型说明](https://help.aliyun.com/zh/model-studio/qwen3-omni-flash-realtime)。

### 阿里云：两套协议需要两个受控 adapter

**Fun-ASR / Qwen-Audio Streaming。** 北京与新加坡使用不同 workspace 专属 WSS 域名，路径为 `/api-ws/v1/inference`；握手通过 `Authorization: Bearer ...` 鉴权。先发送 `run-task`，收到 `task-started` 后发送单声道二进制音频。停止时发送 `finish-task`，继续接收剩余识别事件，等 `task-finished` 后关闭；不能发送结束指令后立即断开。[接口流程](https://help.aliyun.com/zh/model-studio/fun-asr-realtime-websocket-api)

客户端明确配置音频格式、采样率与模型；产品建议先限定一种经过验证的 PCM 格式，而不是把供应商所有格式暴露给用户。返回 `result-generated` 的 `sentence_end=false/true` 分别表示中间/段结束结果；`sentence_id`、`begin_time/end_time` 可供内部关联，`heartbeat=true` 不是字幕。适配器仍须形成项目自己的会话、来源与字幕段身份。[客户端事件](https://help.aliyun.com/zh/model-studio/fun-asr-client-events)、[服务端事件](https://help.aliyun.com/zh/model-studio/fun-asr-server-events)

**Qwen-ASR Realtime。** 路径为 `/api-ws/v1/realtime?model=...`，同样使用 WSS 和 Bearer 鉴权。`session.update` 后通过 `input_audio_buffer.append` 发送 Base64 音频块；支持服务端 VAD，也支持关闭服务端 VAD 后由客户端 `commit`。文档列出 PCM/Opus 与 8/16 kHz；本项目首选核验 16 kHz PCM，不能把 Float32Array 直接当成已编码的 PCM 字节发送。Manual 模式的提交时机与临时字幕可见延迟必须实测，不能假定与服务端 VAD 行为相同。[交互流程](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-interaction-process)、[客户端事件](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-client-events)

`conversation.item.input_audio_transcription.text` 包含已确认前缀 `text` 与可回改后缀 `stash`，应按 item 身份形成当前完整假设，而不是把每个回包追加为新字幕。仅 `conversation.item.input_audio_transcription.completed` 才候选映射为首次 `final`；前缀“已确认”不意味着可提前持久化。停止发送 `session.finish` 并有界等待 `session.finished`，否则可能丢弃尚在识别中的 item。[服务端事件](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-server-events)、[结束流程](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-interaction-process)

**Paraformer。** 当前接口页标明实时服务位于北京，使用 `/api-ws/v1/inference`；任务开始/结束与 `sentence_end` 也有官方定义。虽然形状类似 Fun-ASR，仍应分别验证模型参数、结果身份和故障行为，不能推断协议完全一致。[WebSocket](https://help.aliyun.com/zh/model-studio/websocket-for-paraformer-real-time-service)、[客户端事件](https://help.aliyun.com/zh/model-studio/paraformer-client-events)、[服务端事件](https://help.aliyun.com/zh/model-studio/paraformer-server-events)

### 小米与 MiniMax：ASR 已公开，但流式输出不等于实时输入

小米 ASR 文档使用 `POST /v1/chat/completions`、`mimo-v2.5-asr` 与 `input_audio`，输入仅为单条 MP3/WAV 的 Base64/data URL；鉴权支持 API key 或 Bearer。`stream=true` 是 SSE 响应，`finish_reason=length/content_filter` 不能被当作完整转写成功。本次核验页没有足够证据确认持续音频追加、段时间戳、会话续接及生产时长上限，应在候选试验前补齐，不能借“OpenAI 兼容”直接复用现有文本 Agent adapter。[小米 API](https://mimo.mi.com/docs/zh-CN/api/audio/Speech-Recognition)

MiniMax ASR API 文档当前给出 `https://api.minimax.cn/v1/speech_to_text`，Bearer 鉴权，multipart 的 `model=asr-1.0` 和 `file`。约束为不超过 500 秒、50 MB，不接受裸 PCM；支持 WAV 等容器。SSE 仅支持 JSON 输出，返回 `delta` 和结束标记；非流式可选择带时间戳格式。官方调试台仍展示 `api.minimaxi.com`，与接口文档域名存在差异：实施时按账号/地域核验一个精确 origin，不做透明重定向或跨域凭据重试。[API 文档](https://platform.minimax.cn/docs/api-reference/speech-to-text)、[官方调试台](https://solutions.minimax.cn/debug/asr)

工程推论：可以在内存中把一个有界字幕段编码为 WAV 并作为请求体提交，不必生成本地文件；API 示例读取文件不构成产品必须落盘的要求。但仍要等待分段边界后才能提交整段，较长分段会增加延迟。若先由本地 ASR 产生首次稳定转写，再用这些模型识别同段音频，输出只能进入独立精修稿；这属于 SEM-F04/J15c 的新增云端精修范围，须先登记授权、预算与失败语义，不能沿用当前本地精修实现状态。

### Omni 与“LLM 实时字幕”的含义

Qwen Omni 的 SDK 将输入转录作为独立开关，其转录模型固定为 `qwen3-asr-flash-realtime`；模型自身的文本/音频回复是另一种输出。因此，“直接让对话模型听音频再写一句话”不能自动满足逐段转录事实、完整性、唯一 `final` 与时间戳要求。纯字幕采用专用 ASR；基于已提交正文的润色、总结继续走 Agent。语音对话、同声翻译及语音合成另有产品语义，本轮不把 TTS 或模型回复混为 ASR。[Omni SDK](https://help.aliyun.com/zh/model-studio/omni-realtime-java-sdk)

## 项目建议接法

以下为待决定方案，沿用 [运行时 §5/§9/§11.1](../runtime-architecture.md) 的有效边界与 [RealtimeRuntimeAdapter](../../src/runtime/realtime-runtime-adapter.js) 的采集/worker 生命周期，不表示现有生产代码已有云端路由。

1. 在设置中独立呈现“权威识别策略”和识别 provider 配置，继续保留纯本地权威识别。会话开始冻结 provider、模型、地域、音频编码、策略及非敏感配置 revision；活动会话不能换来源或策略。Agent 模型用途选择完全独立。
2. 在现有音频 worker 一侧建立识别路由，PCM 继续经有界 MessagePort 到识别执行进程，不经过 main 高频 JS 路径。生产注册表只允许受控 adapter；第一批选 Fun-ASR 或 Qwen-ASR 之一，第二个用来验证接口是否真正隔离协议差异。
3. adapter 只负责协议、编码、鉴权、连接状态和归一化结果；路由负责 session/source/segment 身份、generation、sequence 与唯一首次 `final`。存储和 renderer 继续消费现有产品契约，不按供应商名称分支。供应商分段与本地 VAD 边界可能不一致，必须定义音频样本区间映射，不能简单把 provider 句号当成本地分段。
4. 云端正常期间本地核心资源保持就绪，不能持续运行完整本地解码。仅明确断开、稳定错误或经过验证的连接存活失败触发同会话单向本地接管；普通抖动不触发。原子关闭旧 generation，拒绝迟到事件，保留已提交原文，只允许当前未定稿段由有界 PCM 重建唯一 `final`，不自动切回。
5. 预先定义缓冲上限和未定稿区间。若云端未定稿音频超出环形缓冲、背压丢帧或时间对齐不可信，不能假装无损降级：显式报告缺口或进入既有错误/Retry 边界，具体语义先登记。历史已提交文本保持不变。
6. 暂停要停止上传新音频并有界收束尾部；恢复可重建 provider 连接，但保留产品会话身份与新 generation。停止/取消/退出统一设截止时间，释放 PCM、连接与凭据引用；超过截止时间不以任意 partial 冒充 `final`。
7. 凭据只由 main 管理的安全存储获取并按调用传给受控识别进程，独立于 Agent 凭据槽。renderer 只持有配置 ID/凭据存在状态。固定 HTTPS/WSS origin、拒绝 redirect、供应商原始错误映射为闭集诊断，日志不写 header、响应正文或音频块。

第 7 项是新识别调用边界的设计建议，必须先修订相关凭据与子进程隔离合同；不能直接把 Agent 现有凭据通道开放给音频 worker。核心字幕模型资源包继续是本地降级前置条件，完整模型供给后离线能力与 Agent 缺席下的字幕独立性保持原门禁。

## 隐私、费用与尚缺证据

本地遵循 SEM-F14：PCM、编码音频与 Base64 只在有界内存；不得写数据库、日志、导出、崩溃文件、测试产物、模型目录或 Agent 上下文。云端音频授权必须独立于 Agent 文本披露，说明接收厂商/地域/模型与音频用途；用户选择纯本地权威识别时上传次数必须为零。

**本地不落盘不等于云端零留存。** 阿里云隐私页同时写明不用于模型训练及会存储模型/应用调用数据；产品总览进一步区分按量付费 API 与不同订阅计划的数据条款。因此本研究不能证明服务端音频零留存。上线前需确认具体 ASR、地域、账号适用的保留范围/期限与删除规则，若项目要求覆盖第三方的严格零留存，则供应商必须提供相符证据后才能启用。小米与 MiniMax 的 ASR API 页也不足以证明音频零留存，本次不作该承诺。[百炼隐私说明](https://help.aliyun.com/zh/model-studio/privacy-notice)、[百炼产品总览](https://help.aliyun.com/zh/model-studio/what-is-model-studio)

本轮不按营销首字延迟、免费额度或标价选定模型。需针对部署地域和实际账号核对并发、限流、最长连接、静音断开、模型下线、计费单位与额度耗尽行为；当前源未统一给出这些限制，不填猜测值。样本评估应覆盖中文/英文混说、专有名词、长停顿、纯噪声、较长未定稿段、弱网与取消；指标至少含 CER/WER、首个临时字幕及定稿延迟、请求计费时长/用量、缓冲峰值、丢帧与降级次数。费用估算仅使用所选地域当时官方价格及真实用量，不能由文本 token 或宣传速度代算。

## 拟登记旅程与实施顺序

实施前依 SEM-T06 更新语义表、J20 矩阵及相关术语，不根据本研究自动提升任何状态。

| 既有门禁 | 拟新增或扩展的用户路径 |
|---|---|
| J20 + J1/J2/J16 | 分别用 mic/loopback 开始云端会话 → 完整临时假设 → 唯一首次稳定转写 → 停止 → SQLite/历史/导出；纯本地路径及 Agent 不存在仍成立 |
| J20 + SEM-T04 | 缺凭据、401/403、额度耗尽、畸形/重复/乱序事件、无语音、连接失败、明确断网 → 明确失败或单向降级；拒绝迟到云 final、已提交段重开及自动切回 |
| J20 + J12 | 未授权/纯本地上传为零；取消/暂停/退出后无后续发送；凭据、PCM、Base64、正文和原始异常不进入日志/证据；内存及发送队列有界 |
| J20 + J14 | 缺本地降级资源不能把云端配置当作核心 ready；就绪后纯本地断网运行、重启及历史访问仍成立 |
| J15c（后续单独决定） | 本地首次稳定转写 → 有界内存片段请求 MiMo/MiniMax → 独立精修稿；失败保留原文、覆盖不完整如实展示，现场音频无法跨重启补跑 |
| I2/I3/I4 | 当前候选真实 provider/网络/物理来源与长稳实机证据；不得用 API 调通或替身旅程替代，不降低冻结延迟口径 |

建议顺序：先冻结 J20 最小范围及隐私条件 → 用同一受控语料评估 Fun-ASR 与 Qwen-ASR → 选一个贯通真实内部模块的正常/失败旅程 → 取得公网与实机证据 → 再决定分段音频模型/云端精修。测试替身仅在声卡、云网络/provider、系统凭据等外部边界；SessionCoordinator、路由、renderer、SQLite、历史与导出使用真实实现。

文档核验范围：已对照 CONTEXT 全文、相关 SEM 行与 J20 当前状态，读取运行时与生产 adapter，核对上述官方 API 页面。未执行产品测试、未测真实延迟/质量/费用、未验证供应商账号能力或云端保留期限。
