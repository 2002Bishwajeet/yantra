# Third-party notices

Yantra's own code is under the licence in [`LICENSE`](LICENSE). The work below is someone else's, and
its licence asks that this notice travel with it.

## T3 Code

[`crates/yantra-core/src/chat.rs`](crates/yantra-core/src/chat.rs) re-expresses the event vocabulary of
T3 Code's
[`packages/contracts/src/providerRuntime.ts`](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/providerRuntime.ts)
in Rust ([ADR-0026](docs/adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md) decision 5), and
[`web/src/api/thread.ts`](web/src/api/thread.ts) spells the same vocabulary in TypeScript.
[`web/src/screens/session/HarnessPicker.tsx`](web/src/screens/session/HarnessPicker.tsx) copies the
shape of
[`apps/web/src/components/chat/ProviderModelPicker.tsx`](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/ProviderModelPicker.tsx)
onto Yantra's own menu and tokens.
[`crates/yantra-core/src/placement.rs`](crates/yantra-core/src/placement.rs) copies the shape of
[`packages/client-runtime/src/load-balancing.ts`](https://github.com/pingdotgg/t3code/blob/main/packages/client-runtime/src/load-balancing.ts)
at commit `72d5c32`, with Yantra's own score terms.
[`crates/yantra-core/src/notify.rs`](crates/yantra-core/src/notify.rs) copies the activity phases and
headlines of
[`packages/shared/src/agentAwareness.ts`](https://github.com/pingdotgg/t3code/blob/main/packages/shared/src/agentAwareness.ts)
and the failed-run redaction of
[`apps/server/src/relay/AgentAwarenessRelay.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/relay/AgentAwarenessRelay.ts)
at commit `72d5c32`, without the `stale` phase. Its name, wordmark and icon are not used.

[`crates/yantra-core/src/checkpoint.rs`](crates/yantra-core/src/checkpoint.rs) copies the shape of
[`apps/server/src/checkpointing/CheckpointStore.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/checkpointing/CheckpointStore.ts)
and the checkpoint operations of
[`apps/server/src/vcs/GitVcsDriver.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/vcs/GitVcsDriver.ts)
at commit `72d5c32`. Its name, wordmark and icon are not used.

`PermissionMode` in [`crates/yantra-core/src/chat.rs`](crates/yantra-core/src/chat.rs) and
[`web/src/screens/session/ModePicker.tsx`](web/src/screens/session/ModePicker.tsx) copy the four
permission modes, their names and their descriptions from
[`docs/user/permission-modes.md`](https://github.com/pingdotgg/t3code/blob/72d5c32ba67953805feb6fe9ad3b70b632a64c47/docs/user/permission-modes.md)
at commit `72d5c32`. Yantra's default is Supervised, where T3 Code's is Full access.

[`crates/yantra/src/mcp.rs`](crates/yantra/src/mcp.rs) copies the shapes of `steer_task`, `wait_task`
and `cancel_task` from
[`docs/orchestration-v2/orchestrator-mcp-server.md`](https://github.com/pingdotgg/t3code/blob/72d5c32ba67953805feb6fe9ad3b70b632a64c47/docs/orchestration-v2/orchestrator-mcp-server.md)
at commit `72d5c32`: a steer is a cancel and a restart, a wait answers `waitTimedOut`, and a cancel of
an ended task returns its state.

```text
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
