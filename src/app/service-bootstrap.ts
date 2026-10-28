import { createConsoleReply } from '../channels/console/generator.js';
import type { MemoryReader } from '../capabilities/memory/contracts.js';
import { whalePersonality } from '../capabilities/personality/prompt.js';
import { acquireHostLock } from './host-lock.js';
import { readServiceConfig } from './service-config.js';

// Service-only composition: no QQ transport, group policies, legacy memory or timers.
// RunHost owns generation concurrency; no second semaphore is needed here.
export function bootstrapService(env: NodeJS.ProcessEnv = process.env) {
  const config = readServiceConfig(env);
  const close = acquireHostLock(config.memoryPath);
  try {
    const createGenerator = (memory?: MemoryReader) => config.llmEnabled
      ? createConsoleReply(config.apiKey, config.model, config.memoryTurns, config.searchEnabled, fetch, undefined, {
          memory: config.memoryEnabled ? memory : undefined,
          personality: config.persona === 'whale' ? whalePersonality : undefined,
        })
      : undefined;
    return {
      memoryPath: config.memoryPath,
      memoryTurns: config.memoryTurns,
      maxInflight: config.maxInflight,
      createGenerator,
      close,
      status: () => ({
        model: config.llmEnabled ? 'configured' as const : 'not-configured' as const,
        // Compatibility field in the existing public API; this host never starts QQ.
        qq: 'disabled' as const,
      }),
    };
  } catch (error) {
    close();
    throw error;
  }
}
