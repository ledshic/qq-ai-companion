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
import type { AgentChannelFactory } from './channel.js';

export interface AgentOptions {
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

// One runtime owns conversation policy, memory and delivery. Channels supply I/O.
export const createPersonalAgent = (createChannel: AgentChannelFactory,
  generateReply?: (content: string, history: ChatTurn[], signal: AbortSignal, allowTools?: boolean, context?: ReplyContext) => Promise<string>,
  judgeFollowUp?: FollowUpJudge,
  options: AgentOptions = {}) => {
  const log = options.log ?? console.log;
  const memory = options.memory ?? new ConversationMemory(new SqliteSessionStore(':memory:'));
  let stopped = false;
  const channel = createChannel({
    connected: () => { if (!stopped) conversation.connected(); },
    disconnected: () => { if (!stopped) conversation.disconnect(); },
    message: message => { if (!stopped) conversation.handle(message); },
    acknowledged: (chatId, content, messageId, target) => {
      if (!stopped) conversation.acknowledged(chatId, content, messageId, target);
    },
  });
  const deliver = createReplyDelivery(channel.capture, options.memes, log);
  const conversation = new Conversation({
    ...options,
    memory,
    recordsDelivery: true,
    send: deliver,
    lookup: channel.lookupMessage,
    resolveImage: channel.resolveImage,
    referenceHistory: channel.history,
    judge: judgeFollowUp,
    generate: generateReply,
    log,
  });
  let started = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    conversation.disconnect();
    try { channel.stop(); }
    finally { if (!options.memory) memory.close(); }
  };
  return {
    start: (): void => {
      if (started || stopped) return;
      started = true;
      try { channel.start(); }
      catch (error) { stop(); throw error; }
    },
    tick: (): void => { if (started && !stopped) conversation.tick(); },
    stop,
  };
};
