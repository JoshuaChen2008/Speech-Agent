# B5 打包态确定性资格

- 日期：2026-07-31
- 状态：本机确定性联合资格通过；远端 workflow 已接线但尚未在本提交上取得 GitHub Actions 结果
- 发布边界：B5 只关闭构建、ASAR/native、打包态产品壳和 NSIS 机械生命周期；I4 干净机公网、权限和真实音源仍未验收

## 精确候选

`electron-builder 26.15.3` 以 Electron `43.2.0`、sherpa wrapper/platform
`1.13.4` 生成 Windows x64 单击式当前用户 NSIS。候选安装器 SHA-256 为
`0139c3078de99e11f7e40c6cc7768f4cb493973c1a88becea8860efe5421edd2`。
该内部候选没有 Authenticode 签名，不能把可安装解释为 SmartScreen 或公开分发已验收。
当前 `appId=com.live-subtitle.desktop`、产品名 `Live Subtitle` 只冻结这份内部候选的身份。
对外发布前还需确认长期持有的 appId/发布者、图标、签名，以及开发态旧 `userData`
到正式产品身份的迁移策略；B5 不声称已验证旧版升级连续性。

正式包只允许 `package.json`、`src/**/*` 和生产依赖进入 ASAR。结构检查得到
163 个 ASAR 条目，29 个动态/静态产品入口全部存在；`models/`、`test/`、`docs/`、
`.artifacts/`、模型张量和音频载荷均未进入 ASAR 或外部 resources。模型仍只能进入
`userData/models`，SQLite 仍位于 `userData/data`。

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
5. 生产 storage utility 从 ASAR fork，SQLite 保存本次会话，history 查到终态记录并完成 205 段五页往返，DOM 上界 50；
6. 独立 utility 从 ASAR 执行 `require('sherpa-onnx-node')`，实际加载 unpacked `.node` 与相邻 DLL，固定 API 面存在并 exact exit 0；
7. 外部 exact-child supervisor 得到 `clean-exit`、0 incident、0 crash、未观察到 breakpoint，且 `scope.packagedRuntime=true`。

这条旅程仍以受控小资源和 fake ASR 替代公网、真实张量、物理声卡；测试 main 也不是正式
release main。因此它证明打包路径上的模块组合，不冒充 I2/I3/I4。

## NSIS 生命周期

精确候选被静默安装到项目 `.artifacts` 下预先校验的隔离目录；检查正式 exe 和候选生成的
exact uninstaller 存在后，只调用该 uninstaller。安装与卸载均 exit 0，安装目录已移除；随后
只读复核得到遗留快捷方式 0、遗留当前用户卸载登记 0。该探针没有启动正式应用，也没有触碰
`userData`，所以只证明 NSIS 机械生命周期，不证明用户数据保留、真实首启或交互安装向导。

## 不得过度声明

- 不能据此声称物理 mic、真实权限、两小时 I3 或公网大模型下载通过。
- 不能据此声称精确 NSIS 在无仓库/无 Node/无既有 userData 的干净 Win11 上完成完整旅程。
- 首次获得完整 270,938,600 字节模型 bundle 需要公网；只有 ready marker 完整后，才要求断网且无 Agent 仍可字幕和历史。
- 打包态 clean exit 仍不是用户截图 `0x80000003` 的 native stack 根因或永久修复证明；它只说明当前受控打包旅程未复现该异常。

结构、产品和退出证据分别见
[`b5-packaged-layout-results.json`](b5-packaged-layout-results.json)、
[`b5-packaged-product-results.json`](b5-packaged-product-results.json)、
[`b5-packaged-exit-results.json`](b5-packaged-exit-results.json)；NSIS 机械证据见
[`b5-nsis-lifecycle-results.json`](b5-nsis-lifecycle-results.json)。
