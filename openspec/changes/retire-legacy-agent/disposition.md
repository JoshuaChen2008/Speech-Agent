# 退役逐项处置清单

删除前 HEAD：118d77e070d458199917b8137466b4f684d5e193。用户原有改动另存基线，不属于本清单成果。

## 旧源码/专属验证删除

- `src/runtime/storage-worker/formal-agent-store.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `scripts/formal-agent-storage-utility-smoke.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `scripts/fixtures/formal-agent-utility-worker.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `vite.agent-mvp.config.mts`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `test/storage/agent-mvp-store.test.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `test/runtime/formal-agent-runtime.test.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `test/runtime/agent-utility-process-boundary.test.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `test/runtime/agent-mvp-services.test.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `test/runtime/agent-core.test.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `test/integration/agent-redesign-j27-userdata-isolation-journey.test.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `test/integration/agent-mvp-electron-journey.test.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `test/integration/agent-core-journey.test.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `test/integration/formal-agent-three-task-journey.test.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `test/integration/formal-meeting-minutes-journey.test.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `test/integration/formal-agent-lifecycle-journey.test.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `test/integration/formal-agent-storage-utility-journey.test.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `test/storage/formal-agent-schema.test.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/canonical-json.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/contracts.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/errors.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/formal/bounded-merge.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/formal/contracts.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/formal/enhanced-transcript-plugin.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/formal/input-planner.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/formal/job-runner.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/formal/meeting-minutes-plugin.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/formal/memory-consolidation-plugin.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/formal/memory-extraction-plugin.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/formal/model-gateway.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/formal/plugin-host.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/formal/storage-ports.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/job-runner.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/model-gateway.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/pi-agent-adapter.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/plugin-host.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/reference-output.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/storage/agent-store.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-core/storage/schema.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-mvp/agent-service.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-mvp/agent-worker.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-mvp/credential-vault.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-mvp/main.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-mvp/preload.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-mvp/protocol.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-mvp/renderer/global.d.ts`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-mvp/renderer/icons.tsx`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-mvp/renderer/index.html`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-mvp/renderer/main.tsx`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-mvp/renderer/styles.css`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-mvp/rpc-utility-host.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-mvp/runtime-host.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-mvp/settings-store.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-mvp/smoke-harness.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-mvp/storage-service.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-mvp/storage-worker.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-provider/model-provider-registry.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-provider/provider-bootstrap.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-runtime/agent-utility/agent-utility-worker.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-runtime/agent-utility/plugin-proxy.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-runtime/agent-utility/protocol.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-runtime/agent-utility/service.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-runtime/agent-utility/worker-entry.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-runtime/agent-utility/worker-host.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。
- `src/agent-runtime/formal-agent-runtime.js`：旧执行专属；可靠性由现行 scheduler/loop/model-access、删除与升级/J27 测试承担。

## 混合职责保留与修改

## 文档与引用

- `docs/agent-mvp-engineering-handoff.md`、`docs/agent-mvp-interface-contract.md`、`docs/agent-mvp-todo.md`、`docs/agent-plugin-architecture.md`、`docs/agent-mvp-minimal-chain-spec.md`：不再作为当前设计入口；保留为不可变历史留档并加退役声明。
- `docs/formal-agent-mvp-todo.md`、`docs/agent-context-ui-contract.md`、`docs/agent-ui-contract-requests.md`、`docs/agent-ui-ux-handoff.md`：保留现行职责，移除“隔离入口仍可启动/继续使用”的当前语义，统一指向 `src/agent/**` 与 ADR 0019。
- `docs/agent-redesign-execution-plan.md`、`docs/data-architecture.md`、`docs/runtime-architecture.md`、`docs/semantic-contract.md`、`docs/testing-strategy.md`：保留历史日期记录，新增 v10 退役状态、备份/恢复/失败降级边界，并明确旧路径/对象只用于不可变审计。
- `PLAN.md` 与 `docs/research/**`：排期或一手研究历史，不作为当前实现输入；不因退役切片改写历史正文。

- `src/runtime/storage-worker/schema.js`：保留现行职责，移除旧调用或调整防回归断言。
- `src/runtime/storage-worker/sqlite-store.js`：保留现行职责，移除旧调用或调整防回归断言。
- `src/runtime/storage-worker/worker-service.js`：保留现行职责，移除旧调用或调整防回归断言。
- `src/runtime/storage-worker/protocol.js`：保留现行职责，移除旧调用或调整防回归断言。
- `src/runtime/storage-worker/worker-host.js`：保留现行职责，移除旧调用或调整防回归断言。
- `src/runtime/storage-worker/personal-context-store.js`：保留现行职责，移除旧调用或调整防回归断言。
- `src/main/services/storage-gateway.js`：保留现行职责，移除旧调用或调整防回归断言。
- `test/storage/personal-context-store.test.js`：保留现行职责，移除旧调用或调整防回归断言。
- `test/storage/context-ingest-s3.test.js`：保留现行职责，移除旧调用或调整防回归断言。
- `test/storage/storage-worker-service.test.js`：保留现行职责，移除旧调用或调整防回归断言。
- `test/storage/storage-worker-host.test.js`：保留现行职责，移除旧调用或调整防回归断言。
- `test/main/storage-gateway.test.js`：保留现行职责，移除旧调用或调整防回归断言。
- `test/integration/product-entry-legacy-agent-isolation.test.js`：保留现行职责，移除旧调用或调整防回归断言。
- `scripts/verify-package-layout.js`：保留现行职责，移除旧调用或调整防回归断言。
- `src/main/services/product-payload-identity.js`：保留现行职责，移除旧调用或调整防回归断言。

## 数据库对象

退役的 15 个表及顺序以 `src/runtime/storage-worker/retirement-migration.js` 的精确清单为准；它们的索引和触发器随所属表删除。保留全部其它表、现行计数、历史回执和 v1-v9 SQL/checksum。隔离候选 schema 仅迁至 historical-isolated-migrations.js 以验证 catalog 拒绝，不提供入口。
