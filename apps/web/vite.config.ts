import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The screen is built to static files (dist/) that the core serves.
// While developing, `npm run dev:web` serves it on port 5173 and passes
// API calls on to the core. Start the core with
// HOMEBASE_DEV_HOSTS=localhost:5173 so it accepts that address.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:7117" } },
  build: { outDir: "dist", emptyOutDir: true },
});
