import Appearance from '../ui/shared/appearance.js'
import CaptionReducer from '../ui/shared/caption-reducer.js'

window.Appearance = Appearance
window.CaptionReducer = CaptionReducer

await import('./caption.ts')
