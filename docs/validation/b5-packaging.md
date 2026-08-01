# B5 打包态确定性资格

- 日期：2026-07-31
- 状态：当前源码已重建并通过本机确定性联合资格；远端 workflow 已接线但尚未在本提交上取得 GitHub Actions 结果
- 发布边界：B5 已关闭构建、ASAR/native、打包态测试产品壳和 NSIS 机械生命周期；同一隔离 `userData` 的离线复启只发生在测试 package，NSIS 卸载只验证无关 APPDATA 哨兵。正式 release 的非音频 I4 专用机入口已另行准备，但尚无干净机报告；交互权限和真实音源也仍未验收

## 精确候选

`electron-builder 26.15.3` 以 Electron `43.2.0`、sherpa wrapper/platform
`1.13.4` 生成 Windows x64 单击式当前用户 NSIS。候选安装器 SHA-256 为
`4a1deb3551ff89758183c527f7a51acc501fddd75e76c1dd950a612d552449dd`
（104,979,011 字节）。
该内部候选没有 Authenticode 签名；按当前 MVP 决定暂不处理签名，但不能把可安装解释为
SmartScreen 或公开分发身份已验收。
当前 `appId=com.live-subtitle.desktop`、产品名 `Live Subtitle` 只冻结这份内部候选的身份。
对外发布前还需确认长期持有的 appId/发布者、图标、签名，以及开发态旧 `userData`
到正式产品身份的迁移策略；B5 不声称已验证旧版升级连续性。

正式包只允许 `package.json`、`src/**/*` 和生产依赖进入 ASAR。结构检查得到
166 个 ASAR 条目，29 个动态/静态产品入口全部存在；`models/`、`test/`、`docs/`、
`.artifacts/`、模型张量和音频载荷均未进入 ASAR 或外部 resources。模型仍只能进入
`userData/models`，SQLite 仍位于 `userData/data`。

layout schema-v2 还冻结了 `win-unpacked/LiveSubtitle.exe` SHA-256
`37c5399099d6f7147fbf0e3e2a6c6bffe3cbd053e67bc99d94d6689e04122e26` 与
`resources/app.asar` SHA-256
`870f7368b8cbc7684b6e22cb89d8d34582d40ff818bcd191ad3349525907afaa`。
I4 非音频专用机必须让首次安装和离线重装后的两个实际文件都分别等于这两个 digest，不能
只把调用者提供的 payload 字段抄进报告。

整个 `sherpa-onnx-win-x64` 目录被放入 `app.asar.unpacked`；检查到
`sherpa-onnx.node`、两个 onnxruntime DLL 和两个 sherpa DLL 共五个必需二进制，且
ASAR 元数据均标记为 unpacked。包同时关闭 `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`、
Node inspector，开启嵌入式 ASAR 完整性和 only-load-from-ASAR；产品组合根在 packaged
状态下忽略所有 `LIVE_SUBTITLE_*` 开发缝。

## 打包态多模块旅程

测试专用 package variant 与正式包共享上述 ASAR/native/fuse 布局，但 main 明确指向
受控旅程，报告固定 `releaseCandidate=false`。真实打包 exe 运行了：

1. 包内 smoke main 载入包内生产 `src/main.js`，创建 caption、toolbar、settings、history 四窗；
2. settings DOM 点击经 preload/IPC 进入生产 ModelManager，受控 loopback HTTP 执行 Range、tar、SHA、三 marker 和空闲热启用；
3. toolbar 经真实 IPC 完成开始、暂停、恢复、停止，caption 显示定稿；
4. 独立 storage utility 从 ASAR 完成 DB0 的 17 项检查，包括 WAL、迁移/事务、重开和 integrity，exact exit 0；
5. 启动前放入一份只读旧 JSONL；真实 main 冷启动把它迁入 SQLite，history 同时看到旧档、205 段长记录和本次会话，旧文件 SHA 不变且没有 JSONL 双写；
6. history 完成 205 段五页往返，DOM 上界 50；TXT/Markdown/SRT 经真实 renderer/preload/IPC/main 导出边界写出，三种结果都包含完整 205 段；保存路径选择使用受控对话框替身，不冒充人工系统对话框验收；
7. 生产 storage utility 从 ASAR fork 并完成上述写入、迁移、查询和导出；
8. 独立 utility 从 ASAR 执行 `require('sherpa-onnx-node')`，实际加载 unpacked `.node` 与相邻 DLL，固定 API 面存在并 exact exit 0；
9. 首轮自然退出后，外部 runner 再启动同一 packaged exe 和同一隔离 `userData`。第二轮不创建 HTTP fixture server，模型 fetch 尝试为 0；三项 marker 仍 ready，三条旧历史仍存在，JSONL 迁移幂等，完整导出仍可读，并新增、停止、持久化第 4 条会话；
10. 两轮外部 exact-child supervisor 都得到 `clean-exit`、0 incident、0 crash、未观察到 breakpoint，且 `scope.packagedRuntime=true`。

第二轮首次把“模型已 ready 后冷启动”的产品路径放进真实 renderer 旅程，并发现工具条会把
预览 fixture revision 错当成真实 coordinator revision、从而丢弃首个 idle 快照。现已改为首个真实
快照无条件替换预览值；修复后第二轮开始按钮、字幕和历史写入全部通过。

本轮为两次 packaged 启动生成唯一 run ID `b5-04b208a6-4bb9-4294-ae0b-0bed3e00c4ea`。
首启产品报告、首启退出、复启产品报告和复启退出的四个 SHA-256 都写入独立 binding 报告；
复启报告还反向保存首启产品报告 SHA。测试 package 和正式 release ASAR 再分别对完整
`src/` 树做同一规范哈希，均得到 111 个文件和产品载荷 SHA-256
`503a40df18f70c397604bda6a4c3ac909851624ec2129a8db7b690fa610ab93d`。
正式 layout 报告保存 binding 报告 SHA、test exe SHA 和四份运行报告 SHA，因此仓库测试会拒绝
旧运行报告、新 release 包或任一单份报告被替换后的证据拼接。

这条旅程仍以受控小资源和 fake ASR 替代公网、真实张量、物理声卡；测试 main 也不是正式
release main。因此它证明打包路径上的模块组合，不冒充 I2/I3/I4。

## NSIS 生命周期

精确候选被静默安装到项目 `.artifacts` 下预先校验的隔离目录；检查正式 exe 和候选生成的
exact uninstaller 存在后，只调用该 uninstaller。安装与卸载均 exit 0，安装目录已移除。
探针同时把 `APPDATA`/`LOCALAPPDATA` 指向 `.artifacts` 内隔离 profile，并在与应用无关的
固定目录写入哨兵；卸载后该文件仍存在且 SHA-256 未变。这只证明候选 uninstaller 没有清扫
整个隔离 APPDATA。该探针没有启动正式 release 应用、没有观察 Electron 实际 `userData` 路径，
因此不能证明应用真实数据保留、真实首启或交互安装向导；这些仍归 I4。

## 不得过度声明

- 不能据此声称物理 mic、真实权限、两小时 I3 或公网大模型下载通过。
- 不能据此声称精确 NSIS 在无仓库/无 Node/无既有 userData 的干净 Win11 上完成完整旅程；双启动使用的是与正式包同布局但 main 为受控旅程的 test variant。
- 首次获得完整 270,938,600 字节模型 bundle 需要公网；只有 ready marker 完整后，才要求断网且无 Agent 仍可字幕和历史。
- 打包态 clean exit 仍不是用户截图 `0x80000003` 的 native stack 根因或永久修复证明；它只说明当前受控打包旅程未复现该异常。

结构、产品和退出证据分别见
[`b5-packaged-layout-results.json`](b5-packaged-layout-results.json)、
[`b5-packaged-product-results.json`](b5-packaged-product-results.json)、
[`b5-packaged-exit-results.json`](b5-packaged-exit-results.json)、
[`b5-packaged-restart-results.json`](b5-packaged-restart-results.json) 和
[`b5-packaged-restart-exit-results.json`](b5-packaged-restart-exit-results.json)；同轮运行与产品载荷绑定见
[`b5-packaged-run-binding-results.json`](b5-packaged-run-binding-results.json)；NSIS 机械与无关 APPDATA 保留探针见
[`b5-nsis-lifecycle-results.json`](b5-nsis-lifecycle-results.json)。正式 release 的后续非音频专用机
流程见 [`i4-nonaudio-nsis.md`](i4-nonaudio-nsis.md)，它不属于这七份 B5 报告。
