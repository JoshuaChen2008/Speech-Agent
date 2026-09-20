## Context

状态：实现完成·尚未验收。依据 [proposal](proposal.md)、[规范术语](../../../CONTEXT.md)、[视觉规范](../../../docs/ui-design-brief.md) §2.3/§2.6、SEM-F23 与 J18/J25。

实施前代码核查发现 `settings.css` 只匹配显式 text/password/number 与 select；`agent-model-pane.tsx` 的名称、服务器地址、基础路径、模型标识等省略 type。这说明样式匹配存在缺口，尚未进行实机视觉复核。个人上下文 textarea 已有局部样式，需要核对一致性而非假定全部控件失效。

## Goals / Non-Goals

**Goals:** 设置页输入控件接入同一视觉规则；普通、悬停、焦点、禁用、只读和已有校验失败状态可辨认；窄宽度下可操作。

**Non-Goals:** 文案、页面顺序、字段校验规则、提交行为、凭据生命周期、全局控件库抽取、Agent Bar 重设计、字幕排版及窗口几何。

## Decisions

1. `settings.css` 负责设置范围内显式 text/password/number/url/search/email、无 type 文本输入和 textarea；select 统一消费 `src/ui/shared/select.css`，该文件是所有选择控件的唯一 owner。color/range/checkbox/radio/button/hidden 不进入通用输入外观。补显式 type 可增强语义，但不能单靠逐处补属性避免以后再次漏样式。
2. 复用 `--radius-control`、字体、前景和现有语义表面；确需新增的表面/轮廓 token 只在 `tokens.css` 语义层定义。组件不写字面色、主题分支或渐变。保留克制的中性表面，不增加玻璃效果、装饰阴影或动画。
3. 单行输入/select 使用一致的最小高度（目标 36 CSS px）、`6px 10px` 内边距与 border-box；多行输入维持至少 70 CSS px 并允许纵向调整；行布局可换行，长 URL/模型名不撑宽页面。尺寸是布局目标，字体放大时允许增高，不能裁切文字。
4. keyboard focus 使用共享可见轮廓，hover 不产生布局偏移。disabled 与 readonly 保留可读文字；已有错误使用文本加轮廓，不添加新业务错误。焦点与高对比不依赖半透明色差。
5. 样式守卫检查 token 边界；真实生产 J25 设置旅程补计算样式、焦点、禁用和已有命令失败场景，作为 J18 设置表面的联合证据。不能以源码包含某选择器替代渲染证据，也不为纯圆角改动新增孤立单测。

## Risks / Trade-offs

- [选择器过宽] → 验证 color/range/开关未受影响；不改控件原生语义及键盘动作。
- [修复后仍显突兀] → 对真实页面做深/浅/自动主题、高对比、键盘及字体放大检查；CSS 计算值不冒充人工可读性或真实 DWM 证据。
- [与第二个 change 修改同一 TSX] → 建议先落实本 change；后者复用控件规则，只调整结构和文案。两份 TODO 分别记录证据。

## Migration Plan

无数据或配置迁移。按 tasks 实现后可独立交付；回退只撤销本 change 的样式及控件属性，不回退用户配置。正文和密钥不进入验证 JSON；只记录指标、布尔和哈希。

## Open Questions

设置窗当前固定为 880 × 620、`resizable: false`，没有独立最小宽度；以该既有窗口为基准。额外 renderer 放大只作为布局压力证据，不能冒充 100/125/150/200% 系统缩放观察，不修改 BrowserWindow 几何。当前首配向导输入一并消费通用规则，页面文案和信息顺序按现有实现保留。
