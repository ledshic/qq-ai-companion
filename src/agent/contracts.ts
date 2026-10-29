export interface ConversationMessage { role: 'user' | 'assistant'; content: string }
export interface ToolCall { id: string; name: string; arguments: string }
export type ModelMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; calls?: ToolCall[]; reasoning?: string }
  | { role: 'tool'; content: string; callId: string };
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export interface ModelReply { text: string; calls: ToolCall[]; reasoning?: string }
export interface Model {
  complete(messages: ModelMessage[], tools: ToolSpec[], signal: AbortSignal, onDelta?: (text: string) => void): Promise<ModelReply>;
}
export interface Tool extends ToolSpec {
  execute(args: unknown, context: { signal: AbortSignal }): string | Promise<string>;
}
