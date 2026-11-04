# 2026-10-26 CI 阻塞定位与夹具修复

状态：**实现完成·尚未验收**。关联 SEM-F14/F23/F41/F42、SEM-T02/T03/T04，以及 J9-CI/I3/J18/J21/J22-QUALITY/J24-RETRIEVAL/J28-FILES/DB7。基点为 `ffc69f71e75bb8e7b4f915822d6302817d400e8d`，Node 为22.22.2；本轮没有修改 `src/` 产品源码。

## 远端实际失败

[CI run 40206893559](https://github.com/JoshuaChen2008/Speech-Agent/actions/runs/40206893559) 的 attempt 1 在 Integration 为197/198，个人记忆 Electron 旅程约2064ms后以 `choose-root: FIXTURE_FAILED` 退出。attempt 2 同代码 Integration 为198/198，Evidence 为246项符合预期、2项失败、1项按设计跳过，两项错误均为 `I3 non-audio provenance drifted for productPayloadSha256`。最终索引按设计未生成。两次执行均不构成当前修复的远端验收。

## 缺陷类别与最小修复

- 异步动作的中间存储状态被当作界面动作回执。通用规则是：下一次用户动作须满足前一个动作实际发布的界面前置条件。确认保存先提交SQLite，再释放文件Worker资源、重新扫描与刷新；列表已为`ready`时，renderer仍可能`aria-busy=true`，目录按钮仍禁用。夹具在单次点击前增加现有`aria-busy=false`等待，不增加重试或固定休眠。
- 当前产品载荷与旧资格报告混用。通用规则是：严格证据只能绑定实际执行载荷。只在内存中把`src/main.js`与`src/main/window-layout-contract.js`换回父提交`22ab81e`字节，载荷摘要便精确恢复到旧报告；因此用原生成器重跑，未修改verifier或手工替换哈希。
- 缩放后的浮点坐标差异被当作可观察页面溢出。通用规则是：边界比较先使用相同坐标精度，并保留用户可观察的滚动约束。生成记录右边界按`devicePixelRatio`投影到同一像素栅格，页面滚动宽度仍不得超过视口；同一renderer注入1px越界验证仍能拒绝。
- 每次运行指标覆盖受跟踪历史证据。通用规则是：常规旅程运行产物与受跟踪历史证据分别写入明确位置。检索质量旅程改写`.artifacts/personal-memory-synthetic-retrieval.json`，并在同一旅程中验证历史报告字节未变；最终索引的干净工作树检查不放宽。

产品契约、SQLite迁移、确认授权、来源、摘要算法、GPU启动参数与超时均保持原样。数据结构没有增加字段或选项；变化为证据重新生成、几何比较单位与每次运行报告的写入位置。测试辅助入口只延迟实际`fs.rm`调用，不替换内部产品响应，生产模块仍为真实实现。

## 原错误反馈

诊断在真实文件Worker的外部清理边界，延迟不存在的`.old`材料删除800ms，仍执行原OS调用。诊断观察到目录按钮存在、禁用、pane为busy，目录对话框调用为零；原始完整夹具3/3出现同一`choose-root`错误，增加界面回执等待后3/3符合预期。GPU共享上下文错误同时出现在红、绿对照，因此不足以证明因果。原远端日志丢失底层异常，不能唯一归因那一次事件。

保留在既有Electron旅程中的回归再次验证：未修复夹具在约2539ms退出，错误精确为`MEMORY_FILES_ELECTRON_JOURNEY_FAILED: choose-root: FIXTURE_FAILED`；修复后含写入和重启的旅程为1/1，约4746ms，退出码0。父测试要求固定延迟标记实际出现，避免未触发故障条件却得到绿色结果。临时诊断脚本与私有数据已清理，回归辅助入口留在`test/integration/helpers/`。

## 实际命令与结果

| 命令 | 实际结果 |
|---|---|
| `npm run verify:renderer` | 类型检查与生产bundle构建退出0 |
| `npm run test:focus -- test/validation/i3-nonaudio-soak.test.js`（修复前） | 1项符合预期，2项因同一产品载荷漂移失败，退出1 |
| `TZ=UTC node scripts/i3-nonaudio-soak.js --segments 3600 --batch-size 100 --report docs/validation/i3-nonaudio-results.json` | 原生成器退出0，`result=pass`、`gateStatus=partial` |
| `node scripts/verify-i3-nonaudio-report.js docs/validation/i3-nonaudio-results.json` | 严格校验退出0 |
| `npm run test:focus -- test/integration/agent-layout-journey.test.js` | 修复前125%缩放以0.000045776px边界差异退出1，页面scrollWidth与innerWidth同为576；修复后1/1，且每个主题/尺寸/缩放组合均验证1px注入可检出 |
| `npm run test:focus -- test/integration/personal-memory-retrieval-quality.test.js` | 修复前新增字节不变断言以`quality journey must not rewrite tracked evidence`失败，失败钩子未收尾的该次进程被停止；改写产物位置后1/1、正常退出0 |
| `npm run test:focus -- test/integration/personal-memory-electron-journey.test.js` | 外部清理延迟下未修复为0/1、原错误；修复后1/1、退出0 |
| `node --test --experimental-test-isolation=none "test/contracts/**/*.test.js" "test/main/**/*.test.js" "test/runtime/**/*.test.js" "test/storage/**/*.test.js" "test/ui/**/*.test.js"` | Core 1227/1227，0失败，退出0；后续只有测试夹具与证据登记改动，复用该结果 |
| `node --test --experimental-test-isolation=none "test/integration/**/*.test.js"` | 最终夹具含记忆竞态回归，Integration 198/198，0失败，退出0 |
| `node --test --experimental-test-isolation=none "test/gate-0b/**/*.test.js" "test/gate-0c/**/*.test.js" "test/validation/**/*.test.js"` | 最终Evidence 248项符合预期、1项按设计跳过、0失败，退出0 |
| `git diff --check` | 退出0 |

常规运行中检索历史报告曾被原旅程刷新耗时；保留本轮实际指标，语料/策略、100条查询、16条文档、17维向量及质量指标不变。写入位置修复后，全量旅程运行前后该受跟踪报告SHA-256均为`cf6da48ae3774a91b266df3aab2a2e76e30439ebbc76b53f6bc728b681e82887`。

I3的3600段、4000个字幕事件、400段精修、72页与三种导出字节摘要均保持不变；新产品载荷SHA-256为`19938516f3f4b3097b51aa8edd78c22748d804c25b4614b405876b95364a633a`。从GitHub下载attempt 2的资格artifact（ID `12604944122`，GitHub记录ZIP digest=`918b5fde7bcf869628fefc21c80a2642438014544a2901960beabdad5791700e`）后，默认、legacy-risk、current-risk三份打包运行绑定均为同一359文件载荷，与当前报告精确一致；默认运行绑定strict reader退出0。下载在独立空目录内完成，下载内容未作为脚本执行；这只用于证明载荷差异，不冒充新修订CI验收。

## 同类位置检查与处置

本轮使用仓库搜索工具，以下为可复现的等价搜索：

| 搜索 | 命中与处置 |
|---|---|
| `rg -n 'await click|await until|fixtureStage' scripts/fixtures/personal-memory-electron-journey.js` | 保存修改、根目录切换、语义搜索配置已有界面动作回执等待；确认后选目录缺少同一前置条件，已修复；其它读取仍保留相应内容/按钮条件 |
| `rg -n 'right[^\n]*(innerWidth|clientWidth)|rightOverflow' scripts test` | 同一布局夹具的生成记录边界改用设备像素栅格；关闭控件有标题栏内边距，不是贴边浮点比较；页面滚动宽度仍严格检查 |
| `rg -n 'writeFileSync|docs/validation|\.artifacts' test/integration/personal-memory-retrieval-quality.test.js` | 唯一历史报告写回点改到忽略目录，历史报告只读核对 |
| `rg -l '"productPayloadSha256"' docs/validation -g '*.json'` | I3非音频报告要求当前载荷，已重跑；B5四份报告按相互绑定的历史证据校验；历史音频I3资格明确拒绝当前候选；J27、总结检索与工具条历史诊断保留原身份，未伪造刷新 |
| `rg -l 'readAndValidateI3NonAudioReport|validateI3NonAudioReport|i3-nonaudio-results.json' scripts test -g '*.js'` | 原生成器/verifier、I3旅程与无人值守入口消费同一结构；严格规则不变 |

最小设计复核逐行覆盖本轮全部10个改动文件；产品源码净变化0行，夹具/旅程净增41行（含26行外部清理延迟回归入口），语义/旅程登记净增26行，两个JSON证据净变化0行，验证记录另行保留本轮过程。新增内容用于原错误的确定性故障注入、像素越界负例及历史证据不变断言；没有新增产品选项、兼容路径、重试或第二套实现。

## 未验收边界

个人记忆ASAR使用`npx electron-builder --config scripts/fixtures/personal-memory-package.config.cjs --win dir --x64 --publish never`重建退出0；随后`PERSONAL_MEMORY_PACKAGE_DIR=.artifacts/memory-ui-build/win-unpacked npm run test:focus -- test/integration/personal-memory-electron-journey.test.js`得到1/1，约6987ms，写入与重启均使用同一打包产物并正常退出0。两阶段记录的ASAR SHA-256均为`263a7d4ea66b05bd401d6ec92aa00f7bce4f14986ec7e2b183b032bdfff110f4`、executable SHA-256均为`4cef797ff8514234f92712a48b9ea87a287700fcb67f45a654771006e140ee38`。该测试包不等同于正式安装器或新修订完整Windows CI。

当前修订尚未提交、推送或取得新的远端CI资格索引；不能把本地三条lane结果或旧run的成功步骤标记为新修订J9-CI联合验收完成。真实公网模型质量、现场音频、物理麦克风、DWM/系统DPI、两小时音频与干净机均不在本轮证据中。

桌面应用早先的`bind_pr`调用曾被自动审批拒绝，未提供更具体原因，未通过其它工具绕开该拒绝。用户随后明确授权本轮10个文件提交推送到当前分支、关联现有PR并继续远端CI验收；重新关联[现有PR](https://github.com/JoshuaChen2008/Speech-Agent/pull/1)已获准，提交前状态仍为实现完成·尚未验收。
