// Thin wrapper around the Zig-compiled WebAssembly core.
//
// The wasm side uses a bump allocator; because the file, frame buffer and
// audio buffer are all long-lived and re-created together, we rewind the heap
// to a fixed mark whenever a new file is loaded rather than freeing piecemeal.

export interface Exports {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  reset(keep: number): void;
  heapMark(): number;
  createContext(): number;
  clearScratch(ctx: number): void;
  setFile(ctx: number, ptr: number, len: number): void;
  setDims(ctx: number, w: number, h: number): void;
  setColorFormat(ctx: number, ptr: number, len: number): number;
  setAudio(ctx: number, channels: number, sampleBytes: number, sampleRate: number): void;
  setFlip(ctx: number, v: boolean, h: boolean): void;
  setAlignment(ctx: number, a: number): void;
  setPlayhead(ctx: number, visible: boolean): void;
  audioLengthMs(ctx: number): number;
  audioFrameCount(ctx: number): number;
  renderFrame(ctx: number, ms: number, out: number): void;
  renderAudioChannel(ctx: number, channel: number, out: number): void;
}

export const COLOR_FORMAT_ERRORS: Record<number, string> = {
  1: "Color format must be 1–32 characters.",
  2: 'Invalid character. Use r/g/b (color), w (white), x (unused); capitalize to invert.',
  3: "Grayscale (w) cannot be combined with r/g/b.",
  4: "Only one white (w) channel is allowed.",
  5: "At least one color channel (r/g/b/w) is required.",
};

const MAX_DIM = 512;

export class WaterfallCore {
  private ex: Exports;
  private ctx: number;
  private baseMark: number;

  // Live buffers (byte offsets into wasm memory).
  private filePtr = 0;
  private framePtr = 0;
  private audioPtr = 0;
  private audioCap = 0; // capacity in float samples

  width = 48;
  height = 48;

  private constructor(ex: Exports) {
    this.ex = ex;
    this.ctx = ex.createContext();
    this.baseMark = ex.heapMark();
    // Persistent frame output buffer, sized for the maximum resolution.
    this.framePtr = ex.alloc(MAX_DIM * MAX_DIM * 3);
    this.baseMark = ex.heapMark();
  }

  static async load(url: string): Promise<WaterfallCore> {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(buf, {});
    return new WaterfallCore(instance.exports as unknown as Exports);
  }

  private u8(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.ex.memory.buffer, ptr, len);
  }

  loadFile(bytes: Uint8Array) {
    // Rewind everything allocated after the persistent frame buffer.
    this.ex.reset(this.baseMark);
    this.ex.clearScratch(this.ctx);

    this.filePtr = this.ex.alloc(bytes.length);
    this.u8(this.filePtr, bytes.length).set(bytes);
    this.ex.setFile(this.ctx, this.filePtr, bytes.length);

    // Worst case: 1 channel * 1 byte/sample => one float sample per byte.
    this.audioCap = bytes.length;
    this.audioPtr = this.ex.alloc(this.audioCap * 4);
  }

  setDims(w: number, h: number) {
    this.width = Math.min(MAX_DIM, Math.max(4, w | 0));
    this.height = Math.min(MAX_DIM, Math.max(4, h | 0));
    this.ex.setDims(this.ctx, this.width, this.height);
  }

  setColorFormat(fmt: string): number {
    const enc = new TextEncoder().encode(fmt);
    const p = this.ex.alloc(enc.length);
    this.u8(p, enc.length).set(enc);
    const rc = this.ex.setColorFormat(this.ctx, p, enc.length);
    return rc;
  }

  setAudio(channels: number, sampleBytes: number, sampleRate: number) {
    this.ex.setAudio(this.ctx, channels, sampleBytes, sampleRate);
  }

  setFlip(v: boolean, h: boolean) {
    this.ex.setFlip(this.ctx, v, h);
  }

  setAlignment(a: number) {
    this.ex.setAlignment(this.ctx, a);
  }

  setPlayhead(visible: boolean) {
    this.ex.setPlayhead(this.ctx, visible);
  }

  audioLengthMs(): number {
    return this.ex.audioLengthMs(this.ctx);
  }

  audioFrameCount(): number {
    return this.ex.audioFrameCount(this.ctx);
  }

  // Renders one frame and returns a view of RGB bytes (w*h*3). The view is
  // only valid until the next wasm call that may grow memory.
  renderFrame(ms: number): Uint8Array {
    this.ex.renderFrame(this.ctx, ms, this.framePtr);
    return this.u8(this.framePtr, this.width * this.height * 3);
  }

  // Returns a fresh copy of one audio channel as Float32 in [-1, 1].
  renderAudioChannel(channel: number): Float32Array {
    const frames = this.audioFrameCount();
    this.ex.renderAudioChannel(this.ctx, channel, this.audioPtr);
    const view = new Float32Array(this.ex.memory.buffer, this.audioPtr, frames);
    // Copy out of wasm memory into a standalone, non-shared buffer.
    const out = new Float32Array(frames);
    out.set(view);
    return out;
  }
}
