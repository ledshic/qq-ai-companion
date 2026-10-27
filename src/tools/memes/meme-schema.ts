import { completionText } from '../../cognitive/models/model-request.js';
import { isRecord } from '../../shared/value.js';
import { MEME_SEMANTIC_VERSION, type MemeEntry } from './meme-types.js';

const strings = (value: unknown, max = 3): string[] => Array.isArray(value)
  ? value.filter((v): v is string => typeof v === 'string' && !!v.trim()).slice(0, max).map(v => v.slice(0, 80)) : [];
export const parseMemeMeaning = (data: unknown): Omit<MemeEntry, 'id' | 'file' | 'sha256' | 'category'> => {
  if (!isRecord(data) || typeof data.meaning !== 'string' || !data.meaning.trim() ||
    typeof data.speaker !== 'string' || typeof data.target !== 'string' ||
    typeof data.confidence !== 'number' || data.confidence < 0 || data.confidence > 1) throw Error('invalid meme semantics');
  const scenes = strings(data.scenes); const avoid = strings(data.avoid);
  if (!scenes.length || !avoid.length) throw Error('missing meme scenarios');
  return { meaning: data.meaning.trim().slice(0, 180), visibleText: typeof data.visibleText === 'string' ? data.visibleText.slice(0, 150) : '',
    speaker: data.speaker.slice(0, 100), target: data.target.slice(0, 100), scenes, avoid,
    confidence: data.confidence, semanticVersion: MEME_SEMANTIC_VERSION };
};
export const memeModelObject = (data: unknown): Record<string, unknown> => {
  const object: unknown = JSON.parse(completionText(data, 'invalid model response'));
  if (!isRecord(object)) throw Error('invalid model object');
  return object;
};
