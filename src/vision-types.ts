import type { ReplyContext } from './context.js';

export interface ImageReference { url?: string; file?: string }
export interface ImageAttachments { images: ImageReference[]; imageCount: number }
export type ImageResolver = (file: string, signal: AbortSignal) => Promise<unknown>;
export type ImageRequestJudge = (question: string, context: ReplyContext, imageMessageId: string, signal: AbortSignal) => Promise<boolean>;
export type VisionHandler = (question: string, image: ImageReference, signal: AbortSignal,
  context: ReplyContext, resolve?: ImageResolver) => Promise<string>;
