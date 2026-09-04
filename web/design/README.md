# The options round

[D0 §7](../../docs/design/00-plan.md) asks for the visual system to be chosen from rendered
options before D7 is written. This directory is that round. It mounts the real fleet page on
fixture data — ten workspaces and three machines, D3 §10's case — and lets a reader switch
between candidate stylesheets and force either ground.

Nothing here reaches the production bundle. `vite.config.ts` is a second root, and `tsc -b`
does not cover it.

```bash
cd web
npx vite --config design/vite.config.ts --host   # live, on the tailnet address
npx vite build --config design/vite.config.ts     # design/dist/
node design/onefile.mjs                           # design/dist/options.html, one file, no server
```

An option is a candidate `index.css` swap block, written with `light-dark()` so one line
carries both grounds and `data-theme` on the root forces either. `plex.css` is a type overlay
applied on top of `kalam.css`.
