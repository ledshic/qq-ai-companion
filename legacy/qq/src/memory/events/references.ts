import { readdirSync, readFileSync } from 'node:fs';
// Trusted local prose only. Theme names are never interpreted by code.
export const loadEventReferences = (directory = new URL('../../../config/event-memory/references/', import.meta.url)): string => {
  const files = readdirSync(directory).filter(name => name.endsWith('.md')).sort();
  if (!files.length) throw Error('event_references_missing');
  const text = files.map(name => readFileSync(new URL(name, directory), 'utf8').trim()).join('\n\n');
  if (!text.trim() || text.length > 30_000) throw Error('event_references_size');
  return text;
};
