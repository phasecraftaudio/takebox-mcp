import { describe, expect, it } from "vitest";
import { analyze } from "../src/audio/analyze.js";
import { burst, RATE } from "./helpers.js";

describe("recheck: stereo analysis preserves intentional placement", () => {
  it("does not describe a gain-panned stereo take as duplicate mono", () => {
    // A mono source rendered through a stereo pan control has correlated channels with
    // different gains. Unlike duplicate mono, folding this library take changes its pan.
    const left = burst(0.5, 0.3, 0.06);
    const right = left.map((sample) => sample * 0.25);
    const result = analyze({ channels: [left, right], sampleRate: RATE });
    expect(result.flags.join("\n")).not.toContain("same audio in both channels");
  });
});
