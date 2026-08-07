# Gate 0B 模型实测

> 日期：2026-07-25
>
> 原结论（2026-07-25）：**已决定不批准当时的 realtime profile 与 SenseVoice 精修能力。**
>
> **后续决定（2026-07-27）**：产品负责人正式改判——在写明机器基线与理由的前提下把 RTF 门槛重设为 `<0.60`，批准 `x-asr-160ms`（fast profile，numThreads=4）与离线 X-ASR 精修（替换 SenseVoice）。原判定与原门槛在本文与 `gate-0b-results.json` 中原样保留；改判记录见本文末尾 [正式改判](#2026-07-27-正式改判re-judgment) 与 `gate-0b-results.json` 的 `rejudgment` 块。

> 文档复核（2026-08-07）：三个后续 realtime 替代候选的受控评测仍是“0 个 eligible ID、尚未选定替代模型”，生产 manifest 未变；该决定为已决定。本机 revision `a91a200cc2d3df5f73dcb7a0894a9758e532106a` 的 Gate 0B 严格汇总及失败路径包含在 evidence 200/200 中，但远端 run `30801570384` 的同一 evidence lane 为 197 pass+3 fail：`scripts/gate-0b/corpus.json` 未固定 LF，hosted CRLF SHA `fdf4420a243cc6e0efe0074dbf5c60c97efc1d1284448b7bfce9c3d658e1fce9` 与 registry/报告登记的 LF SHA `7edd6dff286b84619a3b68f385ba04622103ffe17cc57dbe5e1f16521deb156d` 不同。该可移植性缺口不改变候选判定，但使当前 revision 的 SEM-T03/J9-CI 保持实现完成·尚未验收；补齐 LF checkout 合同并重跑完整远端资格后才能提升状态。

机器为 Windows 11 23H2（22631.5768）、Intel Core Ultra 9 185H；所有模型均用 CPU、3 threads。CLI 和 Node N-API 均为 sherpa-onnx 1.13.4。判定摘要、归档 URL/SHA256 和流式数值见 [`gate-0b-results.json`](gate-0b-results.json)；[`gate-0b-cli-observations.json`](gate-0b-cli-observations.json) 只保留逐 case 指标与输出摘要哈希，由当时正文计算出的 CER/WER/标点指标在 [`gate-0b-controlled-metrics.json`](gate-0b-controlled-metrics.json) 中也只保留数值与正文摘要哈希。模型和生成测试语料位于已忽略的 `models/gate-0b/`；原始 CLI 输出只在内存中完成解析与摘要哈希，普通文件及标准输出只发布无正文投影。确需持久化的正文中间件只能写入固定私有目录 `models/gate-0b/private/`；受跟踪证据不保存正文、token 串或音频文件名。

## 判定

| 候选 | RTF | 首 partial | 内容/标点 | 结论 |
|---|---:|---:|---|---|
| X-ASR 480ms punct int8 | 可复现 CLI 4 条 `0.18–0.26` | 40ms 喂帧 P95：英文 `574ms`；中文/code-switch `1012–1034ms`。20ms code-switch 仍为 `1021ms` | 受控语料 macro CER `0`，能输出逗号 | **未过 `<1s`** |
| X-ASR 160ms punct int8 | 可复现 CLI 4 条 `0.44–0.65` | code-switch P95 `700ms` | 更快，但官方样本英文质量下降 | **未过 RTF `<0.35`** |
| small-bilingual int8 | 可复现 CLI 6 条 `0.082–0.18` | code-switch P95 `326ms` | code-switch 仅为“我下周一然后”，无标点 | **质量/标点不合格** |
| SenseVoice int8 精修 | 可复现 CLI 聚合 RTF `0.070` | 非流式 | macro CER 从 `0` 变为 `0.00893`；改善 0 条、退化 1 条；按标点数量计算的 F1 下降 | **无可量化收益** |

因此不能把 480ms 的 21–34ms 超标四舍五入成通过，也不能用 160ms/small-bilingual 的速度掩盖 RTF 或内容质量失败。Gate 标准未被修改。

## 方法

- `run-cli-suite.js` 用 v1.13.4 CLI 运行官方测试语料与受控测试语料，把参数固定在源码中；受跟踪 schema-v2 投影只写 case ID、数值和 `transcriptSha256`/`resultSha256`。`rawOutputSha256` 在内存中计算，只绑定当轮 CLI 输出，不再持久化逐组原始日志。CER/WER 复算所需的唯一正文中间件只能写入固定、被 Git 忽略的 `models/gate-0b/private/`；其他仓库路径 fail closed。
- `scripts/gate-0b/corpus.json` 定义 4 条非敏感语料：中文、英文、中英 code-switch、日期/ITN；`generate-corpus.ps1` 用 Windows SAPI 生成 16kHz mono PCM16 WAV 并记录 SHA256。
- `streaming-bench.js` 用官方 v1.13.4 Node N-API，以墙钟节奏分块喂入，首个连续有声窗口到首个非空 partial 计算 P50/P95；同步处理耗时单独计算 RTF。文件与 stdout 都只输出 schema-v2 的 case ID、指标和正文哈希，不含 `wav`、partial/final 正文。
- `evaluate-transcripts.js` 在忽略目录中直接读取同轮私有观测，对同一 case 的 X-ASR 首次稳定转写与 SenseVoice 输出计算 CER、英文 WER 和按标点数量计算的 F1；写入受跟踪目录前投影为只含指标与哈希的 schema-v2，不经过人工抄录。
- 每个 480ms/40ms case 重复 5 次；边缘失败另以 20ms code-switch 重跑 5 次。

## 关键事实修正

- 官方 Windows v1.13.4 CLI 归档里没有 PLAN 所写的 `sherpa-onnx-microphone.exe`。首 partial 因此由同版本 N-API 测量，而非用离线 RTF冒充延迟。
- `small-bilingual` 下载归档实际为 458,187,351 bytes，因为同时包含 float/int8 和多个 chunk 变体；被选中的顶层 int8 三件套约 50 MB。
- 当前 SenseVoice 归档来自 WSYue-ASR；对 4 条受控普通话/英语输入都返回 `<|yue|>`，不能据此批准普通话/code-switch 精修。

## 后续决策

1. `Capabilities.availableProfiles` 在真实 ModelManager 中保持空数组，直到新的候选通过；Gate 0A 的 fixtures 仍是 UI 状态演示，不代表模型已获批准。
2. 480ms 是最接近的候选。若继续评估，应先明确可复现的优化（模型、解码或硬件下限），再按相同语料和门槛全量复测；不能直接放宽 `<1s`。
3. 替换 SenseVoice 精修候选，并加入多人、远场、噪声和真实口音语料；必须报告 macro CER/WER 的正向 delta。
4. 本次只验证模型/CLI/N-API。Electron worker、VAD、背压和真实音频链路不在 0B 的通过声明内。

## 2026-07-27 正式改判（re-judgment）

在 [M2 参数扫描](gate-0b-m2-sweep.md) 证明两条失败均为架构/算力性不可调参救回、[M3 精修评估](gate-0b-m3-refinement.md) 给出全面胜出的替换候选之后，产品负责人于 2026-07-27 明确批准以下两项决定（非静默放宽，逐条留档）：

### 改判 1：重设 realtime RTF 门槛，批准 x-asr-160ms（fast profile）

- **原门槛**：official 样本 RTF `<0.35`。该线当年为「弱机 + 双路并发 + 精修余量」预留。
- **重设为**：official 样本 RTF `<0.60`，**仅限已记录的批准机器基线**（Intel Core Ultra 9 185H，16 核 / 22 线程级别）。
- **理由**：160ms 实测最优（numThreads=4）official max RTF `0.470`、受控 max `0.500`；双路并发占 2×4 / 22 线程，批准的精修仅增加 RTF `0.027`，在本基线上余量仍然充足。弱机不在本次批准范围内——打包版（B5/I4）必须在目标机器复测后才能发布 fast profile，复测不过维持 `availableProfiles: []`。
- **首 partial**（<1000ms 原门槛不变；改判当日补测 t=4 全语料，见 `gate-0b-m2-sweep.json` 的 `x160FirstPartialBench`）：code-switch P95 `697.5ms`、英文 `709.0ms`、中文 roadmap `855.8ms` 通过；**zh-date-itn P95 `1000.3ms`（P50 `992.4ms`）骑线**——该句 5 次运行全部需要恰好 960ms 音频才出首 token，与 480ms 模型在同句的音频下限一致，属发音内容决定的架构性下限。不四舍五入成通过，如实记录为边缘案例：个别开头（如「会议安排在…」）首字会到 ~1.0s，典型案例 0.7–0.86s。
- **已知限制**：160ms 在受控短句上几乎不出标点（macro 标点 F1 = 0），标点恢复交由精修遍完成，因此定稿字幕默认必须启用精修；numThreads ≥ 6 在混合架构上反噬，禁止使用；首 partial 随发音内容波动，个别句子存在 ~960ms 音频下限（上一条骑线案例）。

### 改判 2：批准离线 X-ASR 精修，替换 SenseVoice

- **候选**：`sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03`（同家族非流式）。
- **证据**（两条基线 x480 / x160-t4 同时成立）：内容零退化（macro CER 0 → 0、退化 0 条）、标点 F1 恢复到 `1.000`、聚合 RTF `0.027`——恰好逐条修复 SenseVoice 的两条死因。
- **代价**：失去日/韩/粤能力（产品当前只承诺 zh/en）；磁盘 ~168MB，替换 SenseVoice 的 ~230MB 后首启下载预算改善。

### 持续有效的条件

- 受控语料仍是干净 SAPI 4 条；多人、远场、噪声、真实口音语料扩展仍是后续义务，本次改判不放大质量声明。
- 结构化判定与证据受测试约束：`gate-0b-results.json`（`rejudgment` 块）↔ [`gate-0b-m2-sweep.json`](gate-0b-m2-sweep.json) / [`gate-0b-m3-evaluation.json`](gate-0b-m3-evaluation.json)，由 `test/gate-0b/metrics.test.js` 强制一致。
- 后续任何模型或门槛变更都需要按同一冻结基准重新出具明确的产品决定。

## 2026-08-03 I2 集成复核：重新开启 realtime 模型替换评估

revision `b96b8fe7db5ba4db3ac36c4ee85371a4381b521f` 的五轮真实 `loopback` 产品链路在 4×100ms 段前缓冲与 12×100ms provisional stream 优化后，冻结字幕可见延迟仍为 P50/P95/min/max=1144/1242/1054/1242ms。五轮 `audioNeededAfterCapturedOnsetMs` 为 712.625–776.562ms。最慢 child 的 1242ms 六段为 814/400/0/27/0/1ms；同轮扣除 776.562ms 模型音频需求和触发后 28ms 发布/路由后，当前捕获/VAD 前置观察值为 437.438ms。仅在保持该轮已观察组合时，要维持 `<1000ms`，模型音频需求必须低于 534.562ms。

本 Gate 已跟踪的同一 `zh-en-code-switch` 裸模型结果是 P95=697.4775ms、观测最大音频需求 660ms。它与产品五轮的 712.625–776.562ms 同向，但不是物理下限证明，也不排除另行登记的捕获拓扑或实现改造。当前证据只说明继续微调现有候选缺少达线依据。

因此状态更新为：**已决定基于当前观测停止本轮参数微调，并重新开启 realtime 模型替换评估**。2026-07-27 对 `x-asr-160ms` 的历史改判与证据原样保留，但该候选只继续作为当前实现基线，不再足以支持 I2 发布判定；尚未批准任何替代 realtime 模型。新候选必须沿用相同语料、质量、RTF、首个临时字幕和隐私投影口径，先登记模型 manifest/供应链与 J14 影响，再执行两来源各五轮 I2。不得降低 `<1000ms`、移动 `source t0 + 140ms` 或把六段诊断改作验收值。

## 2026-08-03 实时候选矩阵复测

本轮按 SEM-F17/SEM-T11/SEM-T14 与 J1/J14 先登记供应链、运行文件和门槛，再用同一四条冻结语料、官方 CLI 1.13.4 与 Node N-API 1.13.4 复测。每例 N-API 执行 5 轮、40ms 墙钟喂帧；内容质量相对当前生产受控基线要求 macro CER 与英文 WER 都不高于 `0`。实时模型标点仍由用户明确启用的可选精修补齐，不作为本轮替换门槛。

| `evaluation-only` 候选 | CLI max RTF | 首个临时字幕 P95 最大值 | 混说观测音频需求最大值 | macro CER / 英文 WER | 判定 |
|---|---:|---:|---:|---:|---|
| large bilingual Zipformer | `0.17` | `630.5279ms` | `300ms` | `0.05998168498168498` / `0.1111111111111111` | 内容质量失败 |
| bilingual Paraformer | `0.29` | `588.0249ms` | `500ms` | `0.024267399267399264` / `0.4444444444444444` | 内容质量失败 |
| trilingual Paraformer | `0.27` | `575.8275ms` | `500ms` | `0.21543040293040294` / `0.3333333333333333` | 内容质量失败 |

三项候选的 CLI RTF `<0.60` 与四例首个临时字幕 P95 `<1000ms` 均成立，且混说观测音频需求都低于条件性 `534.562ms` 工程筛选值；该筛选仍不是 I2 验收门槛。三项都未保住内容质量，因此全部保持 `evaluation-only`，未选定替代实时模型。结合既有 small bilingual 质量失败与当前 `x-asr-160ms` 产品链路冻结字幕可见延迟未达线，当前 sherpa-onnx runtime 可直接部署的官方在线中英候选矩阵已逐项留证；中文-only、英文-only 与 online CTC 中文模型不满足同一会话中英内容边界，未进入本轮候选矩阵。

受跟踪严格汇总为 [`gate-0b-realtime-candidate-summary.json`](gate-0b-realtime-candidate-summary.json)：绑定候选 registry SHA-256 `d202c018aa295e5d1859765c1856dab7509280ad7dfcf96c601e1657b48bdcac`，汇总文件 SHA-256 `682d71b5bb8ff7851ceec15e0673bf52943cc74ca9611f9617306d18c4c08a1f`。它内嵌三份内容脱敏评测，重建结果为 `no-eligible-candidate`、0 个 eligible ID、替代候选为 null、生产 manifest 未变；evidence lane 对 registry/corpus/生产 manifest SHA、三份评测闭合字段、指标重算和隐私负向字段 fail closed。

因此**已决定**生产 manifest、J14 下载预算、ready marker 与当前实现基线均不改变；下一步必须另行登记新的模型资产或识别架构并按相同门槛复测。不得降低 `<1000ms`、移动 `source t0 + 140ms` 或放宽内容质量边界，I2 仍为实现完成·尚未验收。
