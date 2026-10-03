# 个人记忆内容导出与只读 MCP 验证记录

状态：实现完成·尚未验收。关联 SEM-F43/F44、J28-EXPORT/MCP、J21/J12/DB7。

实现：正式设置页选择、预览、复制、Markdown/JSON 原子导出；默认关闭的本机 Streamable HTTP MCP，仅暴露三个只读工具。预览和授权绑定精确条目、当前修订与记忆目录身份；每次读取重新核验文件和 SQLite。无 schema 迁移，无新增依赖。

验证命令与结果：

- `npm run verify:renderer`：退出码0，类型检查与生产 renderer 构建成功。
- `npm run test:focus -- test/integration/personal-memory-sharing-journey.test.js test/integration/personal-memory-file-journey.test.js test/integration/personal-memory-electron-journey.test.js test/main/personal-memory-file-ipc.test.js test/validation/b5-packaging-contract.test.js`：29项断言测试，29成功、0失败、0跳过。
- 新增范围、条数和真实写失败断言后，单独运行 sharing journey：4项成功、0失败、0跳过。
- `test/ui/renderer-style-guard.test.js`：10项成功、0失败。

生产 Electron 旅程使用真实 main、preload、renderer、utility process、SQLite 和文件 Worker；保存对话框与剪贴板为受控系统边界。验证复制与导出一致、真实 HTTP 初始化与授权读取、停止共享、重启关闭，读取期间模型请求数为零。其它旅程覆盖未授权条目、令牌/Host/Origin拒绝、非法参数、请求超限、未确认修改、撤销、暂停与授权竞争，以及拒绝后字幕会话写入。报告只含布尔值；合成正文仅位于隔离临时测试目录。

未验证：第三方 MCP 客户端互操作、当前修改后的安装包/干净机、完整三条 lane 与发布验收。本记录不代替这些验收；未声称物理声卡或系统休眠恢复行为。
