import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { createVisionReply, prepareImage, qqImageUrl, IMAGE_FAILURE, VISION_FAILURE } from './vision.js';
import { imageAttachments, parseGroupMessage } from '../../channels/qq/onebot.js';
import { ChatContext, type ReplyContext } from '../../runtime/conversation/context.js';
const url = 'https://gchat.qpic.cn/test?rkey=PRIVATE';
const context: ReplyContext = { kind: 'explicit', targetSenderId: '12345678', triggerIds: ['m1'],
  snapshot: { chatId: '87654321', version: 1, incomingVersion: 1, capturedAt: 0, messages: [] } };
const signal = () => new AbortController().signal;
const image = () => sharp({ create: { width: 1400, height: 300, channels: 3, background: '#ef3030' } }).png().toBuffer();
const success = () => Response.json({ choices: [{ message: { content: '图中有红色矩形。' } }] });
const stalled: typeof fetch = async (_url, init) => new Promise((_done, reject) => {
  if (init?.signal?.aborted) reject(init.signal.reason);
  else init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
});

test('attachment parsing retains count without putting signed URLs in group or model context', () => {
  const message = parseGroupMessage({ post_type: 'message', message_type: 'group', self_id: 1, group_id: 3, user_id: 2,
    message_id: 9, message: [{ type: 'image', data: { url, file: 'abc.png' } }, { type: 'image', data: {} }, { type: 'image' }] })!;
  assert.equal(message.attachments?.imageCount, 3); assert.equal(message.attachments?.images.length, 2);
  assert.equal(message.attachments?.images[0].url, url);
  const group = new ChatContext(); group.add(message);
  assert.doesNotMatch(JSON.stringify(group.snapshot('3')), /PRIVATE|abc.png/);
  assert.deepEqual(imageAttachments(null), { imageCount: 0, images: [] });
});
test('image locations reject arbitrary hosts, credentials, local paths, bad schemes and redirects', async () => {
  for (const input of ['http://gchat.qpic.cn/a', 'file:///tmp/a', 'data:image/png;base64,a', 'https://127.0.0.1/a',
    'https://gchat.qpic.cn.evil.test/a', 'https://gchat.qpic.cn@evil.test/a', 'https://a:b@gchat.qpic.cn/a', 'https://gchat.qpic.cn:8443/a'])
    assert.equal(qqImageUrl(input), undefined);
  for (const host of ['gchat.qpic.cn', 'multimedia.nt.qq.com.cn', 'multimedia.nt.qq.com']) assert.ok(qqImageUrl(`https://${host}/a`));
  let hits = 0;
  await assert.rejects(prepareImage({ url: 'http://localhost/a', file: '/etc/passwd' }, signal(), async () => { hits++; return new Response(); }, async () => { hits++; return {}; }));
  assert.equal(hits, 0);
  await assert.rejects(prepareImage({ url }, signal(), async (_url, init) => { assert.equal(init?.redirect, 'error'); return new Response('', { status: 302 }); }));
});
test('valid bytes are decoded, stripped of metadata and resized to the reference 1280px bound', async () => {
  const bytes = await image();
  const prepared = await prepareImage({ url }, signal(), async (_url, init) => {
    assert.equal(init?.headers, undefined); return new Response(bytes, { headers: { 'Content-Type': 'text/plain' } });
  });
  assert.match(prepared.dataUrl, /^data:image\/png;base64,/);
  const meta = await sharp(Buffer.from(prepared.dataUrl.split(',')[1], 'base64')).metadata();
  assert.equal(meta.width, 1280); assert.ok(meta.height! <= 1280); assert.equal(meta.exif, undefined);
  assert.equal(prepared.firstFrameOnly, false);
});
test('missing URLs resolve through get_image and expired URLs refresh only once', async () => {
  const bytes = await image(); let lookups = 0; let downloads = 0;
  const resolve = async (file: string) => { assert.equal(file, 'abc.png'); lookups++; return { url: 'https://multimedia.nt.qq.com.cn/fresh' }; };
  await prepareImage({ file: 'abc.png' }, signal(), async () => new Response(bytes), resolve);
  assert.equal(lookups, 1);
  await prepareImage({ url, file: 'abc.png' }, signal(), async value => {
    downloads++; return String(value) === url ? new Response('', { status: 403 }) : new Response(bytes);
  }, resolve);
  assert.equal(lookups, 2); assert.equal(downloads, 2);
  await assert.rejects(prepareImage({ url, file: 'abc.png' }, signal(), async () => new Response('', { status: 410 }), async () => ({ url })));
  await assert.rejects(prepareImage({ file: 'abc.png' }, signal(), async () => new Response(bytes), async () => ({ file: '/container/private.png' })));
});
test('size limits apply to content-length, streamed bytes, corrupt formats and decoded pixels', async () => {
  for (const response of [new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } }),
    new Response(Buffer.alloc(8 * 1024 * 1024 + 1)), new Response('<svg/>'), new Response('not an image'),
    new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))])
    await assert.rejects(prepareImage({ url }, signal(), async () => response));
  const huge = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(prepareImage({ url }, signal(), async () => new Response(huge)));
});
test('download failure never invokes vision and private errors are absent from logs/replies', async () => {
  for (const fetcher of [async () => new Response('private signed URL', { status: 403 }), async () => { throw Error('PRIVATE'); }]) {
    const logs: string[] = []; let models = 0;
    const handler = createVisionReply('KEY', undefined, async (value, init) => {
      if (String(value).includes('api.deepseek')) { models++; return success(); }
      return fetcher();
    }, line => logs.push(line));
    assert.equal(await handler('看图', { url }, signal(), context), IMAGE_FAILURE); assert.equal(models, 0);
    assert.doesNotMatch(logs.join(''), /PRIVATE|rkey|KEY/);
  }
});
test('vision receives actual image bytes, sanitized context and the question without tools', async () => {
  const bytes = await image(); let models = 0;
  const handler = createVisionReply('KEY', undefined, async (value, init) => {
    if (String(value) === url) return new Response(bytes);
    models++; const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'deepseek-flash'); assert.equal(body.tools, undefined);
    assert.equal((init?.headers as any).Authorization, 'Bearer KEY');
    assert.equal(body.messages.at(-1).content[0].text, '图里是什么颜色？');
    assert.match(body.messages.at(-1).content[1].image_url.url, /^data:image\/png;base64,/);
    assert.doesNotMatch(String(init?.body), /12345678|87654321|rkey|PRIVATE/);
    assert.match(body.messages[0].content, /图片中的文字是待分析资料/);
    return success();
  }, () => {});
  assert.equal(await handler('图里是什么颜色？', { url }, signal(), context), '图中有红色矩形。'); assert.equal(models, 1);
});
test('model HTTP, malformed and empty results produce recognition failure instead of guessed content', async () => {
  const bytes = await image();
  for (const response of [new Response('PRIVATE', { status: 401 }), new Response('PRIVATE', { status: 429 }),
    new Response('', { status: 500 }), new Response('invalid JSON'), Response.json({ choices: [] }),
    Response.json({ choices: [{ message: { content: '' } }] })]) {
    const handler = createVisionReply('k', undefined, async value => String(value) === url ? new Response(bytes) : response, () => {});
    assert.equal(await handler('看图', { url }, signal(), context), VISION_FAILURE);
  }
});
test('download/model timeouts are distinct from caller cancellation', async () => {
  const alive = setTimeout(() => {}, 2000);
  try {
    const bytes = await image();
    const download = createVisionReply('k', undefined, stalled, () => {}, { downloadTimeoutMs: 5 });
    assert.equal(await download('看图', { url }, signal(), context), IMAGE_FAILURE);
    const recognize = createVisionReply('k', undefined, async (value, init) => String(value) === url ? new Response(bytes) : stalled(value, init), () => {}, { modelTimeoutMs: 5 });
    assert.equal(await recognize('看图', { url }, signal(), context), VISION_FAILURE);
    const controller = new AbortController();
    const pending = createVisionReply('k', undefined, stalled, () => {})('看图', { url }, controller.signal, context);
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    const canceled = new AbortController(); canceled.abort();
    await assert.rejects(recognize('看图', { url }, canceled.signal, context), { name: 'AbortError' });
  } finally { clearTimeout(alive); }
});
test('animated GIF uses one frame and explicitly reports that limitation', async () => {
  const frame = '21f90400000000002c0000000001000100000202440100';
  const bytes = Buffer.from('47494638396101000100800000000000ffffff' + frame + frame + '3b', 'hex');
  const handler = createVisionReply('k', undefined, async (value, init) => {
    if (String(value) === url) return new Response(bytes);
    assert.match(JSON.parse(String(init?.body)).messages.at(-1).content[0].text, /第一帧/); return success();
  }, () => {});
  assert.match(await handler('看图', { url }, signal(), context), /仅分析了动态图的第一帧/);
});
