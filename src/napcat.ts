import { connectNapCat } from './napcat-client.js';
import { createDeepSeekReply } from './deepseek.js';

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

const llmEnabled = process.env.LLM_ENABLED === 'true';
if (llmEnabled && !process.env.DEEPSEEK_API_KEY?.trim()) {
  console.error('LLM_ENABLED=true 时必须配置 DEEPSEEK_API_KEY。');
  process.exit(1);
}
const generateReply = llmEnabled
  ? createDeepSeekReply(process.env.DEEPSEEK_API_KEY!, process.env.DEEPSEEK_MODEL || 'deepseek-flash')
  : undefined;
console.log(llmEnabled ? '[LLM] DeepSeek 已启用，按群和用户隔离记忆，最多 6 轮，30 分钟过期。' : '[LLM] 未启用，使用固定回复。');
const stop = connectNapCat(address, process.env.NAPCAT_TOKEN ?? '', generateReply);
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
