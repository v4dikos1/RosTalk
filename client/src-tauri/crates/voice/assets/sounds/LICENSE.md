# Notification sounds

Every file in this folder was synthesized offline for RosTalk by
`tools/sounds/generate.mjs`: short tones with a soft attack and an exponential
decay, no samples and no third-party libraries. Running the script again
reproduces the files byte for byte.

- The generated WAV files are dedicated to the public domain under
  **CC0-1.0**: use, change and redistribute them without attribution.
- The generator script is part of RosTalk and is under the project's
  [MIT License](../../../../../../LICENSE).

Format: RIFF/WAVE PCM, 16-bit, mono, 48 kHz, at most 400 ms each. Two sets:
`soft` (the default) and `bright` (a fifth higher, shorter decay). The list of
events, frequencies and durations is in `MANIFEST.md`.
