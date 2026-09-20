## Why

设置页新增的部分 `<input>` 未声明 type，现有 `input[type="text"]` 样式无法匹配，导致其使用浏览器默认表面，与已有 Fluent 2 控件不一致。需要修复覆盖并明确主题、焦点和失败状态的验收边界。

状态：实现完成·尚未验收；定向证据见 TODO，实机观察待补。关联 SEM-F23/T04/T05/T06、J18/J25。

## What Changes

- 统一设置页文本、密码、数字、下拉和多行输入的主题表面、轮廓、圆角、字体与间距。
- 覆盖省略 type 的文本输入；保留 color/range/checkbox/radio 的专用外观。
- 补充真实生产设置表单的计算样式、键盘焦点、禁用与失败状态检查。
- 与 [模型设置规划](../simplify-agent-model-settings/proposal.md) 分开实现与验收，本 change 不调整文案及页面信息顺序。

## Capabilities

### New Capabilities

- `settings-input-appearance`: 登记设置页输入控件一致性的可观察要求；属于既有 SEM-F23/J18 的细化，不新增产品业务能力。

### Modified Capabilities

无；当前 `openspec/specs/` 无对应主 spec，本次以独立增量登记，不改写其他进行中的 change。

## Impact

实际涉及 `src/settings/settings.css`及 `src/ui/shared/tokens.css` 语义层；select 外观沿用既有 `src/ui/shared/select.css` 唯一 owner，本 change 不在 `settings.css` 重复定义。验证涉及既有样式守卫和正式 J25 设置旅程。不得修改 main/preload、存储、模型接入或窗口几何。本轮更新设置样式、共享输入语义 token、既有正式 J25 fixture/断言及本 change 证据；未修改 TSX 或业务接口。
