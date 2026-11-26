import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const port = Number(process.env.PORT || 3001);

export default defineConfig({
  plugins: [react()],
  root: "client",
  publicDir: "public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": `http://127.0.0.1:${port}`,
      "/media": `http://127.0.0.1:${port}`,
    },
  },
});
