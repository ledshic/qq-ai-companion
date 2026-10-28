import { test, expect, type Page, type Route } from '@playwright/test';
const date = '2026-10-28T00:00:00Z';
const conversation = (id: string, title: string) => ({ id, title, ownerId: 'owner', channelId: 'console', kind: 'direct', createdAt: date });
async function fixture(page: Page, options: { admin?: boolean; sourceCount?: number } = {}) {
  let authenticated = false;
  const items = [conversation('target', '当前计划'), conversation('second', '另一个目标'),
    ...Array.from({ length: options.sourceCount ?? 2 }, (_, i) => conversation(`source-${i}`, `来源会话 ${i + 1}`)),
    { ...conversation('foreign', '其他拥有者的会话'), ownerId: 'other' },
    { ...conversation('shared', '共享会话'), kind: 'shared' }];
  const policies: Record<string, { sourceConversationIds: string[]; revision: number }> = {
    target: { sourceConversationIds: [], revision: 0 }, second: { sourceConversationIds: [], revision: 0 },
  };
  const writes: { target: string; sourceConversationIds: string[]; expectedRevision: number }[] = [];
  let getOverride: ((route: Route, id: string) => Promise<boolean>) | undefined;
  let postOverride: ((route: Route, id: string) => Promise<boolean>) | undefined;
  await page.route('http://127.0.0.1:4320/api/v1/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname.replace('/api/v1', '');
    if (path === '/sessions') { authenticated = route.request().method() !== 'DELETE'; await route.fulfill({ json: {} }); return; }
    if (!authenticated) { await route.fulfill({ status: 401, json: { error: { code: 'unauthorized' } } }); return; }
    let body: unknown = {};
    const match = path.match(/^\/conversations\/([^/]+)\/memory-sources$/);
    if (match) {
      const id = match[1];
      if (route.request().method() === 'POST') {
        writes.push({ target: id, ...route.request().postDataJSON() });
        if (postOverride && await postOverride(route, id)) return;
        if (route.request().postDataJSON().expectedRevision !== policies[id].revision) {
          await route.fulfill({ status: 409, json: { error: { code: 'memory_policy_conflict' } } }); return;
        }
        policies[id] = { sourceConversationIds: route.request().postDataJSON().sourceConversationIds, revision: policies[id].revision + 1 };
      } else if (getOverride && await getOverride(route, id)) return;
      body = policies[id];
    } else if (path === '/me') body = { ownerId: 'owner', deviceId: 'device', admin: options.admin ?? true };
    else if (path === '/status') body = { apiVersion: 'v1', environment: 'service', accepting: true, model: 'configured', qq: 'disabled' };
    else if (path === '/conversations') body = { conversations: url.searchParams.has('after') ? [] : items, nextCursor: 'end' };
    else if (path.endsWith('/messages')) body = { messages: [], nextCursor: 0 };
    else if (path === '/events') body = { events: [], nextCursor: 0 };
    else if (path === '/pairings') body = { pairings: [] };
    else if (path === '/devices') body = { devices: [] };
    await route.fulfill({ json: body });
  });
  const panel = page.getByRole('region', { name: '来源授权管理' });
  return { items, policies, writes, panel,
    setGet: (handler: typeof getOverride) => { getOverride = handler; },
    setPost: (handler: typeof postOverride) => { postOverride = handler; },
    async login() { await page.goto('/'); await page.getByLabel('设备凭据').fill('fixture'); await page.getByRole('button', { name: '连接工作台' }).click(); await expect(page.getByRole('heading', { name: '当前计划', exact: true })).toBeVisible(); },
    async open() { await page.getByRole('button', { name: '来源授权', exact: true }).click(); await expect(panel).toBeVisible(); },
  };
}
for (const width of [1280, 390, 320]) test(`source selection, persisted grants and revocation at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 320 ? 600 : 900 });
  const f = await fixture(page);
  if (width === 320) f.items.find(item => item.id === 'source-0')!.title += ' 包含很长的来源说明'.repeat(12);
  await f.login(); await f.open();
  await expect(f.panel.getByText('仅当前会话，尚未授权其他来源。')).toBeVisible();
  await expect(f.panel.getByRole('checkbox')).toHaveCount(3);
  await expect(f.panel.getByRole('checkbox', { name: /其他拥有者|共享会话|当前计划/ })).toHaveCount(0);
  await expect(f.panel.getByRole('button', { name: '保存授权' })).toBeDisabled();
  await f.panel.getByRole('checkbox', { name: /来源会话 1/ }).check();
  expect(f.writes).toHaveLength(0);
  await f.panel.getByRole('button', { name: '保存授权' }).click();
  await expect(f.panel.getByText('来源授权已保存。')).toBeVisible();
  expect(f.writes).toEqual([{ target: 'target', sourceConversationIds: ['source-0'], expectedRevision: 0 }]);
  expect(f.policies.second.sourceConversationIds).toEqual([]);
  f.items.push(conversation('created-elsewhere', '新建来源'));
  await f.panel.getByRole('button', { name: '重新加载' }).click();
  await expect(f.panel.getByRole('checkbox', { name: /新建来源/ })).not.toBeChecked();
  expect(f.writes).toHaveLength(1);
  await page.reload(); await expect(page.getByRole('heading', { name: '当前计划', exact: true })).toBeVisible(); await f.open();
  await expect(f.panel.getByRole('checkbox', { name: /来源会话 1/ })).toBeChecked();
  await f.panel.getByRole('button', { name: '撤销全部来源' }).click();
  await expect(f.panel.getByText('已撤销全部跨会话来源，仅保留当前会话。')).toBeVisible();
  expect(f.policies.target.sourceConversationIds).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const composer = await page.getByLabel('发送消息').boundingBox(); expect(composer!.y + composer!.height).toBeLessThanOrEqual(width === 320 ? 600 : 900);
  await page.screenshot({ path: `../../artifacts/source-permissions/panel-${width}.png`, fullPage: true });
});
test('ordinary devices see current grants without mutation controls', async ({ page }) => {
  const f = await fixture(page, { admin: false }); f.policies.target = { sourceConversationIds: ['source-0'], revision: 1 };
  await f.login(); await f.open();
  await expect(f.panel.getByText('来源会话 1', { exact: false })).toBeVisible();
  await expect(f.panel.getByText('普通设备可查看授权，修改需使用拥有者管理设备。')).toBeVisible();
  await expect(f.panel.getByRole('checkbox')).toHaveCount(0);
  await expect(f.panel.getByRole('button', { name: '保存授权' })).toHaveCount(0);
  await expect(f.panel.getByRole('button', { name: '撤销全部来源' })).toHaveCount(0);
  expect(f.writes).toEqual([]);
});
test('selection limit never preselects new conversations and unavailable grants remain revocable', async ({ page }) => {
  const f = await fixture(page, { sourceCount: 10 }); f.policies.target = { sourceConversationIds: ['missing-source'], revision: 1 };
  await f.login(); await f.open();
  await expect(f.panel.getByRole('checkbox', { name: /不可用的来源/ })).toBeChecked();
  for (let i = 1; i <= 7; i++) await f.panel.getByRole('checkbox', { name: new RegExp(`source-${i - 1}$`) }).check();
  await expect(f.panel.getByRole('checkbox', { name: /来源会话 8/ })).toBeDisabled();
  await f.panel.getByRole('checkbox', { name: /不可用的来源/ }).uncheck();
  await expect(f.panel.getByRole('checkbox', { name: /来源会话 8/ })).toBeEnabled();
  expect(f.writes).toEqual([]);
});
test('load failure and uncertain save block changes until explicit reload', async ({ page }) => {
  const f = await fixture(page); f.setGet(async route => { await route.fulfill({ status: 503, json: { error: { code: 'internal_error' } } }); return true; });
  await f.login(); await f.open(); await expect(f.panel.getByRole('alert')).toBeVisible();
  await expect(f.panel.getByRole('checkbox')).toHaveCount(0);
  f.setGet(undefined); await f.panel.getByRole('button', { name: '重新加载' }).click();
  await f.panel.getByRole('checkbox', { name: /来源会话 1/ }).check();
  f.setPost(async route => { await route.abort('failed'); return true; });
  await f.panel.getByRole('button', { name: '保存授权' }).click();
  await expect(f.panel.getByRole('alert')).toContainText('无法确认最新授权');
  await expect(f.panel.getByRole('button', { name: '保存授权' })).toBeDisabled();
  await expect(f.panel.getByRole('heading', { name: '上次确认的来源（0）' })).toBeVisible();
  expect(f.writes).toHaveLength(1);
  f.setPost(undefined); await f.panel.getByRole('button', { name: '重新加载' }).click();
  await expect(f.panel.getByRole('checkbox', { name: /来源会话 1/ })).not.toBeChecked();
});
test('concurrent updates are not overwritten and refresh requires a new explicit choice', async ({ page }) => {
  const f = await fixture(page); await f.login(); await f.open();
  await f.panel.getByRole('checkbox', { name: /来源会话 1/ }).check();
  f.policies.target = { sourceConversationIds: ['source-1'], revision: 1 };
  await f.panel.getByRole('button', { name: '保存授权' }).click();
  await expect(f.panel.getByRole('alert')).toContainText('授权已在其他设备上修改');
  expect(f.policies.target.sourceConversationIds).toEqual(['source-1']); expect(f.writes).toHaveLength(1);
  await f.panel.getByRole('button', { name: '重新加载' }).click();
  await expect(f.panel.getByRole('checkbox', { name: /来源会话 2/ })).toBeChecked();
  await expect(f.panel.getByRole('checkbox', { name: /来源会话 1/ })).not.toBeChecked();
  await expect(f.panel.getByRole('button', { name: '保存授权' })).toBeDisabled();
});
test('a late response for an old target cannot replace the current conversation policy', async ({ page }) => {
  const f = await fixture(page); let delayed!: Route; let arrived!: () => void;
  const ready = new Promise<void>(resolve => { arrived = resolve; });
  f.setGet(async (route, id) => { if (id === 'target') { delayed = route; arrived(); return true; } return false; });
  await f.login(); await f.open(); await ready;
  await page.getByRole('button', { name: '另一个目标', exact: true }).click();
  await expect(f.panel.getByText('当前会话：另一个目标')).toBeVisible();
  await expect(f.panel.getByText('仅当前会话，尚未授权其他来源。')).toBeVisible();
  await delayed.fulfill({ json: { sourceConversationIds: ['source-0'], revision: 10 } });
  await expect(f.panel.getByRole('checkbox', { name: /来源会话 1/ })).not.toBeChecked();
  await f.panel.getByRole('checkbox', { name: /来源会话 2/ }).check();
  await f.panel.getByRole('button', { name: '保存授权' }).click();
  await expect(f.panel.getByText('来源授权已保存。')).toBeVisible();
  expect(f.writes[0].target).toBe('second'); expect(f.writes[0].expectedRevision).toBe(0);
});
test('a late save confirmation never changes the newly selected target', async ({ page }) => {
  const f = await fixture(page); let delayed!: Route; let arrived!: () => void;
  const ready = new Promise<void>(resolve => { arrived = resolve; });
  f.setPost(async route => { delayed = route; arrived(); return true; });
  await f.login(); await f.open();
  await f.panel.getByRole('checkbox', { name: /来源会话 1/ }).check();
  await f.panel.getByRole('button', { name: '保存授权' }).click(); await ready;
  await page.getByRole('button', { name: '另一个目标', exact: true }).click();
  await expect(f.panel.getByText('当前会话：另一个目标')).toBeVisible();
  await delayed.fulfill({ json: { sourceConversationIds: ['source-0'], revision: 1 } });
  await expect(f.panel.getByRole('checkbox', { name: /来源会话 1/ })).not.toBeChecked();
  await expect(f.panel.getByText('来源授权已保存。')).toHaveCount(0);
  await expect(f.panel.getByRole('button', { name: '保存授权' })).toBeDisabled();
});
test('permission loss during save never claims success or allows another write', async ({ page }) => {
  const f = await fixture(page);
  f.setPost(async route => { await route.fulfill({ status: 403, json: { error: { code: 'forbidden' } } }); return true; });
  await f.login(); await f.open(); await f.panel.getByRole('checkbox', { name: /来源会话 1/ }).check();
  await f.panel.getByRole('button', { name: '保存授权' }).click();
  await expect(f.panel.getByRole('alert')).toContainText('当前设备没有修改权限');
  await expect(f.panel.getByRole('button', { name: '保存授权' })).toBeDisabled();
  await expect(f.panel.getByText('来源授权已保存。')).toHaveCount(0);
  expect(f.writes).toHaveLength(1); expect(f.policies.target.sourceConversationIds).toEqual([]);
});
