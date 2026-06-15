import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // catalyst serve exposes the function at /server/<function_name>/;
      // running `node index.js` directly also accepts this prefix (shim in index.js)
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => `/server/ksp_datathon_2026_function${path}`,
      },
    },
  },
})
