import { createNapCatTransport } from './napcat-transport.js';
import type { EventMemoryPort } from './events/types.js';
import type { PersonalityRuntime } from './personality-runtime.js';
import type { MemeManager } from './memes.js';
import type { VisionHandler, ImageRequestJudge } from './vision-types.js';
import type { ReplyContext } from './context.js';
import { createReplyDelivery } from './reply-delivery.js';
import { Conversation, type ContextOptions, type InterjectOptions, type JudgeEveryOptions, type WarmupOptions } from './conversation.js';
import { ConversationMemory, type ChatTurn } from './memory.js';
import { SqliteSessionStore } from './store.js';
import type { FollowUpJudge } from './observation.js';

export interface NapCatOptions {
  eventMemory?: EventMemoryPort;
  personality?: PersonalityRuntime;
  memes?: MemeManager;
  vision?: VisionHandler;
  imageRequest?: ImageRequestJudge;
  autoReply?: boolean;
  unified?: boolean;
  memory?: ConversationMemory;
  maxInflight?: number;
  maxWindows?: number;
  windowMs?: number;
  now?: () => number;
  random?: () => number;
  interject?: InterjectOptions;
  warmup?: WarmupOptions;
  judgeEvery?: JudgeEveryOptions;
  context?: ContextOptions;
  log?: (line: string) => void;
}

// Application composition: wire conversation policy, delivery and transport.
// Keep this facade stable for the process entry point and existing callers.
export const connectNapCat = (url: string, token: string,
  generateReply?: (content: string, history: ChatTurn[], signal: AbortSignal, allowTools?: boolean, context?: ReplyContext) => Promise<string>,
  judgeFollowUp?: FollowUpJudge,
  options: NapCatOptions = {}) => {
  const log = options.log ?? console.log;
  const memory = options.memory ?? new ConversationMemory(new SqliteSessionStore(':memory:'));
  const transport = createNapCatTransport(url, token, {
    connected: () => conversation.connected(),
    disconnected: () => conversation.disconnect(),
    message: message => conversation.handle(message),
    acknowledged: (groupId, content, messageId, target) => conversation.acknowledged(groupId, content, messageId, target),
  }, log);
  const deliver = createReplyDelivery(transport.capture, options.memes, log);

  const conversation = new Conversation({
    memory,
    eventMemory: options.eventMemory,
    unified: options.unified,
    recordsDelivery: true,
    send: deliver,
    lookup: (messageId, signal) => transport.lookup('get_msg', { message_id: messageId }, signal),
    resolveImage: (file, signal) => transport.lookup('get_image', { file }, signal),
    referenceHistory: (groupId, signal) => transport.lookup('get_group_msg_history', { group_id: groupId, count: 21, reverseOrder: false }, signal),
    personality: options.personality,
    vision: options.vision,
    imageRequest: options.imageRequest,
    judge: judgeFollowUp,
    generate: generateReply,
    maxInflight: options.maxInflight,
    maxWindows: options.maxWindows,
    windowMs: options.windowMs,
    autoReply: options.autoReply,
    now: options.now,
    random: options.random,
    interject: options.interject,
    warmup: options.warmup,
    judgeEvery: options.judgeEvery,
    context: options.context,
    log,
  });

  transport.start();
  return Object.assign(transport.stop, { tick: (): void => conversation.tick() });
};
