# Electron `0x80000003` 调查记录

- 状态：截图确认曾出现 breakpoint；发生时间、进程角色与调用栈级根因均未证实
- 对应语义：SEM-F12、SEM-F14、SEM-T02、SEM-T03、SEM-T04
- 证据日期：2026-07-31

## 截图能证明什么

用户提供的错误截图显示 `electron.exe` 抛出 `0x80000003`
（Windows `STATUS_BREAKPOINT`），异常地址相同。截图或其临时副本的文件元数据不能证明
异常实际发生时间，因此不能据此判断它位于某个提交、I2 运行或生命周期改动之前/之后，
也不能建立与任何测试时段重合的历史时间线。

代码审计独立发现过“直接终止 native utility、未等待 exact child `exit`”的生命周期缺陷，
该缺陷值得修复；但没有 dump/调用栈/角色证据把它与截图连接起来，所以它不能被描述为
截图异常的主嫌疑、相关根因或已定位根因。

Windows Application 事件、默认 WER/CrashDumps 和当时的项目日志均没有留下可把
异常映射到 main、renderer、GPU、realtime、refine 或 storage 的记录。截图标题只给出
共同的 `electron.exe`，无法区分 Electron 多进程角色。

## 当前代码已有证据

当前代码已增加 utility fatal listener、固定 service name、worker 内 shutdown 协议、
exact-child exit 屏障和 Coordinator retirement gate。当前 realtime/refine 先等待最多
30 秒 graceful shutdown；超时后只终止并收殓该 exact child，最多再等 5 秒。字幕运行时
以 45 秒作为优雅收束结束/升级触发线，ModelManager 的 5 秒收束与其并行；升级后仍须等待
exact child，故 45 秒不是硬退出上限。旧 generation 未确认退出时不能启动 replacement，
也不按进程名批量结束 Electron。

另一次当前代码的普通产品启动经工具条“退出”完成了应用退出屏障，没有错误弹窗或残留
Electron 进程。stderr 只出现一条 Chromium GPU 状态告警；这不足以证明 GPU 崩溃，也
不足以永久禁用 GPU。

当前代码已完成三轮批准模型活跃诊断；[结构化报告](native-model-activity-lifecycle-results.json)
记录 online ASR、silero VAD 与 offline refinement 同时工作，冻结语料通过内存直送，
累计送入/消费 303 帧，产生 3 final、3 refined 和 3 次 offline decode；六个
realtime/refine exact child 全部优雅 `exitCode=0`，fatal 为 0。
报告不保存正文、PCM、音频引用或本地路径。该诊断不开 BrowserWindow，也不打开物理
mic/loopback，因此只证明活跃 native 工作后的当前收束路径，不是 I2/I3/I4。

当前代码还完成了一轮真实 I2 loopback→ASR→offline refine→退出：128 帧
captured/sent/ingested 一致，dropped、sequence gap、bad sample 均为 0；得到 1 final 和
1 refined，双 CER 0，refined 含标点。Electron exact process 正常退出且没有强制终止。
这是当前真实 native 工作路径的单轮证据，但它仍是开发态 loopback，不覆盖
物理 mic、长时稳定、打包态，也没有生成 native stack。

受监督多窗口产品壳也已完成首设、开始、字幕 DOM、停止、SQLite 历史翻页、资源页与退出
联动。产品壳报告为 `pass / partial`；独立 role exit evidence 为 `clean-exit`、主进程状态码
0、incident 0、未观察到 breakpoint。当前旅程从 settings 缺失态点击安装，使用 fake ASR、
受控模型 fixture（无真实张量）且无物理音频/真实公网，不能作为真实推理、物理声卡或
公网下载证据。

`npm start` 现在由 exact-child supervisor 启动 Electron。main、renderer、audio-host、
realtime、refine、storage 和 Chromium 其他子进程只按固定枚举记录角色、生命周期、退出原因
与状态码分类；报告不保存 PID、命令行、正文、音频/PCM、本地路径、stack 或 dump，不配置
外部上传。它能在再次出现 `0x80000003` 时缩小角色范围，但不能替代 native stack。

这些证据只说明当前受控路径没有观察到 breakpoint，并证明独立发现的生命周期缺陷已被
收束；由于截图没有可核验时间、角色证据或 native stack，不能宣称已复现、定位、修复或
根治截图中的 `0x80000003`。

## 仍需关闭的诊断条件

1. 活跃 online stream + offline refine 的循环和正常产品壳 role evidence 已完成；还需在
   后续故障 lane 覆盖模型加载中强退、硬崩溃后恢复及无法收殓旧 generation 的 fail-closed。
2. 若安全元数据再次观察到 `breakpoint-0x80000003`，再在无现场音频、冻结输入的隔离
   诊断中按 exact PID 捕获一次 dump。dump 可能包含进程内存，不得默认常开，也不得
   当作普通 CI artifact。
3. 若未再次观察到 breakpoint，只能持续保留“截图根因未获 stack 级证明”的状态；不得为
   追求结论而常开 dump、WER/Crashpad 上传或保存现场音频。

## 明确未证明

- 没有证明异常来自 sherpa/ONNX、GPU、renderer 或 Electron main 中的任意一个角色；
- 没有证明用户交互问题已复现；
- 没有证明硬崩溃后的 replacement、字幕恢复或两小时资源稳定性；
- 没有完成物理 mic I2、两小时 I3 或打包态 I4；
- 没有因为诊断需要改变“永不持久化现场音频”的产品语义。
