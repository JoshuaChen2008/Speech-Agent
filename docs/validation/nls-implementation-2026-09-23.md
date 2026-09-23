# NLS 首期实施记录

日期：2026-09-23。状态：**实现完成·尚未验收**。
关联：SEM-F01/F04/F06/F12/F14/F21/F25、SEM-T03/T06、J20、DB1/J10/J12/J16、ADR 0020。

## 实现范围

- 设置页独立 NLS 配置与音频上传披露；main 安全凭据、CreateToken 有效期缓存及刷新；损坏配置显式恢复。
- NLS WebSocket 就绪、持续 PCM、临时字幕、首次稳定转写及停止收束；暂停后恢复新任务并保留会话时间间隔。
- worker 留存上限 60 秒、发送在途上限 2 秒；明确故障后单向本地降级，交接失败或丢帧主动停止采集。接管确认前不宣称实际 provider 已改变。
- SQLite v13 追加迁移保存冻结项目哈希、请求参数、实际 provider、首次降级/故障；历史显示这些事实，旧会话显示未记录。
- 云端会话及其本地降级不精修，保留全局精修偏好。AppKey/声明说明不代表冻结云端模型权重。

## 验证记录

完整三条 lane 在隔离提交候选中执行，排除工作区原有未提交改动：

| 命令 / 范围 | 结果 |
|---|---|
| `npm run verify:renderer` | TypeScript 与 Vite 生产构建退出码 0 |
| `npm run build:native` | Windows 原生窗口模块构建退出码 0 |
| `node scripts/run-test-lanes.js all`：core | 968 项，961 pass、7 skip、0 fail |
| 同命令：integration | 67 项，67 pass、0 fail |
| 同命令：evidence | 239 项，238 pass、1 skip、0 fail |

共 1,274 项，1,266 pass、8 skip、0 fail。7 项是隔离目录缺少模型资产的既有跳过；1 项是须显式启用的 NLS 真实本地张量资格，均不计作验证成立。I3 非音频报告按候选重新生成，3,600 段、虚拟两小时，仍为 `gateStatus=partial`，不证明真实两小时音频。

另外执行 `node scripts/nls-native-fallback-qualification.js .artifacts/nls-work/native-fallback-qualification-final.json`，退出码 0。真实本地资格使用既有受控语料、Silero 和两个 sherpa 识别器；两个样本切点分别得到 20 个临时字幕和 1 个首次稳定转写，故障计数为 0，缓冲释放成立，交接前本地解码计数为 0。只输出指标与哈希，`gateStatus=diagnostic-only`，不保存现场音频。

按用户要求，配置/provider 与运行时两个改动组均由 Luna/max 独立复核；发现的配置恢复、凭据代次清理、错误分类、接管确认时序、worker 错误隔离和收尾缺失首次稳定转写问题已补入回归。末轮又补充关闭端口与缺失状态持久化接口的失败保护。

两组 Luna/max 收口复核均无提交阻断。最终候选执行 `npm run package:smoke:prepared -- --config.electronDist=node_modules/electron/dist`，布局 verifier 核验 606 个 ASAR 条目及 5 个原生二进制；`run-packaged-product-shell.js` 的首启/复启均为 `pass`、`clean-exit`，utility 实际加载 `ws`、`@alicloud/pop-core` 与原生依赖。运行身份为 `b5-2a169853-d2db-4dff-a1c6-09da64581ca0`，产品载荷 SHA-256 为 `2d9c2f07e70092314d182bafc04131255a21a52657e53ada77d88909e46471a5`。这是测试包确定性资格，未生成本期 NSIS 发布验收结论。

该精确候选的前一轮测试包在工具条轮廓观察顺序断言超时，无崩溃或残留进程；完整首启/复启重跑一轮未复现。失败记录保留于 `.artifacts/nls-work/candidate/.artifacts/nls-packaged-staged`，成功记录位于同级 `nls-packaged-staged-retry`，不能由重跑成功推断根因已确认。三条 lane 后只整理了 provider 文件末尾空行，随后重建 I3 精确哈希报告，并复验 provider 与 I3 两组报告测试，共 23 项、0 fail。

凭据删除权限失败返回显式未收束状态，并由重启恢复日志重试。损坏配置恢复有意保留无法安全归属的原文件及加密凭据，界面已明确披露，且不再将其用于识别；这不等同于用户数据清除。

## 未验证范围

没有使用真实 NLS 凭据调用付费识别 API。真实 header 握手、项目识别效果、Token 跨期连接、云端 mic/loopback 各五轮冻结字幕可见延迟及 main 事件循环延迟、两小时音频长稳和干净机发布仍待 I2/I3/I4。百炼与通义听悟保持后置。

本地三条 lane 与测试包确定性检查不等于远端 CI provenance、实机验收或发布验收；原有不相关工作区改动不属于本次提交。
