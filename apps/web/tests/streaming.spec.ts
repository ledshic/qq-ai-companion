import { test, expect, type Page } from '@playwright/test';
const now = '2026-10-29T00:00:00Z';
async function fixture(page: Page) {
  const c = { id: 'conversation', title: '流式对话', ownerId: 'owner', channelId: 'console', kind: 'direct', createdAt: now };
  const other = { ...c, id: 'other', title: '其他对话' };
  const run = { id: 'stream-run', conversationId: c.id, clientMessageId: 'message', state: 'running', input: 'question', result: null as string | null, error: null as string | null, createdAt: now, updatedAt: now };
  let authenticated = false, submitted = false, cancelled = 0;
  let eventId = 1, heldRun: { wait: Promise<void>; entered: () => void } | undefined;
  const messages: object[] = [];
  await page.addInitScript(() => {
    const original = window.fetch.bind(window), streams: any[] = [], latest = new Map<string, unknown>();
    Object.assign(window, { outputStreams: streams, denyOutput: 0, emitOutput(id: string, snapshot: any, drop = false) {
      latest.set(id, snapshot);
      for (const stream of streams.filter(item => item.id === id && item.active)) {
        if (drop) { stream.active = false; stream.controller.close(); }
        else stream.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(snapshot)}\n\n`));
      }
    } });
    window.fetch = async (input, init) => {
      const match = String(input).match(/\/runs\/([^/]+)\/output$/);
      if (!match) return original(input, init);
      if ((window as any).denyOutput) return Response.json({ error: { code: 'unauthorized' } }, { status: (window as any).denyOutput });
      const stream: any = { id: match[1], active: true };
      const body = new ReadableStream({ start(controller) {
        stream.controller = controller; streams.push(stream);
        if (latest.has(stream.id)) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(latest.get(stream.id))}\n\n`));
        init?.signal?.addEventListener('abort', () => { if (stream.active) { stream.active = false; controller.error(new DOMException('Aborted', 'AbortError')); } }, { once: true });
      }, cancel() { stream.active = false; } });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
  await page.route('http://127.0.0.1:4320/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', ''); let body: unknown = {};
    if (path === '/sessions') authenticated = route.request().method() !== 'DELETE';
    else if (!authenticated) { await route.fulfill({ status: 401, json: { error: { code: 'unauthorized' } } }); return; }
    else if (path === '/me') body = { ownerId: 'owner', deviceId: 'device', admin: true };
    else if (path === '/status') body = { apiVersion: 'v1', environment: 'service', accepting: true, model: 'configured', qq: 'disabled' };
    else if (path === '/conversations') body = { conversations: route.request().url().includes('after=') ? [] : [c, other], nextCursor: other.id };
    else if (path.endsWith('/messages')) {
      if (route.request().method() === 'POST') {
        submitted = true; run.input = route.request().postDataJSON().content;
        messages.push({ id: 'user', runId: run.id, conversationId: c.id, role: 'user', content: run.input, createdAt: now });
        body = { messageId: 'user', runId: run.id, duplicate: false, eventId: 1 };
      } else body = { messages: path.includes('/other/') || !route.request().url().includes('after=0') ? [] : messages, nextCursor: messages.length };
    } else if (path === '/runs/stream-run') {
      body = { ...run }; const gate = heldRun; heldRun = undefined;
      if (gate) { gate.entered(); await gate.wait; }
    }
    else if (path === '/runs/stream-run/cancel') { cancelled++; run.state = 'cancelled'; body = run; }
    else if (path === '/events') body = { events: submitted && Number(new URL(route.request().url()).searchParams.get('after')) < eventId ? [{ eventId, runId: run.id, conversationId: c.id, type: 'run.started', time: now, data: {} }] : [], nextCursor: submitted ? eventId : 0 };
    else if (path === '/devices') body = { devices: [] };
    else if (path === '/pairings') body = { pairings: [] };
    await route.fulfill({ json: body });
  });
  const emit = async (text: string, state = 'running', result: string | null = null, error: string | null = null, drop = false) => {
    run.state = state; run.result = result; run.error = error;
    if (state === 'completed' && !messages.some((m: any) => m.role === 'assistant')) messages.push({ id: 'assistant', runId: run.id, conversationId: c.id, role: 'assistant', content: result, createdAt: now });
    await page.evaluate(({ id, snapshot, drop }) => (window as any).emitOutput(id, snapshot, drop), { id: run.id, snapshot: { run, text, sequence: text.length }, drop });
  };
  const connected = async (minimum = 1) => expect.poll(() => page.evaluate(() => (window as any).outputStreams.length)).toBeGreaterThanOrEqual(minimum);
  return { run, emit, connected, cancelled: () => cancelled, holdNextRun() {
    eventId++; let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    heldRun = { wait, entered }; return { ready, release };
  }, async start() {
    await page.goto('/'); await page.getByLabel('设备凭据').fill('fixture'); await page.getByRole('button', { name: '连接工作台' }).click();
    await expect(page.getByRole('heading', { name: c.title, exact: true })).toBeVisible();
    await page.getByLabel('发送消息').fill('question'); await page.getByRole('button', { name: '发送 ↑' }).click(); await connected();
  } };
}
for (const width of [1280, 320]) test(`real draft updates precede final message and do not duplicate history at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 320 ? 600 : 900 }); const f = await fixture(page); await f.start();
  await f.emit('首个真实片段'); const preview = page.getByRole('article', { name: '生成中的回答' });
  await expect(preview).toContainText('首个真实片段'); await expect(preview).toContainText('未提交草稿');
  await f.emit('首个真实片段，第二个片段'); await expect(preview).toContainText('第二个片段');
  await f.emit('', 'completed', '完整权威回答'); await expect(preview).toHaveCount(0);
  await expect(page.getByText('完整权威回答', { exact: true })).toHaveCount(1);
  await expect(page.locator('article').filter({ hasText: '完整权威回答' })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `../../artifacts/streaming/web-${width}.png`, fullPage: true });
});
test('disconnect clears uncertain text and reconnect replaces the snapshot without repeating tokens', async ({ page }) => {
  const f = await fixture(page); await f.start(); await f.emit('草稿一');
  const preview = page.getByRole('article', { name: '生成中的回答' }); await expect(preview).toContainText('草稿一');
  await f.emit('草稿一', 'running', null, null, true); await expect(preview).not.toContainText('草稿一');
  await f.connected(2); await expect(preview).toContainText('草稿一');
  await f.emit('草稿一和新片段'); await expect(preview).toContainText('草稿一和新片段');
  expect((await preview.textContent())!.split('草稿一').length - 1).toBe(1);
  await f.emit('', 'failed', null, 'memory_context_changed'); await expect(preview).toHaveCount(0);
  await expect(page.getByRole('log')).not.toContainText('草稿一');
});
test('cancel and conversation changes remove drafts and ignore late data', async ({ page }) => {
  const f = await fixture(page); await f.start(); await f.emit('尚未提交');
  await expect(page.getByRole('article', { name: '生成中的回答' })).toContainText('尚未提交');
  await page.getByRole('button', { name: '其他对话', exact: true }).click();
  await expect(page.getByRole('log')).not.toContainText('尚未提交');
  await f.emit('旧会话迟到片段'); await expect(page.getByRole('log')).not.toContainText('旧会话迟到片段');
  await page.getByRole('button', { name: '流式对话', exact: true }).click(); await f.connected(2);
  await page.getByRole('button', { name: '停止生成 ■' }).click(); await expect(page.getByRole('article', { name: '生成中的回答' })).toHaveCount(0);
  expect(f.cancelled()).toBe(1); await f.emit('取消后迟到片段'); await expect(page.getByRole('log')).not.toContainText('取消后迟到片段');
});
test('lost device access clears the stream and returns to authentication', async ({ page }) => {
  const f = await fixture(page); await f.start(); await f.emit('已授权草稿');
  await expect(page.getByRole('article', { name: '生成中的回答' })).toContainText('已授权草稿');
  await page.evaluate(() => { (window as any).denyOutput = 401; }); await f.emit('已授权草稿', 'running', null, null, true);
  await expect(page.getByLabel('设备凭据')).toBeVisible(); await expect(page.getByText('已授权草稿', { exact: true })).toHaveCount(0);
});
test('an old lifecycle poll cannot revive a run after the final stream snapshot', async ({ page }) => {
  const f = await fixture(page); await f.start(); await f.emit('未提交草稿'); const gate = f.holdNextRun();
  try {
    await gate.ready; await f.emit('', 'completed', '已提交的最终回答');
    await expect(page.getByText('已提交的最终回答', { exact: true })).toHaveCount(1);
    const response = page.waitForResponse('http://127.0.0.1:4320/api/v1/runs/stream-run'); gate.release(); await response;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByRole('article', { name: '生成中的回答' })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).outputStreams.length)).toBe(1);
  } finally { gate.release(); }
});
