import type { ReplyContext } from './context.js';
import type { ChatTurn } from './memory.js';
import type { ObservationReceipt } from './observation-types.js';
import type { EventMemoryPort } from './events/types.js';
import type { PersonalityRuntime } from './personality-runtime.js';

export interface ReplyContextServices {
  eventMemory?: Pick<EventMemoryPort, 'recall'>;
  personality?: Pick<PersonalityRuntime, 'plan'>;
}

// Per-task preparation only: recall precedes personality planning, and the
// freshness predicate stays local for the scheduler's later send checks.
export const createReplyContextPreparer = (services: ReplyContextServices) =>
  async (context: ReplyContext, text: string, history: ChatTurn[], signal: AbortSignal,
    receipt?: ObservationReceipt, image = false): Promise<ReplyContext> => {
    if (services.eventMemory && text.trim() && (context.kind === 'explicit' || context.kind === 'follow-up') && context.targetSenderId) {
      const recall = await services.eventMemory.recall({chatId:context.snapshot.chatId,ownerId:context.targetSenderId,text,history},signal);
      signal.throwIfAborted();
      context = Object.freeze({...context,longTermMemory:recall.view,memoryGuard:recall.isCurrent});
    }
    if (!services.personality) return context;
    const local = image ? 'image' : context.kind === 'warmup' ? 'warmup'
      : context.kind === 'explicit' && !text.trim() ? 'bare' : undefined;
    const expressionPlan = await services.personality.plan({ text, history, context }, signal, receipt, local);
    signal.throwIfAborted();
    return Object.freeze({ ...context, expressionPlan });
  };
