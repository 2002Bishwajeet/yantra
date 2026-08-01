# landing

The public *coming soon* page for Yantra. Astro 7 + React 19 islands + Tailwind 4, static output.

**This is not the M4 dashboard.** That is `Y-072` and it will live in `web/`, built per
[ADR-0014](../docs/adr/0014-react-with-the-compiler-for-the-web-ui.md). The two share an identity
and nothing else — the shared part is [`design/tokens.css`](../design/tokens.css), plain CSS custom
properties with no framework dependency, which is one of the three delivery shapes ADR-0014 left
open and the one that keeps its integration diff down to `index.css`. The reasoning is in
[`docs/design-system.md`](../docs/design-system.md); read that before changing a colour, and read
§7 before wiring it into the dashboard — `--accent` collides with shadcn's.

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
