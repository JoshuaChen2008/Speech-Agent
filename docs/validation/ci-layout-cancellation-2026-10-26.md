# 2026-10-26 CI 布局负例与取消反馈修复

状态：**实现完成·尚未验收**。关联 SEM-F14/F23/F38/F40/F41、SEM-T03/T04；J9-CI/I3/J18/J21/J22/J25/J30-CANCEL/J30-ELECTRON。基点为 `005410ea5233af038acbf733547f93e75a986485`，Node 为22.22.2。本记录只覆盖本轮差异，早一轮证据保留在 [CI 阻塞记录](ci-regression-2026-10-26.md)。

## 原始失败与根因

[CI run 40269246011](https://github.com/JoshuaChen2008/Speech-Agent/actions/runs/40269246011) 的 Core 为1227/1227、Integration 为196/198。两项错误分别是布局负例 `one CSS pixel of overflow must be detected` 与正式设置旅程 `unconfirmed cancellation renderer state timed out`；产品壳、ASAR、NSIS机械旅程已有该修订的成功结果，不替代新修订资格。

- **布局负例前置条件错误**：分数视口中，把面板平移1 CSS px并不等于相对整数 `innerWidth` 越界1 CSS px。强制设备缩放1.25、既有520×420场景，`innerWidth=522`，面板右边界从521.600006移至522.600006，设备像素栅格差从−1变为0。原夹具退出1；按实测右边界推导位移至 `innerWidth + 1` 后，同场景退出0。新增注入到位检查；原像素栅格、页面滚动宽度及16个主题/尺寸/renderer缩放组合均保留，另以系统设备缩放和1.25两个串行场景执行。
- **取消错误与快照读取错误混用**：真实SQLite触发器拒绝取消写入后，回读仍为 `running`，请求卡片仍存在；成功回读清除了卡片错误，资格刷新又清除了公共状态。缩短前置的真实Electron探针两次命中 `nonterminal refresh cleared unconfirmed cancellation`，第二次同时观察到权威状态非终态与两处提示均消失。第一次子进程退出0却缺少成功报告，仍记录为失败；后续运行器同时要求退出0与成功报告。
- **动作回执前置条件不足**：完整设置旅程曾在更早的 `re-enable confirmation timed out` 失败，未到取消断言。生产设置先发布暂停状态，后收束在途命令并解除开关禁用；夹具改为同时等待已暂停与解除禁用，再单次点击。该失败保留，不计为取消缺陷的红证据。

取消修复将单一错误字符串中混合的两种生命周期分开：保留原快照读取错误，增加一个绑定请求身份及generation的界面内取消错误。非终态快照校准不清除它；权威终态、已登记取消及其它身份不展示旧提示。成功和失败取消回执均核对当前请求身份，过期回执只释放自身锁。没有新增IPC、持久化字段、产品配置、重试、超时或测试专用产品入口。

## 实际验证

| 命令或反馈环 | 结果与范围 |
|---|---|
| `TZ=UTC node --test --test-name-pattern='formal settings, Agent Bar summary' test/integration/agent-redesign-j25-formal-settings-journey.test.js` | 原旅程基线1/1；加入刷新断言后的首次运行0/1，停在更早的重新开启确认；不能作为取消红证据 |
| 隔离userData、既有 `configureRecoveryModel` 加 `verifyOperationControls` 的真实Electron临时探针 | 修复前两次命中非终态刷新清除提示；修复后成功报告的7个控制指标全部为true、退出0。探针分支及调试日志已删除 |
| `npm run verify:renderer` | 首次类型检查因新增可空状态未收窄而退出1；修正后类型检查及生产构建退出0，身份保护修订后再次构建退出0 |
| `npm run test:focus -- test/integration/agent-redesign-j25-formal-settings-journey.test.js test/integration/agent-layout-journey.test.js test/integration/session-summary-request-j30-accept-journey.test.js test/ui/agent-ui.test.js test/ui/renderer-style-guard.test.js` | 75/75，零失败，退出0；覆盖正式Electron取消/重启、两种设备缩放、真实SQLite受理及界面回归 |
| 复用既有AgentView组件harness的临时迟到回执检查 | 两个出口各一次：旧请求成功回执、失败回执均不移除当前请求未确认提示；2/2。属于界面局部回归，不替代正式Electron旅程 |
| `TZ=UTC node scripts/i3-nonaudio-soak.js --segments 3600 --batch-size 100 --report docs/validation/i3-nonaudio-results.json` | 最终生产载荷下原生成器退出0；`result=pass`、`gateStatus=partial`。之前在身份保护修订前生成的一份报告已由最终载荷的实际运行替代 |
| `node scripts/verify-i3-nonaudio-report.js docs/validation/i3-nonaudio-results.json` | 最终报告严格校验退出0，未修改verifier或手工替换哈希 |
| `TZ=UTC node scripts/run-test-lanes.js all` | 最终源码Core 1227/1227、Integration 199/199、Evidence 248项符合预期及1项按设计跳过；零失败、退出0 |
| `git diff --check` | 退出0 |

上述Electron与lane命令均清除 `ELECTRON_RUN_AS_NODE`；原GPU参数与期限保留。GPU错误在成功与失败运行均出现，未作为根因或重跑理由。完整lane在最终产品修订及设置动作条件修订后执行，之后只有文档登记改动。

I3仍为非音频确定性预资格：3600段、4000个字幕事件、400段精修、72页和三种导出摘要保持不变，当前产品载荷SHA-256为 `7d54feb762067b591541624ca4314e8866a5344ff8e39d67268e85675b94e97f`。真实两小时稳定性不在该结论内。

## 同类位置核查与设计复核

| 可复现搜索 | 命中与处置 |
|---|---|
| `rg -n 'setSummarySnapshotError|setSummarySnapshotStale|取消状态尚未确认|interactionStatusRef' src/agent/agent-view.tsx` | 请求切换、新提交及成功回读的清理仅继续管理读取错误；取消失败移入独立身份状态。旧交互路径已经按interactionId保存反馈且写公共状态前核对活动身份，不属于本次快照错误混用 |
| `rg -n 'operations.cancel|isCurrentRequest|setSummaryCancellationError' src/agent/agent-view.tsx` | 同一取消函数的成功/失败出口都核对requestId/generation；异步旧回执不得覆盖当前错误。只读复核发现该遗漏后已修正并动态检查两个出口 |
| `rg -n 'checked ===|disabled|memory processing' scripts/fixtures/formal-agent-j25-settings-journey.js` | 暂停后下一次点击补足解除禁用条件；模型配置失败恢复与取消重发已有相应按钮条件。重新开启之后没有连续点击同一开关，不新增无依据等待 |
| `rg -n 'rightOverflow|translateX' scripts/fixtures/agent-layout-app.js` | 唯一水平负例从实测矩形推导，注入误差小于0.001 CSS px；正常布局阈值与越界拒绝不放宽 |
| `rg -n '\[DEBUG-cancel\]|cancellation-probe' src scripts test` | 无临时调试日志或探针入口遗留 |

主代理逐行审阅本轮全部差异；独立只读复核逐行覆盖五个产品/夹具/旅程文件及两份登记顶部，不把主代理测试结果算作独立执行证据。净行数：产品源码+8，夹具/旅程+47，语义/旅程登记+14，I3 JSON为0；本记录另计。增长分别用于两类错误生命周期及异步身份隔离、原错误真实回归、分数视口负例与证据追踪。没有新增调用方输入、单调用方抽象、兼容路径、第二套实现或测试专用产品参数。

## 未验收边界

新修订Windows CI资格链仍待推送后验收，当前状态为实现完成·尚未验收。托管CI和本地确定性旅程均不证明真实系统DPI/DWM、现场音频、真实公网模型取消/质量、两小时音频或干净机发布验收。本轮没有重建正式安装器，也未启用自动合并。
