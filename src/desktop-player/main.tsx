import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import DesktopPlayerApp from './DesktopPlayerApp'
import ErrorBoundary from '../components/ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary compact>
      <DesktopPlayerApp />
    </ErrorBoundary>
  </StrictMode>,
)
