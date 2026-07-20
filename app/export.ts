// Video export.
//
// Preferred path: WebCodecs — render every frame as fast as the CPU allows and
// encode offline, so a clip exports much faster than real time. Falls back to a
// real-time MediaRecorder capture when WebCodecs isn't available.
//
// Note: raw-byte audio is long — the clip duration scales with the file size —
// so exports of large files legitimately take a while. Progress reflects frames
// actually *encoded* (not just submitted), and the whole thing is cancellable.

import { Muxer, ArrayBufferTarget } from "webm-muxer";

export type ExportPhase = "audio" | "encoding" | "finalizing";

export interface ExportOptions {
  canvas: HTMLCanvasElement; // the visible, already-upscaled canvas
  drawFrame: (ms: number) => void; // renders one frame to `canvas`
  audioChannels: Float32Array[]; // decoded planar audio
  sampleRate: number;
  lengthMs: number;
  fps: number;
  bitrate?: number;
  onProgress?: (fraction: number, phase: ExportPhase) => void;
  shouldCancel?: () => boolean;
}

export class ExportCancelled extends Error {
  constructor() {
    super("Export cancelled");
    this.name = "ExportCancelled";
  }
}

export function webCodecsSupported(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof AudioEncoder !== "undefined";
}

const yieldToLoop = () => new Promise((r) => setTimeout(r, 0));

export async function exportWebCodecs(opts: ExportOptions): Promise<Blob> {
  const { canvas, drawFrame, audioChannels, sampleRate, lengthMs, fps, onProgress, shouldCancel } =
    opts;
  const channels = audioChannels.length;
  const width = canvas.width;
  const height = canvas.height;
  const bail = () => {
    if (shouldCancel?.()) throw new ExportCancelled();
  };

  const hasAudio = channels > 0 && audioChannels[0].length > 0;

  // VP8 encodes far faster than VP9 in software (no HW VP9 encoder on macOS).
  const vp9 = !(await codecOk("vp8", width, height, fps)) && (await codecOk("vp09.00.10.08", width, height, fps));
  const videoCodecString = vp9 ? "vp09.00.10.08" : "vp8";

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: vp9 ? "V_VP9" : "V_VP8", width, height, frameRate: fps },
    audio: hasAudio ? { codec: "A_OPUS", sampleRate, numberOfChannels: channels } : undefined,
    firstTimestampBehavior: "offset",
  });

  let encodeError: unknown = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
      encodedFrames++;
    },
    error: (e) => (encodeError = e),
  });
  videoEncoder.configure({
    codec: videoCodecString,
    width,
    height,
    bitrate: opts.bitrate ?? 4_000_000,
    framerate: fps,
  });
  let encodedFrames = 0;

  const frameCount = Math.max(1, Math.round((lengthMs / 1000) * fps));

  // --- Encode audio first (with periodic yields so the UI stays responsive). ---
  if (hasAudio) {
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => (encodeError = e),
    });
    audioEncoder.configure({
      codec: "opus",
      sampleRate,
      numberOfChannels: channels,
      bitrate: 128_000,
    });

    const total = audioChannels[0].length;
    const chunk = 4096;
    let n = 0;
    for (let start = 0; start < total; start += chunk, n++) {
      bail();
      const len = Math.min(chunk, total - start);
      const planar = new Float32Array(len * channels);
      for (let c = 0; c < channels; c++) {
        planar.set(audioChannels[c].subarray(start, start + len), c * len);
      }
      const data = new AudioData({
        format: "f32-planar",
        sampleRate,
        numberOfFrames: len,
        numberOfChannels: channels,
        timestamp: Math.round((start / sampleRate) * 1e6),
        data: planar,
      });
      audioEncoder.encode(data);
      data.close();
      if (n % 32 === 0) {
        onProgress?.(start / total, "audio");
        await yieldToLoop();
        if (encodeError) throw encodeError;
      }
    }
    await audioEncoder.flush();
    audioEncoder.close();
  }

  // --- Encode video. Keep the encoder fed but bounded so `encodedFrames`
  //     tracks reality and the final flush has little backlog to drain. ---
  const frameDur = Math.round(1e6 / fps);
  for (let i = 0; i < frameCount; i++) {
    bail();
    if (encodeError) throw encodeError;
    const ms = Math.min(lengthMs, (i / fps) * 1000);
    drawFrame(ms);
    const frame = new VideoFrame(canvas, { timestamp: i * frameDur, duration: frameDur });
    videoEncoder.encode(frame, { keyFrame: i % (fps * 4) === 0 });
    frame.close();

    // Don't race too far ahead of the encoder.
    while (videoEncoder.encodeQueueSize > 4) {
      await yieldToLoop();
      if (encodeError) throw encodeError;
    }
    if (i % 4 === 0) onProgress?.(encodedFrames / frameCount, "encoding");
  }

  // --- Finalize: keep reporting real progress while the encoder drains. ---
  const flushing = videoEncoder.flush();
  const poll = setInterval(() => onProgress?.(encodedFrames / frameCount, "finalizing"), 150);
  try {
    await flushing;
  } finally {
    clearInterval(poll);
  }
  videoEncoder.close();
  if (encodeError) throw encodeError;

  muxer.finalize();
  onProgress?.(1, "finalizing");
  return new Blob([muxer.target.buffer], { type: "video/webm" });
}

async function codecOk(codec: string, width: number, height: number, fps: number): Promise<boolean> {
  try {
    const res = await VideoEncoder.isConfigSupported({ codec, width, height, framerate: fps });
    return !!res.supported;
  } catch {
    return false;
  }
}

// Real-time fallback: capture the canvas + a live audio track via MediaRecorder.
export interface RealtimeOptions {
  canvas: HTMLCanvasElement;
  audioTrack: MediaStreamTrack;
  start: () => void; // begin playback
  onEnded: (cb: () => void) => void; // register end-of-playback callback
}

export async function exportRealtime(opts: RealtimeOptions): Promise<Blob> {
  const vStream = opts.canvas.captureStream(60);
  const stream = new MediaStream([...vStream.getVideoTracks(), opts.audioTrack]);
  const mime =
    ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) =>
      MediaRecorder.isTypeSupported(m)
    ) ?? "video/webm";
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((res) => (rec.onstop = () => res()));
  opts.onEnded(() => rec.state !== "inactive" && rec.stop());
  rec.start();
  opts.start();
  await done;
  vStream.getTracks().forEach((t) => t.stop());
  return new Blob(chunks, { type: mime });
}
