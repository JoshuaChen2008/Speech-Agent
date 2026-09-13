状态：实现完成·尚未验收。以下任务已实现首次配置向导、三家服务预设和独立模型测试；完整 J25 与实机边界仍按测试策略记录。依据 [spec](specs/agent-model-settings-guidance/spec.md) 与 [design](design.md)。输入样式 change 仍独立，单独记录 J25 证据。

## 1. 展示文案与导航

- [x] 1.1 重读 CONTEXT 全文、SEM-F00/F23/F33、J25 和 UI 交接 §5.2/§12，核对 design 中展示别名与规范概念逐项对应。
- [x] 1.2 更新模型设置导航、页标题、用途说明、字段标签、按钮及可及名称；保留现有导航 ID 和内部 contract 字段，不全仓替换规范术语。
- [x] 1.3 在 view-model 中整理 readiness/scope/assignment/remote/配置错误的中文映射；写清配置充分不表示推理成功，未知网络原因不细分猜测。

## 2. 信息顺序与渐进呈现

- [x] 2.1 按 design 实现首次配置的连接→API 密钥→模型确认→测试（可跳过）与默认用途顺序，以及已有配置的默认模型摘要→服务管理顺序；新建表单通过明确按钮打开，默认用途必须明确设置。
- [x] 2.2 将配置标识和连接基础路径放到可达的高级区，保留两个地址字段与真实组合摘要；推导非法/冲突或隐藏字段校验失败时自动展开并定位。
- [x] 2.3 保留现有 DeepSeek 空模型模板、自定义连接和九命令分步回执；不播种新模板、不自动分配用途、不合并为原子提交。
- [x] 2.4 把模型获取/手动添加与六字段确认组织为独立区域；建议只预填，未知不默认为否，显示来源日期与能力说明，显式确认后才保存。
- [x] 2.5 默认用途保持可见，其他三个用途按需展开，分别展示使用默认模型或实际二元组；保留用途缺项、能力不匹配及用量未知提示。
- [x] 2.6 保留密钥设置/清除和敏感草稿清理机制；折叠不写入或发网，失败不自动重发、覆盖权威状态或撤销此前成功阶段，键盘顺序与可及名称匹配视觉顺序。

## 3. 受影响验证

- [x] 3.1 调整既有 `test/ui/agent-model-settings-ui.test.js` 的真实 view-model 行为断言，覆盖映射、默认用途未配置、建议待确认及六值 remote 说明；避免整页快照或孤立文案关键词堆砌。
- [ ] 3.2 在正式 J25 设置旅程及 fixture 中验证首次空模板、自定义连接、同服务多个模型、同服务商独立配置、显式默认用途、专用用途折叠/reload 和建议零写入，使用真实产品模块。
- [ ] 3.3 在同一真实旅程覆盖目录失败仍可手填、能力缺项禁止提交、配置冲突不自动推进、session_only 重启后 absent、输入/高级区键盘恢复；保留 Agent Bar→模型运行绑定→SQLite/history 的既有断言。
- [ ] 3.4 执行 `npm run test:focus -- test/ui/agent-model-settings-ui.test.js test/ui/renderer-style-guard.test.js`；再 `npm run verify:renderer` 与 `npm run test:focus -- test/integration/agent-redesign-j25-formal-settings-journey.test.js test/integration/agent-redesign-j25-model-comparison-journey.test.js`，不因改名削弱旧断言。
- [ ] 3.5 人工走读首次配置与已配置两条路径，核对用户无需理解档案/adapter/recipe 即可找到下一动作；核对长中文标签、键盘、高对比与窄窗口，未观察范围如实记录。

## 4. 文档与交付

- [x] 4.1 更新 UI 交接的实际实现记录、术语映射与本 change TODO；区分展示别名和规范定义，不提升无对应证据的 J25 状态。
- [ ] 4.2 列出实际命令、结果、失败/未验证范围并核对 SEM-F14 隐私；PR/合并或阶段联合验收使用当前 revision 完整 CI 或一次 `npm test`，定向结果不代表公网、系统凭据或实机验收。

## 5. 扩展的向导、预设与模型测试

- [x] 5.1 在只读 preset registry 登记 `deepseek-openai@1`、`openai-gpt-4.1-mini@1`、`qwen-beijing@1` 的精确连接、model、region、六字段应用上限、来源日期、helpId 和 strategyVersion；model row 与 formal binding 追加保存策略元数据，保留 DeepSeek 空模板事实，不自动播种用户配置，不改写既有 migration checksum。
- [x] 5.2 新增 `agent-model-test-ui@1.0.0` exact contract、settings-only main IPC 与 preload facade，提供预设公开投影和 `testSavedModel`/`cancelSavedModel` 闭集回执；测试不调用 bind、不发 changed、不写配置/绑定/历史/正文/报告。
- [x] 5.3 实现首次四步向导与已有配置管理路径，支持一次预设能力确认、详情展开、自定义六字段确认、中途退出恢复及北京地域说明。
- [x] 5.4 修正远端目录建议的鉴权失败路径，保持拉取零写入；新增模型测试与正式调用共用冻结的预设请求策略，不自动重试或切换模型；自定义模型使用固定兼容策略，未登记预设不得伪造 provider-specific 参数。
- [x] 5.5 扩展 J25 与 contract/main/runtime/storage/ui 测试，覆盖预设版本、策略、测试边界、revision 冲突、session_only、隐私负扫描和既有绑定不可变；新增 `test/contracts/agent-model-test-ui-contract.test.js`、`test/main/model-test-ipc.test.js`、`test/main/model-access-vault-runtime.test.js` 中的取消/迟到 revision 用例，并执行 `npm run test:focus -- test/contracts/agent-model-test-ui-contract.test.js test/main/model-test-ipc.test.js test/main/model-access-vault-runtime.test.js` 与独立测试段 integration 命令。
