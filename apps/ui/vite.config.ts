import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:4680" },
    // Sandbox previews are reached through the sprite's SSO-gated *.sprites.app
    // URL; transport auth happens there, so vite's Host check can stand down.
    allowedHosts: true,
  },
});
