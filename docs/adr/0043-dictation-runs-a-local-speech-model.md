# ADR-0043 — Dictation runs a local speech model on the box, and yantrad feeds it hotwords

- **Date:** 2026-11-08
- **Status:** Accepted 2026-11-08 by the owner ([Y-651](../../tracker.md)), with three answers: the service is Rust, there is no text pass, and there is no streaming. [Y-682](../../tracker.md) builds it.
- **Evidence:** [R26](../research/26-local-speech-to-text.md), 2026-11-08. The measurements in it
  were made for this ADR.
- **Extends** [ADR-0031](0031-the-microphone-reaches-a-machine-as-a-virtual-source.md) §4 (the audio
  format) and §5 (no audio in a log). It **amends nothing** in it: ADR-0031 sends sound to a program
  on a machine, and this ADR turns sound into text inside the Chat tab. The two share a button
  design and a wire format, and nothing else.
- **Reads against** [ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)
  for who may send audio, and [ADR-0021](0021-the-relay-is-written-to-an-environment-file.md) for
  where the daemon's one setting lives.

## Context

The owner wants to dictate into the Chat composer. T3 Code has no voice to copy (Y-651). The owner
rejects whisper.cpp: it is not stable enough for them, and Whisper "does not capture technical terms
well". The words that matter are crate names, file paths, CLI flags and function names.

R26 measured one candidate on the laptop. NVIDIA Parakeet-TDT-0.6B-v2, run by sherpa-onnx with int8
weights on four CPU threads, decoded speech at a real-time factor of 0.08 and used 1.2 GB of RAM.
Without help it wrote *Tokyo* for `tokio`, *sir* for `serde`, and *Rustmint* for `rustfmt`. With a
hotword list it fixed `tmux`, `ControlMaster`, `ControlPersist`, `axum`, `yantrad` and `systemd`. It
did not fix `serde` or `rustfmt`. A boost that was too high made it insert hotwords the speaker never
said. The test used synthetic speech, which flatters a model, so these numbers are a floor on the
errors and not a forecast.

## Decision

### 1. The model is Parakeet-TDT-0.6B-v2, int8, English

It has 600 M parameters, a CC-BY-4.0 licence, and writes capitals and punctuation. Its mean error
on the Open ASR Leaderboard is 6.05 %, the best of the models near 1 B that run on a CPU and take
hotwords (R26 §1). **v3** (25 languages, 6.34 %) replaces it when the owner dictates in another
language. Attribute the model in the About screen, as CC-BY-4.0 requires.

### 2. The runtime is sherpa-onnx, in a small service that Yantra orchestrates

sherpa-onnx is the only runtime that R26 found with hotwords for this model (`modified_beam_search`,
`--hotwords-file`, `--hotwords-score`) that also runs on x86-64 and aarch64 Linux (its release pages list both; the first build row re-checks). The
service is one process, `yantra-stt`, under systemd. It loads the model once, listens on the tailnet
address only, and answers `POST /transcribe` with raw 16 kHz mono s16le PCM and an optional hotword
list. It returns `{"text": "..."}`. It keeps nothing.

sherpa-onnx ships no HTTP server that takes hotwords per request (R26 §3). So `yantra-stt` is a
small Rust binary over sherpa-onnx's C API, through its Rust bindings. The owner chose Rust on
2026-11-08, so Yantra keeps one runtime outside the browser (CLAUDE.md §B1). yantrad treats the
service as `tmux` is treated, as a program behind an interface. The first build row confirms that
the bindings take a per-request hotword list. If they do not, that row stops and says so.

### 3. It runs on `yantra-box`, and the laptop is the fallback

`yantra-box` has an i5-9500T (6 cores), 14 GiB of RAM and no GPU (R26 §4). It is always on. RAM is
ample for a 1.2 GB process. **Nobody has measured the speed on the box**, because the research
agent may only read it. The laptop's Ryzen ran at 0.08. A 9500T core is slower, so the first
estimate is 0.2 to 0.3, which makes a ten-second utterance take 2 to 3 seconds. The first row of the
build measures it. If it is above 0.5, the service moves to the laptop and nothing else changes.

The daemon reads `YANTRA_STT_URL` from its environment file (ADR-0021). The setting is a URL and
holds no secret. When it is empty, the dictation button is hidden.

### 4. Audio reaches the service by push-to-talk, one utterance at a time

1. The person holds the button in the composer. The browser captures with `getUserMedia` and the
   AudioWorklet from ADR-0031 §4: 16 kHz, mono, s16le, binary WebSocket frames. This works only on
   the HTTPS origin, so it waits for [Y-652](../../tracker.md).
2. The route is `GET /api/dictate`. It calls `allowed()` before the upgrade (ADR-0016). Dictation
   is a write, because it sends audio to a program.
3. yantrad holds the frames **in memory**, up to 60 seconds. On release the browser sends a text
   frame `end`. yantrad then sends the frames and the hotword list to `YANTRA_STT_URL`.
4. The service answers with text. yantrad sends it to the browser as one text frame. The composer
   inserts it at the caret as plain text. It never sends the text on its own.
5. A silent clip, a clip over 60 seconds, or a service error returns a text frame with the reason and
   a close. The composer shows the reason.

ADR-0031 §5 keeps no buffer, because it streams sound to a speaker. This route cannot stream: the
model needs the whole utterance. The buffer is the one new thing, it is in RAM, it is capped, and
the process frees it on every exit path.

### 5. yantrad builds the hotword list

For each request yantrad sends, in this order and up to 200 entries:

1. Crate and package names from the workspace's `Cargo.toml` and `package.json`.
2. File names and directory names in the git index, as written (`Cargo.toml`, `chat.rs`).
3. CLI tools and flags that the workspace's scripts and `justfile` use, **without** the leading
   dashes (see below).
4. Identifiers that appear in the thread's last 50 messages, and that contain a capital or an
   underscore or are not in an English word list.

The list is spelled as the person wants it written, because the model writes the hotword as it is
spelled: R26 shows that spoken *control persist* came out as `ControlPersist`. Matching is
case-sensitive. The score is **3.0**. At 4.0 the model began to insert hotwords that nobody said, and
at 8.0 it wrote only hotwords (R26 §4). The score is a constant in `yantra-core`, not a setting.

What this does **not** do, and the build must not promise:

- It does not fix a word the model hears as a different word. `serde` stayed *sir* and `rustfmt`
  stayed *Rustmint*.
- A hotword that holds symbols makes things worse. `--no-fail-fast` was written correctly once and
  then sprayed *--no-* into three other sentences. So the list holds `nextest` and not
  `--no-fail-fast`, and dashes, slashes and dots are not hotwords.
- Spoken *dash dash* and *slash* stay words. The owner decided on 2026-11-08: no text pass now.

### 6. When the box is off

The dictation button reads `GET {YANTRA_STT_URL}/health` once when the Chat tab opens and again on a
failed request. If the service does not answer in two seconds, the button is disabled and says
*Dictation is off: yantra-box does not answer*. Typing is unaffected. Yantra does **not** fall back
to a cloud service or to the browser's own speech API, because both send the owner's speech to a
third party. A person who wants the fallback runs `yantra-stt` on the laptop and points
`YANTRA_STT_URL` at it.

### 7. No audio and no text in a log (Q5)

The route logs `dictate for {identity} started`, `ended` and the reason a request failed. It logs no
frame, no byte count, no transcript and no hotword. The service does the same, and its systemd unit
sets `StandardOutput=null` for the stream it controls. A test captures a TRACE subscriber, sends a
marker as audio, returns a marker as text, and asserts that neither is in the output. The route is a
new WebSocket with a text-frame protocol, so `contract.gen.ts` does not change.

## Consequences

- The Chat tab gains a button and the daemon gains one route. The daemon still persists nothing:
  the buffer is RAM and the hotword list is rebuilt for each request.
- The box carries a 650 MB model file and a 1.2 GB resident process. It is installed as an optional
  item, as ADR-0031 §1 does for the microphone. It needs no sudo beyond the unit file.
- The error rate on technical words falls but does not reach zero. The owner will still see wrong
  words. The composer is editable, and that is the safety net.
- The model weights are CC-BY-4.0. The About screen must name NVIDIA.
- The speed on the box is an estimate until the first row measures it.

## Answers from the owner, 2026-11-08

- **Rust, not Python,** for `yantra-stt`.
- **No text pass** for *dash dash*, *slash* and *dot*.
- **No streaming.** The service decodes when the button is released.
