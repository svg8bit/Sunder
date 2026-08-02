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
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "@tanstack/react-query"],
          "evm-vendor": ["viem", "wagmi", "wagmi/connectors"],
          "solana-vendor": ["@solana/client", "@solana/react-hooks", "@solana/kit"],
          "ui-vendor": [
            "lucide-react",
            "motion",
            "@radix-ui/react-dialog",
            "@radix-ui/react-popover",
            "@radix-ui/react-switch",
            "@radix-ui/react-tabs",
            "sonner",
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      "@sunder/sniper-engine": path.resolve(root, "packages/sniper-engine/src/index.ts"),
      buffer: path.resolve(root, "node_modules/buffer/index.js"),
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client", "@solana/client", "@solana/react-hooks", "buffer", "wagmi", "viem"],
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
