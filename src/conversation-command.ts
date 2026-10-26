import type { ChatMessage } from './message.js';
import type { ConversationMemory } from './memory.js';
import type { ChatContext } from './context.js';
import type { ObservationWindows } from './observation.js';
import type { EventMemoryPort } from './events/types.js';

export interface ConversationCommandServices {
  eventMemory?: Pick<EventMemoryPort, 'control'>;
  memory: Pick<ConversationMemory, 'clear'>;
  discussion: Pick<ChatContext, 'forget'>;
  windows: Pick<ObservationWindows, 'close'>;
  log: (line: string) => void;
}
export interface ConversationCommandResult {
  content: string;
  // Event-memory controls already apply their operation before acknowledgement.
  // Ordinary session clearing keeps the existing semantic send-review path.
  bypassSendReview: boolean;
}

// Invoked only in the existing explicit, generation-enabled command path.
// Task cancellation, sending and post-delivery window updates stay with the scheduler.
export const handleConversationCommand = (message: ChatMessage,
  services: ConversationCommandServices): ConversationCommandResult | undefined => {
  const content = message.content.trim();
  const controlReply = services.eventMemory?.control(message);
  if (controlReply) {
    if (content === '/清空记忆') services.memory.clear(message.chatId, message.senderId);
    services.windows.close(message.chatId, message.senderId);
    if (content === '/清空记忆') services.discussion.forget(message.chatId, message.senderId);
    return { content: controlReply, bypassSendReview: true };
  }
  if (content === '/清空记忆') {
    services.memory.clear(message.chatId, message.senderId);
    services.windows.close(message.chatId, message.senderId);
    services.log('[记忆] 已清空当前会话。');
    return { content: '已清空你在本群与我的聊天记忆。', bypassSendReview: false };
  }
};
