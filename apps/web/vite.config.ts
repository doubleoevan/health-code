import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
	envDir: false,
	plugins: [react()],
	build: { manifest: true, rollupOptions: { input: "src/client/client.tsx" } },
})
