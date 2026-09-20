状态：实现完成·尚未验收。样式与定向确定性证据已落实，2.4 实机观察尚未取得。依据 [spec](specs/settings-input-appearance/spec.md) 与 [design](design.md)。按当前已有首配向导与模型表单实现，证据不替代模型设置文案 change。

## 1. 核查与样式实现

- [x] 1.1 重读 CONTEXT 全文及 SEM-F23/T04、J18/J25 增量，核对设置页实际输入清单和无 type 的漏样式字段。
- [x] 1.2 在设置页补齐通用输入选择器及必要控件属性，确保 color/range/checkbox/radio 等专用控件不被覆盖。
- [x] 1.3 统一字体、语义表面、边框、圆角、单行最小高度和内边距；多行输入保留纵向调整，行布局在窄窗口换行。
- [x] 1.4 补齐 hover/focus-visible/disabled/readonly/已有错误的外观及高对比轮廓；复用共享 token，必要新增只在语义层。

## 2. 受影响验证

- [x] 2.1 执行 `npm run test:focus -- test/ui/renderer-style-guard.test.js`；若改 TSX，执行 `npm run verify:renderer` 的类型检查与生产构建。
- [x] 2.2 在既有正式 J25 设置旅程及其 fixture 中扩展真实生产表单的计算样式、Tab 焦点、提交 pending、命令失败恢复检查，同时验证色彩选择、滑块和开关不受影响；作为 SEM-F23/J18 设置表面子边界，不新增仅匹配 CSS 字符串的孤立测试。
- [x] 2.3 先 `npm run verify:renderer`，再 `npm run test:focus -- test/integration/agent-redesign-j25-formal-settings-journey.test.js`。保留真实 renderer/preload/main/SQLite，仅替代网络/provider/系统凭据外部边界。
- [ ] 2.4 人工核对深/浅/自动主题、高对比、reduced motion、长值、既有最窄窗口及 100/125/150/200% 系统缩放下的可读与可操作性；未取得观察的组合明确列为未验证，不以计算样式代替实机结果。

## 3. 文档与交付

- [x] 3.1 更新本 change 的实际文件、命令、结果及未验证范围；依 SEM-T05 写状态，定向证据不晋级完整 J18/J25 或实机门禁。
- [x] 3.2 核对仅涉及本 spec 的外观和属性；模型文案、信息顺序、数据与接口未混入。PR/合并或阶段联合验收使用当前 revision 完整 CI 或一次 `npm test`，无新风险不重复成功检查。

## 2026-09-13 实施与证据

- 产品文件：`src/settings/settings.css`、`src/ui/shared/tokens.css`。输入共用主题表面、字体、8px 圆角、36px 单行最小高度；textarea 保持 70px 最小高度和纵向调整。禁用不再降低整控件透明度，只读使用虚线轮廓，已有 `aria-invalid` 使用错误边框。表单行换行、内容区可收缩，用途下拉不再强制 220px 最小宽度。未修改 TSX、校验、main/preload、存储或窗口几何。
- 验证文件：`scripts/fixtures/formal-agent-j25-settings-journey.js`、`test/integration/agent-redesign-j25-formal-settings-journey.test.js`。fixture 先经真实首启场景选择解除遮罩，再操作可见表单；真实内部产品模块和既有 loopback provider 边界保持不变。对真实 configure 回执短暂等待，仅观测 pending 后放行原 handler，不替换结果。
- `npm run verify:renderer`：返回码 0，TypeScript 检查与生产 Vite 构建成立。
- `npm run test:focus -- test/ui/renderer-style-guard.test.js test/integration/agent-redesign-j25-formal-settings-journey.test.js`：返回码 0，10/10。随后增加专用颜色/滑块即时预览、颜色复位和真实 hover 命中断言，再执行 `npm run test:focus -- test/integration/agent-redesign-j25-formal-settings-journey.test.js`：返回码 0，1/1。期间修正 textarea 最小高度的选择器优先级，以及 fixture 在首启遮罩后操作隐藏表单的既有缺口。
- 覆盖：无 type、密码、数字、用途下拉、个人上下文 textarea、首配向导密码/模型/数字；生产主题按钮的深/浅/自动切换；真实 Tab 焦点、hover 前后尺寸；已配置凭据的非法连接命令返回失败，输入保留、权威地址不变、恢复编辑且重复提交受限；颜色/滑块/开关专用边界。URL/search/email/text 类型与 readonly/aria-invalid 是临时施加在真实输入上的受控样式状态，恢复属性后不写配置，不声称产品新增这些字段或校验。
- 高对比与 reduced motion 使用 Chromium 媒体模拟；1/1.25/1.5/2 倍使用 renderer zoom 和长值布局检查。它们不证明 Windows 系统缩放、真实 Mica/DWM 或人工可读性。2.4 的深/浅/自动/高对比、reduced motion 与 100/125/150/200% 系统缩放实机组合均未取得人工观察，保持未勾选。当前设置窗固定 880 × 620、不可拉伸，未新增最小窗口尺寸。
- 报告只新增布尔值与计数，负扫描包含 fixture 凭据；未保存现场音频或新增证据 JSON。未运行完整 `npm test`，本次不是 PR/合并或阶段联合验收。

## 已移交并修复的独立缺口

早期失败探针曾观察到：未配置凭据的模型配置档案提交非法 HTTP origin 时，存储拒绝该连接，但模型接入层可能返回 `ok: true`。该缺口已由独立 change [`fix-model-config-failure-receipts`](../fix-model-config-failure-receipts/) 修复；正式 J25 旅程验证 `MODEL_CONFIG_INVALID`、配置 revision 与档案不变且不广播 changed。此处只保留历史发现与责任边界，不再作为待实现事项。
