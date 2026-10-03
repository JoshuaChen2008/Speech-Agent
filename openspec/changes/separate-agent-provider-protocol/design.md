## Context

参照 tau 的 tau_ai 单次厂商交换思路，依赖首片恢复证据；保持 SEM-F33 凭据与冻结模型身份，验收 J25/J24/J30。

## Goals / Non-Goals

**Goals:** 统一一次模型调用的请求与响应，把厂商差异收进 adapter。
**Non-Goals:** 新厂商上线、动态插件、改变模型用途、runtime 循环迁移或 UI 改版。

## Decisions

1. 在模型接入层内部定义版本化 exchange 接口。统一请求含 messages、只含声明的 tools、outputContract、requestLimits、AbortSignal；凭据通过已有 vault 借用，不能进入可序列化合同。
2. 返回统一 message、toolCalls、finishReason、nullable usage；文本或工具参数增量在内存有界累积。只在确有 provider 流式事件时发布增量，JSON 响应可只发布开始/结束。不制造首 token 或百分比。
3. outputContract 包含格式与受控 Schema，adapter 处理 JSON 模式和声明方言；runtime 后续负责业务 Schema。模型能力不足明确拒绝，不静默丢掉结构化要求。
4. exchange 恰好一次外发，不执行工具、不自动重试、不选模型、不写数据库。toolCallId、多个调用的顺序、结束原因和 usage 未知均须保真；厂商 reasoning 不写日志/数据库或用户结果。
5. 首先从旧 adapter 中提取 exchange，旧循环门面只调用它，暂时保持唯一生产入口。下一片才迁移循环，禁止两条并行生产路径或按运行输入选路径。
6. 统一协议不抹掉诊断事实：受控错误区分鉴权、限流、暂不可达、超时、请求拒绝、响应无效、取消；原始正文只在有界内存内解析并丢弃。

## Risks / Trade-offs

过度抽象 → 仅抽取已有 DeepSeek 策略和通用 OpenAI-compatible 事实，不为未接厂商预造能力。新旧门面长期共存 → 下一片有明确删除任务。

## Migration Plan

先登记接口合同和 fixture，再切旧 adapter 使用 exchange；首片用户旅程保持同样结果。无需替换 SQLite 或移出 main 凭据宿主。接口可回退调用组合，不改历史绑定。

## Open Questions

流式 UI 不作为出口；以后接 SSE 需要单独用户价值与协议验收。
