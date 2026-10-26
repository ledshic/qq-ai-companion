type ProactiveKind = 'judge' | 'interject' | 'warmup';
interface HourlyCount { hour: number; count: number }

// Budgets track acknowledged participation only. Session cancellation and task
// priority remain in Conversation; each participation path keeps its own cooldown.
export class ProactiveBudget {
  private readonly last: Record<ProactiveKind, Map<string, number>> = {
    judge: new Map(), interject: new Map(), warmup: new Map(),
  };
  private readonly hourly = new Map<string, HourlyCount>();
  constructor(private readonly now: () => number) {}

  cooling(kind: ProactiveKind, group: string, cooldownMs: number): boolean {
    const last = this.last[kind].get(group);
    return last !== undefined && this.now() - last < cooldownMs;
  }

  overHourlyCap(group: string, cap: number): boolean {
    const entry = this.hourly.get(group);
    if (!entry) return false;
    return entry.hour === Math.floor(this.now() / 3_600_000) && entry.count >= cap;
  }

  record(kind: ProactiveKind, group: string): void {
    this.last[kind].set(group, this.now());
    if (kind !== 'judge') return;
    const hour = Math.floor(this.now() / 3_600_000);
    const entry = this.hourly.get(group);
    if (!entry || entry.hour !== hour) this.hourly.set(group, { hour, count: 1 });
    else entry.count++;
  }

  disconnected(unified: boolean): void {
    if (unified) return;
    this.last.judge.clear();
    this.hourly.clear();
  }
}
