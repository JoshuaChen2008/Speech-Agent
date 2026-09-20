## 1. 登记
- [x] 1.1 固化 HEAD、工作树和未跟踪文件基线，登记批准 proposal/spec/design、ADR 与合同/J27。
- [x] 1.2 建立逐项文件、调用方、对象、测试与文档处置清单。
## 2. 存储
- [x] 2.1 迁出单一删除事务、保留历史回执并验证原子性和共享上下文。
- [x] 2.2 先建立失败升级测试，再实现历史迁移隔离、验证备份和追加退役迁移。
- [x] 2.3 实现分类失败、字幕降级、Agent/删除门控和重启重试状态。
## 3. 清理
- [x] 3.1 移除旧操作、四棵源码树、专属脚本/构建/测试，迁移可靠性断言。
- [x] 3.2 核查依赖消费者、更新锁文件（如需），收口文档/引用与 J27。
## 4. 验证和审核
- [x] 4.1 定向测试与完整三条 lane、renderer、smoke/release/package fresh/restart；已记录实际结果与环境限制：退役存储定向测试 24/24，`npm run verify:renderer` 返回 0，`npm run test:core` 932/932，`npm run test:evidence` 229/229（I3 报告按 `TZ=UTC --segments 3600 --batch-size 100` 重建，并按 product payload、runner 与 verifier 哈希绑定；报告生成于提交前工作树，不声明绑定完整 Git revision）；`npm run test:integration` 为 50/53，3 项分别为 `agent-bar-ipc-journey` 的 GPU/safeStorage 子进程退出、`renderer-development-entry-journey` 的开发启动退出码 1、`supervised-electron-exit` 的 GPU 导致 abnormal-exit；这些在观测到 GPU/utility 异常的 Windows Electron/加密执行环境边界中未形成可采纳证据。`npm run package:smoke`、`npm run package:release` 返回 0，smoke layout pass（453 ASAR 条目、5 native binary）；release layout 因本机 Authenticode inspection 非零未形成报告，NSIS lifecycle 也未形成可采纳报告，packaged fresh/restart 因 GPU fatal 未形成可采纳证据。整体仍为「实现完成·尚未验收」，不晋级实机或发布验收。
- [x] 4.2 两个独立 gpt-5.6-luna/max 只读审核，修复并由对应审核者复核。
- [x] 4.3 核查基线保留，交付清单、备份恢复说明、测试与审核结果，阻断关闭后进入提交交付。
