#!/usr/bin/env node
/* global Buffer, URL, console */
/**
 * Generates `src/assets/sounds/mention.wav`: a soft two-tone chime for an
 * incoming mention (P33). Node only, no npm packages.
 *
 * 44.1 kHz, mono, 16-bit, 0.42 s, about 37 KB. Two overlapping notes with a
 * short attack and an exponential decay; the second harmonic makes the tone
 * read as a chime rather than a beep. Run from `client/ui`:
 * `node scripts/generate-sound.mjs`.
 */

import { mkdir, writeFile } from "node:fs/promises";

const SAMPLE_RATE = 44_100;
const DURATION_SECONDS = 0.42;
const OUTPUT = new URL("../src/assets/sounds/mention.wav", import.meta.url);

/** One note: starts at `start`, lasts `length`, fundamental `frequency`. */
const NOTES = [
  { start: 0, length: 0.22, frequency: 880, gain: 0.5 },
  { start: 0.13, length: 0.29, frequency: 1318.51, gain: 0.42 },
];

function envelope(time, length) {
  const attack = 0.008;
  if (time < attack) {
    return time / attack;
  }
  const decay = (time - attack) / Math.max(0.001, length - attack);
  return Math.exp(-5.5 * decay);
}

function sampleAt(time) {
  let value = 0;
  for (const note of NOTES) {
    const local = time - note.start;
    if (local < 0 || local >= note.length) {
      continue;
    }
    const shape = envelope(local, note.length);
    const phase = 2 * Math.PI * note.frequency * local;
    value +=
      note.gain *
      shape *
      (Math.sin(phase) + 0.22 * Math.sin(2 * phase) + 0.08 * Math.sin(3 * phase));
  }
  return value;
}

function render() {
  const frames = Math.round(SAMPLE_RATE * DURATION_SECONDS);
  const samples = new Int16Array(frames);
  let peak = 0;
  for (let i = 0; i < frames; i += 1) {
    const value = sampleAt(i / SAMPLE_RATE);
    peak = Math.max(peak, Math.abs(value));
    samples[i] = Math.max(-1, Math.min(1, value)) * 32767;
  }
  // Normalize to a comfortable headroom so the chime is soft, never clipped.
  const target = 0.55 * 32767;
  const scale = peak > 0 ? target / peak : 0;
  for (let i = 0; i < frames; i += 1) {
    samples[i] = Math.round(samples[i] * scale);
  }
  return samples;
}

function wavFile(samples) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buffer;
}

const samples = render();
await mkdir(new URL("../src/assets/sounds/", import.meta.url), { recursive: true });
const file = wavFile(samples);
await writeFile(OUTPUT, file);
console.log(
  `wrote ${OUTPUT.pathname} — ${samples.length} frames, ${file.length} bytes`,
);
