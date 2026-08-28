import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// @ts-ignore: allow side-effect CSS import without module declaration
import './style.css'
import DesktopLyricsApp from './DesktopLyricsApp'
import ErrorBoundary from '../components/ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary compact>
      <DesktopLyricsApp />
    </ErrorBoundary>
  </StrictMode>,
)
