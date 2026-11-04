# 2026-10-26 打包态退出与 Electron 补丁

状态：**实现完成·尚未验收**。关联 SEM-F12/F14/F18/F24、SEM-T03/T04/T12；J19/J9-CI/B5。基点为 `0372784430737788bd73370613f58f1d78378ca0`。本记录只覆盖运行时补丁及其验证，不改写历史 B5 或实机资格。

## 失败事实与修正依据

[CI run 40275946577](https://github.com/JoshuaChen2008/Speech-Agent/actions/runs/40275946577/job/121418602035) 的打包态 `legacy-risk` 产品报告先写出 `pass`，随后 stderr 为 `PostQueuedCompletionStatus: (6) The handle is invalid.`。外部 exact-child 退出证据观察到 `will-quit`、正常退出意图和 main 的 `breakpoint-0x80000003`；角色归因置信为 `exact-handle`，`nativeStackCaptured=false`、`rootCauseIdentified=false`。运行器按原要求拒绝此轮，离线复启及后续 CI 步骤未执行。

候选缺陷类别是运行时停止与延迟任务投递竞争；一般规则是调度器停止后不得接受需要已关闭句柄的新任务。该类别在上游有独立修复，但本应用没有现场 native stack，尚不能唯一归因本次事件。

- [nodejs/node#61999](https://github.com/nodejs/node/pull/61999) 在同一任务锁下标记停止并拒绝迟到 `PostDelayedTask`，避免后台 V8 任务在 libuv loop 关闭后发送异步通知。
- [electron/electron#52956](https://github.com/electron/electron/pull/52956) 及 [electron/electron#53013](https://github.com/electron/electron/pull/53013) 的43-x-y回移纳入该修复。
- [Electron 43.5.0 发行说明](https://github.com/electron/electron/releases/tag/v43.5.0) 明确列出 Windows 上 V8 在退出期间投递延迟 worker 任务的崩溃修复。原 `43.3.0` 不含该补丁。

最小修正是将已有 Electron 精确依赖及锁文件升级至 `43.5.0`，同步报告读取器的精确版本集合。调用方没有新字段或选择，实际版本由安装依赖与二进制核验；无需新增产品状态、退出分支或第二套生命周期。上游变更的是调度器任务状态及其锁内停止标记，本仓库不复制该数据结构或补丁。现有 exact-child 正常退出、异常退出拒绝和四份报告绑定保持原要求。

## 原症状复现边界

| 修正前运行 | 实际结果 |
|---|---|
| `npm run package:smoke:prepared`；`TZ=UTC node scripts/run-packaged-product-shell.js --executable <packaged-executable> --artifacts-root <new-root> --electron-major 43 --window-geometry-profile legacy-risk` | 原 `43.3.0` 打包及一轮首启/离线复启退出0，均为 `clean-exit` |
| 同一打包入口串行压力，遇非零停止 | 前5轮首启/复启符合预期；第6轮 `PRODUCT_SHELL_SMOKE_FAILED`，main 为 `other-nonzero`、breakpoint=false、未开始复启。原始旅程断言未保留，原因未定位；不能计为原异常的红证据 |
| 本机回环 HTTP 重定向后自然退出最小探针 | 80/80 `clean-exit`，未出现原错误 |
| V8 内存池/显式 GC 后自然退出最小探针 | 80/80 `clean-exit`，未出现原错误 |

最小探针不是正式旅程，位于忽略的临时目录，不提交。没有本地原症状的红绿证明；补丁后的成功样本只能证明各自运行边界，不证明原异常永久排除。没有为本次采集 dump/native stack。

## 本轮验证

依赖安装首次因本会话旧小屏幕探针锁住运行时而报 `EBUSY`；核对其精确 PID、启动入口及本会话记录后仅清理该残留实例。该清理不计为受测应用自然退出。随后 npm 仅更新一个依赖包；默认二进制下载请求失败，GitHub CLI 下载中止，Node 官方 ZIP 下载240秒超时，仅校验清单下载成功。改用现有 npm 镜像取得同一制品，须同时核对官方发行清单和 Electron 包内 SHA-256 后再安装，不更改 TLS 或全局网络配置。

| 命令 | 实际结果与范围 |
|---|---|
| `npm install --save-dev --save-exact electron@43.5.0` | 清理已确认的旧探针后退出0；锁文件仅根声明与 Electron 条目变化 |
| 官方运行时 ZIP 校验及 `npm run electron:install` | ZIP SHA-256 为 `1fc131e62cafa02f0c94b5ec730c4eb1e8ce75e5f5b84f3c52a3443d86058184`，同时匹配官方发行清单及依赖包校验值；标准安装器退出0，实际二进制为 Electron43.5.0 / Node24.19.0 |
| `npm run verify:renderer` | 类型检查与生产构建退出0 |
| `env -u ELECTRON_RUN_AS_NODE TZ=UTC node scripts/run-test-lanes.js all` | Electron43.5.0 下 Core1227/1227、Integration199/199、Evidence248项符合预期及1项按设计跳过；零失败，退出0 |
| `npm run package:smoke:prepared` | Electron43.5.0 的 ASAR 测试包构建退出0 |
| `node scripts/verify-package-layout.js --package-dir .artifacts/packaged-smoke-build/win-unpacked --variant smoke --report .artifacts/ci-exit-electron435-layout-20261026.json` | 严格布局校验退出0；14513个ASAR条目、5个sherpa必需二进制、两个自有addon解包，产品载荷与当前359文件身份一致 |
| `TZ=UTC node scripts/verify-i3-nonaudio-report.js docs/validation/i3-nonaudio-results.json` | 严格校验退出0；359个产品载荷文件 SHA-256 仍为 `7d54feb762067b591541624ca4314e8866a5344ff8e39d67268e85675b94e97f`，所有既有 provenance 输入未变，因此不重写报告 |
| `env -u ELECTRON_RUN_AS_NODE TZ=UTC node scripts/run-packaged-product-shell.js --executable <packaged-executable> --artifacts-root <new-root> --electron-major 43 --window-geometry-profile <profile>` | `default`、`legacy-risk`、`current-risk` 各执行一次，均退出0；每组真实 ASAR 首启/同 userData 离线复启均为 `pass`、两次 `clean-exit`。共6次自然退出、0 incident、breakpoint=false；实际 Electron43.5.0 / Node24.19.0 |
| 三组 `createPackagedRunBindingReport` 重新计算并逐项比较 | 三组 run/fresh/restart 身份与四份报告摘要一致；原生加载、API surface、storage utility 往返、packaged DB0均符合预期；产品载荷均与当前359文件身份一致 |
| `git diff --check` | 退出0 |

报告读取器的既有行为场景先在 `43.5.0` 输入上拒绝（16/17），扩展精确版本接纳后17/17符合预期；未登记的 `43.5.1` 仍拒绝。该红绿只覆盖报告版本接纳，不冒充崩溃根因证明。

## 同类位置核查与设计复核

| 可复现搜索 | 命中与处置 |
|---|---|
| `rg -n -e '43\.3\.0' -e '43\.2\.0' -e SUPPORTED_ELECTRON_VERSIONS package.json package-lock.json scripts test .github` | 运行依赖与 lock 的三处值更新；`verify-package-layout.js` 精确集合增加 `43.5.0`；既有 B5 场景保留 `43.3.0` 历史样本并增加新版本/未登记版本边界。其它 I2/I3/native 历史 fixture 保持原解释；CI 仍核对固定主版本43 |
| `rg -n -e '43\.3\.0' -e '43\.2\.0' docs PLAN.md` | 历史运行报告、研究和排期快照不改写；本轮事实另在语义合同、旅程矩阵及此记录登记 |
| 原生 addon 与直接调用方只读核查 | 两个自有 addon 都是同步操作，没有线程、TSFN、N-API async work、`uv_async` 或 IOCP 投递；没有证据将本次错误归因这些模块，因此不混入其它静态风险修正 |

精确读取旧报告是既有证据解释职责，此轮只增加一个已登记版本，不新增兼容分支或任意版本通配。没有重试、固定休眠、强制成功退出、关闭 GC 或错误忽略。主代理逐行复核全部7份修改：两个依赖文件、布局读取器、B5场景、两份登记的增量和本记录；未声称审阅两份大型登记文档的全部历史。净行数为依赖0、布局读取器0、测试+5、语义/旅程登记+12，本记录另计；增长用于版本接纳的负例和可追溯验证事实，没有新增产品抽象、配置或调用方输入。临时下载、退出探针和批量运行脚本在提交前移除，原失败报告保留在忽略目录。

## 当前远端退出核验（2026-10-26）

用户将本轮重点限定为崩溃修复，布局细节搁置；既有断言与资格要求保持原解释。[CI run 40296045613](https://github.com/JoshuaChen2008/Speech-Agent/actions/runs/40296045613/job/121482240649) 的 PR head 为 `02473adee04ae9b9e2f0f76ffe00b839b2a1620d`，实际 merge checkout 为 `c13bb82b45e913512a9c547cd4bb356253dbfc16`；已核对 checkout 的两个 parent 分别为 main `d06d139f66da67fda8ac280666bedc6f9b6ead9b` 与该 PR head。以下结果只绑定该次运行，不表示后续文档修订已有完整远端验收。

下载的 `qualification-evidence-c13bb82b45e913512a9c547cd4bb356253dbfc16-40296045613-1` artifact ID 为 `12639255444`，GitHub 记录大小为65698字节、digest为 `sha256:9e70be26b9c084ac554e5e9de76d19d7d59fd96c70748da6540a8cd54bd15bbf`。隔离下载后用仓库既有严格读取器核验产品壳、ASAR首启、离线复启、退出证据、运行绑定、package layout及NSIS报告，并重新计算绑定中四份报告文件的SHA-256；未执行下载内容。

| 几何档案 | 产品壳 / ASAR首启 / 离线复启 | 外部退出观测 | 启动与字幕行为 |
|---|---|---|---|
| `default` | 各自报告为 `pass`，绑定核验符合预期 | 3次 `clean-exit`，main状态为 `zero`，0 incident，breakpoint=false | 产品壳与ASAR首启的监听启停成立；复启字幕呈现及会话持久化成立 |
| `legacy-risk` | 各自报告为 `pass`，绑定核验符合预期 | 3次 `clean-exit`，main状态为 `zero`，0 incident，breakpoint=false | 同上 |
| `current-risk` | 各自报告为 `pass`，绑定核验符合预期 | 3次 `clean-exit`，main状态为 `zero`，0 incident，breakpoint=false | 同上 |

九次退出均为 Electron `43.5.0`，对应产品壳/ASAR首启的 `crashEventCount=0`；三组 run ID、首启/复启引用及报告摘要闭合。359个产品载荷文件与本机当前身份一致，SHA-256为 `7d54feb762067b591541624ca4314e8866a5344ff8e39d67268e85675b94e97f`。smoke、release与NSIS报告间的身份也已交叉核对：smoke executable摘要为 `632660bf7933e065a3249658c3dfc9f707cb64f7db2c8d615d9f47812783d5e3`，release installer摘要为 `3a73ea3dd4d66047120897314756ce417179e47dcf7617aed0148a71a1b84608`。artifact不含受测二进制，本次没有在本机独立重算远端exe/ASAR/installer摘要；NSIS报告的 `applicationLaunched=false`，只证明安装/卸载机械流程。

实际定向命令：`env -u ELECTRON_RUN_AS_NODE npm run test:focus -- test/main/overlay-startup-controller.test.js test/main/electron-exit-evidence.test.js test/validation/electron-exit-evidence-report.test.js test/validation/b5-packaged-restart-contract.test.js`。结果为36/36、零失败、零跳过、退出0，覆盖启动恢复及异常退出拒绝；它不是36次真实产品启动。既有生产路径报告使用受控音频/模型/网络边界，不证明真实声卡或模型性能。

原退出异常对应的上游补丁已进入本次构建，当前九次样本没有观察到同一异常。所有退出报告仍为 `nativeStackCaptured=false`、`rootCauseIdentified=false`；不能据此宣称本次异常唯一根因已定位或永久排除。本轮没有新增产品修正、测试重试或退出容错。

## 未验收边界

当前远端Core为1220项符合预期、7项按设计跳过、零失败；Integration为196/199，失败为两项布局旅程及一项J24-QA-LONG终态等待超时。后者目前只证明等待超时，没有进程崩溃证据；布局细节按用户要求搁置，实际观测见[布局失败观测记录](ci-layout-observation-2026-10-26.md)。Evidence lane未执行，最终资格索引不存在，完整J9-CI仍未验收。

用户截图中的 `overlay-startup-geometry-failed` 来自强制设备缩放探测期间的生产启动几何恢复流程，不是原生崩溃证据；当前没有普通启动配置下的同类阻断复现。真实声卡、DWM/系统DPI、模型性能、两小时音频与干净机I4不在本轮确定性验证结论内；本次历史退出异常的具体竞态发送者仍未定位。
