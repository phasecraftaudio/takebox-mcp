/**
 * ElevenLabs sound effects.
 *
 * Asks for 48 kHz WAV (`wav_48000`), which the API documents for every plan, so nothing has to be
 * decoded from MP3 and no encoder delay sits at the head. If an account is refused that format,
 * it falls back to MP3 once and stays there for the session.
 *
 * Never asks for the model's own loop flag: TAKEBOX makes loops itself (`shared/dsp/loop.ts`),
 * which keeps the take lossless and the loop point ours to judge — and the API documents WAV for
 * non-looping effects only.
 *
 * API reference, checked 2026-11-09: https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert
 */

import { decodeBytes } from "../audio/codecs.js";
import { FatalProviderError, type Account, type GenerateRequest, type Generated, type Provider } from "./types.js";

const API = "https://api.elevenlabs.io/v1";
/**
 * ElevenLabs' published rate when a duration is set, used only until a real charge has been seen.
 * On 2026-11-10 it really charged 10 a second (the `character-cost` header, and its usage figures),
 * a quarter of this. Every request is booked at what ElevenLabs says it charged, and estimates
 * follow the highest rate it charged lately, plus a margin.
 */
export const CREDITS_PER_SECOND = 40;
/** Headroom over the highest rate seen, so a small price rise does not slip past the cap. */
const RATE_MARGIN = 1.1;
const REQUEST_TIMEOUT_MS = 120_000;

type Fetch = typeof fetch;

export class ElevenLabs implements Provider {
  readonly id = "elevenlabs";
  readonly label = "ElevenLabs";
  readonly promptMax = 450;
  readonly minDurationS = 0.5;
  readonly maxDurationS = 30;
  private format: "wav_48000" | "mp3_44100_128" = "wav_48000";
  private learned: number | null = null;
  // (a session preference only: each request keeps its own format below)

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  creditsPerSecond(): number {
    return this.learned === null ? CREDITS_PER_SECOND : this.learned * RATE_MARGIN;
  }

  learnRate(perSecond: number) {
    if (Number.isFinite(perSecond) && perSecond > 0) this.learned = perSecond;
  }

  estimateCredits(request: GenerateRequest): number {
    return Math.ceil(this.creditsPerSecond() * request.durationS - 1e-9);
  }

  private scrub(text: string): string {
    return text.split(this.apiKey).join("[key]").replace(/xi-api-key[^\s,]*/gi, "[key]").slice(0, 400);
  }

  private async failure(response: Response): Promise<Error> {
    const body = this.scrub(await response.text().catch(() => ""));
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { detail?: { status?: string; message?: string } | string };
      if (typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed.detail?.message) detail = `${parsed.detail.status ?? ""} ${parsed.detail.message}`.trim();
    } catch {
      // not JSON
    }
    if (/quota|credits|insufficient/i.test(detail)) {
      return new FatalProviderError(`ElevenLabs says the account is out of credits: ${detail}`);
    }
    if (response.status === 401) {
      return new FatalProviderError(`ElevenLabs refused the API key (401). Check ELEVENLABS_API_KEY in the MCP config. ${detail}`);
    }
    if (response.status === 429) return new Error(`ElevenLabs is busy or rate-limiting this account (429). Try again shortly. ${detail}`);
    return new Error(`ElevenLabs returned ${response.status}: ${detail}`);
  }

  async generate(request: GenerateRequest, signal?: AbortSignal): Promise<Generated> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const send = (format: string) =>
      this.fetchImpl(`${API}/sound-generation?output_format=${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "xi-api-key": this.apiKey },
        body: JSON.stringify({
          text: request.prompt,
          duration_seconds: request.durationS,
          prompt_influence: request.influence,
          loop: false,
          ...(request.model ? { model_id: request.model } : {}),
        }),
        signal: combined,
      });

    // The format this request used, not the session's current preference: two requests in flight
    // can both be refused WAV, and each needs its own retry (Codex review 2026-11-09, finding 13).
    let format = this.format;
    let response = await send(format);
    if (!response.ok && format === "wav_48000" && [400, 403, 422].includes(response.status)) {
      const text = await response.clone().text().catch(() => "");
      if (/output_format|format|tier|plan/i.test(text)) {
        this.format = "mp3_44100_128";
        format = "mp3_44100_128";
        response = await send(format);
      }
    }
    if (!response.ok) throw await this.failure(response);

    const raw = new Uint8Array(await response.arrayBuffer());
    const audio = await decodeBytes(raw, "the ElevenLabs response");
    // What ElevenLabs charged, which TAKEBOX books instead of its estimate.
    const charged = response.headers.get("character-cost");
    const credits = charged === null || charged.trim() === "" ? Number.NaN : Number(charged);
    return { audio, raw, rawExtension: format === "wav_48000" ? "wav" : "mp3", ...(Number.isFinite(credits) && credits >= 0 ? { credits } : {}) };
  }

  async account(signal?: AbortSignal): Promise<Account> {
    const response = await this.fetchImpl(`${API}/user/subscription`, {
      headers: { "xi-api-key": this.apiKey },
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw await this.failure(response);
    const data = (await response.json()) as {
      tier?: string;
      character_count?: number;
      character_limit?: number;
      next_character_count_reset_unix?: number | null;
    };
    return {
      tier: data.tier ?? "unknown",
      creditsUsed: Number(data.character_count ?? 0),
      creditsLimit: Number(data.character_limit ?? 0),
      resetsAt: data.next_character_count_reset_unix ? new Date(data.next_character_count_reset_unix * 1000).toISOString() : null,
    };
  }
}
