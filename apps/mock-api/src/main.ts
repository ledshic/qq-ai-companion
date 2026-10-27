import { fileURLToPath } from 'node:url';
import { createMockAPI } from './server.js';
const port = Number(process.env.MOCK_API_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error('MOCK_API_PORT must be between 1024 and 65535');
const server = createMockAPI({
  evidenceFile:
    process.env.MOCK_EVIDENCE_FILE ??
    fileURLToPath(
      new URL('../../../artifacts/phase-a/mock-probes.jsonl', import.meta.url),
    ),
});
server.listen(port, '127.0.0.1', () =>
  console.log(
    `[phase-a] mock API at http://127.0.0.1:${port}; no QQ, model or real memory`,
  ),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
