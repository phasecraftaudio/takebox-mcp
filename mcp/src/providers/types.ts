/**
 * A sound generator TAKEBOX can call. ElevenLabs is the first; each new provider is one adapter
 * behind this interface, added when a real user asks for it.
 */

import type { Audio } from "../audio/pcm.js";

export interface GenerateRequest {
  prompt: string;
  durationS: number;
  /** 0..1: how literally the model follows the prompt. */
  influence: number;
  model?: string;
}

export interface Generated {
  audio: Audio;
  /** Exactly what the provider sent, kept as the original. */
  raw: Uint8Array;
  rawExtension: string;
  /** What the provider says it charged for this request, when it says (ElevenLabs: `character-cost`). */
  credits?: number;
}

export interface Account {
  tier: string;
  creditsUsed: number;
  creditsLimit: number;
  resetsAt: string | null;
}

export interface Provider {
  id: string;
  label: string;
  /** Longest prompt the provider accepts. */
  promptMax: number;
  minDurationS: number;
  maxDurationS: number;
  estimateCredits(request: GenerateRequest): number;
  /** The per-second rate estimates use now, margin included. */
  creditsPerSecond?(): number;
  /** Estimate from the rate this provider really charged lately, not its published one. */
  learnRate?(perSecond: number): void;
  generate(request: GenerateRequest, signal?: AbortSignal): Promise<Generated>;
  account(signal?: AbortSignal): Promise<Account>;
}

/** An error that means every other request in the batch will fail the same way. */
export class FatalProviderError extends Error {}
