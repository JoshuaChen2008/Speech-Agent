# Typeless voice-first Agent 调研

> 调研日期：2026-08-28
>
> 结论先行：Typeless 更接近“系统级 AI 语音键盘 / 上下文操作层”，而不是以聊天记录、长期自主规划和工具面板为中心的通用 Agent。它把当前输入框或用户选中的文字作为上下文，把一句语音作为意图，再把结果原地写回或用轻量浮层呈现。

## 1. 官方资料能确认的 UI 形态

- 桌面端有一个常驻应用外壳，提供 Home、History、Dictionary 和 Settings 等入口；官方安装引导把 Dictate、Translate、Ask anything 作为三项主能力，并用快捷键和示例引导用户完成首次体验。[安装与设置](https://www.typeless.com/help/installation-and-setup)、[Settings](https://www.typeless.com/help/quickstart/settings)
- 高频交互不是打开主窗口，而是在当前应用中按全局快捷键后出现 Voice bar。Dictate 的默认桌面流程是：点击任意文本框、按一次快捷键、看到 Voice bar 或听到交互音后说话、再按一次快捷键结束，整理后的文字回到原文本框。[首次听写](https://www.typeless.com/help/quickstart/first-dictation)、[Dictate](https://www.typeless.com/help/quickstart/dictate)
- Translate 复用同一个 Voice bar；用户可以在 Voice bar 上选择目标语言，结束后翻译结果回到原来的文本框。目标语言可在 Settings 中预先维护多个并排序。[Translate](https://www.typeless.com/help/quickstart/translate)
- Ask anything 仍然是短暂的上下文浮层，而不是长期聊天页：可编辑的选中文本通常原地替换；开放问题或针对只读选中文本的回答显示在弹出面板；草稿则写入当前输入框。[Ask anything](https://www.typeless.com/ask-anything)
- 低频管理界面承担 History、Dictionary、Personalization 和 Settings：History 可按 All、Dictations、Ask anything 筛选；Dictionary 支持自动添加、手动添加、编辑、删除和 CSV 导入；Settings 管快捷键、麦克风、语言、主题、交互音、是否暂停其他音频和登录启动。[History & Dictionary](https://www.typeless.com/help/quickstart/history-and-dictionary)、[Settings](https://www.typeless.com/help/quickstart/settings)、[Personalization](https://www.typeless.com/help/quickstart/personalization)

可以把它抽象成下面这条 UI 路径：

```text
任意文本框 / 选中文本
        ↓ 全局快捷键
轻量 Voice bar：收音、状态、目标语言
        ↓ 一句话表达意图
原地替换文本 / 弹出答案 / 打开搜索结果

常驻应用：Home · History · Dictionary · Settings
```

## 2. 功能边界

### Dictate：把自然口述变成可直接发送的文字

Typeless 官方强调的不是逐字转写，而是对口述意图做整理：去掉填充词和重复，识别说到一半的自我修正，自动组织列表/步骤/要点，并按语气、应用场景和个人表达习惯润色。[官方主页](https://www.typeless.com/)

### Translate：说一种语言，直接得到另一种语言的成稿

翻译会尽量保留语气和用途，不只是逐词替换；桌面端可以提前配置多个目标语言。[Translate](https://www.typeless.com/help/quickstart/translate)

### Ask anything：对当前上下文做一次受控操作

官方列出的典型动作包括：

- 重写：变短、变长、改变正式程度、友好程度或风格；
- 阅读：总结、解释、提取行动项、分析选中文本；
- 写作：起草邮件、回复、社交媒体内容；
- 查询：查最新信息、搜索 Google/YouTube/Amazon/GitHub 等并打开相应页面；
- 语言与格式：翻译、生成列表或 Markdown 结构。

这些动作由语音触发，但结果落点由上下文决定：需要改写的内容原地更新，需要回答的问题进入小面板，需要外部信息时才打开搜索页面。[Ask anything](https://www.typeless.com/ask-anything)、[Voice Superpowers 发布说明](https://www.typeless.com/help/release-notes/macos/voice-superpowers)、[Personalized & Smarter 发布说明](https://www.typeless.com/help/release-notes/macos/personalized-smarter)

### 记忆与个性化：偏好层，不是完整个人知识库

Typeless 提供 Personalization 和 Dictionary。前者根据表达模式调整正式/随意、简洁/详细等风格；后者保存人名、项目缩写、行业词汇，且可由用户手动维护。官方将 Personalization 描述为抽象风格模式，不保存实际消息或口述内容。[Personalization](https://www.typeless.com/help/quickstart/personalization)、[History & Dictionary](https://www.typeless.com/help/quickstart/history-and-dictionary)

## 3. 它和主流聊天式 Agent 的关键区别

以下是基于官方功能描述的产品归类：

| 维度 | Typeless | 传统聊天式 Agent |
|---|---|---|
| 入口 | 当前文本框 + 全局快捷键 | 独立聊天窗口或网页 |
| 上下文 | 光标位置、选中文本、当前应用 | 聊天历史、上传文件或显式提示 |
| 输入 | 自然语音意图 | 主要是键盘输入 |
| 输出 | 原地替换、当前输入框成稿或轻量弹出回答 | 聊天消息、工具面板或独立产物页 |
| 运行模型 | 一次短命、目的明确的上下文操作 | 可持续多轮、规划、工具调用和任务状态 |
| 用户感受 | “说一句，当前这段文字就变成我想要的样子” | “和一个 Agent 对话，让它完成一项任务” |

因此，Typeless 可以有 Agent Loop 或受控工具，但产品表面刻意不让用户看到“Agent 正在思考”。它的核心竞争力是零切换、零复制粘贴和低认知负担。

## 4. 对本项目的可迁移方向

当前仓库的 Agent 仍分成两层：字幕系统独立负责采集、实时 ASR、字幕显示、定稿持久化和历史；Agent 系统消费已经越过字幕提交边界的文本。当前隔离 Agent 内核开发入口已有独立的会话、聊天、后台任务和参考产物 UI，但正式字幕接线、正式产品 UI、个人记忆和完整 J21/J22 旅程仍未形成产品证据。参见 [Agent 插件、个人记忆与 Provider 架构](../agent-plugin-architecture.md) 和 [隔离入口 UI 交接](../agent-ui-ux-handoff.md)。

若按 Typeless 特化，建议把正式 Agent 的主形态收敛为：

1. 用户在字幕历史中选定一个会话、若干字幕段，或明确选择权威原始转写/精修稿；
2. 通过一个紧凑的 Agent bar 发出一次意图：整理、翻译、提取待办、解释、增强表达或询问；
3. 只把选定的 `sessionId + transcriptVersion + inputWatermark + digest` 作为本次上下文；
4. 改写/翻译显示为独立派生文本预览，问答显示在侧边或浮层；权威原始转写永不被覆盖；
5. 会后结构化纪要仍可由 `MeetingStopped` 触发，但它是后台 Agent 任务，不应成为主 UI 的聊天首页；
6. Agent Loop、工具事件和重试留在后台，前台只显示简短状态、结果、来源和必要的执行预览。

这会把现有 Agent UI 从“会话列表 + 聊天 + 任务/产物调试台”转成“选定字幕上下文 + 一次语音意图 + 派生结果”。现有三栏调试台可以继续保留为隔离 Agent 内核开发入口，不必作为正式用户入口。

## 5. 不应直接照搬的部分

- Typeless 的全局麦克风命令输入会和本项目 `mic` / `loopback` 单路互斥、Agent 不控制音频/ASR 的边界发生设计耦合。若正式加入语音命令，需要新增并登记独立的命令输入契约；在此之前可先采用全局快捷键 + 文字输入或停止会话后的明确语音操作。
- Typeless 的 History 文档目前提到下载原始音频；本项目的 SEM-F14 明确禁止保存现场音频、音频路径或相关产物，因此只能借鉴“可追溯文本历史”，不能复制该能力。
- Typeless 的个性化/Dictionary 不等价于本项目的个人记忆、记忆候选或确认关键词。后者必须继续遵循来源绑定、关闭休眠、未来会话生效和识别 provider 能力边界。
- Typeless 的搜索与打开页面属于外部动作；本项目 Agent 首版仍应维持内容型插件和受控写入，不把系统操作、任意网络或外部服务写入带进字幕路径。

## 6. 官方来源

- [Typeless 官方主页](https://www.typeless.com/)
- [Ask anything](https://www.typeless.com/ask-anything)
- [Installation & Setup](https://www.typeless.com/help/installation-and-setup)
- [Dictate](https://www.typeless.com/help/quickstart/dictate)
- [Translate](https://www.typeless.com/help/quickstart/translate)
- [History & Dictionary](https://www.typeless.com/help/quickstart/history-and-dictionary)
- [Settings](https://www.typeless.com/help/quickstart/settings)
- [Personalization](https://www.typeless.com/help/quickstart/personalization)
- [Voice Superpowers 发布说明](https://www.typeless.com/help/release-notes/macos/voice-superpowers)
- [Personalized & Smarter 发布说明](https://www.typeless.com/help/release-notes/macos/personalized-smarter)
