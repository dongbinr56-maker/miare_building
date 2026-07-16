import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// GitHub Pages 프로젝트 경로 (https://<user>.github.io/miare_building/)
export default defineConfig({
  base: '/miare_building/',
  plugins: [react(), tailwindcss()],
})
