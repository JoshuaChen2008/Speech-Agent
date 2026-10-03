# Speech-Agent 界面实拍 · 2026-10-03

本次收录 23 张 Electron 实际窗口截图。用途是设计评审参考，不是界面原型，也不作为用户旅程验收证据。

## 采集条件

- 日期：2026-10-03（Asia/Singapore）；中断后沿用同一个独立临时应用数据目录继续采集。
- 系统：Windows；应用版本：v0.1.0；主题：自动，本次显示为深色。
- 数据：首次设置选择会议字幕；监听模式为系统音频；没有启动字幕会话。字幕必需模型未安装；AI 助手关闭；云端发送偏好关闭。
- 窗口：settings、toolbar、caption、history、agent 的实际 Electron renderer；截图包含窗口边缘与光标提示。
- 格式：保留截图工具返回的 JPEG 原始字节；未裁切、拼接、重绘或重新编码。下表记录工具返回的截图尺寸。透明的工具条和字幕窗以本项目窗口为背景采集。
- 源码：HEAD 为 `a591d4f098fc52c77ee5c596e82fb57dd46b340e`；工作区包含未提交变更，因此截图不代表该提交的纯净版本。没有改动产品源码。
- renderer manifest SHA-256：`852932f3604427ce5b87c6790243896e77fe44aae961c08916a9432b59242892`。
- renderer 构建文件指纹（24 个文件）：`704a2087534720d61a2e06c470efc25ee5cfa19a7a6f546accf34ed57b0cb8c5`。按相对路径排序，将各文件的 `路径 + NUL + SHA-256 + LF` 串联后再计算 SHA-256。

## 页面清单

| 编号 | 页面 | 入口 | 尺寸 | 状态与原图 |
| --- | --- | --- | --- | --- |
| 01 | 首次设置 | 启动应用 → 首次设置 | 882 × 623 | 新建独立临时应用数据目录；尚未选择监听模式。 [原图](01-onboarding.jpg) |
| 02 | 显示与字幕 | 工具条 → 设置 → 显示与字幕 | 882 × 623 | 首次设置选择会议字幕后；自动主题当前显示为深色。 [原图](02-settings-display.jpg) |
| 03 | 音频来源 | 工具条 → 设置 → 音频来源 | 882 × 623 | 监听模式为系统音频；未启动音频采集。 [原图](03-settings-audio.jpg) |
| 04 | 语音识别（上部） | 工具条 → 设置 → 语音识别 | 882 × 623 | 页面顶端；本地识别；云端识别配置为空。 [原图](04-settings-recognition-top.jpg) |
| 05 | 语音识别（下部） | 设置 → 语音识别 → 向下滚动 | 882 × 623 | 页面底部；云端数据使用说明未确认；未保存凭据。 [原图](05-settings-recognition-bottom.jpg) |
| 06 | 模型资源（下部） | 设置 → 模型资源 → 向下滚动 | 882 × 623 | 精修模型未安装；精修偏好关闭；未执行下载。 [原图](06-settings-resources-bottom.jpg) |
| 07 | 模型资源（上部） | 工具条 → 设置 → 模型资源 | 882 × 623 | 页面顶端；字幕必需模型未安装；未执行下载。 [原图](07-settings-resources-top.jpg) |
| 08 | 我的记忆（文件与检索） | 工具条 → 设置 → 我的记忆 | 882 × 623 | 页面顶端；未配置记忆文件；记忆搜索索引为 0 条。 [原图](08-settings-memory-top.jpg) |
| 09 | 我的记忆 · 记忆概览 | 设置 → 我的记忆 → 记忆概览 | 882 × 623 | 页面底部；个人记忆 0 条；保留概览与手动记忆输入控件。 [原图](09-settings-memory-overview.jpg) |
| 10 | 我的记忆 · 个人记忆 | 设置 → 我的记忆 → 个人记忆 | 882 × 623 | 个人记忆 0 条；没有输入或确认新记忆。 [原图](10-settings-personal-memory.jpg) |
| 11 | 我的记忆 · 会话要点 | 设置 → 我的记忆 → 会话要点 | 882 × 623 | 会话要点 0 条；未启动字幕会话。 [原图](11-settings-session-points.jpg) |
| 12 | 助手模型（AI 助手偏好） | 工具条 → 设置 → 助手模型 | 882 × 623 | 页面顶端；AI 助手关闭；不允许发送到云端；默认偏好。 [原图](12-settings-assistant-model-top.jpg) |
| 13 | 助手模型（默认模型与入口） | 设置 → 助手模型 → 向下滚动 | 882 × 623 | 默认模型未选；按用途与管理模型服务折叠。 [原图](13-settings-assistant-model-bottom.jpg) |
| 14 | 助手模型 · 模型服务 | 设置 → 助手模型 → 管理模型服务 | 882 × 623 | 展开服务列表；DeepSeek 空模型模板；未设置 API 密钥。 [原图](14-settings-model-services.jpg) |
| 15 | 助手模型 · 新增模型服务 | 设置 → 助手模型 → 管理模型服务 → 新增服务 | 882 × 623 | 空表单；无连接信息或密钥；未保存，已取消。 [原图](15-settings-new-model-service.jpg) |
| 16 | 关于 | 工具条 → 设置 → 关于 | 882 × 623 | 版本 v0.1.0；深色主题。 [原图](16-settings-about.jpg) |
| 17 | 工具条 | 启动应用 → 工具条 | 600 × 72 | 模型未就绪；未启动字幕会话；以本项目窗口作为透明背景。 [原图](17-toolbar.jpg) |
| 18 | 字幕窗 | 启动应用 → 字幕窗 | 922 × 190 | 尚未启动字幕会话；没有字幕内容；以本项目的字幕记录窗口作为透明背景。 [原图](18-caption-idle.jpg) |
| 19 | 字幕记录 | 工具条 → 字幕记录 | 1062 × 723 | 独立数据目录；暂无会话；未启动音频采集。 [原图](19-history-empty.jpg) |
| 20 | 字幕助手 · 初始界面 | 工具条 → 字幕助手 | 722 × 643 | 暂无会话；AI 助手关闭；生成记录区域持续显示“正在读取…”。 [原图](20-agent-initial.jpg) |
| 21 | 字幕助手 · 范围问答 | 字幕助手 → 范围问答 | 722 × 643 | 暂无所选会话；提问与提交控件禁用；未发送模型请求。 [原图](21-agent-range-qa.jpg) |
| 22 | 字幕助手 · 跨会话分析 | 字幕助手 → 跨会话分析 | 722 × 643 | 展开日期范围；未选择日期；暂无会话；保持实际控件布局。 [原图](22-agent-cross-session.jpg) |
| 23 | 字幕助手 · 项目空状态 | 字幕助手 → 跨会话分析 → 显示项目 | 722 × 643 | 无项目关联记忆；显示空项目提示；记录实际标题栏折行，未生成会话总结。 [原图](23-agent-project-empty.jpg) |

## 原图哈希

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| [01-onboarding.jpg](01-onboarding.jpg) | 26614 | `007922c8b073ccc3dc092c98ed379951bad333a60f0124fc7a7dd5a5d51f1656` |
| [02-settings-display.jpg](02-settings-display.jpg) | 38842 | `165c81eb3db1a1d11938248e87b23450b745c5d2326bf54b5a51a66d02f85d1a` |
| [03-settings-audio.jpg](03-settings-audio.jpg) | 28259 | `afbebefdc5810b064deebb7a1eb4ddf78bdf4494afbd57f69ff00e99f30f95a8` |
| [04-settings-recognition-top.jpg](04-settings-recognition-top.jpg) | 40947 | `19157d8dbc8c920b3beeca681eecc14300f1e7edf34031a91531a92976c6f95d` |
| [05-settings-recognition-bottom.jpg](05-settings-recognition-bottom.jpg) | 49848 | `c2293748cffc80c1d0fd59ebb5dc945599e7702cebd9fa9ed96b55ab41771702` |
| [06-settings-resources-bottom.jpg](06-settings-resources-bottom.jpg) | 49215 | `e9bba90c462aa133058c86a19f6ce504b98584bb64354f796b240e15674e5bd5` |
| [07-settings-resources-top.jpg](07-settings-resources-top.jpg) | 45445 | `f9e9017b48851800b92a0dbba9ba58765babbddb48a20ca1c231db5c8527ec79` |
| [08-settings-memory-top.jpg](08-settings-memory-top.jpg) | 56943 | `a2b78a17b74aaa0a712ae7014a594afc3eb2b32ceb553089023498b89c829537` |
| [09-settings-memory-overview.jpg](09-settings-memory-overview.jpg) | 54208 | `3e83ef1f92a84d5b06bb21d37df969517ab9c43e621affe1f936c3d5c49210e9` |
| [10-settings-personal-memory.jpg](10-settings-personal-memory.jpg) | 54403 | `5afd35887e735cc528c2c43c1447e5d06e86c86dc1664efef179c93213062021` |
| [11-settings-session-points.jpg](11-settings-session-points.jpg) | 55845 | `709e81037b581756948310c8cdcfc86183337e0c9369971c3286bf92049325a7` |
| [12-settings-assistant-model-top.jpg](12-settings-assistant-model-top.jpg) | 50136 | `9ee5a789efa7af4c656dc358f25cf0bd41b9611d254bf2af0df5cd4091faf076` |
| [13-settings-assistant-model-bottom.jpg](13-settings-assistant-model-bottom.jpg) | 49337 | `73734e593255aa223ea900d1120c9c52528f52da4efb5dd09beebb783ea7743f` |
| [14-settings-model-services.jpg](14-settings-model-services.jpg) | 44669 | `9fe62cf5743ccb77e90f689c542cdf40491f9490a99cd3dea5f92d71ce80e781` |
| [15-settings-new-model-service.jpg](15-settings-new-model-service.jpg) | 37394 | `66634bafd3b7b0634c1c320fc4a8a932eef200d93e6906885f6025c085fa88f5` |
| [16-settings-about.jpg](16-settings-about.jpg) | 23330 | `bc147ec323d3bb72d20369d87e44345686f39faef1e5fbeb2eb196f2765bf522` |
| [17-toolbar.jpg](17-toolbar.jpg) | 4037 | `20c6c80849483e673dec9db49a459e9b91b3b52b603110ec2a7dbb554fd73d80` |
| [18-caption-idle.jpg](18-caption-idle.jpg) | 6650 | `575d8c03f0f8f54af635ba436b1a9fde248107c489d32b74dcb52c1a9a0ca4d5` |
| [19-history-empty.jpg](19-history-empty.jpg) | 31417 | `cfd2d69b6a2b0dbcf0f6a11c330ddb22ff779e935319b3f1cc6ff0ac1c147497` |
| [20-agent-initial.jpg](20-agent-initial.jpg) | 29363 | `68d4f91247dcafac27b64c566fd6f4b5a13d189d8fd6ac660a32b602ec9bd1df` |
| [21-agent-range-qa.jpg](21-agent-range-qa.jpg) | 32325 | `d6d1b8e815bfec37e0808ffa4533eceb9b884ef72f9c30106a4607f65d9f3522` |
| [22-agent-cross-session.jpg](22-agent-cross-session.jpg) | 37405 | `3e8565fa95b728901ee127213db98adeaf7bb99840a689669b0c92fc79fc6831` |
| [23-agent-project-empty.jpg](23-agent-project-empty.jpg) | 39284 | `3956cdb7c8a89e1dbda6b1257e06767f80132d157c75121f3c58cdada62c9f28` |

## 观察与未覆盖范围

- 字幕助手的生成记录区域在多次界面读取后仍显示“正在读取…”。本次记录实际外观，没有定位原因或更改实现。
- 跨会话分析的日期控件在默认窗口宽度下比较拥挤；显示空项目提示后，标题栏关闭按钮发生折行。原图保留这些现象。
- 在暂无会话和结果的状态下点按“全部结果”，没有出现新增结果面板；没有重复保存近似相同的截图。
- 本次未覆盖有内容的字幕流、字幕记录详情/导出、会话总结结果、待确认记忆详情、真实运行/取消/错误流程、凭据保存、模型下载、浅色主题及其他尺寸/DPI。空状态不能证明这些场景的布局。

## 检查与语义边界

采集前执行 `npm run verify:renderer` 与 `npm run build:native`，均为退出码 0；通过受监督入口启动实际应用。受限沙箱中的 GPU 启动异常属于执行环境记录，不作为产品断言；后续窗口采集来自沙箱外的实际应用。

23 张原图的尺寸与 SHA-256 已逐项核对，194 条本地文件链接已核对；最新浏览页的分类、搜索和原图查看器已实际操作核对。未运行新的功能验收。本次没有现场音频产物，没有真实字幕或记忆数据，也没有模型请求。参考 SEM-F14、SEM-F23、SEM-T01/T02/T03 与 J18/J25/J15/I2；这些截图不改变任何用户能力的验收状态。

## 维护规则

**仅在用户明确要求更新时更新。** 不因代码改动、应用启动或提交自动重拍；不创建后台任务。下次采集创建新的日期目录，同日使用递增后缀，保留本次原图和记录；只在明确要求时更新最新入口与覆盖范围。

[本次浏览页](index.html) · [档案说明](../../README.md)
