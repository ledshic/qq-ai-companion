import type { GroupMessage } from './message.js';
import type { FollowUpCandidate } from './observation.js';

export type ParticipationTaskKind = 'explicit' | 'follow-up' | 'interject' | 'judge';
export interface Inbound {
  kind: ParticipationTaskKind;
  message: GroupMessage;
  text: string;
  receivedAt: number;
  candidate?: FollowUpCandidate;
  senderVersion?: number;
  awaitingReply?: boolean;
  triggerIds?: string[];
}
