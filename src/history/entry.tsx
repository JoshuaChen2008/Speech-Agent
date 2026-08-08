import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import '../ui/shared/manual-window-drag.js'
import { HistoryView } from './history-view'

const root = document.getElementById('root')
if (!root) throw new Error('history root is missing')
flushSync(() => createRoot(root).render(<HistoryView />))
