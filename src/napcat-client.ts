import { createPersonalAgent, type AgentOptions } from './agent.js';
import { createQQChannel } from './qq-channel.js';

// Compatibility entry point: application policy lives in the personal Agent.
export type NapCatOptions = AgentOptions;
export const connectNapCat = (url: string, token: string,
  generateReply?: Parameters<typeof createPersonalAgent>[1],
  judgeFollowUp?: Parameters<typeof createPersonalAgent>[2],
  options: NapCatOptions = {}) => {
  const agent = createPersonalAgent(createQQChannel(url, token, options.log), generateReply, judgeFollowUp, options);
  agent.start();
  return Object.assign(() => agent.stop(), { tick: () => agent.tick() });
};
