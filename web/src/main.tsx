import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@antenna/styles.css';
import './app.css';
import { App } from './App';
import { useStore } from './store';

if (import.meta.env.DEV) Object.assign(window, { store: useStore });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
