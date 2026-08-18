import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// @ts-ignore: allow side-effect CSS import without module declaration
import './style.css'
import DesktopLyricsApp from './DesktopLyricsApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DesktopLyricsApp />
  </StrictMode>,
)
