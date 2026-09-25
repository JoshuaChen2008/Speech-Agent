# 工具条 reload 最小诊断记录

状态：实现完成·尚未验收。对应 SEM-F22、SEM-F14、SEM-T03、J17。

基线为 `codex/agent-progress` 的 `b49a940`；本轮工作区改动未提交、未推送；未启动远端 CI、正式 release/NSIS 或合并 PR。本地 smoke 包验证另见下表。
原 [GitHub CI](https://github.com/JoshuaChen2008/Speech-Agent/actions/runs/35504490662) 的 `toolbar reload recovery timed out` 根因仍未确定。

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
| 当前候选四窗产品壳 | `default` 1/1、`legacy-risk` 1/1、`current-risk` 3/3 均为 `pass/partial`；五次 supervisor 退出均为 `clean-exit` 且 0 incident | 每份诊断均通过严格 reader；产品报告、诊断与 supervisor 退出证据交叉核对；五份报告都绑定上述当前候选载荷 SHA |
| 当前候选 smoke 包 | 构建返回码 0；布局 `pass`，608 个 ASAR 条目、5 个原生二进制；默认配置 fresh 与离线 restart 均 `pass` / `clean-exit` | 这是测试包确定性证据，不是 NSIS、干净机、I4 或发布验收 |
| 历史 `current-risk` 轮廓失败 | 本轮三次均未复现 | 早轮失败发生在 reload 之前，不能据此归因原 CI reload 超时，也不能由当前重跑成功推断该间歇性失败的根因已经确定 |

当前候选三种四窗配置均已执行真实 reload 旅程并取得绑定证据；原远端 CI 超时及早轮前置断言失败的根因仍未确定。以上记录仅确认当前候选在本地验证范围内通过，状态仍为「实现完成·尚未验收」；不提升 J17 的实机 DWM、I2/I3/I4 或发布验收状态。

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

Luna/max 已执行分轮只读语义核对；第一轮指出的诊断异常隔离、非法代次分类和截止后溢出问题已修正并加入负向测试。第一轮复核确认三项均已消除；第二轮最终复核未发现未解决的必须修复项。两轮均保留当前载荷真实四窗 reload 未验证、远端与实机未重验的边界，不提升联合验收状态。
