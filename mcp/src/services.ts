/**
 * What the MCP tools and the board share: one provider, one spend ledger, one set of limits.
 * Both doors into TAKEBOX spend from the same daily cap.
 */

import path from "node:path";
import { loadManifest, resolveSettings } from "./project.js";
import type { Context } from "./make.js";
import { ElevenLabs } from "./providers/elevenlabs.js";
import type { Provider } from "./providers/types.js";
import { limitsFromEnv, SpendLedger, type SpendLimits } from "./spend.js";

export interface ServiceOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  ledger?: SpendLedger;
  cwd?: string;
}

export interface Services {
  env: NodeJS.ProcessEnv;
  apiKey: string;
  provider: Provider | null;
  ledger: SpendLedger;
  limits: SpendLimits;
  libraries: string[];
  cwd: string;
}

export function createServices(options: ServiceOptions = {}): Services {
  const env = options.env ?? process.env;
  const apiKey = env.ELEVENLABS_API_KEY?.trim() ?? "";
  return {
    env,
    apiKey,
    provider: apiKey ? new ElevenLabs(apiKey, options.fetch ?? fetch) : null,
    ledger: options.ledger ?? new SpendLedger(),
    limits: limitsFromEnv(env),
    libraries: (env.TAKEBOX_LIBRARY ?? "").split(path.delimiter).map((p) => p.trim()).filter(Boolean),
    cwd: options.cwd ?? process.cwd(),
  };
}

/** Estimate from what the provider really charged lately, as any TAKEBOX on this machine has seen it. */
export async function learnedRate(services: Services) {
  const provider = services.provider;
  if (!provider?.learnRate) return;
  const rate = await services.ledger.rate(provider.id).catch(() => null);
  if (rate !== null) provider.learnRate(rate);
}

export async function contextFor(services: Services, root: string, extras: Partial<Pick<Context, "signal" | "progress">> = {}): Promise<Context> {
  await learnedRate(services);
  const manifest = await loadManifest(root);
  return {
    root,
    settings: resolveSettings(root, manifest),
    provider: services.provider,
    ledger: services.ledger,
    limits: services.limits,
    ...extras,
  };
}
