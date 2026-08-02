# I4 非音频 NSIS 子门禁

- 当前状态：runner、严格报告 verifier 与回归契约为**实现完成·尚未验收**；尚无合格的专用干净 Win11 执行报告。
- 结论上限：成功报告只能是 `result=pass`、`gateStatus=partial`，不能关闭完整 I4。
- 候选身份：不在本文固定 SHA、载荷文件数或模型文件数。执行时传入与安装器同轮生成的 B5 layout 报告；runner 和 verifier 从该报告读取安装器、`LiveSubtitle.exe`、`app.asar`、签名状态与产品载荷 identity，并在安装和重装后逐项绑定。
- 明确排除：物理 `mic`/`loopback`、Start/capture、系统声音、扬声器播放、媒体权限批准与真实 ASR 推理。

此子门禁补齐“B5 绑定的正式 release main 在真实交互安装后的非音频生命周期”，不重复 B5 的静默 NSIS
探针。它在专用标准用户的干净 Windows 11 快照中交互安装精确候选，启动正式 `src/main.js`，
经设置页完成核心资源与精修资源的独立旅程；随后断网复启、经系统保存对话框导出旧会话，最后验证
卸载后的应用数据保留和离线重装复用。

## 资源与偏好范围

该 runner 以当前资源合同为准：

- **核心字幕模型资源**是实时 ASR 与 VAD。首次只下载并验证这两个资源的 ready marker、固定
  manifest 字节/SHA、实际模型文件与清理后的 staging；精修资源仍不存在。
- 精修默认关闭。操作员先在精修资源缺失时尝试开启偏好，确认开关保持关闭且展示显式下载动作；
  然后在另一轮无 capture 启动中明确下载精修资源，确认 ready 后开关仍关闭；再在下一轮无 capture
  启动中再次明确开启全局精修偏好。
- 断网复启和离线重装后，runner 分别确认核心、精修资源以及已明确开启的全局偏好保持可见和可复用。
  卸载保留清单由实际 ready marker 和实际模型文件动态生成，不以固定文件数作为目标。

I4 非音频 runner 不截获应用进程网络请求，因此报告诚实记录
`refinementNetworkAttemptCountAssessed=false`；“缺失精修资源时点开关 fetch=0”的逐请求证明仍由
J15c/B5 确定性 Electron 旅程提供。此 runner 同样不启动会话，所以不会把“活动会话在开始时冻结
精修偏好、后续全局偏好修改只影响未来会话”写成已在本子门禁复核；它被列入报告限制，并由 J15c
及后续包含真实单路来源的 I4 复核。

## 为什么仓库不保存一份 pass 报告

运行环境必须同时满足：Windows build ≥22000、交互桌面、专用非提权标准用户、干净用户 profile、
无可执行 Node、runner/安装器/fixture 不在 Git 仓库中，以及没有既有安装、`userData` 或模型。
当前开发机已有仓库、Node 和历史 `userData`，不能生成合格证据。没有专用机报告时，本子门禁是
**实现完成·尚未验收**，不是跳过后视为通过。

PowerShell runner 使用 Windows Known Folder API 读取真实 Roaming/Local 路径，不依赖 `APPDATA`
环境变量覆盖。首次正常退出后，它只接受一个新建、同时含模型与 SQLite 的 Roaming 目录，并要求其
basename 为包名 `live-subtitle-agent`，以避免把无关哨兵误记为正式应用 `userData`。

## 专用机准备

向全新快照只传入以下文件；不要挂载仓库或 `node_modules`：

1. 与 B5 layout 报告同轮的 x64 NSIS 安装器；
2. `qualify-i4-nonaudio-nsis.ps1`；
3. 同轮 `b5-packaged-layout-results.json`；
4. `i4-nonaudio-legacy-session.jsonl`。

使用专用标准用户登录交互桌面。确保 Node 不在 `PATH`，没有 `LiveSubtitle.exe`、
`live-subtitle-agent` 数据目录或既有模型。代码签名按当前 MVP 决定暂缓：runner 会把实际
Authenticode 状态与传入 B5 报告比对，不把 SmartScreen 或发布者身份写入本子门禁结论。

## 执行

在传入文件所在的非仓库目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\qualify-i4-nonaudio-nsis.ps1 `
  -Installer .\Live-Subtitle-0.1.0-x64.exe `
  -B5LayoutEvidence .\b5-packaged-layout-results.json `
  -LegacyFixture .\i4-nonaudio-legacy-session.jsonl `
  -ExportRoot .\evidence\exports `
  -Report .\evidence\i4-nonaudio-report.json `
  -OfflineControl vm-host-vnic-disconnect `
  -AttestCleanWindowsSnapshot `
  -AttestCleanUserProfile `
  -AttestDedicatedStandardUser
```

`-ExecutionPolicy Bypass` 只作用于这个新建 VM 进程，处理干净 Windows 常见的
`Restricted`/Mark-of-the-Web 拦截。若组织 Group Policy 不允许，应由 VM 管理者预先允许或签署
runner；标准用户不得自行规避策略。

runner 会暂停并要求操作员输入固定 token。必须遵守屏幕说明：

1. 观察不带 `/S` 参数的精确 NSIS 安装完成。
2. 首次启动完成场景选择，但绝不点击 Start。仅下载核心字幕模型资源，确认实时 ASR 与 VAD ready；
   再尝试开启缺失精修资源的偏好，确认它仍关闭且没有下载精修资源，然后正常退出。
3. 在下一次无 capture 启动中，明确下载精修资源并等待 ready；确认它没有自动开启精修偏好后正常退出。
   在第三次无 capture 启动中，明确开启已 ready 的全局精修偏好并正常退出。
4. 由 VM host 断开 vNIC，或由管理员预置出站阻断。runner 逐一要求生产 allowlist 的
   `github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com` 都不可达。
   它不把 host 不可达夸大为应用零连接尝试。`vm-host-vnic-disconnect` 应通过 Hyper-V/VMware/
   物理控制台操作，或保留无互联网路由的 host-only 管理通道；不要在只有一张联网网卡的 RDP
   会话中断开 vNIC。`preconfigured-outbound-block` 必须对 runner 所在 PowerShell 同样生效，
   只阻断 `LiveSubtitle.exe` 的规则不满足此检查。
5. 离线复启，确认核心、精修和已明确开启的全局精修偏好仍就绪；确认固定旧会话可见，依次经真实
   Windows Save dialog 保存 txt/md/srt，正常退出。
6. 交互运行候选生成的 uninstaller。runner 比较实际 `config.json`、SQLite 主库、固定 legacy
   fixture、ready marker 和模型文件组成的保留清单哈希。
7. 网络保持关闭，交互重装同一候选。确认资源与偏好未触发下载、旧会话仍恰好一条，再通过三个原生
   保存对话框导出；第二组导出的字节数/SHA 必须与卸载前一致，保留清单哈希也必须不变。

任一步失败都不会生成 pass 报告。runner 不使用 UI Automation、SendKeys、进程名强杀、测试 main，
也不向产品源码加入测试后门。

## 报告验证

将生成的 JSON 单独带回仓库后运行：

```powershell
node scripts/verify-i4-nonaudio-nsis-report.js .\path\to\i4-nonaudio-report.json
```

verifier 使用严格 JSON 解析，拒绝重复键、未知字段、非规范时间、绝对路径、字幕正文、音频扩展名、
URL/凭据材料和完整 I4 声明。它从随报告提供的 B5 layout 读取候选 identity，要求首次安装与离线
重装后的 `LiveSubtitle.exe`/`app.asar` SHA 与该 layout 一致；不在 I4 文档或 verifier 中保留旧
候选 SHA 或产品载荷文件数。它分别核验核心的 two-marker ready 状态、精修资源的独立 ready 状态、
“ready 后仍关闭”以及“再次显式开启”的配置持久化。无法由 PowerShell 直接观察的 GUI 行为统一以
`operatorAttested*` 命名；文件、进程、配置和哈希检查以 `harnessVerified*` 命名。

## 与完整 I4 的边界

即使本子门禁取得有效 `pass/partial`，下列内容仍由后续白天音频实机门禁复核：

- media permission 的实际提示、拒绝与批准；
- 物理 `mic` 和真实 `loopback` 的单路捕获、真实 ASR/精修；
- 活动会话精修偏好冻结、pause/resume、设备变化、睡眠/唤醒与硬崩溃恢复；
- 两小时真实声源墙钟 soak、性能与长期窗口交互。

因此完整 I4、I2 和 I3 都不会因这份非音频报告达到发布验收完成。
