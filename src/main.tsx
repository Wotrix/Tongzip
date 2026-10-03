import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import './styles/app.css';

// 主题初始化:先读设置再挂载,避免闪白
void (async () => {
  try {
    const s = await window.tz.getSettings();
    const dark = s.theme === 'dark'
      || (s.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    if (s.accent && s.accent !== 'blue') document.documentElement.dataset.accent = s.accent;
  } catch {
    document.documentElement.dataset.theme = 'light';
  }
  window.tz.onThemeChanged((dark) => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  });
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
})();
