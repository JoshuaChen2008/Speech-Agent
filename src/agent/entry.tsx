import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { AgentView } from './agent-view'

const root = document.getElementById('root')
if (!root) throw new Error('agent root is missing')
flushSync(() => createRoot(root).render(<AgentView />))
