import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { startAppUpdates } from './lib/app-updates';
import { initInstallPromptCapture } from './lib/install-prompt';
import { startSync } from './lib/sync';
import './styles.css';

initInstallPromptCapture();
startSync();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

startAppUpdates();
