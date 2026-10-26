import { isAbort } from './abort.js';
import type { ReplyContext } from './context.js';
import type { GroupMessage } from './message.js';
import type { ChatTurn, ConversationMemory } from './memory.js';
import type { createReplyContextPreparer } from './reply-context.js';
import type { VisionHandler, ImageResolver } from './vision-types.js';

export interface ExplicitReplyServices {
  memory: Pick<ConversationMemory, 'get'>;
  prepareContext: ReturnType<typeof createReplyContextPreparer>;
  generate: (text: string, history: ChatTurn[], signal: AbortSignal, allowTools?: boolean,
    context?: ReplyContext) => Promise<string>;
  vision?: VisionHandler;
  resolveImage?: ImageResolver;
  log: (line: string) => void;
}
export interface ExplicitReplyDraft {
  content: string;
  context: ReplyContext;
  // The scheduler pairs this prompt with actual delivered text, never the draft.
  memoryPrompt?: string;
}

const textReply = async (message: GroupMessage, context: ReplyContext, signal: AbortSignal,
  services: ExplicitReplyServices): Promise<ExplicitReplyDraft> => {
  const content = message.content.trim();
  const history = services.memory.get(message.groupId, message.senderId);
  services.log(`[记忆] 本次携带历史 ${history.length / 2} 轮。`);
  try {
    context = await services.prepareContext(context, content, history, signal);
    const answer = await services.generate(content, history, signal, true, context);
    return { content: answer, context, memoryPrompt: content };
  } catch (error) {
    if (signal.aborted || isAbort(error)) throw error;
    console.error('[LLM] 请求失败或超时，请检查服务、密钥和余额。');
    return { content: '我暂时没能生成回复，请稍后再试。', context };
  }
};

const imageReply = async (message: GroupMessage, context: ReplyContext, signal: AbortSignal,
  services: ExplicitReplyServices): Promise<ExplicitReplyDraft> => {
  const count = (message.attachments?.imageCount ?? 0) + (message.quotedAttachments?.imageCount ?? 0);
  if (count !== 1) return { content: '目前一次只能看一张图，请单独发或引用一张。', context };
  if (!services.vision) return { content: '当前没有启用图片理解，暂时看不了这张图。', context };
  const content = message.content.trim();
  const image = message.attachments?.images[0] ?? message.quotedAttachments!.images[0];
  context = await services.prepareContext(context, content, [], signal, undefined, true);
  const answer = await services.vision(content, image, signal, context, services.resolveImage);
  return { content: answer, context,
    memoryPrompt: content + '\n[本次附带、引用或明确指向了一张图片；历史只保留文字回答，未保留原图。]' };
};

const bareReply = async (message: GroupMessage, context: ReplyContext, signal: AbortSignal,
  services: ExplicitReplyServices): Promise<ExplicitReplyDraft> => {
  try {
    context = await services.prepareContext(context, '', [], signal);
    const answer = await services.generate('', services.memory.get(message.groupId, message.senderId), signal, false, context);
    return { content: answer, context };
  } catch (error) {
    if (signal.aborted || isAbort(error)) throw error;
    services.log('[LLM] 空 @ 应声生成失败，使用简短备用回复。');
    return { content: '在，咋了？', context };
  }
};

// Commands and image-reference preparation have already run. Preserve routing
// precedence; cancellation, delivery, memory writes and windows belong to Conversation.
export const generateExplicitReply = (message: GroupMessage, context: ReplyContext,
  awaitingContent: boolean, signal: AbortSignal, services: ExplicitReplyServices): Promise<ExplicitReplyDraft> => {
  const content = message.content.trim();
  if (content.length > 4000) return Promise.resolve({ content: '文字太长了，请缩短到 4000 个字符以内。', context });
  if ((message.attachments?.imageCount ?? 0) + (message.quotedAttachments?.imageCount ?? 0) > 0)
    return imageReply(message, context, signal, services);
  if (message.replyMessageId && /图片|照片|截图|图里|图中|图上|这张图/.test(content))
    return Promise.resolve({ content: '没能从这条引用中取得可验证的图片，请重新发图或引用一条单图消息。', context });
  if (awaitingContent) return bareReply(message, context, signal, services);
  if (!content) return Promise.resolve({ content: '请在 @、引用或称呼后发送 1 至 4000 个字符的文字。', context });
  return textReply(message, context, signal, services);
};
