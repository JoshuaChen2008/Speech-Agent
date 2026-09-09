# 开发反馈与 CI 测试组合调研

调研日期：2026-09-08。本文提供外部依据和实施建议；项目规则以 `docs/semantic-contract.md` 的 SEM-T01/T02/T03、`docs/testing-strategy.md` 为准，不形成新的验收结论。

## 外部依据

| 依据 | 对本项目的含义 |
|---|---|
| npm 会在用户脚本前后自动执行同名 `pre` / `post` 脚本。[npm 生命周期文档](https://docs.npmjs.com/cli/v11/using-npm/scripts/#pre--post-scripts) | 调研开始时，三个 `pretest:<lane>` 都调用 `verify:renderer`；`npm test` 串联三个 lane，因此重复 typecheck 与 Vite build，CI 还另有显式构建。应由组合入口统一准备一次，再执行选定测试；单独执行 lane 仍要保证前置产物正确。 |
| Node 22 支持按文件和测试名选测，但名称过滤不会减少加载的文件；关闭进程隔离后，全部文件被导入同一进程，顶层测试并发度为 1。[Node 22 test runner](https://nodejs.org/download/release/latest-v22.x/docs/api/test.html#test-runner-execution-model)、[名称过滤](https://nodejs.org/download/release/latest-v22.x/docs/api/test.html#filtering-tests-by-name) | 优先用明确文件集合缩小反馈范围。现有 `--experimental-test-isolation=none` 下不应把增加 `--test-concurrency` 当作直接提速方案；改隔离模型要另行验证全局状态、子进程和资源清理。 |
| 《The Practical Test Pyramid》建议优先快速、窄范围反馈，承认快速集成测试可与单元测试处于同一阶段；跨层重复断言会增加执行和维护成本。[原作者文章：流水线与重复测试](https://martinfowler.com/articles/practical-test-pyramid.html#PuttingTestsIntoYourDeploymentPipeline) | 测试按速度和证明范围安排。先消除重复构建和重复执行；删测试须先证明其断言已由其它测试承担。不能仅因两项使用相同 fixture 或碰到相同模块就判重复。 |
| 多个触发事件会创建多个 workflow run；`push` 可按分支限定。[GitHub workflow 语法](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#using-multiple-events) | 调研开始时同时接受所有分支 push 和 PR；有 PR 的分支 push 可能触发两轮。可采用主分支 push + 所有 PR + 手动执行，保留合并后回归，代价是未建 PR 的功能分支不自动运行。 |
| workflow 被路径过滤跳过时，required check 可能保持 Pending；job 条件跳过则报告成功，依赖失败还可能造成下游跳过。[GitHub required checks 排障](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#handling-skipped-but-required-checks) | 若引入路径选择，保持一个总会执行且校验必要 job 结果的稳定检查；无法可靠判定变更范围时回落完整确定性回归。不要仅在 workflow 顶层加 `paths-ignore: ['docs/**']`，本仓库文档含产品语义和测试契约。 |
| `actions/setup-node` 的 npm 缓存使用锁文件哈希，但不缓存 `node_modules`。[setup-node 官方说明](https://github.com/actions/setup-node#caching-global-packages-data) | 现有 CI 已开启 `cache: npm`。继续 `npm ci`，不要把依赖下载缓存命中当作依赖安装、Electron runtime 或构建产物已满足的证明。 |

## 建议的开发节奏

1. 每轮小修改只执行相关文件测试及必要守卫；例如纯颜色或图标调整走 renderer 样式守卫，不自动启动全套 Electron/NSIS。涉及 renderer 行为时补类型检查、生产构建及相关旅程。
2. 改变用户能力、跨模块契约或失败语义时，执行相关确定性联合测试；例如字幕排版对应 J15，Agent Bar 与正式 Agent 交互对应 J21/J22/J24。内部产品模块保持真实实现，外部边界替身不能扩展到内部模块来换取速度。
3. 未知影响范围、公共契约、依赖/锁文件、测试调度或广泛重构，回落完整确定性回归；完整 CI 和发布资格仍保留明确入口。一次小改的定向结果不冒充联合、实机或发布验收。
4. 本地定向结果有效且代码未再次变化时，不为每条回复重复执行相同检查。交付只列执行范围、失败摘要、未运行范围及原因，避免输出所有成功测试名。
5. 删除测试前写明替代位置及相同失败条件。保留每项用户能力的跨模块旅程，保留对错误边界、持久化与隐私约束的独立证明；本次调研不支持无依据批量删除现有测试。

以上是结合官方行为和本仓库约束作出的建议，不是这些来源要求所有项目采用同一测试频率。对构建次数的收益可以静态计数；实际耗时改善需要在同一环境测量，本文未给出未经测量的提速百分比。
