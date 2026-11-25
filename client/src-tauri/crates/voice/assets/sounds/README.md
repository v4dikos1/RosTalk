# Event sound bank

Generated assets for stage P10. Do not edit the WAV files by hand: rerun

```sh
node tools/sounds/generate.mjs
```

Source, provenance and licence: `docs/assets/sounds/LICENSE.md`.
Per-cue frequencies and lengths: `MANIFEST.md`.

The client embeds these files with `include_bytes!` and decodes them once
(`crates/voice/src/sounds.rs`). Keep the layout 16-bit PCM mono 48 kHz.
