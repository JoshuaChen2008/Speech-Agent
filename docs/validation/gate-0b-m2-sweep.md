# Gate 0B · M2 参数扫描复测（2026-07-26）

> 结论先行：**两个本地 X-ASR 候选在冻结门槛下均不可达标，且原因是架构/算力性的，
> 运行时参数（线程数、chunk 尺寸）无法弥补。** Gate 0B 判定维持 FAIL，
> `approvedProfiles` 维持空。本文档不放宽任何门槛，只封闭「调参能否救回」这个问题，
> 并把残余选项交产品拍板。
>
> **状态更新（2026-07-27）**：产品负责人已按本文残余选项 1 正式改判——批准
> `x-asr-160ms@t4`（fast profile）并重设 RTF 门槛，理由与适用条件见
> [`gate-0b.md`](gate-0b.md) 改判节。本扫描的判定所需数字已提取为 tracked 的
> [`gate-0b-m2-sweep.json`](gate-0b-m2-sweep.json)（`summarize-m2-sweep.js` 生成，
> path-free，以 rawOutputSha256 绑定当轮内存中的 CLI 输出）。当前 M2 runner 的普通
> 输出在生成处已投影为 ID、指标与哈希；M3 必需的线程 sweep 正文副本只能进入
> `models/gate-0b/private/`，不得写入普通 runs、validation 或 artifacts。
>
> 改判当日另补测了 x160@t4 的**全语料**首 partial（本文只测过 code-switch 一条；
> 摘要中的 `x160FirstPartialBench`）：三条 697–856ms 通过，zh-date-itn P95
> `1000.3ms` 骑线（该句 960ms 音频下限，与 480ms 同句一致）；已在改判记录中
> 如实标记为边缘案例，未按通过处理。本文「首 partial ~700ms」的表述仅基于
> code-switch 单条，以补测为准。

## 方法学

与 `docs/validation/gate-0b.md` 冻结方法学完全一致：同一受控语料
（`scripts/gate-0b/corpus.json` 生成的 4 个 WAV）、同一测量脚本族、paced 实时喂帧、
首 partial 从 speech onset 起算、选择级 RTF 以官方 CLI 输出为准。
唯一展开的维度是 **numThreads 运行时配置**（新增 `--num-threads` 参数与
`cli-thread-sweep.js` runner，配置逐条披露在结果中，测量语义不变）。

- 机器：Intel Core Ultra 9 185H（16 核 / 22 逻辑，6P+8E+2LPE 混合架构），CPU provider
- 引擎：sherpa-onnx v1.13.4（CLI 与 N-API 同版本）
- 内容安全的扫描结果：`models/gate-0b/runs/m2-sweep/`；M3 必需的正文中间件：`models/gate-0b/private/m2-sweep/`（两者均被忽略，本文档只记录判定所需数字）

## 480ms punct int8：首 partial 是架构下限，线程无关

N-API streaming bench（首 partial 权威来源），chunk 40ms、5 runs/case、paced：

| 案例 | t=3 P95 | t=4 P95 | t=6 P95 | audioNeededAfterOnset |
|---|---|---|---|---|
| zh-en-code-switch | 1028ms | 1020ms | 1026ms | **980ms** |
| zh-roadmap | 1023ms | 1020ms | 1027ms | **980ms** |
| zh-date-itn | 1006ms | 996ms | 1010ms | **960ms** |
| en-onboarding | 564ms | 569ms | 564ms | 520ms |

基线（t=3）精确复现上轮 1012–1034ms 区间，方法学连续性成立。

**判定**：中文/混说案例的首 partial 需要 **960–980ms 的音频输入**才能产出首个 token
（480ms chunk ×2 + lookahead 的模型架构特性）。paced 实时喂帧下墙钟下限
≈ 音频需求 + 解码耗时 ≈ 990–1030ms，恰好骑在 1000ms 门槛上且不可压缩——
三种线程数的 P95 全部落在 996–1028ms，差异是噪声。**首 partial P95 <1000ms
对该模型在任何线程配置下均不可稳定达标。**

## 160ms punct int8：RTF 算力不可达，多线程反噬

官方 CLI（选择级 RTF 权威来源），`cli-thread-sweep.js`，官方 test_wavs + 受控语料：

| 配置 | official max RTF | controlled max RTF |
|---|---|---|
| t=3（基线） | 0.510 | 0.540 |
| **t=4（最优）** | **0.470** | **0.500** |
| t=6 | 0.520 | 0.570 |
| t=8 | 0.730 | 0.880 |

**判定**：最优配置（t=4）的 RTF 仍是门槛（<0.35）的 1.34–1.43 倍；t≥6 在混合架构上
因 E 核调度反而显著劣化。**RTF <0.35 对该模型在本机 CPU 上不可达标**（首 partial
~700ms 达标不受影响，与上轮一致）。

## 未尝试且不建议继续的方向

- P 核亲和性绑定：预估收益不足以跨过 0.35，且产品无法向用户机器保证核绑定。
- 更新 sherpa 运行时：v1.13.4 为 2026-07-25 复核时的 latest，无更新可用。
- GPU/CUDA：PLAN §2.1 已排除（310MB 运行时 + 终端用户 CUDA 依赖）。

## 残余选项（产品拍板，不由本文档决定）

1. **有意识地重设门槛**：160ms@t4 首 partial ~700ms、内容/标点上轮已过，仅 RTF
   0.47–0.50 超标。原 0.35 门槛保护的是「双路并发 + 精修余量 + 弱机」；在何种
   机器基线上重新定义门槛是产品决定，必须显式记录，不得静默放宽。
2. **nemotron-3.5-asr-streaming-0.6b（2026-06-11）**：新流式家族，80–1120ms 五档，
   int8 各 453MB。参数量约为 X-ASR 的 4 倍，CPU RTF 风险更高，且 453MB 突破
   PLAN §8.2 的首启下载预算，需产品批准后实测。
3. **等待上游新候选**：X-ASR 家族若发布更小 chunk 或蒸馏版本再复测。

## 精修轨（与上述解耦）

`sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03`（131MB，非流式，
X-ASR 同家族离线版）作为 SenseVoice 替换候选进入 M3 评估：同词表/同标点风格，
直接对准上轮 SenseVoice 败因（code-switch CER 退化、标点 F1 下降、无净收益）。
