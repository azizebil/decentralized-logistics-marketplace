import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "frontend",
  publicDir: false,
  server: {
    port: 5173,
    fs: {
      allow: [__dirname]
    }
  },
  preview: {
    port: 4173
  },
  build: {
    outDir: "../dist/frontend",
    emptyOutDir: true,
    chunkSizeWarningLimit: 700
  },
  resolve: {
    alias: {
      "@artifacts": path.resolve(__dirname, "artifacts")
    }
  }
});
