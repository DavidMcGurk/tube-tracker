import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initInstallPromptCapture } from './lib/install-prompt';
import './styles.css';

initInstallPromptCapture();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
