本切片为待评审规划；所有实施任务未执行。先登记后实现，文档结构校验不构成产品验收。

## 1. 接口登记

- [ ] 1.1 核对首片证据与 SEM-F33/J25；登记 exchange 合同、错误和事件字段，核对既有在途 diff。
- [ ] 1.2 定义版本化 messages/tools/outputContract/requestLimits 与响应 fixture，拒绝未知字段及凭据序列化。

## 2. 协议提取

- [ ] 2.1 提取单次 HTTP 交换，保留受信任 origin、redirect 拒绝、凭据借用释放及有界响应读取。
- [ ] 2.2 实现 DeepSeek 与通用 OpenAI-compatible 既有策略归一化，覆盖工具 ID/顺序、nullable usage、finishReason、JSON 和取消。
- [ ] 2.3 旧 adapter 循环门面只调用 exchange，删除重复 HTTP 拼装；不同时引入第二条生产路径。

## 3. 验证与交接

- [ ] 3.1 以网络替身驱动真实 model-access/adapter 验证一次 exchange 恰好一次外发、零工具执行/重试；覆盖畸形响应和超限。
- [ ] 3.2 运行首片正式总结与 J25/J24/J30 回归，按影响范围执行 lane；阶段全量由当前 revision CI/本地承担。
- [ ] 3.3 记录接口与现存循环门面清单，交给 runtime spec 删除；不新增厂商产品承诺。
