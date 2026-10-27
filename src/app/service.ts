import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootstrapAgent } from './bootstrap.js';
import { instanceDataDir } from '../runtime/lock.js';
import { ServiceStore } from '../runtime/service/store.js';
import type { ConsoleGenerator } from '../runtime/service/host.js';
import { RunHost } from '../runtime/service/host.js';
import { APIError } from '@companion/contracts/service';
import { ownerCredential } from './server/credentials.js';
import { createServiceAPI } from './server/api.js';

export async function startService(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: { generate?: ConsoleGenerator } = {},
) {
  const port = Number(env.AGENT_PORT ?? 4320);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('AGENT_PORT must be 1..65535');
  const origin = `http://127.0.0.1:${port}`;
  const origins = [
    origin,
    `http://localhost:${port}`,
    ...(env.AGENT_WEB_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  ];
  for (const allowed of origins) {
    const url = new URL(allowed);
    if (
      url.origin !== allowed ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw Error('Invalid AGENT_WEB_ORIGINS');
  }
  const bootstrap = bootstrapAgent(env);
  let store: ServiceStore | undefined;
  let host: RunHost | undefined;
  let api: ReturnType<typeof createServiceAPI> | undefined;
  const dispose = async () => {
    let failure: unknown;
    for (const release of [
      () => host?.stop(),
      () => api?.close(),
      () => store?.close(),
      () => bootstrap.close(),
    ]) {
      try {
        await release();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  };
  try {
    const credentialPath = join(
      instanceDataDir(bootstrap.memoryPath),
      'service-owner.json',
    );
    const credential = ownerCredential(credentialPath);
    store = new ServiceStore(bootstrap.memoryPath);
    store.ensureOwner(
      credential.ownerId,
      credential.deviceId,
      credential.token,
    );
    host = new RunHost(
      store,
      dependencies.generate ??
        bootstrap.generate ??
        (async () => {
          throw new APIError(503, 'model_not_configured');
        }),
      bootstrap.maxInflight,
      bootstrap.memoryTurns,
    );
    api = createServiceAPI({ store, host, origins, status: bootstrap.status });
    await api.listen({ host: '127.0.0.1', port });
    bootstrap.start();
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= dispose());
    return { api, close, credentialPath };
  } catch (error) {
    try {
      await dispose();
    } catch {
      /* all resources have been visited */
    }
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const service = await startService();
    console.log(
      `[Agent] listening=127.0.0.1:${process.env.AGENT_PORT ?? 4320}; owner credential file=${service.credentialPath}; token is not logged`,
    );
    const shutdown = () => {
      void service.close().then(
        () => {
          process.exitCode = 0;
        },
        () => {
          console.error('[Agent] shutdown_failed');
          process.exitCode = 1;
        },
      );
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch {
    console.error(
      '[Agent] startup_failed; check port, configuration, data ownership and instance lock',
    );
    process.exitCode = 1;
  }
}
