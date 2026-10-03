import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import electron from 'vite-plugin-electron/simple';
import path from 'node:path';

export default defineConfig({
  base: './',
  plugins: [
    tailwindcss(),
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
          },
        },
      },
      preload: {
        input: path.join(__dirname, 'electron/preload.ts'),
        vite: { build: { outDir: 'dist-electron' } },
      },
    }),
  ],
  resolve: {
    alias: [
      { find: /^@shared\/(.*)/, replacement: path.join(__dirname, 'shared/$1') },
      { find: /^@\/(.*)/, replacement: path.join(__dirname, 'src/$1') },
    ],
  },
  build: { outDir: 'dist' },
});
