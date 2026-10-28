import type { DeliveryTarget } from '../conversation/context.js';

export interface DeliveryChannel {
  connected: () => boolean;
  send: (content: string, target?: DeliveryTarget, image?: string) => Promise<boolean>;
}

