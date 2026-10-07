// Probe: the project's own browser-test server and settings, with this folder's tests in place of
// the suite.
import path from "node:path";
import { defineConfig } from "@playwright/test";

const root = path.resolve(__dirname, "../../..");

export default defineConfig({
  testDir: __dirname,
  outputDir: path.join(root, "test-results-probe"),
  timeout: 240_000,
  workers: 1,
  use: { baseURL: "http://localhost:3317", browserName: "chromium", viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: "node scripts/smoke-server.mjs",
    cwd: root,
    url: "http://localhost:3317",
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
