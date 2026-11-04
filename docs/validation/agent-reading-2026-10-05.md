# 会话总结与会话问答阅读呈现验证

记录覆盖：2026-10-05至2026-10-06。关联：SEM-F31/F38/F40、SEM-T04、J29/J22/J30/J18；程序构建边界为SEM-F18/F19/T12。状态：**实现完成·尚未验收**。

模型输出说明要求一段一个主题、短段落、独立事项，问答先直接回答再解释依据；内容不足时保留待核对事项。展示复用一个正文组件，支持段落、清单、小标题、重点强调与行内代码。超过240 Unicode code point的正文按约180 code point在完整句子边界分段；短文本、长句和无句末边界的正文不强制切开。React文本节点保留可见内容，HTML、链接、图片与代码围栏不执行。保存正文、来源与结果Schema不变，查看旧结果不调用模型。

排版取向参考[W3C的标题与留白建议](https://www.w3.org/WAI/tips/designing/)和[视觉呈现说明](https://www.w3.org/WAI/WCAG21/Understanding/visual-presentation.html)：控制行宽，增加行距与段间留白，按内容分组；不据此声称完整WCAG资格。

## 定向检查

- `node --test --test-name-pattern="result paragraphs|existing long summary" test/ui/agent-ui.test.js`：实现前0/2，确认原样显示格式标记与长正文单段的缺口。
- `npm run test:focus -- test/contracts/agent-recipes-contract.test.js test/ui/agent-result-text.test.js test/ui/agent-ui.test.js test/ui/renderer-style-guard.test.js`：79/79。
- `npm run test:focus -- test/integration/personal-memory-question-journey.test.js test/integration/session-summary-j29-memory-journey.test.js test/integration/session-summary-budget-recovery-journey.test.js test/integration/session-question-window-journey.test.js`：40/40。
- `npm run verify:renderer`：返回0。网络边界提供受控结果，内部请求服务、模型接入层、Loop、SQLite与renderer使用真实实现；确认保存后重读的正文与来源、长输入归并及既有失败/取消路径。

10月6日补充：真实问答出现个人记忆引用结构拒绝后，新增完整逐结论示例回归初次为0/1。补强输出说明后，`npm run test:focus -- test/contracts/agent-recipes-contract.test.js test/contracts/agent-output-diagnostics.test.js test/ui/agent-result-text.test.js test/ui/agent-ui.test.js test/ui/renderer-style-guard.test.js`为83/83；上述四条integration文件再次执行为40/40。后续真实复核发现根字段遗漏，列出全部七个必填根字段与显式`coverage:null`；最终`node --test test/contracts/agent-recipes-contract.test.js`为10/10，包含逐字段删除仍拒绝及根/逐结论的非法记忆引用仍拒绝，`npm run verify:renderer`返回0。重复检查不累加为新测试项。

浏览器只读取合成预览的DOM与计算样式，未读取或发送用户会话正文。正文字号14.85px、行高26.73px、相邻段间距14.85px；1280px浅色及520px深浅主题无横向溢出。旧长正文呈现为5段，主题小标题为语义化h3。浏览器截图接口未取得图像，这些指标不替代人工视觉验收。

## 独立程序核对

10月5日采用生产配置`electron-builder.config.cjs`生成独立Windows x64目录，未替换旧程序，该目录未启动。两项native构建检查均返回0；ASAR中351个运行时源文件与当时工作区逐字节一致，包括25个renderer文件，源码声明文件数为0，两项产品native addon均解包，入口为`src/main.js`。

| 产物 | SHA-256 |
|---|---|
| ASAR | `9b39affcfefcc019bfaeea100950f3da7da7559e18d25237c2f14731acb2d42c` |
| 程序 | `92c29cb55137bd473d54b1382f5372fda20ef3f62e86e3d5fccad96680cfd8d9` |

10月6日按相同生产配置重新构建包含最终字段说明的独立Windows x64目录；实际命令为`electron-builder --config electron-builder.config.cjs --win dir --x64 --publish never --config.directories.output=成品软件/Speech-Agent-2026-10-06-阅读排版`，返回0。351个运行时源文件与最终工作区逐字节一致，遗漏及额外源文件均为0；包含25个renderer文件，没有源码声明文件，两项产品native addon均解包，入口保持`src/main.js`。核对脚本首轮因ASAR路径未按Windows分隔符规范化而失败；修正探针后返回0，该探针错误未计作产品断言。证据JSON仅保留计数、布尔和哈希。

| 10月6日产物 | SHA-256 |
|---|---|
| ASAR | `789e30117e6d5a03e8a59ae91384ed8c4c502a0498f904958f99652bd34cb389` |
| 程序 | `719644362e07b48b3447a9f60dc9b1c8cd5e999182b5a139612d5f9bd5a3de43` |

## 隔离合成会话的真实模型核对

只向既有受信任DeepSeek连接发送合成会话；没有复制或发送用户字幕与个人记忆，没有启动音频采集。配置及既有数据库只读，选定连接的密文凭据在隔离临时目录中使用，未保存明文。正式请求服务、模型接入层、Agent Loop、utility storage worker与SQLite均使用生产实现，网络没有替代；此探针直接受理请求，不经生产UI提交。

补强说明前，多轮问答在模型响应后被拒绝。其中一轮根字段完整、逐结论字段完整，但真实校验错误的哈希与`MemoryRefV1 must be a plain object`对应；另一轮少一个根字段。这些证据确认结构及引用问题，不是输入容量拒绝，不将其归因推广到缺少字段诊断的旧失败记录。修订只补强说明与有效示例，未补造字段、清洗非法引用或放松结果校验。[DeepSeek官方JSON Output说明](https://api-docs.deepseek.com/guides/json_mode/)要求提示明确JSON结构；JSON模式的合法语法不替代本项目字段和来源校验。

最终说明对同一91段、18,127 bytes合成会话执行两轮独立生成，每轮实际调用3次模型（总结、意图路由、问答）。

| 结果指标 | 第1轮 | 第2轮 |
|---|---:|---:|
| 总结概要段数 | 3 | 4 |
| 总结独立结论/待办/风险项数 | 15 | 15 |
| 问答正文段数 / 小标题数 | 6 / 5 | 7 / 5 |
| 问答有依据逐结论数 / 待核对项数 | 3 / 4 | 5 / 5 |
| 总结来源数 / 问答来源数 | 6 / 2 | 6 / 3 |

两轮的总结及问答均生成并保存，正式交互重读的结果哈希一致；组合正文保留较晚日期修订，未把待办当作已执行。子进程各自然退出返回0，隔离数据目录已清理。报告保存正文摘要哈希、段数、来源数、错误枚举及字段计数，不保存原始输出。仅两轮合成样本不能证明模型永远遵循结构；非法结构仍显式失败且无部分结果。

## 未验证范围

尝试启动隔离的生产Electron窗口，但Computer Use对新应用的访问授权两次超时，未取得新窗口的实际点击及视觉证据。初次沙箱GPU子进程启动异常、探针数据库迁移/加密状态初始化及启动器输出管道问题均属于验证环境或探针问题，调整后真实服务探针自然退出；不据此断言产品界面故障或成功。

未执行用户实际会话外发、新程序实机交互、完整三条lane、B5或I4。目录及哈希不替代已绑定revision/run的发布验收产物；旧结果阅读的分段属于呈现，不改写已保存正文。
