export type PersonalityMode = 'legacy' | 'modular';
export interface ExpressionPlan {
  readonly mode: 'neutral' | 'explain' | 'casual' | 'play' | 'support';
  readonly banter: 'off' | 'light' | 'normal';
  readonly automaticMeme: 'eligible' | 'suppress';
  readonly reasonCode: string;
  readonly policyVersion: 'expression-policy-v1';
}
