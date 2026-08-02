# 字幕 MVP 验收导航

本页只投影 [`semantic-contract.md`](../semantic-contract.md) 与
[`testing-strategy.md`](../testing-strategy.md) 已登记的要求，不定义新要求。状态词、能力边界和
门禁冲突时，以上两份文档仍是权威来源。

| 门禁 | 状态 | 入口 | 环境 | 是否发声/采集 | 当前证据 | 下一动作 |
|---|---|---|---|---|---|---|
| DB0 / DB1 / DB2 / J10 SQLite 与迁移 | 联合验收完成 | `npm run test:integration`、`npm run test:evidence` | 本机或 Windows CI | 否 | [`db0-sqlite.md`](db0-sqlite.md)、[`db1-storage.md`](db1-storage.md)、[`db2-product-sqlite-cutover.md`](db2-product-sqlite-cutover.md) | 持续回归；I4 再复核正式 `userData` |
| J14 核心字幕模型资源包与精修模型资源 | 联合验收完成 | `model-install-caption-journey.test.js`、产品壳旅程 | Windows CI；公网供给另归 I4 | 否 | [`b4-model-and-product-shell.md`](b4-model-and-product-shell.md) | 在 I4 干净机复核真实公网供给与离线复启 |
| B5 打包态确定性资格 | 联合验收完成 | `npm run package:release` 与 B5 verifiers | 允许 Electron/NSIS 子进程的 Windows | 否 | [`b5-packaging.md`](b5-packaging.md) 与七份 B5 JSON | 新候选产生后重建并绑定全部报告 |
| J9-CI 远端资格 | 实现完成·尚未验收 | [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) | GitHub Windows hosted runner | 否 | run `30763123116` 绑定 revision `2efb8969…`，已通过 Electron `43.2.0`、存储、四窗口产品壳、packaged 双启动、release NSIS 与隔离安装卸载，hidden artifact 已上传；末端仅有完整产品文本 checkout 行尾造成的 2 项载荷漂移失败 | 推送全部产品文本 LF checkout 与新候选 B5 证据，取得成功 workflow 与 provenance artifact |
| J15a 固定高度字幕流 | 联合验收完成 | `caption-layout-smoke.js` + reducer/IPC/产品壳旅程 | Windows CI | 否 | `caption-layout-report@v2` 与确定性回归 | 保持每次 CI 回归 |
| J15a 可见 DWM 矩阵 | 实现完成·尚未验收 | `caption-visual-review.js` + matrix verifier | 交互式 Win11，四档真实 DPI 与异缩放双屏 | 否 | runner/verifier 已就位；尚无 36 例闭合矩阵 | 完成 36/36 observation 与一次异缩放双屏移动 |
| J15b / J15c 版本隔离与可选精修 | 联合验收完成 | core、integration、packaged 双启动 | Windows CI | 否 | [`b5-packaging.md`](b5-packaging.md) | I2/I4 再复核真实模型与音频边界 |
| Gate 0B 模型判定 | 已决定 | Gate 0B 脚本与指标回归 | 已记录机器基线 | 仅受控语料 | [`gate-0b.md`](gate-0b.md)；原判定由文内 2026-07-27 正式改判取代 | 模型或门槛变化时按冻结基准重新决策 |
| Gate 0C 采集拓扑 | 实机验收完成 | `scripts/gate-0c/` + strict verifier | 具备实际音频端点的 Win11 | 是 | [`gate-0c.md`](gate-0c.md) 与 `i2-live-v5/gate-0c-preflight.json` | 新 I2 候选按同轮预检重新绑定 |
| I2 真实来源与交互恢复 | 实现完成·尚未验收 | `run-i2-live-series.ps1`、`run-i2-interaction.ps1` | 具备真实 `loopback`/`mic`、设备控制权与睡眠权限的 Win11 | 是 | [`i2-real-source-series.md`](i2-real-source-series.md)、[`i2-interaction-recovery.md`](i2-interaction-recovery.md) | 优化冻结字幕可见延迟；完成原生拖动、设备移除/Retry、睡眠/唤醒/Retry 与物理麦克风证据 |
| I3 两小时字幕会话 | 实现完成·尚未验收 | `run-i3-live-audio-soak.ps1` | 可连续运行 7,200 秒的 Win11 | 是 | [`i3-live-audio-soak.md`](i3-live-audio-soak.md)；75 秒资格已有证据 | 完成原生拖动后执行 7,200 秒、至少 3,000 段的正式 soak |
| I4 非音频子门禁 | 实现完成·尚未验收 | `qualify-i4-nonaudio-nsis.ps1` | 无仓库、无 Node、无既有数据的 Win11 标准用户快照 | 否 | [`i4-nonaudio-nsis.md`](i4-nonaudio-nsis.md)；尚无专用机报告 | 在专用快照执行并带回 `pass/partial` 报告 |
| I4 完整干净机发布验收 | 已决定 | 非音频报告 + `loopback`/`mic` 音频 child + strict summary | 同一专用 Win11 标准用户候选环境 | 是，两个来源互斥顺序执行 | 音频 child、summary 与移交包要求已决定，尚未实现 | 实现入口后依次执行三个 child 并形成严格 summary |
| Agent 系统 | 已决定 | 后置 | 后续阶段 | 不拥有采集 | 尚未实现 | 不阻断字幕 MVP |

## 历史证据策略

`docs/validation` 下既有 JSON 是按当时 schema 与哈希链保留的证据，不在文件顶部追加注释，也不为
更新状态而改写。被后续改判或新 schema 取代的状态由本导航及对应 Markdown 明确标注：Gate 0B
原判定由其文内正式改判取代；`gate-0c-results.json` 只保留旧报告哈希凭据，当前权威预检是
`i2-live-v5/gate-0c-preflight.json`。历史交接文档也只作为快照，不得覆盖当前语义合同。

## 证据隐私

所有新报告先经过各自 strict verifier 与 SEM-F14 隐私负扫描，再考虑进入本目录。JSON 不得包含
字幕正文、现场 PCM/WAV、设备名、本地绝对路径、绝对单调时刻或时钟偏移；需要证明内容一致时只写
指标、枚举与摘要哈希。
