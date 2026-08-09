# ADR 0007：Agent 内核先通过隔离开发入口验证

- 状态：已决定
- 日期：2026-08-09
- 决策者：项目负责人
- 依赖：ADR 0002、ADR 0003、ADR 0005

## 背景

Agent 系统尚无运行实现。直接同时接入字幕停止事件、会后结构化纪要、个人记忆、确认关键词、本地模型管理和正式 UI，会把 Pi/Electron 兼容、能力权限、持久任务与产品业务语义混在同一个切片里，也会增加字幕系统回归面。

## 决策

1. 首个实现切片是隔离 Agent 内核开发入口，只验证 Pi Agent Loop、静态第一方插件 registry、能力白名单、`ModelGateway`、调试聊天、执行预览、固定 recipe 专用子 Agent、后台 Agent 任务与 SQLite 恢复。
2. 该入口拥有独立 main、renderer、preload、IPC access policy、utility process、userData、SQLite 和诊断目录；不得导入或启动正式字幕主进程。
3. 输入只使用由真实 storage worker 写入隔离 SQLite 的无音频合成终态会话。参考插件只能生成明确标记为 `reference-output` 的结构化产物，不实现会后结构化纪要、增强文本、个人记忆或确认关键词。
4. 首个真实 Agent 模型 provider 是用户配置的 OpenAI-compatible HTTPS 服务，并配一个只用于自动化测试的确定性 provider。本地 Agent 模型 provider 只冻结接口，留到正式 Agent 产品切片实现。
5. 开发入口、Pi 依赖和 Agent renderer 产物不得进入正式安装包或正式导航。隔离库的数据不迁移到正式产品 userData。
6. J23 只验收 Agent 内核。J21/J22 必须等真实字幕输入、个人记忆、固定业务工具和正式产品 UI 接入后分别闭合。

## 取舍

- 先隔离验证会多一个开发入口和候选 migration catalog，但能把 Pi ESM、Electron utility process、持久任务和权限失败独立定位。
- 云端参考实现使 Agent Loop 不依赖本机模型资源；代价是首次切片不能证明本地 Agent 模型工作，必须明确保留后续任务。
- 参考插件不是可丢弃 mock：它必须走真实 PluginHost、任务调度、storage worker、SQLite 和 Schema writer；只有模型 provider 是可替换外部边界。

## 关联

- 语义：SEM-F15、SEM-F16、SEM-F29
- 当前旅程：J23；J23 不计入 J13/J21/J22 的实现或验收证据
- 后续正式插件门禁：J13
- 后续产品旅程：J21、J22
