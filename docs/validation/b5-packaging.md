# B5 打包态确定性资格

- 日期：2026-08-02
- 状态：当前源码的构建、ASAR/native、真实打包测试产品壳双启动与 NSIS 机械生命周期已达到确定性联合验收完成；远端 run `30750568366` 已在 revision `2242103eb917f2afbfe81c7c8df788852bb36ebc` 执行，但因锁文件安装后缺少 Electron runtime 而失败；显式 runtime 供给与前置版本校验修复为实现完成·尚未验收
- 发布边界：同一隔离 `userData` 的离线复启发生在测试 package；NSIS 卸载只验证隔离安装目录与无关 APPDATA 哨兵。正式 release 的 I4 非音频专用干净机尚未执行，因此尚未达到实机验收完成或发布验收完成

## 精确候选

`electron-builder 26.15.3` 以 Electron `43.2.0`、sherpa wrapper/platform
`1.13.4` 生成 Windows x64 单击式当前用户 NSIS。候选安装器 SHA-256 为
`4abc23bc4f0ab0307d551a5c59c834009d3d48953810f6c864c485db73db31de`
（104,996,979 字节）。

该内部候选的 Authenticode 状态是 `not-signed`。按当前 MVP 决定暂不处理代码签名，但不能把
可安装解释为 SmartScreen 或公开分发身份已经验收。当前
`appId=com.live-subtitle.desktop`、产品名 `Live Subtitle` 只冻结这份内部候选的身份；
对外发布前仍需确认长期 appId、发布者、图标、签名及旧 `userData` 的升级迁移策略。

正式包只允许 `package.json`、`src/**/*` 和生产依赖进入 ASAR。结构检查得到
168 个 ASAR 条目，29 个动态/静态产品入口全部存在；`models/`、`test/`、`docs/`、
`.artifacts/`、模型张量和音频载荷均未进入 ASAR 或外部 resources。模型仍只能进入
`userData/models`，SQLite 仍位于 `userData/data`。

layout schema-v2 冻结了 `win-unpacked/LiveSubtitle.exe` SHA-256
`6a38d9fc6cbf09893702dfa78c2e1c22339f4391cadc0b49a5c855111df5d03e` 与
`resources/app.asar` SHA-256
`72f23ae31de1cb173a41e9d4fb46251bb32d3e20403018aacf1b2599a908d22b`。
I4 非音频专用机必须让首次安装和离线重装后的实际文件分别等于这两个 digest，不能只抄写
调用者提供的字段。

整个 `sherpa-onnx-win-x64` 目录位于 `app.asar.unpacked`；检查到
`sherpa-onnx.node`、两个 onnxruntime DLL 和两个 sherpa DLL 共五个必需二进制，且
ASAR 元数据均标记为 unpacked。包同时关闭 `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`、
Node inspector，开启嵌入式 ASAR 完整性和 only-load-from-ASAR；产品组合根在 packaged
状态下忽略所有 `LIVE_SUBTITLE_*` 开发缝。

## 打包态多模块旅程

测试专用 package variant 与正式包共享上述 ASAR/native/fuse 布局，但 main 指向受控旅程，
报告固定 `releaseCandidate=false`。真实打包 exe 已完成以下无音频路径：

1. 包内 smoke main 载入包内生产 `src/main.js`，创建 caption、toolbar、settings、history 四窗。
2. 精修模型缺失时点击全局偏好保持关闭且网络请求为 0；设置页随后经真实 preload/IPC/ModelManager 显式安装核心 ASR+VAD，受控 HTTP 验证 `.part` Range、tar、SHA、两个核心 ready marker 与空闲热启用。
3. 精修模型继续保持独立缺失；首轮明确开始精修下载后，受控服务器只送出一个字节并保持流，设置 renderer 再明确点击取消。真实 Electron fetch 连接关闭，合法 `.part` 保留，精修 ready marker 仍为 0。
4. 已开始且冻结为关闭的首轮会话不受其他设置变化影响，核心字幕、暂停/恢复、停止与历史继续可用。
5. history 对 205 段完成五页往返且 DOM 上界为 50。会话 A 从原始版明确切到精修版，跨页保持选择并按精修版导出；选择会话 B 后自动回到原始版并按原始版导出。TXT/Markdown/SRT 原始版均包含完整 205 段；保存路径使用受控对话框替身，不冒充人工系统对话框验收。
6. 独立 storage utility 从 ASAR 完成 DB0 的 17 项 WAL、迁移、事务、重开与 integrity 检查；启动前只读旧 JSONL 被幂等迁入 SQLite，旧文件 SHA 不变且没有 JSONL 双写。
7. 独立 native utility 从 ASAR 加载 unpacked `.node` 与相邻 DLL，固定 API 面存在并 exact exit 0。
8. 首轮自然退出后，外部 runner 使用同一 packaged exe 和隔离 `userData` 再启动。第二轮先在没有 fixture server 的条件下确认核心两个 marker 仍 ready、精修仍 missing、合法 `.part` 存在且 fetch=0；随后才启动受控服务器并由用户明确“继续下载”，断言精确 Range，产生一个精修 marker。安装后开关仍关闭，再次明确开启才影响未来会话。受控 worker 故障期间没有弹窗、提示或 resize，全部仍可见 `final` 回到首次稳定转写；正常停止后由 main→IPC→toolbar 显示一次工具条会话状态通知，“查看历史”清除提示并打开保留故障事实与覆盖度的历史。旧提示在复启时不重放，活动会话保持启动时冻结值，最终持久化第 4 条终态会话。
9. 两轮 exact-child supervisor 都得到 `clean-exit`、0 incident、0 crash、未观察到 breakpoint，且 `scope.packagedRuntime=true`。

精修下载的“取消→连接关闭→保留合法 `.part`→应用复启 fetch=0→再次明确继续才 Range”已在
同一真实 packaged Electron 双启动旅程中闭合；报告 schema-v3 分别记录首轮取消事实和第二轮继续事实。

本轮两次 packaged 启动的唯一 run ID 为
`b5-2bd0dc7a-e233-41a5-a41b-65d04344b0aa`。首启产品、首启退出、复启产品和复启退出的
四个 SHA-256 写入独立 binding 报告；复启报告反向保存首启产品报告 SHA。测试 package 与正式
release ASAR 对完整 `src/` 树做同一规范哈希，均得到 114 个文件和产品载荷 SHA-256
`b6503ca26c3f59bb0b5c15acfa6c2ceec0d2eaff3a540bf5f56016032c1a0bbd`。
正式 layout 报告同时保存 binding 报告 SHA、test exe SHA 和四份运行报告 SHA，仓库门禁会拒绝
旧运行报告、新 release 包或任一单份报告被替换后的证据拼接。

## CI 精确 revision 索引

本地七份 B5 报告回答“这一轮受控运行、产品载荷与 installer 是否彼此一致”，但不单独回答
“它来自哪个 Git checkout”。Windows workflow 现在把最终 provenance 索引放在全部布局、存储、
产品壳、packaged 双启动、release、NSIS 与 core/integration/evidence 步骤之后：writer 先要求
实际 `HEAD` 与触发时 `GITHUB_SHA` 完全相同、受跟踪工作树无改动，再记录 run ID/attempt、
workflow/job/event、`package-lock.json`/workflow digest、installer SHA，以及布局、B5 binding、
release layout 和 NSIS 报告 SHA；strict verifier 随后重新读取关键报告和文件并核对跨报告关系。
上传名包含 revision、run ID 与 attempt。失败运行仍上传已有诊断，但不会生成这份最终索引。

writer/verifier、workflow 顺序与本地当前候选的交叉哈希探针为实现完成·尚未验收。远端 run
`30750568366` 精确绑定 revision `2242103eb917f2afbfe81c7c8df788852bb36ebc`：`npm ci`
成功后，`node_modules/electron/dist/electron.exe` 不存在，首个字幕布局步骤无法启动；后续存储、
产品壳、打包、回归与最终 provenance 索引均未执行。该结果只证明 Electron runtime 供给前置缺口，
不构成字幕布局或产品断言失败。只有显式安装并校验锁定的 Electron `43.2.0` 后完整 workflow
成功，才可取得对应远端索引；本地构造相同 JSON 也不带远端来源语境或签名，不能冒充 GitHub run 证据。

这条旅程使用受控小资源和 fake ASR，不访问物理声卡、不保存音频，也不冒充公网真实张量、
I2、真实两小时 I3 或 I4。

## NSIS 生命周期

精确候选被静默安装到项目 `.artifacts` 下预先校验的隔离目录；确认正式 exe 和候选生成的
exact uninstaller 存在后，只调用该 uninstaller。安装与卸载均 exit 0，安装目录已移除。
探针把 `APPDATA`/`LOCALAPPDATA` 指向 `.artifacts` 内隔离 profile，并在与应用无关的固定目录
写入哨兵；卸载后该文件仍存在且 SHA-256 未变。这只证明候选 uninstaller 没有清扫整个隔离
APPDATA。探针没有启动正式 release 应用、没有观察 Electron 实际 `userData` 路径，因此不能
证明真实应用数据保留、真实首启或交互安装向导；这些仍归 I4。

## 不得过度声明

- 不能据此声称物理 mic/loopback、真实媒体权限、两小时 I3、真实模型调用或公网大模型下载通过。
- 不能据此声称精确 NSIS 已在无仓库、无 Node、无既有 `userData` 的干净 Win11 上完成完整旅程；双启动使用的是与正式包同布局但 main 为受控旅程的 test variant。
- 默认核心字幕首次公网供给为实时 ASR+VAD 共 134,541,861 字节；136,396,739 字节精修模型默认不下载，只有用户明确动作才供给。不能再把三资源全量 bundle 当作核心 ready 条件。
- 打包态 clean exit 不是用户截图 `0x80000003` 的 native stack 根因或永久修复证明，只说明本轮受控打包旅程未复现。

结构、产品和退出证据分别见
[`b5-packaged-layout-results.json`](b5-packaged-layout-results.json)、
[`b5-packaged-product-results.json`](b5-packaged-product-results.json)、
[`b5-packaged-exit-results.json`](b5-packaged-exit-results.json)、
[`b5-packaged-restart-results.json`](b5-packaged-restart-results.json) 和
[`b5-packaged-restart-exit-results.json`](b5-packaged-restart-exit-results.json)；同轮运行与产品载荷绑定见
[`b5-packaged-run-binding-results.json`](b5-packaged-run-binding-results.json)；NSIS 机械与无关 APPDATA 保留探针见
[`b5-nsis-lifecycle-results.json`](b5-nsis-lifecycle-results.json)。正式 release 的后续非音频专用机
流程见 [`i4-nonaudio-nsis.md`](i4-nonaudio-nsis.md)，它不属于这七份 B5 报告。
