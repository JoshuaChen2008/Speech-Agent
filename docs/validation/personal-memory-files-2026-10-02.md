# 用户掌控个人记忆交付记录 · 2026-10-02

状态：**实现完成·尚未验收**。依据 SEM-F41/F42、SEM-F14/T01/T02/T03/T04/T06、ADR0025；旅程 J21/J28-FILES、J22/J24-RETRIEVAL、J29/J30/J12、DB1/DB7/J10。[操作指南](../personal-memory-guide.md)与[已决定方案](../user-controlled-personal-memory-proposal.md)保持同一边界。

## 实际改动

- 已确认个人记忆以 Markdown 为正文权威；支持自选目录、外部编辑、无元数据文件核对、未知 YAML 字段与注释保留。正文2048 UTF-8字节、文件64 KiB，超限拒绝。根内移动不新增来源，外部消费内容变化、重复 ID、损坏、失联立即退出读取。
- SQLite catalog 追加 v29–v32，原 v1–v28 SQL/checksum 保持不变。保存确认、来源、修订身份、休眠、忘记、删除、suppression、操作恢复与待清理回执；迁移保留既有修订与会话关联，中断后的空文件占位经独占核验可重试，其它已有字节不覆盖。已切换条目正文及旧正文修订不回读。候选与会话经历记录仍沿既有 SQLite 事实。
- 应用内保存经独立文件 Worker 持有真实 Win32 独占句柄，核对并刷新文件后提交 SQLite。覆盖目标、旧内容、未知部分内容及缺失文件的恢复，未知内容须用户明确选择；锁竞争保留草稿。删除先撤销，按字节摘要清理；文件变更不被重试覆盖或删除。
- resolve@2 与新建 `qa.answer@5` 统一精确字段/别名、FTS5/BM25/中文短词及本地 Float32 向量，RRF常数60。两路在排名前使用同一范围，日期按会话开始时刻过滤；不跨项目/会话、旧修订或撤销边界。旧工具与旧 recipe 保留原解释。
- 表征连接、模型、披露与凭据独立；默认关闭，HTTPS exact origin、拒绝 redirect。批次≤16条/32 KiB，单并发、30秒/次、最多3次尝试；查询3秒期限，失败显式降级关键词。取消、模型或正文变化拒绝迟到写入；重建只改变派生数据。
- 正式设置 renderer/preload/main 已接通目录、确认、迁移、恢复、清理、治理携带、独立表征配置及重建/取消。外部修订及确认通知会刷新个人上下文列表。总结参考关闭排除请求触发的文件/表征读取；独立后台文件监听不被误算为总结读取。
- 治理携带不含正文、凭据或绝对路径，4 MiB有界读取，导入不自动确认外来文件；来源不匹配标为缺失。禁止把携带 JSON 写入 `.artifacts/` 或 `docs/validation/`，这两处只写证据。

## 当前工作树验证

| 命令或范围 | 实际结果 |
|---|---|
| `npm run verify:renderer` | renderer 类型检查与生产构建返回码0 |
| `npm run --ignore-scripts test:core` | 1162/1162，0失败、0跳过 |
| `npm run --ignore-scripts test:integration` | 159/160；唯一失败为 J18 的 localhost Vite renderer `ERR_FAILED`，仓库2026-09-28已有同类记录 |
| `npm run --ignore-scripts test:evidence` | 248通过、1按设计跳过，0失败；新增原生模块 allowlist 与加载检查已更新 |
| 记忆文件专属测试 | 18项，包含真实文件/SQLite/Win32锁、崩溃恢复、迁移、外来来源、范围过滤、非合作provider、取消、迟到修订及正式 Electron 设置/重启旅程 |
| `TZ=UTC node scripts/i3-nonaudio-soak.js --segments 3600 --batch-size 100 --report docs/validation/i3-nonaudio-results.json` | `result=pass`、`gateStatus=partial`；源码与当前产品载荷身份重建，非音频预资格保持原限定 |
| `npm run package:smoke:prepared` 与 `verify-package-layout.js --variant smoke` | 构建与包布局检查返回码0；记忆原生模块及YAML依赖入包，原生模块按ASAR unpack保存 |
| 记忆文件专用打包旅程 | 1/1，内部含写入与重启两阶段；实际ASAR中的生产main/renderer/preload、SQLite utility process、文件Worker与Win32原生模块完成新增、应用内修改、外部确认、目录选择、独立表征配置、索引发布及重启恢复 |

三条 lane 共用一次生产 renderer 构建；因既有 J18 失败，逐 lane 执行以继续核对 evidence。打包检查不等于安装器、干净机或发布验收；本记录不提升旧证据状态。

专用打包旅程可重现：先执行 `node_modules/.bin/electron-builder.cmd --config scripts/fixtures/personal-memory-package.config.cjs --win dir --x64 --publish never`；再在PowerShell设置 `$env:PERSONAL_MEMORY_PACKAGE_DIR = '.artifacts/memory-ui-build/win-unpacked'`，执行 `npm run test:focus -- test/integration/personal-memory-electron-journey.test.js`。该包仅替换测试入口并使用临时userData；不会充当发布候选。`.artifacts/memory-packaged-write.json` 与 `memory-packaged-restart.json` 只保存布尔事实、枚举与ASAR/可执行文件哈希。构造真实原有SQLite关联作为迁移起点，内部存储与文件模块均未替换。

## 收益与质量边界

固定100条带标签合成查询：80条有答案、20条无答案，16条正文。真实存储、词法召回、向量排名与RRF运行；网络边界为受控查表provider，17维向量。报告只含指标、枚举、布尔值、相对耗时及哈希：[检索报告](personal-memory-synthetic-retrieval-2026-10-02.json)。

| 算法 | Recall@10 | nDCG@10 | 无答案误召回率 |
|---|---:|---:|---:|
| 关键词 | 0.4125 | 0.3869 | 0 |
| 受控向量 | 1.0000 | 1.0000 | 0 |
| RRF | 1.0000 | 0.9954 | 0 |

这些数据证明融合及有效集合过滤实现，不能说明真实云端模型的召回收益。未取得真实云端凭据，未执行独立人工标注与保留验证集、目标设备资源预算、真实外部编辑器/权限组合或完整安装发布资格；上述边界仍待验收，云端表征保持默认关闭。字幕独立性通过真实SQLite写入/历史路径和非合作provider并行旅程核对，不代表物理音源、ASR性能或实机长稳证据。
