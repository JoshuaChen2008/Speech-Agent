# I4 非音频 NSIS 子门禁

- 当前状态：执行入口、固定 legacy fixture、严格报告 verifier 与回归契约已完成；尚无合格的专用干净 Win11 执行报告
- 结论上限：成功报告只能是 `result=pass`、`gateStatus=partial`，不能关闭完整 I4
- 当前候选：unsigned x64 NSIS SHA-256 `36c7512037720cb50fea98a25ae021e9d5bfcc1a744bbca5d7b4b3e65895f4ae`
- 明确排除：物理 mic/loopback、Start/capture 命令、系统声音、扬声器播放、媒体权限批准、真实 ASR 推理

这条子门禁补齐“正式 release main 在真实安装后的非音频生命周期”，不重复 B5 的测试
package。B5 的 NSIS 探针只静默安装、卸载并检查一个与应用无关的 APPDATA 哨兵；本入口则
必须在专用标准用户的干净 Windows 11 快照中交互安装精确候选，启动正式 `src/main.js`，
经设置页从公网取得生产三资源 bundle，断网复启并经系统保存对话框导出旧档，再用候选生成的
uninstaller 验证真实应用数据保留及离线重装复用。

## 为什么当前仓库不保存一份“通过”报告

运行环境必须同时满足：Windows build ≥22000、交互桌面、专用非提权标准用户、干净用户
profile、无可执行的 Node、脚本/安装器/fixture 不在 Git 仓库中，以及没有旧安装、旧
`userData` 或模型。当前开发机已有仓库、Node 和历史 `userData`，因此不能生成合格证据。
没有专用机报告时，本子门禁状态就是未执行，而不是跳过后视为通过。

PowerShell runner 使用 Windows Known Folder API 读取真实 Roaming/Local 路径；它不依赖
`APPDATA` 环境变量覆盖。首次正常退出后，runner 只接受一个新建且同时含模型与 SQLite 的
Roaming 目录，并要求其 basename 为包名 `live-subtitle-agent`。这避免把无关哨兵误写成
“正式应用 userData 已验证”。

## 专用机准备

向全新快照只传入以下四个文件；不要挂载仓库或 `node_modules`：

1. `Live-Subtitle-0.1.0-x64.exe`
2. `qualify-i4-nonaudio-nsis.ps1`
3. tracked `b5-packaged-layout-results.json`
4. `i4-nonaudio-legacy-session.jsonl`

使用专用标准用户登录交互桌面。确保 Node 不在 `PATH`，没有 `LiveSubtitle.exe`、
`live-subtitle-agent` 数据目录或既有模型。代码签名当前按内部 MVP 决定暂缓，因此这份候选
应显示 `NotSigned`；SmartScreen/发布者身份不在本子门禁结论内。

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

`-ExecutionPolicy Bypass` 只作用于这一个新建 VM 进程，解决干净 Windows 常见的
`Restricted`/Mark-of-the-Web 拦截；若组织 Group Policy 不允许，则由 VM 管理者预先允许或
签署 runner，标准用户不得自行规避策略。

runner 会暂停并要求操作员输入固定 token。操作员必须遵守屏幕说明：

1. 观察无 `/S` 参数的精确 NSIS 安装完成。
2. 首启完成场景选择，但绝不点击 Start；从正式设置页执行公网下载，等待三资源 ready，正常退出。
3. 由 VM host 断开 vNIC，或由管理员预置出站阻断；标准用户本身不负责禁用网卡。runner
   逐一要求生产 allowlist 的 `github.com`、`objects.githubusercontent.com`、
   `release-assets.githubusercontent.com` 均不可达。报告仍明确写
   `networkAttemptCountAssessed=false`，不会把“下载域名不可达时可用”夸大为应用零连接尝试。
   `vm-host-vnic-disconnect` 必须经 Hyper-V/VMware/物理控制台操作，或保留一条无互联网路由的
   host-only 管理通道；不要在仅有一张联网网卡的 RDP 会话里断开 vNIC，否则操作员也会失联。
   `preconfigured-outbound-block` 必须是 VM 级、全局或对该标准用户同样生效的阻断，使 runner
   所在的 PowerShell 也无法访问上述三个 host；只阻断 `LiveSubtitle.exe` 的应用级规则不满足
   本资格脚本的探测条件。
4. 离线复启，确认固定旧档可见；依次通过真实 Windows Save dialog 保存 txt/md/srt，正常退出。
5. 交互运行候选生成的 uninstaller；比较卸载前后的 15 个核心产品数据文件：
   `config.json`、SQLite 主库、只读 legacy fixture、3 个生产 ready marker 和 9 个实际模型文件。
6. 网络仍关闭时交互重装同一 SHA 候选；确认模型 ready、同 ID 历史恰好一条，并再次经
   三个原生保存对话框导出。第二组导出的字节数/SHA 必须与卸载前完全一致，15 文件清单也
   必须保持不变。

任何一步失败都不会生成 pass 报告。runner 不使用 UI Automation、SendKeys、进程名强杀或
测试 main，也不向产品源码加入测试后门。

## 报告验证

把生成的 JSON 单独带回仓库，再运行：

```powershell
node scripts/verify-i4-nonaudio-nsis-report.js .\path\to\i4-nonaudio-report.json
```

verifier 使用严格 JSON 解析，拒绝重复键、未知字段、非规范时间、绝对路径、正文、音频扩展名、
URL/凭据材料和完整 I4 声明。它还会校验带回报告中的 B5 layout 文件 SHA，并要求首次安装和
离线重装后的 `LiveSubtitle.exe`/`app.asar` SHA 都与 tracked layout 相等；由此再绑定安装器、
签名状态、release main 和 111 文件产品载荷 identity。三份 ready marker 必须逐项匹配生产
manifest 的 artifact ID、字节数、源 SHA 和 marker 文件 SHA；legacy 源 SHA必须匹配仓库
固定 fixture。GUI 可见性、公网设置点击和“不点击 Start”等无法由 PowerShell直接观察的项
全部以 `operatorAttested*` 命名，文件/进程/hash 检查则以 `harnessVerified*` 命名。

## 与完整 I4 的边界

即使本子门禁取得有效 `pass/partial`，下列内容仍只由后续白天音频实机门禁关闭：

- media permission 的实际提示、拒绝与批准；
- 物理 mic 和真实 loopback 的单路捕获、真实 ASR/精修；
- pause/resume、设备变化、睡眠/唤醒与硬崩溃恢复；
- 两小时真实声源墙钟 soak、性能与长期窗口交互。

因此完整 I4、I2 和 I3 均不会因这份非音频报告变成完成。
