# yantra-stt — working notes

This crate is the dictation service on the box ([ADR-0043](../../docs/adr/0043-dictation-runs-a-local-speech-model.md)).
It loads Parakeet-TDT-0.6B-v2 once through sherpa-onnx and answers `POST /transcribe` on one tailnet address.

Scoped to this crate; the root [`CLAUDE.md`](../../CLAUDE.md) still binds.

- It keeps nothing. No audio, transcript or hotword reaches a log (§7). The unit sends stdout nowhere.
- It listens on the address `--listen` names. Never bind it to `0.0.0.0`: the tailnet is the only door.
- Hotwords need `modified_beam_search` and `bpe.vocab` (R26 §2). The score is `yantra_core::stt::HOTWORD_SCORE`, not a flag.
- A hotword with a NUL is refused with 400, because the sherpa-onnx wrapper panics on one.
- The HTTP layer sits behind the `Recognise` trait, so its tests run without the model.
- The release binary links glibc and libstdc++. Build it on the machine that runs it, or on one with the same glibc or older; `cargo zigbuild` cannot link the prebuilt C++ libraries.
