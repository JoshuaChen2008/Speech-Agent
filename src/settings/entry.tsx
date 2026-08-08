import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import '../ui/shared/manual-window-drag.js'
import { SettingsView } from './settings-view'

const root = document.getElementById('root')
if (!root) throw new Error('settings root is missing')

flushSync(() => createRoot(root).render(<SettingsView />))
