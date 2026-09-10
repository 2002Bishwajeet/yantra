# landing

The public page for Yantra. Astro 7 + Tailwind 4, static output, one page, no client framework.

**It is the owner's own design.** Two designs were rejected outright, `Y-208` stripped the page to a
placeholder to wait for a third, and the owner then drew two in [Claude
Design](https://claude.ai/design/p/810a535a-9ea9-4277-a0ce-ebc3b8caa796): `Yantra Landing B.dc.html`,
which `Y-209` built, and `Yantra Landing Painted.dc.html`, which replaced it the same day and is what
this is. What arrives is one sticky frame over three screen-heights, and everything on it is a
function of how far you have scrolled: three clauses light one at a time, three verses take turns in
one box, three pips fill, and the install command appears only at the last beat, once the page has
said all three things.

**The painting is the page.** A Vishvakarma — the divine craftsman, the maker of instruments — fills
the frame, and Canvas UI's Cloth hangs it as fabric that moves under the cursor and folds harder at
each beat. `src/lib/canvas-fx.js` holds that one effect and nothing else: the upstream file also
carries Flame Wrap, Displacement and Canvas Paint, but it is an IIFE assigning to a single object, so
nothing tree-shakes and an unused shader is bytes a visitor downloads.

**The palette is the painting's, not the dashboard's.** Charcoal ground, aged brass for every rule
and label, warm ivory for the words, and one terracotta for the things you can act on. This reverses
`Y-209`, which took the dashboard's Material roles read dark — the sage measured in R14 — so that the
two surfaces would share an identity. They no longer do, on purpose and for now: `Y-383` is the row
that moves the dashboard to match, and until it lands the disagreement is the cost of the landing
going first.

**Dark only, and that is also a reversal.** `Y-208` honoured `prefers-color-scheme` because a neutral
placeholder had no argument for overriding it. This page does: it is a dark painting, and a light
inversion of it is a second design rather than a second palette. A test asserts it, because that is
the kind of decision a later edit undoes without noticing.

**Four faces, self-hosted**: Fraunces for the display serif, Geist for the interface, IBM Plex Mono
for the command, and Noto Serif Devanagari for the one word यन्त्र. Self-hosting is a reproducibility
requirement rather than a preference — a `system-ui` stack renders differently on the CI runner than
on a developer's box and breaks the baselines, which is what `Y-208` found. Fontsource ships six axis
cuts of Fraunces; this takes the `opsz` one, because the design asks for optical sizing and the
`full` cut carries two axes nothing here sets.

**The two images are exported by the owner, not fetched.** `src/assets/vishvakarma.png` (the
painting, 1585x992) and `src/assets/yantra-mark.png` (the mandala in the masthead and the colophon,
1254x1254 with alpha) came over Taildrop by hand: the Claude Design MCP caps a file read at 256 KiB
of base64, and both are far past it. They go through `astro:assets` rather than `public/`, so the
build emits sized WebP — the painting is 3.0 MB of PNG and 284 kB served, at quality 68 because at
1:1 on its busiest region that is indistinguishable from 82 and a third smaller.

**The release the page offers is read from [`Cargo.toml`](../Cargo.toml) at build time**, not typed
here. Three places name it, and a version bump already touches that one line (`Y-364`). A test
asserts the page and the manifest agree.

**This is not the M4 dashboard.** That is `Y-072`, it lives in `web/`, and it is built per
[ADR-0014](../docs/adr/0014-react-with-the-compiler-for-the-web-ui.md).

**The landing reads no shared stylesheet.** Not [`design/tokens.css`](../design/tokens.css), which
[`docs/design-system.md`](../docs/design-system.md) documents and which describes a build that no
longer exists, and not `web/src/m3/tokens.css` either. It reads nothing at build time but the
manifest: the two apps are separate builds, and a cross-app CSS import breaks silently.

Nothing was lost in the earlier strips. Commit `827d300` on `main` holds the whole Pattachitra build,
and `tracker.md` rows `Y-206`/`Y-207` record what drawing it taught; `Y-209`'s vajra and fire are one
commit back on this branch.

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

Four baselines: the first beat and the last, on desktop and mobile.

> **Playwright's `reducedMotion` option is accepted and then dropped.** Set it in `use` — at file,
> describe or config level — and `matchMedia('(prefers-reduced-motion: reduce)')` still answers
> `false` inside the page and `contextOptions.reducedMotion` is `undefined`. Measured against the
> headless shell these run on; a full chromium is untested and need not be, because
> `page.emulateMedia({ reducedMotion: 'reduce' })` works either way, and `tests/landing.spec.ts`
> uses that.
> Every landing test carried the dead option from `Y-204` onward without anyone noticing, because
> the page it tested had no motion to suppress. `Y-209` had two WebGL loops and burned every
> snapshot timeout before failing. The Cloth reads the preference itself and parks after one frame,
> so with `emulateMedia` in place the fabric holds a single still fold and the baselines are stable.

> **A loaded image is not a painted one.** The cloth renders on the frame after `img.decode()`
> resolves, and `decode()` is asynchronous, so a screenshot taken two frames after the bitmap is
> complete catches the flat backing colour instead of the fabric — with the `<img>` beneath it
> perfect and every other assertion on the page passing. The page sets `data-cloth` once the fabric
> exists and `settle()` waits for that attribute.

Two tests assert the painting, because one was not enough. The first checks the asset is served: a
build that emits the markup and loses the asset ships a charcoal rectangle nobody notices. The
second checks it reached the fabric, which is the failure above and is separate. That one needs no
pixel decoder — PNG compresses this canvas to 449 bytes when it is a flat fill and 1.6 MB when it is
the painting.

The four baselines are 4.4 MB together. A photographic hero does not compress, and lossless
recompression buys 6%, so they are left as Playwright writes them.

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
