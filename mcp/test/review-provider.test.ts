import { describe, expect, it } from "vitest";
import { createMp3Encoder } from "wasm-media-encoders";
import { ElevenLabs } from "../src/providers/elevenlabs.js";
import { burst, RATE } from "./helpers.js";

describe("review: ElevenLabs fallback during the two-request generation pool", () => {
  it("falls back for every in-flight WAV refusal when another request already switched to MP3", async () => {
    const encoder = await createMp3Encoder();
    encoder.configure({ sampleRate: RATE, channels: 1, vbrQuality: 2 });
    const chunk = encoder.encode([burst(0.5, 0.2, 0.05)]).slice();
    const end = encoder.finalize().slice();
    const mp3 = new Uint8Array([...chunk, ...end]);
    let wavRequests = 0;
    let releaseSecond!: () => void;
    const secondWav = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const formats: string[] = [];
    const fake = (async (url: string | URL | Request) => {
      const format = new URL(String(url)).searchParams.get("output_format")!;
      formats.push(format);
      if (format === "wav_48000") {
        wavRequests += 1;
        // The second response arrives after the first has discovered the tier restriction.
        if (wavRequests === 2) await secondWav;
        return new Response(JSON.stringify({ detail: { status: "invalid_output_format", message: "output_format not allowed on your tier" } }), { status: 403 });
      }
      releaseSecond();
      return new Response(mp3, { status: 200 });
    }) as typeof fetch;
    const provider = new ElevenLabs("review-placeholder", fake);
    const outcomes = await Promise.allSettled([
      provider.generate({ prompt: "A jump.", durationS: 1, influence: 0.4 }),
      provider.generate({ prompt: "A coin.", durationS: 1, influence: 0.4 }),
    ]);
    expect({ statuses: outcomes.map((r) => r.status), mp3Requests: formats.filter((f) => f === "mp3_44100_128").length })
      .toEqual({ statuses: ["fulfilled", "fulfilled"], mp3Requests: 2 });
  });
});
