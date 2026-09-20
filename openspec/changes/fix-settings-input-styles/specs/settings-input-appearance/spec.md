## ADDED Requirements

### Requirement: Settings inputs share theme-aware appearance

设置页 SHALL 为文本（包括无 type）、密码、数字、URL、搜索、邮箱、select 和 textarea 提供同源字体、表面、边框、圆角和间距，消费共享语义 token。关联 SEM-F23/J18。

#### Scenario: Model configuration fields receive component styling
- **WHEN** 用户打开生产设置页并展开新建或编辑模型配置档案表单
- **THEN** 名称、地址、基础路径和模型输入具有应用主题样式，无 type 文本输入与显式 text 的表面、字体和圆角一致，密码与数字输入同源
- **AND** color/range/checkbox/radio 保持专用外观与原有操作语义

#### Scenario: Theme changes preserve readability
- **WHEN** 用户切换深色、浅色、自动主题或进入系统高对比
- **THEN** 输入文字、占位说明与轮廓可辨认，组件不遗留浏览器默认白底，普通主题遵守 token 切换，高对比允许系统色接管

### Requirement: Input states remain accessible without layout movement

设置输入 SHALL 保留可及名称和键盘路径，展示可见焦点，区分禁用、只读与已有错误状态；悬停和聚焦不得改变控件外部尺寸。关联 SEM-F23/T04、J18/J25。

#### Scenario: Keyboard and pending interaction
- **WHEN** 用户用 Tab 到达输入并发出既有配置命令
- **THEN** 焦点轮廓可见，等待回执期间受限控件不可重复提交，文字保持可读，reduced motion 不产生新增循环动画

#### Scenario: Existing command fails
- **WHEN** 配置命令返回已登记的失败回执
- **THEN** 页面展示文字错误并恢复可编辑状态，错误不能只依赖颜色；样式改动不改变权威配置、输入清理规则或错误码

### Requirement: Forms fit existing settings bounds

设置页 SHALL 在既有窗口边界内保持输入与动作可达，允许行换行和页面纵向滚动，不改变窗口几何或输入校验。关联 SEM-F23/J18。

#### Scenario: Long values and enlarged text
- **WHEN** 用户在既有最窄设置窗口输入长地址或模型名，或将界面文字放大
- **THEN** 字段和保存动作无横向裁切，单行控件可以内部滚动文本，多行控件可纵向调整，页面不出现由表单撑宽造成的横向滚动
