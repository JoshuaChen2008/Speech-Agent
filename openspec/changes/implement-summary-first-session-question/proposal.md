## Why

会话问答反复处理整场正文，长输入受累计预算限制。会话经历摄取仍有单次 15,000 字节限制，概览仅保存前八项文本，无法承担用户要求的总结检索与精确回溯。

## What Changes

- 终态会话按容量生成独立范围的最终会话经历记录，保存逐项来源、时间、输入身份与处理进度；重试复用已提交范围。
- 新问答版本先检索会话经历记录及既有纪要，并允许原文独立召回；有界读取相邻正文，生成带依据与覆盖说明的回答。
- 正式 Agent 入口支持单会话、日期范围及项目的局部问答和全局回顾，完整清单/计数采用完整范围策略。
- 结果来源可点击精确定位字幕历史，来源失效、取消、预算和缺口显式反馈。
- 沿用个人记忆的候选确认与撤销；普通纪要不自动成为本人事实。保留旧 recipe、绑定、导出编码及迁移 checksum。

## Capabilities

### New Capabilities

- `summary-first-question`: 分段会话经历、检索问答、跨会话覆盖、来源导航及预算治理。

### Modified Capabilities

无；现行语义修订统一登记到 SEM-F26/F28/F30/F31/F34/F38/F39/F40 与 J21/J22/J24/J29/J30/J31。

## Impact

个人上下文、正式运行服务、执行宿主、recipe/预算合同、storage worker/SQLite 追加迁移、main/preload/Agent renderer/历史导航、三条既有测试 lane。复用同一 Agent Loop，不增加外部框架、远端权威数据库或现场音频产物。依据 docs/session-question-summary-first-plan.md；用户已授权实施全部规划。
