import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import TaskWindow from './components/TaskWindow';
import FolderView from './views/FolderView';
import { ToastHost } from './components/ui';
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
  // 一套 bundle 三路分流:task=独立任务窗 / folder=独立文件夹浏览窗 / 其余=主窗
  const q = new URLSearchParams(location.search);
  const kind = q.get('window');
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {kind === 'task' ? <TaskWindow />
        : kind === 'folder' ? (
          <ToastHost>
            <FolderView dir={decodeURIComponent(q.get('dir') ?? '') || 'C:/'} standalone />
          </ToastHost>
        )
        : <App />}
    </React.StrictMode>,
  );
})();
