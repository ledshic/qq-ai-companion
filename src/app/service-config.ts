export function readServiceConfig(env: NodeJS.ProcessEnv) {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < min || value > max)
      throw Error(`${name} must be an integer in ${min}..${max}`);
    return value;
  };
  const llmEnabled = env.LLM_ENABLED === 'true';
  const apiKey = env.DEEPSEEK_API_KEY?.trim() ?? '';
  if (llmEnabled && !apiKey) throw Error('LLM_ENABLED=true requires DEEPSEEK_API_KEY');
  return {
    memoryPath: env.MEMORY_DB || 'data/memory.db',
    memoryTurns: integer('MEMORY_TURNS', 9, 1, 50),
    maxInflight: integer('MAX_INFLIGHT', 3, 1, 16),
    llmEnabled,
    apiKey,
    model: env.DEEPSEEK_MODEL || 'deepseek-flash',
    searchEnabled: env.WEB_SEARCH_ENABLED === 'true',
  };
}
