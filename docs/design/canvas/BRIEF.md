# Yantra dashboard canvas — shared brief for every artboard

Y-332. Every artboard is one `.dc.html` file in this directory, 1440 × 1024, desktop. Static
mockup: no script block, no interactivity. Real Yantra content, no filler, no lorem ipsum.
Read `Main.dc.html` first and copy its shell, its class names and its idiom exactly.

## Register

Material 3 Expressive. Big rounded containers (28 px), pill controls (999 px), tonal surfaces
instead of borders, one bold display number per card, generous padding. Quiet otherwise: no
gradients, no shadows, no emoji. State is always a **mark plus a word**, never colour alone.

## Palette (light), from `../palette-sage.json`

| Role | Hex | Use |
| --- | --- | --- |
| Primary | `#48674B` | filled buttons, the needs-you mark, links |
| On Primary | `#FFFFFF` | text on primary |
| Primary Container | `#CBE8C6` | the one hero card per page |
| On Primary Container | `#2F4E33` | text on the hero |
| Secondary Container | `#D6E8D0` | selected tab, selected row, quick actions |
| On Secondary Container | `#3B4B39` | text on it |
| Tertiary | `#7A6A45` | the running mark, elapsed bars |
| Tertiary Container | `#F2E1B8` | beige: the not-urgent attention card |
| On Tertiary Container | `#5C4E2D` | text on it |
| Error | `#BA1A1A` | crashed or killed mark, badge |
| Error Container | `#FFDAD6` | unreachable chip |
| On Error Container | `#93000A` | text on it |
| Surface | `#F8FAF3` | page background |
| Surface Container Low | `#F2F4EC` | the rail |
| Surface Container | `#ECEEE6` | ordinary cards |
| Surface Container High | `#E6E9E0` | tab group, search, icon buttons, the running card |
| Surface Container Lowest | `#FFFFFF` | rows inside a card |
| On Surface | `#191D18` | body text |
| On Surface Variant | `#424940` | secondary text, eyebrows |
| Outline | `#727A70` | hollow marks |
| Outline Variant | `#C2C9BE` | the one outlined card, dividers |

## Type

Google Sans Flex from Google Fonts, IBM Plex Mono for every age, duration, count of tokens and
amount of money. Sizes: display 64 or 44 Bold; title 18 SemiBold; row title 14 or 15 Medium;
body 13 Regular; meta 12 Regular; eyebrow 12 Medium, uppercase, 0.8 px tracking.

## Shell

Every page carries the same top bar from `Main.dc.html`: wordmark, the pill tab group
(Dashboard · Fleet · Machines · Usage), search with ⌘K, the notification bell with its badge, the
avatar. Move the selected pill to the page you are drawing. Only the Dashboard and New session
keep the left rail; Fleet, Machines and Usage use the full width under the top bar with a
24 px page padding and a 16 px gap.

## Marks

`.mark-needs` filled sage · `.mark-running` filled beige · `.mark-idle` hollow · `.mark-unknown`
dashed hollow · `.mark-failed` filled red. Always followed by the word.

## Rules that bite

- Keep `<script src="./support.js"></script>` in the head exactly. Omit `data-dc-script`.
- Close every element, quote every attribute. Flex or grid with `gap`, never margins between
  siblings. Inline `style` for anything a viewer should restyle.
- Root element is a fixed 1440 × 1024 box with `background:#F8FAF3` and `overflow:hidden`.
- Icons are inline SVG, stroke 1.5, 20 or 24 px. No emoji.
- Hit targets 44 px minimum on rows and buttons.
- Time under a day is an age (4s, 12m, 6h); over a day is a date (7 Jul).
- Confirm only what cannot be undone: Delete and Kill. Stop and Resume do not prompt.
- Fleet names to reuse: machines `cachyos-g14`, `macbook`, `pi-5`, `hetzner-1`, `nas`,
  `thinkpad` (unreachable). Workspaces `yantra-web`, `homelab-k8s`, `landing`, `agent-sdk`,
  `price-table`, `ntfy-relay`, `docs-sweep`, `appliance`, `landing-copy`, `cargo-zig`.

## Settings register (owner, 6 Sep, after the first draft was rejected)

Settings is not a dashboard. Take the pattern from Linear, Vercel and Raycast: a category list on
the left, ONE category on the right, drawn as grouped list rows (leading icon, headline, supporting
line, trailing value or chevron or switch). A value that is a secret or a long string is never
drawn on the page: the row says *Set · replaced 4 Sep* or shows the hostname only, and the full
URL or a masked token appears only in the edit sheet a tap opens. Categories: General, Notifications,
Providers (Hosting: GitHub, GitLab · LLM: Anthropic, OpenAI later), Agents, Access (SSH identity,
who may open the dashboard), Appearance, About (daemon).

**Appearance (owner, 6 Sep, reversing Q6's "no theming, no density"):** a dashboard layout choice
(Clean, the picked direction with whitespace · Compact, denser rows and smaller cards), a colour seed
(sage default, plus beige, terracotta, slate, plum, and a custom hex) that recolours the whole M3
scheme, and Light / Dark / System. D3 §0 and Q6 need a dated amendment when this ships.

## Form factors

- **Phone, PWA, 390 × 844.** Standalone app, no browser chrome and no fake status bar. M3 bottom
  navigation bar, 80 px, four destinations with icon and label: Dashboard, Fleet, Machines, Usage.
  Small top app bar: page title, bell with badge, avatar. A FAB above the bar on the right opens
  New session, which becomes a full-screen sheet with the same four steps. Rows are 56 px, cards
  stack in one column, the bento becomes a vertical feed with Needs you first. Idle collapses
  behind a disclosure. Order never changes under a finger: a *Reorder* pill applies new order.
- **Tablet, 834 × 1194 portrait.** M3 navigation rail, 80 px, on the left with the four
  destinations and the New FAB at the top of the rail. No top tab group. Two content columns.
  The sessions rail from the desktop is not drawn; sessions are reached from the Fleet.
- Type sizes do not shrink on smaller screens. Hit targets stay 44 px minimum.

## Workspace tile colours (canonical, from Main.dc.html)

yantra-web `#48674B` · landing `#7A6A45` · homelab-k8s `#3F5F7A` · appliance `#4E6E7A` ·
agent-sdk `#6B4E7A` · cargo-zig `#3A5A5A` · docs-sweep `#5A6E3A` · price-table `#8A5A3A` ·
landing-copy `#9A7A3A` · ntfy-relay `#A85B3C`. A tile is 36 px, radius 12, white first letter.

## Compact layout (Y-335, measured on MainCompact.dc.html)

Card radius 20, padding 14 (16 at the sides), card gap 8. Row radius 14, padding 6 px 10 px,
min-height 40 (a two-line tile row comes to 48). List gap 4, page and column gap 8. Hero number
44/44, status line 36. Single-line rows use a 28 px tile at radius 10. Idle is expanded as a
two-column grid instead of a collapsed line, and the freed space holds a Recent card (the last five
session events). Type sizes do not shrink; the goal is more rows on one screen.

## Consistency rules found on 6 Sep evening

- `landing` lives on `macbook` and `price-table` on `cachyos-g14`; a board about one machine
  shows only that machine's workspaces.
- A confirmation dialog's row repeats the Fleet row under it word for word.
- `cachyos-g14` passes all nine doctor checks everywhere; draw a missing check on `thinkpad`.
- The tailnet is `yantra.tail3a1b.ts.net` on every board.
- GitHub is a sign-in Yantra holds (owner, 6 Sep): New session browses and searches repositories,
  private ones included; reviews, issues and pull requests come through the same grant. Nothing on
  a board says `gh` holds it. The doctor's `provider-cli` and `provider-auth` checks stay: git on
  the machine still clones.
