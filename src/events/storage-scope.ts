// Stored JSON and SQLite columns retain their original names. Translate only
// the record envelope; business payloads and evidence must remain untouched.
export const parseStoredScope = (json: string): any => {
  const value = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { groupId, ...record } = value;
  if (typeof record.chatId === 'string') return record;
  return typeof groupId === 'string' ? { ...record, chatId: groupId } : value;
};

export const stringifyStoredScope = <T extends { chatId: string }>(value: T): string => {
  const { chatId, ...record } = value;
  return JSON.stringify({ ...record, groupId: chatId });
};
