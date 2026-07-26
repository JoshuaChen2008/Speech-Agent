# Gate 0B · M3 精修候选替换评估（2026-07-27）

> 结论先行：**离线 X-ASR（同家族非流式）在冻结基准上全面胜出 SenseVoice，
> 建议作为精修候选进入正式 re-judgment。** 本文档只提供证据与建议；
> `gate-0b-results.json` 的 `approvedRefinement` 是受测试约束的冻结判定，
> 翻转它属于正式 gate 决定，与 realtime 门槛的产品拍板一并进行。
>
> **状态更新（2026-07-27）**：re-judgment 已执行——产品负责人批准本候选替换
> SenseVoice（`approvedRefinement: true`），决定与条件见 [`gate-0b.md`](gate-0b.md)
> 改判节。本评估的结构化输出已进 tracked 的
> [`gate-0b-m3-evaluation.json`](gate-0b-m3-evaluation.json)，与判定块由测试强制一致。

## 候选与来源

- 模型：`sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03`
  （非流式 transducer，X-ASR 家族，与 realtime 候选同词表/同标点风格）
- 来源：官方 `k2-fsa/sherpa-onnx` GitHub release `asr-models`
- 压缩包 130.1MB，SHA256 `5D02C36D7B44E886B7C8F0D8E051F8713ACAB96C264BB6EF9E718BE39A6A2224`
- 解包位置：`models/gate-0b/extracted/x-asr-offline/`（忽略目录）

## 方法学

与 SenseVoice 原评估完全一致：同一受控语料（4 案例）、同一官方 CLI
（sherpa-onnx-offline.exe, num-threads=3, cpu）、同一冻结评估器
`evaluate-transcripts.js`（CER/WER/标点 F1、净收益口径）、聚合 RTF 口径。
Runner：`scripts/gate-0b/m3-offline-refine.js`；原始输出与结构化结果在
`models/gate-0b/runs/m3/`（忽略目录）。评估器输出的 `senseVoice` 字段在本
评估中承载精修候选。

## 结果对照（SenseVoice 败因逐条对齐）

| 指标 | realtime x480 基线 | SenseVoice（冻结原判定） | 离线 X-ASR（M3） |
|---|---|---|---|
| macro CER | 0.0000 | **0.0089（1 案例退化）** | **0.0000（零退化）** |
| macro 标点 F1 | 0.1667 | **0.0000（摧毁标点）** | **1.0000（4/4 满分）** |
| 聚合 RTF | — | 0.070 | **0.027**（21.4s 音频 / 0.58s） |

以 x160-controlled-t4 为基线同样成立（realtime 标点 F1 0.0000 → 精修 1.0000，
CER 0→0）。逐案例细节：精修还原了句号、逗号与英文连字符（"drop-off"），
无任何内容改写退化。

## 边界与后续（与原判定的冻结告诫一致）

- 受控语料为干净 SAPI 语音、仅 4 案例：realtime 基线内容 CER 已为 0，
  本基准上「正向 CER delta」没有可得空间；本候选的净收益体现为
  **零内容退化 + 标点满分**，恰好是 SenseVoice 的两条死因。
- 多人、远场、噪声与真实口音语料的扩展仍是 re-judgment 前置条件之一
  （原判定告诫保持有效）。
- 磁盘影响：解包后约 168MB，替代 SenseVoice 的约 230MB（首启下载预算改善）。
- 五语能力（日/韩/粤）随 SenseVoice 移除而失去；产品当前只承诺 zh/en，
  如未来需要多语精修需另行评估。
