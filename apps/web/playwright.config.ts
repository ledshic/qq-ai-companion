import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: { channel: 'chrome', baseURL: 'http://127.0.0.1:4173' },
  webServer: [
    {
      command: 'pnpm --filter @companion/mock-api dev',
      url: 'http://127.0.0.1:4317',
      reuseExistingServer: true,
    },
    {
      command: 'pnpm preview',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: true,
    },
  ],
  reporter: 'list',
});
