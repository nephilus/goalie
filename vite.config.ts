import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
export default defineConfig({ plugins: [reactRouter(), tailwindcss()], server: { host: '127.0.0.1', port: 4310, strictPort: true } });
