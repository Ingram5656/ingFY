import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 开发服务器固定端口 1420，见 src-tauri/tauri.conf.json
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
