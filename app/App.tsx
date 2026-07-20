import { useCallback, useEffect, useRef, useState } from "react";
import { WaterfallCore, COLOR_FORMAT_ERRORS } from "./wasm";
import { Player } from "./player";
import { exportWebCodecs, exportRealtime, webCodecsSupported } from "./export";

const EXPORT_FPS = 30;

const ALIGNMENTS = [
  { label: "Start", value: 0 },
  { label: "End", value: 1 },
  { label: "Middle", value: 2 },
];

const DISPLAY_W = 512;

// The row (post-flip) where the playhead sits, matching the wasm addressing.
function playheadVisualRow(alignment: number, h: number, flipV: boolean): number {
  let row: number;
  if (alignment === 1) row = 0; // end
  else if (alignment === 0) row = h - 1; // start
  else row = Math.round((h - 1) / 2); // middle
  return flipV ? h - 1 - row : row;
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const cs = Math.floor((ms % 1000) / 10);
  return `${m}:${String(s % 60).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function App() {
  const coreRef = useRef<WaterfallCore | null>(null);
  const playerRef = useRef<Player | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null); // visible, upscaled
  const offscreenRef = useRef<HTMLCanvasElement | null>(null); // native w×h
  const imageDataRef = useRef<ImageData | null>(null);
  const rafRef = useRef(0);

  const [ready, setReady] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);

  // Playback
  const [playing, setPlaying] = useState(false);
  const [posMs, setPosMs] = useState(0);
  const [lengthMs, setLengthMs] = useState(0);
  const [volume, setVolume] = useState(0.3);

  // Video settings
  const [width, setWidth] = useState(48);
  const [height, setHeight] = useState(48);
  const [colorFormat, setColorFormat] = useState("bgrx");
  const [colorError, setColorError] = useState<string | null>(null);
  const [flipV, setFlipV] = useState(true);
  const [flipH, setFlipH] = useState(false);
  const [alignment, setAlignment] = useState(2);
  const [playhead, setPlayhead] = useState(true);

  // Audio settings
  const [sampleRate, setSampleRate] = useState(32000);
  const [sampleBytes, setSampleBytes] = useState(1);
  const [channels, setChannels] = useState(1);

  // Export
  const [recording, setRecording] = useState(false);
  const [exportPct, setExportPct] = useState(0);
  const [exportFast] = useState(() => webCodecsSupported());
  const [exportSupported] = useState(
    () =>
      webCodecsSupported() ||
      (typeof MediaRecorder !== "undefined" && "captureStream" in HTMLCanvasElement.prototype)
  );

  // --- Load the wasm core once. ---
  useEffect(() => {
    let cancelled = false;
    WaterfallCore.load("./core.wasm").then((core) => {
      if (cancelled) return;
      coreRef.current = core;
      playerRef.current = new Player();
      playerRef.current.onEnded = () => setPlaying(false);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Rebuild the AudioBuffer whenever the file or audio settings change. ---
  const rebuildAudio = useCallback(() => {
    const core = coreRef.current;
    const player = playerRef.current;
    if (!core || !player || !fileBytes) return;

    const fraction = player.lengthMs > 0 ? player.currentMs() / player.lengthMs : 0;

    core.setAudio(channels, sampleBytes, sampleRate);
    const len = core.audioLengthMs();
    const chans: Float32Array[] = [];
    for (let c = 0; c < channels; c++) chans.push(core.renderAudioChannel(c));
    player.setBuffer(chans, sampleRate, len);
    player.seekMs(fraction * len);
    setLengthMs(len);
    setPosMs(player.currentMs());
  }, [fileBytes, channels, sampleBytes, sampleRate]);

  useEffect(() => {
    rebuildAudio();
  }, [rebuildAudio]);

  // --- Apply video settings to the core (cheap, affects next frame). ---
  useEffect(() => {
    const core = coreRef.current;
    if (!core || !ready) return;
    core.setDims(width, height);
    core.setFlip(flipV, flipH);
    core.setAlignment(alignment);
    core.setPlayhead(false); // the playhead is drawn as a stable overlay in JS

    // Native-resolution offscreen buffer for the raw waterfall pixels.
    if (!offscreenRef.current) offscreenRef.current = document.createElement("canvas");
    const off = offscreenRef.current;
    off.width = core.width;
    off.height = core.height;
    imageDataRef.current = off.getContext("2d")!.createImageData(core.width, core.height);

    // Visible canvas is upscaled to a crisp fixed size.
    const c = canvasRef.current;
    if (c) {
      c.width = DISPLAY_W;
      c.height = Math.round((DISPLAY_W * core.height) / core.width);
    }
  }, [ready, width, height, flipV, flipH, alignment, playhead]);

  // --- Color format (validated separately so bad input doesn't apply). ---
  useEffect(() => {
    const core = coreRef.current;
    if (!core || !ready) return;
    const rc = core.setColorFormat(colorFormat);
    setColorError(rc === 0 ? null : COLOR_FORMAT_ERRORS[rc] ?? "Invalid color format.");
  }, [ready, colorFormat]);

  useEffect(() => {
    playerRef.current?.setVolume(volume);
  }, [volume]);

  // --- Render loop. ---
  const drawFrame = useCallback(
    (ms: number) => {
      const core = coreRef.current;
      const canvas = canvasRef.current;
      const off = offscreenRef.current;
      const img = imageDataRef.current;
      if (!core || !canvas || !off || !img || !fileBytes) return;

      // 1. Raw waterfall pixels into the native-resolution offscreen buffer.
      const rgb = core.renderFrame(ms);
      const data = img.data;
      const px = core.width * core.height;
      for (let i = 0; i < px; i++) {
        data[i * 4 + 0] = rgb[i * 3 + 0];
        data[i * 4 + 1] = rgb[i * 3 + 1];
        data[i * 4 + 2] = rgb[i * 3 + 2];
        data[i * 4 + 3] = 255;
      }
      off.getContext("2d")!.putImageData(img, 0, 0);

      // 2. Upscale crisply to the visible canvas.
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

      // 3. Stable playhead overlay (content-independent, so no flicker).
      if (playhead) {
        const vRow = playheadVisualRow(alignment, core.height, flipV);
        const y = (vRow + 0.5) * (canvas.height / core.height);
        ctx.save();
        ctx.strokeStyle = "rgba(74, 222, 128, 0.35)";
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
        ctx.restore();
      }
    },
    [fileBytes, playhead, alignment, flipV]
  );

  useEffect(() => {
    const loop = () => {
      const player = playerRef.current;
      if (player) {
        const ms = player.currentMs();
        drawFrame(ms);
        setPosMs(ms);
        if (player.playing !== playing) setPlaying(player.playing);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [drawFrame, playing]);

  // --- File loading. ---
  const onFile = useCallback(
    async (file: File) => {
      const core = coreRef.current;
      const player = playerRef.current;
      if (!core || !player) return;
      player.pause();
      setPlaying(false);
      const bytes = new Uint8Array(await file.arrayBuffer());
      core.loadFile(bytes);
      core.setDims(width, height);
      core.setColorFormat(colorFormat);
      core.setFlip(flipV, flipH);
      core.setAlignment(alignment);
      core.setPlayhead(false);
      setFileName(file.name);
      setFileBytes(bytes); // triggers rebuildAudio
    },
    [width, height, colorFormat, flipV, flipH, alignment]
  );

  const downloadBlob = useCallback(
    (blob: Blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (fileName ? fileName.replace(/\.[^.]+$/, "") : "waterfall") + ".webm";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
    [fileName]
  );

  const exportVideo = useCallback(async () => {
    const player = playerRef.current;
    const core = coreRef.current;
    const canvas = canvasRef.current;
    if (!player || !core || !canvas || !fileBytes || recording || !exportSupported) return;

    setRecording(true);
    setExportPct(0);
    player.pause();
    setPlaying(false);

    try {
      let blob: Blob;
      if (webCodecsSupported()) {
        // Fast, offline path: encode every frame as fast as the CPU allows.
        const chans: Float32Array[] = [];
        for (let c = 0; c < channels; c++) chans.push(core.renderAudioChannel(c));
        blob = await exportWebCodecs({
          canvas,
          drawFrame,
          audioChannels: chans,
          sampleRate,
          lengthMs: player.lengthMs,
          fps: EXPORT_FPS,
          onProgress: setExportPct,
        });
        drawFrame(player.currentMs()); // restore the live view
      } else {
        // Real-time fallback via MediaRecorder.
        player.seekMs(0);
        setPosMs(0);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const prevOnEnded = player.onEnded;
        blob = await exportRealtime({
          canvas,
          audioTrack: player.getAudioStreamTrack(),
          start: () => {
            player.play();
            setPlaying(true);
          },
          onEnded: (cb) => {
            player.onEnded = () => {
              setPlaying(false);
              cb();
            };
          },
        });
        player.onEnded = prevOnEnded;
      }
      downloadBlob(blob);
    } catch (err) {
      console.error("Export failed", err);
    } finally {
      setRecording(false);
    }
  }, [fileBytes, recording, exportSupported, channels, sampleRate, drawFrame, downloadBlob]);

  const togglePlay = useCallback(() => {
    const player = playerRef.current;
    if (!player || !fileBytes) return;
    if (player.playing) player.pause();
    else player.play();
    setPlaying(player.playing);
  }, [fileBytes]);

  // --- Keyboard shortcuts. ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT")) return;
      const player = playerRef.current;
      if (!player) return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "ArrowRight") {
        player.seekMs(player.currentMs() + 2000);
      } else if (e.code === "ArrowLeft") {
        player.seekMs(player.currentMs() - 2000);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay]);

  const displaySize = 512;
  const aspect = height / width;

  return (
    <div className="app">
      <header>
        <h1>Binary Waterfall</h1>
        <p className="sub">A raw-data media player — hear and see any file. Zig + WebAssembly.</p>
      </header>

      <div className="stage">
        <div
          className="viewer"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) onFile(f);
          }}
        >
          <canvas
            ref={canvasRef}
            className="screen"
            style={{ width: displaySize, height: displaySize * aspect }}
          />
          {!fileBytes && (
            <label className="dropzone">
              <input
                type="file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onFile(f);
                }}
              />
              <span>{ready ? "Drop a file here or click to browse" : "Loading core…"}</span>
            </label>
          )}
        </div>

        <div className="panel">
          <SettingsGroup title="File">
            <label className="file-btn">
              <input
                type="file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onFile(f);
                }}
              />
              {fileName ?? "Choose file…"}
            </label>
          </SettingsGroup>

          <SettingsGroup title="Video">
            <NumField label="Width" value={width} min={4} max={512} onChange={setWidth} />
            <NumField label="Height" value={height} min={4} max={512} onChange={setHeight} />
            <div className="field">
              <span>Color format</span>
              <input
                type="text"
                value={colorFormat}
                spellCheck={false}
                onChange={(e) => setColorFormat(e.target.value)}
              />
            </div>
            {colorError && <div className="err">{colorError}</div>}
            <div className="field">
              <span>Alignment</span>
              <select value={alignment} onChange={(e) => setAlignment(Number(e.target.value))}>
                {ALIGNMENTS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
            <Check label="Flip vertical" checked={flipV} onChange={setFlipV} />
            <Check label="Flip horizontal" checked={flipH} onChange={setFlipH} />
            <Check label="Show playhead" checked={playhead} onChange={setPlayhead} />
          </SettingsGroup>

          <SettingsGroup title="Audio">
            <div className="field">
              <span>Channels</span>
              <select value={channels} onChange={(e) => setChannels(Number(e.target.value))}>
                <option value={1}>Mono</option>
                <option value={2}>Stereo</option>
              </select>
            </div>
            <div className="field">
              <span>Sample bytes</span>
              <select value={sampleBytes} onChange={(e) => setSampleBytes(Number(e.target.value))}>
                {[1, 2, 3, 4].map((b) => (
                  <option key={b} value={b}>
                    {b} ({b * 8}-bit)
                  </option>
                ))}
              </select>
            </div>
            <NumField
              label="Sample rate"
              value={sampleRate}
              min={1000}
              max={192000}
              step={1000}
              onChange={setSampleRate}
            />
          </SettingsGroup>
        </div>
      </div>

      <div className="transport">
        <button className="play" onClick={togglePlay} disabled={!fileBytes || recording}>
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="time">{fmtTime(posMs)}</span>
        <input
          className="seek"
          type="range"
          min={0}
          max={Math.max(1, lengthMs)}
          value={posMs}
          onChange={(e) => {
            const ms = Number(e.target.value);
            playerRef.current?.seekMs(ms);
            setPosMs(ms);
          }}
          disabled={!fileBytes || recording}
        />
        <span className="time">{fmtTime(lengthMs)}</span>
        <span className="vol-icon">🔊</span>
        <input
          className="vol"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
        />
      </div>

      <div className="export">
        <button
          className="export-btn"
          onClick={exportVideo}
          disabled={!fileBytes || recording || !exportSupported}
          title={exportSupported ? "Encode the visualization + audio to a .webm file" : "Not supported in this browser"}
        >
          {recording ? "● Encoding…" : "⬇ Export video (.webm)"}
        </button>
        {recording && (
          <div className="export-bar">
            <div className="export-fill" style={{ width: `${Math.round(exportPct * 100)}%` }} />
          </div>
        )}
        <span className="export-note">
          {recording
            ? exportFast
              ? `Encoding offline… ${Math.round(exportPct * 100)}%`
              : "Recording in real time — plays through once, then downloads."
            : exportFast
              ? "Fast offline encode (WebCodecs)."
              : "Real-time capture (one full playthrough)."}
        </span>
      </div>
    </div>
  );
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="group">
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}

function NumField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
      />
    </label>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
