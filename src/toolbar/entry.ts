import Icons from '../ui/shared/fluent-icons.ts'
import * as AppearanceModule from '../ui/shared/appearance.js'
import * as RuntimeViewModule from '../ui/shared/runtime-view.js'
import '../ui/shared/fixtures.generated.js'
import '../ui/shared/manual-window-drag.js'
import { resolveLegacyUmdApi } from '../ui/shared/legacy-umd-api'

const Appearance = resolveLegacyUmdApi(
  AppearanceModule,
  window.Appearance,
  'applyAppearance',
  'appearance'
)
const RuntimeView = resolveLegacyUmdApi(
  RuntimeViewModule,
  window.RuntimeView,
  'buildRuntimeView',
  'runtime-view'
)

window.Icons = Icons
window.Appearance = Appearance
window.RuntimeView = RuntimeView

await import('./toolbar.ts')
