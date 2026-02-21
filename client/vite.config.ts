import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@mping/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    host: true,
    // Use mkcert-generated certs so browsers show a green padlock instead
    // of a "Not Secure" warning. Run `mkcert -install` once on your machine
    // to trust these certs system-wide (already done).
    https: {
      key: fs.readFileSync(path.resolve(__dirname, "../cert-key.pem")),
      cert: fs.readFileSync(path.resolve(__dirname, "../cert.pem")),
    },
    proxy: {
      "/socket.io": {
        target: "http://localhost:3001",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
