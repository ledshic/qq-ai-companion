export interface ToolContext {
  now: () => number;
  random: () => number;
  timeZone: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: unknown, ctx: ToolContext): string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});

const asInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

export const TOOLS: ToolDefinition[] = [
  {
    name: 'get_current_time',
    description: '查询当前日期和时间。用户问“现在几点”“今天几号”“星期几”时调用。',
    parameters: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'IANA 时区名，例如 Asia/Shanghai；默认使用运行环境时区' },
      },
    },
    run(args, ctx) {
      const requested = asRecord(args).timezone;
      const zone = typeof requested === 'string' && requested.trim() ? requested.trim() : ctx.timeZone;
      try {
        const formatted = new Intl.DateTimeFormat('zh-CN', {
          timeZone: zone, dateStyle: 'full', timeStyle: 'medium',
        }).format(new Date(ctx.now()));
        return `${formatted}（${zone}）`;
      } catch {
        return `无法识别的时区：${zone}`;
      }
    },
  },
  {
    name: 'roll_dice',
    description: '掷骰子。用户要随机数、抽签、掷骰子、决定吃什么都可能用得上。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: '骰子数量，1-10，默认 1' },
        sides: { type: 'integer', description: '每个骰子的面数，2-100，默认 6' },
      },
    },
    run(args, ctx) {
      const options = asRecord(args);
      const count = asInt(options.count, 1, 1, 10);
      const sides = asInt(options.sides, 6, 2, 100);
      const rolls = Array.from({ length: count }, () => 1 + Math.floor(ctx.random() * sides));
      const total = rolls.reduce((sum, value) => sum + value, 0);
      return `${count}d${sides} = ${rolls.join(' + ')} = ${total}`;
    },
  },
];

export const toolSpecs = (): unknown[] => TOOLS.map(tool => ({
  type: 'function',
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
}));

export const DEFAULT_TOOL_CONTEXT: ToolContext = {
  now: () => Date.now(),
  random: () => Math.random(),
  timeZone: 'Asia/Shanghai',
};

// Tool output goes back to the model as data, so failures are reported as text
// instead of thrown: the model can recover or give up gracefully.
export const runTool = (name: string, rawArguments: string, ctx: ToolContext = DEFAULT_TOOL_CONTEXT): string => {
  const tool = TOOLS.find(candidate => candidate.name === name);
  if (!tool) return `未知工具：${name}`;
  let args: unknown = {};
  if (rawArguments.trim()) {
    try {
      args = JSON.parse(rawArguments);
    } catch {
      return `工具参数不是合法 JSON：${rawArguments.slice(0, 100)}`;
    }
  }
  try {
    return tool.run(args, ctx);
  } catch (error) {
    return `工具执行失败：${error instanceof Error ? error.message : '未知错误'}`;
  }
};
