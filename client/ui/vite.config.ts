import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

// GitHub repository of the releases (P13, ADR 0026): the "own server" page of
// the client shows its release page. `make release RELEASE_REPO=owner/name`
// passes it as ROSTALK_RELEASE_REPO, the same variable the Rust shell reads.
const releaseRepo = process.env.ROSTALK_RELEASE_REPO?.trim() || "v4dikos1/RosTalk";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(releaseRepo)) {
  throw new Error(`ROSTALK_RELEASE_REPO must be owner/name, got ${releaseRepo}`);
}

// The WebView loads the built assets from disk, so every URL must stay
// relative. Port 1420 is the Tauri convention and matches devUrl in
// client/src-tauri/tauri.conf.json.
//
// `--mode server-setup` builds the second entry point, server-setup.html, for
// the separate rostalk-server-setup application (P13, ADR 0026) into
// dist-server-setup on port 1421. The client build (dist) does not contain it.
export default defineConfig(({ mode }) => {
  const serverSetup = mode === "server-setup";
  return {
  plugins: [react(), tailwindcss()],
  base: "./",
  define: {
    __ROSTALK_RELEASE_REPO__: JSON.stringify(releaseRepo),
  },
  clearScreen: false,
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
    },
  },
  server: {
    port: serverSetup ? 1421 : 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
    outDir: serverSetup ? "dist-server-setup" : "dist",
    rollupOptions: {
      input: path.resolve(root, serverSetup ? "server-setup.html" : "index.html"),
    },
    // Source maps stay off for now: the bundled UI is embedded into the client
    // binary and release builds are not debugged in place yet. Turn them on
    // together with the crash-report pipeline.
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**"],
    css: false,
    restoreMocks: true,
    // `make check` is the acceptance gate and can run while another worktree
    // compiles on the same machine; the default 5 s is not enough for jsdom
    // under that load (a 35 s suite took 136 s), and that is not a test failure.
    testTimeout: 15000,
  },
  };
});
