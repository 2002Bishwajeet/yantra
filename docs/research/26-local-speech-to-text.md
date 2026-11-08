# R26 — Local speech-to-text for the Chat composer

**Asked 2026-11-08 by the owner, for [Y-651](../../tracker.md) and ADR-0043.** The owner wants to
dictate into the Chat composer with a small local model, and rejects whisper.cpp because Whisper
"does not capture technical terms well".

- **Every claim says one of:** *card* (the model's Hugging Face page), *docs* (vendor documentation),
  *measured* (run on the laptop on 2026-11-08), or *not found*.
- **Measured on:** an AMD Ryzen 5 4600HS, 6 cores, 12 threads, 4 threads used. Not on `yantra-box`.
- **Leaderboard caveat.** The live Open ASR Leaderboard page returned no table to the fetch tool. The
  mean errors below come from each model's card, which copies the leaderboard value. Cards and the
  leaderboard may differ by a re-run. Blog posts that rank models disagree with each other, so none
  is used here.

## Negative findings

1. **sherpa-onnx hotwords work only for transducer models** and only with `modified_beam_search`.
   Canary, Whisper-family, Moonshine and the LLM-style models get none (docs).
2. **A high boost makes the model say words nobody said.** Score 5.0 inserted `clippy` into two
   sentences. Score 8.0 wrote only hotwords (measured, §4).
3. **Hotwords do not fix a word the model hears as a far-off word.** `serde` stayed *sir* and
   `rustfmt` stayed *Rustmint* at every score (measured).
4. **A hotword that holds symbols is dangerous.** `--no-fail-fast` as a hotword fixed one sentence and
   injected *--no-* fragments into three others (measured).
5. **Spoken *dash dash* and *slash* are never turned into `--` and `/`** by any run (measured).
6. **sherpa-onnx has no OpenAI-style REST server** and its WebSocket servers fix the hotword list at
   start (docs; the pip wheel ships `sherpa-onnx-cli` only). Wrapping it is our job.
7. **TTS audio flatters the model.** The test voice is clean, slow and consistent. A real voice on a
   phone microphone will do worse.
8. **Not measured:** speed on `yantra-box`, Qwen3-ASR's context feature, NeMo GPU-PB, Moonshine,
   Kyutai and Voxtral. Kyutai and Voxtral expect a GPU (card).

## 1. Candidate models

| Model | Params | Licence | Languages | Punct. | Streaming | Mean error | Hotwords | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Parakeet-TDT-0.6B-v2 | 0.6 B | CC-BY-4.0 | English | yes | no (offline) | 6.05 % | yes, in sherpa-onnx and NeMo | card |
| Parakeet-TDT-0.6B-v3 | 0.6 B | CC-BY-4.0 | 25 European | yes | chunked, NeMo script | 6.34 % | same | card |
| Canary-1B-flash | 0.88 B | CC-BY-4.0 | en, de, fr, es | optional | no | 6.35 % | NeMo GPU-PB only | card, docs |
| Canary-180M-flash | 0.18 B | CC-BY-4.0 | en, de, fr, es | optional | no | 7.12 % | NeMo GPU-PB only | card, docs |
| Moonshine streaming-medium | 0.245 B | MIT | English (README lists ten) | not stated | yes | 6.65 % | not found | card, README |
| Moonshine base | 0.061 B | MIT | English | not stated | no | 9.99 % | not found | card |
| Kyutai stt-1b-en_fr | 1.0 B | CC-BY-4.0 | en, fr | yes | yes, 0.5 s delay | not stated | not found | card |
| Voxtral Mini 4B Realtime | 4 B | Apache-2.0 | 13 | not stated | yes, 240 ms to 2.4 s | 7.68 % | not found; needs 16 GB GPU | card |
| distil-large-v3.5 | 0.756 B | MIT | English | yes (Whisper) | no | 7.08 % (short form) | Whisper `prompt_ids` | card |
| Canary-Qwen-2.5B | 2.5 B | CC-BY-4.0 | English | yes | no | 5.63 % | fixed prompt, no context documented | card |
| Qwen3-ASR-0.6B | 0.9 B | Apache-2.0 | 52 | not stated | vLLM only | not stated | card is silent; paper says trained for it | card |

Notes:

- Canary-Qwen-2.5B and Qwen3-ASR are above or at the top of the size range and lead the mean
  error among open models (blog snapshots of late October 2026 put Qwen3-ASR-1.7B near 5.4 %; those
  are not primary sources). Neither is the pick: Canary-Qwen needs a GPU (card) and Qwen3-ASR's
  context feature is undocumented on its card.
- Parakeet and Canary mean errors are reported without punctuation (card).
- Parakeet-v2's card lists a 24-minute limit per pass and "at least 2 GB of RAM".

## 2. Context biasing

| Runtime | Models | How | Limits |
| --- | --- | --- | --- |
| sherpa-onnx | Transducers only, streaming and offline, including NeMo Parakeet-TDT | `decoding_method=modified_beam_search`, `hotwords_file`, `hotwords_score` (default 1.5), `modeling_unit=bpe`, `bpe_vocab`; per-hotword score as `word :3.5`; `create_stream(hotwords=...)` takes a list for one stream | Token-level match. A partial match is boosted and the boost is cancelled if it never completes. Greedy search ignores hotwords. |
| NeMo GPU-PB | CTC, RNN-T/TDT, Canary | `boosting_tree.key_phrases_file`, `context_score=1.0`, `depth_scaling=2.0` (1.0 for Canary), `boosting_tree_alpha` tuned. TDT: `strategy=greedy_batch` or `malsd_batch`. Per-stream via `biasing_request` for TDT | Phrases must be capitalised as the model writes them. Docs state no phrase limit. A paper says up to 20 K phrases. |
| Whisper family | distil-whisper | `prompt_ids` (card) | Prompt biasing is the weak path the owner already rejected. |
| Qwen3-ASR | | System-prompt context (paper, third-party summary) | Exact API not found on the card. |

Can Yantra feed workspace words as hotwords? **Yes, with limits** (§4). The hotword text is also the
output text, so a hotword spelled `ControlPersist` turns spoken *control persist* into
`ControlPersist` (measured). A hotword cannot map a spoken form to a different written form.

## 3. Runtimes

| Runtime | Server | Parakeet | Hotwords | Install | Note |
| --- | --- | --- | --- | --- | --- |
| sherpa-onnx 2.0.1 | WebSocket servers (own protocol), no REST | yes, `model_type=nemo_transducer`, int8 files from the release page | yes (§2) | `pip install sherpa-onnx`, or the C++ binaries | Apache-2.0 library. Prebuilt for aarch64 and x86-64 Linux (stated by its release pages; not re-checked). |
| onnx-asr 0.12.0 | none | yes | **not found** | `pip install "onnx-asr[cpu,hub]"` | MIT. CPU RTFx 36 on a Ryzen 9800X3D, 1.0 on a Cortex-A53 (docs). A page warns that onnxruntime 1.24.1 breaks it. |
| NeMo | scripts | yes | GPU-PB (§2) | PyTorch stack, heavy | Card lists NVIDIA GPUs as the tested hardware. |
| Third-party OpenAI-style wrappers for Parakeet | `/v1/audio/transcriptions` | yes | their own | pip | e.g. `parakeet-api`. Not evaluated. |
| faster-whisper-style servers (speaches) | REST | **not found** | Whisper prompt only | | Not evaluated, and Whisper is the rejected family. |

## 4. Measurement

- **Setup.** `~/yantra-stt-research/` holds a venv with sherpa-onnx 2.0.1, the int8 Parakeet-TDT-0.6B-v2
  files from the sherpa-onnx release page (encoder 652 MB), and Piper's `en_US-lessac-medium` voice.
  Six sentences with technical terms were spoken by Piper (22.05 kHz, 4.2 to 6.8 s each, 32 s total).
  Spoken forms were *dash dash no fail fast*, *slash*, *dot*. Ground truth is what was said.
- **Speed.** RTF = decode time / audio time, model loaded, six clips, excluding load (2.2 s).

| Setting | Threads | RTF | Peak RSS |
| --- | --- | --- | --- |
| greedy, no hotwords | 4 | 0.075 | 1.19 GB |
| greedy, no hotwords | 1 | 0.181 | not measured |
| modified_beam_search + 15 hotwords | 4 | 0.086 to 0.089 | 1.21 GB |

- **Words that matter, by setting.** "ok" = written as intended.

| Term | no hotwords | score 2 | score 3 | score 4 | score 5 |
| --- | --- | --- | --- | --- | --- |
| `yantra` | cased *Yantra* (ok) | ok | ok | ok | ok |
| `tokio` | *Tokyo* | *Tokyo* | *Tokyo* | ok | ok |
| `ControlMaster` | *control master* | ok | ok | ok | ok |
| `ControlPersist` | *control persist* | ok | ok | ok | missing |
| `tmux` | *Tmux* | ok | ok | ok | ok |
| `axum` | *Axim* | ok | ok | ok | ok |
| `yantrad` | *Yantrad* | ok | ok | ok | ok |
| `systemd` | *system D* | ok | ok | ok | ok |
| `serde` | *sir* | *sir* | *sir* | *sir* | *sir* |
| `rustfmt` | *Rustmint* | *rustmint* | *rustmint* | *rustm tent* | *rustment tmux* |
| `journalctl` | *journal ktl-u* | *journal ktl-u* | *journal cuttle-u* | ok | ok |
| `spawn blocking` | spoken as two words | same | same | same | same |
| false insertions | none | none | none | `clippy` x2 | `clippy` x2, `tmux` x1 |

At score 8.0 every sentence was mostly hotwords (*tmux tmux tmux serde ...*). **The usable score
was 2 to 3.** Score 3.0 and 15 hotwords fixed six terms and inserted nothing.

- **Symbol hotwords.** A second list held `spawn_blocking`, `portable-pty`, `--no-fail-fast`,
  `Cargo.toml`. At score 3.0, `Cargo.toml` was fixed and `--no-fail-fast` was fixed in one sentence.
  But `--no-` fragments appeared in three other sentences. `spawn_blocking` and `portable-pty` were
  never written. The list is unsafe.
- **Per-stream hotwords.** `create_stream(hotwords="serde\naxum\nrustfmt\nclippy")` ran with no error.
  Its effect was not separated from the global file, so it is *not verified*.
- **Estimate for `yantra-box`.** `yantra-box` is an Intel i5-9500T, 6 cores, no SMT, 14 GiB RAM, 12 GiB
  swap, and an Intel UHD 630 only (read over ssh with `lscpu`, `free -h`, `lspci`, 2026-11-08). The
  laptop's four-thread RTF of 0.08 suggests 0.2 to 0.3 there. This is a guess, to be measured.
- **What this did not test.** Real human speech, accents, background noise, Parakeet v3, NeMo
  GPU-PB, a hotword list over 15 entries, and recognition of long utterances.

## 5. Recommendation

Parakeet-TDT-0.6B-v2, int8, in sherpa-onnx, with 2.0 to 3.0 as the hotword score and a list of names
only. See [ADR-0043](../adr/0043-dictation-runs-a-local-speech-model.md).

## Sources

All accessed 2026-11-08.

- NVIDIA, *parakeet-tdt-0.6b-v2* — <https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2>
- NVIDIA, *parakeet-tdt-0.6b-v3* — <https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3>
- NVIDIA, *canary-1b-flash* — <https://huggingface.co/nvidia/canary-1b-flash>
- NVIDIA, *canary-180m-flash* — <https://huggingface.co/nvidia/canary-180m-flash>
- NVIDIA, *canary-qwen-2.5b* — <https://huggingface.co/nvidia/canary-qwen-2.5b>
- Useful Sensors, *moonshine-base* — <https://huggingface.co/UsefulSensors/moonshine-base>
- Useful Sensors, *moonshine-streaming-medium* — <https://huggingface.co/UsefulSensors/moonshine-streaming-medium>
- Moonshine README — <https://github.com/moonshine-ai/moonshine>
- Kyutai, *stt-1b-en_fr* — <https://huggingface.co/kyutai/stt-1b-en_fr>
- Mistral, *Voxtral-Mini-4B-Realtime-2602* — <https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602>
- distil-whisper, *distil-large-v3.5* — <https://huggingface.co/distil-whisper/distil-large-v3.5>
- Qwen, *Qwen3-ASR-0.6B* — <https://huggingface.co/Qwen/Qwen3-ASR-0.6B> and the report <https://arxiv.org/abs/2601.21337>
- sherpa-onnx, *Hotwords (Contextual biasing)* — <https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html>
- sherpa-onnx, *NeMo transducer models* — <https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html>
- sherpa-onnx, *WebSocket servers* — <https://k2-fsa.github.io/sherpa/onnx/websocket/offline-websocket.html>
- NVIDIA NeMo, *Word Boosting* — <https://docs.nvidia.com/nemo/speech/latest/asr/asr_customization/word_boosting.html>; TurboBias paper <https://arxiv.org/abs/2508.07014>
- onnx-asr — <https://istupakov.github.io/onnx-asr> and <https://pypi.org/project/onnx-asr/>
- Open ASR Leaderboard — <https://huggingface.co/spaces/hf-audio/open_asr_leaderboard> (page returned no table to the fetch tool)
- Piper voice `en_US-lessac-medium`, `piper-tts` 1.8.0 (pip, run locally)
- Measurements: `~/yantra-stt-research/run.py` and `hot.txt`, 2026-11-08, on the owner's laptop.
