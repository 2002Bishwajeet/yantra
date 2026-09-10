# landing

The public page for Yantra. Astro 7 + Tailwind 4, static output, one page, no client framework.

**It is the owner's own design.** Two earlier ones were rejected and `Y-208` stripped the page back
to a placeholder to wait for a third; the owner drew it in Claude Design as
[`Yantra Landing B.dc.html`](https://claude.ai/design/p/810a535a-9ea9-4277-a0ce-ebc3b8caa796) and
`Y-209` built it. What arrives here is one sticky frame over three screen-heights, and everything on
it is a function of how far you have scrolled: three clauses light one at a time, three verses take
turns, a bolt climbs the vajra beside them, and the install command appears only at the last beat,
once the page has said all three things.

**The palette is the dashboard's.** Every colour in `src/styles/global.css` is a Material role from
[`web/src/m3/tokens.css`](../web/src/m3/tokens.css) read in its **dark** value — the sage palette
measured in R14 — except the terracotta accent, which the owner added for this page and which no
dashboard role holds. This is a reversal: the placeholder took no palette at all, precisely so there
would be nothing here to argue with once the direction was settled. It is settled.

**Dark only, and that is also a reversal.** `Y-208` honoured `prefers-color-scheme` because a neutral
placeholder had no argument for overriding it. This page does: the fire, the ember rim and the
vajra's five inks are all read against one ground, and a light inversion of them is a second design
rather than a second palette. A test asserts it, because that is the kind of decision a later edit
undoes without noticing.

**The page ships JavaScript now**, which the placeholder did not. Two WebGL canvases from
[`src/lib/canvas-fx.js`](src/lib/canvas-fx.js) — Canvas UI's Flame Wrap around the panel, and its
Displacement shearing the vajra that `src/lib/vajra.js` paints. Both honour
`prefers-reduced-motion`, and with no script at all the page still says all three clauses and shows
the command: see the `scripting: none` block at the bottom of the stylesheet.

**Three faces, self-hosted**: Google Sans Flex, IBM Plex Mono and Noto Serif Devanagari, subset to
latin and devanagari, declared with the same `@font-face` idiom the dashboard uses. Self-hosting is
a reproducibility requirement rather than a preference — a `system-ui` stack renders differently on
the CI runner than on a developer's box and breaks the baselines, which is what `Y-208` found.

**The release the page offers is read from [`Cargo.toml`](../Cargo.toml) at build time**, not typed
here. Three places name it, and a version bump already touches that one line (`Y-364`). A test
asserts the page and the manifest agree.

**This is not the M4 dashboard.** That is `Y-072`, it lives in `web/`, and it is built per
[ADR-0014](../docs/adr/0014-react-with-the-compiler-for-the-web-ui.md).

**The landing does not read [`design/tokens.css`](../design/tokens.css)**, which
[`docs/design-system.md`](../docs/design-system.md) documents. It reads nothing at build time but the
manifest; the sage values above are restated in `global.css` with the roles they came from named,
because the two apps are separate builds and a cross-app CSS import breaks silently.

Nothing was lost in the earlier strip. Commit `827d300` on `main` holds the whole Pattachitra
build, and `tracker.md` rows `Y-206`/`Y-207` record what drawing it taught.

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

## Visual regression

Four baselines: the first beat and the last, on desktop and mobile. They replace the light/dark pair
the placeholder had, because there is one ground now.

> **Playwright's `reducedMotion` option is accepted and then dropped.** Set it in `use` — at file,
> describe or config level — and `matchMedia('(prefers-reduced-motion: reduce)')` still answers
> `false` inside the page and `contextOptions.reducedMotion` is `undefined`. Measured against the
> headless shell these run on; a full chromium is untested and need not be, because
> `page.emulateMedia({ reducedMotion: 'reduce' })` works either way, and `tests/landing.spec.ts`
> uses that.
> Every landing test carried the dead option from `Y-204` onward without anyone noticing, because
> the page it tested had no motion to suppress. This one has two WebGL loops: with the preference
> genuinely off they animate at about five frames a second under the shell, no two screenshots are
> ever alike, and each of the four snapshot tests burns its whole timeout before failing.

## Deploy previews

Every PR touching `landing/` or `design/` builds, runs the visual regression, and uploads a
preview version to Cloudflare. The workflow posts one comment with the preview URL and edits
it in place on later pushes. A push to `main` deploys production.

**Workers static assets, not Pages.** Pages is not deprecated, but Cloudflare has stopped
recommending it: wrangler itself now prints *"Workers are the recommended way to deploy all
new projects"*, and Astro's deploy guide no longer documents Pages at all. Config is
[`wrangler.jsonc`](wrangler.jsonc), hand-written because `astro add cloudflare` would
normally generate it and **the adapter is explicitly not needed for `output: 'static'`**.

`.github/workflows/landing.yml` is a **separate workflow, not a job in `ci.yml`** — R-24's
retire condition is that `cargo build` stays green on a machine with no Node installed, and
the cheapest way to keep that true is for the Rust gate and the Node gate to share no file.
The `just` recipes (`landing-build`, `landing-visual`) are absent from `just ci` and
`just check` for the same reason.

### One-time setup

Three steps need the dashboard; the rest is CLI.

1. **Claim a `workers.dev` subdomain** for the account, if one has never been enabled.
   Preview URLs only exist on `workers.dev`.
2. **Create a custom API token** (Account → API Tokens → Create Token → *Custom token*):
   - `Account` · `Workers Scripts` · **Edit**
   - `Account` · `Account Settings` · **Read**  (optional, but a useful margin)

   Scope it to this one account. **Do not use the "Edit Cloudflare Workers" template** —
   it grants `Workers Routes` write on *every zone* plus KV, R2 and Tail, which is far more
   than a static-asset deploy needs sitting in a CI secret. Cloudflare's own guide
   recommends that template anyway.
3. **Add two repository secrets:**

   ```sh
   gh secret set CLOUDFLARE_API_TOKEN     # from step 2
   gh secret set CLOUDFLARE_ACCOUNT_ID    # Workers & Pages -> right sidebar -> Account ID
   ```

   `CLOUDFLARE_ACCOUNT_ID` is nominally optional, but inference fails in CI when the token
   is account-owned or the user has more than one account, so set it.
4. **Bootstrap the Worker once**, from `landing/`:

   ```sh
   npx wrangler deploy
   ```

   Required: `wrangler versions upload` fails on a Worker that has never been deployed,
   because there is no prior version to inherit bindings from. After this, PR previews work.

Until both secrets exist the deploy steps **skip rather than fail**, so the build and the
visual regression still gate every PR regardless. A fork PR gets no secrets on
`pull_request` and skips too; the fix for that is the `workflow_run` split (unprivileged
build, privileged deploy), never `pull_request_target`, which would run with secrets against
unreviewed code.

`site` is deliberately unset in `astro.config.mjs`. Set it once there is a stable domain —
leave it fixed at the production URL rather than the per-PR preview, or throwaway preview
domains start self-canonicalising into search results.
