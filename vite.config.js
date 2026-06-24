import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Allow access through the Cloudflare quick-tunnel (HTTPS for phone mic testing)
    allowedHosts: [".trycloudflare.com"],
  },
});
