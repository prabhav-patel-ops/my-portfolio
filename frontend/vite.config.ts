import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/my-portfolio/",
  server: { port: 5173 },
  build: { outDir: "dist", chunkSizeWarningLimit: 1800 },
});
