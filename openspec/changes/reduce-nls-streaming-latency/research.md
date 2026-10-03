# 信息收集记录 · 2026-09-27

本记录区分代码事实、受控实验、官方说明与待证假设。用户确认：当前仓库开发版；与参考程序使用同一 NLS 项目；主要症状是持续说话时字幕一直落后。用户要求以实际体验尽可能降低延迟，不把规划中的单一目标当作优化终点。

## 已有与新增证据

| 发现 | 证据 | 能说明什么 / 不能说明什么 |
|---|---|---|
| 一次交付停顿变成持续落后 | 前轮真实 buffer/provider/router 诊断：300/600/1200ms 停顿后持续同量落后；仅绕过发送等待后 600ms 差距归零 | 确认客户端存在保留积压的机制；没有证明实机触发源 |
| 云端默认分帧 100ms | `audio-host/host.js` 固定 1600 samples；worklet 的 FrameAssembler 等满帧再发布 | 单个样本等待装帧在约 0–100ms 内；不能单独解释秒级落后 |
| 后续发送另按音频时长排队 | `nls-realtime-provider.js` 在 callback 后计算下一期限，长迟到重锚定 | 采集与发送各有节奏；积压后缺少净消耗速率 |
| 云端不等待本地 VAD/解码 | realtime worker 将帧交给 CloudAudioBuffer，正常云端分支不调用本地 core.ingestFrame | 降低“本地模型慢导致正常云端慢”的优先级 |
| 存储与显示正常路径无秒级等待 | Coordinator 广播不等 SQLite 异步 I/O，caption ingest 直接 render | 静态路径事实；不能排除 main/renderer 事件循环卡顿 |
| TCP_NODELAY 已启用 | 已安装 `ws/lib/websocket.js` 的 setSocket 调用 `socket.setNoDelay()` | 不把重复设置 NoDelay 当作主要优化 |
| 首个 partial trace 偏向本地链路 | I2 脚本实例化 RealtimeRuntimeAdapter；worker partial timing 来自本地 core；云端结果在 main router 发布 | 当前运行器不能直接给出云端持续跟随全链路证据 |
| 云端观测不足 | RecognitionRuntimeAdapter 只附加 eventLoopP95Ms/P99Ms；CloudAudioBuffer 发到 main 的包不带原采集时钟字段 | 缺持续帧年龄、发送排队和结果对应显示观测；仅 P95 也会漏稀有长阻塞 |
| 改固定参数有历史兼容风险 | assertRecognitionBinding 与当前 NLS_PARAMETERS 逐字段相等；recognitionMetadata 在读 SQLite 时复用它 | 直接把 800 改成 300 可能拒绝旧会话快照；必须先区分历史版本与新默认值 |

代码位置均在仓库的 `src/` 下。前轮证据与命令见 [诊断记录](../../../docs/validation/nls-latency-investigation-2026-09-27.md)。本轮没有重复运行相同成功测试，也没有修改生产逻辑。

## 参考程序

三份 `_rebuild` 文档只有规划与逆向摘要，没有可直接执行的重建源码；原 exe 仍在。仅从 `setings.json` 输出白名单非敏感字段：`PunctuateSentenceValue=300`、`TranslateSwitch=false`、`BilingualSubtitleSwitch=false`、`MinutesMeetAudio=false`、`MinutesMeetTxt=true`、`AudioInputSource=1`。来源枚举映射未核验，不由整数猜测 mic/loopback。

exe 精确字符串检索命中 `PunctuateSentenceValue`、`SetMaxSentenceSilence`、`max_sentence_silence`、中间结果与标点参数名。它增强了“旧程序有断句配置”的线索，**不证明字段单位、调用关系、实际发出的值、分片大小或刷新频率**。没有读取 speech_engine 凭据、字幕历史，也没有启动会写 TXT 的参考程序。参考程序的后续对照须使用受控内容，且先核实现场音频保存关闭。

## 官方依据

访问日期为 2026-09-27；仅概述与本次决策有关的事实。

1. [WebSocket 协议](https://help.aliyun.com/zh/isi/user-guide/websocket)：100ms/3200 字节是 16kHz PCM 示例，分片不限定该大小，节奏需匹配音频时长。**没有据此得到无限突发或特定追平倍速的许可。**
2. [SDK FAQ](https://help.aliyun.com/zh/isi/support/sdk-faq)：文件模拟实时流需要控制发送速度；间隔过大增加延迟，过小增加网络与服务资源负担。它没有要求真实采集在每次到帧后再固定睡眠一个帧时长。
3. [Node SDK 示例](https://help.aliyun.com/zh/isi/developer-reference/sdk-for-node-js)：示例读取 1024 字节块并 sleep 20ms；示例不能当成协议推荐倍速或生产性能证据。
4. [Go SDK 示例](https://help.aliyun.com/zh/isi/developer-reference/sdk-for-go)：示例加载 320 字节块、循环 sleep 10ms。官方 [发送入口](https://github.com/aliyun/alibabacloud-nls-go-sdk/blob/master/st.go)委托底层发送，[WebSocket 层](https://github.com/aliyun/alibabacloud-nls-go-sdk/blob/master/ws.go)直接写二进制帧。**不能推断参考 exe 就采用当前版本 SDK。**
5. [实时识别接口](https://help.aliyun.com/zh/isi/user-guide/api-reference)：支持就近地域接入 `nls-gateway.aliyuncs.com`；中间结果的 time 表示服务端已处理音频时长，不保证显示文本最后一个词已跟上该水位。云模型仍由项目决定。
6. [语音识别 FAQ](https://help.aliyun.com/zh/isi/support/faq-about-speech-recognition)：语义断句可能增加延迟；当前代码已关闭。静音也须连续发送。文中约 300ms 尾点延迟不是首字或持续字幕延迟承诺。

## 本机无鉴权网络探测

三个官方域名分别执行三次新连接的 `curl.exe --head --noproxy '*' --connect-timeout 4 --max-time 6`；输出仅时间和 HTTP 状态，不发 Token 或音频，不读取响应正文。轮次顺序固定为当前上海、参考域名、就近域名，样本仅用于发现线索，不做统计显著性判断。

| 域名标签 | TCP 建连累计时间 ms（3轮） | 首响应累计时间 ms（3轮） |
|---|---|---|
| 当前上海 | 53.461 / 40.171 / 40.514 | 353.440 / 117.708 / 113.553 |
| 参考域名 | 53.311 / 47.444 / 38.673 | 157.287 / 143.078 / 113.126 |
| 就近域名 | 17.930 / 18.115 / 16.655 | 51.738 / 48.469 / 48.182 |

九次均为 HTTPS 404；只证明相应 HTTPS 路径可响应，不证明 NLS 鉴权、识别服务、header 兼容或流式时延。TCP 数值含 DNS，均不是长连接 RTT；不能把首轮 TLS 高值归因给识别模型。上海两个域名没有显示稳定数量级差异；就近域名值得纳入后续真实 NLS 实验，但不直接改生产端点。

第一次沙箱探测在 Windows Schannel `SEC_E_NO_CREDENTIALS` 处失败，该批不计为产品/服务失败；在正常系统权限下完成上述无鉴权探测。进程只读筛查未发现当前仓库 Electron 实例，因此本轮没有当前产品公网 ASR/renderer 分段时序。

## 定位优先级

1. 已复现机制：发送恢复时把积压保留下来。实机预测：结果对应音频落后与发送队列年龄同向变化。
2. 待证触发源：采集 renderer/worker/main 阻塞使帧成批交付。预测：延迟先出现在网络发送前。
3. 待证额外固定成本：100ms 装帧与公网路径。预测：改变分帧只影响相关区间，改变网关只影响传输/服务区间。
4. 待证体验差异：300 与 800 的断句配置、partial 内容修订行为。预测：断句改变主要影响稳定转写和段切换，不应解释所有持续 partial 排队。
5. 条件性架构方向：若主线程/Chromium 采集占主要成本，再考虑执行位置或采集拓扑。没有证据支持先重写 Electron、换供应商或并跑本地识别。


## 2026-09-30 首字慢：本轮复核与优先级修订

用户本轮明确症状为「从第一句话起就出字慢」。此前持续积压实验不能代替该症状的根因证明；当前未取得真实NLS、采集和renderer首字分段时序，首字根因仍未确认。本轮只诊断与规划，未改生产代码或调用付费识别。

当前云端支持为实现完成·尚未验收：上海NLS单项目配置、安全凭据/Token缓存、持续PCM、中间结果、首次稳定转写、暂停/恢复、停止排空、明确故障单向本地降级、SQLite与历史已有实现。缺口主要是云端专属性能观测和实机验收；多供应商与多地域可选不属于现有能力。J20旧矩阵行仍写「尚无实现证据」，与同文2026-09-23实施更新冲突，应按后者理解并在后续文档收口校正。

本轮复验 `node scripts/diagnose-nls-pacing.js --assert-recovery`：退出码1；300/600/1200ms交付停顿后仍持续同量落后；600ms仅绕过发送等待的实验为0ms。provider哈希仍为b43aa61a5c814076bddf47264e7a5e71b767973468d1fdc25b864fb764de6442。定向 `node --test test/runtime/nls-realtime-provider.test.js test/runtime/recognition-session-router.test.js test/integration/nls-recognition-runtime-journey.test.js`：24/24。前者是额外积压的诊断红信号，后者不证明真实云端低延迟。

首字排查按以下顺序执行，每项都有独立判别信号：

1. **P0：先分离启动等待与就绪后首字。** 当前启动顺序是worker就绪→beforeCapture取得Token并等待NLS TranscriptionStarted→startCapture。冷启动若慢在这些环节，仅说明点击开始到监听等待；如果已显示监听且语音起点之后仍慢，不能归因于之前的Token/模型准备。先补点击、worker就绪、Token、握手、采集首帧、首发、首个非空partial、Coordinator接受、renderer应用的相对耗时；冷/热启动与mic/loopback分开。
2. **P1：按最大实测分段选择优化。** 发送前慢：比较100/40/20ms实际采集分帧及IPC年龄；首帧立即发送已有实现，不额外加“立即发送”开关。Token/worker准备慢：评估有界缓存或不采集音频的准备并行，保留本地降级资源就绪和启动失败语义。发送及时而云端回包慢：同项目受控输入比较合法网关/项目模型与参数；先核对地域和鉴权适配，不直接换域名。回包到显示慢：定位main/renderer阻塞后再考虑隔离。
3. **P1并行证据项：修复已复现的持续积压。** 正式优化仍需有界追平、背压、2秒待发硬上限、连续性和真实服务接受性；不能无界补发或丢帧。它保护后续跟随性，不承诺解决首字慢。
4. **P2：断句单独比较800/500/300ms。** 官方协议明确max_sentence_silence是句末静音门限，中间结果开关独立；当前中间结果开启、语义断句关闭。减少静音门限针对定稿，不能承诺缩短首字。任何默认参数改变须先分离历史绑定校验，防止旧会话读取失败。

验收保留首字五轮与既有I2门槛，同时比较持续文字落后、停顿恢复、准确性和资源；报告仅指标/哈希。当前没有可复现用户首字症状的真实服务闭环，因此以上首字路径是待测分支，不是已证根因。执行入口沿用本change任务2.1–2.3；先形成基线再选择4/5/6/7节候选，避免一次实现整个实验矩阵。

官方复核：[实时识别接口](https://help.aliyun.com/zh/isi/user-guide/api-reference)、[WebSocket协议](https://www.alibabacloud.com/help/en/isi/user-guide/websocket)。协议说明中间结果与断句是不同控制，语言/模型依赖项目配置；本轮未验证任何新网关实际识别资格。
