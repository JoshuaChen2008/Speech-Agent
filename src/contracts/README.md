# Runtime contract v1

`src/contracts` 是 renderer、preload、主进程和 workers 之间唯一可共享的运行事实。v1 使用 CommonJS、JSON fixtures 和无依赖运行时校验器；未知字段会被忽略，缺少或写错必需字段会被拒绝。

## RuntimeSnapshot

完整快照，而不是状态增量。`revision` 由 `SessionCoordinator` 在每次可观察迁移时递增。

| 字段 | v1 类型 | 语义 |
|---|---|---|
| `schemaVersion` | `1` | 契约主版本。 |
| `revision` | 非负整数 | 全局快照版本；UI 只接受更大的值。 |
| `sessionId` | `string \| null` | `idle/unavailable` 为 `null`；活动会话跨 pause/resume 保持不变。 |
| `phase` | `unavailable \| idle \| starting \| listening \| paused \| stopping \| recovering \| error` | 权威运行阶段。 |
| `capabilities` | `Capabilities` | 当前状态和已安装资源共同决定的可用操作。 |
| `sources` | `AudioSource[]` | 所有产品级音频来源。 |
| `model` | `ModelState` | 只暴露产品 profile，不暴露文件名或路径。 |
| `lastError` | `RuntimeError \| null` | 可展示、结构化且已脱敏的错误。 |

`AudioSource` 固定字段：

| 字段 | v1 类型 |
|---|---|
| `id` | 非空 string |
| `label` | 非空 string |
| `state` | `unavailable \| inactive \| starting \| active \| paused \| recovering \| error` |
| `level` | `0..1`；非 `active` 时必须为 `0` |

`ModelState` 固定字段：

| 字段 | v1 类型 |
|---|---|
| `state` | `missing \| downloading \| verifying \| ready \| error` |
| `profile` | `fast \| balanced \| accurate \| null` |
| `progress` | `0..1 \| null`；`ready` 时为 `1` |

`RuntimeError` 固定字段：`scope`（`audio/model/worker/translation/system`）、稳定的 `code`、可展示 `message`、`recoverable` 和 `nextAction`。

## Capabilities

| 字段 | v1 类型 |
|---|---|
| `schemaVersion` | `1` |
| `canStart` / `canPause` / `canResume` / `canStop` / `canRetry` | boolean |
| `canRefine` / `canTranslate` | boolean |
| `availableProfiles` | 去重后的 `fast/balanced/accurate` 数组 |
| `availableSourceIds` | 去重后的 source id 数组 |
| `translationTargets` | 去重后的 BCP-47 language tag 数组 |
| `limitations` | `{ capability, code, message, nextAction }[]` |

`limitations` 解释为什么一个产品能力不可用。它不能与对应的 `can* = true` 同时出现。

## CaptionEvent

| 字段 | v1 类型 | 语义 |
|---|---|---|
| `schemaVersion` | `1` | 契约主版本。 |
| `sessionId` / `sourceId` / `segmentId` | 非空 string | 同一段更新不得换 id。 |
| `sequence` | 正整数 | 在 `sessionId + sourceId` 范围严格递增。 |
| `revision` | 正整数 | 在 `sessionId + segmentId` 范围严格递增。 |
| `kind` | `partial \| final \| refined \| translated` | 更新类型。 |
| `t0` / `t1` | 非负有限秒数，`t1 >= t0` | 从 session start 起算的单调时间。 |
| `text` | string | 当前权威原文；非 partial 时非空。 |
| `translation` | `null \| Translation` | 只有 `translated` 事件非空。 |

`Translation` 固定字段为 `language`、非空 `text` 和 `basedOnRevision`。译文事件仍携带当前原文，并且自身 revision 更大；消费者只有在 `basedOnRevision` 与当前源文本 revision 匹配时才展示译文，避免旧译文覆盖新精修。

## CommandResult

| 字段 | v1 类型 | 语义 |
|---|---|---|
| `schemaVersion` | `1` | 所有跨边界消息一致带版本。 |
| `ok` | boolean | 命令是否被接受/完成。 |
| `code` | 稳定大写错误码；成功固定 `OK` | 程序分支依据。 |
| `message` | `string \| null` | 失败时为可展示文本；成功为 `null`。 |
| `recoverable` | `boolean \| null` | 失败时必填；成功为 `null`。 |
| `nextAction` | `retry \| open-settings \| open-model-manager \| request-permission \| null` | UI 可执行的下一步，不包含 IPC 名。 |

命令 pending 状态由后续完整 `RuntimeSnapshot` 表达，不在 `CommandResult` 里复制运行状态。

## 使用

```js
const { assertRuntimeSnapshot } = require('./src/contracts')
const fixtures = require('./src/contracts/fixtures')

assertRuntimeSnapshot(fixtures.runtime.listening)
```

校验器返回原对象，失败时抛出带字段路径的 `TypeError`。fixtures 被递归冻结，可由未来的 fake adapter、IPC 测试和 worker 测试复用，不能在测试或 UI 中原地修改。
