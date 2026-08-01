# landing

The public *coming soon* page for Yantra. Astro 7 + React 19 islands + Tailwind 4, static output.

**This is not the M4 dashboard.** That is `Y-072`, it is blocked on `Q14`, and it will live in
`web/`. The two share an identity and nothing else — the shared part is
[`design/tokens.css`](../design/tokens.css), which is plain CSS custom properties with no framework
dependency precisely so `Q14` stays open. The reasoning is in
[`docs/design-system.md`](../docs/design-system.md); read that before changing a colour.

```sh
npm install
npm run dev      # http://localhost:4321
npm run build    # -> dist/
```

> **`astro dev` daemonizes itself when it detects an AI-agent environment** (Astro 7 bundles
> `am-i-vibing`), so the foreground process exits 0 immediately and anything waiting on the server
> — Playwright's `webServer`, most of all — fails with *"exited early"*. Set
> `ASTRO_DEV_BACKGROUND=1` to keep it in the foreground. The name reads backwards; it means
> *"I am already the background child"*.

Built assets are never committed (R-24).
