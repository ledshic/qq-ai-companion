import type { SendGuard } from './context.js';
export const splitPersonaReply = (text: string): string[] => {
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
  if (lines.length <= 3) return lines;
  return [lines[0], lines[1], lines.slice(2).join(' ')];
};

export const deliverPersonaReply = async (text: string, send: (part: string) => Promise<boolean>,
  allowed: SendGuard, wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 1200))): Promise<string> => {
  const delivered: string[] = [];
  for (const part of splitPersonaReply(text)) {
    if (delivered.length) await wait();
    try {
      if (!await allowed() || !await send(part)) break;
    } catch {
      // A timing recheck may fail after earlier parts were acknowledged.
      // Preserve exactly those parts instead of losing their delivery history.
      break;
    }
    delivered.push(part);
  }
  return delivered.join('\n');
};
