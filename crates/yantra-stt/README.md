# yantra-stt

Speech to text for the Chat composer's dictation ([ADR-0043](../../docs/adr/0043-dictation-runs-a-local-speech-model.md)).
`yantrad` sends one utterance and a hotword list to `POST /transcribe`, and puts the text at the caret.

The model is [Parakeet-TDT-0.6B-v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) by **NVIDIA**,
used under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). The runtime is
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), Apache-2.0.

## Install on the box

No sudo is needed. The service is a systemd user unit, so the account needs linger.

1. Build on the box, or on a machine with the same glibc or an older one:
   `cargo build --release -p yantra-stt`. Copy the binary to `~/.local/bin/yantra-stt`.
2. Download the int8 model from the sherpa-onnx release page into
   `~/.local/share/yantra-stt/parakeet-tdt-0.6b-v2-int8/`: `encoder.int8.onnx`, `decoder.int8.onnx`,
   `joiner.int8.onnx` and `tokens.txt`.
3. Make `bpe.vocab` from `tokens.txt` in that directory. Hotwords need it:
   `awk '{printf "%s\t%g\n", $1, -($2+1)/1000}' tokens.txt > bpe.vocab`
4. Copy [`yantra-stt.service`](yantra-stt.service) to `~/.config/systemd/user/`. Set `LISTEN` to
   `$(tailscale ip -4):7718`. Then run `systemctl --user daemon-reload` and
   `systemctl --user enable --now yantra-stt`.
5. On the hub, set `YANTRA_STT_URL=http://<that address>:7718` in `/etc/yantra/daemon.env` and
   restart `yantrad`. The Chat then shows the dictation button.

Check it with `curl http://<address>:7718/health`, which answers 200.

## Speed on the box

Measured on 2026-11-11 on `yantra-box` (Intel i5-9500T, 6 cores, 14 GiB RAM), with
`yantra-stt bench --model <dir> --threads 4` over R26's six Piper clips (32.3 s of audio). The model
load (2.2 s) is not in the real-time factor.

| Setting | RTF | Peak RSS |
| --- | --- | --- |
| no hotwords | 0.090 | 0.95 GB |
| 13 hotwords, per request | 0.088 | 0.95 GB |

A ten-second utterance takes about one second to decode. ADR-0043 §3 moves the service to the
laptop above 0.5, so it stays on the box. One request through the running service, a 6.5 s clip
from the laptop over the tailnet, took 0.57 s.
