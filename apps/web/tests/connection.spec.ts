import { test, expect } from '@playwright/test';
for (const width of [1280, 390])
  test(`roundtrip at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByText('连接通过', { exact: true })).toBeVisible();
    await expect(page.getByTestId('platform')).toHaveText('web / browser');
    await page.getByLabel('验证消息').fill('浏览器回归验证');
    await page.getByRole('button', { name: '验证连接' }).click();
    await expect(page.getByRole('status')).toContainText('浏览器回归验证');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `../../artifacts/phase-a/web-${width}.png`,
      fullPage: true,
    });
  });
test('connection failure can be corrected', async ({ page }) => {
  await page.goto('/?api=http://127.0.0.1:1');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('模拟 API 地址').fill('http://127.0.0.1:4317');
  await page.getByRole('button', { name: '验证连接' }).click();
  await expect(page.getByText('连接通过', { exact: true })).toBeVisible();
});
