import type { SourceGenre, SourceType } from "../shared/sourcePresets";
import type { Loudness } from "../shared/dsp/loudness";

export type { Loudness, SourceGenre, SourceType };

export type AudioKind = "sfx" | "tts" | "music";

export type AudioResult = {
  id: string;
  filename: string;
  duration: number;
  sampleRate: number;
  kind: AudioKind;
  label: string;
  songId?: string;
  /** What a take tool or template step did to produce this file. */
  notice?: string;
  /** A seamless loop: previewed without a gap. */
  loopable?: boolean;
  /** Present once the service has measured it. */
  loudness?: Loudness;
  disposition?: "new" | "keep" | "reject";
  exported?: boolean;
};

export type SharedSettings = {
  variations: number;
  baseFilename: string;
  outputFolder: string;
};

export type SfxSettings = SharedSettings & {
  /** Game-ready template (true) or the isolated layer presets (false). */
  useTemplate: boolean;
  templateId: string;
  /** The user's addition to a template's prompt. */
  detail: string;
  description: string;
  sourceGenre: SourceGenre;
  sourceType: SourceType;
  duration: number | null;
  promptInfluence: number;
  loop: boolean;
};

export type TtsSettings = SharedSettings & {
  description: string;
  voiceId: string;
  modelId: string;
  stability: number;
  similarityBoost: number;
  style: number;
  speakerBoost: boolean;
};

export type MusicSettings = SharedSettings & {
  description: string;
  duration: number | null;
  forceInstrumental: boolean;
  generationMode: "track" | "loop" | "ambience";
  modelId: "music_v1" | "music_v2";
  finetuneId: string;
  referenceStrength: "low" | "medium" | "high" | "xhigh";
  compositionPlan: string;
  useCompositionPlan: boolean;
  storeForInpainting: boolean;
  signWithC2pa: boolean;
  seed: number | null;
  videoTags: string;
};

export type MusicFinetune = {
  id: string;
  name: string;
  tags: string[];
  modelId: string;
  visibility: string;
  createdBy: string;
  status: string;
  progress: number;
  primaryGenre: string;
  failureReason: string;
};

export type MusicReference = {
  id: string;
  filename: string;
  duration: number;
};

export type MusicVideoBatch = {
  id: string;
  filenames: string[];
  duration: number;
};

export type Voice = {
  id: string;
  name: string;
  category: string;
  description: string;
  labels: Record<string, string>;
  previewUrl: string;
  isOwner: boolean;
  isLegacy: boolean;
};

export type VoiceDesignPreview = {
  id: string;
  audioUrl: string;
  mediaType: string;
  duration: number;
  language: string;
};

export type TtsModel = {
  id: string;
  name: string;
  description: string;
  canUseStyle: boolean;
  canUseSpeakerBoost: boolean;
  costFactor: number;
  maxCharacters: number;
  languages: string[];
};

export type UsageData = {
  fetchedAt: string;
  subscription: {
    tier: string;
    status: string;
    used: number;
    limit: number;
    remaining: number;
    voiceSlotsUsed: number;
    voiceLimit: number;
    resetAt: string | null;
    billingPeriod: string | null;
    overageLimit: number | "unlimited" | null;
    overage: { amount: number; currency: string };
  };
  range: { days: number; startTime: number; endTime: number };
  rows: Array<{ timestamp: string; product: string; credits: number }>;
  analyticsError: string | null;
};
