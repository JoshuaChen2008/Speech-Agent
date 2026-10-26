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

## 当前远端观测与搁置范围（2026-10-26）

[CI run 40296045613](https://github.com/JoshuaChen2008/Speech-Agent/actions/runs/40296045613/job/121482240649)（PR head `02473adee04ae9b9e2f0f76ffe00b839b2a1620d`，merge checkout `c13bb82b45e913512a9c547cd4bb356253dbfc16`）取得了两项原失败的具体观测：

- 系统设备缩放的 `dark/520/1` 越界负例：注入前后 `panel.right=520`、`innerWidth=520`，实际变换位移、页面溢出及右边界溢出均为0。负例没有注入到位，原因仍未定位。
- 1.25设备缩放的 `dark/520x420/1: viewport commit`：outer为523×421、content为522×421、viewport为522×422，DPR为1.25、zoom为1；visible/enabled为true、loading为false。outer宽度与目标相差3 DIP，未满足既有2 DIP条件；该失败发生在520宽场景，不能归因为1100宽请求超过屏幕。

用户明确将布局细节搁置，当前重点为崩溃修复。本轮不继续布局修正，既有矩阵、期限及严格断言保持原解释。该run另有一项J24-QA-LONG终态等待超时，Integration合计196/199；Evidence未执行且最终资格索引不存在，完整J9-CI未验收。相同run三档案共九次产品壳/ASAR首启/离线复启退出均为 `clean-exit`，核验范围见[退出记录](ci-electron-exit-2026-10-26.md)。真实系统DPI/DWM与其它实机边界不得以这些确定性结果提升状态。
