## Context

依赖 separate-agent-provider-protocol。当前 executor 外壳和 adapter 内循环职责重叠；本片实现 SEM-F28/ADR0016 的唯一 Agent Loop，覆盖 J22/J24/J30/J31。

## Goals / Non-Goals

**Goals:** 一个循环拥有工具、消息、轮次与预算；所有 recipe 和长输入节点复用它。
**Non-Goals:** 新增工具、改变 recipe 授权、改变重试次数、切换框架或产品入口。

## Decisions

1. Agent 执行宿主 runtime 接受冻结 recipe、模型运行绑定、输入计划节点及受控工具接口；不 import Electron、renderer、vault 或 SQLite 实现。
2. 循环顺序固定为预算/取消检查 → 持久请求预留 → 一次 exchange → 统一响应验证 → 工具权限/参数/预算核对与执行 → 追加观察或业务产物 Schema 校验 → 终止/下一轮。
3. 同一轮多个工具调用按登记策略执行；只有实际执行才产生工具调用记录。取消和失租在外发、执行工具、产物提交前均有屏障。
4. runtime 管理局部重试，操作层管理持久 attempt；二者读取同一冻结账本。沿现有 agent-retry@1/旧策略解释；局部耗尽不得触发外层无条件重放。非合作 provider 仍由宿主期限收束并处理迟到 reject。
5. recipe 系统指令、结构化输出合同和工具授权集中登记，模型不能改变预算/轮次。输出用量缺失保持 null。长输入每节点共享 run/attempt 预算，不能重置。
6. 在唯一组合根一次切换至 runtime 循环并删除旧 adapter 中的循环/工具执行/重试逻辑。保留版本兼容解释器，不保留重复循环。对现有 Pi 接入做事实核对；本片不引入第二框架。

## Risks / Trade-offs

重复预留/重试导致耗尽 → 真实 SQLite 跨 attempt 旅程。工具中途取消后迟到提交 → 身份代次和终态屏障。迁移破坏长输入 → 复用同一节点测试。

## Migration Plan

以首片与长输入旅程作为行为基线，逐 recipe 对照但生产仅单一循环；旧绑定格式不变。相关 lane 及当前 revision 完整 CI/本地全量验证后迁移出口成立。

## Open Questions

实施前盘点当前 Pi 实际调用与文档的差异并登记缺口，不能将命名当作接入证据。
