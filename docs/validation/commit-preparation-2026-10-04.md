# 提交整理与异常处理记录 · 2026-10-04

状态：实现完成·尚未验收。用户已授权创建本地提交；实际 push 仍待用户过目最终提交哈希与范围。基线为 `codex/agent-progress` 的 `a591d4f`，远端同名分支为 `b49a940`，原有 23 条未推送提交保留。

依据 [CONTEXT.md](../../CONTEXT.md)、SEM-F14/F23/F24/F38/F41/F43/F44、SEM-T01/T02/T03/T04/T05，以及 J9-CI/J12/J18/J19/J21/J28-FILES/J28-EXPORT/J28-MCP/J29/J30/J31、DB1/DB7、I3/B5。本记录不提升历史规划、确定性旅程或实机验收状态。

## 执行环境与实际命令

本机命令路径中没有 `npm`；使用已配置的依赖运行时 Node v24.19.0 直接执行 package scripts 指向的 TypeScript、Vite、测试 runner 和 electron-builder，没有安装替代工具或修改用户全局设置。以下 `node` 表示该运行时；受限环境无法正常启动的 Electron/子进程检查，经相同输入的沙箱外执行重验。打包内 Electron 为 43.3.0，Node 为 24.18.1。

```text
node node_modules/typescript/bin/tsc -p tsconfig.renderer.json --noEmit
node node_modules/vite/bin/vite.js build
node scripts/build-caption-input-native.js --check
node scripts/build-memory-file-native.js --check
node scripts/run-test-lanes.js all
```

类型检查、生产 renderer 构建和两个原生模块存在性检查均返回 0。本轮没有重新编译 C++；现有记忆原生模块的生成时间晚于当前源码，实际 Win32 句柄旅程与打包 utility probe 另有执行证据。`--check` 本身不证明实际加载。

| 当前验证输入 | 结果 | 执行边界 |
|---|---|---|
| Core | 1163 项成立，0 失败、0 跳过 | 完整 core lane；包括修正后的共享 renderer 测试装载器 |
| Integration | 165 项成立，0 失败、0 跳过 | 完整 integration lane；真实 main/preload/renderer/storage/SQLite/文件 Worker，外部边界受控 |
| Evidence | 248 项成立，0 失败、1 明确跳过 | 完整 evidence lane；I3 报告经原运行器刷新后补验 |
| 记忆文件保存与重启压力回归 | 15/15 轮返回 0 | 每轮包含 write 和 restart；仍保留外部修改、确认、导出与 MCP 路径 |
| 最新产品壳/打包严格 verifier 与样式守卫 | 42/42，返回 0 | 四个既有测试文件；不替代真实打包旅程 |

完整 runner 曾在 evidence 的两项旧 I3 绑定检查处返回 1。修正只刷新报告，随后单独执行完整 evidence lane 得到上述结果；没有重跑已成立且输入未变的 core/integration，也不把整个 `all` 调用写成返回 0。完整 evidence 使用既有 runner 的 `TEST_ARGS` 与 `laneFiles('evidence')` 展开文件，等价命令为：

```text
node --test --experimental-test-isolation=none "test/gate-0b/**/*.test.js" "test/gate-0c/**/*.test.js" "test/validation/**/*.test.js"
```

唯一跳过项为 `nls-native-fallback-qualification.test.js`：未设置 `RUN_NLS_NATIVE_QUALIFICATION=1`，没有宣称真实本地模型降级资格。Node 的 `stripTypeScriptTypes` 实验性提示，以及受控 Electron 的共享 GPU context 提示仍可能出现；各断言和进程退出结果独立核验，未以屏蔽日志替代验证。

## 异常、根因与修正

| 异常与复现 | 定位结果 | 修正及重验 |
|---|---|---|
| 首轮 integration 160/165：布局 GPU 子进程退出、开发入口 localhost `ERR_FAILED` | 同一代码在沙箱外两条旅程 2/2；属于执行环境边界 | 保留原测试及断言，使用真实 Electron 与子进程重验，不计为产品断言成功或失败 |
| Agent Bar 旅程等待超时；沙箱外仍失败 | 专用夹具漏注册 `session-summary-run:list-recoverable` 所属真实 IPC 服务，且资格提示仍匹配旧文案 | 注册真实 `SessionSummaryRunService` 与 IPC，沿用真实存储和发送者校验；按规范匹配“助手模型”提示；定向 1/1，随后纳入完整 integration |
| 个人记忆设置和历史引用旅程各一项失败 | 定位器仍寻找旧“待确认候选”和“查看字幕事件”，与已登记的展示别名不一致 | 改为“待确认记忆”和“查看引用原文”；保留确认持久化、后续历史页、原文引用及零模型调用断言；定向 2/2 |
| 第二轮 integration 164/165，记忆文件 Electron 旅程出现 `EBUSY`；单独连续运行第 3 轮复现 | 夹具在点击保存后立即直接读文件；真实保存仍持 Win32 独占句柄等待 SQLite 提交，并非句柄未释放 | 先等待真实编辑行 `aria-busy=false`、退出编辑且新正文显示，再保留原 UTF-8 新正文包含断言。没有放宽独占锁或自动重试 EBUSY；同一旅程连续 15 轮成立，随后完整 integration 165/165 |
| renderer 旅程出现 circular dependency 的 `then` 警告 | 自定义 CJS 装载器执行 `_compile` 后未设置 `loaded`，已执行模块被 Node 视作未收束模块 | 在执行结束后设置 `mod.loaded=true`；相同 `--trace-warnings` 定向旅程 2/2，该警告消失，随后完整 core/integration 成立 |
| evidence 两项严格拒绝 `historyRendererSha256` 漂移 | 旧 I3 报告绑定了界面修订前的历史 renderer 与产品载荷 | 在 `TZ=UTC` 下使用原生成器重新执行 3600 段/4000 事件/400 精修段合成旅程；未手改哈希、基线或 verifier，完整 evidence 248 项成立、1 明确跳过 |
| 默认几何打包产品壳严格拒绝 `primaryWindowTitleStable=false` | 生产工具条已按规范显示 `Speech-Agent`，夹具仍精确比较旧 `Live Subtitle` | 仅修正夹具期望；保留 strict verifier、生命周期断言与原失败报告。重建测试 ASAR 后 fresh/restart 及两次自然退出绑定成立 |

夹具新增的错误阶段均为代码内静态枚举；错误输出仅保留 `EBUSY/ENOENT/EPERM/EACCES` 闭集码，其余为 `FIXTURE_FAILED`，不回显原始异常、正文、路径或凭据。测试保存/导出的合成内容只存在隔离临时目录；没有保存现场音频。

I3 刷新命令及边界：

```text
TZ=UTC
node scripts/i3-nonaudio-soak.js --segments 3600 --batch-size 100 --report docs/validation/i3-nonaudio-results.json
```

`gateStatus=partial`、`realTwoHourAudioSoak=false`，只证明加速虚拟时间、存储、历史分页/DOM、导出和受控资源界限，不能证明真实音频两小时稳定性。

相关定向命令：

```text
node --test test/integration/personal-memory-electron-journey.test.js
node --trace-warnings --test --experimental-test-isolation=none --test-name-pattern="settings renderer, real preload|Agent renderer, production preload and source IPC" test/integration/personal-memory-question-journey.test.js test/integration/session-experience-journey.test.js
node scripts/run-test-lanes.js focus test/validation/product-shell-window-interaction-report.test.js test/validation/b5-packaging-contract.test.js test/validation/b5-packaged-restart-contract.test.js test/ui/renderer-style-guard.test.js
```

## 当前打包检查

```text
node node_modules/electron-builder/cli.js --config electron-builder.smoke.config.cjs --win dir --x64 --publish never
node scripts/verify-package-layout.js --package-dir .artifacts/packaged-smoke-build/win-unpacked --variant smoke --report .artifacts/commit-preparation-package-layout-2026-10-04-r2.json
node node_modules/electron-builder/cli.js --config scripts/fixtures/personal-memory-package.config.cjs --win dir --x64 --publish never
PERSONAL_MEMORY_PACKAGE_DIR=.artifacts/memory-ui-build/win-unpacked
node --test test/integration/personal-memory-electron-journey.test.js
node scripts/run-packaged-product-shell.js --executable <本轮测试包可执行文件> --artifacts-root <本轮隔离证据目录> --electron-major 43 --window-geometry-profile default
```

最后一条实际使用本轮生成的测试包与 `.artifacts/commit-preparation-product-2026-10-04-r2`；上述占位符仅避免在报告中保留本地绝对路径。两个测试包的构建均返回 0，没有发布或上传。

| 检查 | 当前结果 |
|---|---|
| smoke 布局 | 840 个 ASAR 条目；5 个 sherpa native 文件及 caption/memory 两个 addon 均按要求解包；NLS、YAML、MCP 与个人记忆必需入口存在；无模型张量或音频载荷 |
| 记忆专用 ASAR | 1/1；真实设置点击、SQLite utility、MD 正文权威、应用内/外修改确认、复制/导出、MCP 授权读取/停止、表征配置和重启恢复；重启后 MCP 关闭 |
| 默认几何产品壳 | strict report、utility 原生实际加载、SQLite DB0 17 项、四个 renderer 和存储往返成立；fresh/restart 各自然退出，退出绑定成立 |

最终 smoke 可执行文件 SHA-256：`3473dd2af76218335fba74bb8fc07c9a54b9b7fc4e5e9ab51919c0d774057847`；ASAR：`f1146f4e7ed1e2b6dbf4997c49dea85dc19eaad8efe5ea1be627b85cff837459`。344 个产品载荷文件摘要：`a14fadab4a824c84baa5569a0a8b69688d3ad1613012f3e7c4c45398e5ed5836`。fresh/restart 的报告和退出摘要保存在本地 `qualification-binding.json`，运行身份为 `b5-86025060-93ec-40e1-bec8-2b950d5dbfc1`。

记忆专用测试 ASAR SHA-256：`b045a4f21bd46ea26a4e8795a6005a26a234dfd23caa49550ae1d378044a3163`；可执行文件：`23075251d1398fd1b7f903fe37550ce44dc6c1a089350544858e61b4815211ac`。write/restart 报告只有布尔、受控枚举和哈希。

本轮打包报告保留在本地 `.artifacts/`，继续按忽略规则排除；提交本文与原生成器刷新后的 I3 JSON。未执行 legacy-risk/current-risk 几何配置、NSIS 安装/卸载、干净机、真实模型供给、公网 NLS/表征服务、第三方 MCP 客户端、物理音源、DWM/系统 DPI 或真实音频长稳。测试包不等同于发布安装器。

## 审查与提交范围

用户指定 GPT-6.1 Sol / high 子 agent 负责明确清单暂存和本地提交；主 agent 负责定位、修正、验证与最终审查。另按 `testing-strategy.md` §2 的要求，由 Luna 子 agent 在 commit 前只读复核主要产品改动、迁移/隐私边界和本轮夹具修正，未发现已确认阻断；独立复核不替代主 agent 的执行证据。

新增提交按依赖整理为三组：实现及对应语义/旅程/异常记录；四项未来规划；界面实拍、研究与推送盘点。共享 main、schema、recipe 和预算改动放入同一实现提交，避免构造无法独立工作的中间提交。未来规划保持未实施任务和开放门禁，既有 23 条提交不改写。

`git diff --check` 返回 0；候选文本及原 23 条未推送提交的 patch 未命中所检查的私钥、GitHub/API Token 模式。四份变更 validation JSON 经严格 JSON 解析与字段/路径筛查，未命中正文或绝对路径；模式扫描不能证明不存在任意形态凭据。Markdown 文件相对链接核对未发现失联。29 张实际窗口图和 1 张浏览页图已逐张查看，没有真实字幕、记忆数据或凭据；图片保留历史构建与空状态边界，不冒充当前功能验收。

排除用户字幕原文导出、本地参考附件、`.zcodeignore`、模型、依赖、构建产物、原生二进制、日志及 `.artifacts/`；`.gitignore` 已登记前三类本地文件规则。状态中仅有 mtime/行尾表现而无内容 diff 的 `formal-agent-job-scheduler.js` 不纳入提交，不通过 reset 或覆盖文件清理它。

仍有开放产品与实机门禁，按各 OpenSpec 和既有记录保留；例如历史界面截图中的生成记录持续“正在读取…”现象没有被这组空状态图片验收。当前分支 push 不触发完整 CI；本次本地证据不冒充远端 CI 或产品联合验收。
