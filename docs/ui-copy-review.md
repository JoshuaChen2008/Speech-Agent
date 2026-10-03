# Speech-Agent 界面用语记录

日期：2026-10-02。状态：实现完成·尚未验收。关联 SEM-F11/F14/F23/F27/F30/F37/F38/F41/F42/T05；J10/J15b/J15c/J18/J20/J21/J25/J28-FILES/J29。

## 官方参考与采用方式

- [OpenAI Data controls](https://developers.openai.com/api/docs/guides/your-data) 使用 Your data、Data controls 组织数据使用与控制说明。Speech-Agent 采用“云端数据使用说明”，具体授权动作采用“允许发送到云端模型”。这是本产品中文展示选择，不声称是官方中文译名，也不套用 OpenAI 的保留或训练政策到其他供应商。
- [Pi Providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md) 区分服务商、API key、OAuth 和凭据保存。保留 API 密钥、AppKey、AccessKey、Token 等技术词；已查阅页面未提供与本产品相同的“云端披露”开关名称，不杜撰 Pi 的隐私承诺。
- [Microsoft Windows 界面写作](https://learn.microsoft.com/en-us/windows/apps/design/style/writing-style) 建议使用简洁、熟悉的语言；错误提示说明实际问题与下一步。

## 修改边界

界面标题采用 Speech-Agent，助手窗口称“字幕助手”，保留功能名“会话总结 / 会话问答”和概念“会话 / 精修稿”。内部领域术语与展示别名见 CONTEXT.md。不改包 ID、数据目录、数据库、协议、导出格式或模型提示词。高级诊断保留错误码和技术指标；常用页面不展示原始事件序号或配置修订号。记忆暂停、停止使用、删除分别说明数据是否保留。云端说明分别覆盖助手文字输入、识别音频、语义搜索内容。

## 验证记录

以下为此次展示修订的局部回归，不替代当前 revision 的完整三条 lane 或实机验收。

| 实际命令 | 结果 |
|---|---|
| `npm run verify:renderer` | 类型检查和生产 renderer 构建退出码 0 |
| `node --test --experimental-test-isolation=none "test/ui/**/*.test.js" test/main/refinement-notice.test.js test/main/window-layout-contract.test.js test/main/application-window-lifecycle-controller.test.js test/main/history-service.test.js` | 226 项断言测试，226 成功、0 失败；含 renderer 样式守卫 |
| `node --test --experimental-test-isolation=none test/ui/agent-settings-ui.test.js test/ui/agent-context-settings-ui.test.js` | 最后调整授权标签与记忆类别后，7 项成功、0 失败 |
| `node --test --experimental-test-isolation=none test/integration/history-review-journey.test.js test/integration/refinement-fallback-journey.test.js test/integration/nls-settings-renderer-journey.test.js test/integration/agent-redesign-j25-formal-settings-journey.test.js test/integration/personal-memory-electron-journey.test.js test/integration/session-summary-j29-memory-journey.test.js` | 首轮 11 项，8 成功、3 失败；失败均为历史/NLS 文案断言或记忆文件 Electron 旅程的旧授权文字定位器。已逐项更新，未放宽授权、数据或失败路径断言 |
| `node --test --experimental-test-isolation=none test/integration/history-review-journey.test.js test/integration/nls-settings-renderer-journey.test.js test/integration/personal-memory-electron-journey.test.js` | 修正上述断言与定位器后，6 项成功、0 失败；前述 6 文件合计 11 项均有成功结果 |
| `node --test --experimental-test-isolation=none test/integration/nls-recognition-runtime-journey.test.js test/integration/agent-redesign-j25-model-comparison-journey.test.js` | 25 项成功、0 失败；覆盖云端断连进度和模型比较 |

共 36 项受影响的确定性旅程测试有成功结果，其中包含生产 Electron 设置、助手生成/取消/恢复和记忆文件编辑/确认/独立语义搜索授权。字幕导出仍由真实 HistoryService 验证原有版本隔离与 `[原始版回退]` 标记。显示模型 ID 与配置标识以区分同名模型服务，移除普通结果卡中的配置修订号。

未执行全量 `npm test`，未进行真人逐屏可读性、实机音频、DWM、安装器或干净机验收。产品窗口名称已统一；安装器产品名、npm 包名、持久化目录和协议标识属于兼容性边界，本次不改动。开发设计基准页的历史架构说明不作为产品文案批量替换。
