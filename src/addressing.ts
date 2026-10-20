// Require a delimiter or a direct-address cue; do not match names like 小爱好者.
export const stripBotName = (text: string): string | undefined => {
  const trimmed = text.trimStart();
  if (!/^小爱(?=$|[\s，,。.!！?？:：、～~]|你|请|帮|能|在吗|在不在|觉得|记住|告诉|介绍|解释|说说|早上好|晚上好|你好)/u.test(trimmed)) return undefined;
  return trimmed.slice(2).replace(/^[\s，,。.!！?？:：、～~]+/u, '').trim();
};
