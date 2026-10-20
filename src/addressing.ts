import { BOT_NAME } from './identity.js';

// Require a delimiter or direct-address cue after a full name.
export const stripBotName = (text: string): string | undefined => {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(BOT_NAME)) return undefined;
  const rest = trimmed.slice(BOT_NAME.length);
  if (!/^(?:$|[\s，,。.!！?？:：、～~]|你|请|帮|能|在吗|在不在|觉得|记住|告诉|介绍|解释|说说|早上好|晚上好|你好)/u.test(rest)) return undefined;
  return rest.replace(/^[\s，,。.!！?？:：、～~]+/u, '').trim();
};
