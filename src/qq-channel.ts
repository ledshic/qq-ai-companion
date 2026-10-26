import type { AgentChannelFactory } from './channel.js';
import { imageReferenceHistory, normalizeMessageReference } from './onebot.js';
import { isPrivateChat } from './chat-scope.js';
import { createNapCatTransport } from './napcat-transport.js';

// OneBot actions and private/group routing belong to the QQ adapter.
export const createQQChannel = (url: string, token: string,
  log?: (line: string) => void): AgentChannelFactory => events => {
  const transport = createNapCatTransport(url, token, events, log);
  return {
    start: transport.start,
    stop: transport.stop,
    capture: transport.capture,
    lookupMessage: async (messageId, signal, current) => normalizeMessageReference(
      await transport.lookup('get_msg', { message_id: messageId }, signal), current),
    resolveImage: (file, signal) => transport.lookup('get_image', { file }, signal),
    history: async (current, signal) => {
      if (isPrivateChat(current.chatId)) return;
      const messages = imageReferenceHistory(await transport.lookup('get_group_msg_history',
        { group_id: current.chatId, count: 21, reverseOrder: false }, signal), current);
      return messages ? { chatId: current.chatId, messages } : undefined;
    },
  };
};
