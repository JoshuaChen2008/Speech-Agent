# 持续音频实时识别 API 协议调研

调研日期：2026-09-21。范围：字幕系统的识别 provider，不含精修、增强文本、Agent 模型 provider。本文是研究建议，不登记新的产品要求，不代表实现或验收；实施前仍须按 SEM-T06 登记语义与旅程。已阅读全文 `CONTEXT.md`；相关约束为 SEM-F01/F12/F14，关联 J1/J4/J5/J8 与 I2/I3。

## 建议

补充 ISI/NLS 产品线后的当前建议：**先接 NLS 实时语音识别，再接百炼任务型 WebSocket**，详见 [NLS 调研](nls-realtime-api-2026-09-21.md)与[修订接入建议](cloud-realtime-asr-integration-plan-2026-09-21.md)。下文保留百炼、腾讯与 Azure 的协议事实，原 Fun-ASR 首接排序已被本轮补充取代；不构成识别准确率或延迟排名。

需要区分两种 Qwen：`qwen3-asr-flash-realtime` 使用另一套 realtime 事件；`qwen-audio-3.0-asr-flash-streaming` 则与 Fun-ASR 共用 inference 协议。后者于 2026-07-30 发布，应纳入同协议内的后续候选，不能因为名称含 Qwen 就归到前者。新增模型的语言、热词等能力见[官方更新记录](https://help.aliyun.com/zh/model-studio/newly-released-models)。

NLS 与百炼已可用于验证两个不同产品线的协议边界；腾讯云及 Azure 作为后续跨供应商参照。不要做“填任意 URL 即兼容”的入口：鉴权、握手、音频编码、时间轴、停止收尾都存在协议差异。

## 已核实的协议事实

### 阿里 Fun-ASR-Realtime

- WebSocket 握手使用 Bearer API Key；北京、新加坡有不同 workspace 域名。官方仍支持旧 DashScope 域名。Java/Python 有 DashScope SDK，其他语言可直接使用 WebSocket。
- `run-task → task-started` 后才送单声道二进制音频；停止时发送 `finish-task`，继续消费结果，直到 `task-finished` 才关闭。停止按钮不能直接断连接。[协议流程](https://help.aliyun.com/zh/model-studio/fun-asr-realtime-websocket-api)
- `result-generated` 中 `sentence_id` 表示云端段身份；`sentence_end=false/true` 区分临时结果与段结束结果；`begin_time/end_time` 是毫秒时间戳。`heartbeat=true` 的结果不是字幕。[服务端事件](https://help.aliyun.com/zh/model-studio/fun-asr-server-events)
- 可配置 VAD 断句静音阈值。`heartbeat=true` 的明确承诺是**持续送静音音频**时保持连接，并非停止送帧仍永久保活。默认 VAD 阈值 1300 ms，范围 200–6000 ms；这是段结束条件，不应当作首个临时字幕延迟。[客户端事件](https://help.aliyun.com/zh/model-studio/fun-asr-client-events)
- 官方模型表把实时 Fun-ASR 的音频时长/大小列为无限制；这不等于无网络故障或永久连接 SLA。[模型表](https://help.aliyun.com/zh/model-studio/asr-model)
- 模型与地域必须联动：当前 `fun-asr-realtime` 稳定别名指向 2025-11-07，2026-02-28 快照不在新加坡清单。任务间可复用连接，但任务结束后 60 秒无新任务会断开。[地域与连接复用](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide)

建议：内部默认传 PCM16 单声道 16 kHz，以现有采集输出为基础做有界转换；参数与模型能力采用受控注册表，固定模型 ID，不用通用“最新版”推断兼容性。暂停后重开 provider 任务时，云端时间戳必须映射回本次字幕会话的时间轴。

### Qwen3-ASR-Flash-Realtime

使用 `session.update` 配置，`input_audio_buffer.append` 发送 Base64 音频；VAD 模式由服务端决定断句，Manual 模式由客户端 commit。`session.finish` 后等待 `session.finished`；直接关连接会丢弃进行中的识别项。未收到 speech_started 就 finish 的情况也要单独验证。[交互流程](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-interaction-process)、[客户端事件](https://help.aliyun.com/en/model-studio/qwen-asr-realtime-client-events)

官方指南明确它当前不返回转写时间戳。虽然 `speech_started` 有 `audio_start_ms`，那是 VAD 检测时刻，不能冒充字级对齐；将其用于字幕段边界也需要另行定义与验证。首版优先使用原生转写时间戳的协议更稳妥。[时间戳说明](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide)、[服务端事件](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-server-events)

未确认：本轮没有找到足够明确且专属于 Qwen3-ASR-Realtime 的连接最长存活时间证据，不能套用 Qwen-Omni 的限制。

### 腾讯云实时 ASR

签名鉴权，与阿里 Bearer 不兼容；连续二进制音频，推荐每 40 ms 送等时长数据。超过实时率或包间隔超过 6 秒可能被断开。结果的 `index` 是段序号，`slice_type=2` 表示稳定段结果；`start_time/end_time` 是流内时间。发送 `{"type":"end"}` 后等待 `final=1` 表示全流结束。**段稳定与全流结束是两个不同信号**。[腾讯官方协议](https://intl.cloud.tencent.com/zh/document/api/1118/53937)

建议：把发送节奏、鉴权和全流停止收尾留在 adapter 内；不要把阿里的 task-finished 或 sentence_id 写进共享契约。暂停时不能简单保持 socket 却停止送帧。未确认：大陆/国际账号地域差异、连接最长时长和音频留存条款，本轮不足以作生产承诺。

### Azure Speech continuous recognition

SDK 支持持续识别，分别产生 `Recognizing`、`Recognized`、`Canceled`，有独立停止方法。[持续识别](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-recognize-speech)

SDK 支持 push stream；Node.js 不支持其麦克风便捷入口，但本项目可继续使用自己的 audio host，把内存帧送入流。[官方入门](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-speech-to-text)

结果 offset/duration 使用 100 ns ticks，从 SDK 处理首字节开始计；临时结果与稳定结果的 offset 不保证相同。[时间戳说明](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-speech-recognition-results)

建议：SDK 也包在同一个异步 provider 生命周期后，不让 SDK 接管系统音频采集。EOF、停止回调与最后结果顺序、长会话连接管理需独立验证，不能把 stop 方法返回等同于所有字幕已持久化。

## 留存事实与尚未确认项

百炼 FAQ 明确不将用户数据用于模型训练，同时表示依法存储模型与应用调用产生的数据。本轮未找到 Fun-ASR 流式音频专属零留存例外，也未核实音频、转写文本、审计元数据各自保存多久。**不能从“不训练”推导“不存储”。** 对北京和新加坡应分别核实，不把地域选择等同于零留存。[百炼 FAQ](https://help.aliyun.com/zh/model-studio/faq-about-alibaba-cloud-model-studio)

Azure 官方明确实时 STT 音频仅在服务器内存处理、不落盘；但产品另有可开启的音频/转写日志，保存 30 天。接入配置应禁止开启这些日志。[实时 STT 数据处理](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/speech-service/speech-to-text/data-privacy-security)、[可选日志](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/logging-audio-transcription)

SEM-F14 的产品内零音频落盘仍必须落实；供应商处理与留存另行披露。本轮未调用付费接口、未上传现场音频，协议研究不能证明云端真实留存行为。

## 共享接口建议与验收缺口

建议共享层只表达 `open(binding)`、`write(frame)`、`finish()`、`abort()` 及异步的 ready/partial/final/ended/failure；adapter 负责线缆协议。binding 至少冻结 provider、协议、模型、地域、输入格式、凭据引用与配置版本。不要用同步 `poll()` 冒充异步网络结果。

共同规则应包括：帧序号与会话相对采样位置、连接代次、云端段到项目 segmentId 的映射、唯一 final、事件去重、有界发送队列、有界停止等待、旧代次结果失效。时间戳允许在 final 前修订，但首次稳定转写提交后不可被迟到结果覆盖。鉴权失败、配额失败、网络失败和协议错误归一为稳定错误类别，不原样记录带正文或密钥的 SDK 异常。

同会话云端主力识别与本地降级需要另行明确未提交音频边界。云端最后成功发送不代表已产生稳定结果；本地有界缓冲也不代表可以恢复任意网络积压。实施不得承诺无损恢复。禁止已降级后旧云端结果再提交，以及同一会话静默切回云端。

SEM-F01 的 Silero 确认前零字幕要求与云端自主分段存在待登记语义边界。不能未经修改语义表就删除本地确认门，也不能把云端一个段强行对应本地 VAD 一个段。

实施前至少登记：暂停/恢复重新建任务与时间轴、讲话途中停止的尾段、无语音停止、鉴权/断网/积压故障、本地单向接管、迟到结果、长静音、长会话、设置变更只影响未来会话、凭据与零音频落盘。确定性层仅替代网络边界，保留真实 coordinator、reducer、SQLite、配置与 IPC；I2/I3 另提供实机延迟、质量、两小时稳定性证据。
