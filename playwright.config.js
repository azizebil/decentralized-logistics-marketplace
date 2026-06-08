const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./test",
  testMatch: "ui-demo.spec.js",
  timeout: 60_000,
  reporter: [["list"], ["html", { outputFolder: "test/playwright-report", open: "never" }]],
  use: {
    headless: true,
    baseURL: "http://127.0.0.1:5173",
    screenshot: "only-on-failure",
    video: "off",
  },
  workers: 1,
});
