import Icons from '../ui/shared/fluent-icons.ts'
import Appearance from '../ui/shared/appearance.js'
import RuntimeView from '../ui/shared/runtime-view.js'
import '../ui/shared/fixtures.generated.js'
import '../ui/shared/manual-window-drag.js'

window.Icons = Icons
window.Appearance = Appearance
window.RuntimeView = RuntimeView

await import('./toolbar.ts')
