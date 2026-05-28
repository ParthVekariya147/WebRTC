import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,   // Raised: file transfer adds latency on top of ICE
  retries: 2,       // WebRTC ICE timing is non-deterministic in headless Chromium
  workers: 1,       // Serial — avoid port/resource contention between tests
  use: {
    baseURL: 'http://localhost:5173',
  },
  webServer: [
    {
      command: 'cd client && npm run dev',
      url: 'http://localhost:5173/app.html',
      reuseExistingServer: true,
    },
    {
      // Signaling server — Playwright checks the URL on startup.
      // We expose a lightweight /health endpoint for the readiness check.
      command: 'node server/server.js',
      url: 'http://localhost:8080/health',
      reuseExistingServer: true,
      timeout: 10000,
    },
  ],
});
