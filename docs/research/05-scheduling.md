# 05 — Scheduling and Placement

Research note for YANTRA. All docs retrieved 2026-07-28. Day 0, no code exists.

## Summary

- Every serious scheduler is the same shape: **hard filter → soft score → pick max**. Steal the shape, nothing else. The
  distinction that matters: **constraint (binary, filters) vs affinity (weighted, scores)** — Yantra's `requires:` /
  `prefer:` split falls straight out of it.
- **Bin-packing is the wrong objective.** Nomad and K8s pack to raise density and cut cost; Yantra's machines are already
  bought and idle. The goal is *fast session, don't kill a battery*.
- CI systems are the right-sized prior art: **set-containment label matching, AND semantics, no scoring**. Yantra needs
  that plus a small score to break ties among the 2-4 survivors.
- The hard part is not the algorithm (~100 lines) but **telemetry freshness and explainability**: a push-heartbeat agent
  and a persisted decision record, not a framework.

## Prior art findings

### HashiCorp Nomad

Pipeline: evaluation → reconciliation → **feasibility checking** → **ranking** → plan submission to the leader's plan
queue. Feasibility removes wrong datacenter/node pool, unhealthy nodes, nodes missing required task drivers, and nodes
failing `constraint` — binary, no partial credit.


- **`constraint`** = `attribute` / `operator` / `value`; operators `=`, `!=`, `<`…`>=`, `regexp`, `set_contains{,_any}`,
  `version`, `semver`, `is_set`, `is_not_set`, `distinct_hosts`, `distinct_property`. Attributes are interpolated node
  facts: `${attr.kernel.name}`, `${attr.driver.docker.available}`, `${node.class}`, `${meta.*}` — and `node.class` is
  just an operator-assigned free-text bucket, a label with a worse name. **[steal the grammar, not the operators]**
- **`affinity`** = same grammar plus `weight` **-100..100** (default 50), negative = anti-affinity; soft, never makes a
  node infeasible. **[steal: signed integer weights, no DSL]**
- **`spread`** = `attribute` + `target`/`percent` + `weight` 0..100, scoring distance from a target distribution; docs
  stress it is *not* the cluster-wide `SchedulerAlgorithm` (`binpack` default / `spread`). **[skip both]**
- **Scoring** = best-fit bin-packing "influenced by Google's work on Borg", plus `job-anti-affinity` and
  `node-reschedule-penalty` (avoid a node where this alloc previously failed). Per-scorer outputs are **averaged into a
  normalized final score**, with the breakdown exposed in `nomad alloc status -verbose`. **[steal: the reschedule
  penalty, and above all publishing the per-scorer breakdown, not just the winner. Skip: bin-packing, plan queue,
  evaluation broker, node pools.]**

### Kubernetes kube-scheduler

**Filter** (was: predicates) → **Score** (was: priorities) → **Bind**. Survivors are "feasible"; an empty set leaves the
Pod `Pending` forever — no fallback, no partial placement. The Scheduling Framework exposes 14 extension points
(`queueSort`, `preFilter`, `filter`, `postFilter`, `score`, …) **[skip: framework, profiles, preemption, topo spread]**.

- Each score plugin returns **0..100** per node; the framework normalizes, multiplies by the plugin's weight, and sums.
  Default weights: `TaintToleration` **3**; `NodeAffinity`, `InterPodAffinity`, `PodTopologySpread` **2**;
  `ImageLocality`, `NodeResourcesFit`, `NodeResourcesBalancedAllocation` **1**. **[steal normalize→weight→sum]**
- **Ties are broken at random**, deliberately, to spread load. **[skip: reproducibility beats fairness at n≤8]**
- **`nodeSelector`**: exact label map, AND, hard. **`nodeAffinity`**: `required…` (hard, filters) vs `preferred…` (soft,
  scores), `weight` **1..100**, operators `In`/`NotIn`/`Exists`/`Gt`/`Lt`; both must pass if both set. **`nodeName`**
  bypasses the scheduler. **[steal: hard-vs-soft as one predicate with two dispositions; `nodeName` as manual override]**
- **Taints/tolerations** invert the polarity — the *node* repels, the workload opts in. Effects `NoSchedule`,
  `PreferNoSchedule`, `NoExecute`; v1.35 adds numeric `Gt`/`Lt` operators. **[steal as machine-side opt-out: "this Pi is
  mine — don't auto-place unless the workspace `tolerates: [personal]`"]**

### Docker Swarm and CI systems — the right-sized answer

- **Swarm**: `--constraint` with only `==` / `!=`, ANDed, over `node.{id,hostname,role}`, `node.platform.{os,arch}`,
  `node.labels.*`, `engine.labels.*`; `--placement-pref 'spread=node.labels.datacenter'` is the *only* strategy. No
  weights, no knobs — Swarm proves you can ship placement with **no score function at all**.
- **GitHub Actions**: `runs-on: [self-hosted, linux, x64, gpu]` — a runner must carry **all** labels (AND /
  set-containment). Default labels auto-applied (`self-hosted`, OS, arch), suppressible with `--no-default-labels`.
  **No scoring** — first online idle match wins; no match ⇒ queued, **failing after 24h**; unclaimed 60s ⇒ re-queued.
- **Buildkite**: agents start with `--tags "queue=linux-medium-x86"`; steps target `agents: {queue: …}` at pipeline root,
  overridable per step. Within a queue: "the first available agent, ordered by how recently an agent successfully
  completed a job" — **LRU-ish, not scored**.

**[steal]** label AND-matching + an ordered preference list covers ~90% of Yantra's cases, the score handles the rest;
plus **auto-derived default labels** — never hand-write `os: linux`.

## Proposed Yantra placement algorithm (v1)

### Declaration language

Machine facts (os, arch, cpus, ram_total, gpu, hostname, mac) are **auto-derived by the agent**; only labels a machine
cannot know about are hand-written. All three modes are one code path: **manual** = filters only, no score; **preferred**
= `prefer` is authoritative, the score only ordering within the list before falling back to unlisted feasible machines;
**auto** = full score.

```yaml
# machines.yaml — `priority` is the static tie-break rank
zenith: { os: linux, arch: x86_64, labels: [gpu, cuda, docker], mac: "aa:bb:…", priority: 30 }
pi5:    { os: linux, arch: arm64,  labels: [docker, lowpower], taints: [personal], priority: 0 }
# --- workspace.yaml ---
placement:
  mode: auto                                       # manual | preferred | auto
  pin: zenith                                      # manual mode only
  requires: { os: linux, labels: [gpu, docker],    # labels: ALL present (AND, set containment)
              ram_gb: 8, disk_gb: 20 }             # ram_gb is FREE, not total
  prefer: [zenith, mba]                            # ordered; machine names or labels
  avoid: [pi5]                                     # soft penalty, not a filter
  tolerates: []                                    # machine taints this workspace may ignore
```

### Hard filters (ordered; the first failure is the recorded reason)

1. `enrolled && !drain` (not in maintenance).
2. **Reachable**: heartbeat age ≤ 30s. Asleep-but-WoL-capable ⇒ *deferred-feasible* (kept, penalised).
3. `requires.os` / `requires.arch` match, if set.
4. `requires.labels ⊆ machine.labels` (the GitHub Actions rule), and `machine.taints − workspace.tolerates == ∅`.
5. `free_ram_gb ≥ requires.ram_gb` (measured, not total) and `free_disk_gb ≥ requires.disk_gb`.

Before filtering: if the workspace already has a **live session** somewhere, return that machine (`reason: "existing
session"`). Placement runs only for cold starts — "already running here" is a short-circuit, not a predicate, and is what
makes `yantra up X` twice idempotent.

### Scoring

Each signal normalized to `0.0..1.0` × a weight; weights sum to 100, so the score reads as a percentage. They live in
`config.yaml` and are echoed into every decision record, so tuning stays visible.

| signal | weight | formula |
|---|---:|---|
| preference rank | 30 | `prefer` length n, index i ⇒ `(n − i)/n`; unlisted ⇒ 0 |
| session affinity | 20 | 1.0 if this machine ran the workspace within 7 days, else 0 |
| free RAM headroom | 20 | `clamp((free_gb − requires.ram_gb) / 16, 0, 1)` |
| CPU idle | 15 | `clamp(1 − cpu_busy_pct/100, 0, 1)` |
| power state | 10 | AC 1.0; battery >60% 0.5; 20-60% 0.2; ≤20% 0.0 |
| optional capability match | 5 | fraction of `prefer_labels` present |
| **penalties** (flat, additive) | — | asleep/needs-WoL −15; in `avoid` −25; failed to start here in last 1h −20 (Nomad's reschedule penalty) |

### Pseudocode (TypeScript, per ADR-0003)

```ts
const ALGO_VERSION = 1;

export function place(ws: Workspace, machines: Machine[], facts: FactMap, hist: History, now: number): Decision {
  const rec = new Decision(ws.name, ws.mode, now, ALGO_VERSION, WEIGHTS);
  const live = hist.liveSession(ws);                           // idempotency short-circuit
  if (live) return rec.decide(live.machine, "existing session");
  if (ws.mode === "manual") return manualPin(rec, ws, facts);  // k8s `nodeName` analogue

  const feasible: Machine[] = [];
  for (const m of [...machines].sort(byName)) {                // sorted => deterministic
    const why = firstFailedFilter(ws, m, facts[m.name]);       // first failure, or null
    why ? rec.reject(m, why) : feasible.push(m);
  }
  if (!feasible.length) return rec.fail(histogram(rec.rejections));

  for (const m of feasible) {
    const s = signals(ws, m, facts[m.name], hist, now);       // each 0..1
    rec.candidate(m, round1(sum(keys(s).map(k => WEIGHTS[k] * s[k]))
                            + penalties(ws, m, facts[m.name], hist)), s);
  }
  // deterministic ranking: score desc, static priority desc, name asc
  const best = rec.candidates.sort(by(c => -c.score, c => -c.machine.priority, c => c.machine.name))[0];
  rec.margin = best.score - (rec.candidates[1]?.score ?? 0);

  if (facts[best.machine.name].asleep && !wakeAndWait(best.machine, 90_000)) {
    rec.action("wol_failed", best.machine);                    // retry once, without it
    return place(ws, machines.filter(m => m !== best.machine), facts, hist, now);
  }
  return rec.decide(best.machine, "highest score");
}
```

**Determinism.** The score is a pure function of `(spec, facts snapshot, history, weights, ALGO_VERSION)` — no
randomness, explicitly rejecting kube-scheduler's random tie-break. Scores round to 1 decimal *before* comparison so
float noise cannot reorder runs; the facts snapshot is in the record, so `yantra explain --replay <id>` replays exactly.

**Failure modes.** *No feasible machine*: fail fast, never queue — print the rejection histogram plus the closest miss,
exit non-zero. *Offline or facts stale >30s*: never feasible (filter 2); better to under-place than place onto a dead
box. *All feasible asleep*: WoL the best-scoring one, poll heartbeat 90s, then retry once excluding it — no `mac` means
never wakeable. *Dies mid-session*: v1 reports and stops, **no auto-migration or rescheduling loop**. *User override*
(`yantra up X --on pi5`): filters only; failure refuses, `--force` proceeds and records `overridden_filters`.

## Telemetry requirements

A small agent per machine **pushes** a JSON heartbeat to `yantrad` every **10s**. Push, not poll: it handles NAT, roaming
laptops and sleep for free — absence of a heartbeat *is* the offline signal, needing no server-side timeout logic.
Dynamic facts (RAM, CPU, power, disk) every **10s**, stale at **30s**; static facts (os, arch, cpus, ram_total, gpu, MAC,
labels) on agent start and every **15 min**. Rejected: **node_exporter/Prometheus** (a TSDB and scrape config for six
numbers); **Glances** (a Python runtime on a Pi); **SSH polling** (3-8 handshakes per placement ≈ 0.2-0.8s, and blind to
a sleeping laptop — precisely the case that matters). **Common currency**: Windows has no load average, so the agent
reports `cpu_busy_pct` (0-100), derived on Linux/macOS as `min(load1/ncpu, 1) × 100`; no battery device ⇒ `ac: true`.

| fact | Linux (verified locally) | macOS | Windows (PowerShell) |
|---|---|---|---|
| free RAM | `awk '/MemAvailable/{print $2}' /proc/meminfo` (kB) | `vm_stat` — (free+inactive+speculative) × `sysctl -n hw.pagesize`; or `memory_pressure \| tail -1` | `(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory` (kB) |
| load / CPU busy | `cut -d' ' -f1-3 /proc/loadavg` | `sysctl -n vm.loadavg` → `{ 1.85 2.01 1.99 }` | `(Get-CimInstance Win32_Processor \| Measure-Object LoadPercentage -Average).Average` |
| total RAM / cores | `/proc/meminfo` `MemTotal`; `nproc` | `sysctl -n hw.memsize` (bytes); `sysctl -n hw.ncpu` | `…TotalVisibleMemorySize`; `(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors` |
| on AC | `cat /sys/class/power_supply/AC*/online` → `1` | `pmset -g batt` → `Now drawing from 'AC Power'` | `(Get-CimInstance Win32_Battery).BatteryStatus` → `2` = AC |
| battery % | `cat /sys/class/power_supply/BAT0/capacity` | `pmset -g batt` → `95%; discharging` | `(Get-CimInstance Win32_Battery).EstimatedChargeRemaining` |
| GPU | `nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader`; fallback `lspci \| grep -iE 'vga\|3d'` | `system_profiler SPDisplaysDataType -json` | `Get-CimInstance Win32_VideoController \| Select Name,AdapterRAM`; NVIDIA: same `nvidia-smi` |
| free disk | `df -B1 --output=avail /` | `df -k /` | `(Get-PSDrive C).Free` |
| WoL ready | `ethtool <if> \| grep Wake-on` → `g` | `pmset -g \| grep womp` → `1` | `powercfg /devicequery wake_armed` |
Linux column executed here (kernel 7.1.3, CachyOS): `MemAvailable`, `/proc/loadavg`, `nproc`→12, `AC0/online`→1,
`BAT0/capacity`→100, `nvidia-smi`→`GeForce GTX 1650 Ti, 4096 MiB, 8 MiB, 0 %`. **Negative findings:** desktops have *no*
`AC*` entry at all, and `BAT0/status` read `Not charging` while plugged in — treat a missing power_supply device as `ac:
true` and never infer AC from `status`. `pmset -g batt` on a desktop Mac prints only the `AC Power` line; Apple Silicon
has no `nvidia-smi` equivalent, so `gpu` there is a static label, not a measurement. `Win32_Battery` returns **no
instances** on Windows desktops — absence means AC, not unknown.

## Placement decision record

One append-only JSON row per attempt (success *and* failure) in `bun:sqlite`, keyed by ULID; surfaced by
`yantra explain <ws>` and `yantra plan <ws>` (dry run, à la `nomad plan`).

```json
{ "id":"plc_01K3F2Q8", "ts":"2026-07-28T18:30:00Z", "algo_version":1, "workspace":"yantra-api", "mode":"auto",
  "chosen":"zenith", "reason":"highest score", "runner_up":"mba", "margin":12.4,
  "weights":{"pref":30,"affinity":20,"ram":20,"cpu":15,"power":10,"caps":5},
  "candidates":[{"machine":"zenith","score":81.2,"penalties":[],
    "signals":{"pref":1.0,"affinity":1.0,"ram":0.72,"cpu":0.85,"power":1.0,"caps":1.0},
    "contrib":{"pref":30,"affinity":20,"ram":14.4,"cpu":12.8,"power":10,"caps":5}}],
  "rejected":[{"machine":"pi5","filter":"requires.labels","detail":"missing 'gpu'"},
              {"machine":"winbox","filter":"heartbeat","detail":"last seen 412s ago (limit 30s)"}],
  "facts_snapshot_ts":"2026-07-28T18:29:58Z", "actions":["wol:none"],
  "facts":{"zenith":{"free_ram_gb":19.5,"cpu_busy_pct":15,"ac":true,"asleep":false}, "…":{}} }
```

Rendered, the failure line copies kube-scheduler's `FailedScheduling` event (which **aggregates reasons into a
histogram**) and the table copies Nomad's `alloc status -verbose`:

```
0/4 machines available: 1 missing label 'gpu', 1 offline, 1 insufficient RAM (need 8G, free 5.2G), 1 tainted
'personal'.  Closest: zenith (RAM only, short by 2.8G).

MACHINE  SCORE  PREF  AFFIN   RAM   CPU  POWER  CAPS  NOTE
zenith    81.2  30.0   20.0  14.4  12.8   10.0   5.0  <- chosen
mba       68.8  15.0    0.0  16.0  13.0    5.0   5.0
```

The record is the explainability contract: **if a signal is not in the record, it must not influence the decision** —
that rule alone stops the score function growing hidden inputs.

## Explicitly out of scope

State these in the README so future-you does not relitigate them. Target **~100 lines** for `place()` + filters +
signals; past 200, something below crept back in.

- **Preemption / eviction.** Never kick out a running session; score busy machines lower instead. **Live migration /
  auto-reschedule** on node failure: report it, let the user re-run.
- **Queueing / pending backlog.** No feasible machine ⇒ fail immediately (Actions queues 24h because it has thousands of
  jobs; Yantra has one user). **Bin-packing**: it optimises a cost function Yantra does not have; prefer spread, which
  falls out of the CPU-idle term for free.
- **Multi-tenancy** (namespaces, quotas, RBAC, priority classes); **reservations / oversubscription** (just measure free
  RAM at placement time); **autoscaling** (the fleet is a fixed YAML list); **gang scheduling, topology spread,
  `distinct_hosts`** (one session, one machine).
- **A plugin framework or scheduler profiles.** At 8 machines the scheduler is smaller than the interface that would
  abstract it — one file, one function. Likewise **no learned scorer**: ~5 placements a day is no training signal.

## Risks & unknowns

- **Weight tuning is unfalsifiable at n≤8.** With 4 machines `prefer` (30) dominates and the other signals may never flip
  an outcome. Log every decision; after ~50 real placements, check whether any non-preference signal ever changed the
  winner — if not, **delete those signals rather than tune them.**
- **WoL is unreliable in practice**: rarely works over Wi-Fi (Apple Silicon needs a Bonjour Sleep Proxy; Windows needs
  the NIC's "allow this device to wake the computer" *and* fast-startup disabled), and never across subnets without a
  directed broadcast. Tailscale does **not** solve this — it cannot wake a sleeping host. Best-effort only.
- **Sleep/wake flapping.** A laptop can be feasible at filter time and asleep 5s later: re-verify the heartbeat before
  starting the session, and treat "chosen machine vanished" as a one-shot retry.
- **Label drift.** A machine tagged `gpu` whose driver broke still passes the filter — derive capability labels from
  probes (`nvidia-smi` exits 0), re-probed on every agent start.
- **Session affinity may be redundant** — it keeps pulling work back to the last machine even after its state diverged;
  unclear it should be a score term at all, given the live-session short-circuit.
- **`cpu_busy_pct` is not comparable across OSes** (load-average-derived vs `LoadPercentage`); accept the imprecision.
  **Clock skew** corrupts heartbeat-age checks — assume NTP, record both agent- and server-side timestamps.
  **Unverified**: macOS/Windows commands come from vendor docs, not execution — run them on real hardware first.

## Sources

All URLs retrieved **2026-07-28**. Nomad:
[scheduling](https://developer.hashicorp.com/nomad/docs/concepts/scheduling/scheduling) ·
[`constraint`](https://developer.hashicorp.com/nomad/docs/job-specification/constraint) ·
[`affinity`](https://developer.hashicorp.com/nomad/docs/job-specification/affinity) ·
[`spread`](https://developer.hashicorp.com/nomad/docs/job-specification/spread) ·
[operator config](https://developer.hashicorp.com/nomad/api-docs/operator/scheduler). Kubernetes:
[kube-scheduler](https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/) ·
[assign pod to node](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/) ·
[taints](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/) ·
[scheduler config + weights](https://kubernetes.io/docs/reference/scheduling/config/). Others:
[`docker service create`](https://docs.docker.com/reference/cli/docker/service/create/) ·
[Buildkite queues](https://buildkite.com/docs/agent/v3/queues) ·
[`Win32_Battery`](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-battery) ·
[GH runners](https://docs.github.com/en/actions/reference/runners/self-hosted-runners) ·
[GH `runs-on`](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow) ·
Apple man pages `vm_stat(1)`, `pmset(1)`, `sysctl(3)`. Linux column executed locally on kernel 7.1.3 / CachyOS.
