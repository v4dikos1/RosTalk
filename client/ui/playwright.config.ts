import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: "ru-RU",
    colorScheme: "dark",
    trace: "off",
  },
  webServer: [
    {
      command:
        "npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      // rostalk-server-setup (P13): dist-server-setup is built by the
      // `npm run build` above; the URL waits for it.
      command:
        "npx vite preview --mode server-setup --host 127.0.0.1 --port 4174 --strictPort",
      url: "http://127.0.0.1:4174/server-setup.html",
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
  ],
});
