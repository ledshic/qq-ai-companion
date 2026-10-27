// Channel-neutral conversation identity. Values remain opaque to the core.
export interface ChatScope { chatId: string }

// Legacy QQ private-chat keys are retained for persisted data compatibility.
// Numeric OneBot group IDs cannot collide with this internal direct-chat namespace.
export const privateChatId = (userId: string): string => `private:${userId}`;
export const isPrivateChat = (chatId: string): boolean => /^private:\d+$/.test(chatId);
export const privateChatUser = (chatId: string): string | undefined =>
  isPrivateChat(chatId) ? chatId.slice('private:'.length) : undefined;
