#!/usr/bin/env node
// Generates the RosTalk event-sound bank (playtest-1, stage P10).
//
// The assets are synthesised offline by this script rather than taken from a
// sample library: the whole bank is a handful of soft, short cues, and a
// deterministic generator keeps them one family (same level, same attack,
// no harsh highs) and reviewable in git. The output is dedicated to the
// public domain (CC0-1.0); see
// client/src-tauri/crates/voice/assets/sounds/LICENSE.md.
//
// Usage: node tools/sounds/generate.mjs
//
// Format: RIFF/WAVE, 16-bit PCM, mono, 48 kHz — exactly what the client's WAV
// parser expects (`client/src-tauri/crates/voice/src/sounds/wav.rs`).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 48_000;
const MAX_MS = 400;
const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "client",
  "src-tauri",
  "crates",
  "voice",
  "assets",
  "sounds",
);

const TAU = Math.PI * 2;

/** Deterministic LCG so a rerun produces byte-identical files. */
function noiseSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000 * 2 - 1;
  };
}

/** One-pole low-pass; used to keep the cues free of harsh upper harmonics. */
function lowPass(samples, cutoff) {
  const alpha = 1 - Math.exp((-TAU * cutoff) / RATE);
  let value = 0;
  for (let index = 0; index < samples.length; index += 1) {
    value += alpha * (samples[index] - value);
    samples[index] = value;
  }
}

function envelope(length, attackMs, decayMs) {
  const attack = Math.max(1, Math.round((attackMs * RATE) / 1000));
  const decay = Math.max(1, Math.round((decayMs * RATE) / 1000));
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const rise = index < attack ? index / attack : 1;
    // Exponential tail with a short cosine smoothing at the very end.
    const tail = Math.exp(-(index - attack) / decay);
    const fadeOut = Math.min(1, (length - index) / (0.006 * RATE));
    out[index] = Math.max(0, rise * tail * Math.min(1, fadeOut));
  }
  return out;
}

/**
 * A soft struck tone: fundamental plus two quiet partials. `bright` shifts the
 * timbre up and adds a little third harmonic; `soft` stays rounder.
 */
function tone(frequency, durationMs, { bright = false, level = 1 } = {}) {
  const length = Math.round((durationMs * RATE) / 1000);
  const samples = new Float32Array(length);
  const env = envelope(length, bright ? 4 : 7, durationMs * (bright ? 0.22 : 0.3));
  const partials = bright
    ? [
        [1, 1],
        [2.01, 0.28],
        [3.02, 0.12],
      ]
    : [
        [1, 1],
        [2, 0.22],
        [3.01, 0.05],
      ];
  for (let index = 0; index < length; index += 1) {
    let value = 0;
    for (const [ratio, amount] of partials) {
      value += Math.sin(TAU * frequency * ratio * (index / RATE)) * amount;
    }
    samples[index] = value * env[index] * level;
  }
  lowPass(samples, bright ? 7_200 : 4_400);
  return samples;
}

/** A muted wooden knock: a short low sine with a noise transient. */
function knock(frequency, durationMs, { bright = false, level = 1 } = {}) {
  const length = Math.round((durationMs * RATE) / 1000);
  const samples = new Float32Array(length);
  const env = envelope(length, 3, durationMs * 0.25);
  const noise = noiseSource(Math.round(frequency) * 31 + length);
  for (let index = 0; index < length; index += 1) {
    const body = Math.sin(TAU * frequency * (index / RATE)) * env[index];
    const click = noise() * Math.max(0, 1 - index / (0.01 * RATE)) * env[index];
    samples[index] = (body + click * 0.35) * level;
  }
  lowPass(samples, bright ? 2_800 : 1_600);
  return samples;
}

/** A very short filtered tick for push-to-talk. */
function tick(frequency, durationMs, { bright = false, level = 1 } = {}) {
  const length = Math.round((durationMs * RATE) / 1000);
  const samples = new Float32Array(length);
  const env = envelope(length, 2, durationMs * 0.35);
  const noise = noiseSource(frequency * 7 + length);
  for (let index = 0; index < length; index += 1) {
    const body = Math.sin(TAU * frequency * (index / RATE)) * 0.6;
    samples[index] = (body + noise() * 0.4) * env[index] * level;
  }
  lowPass(samples, bright ? 2_200 : 1_200);
  return samples;
}

function place(target, source, offsetMs) {
  const offset = Math.round((offsetMs * RATE) / 1000);
  for (let index = 0; index < source.length; index += 1) {
    const at = offset + index;
    if (at >= target.length) {
      break;
    }
    target[at] += source[index];
  }
}

/** Builds one cue from layered notes; every cue is capped at 400 ms. */
function render(spec, bright) {
  const length = Math.min(
    Math.round((MAX_MS * RATE) / 1000),
    Math.round((spec.durationMs * RATE) / 1000),
  );
  const out = new Float32Array(length);
  for (const note of spec.notes) {
    const shifted = note.frequency * (bright ? 1.25 : 1);
    const generator =
      spec.voice === "tone" ? tone : spec.voice === "knock" ? knock : tick;
    const layer = generator(shifted, note.durationMs, {
      bright,
      level: note.level ?? 1,
    });
    place(out, layer, note.atMs ?? 0);
  }
  // Equalise the family: every cue peaks at the same level so the per-event
  // volume slider means the same thing across the whole bank. Short cues get a
  // slightly lower peak, which sounds as loud as a long decaying tail.
  let peak = 0;
  for (const sample of out) {
    peak = Math.max(peak, Math.abs(sample));
  }
  const target = spec.voice === "tick" ? 0.32 : 0.46;
  const gain = peak > 0 ? target / peak : 0;
  const pcm = Buffer.alloc(out.length * 2);
  for (let index = 0; index < out.length; index += 1) {
    const value = Math.max(-1, Math.min(1, out[index] * gain));
    pcm.writeInt16LE(Math.round(value * 32767), index * 2);
  }
  return { pcm, durationMs: (out.length / RATE) * 1000 };
}

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// The event names match `EventSound` in the voice crate and the file names in
// `sounds/bank.rs`. Frequencies are the "soft" set; the bright set is shifted
// by a fifth and gets a shorter, glassier timbre.
const CUES = {
  self_join: {
    voice: "tone",
    durationMs: 380,
    notes: [
      { frequency: 523.25, durationMs: 220, atMs: 0 },
      { frequency: 783.99, durationMs: 260, atMs: 110, level: 0.85 },
    ],
  },
  self_leave: {
    voice: "tone",
    durationMs: 380,
    notes: [
      { frequency: 783.99, durationMs: 220, atMs: 0 },
      { frequency: 523.25, durationMs: 260, atMs: 110, level: 0.85 },
    ],
  },
  user_join: {
    voice: "tone",
    durationMs: 220,
    notes: [
      { frequency: 659.25, durationMs: 140, atMs: 0 },
      { frequency: 987.77, durationMs: 110, atMs: 70, level: 0.55 },
    ],
  },
  user_leave: {
    voice: "tone",
    durationMs: 220,
    notes: [
      { frequency: 659.25, durationMs: 140, atMs: 0 },
      { frequency: 493.88, durationMs: 110, atMs: 70, level: 0.55 },
    ],
  },
  mic_off: {
    voice: "knock",
    durationMs: 200,
    notes: [
      { frequency: 392.0, durationMs: 110, atMs: 0 },
      { frequency: 293.66, durationMs: 130, atMs: 80, level: 0.8 },
    ],
  },
  mic_on: {
    voice: "knock",
    durationMs: 200,
    notes: [
      { frequency: 293.66, durationMs: 110, atMs: 0 },
      { frequency: 392.0, durationMs: 130, atMs: 80, level: 0.8 },
    ],
  },
  sound_off: {
    voice: "tone",
    durationMs: 260,
    notes: [
      { frequency: 880.0, durationMs: 140, atMs: 0 },
      { frequency: 587.33, durationMs: 160, atMs: 90, level: 0.75 },
    ],
  },
  sound_on: {
    voice: "tone",
    durationMs: 260,
    notes: [
      { frequency: 587.33, durationMs: 140, atMs: 0 },
      { frequency: 880.0, durationMs: 160, atMs: 90, level: 0.75 },
    ],
  },
  stream_started: {
    voice: "tone",
    durationMs: 340,
    notes: [
      { frequency: 523.25, durationMs: 160, atMs: 0, level: 0.7 },
      { frequency: 659.25, durationMs: 160, atMs: 70, level: 0.7 },
      { frequency: 783.99, durationMs: 180, atMs: 140, level: 0.7 },
    ],
  },
  self_stream_started: {
    voice: "tone",
    durationMs: 360,
    notes: [
      { frequency: 659.25, durationMs: 150, atMs: 0, level: 0.65 },
      { frequency: 987.77, durationMs: 150, atMs: 70, level: 0.65 },
      { frequency: 1318.51, durationMs: 170, atMs: 140, level: 0.55 },
    ],
  },
  self_stream_ended: {
    voice: "tone",
    durationMs: 360,
    notes: [
      { frequency: 1318.51, durationMs: 150, atMs: 0, level: 0.55 },
      { frequency: 987.77, durationMs: 150, atMs: 70, level: 0.65 },
      { frequency: 659.25, durationMs: 170, atMs: 140, level: 0.65 },
    ],
  },
  stream_viewer_joined: {
    voice: "tone",
    durationMs: 110,
    notes: [{ frequency: 1567.98, durationMs: 90, atMs: 0, level: 0.35 }],
  },
  direct_message: {
    voice: "tone",
    durationMs: 300,
    notes: [
      { frequency: 987.77, durationMs: 170, atMs: 0, level: 0.8 },
      { frequency: 783.99, durationMs: 190, atMs: 100, level: 0.7 },
    ],
  },
  connection_lost: {
    voice: "knock",
    durationMs: 360,
    notes: [
      { frequency: 196.0, durationMs: 180, atMs: 0, level: 0.9 },
      { frequency: 146.83, durationMs: 220, atMs: 120, level: 0.8 },
    ],
  },
  connection_restored: {
    voice: "knock",
    durationMs: 360,
    notes: [
      { frequency: 146.83, durationMs: 160, atMs: 0, level: 0.8 },
      { frequency: 196.0, durationMs: 160, atMs: 90, level: 0.8 },
      { frequency: 261.63, durationMs: 180, atMs: 180, level: 0.7 },
    ],
  },
  ptt_down: {
    voice: "tick",
    durationMs: 60,
    notes: [{ frequency: 180.0, durationMs: 50, atMs: 0 }],
  },
  ptt_up: {
    voice: "tick",
    durationMs: 60,
    notes: [{ frequency: 120.0, durationMs: 45, atMs: 0 }],
  },
};

for (const set of ["soft", "bright"]) {
  const dir = join(ROOT, set);
  mkdirSync(dir, { recursive: true });
  for (const [name, spec] of Object.entries(CUES)) {
    const { pcm } = render(spec, set === "bright");
    writeFileSync(join(dir, `${name}.wav`), wav(pcm));
  }
}

// A short manifest kept next to the assets, so a reviewer can see what was
// generated without running the script.
const lines = Object.entries(CUES).map(
  ([name, spec]) =>
    `| \`${name}.wav\` | ${spec.voice} | ${spec.durationMs} ms | ${spec.notes
      .map((note) => `${note.frequency.toFixed(2)} Hz`)
      .join(", ")} |`,
);
writeFileSync(
  join(ROOT, "MANIFEST.md"),
  `# Event sound bank\n\nGenerated by \`tools/sounds/generate.mjs\`. Values are the soft set;\nthe bright set shifts every note up a fifth and shortens the decay.\n\n| File | Voice | Length | Notes |\n|---|---|---|---|\n${lines.join("\n")}\n`,
);

console.log(`wrote ${Object.keys(CUES).length * 2} cues to ${ROOT}`);
