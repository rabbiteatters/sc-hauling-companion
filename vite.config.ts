import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // SCMDB has no CORS — proxy data dumps in dev for live Demo fills
      '/scmdb-data': {
        target: 'https://scmdb.net',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/scmdb-data/, '/data'),
      },
    },
  },
})
