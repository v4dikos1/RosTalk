# Third-party notices

RosTalk is distributed under the [MIT License](LICENSE). The binaries also
contain third-party software under its own licenses. The full dependency
graph is pinned in `client/src-tauri/Cargo.lock`, `client/ui/package-lock.json`
and the `go.sum` files; every crate, npm package and Go module ships its
license text in its source distribution.

All dependencies are under permissive licenses (MIT, Apache-2.0, BSD, ISC,
Zlib, Unicode-3.0 and similar) except the file-level copyleft components listed
below. No GPL, LGPL or AGPL code is linked.

## Notable components

| Component | Used in | License |
|---|---|---|
| [LiveKit Server](https://github.com/livekit/livekit-server) | server (embedded SFU) | Apache-2.0 |
| [Pion WebRTC](https://github.com/pion/webrtc) | server | MIT |
| [modernc.org/sqlite](https://gitlab.com/cznic/sqlite) | server | BSD-3-Clause |
| [LiveKit Rust SDK](https://github.com/livekit/rust-sdks) (`livekit`, `libwebrtc`, `webrtc-sys`) | client voice engine | Apache-2.0 |
| [WebRTC](https://webrtc.googlesource.com/src) (prebuilt `libwebrtc`, audio processing) | client voice engine | BSD-3-Clause |
| [Tauri](https://github.com/tauri-apps/tauri) | client shell | Apache-2.0 OR MIT |
| [cpal](https://github.com/RustAudio/cpal) | client audio I/O | Apache-2.0 |
| [nnnoiseless](https://github.com/jneem/nnnoiseless) (RNNoise port) | client noise suppression | BSD-3-Clause |
| [dfn3_rs](https://github.com/TanixLu/dfn3_rs) with the [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) model | client noise suppression | MIT OR Apache-2.0 |
| [russh](https://github.com/warp-tech/russh) | server setup wizard (SSH) | Apache-2.0 |
| [React](https://react.dev), [Radix UI](https://www.radix-ui.com), [Tailwind CSS](https://tailwindcss.com) | client interface | MIT |
| [Golos Text](https://github.com/googlefonts/golos-text) | client interface font | SIL Open Font License 1.1 (`client/ui/src/assets/fonts/golos-text/OFL.txt`) |
| [Noto Color Emoji](https://github.com/googlefonts/noto-emoji) | client emoji font | SIL Open Font License 1.1 (`client/ui/src/assets/fonts/noto-emoji/OFL.txt`) |

## File-level copyleft (MPL-2.0)

These libraries are used unmodified. Their source code is available from the
linked repositories and from the Go module proxy or crates.io.

| Component | Used in |
|---|---|
| [hashicorp/go-cleanhttp](https://github.com/hashicorp/go-cleanhttp), [go-retryablehttp](https://github.com/hashicorp/go-retryablehttp), [go-version](https://github.com/hashicorp/go-version), [golang-lru](https://github.com/hashicorp/golang-lru) | server (through LiveKit) |
| [cssparser](https://github.com/servo/rust-cssparser), [selectors](https://github.com/servo/stylo), [dtoa-short](https://github.com/upsuper/dtoa-short) | client (through Tauri) |
| [option-ext](https://github.com/soc/option-ext) | client (through `dirs`) |

## Assets made for RosTalk

The notification sounds in `client/src-tauri/crates/voice/assets/sounds/` are
synthesized by `tools/sounds/generate.mjs` and dedicated to the public domain
under CC0-1.0 (see the `LICENSE.md` next to them).
