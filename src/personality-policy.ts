import type { PersonalityMode, ExpressionPlan } from './personality-types.js';
export type { PersonalityMode, ExpressionPlan } from './personality-types.js';
import type { ContextObservation } from './observation-types.js';

export const parsePersonalityMode = (value = 'legacy'): PersonalityMode => {
  if (value !== 'legacy' && value !== 'modular') throw Error('PERSONALITY_MODE 只能是 legacy 或 modular');
  return value;
};
export const resolveExpression = (observation?: ContextObservation, local?: 'bare' | 'warmup' | 'image'): ExpressionPlan => {
  let mode: ExpressionPlan['mode'] = 'neutral';
  let banter: ExpressionPlan['banter'] = 'light';
  let reasonCode = 'unknown';
  if (local === 'bare' || local === 'warmup') {
    mode = 'casual'; banter = local === 'bare' ? 'off' : 'light'; reasonCode = local;
  } else if (observation) {
    mode = ({ question: 'explain', casual: 'casual', play: 'play', support: 'support', unknown: 'neutral' } as const)[observation.intent];
    reasonCode = observation.intent;
    banter = mode === 'play' ? 'normal' : 'light';
    if (observation.seriousness === 'explicit' || observation.requestedBanter === 'stop') {
      if (mode === 'play') mode = 'neutral';
      banter = 'off'; reasonCode = 'serious_or_stop';
    }
    if (observation.intent === 'support') { banter = 'off'; reasonCode = 'support'; }
  }
  // Text-only analysis cannot decide that an unseen image invites teasing.
  if (local === 'image') { if (mode === 'play') mode = 'neutral'; banter = 'off'; reasonCode = 'image_conservative'; }
  return Object.freeze({ mode, banter, automaticMeme: banter === 'off' ? 'suppress' : 'eligible', reasonCode,
    policyVersion: 'expression-policy-v1' });
};
