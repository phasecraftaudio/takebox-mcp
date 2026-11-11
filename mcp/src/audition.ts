/**
 * Style audition: the same three sounds in up to four directions, one take each, under one
 * spend check and one reservation. The person hears the styles side by side and picks by ear.
 */

import { makeSounds, type Context } from "./make.js";
import { ProjectError } from "./project.js";
import { checkSpend } from "./spend.js";
import { auditionSpecs, resolveStyle } from "./styles.js";

export const MAX_STYLES = 4;

export async function runAudition(ctx: Context, styles: string[], options: { dryRun?: boolean; confirmCredits?: number; alwaysConfirm?: boolean } = {}) {
  const resolved = [...new Map(styles.map(resolveStyle).map((style) => [style.key, style])).values()];
  if (resolved.length === 0) throw new ProjectError("Pick at least one style.");
  if (resolved.length > MAX_STYLES) throw new ProjectError(`Audition at most ${MAX_STYLES} styles at a time.`);

  const priced = await Promise.all(
    resolved.map(async (style) => {
      const estimate = (await makeSounds(ctx, auditionSpecs(style.direction), { dryRun: true })) as { estimate_credits: number };
      return { ...style, credits: estimate.estimate_credits };
    }),
  );
  const total = priced.reduce((sum, style) => sum + style.credits, 0);
  const limits = options.alwaysConfirm ? { ...ctx.limits, askAbove: 0 } : ctx.limits;
  const spent = await ctx.ledger.spentToday();
  const committed = await ctx.ledger.committedToday();
  const spend = { estimate_credits: total, spent_today: spent, daily_cap: limits.dailyCap, ask_above: limits.askAbove };
  const list = priced.map(({ key, label, direction, credits }) => ({ key, label, direction, credits }));

  if (options.dryRun) return { status: "estimate", ...spend, styles: list, sounds_per_style: ["jump", "coin", "hit"] };
  const decision = checkSpend(total, committed, limits, options.confirmCredits);
  if (!decision.ok) {
    return {
      status: decision.reason === "cap" ? "over_daily_cap" : "needs_confirmation",
      ...spend,
      styles: list,
      message: decision.reason === "cap" ? decision.message : `This audition is about ${total} credits. Ask the person, then call again with confirm_credits: ${total}.`,
    };
  }
  if (!ctx.provider) throw new ProjectError("No ELEVENLABS_API_KEY is set in the MCP config, so nothing can be generated.");

  // Hold the whole audition before the first style starts (Codex review 2026-11-09, finding 3).
  const reservation = await ctx.ledger.reserve(total, limits.dailyCap);
  if (!reservation) {
    return { status: "over_daily_cap", ...spend, styles: list, message: `Other batches running now already hold most of today's cap of ${limits.dailyCap}.` };
  }

  const made = [];
  let used = 0;
  try {
    for (const style of priced) {
      const result = (await makeSounds(ctx, auditionSpecs(style.direction), {
        reservation,
        audition: { key: style.key, label: style.label, direction: style.direction },
      })) as { status: string; credits_used?: number; sounds?: { name: string; files: string[]; errors?: string[] }[]; stopped?: string; message?: string };
      used += result.credits_used ?? 0;
      made.push({
        key: style.key,
        label: style.label,
        direction: style.direction,
        status: result.status,
        files: result.sounds?.flatMap((sound) => sound.files) ?? [],
        ...(result.message ? { message: result.message } : {}),
        ...(result.stopped ? { stopped: result.stopped } : {}),
      });
      if (result.stopped || result.status === "over_daily_cap") break;
    }
  } finally {
    await ctx.ledger.release(reservation);
  }
  return {
    status: made.every((style) => style.files.length === 3) ? "made" : "partly_made",
    credits_used: used,
    spent_today: spent + used,
    styles: made,
    next: "Open the board (open_board) so the person can hear the styles side by side and pick one. Their pick becomes the direction.",
  };
}
