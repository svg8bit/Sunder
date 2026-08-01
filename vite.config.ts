import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    outDir: "dist/client",
    sourcemap: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      "@sunder/sniper-engine": path.resolve(root, "packages/sniper-engine/src/index.ts"),
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client", "@solana/client", "@solana/react-hooks"],
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    allowedHosts: ["terminal.local", "localhost", "127.0.0.1"],
    warmup: {
      clientFiles: ["./src/main.tsx"],
    },
  },
  plugins: [react(), tailwindcss()],
});
