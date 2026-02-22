import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";

// Check if SSL certs exist (only for local development)
const certKeyPath = path.resolve(__dirname, "../cert-key.pem");
const certPath = path.resolve(__dirname, "../cert.pem");
const hasSSLCerts = fs.existsSync(certKeyPath) && fs.existsSync(certPath);

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
    // HTTPS only for local development when certs are available
    ...(hasSSLCerts && {
      https: {
        key: fs.readFileSync(certKeyPath),
        cert: fs.readFileSync(certPath),
      },
    }),
    proxy: {
      "/socket.io": {
        target: "http://localhost:3001",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
