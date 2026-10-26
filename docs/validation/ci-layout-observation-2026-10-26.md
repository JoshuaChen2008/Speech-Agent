# 2026-10-26 布局旅程失败观测

状态：**实现完成·尚未验收**。关联 SEM-F14/F23、SEM-T03/T04，J18/J22/J9-CI。基点为 `a91ece0356f2b7e91d9fb25a831d6d666ad6032b`；本轮只补齐失败观测，不声称已修复尚未复现的远端原因。

## 远端事实

[CI run 40288942420](https://github.com/JoshuaChen2008/Speech-Agent/actions/runs/40288942420) 的 Core 为1220项符合预期、7项按设计跳过、0失败；Integration 为197/199。两项失败均在布局旅程：系统设备缩放场景的 `negative control must inject one CSS pixel of overflow` 未给出实际偏差，1.25设备缩放场景仅给出 `layout fixture readiness timeout`，无法识别具体阶段。Evidence 和最终资格索引因前序失败未执行，不能计为成功。

该修订的三个几何档案产品壳、ASAR首启/离线复启、NSIS机械旅程符合预期；个人记忆及正式设置旅程也有本轮成功结果。这些结果不能替代当前修订完整资格链。

## 反馈与限制

| 实际命令或操作 | 结果与边界 |
|---|---|
| `env -u ELECTRON_RUN_AS_NODE npm run test:focus -- test/integration/agent-layout-journey.test.js` | 诊断前2/2，未复现远端两项错误 |
| 同一完整夹具强制设备缩放1 | 退出0；负例观测为1 CSS px |
| 同一夹具的临时分数设备缩放探测 | 0.8、1.1暴露工具条停靠/启动几何拒绝，1.3出现对象销毁，1.4出现日期尺寸拒绝，1.6和2出现水平溢出；均是其它失败，不能用作远端原错误的红证据 |
| 用户截图及进程核对 | 设备缩放探测期间用户看到 `overlay-startup-geometry-failed`；该生产错误来自字幕窗/工具条启动几何结算，早于Agent布局旅程。探测已停止，查询时没有残留的Electron进程；没有改用户显示配置 |
| 原正常场景临时数值探针 | 系统设备缩放1.25时，窄视口浮点宽度约521.599976，整数`innerWidth`为522，注入后偏差约0.999985 CSS px；原0.001容差成立。没有据此扩大容差 |
| `env -u ELECTRON_RUN_AS_NODE npm run test:focus -- test/integration/agent-layout-journey.test.js test/validation/test-lanes-contract.test.js test/validation/i3-nonaudio-soak.test.js` | 诊断修订9/9，零失败、退出0；保留真实生产旅程、分层守卫与I3严格校验 |
| 临时Electron原生最大尺寸1024×768约束，同一完整夹具 | 原1100×720请求读回1025×722，保持原断言拒绝；现在失败明确为`dark/1100x720/1: viewport commit`，含实际outer/content/viewport/zoom及visible/enabled/loading。只证明受限尺寸下的诊断有效，不证明托管桌面存在同一约束 |
| `git diff --check` | 退出0 |

## 修改范围

缺陷类别是失败观测丢失阶段与实际输入；通用规则是失败事实须足以区分未收到动作回执、原生尺寸拒绝与renderer坐标变化，不能用通用错误掩盖这些边界。

在既有 `until` 中传入阶段名称；尺寸等待保留最后一次原生outer/content及renderer视口快照，数值条件与原期限不变。越界负例保留同一位移公式及严格阈值，仅在失败消息附加注入前后边界、视口、DPR、滚动宽度和实际变换位移。无重试、固定就绪延时、条件放宽、产品配置或产品源码改动。

同类搜索 `rg -n 'until\(|getContentSize|injectedOverflow|style\.transform' scripts/fixtures/agent-layout-app.js scripts/fixtures/formal-agent-j25-settings-journey.js`：本轮布局夹具的全部等待补阶段；同文件唯一水平负例补观测。正式设置夹具已有带用途的等待标签，保持现状。未使用更小的实测窗口替代1100宽矩阵，未把人工最大尺寸当成托管桌面根因。

主代理逐行复核本轮夹具及两份登记增量；只读子代理核查原生窗口创建、show生命周期和工具条启动结算，未运行测试，其报告不作为独立运行证据。净行数：产品源码0、夹具+13、语义/旅程登记+12，本记录另计。增长用于失败诊断，没有新增抽象或第二套旅程。临时数值日志与原生最大尺寸入口已删除。

下一步由当前修订Windows CI给出原失败的具体观测，再按实际原因修正；完整三条lane、最终资格索引、真实系统DPI/DWM和其它实机边界均不得以本轮定向结果提升状态。
