import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  FolderSearch,
  Layers3,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Repeat,
  Scissors,
  Shrink,
  Split,
  Square,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import type { AudioResult, Loudness } from "./types";
import { TRIM_PRESETS } from "../shared/dsp/segment";
import { audioContext, outputFor, resumeAudio } from "./audioOutput";

type Tool = "tighten" | "split" | "loop";

/** What the keyboard asks of the selected card. App owns the keys; the card owns playback. */
export type TakeAction = "toggle" | "stop";
export const TAKE_ACTION_EVENT = "takebox-take";

/** Longer takes are measured only when opened: measuring decodes the whole file. */
const MEASURE_ON_SIGHT_S = 60;
/** Above this, a game's own mixing can clip the sound. */
const TRUE_PEAK_LIMIT = -1;

type GaplessPlayer = {
  source: AudioBufferSourceNode;
  gain: GainNode;
  buffer: AudioBuffer;
  /** Context time at which the buffer's start would have played: the cursor counts from here. */
  startedAt: number;
  timer: number;
};

function playBuffer(context: AudioContext, buffer: AudioBuffer, into: AudioNode, offset: number) {
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(into);
  source.start(0, offset);
  return source;
}

function formatLufs(value: number | null) {
  return value === null || value <= -119 ? "—" : value.toFixed(1);
}

/** How often the cursor follows a gapless loop. Seeking the media element every frame is wasteful. */
const LOOP_CURSOR_MS = 50;

type Props = {
  result: AudioResult;
  autoPlay: boolean;
  disabled: boolean;
  /** Fold playback to mono. */
  mono: boolean;
  /** The take the keyboard acts on. */
  selected: boolean;
  onSelect: () => void;
  onDisposition: (value: "keep" | "reject") => void | Promise<void>;
  onRegenerate: () => void;
  onExport: (result: AudioResult) => void;
  onError: (message: string) => void;
  /** What Reject does here: the desktop trashes the WAV, the MCP board moves it aside. */
  rejectTitle?: string;
};

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "00:00.000";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(3).padStart(6, "0")}`;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload;
}

export default function WaveformCard({
  result,
  autoPlay,
  disabled,
  mono,
  selected,
  onSelect,
  onDisposition,
  onRegenerate,
  onExport,
  onError,
  rejectTitle = "Reject and move WAV to Trash",
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<WaveSurfer | null>(null);
  const regionRef = useRef<Region | null>(null);
  const loopRegionRef = useRef(false);
  const loopPreviewRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [zoom, setZoom] = useState(45);
  const [region, setRegion] = useState<{ start: number; end: number } | null>(null);
  // A finished loop is auditioned as a loop: that is the only way to judge it.
  const [loopPreview, setLoopPreview] = useState(Boolean(result.loopable));
  const [loopRegion, setLoopRegion] = useState(false);
  const [tool, setTool] = useState<Tool | "">("");
  const [splitPreset, setSplitPreset] = useState(TRIM_PRESETS[0]!.id);
  // Wavesurfer restarts a looping file with an audible gap, so a loopable take plays through
  // Web Audio instead, where the buffer repeats sample-for-sample.
  const gaplessRef = useRef<GaplessPlayer | null>(null);
  const loopBufferRef = useRef<AudioBuffer | null>(null);
  // Every start takes a token. Stop, another take playing, a mode change and unmounting all spend
  // it, so a start still loading or decoding when one of those happens never makes a sound
  // (Codex review 2026-10-19, finding 7).
  const startTokenRef = useRef(0);
  // Set once the media element has been routed through Web Audio for mono; it stays routed.
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const monoRef = useRef(mono);
  const [loudness, setLoudness] = useState<Loudness | null>(result.loudness ?? null);
  const actionRef = useRef<(action: TakeAction) => void>(() => {});
  const [exporting, setExporting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [separatingStems, setSeparatingStems] = useState<"" | "two_stems_v1" | "six_stems_v1">("");
  const [stemMessage, setStemMessage] = useState("");

  useEffect(() => {
    if (!containerRef.current) return;
    const regions = RegionsPlugin.create();
    const wave = WaveSurfer.create({
      container: containerRef.current,
      url: `/api/audio/${result.id}`,
      height: 28,
      waveColor: "#58606d",
      progressColor: "#d5fe55",
      cursorColor: "#f2f5e9",
      cursorWidth: 1,
      barWidth: 2,
      barGap: 2,
      barRadius: 2,
      normalize: false,
      minPxPerSec: zoom,
      plugins: [regions],
    });
    waveRef.current = wave;
    wave.setVolume(volume);
    const stopDrag = regions.enableDragSelection({ color: "rgba(213, 254, 85, .18)" });

    const syncRegion = (selected: Region) => {
      setRegion({ start: selected.start, end: selected.end });
    };

    regions.on("region-created", (selected) => {
      if (regionRef.current && regionRef.current.id !== selected.id) regionRef.current.remove();
      regionRef.current = selected;
      syncRegion(selected);
    });
    regions.on("region-updated", syncRegion);
    regions.on("region-out", (selected) => {
      if (loopRegionRef.current && selected.id === regionRef.current?.id) selected.play();
    });
    wave.on("ready", () => {
      setReady(true);
      if (autoPlay) {
        window.dispatchEvent(new CustomEvent("sourceforge-play", { detail: result.id }));
        if (result.loopable) void startGapless().catch(() => void wave.play());
        else void wave.play();
      }
    });
    wave.on("play", () => {
      window.dispatchEvent(new CustomEvent("sourceforge-play", { detail: result.id }));
      setPlaying(true);
    });
    wave.on("pause", () => setPlaying(false));
    wave.on("finish", () => {
      if (loopPreviewRef.current) {
        wave.setTime(0);
        void wave.play();
      } else {
        setPlaying(false);
      }
    });
    wave.on("timeupdate", setCurrent);
    // A click on the waveform moves the loop too, not only the cursor (finding 8).
    wave.on("interaction", (time: number) => seekGapless(time));
    wave.on("error", (message) => onError(`Waveform error: ${String(message)}`));

    const stopForOther = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== result.id) {
        stopGapless();
        wave.pause();
        wave.setTime(0);
      }
    };
    window.addEventListener("sourceforge-play", stopForOther);

    return () => {
      stopDrag();
      window.removeEventListener("sourceforge-play", stopForOther);
      stopGapless();
      wave.destroy();
      waveRef.current = null;
    };
    // The WaveSurfer instance is intentionally created only for this immutable result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.id]);

  // One transport at a time, whichever mode is on: never the loop and the waveform's own player
  // together (finding 9).
  useEffect(() => {
    loopPreviewRef.current = loopPreview;
    if (!loopPreview) stopGapless();
    else if (waveRef.current?.isPlaying()) waveRef.current.pause();
  }, [loopPreview]);

  useEffect(() => {
    loopRegionRef.current = loopRegion;
  }, [loopRegion]);

  // Mono: route the element through the fold the first time it is needed, then switch the
  // connection. A gapless loop that is playing switches with it.
  useEffect(() => {
    monoRef.current = mono;
    const wave = waveRef.current;
    if (!ready || !wave) return;
    if (mono && !mediaSourceRef.current) {
      mediaSourceRef.current = audioContext().createMediaElementSource(wave.getMediaElement());
    }
    if (mediaSourceRef.current) {
      mediaSourceRef.current.disconnect();
      mediaSourceRef.current.connect(outputFor(mono));
    }
    const player = gaplessRef.current;
    if (player) {
      player.gain.disconnect();
      player.gain.connect(outputFor(mono));
    }
  }, [mono, ready]);

  useEffect(() => {
    if (loudness || !ready || (result.duration > MEASURE_ON_SIGHT_S && !expanded)) return;
    let cancelled = false;
    fetch(`/api/audio/${result.id}/loudness`)
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { loudness?: Loudness } | null) => {
        if (!cancelled && payload?.loudness) setLoudness(payload.loudness);
      })
      .catch(() => {
        // A missing meter reading is not worth an error banner.
      });
    return () => {
      cancelled = true;
    };
  }, [ready, expanded, loudness, result.id, result.duration]);

  useEffect(() => {
    const onAction = (event: Event) => {
      const { id, action } = (event as CustomEvent<{ id: string; action: TakeAction }>).detail;
      if (id === result.id) actionRef.current(action);
    };
    window.addEventListener(TAKE_ACTION_EVENT, onAction);
    return () => window.removeEventListener(TAKE_ACTION_EVENT, onAction);
  }, [result.id]);

  async function startGapless() {
    const wave = waveRef.current;
    if (!wave || gaplessRef.current) return;
    const token = ++startTokenRef.current;
    const live = () => token === startTokenRef.current && waveRef.current === wave;
    const context = audioContext();
    if (context.state === "suspended") await context.resume();
    if (!live()) return;
    if (!loopBufferRef.current) {
      try {
        const response = await fetch(`/api/audio/${result.id}`);
        if (!live()) return;
        if (!response.ok) throw new Error("Could not load the loop for playback.");
        const data = await response.arrayBuffer();
        if (!live()) return;
        loopBufferRef.current = await context.decodeAudioData(data);
      } catch (error) {
        // A start that was cancelled fails quietly. Rethrown, its failure would reach the
        // caller's fallback and start the media element after Stop (Codex re-check 2026-10-20).
        if (!live()) return;
        throw error;
      }
      if (!live()) return;
    }
    if (gaplessRef.current) return;
    if (wave.isPlaying()) wave.pause();
    const buffer = loopBufferRef.current;
    const gain = context.createGain();
    gain.gain.value = wave.getVolume();
    gain.connect(outputFor(monoRef.current));
    const offset = wave.getCurrentTime() < buffer.duration - 0.01 ? wave.getCurrentTime() : 0;
    const player: GaplessPlayer = {
      source: playBuffer(context, buffer, gain, offset),
      gain,
      buffer,
      startedAt: context.currentTime - offset,
      timer: 0,
    };
    player.timer = window.setInterval(() => {
      wave.setTime((context.currentTime - player.startedAt) % buffer.duration);
    }, LOOP_CURSOR_MS);
    gaplessRef.current = player;
    window.dispatchEvent(new CustomEvent("sourceforge-play", { detail: result.id }));
    setPlaying(true);
  }

  /** Restart the playing loop at a point in the buffer: a source cannot be moved once started. */
  function seekGapless(time: number) {
    const player = gaplessRef.current;
    if (!player) return;
    const context = audioContext();
    const length = player.buffer.duration;
    const offset = ((time % length) + length) % length;
    try {
      player.source.stop();
    } catch {
      // Already stopped.
    }
    player.source.disconnect();
    player.source = playBuffer(context, player.buffer, player.gain, offset);
    player.startedAt = context.currentTime - offset;
  }

  function stopGapless() {
    startTokenRef.current += 1;
    const player = gaplessRef.current;
    if (!player) return;
    window.clearInterval(player.timer);
    try {
      player.source.stop();
    } catch {
      // Already stopped.
    }
    player.source.disconnect();
    player.gain.disconnect();
    gaplessRef.current = null;
    setPlaying(false);
  }

  function togglePlay() {
    const wave = waveRef.current;
    if (!wave) return;
    resumeAudio();
    if (result.loopable && loopPreview) {
      if (gaplessRef.current) stopGapless();
      else void startGapless().catch((caught) => onError(caught instanceof Error ? caught.message : "Loop playback failed."));
      return;
    }
    if (!wave.isPlaying()) {
      window.dispatchEvent(new CustomEvent("sourceforge-play", { detail: result.id }));
    }
    void wave.playPause();
  }

  function stop() {
    stopGapless();
    waveRef.current?.pause();
    waveRef.current?.setTime(0);
    setCurrent(0);
  }

  actionRef.current = (action) => {
    if (action === "toggle") togglePlay();
    else stop();
  };

  async function runTool(kind: Tool) {
    setTool(kind);
    try {
      const payload = await postJson<{ results: AudioResult[] }>(
        `/api/audio/${result.id}/${kind}`,
        kind === "split" ? { preset: splitPreset } : {},
      );
      // Each new card goes on top, so add the last first and the first cut ends up first.
      for (const item of [...payload.results].reverse()) onExport(item);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "The take tool failed.");
    } finally {
      setTool("");
    }
  }

  function clearRegion() {
    regionRef.current?.remove();
    regionRef.current = null;
    setRegion(null);
    setLoopRegion(false);
  }

  function playRegion() {
    if (!regionRef.current) return;
    stopGapless();
    window.dispatchEvent(new CustomEvent("sourceforge-play", { detail: result.id }));
    regionRef.current.play();
  }

  async function exportRegion() {
    if (!region) return;
    setExporting(true);
    try {
      const payload = await postJson<{ result: AudioResult }>(`/api/audio/${result.id}/export`, region);
      onExport(payload.result);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Region export failed.");
    } finally {
      setExporting(false);
    }
  }

  async function reveal() {
    try {
      await postJson("/api/reveal", { id: result.id });
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Could not reveal file.");
    }
  }

  async function reject() {
    setRejecting(true);
    try {
      await onDisposition("reject");
    } finally {
      setRejecting(false);
    }
  }

  async function exportStems(variation: "two_stems_v1" | "six_stems_v1") {
    setSeparatingStems(variation);
    setStemMessage("");
    try {
      const payload = await postJson<{ ok: boolean; filename: string }>(
        `/api/audio/${result.id}/stems`,
        { variation },
      );
      setStemMessage(`${payload.filename} saved beside the mix.`);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Stem separation failed.");
    } finally {
      setSeparatingStems("");
    }
  }

  return (
    <article
      id={`take-${result.id}`}
      className={`wave-card ${result.disposition || "new"} ${expanded ? "expanded" : ""} ${selected ? "selected" : ""}`}
      onMouseDown={onSelect}
    >
      <div className="compact-wave-row">
        <div className="compact-file">
          <span className="file-index">{result.loopable ? "LOOP" : result.exported ? "EDIT" : result.label.toUpperCase()}</span>
          <h3 title={result.filename}>{result.filename}</h3>
          {result.notice && <small className="take-notice" title={result.notice}>{result.notice}</small>}
        </div>
        <div className="compact-transport">
          <button className="transport-main" onClick={togglePlay} disabled={!ready} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
          </button>
          <button className="icon-button" onClick={stop} disabled={!ready} aria-label="Stop">
            <Square size={10} fill="currentColor" />
          </button>
        </div>

        <div className="waveform-shell">
          <div ref={containerRef} className="waveform" />
          {!ready && <div className="wave-loading">Decoding…</div>}
          <div className="timeline-readout">
            <span>{formatTime(current)}</span>
            {loudness && (
              // One-shots compare by their loudest 400 ms; longer takes by the whole.
              result.duration < 3 || loudness.integrated === null ? (
                <span className="loudness-readout" title="Loudness of the loudest 400 ms (LUFS-M max). Compare one-shots by this.">
                  {formatLufs(loudness.momentaryMax)} LUFS-M
                </span>
              ) : (
                <span className="loudness-readout" title="Integrated loudness of the whole take (LUFS-I).">
                  {formatLufs(loudness.integrated)} LUFS-I
                </span>
              )
            )}
            <span>{formatTime(result.duration)}</span>
          </div>
        </div>

        <div className="quick-review">
          <button
            className={result.disposition === "keep" ? "keep active" : "keep"}
            onClick={() => onDisposition("keep")}
            aria-label="Keep"
            title="Keep"
          >
            <Check size={13} />
          </button>
          <button
            className={result.disposition === "reject" ? "reject active" : "reject"}
            disabled={rejecting}
            onClick={() => void reject()}
            aria-label="Reject"
            title={rejectTitle}
          >
            {rejecting ? <LoaderCircle className="spin" size={13} /> : <X size={13} />}
          </button>
          <button
            onClick={() => setExpanded((currentValue) => !currentValue)}
            aria-expanded={expanded}
            aria-label={expanded ? "Hide audio tools" : "Show audio tools"}
            title={expanded ? "Hide audio tools" : "Show tighten, split, loop, trim, zoom, regenerate, and Finder tools"}
          >
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="wave-card-details">
          <div className="file-meta">
            <span>{formatTime(result.duration)}</span>
            <span>{(result.sampleRate / 1000).toFixed(0)} kHz</span>
            <span>24-bit WAV</span>
            {loudness && (
              <>
                <span title="Integrated loudness over the whole take">I {formatLufs(loudness.integrated)} LUFS</span>
                <span title="Loudest 400 ms">M max {formatLufs(loudness.momentaryMax)} LUFS</span>
                <span
                  className={loudness.truePeak > TRUE_PEAK_LIMIT ? "peak-warning" : ""}
                  title={loudness.truePeak > TRUE_PEAK_LIMIT ? "Above −1 dBTP: may clip once a game mixes it" : "True peak, from 4× oversampling"}
                >
                  TP {formatLufs(loudness.truePeak)} dBTP
                </span>
              </>
            )}
            {result.songId && <span title={result.songId}>EDIT ID {result.songId.slice(0, 8)}…</span>}
            {result.disposition === "keep" && <b className="kept"><Check size={12} /> KEPT</b>}
            {result.disposition === "reject" && <b className="rejected"><X size={12} /> REJECTED</b>}
          </div>
          <div className="transport">
            <label className="compact-slider">
              <Volume2 size={15} />
              <input type="range" min="0" max="1" step=".05" value={volume} onChange={(event) => { const next = Number(event.target.value); setVolume(next); waveRef.current?.setVolume(next); if (gaplessRef.current) gaplessRef.current.gain.gain.value = next; }} />
            </label>
            <label className="compact-slider zoom-slider">
              <span>ZOOM</span>
              <input type="range" min="10" max="240" step="5" value={zoom} onChange={(event) => { const next = Number(event.target.value); setZoom(next); waveRef.current?.zoom(next); }} />
            </label>
            <label className="mini-toggle" title={result.loopable ? "Repeats without a gap, exactly as a game engine will" : "Restarts at the end — not seamless, so not a test of a loop"}><input type="checkbox" checked={loopPreview} onChange={(event) => setLoopPreview(event.target.checked)} /><span /> {result.loopable ? "Play as loop" : "Loop preview"}</label>
          </div>

          {/* The take tools: the same steps game-ready templates run automatically, by hand. */}
          <div className="take-tools">
            <span className="take-tools-label">GAME-READY TOOLS</span>
            <button disabled={Boolean(tool)} onClick={() => void runTool("tighten")} title="Remove the silence at the start and the end, with a short fade at each cut">
              {tool === "tighten" ? <LoaderCircle className="spin" size={13} /> : <Shrink size={13} />} Tighten
            </button>
            <span className="split-control">
              <button disabled={Boolean(tool)} onClick={() => void runTool("split")} title="Cut each separate sound — every footstep, every hit — into its own file">
                {tool === "split" ? <LoaderCircle className="spin" size={13} /> : <Split size={13} />} Split
              </button>
              <select value={splitPreset} disabled={Boolean(tool)} onChange={(event) => setSplitPreset(event.target.value)} aria-label="What the take contains">
                {TRIM_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
              </select>
            </span>
            <button disabled={Boolean(tool)} onClick={() => void runTool("loop")} title="Make a seamless loop from the steady part of the take">
              {tool === "loop" ? <LoaderCircle className="spin" size={13} /> : <Repeat size={13} />} Make loop
            </button>
          </div>

          <div className="region-bar">
            <div className="region-info">
              <Scissors size={15} />
              {region ? (
                <span><b>REGION</b> {formatTime(region.start)} — {formatTime(region.end)} <strong>{(region.end - region.start).toFixed(3)}s</strong></span>
              ) : (
                <span>Drag across the waveform to select a region</span>
              )}
            </div>
            <div className="region-actions">
              <button disabled={!region} onClick={playRegion}><Play size={13} /> Play region</button>
              <label className="mini-toggle"><input type="checkbox" disabled={!region} checked={loopRegion} onChange={(event) => setLoopRegion(event.target.checked)} /><span /> Loop region</label>
              <button disabled={!region} onClick={clearRegion}><Trash2 size={13} /> Clear</button>
              <button className="export" disabled={!region || exporting} onClick={() => void exportRegion()}><Download size={13} /> {exporting ? "Exporting…" : "Export selection"}</button>
            </div>
          </div>

          <div className="review-actions">
            <button disabled={disabled} onClick={onRegenerate}><RefreshCw size={14} /> Regenerate</button>
            {result.kind === "music" && (
              <>
                <button disabled={Boolean(separatingStems)} onClick={() => void exportStems("two_stems_v1")}>
                  {separatingStems === "two_stems_v1" ? <LoaderCircle className="spin" size={13} /> : <Layers3 size={13} />}
                  2 Stems
                </button>
                <button disabled={Boolean(separatingStems)} onClick={() => void exportStems("six_stems_v1")}>
                  {separatingStems === "six_stems_v1" ? <LoaderCircle className="spin" size={13} /> : <Layers3 size={13} />}
                  6 Stems
                </button>
              </>
            )}
            <button onClick={() => void reveal()}><FolderSearch size={14} /> Reveal in Finder</button>
          </div>
          {stemMessage && <div className="stem-success"><Check size={12} /> {stemMessage}</div>}
        </div>
      )}
    </article>
  );
}
