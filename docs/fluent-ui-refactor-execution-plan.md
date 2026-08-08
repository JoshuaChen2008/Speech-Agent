# Fluent 2 桌面界面渐进重构执行计划

> 状态：已决定 · 2026-08-08
> 语义：SEM-F23；联合旅程：J18；既有字幕/窗口边界：SEM-F20、SEM-F22、J15a、J17、I2 `dwm-drag`

## 1. 决策

- 保留 Electron 主进程、preload、字幕运行时、SQLite 和现有 IPC 契约。
- 四个可见 renderer 使用 TypeScript 与 Vite 多页面构建。
- 字幕窗和工具条保持直接 DOM；设置窗和字幕历史使用 React。
- Fluent 2 只提供 design token、动效、材质和图标指导，不引入 Fluent UI React 组件库。
- 保留设置与字幕历史现有信息架构，不新增搜索、权限、翻译或 Agent 能力。

## 2. 实施顺序

1. 先登记 SEM-F23/J18，并冻结生产 bundle、Mica、键盘、主题、动效和性能边界。
2. 接入 TypeScript、Vite MPA、开发/生产入口隔离、typecheck 和打包 allowlist。
3. 迁移字幕窗与工具条到 TypeScript 直接 DOM，并优化纯位移与多窗层级热路径。
4. 使用 React + TypeScript 重构设置窗，保留权威回执和模型资源语义。
5. 使用 React + TypeScript 重构字幕历史，保留版本、分页、导出和精修会话结果语义。
6. 用生产 bundle 闭合 J18、打包身份和严格报告；真实 Mica/DWM/DPI 继续进入 J15a/I2 实机矩阵。

## 3. 验收边界

- `npm test` 三条 lane、TypeScript 类型检查、Vite 生产构建和 package smoke 均需成立。
- 临时字幕高频更新不得重建根节点、自动改变 bounds 或产生持久化事实。
- 设置与字幕历史必须覆盖深色、浅色、系统高对比、键盘焦点和 reduced motion。
- 报告只保存枚举、布尔、计数、相对时长与哈希，不保存字幕正文、本地绝对路径、设备名、现场音频或绝对单调时刻。
- J18 确定性证据成立后状态可更新为「联合验收完成」；没有人工矩阵时不得把 Mica、DWM、DPI 或异缩放写成「实机验收完成」。

## 4. 提交门禁

每个较大阶段先暂存，由 `gpt-5.6-luna`、reasoning `max` 的只读 subagent 核对语义、正常回归、失败路径和组合 CI；阻断项修正并复核后才提交。
