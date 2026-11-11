/**
 * Where playback goes: one Web Audio context for every take card, and a mono fold.
 *
 * Fixed at 48 kHz, the rate of every take, so a loop buffer is never resampled on decode and
 * its length stays exactly what the file says. The browser converts to the device's own rate.
 *
 * **Mono** plays everything as (L + R) / 2 in both speakers: how a phone speaker, a cheap tablet
 * or a mono broadcast will hear a sound. Two sounds that cancel each other, or a stereo effect
 * that collapses, show up here first. It is the Web Audio spec's own "speakers" downmix: a
 * one-channel node set to explicit, which then upmixes back to both outputs.
 *
 * ⚠️ A media element routed through Web Audio plays only through it, and a context created
 * before any click starts suspended in a browser. So cards route through here only once mono is
 * switched on, by a click that also resumes the context, and stay on the plain element otherwise.
 */

let context: AudioContext | null = null;
let monoBus: GainNode | null = null;

export function audioContext(): AudioContext {
  if (!context) context = new AudioContext({ sampleRate: 48000 });
  return context;
}

/** Safe to call from any click: a no-op once the context is running. */
export function resumeAudio() {
  const current = audioContext();
  if (current.state === "suspended") void current.resume();
}

/** The node a source should connect to: the speakers, or the mono fold in front of them. */
export function outputFor(mono: boolean): AudioNode {
  const current = audioContext();
  if (!mono) return current.destination;
  if (!monoBus) {
    monoBus = current.createGain();
    monoBus.channelCount = 1;
    monoBus.channelCountMode = "explicit";
    monoBus.channelInterpretation = "speakers";
    monoBus.connect(current.destination);
  }
  return monoBus;
}
