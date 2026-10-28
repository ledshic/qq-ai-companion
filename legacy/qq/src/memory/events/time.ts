// Calendar expressions are application rules, independent of the task engine.
export const ZONE = 'Asia/Shanghai';
const DAY = 86_400_000;
export const localDate = (at: number): string => new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(at));
export const midnight = (date: string): number => Date.parse(date + 'T00:00:00+08:00');
export const addDays = (date: string, count: number): string => localDate(midnight(date) + count * DAY);
const valid = (date: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(midnight(date)) && localDate(midnight(date)) === date;
export const durationDays = (text: string): number | null => {
  const match = /^(一|二|两|三|四|五|六|七|八|九|十|\d{1,2})天$/.exec(text);
  if (!match) return null;
  const n = Number(match[1]) || ({一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10} as Record<string,number>)[match[1]];
  return n >= 1 && n <= 30 ? n : null;
};
export const resolveDate = (text: string, sourceAt: number | null, notBefore?: string): string | null => {
  if (sourceAt === null) return null;
  const base = localDate(sourceAt);
  const offsets: Record<string,number> = {今天:0,明天:1,后天:2};
  if (Object.hasOwn(offsets,text)) return addDays(base,offsets[text]);
  const full = /^(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?$/.exec(text);
  if (full) { const date = `${full[1]}-${full[2].padStart(2,'0')}-${full[3].padStart(2,'0')}`; return valid(date) ? date : null; }
  const weekday = /^(下周|本周|这周|周|星期)([一二三四五六日天])$/.exec(text);
  if (!weekday) return null;
  const day = new Date(midnight(base) + 8 * 3_600_000).getUTCDay() || 7;
  const target = '一二三四五六日'.indexOf(weekday[2].replace('天','日')) + 1;
  const monday = addDays(base,1-day);
  if (weekday[1] === '下周') return addDays(monday,7+target-1);
  if (weekday[1] === '本周' || weekday[1] === '这周') return addDays(monday,target-1);
  // Bare weekdays need an already established interval to disambiguate.
  if (!notBefore) return null;
  const candidates = [addDays(monday,target-1),addDays(monday,7+target-1)].filter(date => date >= notBefore);
  return candidates[0] ?? null;
};
