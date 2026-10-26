import type { AnalysisInput, ContextAnalyzer, ObservationReceipt } from './observation-types.js';
import { ANALYZER_VERSION, inputRevision, parseObservation } from './context-analysis.js';
import type { ExpressionPlan } from './personality-types.js';
import { resolveExpression } from './personality-policy.js';

// Stateless: receipts are passed by the caller, never retained across tasks.
export class PersonalityRuntime {
  constructor(private analyze: ContextAnalyzer, private log: (line: string) => void = console.log) {}
  async plan(input: AnalysisInput, signal: AbortSignal, receipt?: ObservationReceipt,
    local?: 'bare' | 'warmup' | 'image'): Promise<ExpressionPlan> {
    signal.throwIfAborted();
    if (local === 'bare' || local === 'warmup') return resolveExpression(undefined, local);
    const started = Date.now();
    const reused = receipt !== undefined;
    let result = receipt;
    try { if (!result) result = await this.analyze(input, signal); }
    catch { signal.throwIfAborted(); }
    signal.throwIfAborted();
    const valid = result?.inputRevision === inputRevision(input) && result.analyzerVersion === ANALYZER_VERSION &&
      (result.status === 'valid' || result.status === 'unknown');
    const observation = valid ? parseObservation(result?.observation, input) : undefined;
    const plan = resolveExpression(observation, local);
    this.log(`[人格] source=${reused ? 'reused' : 'analyzer'}; status=${observation ? result?.status : 'fallback'}; reason=${plan.reasonCode}; policy=${plan.policyVersion}; ms=${Date.now() - started}`);
    return plan;
  }
}
