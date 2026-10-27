import { test, expect } from '@playwright/test';
for (const width of [1280, 390, 320]) test(`workspace chat and dashboard at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 320 ? 600 : 900 });
  let authenticated = false, accepting = true;
  const conversation = { id: 'conversation-1', title: '测试对话', ownerId: 'owner', channelId: 'console', kind: 'direct', createdAt: new Date().toISOString() };
  const messages: object[] = [];
  const now = new Date().toISOString();
  const run = { id: 'run-1', conversationId: conversation.id, clientMessageId: 'client-1', state: 'completed', input: '你好', result: '你好，欢迎回来。', error: null, createdAt: now, updatedAt: now };
  await page.route('http://127.0.0.1:4320/api/v1/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname.replace('/api/v1', '');
    let body: unknown = {};
    if (path === '/sessions') authenticated = true;
    else if (!authenticated) { await route.fulfill({ status: 401, json: { error: { code: 'unauthorized' } } }); return; }
    else if (path === '/me') body = { ownerId: 'owner', deviceId: 'device-1', admin: true };
    else if (path === '/status') body = { apiVersion: 'v1', environment: 'service', accepting, model: 'configured', qq: 'disabled' };
    else if (path === '/conversations') body = { conversations: url.searchParams.has('after') ? [] : [conversation], nextCursor: conversation.id };
    else if (path.endsWith('/messages')) {
      if (route.request().method() === 'POST') {
        const input = route.request().postDataJSON(); run.input = input.content;
        messages.push({ id: 'm1', conversationId: conversation.id, runId: run.id, role: 'user', content: input.content, createdAt: now }, { id: 'm2', conversationId: conversation.id, runId: run.id, role: 'assistant', content: run.result, reasoning: '先分析问题，再给出回答。', createdAt: now });
        body = { messageId: 'm1', runId: run.id, eventId: 1, duplicate: false };
      } else body = { messages: url.searchParams.get('after') === '0' ? messages : [], nextCursor: messages.length };
    } else if (path === '/runs/run-1') body = run;
    else if (path === '/events') body = { events: [], nextCursor: 0 };
    else if (path === '/devices') body = { devices: [{ id: 'device-1', name: 'Host owner with a deliberately long device identifier for narrow screens', admin: true, revoked: false }] };
    else if (path === '/pairings') body = { pairings: [] };
    else if (path === '/runtime/pause') { accepting = false; body = { accepting }; }
    else if (path === '/runtime/resume') { accepting = true; body = { accepting }; }
    await route.fulfill({ json: body });
  });
  await page.goto('/');
  await page.getByLabel('设备凭据').fill('test-token');
  await page.getByRole('button', { name: '连接工作台' }).click();
  await expect(page.getByRole('heading', { name: '测试对话' })).toBeVisible();
  if (width <= 650) await expect(page.getByRole('button', { name: '退出连接' })).toBeVisible();
  const composer = await page.getByLabel('发送消息').boundingBox();
  expect(composer).not.toBeNull();
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(width === 320 ? 600 : 900);
  await page.getByLabel('发送消息').fill('你好');
  await page.getByRole('button', { name: '发送 ↑' }).click();
  await expect(page.getByRole('log')).toContainText('你好，欢迎回来。');
  await expect(page.getByText('先分析问题，再给出回答。')).toBeHidden();
  await page.getByText('思考过程').click();
  await expect(page.getByText('先分析问题，再给出回答。')).toBeVisible();
  await page.getByRole('button', { name: '服务概览' }).click();
  await expect(page.getByRole('heading', { name: '服务概览' })).toBeVisible();
  const longDevice = page.getByText('Host owner with a deliberately long device identifier for narrow screens');
  await expect(longDevice).toBeVisible();
  const deviceBox = await longDevice.boundingBox();
  expect(deviceBox!.x + deviceBox!.width).toBeLessThanOrEqual(width);
  await page.getByRole('button', { name: '暂停接收请求' }).click();
  await expect(page.getByRole('button', { name: '恢复接收请求' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `../../artifacts/web-ui/dashboard-${width}.png`, fullPage: true });
});
