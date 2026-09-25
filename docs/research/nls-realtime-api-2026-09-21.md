# 阿里云 ISI/NLS 实时识别：鉴权、配置与运行边界

日期：2026-09-21。范围为 `SpeechTranscriber` 持续音频识别，不含一句话识别、文件识别、语音对话、精修或 Agent。已重新阅读全文 `CONTEXT.md`。本文只记录研究事实与建议；实施前按 SEM-T06 登记，关联 SEM-F01/F12/F14、J1/J5/J8、I2/I3。本轮仅浏览官方文档和阿里云官方 SDK 源码，没有付费调用、Token 获取或现场音频上传。

## 建议修订

把 **ISI/NLS 实时语音识别** 作为当前首接目标是合理的：协议面向长时间持续语音、独立提供段事件与识别任务结束事件；它与百炼 Fun-ASR 是不同服务，不能共用鉴权或模型配置方式。保留识别 provider 的异步接口，把 NLS 作为第一种 adapter；Fun-ASR 后续作为第二种阿里协议扩展。选择 NLS 不构成准确率、冻结字幕可见延迟或零留存的实测证明。

## Token：不要写死 24 小时

**事实。** 生产 Token 使用 AccessKey 调用 `CreateToken`，不是百炼 API Key。官方 Node.js 示例使用 `@alicloud/pop-core`，HTTPS endpoint 为 `nls-meta.cn-shanghai.aliyuncs.com`，RPC API 版本 `2019-02-28`。返回 `Token.Id` 与 `Token.ExpireTime`，后者是 Unix 秒；应用负责缓存与到期前刷新，不应假设 SDK 自动刷新，也不应以固定时长代替返回值。[Token SDK 文档](https://help.aliyun.com/zh/isi/getting-started/obtain-an-access-token/)

**事实。** 控制台测试 Token 明确 24 小时失效；SDK/OpenAPI Token 依返回过期时刻。同一个有效 Token 可重复使用，获取新 Token 不会使旧 Token 失效，没有永久有效 Token。[Token 生命周期 FAQ](https://help.aliyun.com/zh/isi/getting-started/obtain-an-access-token-1)

**建议。** main 单独拥有 AccessKey、Token 缓存与刷新职责，绑定凭据槽版本；同槽刷新合并为一个请求，使用到期裕量、超时和有限重试。旧槽刷新结果不得覆盖已更换凭据。不可把 Token 写入配置、SQLite、日志、命令行或 renderer。鉴权故障与系统时间签名错误应区分，不能无界重复申请 Token。

**未确认。** Token 在一个已建立的长连接中途到期时是否会强制断连，本轮来源没有给出明确保证；不能假设“握手成功就永远有效”，也不要为了 Token 到期无依据地切断已工作的字幕流。应覆盖新建连接、暂停恢复、过期前后连接的实测矩阵。

## WebSocket Header：有官方源码依据

**事实。** 实时 ASR WebSocket 文档示例在 query 中传 `token`。[WebSocket 文档](https://help.aliyun.com/zh/isi/developer-reference/websocket)

**事实。** 阿里云官方 Go SDK 的 `ws.go` 在 `issueWsConnect` 中构造 Token HTTP header 并交给 WebSocket dialer；`utils.go` 把 header 常量定义为 `X-NLS-Token`，`st.go` 的 `SpeechTranscriber` 通过同一连接实现发送实时音频。这是实时识别支持 header 的第一方实现依据，不是借用语音合成或 VoiceChat 文档。[ws.go](https://raw.githubusercontent.com/aliyun/alibabacloud-nls-go-sdk/master/ws.go)、[utils.go](https://raw.githubusercontent.com/aliyun/alibabacloud-nls-go-sdk/master/utils.go)、[st.go](https://raw.githubusercontent.com/aliyun/alibabacloud-nls-go-sdk/master/st.go)

**建议。** Node/main 的受控 WebSocket 客户端优先使用 `X-NLS-Token`，不把 Token 拼入 URL；固定允许的 WSS origin/path，拒绝重定向和任意 header 注入。网络异常也只输出稳定错误码。官方 SDK 的日志行为不能照搬：源码中存在发送请求或接收原始结果日志，应禁用或替换为受约束诊断。Header 接入仍需实际服务验证，源码检视不冒充公网验收。

## 凭据只在 main 与 worker 直连的取舍

**工程推论。** 短期 Token 仍是能调用服务的凭据。把它下发给 worker 可以保住“长期 AccessKey 只在 main”，但不满足“所有凭据只在 main”。二者不能写成同一保证。

若遵循用户“凭据只在 main”的偏好，建议 main 拥有 WSS 连接、Token header、Start/Stop 指令与网络发送；audio host/worker 通过有界 MessagePort 向 main 交付 PCM 帧，main 只转发且不做重采样/ASR/大体积解析。16 kHz × 16 bit × 单声道的原始带宽为 32,000 字节/秒，仍需以 I2/I3 验证 main 转发对延迟和事件循环的影响。

worker 直接对云发送 WebSocket 帧则通常需要它持有经鉴权的连接及其运行权限；把 main 建立的 socket 移交并不是普通 Electron MessagePort 的现成功能，也不能因此声称没有向 worker 委派服务访问能力。若以后确有性能证据需要改为 worker 直连，应明确重新决定凭据边界，而不是静默把 Token 当作非敏感配置。当前优先 main 网络 owner，worker 保持音频处理职责。

## AppKey 与模型：只能冻结本地选择，不能宣称云模型不可变

**事实。** AppKey 对应控制台项目；语种、方言和行业模型在项目中选择并发布。一个项目绑定一个 ASR 模型，请求参数不能动态换模型；要用不同模型可建立多个项目。控制台还可改变绑定的热词与定制语言模型。[管理项目](https://help.aliyun.com/zh/isi/getting-started/manage-projects)

**推论。** `AppKey + 本地配置 revision` 不能证明远端模型快照不变。用户在控制台改项目配置或供应商更新底层模型时，本地 AppKey 可能保持相同。当前已查看的识别协议未提供可核验的 immutable model revision 返回值。[实时接口](https://help.aliyun.com/zh/isi/developer-reference/api-reference)

**建议。** 冻结 provider、地域、AppKey 引用、采样率、显式请求参数、用户确认的项目模型名称与本地 revision；把模型名称标为用户确认信息，不包装成 provider 已验证事实。正式比较使用独立项目且期间不改云配置；记录验证日期和参数摘要。若更换控制台模型，应显式更新本地确认信息并重新做质量资格。即便如此，也不承诺云端模型权重级复现。

## 地域、持续静音与长连接

**事实。** 当前中国站地域页列实时识别的上海、北京、深圳 WSS `/ws/v1` 网关；三者均使用上海 Token 签发端点的 Token，不必因三地切换重建 AppKey。地域页不能据此推导新加坡互通；Token 文档还明确提醒不要混用上海和新加坡签发端点。[地域与域名](https://help.aliyun.com/zh/isi/product-overview/regions-and-domain-names)、[Token 文档](https://help.aliyun.com/zh/isi/getting-started/obtain-an-access-token/)

**事实。** 官方概述描述实时识别面向不限时长音频流。本轮未找到当前 NLS `SpeechTranscriber` 的固定四小时连接上限；不能套用别的语音服务限制。[产品概述](https://help.aliyun.com/zh/isi/product-overview/what-is-intelligent-speech-interaction/)

**事实。** 实时识别 SDK FAQ 指出超过 10 秒无音频数据会空闲断连。语音识别 FAQ 要求用户停顿时持续送静音数据，服务端才能依音频静音判断断句。这与 WebSocket ping 是否往返是不同条件。[C++ 实时识别 FAQ](https://help.aliyun.com/zh/isi/developer-reference/sdk-for-c-5)、[识别 FAQ](https://help.aliyun.com/zh/isi/support/faq-about-speech-recognition)

**建议。** 正常监听时不能在本地 VAD 之后把全部静音帧过滤掉；否则云端断句和音频时间轴会改变。暂停走明确停止收尾、恢复新任务并映射回同一会话时间轴，不能仅停帧而保留 socket。SEM-F01 的本地确认门与云端分段边界必须在实施前登记，不能偷偷取消。不限音频时长不是永久连接 SLA；两小时 I3 仍需验证。

## 留存：现有证据不足以承诺零留存

查到的官方《智能语音交互隐私政策》明确适用于 SDK，采用目的所需期限及法定例外的概括性保留表述，并说明境内储存；未给实时 WebSocket 音频和转写文本逐项保留时长，也未提供零留存保证。该政策不能直接代替原始 WebSocket API 的服务条款核验。[官方政策](https://terms.alicdn.com/legal-agreement/terms/b_platform_service_agreement/20240325163900980/20240325163900980.html)

**未确认。** 实时音频、识别文本、故障采样及审计元数据各自的保存范围/时长、是否参与服务优化、是否有关闭采样或特殊保留配置。本轮不能把百炼条款移植到 NLS，也不能把文件识别结果保存 72 小时的规则套到实时识别。

**建议。** 本地继续严格执行 SEM-F14；产品云端披露写明会把当前音频流发送至所选地域。对供应商未核实的音频留存不作否定保证；若发布承诺要求端到端零音频落盘，需先取得适用于该 API 的明确条款证据。

## 后续验证范围

确定性旅程先覆盖 Token 过期/刷新竞态、错误 AppKey、header 不泄漏、停止尾段、10 秒停帧、长静音送帧、暂停恢复新任务、远端配置声明变化、旧连接结果失效与本地单向降级。只替代网络等外部边界，使用真实配置、coordinator、reducer、存储和 IPC。公网验证再检查真实 header 握手、实际项目模型效果、Token 长连接行为和 I2/I3；本次研究不改变现有验收状态。
