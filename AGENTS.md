# AGENTS.md · 改动前必读的路由表

本仓库的文档树全部读完约 11 万 token，超过半个上下文窗口。**不要整读。**
先读完本文（约 2k token），再按第 4 节路由表只取你这次改动需要的部分。

---

## 1. 项目一句话

Win11 本地实时字幕系统：Electron 多窗口 + sherpa-onnx 本地 ASR + SQLite 字幕历史。
Agent 系统（摘要、增强文本）是**后置的可选系统**，尚未实现。
**字幕系统必须能在 Agent 完全不存在时独立完整工作。**

---

## 2. 七条硬规矩（违反即返工）

1. **术语必须查**（SEM-T05 / 语义合同 §3.5）。**每次改动都要读 `CONTEXT.md` 全文，没有例外。** 语义表需要反复 review 核查，而核查的前提是用词与 `CONTEXT.md` 的规范定义逐字对齐。写需求、写测试名、写提交信息、写报告字段前都要对照一遍；禁止自造术语，也禁止使用"本地声音""最终字幕""双路模式""录音回放"这类已被明确列为避免使用的说法。发现现有代码或文档用词与 `CONTEXT.md` 冲突时，先记录为缺口，不要顺着现状继续用。
2. **先登记后实现**（SEM-T06）。新增功能或改变语义，必须先在 `docs/semantic-contract.md` 语义表和 `docs/testing-strategy.md` 旅程矩阵登记，再动代码。不接受"先实现完再补需求"。
3. **状态词受限**（SEM-T05）。只允许「已决定 / 实现完成·尚未验收 / 联合验收完成 / 实机验收完成 / 发布验收完成」。禁止无修饰的"完成""可用""测试通过"。
4. **永不保存现场音频**（SEM-F14）。PCM、WAV、录音片段、音频文件路径都不得写入数据库、日志、导出、报告、测试产物或模型目录。有界内存缓冲用完即释放。
5. **单路互斥**（SEM-F02）。一个会话只能是 `mic` 或 `loopback`，运行中不得并发或直接切换来源；换源必须先停止并新建会话。
6. **报告只写指标与哈希**（SEM-F14）。`.artifacts/` 与 `docs/validation/` 下的任何 JSON 都不得含字幕正文、本地绝对路径、设备名、绝对单调时刻或时钟偏移。
7. **单测不等于完成**（SEM-T01/T02）。一项用户能力必须有至少一条跨模块用户旅程；替身只允许出现在声卡、网络、系统权限、云 provider 这些不可确定的外部边界，产品内部模块一律用真实实现。

---

## 3. 文档职责与冲突优先级

| 文档 | 唯一职责 | 什么时候读 |
|---|---|---|
| `docs/semantic-contract.md` | **要求、测试边界、完成口径的唯一权威** | 每次改动，只读相关 SEM 行 |
| `CONTEXT.md` | **规范术语定义（语义核查的基准）** | **每次改动必读全文，不可跳过** |
| `docs/testing-strategy.md` | 测试分层、旅程 ID、当前证据 | 每次改动，只读相关 J 行 + §2 分层表 |
| `docs/data-architecture.md` | SQLite 事实、投影、迁移约束 | 只在动存储时 |
| `docs/runtime-architecture.md` | 运行时职责、状态机、契约、生命周期 | 只在动运行时/契约时 |
| `docs/subtitle-window.md` | 窗口几何、拖动穿透、渲染不变量 | 只在动窗口/字幕 UI 时 |
| `docs/subtitle-flow-and-transcript-versions.md` | 固定高度字幕流与版本隔离设计 | 只在动字幕排版或转写版本时 |
| `docs/adr/` | 已接受的架构决策 | 与现状冲突时以 ADR 为准 |
| `PLAN.md` | 排期与历史叙述，**不定义语义** | 默认跳过 |
| `README.md` | 运行方式与结构总览 | 只在需要跑起来时 |
| `docs/claude-handoff.md` | 历史交接快照，内容已部分过时 | 默认跳过 |

**冲突时**：`semantic-contract.md` > `adr/` > 其它文档 > 代码现状。
PLAN 或 README 落后于语义合同时，以语义合同为准，并把差异记录为实现缺口——不要用现状改写要求。

---

## 4. 路由表

> **下表每一行的"必读"都隐含包含 `CONTEXT.md` 全文。** 术语是语义表反复核查的基准，任何改动都不得跳过它；"明确跳过"一列永远不包含 `CONTEXT.md`。

| 改动类型 | 必读（本文 + `CONTEXT.md` + 以下） | 主要代码 | 明确跳过 |
|---|---|---|---|
| **字幕窗显示 / 排版 / 溢出** | SEM-F03/F04/F11/F20 四行；`subtitle-flow-and-transcript-versions.md` 全文（6KB）；`subtitle-window.md` §3 §5 §6；testing-strategy 的 J15 行 | `src/caption/*`、`src/ui/shared/caption-reducer.js`、`appearance.js`、`tokens.css`（只看 `--fs` `--lh-caption` `--line-gap` `--fs-caption-ratio-prev`）、`src/preload/caption.js` | PLAN、handoff、data-architecture、runtime-architecture |
| **字幕事件 / 状态契约** | SEM-F03/F04/F06；`runtime-architecture.md` §6 | `src/contracts/caption-event.js`、`caption-state.js`、`src/contracts/fixtures/` | PLAN、README、UI 文档 |
| **存储 / 投影 / 历史 / 导出** | SEM-F07/F11/T08；`data-architecture.md` §3 §4 §5 §6；ADR 0001；testing-strategy 的 J10 行 | `src/runtime/storage-worker/{schema,subtitle-store,protocol,worker-service}.js`、`storage-gateway.js`、`sqlite-session-recorder.js`、`history-service.js`、`src/history/history.js` | subtitle-window、ui-design-brief |
| **会话状态 / 暂停恢复 / 崩溃恢复** | SEM-F06/F12；`runtime-architecture.md` §4 §8 | `session-coordinator.js`、`subtitle-application-runtime.js`、`power-session-guard.js` | 存储 schema、UI 文档 |
| **音频采集 / 实时 ASR / 精修** | SEM-F01/F12/F14；`runtime-architecture.md` §5 §9 | `src/runtime/audio-host/*`、`realtime-worker/*`、`refine-worker/*` | 历史导出、打包文档 |
| **模型资源 / 下载 / 就绪判定** | SEM-F17/T11；testing-strategy 的 J14 行 | `model-manager.js`、`model-manifest.js`、`model-resolver.js`、`model-runtime.js`、`src/settings/*` | 字幕排版、存储 |
| **窗口几何 / 拖动 / 拉伸 / 穿透** | `subtitle-window.md` §3 §4 §5；SEM-F20 | `src/main.js` 的 `CAP_LIMITS` / `dock` / `dragTick` / `resizeTick` | 存储、模型、契约 |
| **打包 / 安装器** | SEM-F18/F19/T12 | `electron-builder*.cjs`、`scripts/verify-package-layout.js`、`qualify-nsis-lifecycle.js` | 字幕与存储实现细节 |
| **CI / 测试分层** | testing-strategy §2 执行分层表；SEM-T03 | `.github/workflows/ci.yml`、`test/validation/test-lanes-contract.test.js`、`package.json` 的 scripts | 全部产品设计文档 |
| **纯文案 / 颜色 / 图标** | `docs/ui-design-brief.md` §2.3 token 分层 + §2.6 视觉不变量与禁止项 | `src/ui/shared/tokens.css`（语义层）、对应 `.css` / `.html`；改完跑 `node --test test/ui/renderer-style-guard.test.js` | 其余全部 |

---

## 5. 测试与运行

```bash
npm run test:core         # contracts/main/runtime/storage/ui，最快，先跑这条
npm run test:integration  # 跨模块确定性旅程
npm run test:evidence     # gate/validation/证据回归（含约 7 秒 I3 预资格）
npm test                  # 三条 lane 依次执行
npm start                 # 受监督启动完整应用
```

- **新增测试必须落在既有三个 lane 的目录内**（`test/{contracts,main,runtime,storage,ui,integration,gate-0b,gate-0c,validation}`）。新建其它目录会让 `test-lanes-contract.test.js` 直接变红，因为 lane 目录是硬编码的。
- Windows 的 `tar.exe` 与 Electron 子进程在受限沙箱内可能被 `EPERM` 拒绝。**这是执行环境问题，不得计作产品断言失败或通过。**
- 托管 CI 不证明真实声卡、物理麦克风、DWM 窗口行为、模型性能、交互安装或干净机（SEM-T03）。这些结论只能来自实机报告。

---

## 6. 本仓库最容易踩的坑

1. **`segments.text` 会被精修结果覆盖。** 首次 `final` 的原文靠 `segments.first_event_order` 指针回到 `caption_events` 取。改插入逻辑前先确认这条不变量仍成立。
2. **schema migration checksum 是 fail-closed。** 直接改 `INITIAL_SCHEMA_SQL` 会让所有既有数据库拒绝打开。要加表加列必须新增 migration 版本，并接受既有库全部执行升级。
3. **`history-service` 的入参是 `exactObject` 白名单。** 多传一个字段直接抛错；扩展接口要同步改 IPC access policy、preload 和 renderer 四处。
4. **改导出或迁移语义时，既有测试可能仍然全绿**——它们校验的是折叠后的单一投影。必须先写一条会红的测试，再改实现。
5. **caption renderer 的顶层常量不能叫 `shell`。** preload 的 contextBridge 已占用该全局名，同名 `const` 会 SyntaxError 导致整个 renderer 白屏。
6. **调试信息也不能写正文或路径进报告**（SEM-F14）。需要证明内容一致时写布尔或摘要哈希。
7. **`refined` / `translated` 事件不得开启新字幕段。** 目标段已被淘汰时直接忽略，主进程 `foldCaptionState` 与 renderer reducer 必须保持同一规则。

---

## 7. 提交前自检

- [ ] 需求、测试名、提交信息与报告字段的用词已逐条对照 `CONTEXT.md` 核查，无自造术语与被禁用说法
- [ ] 引用了至少一个 `SEM-*` 和一个 `J* / DB* / I*` gate
- [ ] 状态词符合第 2 节第 3 条
- [ ] 新增或变更的能力已在语义表与旅程矩阵登记
- [ ] 没有新增音频产物、音频路径，也没有 SQLite/JSONL 双写
- [ ] 失败路径至少覆盖一条（SEM-T04），核心能力 fail closed 或显式降级
- [ ] `npm test` 三条 lane 全通过
