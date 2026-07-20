// Video export.
//
// Preferred path: WebCodecs — render every frame as fast as the CPU allows and
// encode offline, so a clip exports much faster than real time. Falls back to a
// real-time MediaRecorder capture when WebCodecs isn't available.

import { Muxer, ArrayBufferTarget } from "webm-muxer";

export interface ExportOptions {
  canvas: HTMLCanvasElement; // the visible, already-upscaled canvas
  drawFrame: (ms: number) => void; // renders one frame to `canvas`
  audioChannels: Float32Array[]; // decoded planar audio
  sampleRate: number;
  lengthMs: number;
  fps: number;
  onProgress?: (fraction: number) => void;
}

export function webCodecsSupported(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof AudioEncoder !== "undefined";
}

export async function exportWebCodecs(opts: ExportOptions): Promise<Blob> {
  const { canvas, drawFrame, audioChannels, sampleRate, lengthMs, fps, onProgress } = opts;
  const channels = audioChannels.length;
  const width = canvas.width;
  const height = canvas.height;

  const hasAudio = channels > 0 && audioChannels[0].length > 0;

  // VP8 encodes far faster than VP9 in software, which dominates when there's no
  // hardware VP9 encoder (e.g. macOS). Prefer it for speed.
  const vp9 = !(await codecOk("vp8", width, height, fps)) && (await codecOk("vp09.00.10.08", width, height, fps));
  const videoCodecString = vp9 ? "vp09.00.10.08" : "vp8";

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: vp9 ? "V_VP9" : "V_VP8", width, height, frameRate: fps },
    audio: hasAudio ? { codec: "A_OPUS", sampleRate, numberOfChannels: channels } : undefined,
    firstTimestampBehavior: "offset",
  });

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => console.error("VideoEncoder", e),
  });
  videoEncoder.configure({
    codec: videoCodecString,
    width,
    height,
    bitrate: 6_000_000,
    framerate: fps,
  });

  // --- Encode audio first (cheap, keeps the muxer's tracks interleaved). ---
  if (hasAudio) {
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => console.error("AudioEncoder", e),
    });
    audioEncoder.configure({
      codec: "opus",
      sampleRate,
      numberOfChannels: channels,
      bitrate: 128_000,
    });

    const total = audioChannels[0].length;
    const chunk = 4096;
    for (let start = 0; start < total; start += chunk) {
      const n = Math.min(chunk, total - start);
      // f32-planar wants all of channel 0, then all of channel 1, ...
      const planar = new Float32Array(n * channels);
      for (let c = 0; c < channels; c++) {
        planar.set(audioChannels[c].subarray(start, start + n), c * n);
      }
      const data = new AudioData({
        format: "f32-planar",
        sampleRate,
        numberOfFrames: n,
        numberOfChannels: channels,
        timestamp: Math.round((start / sampleRate) * 1e6),
        data: planar,
      });
      audioEncoder.encode(data);
      data.close();
    }
    await audioEncoder.flush();
    audioEncoder.close();
  }

  // --- Encode video frames. ---
  const frameCount = Math.max(1, Math.round((lengthMs / 1000) * fps));
  const frameDur = Math.round(1e6 / fps);
  for (let i = 0; i < frameCount; i++) {
    const ms = Math.min(lengthMs, (i / fps) * 1000);
    drawFrame(ms);
    const frame = new VideoFrame(canvas, {
      timestamp: i * frameDur,
      duration: frameDur,
    });
    videoEncoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();

    // Respect encoder backpressure and keep the UI responsive.
    if (videoEncoder.encodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 0));
    }
    if (i % 8 === 0) onProgress?.(i / frameCount);
  }

  await videoEncoder.flush();
  videoEncoder.close();
  muxer.finalize();
  onProgress?.(1);

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
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
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
