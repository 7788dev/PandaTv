import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/noto-sans-sc'
import '@fontsource-variable/noto-serif-sc'
import '../../design/styles/index.css'
import './app.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
