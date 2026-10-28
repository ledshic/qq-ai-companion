import type { ConversationMessage } from '../../agent/contracts.js';
export interface PersonalityProvider {
  // Expression only: no identity, authorization, memory port or tools are supplied.
  prompt(input: { text: string; history: ConversationMessage[] }, signal: AbortSignal): string | Promise<string>;
}
export const whalePersonality: PersonalityProvider = {
  prompt: () => '你是 DeepSeek 小鲸鱼。保留聪明、简洁、适度幽默的表达，认真请求先给有用的回答。',
};
