import { bootstrapAgent } from './bootstrap.js';
if (!process.env.NAPCAT_WS_URL) {
  console.error('请先在 .env 中设置 NAPCAT_WS_URL（参考 .env.example）。');
  process.exit(1);
}
let host: ReturnType<typeof bootstrapAgent> | undefined;
try {
  host = bootstrapAgent();
  host.start();
  const shutdown = () => {
    host!.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  host?.close();
  console.error(error instanceof Error ? error.message : '宿主启动失败');
  process.exitCode = 1;
}
