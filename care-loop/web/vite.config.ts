import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The dev server proxies /api to the care-loopd service rather than enabling CORS on it: the browser
// then sees ONE origin in development, exactly as it does in production where `care-loopd serve`
// hands out these assets itself. Same-origin everywhere means the session cookie needs no special
// casing, and no CORS policy has to be written, reviewed, or kept honest.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.CARE_API ?? "http://127.0.0.1:3142",
        changeOrigin: false, // keep Host intact so Set-Cookie's domain stays the browser's origin
      },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
