// Binary Waterfall core, compiled to WebAssembly.
//
// Ports the conversion logic from nimaid/binary-waterfall:
//   - The raw file bytes ARE the PCM audio (reinterpreted as samples).
//   - A width*height window of pixels scrolls through the file, its position
//     synced to the audio playback time. Each pixel consumes `color_bytes`
//     bytes according to a color-format string like "bgrx".

const std = @import("std");

const Alignment = enum(u8) { start = 0, end = 1, middle = 2 };

// Color format codes, matching the upstream single-char codes.
const Code = enum(u8) {
    red = 'r',
    red_inv = 'R',
    green = 'g',
    green_inv = 'G',
    blue = 'b',
    blue_inv = 'B',
    white = 'w',
    white_inv = 'W',
    unused = 'x',
};

const Context = struct {
    // File data
    file: [*]const u8 = undefined,
    total_bytes: usize = 0,

    // Video
    width: u32 = 48,
    height: u32 = 48,
    format: [32]Code = undefined,
    format_len: u32 = 0,
    color_bytes: u32 = 0, // total bytes per pixel (used + unused)
    flip_v: bool = true,
    flip_h: bool = false,
    alignment: Alignment = .middle,
    playhead_visible: bool = true,

    // Audio
    num_channels: u32 = 1,
    sample_bytes: u32 = 1,
    sample_rate: u32 = 32000,
    audio_length_ms: u32 = 0,

    // Scratch buffer for one canonical (pre-flip) RGB frame.
    scratch: []u8 = &.{},
};

// ---------------------------------------------------------------------------
// Allocator: a simple growing bump allocator over wasm linear memory.
// JS allocates a handful of long-lived buffers (file, frame out, audio out),
// so we don't bother with real freeing; `reset` rewinds everything.
// ---------------------------------------------------------------------------

var heap_top: usize = 0;

fn heapInit() void {
    if (heap_top == 0) {
        // Start the heap just past whatever the linker placed statically.
        heap_top = @intFromPtr(&__heap_base);
    }
}

extern var __heap_base: u8;

fn bumpAlloc(n: usize) usize {
    heapInit();
    const aligned = std.mem.alignForward(usize, heap_top, 16);
    const end = aligned + n;
    const cur_pages = @wasmMemorySize(0);
    const cur_bytes = cur_pages * std.wasm.page_size;
    if (end > cur_bytes) {
        const need_bytes = end - cur_bytes;
        const need_pages = (need_bytes + std.wasm.page_size - 1) / std.wasm.page_size;
        if (@wasmMemoryGrow(0, need_pages) == -1) return 0;
    }
    heap_top = end;
    return aligned;
}

export fn alloc(n: usize) usize {
    return bumpAlloc(n);
}

// Rewind the heap. Everything allocated after `keep` becomes free.
export fn reset(keep: usize) void {
    heapInit();
    if (keep != 0) heap_top = keep;
}

export fn heapMark() usize {
    heapInit();
    return heap_top;
}

// ---------------------------------------------------------------------------
// Context lifecycle
// ---------------------------------------------------------------------------

export fn createContext() usize {
    const p = bumpAlloc(@sizeOf(Context));
    const ctx: *Context = @ptrFromInt(p);
    ctx.* = Context{};
    return p;
}

fn asCtx(handle: usize) *Context {
    return @ptrFromInt(handle);
}

// Drop the scratch buffer so it is re-allocated fresh after a heap reset.
export fn clearScratch(handle: usize) void {
    asCtx(handle).scratch = &.{};
}

export fn setFile(handle: usize, ptr: usize, len: usize) void {
    const ctx = asCtx(handle);
    ctx.file = @ptrFromInt(ptr);
    ctx.total_bytes = len;
    recomputeAudioLength(ctx);
}

export fn setDims(handle: usize, w: u32, h: u32) void {
    const ctx = asCtx(handle);
    ctx.width = if (w < 4) 4 else w;
    ctx.height = if (h < 4) 4 else h;
    ensureScratch(ctx);
}

fn ensureScratch(ctx: *Context) void {
    const need = ctx.width * ctx.height * 3;
    if (ctx.scratch.len < need) {
        const p = bumpAlloc(need);
        ctx.scratch = @as([*]u8, @ptrFromInt(p))[0..need];
    }
}

// Set the color format from a raw string (ptr/len into wasm memory).
// Returns 0 on success, non-zero error code on invalid format.
export fn setColorFormat(handle: usize, ptr: usize, len: usize) i32 {
    const ctx = asCtx(handle);
    const str = @as([*]const u8, @ptrFromInt(ptr))[0..len];

    if (len == 0 or len > 32) return 1;

    var used: u32 = 0;
    var white: u32 = 0;
    var rgb: u32 = 0;

    var i: usize = 0;
    while (i < len) : (i += 1) {
        const c = str[i];
        const code: Code = switch (c) {
            'r' => .red,
            'R' => .red_inv,
            'g' => .green,
            'G' => .green_inv,
            'b' => .blue,
            'B' => .blue_inv,
            'w' => .white,
            'W' => .white_inv,
            'x' => .unused,
            else => return 2, // bad char
        };
        ctx.format[i] = code;
        switch (code) {
            .unused => {},
            .white, .white_inv => {
                white += 1;
                used += 1;
            },
            else => {
                rgb += 1;
                used += 1;
            },
        }
    }

    // Grayscale (white) and RGB modes are mutually exclusive.
    if (white > 0 and rgb > 0) return 3;
    if (white > 1) return 4;
    if (white == 0 and rgb == 0) return 5;

    ctx.format_len = @intCast(len);
    ctx.color_bytes = @intCast(len);
    return 0;
}

export fn setAudio(handle: usize, channels: u32, sample_bytes: u32, sample_rate: u32) void {
    const ctx = asCtx(handle);
    ctx.num_channels = if (channels == 2) 2 else 1;
    ctx.sample_bytes = std.math.clamp(sample_bytes, 1, 4);
    ctx.sample_rate = if (sample_rate < 1) 1 else sample_rate;
    recomputeAudioLength(ctx);
}

export fn setFlip(handle: usize, v: bool, h: bool) void {
    const ctx = asCtx(handle);
    ctx.flip_v = v;
    ctx.flip_h = h;
}

export fn setAlignment(handle: usize, a: u32) void {
    asCtx(handle).alignment = @enumFromInt(@as(u8, @intCast(a & 3)));
}

export fn setPlayhead(handle: usize, visible: bool) void {
    asCtx(handle).playhead_visible = visible;
}

fn recomputeAudioLength(ctx: *Context) void {
    if (ctx.total_bytes == 0) {
        ctx.audio_length_ms = 0;
        return;
    }
    const frame_bytes = ctx.num_channels * ctx.sample_bytes;
    const frames = ctx.total_bytes / frame_bytes; // whole PCM frames only
    // ceil(frames / rate * 1000)
    const num = frames * 1000;
    ctx.audio_length_ms = @intCast((num + ctx.sample_rate - 1) / ctx.sample_rate);
}

export fn audioLengthMs(handle: usize) u32 {
    return asCtx(handle).audio_length_ms;
}

export fn audioFrameCount(handle: usize) u32 {
    const ctx = asCtx(handle);
    if (ctx.total_bytes == 0) return 0;
    const frame_bytes = ctx.num_channels * ctx.sample_bytes;
    return @intCast(ctx.total_bytes / frame_bytes);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Python's round(): round half to even. All inputs here are non-negative.
fn pyRound(x: f64) f64 {
    const fl = @floor(x);
    const diff = x - fl;
    if (diff < 0.5) return fl;
    if (diff > 0.5) return fl + 1;
    const fli: i64 = @intFromFloat(fl);
    return if (@mod(fli, 2) == 0) fl else fl + 1;
}

fn fileByte(ctx: *Context, index: i64) u8 {
    if (index < 0) return 0;
    const u: usize = @intCast(index);
    if (u >= ctx.total_bytes) return 0;
    return ctx.file[u];
}

// ---------------------------------------------------------------------------
// Frame generation
// ---------------------------------------------------------------------------

// Writes width*height*3 RGB bytes (flip-applied) to `out_ptr`.
export fn renderFrame(handle: usize, ms: u32, out_ptr: usize) void {
    const ctx = asCtx(handle);
    ensureScratch(ctx);
    const w = ctx.width;
    const h = ctx.height;
    const total_pixels = w * h;
    const pic = ctx.scratch;

    // --- Compute the starting byte address for this frame (see upstream). ---
    const color_bytes: i64 = @intCast(ctx.color_bytes);
    const block: i64 = @as(i64, @intCast(w)) * color_bytes; // one row of bytes
    const total_blocks: i64 = @intCast((ctx.total_bytes + @as(usize, @intCast(block)) - 1) / @as(usize, @intCast(block)));

    var index_f: f64 = 0;
    if (ctx.audio_length_ms > 0) {
        index_f = pyRound(@as(f64, @floatFromInt(total_blocks)) *
            (@as(f64, @floatFromInt(ms)) / @as(f64, @floatFromInt(ctx.audio_length_ms))));
    }
    var index: i64 = @intFromFloat(index_f);

    switch (ctx.alignment) {
        .start => index -= @intCast(h),
        .middle => index -= @intFromFloat(pyRound(@as(f64, @floatFromInt(h)) / 2.0)),
        .end => {},
    }

    var address: i64 = index * block;

    // --- Fill the canonical (pre-flip) RGB buffer. ---
    var pos: u32 = 0; // pixel index written so far
    var idx: i64 = 0; // byte offset into the file window

    // Negative address => prepend rows of black pixels, then read from 0.
    if (address < 0) {
        var prepend: u32 = @intFromFloat(pyRound(@as(f64, @floatFromInt(-address)) / @as(f64, @floatFromInt(color_bytes))));
        if (prepend > total_pixels) prepend = total_pixels;
        while (pos < prepend) : (pos += 1) {
            pic[pos * 3 + 0] = 0;
            pic[pos * 3 + 1] = 0;
            pic[pos * 3 + 2] = 0;
        }
        address = 0;
    }

    while (pos < total_pixels) : (pos += 1) {
        var r: u8 = 0;
        var g: u8 = 0;
        var b: u8 = 0;
        var f: u32 = 0;
        while (f < ctx.format_len) : (f += 1) {
            const v = fileByte(ctx, address + idx);
            idx += 1;
            switch (ctx.format[f]) {
                .red => r = v,
                .red_inv => r = 255 - v,
                .green => g = v,
                .green_inv => g = 255 - v,
                .blue => b = v,
                .blue_inv => b = 255 - v,
                .white => {
                    r = v;
                    g = v;
                    b = v;
                },
                .white_inv => {
                    r = 255 - v;
                    g = 255 - v;
                    b = 255 - v;
                },
                .unused => {},
            }
        }
        pic[pos * 3 + 0] = r;
        pic[pos * 3 + 1] = g;
        pic[pos * 3 + 2] = b;
    }

    // --- Playhead row: turn it into a contrasting grayscale bar. ---
    if (ctx.playhead_visible) {
        const row: u32 = switch (ctx.alignment) {
            .end => 0,
            .start => h - 1,
            .middle => @intFromFloat(pyRound(@as(f64, @floatFromInt(h - 1)) / 2.0)),
        };
        var col: u32 = 0;
        while (col < w) : (col += 1) {
            const o = (row * w + col) * 3;
            const pr = pic[o + 0];
            const pg = pic[o + 1];
            const pb = pic[o + 2];
            const lum = (0.299 * @as(f64, @floatFromInt(pr)) +
                0.587 * @as(f64, @floatFromInt(pg)) +
                0.114 * @as(f64, @floatFromInt(pb))) / 255.0;
            const contrast: f64 = if (lum < 0.5) 255.0 else 0.0;
            // invert, then desaturate (gray = round((min+max)/2)), then average with contrast
            const ir: u8 = 255 - pr;
            const ig: u8 = 255 - pg;
            const ib: u8 = 255 - pb;
            const mn: u8 = @min(ir, @min(ig, ib));
            const mx: u8 = @max(ir, @max(ig, ib));
            const gray = pyRound((@as(f64, @floatFromInt(mn)) + @as(f64, @floatFromInt(mx))) / 2.0);
            const final: u8 = @intFromFloat(pyRound((gray + contrast) / 2.0));
            pic[o + 0] = final;
            pic[o + 1] = final;
            pic[o + 2] = final;
        }
    }

    // --- Copy to output applying flips. ---
    const out = @as([*]u8, @ptrFromInt(out_ptr));
    var y: u32 = 0;
    while (y < h) : (y += 1) {
        const sy = if (ctx.flip_v) h - 1 - y else y;
        var x: u32 = 0;
        while (x < w) : (x += 1) {
            const sx = if (ctx.flip_h) w - 1 - x else x;
            const src = (sy * w + sx) * 3;
            const dst = (y * w + x) * 3;
            out[dst + 0] = pic[src + 0];
            out[dst + 1] = pic[src + 1];
            out[dst + 2] = pic[src + 2];
        }
    }
}

// ---------------------------------------------------------------------------
// Audio: decode raw PCM bytes to planar Float32 [-1, 1], one channel at a time.
// out_ptr must hold audioFrameCount() f32 values.
// ---------------------------------------------------------------------------

export fn renderAudioChannel(handle: usize, channel: u32, out_ptr: usize) void {
    const ctx = asCtx(handle);
    const out = @as([*]f32, @ptrFromInt(out_ptr));
    const frames = audioFrameCount(handle);
    const sb = ctx.sample_bytes;
    const frame_bytes = ctx.num_channels * sb;

    var i: u32 = 0;
    while (i < frames) : (i += 1) {
        const base = @as(usize, i) * frame_bytes + @as(usize, channel) * sb;
        out[i] = decodeSample(ctx, base);
    }
}

fn decodeSample(ctx: *Context, base: usize) f32 {
    const sb = ctx.sample_bytes;
    switch (sb) {
        1 => {
            // 8-bit WAV is unsigned, centered at 128.
            const v = ctx.file[base];
            return (@as(f32, @floatFromInt(@as(i16, v) - 128)) / 128.0);
        },
        2 => {
            const v: i16 = @bitCast(@as(u16, ctx.file[base]) | (@as(u16, ctx.file[base + 1]) << 8));
            return @as(f32, @floatFromInt(v)) / 32768.0;
        },
        3 => {
            var u: u32 = @as(u32, ctx.file[base]) |
                (@as(u32, ctx.file[base + 1]) << 8) |
                (@as(u32, ctx.file[base + 2]) << 16);
            if (u & 0x800000 != 0) u |= 0xFF000000; // sign-extend
            const v: i32 = @bitCast(u);
            return @as(f32, @floatFromInt(v)) / 8388608.0;
        },
        4 => {
            const v: i32 = @bitCast(@as(u32, ctx.file[base]) |
                (@as(u32, ctx.file[base + 1]) << 8) |
                (@as(u32, ctx.file[base + 2]) << 16) |
                (@as(u32, ctx.file[base + 3]) << 24));
            return @as(f32, @floatFromInt(v)) / 2147483648.0;
        },
        else => return 0,
    }
}
