import { connectNapCat } from './napcat-client.js';

const address = process.env.NAPCAT_WS_URL;
if (!address) {
  console.error('请先在 .env 中设置 NAPCAT_WS_URL（参考 .env.example）。');
  process.exit(1);
}

try {
  const url = new URL(address);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid URL');
  }
} catch {
  console.error('NAPCAT_WS_URL 必须是 ws:// 或 wss:// 地址；Token 请单独配置。');
  process.exit(1);
}

const stop = connectNapCat(address, process.env.NAPCAT_TOKEN ?? '');
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
