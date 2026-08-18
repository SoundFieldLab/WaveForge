import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import DesktopPlayerApp from './DesktopPlayerApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DesktopPlayerApp />
  </StrictMode>,
)
