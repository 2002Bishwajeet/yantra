# A decision model: the data, the training and the eval

**Planned 2026-10-12.** Rows [Y-461 to Y-469](../../tracker.md#3-task-board). Owner's instruction,
2026-10-12: do not integrate Laya or Jev now. Make the work ready, so that a later session can
collect and clean the data, train Laya on RunPod, and integrate Laya or Jev.

This plan builds nothing in the daemon. It says which decision to learn, where the labels come
from, how to train and how to judge the result. The integration waits for an ADR (Y-468).

---

## 1. Context

[Laya](https://github.com/NandhaKishorM/laya) is an Apache-2.0 decision model of about 421M
parameters. It runs locally. [Jev](https://typesafe.ai) is TypeSafe AI's hosted model. Both answer
the same request shape, `POST /v1/systemone`, so the backend choice stays open.

The owner's research note of 2026-10-12 (Journal, *Yantra: Laya and Android over Tailscale*) found:

- Laya scores **0.362 zero-shot** on its own benchmark, below the 0.461 that the most common answer
  gets. Fine-tuned, it scores **0.766**. So Laya is useful only after a fine-tune on our own labels.
- Placement (Y-452), model routing and live tool gating are poor fits. Rules or Claude decide them
  better. This plan does not reopen those verdicts.
- The appliance (i5-9500T, no GPU) has no measured latency. The estimate is 250–450 ms for each
  question, and INT8 ONNX may halve it.
- Rust has no Laya runtime. The path is the INT8 ONNX graph in the `ort` crate, plus a port of the
  prompt building and answer decoding in `onnx_agent.py`.

## 2. The decisions, and where their labels come from

A row with no named decision is useless, so the decision comes first. The owner asked for decisions
whose labels come free. **That rule holds, but the owner's own history has almost no free labels.**
On 2026-10-12 a scan of this box's `~/.claude/projects` (2,642 transcript files, 29,906 tool calls)
found:

| Signal | Count | Why |
| --- | --- | --- |
| Tool calls the owner refused in the TUI (`doesn't want to proceed`) | 6 | The owner works in `bypassPermissions`, `dontAsk` and `auto`. Only 7 user messages ran in `default` mode. |
| Tool calls refused in the Chat (`The person declined in Yantra.`) | 0 | Every hit of that string was the source code quoted back, not a refusal. |
| `yantra mcp` delegations (`mcp__yantra__start_task`) | 0 | Delegation shipped on 2026-10-06 and the owner has not used it from this box. |
| Assistant turns that ended (`stop_reason: end_turn`), main sessions only | 3,489 | Every turn ends; nothing says whether it ended done or asking. |
| `AskUserQuestion` calls | 18 | The one crisp "needs input" signal. |

The scan covers one machine. The Mac may differ, and the extractor (Y-463) gives the real count.

### 2.1 Picked first: the state of a session at the end of a turn

- **Input:** the last assistant message of a turn, and the user message before it, cut to the
  model's sequence length.
- **Output:** a `choice` of `done`, `needs_input` or `blocked`.
- **Why it matters:** `notify::Phase::WaitingForInput` exists, and no `Verdict` maps to it. For a
  TUI session the notifier cannot tell "finished" from "asks you a question". The difference is in
  the text, so a rule is weak here and a text model can help.
- **Rule to beat:** the last assistant text ends with a question mark, or the turn called
  `AskUserQuestion` → `needs_input`; else `done`.
- **Labels:**
  1. Crisp and free: `AskUserQuestion` → `needs_input`. `max_tokens` and
     `model_context_window_exceeded` → `blocked`, but a rule already decides those, so they stay
     out of the model's job and out of the eval.
  2. Weak and free: the owner's next message. A reply under 200 characters within 30 minutes
     suggests an answer (`needs_input`). A new task, a `/clear`, or no reply suggests `done`. This is
     noisy and serves only as a check on 3.
  3. Paid: a Claude judge labels each turn, through the owner's own login. The transcripts went to
     Anthropic when they were written, so the judge adds no new party. The owner audits a random
     sample (§3.2). Laya's own `laya-typed-decisions` learned from a teacher's labels in the same
     way, so this is the method the model was built for.
- **Volume:** thousands of turns on this box alone, so volume is not the limit. Label quality is.

### 2.2 Kept as a candidate: tool permission

- **Input:** the tool name and its input, as Claude Code writes them in the `tool_use` block.
- **Output:** `noul`, the probability that the owner allows it.
- **Labels:** a refusal is crisp (`is_error` and one of the two strings above). An allow is **not**
  crisp: a tool that ran may have run under an allow rule or a permissive mode, and the transcript
  does not record that a person was asked. The `permissionMode` field on each entry narrows it: in
  `default` mode a tool that ran and is not in the allow list was asked and allowed.
- **Why not first:** six refusals in 29,906 calls. A fine-tune needs at least 500 in each class
  (§3.4). This decision becomes viable only if the owner runs the Chat in its Supervised mode
  (Y-453) for weeks. The owner decides that in Q23.
- **Its use, if it ever passes:** a default on the Chat's permission card, never an automatic
  answer. The research note's verdict on live gating stands: a wrong allow costs too much.
- **A correction to the research note.** Its 1c says Yantra is not in the tool-call loop. That
  holds for TUI sessions. In the Chat, `yantrad` answers Claude's `can_use_tool` control requests
  itself (`crates/yantra-core/src/claude.rs`), so the card is the one place a model could help.

### 2.3 Dropped: the delegation target

No row exists (zero calls). The research note's 1b verdict also stands: Claude, with the whole
conversation in front of it, picks the machine and harness better than a 421M classifier. Write the
policy into the `yantra mcp` tool descriptions instead.

### 2.4 Dropped: ntfy urgency

The daemon already knows the event kind (`notify::Phase`). A rule sets the priority. No text
decision is left.

## 3. The data pipeline

**Collect nothing new.** The source is the redacted history of
[ADR-0032](../adr/0032-the-appliance-keeps-the-conversation-history-encrypted.md). yantrad stays out
of the data path, and §B1 holds. No new store and no new ADR are needed for the data.

**The staging copy is enough; the archive is not needed.** Y-430 is done: `yantra history stage`
writes a redacted copy of each harness's transcripts to `$XDG_DATA_HOME/yantra/history/` on each
machine. The archive on the appliance (Y-431) waits on the disk key (Y-429), which waits on the
owner's appliance. The extractor reads either folder, because the archive holds the same files.
So Y-463 depends on Y-430 and not on Y-431. Run it on one machine's staging copy now, and on the
archive when it ships.

**Nothing in this pipeline is committed.** The rows, the labels and the checkpoints stay on the
owner's disk and on the RunPod volume. The repo holds the code and the plan only.

### 3.1 Extract

`yantra history extract --decision <session-state|tool-permission> --out <dir> <folder>`, a Rust
subcommand beside `yantra history stage` in the `yantra` CLI. It reuses the `Scan` trait and
`GITLEAKS_CONFIG` from `crates/yantra-core/src/history.rs`. Claude Code transcripts only at first;
the other harnesses in `HARNESSES` follow when a decision needs them.

Each line of `<dir>/rows.jsonl` is one row in Laya's training format (§4.1). It also writes
`rows.meta.jsonl`, one line for each row in the same order, with what the split and the audit need.
Laya's docs do not say that the trainer ignores an unknown key, so the metadata stays out of the
training file.

```json
{"session": "<transcript uuid>", "repo": "<slugged cwd>", "ts": "2026-10-08T09:14:02Z",
 "source": "ask_user_question|next_message|judge", "next_message": "answer|new_task|none"}
```

### 3.2 Label

1. The extractor writes the crisp labels (§2.1 item 1), and the weak label (item 2) in
   `rows.meta.jsonl`.
2. A judge pass labels the rest. It reads the same `criteria` text as the model (§4.1), so a later
   session does not invent the label set. The judge writes its label and one line of reason.
3. **The owner audits 200 random rows.** The pass mark is 95% agreement with the judge. Below it,
   the label definitions change and the judge runs again. The build loop cannot do this step.

### 3.3 Re-check the redaction, then dedupe

1. The extractor runs every row through gitleaks with `GITLEAKS_CONFIG` again. The rows are
   excerpts of already redacted files, so a finding means a rule changed or the staging copy is old. Drop the row and
   count it. A count above zero is a bug report against Y-430.
2. Drop exact duplicates by a hash of the input text.
3. Drop near-duplicates: the same session and the same first 200 characters. Agent loops repeat
   their messages.
4. Drop the yantra repo's own test runs: a session whose `cwd` is a podman fixture or a tempdir.

### 3.4 How many rows, and balance

Laya gives no minimum. Its own evidence is three data points:

| Data | Training size | Result |
| --- | --- | --- |
| `laya-typed-decisions` | 1,200 cases, 6,000 decisions | 0.362 → 0.766 |
| MASSIVE intent, 20 options | 11,514 rows | 0.730 → 0.936 |
| Issue #963 | 1,100 items, 72 updates | the head collapsed; 8 epochs still failed |

So the floor for a first run is **3,000 labelled training rows** for the decision, with at least
500 in the smallest class. Below that, do not spend a GPU hour. Cap each class at three times the
smallest in the training set. Keep the natural rate in the test set, because the pass mark must
reflect real traffic.

### 3.5 Split

Split by **session**, never by row, so that one conversation cannot sit in train and in test. Hold
out every session of one repo that the training set never sees, to measure transfer.

| Set | Share | Use |
| --- | --- | --- |
| train | 70% | the fine-tune |
| dev | 10% | early stopping and the threshold |
| test | 20% | the §5 table, read once per arm |
| held-out repo | one repo | transfer check |

Write a short dataset card beside the files: counts per class, the label source mix, the audit
score, the gitleaks drop count and the extractor's git commit.

## 4. The training run on RunPod

Laya's code was read at commit `c73908d96ff73c0062c340a11bf7c54ec7d8bc4d` (2026-10-12). Pin that
commit, or read the diff before a newer one runs on the owner's data. The commands below are from
Laya's `docs/finetune.md`, `scripts/export_onnx.py` and RunPod's `runpodctl` reference. Nobody has
run them for Yantra yet.

### 4.1 The training-data format

`laya-train` reads JSONL, one case per line: a `state`, the `questions`, and `expected` with a hard
label for each question. This is the session-state row Y-463 writes:

```json
{"state": {"owner": "Rename the flag and run the tests.",
           "agent": "Renamed it in 4 files. 2 tests fail on the old name in fixtures. Update the fixtures too?"},
 "questions": {"turn_state": {"type": "choice",
   "instructions": "The agent's turn has ended. What must the owner do now?",
   "criteria": {"done": "Nothing: the agent finished and reports the result",
                "needs_input": "Answer: the agent asks a question or waits for a choice",
                "blocked": "Fix something: the agent cannot go on without access, a tool or a fix"}}},
 "expected": {"turn_state": "needs_input"}}
```

The tool-permission row, if Q23 ever picks it, uses a `noul`:

```json
{"state": {"tool": "Bash", "input": {"command": "git push --force origin main"}},
 "questions": {"allow": {"type": "noul", "instructions": "Would the owner allow this tool call?"}},
 "expected": {"allow": false}}
```

In place of `expected`, a row may carry `gold`, the teacher's probabilities:
`{"turn_state": {"probabilities": {"done": 0.1, "needs_input": 0.85, "blocked": 0.05}}}`. Use it if
the judge gives probabilities, for example by a vote over three samples. The question text must be
the same in every row, in the eval and in the integration. One file, `questions.json`, holds it.

### 4.2 The defaults Laya trains with

A full fine-tune of ModernBERT-large (421M); Laya has no LoRA path. AdamW with a cosine schedule,
`encoder_lr` 2.5e-5, `head_lr` 1e-4, 4 epochs, micro-batch 8 with gradient accumulation 8 (an
effective batch of 64), fp16 and gradient checkpointing on CUDA. The loss is `rlcd` by default;
issue #887's reproduction scored `soft-ce` higher (0.790 against 0.7715). Laya publishes no GPU
memory figure. Its runs fit a 16 GB card. The published time figures conflict (4–6 minutes and 4–5
hours for the same notebook), so treat the run time as unknown until `--dry-run` prints the update
budget.

### 4.3 The pod

Use the **secure** cloud. The rows are redacted conversation text, and the community cloud runs on
hosts that third parties own. An RTX 4090 (24 GB) has room to spare for a 421M fine-tune.

| GPU | Community $/h | Secure $/h |
| --- | --- | --- |
| RTX 4090, 24 GB | 0.34 | 0.74 |
| A40, 48 GB | 0.35 | 0.49 |
| L40S, 48 GB | 0.79 | 1.09 |
| A100 SXM, 80 GB | 1.39 | 1.59 |

Prices are from runpod.io/pricing on 2026-10-12, billed per second. Use a pod, not serverless:
serverless is built for inference endpoints, and a training run needs a shell for hours. Three
seeds at about two hours each on a secure 4090 cost roughly $5. That is an estimate.

```bash
# On the owner's box. `doctor` stores the API key and the ssh key.
runpodctl doctor
runpodctl pod create --name laya-ft --template-id runpod-torch-v21 \
  --gpu-id "NVIDIA GeForce RTX 4090" --cloud-type SECURE \
  --container-disk-in-gb 40 --volume-in-gb 50
runpodctl pod list                                # note the pod's ssh host and port
scp -P <port> train.jsonl dev.jsonl test.jsonl heldout.jsonl questions.json root@<host>:/workspace/data/
ssh -p <port> root@<host>
```

### 4.4 The run

Run it in `tmux` on the pod, because a dropped ssh connection must not end the run.

```bash
cd /workspace
git clone https://github.com/NandhaKishorM/laya && cd laya
git checkout c73908d96ff73c0062c340a11bf7c54ec7d8bc4d
pip install -e ".[onnx]"
laya-train --help                                 # confirm the flags below still exist

# 1. The update budget, with no weights loaded.
laya-train --data /workspace/data/train.jsonl --base english --out /workspace/ckpt/dry --dry-run

# 2. Three seeds. Issue #963 saw identical data take off on some seeds and not on others.
for seed in 0 1 2; do
  laya-train --data /workspace/data/train.jsonl --eval /workspace/data/dev.jsonl \
    --base english --out /workspace/ckpt/seed$seed --loss soft-ce --shuffle-options choice \
    --epochs 4 --seed $seed 2>&1 | tee /workspace/ckpt/seed$seed.log
done
```

If fewer than 3,000 training rows exist (§3.4), do not start. If the dev score does not move on any
seed, raise `--epochs` to 8 once, then stop. Keep the seed with the best dev score. Never pick by the
test set.

### 4.5 The ONNX export

```bash
python scripts/export_onnx.py --model /workspace/ckpt/seed<best> \
  --output /workspace/ckpt/turn-state.onnx --quantize
# writes turn-state.onnx (fp32) and turn-state.int8.onnx
```

Do not pass `--per-channel`; Laya's docs say it collapses the model. **INT8 costs accuracy.** Laya's
own docs measure about 67% agreement with the eager English model, and warn against INT8 where the
probability matters (`docs/reference/agent.md`, issue #790). So §5 scores the fp32 file and the INT8
file as two arms, and the integration ships the one that passes.

### 4.6 Bring it home and clean up

```bash
scp -P <port> -r root@<host>:/workspace/ckpt ~/laya-runs/$(date +%F)/
runpodctl pod stop <pod-id>
runpodctl pod delete <pod-id>                     # the volume and the redacted rows go with it
```

RunPod's reference lists `create, list, start, stop, inspect, delete` for `runpodctl pod`. The exact
stop and delete syntax was not checked. Confirm in the RunPod console that no pod and no volume is
left.

## 5. The eval

Every arm answers the same `questions.json` on the same test set. Each arm reads the test set once.

### 5.1 The arms

| Arm | What it is | Where it runs |
| --- | --- | --- |
| Rule | §2.1's rule, as the integration would run it | the owner's box |
| Laya zero-shot | `convaiinnovations/laya`, eager PyTorch, CPU | the owner's box |
| Jev zero-shot | `jev-latest`, offline, only if Q24 says yes (§5.2) | TypeSafe |
| Laya fine-tuned, fp32 ONNX | `turn-state.onnx` | the owner's box |
| Laya fine-tuned, INT8 ONNX | `turn-state.int8.onnx` | the owner's box |
| The judge | the labels themselves, on the 200 audited rows | for scale only |

Score the exact file the integration would ship, not the PyTorch checkpoint it came from.

**Metrics:** macro-F1 over the classes; the recall of `needs_input`, because a missed question is
the failure that hurts; and the same two on the held-out repo. The eval script is a short Python
file beside the data on the owner's disk, outside the repo. Rust stays the only runtime in the
repo's control plane (§B1). Y-469 ports the decoding and tests it against these numbers.

### 5.2 Jev: offline only

Jev is hosted. Sending conversation text to TypeSafe conflicts with ADR-0032, where the owner
refused a plaintext copy off the machines, and with Yantra's position against a third-party relay.
TypeSafe offers zero data retention to enterprise customers only, and its data processing agreement
names no retention period. Jev also is not fine-tuned on customer data, so its arm is zero-shot only.

So Jev is an offline baseline on the redacted test set. It is opt-in (Q24) and never in the live
path, unless an ADR says otherwise. The request needs a bearer key in `TYPESAFE_API_KEY`:

```bash
curl -s https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" -H "Content-Type: application/json" \
  -d '{"model": "jev-latest", "state": {"owner": "…", "agent": "…"},
       "questions": {"turn_state": {"type": "choice", "instructions": "…", "criteria": {"done": "…"}}}}'
```

The answer is `{"model": "jev-1.13.0", "answers": {"turn_state": {"type": "choice", "choice": "…",
"probabilities": {…}, "confidence": 0.81}}, "usage": {…}}`. Retry 429 and 529 with backoff. At
$0.042 for each million input tokens, a 2,000-row test set costs cents.

### 5.3 The appliance benchmark

Y-467 runs this before any GPU hour, with the base checkpoint. Latency and memory depend on the
architecture and the sequence length, not on the fine-tune. If it fails, the subject closes for this
appliance. It adapts the research note's experiment:

```bash
mkdir -p ~/laya-bench && cd ~/laya-bench
python3 -m venv .venv && . .venv/bin/activate
pip install --index-url https://download.pytorch.org/whl/cpu torch
git clone https://github.com/NandhaKishorM/laya src
git -C src checkout c73908d96ff73c0062c340a11bf7c54ec7d8bc4d
pip install -e "src[onnx]"
python src/scripts/export_onnx.py --model convaiinnovations/laya --output laya.onnx --quantize
cat > bench.py <<'PY'
import json, statistics, sys, time, laya
q = {"turn_state": {"type": "choice", "instructions": "The agent's turn has ended. What must the owner do now?",
     "criteria": {"done": "finished", "needs_input": "asks a question", "blocked": "cannot go on"}}}
s = {"owner": "Rename the flag and run the tests.", "agent": "Renamed it. " * 120 + "Update the fixtures too?"}
kw = {"backend": "onnx", "onnx_path": sys.argv[1]} if len(sys.argv) > 1 else {"device": "cpu"}
a = laya.load("convaiinnovations/laya", **kw)
for _ in range(3): a.predict(s, q)
t = []
for _ in range(50):
    t0 = time.perf_counter(); a.predict(s, q); t.append((time.perf_counter() - t0) * 1000)
t.sort(); print(json.dumps({"p50_ms": round(statistics.median(t)), "p95_ms": round(t[47])}))
PY
for f in "" laya.onnx laya.int8.onnx; do
  OMP_NUM_THREADS=4 /usr/bin/time -v python bench.py $f 2>&1 | grep -E 'p50|Maximum resident'
done
```

The state is about 500 tokens, near the base model's 512 limit, so the numbers are the worst case.
`OMP_NUM_THREADS=4` leaves two of the i5-9500T's six cores for `yantrad`, Syncthing and `ctx`.

### 5.4 The pass mark

An arm passes only if every line holds:

| Measure | Pass |
| --- | --- |
| macro-F1 on the test set | at least 0.85, and at least 0.10 above the rule |
| `needs_input` recall | at least 0.90 |
| macro-F1 on the held-out repo | no more than 0.05 below the test set |
| p50 latency on the appliance, one question | under 150 ms |
| p95 latency on the appliance | under 400 ms |
| peak RSS on the appliance | under 1.5 GB |

The RSS mark is below the research note's 2 GB because ADR-0032's `ctx` takes up to 985 MB while it
indexes, inside the same 4 GB budget. The call runs once per turn end, not once per tool call, so
400 ms at p95 is acceptable here where it would not be for a gate. If no arm passes, Y-468 records
that and closes the subject, and the rule stays.

## 6. Integration sketch

Integration needs an ADR (Y-468), and the build loop parks that row. The sketch below is the
proposal that ADR starts from, not a decision.

- **One seam.** A narrow trait over the `/v1/systemone` request and response, in the style of the
  four seams in CLAUDE.md §B2, with a fake for the layers above:

  ```rust
  pub trait Decide {
      async fn decide(&self, req: &SystemOneRequest) -> Result<SystemOneResponse, DecideError>;
  }
  ```

  `SystemOneRequest` and `SystemOneResponse` mirror the JSON in §4.1 and §5.2 field for field.
- **Backends.** `LocalLaya`: the INT8 ONNX graph through `ort` and `tokenizers`, with the input and
  output code of `onnx_agent.py` ported and tested against the Python on the same rows. `Jev`: an
  HTTP client, only if the owner's ADR allows it (§5.2). `Fake`: a table, for tests.
- **Where it runs.** In `yantrad`, called after a turn ends, to choose between "Agent finished" and
  "Waiting for input". The model answers a hint. A crisp rule (`AskUserQuestion`, a stop reason)
  overrides it, and a timeout or an error falls back to the rule.
- **What it costs.** `libonnxruntime` on musl for the appliance target, and the RSS that §5.3
  measures. The model file is not in the release archive; Install fetches it once, opt-in, like the
  history archive.

## 7. Risks

- **Labels stay thin.** The owner's habits produce few free labels (§2). Mitigation: the judge,
  and the owner's 200-row audit. If the audit fails twice, close the subject.
- **The judge teaches Laya to copy Claude.** A fine-tuned Laya then only matches a slower judge.
  That is the point if it is fast and local; it is a failure if the rule already matches the judge.
  §5's rule arm shows which.
- **Redaction misses a secret** (R18 §11.3 measured this). The rows never leave the owner's disk
  and the RunPod volume, and §3.3 re-scans them. Delete the RunPod volume after the run.
- **Laya is young and its popularity is abnormal** (research note). Pin the commit and the
  checkpoint revision. Read the training script before it runs on the owner's data.
- **The appliance is too slow or too small.** §5.3 runs early (Y-467 depends only on this plan),
  so the subject closes before a GPU hour is spent.
- **A drift.** The Claude Code transcript format changes. The extractor's fixture tests pin the
  shapes it reads.

## 8. Questions for the owner

- **Q23.** Which decision first? This plan proposes session state (§2.1). May a Claude judge label
  it, with your 200-row audit as the check? Will you run the Chat in Supervised mode, so that tool
  permission gains labels?
  **Answered 2026-10-12: yes.** Session state first, labelled by a Claude judge and audited by the
  owner. Supervised mode is not promised, so tool permission stays a candidate.
- **Q24.** May redacted eval rows go to TypeSafe for a Jev baseline (§5.2)? The plan's default is no.
  **Answered 2026-10-12: yes**, offline and opt-in, on redacted rows only.
- **The appliance.** Which box runs Y-467? **Answered by Q15 (Y-460):** the HP EliteDesk 800 G5 Mini,
  i5-9500T.

## Sources

All accessed 2026-10-12.

- Laya repository at commit `c73908d`: <https://github.com/NandhaKishorM/laya>
- Laya fine-tuning guide: <https://raw.githubusercontent.com/NandhaKishorM/laya/HEAD/docs/finetune.md>
- Laya browser-agent fine-tune: <https://raw.githubusercontent.com/NandhaKishorM/laya/HEAD/docs/finetune_browser_agent.md>
- Laya HTTP API: <https://raw.githubusercontent.com/NandhaKishorM/laya/HEAD/docs/http-api.md>
- Laya ONNX agent and its INT8 warning: <https://raw.githubusercontent.com/NandhaKishorM/laya/HEAD/docs/reference/agent.md>
- Laya trainer: <https://raw.githubusercontent.com/NandhaKishorM/laya/HEAD/laya/train.py>,
  <https://raw.githubusercontent.com/NandhaKishorM/laya/HEAD/laya/train_cli.py>
- Laya ONNX code: <https://raw.githubusercontent.com/NandhaKishorM/laya/HEAD/laya/onnx_agent.py>,
  <https://raw.githubusercontent.com/NandhaKishorM/laya/HEAD/scripts/export_onnx.py>
- `laya-typed-decisions` model card: <https://huggingface.co/convaiinnovations/laya-typed-decisions>
- The typed-decisions dataset: <https://datasets-server.huggingface.co/first-rows?dataset=LocalLLaMA/typed-decisions&config=all&split=train>
- Jev API: <https://docs.typesafe.ai/api.md>
- Jev models, prices and limits: <https://docs.typesafe.ai/models.md>
- TypeSafe legal and data processing: <https://docs.typesafe.ai/legal.md>, <https://typesafe.ai/legal/data-processing>
- RunPod prices: <https://www.runpod.io/pricing>
- `runpodctl pod`: <https://docs.runpod.io/runpodctl/reference/runpodctl-pod.md>
- Connecting to a pod: <https://docs.runpod.io/pods/connect-to-a-pod.md>
- RunPod serverless: <https://docs.runpod.io/serverless/overview.md>
- The owner's research note, Journal *Project reports*, "Yantra: Laya and Android over Tailscale (2026-10-12)".
- The transcript scan in §2: `~/.claude/projects` on the owner's Linux box, 2026-10-12. Counts only;
  no transcript text left the machine or entered this plan.
- Yantra: [ADR-0032](../adr/0032-the-appliance-keeps-the-conversation-history-encrypted.md),
  `crates/yantra-core/src/history.rs`, `crates/yantra-core/src/claude.rs`,
  `crates/yantra-core/src/notify.rs`, `crates/yantra-core/src/status.rs`, `crates/yantra/src/mcp.rs`.
