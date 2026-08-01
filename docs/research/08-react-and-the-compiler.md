# 08 — React + React Compiler + Vite: what "latest" actually means today

Research note for Yantra (M4 web UI). Evidence retrieved **2026-08-01**. Every version below was read
from the npm registry or an official doc on that date, and the config was **executed**, not assumed:
a real `npm create vite@latest` scaffold was built with the compiler enabled on this machine
(x86_64 CachyOS, kernel 7.1.3-2, Node v24.0.0, npm 11.3.0). The spike was throwaway and is not
committed — every command below is reproducible from a clean directory.

> **Perishability.** React 19.2.x ships patches roughly monthly (19.2.0 → 19.2.8 between 2025-10-01 and
> 2026-07-21). Vite 8, TypeScript 6/7 and Babel 8 are all *inside a major transition right now*. Treat
> every number here as correct on 2026-08-01 and re-check before pinning. The **structural** findings
> (§ Negative findings) will outlive the numbers.

## Summary

- **React stable is `19.2.8`** (2026-07-21). **React Compiler is stable**: `babel-plugin-react-compiler@1.0.0`,
  published **2025-10-07**, and it is still the only 1.x release almost ten months later.
- **There is no SWC path and no Babel-free path.** The compiler *is* a Babel plugin. `@vitejs/plugin-react-swc`
  does not mention React Compiler anywhere in its README. Using the compiler means running Babel over your
  source, in addition to Vite's Oxc transform.
- **The config every tutorial shows is dead.** `react({ babel: { plugins: [...] } })` was **removed in
  `@vitejs/plugin-react@6.0.0`**. The current wiring is a *separate* `@rolldown/plugin-babel` plugin fed
  `reactCompilerPreset()`.
- **`npm create vite@latest --template react-ts` no longer produces an ESLint config.** It produces
  `.oxlintrc.json` and `"lint": "oxlint"`. There is no `eslint.config.js`, no `eslint` dependency.
- **oxlint has `react/react-compiler`** — a Rust reimplementation of the compiler's diagnostics — and the
  generated `.oxlintrc.json` **does not enable it**. Enabling it is one line and zero new dependencies.
  For a one-page app this is the whole ESLint story; you can skip ESLint entirely.
- **A compiler bail-out is silent.** Default `panicThreshold` is `"none"`. The build succeeds, prints
  nothing, and the component is simply not optimized. Verified by executing the compiler with a `logger`.
- **The official claim that an ESLint error implies a compiler bail-out is false.** Measured
  counter-example below.
- **Node: the real floor is `^22.18 || >=24.11`, not Vite's `^20.19 || >=22.12`.** On Node 24.0.0,
  `npm i -D @babel/core` silently writes `^7.29.7` — Babel **7** — with no warning at all.
- **TypeScript: use 6.0.x, not 7.0.x.** `typescript-eslint@8.65.0` hard-`throw`s on TS 7. The Vite template
  pins `~6.0.2` for exactly this reason.

---

## 1. Versions, exact, as of 2026-08-01

Read from `https://registry.npmjs.org/-/package/<pkg>/dist-tags`.

| Package | `latest` | Note |
| --- | --- | --- |
| `react`, `react-dom` | **19.2.8** | 19.2.0 was 2025-10-01; 19.2.8 was 2026-07-21. `canary` is `19.3.0-canary-*`. |
| `babel-plugin-react-compiler` | **1.0.0** | Stable. Published 2025-10-07. **Only 1.x release to date.** |
| `react-compiler-runtime` | **1.0.0** | Only needed when targeting React 17/18. Not needed here. |
| `eslint-plugin-react-hooks` | **7.1.1** | 2026-04-17. Contains the compiler rules. |
| `eslint-plugin-react-compiler` | `19.1.0-rc.2` | **Superseded.** Never reached stable; not formally deprecated on npm either. Do not install. |
| `eslint` | 10.8.0 | |
| `vite` | **8.2.0** | Rolldown-powered. |
| `@vitejs/plugin-react` | **6.0.5** | `peerDependencies: { vite: "^8.0.0" }`. |
| `@vitejs/plugin-react-swc` | 4.3.3 | Supports vite `^4 \|\| ^5 \|\| ^6 \|\| ^7 \|\| ^8`. **No compiler support.** |
| `@rolldown/plugin-babel` | **0.2.3** | `engines: { node: ">=22.12.0 \|\| ^24.0.0" }`. |
| `@babel/core` | 8.0.1 | Babel 8.0.0 shipped 2026-06-16. See §6 — you will probably not get this. |
| `create-vite` | 9.1.2 | |
| `typescript` | 7.0.2 | **But use 6.0.x.** See §7. |
| `oxlint` | 1.76.0 | |
| `@types/react` / `@types/react-dom` | 19.2.18 / 19.2.4 | |
| `@xterm/xterm` (M6) | 6.0.0 | 2025-12-22. Note the scope: `xterm@5.3.0` is the dead unscoped package. |

**Is React Compiler stable, RC, or beta?** Stable. `babel-plugin-react-compiler@1.0.0`, announced in
*React Compiler v1.0* on react.dev, 2025-10-07. The `beta` (`19.0.0-beta-af1b7da-20250417`) and `rc`
(`19.1.0-rc.3`) dist-tags still exist and are **older than `latest`** — reading dist-tags carelessly will
hand you a 2025 pre-release. Install with `@latest` or an explicit `^1.0.0`.

---

## 2. How the compiler is actually wired in 2026

**Verbatim from `react.dev/learn/react-compiler/installation` (raw source, fetched 2026-08-01):**

> ### Vite
>
> If you use Vite with version 6.0.0 or later of `@vitejs/plugin-react`, you can use the `reactCompilerPreset`:
>
> ```
> npm install -D @rolldown/plugin-babel
> ```
>
> ```js
> // vite.config.js
> import { defineConfig } from 'vite';
> import react, { reactCompilerPreset } from '@vitejs/plugin-react';
> import babel from '@rolldown/plugin-babel';
>
> export default defineConfig({
>   plugins: [
>     react(),
>     babel({
>       presets: [reactCompilerPreset()]
>     }),
>   ],
> });
> ```
>
> **Note:** In `@vitejs/plugin-react@6.0.0`, the inline Babel option was removed.

The plugin's own README gives the complete install line, which the react.dev page does **not**:

```sh
npm install -D @rolldown/plugin-babel @babel/core babel-plugin-react-compiler
npm install -D @types/babel__core   # required if you use TypeScript
```

`@types/babel__core` is not optional in the Vite template: `tsconfig.node.json` includes `vite.config.ts`
and `npm run build` runs `tsc -b` over it, and `@vitejs/plugin-react`'s `.d.ts` imports its compiler-preset
types from `#optionalTypes`.

### Is there a Vite path that does not require Babel?

**No.** Three independent confirmations:

1. React Compiler ships only as a Babel plugin (`babel-plugin-react-compiler`); react.dev lists Babel,
   Vite-via-Babel, Next.js, React Router-via-Babel, a community *webpack loader*, Expo, Metro, Rspack,
   Rsbuild. Every entry routes through Babel.
2. `@vitejs/plugin-react-swc`'s README (fetched raw, 2026-08-01) contains **zero occurrences of the string
   "compiler"**. There is no SWC React Compiler plugin in its option surface.
3. `reactCompilerPreset` is literally a thin wrapper that points Babel at the plugin. From
   `node_modules/@vitejs/plugin-react/dist/index.js`:

```js
const defaultCodeFilter = /forwardRef|memo|\b(?:[A-Z]|use[A-Z0-9])/;
const reactCompilerPreset = (options = {}) => ({
  preset: () => ({ plugins: [[fileURLToPath(import.meta.resolve("babel-plugin-react-compiler")), options]] }),
  rolldown: {
    filter: { code: options.compilationMode === "annotation" ? /['"]use memo['"]/ : defaultCodeFilter },
    applyToEnvironmentHook: (env) => env.config.consumer === "client",
    optimizeDeps: { include: options.target === "17" || options.target === "18"
      ? ["react-compiler-runtime"] : ["react/compiler-runtime"] }
  }
});
```

So: `@vitejs/plugin-react` (Oxc, fast) does JSX + Fast Refresh; `@rolldown/plugin-babel` runs Babel a
second time over only the files whose **text** matches `defaultCodeFilter`. Client environment only.
`reactCompilerPreset(opts)` forwards `opts` straight to the Babel plugin, so any compiler option
(`compilationMode`, `target`, `panicThreshold`, `logger`, `gating`) is settable there.

### Verified-working configuration

This exact set was scaffolded, installed and built successfully (`✓ built in 434ms`), and the output
contains the compiler's memoization markers.

```bash
npm create vite@latest yantra-web -- --template react-ts
cd yantra-web
npm install
npm install -D @rolldown/plugin-babel @babel/core babel-plugin-react-compiler @types/babel__core
```

`vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
})
```

`package.json` (as generated, plus the four compiler devDeps; resolved versions from the spike):

```json
{
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "oxlint",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.2.8",
    "react-dom": "^19.2.8"
  },
  "devDependencies": {
    "@babel/core": "^8.0.1",
    "@rolldown/plugin-babel": "^0.2.3",
    "@types/babel__core": "^7.20.5",
    "@types/node": "^24.13.3",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.5",
    "babel-plugin-react-compiler": "^1.0.0",
    "oxlint": "^1.75.0",
    "typescript": "~6.0.3",
    "vite": "^8.2.0"
  }
}
```

`@babel/core` is written as `^8.0.1` **deliberately** — see §6; left to itself npm writes `^7.29.7` on
this machine.

---

## 3. Negative findings — this does not work the way everyone assumes

### 3a. `react({ babel: { plugins: [...] } })` no longer exists

Removed in `@vitejs/plugin-react@6.0.0`, stated in the react.dev Note quoted above and confirmed against
the shipped `index.d.ts`: the `Options` interface has only `include`, `exclude`, `jsxImportSource`,
`jsxRuntime`, `reactRefreshHost`. **Every blog post, StackOverflow answer and LLM memory from 2024–2025
shows the removed form.** It will not error usefully — it is an unknown property on a typed options object.

### 3b. An ESLint error does **not** mean the compiler bailed out

react.dev, verbatim: *"When the ESLint rule reports an error, it means the compiler will skip optimizing
that specific component or hook."*

**Measured counter-example.** `src/Edge.tsx`:

```tsx
export function SyncSetInEffect() {
  const [n, setN] = useState(0)
  useEffect(() => { setN(1) }, [])
  return <div>{n}</div>
}
```

- ESLint with `reactHooks.configs.flat.recommended` → **`error react-hooks/set-state-in-effect`**.
- Running `babel-plugin-react-compiler` over the same file with a `logger` → **`CompileSuccess`**, and the
  emitted code contains `_c(...)` memo caches.

So `set-state-in-effect` is a *code-quality* rule that does not gate compilation. Conversely
`set-state-in-render` **does** bail. The two categories are not distinguished anywhere in the preset.
**Consequence: you cannot use "ESLint is clean" as a proxy for "everything got optimized."**

### 3c. Bail-outs are silent by default

Default `panicThreshold` is `"none"` and default `compilationMode` is `"infer"` — read directly out of
`node_modules/babel-plugin-react-compiler/dist/index.js` (`panicThreshold: "none"`, `compilationMode: "infer"`
in the defaults object). A component the compiler cannot handle is emitted **byte-identical to its input**,
the build exits 0, and nothing is printed.

Demonstrated. Input:

```jsx
export function SetStateInRender() {
  const [n, setN] = useState(0)
  setN(n + 1)
  return <div>{n}</div>
}
```

Logger events: `CompileSuccess`, **`CompileError` (category `RenderSetState`)**, `CompileSuccess`.
Emitted output for that one function — note the complete absence of `_c`:

```js
export function SetStateInRender() {
  const [n, setN] = useState(0);
  setN(n + 1);
  return <div>{n}</div>;
}
```

while its neighbours got `const $ = _c(6);` and full memo caches.

### 3d. Mutating props was flagged by nothing

```jsx
export function MutatesProps(props) {
  props.items.push('mutated')
  return <div>{props.items.length}</div>
}
```

- `eslint-plugin-react-hooks@7.1.1` `recommended` (which includes `react-hooks/immutability`): **no diagnostic**.
- `oxlint` `react/react-compiler`: **no diagnostic**.
- The compiler: `CompileSuccess` — it memoized the component, keyed on `props.items.length`, the very value
  being mutated.

One sample, so do not generalise the rule's coverage from it. But it disproves the folk belief that "the
compiler / the lint rules will catch you if you mutate." **They did not.**

### 3e. The default Vite React template no longer ships ESLint

`npm create vite@latest app -- --template react-ts` (create-vite 9.1.2) generates:

```
.gitignore  .oxlintrc.json  index.html  package.json  public/  README.md
src/{App.css,App.tsx,index.css,main.tsx,assets/}  tsconfig.json  tsconfig.app.json
tsconfig.node.json  vite.config.ts
```

No `eslint.config.js`. `"lint": "oxlint"`. `.oxlintrc.json` as generated:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

This config reports **no compiler diagnostics at all** until you add the rule in §4.

### 3f. `tsconfig.app.json` has no `"strict": true` — and is still strict

TypeScript 6.0 flipped `strict` to default `true`. Probed directly: a file with `function probe(x?: string) { return x.length }` fails `tsc -b` with
`error TS18048: 'x' is possibly 'undefined'`. Do not "fix" the missing flag; do not copy an old tsconfig
that sets `"strict": false` implicitly by omission-from-a-5.x-era template.

---

## 4. The ESLint story

**The plugin is `eslint-plugin-react-hooks`. `eslint-plugin-react-compiler` is dead** — stuck at
`19.1.0-rc.2`, never stable, folded into `eslint-plugin-react-hooks` at **v6.0.0** (2025-04-21) and shipped
in the `recommended` preset from **v7.0.0** (2025-10-08).

**react.dev is out of date on this point.** It says *"The compiler rules are available in the
`recommended-latest` preset."* Dumped from the installed 7.1.1 package, `recommended` **already contains
every compiler rule**; `recommended-latest` differs by exactly one added rule:

```
recommended        : rules-of-hooks, exhaustive-deps, static-components, use-memo,
                     preserve-manual-memoization, incompatible-library, immutability, globals,
                     refs, set-state-in-effect, error-boundaries, purity, set-state-in-render,
                     unsupported-syntax, config, gating          (16 rules)
recommended-latest : the above + void-use-memo                  (17 rules)
```

(Cosmetic bug worth knowing: the package reports `meta.version === "7.0.0"` while the installed version is
7.1.1.)

### Two viable paths — pick the second

**Path A — full ESLint.** Officially blessed, and it cost four extra dependencies and two config bugs in
the spike:

- `reactHooks.configs.flat.recommended` has **no `files` key**, so on ESLint 10 `npx eslint src/` fails with
  *"all of the files matching the glob pattern src/ are ignored"*. You must wrap it in a config entry with
  `files: ['**/*.{ts,tsx}']`.
- `import js from '@eslint/js'` fails with `ERR_MODULE_NOT_FOUND` — ESLint 10 does not expose it; install
  `@eslint/js` explicitly.
- `typescript-eslint@8.65.0` pins you to TypeScript 6 (§7).

Working config, if you go this way:

```js
// eslint.config.js
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat.recommended],
  },
])
```

```sh
npm install -D eslint @eslint/js eslint-plugin-react-hooks typescript-eslint
```

**Path B — oxlint only. Recommended for Yantra.** oxlint 1.76.0 ships `react/react-compiler`, described by
the Oxc docs as running *"the React Compiler's analysis in lint-only mode"* and surfacing *"the same
diagnostics as `eslint-plugin-react-compiler`"*. It is **category `nursery`**, so not on by default. Add
one line to the generated `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }],
    "react/react-compiler": "error"
  }
}
```

Measured side by side on the same two files:

| File / line | ESLint `recommended` | oxlint `react/react-compiler` |
| --- | --- | --- |
| `Bad.tsx:10` setState in render | `set-state-in-render` | `RenderSetState` |
| `Edge.tsx:5` setState in effect | `set-state-in-effect` | `EffectSetState` |
| `Edge.tsx:11` derived state in effect | `set-state-in-effect` | `EffectSetState` **+ `EffectDerivationsOfState`** |
| `Bad.tsx:4` prop mutation | *nothing* | *nothing* |

oxlint found strictly more here, with **zero added dependencies**, no `@babel/*` in the lint path, and it
does not drag in `typescript-eslint`, which is what would block TypeScript 7 later. For a one-page,
four-table app this is the §B4 "smallest thing that runs" answer. Note the rule is `nursery` — that is a
real caveat, and it is why Path A is documented above as the fallback.

---

## 5. Verifying the compiler actually optimized something

Three mechanisms, in increasing order of usefulness for CI.

1. **React DevTools badge** (official). react.dev: *"Components optimized by React Compiler will show a
   'Memo ✨' badge in React DevTools."* Manual, dev-mode, per-component. **Not verified here** — no browser
   session was run.
2. **Grep the build output** (official, and cheap). Compiled components import
   `{ c as _c } from "react/compiler-runtime"` and guard on
   `Symbol.for("react.memo_cache_sentinel")`. In the spike, `dist/assets/index-*.js` contained
   **2** occurrences of `react.memo_cache_sentinel`. A CI smoke check is one line:

   ```sh
   grep -q 'react.memo_cache_sentinel' dist/assets/*.js || { echo "React Compiler did not run"; exit 1; }
   ```

   This proves the compiler *ran*. It does not prove any particular component was optimized.
3. **The `logger` option** — the only way to enumerate bail-outs. Pass it through the preset:

   ```ts
   babel({ presets: [reactCompilerPreset({
     logger: { logEvent: (filename, event) => { if (event.kind !== 'CompileSuccess') console.warn(filename, event.kind, event.detail?.options?.category) } },
   })] })
   ```

   Event kinds observed: `CompileSuccess`, `CompileError` (with `detail.options.category`, e.g.
   `RenderSetState`). Setting `panicThreshold: 'all_errors'` turns bail-outs into build failures; react.dev
   recommends `'none'` for production, so use `'all_errors'` only in a dedicated CI check, if at all.

   oxlint's rule also accepts `{ "reportAllBailouts": true }`. Enabled in the spike it produced **no
   additional diagnostics** over the default — **unverified** what, if anything, it adds in a larger codebase.

---

## 6. Node — and a resolution trap that changes your lockfile

| Component | Declared `engines` |
| --- | --- |
| `vite@8.2.0` | `^20.19.0 \|\| >=22.12.0` |
| `@vitejs/plugin-react@6.0.5` | `^20.19.0 \|\| >=22.12.0` |
| `create-vite@9.1.2` | `^20.19.0 \|\| >=22.12.0` |
| `@rolldown/plugin-babel@0.2.3` | `>=22.12.0 \|\| ^24.0.0` — **Node 20 excluded** |
| `@babel/core@8.0.1` | `^22.18.0 \|\| >=24.11.0` |
| `eslint@10.8.0` | `^20.19.0 \|\| ^22.13.0 \|\| >=24` |

**Effective floor for this stack: Node `^22.18.0 || >=24.11.0`.** Vite's advertised `>=20.19` is not the
binding constraint once the compiler is wired in.

### The trap, reproduced from a clean cache

On this machine (Node **v24.0.0**, which satisfies none of Babel 8's ranges):

```
$ npm init -y && npm install -D @babel/core
added 39 packages ...
$ node -p "require('./package.json').devDependencies"
{ '@babel/core': '^7.29.7' }
```

**`npm install -D @babel/core` silently installed Babel 7, and printed no warning.** npm's version
selection skipped `8.0.0` and `8.0.1` because their `engines` exclude Node 24.0.0, and fell back to
`7.29.7` (`engines: >=6.9.0`). Only forcing the version reveals the cause:

```
$ npm install -D @babel/core@8.0.1
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@babel/core@8.0.1',
npm warn EBADENGINE   required: { node: '^22.18.0 || >=24.11.0' },
npm warn EBADENGINE   current: { node: 'v24.0.0', npm: '11.3.0' }
npm warn EBADENGINE }
```

Running the react.dev install line alongside Vite produced a *third* answer: **`@babel/core@8.0.0-rc.4`**
(engines `^20.19.0 || >=22.12.0`) — a release candidate, chosen because `@rolldown/plugin-babel`'s peer
range is `^7.29.0 || ^8.0.0-rc.1`. Reproduced with a fresh `--cache` directory, so it is not a stale-metadata
artefact.

**So the Babel major you get depends on which Node the developer happened to be running.** Three different
Node versions produce three different lockfiles from the same command.

Good news: **it does not break.** The spike built identically under `@babel/core@7.29.7`, `8.0.0-rc.4` and
`8.0.1` — same bundle, same hash, same 2 `memo_cache_sentinel` hits. This is a reproducibility problem, not
a correctness one. Mitigations: commit `package-lock.json`, pin `@babel/core` explicitly, and pin Node.

### CI on `ubuntu-24.04`

The GitHub Actions `ubuntu-24.04` image ships **Node.js 22.23.1** by default (npm 10.9.8), with **24.18.0**
also in the tool cache. Node 22.23.1 satisfies `^22.18.0`, so CI gets **Babel 8** while an Arch box on Node
24.0.0 gets Babel 7. Set the version explicitly:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: '24.18.1'   # current v24 LTS "Krypton", 2026-07-28
    cache: npm
```

Node 20 "Iron" is at v20.20.2 (2026-03-24) and is excluded by `@rolldown/plugin-babel` — do not target it.

### Y-073 (must not entangle the Rust jobs)

Nothing in this stack touches Cargo, and nothing in Cargo touches this. The web build is
`npm ci && npm run build` in the UI directory; `fmt`/`clippy`/`test` and the `aarch64-unknown-linux-musl`
`cargo-zigbuild` cross-build need no Node at all. Two things to watch:

- **`npm run build` is `tsc -b && vite build`** — the type-check is inside the build script. If you also
  want a standalone `typecheck` job, keep the split explicit rather than letting the Rust job discover it.
- **If `yantrad` ends up serving the built UI via `rust-embed`/`include_dir`, the Rust build acquires a
  Node dependency by the back door**, including in the musl cross-build. Keep the artifact handoff a CI
  step (build UI → upload artifact → download into the packaging job), not a `build.rs` that shells out to
  `npm`. This is the one decision that can violate Y-073, and it is not a JS-toolchain decision.

---

## 7. TypeScript: use 6, not 7

`typescript@latest` is **7.0.2** — the Go/native port. The Vite template pins **`~6.0.2`**. That pin is not
laziness:

```
$ npm install -D typescript@7 && npx eslint src/Poll.tsx
typescript-eslint does not support TS 7.0.
Please see .../announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0
See also https://github.com/typescript-eslint/typescript-eslint/issues/10940
Error: typescript-eslint does not support TS 7.0.
```

`tsc -b` itself worked fine under 7.0.2 (exit 0) on the template's config. It is only `typescript-eslint`
that hard-fails. So:

- **Path B (oxlint only) is not blocked by TS 7** — worth knowing, though staying on TS 6.0.x matches the
  template and is the boring choice.
- **Path A (ESLint) forces TypeScript 6.**

TypeScript 6.0 breaking changes that matter for a fresh project: `strict` now defaults to `true`; `module`
defaults to `esnext` and `moduleResolution` to `bundler`; `target: es5` is deprecated (floor ES2015, default
is the current-year ES version); `esModuleInterop: false` / `allowSyntheticDefaultImports: false` can no
longer be set. Options deprecated in 6.0 are **removed in 7.0**.

Vite 8's own breaking changes are almost all irrelevant to a one-page app, but note: Rolldown+Oxc replace
Rollup+esbuild; Lightning CSS is now the default CSS minifier (`build.cssMinify: 'esbuild'` to revert, which
then requires installing esbuild); `build.esbuildOptions` is gone; object-form `manualChunks` removed;
passing a URL to `import.meta.hot.accept` is no longer supported; browser baseline rises to Chrome 111 /
Firefox 114 / Safari 16.4.

---

## 8. React 19.2 vs the last widely-documented React

Between **19.0.0** (2024-12-05) — the version most third-party writing describes — and **19.2.8**:

- **`useEffectEvent`** (19.2). Directly relevant: lets a polling effect read the latest props/state without
  listing them as dependencies. Must **not** appear in the dep array; the linter enforces that. Requires
  `eslint-plugin-react-hooks@latest`.
- **`<Activity />`** (19.2), **Performance Tracks** in Chrome DevTools, **partial pre-rendering**
  (`resume`, `resumeAndPrerender`) — all SSR/routing features. Not applicable here.
- **`cacheSignal`** — RSC only. Not applicable.
- **SSR Suspense reveals are now batched** — not applicable (no SSR).
- **`useId` default prefix changed** — `:r:` (19.0) → `«r»` (19.1) → **`_r_`** (19.2), so IDs are valid
  `view-transition-name` / XML 1.0 names. Only bites snapshot tests and hand-written CSS selectors.

**The React 19.2 release notes list no breaking changes.** Nothing in 19.1/19.2 affects a `fetch`-polling
app with no router and no state library.

### What does affect a polling app: `react-hooks/set-state-in-effect`

This rule is **`error`** in `recommended`. The naive "load once on mount" idiom trips it:

```tsx
useEffect(() => { setN(1) }, [])          // error react-hooks/set-state-in-effect
useEffect(() => { setDoubled(value * 2) }, [value])  // error, twice (oxlint adds EffectDerivationsOfState)
```

But the idiomatic polling loop this project actually needs is **clean under both linters** and
**compiles successfully** (`CompileSuccess`, `_c` cache emitted). Verified:

```tsx
export function Machines() {
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    let timer: ReturnType<typeof setTimeout>

    const tick = async () => {
      try {
        const res = await fetch('/api/machines', { signal: ac.signal })
        setRows(await res.json())
        setError(null)
      } catch (e) {
        if (!ac.signal.aborted) setError(String(e))
      }
      timer = setTimeout(tick, 2000)
    }
    tick()

    return () => { ac.abort(); clearTimeout(timer) }
  }, [])
  ...
}
```

The distinction the rules draw is **synchronous** `setState` in the effect body (banned) vs `setState` in a
callback that fires later (fine). Write the four sections that way from the start and the linter is a
non-event. `setTimeout`-after-response beats `setInterval` here anyway — no overlap when the daemon is slow.

---

## 9. Implications for a design system that arrives later

Nothing in this setup pins a styling layer, but four seams are worth knowing before another agent system
hands over a design system:

- **`jsxImportSource` is the one styling-coupled knob.** Emotion / `styled-jsx`-style libraries require
  `react({ jsxImportSource: '@emotion/react' })`. It lives in `vite.config.ts`, it is one line, and it is
  reversible. Nothing else in the compiler wiring cares about CSS.
- **Keep it plain CSS or CSS Modules until the design system lands.** Both are Vite built-ins; swapping to
  Tailwind later is `npm i -D tailwindcss @tailwindcss/vite` + one plugin line (`@tailwindcss/vite@4.3.3`
  declares `vite: "^5.2.0 || ^6 || ^7 || ^8"`, so Vite 8 is supported today). Swapping to a CSS-in-JS
  library is the expensive direction, and it is expensive because of `jsxImportSource` and runtime
  behaviour, not because of the compiler.
- **`react-hooks/incompatible-library`** (severity `warn` in both presets) exists precisely to flag
  libraries the compiler cannot reason about. If the incoming design system trips it, that is the early
  warning, and it is on by default.
- **Vite 8 minifies CSS with Lightning CSS, not esbuild.** A design system shipping exotic or very new CSS
  syntax may need `build.cssMinify: 'esbuild'` — which then requires adding `esbuild` as a devDependency.
  Cheap to fix, easy to misdiagnose.

The setup does *not* make swapping styling harder. The thing that would is committing to a CSS-in-JS
runtime now, before the design system's own choice is known.

---

## Risks & unknowns

- **The DevTools "Memo ✨" badge was not observed.** No browser was run. It is documented on react.dev;
  documented is not verified.
- **The React Compiler has shipped exactly one release (`1.0.0`, 2025-10-07) in ten months.** Whether that
  means "finished" or "stalled" is **unverified**. It does mean the compiler is not the moving part here —
  Vite 8, Babel 8 and TypeScript 6→7 are.
- **`oxlint`'s `react/react-compiler` is category `nursery`.** It matched or beat ESLint on every case
  tested, but it is a **reimplementation** of the compiler's analysis, not the compiler. It can drift from
  what `babel-plugin-react-compiler` actually does. If Path B is taken, the §5 grep check in CI is what
  keeps you honest.
- **`reportAllBailouts` produced nothing extra** on a 5-component sample. Untested at scale.
- **The prop-mutation miss (§3d) is one sample.** It is not a claim that `react-hooks/immutability` never
  fires.
- **Nothing was tested on Node 22.** All local results are Node v24.0.0. The CI runner defaults to 22.23.1,
  which will resolve Babel 8 where this machine resolved Babel 7 — a divergence that was inferred from
  `engines` metadata and npm's observed behaviour, **not executed on a 22.x runtime**.
- **`@xterm/xterm@6.0.0` (M6) was only inspected as metadata** — `main: lib/xterm.js`, `module:
  lib/xterm.mjs`, `types: typings/xterm.d.ts`, no `exports` field, no `engines`. It was not installed, not
  rendered, and not tested against React 19 StrictMode double-mounting, which is the usual xterm-in-React
  failure. Defer to M6 and test it then.

## Sources

*All retrieved 2026-08-01.*

- **Executed locally, 2026-08-01**: x86_64 CachyOS, kernel 7.1.3-2, Node v24.0.0, npm 11.3.0.
  `npm create vite@latest app -- --template react-ts` (create-vite 9.1.2), full install, React Compiler
  wired via `reactCompilerPreset`, `npm run build` ✓, direct `babel.transformSync` runs with a `logger`,
  `npx eslint` and `npx oxlint` runs, clean-cache npm resolution reproductions.
- React Compiler: [installation](https://react.dev/learn/react-compiler/installation) (raw source:
  `raw.githubusercontent.com/reactjs/react.dev/main/src/content/learn/react-compiler/installation.md`) ·
  [configuration](https://react.dev/reference/react-compiler/configuration) ·
  [React Compiler v1.0 announcement, 2025-10-07](https://react.dev/blog/2025/10/07/react-compiler-1)
- React: [React 19.2 release notes, 2025-10-01](https://react.dev/blog/2025/10/01/react-19-2)
- ESLint plugin: [`eslint-plugin-react-hooks` README](https://github.com/react/react/blob/main/packages/eslint-plugin-react-hooks/README.md)
  (raw from `facebook/react` main) · preset contents dumped from the installed 7.1.1 package
- Vite: [`@vitejs/plugin-react` README](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md) ·
  [`@vitejs/plugin-react-swc` README](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc/README.md) ·
  [Vite migration guide](https://vite.dev/guide/migration) · [Vite 8.0 announcement](https://vite.dev/blog/announcing-vite8) ·
  `reactCompilerPreset` source read from `node_modules/@vitejs/plugin-react/dist/index.js`
- oxlint: [`react/react-compiler` rule docs](https://oxc.rs/docs/guide/usage/linter/rules/react/react-compiler.html) ·
  rule inventory read from `node_modules/oxlint/configuration_schema.json` (oxlint 1.76.0)
- TypeScript: [TypeScript 6.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html) ·
  [typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)
- Versions & engines: `https://registry.npmjs.org/-/package/<pkg>/dist-tags` and
  `https://registry.npmjs.org/<pkg>/latest` for every package in the §1 table
- Node/CI: [`actions/runner-images` Ubuntu2404-Readme.md](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md) ·
  `https://nodejs.org/dist/index.json` (v24.18.1 LTS "Krypton" 2026-07-28; v22.23.2 "Jod"; v20.20.2 "Iron")
