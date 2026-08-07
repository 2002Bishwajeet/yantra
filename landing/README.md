# landing

The public *coming soon* page for Yantra. Astro 7 + Tailwind 4, static output, one page, no client
framework, and no JavaScript shipped to the browser at all.

**It is a placeholder, deliberately.** Two designs have been rejected and the owner is redrawing the
direction from their own prototype (`Y-208`), so the page is three lines of type on a neutral ground
and commits to nothing. The one face it does load is self-hosted because a `system-ui` stack renders
differently on the CI runner than on a developer's box and breaks the baselines — reproducibility,
not identity. What is worth keeping is underneath it: the build, the visual
regression and the Cloudflare deploy below all stay exercised, so the redraw arrives at a working
pipeline rather than rebuilding one.

Nothing was lost in the strip. Commit `827d300` on `main` holds the whole previous build — the
Pattachitra palette measured off a reference photograph, the cusped torana, and a Jai Prakash bowl
reading the real sun over Jaipur — and `tracker.md` rows Y-206/Y-207 record what drawing them taught,
including the geometry that would otherwise have to be rediscovered.

**This is not the M4 dashboard.** That is `Y-072`, it lives in `web/`, and it is built per
[ADR-0014](../docs/adr/0014-react-with-the-compiler-for-the-web-ui.md).

**The landing does not read [`design/tokens.css`](../design/tokens.css)**, which
[`docs/design-system.md`](../docs/design-system.md) documents and which still describes the
dashboard's identity. It did once. The placeholder takes no palette at all — three neutrals defined
in `src/styles/global.css` — precisely so there is nothing here to argue with when the direction is
settled.

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
