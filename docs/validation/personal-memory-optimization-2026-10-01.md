# 个人记忆、记忆概览与会话总结优化

状态：**实现完成·尚未验收**。范围为用户批准的五步；对应 SEM-F26/F27/F30/F31/F32/F37/F38、SEM-T03/T04/T06/T08，J21/J22/J28/J29、DB7/J12。

| 步骤 | 当前实现 |
|---|---|
| 语义登记 | CONTEXT、SEM、旅程矩阵及同一 OpenSpec change 对齐提问优先规则；旧会话全局推断退出注入并待复核。 |
| 个人记忆 | 正式提问的本人陈述、长期要求及独立重复表达先形成候选；确认/纠正支持正文、种类和范围。手动管理不调用模型。 |
| 会话关联 | 摄取冻结有界已确认信息，关联键同时在信息与字幕证据中核验；保存两侧身份、版本、水位和 digest。修改/忘记/删除使旧关联失效。 |
| 记忆概览 | 默认按实际条目分组，候选单列；后台综合复用既有 Loop/调度器，仅保留当前及一份上版。分页、覆盖、省略、失败及来源失效均有明确表示。 |
| 会话总结 | 四栏保持；可展开实际纳入输入的记忆、本次会话的关联依据及来源。普通总结不写入个人记忆；关闭、休眠及撤销继续隔离。 |

追加 migration 22/23/24；既有 migration checksum 保留。来源导航由主进程复核正式交互身份或会话/正文版本/事件范围，支持首个历史页之外的定位。原始提问不持久化，展示有界提问摘要及其缺失说明。

## 验证

| 检查 | 实际结果 |
|---|---|
| `npm test` 的 renderer/Core/Integration | 类型检查与构建成立；Core 1153/1153，Integration 119/119。含正式 Electron 设置、Agent Bar、历史及重启旅程。 |
| `npm run test:evidence` 最后一次执行 | 249 项：248 项成立、1 项明确跳过、0 项失败。跳过的是未请求的原生模型资格，不据此声称模型证据。 |
| 新增提问优化跨模块旅程 | 13/13；包括真实 renderer→preload→main→控制器→SQLite、真实 Loop/调度器、候选确认、范围修改、噪声负矩阵、总结输入、迟到响应与撤销。 |
| 新增概览存储检查 | 4/4；v21 升级及失败回滚、分页/提交幂等、精修稿分页外定位、SQLite 重开。 |
| OpenSpec / 差异检查 | `openspec validate clarify-memory-and-session-summary --strict`、`git diff --check` 均成立。 |

最终全量执行的 evidence 部分曾因 I3 导出基线的时区不一致出现 1 项失败；按该旅程固定的 UTC 环境重新运行 `node scripts/i3-nonaudio-soak.js --segments 3600 --batch-size 100 --report docs/validation/i3-nonaudio-results.json` 后，再执行完整 evidence lane 得到上表结果。I3 仍只代表 3600 段、7200000ms 虚拟时长的无音频预资格，未晋级真实两小时声音门禁。

受限环境的 Electron 开发入口加载本机页面返回 `ERR_FAILED`；沙箱外定向检查及完整 Integration 成立。J18 沿用其它确定性 Electron 旅程的无 GPU 参数，仅证明 renderer 初始化。新记忆界面的来源打开在确定性旅程中控制 Electron 的操作系统边界；真实窗口聚焦/返回、DWM 与真实 provider 的提取、关联和综合质量仍需实机验收。

本轮没有采集现场音频，没有新建包含音频、字幕正文、设备名或本地绝对路径的证据 JSON。I3 再生成记录由严格验证器复核，只保存规定的指标、布尔和哈希。

历史批量整理、复制/Markdown/JSON 携带、只读 MCP 保留为后续范围。本轮不提交、不归档整个 change，也不改变已有交互的导出编码。

## 工作树代码身份

以下为规范化 LF 后的 SHA-256；工作树还含先前改动，不以本记录归属这些改动。

| 边界 | SHA-256 |
|---|---|
| recipe 合同 | `99bf1bebf485ff752b61ebbedf89fa296ce4353e68b99caa26915cd3aaa91746` |
| 管理 UI 合同 | `d88c49f0ff0c9ca51efcc5adb197e319492ca8fa78edd54e3f959b41de5e734d` |
| 个人上下文存储 | `6577b329dfb37493500ad4bc0df1d734c370fa0db4f998b398e3dad5ef736a68` |
| 概览存储 | `3050ca55c4be57b5261c04a573a52e5acd1b8fa13c192aac327a72aa2623c4dc` |
| schema | `6650e15b9a55ab64f895a6a8f08f713b2116985c7d26be4cc1f51889a9a5c8f9` |
| 我的记忆 renderer | `86a9bb669fdcb42ba29a8145c2bf300cbb5a0f7fc5e9aae0bbf5ab627d558248` |
| 历史 renderer | `609d295e5987d4ba3a193abb990ecdcf0a6b313ec76a059c148ff3d77b95ace3` |
| Agent Bar renderer | `d082ec1559113ec61c4f77511001aa8568d0cbc912bb4cd8076ad268c02480ec` |
