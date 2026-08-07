# 字幕 MVP 验收导航

本页只投影 [`semantic-contract.md`](../semantic-contract.md) 与
[`testing-strategy.md`](../testing-strategy.md) 已登记的要求，不定义新要求。状态词、能力边界和
门禁冲突时，以上两份文档仍是权威来源。

> 2026-08-07 当前复核基线为 revision `bbfd7041e5963e51942392323735298a7b81cb30` / run `31191838016`：core 422 tests=415 pass+7 expected model/Silero-asset skips、integration 29/29、evidence 204/204；总计 655 tests=648 pass+7 expected skips+0 fail。artifact ID `8999273285`、GitHub ZIP digest `5ce4070cee109df6d3d86b43b165b20a40636e8e3cd638fd9f28096da95855af`、索引绑定 installer SHA `d77d16c00337696727e00ad41d3fc61e1eab85d99edc4527c7cf55b548e0060c`、产品载荷 SHA `e95fd87f8af1e46e50745d8fb541d337bab783905202120df4d92e579beea35a`。7 项跳过不计作模型测试成立；本轮未执行声音测试。

| 门禁 | 状态 | 入口 | 环境 | 是否发声/采集 | 当前证据 | 下一动作 |
|---|---|---|---|---|---|---|
| DB0 / DB1 / DB2 / J10 SQLite 与迁移 | 联合验收完成 | `npm run test:integration`、`npm run test:evidence` | 本机或 Windows CI | 否 | [`db0-sqlite.md`](db0-sqlite.md)、[`db1-storage.md`](db1-storage.md)、[`db2-product-sqlite-cutover.md`](db2-product-sqlite-cutover.md) | 持续回归；I4 再复核正式 `userData` |
| J14 核心字幕模型资源包与精修模型资源 | 联合验收完成 | `model-install-caption-journey.test.js`、产品壳旅程 | Windows CI；公网供给另归 I4 | 否 | [`b4-model-and-product-shell.md`](b4-model-and-product-shell.md) | 在 I4 干净机复核真实公网供给与离线复启 |
| J16 同源两阶段实时识别 | 联合验收完成 | `two-stage-recognizer.test.js`、`caption-session-journey.test.js`、schema-v4 产品壳 | Windows CI；真实张量另归 I2/I4 | 否 | `mic`/`loopback` 同帧扇出、权威接管、唯一首次稳定转写、失败边界、三项核心 marker 与四项总资源闭合 | 保持确定性回归；真实来源性能不在本轮执行 |
| B5 打包态确定性资格 | 联合验收完成 | `npm run package:release` 与 B5 verifiers | 允许 Electron/NSIS 子进程的 Windows | 否 | 当前 bbfd/run 资格绑定远端 installer SHA=`d77d16c0…060c`、产品载荷 SHA=`e95fd87f…a35a`；下载 artifact 不含 installer 字节。历史本地候选 `d862c5fc…0de10` / `a1f03ed6…9accc` 只由其七份 B5 JSON 同轮绑定 | I4 必须另行取得并核验当前 bbfd/run 的精确 installer 字节；不得把远端摘要或历史本地候选冒充当前安装器 |
| J9-CI 远端资格 | 联合验收完成 | [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) | GitHub Windows hosted runner | 否 | run `30784483976` 绑定 I3 修复代码候选 revision `82d56f64…7939`，Electron `43.2.0` 前置、全部 workflow steps 与 627 项回归成功；artifact `qualification-evidence-82d56f64…-30784483976-1`（ID `8844827701`，ZIP digest `78227ef5…daca`）下载后通过五个 strict readers、四份报告与 lockfile/workflow SHA、跨报告绑定及 41 文件/29 JSON 隐私负扫描。下载包不含 installer 字节，同轮 workflow 已在索引生成前复核远端 installer SHA `bdac65ed…a7c4`。后续 revision `c36aefaee4778a1bf2dfe1ee005924a724f4be53` 的 run `30786324179` 因 I3 live playback HTML 未固定 LF 而在 evidence lane fail closed，未形成新的 provenance 索引；该 revision 保持实现完成·尚未验收。LF 修复 run `30787209338` 精确绑定 revision `f86ac1ef604dc7da0728c6eda44d59bbfd1e09bf`，全部 workflow steps 与 629 项回归成功；artifact `qualification-evidence-f86ac1ef604dc7da0728c6eda44d59bbfd1e09bf-30787209338-1`（ID `8845725648`，GitHub ZIP digest `b9d0a56b…93242`）下载后通过五个 strict readers、四份报告与两个源码 digest、跨报告绑定及 41 文件/29 JSON 隐私负扫描；同轮索引绑定 installer SHA `b9becb19…16f31`。其后 run `30790372286` 精确绑定 I2 模型替换决策 revision `5c6ce847fc07329802e3e98db9db70cc683f1f75`，Electron `43.2.0` 前置，workflow 结论为 `success`；core 414 tests=407 pass+7 expected model/Silero-asset skips，integration 27/27，evidence 190/190；总计 631 tests=624 pass+7 expected skips+0 fail。7 项跳过不计作模型测试成立；artifact `qualification-evidence-5c6ce847fc07329802e3e98db9db70cc683f1f75-30790372286-1`（ID `8846860080`，GitHub ZIP digest `5968779b…69ef`）下载后通过同一组严格复核与隐私负扫描，同轮索引绑定 installer SHA `618f02ed…57e0` 且下载包不含 installer 字节。该精确 revision 的 J9-CI 已达到联合验收完成 | 保持每次候选回归；不得替代 Gate 0B 模型选择或 J15a/I2/I3/I4 实机门禁 |
| J9-CI 当前 revision 复核 | 联合验收完成 | run `31191838016` / revision `bbfd7041e5963e51942392323735298a7b81cb30` | GitHub Windows hosted runner | 否 | 全部 workflow steps、655 项回归口径、provenance 索引与 artifact 上传成立；artifact ID `8999273285`、ZIP digest `5ce4070c…55af` | 保持每次候选回归；不得替代 J15a/I2/I3/I4 实机门禁 |
| J15a 固定高度字幕流 | 联合验收完成 | `caption-layout-smoke.js` + reducer/IPC/产品壳旅程 | Windows CI | 否 | `caption-layout-report@v2` 与确定性回归 | 保持每次 CI 回归 |
| J15a 可见 DWM 矩阵 | 实现完成·尚未验收 | `caption-visual-review.js` + matrix verifier | 交互式 Win11，四档真实 DPI 与异缩放双屏 | 否 | runner/verifier 已就位；尚无 36 例闭合矩阵 | 完成 36/36 observation 与一次异缩放双屏移动 |
| J15b / J15c 版本隔离与可选精修 | 联合验收完成 | core、integration、packaged 双启动 | Windows CI | 否 | [`b5-packaging.md`](b5-packaging.md) | I2/I4 再复核真实模型与音频边界 |
| Gate 0B 历史模型判定 | 已决定 | Gate 0B 脚本与指标回归 | 已记录机器基线 | 仅受控语料 | [`gate-0b.md`](gate-0b.md)、[`gate-0b-realtime-candidate-summary.json`](gate-0b-realtime-candidate-summary.json)；严格汇总绑定 registry `d202c018…bdcac`，三个新候选均因内容质量失败保持 `evaluation-only`，0 个 eligible ID，尚未选定替代模型，当时的生产 manifest 未变；该冻结 summary 不资格当前 schema-v4 manifest | 另行登记新的模型资产或识别架构；保持全部冻结门槛后复测，不得用 Gate 0B 替代两来源 I2 |
| Gate 0C 采集拓扑 | 实机验收完成 | `scripts/gate-0c/` + strict verifier | 具备实际音频端点的 Win11 | 是 | [`gate-0c.md`](gate-0c.md) 与 `i2-live-v5/gate-0c-preflight.json` | 新 I2 候选按同轮预检重新绑定 |
| I2 真实来源与交互恢复 | 实现完成·尚未验收 | `run-i2-live-series.ps1`、`run-i2-interaction.ps1` | 具备真实 `loopback`/`mic`、设备控制权与睡眠权限的 Win11 | 是 | [`i2-real-source-series.md`](i2-real-source-series.md)、[`i2-live-b96b8fe-loopback/`](i2-live-b96b8fe-loopback/)、[`i2-interaction-recovery.md`](i2-interaction-recovery.md)；最近 `loopback` 五轮冻结 P95=1242ms，六段 trace 已重新开启 Gate 0B realtime 模型替换评估；Gate 0B 三个新候选均未保住内容质量，尚未选定替代模型 | 保持 `<1000ms`、`source t0 + 140ms`、Silero 与 4/12 边界；另行登记新模型或识别架构后重跑两来源各五轮，并完成原生拖动、设备移除/Retry、睡眠/唤醒/Retry 与物理麦克风证据 |
| I3 两小时字幕会话 | 实现完成·尚未验收 | `run-i3-live-audio-soak.ps1` | 可连续运行 7,200 秒的 Win11 | 是 | [`i3-live-audio-soak.md`](i3-live-audio-soak.md) 与 [`i3-live-82d56f6-loopback-qualification/report.json`](i3-live-82d56f6-loopback-qualification/report.json)；revision `82d56f64…7939` 的 75 秒资格为 `pass/partial`，31 个首次稳定转写、29 个精修稿、15/15 检查成立 | 由真人完成一次原生拖动后执行 7,200 秒、至少 3,000 个首次稳定转写的正式 soak |
| I4 非音频子门禁 | 实现完成·尚未验收 | `qualify-i4-nonaudio-nsis.ps1` | 无仓库、无 Node、无既有数据的 Win11 标准用户快照 | 否 | [`i4-nonaudio-nsis.md`](i4-nonaudio-nsis.md)；尚无专用机报告 | 在专用快照执行并带回 `pass/partial` 报告 |
| I4 完整干净机发布验收 | 实现完成·尚未验收 | 非音频报告 + `loopback`/`mic` 音频 child + strict summary | 同一专用 Win11 标准用户候选环境 | 是，两个来源互斥顺序执行 | [`i4-audio-release.md`](i4-audio-release.md)；音频 child、strict summary、六项载荷移交包构建器与两套 verifier 入口已实现，尚无专用机报告 | 在专用快照依次执行非音频、`loopback`、`mic`，带回三份 child 后形成严格 summary |
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
