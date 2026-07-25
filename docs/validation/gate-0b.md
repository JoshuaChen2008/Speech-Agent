# Gate 0B 模型实测

> 日期：2026-07-25
>
> 结论：**实测已完成，Gate 未通过；当前不批准任何 realtime profile，也不批准 SenseVoice 精修能力。**

机器为 Windows 11 23H2（22631.5768）、Intel Core Ultra 9 185H；所有模型均用 CPU、3 threads。CLI 和 Node N-API 均为 sherpa-onnx 1.13.4。判定摘要、归档 URL/SHA256 和流式数值见 [`gate-0b-results.json`](gate-0b-results.json)；逐条 CLI 输出见 [`gate-0b-cli-observations.json`](gate-0b-cli-observations.json)，由它直接生成的 CER/WER/标点指标见 [`gate-0b-controlled-metrics.json`](gate-0b-controlled-metrics.json)。模型、合成 WAV 和逐次原始 CLI 日志位于已忽略的 `models/gate-0b/`，每组日志由观测文件中的 SHA256 关联。

## 判定

| 候选 | RTF | 首 partial | 内容/标点 | 结论 |
|---|---:|---:|---|---|
| X-ASR 480ms punct int8 | 可复现 CLI 4 条 `0.18–0.26` | 40ms 喂帧 P95：英文 `574ms`；中文/code-switch `1012–1034ms`。20ms code-switch 仍为 `1021ms` | 受控语料 macro CER `0`，能输出逗号 | **未过 `<1s`** |
| X-ASR 160ms punct int8 | 可复现 CLI 4 条 `0.44–0.65` | code-switch P95 `700ms` | 更快，但官方样本英文质量下降 | **未过 RTF `<0.35`** |
| small-bilingual int8 | 可复现 CLI 6 条 `0.082–0.18` | code-switch P95 `326ms` | code-switch 仅为“我下周一然后”，无标点 | **质量/标点不合格** |
| SenseVoice int8 精修 | 可复现 CLI 聚合 RTF `0.070` | 非流式 | macro CER 从 `0` 变为 `0.00893`；改善 0 条、退化 1 条；按标点数量计算的 F1 下降 | **无可量化收益** |

因此不能把 480ms 的 21–34ms 超标四舍五入成通过，也不能用 160ms/small-bilingual 的速度掩盖 RTF 或内容质量失败。Gate 标准未被修改。

## 方法

- `run-cli-suite.js` 用 v1.13.4 CLI 运行官方 WAV 与受控 WAV，把参数固定在源码中，并输出不含本机绝对路径的结构化观测；`rawOutputSha256` 关联本地逐组原始日志。
- `scripts/gate-0b/corpus.json` 定义 4 条非敏感语料：中文、英文、中英 code-switch、日期/ITN；`generate-corpus.ps1` 用 Windows SAPI 生成 16kHz mono PCM16 WAV 并记录 SHA256。
- `streaming-bench.js` 用官方 v1.13.4 Node N-API，以墙钟节奏分块喂入，首个连续有声窗口到首个非空 partial 计算 P50/P95；同步处理耗时单独计算 RTF。
- `evaluate-transcripts.js` 直接读取上述观测，对同一 WAV 的 X-ASR final 与 SenseVoice 输出计算 CER、英文 WER 和按标点数量计算的 F1，不经过人工抄录。
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
