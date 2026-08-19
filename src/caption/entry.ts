import * as AppearanceModule from '../ui/shared/appearance.js'
import * as CaptionReducerModule from '../ui/shared/caption-reducer.js'
import { resolveLegacyUmdApi } from '../ui/shared/legacy-umd-api'

const Appearance = resolveLegacyUmdApi(
  AppearanceModule,
  window.Appearance,
  'applyAppearance',
  'appearance'
)
const CaptionReducer = resolveLegacyUmdApi(
  CaptionReducerModule,
  window.CaptionReducer,
  'createState',
  'caption-reducer'
)

window.Appearance = Appearance
window.CaptionReducer = CaptionReducer

await import('./caption.ts')
