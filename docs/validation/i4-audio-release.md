# I4 音频子报告与严格汇总

- 当前状态：来源隔离 runner、两个 child 的 strict verifier、strict summary 和干净机移交包入口为
  **实现完成·尚未验收**。
- 当前证据：构建器、两套移交包 verifier 与 strict report/summary 契约回归；尚无专用干净
  Win11 的非音频、`loopback` 或 `mic` child 报告。
- 完整结论：只有同一候选的非音频 `pass/partial`、`loopback` `pass/partial`、`mic`
  `pass/partial` 全部通过严格校验后，summary 才能形成完整 I4 结论。

本入口实现 SEM-T12 / J9-I4 已登记的发布证据分层。两个音频来源不得并发：必须先执行
`loopback`，正常退出并带回其报告摘要后，再执行 `mic`。runner 不使用 UI Automation、SendKeys、
测试 main 或产品后门。权限拒绝/批准、字幕可见、暂停/恢复和原生保存对话框属于明确的操作者
attestation；精确进程串行、安装文件 SHA、SQLite header 与变化、三格式导出字节/SHA、离线复启和
零音频产物由 harness 独立验证。操作者输入 token 不能单独产生 `pass`。

## 构建并核对移交包

在源码工作区、当前 B5 安装器仍存在时运行：

```powershell
node scripts/build-i4-clean-machine-handoff.js `
  --installer .artifacts/release-package/Live-Subtitle-0.1.0-x64.exe `
  --layout docs/validation/b5-packaged-layout-results.json `
  --output .artifacts/i4-clean-machine-handoff-current

node scripts/verify-i4-clean-machine-handoff.js `
  .artifacts/i4-clean-machine-handoff-current

powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  .artifacts/i4-clean-machine-handoff-current/verifiers/verify-i4-clean-machine-handoff.ps1
```

构建器拒绝覆盖已有目录。移交包 manifest 只允许六项载荷：精确 NSIS、B5 layout、非音频
runner、音频 runner、PowerShell 包 verifier 和 legacy fixture。包内不含 Git 仓库、Node runtime、
`node_modules`、模型或现场音频。legacy fixture 是受跟踪、固定 SHA 的合成 reference，属于迁移测试
输入且明确含合成字幕正文；manifest 不把它伪称为现场采集或报告正文。除此 fixture 外，移交包不含
现场采集/报告正文。manifest 只记录相对路径、字节数、角色和 SHA；包 verifier 会拒绝任一额外或
重命名文件、路径与角色不匹配以及 fixture SHA 漂移。当前安装器未签名，manifest 明确保留该限制。

将完整目录复制到无仓库、无 Node、无既有安装/`userData`/模型的 Win11 专用标准用户快照。
先运行包内 verifier。报告与导出必须写入移交包之外的同级新目录，否则会破坏六项载荷 allowlist。

## 执行顺序

以下命令假设当前目录是移交包根，返回目录是其同级 `I4-returned-evidence`。先按
[`i4-nonaudio-nsis.md`](i4-nonaudio-nsis.md) 的操作要求执行非音频子门禁：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  .\runners\qualify-i4-nonaudio-nsis.ps1 `
  -Installer .\installer\Live-Subtitle-0.1.0-x64.exe `
  -B5LayoutEvidence .\evidence\b5-packaged-layout-results.json `
  -LegacyFixture .\fixtures\i4-nonaudio-legacy-session.jsonl `
  -ExportRoot ..\I4-returned-evidence\nonaudio-exports `
  -Report ..\I4-returned-evidence\i4-nonaudio.json `
  -OfflineControl vm-host-vnic-disconnect `
  -AttestCleanWindowsSnapshot -AttestCleanUserProfile -AttestDedicatedStandardUser
```

非音频旅程结束时，生产下载 host 必须保持不可达。随后只选择 `loopback`，按 runner 屏幕说明依次
执行真实权限拒绝、批准、开始、字幕观察、暂停/恢复、停止、历史和三格式导出：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  .\runners\qualify-i4-audio-child.ps1 `
  -Source loopback `
  -Installer .\installer\Live-Subtitle-0.1.0-x64.exe `
  -B5LayoutEvidence .\evidence\b5-packaged-layout-results.json `
  -NonAudioReport ..\I4-returned-evidence\i4-nonaudio.json `
  -ExportRoot ..\I4-returned-evidence\loopback-exports `
  -Report ..\I4-returned-evidence\i4-loopback.json
```

确认精确候选所有进程已经退出，再只选择物理麦克风执行第二个 child；`mic` 报告必须绑定前一份
`loopback` 报告的精确 SHA：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  .\runners\qualify-i4-audio-child.ps1 `
  -Source mic `
  -Installer .\installer\Live-Subtitle-0.1.0-x64.exe `
  -B5LayoutEvidence .\evidence\b5-packaged-layout-results.json `
  -NonAudioReport ..\I4-returned-evidence\i4-nonaudio.json `
  -PriorLoopbackChildReport ..\I4-returned-evidence\i4-loopback.json `
  -ExportRoot ..\I4-returned-evidence\mic-exports `
  -Report ..\I4-returned-evidence\i4-mic.json
```

任一步失败都不得手工补写或修改报告；恢复干净快照后重新执行对应顺序。

## 返回源码工作区严格校验

把 B5 layout 和三份 child JSON 带回同一源码 revision。先逐份验证，再由 writer 形成只含摘要与哈希
的 summary：

```powershell
node scripts/verify-i4-nonaudio-nsis-report.js `
  .\returned\i4-nonaudio.json docs/validation/b5-packaged-layout-results.json

node scripts/verify-i4-audio-child-report.js `
  .\returned\i4-loopback.json loopback .\returned\i4-nonaudio.json `
  docs/validation/b5-packaged-layout-results.json

node scripts/verify-i4-audio-child-report.js `
  .\returned\i4-mic.json mic .\returned\i4-nonaudio.json `
  docs/validation/b5-packaged-layout-results.json .\returned\i4-loopback.json

node scripts/write-i4-release-summary.js `
  --layout docs/validation/b5-packaged-layout-results.json `
  --non-audio .\returned\i4-nonaudio.json `
  --loopback .\returned\i4-loopback.json `
  --mic .\returned\i4-mic.json `
  --output .artifacts/i4-returned/i4-release-summary.json

node scripts/verify-i4-release-summary.js `
  .artifacts/i4-returned/i4-release-summary.json `
  .\returned\i4-nonaudio.json .\returned\i4-loopback.json .\returned\i4-mic.json `
  docs/validation/b5-packaged-layout-results.json
```

strict readers 在对象校验前拒绝非法 UTF-8、BOM、重复键、非有限数值与尾随输入；随后拒绝未知字段、
错序/错绑候选、缺失旅程、导出漂移、未变化的 SQLite、音频产物/引用、字幕正文、设备名、本地绝对
路径和绝对单调时刻。summary writer 只允许输出到 `.artifacts` 且拒绝覆盖已有文件。未经 verifier
闭合的 JSON 不得进入 `docs/validation`。

本入口不关闭 I2 `<1000ms` 性能门槛、I3 两小时 soak、DWM 可见矩阵、代码签名或 SmartScreen。
