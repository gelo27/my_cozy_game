import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { isMobileDevice } from './world/WorldSettings';

// Touch screens get the compact HUD (Tailwind `touch:` variant)
if (isMobileDevice()) document.documentElement.classList.add('touch-ui');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
