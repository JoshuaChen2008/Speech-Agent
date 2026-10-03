# 工具条 reload 最小诊断记录

状态：实现完成·尚未验收。对应 SEM-F22、SEM-F14、SEM-T03、J17。

2026-09-21 初始记录的基线为 `codex/agent-progress` 的 `b49a940`；当时工作区改动未提交、未推送，也未启动远端 CI、正式 release/NSIS 或合并 PR。本地 smoke 包验证另见下表。2026-09-26 复核见下文。
原 [GitHub CI](https://github.com/JoshuaChen2008/Speech-Agent/actions/runs/35504490662) 的 `toolbar reload recovery timed out` 根因仍未确定。

## 2026-09-26 复核结果

远端 run `35504490662` 绑定 revision `b49a940b395942787152809a23a8608a53a690ce`。步骤 `Run four-window product-shell user journey` 的日志给出 `Error: toolbar reload recovery timed out`；可确认该恢复等待报错，但日志没有 renderer/main/layout 分支证据，根因仍未确定。该 revision 的 workflow 命令没有传入 `--toolbar-reload-diagnostic`，所以这次运行不能产出该诊断的阶段快照。workflow 上传了 artifact `qualification-evidence-b49a940b395942787152809a23a8608a53a690ce-35504490662-1`（ID `10602993827`），但 `gh run download` 返回 HTTP 401 `Requires authentication`，本轮无法读取其中内容。

本机按要求先执行 `npm run prepackage:release`，命令返回码为 0；定向测试 48/48 项通过。同一 `npm run test:integration` 在受限 sandbox 的首轮为 64/67，3 项异常涉及 Electron 子进程 GPU/safeStorage 启动及 renderer development entry；按 SEM-T03 口径不将这轮结果算作产品断言结论。在获准的 Windows 子进程环境原样重跑后，integration 返回码为 0，67/67 项通过，确认当前确定性跨模块 integration lane 可复核，但它没有产出目标产品壳 reload 诊断。

随后三种配置的受监督产品壳复跑均以返回码 1 异常退出，supervisor 证据显示 `appReady=true`、`bootstrapComplete=true`，之后 main 以 `breakpoint-0x80000003` 异常退出；6 个 incident 中 5 个为 `chromium-other` 子进程崩溃，另 1 个为 main exit。没有产品报告或 `toolbar-reload-diagnostic.json`；退出证据也没有 build/payload binding、native stack，且 `rootCauseIdentified=false`、`packagedRuntime=false`。这说明启动与 bootstrap 已发生，但不能证明进程实际加载了刚生成的 renderer 产物，也不能确认是否进入 5 秒恢复等待。子进程异常退出与 main breakpoint 之间没有因果证据；这些本机观察不能定位上述远端 run 的根因。

本次环境没有可用的交互式桌面会话，因此未执行 J15a 可见 DWM 矩阵或 I2 `dwm-drag` 实机观察；也没有专用干净 Win11 快照，I4 非音频、`loopback`、`mic` 子报告均未执行。release 安装器布局与 NSIS 生命周期结果见 [`b5-packaging.md`](b5-packaging.md) 的 2026-09-26 记录。当前状态保持「实现完成·尚未验收」；没有提升联合验收或发布验收状态。

## 2026-09-26 后续定位：artifact 已取得，目标超时未复现

本节晚于上节的环境受阻记录。对应 SEM-F22/F14/T03、J17；状态仍为实现完成·尚未验收。没有修改产品代码、5 秒恢复等待或布局接受条件，也没有推送或触发新 CI。指标与哈希见 [`toolbar-reload-investigation-2026-09-26.json`](toolbar-reload-investigation-2026-09-26.json)。

通过 GitHub connector 下载了原 artifact，ZIP SHA-256 为 `be87bb81e9774994a7f76b5594d0a05a2a7db66d749a71323d17b87ed2147caa`，与 GitHub 的 digest 相同；此前 HTTP 401 不再阻止本轮读取。只提取了产品失败报告与退出证据，没有展开整个工作目录：

- 产品报告为 `fail / PRODUCT_SHELL_SMOKE_FAILED`，`crashEventCount=0`。
- 退出证据为 `other-nonzero`，`quitRequested=true`、`willQuitObserved=true`、`cleanIntentObserved=true`。唯一 incident 是主进程非零退出；renderer/utility gone、preload error、unresponsive 和 rejected IPC 计数均为 0，`breakpointObserved=false`。这支持“旅程断言失败后退出”的路径，不能将本机 sandbox 的 GPU 崩溃归因给原 CI；计数为零也不证明所有可能异常都已被观测。
- ZIP 中没有 `toolbar-reload-diagnostic.json`，与原 workflow 未启用诊断一致。旧 artifact 不能补出 renderer/main/layout 分支证据。

原提交 `b49a940` 的等待顺序可进一步收窄问题边界：`isLoading() === false` → 通过真实 preload/IPC 读到更大的工具条布局代次 → 观察到该代次的 `invalidate/fallback` → 等待同代 `acceptReport/source=toolbar`。因此报错到达 `toolbar reload recovery`，表示前面三个等待已经返回。它不等于 renderer 的 `initToolbarLayout()` 已成功，也不证明所有异步布局/字体工作已经结束；旅程自身发起的上下文读取与 renderer 的初始化读取是不同调用。唯一能确定缺少的是 **5 秒内被 probe 观察到的同代有效布局报告**。

本机当前 revision `120430c` 的实际命令与结果：

```powershell
npm run verify:renderer
node scripts/run-supervised-electron.js --entry scripts/product-shell-smoke.js --entry-arg --toolbar-reload-diagnostic --entry-arg --work-dir --entry-arg .artifacts/reload-diagnosis-20260926/host-baseline/work --entry-arg --report --entry-arg .artifacts/reload-diagnosis-20260926/host-baseline/report.json --entry-arg --window-geometry-profile --entry-arg default --report .artifacts/reload-diagnosis-20260926/host-baseline/exit-evidence.json --strict-report
node scripts/verify-toolbar-reload-diagnostic.js .artifacts/reload-diagnosis-20260926/host-baseline/toolbar-reload-diagnostic.json
node scripts/verify-product-shell-report.js .artifacts/reload-diagnosis-20260926/host-baseline/report.json
node scripts/verify-electron-exit-evidence.js .artifacts/reload-diagnosis-20260926/host-baseline/exit-evidence.json
```

构建返回 0。首轮受限 sandbox 的产品壳在 GPU 子进程边界异常退出，没有到达目标断言；随后获准在沙箱外使用独立目录执行上述命令，产品报告为 `pass/partial`，阶段诊断为 `recovered`，supervisor 为 `clean-exit`、0 incident，三个 reader 均返回 0。renderer 已发送，main 已接收并接受目标代次布局，无发送者或布局拒绝。载荷 SHA 为 `e4e0f26678910d75983bee8a3000b988ff24b30d8e2e0f4be70785a5da5214ac`。

另用明确标为临时诊断的 `.artifacts/reload-diagnosis-20260926/repeat-reload.cjs`，在内存中包装原产品壳入口，连续调用原 `completeWindowInteractionLayoutProbe()` 100 次，每轮诊断写独立文件。保留真实四窗/main/preload/renderer/IPC，未改产品源码、可见性、调度、超时或判定；包装只改变重复次数与诊断文件名：

```powershell
node scripts/run-supervised-electron.js --entry .artifacts/reload-diagnosis-20260926/repeat-reload.cjs --entry-arg --toolbar-reload-diagnostic --entry-arg --work-dir --entry-arg .artifacts/reload-diagnosis-20260926/repeat/work --entry-arg --report --entry-arg .artifacts/reload-diagnosis-20260926/repeat/report.json --report .artifacts/reload-diagnosis-20260926/repeat/exit-evidence.json --strict-report
```

结果为 100/100 `recovered`，所有快照经 `validateReport` 验证；拒绝计数与缓冲溢出计数均为 0，应用正常退出。这是同一进程中的重复诊断，不是 100 次独立 CI，也不是原提交的重跑；观测开销可能影响竞态。当前与原提交的工具条上报路径差异为诊断探针，但其它产品模块已有改动，因此不能用当前成功代替旧 revision 的原因证明。

联网核对发现一个需要阶段证据才能验证的具体调度依赖：`queueToolbarLayoutReport()` 的发送只在 rAF 内发生，100ms 补报仍调用同一队列，已有 pending 时还会直接返回；所以它不是独立于 rAF 的恢复通道。Electron [Page visibility 文档](https://www.electronjs.org/docs/latest/api/browser-window#page-visibility) 说明 `backgroundThrottling: false` 的预期，项目已经设置该选项。[Windows hide/rAF 问题 #31016](https://github.com/electron/electron/issues/31016) 与 [隐藏窗口渲染问题 #42378](https://github.com/electron/electron/issues/42378) 提供相关案例，但版本和触发条件不同，不能证明 Electron 43.3.0 的本次 CI 命中了相同问题。没有证据支持直接升级 Electron、增大超时或把 `backgroundThrottling: false` 再加一遍。

下一次应在 Windows hosted runner 执行含现有 `--toolbar-reload-diagnostic` 的 workflow；单纯 rerun 原 run 会继续使用旧 workflow，无法增加该快照。若再次失败，按 `context-valid → queued → raf-ran → sent → report-arrived → sender-accepted → layout-accepted/rejected` 定位最早缺失或拒绝环节，再做单变量实验。本轮没有捕获目标失败，故不提交猜测性修复，不提升 J17、I2 或发布验收状态。

## 实现边界

- 产品壳通过 `--toolbar-reload-diagnostic` 显式启用。renderer/preload 观察初始化、上下文、排队/rAF、去重、原有 100ms 补报及实际发送；main 观察到达、发送者校验、实际布局校验分支与工具条布局代次关系。
- 原恢复等待仍为 5 秒；不新增轮廓报告或恢复重试，不改变窗口可见性、接受规则或回退轮廓。每端最多 128 条记录，截止后的溢出不会改变截止前事实；旧文档和缺失快照不能提供“未发送”的结论。
- 判定截止后只读快照最多等待 1 秒。诊断单独写入 `toolbar-reload-diagnostic.json`，不修改资格报告 schema；读写故障不覆盖原失败，诊断证据缺失的资格命令非零，但已观察到的恢复仍标为 `recovered`。
- 几何、工具条布局代次原值与时刻仅留内存。reader 使用闭集字段和仓库严格 JSON parser，拒绝未知字段、重复键、非法 UTF-8 及矛盾事实。
- smoke package 的 helper allowlist 已同步。2026-09-25 smoke 包布局与默认 fresh/offline restart 旅程已通过；packaged run 未启用工具条 reload 诊断，因此没有打包态 reload 诊断证据，也没有正式 release/NSIS 资格结论。

## 验证结果与未验证范围

当前候选产品载荷 SHA-256：`e4e0f26678910d75983bee8a3000b988ff24b30d8e2e0f4be70785a5da5214ac`（294 个产品载荷文件）。

| 验证 | 实际结果 | 口径 |
|---|---|---|
| `npm run verify:renderer` | exit 0 | TypeScript 检查与 Vite 生产构建 |
| `npm run test:focus -- test/main/window-layout-contract.test.js test/ui/window-layout-ui.test.js test/ui/toolbar-layout-diagnostic-preload.test.js test/validation/toolbar-reload-diagnostic.test.js test/validation/b5-packaging-contract.test.js test/validation/b4-model-product-evidence.test.js` | 48/48 | 工具条布局、诊断 bridge/reader、smoke 包契约定向验证 |
| 完整 `npm test` | core、integration、evidence 三条 lane 均返回码 0；evidence 248 pass、1 skip、0 fail | 受限沙箱的一次 Electron GPU / `safeStorage` 启动失败后，在获准的 Windows 子进程环境重跑；无实机或付费 provider 结论 |
| I3 非音频派生报告 | 原 runner 重建，`result=pass`、`gateStatus=partial` | 原报告因产品载荷哈希过期被严格 reader 拒绝；使用 `TZ=UTC node scripts/i3-nonaudio-soak.js --segments 3600 --batch-size 100 --report docs/validation/i3-nonaudio-results.json` 重建，没有手改哈希，不证明真实音频或两小时实机运行 |
| 2026-09-25 本地候选四窗产品壳 | `default` 1/1、`legacy-risk` 1/1、`current-risk` 3/3 均为 `pass/partial`；五次 supervisor 退出均为 `clean-exit` 且 0 incident | 当时每份诊断均通过严格 reader；产品报告、诊断与 supervisor 退出证据交叉核对；五份报告都绑定上述候选载荷 SHA |
| 2026-09-25 smoke 包 | 构建返回码 0；布局 `pass`，608 个 ASAR 条目、5 个原生二进制；默认配置 fresh 与离线 restart 均 `pass` / `clean-exit` | 这是测试包确定性证据，不是 NSIS、干净机、I4 或发布验收 |
| 截至 2026-09-25 的历史 `current-risk` 轮廓失败 | 三次复跑均未复现 | 早轮失败发生在 reload 之前，不能据此归因原 CI reload 超时，也不能由当时重跑成功推断该间歇性失败的根因已经确定 |

截至 2026-09-25 的记录中，三种四窗配置已执行真实 reload 旅程并取得绑定证据；2026-09-26 的新一轮受监督复跑没有产生产品报告或阶段诊断，因此不能把此前结果外推为本轮旅程证据。原远端 CI 超时与早轮前置断言失败的根因仍未确定。状态保持「实现完成·尚未验收」；J17 可见 DWM、I2/I3/I4 与发布验收边界均未改变。

## 脱敏诊断样例

以下为早轮真实 `default` 诊断的字段摘录，展示证据形式；它不是完整 reader 输入，也不是当前载荷验收报告。早轮完整文件保留在本地 `.artifacts/toolbar-reload-diagnostic-20260921-default-host/`。

```json
{
  "kind": "toolbar-reload-diagnostic",
  "gateStatus": "diagnostic-only",
  "productPayloadSha256": "3ecd77f616be4bd2b3da23cd551f0313641780eb1a5817ce767b2ce1a54e89cf",
  "outcome": "recovered",
  "phase": "recovery",
  "recoveryTimeoutMs": 5000,
  "facts": {
    "rendererSentObserved": true,
    "mainReceivedObserved": true,
    "senderRejectedObserved": false,
    "layoutRejectedObserved": false,
    "generationMismatchObserved": false,
    "targetLayoutAcceptedObserved": true
  }
}
```

Luna/max 已执行分轮只读语义核对；第一轮指出的诊断异常隔离、非法代次分类和截止后溢出问题已修正并加入负向测试。第一轮复核确认三项均已消除；第二轮最终复核未发现未解决的必须修复项。2026-09-25 表格所列的同一候选载荷已取得绑定四窗 reload 旅程证据；2026-09-26 复跑没有生成可核验产品报告或阶段诊断。远端 run 根因、J15a/I2 实机和 I4/发布边界仍未闭合，不提升联合验收状态。
