import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Set base for GitHub Pages:
  // if deploying to https://USERNAME.github.io/REPO_NAME/
  base: '/REPO_NAME/',

  // if deploying to https://USERNAME.github.io/ (user/organization site),
  // use base: '/' or remove it entirely.
})
