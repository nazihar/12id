import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Plugin order from the TanStack Start docs: the Start plugin before React's. How the production
// build is served on Node (plain server entry with srvx, or Nitro) is settled by the C0 spike.
export default defineConfig({
  server: { port: 3600 },
  resolve: { tsconfigPaths: true },
  plugins: [tanstackStart(), viteReact(), tailwindcss()],
})
