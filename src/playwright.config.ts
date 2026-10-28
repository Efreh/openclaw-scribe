import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./spec/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: "list",
  use: { screenshot: "only-on-failure", trace: "retain-on-failure" },
});
