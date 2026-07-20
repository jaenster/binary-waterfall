// Web Audio playback with a queryable millisecond clock.
//
// AudioBufferSourceNode can't pause/resume, so we track an offset and rebuild
// the source node on every play/seek.

export class Player {
  private actx: AudioContext;
  private gain: GainNode;
  private limiter: DynamicsCompressorNode;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;

  playing = false;
  lengthMs = 0;

  private offsetMs = 0; // position captured at the last play()
  private startedAt = 0; // actx.currentTime at the last play()
  private stopping = false; // true while we tear down a source ourselves
  private streamDest: MediaStreamAudioDestinationNode | null = null;

  onEnded?: () => void;

  constructor() {
    this.actx = new AudioContext();
    this.gain = this.actx.createGain();
    // A compressor/limiter tames the harsh peaks of raw-byte audio so no file
    // can be painfully loud regardless of the volume setting.
    this.limiter = this.actx.createDynamicsCompressor();
    this.limiter.threshold.value = -18;
    this.limiter.knee.value = 12;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.gain.connect(this.limiter);
    this.limiter.connect(this.actx.destination);
  }

  // Audio track that mirrors playback, for feeding into a MediaRecorder.
  getAudioStreamTrack(): MediaStreamTrack {
    if (!this.streamDest) {
      this.streamDest = this.actx.createMediaStreamDestination();
      this.limiter.connect(this.streamDest);
    }
    return this.streamDest.stream.getAudioTracks()[0];
  }

  setBuffer(channels: Float32Array[], sampleRate: number, lengthMs: number) {
    this.stop();
    this.offsetMs = 0;
    this.playing = false;
    this.lengthMs = lengthMs;

    const frames = channels[0]?.length ?? 0;
    if (frames === 0) {
      this.buffer = null;
      return;
    }
    const buf = this.actx.createBuffer(channels.length, frames, sampleRate);
    for (let c = 0; c < channels.length; c++) buf.getChannelData(c).set(channels[c]);
    this.buffer = buf;
  }

  setVolume(v: number) {
    this.gain.gain.value = v;
  }

  private stop() {
    if (this.source) {
      this.stopping = true;
      try {
        this.source.stop();
      } catch {
        /* already stopped */
      }
      this.source.disconnect();
      this.source = null;
      this.stopping = false;
    }
  }

  play() {
    if (!this.buffer || this.playing) return;
    if (this.actx.state === "suspended") void this.actx.resume();
    if (this.offsetMs >= this.lengthMs) this.offsetMs = 0;

    const src = this.actx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    src.onended = () => {
      if (this.stopping) return; // we stopped it on purpose
      this.playing = false;
      this.offsetMs = this.lengthMs;
      this.onEnded?.();
    };
    src.start(0, this.offsetMs / 1000);
    this.source = src;
    this.startedAt = this.actx.currentTime;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.offsetMs = this.currentMs();
    this.stop();
    this.playing = false;
  }

  seekMs(ms: number) {
    const clamped = Math.max(0, Math.min(this.lengthMs, ms));
    const wasPlaying = this.playing;
    this.stop();
    this.playing = false;
    this.offsetMs = clamped;
    if (wasPlaying) this.play();
  }

  currentMs(): number {
    if (!this.playing) return this.offsetMs;
    const ms = this.offsetMs + (this.actx.currentTime - this.startedAt) * 1000;
    return Math.max(0, Math.min(this.lengthMs, ms));
  }
}
