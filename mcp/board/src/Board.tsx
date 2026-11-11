/**
 * The sound board: every sound a game has, heard and decided on in one place.
 *
 * The take cards are TAKEBOX desktop's own `WaveformCard`, unchanged; the board server answers the
 * routes they call. Everything that spends asks first, with the cost, every time: the board does
 * not have the AI's judgement to lean on, so the person decides each spend themselves.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, FileSearch, LoaderCircle, Plus, Sparkles, Volume2, Wand2, Zap } from "lucide-react";
import WaveformCard from "../../../src/WaveformCard";
import PhasecraftMark from "../../../src/PhasecraftMark";
import { resumeAudio } from "../../../src/audioOutput";
import type { AudioResult } from "../../../src/types";

// ── What the board server sends ─────────────────────────────────────────────────────

type Kind = "one-shot" | "sequence" | "loop";
type Role = "ui" | "foley" | "sfx" | "impact" | "ambience" | "music" | "voice";

type Sound = {
  name: string;
  group: string;
  kind: Kind;
  role: Role;
  source: "generated" | "file";
  prompt: string;
  durationS: number | null;
  kept: number;
  takes: AudioResult[];
};

type Style = { id: string; name: string; direction: string; about: string };

type BoardState = {
  project: string;
  name: string;
  engine: string;
  settings: { folder: string; formats: { oneShot: string[]; loop: string[] }; direction: string };
  spend: { today: number; cap: number | null; askAbove: number | null; perSecond: number | null };
  provider: string | null;
  styles: Style[];
  sounds: Sound[];
  auditions: { key: string; label: string; direction: string; chosen: boolean; takes: AudioResult[] }[];
  version: number;
};

type Draft = { name: string; prompt: string; kind: Kind; role: Role; variations: number; duration_s: number; influence?: number; split_preset?: string };

type Cue = { cue: string; mentions: number; evidence: string[]; suggestion: Draft; alreadyMade?: string[] };
type Plan = {
  filesScanned: number;
  styleHints: { word: string; mentions: number }[];
  cues: Cue[];
  missingAudio: { reference: string; at: string }[];
  playback: { library: string; at: string }[];
};

type SpendReply = { status: string; estimate_credits?: number; credits_used?: number; message?: string; stopped?: string; sounds?: { name: string; files: string[]; errors?: string[] }[] };

/** Until the server says what ElevenLabs really charges: its published rate, which ran four times high. */
const PUBLISHED_PER_SECOND = 40;
const DEFAULT_DURATION: Record<Kind, number> = { "one-shot": 2, sequence: 6, loop: 15 };
const KINDS: Kind[] = ["one-shot", "sequence", "loop"];
const ROLES: Role[] = ["ui", "foley", "sfx", "impact", "ambience", "music", "voice"];
const GROUP_ORDER = ["Interface", "Footsteps & foley", "Sounds", "Impacts", "Ambience", "Music & stings", "Voice"];

async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload;
}

const fmt = (n: number | null) => (n === null || !Number.isFinite(n) ? "∞" : Math.round(n).toLocaleString("en-US"));
const costOf = (d: { duration_s: number; variations: number }, perSecond: number | null) =>
  Math.ceil((perSecond ?? PUBLISHED_PER_SECOND) * d.duration_s - 1e-9) * d.variations;

type Pending = { title: string; detail: string; credits: number; run: (confirm: number) => Promise<void> };

export default function Board() {
  const [board, setBoard] = useState<BoardState | null>(null);
  const [page, setPage] = useState<"sounds" | "style" | "plan">("sounds");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [mono, setMono] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const version = useRef(0);

  const load = useCallback(async () => {
    try {
      const state = await api<BoardState>("/api/board");
      version.current = state.version;
      setBoard(state);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the board.");
    }
  }, []);

  useEffect(() => {
    void load();
    // The AI may be making sounds while the board is open: follow takebox.json.
    const timer = window.setInterval(() => {
      void api<{ version: number }>("/api/version")
        .then(({ version: next }) => {
          if (next !== version.current) void load();
        })
        .catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  /** Every spend: price it, ask, then run with the agreed amount. */
  async function spend(title: string, url: string, body: Record<string, unknown>, done?: () => void) {
    setError("");
    try {
      const estimate = await api<SpendReply>(url, { ...body, dry_run: true });
      const credits = estimate.estimate_credits ?? 0;
      setPending({
        title,
        detail: `About ${fmt(credits)} credits. Spent today ${fmt(board?.spend.today ?? 0)} of ${fmt(board?.spend.cap ?? null)}.`,
        credits,
        run: async (confirm) => {
          setBusy(`${title}…`);
          try {
            const reply = await api<SpendReply>(url, { ...body, confirm_credits: confirm });
            if (reply.status === "over_daily_cap" || reply.status === "needs_confirmation") throw new Error(reply.message ?? "Not made.");
            const errors = reply.sounds?.flatMap((s) => s.errors ?? []) ?? [];
            if (reply.stopped) setError(reply.stopped);
            else if (errors.length) setError(errors.join(" · "));
            setNotice(`${title}: done${reply.credits_used !== undefined ? `, ${fmt(reply.credits_used)} credits` : ""}. Have a listen.`);
            // Only a batch that made everything clears its picks, so a stopped one is easy to retry.
            if (!reply.stopped && !errors.length) done?.();
            await load();
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : "That did not work.");
          } finally {
            setBusy("");
          }
        },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not price that.");
    }
  }

  if (!board) {
    return (
      <main className="terminal-app">
        <div className="board-loading">{error || "Loading the board…"}</div>
      </main>
    );
  }

  const canMake = Boolean(board.provider);

  return (
    <main className="terminal-app" onPointerDown={resumeAudio}>
      <header className="topbar">
        <div className="brand">
          <PhasecraftMark />
          <span className="brand-text">
            <strong>TAKEBOX</strong>
            <span className="brand-by">
              by
              <img src="/phasecraft-wordmark.png" alt="PHASECRAFT" />
            </span>
          </span>
        </div>
        <nav className="page-tabs">
          {(["sounds", "style", "plan"] as const).map((name) => (
            <button key={name} className={page === name ? "active" : ""} onClick={() => setPage(name)}>
              {name.toUpperCase()}
            </button>
          ))}
        </nav>
        <span className="credit-readout" title="Credits spent today through TAKEBOX, against your daily cap">
          <Zap size={12} />
          {fmt(board.spend.today)} / {fmt(board.spend.cap)}
        </span>
        <button className={`board-mono ${mono ? "on" : ""}`} onClick={() => setMono((m) => !m)} title="Hear it the way a phone speaker does">
          <Volume2 size={11} /> {mono ? "MONO" : "STEREO"}
        </button>
      </header>

      <div className="app-shell board-shell">
        <section className="page-intro board-intro">
          <div>
            <p>
              SOUND BOARD · {board.engine.toUpperCase()} · {board.settings.folder}
            </p>
            <h1>{board.name}</h1>
          </div>
          <span>
            {board.settings.direction ? (
              <>
                Direction <b>{board.settings.direction}</b>
              </>
            ) : (
              "No direction yet. Pick one by ear on the STYLE page before making the game's sounds."
            )}
            {!canMake && <em className="board-warn"> No ElevenLabs key in the MCP config: listening, keeping and the take tools work; making new sounds does not.</em>}
          </span>
        </section>

        {(error || notice || busy) && (
          <div className={`board-status ${error ? "bad" : ""}`}>
            {busy ? <LoaderCircle className="spin" size={13} /> : null}
            <span>{busy || error || notice}</span>
            {!busy && (
              <button onClick={() => (error ? setError("") : setNotice(""))} aria-label="Dismiss">
                ×
              </button>
            )}
          </div>
        )}

        {page === "sounds" && (
          <SoundsPage
            board={board}
            busy={Boolean(busy)}
            canMake={canMake}
            mono={mono}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onError={setError}
            onChanged={load}
            onSpend={spend}
            onGo={setPage}
          />
        )}
        {page === "style" && <StylePage board={board} busy={Boolean(busy)} canMake={canMake} mono={mono} selectedId={selectedId} onSelect={setSelectedId} onError={setError} onChanged={load} onSpend={spend} />}
        {page === "plan" && <PlanPage board={board} busy={Boolean(busy)} canMake={canMake} onError={setError} onSpend={spend} />}
      </div>

      {pending && (
        <div className="board-confirm" role="dialog" aria-modal="true">
          <div className="panel">
            <span>SPEND CREDITS</span>
            <h2>{pending.title}</h2>
            <p>{pending.detail}</p>
            <div className="board-confirm-actions">
              <button onClick={() => setPending(null)}>Cancel</button>
              <button
                className="board-primary"
                onClick={() => {
                  const action = pending;
                  setPending(null);
                  void action.run(action.credits);
                }}
              >
                Spend ~{fmt(pending.credits)}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// ── Shared bits ─────────────────────────────────────────────────────────────────────

type CardProps = {
  busy: boolean;
  mono: boolean;
  selectedId: string;
  onSelect: (id: string) => void;
  onError: (message: string) => void;
  onChanged: () => Promise<void>;
};

function TakeCard({ take, onRegenerate, ...props }: CardProps & { take: AudioResult; onRegenerate: () => void }) {
  return (
    <WaveformCard
      result={take}
      autoPlay={false}
      disabled={props.busy}
      mono={props.mono}
      selected={props.selectedId === take.id}
      onSelect={() => props.onSelect(take.id)}
      onDisposition={async (value) => {
        try {
          await api(`/api/audio/${take.id}/disposition`, { value });
          await props.onChanged();
        } catch (caught) {
          props.onError(caught instanceof Error ? caught.message : "Could not save that.");
        }
      }}
      onRegenerate={onRegenerate}
      onExport={() => void props.onChanged()}
      onError={props.onError}
      rejectTitle="Reject: move its files to .takebox/rejected in the project (never deleted)"
    />
  );
}

type SpendFn = (title: string, url: string, body: Record<string, unknown>, done?: () => void) => Promise<void>;

// ── SOUNDS ──────────────────────────────────────────────────────────────────────────

function SoundsPage({ board, canMake, onSpend, onGo, ...card }: CardProps & { board: BoardState; canMake: boolean; onSpend: SpendFn; onGo: (page: "style" | "plan") => void }) {
  const [drafts, setDrafts] = useState<Record<string, { prompt: string; variations: number }>>({});
  const [current, setCurrent] = useState("");
  const [missing, setMissing] = useState<Plan["missingAudio"]>([]);
  // Sounds ticked for new takes together: one estimate, one yes (Ryu, 11-10).
  const [ticked, setTicked] = useState<string[]>([]);
  const groups = useMemo(() => {
    const map = new Map<string, Sound[]>();
    for (const sound of board.sounds) map.set(sound.group, [...(map.get(sound.group) ?? []), sound]);
    return [...map.entries()].sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]));
  }, [board.sounds]);
  const order = useMemo(() => groups.flatMap(([, sounds]) => sounds.map((sound) => sound.name)), [groups]);
  // One sound at a time (Ryu, 11-10): the sidebar picks it. A sound that was removed falls back to the first.
  const shown = board.sounds.find((sound) => sound.name === current) ?? board.sounds.find((sound) => sound.name === order[0]);

  // Files the code asks for that do not exist yet. Read once, quietly: PLAN is where they are dealt with.
  useEffect(() => {
    let live = true;
    api<Plan>("/api/plan").then((scan) => live && setMissing(scan.missingAudio), () => undefined);
    return () => {
      live = false;
    };
  }, []);

  // Arrow keys move the selection; keep focus on the sound now shown, so the next arrow carries on from it.
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    if (nav.current?.contains(document.activeElement)) nav.current.querySelector<HTMLButtonElement>("button.active")?.focus();
  }, [shown?.name]);

  const promptOf = (item: Sound) => (drafts[item.name]?.prompt ?? item.prompt).trim();
  const variationsOf = (item: Sound) => drafts[item.name]?.variations ?? 1;
  const picked = board.sounds.filter((item) => ticked.includes(item.name) && promptOf(item));
  const pickedCost = picked.reduce(
    (sum, item) => sum + costOf({ duration_s: item.durationS ?? DEFAULT_DURATION[item.kind], variations: variationsOf(item) }, board.spend.perSecond),
    0,
  );
  const tick = (name: string) => setTicked((t) => (t.includes(name) ? t.filter((n) => n !== name) : [...t, name]));
  const redoPicked = () =>
    void onSpend(
      `New takes of ${picked.map((item) => `${item.name} ×${variationsOf(item)}`).join(", ")}`,
      "/api/redo-many",
      { sounds: picked.map((item) => ({ name: item.name, prompt: promptOf(item), variations: variationsOf(item) })) },
      () => setTicked([]),
    );

  const step = (by: number) => {
    const at = order.indexOf(shown?.name ?? "");
    const next = order[Math.min(order.length - 1, Math.max(0, at + by))];
    if (next) setCurrent(next);
  };

  if (board.sounds.length === 0) {
    return (
      <div className="empty-state board-empty">
        <Sparkles size={22} />
        <h3>No sounds yet</h3>
        <p>Hear a few styles first, then let TAKEBOX read your game and plan the rest.</p>
        <div className="board-row">
          <button onClick={() => onGo("style")}>Pick a style</button>
          <button className="board-primary" onClick={() => onGo("plan")}>
            Plan from my game
          </button>
        </div>
      </div>
    );
  }

  const sound = shown!;
  const draft = drafts[sound.name] ?? { prompt: sound.prompt, variations: 1 };
  const seconds = sound.durationS ?? DEFAULT_DURATION[sound.kind];
  const redo = (variations: number, prompt = draft.prompt) => void onSpend(`New takes of ${sound.name} ×${variations}`, "/api/redo", { name: sound.name, prompt, variations });

  return (
    <div className="sounds-layout">
      <nav
        ref={nav}
        className="sound-nav panel"
        aria-label="Sounds"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            step(e.key === "ArrowDown" ? 1 : -1);
          }
        }}
      >
        {groups.map(([group, sounds]) => (
          <section key={group}>
            <h2>{group}</h2>
            {sounds.map((item) => (
              <div key={item.name} className={`sound-nav-row ${item.name === sound.name ? "active" : ""}`}>
                <input
                  type="checkbox"
                  checked={ticked.includes(item.name) && Boolean(promptOf(item))}
                  disabled={!promptOf(item)}
                  onChange={() => tick(item.name)}
                  aria-label={`Pick ${item.name} for new takes`}
                  title={promptOf(item) ? "Pick for new takes, made together" : "Came from a file: write a prompt for it first"}
                />
                <button
                  className={item.name === sound.name ? "active" : ""}
                  aria-current={item.name === sound.name ? "true" : undefined}
                  onClick={() => setCurrent(item.name)}
                >
                  <span>{item.name}</span>
                  <small>
                    {item.kept > 0 && (
                      <b>
                        <Check size={9} /> {item.kept}
                      </b>
                    )}
                    {item.takes.length}
                  </small>
                </button>
              </div>
            ))}
          </section>
        ))}
        {picked.length > 0 && (
          <div className="sound-nav-batch">
            <span>
              {picked.length} sound{picked.length === 1 ? "" : "s"} picked · ~{fmt(pickedCost)} credits
            </span>
            <button className="board-primary" disabled={card.busy || !canMake} onClick={redoPicked} title="Each with its own prompt and number of takes, as set on its page">
              <Wand2 size={12} /> Make {picked.length} picked
            </button>
            <button onClick={() => setTicked([])}>Clear</button>
          </div>
        )}
        {missing.length > 0 && (
          <section className="sound-nav-missing">
            <h2>Missing in your code</h2>
            {missing.map((m) => (
              <button key={`${m.reference}@${m.at}`} onClick={() => onGo("plan")} title={`${m.at} asks for this file. Plan it on the PLAN page.`}>
                <span>{m.reference.split(/[\\/]/).pop()}</span>
                <small>plan</small>
              </button>
            ))}
          </section>
        )}
      </nav>

      <article key={sound.name} className="panel sound-block">
        <div className="sound-head">
          <h3>{sound.name}</h3>
          <span className="board-chips">
            <i>{sound.kind}</i>
            <i>{sound.role}</i>
            {sound.source === "file" && <i>from file</i>}
            <i>
              {sound.takes.length} take{sound.takes.length === 1 ? "" : "s"}
            </i>
            {sound.kept > 0 && (
              <i className="kept">
                <Check size={10} /> {sound.kept} kept
              </i>
            )}
          </span>
        </div>
        <div className="sound-prompt">
          <textarea
            value={draft.prompt}
            placeholder={sound.source === "file" ? "Brought in from a file. Write a prompt to generate new takes." : ""}
            onChange={(e) => setDrafts((d) => ({ ...d, [sound.name]: { ...draft, prompt: e.target.value } }))}
            rows={2}
          />
          <select value={draft.variations} onChange={(e) => setDrafts((d) => ({ ...d, [sound.name]: { ...draft, variations: Number(e.target.value) } }))}>
            {[1, 2, 3, 4, 6].map((n) => (
              <option key={n} value={n}>
                ×{n}
              </option>
            ))}
          </select>
          <button className="board-primary" disabled={card.busy || !canMake || !draft.prompt.trim()} onClick={() => redo(draft.variations)}>
            <Wand2 size={12} /> New takes of {sound.name}
            {picked.length > 0 ? " only" : ""} · ~{fmt(costOf({ duration_s: seconds, variations: draft.variations }, board.spend.perSecond))}
          </button>
        </div>
        <div className="take-list">
          {sound.takes.map((take) => (
            <TakeCard key={take.id} take={take} {...card} onRegenerate={() => redo(1)} />
          ))}
        </div>
      </article>
    </div>
  );
}

// ── STYLE ───────────────────────────────────────────────────────────────────────────

function StylePage({ board, canMake, onSpend, ...card }: CardProps & { board: BoardState; canMake: boolean; onSpend: SpendFn }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [own, setOwn] = useState("");
  const [direction, setDirection] = useState(board.settings.direction);
  useEffect(() => setDirection(board.settings.direction), [board.settings.direction]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 4 ? p : [...p, id]));
  const saveDirection = async (value: string) => {
    try {
      await api("/api/direction", { direction: value });
      await card.onChanged();
      return true;
    } catch (caught) {
      card.onError(caught instanceof Error ? caught.message : "Could not save the direction.");
      return false;
    }
  };

  return (
    <div className="style-page">
      <section className="panel style-direction">
        <label className="field">
          <span>The game's direction · every prompt carries it</span>
          <input value={direction} placeholder="e.g. soft wooden toy-like, warm and rounded" onChange={(e) => setDirection(e.target.value)} />
        </label>
        <button disabled={direction === board.settings.direction} onClick={() => void saveDirection(direction)}>
          Save
        </button>
      </section>

      <section>
        <div className="board-section-head">
          <h2>Hear styles side by side</h2>
          <p>Pick up to four. Each makes a jump, a coin and a hit, one take each. The cost shows before anything is spent.</p>
        </div>
        <div className="style-grid">
          {board.styles.map((style) => (
            <button key={style.id} className={`style-card ${picked.includes(style.id) ? "picked" : ""}`} onClick={() => toggle(style.id)}>
              <strong>{style.name}</strong>
              <small>{style.about}</small>
              <em>{style.direction}</em>
            </button>
          ))}
          <div className="style-card own">
            <strong>Your own words</strong>
            <input value={own} placeholder="e.g. squishy slime and bubbles" onChange={(e) => setOwn(e.target.value)} />
            <span className="style-own-actions">
              <button disabled={!own.trim() || picked.length >= 4 || picked.includes(own.trim())} onClick={() => (setPicked((p) => [...p, own.trim()]), setOwn(""))} title="Hear it beside the others first (costs credits)">
                <Plus size={11} /> Add to hear
              </button>
              {/* Free: skip hearing it and make these words the game's direction now (Ryu, 11-10). */}
              <button disabled={!own.trim() || own.trim() === board.settings.direction} onClick={() => void saveDirection(own.trim()).then((saved) => saved && setOwn(""))} title="Make these words the game's direction now, without hearing them (free)">
                Use now
              </button>
            </span>
          </div>
        </div>
        <div className="board-row">
          <span className="board-muted">{picked.length ? picked.map((id) => board.styles.find((s) => s.id === id)?.name ?? id).join(" · ") : "Nothing picked yet"}</span>
          <button className="board-primary" disabled={!picked.length || card.busy || !canMake} onClick={() => void onSpend(`Hear ${picked.length} style${picked.length > 1 ? "s" : ""}`, "/api/audition", { styles: picked })}>
            <Sparkles size={12} /> Hear {picked.length || ""} style{picked.length === 1 ? "" : "s"}
          </button>
        </div>
      </section>

      {board.auditions.length > 0 && (
        <section className="board-auditions">
          <div className="board-section-head">
            <h2>Auditions</h2>
            <p>Same three sounds in each style. Use the one that sounds like your game.</p>
          </div>
          {board.auditions.map((audition) => (
            <article key={audition.key} className={`panel audition ${audition.chosen ? "chosen" : ""}`}>
              <div className="sound-head">
                <h3>{audition.label}</h3>
                <span className="board-chips">
                  <i>{audition.direction}</i>
                  {audition.chosen ? (
                    <i className="kept">
                      <Check size={10} /> the game's direction
                    </i>
                  ) : (
                    <button className="board-primary" onClick={() => void saveDirection(audition.direction)}>
                      Use this style
                    </button>
                  )}
                </span>
              </div>
              <div className="take-list">
                {audition.takes.map((take) => (
                  <TakeCard key={take.id} take={take} {...card} onRegenerate={() => card.onError("Audition takes are made once. Pick the style, then make the game's sounds.")} />
                ))}
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

// ── PLAN ────────────────────────────────────────────────────────────────────────────

function PlanPage({ board, busy, canMake, onError, onSpend }: { board: BoardState; busy: boolean; canMake: boolean; onError: (m: string) => void; onSpend: SpendFn }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [reading, setReading] = useState(false);
  const [rows, setRows] = useState<(Draft & { on: boolean; evidence?: string[]; made?: boolean })[]>([]);

  const read = useCallback(async () => {
    setReading(true);
    try {
      const scan = await api<Plan>("/api/plan");
      setPlan(scan);
      setRows(scan.cues.map((cue) => ({ ...cue.suggestion, on: !cue.alreadyMade, evidence: cue.evidence, made: Boolean(cue.alreadyMade) })));
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Could not read the game.");
    } finally {
      setReading(false);
    }
  }, [onError]);

  useEffect(() => {
    void read();
  }, [read]);

  const set = (index: number, change: Partial<Draft & { on: boolean }>) => setRows((r) => r.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const chosen = rows.filter((row) => row.on && row.name.trim() && row.prompt.trim());
  const total = chosen.reduce((sum, row) => sum + costOf(row, board.spend.perSecond), 0);

  return (
    <div className="plan-page">
      <div className="board-section-head">
        <h2>What your game needs</h2>
        <p>
          Read from the code: each line is a moment that likely wants a sound, with where it was found. Untick what is wrong, edit any prompt, add
          what the code does not show.
        </p>
        <button disabled={reading} onClick={() => void read()}>
          {reading ? <LoaderCircle className="spin" size={12} /> : <FileSearch size={12} />} Read my game again
        </button>
      </div>

      {plan && (
        <div className="plan-facts">
          <span>{plan.filesScanned} files read</span>
          {plan.styleHints.length > 0 && <span>Style words: {plan.styleHints.map((h) => h.word).join(", ")}</span>}
          {plan.playback.length > 0 && <span>Plays sound with: {[...new Set(plan.playback.map((p) => p.library))].join(", ")}</span>}
          {plan.missingAudio.map((m) => (
            <span key={m.at} className="missing">
              Missing: {m.reference} ({m.at})
            </span>
          ))}
        </div>
      )}
      {!board.settings.direction && <p className="board-warn">No direction set: the prompts below are plain. Pick a style first and they will carry it.</p>}

      <div className="plan-rows">
        {rows.map((row, index) => (
          <div key={index} className={`panel plan-row ${row.on ? "" : "off"}`}>
            <label className="plan-check">
              <input type="checkbox" checked={row.on} onChange={(e) => set(index, { on: e.target.checked })} />
            </label>
            <div className="plan-main">
              <div className="plan-line">
                <input className="plan-name" value={row.name} onChange={(e) => set(index, { name: e.target.value })} />
                <select value={row.kind} onChange={(e) => set(index, { kind: e.target.value as Kind })}>
                  {KINDS.map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
                <select value={row.role} onChange={(e) => set(index, { role: e.target.value as Role })}>
                  {ROLES.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
                <label>
                  ×<input type="number" min={1} max={8} value={row.variations} onChange={(e) => set(index, { variations: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })} />
                </label>
                <label>
                  <input type="number" min={0.5} max={30} step={0.1} value={row.duration_s} onChange={(e) => set(index, { duration_s: Math.max(0.5, Math.min(30, Number(e.target.value) || 1)) })} />s
                </label>
                <span className="plan-cost">~{fmt(costOf(row, board.spend.perSecond))}</span>
                {row.made && <i className="plan-made">already made</i>}
              </div>
              <textarea rows={2} value={row.prompt} onChange={(e) => set(index, { prompt: e.target.value })} />
              {row.evidence?.[0] && <small className="plan-evidence">{row.evidence[0]}</small>}
            </div>
          </div>
        ))}
        <button
          className="plan-add"
          onClick={() => setRows((r) => [...r, { name: "", prompt: "", kind: "one-shot", role: "sfx", variations: 1, duration_s: 1, on: true }])}
        >
          <Plus size={12} /> Add a sound
        </button>
      </div>

      <div className="plan-footer">
        <span>
          {chosen.length} sound{chosen.length === 1 ? "" : "s"} · ~{fmt(total)} credits
        </span>
        <button
          className="board-primary"
          disabled={!chosen.length || busy || !canMake}
          onClick={() =>
            void onSpend(`Make ${chosen.length} sound${chosen.length === 1 ? "" : "s"}`, "/api/make", {
              sounds: chosen.map(({ on: _on, evidence: _e, made: _m, ...spec }) => spec),
            })
          }
        >
          <Wand2 size={12} /> Make {chosen.length} sound{chosen.length === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );
}
